/**
 * Stenographer — Real-Time Objections (§12)
 *
 * Opposing counsel in the room while the transcript is still being
 * written. One detector — assertion-contradicts-TB — watches the same
 * message stream the indexer tails, backed by an in-memory cache of
 * active TBs, and records objections for `/flags` to emit.
 *
 * Passivity holds: nothing here writes into a conversation. Objections
 * are emitted; whoever is in the session decides what to do with them.
 *
 * v1 is precision over recall: only tombstoned *literals* (numeric
 * constants, identifiers, config values declared on the TB) are matched,
 * only in assistant output (generated code and concrete plans), and only
 * the new side of an edit. Not paraphrases, not vibes.
 *
 * Objections themselves are operational state, not truth: the log lives
 * beside the ledger, and only the *ruling* on an objection enters the
 * record (as an ordinary RULING, §11).
 */

import type Database from 'better-sqlite3';
import { ulid, type TbEntry, type UvEntry, type TombstonedLiteral } from './types.js';
import type { TruthLedger } from './ledger.js';
import type { ConversationMessage } from '../types.js';

export type ObjectionMode = 'off' | 'shadow' | 'deliver';
export type ObjectionStatus = 'pending' | 'sustained' | 'overruled';

/** An objection without grounds is noise: every flag ships all three parts. */
export interface Objection {
  id: string;
  createdAt: string;
  sessionId: string;
  messageId: string;
  tbId: string;
  literal: TombstonedLiteral;
  /** What was asserted and which entry it contradicts. */
  objection: string;
  /** The full TB record at the time of the objection, plus any live contest. */
  exhibit: { tombstone: TbEntry; contestedBy: UvEntry[] };
  /** The transcript line objected to. */
  transcriptLine: string;
  /** Where the line came from: assistant text, or a tool call's input. */
  source: string;
  status: ObjectionStatus;
  /** False for shadow-mode objections: recorded and rulable, never emitted on /flags. */
  delivered: boolean;
  rulingId: string | null;
}

export interface ObjectionStats {
  raised: number;
  pending: number;
  sustained: number;
  overruled: number;
  shadow: number;
  /** sustained / (sustained + overruled); null until something is ruled on. */
  sustainRate: number | null;
}

// ─────────────────────────────────────────────────────────────
// Literal matching
// ─────────────────────────────────────────────────────────────

/** How far after a subject a dead value may appear (`LOG_BUDGET = 30`, "log budget to 30"). */
const AFTER_SUBJECT_WINDOW = 40;
/** How far before a subject (`30 as the log budget`). */
const BEFORE_SUBJECT_WINDOW = 20;
const MAX_LINE_LENGTH = 500;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Subject pattern that tolerates naming-convention drift: "logBudget",
 * "LOG_BUDGET", "log-budget", and "log budget" all match subject
 * "logBudget". Word-bounded, so "maxLogBudget" and "LOG_BUDGET_MAX" don't.
 */
function subjectRegExp(subject: string): RegExp {
  const words = subject
    .split(/[\s_\-.]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9_])${words.join('[\\s_\\-.]*')}(?![A-Za-z0-9_])`, 'gi');
}

/** Exact, case-sensitive token: "30" doesn't match "300" or "30.5". */
function valueRegExp(value: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(value)}(?![A-Za-z0-9_]|\\.\\d)`, 'g');
}

function spans(re: RegExp, text: string): Array<[number, number]> {
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
}

/**
 * Returns the lines of `text` that assert a tombstoned literal. A line
 * that also mentions the replacement is discussing the change ("bumped
 * LOG_BUDGET from 30 to 100"), not asserting the dead value, and is skipped.
 */
export function findLiteralHits(text: string, literal: TombstonedLiteral): string[] {
  const dead = valueRegExp(literal.dead);
  const current = literal.current ? valueRegExp(literal.current) : null;
  const subject = literal.subject ? subjectRegExp(literal.subject) : null;
  const hits: string[] = [];

  for (const line of text.split('\n')) {
    const deadSpans = spans(dead, line);
    if (deadSpans.length === 0) continue;
    if (current && spans(current, line).length > 0) continue;

    if (subject) {
      const near = spans(subject, line).some(([sStart, sEnd]) =>
        deadSpans.some(
          ([dStart, dEnd]) =>
            (dStart >= sEnd && dStart - sEnd <= AFTER_SUBJECT_WINDOW) ||
            (dEnd <= sStart && sStart - dEnd <= BEFORE_SUBJECT_WINDOW)
        )
      );
      if (!near) continue;
    }
    hits.push(line.trim().slice(0, MAX_LINE_LENGTH));
  }
  return hits;
}

/**
 * The text an assistant message asserts: its prose plus the string inputs
 * of its tool calls. Keys naming the *old* side of an edit (`old_string`,
 * `oldText`, ...) are skipped — replacing a dead value is the fix, not the
 * mistake.
 */
export function assertedText(msg: ConversationMessage): Array<{ source: string; text: string }> {
  const out: Array<{ source: string; text: string }> = [];
  if (msg.content) out.push({ source: 'text', text: msg.content });

  const collect = (value: unknown, source: string, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      out.push({ source, text: value });
    } else if (Array.isArray(value)) {
      for (const v of value) collect(v, source, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (/^old/i.test(key)) continue;
        collect(v, source, depth + 1);
      }
    }
  };
  for (const call of msg.toolCalls ?? []) {
    collect(call.input, `tool:${call.name}`, 0);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Detector + log
// ─────────────────────────────────────────────────────────────

export class ObjectionLog {
  private db: Database.Database;
  private ledger: TruthLedger;
  private cache: { generation: string; tombstones: TbEntry[] } | null = null;

  constructor(db: Database.Database, ledger: TruthLedger) {
    this.db = db;
    this.ledger = ledger;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objections (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        tb_id TEXT NOT NULL,
        dead TEXT NOT NULL,
        record TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        delivered INTEGER NOT NULL DEFAULT 0,
        ruling_id TEXT,
        UNIQUE(message_id, tb_id, dead)
      );
      CREATE INDEX IF NOT EXISTS idx_objections_key ON objections(session_id, tb_id, dead);
    `);
  }

  /** The active-TB cache: rebuilt only when the ledger's generation moves. */
  private matchableTombstones(): TbEntry[] {
    const generation = this.ledger.generation();
    if (!this.cache || this.cache.generation !== generation) {
      this.cache = { generation, tombstones: this.ledger.getMatchableTombstones() };
    }
    return this.cache.tombstones;
  }

  /**
   * Scans one completed assistant message. Stenographer only ever sees
   * finished log lines, so delivery is at message boundaries by
   * construction — never mid-generation.
   *
   * Counsel doesn't repeat itself: a literal already objected to in this
   * session and still pending, or already overruled, isn't raised again.
   * One the judge sustained is raised again if the mistake recurs.
   */
  scan(msg: ConversationMessage, sessionId: string, mode: ObjectionMode): Objection[] {
    if (mode === 'off' || msg.role !== 'assistant') return [];
    const tombstones = this.matchableTombstones();
    if (tombstones.length === 0) return [];

    const sources = assertedText(msg);
    const raised: Objection[] = [];

    for (const tb of tombstones) {
      for (const literal of tb.body.literals ?? []) {
        if (this.isSettledInSession(sessionId, tb.id, literal.dead)) continue;

        let hit: { line: string; source: string } | null = null;
        for (const { source, text } of sources) {
          const lines = findLiteralHits(text, literal);
          if (lines.length > 0) {
            hit = { line: lines[0], source };
            break;
          }
        }
        if (!hit) continue;

        const objection = this.record(msg, sessionId, tb, literal, hit, mode === 'deliver');
        if (objection) raised.push(objection);
      }
    }
    return raised;
  }

  private isSettledInSession(sessionId: string, tbId: string, dead: string): boolean {
    const row = this.db
      .prepare(`
        SELECT 1 FROM objections
        WHERE session_id = ? AND tb_id = ? AND dead = ? AND status IN ('pending', 'overruled')
        LIMIT 1
      `)
      .get(sessionId, tbId, dead);
    return Boolean(row);
  }

  private record(
    msg: ConversationMessage,
    sessionId: string,
    tb: TbEntry,
    literal: TombstonedLiteral,
    hit: { line: string; source: string },
    delivered: boolean
  ): Objection | null {
    const contestedBy =
      tb.body.status === 'contested'
        ? (this.ledger.getContested().find((c) => c.tombstone.id === tb.id)?.contestedBy ?? [])
        : [];
    const what = literal.subject ? `${literal.subject} = ${literal.dead}` : literal.dead;
    const replacement = literal.current ? `; current value: ${literal.current}` : '';
    const asterisk = contestedBy.length > 0 ? ' (TB is contested — see exhibit)' : '';

    const id = ulid();
    const createdAt = new Date().toISOString();
    const record = {
      literal,
      objection: `Asserted ${what}, which ${tb.id} tombstones${replacement}${asterisk}: ${tb.body.claim}`,
      exhibit: { tombstone: tb, contestedBy },
      transcriptLine: hit.line,
      source: hit.source,
    };

    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO objections
          (id, created_at, session_id, message_id, tb_id, dead, record, status, delivered)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(id, createdAt, sessionId, msg.id, tb.id, literal.dead, JSON.stringify(record), delivered ? 1 : 0);
    // Re-tailing the same message is idempotent
    return result.changes > 0 ? this.get(id) : null;
  }

  get(id: string): Objection | null {
    const row = this.db.prepare('SELECT * FROM objections WHERE id = ?').get(id) as any;
    return row ? rowToObjection(row) : null;
  }

  /**
   * Objections in id (time) order. `since` is an exclusive id cursor, so a
   * polling consumer passes the last id it saw. Shadow objections are
   * excluded unless asked for.
   */
  list(options: { since?: string; status?: ObjectionStatus; includeShadow?: boolean; limit?: number } = {}): Objection[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeShadow) where.push('delivered = 1');
    if (options.since) {
      where.push('id > ?');
      params.push(options.since);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    const sql = `SELECT * FROM objections ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`;
    params.push(options.limit ?? 100);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToObjection);
  }

  /** Records the outcome of a ruling filed in the ledger. */
  markRuled(id: string, outcome: 'sustained' | 'overruled', rulingId: string): void {
    this.db
      .prepare('UPDATE objections SET status = ?, ruling_id = ? WHERE id = ?')
      .run(outcome, rulingId, id);
  }

  stats(): ObjectionStats {
    const rows = this.db
      .prepare('SELECT status, delivered, COUNT(*) c FROM objections GROUP BY status, delivered')
      .all() as Array<{ status: ObjectionStatus; delivered: number; c: number }>;
    const stats: ObjectionStats = { raised: 0, pending: 0, sustained: 0, overruled: 0, shadow: 0, sustainRate: null };
    for (const r of rows) {
      stats.raised += r.c;
      stats[r.status] += r.c;
      if (!r.delivered) stats.shadow += r.c;
    }
    const ruled = stats.sustained + stats.overruled;
    stats.sustainRate = ruled > 0 ? stats.sustained / ruled : null;
    return stats;
  }
}

function rowToObjection(row: any): Objection {
  const record = JSON.parse(row.record);
  return {
    id: row.id,
    createdAt: row.created_at,
    sessionId: row.session_id,
    messageId: row.message_id,
    tbId: row.tb_id,
    literal: record.literal,
    objection: record.objection,
    exhibit: record.exhibit,
    transcriptLine: record.transcriptLine,
    source: record.source,
    status: row.status,
    delivered: row.delivered === 1,
    rulingId: row.ruling_id ?? null,
  };
}

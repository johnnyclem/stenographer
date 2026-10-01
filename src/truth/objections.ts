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
 * what a tool call asserts: the new side of an edit, a written file, a
 * shell command that writes (asserting.ts). Not searches, not commit
 * messages, not paraphrases. The matcher lives in literal-matcher.ts.
 *
 * Objections themselves are operational state, not truth: the log lives
 * beside the ledger, and only the *ruling* on an objection enters the
 * record (as an ordinary RULING, §11).
 */

import type Database from 'better-sqlite3';
import { ulid, type TbEntry, type UvEntry, type TombstonedLiteral } from './types.js';
import type { TruthLedger } from './ledger.js';
import type { ConversationMessage } from '../types.js';
import { LiteralMatcher } from './literal-matcher.js';
import { assertingFields } from './asserting.js';

export { findLiteralHits } from './literal-matcher.js';

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
// What a message asserts
// ─────────────────────────────────────────────────────────────

/**
 * The text an assistant message asserts: its prose plus what its tool calls
 * assert (asserting.ts): the new side of an edit, a written file, a shell
 * command that writes. Searches, reads, commit messages and keys naming the
 * *old* side of an edit are skipped — looking for a dead value, or
 * replacing it, is the fix, not the mistake.
 */
export function assertedText(msg: ConversationMessage): Array<{ source: string; text: string }> {
  const out: Array<{ source: string; text: string }> = [];
  if (msg.content) out.push({ source: 'text', text: msg.content });
  for (const call of msg.toolCalls ?? []) {
    for (const { text } of assertingFields(call.name, call.input)) out.push({ source: `tool:${call.name}`, text });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// The objections table
// ─────────────────────────────────────────────────────────────

const OBJECTIONS_TABLE = (name: string) => `
  CREATE TABLE IF NOT EXISTS ${name} (
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
    UNIQUE(session_id, message_id, tb_id, dead)
  )`;
const SESSION_KEY = /UNIQUE\s*\(\s*session_id\s*,\s*message_id\s*,\s*tb_id\s*,\s*dead\s*\)/i;

/**
 * Creates the objections table, or moves a 0.x one (unique on message id,
 * so an id-less adapter's line hash collided across sessions — STENO-T-14)
 * to the per-session key, rows included.
 */
export function ensureObjectionSchema(db: Database.Database): void {
  db.exec(OBJECTIONS_TABLE('objections'));
  const outdated = () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'objections'`).get() as
      | { sql: string }
      | undefined;
    return Boolean(row && !SESSION_KEY.test(row.sql));
  };
  if (outdated()) {
    const migrate = () => {
      // Checked again under the write lock: another process may have just migrated
      if (!outdated()) return;
      db.exec(`
        ${OBJECTIONS_TABLE('objections_next')};
        INSERT INTO objections_next (id, created_at, session_id, message_id, tb_id, dead, record, status, delivered, ruling_id)
          SELECT id, created_at, session_id, message_id, tb_id, dead, record, status, delivered, ruling_id FROM objections;
        DROP TABLE objections;
        ALTER TABLE objections_next RENAME TO objections;
      `);
    };
    if (db.inTransaction) migrate();
    else db.transaction(migrate).immediate();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_objections_key ON objections(session_id, tb_id, dead);
  `);
}

// ─────────────────────────────────────────────────────────────
// Detector + log
// ─────────────────────────────────────────────────────────────

/** One active literal, as the matcher knows it. */
interface ActiveLiteral {
  tb: TbEntry;
  literal: TombstonedLiteral;
  /** Ledger order (TB, then literal): the order objections are raised in. */
  order: number;
}

/** The active TBs and their literals, compiled into one matcher. */
export interface CompiledTombstones {
  tombstones: TbEntry[];
  matcher: LiteralMatcher<ActiveLiteral>;
}

/** Compiles the literals of `tombstones` (in order) into one matcher. */
export function compileTombstones(tombstones: TbEntry[]): CompiledTombstones {
  const literals = tombstones.flatMap((tb) => (tb.body.literals ?? []).map((literal) => ({ tb, literal })));
  return { tombstones, matcher: new LiteralMatcher(literals.map((l, order) => ({ key: { ...l, order }, literal: l.literal }))) };
}

export class ObjectionLog {
  private db: Database.Database;
  private ledger: TruthLedger;
  private cache: ({ generation: string } & CompiledTombstones) | null = null;

  constructor(db: Database.Database, ledger: TruthLedger) {
    this.db = db;
    this.ledger = ledger;
    ensureObjectionSchema(db);
  }

  /** The active-TB matcher: recompiled only when the ledger's generation moves. */
  compiled(): CompiledTombstones {
    const generation = this.ledger.generation();
    if (!this.cache || this.cache.generation !== generation) {
      this.cache = { generation, ...compileTombstones(this.ledger.getMatchableTombstones()) };
    }
    return this.cache;
  }

  /**
   * Scans one completed assistant message. Stenographer only ever sees
   * finished log lines, so delivery is at message boundaries by
   * construction — never mid-generation.
   *
   * Counsel doesn't repeat itself: a literal already objected to in this
   * session and still pending, or already overruled, isn't raised again.
   * One the judge sustained is raised again if the mistake recurs.
   *
   * Each source is read once by one matcher for all active literals; the
   * settled literals are fetched once per scan.
   */
  scan(msg: ConversationMessage, sessionId: string, mode: ObjectionMode): Objection[] {
    if (mode === 'off' || msg.role !== 'assistant') return [];
    const { tombstones, matcher } = this.compiled();
    if (tombstones.length === 0) return [];

    const settled = this.settledInSession(sessionId);
    const found = new Map<ActiveLiteral, { line: string; source: string }>();
    for (const { source, text } of assertedText(msg)) {
      const hits = matcher.match(text, {
        skip: (key) => found.has(key) || settled.has(settledKey(key.tb.id, key.literal.dead)),
      });
      for (const hit of hits) found.set(hit.key, { line: hit.line, source });
    }

    const raised: Objection[] = [];
    for (const [key, hit] of [...found].sort(([a], [b]) => a.order - b.order)) {
      const objection = this.record(sessionId, msg.id, key.tb, key.literal, hit, mode === 'deliver');
      if (objection) raised.push(objection);
    }
    return raised;
  }

  /** (tb, dead) pairs already objected to in this session and pending, or overruled. */
  private settledInSession(sessionId: string): Set<string> {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT tb_id, dead FROM objections
        WHERE session_id = ? AND status IN ('pending', 'overruled')
      `)
      .all(sessionId) as Array<{ tb_id: string; dead: string }>;
    return new Set(rows.map((r) => settledKey(r.tb_id, r.dead)));
  }

  private record(
    sessionId: string,
    messageId: string,
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
      .run(id, createdAt, sessionId, messageId, tb.id, literal.dead, JSON.stringify(record), delivered ? 1 : 0);
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

const settledKey = (tbId: string, dead: string): string => `${tbId}\u0000${dead}`;

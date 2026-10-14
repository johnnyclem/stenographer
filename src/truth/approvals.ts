/**
 * Stenographer — Approvals, promotion and nomination (PRD R5)
 *
 * An agent's claim is a UV. It becomes a TB when a person approves it and
 * one other approver agrees: an agent session, or stenographer itself as
 * the reporter, citing the passages of the indexed record that support the
 * claim. No number of agent sessions promotes. Three or more agreeing from
 * different angles nominate: the UV is marked corroborated (one ADDENDUM
 * with a `corroborates` link, carrying them as its quorum) and goes first
 * on the docket, and it stays a UV until a person approves it.
 *
 * Approvals are operational state, like attestations: a table beside the
 * ledger, shared by every stenographer process on the file, never a ledger
 * entry and never exported, until a promotion writes them into the TB's
 * `approvals`. The TB is signed by the human approver, who becomes its
 * `answerableBy`: answerability is assigned at promotion and nowhere else.
 *
 * The rules:
 * - A human approval needs a person (by the ledger's classifier, never an
 *   agent). Its evidence is optional: a person may approve on judgment.
 * - An agent approval needs an agent identity, its session, and settling
 *   evidence of its own. Two approvals from one session are one.
 * - A reporter approval cites indexed messages (`cites`, at least one, each
 *   an id the record holds) and never counts as the human.
 * - Nobody approves what they drafted: the contempt rule binds every
 *   approver (author, signer, drafter or agent session of the UV).
 * - Promotion needs a human approval, a second distinct approver, and at
 *   least one evidence item among the approvals: the TB's evidence is
 *   their union. Until then the UV waits, and the result says what is
 *   missing.
 *
 * Every decision runs in one write transaction, with the clock read under
 * the lock, as attestations do.
 */

import type Database from 'better-sqlite3';
import { chooseNomination, evidenceKey, NOMINATION_MIN_MEMBERS, trimWhiteSpace, type QuorumMember } from './quorum.js';
import { TruthWriteError } from './errors.js';
import type { TruthLedger } from './ledger.js';
import {
  ulid,
  identityKey,
  evidenceClass,
  EvidenceSchema,
  REPORTER_IDENTITY,
  SETTLING_EVIDENCE_KINDS,
  type AddendumEntry,
  type Approval,
  type ApprovalRole,
  type Evidence,
  type RulingEntry,
  type TbEntry,
  type UvEntry,
} from './types.js';

/** Epoch ms, or a clock read once the write lock is held. */
export type ApprovalClock = number | (() => number);
const readClock = (clock: ApprovalClock): number => (typeof clock === 'function' ? clock() : clock);

/** One approval of an open UV, as recorded. */
export interface UvApproval {
  id: string;
  uvId: string;
  by: string;
  role: ApprovalRole;
  agentSessionId: string | null;
  evidence: Evidence[];
  /** A reporter's approval: the indexed messages it cites. */
  cites: string[];
  note: string | null;
  createdAt: string;
  /** The TB the promotion wrote them into, or null while the UV is open. */
  consumedBy: string | null;
}

/** Where a UV stands on its way to a TB. */
export interface ApprovalSummary {
  /** Distinct approvers so far (a person by identity, an agent by session, the reporter once). */
  approvers: number;
  human: boolean;
  /** Agent sessions that approved. */
  agentSessions: number;
  reporter: boolean;
  /** Whether a nomination was written (three or more agent sessions from different angles). */
  nominated: boolean;
  /** What promotion still needs. */
  missing: Array<'a human approval' | 'a second approver' | 'evidence'>;
}

export type ApproveOutcome =
  | { status: 'approved'; approval: UvApproval; uv: UvEntry; approvals: ApprovalSummary }
  | { status: 'nominated'; approval: UvApproval; uv: UvEntry; approvals: ApprovalSummary; addendum: AddendumEntry; members: UvApproval[] }
  | { status: 'promoted'; approval: UvApproval; uv: UvEntry; tombstone: TbEntry; addendum: AddendumEntry; ruling: RulingEntry | null; approvals: UvApproval[] };

/** The approvals table, beside the ledger in the state database. Idempotent. */
export function ensureApprovalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uv_approvals (
      id TEXT PRIMARY KEY,
      uv_id TEXT NOT NULL,
      by TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_session_id TEXT,
      evidence TEXT NOT NULL,
      cites TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      consumed_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_uv_approvals_uv ON uv_approvals(uv_id, consumed_by);
  `);
}

interface ApprovalRow {
  id: string;
  uv_id: string;
  by: string;
  role: ApprovalRole;
  agent_session_id: string | null;
  evidence: string;
  cites: string;
  note: string | null;
  created_at: string;
  consumed_by: string | null;
}

function toApproval(row: ApprovalRow): UvApproval {
  return {
    id: row.id,
    uvId: row.uv_id,
    by: row.by,
    role: row.role,
    agentSessionId: row.agent_session_id,
    evidence: JSON.parse(row.evidence),
    cites: JSON.parse(row.cites),
    note: row.note,
    createdAt: row.created_at,
    consumedBy: row.consumed_by,
  };
}

/** The key two approvals count once under: a person by identity, an agent by session, the reporter once. */
function approverKey(a: { role: ApprovalRole; by: string; agentSessionId: string | null }): string {
  if (a.role === 'agent') return `session:${trimWhiteSpace(a.agentSessionId ?? '')}`;
  if (a.role === 'reporter') return 'reporter';
  return `human:${identityKey(a.by)}`;
}

/** The approvals as a promoted TB records them (spec, Approvals). */
export function toWireApprovals(approvals: UvApproval[]): Approval[] {
  return approvals.map((a) => ({
    by: a.by,
    role: a.role,
    ts: a.createdAt,
    ...(a.role === 'agent' && a.agentSessionId ? { agentSessionId: a.agentSessionId } : {}),
    ...(a.role === 'reporter' ? { cites: a.cites } : {}),
  }));
}

export class UvApprovals {
  constructor(
    private db: Database.Database,
    private ledger: TruthLedger
  ) {
    ensureApprovalSchema(db);
  }

  /** Approvals on a UV (every UV, when omitted), oldest first. */
  list(uvId?: string): UvApproval[] {
    const rows = (
      uvId
        ? this.db.prepare('SELECT * FROM uv_approvals WHERE uv_id = ? ORDER BY created_at, id').all(uvId)
        : this.db.prepare('SELECT * FROM uv_approvals ORDER BY created_at, id').all()
    ) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** Where a UV stands: its standing approvals, who they are, and what promotion still needs. */
  summary(uvId: string): ApprovalSummary {
    return this.summarize(uvId, this.standing(uvId));
  }

  private standing(uvId: string): UvApproval[] {
    return this.list(uvId).filter((a) => a.consumedBy === null);
  }

  private summarize(uvId: string, approvals: UvApproval[]): ApprovalSummary {
    const keys = new Set(approvals.map(approverKey));
    const human = approvals.some((a) => a.role === 'human');
    const evidence = approvals.some((a) => a.evidence.length > 0);
    const missing: ApprovalSummary['missing'] = [];
    if (!human) missing.push('a human approval');
    if (keys.size < 2) missing.push('a second approver');
    if (!evidence) missing.push('evidence');
    return {
      approvers: keys.size,
      human,
      agentSessions: new Set(approvals.filter((a) => a.role === 'agent').map(approverKey)).size,
      reporter: approvals.some((a) => a.role === 'reporter'),
      nominated: this.ledger.isCorroborated(uvId),
      missing,
    };
  }

  /**
   * Records an approval of an open UV and promotes or nominates it when
   * that completes one. The checks come first: an approval that fails them
   * is not recorded.
   */
  approve(
    input: {
      uvId: string;
      by: string;
      role: ApprovalRole;
      agentSessionId?: string | null;
      evidence?: Evidence[];
      cites?: string[];
      note?: string | null;
    },
    clock: ApprovalClock
  ): ApproveOutcome {
    return this.ledger.atomically((): ApproveOutcome => {
      const now = readClock(clock);
      const uv = this.ledger.getEntry(input.uvId) as UvEntry | null;
      if (!uv || uv.type !== 'UV') throw new TruthWriteError(`no such UV: ${input.uvId}`);
      if (uv.body.status !== 'open') throw new TruthWriteError(`UV ${uv.id} is already ${uv.body.status}`);
      if (this.ledger.isStruck(uv.id)) throw new TruthWriteError(`UV ${uv.id} is struck: nothing is approved on it`);
      if (uv.standing === 'unsupported') {
        const reason = uv.reasons?.[0];
        throw new TruthWriteError(`UV ${uv.id} is unsupported (${reason ? `${reason.reason} ${reason.premise}` : 'a premise below it is dead'}): it can't be promoted`);
      }

      const by = this.ledger.accountable(input.by, 'approver');
      const session = input.agentSessionId ? trimWhiteSpace(input.agentSessionId) : '';
      let evidence = (input.evidence ?? []).map((e) => EvidenceSchema.parse(e));
      let cites: string[] = [];
      switch (input.role) {
        case 'human':
          if (this.ledger.isAgent(by)) throw new TruthWriteError(`'${by}' is an agent: an agent's approval is role agent, and never counts as the human`);
          break;
        case 'agent':
          if (!this.ledger.isAgent(by)) throw new TruthWriteError(`'${by}' is not an agent: a person's approval is role human`);
          if (!session) throw new TruthWriteError(`an agent's approval names its session`);
          if (!evidence.some((e) => evidenceClass(e.kind) === 'settling')) {
            throw new TruthWriteError(`an agent's approval cites settling evidence of its own (${SETTLING_EVIDENCE_KINDS.join(', ')}): its confidence is not evidence`);
          }
          break;
        case 'reporter':
          if (identityKey(by) !== identityKey(REPORTER_IDENTITY)) throw new TruthWriteError(`the reporter's approval is '${REPORTER_IDENTITY}'s, not '${by}'s`);
          cites = [...new Set((input.cites ?? []).map((c) => c.trim()).filter(Boolean))];
          if (cites.length === 0) throw new TruthWriteError('the reporter approves only by citing passages of the indexed record (cites, at least one message id)');
          this.requireIndexed(cites);
          evidence = cites.map((ref) => ({ kind: 'message' as const, ref, detail: 'a passage of the indexed record' }));
          break;
        default:
          throw new TruthWriteError(`an approval's role is human, agent or reporter, not '${String(input.role)}'`);
      }
      // Nobody approves what they drafted, and one session is one approver
      this.ledger.assertIndependent({ author: by, agentSessionId: session || null }, uv, 'approve');
      const standing = this.standing(uv.id);
      const key = approverKey({ role: input.role, by, agentSessionId: session || null });
      const again = standing.find((a) => approverKey(a) === key);
      if (again) {
        throw new TruthWriteError(
          input.role === 'agent' ? `session ${session} already approved UV ${uv.id}: one session is one approver` : `'${by}' already approved UV ${uv.id}`
        );
      }

      const approval: UvApproval = {
        id: ulid(now),
        uvId: uv.id,
        by,
        role: input.role,
        agentSessionId: session || null,
        evidence,
        cites,
        note: input.note ?? null,
        createdAt: new Date(now).toISOString(),
        consumedBy: null,
      };
      this.db
        .prepare(
          `INSERT INTO uv_approvals (id, uv_id, by, role, agent_session_id, evidence, cites, note, created_at, consumed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(approval.id, approval.uvId, approval.by, approval.role, approval.agentSessionId, JSON.stringify(approval.evidence), JSON.stringify(approval.cites), approval.note, approval.createdAt);
      const all = [...standing, approval];

      // Promotion: a person, one more, and something to cite
      const summary = this.summarize(uv.id, all);
      if (summary.missing.length === 0) {
        const human = [...all].reverse().find((a) => a.role === 'human')!;
        const seen = new Set<string>();
        const union = all.flatMap((a) => a.evidence).filter((e) => (seen.has(evidenceKey(e)) ? false : (seen.add(evidenceKey(e)), true)));
        const result = this.ledger.resolveUv(uv.id, 'verified', union, {
          author: human.by,
          signedBy: human.by,
          opinion: human.note ?? `Approved by ${human.by} with ${all.length - 1} other approval${all.length === 2 ? '' : 's'}.`,
          mintTombstone: uv.body.assertion,
          promotion: { approvals: toWireApprovals(all) },
          timestamp: approval.createdAt,
        });
        const mark = this.db.prepare('UPDATE uv_approvals SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL');
        for (const a of all) mark.run(result.tombstone!.id, a.id);
        return {
          status: 'promoted',
          approval: { ...approval, consumedBy: result.tombstone!.id },
          uv: result.uv,
          tombstone: result.tombstone!,
          addendum: result.addendum,
          ruling: result.ruling,
          approvals: all.map((a) => ({ ...a, consumedBy: result.tombstone!.id })),
        };
      }

      // Nomination: three or more agent sessions from different angles, once
      if (input.role === 'agent' && !summary.nominated) {
        const agents = all.filter((a) => a.role === 'agent');
        const members = chooseNomination(
          agents.map((a) => ({ id: a.id, author: a.by, agentSessionId: a.agentSessionId, createdAt: a.createdAt, evidence: a.evidence })),
          NOMINATION_MIN_MEMBERS
        );
        if (members) {
          const quorum: QuorumMember[] = members.map((m) => ({ author: m.author, agentSessionId: m.agentSessionId!, ts: m.createdAt, evidence: m.evidence, verdict: 'verified' }));
          // Rule 2: the writer is a member. This session completed it, so it writes the nomination.
          const nominated = this.ledger.nominateUv(uv.id, quorum, { author: by, agentSessionId: session, timestamp: approval.createdAt });
          const chosen = new Set(members.map((m) => m.id));
          return {
            status: 'nominated',
            approval,
            uv: nominated.uv,
            approvals: this.summarize(uv.id, all),
            addendum: nominated.addendum,
            members: agents.filter((a) => chosen.has(a.id)),
          };
        }
      }
      return { status: 'approved', approval, uv: this.ledger.getEntry(uv.id) as UvEntry, approvals: summary };
    });
  }

  /** A reporter's cites name messages the record holds: the indexed `messages` table on this state file. */
  private requireIndexed(cites: string[]): void {
    const table = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`).get();
    if (!table) throw new TruthWriteError('the reporter cites the indexed record, and this state file holds none');
    const find = this.db.prepare('SELECT 1 FROM messages WHERE id = ?');
    for (const id of cites) {
      if (!find.get(id)) throw new TruthWriteError(`the reporter cites message ${id}, which the record doesn't hold`);
    }
  }
}

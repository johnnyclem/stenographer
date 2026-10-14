/**
 * Stenographer — Agent attestations
 *
 * Agents settle nothing (PRD R5, decision D2): an agent's claim is a UV
 * until a person approves it. On its own an agent can only attest.
 *
 * - resolve_uv in the agent profile records an attestation: this session's
 *   verdict on an open UV, with its evidence. Attestations are operational
 *   state, like objections: a table in the state database, shared by every
 *   stenographer process on that file, never a ledger entry, never
 *   exported. A verified verdict is also an approval (approvals.ts): a
 *   person's approval plus one more promotes the UV, and three agent
 *   sessions agreeing from different angles nominate it for review. A
 *   refuted verdict waits on the docket, where a person rules. When
 *   attestations from distinct sessions agree within 15 minutes from
 *   different angles, the ledger writes nothing: the agreement is reported
 *   (`agreed`), and the docket shows it. A verdict the other way within the
 *   window is a dispute, and a person hears of it.
 * - propose_tombstone files a draft for a person, as ever. Drafts from
 *   distinct sessions naming the same set of literals, from different
 *   angles, mint nothing: three of them nominate the draft, which the docket
 *   lists first (draftAgreement).
 *
 * The 1.0 quorum that settled a UV or minted a TB (resolveUvByQuorum,
 * mintTombstoneByQuorum) is still in the library for ledgers that hold such
 * lines, and no live path writes one.
 *
 * Every decision here runs in one write transaction. Time is the caller's
 * clock (`now`, epoch ms, or a clock to read), so the window is
 * deterministic in tests. A clock is read once the write lock is held: a
 * process that waited for the lock behind another's opposite verdict reads
 * a time after it, and sees it.
 */

import type Database from 'better-sqlite3';
import { chooseNomination, chooseQuorum, literalSetKey, NOMINATION_MIN_MEMBERS, QUORUM_WINDOW_MS, type QuorumProgress } from './quorum.js';
import type { TruthLedger } from './ledger.js';
import { ulid, type Evidence, type ProposalEntry, type TombstonedLiteral, type UvEntry } from './types.js';

/** Epoch ms, or a clock that attest and settleTombstoneQuorum read once they hold the write lock. */
export type QuorumClock = number | (() => number);

const readClock = (clock: QuorumClock): number => (typeof clock === 'function' ? clock() : clock);

/** One agent session's verdict on an open UV. */
export interface Attestation {
  id: string;
  uvId: string;
  resolution: 'verified' | 'refuted';
  author: string;
  agentSessionId: string;
  evidence: Evidence[];
  note: string | null;
  createdAt: string;
  /**
   * The addendum that settled it under the 1.0 quorum rule, 'raised' when
   * its quorum went to a person, or null: since 1.1 nothing consumes a
   * verdict, and every one stands on the docket until a person rules.
   */
  consumedBy: string | null;
}

export type AttestOutcome =
  /** Recorded; no other session agrees yet. */
  | { status: 'attested'; attestation: Attestation; uv: UvEntry; quorum: QuorumProgress }
  /** An opposite verdict stands within the window (from any session, this one included). `raise` is set for the first attestation of a dispute. */
  | { status: 'disputed'; attestation: Attestation; uv: UvEntry; dissent: Attestation[]; raise: boolean }
  /** Two or more sessions agree from different angles. Nothing settles: the docket shows the agreement, and a person rules. */
  | { status: 'agreed'; attestation: Attestation; uv: UvEntry; members: Attestation[] };

/** The attestation table, beside the ledger in the state database. Idempotent. */
export function ensureAttestationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uv_attestations (
      id TEXT PRIMARY KEY,
      uv_id TEXT NOT NULL,
      resolution TEXT NOT NULL,
      author TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      evidence TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      consumed_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_uv_attestations_uv ON uv_attestations(uv_id, consumed_by);
  `);
}

interface AttestationRow {
  id: string;
  uv_id: string;
  resolution: 'verified' | 'refuted';
  author: string;
  agent_session_id: string;
  evidence: string;
  note: string | null;
  created_at: string;
  consumed_by: string | null;
}

function toAttestation(row: AttestationRow): Attestation {
  return {
    id: row.id,
    uvId: row.uv_id,
    resolution: row.resolution,
    author: row.author,
    agentSessionId: row.agent_session_id,
    evidence: JSON.parse(row.evidence),
    note: row.note,
    createdAt: row.created_at,
    consumedBy: row.consumed_by,
  };
}

export class UvAttestations {
  constructor(
    private db: Database.Database,
    private ledger: TruthLedger
  ) {
    ensureAttestationSchema(db);
  }

  /** Attestations on a UV (every UV, when omitted), oldest first. */
  list(uvId?: string): Attestation[] {
    const rows = (
      uvId
        ? this.db.prepare('SELECT * FROM uv_attestations WHERE uv_id = ? ORDER BY created_at, id').all(uvId)
        : this.db.prepare('SELECT * FROM uv_attestations ORDER BY created_at, id').all()
    ) as AttestationRow[];
    return rows.map(toAttestation);
  }

  /**
   * Records an agent session's verdict on an open UV. Nothing settles: the
   * UV stays open for a person, and the outcome says whether other sessions
   * agree or dispute it. The checks a resolution meets come first (the UV
   * is open, there is evidence, the agent is independent of the UV and,
   * refuting a contest, of its TB): an attestation that fails them is not
   * recorded.
   *
   * Dissent is any opposite verdict filed within the window before now or
   * after it (a clock another process read later, which committed first),
   * that no addendum settled: one that may still join a quorum, or one
   * whose quorum was raised to a person.
   */
  attest(
    input: {
      uvId: string;
      resolution: 'verified' | 'refuted';
      evidence: Evidence[];
      author: string;
      agentSessionId: string;
      note?: string | null;
    },
    clock: QuorumClock
  ): AttestOutcome {
    return this.ledger.atomically((): AttestOutcome => {
      const now = readClock(clock);
      const { evidence, uv, contestedTb } = this.ledger.checkResolution(input.uvId, input.resolution, input.evidence, input);
      const attestation: Attestation = {
        id: ulid(now),
        uvId: uv.id,
        resolution: input.resolution,
        author: input.author,
        agentSessionId: input.agentSessionId,
        evidence,
        note: input.note ?? null,
        createdAt: new Date(now).toISOString(),
        consumedBy: null,
      };
      this.db
        .prepare(
          `INSERT INTO uv_attestations (id, uv_id, resolution, author, agent_session_id, evidence, note, created_at, consumed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          attestation.id,
          attestation.uvId,
          attestation.resolution,
          attestation.author,
          attestation.agentSessionId,
          JSON.stringify(attestation.evidence),
          attestation.note,
          attestation.createdAt
        );

      // Other verdicts on this UV since the window opened. Those that may join a
      // quorum are unconsumed and not after now; dissent is any opposite one no
      // addendum settled, raised to a person or not, filed before now or after
      const recent = this.list(uv.id).filter((a) => a.id !== attestation.id && Date.parse(a.createdAt) >= now - QUORUM_WINDOW_MS);
      const others = recent.filter((a) => a.consumedBy === null && Date.parse(a.createdAt) <= now);
      const dissent = recent.filter((a) => a.resolution !== input.resolution && (a.consumedBy === null || a.consumedBy === 'raised'));
      if (dissent.length > 0) {
        // The first attestation of a dispute raises it; later ones find both verdicts already standing
        const raise = !others.some((a) => a.resolution === input.resolution);
        return { status: 'disputed', attestation, uv, dissent, raise };
      }

      void contestedTb; // a person rules on a contest either way: agents settle nothing
      const chosen = chooseQuorum(attestation, others, now);
      if (!chosen.members) return { status: 'attested', attestation, uv, quorum: chosen.progress };
      // Agreement is reported, never written: the UV stays open, and the docket shows who agrees
      return { status: 'agreed', attestation, uv, members: chosen.members };
    });
  }
}

/**
 * Where a draft stands among the other agents' drafts of the same literals;
 * `heldBy` names an active or contested TB that already holds every
 * literal; `nominated` is set when three or more agent sessions drafted the
 * same set from different angles, which puts the drafts first on the
 * docket. Nothing mints: a person signs one of the drafts.
 */
export type TombstoneQuorumProgress = QuorumProgress & { heldBy?: string; nominated?: true };

/**
 * After an agent files `draft`: where it stands among open agent drafts
 * from other sessions naming the same set of literals, from different
 * angles (`agreeing` counts those within 15 minutes, as a quorum did), and
 * whether three or more sessions, any time apart, nominate it. Nothing
 * mints (PRD R5: no number of agent sessions mints a TB). Only agents'
 * drafts count (the ledger's classifier says who is one). Runs in one
 * transaction, which reads `now` once it holds the lock.
 */
export function draftAgreement(
  ledger: TruthLedger,
  draft: ProposalEntry,
  ctx: { author: string; agentSessionId: string; now: QuorumClock }
): { progress: TombstoneQuorumProgress } {
  return ledger.atomically(() => {
    const now = readClock(ctx.now);
    const literalsOf = (p: ProposalEntry) => (p.body.draft.literals ?? []) as TombstonedLiteral[];
    const candidate = (p: ProposalEntry) => ({
      id: p.id,
      author: p.author,
      agentSessionId: p.agentSessionId ?? null,
      createdAt: p.createdAt,
      evidence: (p.body.draft.evidence ?? []) as Evidence[],
    });
    const literals = literalsOf(draft);
    if (literals.length === 0) {
      // Drafts agree on literals: one without any agrees with nothing
      const { progress } = chooseQuorum(candidate(draft), [], now);
      return { progress: { ...progress, missing: ['literals', ...progress.missing] } };
    }

    const set = literalSetKey(literals);
    const agreeing = ledger
      .listProposals('open', 'tombstone')
      .filter(
        (p) =>
          p.id !== draft.id &&
          p.body.requiresNotary === true &&
          p.body.signal?.source === 'agent-draft' &&
          ledger.isAgent(p.author) &&
          literalsOf(p).length > 0 &&
          literalSetKey(literalsOf(p)) === set
      )
      .map(candidate);
    const { progress } = chooseQuorum(candidate(draft), agreeing, now);

    // Already truth: an active or contested TB holds every literal of the set
    const wanted = JSON.parse(set) as string[];
    const heldBy = ledger.getMatchableTombstones().find((tb) => {
      const held = new Set(JSON.parse(literalSetKey(tb.body.literals ?? [])) as string[]);
      return wanted.every((l) => held.has(l));
    })?.id;
    if (heldBy) return { progress: { ...progress, heldBy } };
    // Three sessions from different angles nominate the drafts: first on the docket, still a person's to sign
    const nominated = chooseNomination([candidate(draft), ...agreeing], NOMINATION_MIN_MEMBERS) !== null;
    return { progress: { ...progress, ...(nominated ? { nominated: true as const } : {}) } };
  });
}

/** @deprecated Since 1.1 agent drafts mint nothing: use draftAgreement, which says where the drafts stand. */
export const settleTombstoneQuorum = draftAgreement;

/**
 * Whether open agent drafts of the same literal set as `draft`, from three
 * or more sessions and different angles, nominate it (the docket reads
 * this; nothing is written).
 */
export function draftNominated(ledger: TruthLedger, draft: ProposalEntry): boolean {
  const literalsOf = (p: ProposalEntry) => (p.body.draft.literals ?? []) as TombstonedLiteral[];
  const literals = literalsOf(draft);
  if (literals.length === 0 || !ledger.isAgent(draft.author)) return false;
  const set = literalSetKey(literals);
  const candidates = ledger
    .listProposals('open', 'tombstone')
    .filter((p) => p.body.requiresNotary === true && p.body.signal?.source === 'agent-draft' && ledger.isAgent(p.author) && literalsOf(p).length > 0 && literalSetKey(literalsOf(p)) === set)
    .map((p) => ({ id: p.id, author: p.author, agentSessionId: p.agentSessionId ?? null, createdAt: p.createdAt, evidence: (p.body.draft.evidence ?? []) as Evidence[] }));
  return chooseNomination(candidates, NOMINATION_MIN_MEMBERS) !== null;
}

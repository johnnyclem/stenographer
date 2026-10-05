/**
 * Stenographer — Agent attestations and the quorum that settles them
 *
 * Agents settle claims only together (spec/truth-format, "Agent quorum"):
 * two or more agent sessions agreeing from different angles at the same
 * time. On its own an agent can only attest.
 *
 * - resolve_uv in the agent profile records an attestation: this session's
 *   verdict on an open UV, with its evidence. Attestations are operational
 *   state, like objections: a table in the state database, shared by every
 *   stenographer process on that file, never a ledger entry, never
 *   exported. When attestations from distinct sessions agree within 15
 *   minutes from different angles, the one that completes the quorum writes
 *   a single ADDENDUM carrying every member (TruthLedger.resolveUvByQuorum).
 *   A verdict the other way within the window is a dispute: no quorum forms,
 *   and a person hears of it. A quorum that verifies a contest would
 *   override the TB, which no agent does: it is raised to a person instead.
 * - propose_tombstone files a draft for a person, as ever. Drafts from
 *   distinct sessions naming the same set of literals, within 15 minutes and
 *   from different angles, mint a TB together
 *   (TruthLedger.mintTombstoneByQuorum), unless an active or contested TB
 *   already holds every literal.
 *
 * Every decision here runs in one write transaction, so two processes
 * attesting at once can't both complete the same quorum. Time is the
 * caller's clock (`now`, epoch ms, or a clock to read), so the window is
 * deterministic in tests. A clock is read once the write lock is held: a
 * process that waited for the lock behind another's opposite verdict reads
 * a time after it, and sees it.
 */

import type Database from 'better-sqlite3';
import { chooseQuorum, literalSetKey, QUORUM_WINDOW_MS, type QuorumMember, type QuorumProgress } from './quorum.js';
import type { TruthLedger } from './ledger.js';
import { ulid, type AddendumEntry, type Evidence, type ProposalEntry, type TbEntry, type TombstonedLiteral, type UvEntry } from './types.js';

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
   * The addendum that settled it, 'raised' when its quorum went to a person,
   * or null while it may still join a quorum. A raised verdict still stands
   * as dissent within the window: a person has it, and it is no one's to undo.
   */
  consumedBy: string | null;
}

export type AttestOutcome =
  /** Recorded; no quorum yet. */
  | { status: 'attested'; attestation: Attestation; uv: UvEntry; quorum: QuorumProgress }
  /** An opposite verdict stands within the window (from any session, this one included): no quorum forms. `raise` is set for the first attestation of a dispute. */
  | { status: 'disputed'; attestation: Attestation; uv: UvEntry; dissent: Attestation[]; raise: boolean }
  /**
   * A quorum formed that agents may not act on, so it is raised to a person and nothing is written to the
   * ledger: it verified a contest (overriding the TB needs a person), or the ledger's agent quorum is off.
   */
  | { status: 'raised'; reason: 'contest-verified'; attestation: Attestation; uv: UvEntry; members: Attestation[]; tbId: string }
  | { status: 'raised'; reason: 'quorum-off'; attestation: Attestation; uv: UvEntry; members: Attestation[] }
  /** The quorum settled the UV with one ADDENDUM. */
  | { status: 'settled'; attestation: Attestation; uv: UvEntry; addendum: AddendumEntry; members: Attestation[] };

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
   * Records an agent session's verdict on an open UV and settles the UV when
   * it completes a quorum. The checks a resolution meets come first (the UV
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

      const chosen = chooseQuorum(attestation, others, now);
      if (!chosen.members) return { status: 'attested', attestation, uv, quorum: chosen.progress };

      const members = chosen.members;
      if (contestedTb && input.resolution === 'verified') {
        this.consume(members, 'raised');
        return { status: 'raised', reason: 'contest-verified', attestation: { ...attestation, consumedBy: 'raised' }, uv, members, tbId: contestedTb.id };
      }
      if (this.ledger.agentQuorum() === 'off') {
        this.consume(members, 'raised');
        return { status: 'raised', reason: 'quorum-off', attestation: { ...attestation, consumedBy: 'raised' }, uv, members };
      }
      const quorum: QuorumMember[] = members.map((m) => ({
        author: m.author,
        agentSessionId: m.agentSessionId,
        ts: m.createdAt,
        evidence: m.evidence,
        verdict: m.resolution,
      }));
      const settled = this.ledger.resolveUvByQuorum(uv.id, input.resolution, quorum, {
        author: input.author,
        agentSessionId: input.agentSessionId,
        opinion: input.note ?? undefined,
        timestamp: attestation.createdAt,
      });
      this.consume(members, settled.addendum.id);
      return {
        status: 'settled',
        attestation: { ...attestation, consumedBy: settled.addendum.id },
        uv: settled.uv,
        addendum: settled.addendum,
        members,
      };
    });
  }

  private consume(members: Attestation[], by: string): void {
    const mark = this.db.prepare('UPDATE uv_attestations SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL');
    for (const m of members) mark.run(by, m.id);
  }
}

/**
 * Where a draft's tombstone quorum stands; `heldBy` names an active or
 * contested TB that already holds every literal. `quorumOff` is set when the
 * ledger's agent quorum is off: nothing an agent drafts mints, however many
 * agree, and the drafts wait for a person.
 */
export type TombstoneQuorumProgress = QuorumProgress & { heldBy?: string; quorumOff?: true };

/**
 * After an agent files `draft`: mints a TB when open agent drafts from
 * other sessions name the same set of literals, within 15 minutes of each
 * other and of `now`, from different angles — unless an active or contested
 * TB already holds every literal. Otherwise says where the quorum stands.
 * Only agents' drafts settle together (the ledger's classifier says who is
 * one). Runs in one write transaction, which reads `now` once it holds the
 * write lock.
 */
export function settleTombstoneQuorum(
  ledger: TruthLedger,
  draft: ProposalEntry,
  ctx: { author: string; agentSessionId: string; now: QuorumClock }
): { tombstone: TbEntry } | { progress: TombstoneQuorumProgress } {
  return ledger.atomically(() => {
    const now = readClock(ctx.now);
    const off = ledger.agentQuorum() === 'off';
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
      // A quorum TB carries the literals its members agree on
      const { progress } = chooseQuorum(candidate(draft), [], now);
      return { progress: { ...progress, missing: ['literals', ...progress.missing], ...(off ? { quorumOff: true as const } : {}) } };
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
    const { members, progress } = chooseQuorum(candidate(draft), agreeing, now);

    // Already truth: an active or contested TB holds every literal of the set
    const wanted = JSON.parse(set) as string[];
    const heldBy = ledger.getMatchableTombstones().find((tb) => {
      const held = new Set(JSON.parse(literalSetKey(tb.body.literals ?? [])) as string[]);
      return wanted.every((l) => held.has(l));
    })?.id;
    if (heldBy) return { progress: { ...progress, heldBy } };
    // On a ledger whose quorum is off, agreeing drafts mint nothing: a person signs one of them
    if (off) return { progress: { ...progress, quorumOff: true } };
    if (!members) return { progress };

    const tombstone = ledger.mintTombstoneByQuorum(
      members.map((m) => m.id),
      { author: ctx.author, agentSessionId: ctx.agentSessionId, timestamp: new Date(now).toISOString() }
    );
    return { tombstone };
  });
}

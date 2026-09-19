/**
 * Stenographer — Truth Ledger (append-only, supersede-only)
 *
 * The storage layer for TB/UV v2. No entry is ever mutated or deleted;
 * state changes are new entries linking backward. The one apparent
 * exception — the cached `status` column — is derived state, updated only
 * inside the same transaction that appends the legal artifact justifying
 * the change. There is no public API to flip a status without one:
 * the override protocol is enforced here, not by convention.
 */

import type Database from 'better-sqlite3';
import {
  ulid,
  isAnonymousIdentity,
  isSelfSigningEvidence,
  TbInputSchema,
  UvInputSchema,
  EvidenceSchema,
  MIGRATION_AUTHOR,
  type Evidence,
  type Provenance,
  type TruthEntry,
  type LinkType,
  type TbEntry,
  type UvEntry,
  type ProposalEntry,
  type AddendumEntry,
  type RulingEntry,
  type TbBody,
  type UvBody,
  type ProposalBody,
  type VerifyBy,
} from './types.js';

export class TruthWriteError extends Error {}
/** Contempt of corpus: corroboration must be provenance-independent (§11). */
export class ContemptError extends TruthWriteError {}

export interface WriteContext {
  author: string;
  provenance?: Provenance;
  agentSessionId?: string | null;
  /** Embedding of the entry's salient text, for queue/search ranking. */
  embedding?: number[];
  timestamp?: string;
}

export type TruthFilter = 'current' | 'all' | 'contested';

const MANUAL: Provenance = { kind: 'manual' };

export class TruthLedger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS truth_entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        author TEXT NOT NULL,
        provenance TEXT NOT NULL,
        agent_session_id TEXT,
        origin TEXT NOT NULL DEFAULT 'local',
        body TEXT NOT NULL,
        status TEXT,
        target_ref TEXT,
        struck INTEGER NOT NULL DEFAULT 0,
        embedding BLOB
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS truth_links (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        UNIQUE(from_id, to_id, link_type)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_truth_type_status ON truth_entries(type, status);
      CREATE INDEX IF NOT EXISTS idx_truth_target_ref ON truth_entries(target_ref);
      CREATE INDEX IF NOT EXISTS idx_truth_links_to ON truth_links(to_id);
    `);
  }

  // ─────────────────────────────────────────────────────────
  // Internal write primitives
  // ─────────────────────────────────────────────────────────

  private requireAccountable(identity: string, role: string): void {
    if (isAnonymousIdentity(identity)) {
      throw new TruthWriteError(
        `${role} '${identity}' is not an accountable identity — anonymous writes are rejected at the schema level`
      );
    }
  }

  /**
   * Provenance-independence check (contempt of corpus, §11): evidence used
   * to verify or sign an entry may not share lineage with the assertion it
   * supports. Repetition is not evidence.
   */
  private requireIndependence(
    actor: { author: string; agentSessionId?: string | null },
    target: TruthEntry,
    action: string
  ): void {
    if (actor.author === target.author) {
      throw new ContemptError(
        `contempt of corpus: '${actor.author}' cannot ${action} entry ${target.id} it authored — corroboration must be provenance-independent`
      );
    }
    if (
      actor.agentSessionId &&
      target.agentSessionId &&
      actor.agentSessionId === target.agentSessionId
    ) {
      throw new ContemptError(
        `contempt of corpus: ${action} of ${target.id} traces to the same agent session (${actor.agentSessionId}) as its target — one opinion wearing two hats is not two witnesses`
      );
    }
  }

  private insertEntry(
    entry: Omit<TruthEntry, 'links'>,
    embedding?: number[]
  ): void {
    const status = (entry.body as { status?: string }).status ?? null;
    const targetRef = (entry.body as { targetRef?: string | null }).targetRef ?? null;
    this.db
      .prepare(`
        INSERT INTO truth_entries (id, type, created_at, author, provenance,
          agent_session_id, origin, body, status, target_ref, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.type,
        entry.createdAt,
        entry.author,
        JSON.stringify(entry.provenance),
        entry.agentSessionId ?? null,
        entry.origin,
        JSON.stringify(entry.body),
        status,
        targetRef,
        embedding && embedding.length > 0
          ? Buffer.from(new Float32Array(embedding).buffer)
          : null
      );
  }

  private addLink(fromId: string, toId: string, type: LinkType): void {
    this.db
      .prepare('INSERT OR IGNORE INTO truth_links (from_id, to_id, link_type) VALUES (?, ?, ?)')
      .run(fromId, toId, type);
  }

  /** Derived-state cache update — only ever called inside a legal transition. */
  private setStatus(id: string, status: string): void {
    // The body JSON is the exported record; keep its status in sync with the column.
    const row = this.db.prepare('SELECT body FROM truth_entries WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    if (!row) throw new TruthWriteError(`no such entry: ${id}`);
    const body = JSON.parse(row.body);
    body.status = status;
    this.db
      .prepare('UPDATE truth_entries SET status = ?, body = ? WHERE id = ?')
      .run(status, JSON.stringify(body), id);
  }

  private mustGet(id: string): TruthEntry {
    const entry = this.getEntry(id);
    if (!entry) throw new TruthWriteError(`no such entry: ${id}`);
    return entry;
  }

  private mustGetTyped<T extends TruthEntry>(id: string, type: TruthEntry['type']): T {
    const entry = this.mustGet(id);
    if (entry.type !== type) {
      throw new TruthWriteError(`entry ${id} is a ${entry.type}, expected ${type}`);
    }
    return entry as T;
  }

  // ─────────────────────────────────────────────────────────
  // Proposals — the only thing inference may ever produce
  // ─────────────────────────────────────────────────────────

  /**
   * Writes a machine-drafted proposal. Dedupes by target: an open proposal
   * of the same kind against the same target is returned instead of
   * duplicated (batching by target entity, §10).
   */
  addProposal(
    body: Omit<ProposalBody, 'status' | 'dismissedBy' | 'dismissReason'>,
    ctx: WriteContext
  ): ProposalEntry {
    this.requireAccountable(ctx.author, 'proposal author');

    if (body.targetRef) {
      const existing = this.db
        .prepare(`
          SELECT id FROM truth_entries
          WHERE type = 'PROPOSAL' AND status = 'open' AND target_ref = ?
        `)
        .all(body.targetRef) as Array<{ id: string }>;
      for (const row of existing) {
        const entry = this.getEntry(row.id) as ProposalEntry;
        if (entry.body.kind === body.kind) return entry;
      }
    }

    const id = ulid();
    this.insertEntry(
      {
        id,
        type: 'PROPOSAL',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: { ...body, status: 'open' } satisfies ProposalBody,
      },
      ctx.embedding
    );
    return this.getEntry(id) as ProposalEntry;
  }

  /**
   * An accountable author signs a proposal, minting the real TB/UV with a
   * `signs` link back. `edits` corrects the draft at signing time — the
   * signed version is what's true, the draft is history.
   */
  signProposal(
    proposalId: string,
    signedBy: string,
    edits?: Record<string, unknown>,
    ctx?: Partial<WriteContext>
  ): TbEntry | UvEntry {
    this.requireAccountable(signedBy, 'signer');
    const proposal = this.mustGetTyped<ProposalEntry>(proposalId, 'PROPOSAL');
    if (proposal.body.status !== 'open') {
      throw new TruthWriteError(`proposal ${proposalId} is already ${proposal.body.status}`);
    }
    // A signer sharing the drafting agent's session is the drafter signing
    // its own work — one hat, not two.
    this.requireIndependence(
      { author: signedBy, agentSessionId: ctx?.agentSessionId },
      proposal,
      'sign'
    );

    const draft = { ...proposal.body.draft, ...(edits ?? {}) };
    const writeCtx: WriteContext = {
      author: signedBy,
      provenance: proposal.provenance,
      agentSessionId: ctx?.agentSessionId ?? null,
      embedding: ctx?.embedding,
      timestamp: ctx?.timestamp,
    };

    const mint = this.db.transaction((): TbEntry | UvEntry => {
      let minted: TbEntry | UvEntry;
      if (proposal.body.kind === 'tombstone') {
        const input = TbInputSchema.parse({ ...draft, signedBy });
        minted = this.insertTb(input, writeCtx);
      } else {
        const input = UvInputSchema.parse(draft);
        minted = this.insertUv(input, writeCtx);
      }
      this.addLink(minted.id, proposalId, 'signs');
      this.setStatus(proposalId, 'signed');
      return minted;
    });
    // Re-fetch: the entry snapshot inside the transaction predates its links
    return this.getEntry(mint().id) as TbEntry | UvEntry;
  }

  /** Dismissal reasons are kept — they are training data for the detector. */
  dismissProposal(proposalId: string, dismissedBy: string, reason: string): ProposalEntry {
    this.requireAccountable(dismissedBy, 'dismisser');
    if (!reason || reason.trim().length === 0) {
      throw new TruthWriteError('a dismissal requires a reason');
    }
    const proposal = this.mustGetTyped<ProposalEntry>(proposalId, 'PROPOSAL');
    if (proposal.body.status !== 'open') {
      throw new TruthWriteError(`proposal ${proposalId} is already ${proposal.body.status}`);
    }

    const body = { ...proposal.body, status: 'dismissed' as const, dismissedBy, dismissReason: reason };
    this.db
      .prepare('UPDATE truth_entries SET status = ?, body = ? WHERE id = ?')
      .run('dismissed', JSON.stringify(body), proposalId);
    return this.getEntry(proposalId) as ProposalEntry;
  }

  // ─────────────────────────────────────────────────────────
  // Direct assertion — for authors who already know
  // ─────────────────────────────────────────────────────────

  assertTombstone(
    input: { claim: string; evidence: Evidence[]; signedBy: string },
    ctx: WriteContext
  ): TbEntry {
    const parsed = TbInputSchema.parse(input);
    this.requireAccountable(ctx.author, 'author');
    return this.insertTb(parsed, ctx);
  }

  assertUv(
    input: { assertion: string; basis: string; verifyBy: VerifyBy; contests?: string },
    ctx: WriteContext
  ): UvEntry {
    const parsed = UvInputSchema.parse(input);
    this.requireAccountable(ctx.author, 'author');
    return this.insertUv(parsed, ctx);
  }

  private insertTb(
    input: { claim: string; evidence: Evidence[]; signedBy: string },
    ctx: WriteContext
  ): TbEntry {
    const id = ulid();
    this.insertEntry(
      {
        id,
        type: 'TB',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: {
          claim: input.claim,
          evidence: input.evidence,
          signedBy: input.signedBy,
          status: 'active',
        } satisfies TbBody,
      },
      ctx.embedding
    );
    return this.getEntry(id) as TbEntry;
  }

  private insertUv(
    input: { assertion: string; basis: string; verifyBy: VerifyBy; contests?: string },
    ctx: WriteContext
  ): UvEntry {
    const insert = this.db.transaction((): string => {
      let contests: string | null = null;
      if (input.contests) {
        const tb = this.mustGetTyped<TbEntry>(input.contests, 'TB');
        if (tb.body.status === 'overridden') {
          throw new TruthWriteError(`TB ${tb.id} is already overridden — nothing to contest`);
        }
        contests = tb.id;
      }

      const id = ulid();
      this.insertEntry(
        {
          id,
          type: 'UV',
          createdAt: ctx.timestamp ?? new Date().toISOString(),
          author: ctx.author,
          provenance: ctx.provenance ?? MANUAL,
          agentSessionId: ctx.agentSessionId ?? null,
          origin: 'local',
          body: {
            assertion: input.assertion,
            basis: input.basis,
            verifyBy: input.verifyBy,
            contests,
            status: 'open',
          } satisfies UvBody,
        },
        ctx.embedding
      );

      // Override protocol path 1 (contest): the TB becomes contested but
      // remains active truth.
      if (contests) {
        this.addLink(id, contests, 'contests');
        this.setStatus(contests, 'contested');
      }
      return id;
    });
    return this.getEntry(insert()) as UvEntry;
  }

  // ─────────────────────────────────────────────────────────
  // UV resolution (§5/§6)
  // ─────────────────────────────────────────────────────────

  /**
   * Resolves an open UV with an evidence-bearing ADDENDUM. `command`
   * evidence is self-signing (reproducible by anyone — summary judgment);
   * any other resolution that mints a TB requires a human `signedBy` plus
   * a written `opinion`, recorded as a promotion RULING.
   *
   * If the UV contests a TB:
   * - verified → the TB is overridden (override protocol path 2, proven)
   * - refuted  → the TB returns to active (unless still otherwise contested)
   */
  resolveUv(
    uvId: string,
    resolution: 'verified' | 'refuted',
    evidence: Evidence[],
    ctx: WriteContext & { signedBy?: string; opinion?: string; mintTombstone?: string }
  ): { uv: UvEntry; addendum: AddendumEntry; tombstone: TbEntry | null; ruling: RulingEntry | null } {
    this.requireAccountable(ctx.author, 'resolver');
    const parsedEvidence = evidence.map((e) => EvidenceSchema.parse(e));
    if (parsedEvidence.length === 0) {
      throw new TruthWriteError('resolving a UV requires evidence');
    }
    const uv = this.mustGetTyped<UvEntry>(uvId, 'UV');
    if (uv.body.status !== 'open') {
      throw new TruthWriteError(`UV ${uvId} is already ${uv.body.status}`);
    }
    this.requireIndependence(ctx, uv, resolution === 'verified' ? 'verify' : 'refute');

    const selfSigning = isSelfSigningEvidence(parsedEvidence);
    const contestedTb = uv.body.contests ? this.mustGetTyped<TbEntry>(uv.body.contests, 'TB') : null;
    // Minting a TB happens when the resolution invalidates existing truth:
    // a verified contest overrides its TB; a refuted UV that propagated gets
    // a TB minted against the UV itself (mintTombstone carries the claim).
    const mintsTb = Boolean(
      (resolution === 'verified' && contestedTb) || ctx.mintTombstone
    );
    if (mintsTb && !selfSigning && !ctx.signedBy) {
      throw new TruthWriteError(
        'non-command evidence cannot self-sign a tombstone — a human signedBy is required (judgment calls are not summary judgment)'
      );
    }
    if (ctx.signedBy) this.requireAccountable(ctx.signedBy, 'signer');

    const run = this.db.transaction(() => {
      const now = ctx.timestamp ?? new Date().toISOString();

      const addendumId = ulid();
      this.insertEntry({
        id: addendumId,
        type: 'ADDENDUM',
        createdAt: now,
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: { evidence: parsedEvidence, note: ctx.opinion ?? null },
      });
      this.addLink(addendumId, uvId, resolution === 'verified' ? 'verifies' : 'refutes');
      this.setStatus(uvId, resolution);

      let tombstoneId: string | null = null;
      if (mintsTb) {
        const signer = ctx.signedBy ?? ctx.author;
        const claim =
          ctx.mintTombstone ??
          (resolution === 'verified' && contestedTb
            ? `Overridden: "${contestedTb.body.claim}" — contradicted by verified assertion: ${uv.body.assertion}`
            : `Refuted: "${uv.body.assertion}"`);
        const tb = this.insertTb(
          { claim, evidence: parsedEvidence, signedBy: signer },
          { ...ctx, timestamp: now, embedding: ctx.embedding }
        );
        tombstoneId = tb.id;
        if (resolution === 'verified' && contestedTb) {
          this.addLink(tb.id, contestedTb.id, 'supersedes');
        } else if (resolution === 'refuted') {
          // The correction is discoverable from the refuted UV
          this.addLink(tb.id, uvId, 'supersedes');
        }
      }

      // Contested-TB bookkeeping (override protocol)
      if (contestedTb) {
        if (resolution === 'verified') {
          this.addLink(addendumId, contestedTb.id, 'overrides');
          this.setStatus(contestedTb.id, 'overridden');
        } else if (!this.hasOpenContest(contestedTb.id, uvId)) {
          this.setStatus(contestedTb.id, 'active');
        }
      }

      // Promotion ruling: the gavel on a non-self-signing resolution (§11)
      let rulingId: string | null = null;
      if (mintsTb && !selfSigning) {
        rulingId = this.insertRuling(
          { kind: 'promotion', opinion: ctx.opinion ?? `Evidence ruled sufficient by ${ctx.signedBy}`, target: uvId },
          { ...ctx, author: ctx.signedBy!, timestamp: now }
        );
      }

      return { addendumId, tombstoneId, rulingId };
    });

    const { addendumId, tombstoneId, rulingId } = run();
    return {
      uv: this.getEntry(uvId) as UvEntry,
      addendum: this.getEntry(addendumId) as AddendumEntry,
      tombstone: tombstoneId ? (this.getEntry(tombstoneId) as TbEntry) : null,
      ruling: rulingId ? (this.getEntry(rulingId) as RulingEntry) : null,
    };
  }

  private hasOpenContest(tbId: string, excludeUvId?: string): boolean {
    const rows = this.db
      .prepare(`SELECT from_id FROM truth_links WHERE to_id = ? AND link_type = 'contests'`)
      .all(tbId) as Array<{ from_id: string }>;
    return rows.some((r) => {
      if (r.from_id === excludeUvId) return false;
      const uv = this.getEntry(r.from_id) as UvEntry | null;
      return uv?.body.status === 'open';
    });
  }

  // ─────────────────────────────────────────────────────────
  // Override protocol path 2 — the force path
  // ─────────────────────────────────────────────────────────

  /**
   * Proven override: flips an active/contested TB to overridden. Fails
   * without evidence — like force-pushing a protected branch, possible,
   * deliberate, and logged. (Path 1, contesting, is assertUv+contests.)
   */
  overrideTombstone(
    tbId: string,
    addendum: { evidence: Evidence[]; note?: string },
    ctx: WriteContext
  ): { tombstone: TbEntry; addendum: AddendumEntry } {
    this.requireAccountable(ctx.author, 'author');
    const parsedEvidence = addendum.evidence.map((e) => EvidenceSchema.parse(e));
    if (parsedEvidence.length === 0) {
      throw new TruthWriteError(
        'overriding a TB requires evidence — there is no third path, and no path at all for unattributed writes'
      );
    }
    const tb = this.mustGetTyped<TbEntry>(tbId, 'TB');
    if (tb.body.status === 'overridden') {
      throw new TruthWriteError(`TB ${tbId} is already overridden`);
    }

    const run = this.db.transaction((): string => {
      const id = ulid();
      this.insertEntry({
        id,
        type: 'ADDENDUM',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: { evidence: parsedEvidence, note: addendum.note ?? null },
      });
      this.addLink(id, tbId, 'overrides');
      this.setStatus(tbId, 'overridden');
      return id;
    });

    const addendumId = run();
    return {
      tombstone: this.getEntry(tbId) as TbEntry,
      addendum: this.getEntry(addendumId) as AddendumEntry,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Rulings (§11)
  // ─────────────────────────────────────────────────────────

  fileRuling(
    input: { kind: 'strike' | 'promotion' | 'contempt'; opinion: string; target: string },
    ctx: WriteContext
  ): { ruling: RulingEntry; conductTombstone: TbEntry | null } {
    this.requireAccountable(ctx.author, 'ruling author');
    if (!input.opinion || input.opinion.trim().length === 0) {
      throw new TruthWriteError('a ruling requires a written opinion — rulings are precedent');
    }

    const run = this.db.transaction((): { rulingId: string; tbId: string | null } => {
      const rulingId = this.insertRuling(input, ctx);
      let tbId: string | null = null;

      if (input.kind === 'strike') {
        const target = this.mustGet(input.target);
        this.addLink(rulingId, target.id, 'strikes');
        // Inadmissible for retrieval; nothing is deleted — append-only holds
        this.db.prepare('UPDATE truth_entries SET struck = 1 WHERE id = ?').run(target.id);
      } else if (input.kind === 'promotion') {
        this.mustGet(input.target);
      } else {
        // Contempt mints exactly one artifact: a TB about the conduct,
        // surfaced when that author's output is next reviewed. No karma.
        const tb = this.insertTb(
          {
            claim: `Contempt of corpus: ${input.target} — ${input.opinion}`,
            evidence: [{ kind: 'wiki', ref: rulingId, detail: 'contempt ruling' }],
            signedBy: ctx.author,
          },
          ctx
        );
        tbId = tb.id;
      }
      return { rulingId, tbId };
    });

    const { rulingId, tbId } = run();
    return {
      ruling: this.getEntry(rulingId) as RulingEntry,
      conductTombstone: tbId ? (this.getEntry(tbId) as TbEntry) : null,
    };
  }

  private insertRuling(
    input: { kind: 'strike' | 'promotion' | 'contempt'; opinion: string; target: string },
    ctx: WriteContext
  ): string {
    const id = ulid();
    this.insertEntry(
      {
        id,
        type: 'RULING',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: { kind: input.kind, opinion: input.opinion, target: input.target },
      },
      ctx.embedding
    );
    return id;
  }

  // ─────────────────────────────────────────────────────────
  // Migration (Phase 1 backfill)
  // ─────────────────────────────────────────────────────────

  /**
   * Backfills a pre-assertion auto-closed supersession as a queryably
   * second-class TB: author 'migration', signedBy null, provenance marking
   * that it predates assertion. Re-signable or contestable like anything else.
   */
  backfillLegacyTombstone(legacy: {
    id: string;
    superseded: string;
    correctedTo: string;
    reason: string;
    timestamp: string;
  }): TbEntry | null {
    const existing = this.db
      .prepare(`SELECT id FROM truth_entries WHERE type = 'TB' AND target_ref = ?`)
      .get(`legacy:${legacy.id}`) as { id: string } | undefined;
    if (existing) return null;

    const id = ulid();
    this.db
      .prepare(`
        INSERT INTO truth_entries (id, type, created_at, author, provenance,
          agent_session_id, origin, body, status, target_ref, embedding)
        VALUES (?, ?, ?, ?, ?, NULL, 'local', ?, 'active', ?, NULL)
      `)
      .run(
        id,
        'TB',
        legacy.timestamp,
        MIGRATION_AUTHOR,
        JSON.stringify({ kind: 'migration', ref: legacy.id } satisfies Provenance),
        JSON.stringify({
          claim: `Superseded: "${legacy.superseded}" → "${legacy.correctedTo}" (${legacy.reason})`,
          evidence: [{ kind: 'wiki', ref: `legacy:${legacy.id}`, detail: 'pre-assertion auto-close' }],
          signedBy: null,
          status: 'active',
        } satisfies TbBody),
        `legacy:${legacy.id}`
      );
    return this.getEntry(id) as TbEntry;
  }

  /** Used by wiki import: entries keep their original ids and authors. */
  importEntry(entry: TruthEntry, embedding?: number[]): 'inserted' | 'unchanged' | 'conflict' {
    const existing = this.getEntry(entry.id);
    if (existing) {
      const same =
        JSON.stringify(existing.body) === JSON.stringify(entry.body) &&
        existing.author === entry.author;
      return same ? 'unchanged' : 'conflict';
    }
    const run = this.db.transaction(() => {
      this.insertEntry(entry, embedding);
      for (const link of entry.links) {
        this.addLink(link.fromId, link.toId, link.type);
      }
    });
    run();
    return 'inserted';
  }

  // ─────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────

  getEntry(id: string): TruthEntry | null {
    const row = this.db.prepare('SELECT * FROM truth_entries WHERE id = ?').get(id) as any;
    return row ? this.rowToEntry(row) : null;
  }

  listProposals(status?: ProposalBody['status'], kind?: ProposalBody['kind']): ProposalEntry[] {
    const rows = (
      status
        ? this.db
            .prepare(`SELECT * FROM truth_entries WHERE type = 'PROPOSAL' AND status = ? ORDER BY created_at ASC`)
            .all(status)
        : this.db.prepare(`SELECT * FROM truth_entries WHERE type = 'PROPOSAL' ORDER BY created_at ASC`).all()
    ) as any[];
    return rows
      .map((r) => this.rowToEntry(r) as ProposalEntry)
      .filter((p) => !kind || p.body.kind === kind);
  }

  /** Open UVs — the raw verification queue (ranking happens in the engine). */
  getOpenUvs(): Array<UvEntry & { embedding: number[] | null }> {
    const rows = this.db
      .prepare(`SELECT * FROM truth_entries WHERE type = 'UV' AND status = 'open' AND struck = 0 ORDER BY created_at ASC`)
      .all() as any[];
    return rows.map((r) => ({
      ...(this.rowToEntry(r) as UvEntry),
      embedding: r.embedding
        ? Array.from(
            new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
          )
        : null,
    }));
  }

  /** All TB+UV disputes: contested TBs paired with their live contesting UVs. */
  getContested(): Array<{ tombstone: TbEntry; contestedBy: UvEntry[] }> {
    const rows = this.db
      .prepare(`SELECT * FROM truth_entries WHERE type = 'TB' AND status = 'contested' AND struck = 0 ORDER BY created_at ASC`)
      .all() as any[];
    return rows.map((r) => {
      const tb = this.rowToEntry(r) as TbEntry;
      const contests = this.db
        .prepare(`SELECT from_id FROM truth_links WHERE to_id = ? AND link_type = 'contests'`)
        .all(tb.id) as Array<{ from_id: string }>;
      const contestedBy = contests
        .map((c) => this.getEntry(c.from_id) as UvEntry)
        .filter((uv) => uv && uv.body.status === 'open');
      return { tombstone: tb, contestedBy };
    });
  }

  /**
   * Truth entries per filter. 'current' excludes overridden TBs, resolved
   * UVs, and struck entries; ties between a TB and a UV covering the same
   * subject break toward the TB (TBs sort first).
   */
  getTruth(
    filter: TruthFilter = 'current'
  ): Array<(TbEntry | UvEntry) & { embedding: number[] | null }> {
    let where: string;
    switch (filter) {
      case 'current':
        where = `struck = 0 AND ((type = 'TB' AND status IN ('active','contested')) OR (type = 'UV' AND status = 'open'))`;
        break;
      case 'contested':
        where = `struck = 0 AND ((type = 'TB' AND status = 'contested') OR (type = 'UV' AND status = 'open' AND json_extract(body, '$.contests') IS NOT NULL))`;
        break;
      case 'all':
        where = `type IN ('TB', 'UV')`;
        break;
    }
    const rows = this.db
      .prepare(`SELECT * FROM truth_entries WHERE ${where} ORDER BY (type = 'TB') DESC, created_at ASC`)
      .all() as any[];
    return rows.map((r) => ({
      ...(this.rowToEntry(r) as TbEntry | UvEntry),
      embedding: r.embedding
        ? Array.from(
            new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
          )
        : null,
    }));
  }

  /** Signed truth for wiki export: TBs and UVs, never proposals. */
  getExportableEntries(since?: string): Array<TbEntry | UvEntry> {
    const rows = (
      since
        ? this.db
            .prepare(`SELECT * FROM truth_entries WHERE type IN ('TB','UV') AND created_at > ? ORDER BY created_at ASC, id ASC`)
            .all(since)
        : this.db.prepare(`SELECT * FROM truth_entries WHERE type IN ('TB','UV') ORDER BY created_at ASC, id ASC`).all()
    ) as any[];
    return rows.map((r) => this.rowToEntry(r) as TbEntry | UvEntry);
  }

  getStats(): { tombstones: number; uvs: number; openUvs: number; openProposals: number; contested: number; rulings: number } {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number }).c;
    return {
      tombstones: count(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'TB'`),
      uvs: count(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'UV'`),
      openUvs: count(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'UV' AND status = 'open'`),
      openProposals: count(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'PROPOSAL' AND status = 'open'`),
      contested: count(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'TB' AND status = 'contested'`),
      rulings: count(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'RULING'`),
    };
  }

  private rowToEntry(row: any): TruthEntry {
    const links = this.db
      .prepare('SELECT * FROM truth_links WHERE from_id = ? OR to_id = ?')
      .all(row.id, row.id) as Array<{ from_id: string; to_id: string; link_type: string }>;
    return {
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      author: row.author,
      provenance: JSON.parse(row.provenance),
      agentSessionId: row.agent_session_id ?? null,
      origin: row.origin,
      body: JSON.parse(row.body),
      links: links.map((l) => ({ fromId: l.from_id, toId: l.to_id, type: l.link_type as LinkType })),
    };
  }
}

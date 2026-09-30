/**
 * Stenographer — Truth Ledger (append-only, supersede-only, hash-chained)
 *
 * The storage layer for TB/UV v2. No entry is ever mutated or deleted;
 * state changes are new entries linking backward. Status is not stored:
 * it is derived from an entry's inbound links (status.ts). The `status`
 * and `struck` columns cache that derivation, recomputed in the same
 * transaction as every append and checked by `stenographer verify` — there
 * is no statement here that sets a status, only links that imply one: the
 * override protocol is enforced here, not by convention.
 *
 * Every entry is chained to the one before it (prevHash, hash over its RFC
 * 8785 canonical form, chain.ts), so an edit made around the ledger shows.
 */

import type Database from 'better-sqlite3';
import { CHAIN_VERSION, chainRecord, recordHash, linkKey, verifyLedger, type IntegrityReport, type LedgerRow } from './chain.js';
import { canonicalize } from './jcs.js';
import { deriveAll, deriveStatus, deriveStruck, recordedStatus, type InboundLink } from './status.js';
import {
  ulid,
  canonicalIdentity,
  identityKey,
  isAnonymousIdentity,
  isReservedIdentity,
  hasControlCharacters,
  isSelfSigningEvidence,
  FILED_RULING_KINDS,
  DETECTOR_PREFIX,
  TbInputSchema,
  TombstoneDraftInputSchema,
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
  type MarkerBody,
  type TruthLink,
  type TruthEntryType,
  type TbBody,
  type UvBody,
  type ProposalBody,
  type VerifyBy,
  type TombstonedLiteral,
  type FiledRulingKind,
} from './types.js';

export class TruthWriteError extends Error {}
/** Contempt of corpus: corroboration must be provenance-independent (§11). */
export class ContemptError extends TruthWriteError {}
/** An agent-drafted proposal reached a signing path that isn't the notary's. */
export class NotarizationRequiredError extends TruthWriteError {}

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

/** Columns a pre-1.0 truth_entries table lacks. */
const CHAIN_COLUMNS: Array<[string, string]> = [
  ['seq', 'INTEGER'],
  ['prev_hash', 'TEXT'],
  ['hash', 'TEXT'],
  ['appended_links', 'TEXT'],
];

/** An entry as it is stored: the body as written, without the derived status. */
type NewEntry = Omit<TruthEntry, 'links' | 'body'> & { body: object };

export class TruthLedger {
  private db: Database.Database;
  /** Bumped on every write through this instance — cheap cache invalidation. */
  private writes = 0;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    // status and struck are caches of the derivation from links; seq,
    // prev_hash and hash are the chain; appended_links are the links each
    // entry's append wrote (part of what its hash covers).
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
        embedding BLOB,
        seq INTEGER,
        prev_hash TEXT,
        hash TEXT,
        appended_links TEXT
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
      CREATE TABLE IF NOT EXISTS truth_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(truth_entries)').all() as Array<{ name: string }>).map((c) => c.name)
    );
    for (const [name, type] of CHAIN_COLUMNS) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE truth_entries ADD COLUMN ${name} ${type}`);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_truth_type_status ON truth_entries(type, status);
      CREATE INDEX IF NOT EXISTS idx_truth_target_ref ON truth_entries(target_ref);
      CREATE INDEX IF NOT EXISTS idx_truth_links_to ON truth_links(to_id);
      CREATE INDEX IF NOT EXISTS idx_truth_links_from ON truth_links(from_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_truth_seq ON truth_entries(seq);
    `);

    this.chainExistingEntries();
  }

  /**
   * One-time migration of a pre-1.0 ledger. Its rows are chained in
   * insertion order exactly as they are (bodies included — nothing is
   * rewritten), each link is assigned to the entry that wrote it, and a
   * MARKER written by 'migration' closes the run: the chain attests to those
   * entries from the marker on, not from when they were written. Cached
   * statuses are then re-derived from links; the ones that change (e.g. a
   * TB the 0.x contest bookkeeping had resurrected, STENO-T-06) are listed
   * in the marker.
   */
  private chainExistingEntries(): void {
    const chained = () => Boolean(this.db.prepare(`SELECT 1 FROM truth_meta WHERE key = 'chain_version'`).get());
    if (chained()) return;

    this.tx(() => {
      // Checked again under the write lock: another process may have just migrated
      if (chained()) return;
      // Chained rows without the version record aren't a pre-1.0 ledger: leave
      // them for verify to report rather than re-chain over whatever changed.
      if (this.db.prepare('SELECT 1 FROM truth_entries WHERE hash IS NOT NULL LIMIT 1').get()) return;

      const rows = this.db.prepare('SELECT * FROM truth_entries ORDER BY rowid').all() as LedgerRow[];
      if (rows.length > 0) {
        const ids = new Set(rows.map((r) => r.id));
        const owned = new Map<string, TruthLink[]>();
        const orphans: TruthLink[] = [];
        const links = this.db.prepare('SELECT from_id, to_id, link_type FROM truth_links ORDER BY rowid').all() as Array<{
          from_id: string;
          to_id: string;
          link_type: string;
        }>;
        for (const l of links) {
          const link: TruthLink = { fromId: l.from_id, toId: l.to_id, type: l.link_type as LinkType };
          // Links are written with the entry they come from; a wiki import
          // also carries links whose source it didn't bring along.
          const owner = ids.has(link.fromId) ? link.fromId : ids.has(link.toId) ? link.toId : null;
          if (owner) owned.set(owner, [...(owned.get(owner) ?? []), link]);
          else orphans.push(link);
        }

        let prevHash: string | null = null;
        let seq = 0;
        const update = this.db.prepare(
          'UPDATE truth_entries SET seq = ?, prev_hash = ?, hash = ?, appended_links = ? WHERE id = ?'
        );
        for (const row of rows) {
          const appended = JSON.stringify(owned.get(row.id) ?? []);
          let hash: string;
          try {
            hash = recordHash(chainRecord({ ...row, appended_links: appended, prev_hash: prevHash }));
          } catch {
            // Unreadable or uncanonicalizable (e.g. a lone surrogate): left out
            // of the chain, where verify reports it, rather than unopenable
            continue;
          }
          update.run(++seq, prevHash, hash, appended, row.id);
          prevHash = hash;
        }

        const parse = (body: string): unknown => {
          try {
            return JSON.parse(body);
          } catch {
            return undefined;
          }
        };
        const derived = deriveAll(
          rows.map((r) => ({ id: r.id, type: r.type as TruthEntryType, recorded: recordedStatus(parse(r.body)) })),
          links.map((l) => ({ fromId: l.from_id, toId: l.to_id, type: l.link_type as LinkType }))
        );
        const statusCorrections: MarkerBody['statusCorrections'] = [];
        for (const row of rows) {
          const want = derived.get(row.id)!;
          if ((row.status ?? null) !== want.status) {
            statusCorrections.push({ id: row.id, field: 'status', was: row.status ?? null, now: want.status });
          }
          if (Boolean(row.struck) !== want.struck) {
            statusCorrections.push({ id: row.id, field: 'struck', was: String(Boolean(row.struck)), now: String(want.struck) });
          }
        }

        this.append(
          {
            id: ulid(),
            type: 'MARKER',
            createdAt: new Date().toISOString(),
            author: MIGRATION_AUTHOR,
            provenance: { kind: 'migration' },
            agentSessionId: null,
            origin: 'local',
            body: {
              kind: 'chained-at-migration',
              note:
                'The entries before this marker were written before the ledger was hash-chained. Their hashes were ' +
                'computed when this marker was written, so the chain shows they have not changed since then — not ' +
                'since they were written.',
              entries: seq,
              links: links.length,
              through: prevHash,
              statusCorrections,
            } satisfies MarkerBody,
          },
          orphans
        );
        this.refresh(rows.map((r) => r.id));
      }
      this.db.prepare(`INSERT INTO truth_meta (key, value) VALUES ('chain_version', ?)`).run(CHAIN_VERSION);
    });
  }

  // ─────────────────────────────────────────────────────────
  // Internal write primitives
  // ─────────────────────────────────────────────────────────

  /**
   * The accountability floor for every write: no anonymous or generic
   * identity, no control characters, and no reserved identity — 'migration'
   * belongs to the backfill path and 'detector:*' to the pipelines that file
   * proposals (`allowDetector`). Returns the canonical (stored) form.
   */
  private accountable(identity: string, role: string, opts: { allowDetector?: boolean } = {}): string {
    if (typeof identity !== 'string' || isAnonymousIdentity(identity)) {
      throw new TruthWriteError(
        `${role} '${identity}' is not an accountable identity — anonymous writes are rejected at the schema level`
      );
    }
    if (hasControlCharacters(identity)) {
      throw new TruthWriteError(`${role} identity contains control characters`);
    }
    const detector = identityKey(identity).startsWith(DETECTOR_PREFIX);
    if (isReservedIdentity(identity) && !(detector && opts.allowDetector)) {
      throw new TruthWriteError(
        `${role} '${identity}' is reserved for the ${detector ? 'detector' : 'backfill'} path`
      );
    }
    return canonicalIdentity(identity);
  }

  /**
   * Who and which agent session stand behind an entry: its author, a TB's
   * signer, and the drafter of any proposal it was signed from.
   */
  private lineage(target: TruthEntry): { identities: string[]; sessions: string[] } {
    const identities = [target.author];
    const sessions = [target.agentSessionId];
    if (target.type === 'TB') identities.push((target.body as TbBody).signedBy ?? '');
    for (const link of target.links) {
      if (link.type !== 'signs' || link.fromId !== target.id) continue;
      const draft = this.getEntry(link.toId);
      if (draft) {
        identities.push(draft.author);
        sessions.push(draft.agentSessionId);
      }
    }
    return {
      identities: identities.filter(Boolean).map(identityKey),
      sessions: sessions.map((s) => s?.trim()).filter((s): s is string => Boolean(s)),
    };
  }

  /**
   * Provenance-independence check (contempt of corpus, §11): evidence used
   * to verify or sign an entry may not share lineage with the assertion it
   * supports. Repetition is not evidence. Identities compare canonically
   * (case, width, whitespace and invisible characters don't make a second
   * person), and every identity acting — resolver and signer — is checked.
   */
  private requireIndependence(
    actor: { author: string; signedBy?: string | null; agentSessionId?: string | null },
    target: TruthEntry,
    action: string
  ): void {
    const { identities, sessions } = this.lineage(target);
    for (const who of [actor.author, actor.signedBy]) {
      if (who && identities.includes(identityKey(who))) {
        throw new ContemptError(
          `contempt of corpus: '${who}' cannot ${action} entry ${target.id} — they already stand behind it (as author, signer or drafter); corroboration must be provenance-independent`
        );
      }
    }
    const session = actor.agentSessionId?.trim();
    if (session && sessions.includes(session)) {
      throw new ContemptError(
        `contempt of corpus: ${action} of ${target.id} traces to the same agent session (${session}) as its target — one opinion wearing two hats is not two witnesses`
      );
    }
  }

  /**
   * Changes whenever the ledger may have changed: in-process writes bump
   * the counter, and SQLite's data_version moves on commits from other
   * connections. Caches over the ledger (e.g. the active-TB cache for
   * objections) compare this instead of re-querying.
   */
  generation(): string {
    const dataVersion = this.db.pragma('data_version', { simple: true }) as number;
    return `${this.writes}:${dataVersion}`;
  }

  /**
   * Runs `fn` in one write transaction. The outermost one begins IMMEDIATE,
   * so the chain head it reads can't move under it from another connection.
   */
  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn).immediate();
  }

  /**
   * The only way anything enters the ledger: chains the entry to the current
   * head, writes the links it carries, and re-derives the cached status of
   * everything those links touch.
   */
  private append(entry: NewEntry, links: TruthLink[] = [], opts: { embedding?: number[]; targetRef?: string | null } = {}): void {
    this.tx(() => {
      this.writes++;
      const unique = [...new Map(links.map((l) => [linkKey(l), { fromId: l.fromId, toId: l.toId, type: l.type }])).values()];
      const head = this.db
        .prepare('SELECT seq, hash FROM truth_entries WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; hash: string } | undefined;
      const row = {
        id: entry.id,
        type: entry.type,
        created_at: entry.createdAt,
        author: entry.author,
        provenance: JSON.stringify(entry.provenance),
        agent_session_id: entry.agentSessionId ?? null,
        origin: entry.origin,
        body: JSON.stringify(entry.body),
        target_ref: opts.targetRef !== undefined ? opts.targetRef : ((entry.body as { targetRef?: string | null }).targetRef ?? null),
        appended_links: JSON.stringify(unique),
        prev_hash: head?.hash ?? null,
      };
      let hash: string;
      try {
        hash = recordHash(chainRecord(row));
      } catch (err) {
        // e.g. a lone surrogate: what can't be canonicalized can't be chained
        throw new TruthWriteError(`entry ${entry.id} can't be hashed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.db
        .prepare(`
          INSERT INTO truth_entries (id, type, created_at, author, provenance, agent_session_id, origin,
            body, target_ref, embedding, seq, prev_hash, hash, appended_links)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          row.id,
          row.type,
          row.created_at,
          row.author,
          row.provenance,
          row.agent_session_id,
          row.origin,
          row.body,
          row.target_ref,
          opts.embedding && opts.embedding.length > 0 ? Buffer.from(new Float32Array(opts.embedding).buffer) : null,
          (head?.seq ?? 0) + 1,
          row.prev_hash,
          hash,
          row.appended_links
        );
      const insertLink = this.db.prepare('INSERT OR IGNORE INTO truth_links (from_id, to_id, link_type) VALUES (?, ?, ?)');
      for (const link of unique) insertLink.run(link.fromId, link.toId, link.type);
      this.refresh([entry.id, ...unique.flatMap((l) => [l.fromId, l.toId])]);
    });
  }

  /**
   * Re-derives the cached status of `ids` from their inbound links, plus
   * the TBs contested by any of them (a TB's status reads its contesting
   * UVs'). The only writer of the status and struck columns.
   */
  private refresh(ids: Iterable<string>): void {
    const pending = new Set(ids);
    const contested = this.db.prepare(`SELECT to_id FROM truth_links WHERE from_id = ? AND link_type = 'contests'`);
    for (const id of [...pending]) {
      for (const r of contested.all(id) as Array<{ to_id: string }>) pending.add(r.to_id);
    }
    const select = this.db.prepare('SELECT id, type, body, status, struck FROM truth_entries WHERE id = ?');
    const rows = [...pending]
      .map((id) => select.get(id) as Pick<LedgerRow, 'id' | 'type' | 'body' | 'status' | 'struck'> | undefined)
      .filter((r): r is Pick<LedgerRow, 'id' | 'type' | 'body' | 'status' | 'struck'> => Boolean(r))
      // TBs last: they read the status just derived for their contests
      .sort((a, b) => Number(a.type === 'TB') - Number(b.type === 'TB'));

    const inbound = this.db.prepare(`
      SELECT l.link_type, e.type AS from_type, e.status AS from_status
      FROM truth_links l LEFT JOIN truth_entries e ON e.id = l.from_id
      WHERE l.to_id = ?
    `);
    const update = this.db.prepare('UPDATE truth_entries SET status = ?, struck = ? WHERE id = ?');
    for (const row of rows) {
      const links = (inbound.all(row.id) as Array<{ link_type: string; from_type: string | null; from_status: string | null }>).map(
        (l): InboundLink => ({
          type: l.link_type as LinkType,
          from: l.from_type ? { type: l.from_type as TruthEntryType, status: l.from_status } : null,
        })
      );
      const status = deriveStatus(row.type as TruthEntryType, recordedStatus(JSON.parse(row.body)), links);
      const struck = deriveStruck(links) ? 1 : 0;
      if (status !== (row.status ?? null) || struck !== row.struck) update.run(status, struck, row.id);
    }
  }

  /** Validates the hash chain, the links, and every cached status (see chain.ts). */
  verify(): IntegrityReport {
    return verifyLedger(this.db);
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
   * of the same kind against the same target, from the same author and with
   * the same notary requirement, is returned instead of duplicated
   * (batching by target entity, §10). Dedupe never crosses authors: one
   * author's draft is never folded into another's.
   */
  addProposal(
    body: Omit<ProposalBody, 'status' | 'dismissedBy' | 'dismissReason'>,
    ctx: WriteContext
  ): ProposalEntry {
    const author = this.accountable(ctx.author, 'proposal author', { allowDetector: true });

    if (body.targetRef) {
      const existing = this.findOpenProposal({
        kind: body.kind,
        targetRef: body.targetRef,
        author,
        requiresNotary: Boolean(body.requiresNotary),
      });
      if (existing) return existing;
    }

    // No status or dismissal fields: those are derived (open until a signs or
    // dismisses link arrives), whatever a caller passed
    const { status: _s, dismissedBy: _d, dismissReason: _r, ...stored } = body as ProposalBody;
    const id = ulid();
    this.append(
      {
        id,
        type: 'PROPOSAL',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: stored satisfies Omit<ProposalBody, 'status'>,
      },
      [],
      { embedding: ctx.embedding }
    );
    return this.getEntry(id) as ProposalEntry;
  }

  /** The open proposal `addProposal` would dedupe into, if any. */
  findOpenProposal(match: {
    kind: ProposalBody['kind'];
    targetRef: string;
    author: string;
    requiresNotary: boolean;
  }): ProposalEntry | null {
    const rows = this.db
      .prepare(`
        SELECT id FROM truth_entries
        WHERE type = 'PROPOSAL' AND status = 'open' AND target_ref = ?
        ORDER BY created_at ASC
      `)
      .all(match.targetRef) as Array<{ id: string }>;
    const author = identityKey(match.author);
    for (const row of rows) {
      const entry = this.getEntry(row.id) as ProposalEntry;
      if (
        entry.body.kind === match.kind &&
        identityKey(entry.author) === author &&
        Boolean(entry.body.requiresNotary) === match.requiresNotary
      ) {
        return entry;
      }
    }
    return null;
  }

  /**
   * An agent drafts a tombstone it believes in but may not sign. The draft is
   * validated as a TB would be (evidence, literals) so the notary reviews
   * something that can actually mint, and it is marked `requiresNotary`:
   * only a person, through the notary path, can turn it into truth.
   */
  draftTombstone(
    input: { claim: string; evidence: Evidence[]; literals?: TombstonedLiteral[]; rationale?: string; targetRef?: string },
    ctx: WriteContext
  ): ProposalEntry {
    // Drafts come from agents and people, never from a reserved identity
    this.accountable(ctx.author, 'drafter');
    const { claim, evidence, literals } = TombstoneDraftInputSchema.parse(input);
    return this.addProposal(
      {
        kind: 'tombstone',
        draft: { claim, evidence, ...(literals && literals.length > 0 ? { literals } : {}) },
        signal: { source: 'agent-draft', ...(input.rationale ? { detail: input.rationale } : {}) },
        targetRef: input.targetRef ?? null,
        requiresNotary: true,
      },
      ctx
    );
  }

  /**
   * An accountable author signs a proposal, minting the real TB/UV with a
   * `signs` link back. `edits` corrects the draft at signing time — the
   * signed version is what's true, the draft is history.
   *
   * Agent-drafted proposals (`requiresNotary`) only mint when the caller
   * passes `notarized` — which only the notary paths do.
   */
  signProposal(
    proposalId: string,
    signedBy: string,
    edits?: Record<string, unknown>,
    ctx?: Partial<WriteContext> & { notarized?: boolean }
  ): TbEntry | UvEntry {
    signedBy = this.accountable(signedBy, 'signer');
    const proposal = this.mustGetTyped<ProposalEntry>(proposalId, 'PROPOSAL');
    if (proposal.body.status !== 'open') {
      throw new TruthWriteError(`proposal ${proposalId} is already ${proposal.body.status}`);
    }
    if (proposal.body.requiresNotary && !ctx?.notarized) {
      throw new NotarizationRequiredError(
        `proposal ${proposalId} was drafted by '${proposal.author}' and must be notarized by a person — ` +
          'it has been raised to them for approval; it is not truth until they sign it'
      );
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

    // The signs link closes the proposal: it derives as signed from here on
    const signs = [{ toId: proposalId, type: 'signs' as const }];
    if (proposal.body.kind === 'tombstone') {
      return this.insertTb(TbInputSchema.parse({ ...draft, signedBy }), writeCtx, signs);
    }
    return this.insertUv(UvInputSchema.parse(draft), writeCtx, signs);
  }

  /**
   * Dismissal reasons are kept — they are training data for the detector.
   * A dismissal is an appended RULING (kind 'dismissal') with a `dismisses`
   * link; the proposal itself is never rewritten. Its `dismissedBy` and
   * `dismissReason` are read back from that ruling.
   */
  dismissProposal(
    proposalId: string,
    dismissedBy: string,
    reason: string,
    ctx: Partial<Omit<WriteContext, 'author'>> = {}
  ): ProposalEntry {
    dismissedBy = this.accountable(dismissedBy, 'dismisser');
    if (!reason || reason.trim().length === 0) {
      throw new TruthWriteError('a dismissal requires a reason');
    }
    const proposal = this.mustGetTyped<ProposalEntry>(proposalId, 'PROPOSAL');
    if (proposal.body.status !== 'open') {
      throw new TruthWriteError(`proposal ${proposalId} is already ${proposal.body.status}`);
    }

    this.insertRuling(
      { kind: 'dismissal', opinion: reason, target: proposalId },
      { ...ctx, author: dismissedBy },
      [{ toId: proposalId, type: 'dismisses' }]
    );
    return this.getEntry(proposalId) as ProposalEntry;
  }

  // ─────────────────────────────────────────────────────────
  // Direct assertion — for authors who already know
  // ─────────────────────────────────────────────────────────

  assertTombstone(
    input: { claim: string; evidence: Evidence[]; signedBy: string; literals?: TombstonedLiteral[] },
    ctx: WriteContext
  ): TbEntry {
    const parsed = TbInputSchema.parse(input);
    const author = this.accountable(ctx.author, 'author');
    return this.insertTb(parsed, { ...ctx, author });
  }

  assertUv(
    input: { assertion: string; basis: string; verifyBy: VerifyBy; contests?: string | null },
    ctx: WriteContext
  ): UvEntry {
    const parsed = UvInputSchema.parse(input);
    const author = this.accountable(ctx.author, 'author');
    return this.insertUv(parsed, { ...ctx, author });
  }

  /** Outbound links of a new entry, by target and type. */
  private static outbound(fromId: string, links: Array<{ toId: string; type: LinkType }>): TruthLink[] {
    return links.map((l) => ({ fromId, toId: l.toId, type: l.type }));
  }

  private insertTb(
    input: { claim: string; evidence: Evidence[]; signedBy: string; literals?: TombstonedLiteral[] },
    ctx: WriteContext,
    links: Array<{ toId: string; type: LinkType }> = []
  ): TbEntry {
    const id = ulid();
    this.append(
      {
        id,
        type: 'TB',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        // No status: a TB is active until links say otherwise
        body: {
          claim: input.claim,
          evidence: input.evidence,
          signedBy: input.signedBy,
          // Only present when given, so literal-free TBs keep their exact shape
          ...(input.literals && input.literals.length > 0 ? { literals: input.literals } : {}),
        } satisfies Omit<TbBody, 'status'>,
      },
      TruthLedger.outbound(id, links),
      { embedding: ctx.embedding }
    );
    return this.getEntry(id) as TbEntry;
  }

  private insertUv(
    input: { assertion: string; basis: string; verifyBy: VerifyBy; contests?: string | null },
    ctx: WriteContext,
    links: Array<{ toId: string; type: LinkType }> = []
  ): UvEntry {
    const insert = (): string => {
      let contests: string | null = null;
      if (input.contests) {
        const tb = this.mustGetTyped<TbEntry>(input.contests, 'TB');
        if (tb.body.status === 'overridden') {
          throw new TruthWriteError(`TB ${tb.id} is already overridden — nothing to contest`);
        }
        contests = tb.id;
      }

      const id = ulid();
      this.append(
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
          } satisfies Omit<UvBody, 'status'>,
        },
        // Override protocol path 1 (contest): the contests link makes the TB
        // contested while this UV is open; it remains active truth.
        TruthLedger.outbound(id, [...(contests ? [{ toId: contests, type: 'contests' as const }] : []), ...links]),
        { embedding: ctx.embedding }
      );
      return id;
    };
    return this.getEntry(this.tx(insert)) as UvEntry;
  }

  // ─────────────────────────────────────────────────────────
  // UV resolution (§5/§6)
  // ─────────────────────────────────────────────────────────

  /**
   * Resolves an open UV with an evidence-bearing ADDENDUM. Only evidence
   * stenographer executed self-signs (summary judgment); caller-submitted
   * command output is a claim (`claimed-command`), so any resolution that
   * mints a TB requires a human `signedBy` plus a written `opinion`,
   * recorded as a promotion RULING.
   *
   * If the UV contests a TB:
   * - verified → the addendum overrides the TB (override protocol path 2, proven)
   * - refuted  → the contest closes; the TB derives as active again unless
   *              another contest is open or it was overridden meanwhile
   *
   * `allowMint: false` (the MCP agent profile) refuses any resolution that
   * would mint a TB, so an agent cannot turn its own resolution into truth:
   * that stays a person's call.
   */
  resolveUv(
    uvId: string,
    resolution: 'verified' | 'refuted',
    evidence: Evidence[],
    ctx: WriteContext & { signedBy?: string; opinion?: string; mintTombstone?: string; allowMint?: boolean }
  ): { uv: UvEntry; addendum: AddendumEntry; tombstone: TbEntry | null; ruling: RulingEntry | null } {
    const author = this.accountable(ctx.author, 'resolver');
    const signedBy = ctx.signedBy ? this.accountable(ctx.signedBy, 'signer') : undefined;
    ctx = { ...ctx, author, signedBy };
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
    // Refuting a contest restores the contested TB: its own authors can't be
    // the ones to do that (conceding by verifying the contest is fine).
    if (contestedTb && resolution === 'refuted') {
      this.requireIndependence(ctx, contestedTb, 'refute the contest against');
    }
    // Minting a TB happens when the resolution invalidates existing truth:
    // a verified contest overrides its TB; a refuted UV that propagated gets
    // a TB minted against the UV itself (mintTombstone carries the claim).
    const mintsTb = Boolean(
      (resolution === 'verified' && contestedTb) || ctx.mintTombstone
    );
    if (mintsTb && ctx.allowMint === false) {
      throw new NotarizationRequiredError(
        contestedTb && resolution === 'verified'
          ? `verifying UV ${uvId} would override TB ${contestedTb.id} and mint its successor — that needs a person to notarize: ` +
              'leave the UV open with your evidence, or draft the successor with propose_tombstone'
          : `resolving UV ${uvId} with mintTombstone would mint a TB — that needs a person to notarize: draft it with propose_tombstone`
      );
    }
    if (mintsTb && !selfSigning && !signedBy) {
      throw new TruthWriteError(
        'evidence stenographer did not execute cannot self-sign a tombstone — a human signedBy is required ' +
          '(submitted command output is a claim, and judgment calls are not summary judgment)'
      );
    }

    const { addendumId, tombstoneId, rulingId } = this.tx(() => {
      const now = ctx.timestamp ?? new Date().toISOString();

      // The addendum resolves the UV and, verifying a contest, overrides its
      // TB. A refuted contest needs no link to the TB: with the UV no longer
      // open, the contest stops counting, and an override never un-counts.
      const addendumId = ulid();
      this.append(
        {
          id: addendumId,
          type: 'ADDENDUM',
          createdAt: now,
          author: ctx.author,
          provenance: ctx.provenance ?? MANUAL,
          agentSessionId: ctx.agentSessionId ?? null,
          origin: 'local',
          body: { evidence: parsedEvidence, note: ctx.opinion ?? null },
        },
        TruthLedger.outbound(addendumId, [
          { toId: uvId, type: resolution === 'verified' ? 'verifies' : 'refutes' },
          ...(contestedTb && resolution === 'verified' ? [{ toId: contestedTb.id, type: 'overrides' as const }] : []),
        ])
      );

      let tombstoneId: string | null = null;
      if (mintsTb) {
        const signer = ctx.signedBy ?? ctx.author;
        const claim =
          ctx.mintTombstone ??
          (resolution === 'verified' && contestedTb
            ? `Overridden: "${contestedTb.body.claim}" — contradicted by verified assertion: ${uv.body.assertion}`
            : `Refuted: "${uv.body.assertion}"`);
        const supersedes =
          resolution === 'verified' && contestedTb
            ? contestedTb.id
            : resolution === 'refuted'
              ? uvId // the correction is discoverable from the refuted UV
              : null;
        const tb = this.insertTb(
          { claim, evidence: parsedEvidence, signedBy: signer },
          { ...ctx, timestamp: now, embedding: ctx.embedding },
          supersedes ? [{ toId: supersedes, type: 'supersedes' }] : []
        );
        tombstoneId = tb.id;
      }

      // Promotion ruling: the gavel on a non-self-signing resolution (§11)
      let rulingId: string | null = null;
      if (mintsTb && !selfSigning) {
        rulingId = this.insertRuling(
          { kind: 'promotion', opinion: ctx.opinion ?? `Evidence ruled sufficient by ${signedBy}`, target: uvId },
          { ...ctx, author: signedBy!, timestamp: now }
        );
      }

      return { addendumId, tombstoneId, rulingId };
    });

    return {
      uv: this.getEntry(uvId) as UvEntry,
      addendum: this.getEntry(addendumId) as AddendumEntry,
      tombstone: tombstoneId ? (this.getEntry(tombstoneId) as TbEntry) : null,
      ruling: rulingId ? (this.getEntry(rulingId) as RulingEntry) : null,
    };
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
    ctx = { ...ctx, author: this.accountable(ctx.author, 'author') };
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

    const addendumId = ulid();
    this.append(
      {
        id: addendumId,
        type: 'ADDENDUM',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: { evidence: parsedEvidence, note: addendum.note ?? null },
      },
      TruthLedger.outbound(addendumId, [{ toId: tbId, type: 'overrides' }])
    );
    return {
      tombstone: this.getEntry(tbId) as TbEntry,
      addendum: this.getEntry(addendumId) as AddendumEntry,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Rulings (§11)
  // ─────────────────────────────────────────────────────────

  fileRuling(
    input: { kind: FiledRulingKind; opinion: string; target: string },
    ctx: WriteContext
  ): { ruling: RulingEntry; conductTombstone: TbEntry | null } {
    ctx = { ...ctx, author: this.accountable(ctx.author, 'ruling author') };
    // An unrecognized kind is a mistake, not contempt: contempt mints a TB
    if (!(FILED_RULING_KINDS as readonly string[]).includes(input.kind)) {
      throw new TruthWriteError(
        `unknown ruling kind '${input.kind}' — expected one of ${FILED_RULING_KINDS.join(', ')}`
      );
    }
    if (!input.opinion || input.opinion.trim().length === 0) {
      throw new TruthWriteError('a ruling requires a written opinion — rulings are precedent');
    }

    const { rulingId, tbId } = this.tx((): { rulingId: string; tbId: string | null } => {
      let rulingId: string;
      let tbId: string | null = null;

      if (input.kind === 'strike') {
        // Inadmissible for retrieval; nothing is deleted — append-only holds
        const target = this.mustGet(input.target);
        rulingId = this.insertRuling(input, ctx, [{ toId: target.id, type: 'strikes' }]);
      } else if (input.kind === 'promotion') {
        this.mustGet(input.target);
        rulingId = this.insertRuling(input, ctx);
      } else {
        rulingId = this.insertRuling(input, ctx);
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

    return {
      ruling: this.getEntry(rulingId) as RulingEntry,
      conductTombstone: tbId ? (this.getEntry(tbId) as TbEntry) : null,
    };
  }

  /**
   * Ruling on a real-time objection (§12). The real-time layer feeds the
   * same record — it does not get its own — so the judgment lands as an
   * ordinary RULING targeting the TB: sustained is corroboration for the
   * TB, overruled is signal for tightening the matcher. Neither changes
   * the TB's status.
   *
   * No provenance-independence check: the corroborating evidence is the
   * detector's catch in a transcript, not the ruler's word, so the
   * operator who signed a TB may still rule on objections that cite it.
   */
  fileObjectionRuling(
    input: { objectionId: string; tbId: string; outcome: 'sustained' | 'overruled'; opinion: string },
    ctx: WriteContext
  ): RulingEntry {
    ctx = { ...ctx, author: this.accountable(ctx.author, 'ruling author') };
    if (!input.opinion || input.opinion.trim().length === 0) {
      throw new TruthWriteError('a ruling requires a written opinion — rulings are precedent');
    }
    this.mustGetTyped<TbEntry>(input.tbId, 'TB');
    const id = ulid();
    this.append(
      {
        id,
        type: 'RULING',
        createdAt: ctx.timestamp ?? new Date().toISOString(),
        author: ctx.author,
        provenance: ctx.provenance ?? MANUAL,
        agentSessionId: ctx.agentSessionId ?? null,
        origin: 'local',
        body: {
          kind: 'objection',
          opinion: input.opinion,
          target: input.tbId,
          objectionId: input.objectionId,
          outcome: input.outcome,
        },
      },
      [],
      { embedding: ctx.embedding }
    );
    return this.getEntry(id) as RulingEntry;
  }

  /** Active or contested TBs that carry matchable literals, excluding struck ones. */
  getMatchableTombstones(): TbEntry[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM truth_entries
        WHERE type = 'TB' AND status IN ('active','contested') AND struck = 0
          AND json_array_length(json_extract(body, '$.literals')) > 0
        ORDER BY created_at ASC
      `)
      .all() as any[];
    return rows.map((r) => this.rowToEntry(r) as TbEntry);
  }

  private insertRuling(
    input: { kind: FiledRulingKind | 'dismissal'; opinion: string; target: string },
    ctx: WriteContext,
    links: Array<{ toId: string; type: LinkType }> = []
  ): string {
    const id = ulid();
    this.append(
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
      TruthLedger.outbound(id, links),
      { embedding: ctx.embedding }
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
    this.append(
      {
        id,
        type: 'TB',
        createdAt: legacy.timestamp,
        author: MIGRATION_AUTHOR,
        provenance: { kind: 'migration', ref: legacy.id },
        agentSessionId: null,
        origin: 'local',
        body: {
          claim: `Superseded: "${legacy.superseded}" → "${legacy.correctedTo}" (${legacy.reason})`,
          evidence: [{ kind: 'wiki', ref: `legacy:${legacy.id}`, detail: 'pre-assertion auto-close' }],
          signedBy: null,
        } satisfies Omit<TbBody, 'status'>,
      },
      [],
      { targetRef: `legacy:${legacy.id}` }
    );
    return this.getEntry(id) as TbEntry;
  }

  /**
   * Used by wiki import: entries keep their original ids and authors, and
   * their body as the wiki wrote it — including the status the line
   * carried, which counts only as a terminal floor (status.ts). The entry is
   * chained like any other, with the links the line carried about itself.
   *
   * Since links decide status, a line may only speak for itself: it keeps
   * links into the entry (its own history) and the links a TB or UV writes —
   * a UV's contest (the one its `contests` field names, which it implies),
   * a TB's supersessions, and a TB's signature of a proposal this ledger
   * doesn't hold. Anything else it carries, such as an `overrides` or
   * `strikes` aimed at a local entry, is dropped.
   */
  importEntry(entry: TruthEntry, embedding?: number[]): 'inserted' | 'unchanged' | 'conflict' {
    const existing = this.getEntry(entry.id);
    if (existing) {
      const same = canonicalize(existing.body) === canonicalize(entry.body) && existing.author === entry.author;
      return same ? 'unchanged' : 'conflict';
    }
    const contests = entry.type === 'UV' ? ((entry.body as UvBody).contests ?? null) : null;
    const ownLink = (link: TruthLink): boolean => {
      if (link.toId === entry.id) return true;
      if (link.fromId !== entry.id) return false;
      if (entry.type === 'UV') return link.type === 'contests' && link.toId === contests;
      return link.type === 'supersedes' || (link.type === 'signs' && !this.getEntry(link.toId));
    };
    this.append(
      entry,
      [...entry.links.filter(ownLink), ...(contests ? [{ fromId: entry.id, toId: contests, type: 'contests' as const }] : [])],
      { embedding }
    );
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
      default:
        throw new TruthWriteError(`unknown truth filter '${filter}' — expected current, all, or contested`);
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

  /**
   * The stored entry as callers see it: its body carries the derived status,
   * and a dismissed proposal carries who dismissed it and why, read from the
   * dismissal ruling (0.x rows recorded both in the body itself).
   */
  private rowToEntry(row: any): TruthEntry {
    const links = this.db
      .prepare('SELECT * FROM truth_links WHERE from_id = ? OR to_id = ? ORDER BY rowid')
      .all(row.id, row.id) as Array<{ from_id: string; to_id: string; link_type: string }>;
    let body = JSON.parse(row.body);
    if (row.status !== null && row.status !== undefined) {
      if (row.type === 'TB' && !('status' in body) && 'literals' in body) {
        // Where a TB body has always carried it: before its literals
        const { literals, ...rest } = body;
        body = { ...rest, status: row.status, literals };
      } else {
        body.status = row.status;
      }
    }
    if (row.type === 'PROPOSAL' && row.status === 'dismissed' && body.dismissedBy === undefined) {
      const ruling = this.db
        .prepare(`
          SELECT e.author, e.body FROM truth_links l JOIN truth_entries e ON e.id = l.from_id
          WHERE l.to_id = ? AND l.link_type = 'dismisses' ORDER BY e.seq LIMIT 1
        `)
        .get(row.id) as { author: string; body: string } | undefined;
      if (ruling) {
        body.dismissedBy = ruling.author;
        body.dismissReason = (JSON.parse(ruling.body) as RulingEntry['body']).opinion;
      }
    }
    return {
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      author: row.author,
      provenance: JSON.parse(row.provenance),
      agentSessionId: row.agent_session_id ?? null,
      origin: row.origin,
      body,
      links: links.map((l) => ({ fromId: l.from_id, toId: l.to_id, type: l.link_type as LinkType })),
    };
  }
}

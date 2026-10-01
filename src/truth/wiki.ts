/**
 * Stenographer — Team llm-wiki interop: the truth format, v2 (§8)
 *
 * The normative spec is spec/truth-format/README.md, with a JSON Schema
 * (wiki-line.v2.schema.json) and golden fixtures. In short:
 *
 * - A wiki file is one ledger's append-only, hash-chained line stream:
 *   every line has `seq` (1, 2, 3, … per ledger), `prevHash` (the previous
 *   line's hash) and `hash` (SHA-256 of the line's JCS form without `hash`).
 *   One writer per file.
 * - Entry lines are the ledger's records: TB and UV (with the status they
 *   had when written), and the ADDENDUM and RULING entries that change a
 *   status. Every later status change is an appended TRANSITION line
 *   naming its target, the new status and its cause. A reader's current
 *   status for an entry is the status of the highest-seq TRANSITION that
 *   targets it, else the entry line's own. Nothing is rewritten.
 * - Unknown or missing statuses are excluded from current truth (fail
 *   closed). Proposals never travel in a wiki file; PROPOSAL lines are the
 *   intake's format (intake.ts).
 *
 * Import validates every line and the chain, then runs the file in one
 * transaction: either every line lands, or none does and the result lists
 * each line's error. Each entry is appended through the ledger's admit()
 * check, like any live write. A TB lands as truth only when it is signed
 * and verifiable — a hash-chained line whose signer the signer registry
 * (when there is one) lists; otherwise it is filed as a reconciliation
 * PROPOSAL. Status changes are applied from the ADDENDUM and RULING entries
 * that cause them, under the same trust rules; TRANSITION lines are checked
 * against their causes, since this ledger derives status itself.
 * Re-importing a file is a no-op.
 *
 * v1 lines (0.x: no schemaVersion, a `status` field) are still read; see
 * the spec's upgrade notes.
 */

import { z } from 'zod';
import { canonicalize, sha256Hex } from './jcs.js';
import { deriveStatus, deriveStruck, recordedStatus, type InboundLink } from './status.js';
import { resolveIdentity, type SignerRegistry, type SignerRole } from './identity.js';
import { INBOUND_LINKS, OUTBOUND_LINKS, type LedgerRecord, type NewEntry, type TruthLedger } from './ledger.js';
import {
  EVIDENCE_KINDS,
  EvidenceSchema,
  LINK_TYPES,
  MIGRATION_AUTHOR,
  ProvenanceSchema,
  TombstonedLiteralSchema,
  VerifyBySchema,
  canonicalIdentity,
  hasControlCharacters,
  identityKey,
  isAnonymousIdentity,
  isReservedIdentity,
  type LinkType,
  type TruthEntryType,
  type TruthLink,
} from './types.js';

export const WIKI_SCHEMA_VERSION = 2;

/** The detector identity reconciliation proposals are filed under. */
export const WIKI_SYNC_DETECTOR = 'detector:wiki-sync';

/** The statuses a TB or UV line, or a TRANSITION, can carry. `struck` is sticky. */
export const WIKI_STATUSES = {
  TB: ['active', 'contested', 'overridden', 'struck'],
  UV: ['open', 'verified', 'refuted', 'struck'],
} as const;

/** What caused a TRANSITION. `dismiss` and `promote` are for proposal streams; a wiki export never carries them. */
export const CAUSE_KINDS = ['contest', 'override', 'strike', 'verify', 'refute', 'dismiss', 'promote'] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

/** Links whose arrival changes the status of a TB or UV. */
const STATUS_LINKS: readonly LinkType[] = ['contests', 'overrides', 'verifies', 'refutes', 'strikes'];

/** Ruling kinds the ledger knows (types.ts RulingKind). */
const RULING_KINDS = ['strike', 'promotion', 'contempt', 'objection', 'dismissal'];

// ─────────────────────────────────────────────────────────────
// Line shapes
// ─────────────────────────────────────────────────────────────

/** One v2 line, as written: fields in the spec, plus whatever a newer writer added (preserved, not interpreted). */
export type WikiLine = Record<string, unknown> & {
  schemaVersion: 2;
  seq: number;
  id: string;
  type: 'TB' | 'UV' | 'ADDENDUM' | 'RULING' | 'PROPOSAL' | 'TRANSITION';
  ts: string;
  author: string;
  prevHash: string | null;
  hash: string;
};

/** A line read back and validated. `line` is the parsed object, unknown fields included. */
export interface DecodedWikiLine {
  version: 1 | 2;
  type: WikiLine['type'];
  line: Record<string, unknown>;
  /** v2 only. */
  seq: number | null;
  prevHash: string | null;
  hash: string | null;
}

export class WikiLineError extends Error {}

// ─────────────────────────────────────────────────────────────
// Structure (mirrors spec/truth-format/wiki-line.v2.schema.json)
//
// Lenient where the spec says readers must be: unknown fields pass
// through, and enum-like fields (status, evidence kind, …) are open
// strings. What stenographer can admit into its ledger is decided at
// import (see unknownValue), not here.
// ─────────────────────────────────────────────────────────────

const ID = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'an id is 1–256 characters: letters, digits, . _ : -');
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const Timestamp = z
  .string()
  .refine((s) => RFC3339.test(s) && Number.isFinite(Date.parse(s)), 'ts must be an RFC 3339 date-time');
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'a hash is 64 lowercase hex digits');
const Text = z.string().min(1);
const Blankless = z.string().refine((s) => s.trim().length > 0, 'cannot be blank');

/** An identity someone stands behind: the write-time rules (types.ts AuthorSchema), without canonicalizing. */
function identityIssue(s: string, opts: { reserved?: 'detector' | 'any' } = {}): string | null {
  if (isAnonymousIdentity(s)) {
    return 'anonymous or generic identities cannot assert truth — use a registered human handle or agent identity';
  }
  if (hasControlCharacters(s)) return 'identities cannot contain control characters';
  if (isReservedIdentity(s)) {
    const detector = identityKey(s).startsWith('detector:');
    if (opts.reserved === 'any' || (opts.reserved === 'detector' && detector)) return null;
    return `'migration' and 'detector:*' are reserved for the backfill and detector paths`;
  }
  return null;
}
const identity = (opts: { reserved?: 'detector' | 'any' } = {}) =>
  z.string().superRefine((s, ctx) => {
    const issue = identityIssue(s, opts);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });
const Identity = identity();

const Evidence = z.object({ kind: Text, ref: Text, detail: z.string().optional() }).passthrough();
const VerifyBy = z.object({ kind: Text, value: Text, detail: z.string().optional() }).passthrough();
const Link = z.object({ fromId: ID, toId: ID, type: Text }).passthrough();
const Provenance = z.object({ kind: Text, ref: z.string().optional(), line: z.number().int().optional() }).passthrough();
/** A dead literal as live writes accept it (types.ts), with values as written: no surrounding whitespace. */
const Literal = z.unknown().superRefine((value, ctx) => {
  const parsed = TombstonedLiteralSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: issue.path });
    return;
  }
  const raw = value as Record<string, unknown>;
  for (const key of ['dead', 'subject', 'current'] as const) {
    if (typeof raw[key] === 'string' && raw[key] !== (raw[key] as string).trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'literal values cannot have surrounding whitespace', path: [key] });
    }
  }
});
const XSteno = z
  .object({
    origin: Text.optional(),
    provenance: Provenance.optional(),
    agentSessionId: z.string().nullable().optional(),
    targetRef: z.string().nullable().optional(),
    links: z.array(Link).optional(),
    ledgerHash: Hex64.optional(),
  })
  .passthrough();

const Envelope = {
  schemaVersion: z.literal(2),
  seq: z.number().int().positive(),
  id: ID,
  ts: Timestamp,
  author: z.string(),
  prevHash: Hex64.nullable(),
  hash: Hex64,
  'x-steno': XSteno.optional(),
};

const TbLine = z
  .object({
    ...Envelope,
    type: z.literal('TB'),
    claim: Text,
    evidence: z.array(Evidence).min(1, 'a TB requires at least one piece of evidence'),
    signedBy: Identity.nullable(),
    literals: z.array(Literal).min(1, 'omit literals rather than send none').optional(),
    status: z.string().optional(),
  })
  .passthrough();
const UvLine = z
  .object({
    ...Envelope,
    type: z.literal('UV'),
    author: Identity,
    assertion: Text,
    basis: Text,
    verifyBy: VerifyBy,
    contests: ID.nullable(),
    status: z.string().optional(),
  })
  .passthrough();
const AddendumLine = z
  .object({
    ...Envelope,
    type: z.literal('ADDENDUM'),
    author: Identity,
    evidence: z.array(Evidence).min(1, 'an addendum requires at least one piece of evidence'),
    note: z.string().nullable(),
  })
  .passthrough();
const RulingLine = z
  .object({ ...Envelope, type: z.literal('RULING'), author: Identity, kind: Text, opinion: Blankless, target: ID })
  .passthrough();
const ProposalLine = z
  .object({
    ...Envelope,
    type: z.literal('PROPOSAL'),
    // Detectors file proposals
    author: identity({ reserved: 'detector' }),
    kind: Text,
    draft: z.record(z.unknown()),
    targetRef: z.string().nullable(),
    signal: z.object({ source: Text }).passthrough(),
    agentSessionId: z.string().nullable().optional(),
  })
  .passthrough();
const TransitionLine = z
  .object({
    ...Envelope,
    type: z.literal('TRANSITION'),
    // A transition's author is its cause's, which may be the backfill's 'migration'
    author: identity({ reserved: 'any' }),
    target: ID,
    status: Text,
    cause: z.object({ kind: Text, ref: ID.nullable() }).passthrough(),
  })
  .passthrough();

const LineV2 = z
  .discriminatedUnion('type', [TbLine, UvLine, AddendumLine, RulingLine, ProposalLine, TransitionLine])
  .superRefine((line, ctx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if ((line.seq === 1) !== (line.prevHash === null)) {
      issue('prevHash is null on the first line of a stream (seq 1), and only there', ['prevHash']);
    }
    if (line.type === 'TB') {
      // The backfill's second-class TBs are the one place 'migration' authors one, unsigned
      const migration = identityKey(line.author) === MIGRATION_AUTHOR && line.signedBy === null;
      const authorIssue = migration ? null : identityIssue(line.author);
      if (authorIssue) issue(authorIssue, ['author']);
    }
    const links = line['x-steno']?.links ?? [];
    const keys = links.map((l) => JSON.stringify([l.fromId, l.toId, l.type]));
    if (new Set(keys).size !== keys.length) issue('a line lists each link once', ['x-steno', 'links']);
    if (line.type === 'TB' || line.type === 'UV') {
      // A line speaks for itself: links from it of a kind its type writes, or its own history
      for (const [i, l] of links.entries()) {
        if (!(LINK_TYPES as readonly string[]).includes(l.type)) continue; // an unknown kind: decided at import
        const type = l.type as LinkType;
        const own =
          (l.fromId === line.id && OUTBOUND_LINKS[line.type].includes(type)) ||
          (l.toId === line.id && l.fromId !== line.id && (INBOUND_LINKS[line.type] ?? []).includes(type));
        if (!own) issue(`a ${line.type} line cannot carry the link ${l.fromId} -${l.type}-> ${l.toId}`, ['x-steno', 'links', String(i)]);
      }
    }
    if (line.type === 'UV' && line['x-steno']?.links) {
      const contestLinks = links.filter((l) => l.type === 'contests' && l.fromId === line.id);
      if (line.contests && !contestLinks.some((l) => l.toId === line.contests)) {
        issue('a UV that contests a TB lists its contests link in x-steno.links', ['x-steno', 'links']);
      }
      if (contestLinks.some((l) => l.toId !== line.contests)) {
        issue('a contests link points at the TB the contests field names', ['x-steno', 'links']);
      }
    }
    if (line.type === 'ADDENDUM' || line.type === 'RULING') {
      for (const [i, l] of links.entries()) {
        if (l.fromId !== line.id) {
          issue(`${line.type === 'ADDENDUM' ? 'an' : 'a'} ${line.type} line lists only the links it writes`, ['x-steno', 'links', String(i)]);
        }
      }
    }
  });

// ─────────────────────────────────────────────────────────────
// v1 (0.x): no version, a `status` field, no hash
// ─────────────────────────────────────────────────────────────

const LineV1 = z
  .object({
    schemaVersion: z.literal(1).optional(),
    id: ID,
    type: z.enum(['TB', 'UV']),
    ts: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'ts must be a timestamp'),
    author: z.string(),
    status: z.string().optional(),
    'x-steno': z
      .object({
        origin: z.enum(['local', 'wiki']).optional(),
        provenance: ProvenanceSchema.optional(),
        agentSessionId: z.string().nullable().optional(),
        links: z.array(z.object({ fromId: ID, toId: ID, type: z.enum(LINK_TYPES) })).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const TbBodyV1 = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1, 'a TB requires at least one piece of evidence'),
  signedBy: Identity.nullable().optional(),
  literals: z.array(TombstonedLiteralSchema).optional(),
});

const UvBodyV1 = z.object({
  author: Identity,
  assertion: z.string().min(1),
  basis: z.string().min(1),
  verifyBy: VerifyBySchema,
  contests: ID.nullable().optional(),
});

/** Terminal statuses: the only recorded statuses the ledger's fold reads (status.ts). */
const TERMINAL = new Set(['overridden', 'verified', 'refuted']);

// ─────────────────────────────────────────────────────────────
// Codec
// ─────────────────────────────────────────────────────────────

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WikiLineError(formatIssues(parsed.error));
  return parsed.data;
}

/** sha256hex(JCS(line without `hash`)): the hash a v2 line carries. Doesn't validate the line. */
export function wikiLineHash(line: string | Record<string, unknown>): string {
  const { hash: _hash, ...rest } = typeof line === 'string' ? (JSON.parse(line) as Record<string, unknown>) : line;
  return sha256Hex(canonicalize(rest));
}

/**
 * Reads one wiki line: validates it (v2, or v1 from 0.x) and checks its
 * hash. Throws WikiLineError when it is not a valid line. Chain continuity
 * across lines is checkWikiChain's. This is the codec the spec's fixtures pin.
 */
export function decodeWikiLine(text: string): DecodedWikiLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new WikiLineError(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WikiLineError('a line is a JSON object');
  const obj = raw as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (version === undefined || version === 1) {
    parseOrThrow(LineV1, obj);
    return { version: 1, type: obj.type as 'TB' | 'UV', line: obj, seq: null, prevHash: null, hash: null };
  }
  if (version !== 2) throw new WikiLineError(`schemaVersion ${JSON.stringify(version)} is not one this stenographer reads (1, 2)`);

  const line = parseOrThrow(LineV2, obj);
  let hash: string;
  try {
    hash = wikiLineHash(obj);
  } catch (err) {
    throw new WikiLineError(`the line can't be canonicalized: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (hash !== line.hash) {
    throw new WikiLineError(`hash mismatch: the line hashes to ${hash}, not ${line.hash} — it was changed after it was written`);
  }
  return { version: 2, type: line.type, line: obj, seq: line.seq, prevHash: line.prevHash, hash: line.hash };
}

/**
 * Checks that decoded v2 lines form one stream: each line's seq follows the
 * one before it, and its prevHash is that line's hash. A stream may start
 * part-way (an incremental export), but not skip, repeat, reorder or
 * interleave two writers. Returns the index and error of each break.
 */
export function checkWikiChain(lines: Array<DecodedWikiLine | null>): Array<{ index: number; error: string }> {
  const breaks: Array<{ index: number; error: string }> = [];
  let prev: DecodedWikiLine | null = null;
  lines.forEach((d, index) => {
    if (!d) {
      prev = null; // an unreadable line: don't pile chain errors on top of its own
      return;
    }
    if (d.version !== 2) return;
    if (prev && d.seq !== prev.seq! + 1) {
      breaks.push({ index, error: `chain broken: seq ${d.seq} follows ${prev.seq} — a line is missing, repeated or out of order` });
    } else if (prev && d.prevHash !== prev.hash) {
      breaks.push({
        index,
        error: `chain broken: prevHash ${d.prevHash} is not the previous line's hash ${prev.hash} — two writers' lines, or an edited one`,
      });
    }
    prev = d;
  });
  return breaks;
}

// ─────────────────────────────────────────────────────────────
// Export: the ledger as one hash-chained line stream
// ─────────────────────────────────────────────────────────────

/** A TB or UV's status as the wiki states it: struck wins, then the derived status. */
function wikiStatus(state: { status: string | null; struck: boolean }): string {
  return state.struck ? 'struck' : state.status!;
}

/** What made a TB or UV's wiki status change when `cause` was appended. */
function causeKind(cause: LedgerRecord, targetType: TruthEntryType, status: string): CauseKind {
  if (status === 'struck') return 'strike';
  if (targetType === 'TB') {
    if (status === 'overridden') return 'override';
    if (status === 'contested') return 'contest';
    // A contest stopped counting: its UV was resolved
    return cause.links.some((l) => l.type === 'verifies') ? 'verify' : 'refute';
  }
  return status === 'verified' ? 'verify' : 'refute';
}

/**
 * Replays the ledger in chain order and writes its wiki stream: an entry
 * line for every TB and UV (with the status it had then) and for every
 * ADDENDUM or RULING with a status link to one, and a TRANSITION line each
 * time an exported entry's status changes. The stream depends only on the
 * ledger's entries in order, so it only ever grows at the end: line n is
 * the same line on every export.
 */
function buildStream(ledger: TruthLedger): { lines: WikiLine[]; skipped: Array<{ id: string; error: string }> } {
  const types = new Map<string, TruthEntryType>();
  const recorded = new Map<string, unknown>();
  const inbound = new Map<string, TruthLink[]>();
  const contestsFrom = new Map<string, string[]>();
  const derived = new Map<string, { status: string | null; struck: boolean }>();
  const stated = new Map<string, string>(); // the status the stream last stated, per exported TB/UV
  const lines: WikiLine[] = [];
  const skipped: Array<{ id: string; error: string }> = [];

  const derive = (id: string) => {
    const type = types.get(id);
    if (!type) return;
    const links = (inbound.get(id) ?? []).map((l): InboundLink => {
      const fromType = types.get(l.fromId);
      return { type: l.type, from: fromType ? { type: fromType, status: derived.get(l.fromId)?.status ?? null } : null };
    });
    derived.set(id, { status: deriveStatus(type, recorded.get(id), links), struck: deriveStruck(links) });
  };

  const emit = (fields: Record<string, unknown>, id: string): boolean => {
    const unhashed = { schemaVersion: WIKI_SCHEMA_VERSION, seq: lines.length + 1, ...fields, prevHash: lines.at(-1)?.hash ?? null };
    try {
      const line = { ...unhashed, hash: wikiLineHash(unhashed) } as WikiLine;
      decodeWikiLine(JSON.stringify(line));
      lines.push(line);
      return true;
    } catch (err) {
      skipped.push({ id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  const push = <V>(map: Map<string, V[]>, key: string, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (const r of ledger.getChainedRecords()) {
    types.set(r.id, r.type);
    recorded.set(r.id, recordedStatus(r.body));
    for (const link of r.links) {
      push(inbound, link.toId, link);
      if (link.type === 'contests') push(contestsFrom, link.fromId, link.toId);
    }

    // What this entry can have changed: itself, what it links, and the TBs those UVs contest
    const affected = [r.id, ...r.links.flatMap((l) => [l.toId, l.fromId])];
    for (const id of [...affected]) affected.push(...(contestsFrom.get(id) ?? []));
    const unique = [...new Set(affected)];
    for (const id of unique) if (types.get(id) !== 'TB') derive(id);
    for (const id of unique) if (types.get(id) === 'TB') derive(id);

    const steno = { origin: r.origin, provenance: r.provenance, agentSessionId: r.agentSessionId, targetRef: r.targetRef, links: r.links, ledgerHash: r.hash };
    const envelope = { id: r.id, type: r.type, ts: r.createdAt, author: r.author };
    const b = r.body;
    if (r.type === 'TB' || r.type === 'UV') {
      const status = wikiStatus(derived.get(r.id)!);
      const body =
        r.type === 'TB'
          ? { claim: b.claim, evidence: b.evidence, signedBy: b.signedBy, ...(b.literals !== undefined ? { literals: b.literals } : {}) }
          : { assertion: b.assertion, basis: b.basis, verifyBy: b.verifyBy, contests: b.contests ?? null };
      if (emit({ ...envelope, ...body, status, 'x-steno': steno }, r.id)) stated.set(r.id, status);
    } else if (
      (r.type === 'ADDENDUM' || r.type === 'RULING') &&
      r.links.some((l) => STATUS_LINKS.includes(l.type) && (types.get(l.toId) === 'TB' || types.get(l.toId) === 'UV'))
    ) {
      const body = r.type === 'ADDENDUM' ? { evidence: b.evidence, note: b.note ?? null } : { kind: b.kind, opinion: b.opinion, target: b.target };
      emit({ ...envelope, ...body, 'x-steno': steno }, r.id);
    }

    // Every exported TB or UV whose status this entry changed gets a TRANSITION
    for (const id of unique) {
      const was = stated.get(id);
      if (id === r.id || was === undefined) continue;
      const now = wikiStatus(derived.get(id)!);
      if (now === was) continue;
      const transition = {
        id: `${r.id}:${id}`,
        type: 'TRANSITION',
        ts: r.createdAt,
        author: r.author,
        target: id,
        status: now,
        cause: { kind: causeKind(r, types.get(id)!, now), ref: r.id },
      };
      if (emit(transition, transition.id)) stated.set(id, now);
    }
  }
  return { lines, skipped };
}

export interface WikiExportResult {
  lines: string[];
  count: number;
  /** The seq of the stream's last line (0 when empty): pass it as `sinceSeq` next time. */
  lastSeq: number;
  /** Entries that can't be written as a valid v2 line (pre-1.0 rows the format can't express), left out. */
  skipped: Array<{ id: string; error: string }>;
}

/**
 * The ledger's wiki stream (spec/truth-format). `sinceSeq` returns the
 * lines after that seq; `since` (a timestamp, kept as a deprecated alias)
 * returns the stream from the first line written after it. Either way the
 * lines returned are contiguous, so they chain.
 */
export function exportWikiEntries(ledger: TruthLedger, options: { sinceSeq?: number; since?: string } = {}): WikiExportResult {
  const { lines, skipped } = buildStream(ledger);
  let from = 0;
  if (options.sinceSeq !== undefined) from = Math.min(Math.max(0, options.sinceSeq), lines.length);
  else if (options.since !== undefined) {
    const since = Date.parse(options.since);
    const first = lines.findIndex((l) => Date.parse(l.ts) > since);
    from = first === -1 ? lines.length : first;
  }
  const out = lines.slice(from).map((l) => JSON.stringify(l));
  return { lines: out, count: out.length, lastSeq: lines.length, skipped };
}

// ─────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────

export interface ImportOptions {
  /**
   * Whose signatures this ledger accepts from the wiki. With a registry, a
   * TB lands as truth only when its author and signer are listed (people or
   * agents), and an override, strike or ruling applies only when a listed
   * person wrote it. Without one, any accountable identity passes, as on
   * live operator paths, except that an override, strike or ruling of an
   * entry this ledger made itself is held.
   */
  signers?: SignerRegistry | null;
  /** Embeddings for the claims and assertions of imported entries, by entry id (the engine computes them). */
  embeddings?: ReadonlyMap<string, number[]>;
}

export type ReconciliationReason = 'unsigned' | 'unverifiable' | 'unknown-status' | 'unknown-value' | 'conflict';

export interface ImportResult {
  /** False when any line failed: the file was rolled back, nothing was written, and `errors` says why. */
  committed: boolean;
  /** Lines appended to the ledger: TBs, UVs, and the addenda and rulings that change a status. */
  inserted: number;
  /** Lines this ledger already holds, or has already reconciled: re-importing a file changes nothing. */
  unchanged: number;
  /** TRANSITION lines checked against their causes. This ledger derives status from the causes themselves. */
  derived: number;
  /** Lines filed as reconciliation PROPOSALs instead of truth. */
  proposals: Array<{ line: number; id: string; proposalId: string; reason: ReconciliationReason; detail: string }>;
  /** The `conflict` proposals: a line whose id this ledger holds with a different body. */
  conflicts: Array<{ id: string; proposalId: string }>;
  /** Lines not applied: from someone the registry doesn't list, at an entry not held here, or with values this ledger can't apply. */
  held: Array<{ line: number; id: string; reason: string }>;
  errors: Array<{ line: number; id?: string; error: string }>;
}

/** Thrown inside the import transaction to roll it back. */
class Rollback extends Error {}

/**
 * Ingests wiki lines (blank lines are skipped; line numbers count them) in
 * one transaction. Every line is decoded, the v2 lines must chain, and each
 * is admitted like a live write; if any fails, nothing is written and
 * every failing line is reported.
 */
export function importWikiEntries(
  ledger: TruthLedger,
  input: { lines: string[] },
  options: ImportOptions = {}
): ImportResult {
  const result: ImportResult = { committed: false, inserted: 0, unchanged: 0, derived: 0, proposals: [], conflicts: [], held: [], errors: [] };
  const items: Array<{ line: number; text: string; d: DecodedWikiLine | null }> = [];
  input.lines.forEach((text, i) => {
    if (text.trim().length === 0) return;
    try {
      items.push({ line: i + 1, text, d: decodeWikiLine(text) });
    } catch (err) {
      items.push({ line: i + 1, text, d: null });
      result.errors.push({ line: i + 1, ...idOf(text), error: messageOf(err) });
    }
  });
  for (const { index, error } of checkWikiChain(items.map((i) => i.d))) {
    result.errors.push({ line: items[index].line, ...idOf(items[index].text), error });
  }

  const seen = new Set<string>();
  try {
    ledger.atomically(() => {
      for (const { line, d } of items) {
        if (!d) continue;
        const id = d.line.id as string;
        try {
          ledger.atomically(() => applyLine(ledger, line, d, seen, options, result));
        } catch (err) {
          result.errors.push({ line, id, error: messageOf(err) });
        }
        seen.add(id);
      }
      if (result.errors.length > 0) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    const errors = result.errors.sort((a, b) => a.line - b.line);
    return { committed: false, inserted: 0, unchanged: 0, derived: 0, proposals: [], conflicts: [], held: [], errors };
  }
  result.committed = true;
  return result;
}

function applyLine(
  ledger: TruthLedger,
  lineNo: number,
  d: DecodedWikiLine,
  seen: Set<string>,
  options: ImportOptions,
  result: ImportResult
): void {
  const line = d.line;
  const id = line.id as string;
  const signers = options.signers ?? null;

  switch (d.type) {
    case 'PROPOSAL':
      throw new WikiLineError('a PROPOSAL line belongs in a proposals file for the intake (importProposalDrafts), not a wiki file');

    case 'TRANSITION': {
      // This ledger derives status from the entries that cause it; a transition must name one it has seen
      const cause = (line.cause as { ref: string | null }).ref;
      if (cause !== null && !seen.has(cause) && !ledger.getEntry(cause)) {
        throw new WikiLineError(`TRANSITION ${id} names cause ${cause}, which is neither earlier in this file nor in this ledger`);
      }
      const type = ledger.getEntry(line.target as string)?.type;
      if ((type === 'TB' || type === 'UV') && !(WIKI_STATUSES[type] as readonly string[]).includes(line.status as string)) {
        result.held.push({ line: lineNo, id, reason: `status '${line.status}' is not one this stenographer knows for a ${type}` });
        return;
      }
      result.derived++;
      return;
    }

    case 'ADDENDUM':
    case 'RULING': {
      const change = changeOf(d);
      if ('unknown' in change) {
        result.held.push({ line: lineNo, id, reason: change.unknown });
        return;
      }
      const distrust = ledger.getEntry(id) ? null : changeDistrust(ledger, change.entry, change.links, signers);
      if (distrust) {
        result.held.push({ line: lineNo, id, reason: distrust });
        return;
      }
      const outcome = ledger.importChange(change.entry, change.links);
      if (outcome.outcome === 'held') result.held.push({ line: lineNo, id, reason: outcome.reason });
      else if (outcome.outcome === 'inserted') result.inserted++;
      else result.unchanged++;
      return;
    }

    case 'TB':
    case 'UV': {
      const entry = entryOf(d);
      // An entry already held is compared, never re-routed: the same is a no-op, a different one a conflict
      const route = entry.route ?? (ledger.getEntry(id) ? null : entryRoute(d, entry.entry, signers));
      if (route) {
        reconcile(ledger, lineNo, d, entry.entry, route.reason, route.detail, options, result);
        return;
      }
      // A v1 line can't sign a proposal this ledger holds; its links like that are dropped (v2 lines are refused)
      const links = d.version === 1 ? entry.links.filter((l) => !(l.type === 'signs' && ledger.getEntry(l.toId))) : entry.links;
      const outcome = ledger.importEntry(entry.entry, links, { embedding: options.embeddings?.get(id), targetRef: entry.targetRef });
      if (outcome === 'inserted') result.inserted++;
      else if (outcome === 'unchanged') result.unchanged++;
      else reconcile(ledger, lineNo, d, entry.entry, 'conflict', `wiki entry ${id} contradicts the copy this ledger holds`, options, result);
      return;
    }
  }
}

interface EntryOf {
  entry: NewEntry;
  links: TruthLink[];
  targetRef: string | null;
  /** Set when the line can't be admitted as truth: it is filed as a proposal instead. */
  route?: Route;
}

type Route = { reason: ReconciliationReason; detail: string };

/** The first value in a v2 line this stenographer has no meaning for, if any. */
function unknownValue(line: Record<string, unknown>): string | null {
  const x = (line['x-steno'] ?? {}) as { origin?: string; provenance?: { kind: string }; links?: Array<{ type: string }> };
  for (const e of (line.evidence ?? []) as Array<{ kind: string }>) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(e.kind)) return `evidence kind '${e.kind}'`;
  }
  const verifyBy = line.verifyBy as { kind: string } | undefined;
  if (verifyBy && !(VerifyBySchema.shape.kind.options as readonly string[]).includes(verifyBy.kind)) {
    return `verifyBy kind '${verifyBy.kind}'`;
  }
  if (x.provenance && !(ProvenanceSchema.shape.kind.options as readonly string[]).includes(x.provenance.kind)) {
    return `provenance kind '${x.provenance.kind}'`;
  }
  for (const l of x.links ?? []) if (!(LINK_TYPES as readonly string[]).includes(l.type)) return `link type '${l.type}'`;
  if (line.type === 'RULING' && !RULING_KINDS.includes(line.kind as string)) return `ruling kind '${line.kind}'`;
  return null;
}

/** The ledger entry a TB or UV line describes, and why it can't be admitted as truth, if it can't. */
function entryOf(d: DecodedWikiLine): EntryOf {
  const line = d.line;
  const id = line.id as string;
  const type = d.type as 'TB' | 'UV';
  if (d.version === 1) return entryOfV1(line, type);

  // Fail closed: a status this stenographer doesn't know is not truth, nor is
  // 'struck' on an entry line — only a strike, which travels, sets that
  const status = line.status as string | undefined;
  const live = type === 'TB' ? ['active', 'contested', 'overridden'] : ['open', 'verified', 'refuted'];
  const unknown = unknownValue(line);
  const route: Route | undefined =
    status === undefined || !live.includes(status)
      ? {
          reason: 'unknown-status',
          detail: `wiki ${type} ${id} has ${status === undefined ? 'no status' : `status '${status}'`}, which this stenographer can't hold as truth`,
        }
      : unknown
        ? { reason: 'unknown-value', detail: `wiki ${type} ${id} has ${unknown}, which this stenographer doesn't know` }
        : undefined;

  const x = (line['x-steno'] ?? {}) as {
    provenance?: NewEntry['provenance'];
    agentSessionId?: string | null;
    targetRef?: string | null;
    links?: TruthLink[];
  };
  // A terminal status the line states is kept as a floor (status.ts): no fold here can undo it
  const floor = status && TERMINAL.has(status) ? { status } : {};
  const body =
    type === 'TB'
      ? { claim: line.claim, evidence: line.evidence, signedBy: line.signedBy, ...(line.literals !== undefined ? { literals: line.literals } : {}), ...floor }
      : { assertion: line.assertion, basis: line.basis, verifyBy: line.verifyBy, contests: line.contests, ...floor };
  return {
    entry: {
      id,
      type,
      createdAt: line.ts as string,
      author: line.author as string,
      provenance: x.provenance ?? { kind: 'wiki', ref: id },
      agentSessionId: x.agentSessionId ?? null,
      origin: 'wiki',
      body,
    },
    links: (x.links ?? []).map((l) => ({ fromId: l.fromId, toId: l.toId, type: l.type })),
    targetRef: x.targetRef ?? null,
    ...(route ? { route } : {}),
  };
}

function entryOfV1(line: Record<string, unknown>, type: 'TB' | 'UV'): EntryOf {
  const id = line.id as string;
  const x = (line['x-steno'] ?? {}) as { provenance?: NewEntry['provenance']; agentSessionId?: string | null; links?: TruthLink[] };
  let body: Record<string, unknown>;
  let author: string;
  if (type === 'TB') {
    const tb = parseOrThrow(TbBodyV1, line);
    // The backfill's unsigned TBs carry 'migration'; anyone else is held to the write-time rules
    const migration = identityKey(line.author as string) === MIGRATION_AUTHOR && !tb.signedBy;
    if (!migration) parseOrThrow(z.object({ author: Identity }), line);
    author = canonicalIdentity(line.author as string);
    body = {
      claim: tb.claim,
      evidence: tb.evidence,
      signedBy: tb.signedBy ? canonicalIdentity(tb.signedBy) : null,
      ...(tb.literals && tb.literals.length > 0 ? { literals: tb.literals } : {}),
    };
  } else {
    const uv = parseOrThrow(UvBodyV1, line);
    author = canonicalIdentity(uv.author);
    body = { assertion: uv.assertion, basis: uv.basis, verifyBy: uv.verifyBy, contests: uv.contests ?? null };
  }

  // Fail closed on a status a v1 line couldn't have meant; keep a terminal one as a floor
  const status = line.status as string | undefined;
  const known = type === 'TB' ? ['active', 'contested', 'overridden'] : ['open', 'verified', 'refuted'];
  const route: Route | undefined =
    status !== undefined && !known.includes(status)
      ? { reason: 'unknown-status', detail: `v1 ${type} ${id} has status '${status}', which this stenographer can't hold as truth` }
      : undefined;
  if (!route && status && TERMINAL.has(status)) body.status = status;

  // A v1 line may only speak for itself: links into it, and the ones its own
  // type writes (a UV's contest of the TB it names). Others are dropped.
  const contests = type === 'UV' ? (body.contests as string | null) : null;
  const links = (x.links ?? []).filter((l) => {
    if (l.toId === id) return l.fromId !== id;
    if (l.fromId !== id) return false;
    if (type === 'UV') return (l.type === 'contests' && l.toId === contests) || l.type === 'signs';
    return l.type === 'supersedes' || l.type === 'signs';
  });
  return {
    entry: {
      id,
      type,
      createdAt: line.ts as string,
      author,
      provenance: x.provenance ?? { kind: 'wiki', ref: id },
      agentSessionId: x.agentSessionId ?? null,
      origin: 'wiki',
      body,
    },
    links: links.map((l) => ({ fromId: l.fromId, toId: l.toId, type: l.type })),
    targetRef: null,
    ...(route ? { route } : {}),
  };
}

/** The ADDENDUM or RULING a v2 line describes, or what this stenographer can't apply in it. */
function changeOf(d: DecodedWikiLine): { entry: NewEntry; links: TruthLink[] } | { unknown: string } {
  const line = d.line;
  const unknown = unknownValue(line);
  if (unknown) return { unknown: `it has ${unknown}, which this stenographer doesn't know` };
  const x = (line['x-steno'] ?? {}) as { provenance?: NewEntry['provenance']; agentSessionId?: string | null; links?: TruthLink[] };
  if (!x.links) return { unknown: 'it lists no links (x-steno.links), so what it changes is unknown' };
  const id = line.id as string;
  return {
    entry: {
      id,
      type: d.type as 'ADDENDUM' | 'RULING',
      createdAt: line.ts as string,
      author: line.author as string,
      provenance: x.provenance ?? { kind: 'wiki', ref: id },
      agentSessionId: x.agentSessionId ?? null,
      origin: 'wiki',
      body: d.type === 'ADDENDUM' ? { evidence: line.evidence, note: line.note } : { kind: line.kind, opinion: line.opinion, target: line.target },
    },
    links: x.links.map((l) => ({ fromId: l.fromId, toId: l.toId, type: l.type })),
  };
}

/** Why a TB or UV line can't land as truth here, if it can't. */
function entryRoute(d: DecodedWikiLine, entry: NewEntry, signers: SignerRegistry | null): Route | null {
  const body = entry.body as { signedBy?: string | null };
  if (entry.type === 'TB') {
    if (!body.signedBy) return { reason: 'unsigned', detail: `wiki TB ${entry.id} has no signer` };
    if (d.version === 1) {
      return { reason: 'unverifiable', detail: `wiki TB ${entry.id} is a v1 line: it carries no hash, so its content can't be checked` };
    }
  }
  const roles: SignerRole[] = ['human', 'agent'];
  try {
    resolveIdentity(entry.author, roles, 'author', signers);
    if (entry.type === 'TB') resolveIdentity(body.signedBy!, roles, 'signer', signers);
  } catch (err) {
    return { reason: 'unverifiable', detail: `wiki ${entry.type} ${entry.id}: ${messageOf(err)}` };
  }
  return null;
}

/**
 * Why an ADDENDUM or RULING can't be applied here, if it can't. An
 * override, a strike or any ruling is a person's act on live paths, so its
 * author must be one; a resolution may come from an agent.
 *
 * A line's hash shows it is unchanged, not who wrote it: anyone can write a
 * one-line stream. So without a signer registry to say who the people are,
 * an override, strike or ruling from the wiki applies only to entries that
 * came from the wiki themselves (as trustworthy as the files they came
 * from), never to one this ledger made: that is held.
 */
function changeDistrust(
  ledger: TruthLedger,
  entry: NewEntry,
  links: TruthLink[],
  signers: SignerRegistry | null
): string | null {
  const judicial = entry.type === 'RULING' || links.some((l) => l.type === 'overrides' || l.type === 'strikes');
  try {
    resolveIdentity(entry.author, judicial ? ['human'] : ['human', 'agent'], 'author', signers);
  } catch (err) {
    return messageOf(err);
  }
  if (judicial && !signers) {
    const target = (entry.body as { target?: unknown }).target;
    const targets = [...links.filter((l) => l.fromId === entry.id).map((l) => l.toId), ...(typeof target === 'string' ? [target] : [])];
    // (A local proposal can't be signed or dismissed from the wiki at all: admission refuses that)
    const local = targets.find((id) => {
      const target = ledger.getEntry(id);
      return target?.origin === 'local' && (target.type === 'TB' || target.type === 'UV');
    });
    if (local) {
      return (
        `a ${entry.type === 'RULING' ? 'ruling' : 'override'} from the wiki changes ${local}, which this ledger made itself: ` +
        'that applies only from a person a signer registry lists, and none is configured'
      );
    }
  }
  return null;
}

/**
 * Files a line that can't land as truth as a reconciliation PROPOSAL a
 * person signs or dismisses — once: a proposal for the same line, in any
 * status, makes this a no-op, so a dismissed one is not raised again and a
 * signed one is not minted twice.
 */
function reconcile(
  ledger: TruthLedger,
  lineNo: number,
  d: DecodedWikiLine,
  entry: NewEntry,
  reason: ReconciliationReason,
  detail: string,
  options: ImportOptions,
  result: ImportResult
): void {
  const line = d.line;
  const id = line.id as string;
  const kind = d.type === 'TB' ? ('tombstone' as const) : ('uv' as const);
  // What a person would sign: the body as read (a v1 line's normalized), without the signer or any status
  const b = entry.body as Record<string, unknown>;
  const draft =
    kind === 'tombstone'
      ? { claim: b.claim, evidence: b.evidence, ...(b.literals !== undefined ? { literals: b.literals } : {}) }
      : { assertion: b.assertion, basis: b.basis, verifyBy: b.verifyBy, contests: b.contests ?? null };

  const same = canonicalize(draft);
  const already = ledger.proposalsFor(id).some((p) => p.author === WIKI_SYNC_DETECTOR && canonicalize(p.body.draft) === same);
  const open = ledger.findOpenProposal({ kind, targetRef: id, author: WIKI_SYNC_DETECTOR, requiresNotary: true });
  if (already || open) {
    result.unchanged++;
    return;
  }

  const proposal = ledger.addProposal(
    {
      kind,
      draft,
      signal: { source: 'wiki-reconciliation', detail },
      targetRef: id,
      requiresNotary: true,
      meta: {
        wiki: {
          id,
          reason,
          author: line.author,
          ...(kind === 'tombstone' ? { signedBy: line.signedBy ?? null } : {}),
          ...(line.status !== undefined ? { status: line.status } : {}),
          ...(d.hash ? { hash: d.hash } : {}),
        },
      },
    },
    { author: WIKI_SYNC_DETECTOR, provenance: { kind: 'wiki', ref: id }, embedding: options.embeddings?.get(id) }
  );
  result.proposals.push({ line: lineNo, id, proposalId: proposal.id, reason, detail });
  if (reason === 'conflict') result.conflicts.push({ id, proposalId: proposal.id });
}

/**
 * The claim or assertion of each TB/UV line, by id — what the engine embeds
 * before an import. Lines that don't parse are skipped (import reports them).
 */
export function wikiLineTexts(lines: string[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const text of lines) {
    if (text.trim().length === 0) continue;
    try {
      const line = JSON.parse(text) as { id?: unknown; type?: unknown; claim?: unknown; assertion?: unknown };
      const salient = line.type === 'TB' ? line.claim : line.type === 'UV' ? line.assertion : undefined;
      if (typeof line.id === 'string' && typeof salient === 'string' && salient.length > 0) texts.set(line.id, salient);
    } catch {
      // reported by the import
    }
  }
  return texts;
}

function idOf(text: string): { id?: string } {
  try {
    const id = (JSON.parse(text) as { id?: unknown }).id;
    return typeof id === 'string' ? { id } : {};
  } catch {
    return {};
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

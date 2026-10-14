/**
 * Stenographer — the truth format v2 codec (§8)
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
 * - A TB or UV may derive from other entries: `derives` links in
 *   `x-steno.links`, each pinned by the premise's content hash, and an
 *   `inference`. Standing is computed on read over them (status.ts) and
 *   never written to a line.
 * - A TB a person promoted from a UV carries `approvals` and `answerableBy`;
 *   an ADDENDUM with a `corroborates` link and a three-member `quorum`
 *   nominates a UV (it stays open). Every ruling names `answerableBy`.
 * - Unknown or missing statuses are excluded from current truth (fail
 *   closed). Proposals never travel in a wiki file; PROPOSAL lines are the
 *   intake's format (intake.ts).
 *
 * This module reads and checks lines and chains, and nothing else: it loads
 * no SQLite driver, so the `truth-format` subpath can ship it to readers
 * that only fold. Export and import are wiki.ts.
 *
 * v1 lines (0.x: no schemaVersion, a `status` field) are still read; see
 * the spec's upgrade notes.
 */

import { z } from 'zod';
import { canonicalize, sha256Hex } from './jcs.js';
import { checkQuorum } from './quorum.js';
import { INBOUND_LINKS, OUTBOUND_LINKS } from './format.js';
import {
  LINK_TYPES,
  MAX_PREMISES,
  MIGRATION_AUTHOR,
  SCOPE_PATTERN,
  EvidenceSchema,
  ProvenanceSchema,
  TombstonedLiteralSchema,
  VerifyBySchema,
  hasControlCharacters,
  identityKey,
  isAnonymousIdentity,
  isReservedIdentity,
  isRfc3339DateTime,
  type LinkType,
} from './types.js';

export const WIKI_SCHEMA_VERSION = 2;

/** The statuses a TB or UV line, or a TRANSITION, can carry. `struck` is sticky. */
export const WIKI_STATUSES = {
  TB: ['active', 'contested', 'overridden', 'struck'],
  UV: ['open', 'verified', 'refuted', 'struck'],
} as const;

/** What caused a TRANSITION. `dismiss` and `promote` are for proposal streams; a wiki export never carries them. */
export const CAUSE_KINDS = ['contest', 'override', 'strike', 'verify', 'refute', 'dismiss', 'promote'] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

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
const Timestamp = z.string().refine(isRfc3339DateTime, 'ts must be an RFC 3339 date-time naming a real time');
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'a hash is 64 lowercase hex digits');
const Text = z.string().min(1);
const Blankless = z.string().refine((s) => s.trim().length > 0, 'cannot be blank');

/** An identity someone stands behind: the write-time rules (types.ts AuthorSchema), without canonicalizing. */
function identityIssue(s: string, opts: { reserved?: 'detector' } = {}): string | null {
  if (isAnonymousIdentity(s)) {
    return 'anonymous or generic identities cannot assert truth — use a registered human handle or agent identity';
  }
  if (hasControlCharacters(s)) return 'identities cannot contain control characters';
  if (isReservedIdentity(s)) {
    const detector = identityKey(s).startsWith('detector:');
    if (opts.reserved === 'detector' && detector) return null;
    return `'migration' and 'detector:*' are reserved for the backfill and detector paths`;
  }
  return null;
}
const identity = (opts: { reserved?: 'detector' } = {}) =>
  z.string().superRefine((s, ctx) => {
    const issue = identityIssue(s, opts);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });
/** An identity someone stands behind, as the line rules check it (used by wiki.ts's v1 reader too). */
export const Identity = identity();

const Evidence = z.object({ kind: Text, ref: Text, detail: z.string().optional() }).passthrough();
const VerifyBy = z.object({ kind: Text, value: Text, detail: z.string().optional() }).passthrough();
/** A link; a `derives` link also carries the premise's content hash (checked below). */
const Link = z.object({ fromId: ID, toId: ID, type: Text, contentHash: Hex64.optional() }).passthrough();
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
/** A quorum member's shape (spec, Agent quorum): the rules across members and the line are checkQuorum's. */
const QuorumMember = z
  .object({ author: z.string(), agentSessionId: z.string(), ts: Timestamp, evidence: z.array(Evidence).min(1, 'a quorum member cites evidence') })
  .passthrough();
const AddendumQuorumMember = QuorumMember.extend({ verdict: z.enum(['verified', 'refuted']) });
/** Who approved a promoted UV (spec, Approvals): a person, an agent session, or the reporter with the passages it cites. */
const Approval = z
  .object({ by: Identity, role: Text, ts: Timestamp, agentSessionId: z.string().optional(), cites: z.array(Text).optional() })
  .passthrough();
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
    quorum: z.array(QuorumMember).optional(),
    inference: Blankless.optional(),
    answerableBy: Identity.optional(),
    approvals: z.array(Approval).min(1, 'omit approvals rather than send none').optional(),
    status: Text.optional(),
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
    inference: Blankless.optional(),
    status: Text.optional(),
  })
  .passthrough();
const AddendumLine = z
  .object({
    ...Envelope,
    type: z.literal('ADDENDUM'),
    author: Identity,
    evidence: z.array(Evidence).min(1, 'an addendum requires at least one piece of evidence'),
    note: z.string().nullable(),
    quorum: z.array(AddendumQuorumMember).optional(),
  })
  .passthrough();
const RulingLine = z
  .object({
    ...Envelope,
    type: z.literal('RULING'),
    author: Identity,
    kind: Text,
    opinion: Blankless,
    target: ID,
    answerableBy: Identity.optional(),
    /** A precedent's scope (spec, Precedents): a lowercase dotted slug. */
    scope: z.string().regex(SCOPE_PATTERN, 'a scope is a lowercase dotted slug, such as ci.merge-on-red').optional(),
  })
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
    // A transition's author is its cause's: a person or an agent, never 'migration' or a detector
    author: Identity,
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
      // Derivation (spec, "Derivation"): one to 16 pinned premises, each once, never itself, and the inference with them
      const derives = links.filter((l) => l.type === 'derives' && l.fromId === line.id);
      for (const [i, l] of links.entries()) {
        if (l.type === 'derives' && l.contentHash === undefined) issue('a derives link carries the premise\'s contentHash', ['x-steno', 'links', String(i)]);
        if (l.type === 'derives' && l.toId === line.id) issue('an entry cannot derive from itself', ['x-steno', 'links', String(i)]);
        if (l.type !== 'derives' && l.contentHash !== undefined) issue('only a derives link carries a contentHash', ['x-steno', 'links', String(i)]);
      }
      if (derives.length > MAX_PREMISES) issue(`an entry derives from at most ${MAX_PREMISES} premises`, ['x-steno', 'links']);
      if (new Set(derives.map((l) => l.toId)).size !== derives.length) issue('a premise is named once', ['x-steno', 'links']);
      if ((derives.length > 0) !== (line.inference !== undefined)) {
        issue('premises and inference come together: a derived entry lists its derives links and states the inference', ['inference']);
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
    if (line.type === 'RULING') {
      // A precedent (spec, Precedents): a scope, and a target that is itself or the one precedent it supersedes
      const precedent = line.kind === 'precedent';
      const supersedes = links.filter((l) => l.type === 'supersedes' && l.fromId === line.id);
      // (A scope on another kind is kept as written: a newer writer's kind may carry one too)
      if (precedent && line.scope === undefined) issue('a precedent names its scope', ['scope']);
      if (!precedent && supersedes.length > 0) issue('only a precedent supersedes another', ['x-steno', 'links']);
      if (precedent && supersedes.length > 1) issue('a precedent supersedes one precedent', ['x-steno', 'links']);
      if (precedent && supersedes.length === 1 && line.target !== supersedes[0].toId) {
        issue("a precedent's target is the precedent it supersedes", ['target']);
      }
      if (precedent && supersedes.length === 0 && line.target !== line.id) {
        issue('the first precedent on a scope targets itself', ['target']);
      }
    }
    // Agents settle only together: a quorum keeps rules 1–6, and appears only on a TB or an ADDENDUM
    if ('quorum' in line) {
      for (const message of checkQuorum(line as Parameters<typeof checkQuorum>[0])) issue(message, ['quorum']);
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

/** The body of a v1 TB line, for wiki.ts's v1 reader. */
export const TbBodyV1 = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1, 'a TB requires at least one piece of evidence'),
  signedBy: Identity.nullable().optional(),
  literals: z.array(TombstonedLiteralSchema).optional(),
});

/** The body of a v1 UV line, for wiki.ts's v1 reader. */
export const UvBodyV1 = z.object({
  author: Identity,
  assertion: z.string().min(1),
  basis: z.string().min(1),
  verifyBy: VerifyBySchema,
  contests: ID.nullable().optional(),
});

// ─────────────────────────────────────────────────────────────
// Codec
// ─────────────────────────────────────────────────────────────

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

export function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
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
    // 0.x wrote no quorum; an agent's settlement is a v2 line
    if ('quorum' in obj) throw new WikiLineError('a v1 line carries no quorum: agents settle claims together only on v2 lines');
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


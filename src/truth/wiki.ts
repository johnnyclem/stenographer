/**
 * Stenographer — Team llm-wiki interop: export and import (§8)
 *
 * The line format and its codec are wiki-codec.ts (spec/truth-format).
 * This module replays the ledger into its hash-chained stream, and admits
 * a teammate's stream into the ledger.
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
 * Re-importing a file is a no-op. A TB, UV, ADDENDUM or RULING line's fields
 * this version doesn't define are kept with the entry (its body's `extra`)
 * and exported again as written; TRANSITIONs are derived, so theirs aren't.
 */

import { z } from 'zod';
import { canonicalize, sha256Hex } from './jcs.js';
import { deriveStatus, deriveStruck, recordedStatus, type InboundLink } from './status.js';
import { agentClassifier, resolveIdentity, type SignerRegistry, type SignerRole } from './identity.js';
import { type AgentClassifier, type QuorumMember } from './quorum.js';
import { LINE_BODY_FIELDS, LINE_ENVELOPE_FIELDS } from './format.js';
import type { LedgerRecord, NewEntry, TruthLedger } from './ledger.js';
import {
  EVIDENCE_KINDS,
  LINK_TYPES,
  MIGRATION_AUTHOR,
  ProvenanceSchema,
  VerifyBySchema,
  canonicalIdentity,
  identityKey,
  type LinkType,
  type TruthEntryType,
  type TruthLink,
  type UvEntry,
} from './types.js';
import {
  Identity,
  TbBodyV1,
  UvBodyV1,
  WIKI_SCHEMA_VERSION,
  WIKI_STATUSES,
  WikiLineError,
  checkWikiChain,
  decodeWikiLine,
  parseOrThrow,
  wikiLineHash,
  type CauseKind,
  type DecodedWikiLine,
  type WikiLine,
} from './wiki-codec.js';

export {
  WIKI_SCHEMA_VERSION,
  WIKI_STATUSES,
  CAUSE_KINDS,
  WikiLineError,
  checkWikiChain,
  decodeWikiLine,
  wikiLineHash,
  wikiLineTexts,
  type CauseKind,
  type DecodedWikiLine,
  type WikiLine,
} from './wiki-codec.js';

/** The detector identity reconciliation proposals are filed under. */
export const WIKI_SYNC_DETECTOR = 'detector:wiki-sync';

/** Links whose arrival changes the status of a TB or UV. */
const STATUS_LINKS: readonly LinkType[] = ['contests', 'overrides', 'verifies', 'refutes', 'strikes'];

/** Ruling kinds the ledger knows (types.ts RulingKind). */
const RULING_KINDS = ['strike', 'promotion', 'contempt', 'objection', 'dismissal'];

/** Terminal statuses: the only recorded statuses the ledger's fold reads (status.ts). */
const TERMINAL = new Set(['overridden', 'verified', 'refuted']);

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
    // A contest stopped counting: its UV was struck, or resolved
    if (cause.links.some((l) => l.type === 'strikes')) return 'strike';
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
  const written = new Set<string>(); // ids of the entry lines in the stream
  const lines: WikiLine[] = [];
  const skipped: Array<{ id: string; error: string }> = [];

  const derive = (id: string) => {
    const type = types.get(id);
    if (!type) return;
    const links = (inbound.get(id) ?? []).map((l): InboundLink => {
      const fromType = types.get(l.fromId);
      const from = derived.get(l.fromId);
      return { type: l.type, from: fromType ? { type: fromType, status: from?.status ?? null, struck: from?.struck ?? false } : null };
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
    // The fields a newer writer's line carried, as it wrote them (admission keeps them off the line's own)
    const extra = (b.extra ?? {}) as Record<string, unknown>;
    if (r.type === 'TB' || r.type === 'UV') {
      const status = wikiStatus(derived.get(r.id)!);
      const body =
        r.type === 'TB'
          ? {
              claim: b.claim,
              evidence: b.evidence,
              signedBy: b.signedBy,
              ...(b.literals !== undefined ? { literals: b.literals } : {}),
              ...(b.quorum !== undefined ? { quorum: b.quorum } : {}),
              ...(b.inference !== undefined ? { inference: b.inference } : {}),
            }
          : {
              assertion: b.assertion,
              basis: b.basis,
              verifyBy: b.verifyBy,
              contests: b.contests ?? null,
              ...(b.inference !== undefined ? { inference: b.inference } : {}),
            };
      if (emit({ ...envelope, ...body, status, ...extra, 'x-steno': steno }, r.id)) {
        stated.set(r.id, status);
        written.add(r.id);
      }
    } else if (
      (r.type === 'ADDENDUM' || r.type === 'RULING') &&
      r.links.some((l) => STATUS_LINKS.includes(l.type) && (types.get(l.toId) === 'TB' || types.get(l.toId) === 'UV'))
    ) {
      const body =
        r.type === 'ADDENDUM'
          ? { evidence: b.evidence, note: b.note ?? null, ...(b.quorum !== undefined ? { quorum: b.quorum } : {}) }
          : { kind: b.kind, opinion: b.opinion, target: b.target };
      if (emit({ ...envelope, ...body, ...extra, 'x-steno': steno }, r.id)) written.add(r.id);
    }

    // Every exported TB or UV whose status this entry changed gets a
    // TRANSITION. It names this entry as its cause only when this entry's
    // line is in the stream: one the format can't express (skipped) is not,
    // and a cause readers can't find would make the file unimportable.
    for (const id of unique) {
      const was = stated.get(id);
      if (id === r.id || was === undefined) continue;
      const now = wikiStatus(derived.get(id)!);
      if (now === was) continue;
      // `<cause>:<target>`, or its hash when that would break the 256-character id rule
      const composed = `${r.id}:${id}`;
      const transition = {
        id: composed.length <= 256 ? composed : `transition:${sha256Hex(composed)}`,
        type: 'TRANSITION',
        ts: r.createdAt,
        author: r.author,
        target: id,
        status: now,
        cause: { kind: causeKind(r, types.get(id)!, now), ref: written.has(r.id) ? r.id : null },
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

export type ReconciliationReason = 'unsigned' | 'unverifiable' | 'agent-without-quorum' | 'unknown-status' | 'unknown-value' | 'conflict';

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
  // Fail closed: an agent by this ledger's classifier or by the registry's say
  const registry = signers ? agentClassifier(signers) : null;
  const isAgent: AgentClassifier = (identity) => ledger.isAgent(identity) || Boolean(registry?.(identity));

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
      const distrust = ledger.getEntry(id) ? null : changeDistrust(ledger, change.entry, change.links, signers, isAgent);
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
      const route =
        entry.route ??
        (ledger.getEntry(id) ? null : (entryRoute(d, entry.entry, signers, isAgent) ?? premiseConflict(ledger, entry.entry, entry.links)));
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

/**
 * The first value in a v2 line this stenographer has no meaning for, if any.
 * Each field is read only on the line types that define it: on any other,
 * a field of that name is a newer writer's unknown field, kept as written
 * (Importing rule 10), whatever it holds.
 */
function unknownValue(line: Record<string, unknown>): string | null {
  const x = (line['x-steno'] ?? {}) as { origin?: string; provenance?: { kind: string }; links?: Array<{ type: string }> };
  if ((line.type === 'TB' || line.type === 'ADDENDUM') && Array.isArray(line.evidence)) {
    for (const e of line.evidence as Array<{ kind: string }>) {
      if (!(EVIDENCE_KINDS as readonly string[]).includes(e.kind)) return `evidence kind '${e.kind}'`;
    }
  }
  const verifyBy = line.type === 'UV' ? (line.verifyBy as { kind: string }) : undefined;
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

/**
 * A line's top-level fields that this version doesn't define for its type,
 * kept for the entry's body (`extra`) so the export writes them back as they
 * came. `x-steno` is this ledger's own record, and is written afresh.
 */
function extraOf(line: Record<string, unknown>, type: keyof typeof LINE_BODY_FIELDS): { extra?: Record<string, unknown> } {
  const unknown = Object.entries(line).filter(([key]) => !LINE_ENVELOPE_FIELDS.includes(key) && !LINE_BODY_FIELDS[type].includes(key));
  // fromEntries defines each key as an own field, so even a `__proto__` field stays one
  return unknown.length > 0 ? { extra: Object.fromEntries(unknown) } : {};
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
      ? {
          claim: line.claim,
          evidence: line.evidence,
          signedBy: line.signedBy,
          ...(line.literals !== undefined ? { literals: line.literals } : {}),
          ...(line.quorum !== undefined ? { quorum: line.quorum } : {}),
          ...(line.inference !== undefined ? { inference: line.inference } : {}),
          ...floor,
          ...extraOf(line, type),
        }
      : {
          assertion: line.assertion,
          basis: line.basis,
          verifyBy: line.verifyBy,
          contests: line.contests,
          ...(line.inference !== undefined ? { inference: line.inference } : {}),
          ...floor,
          ...extraOf(line, type),
        };
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
    links: (x.links ?? []).map(importedLink),
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
      ...extraOf(line, type),
    };
  } else {
    const uv = parseOrThrow(UvBodyV1, line);
    author = canonicalIdentity(uv.author);
    body = { assertion: uv.assertion, basis: uv.basis, verifyBy: uv.verifyBy, contests: uv.contests ?? null, ...extraOf(line, type) };
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
  // No links, or an empty list: either way the line says nothing it changes
  if (!x.links || x.links.length === 0) return { unknown: 'it lists no links (x-steno.links), so what it changes is unknown' };
  const id = line.id as string;
  const type = d.type as 'ADDENDUM' | 'RULING';
  return {
    entry: {
      id,
      type,
      createdAt: line.ts as string,
      author: line.author as string,
      provenance: x.provenance ?? { kind: 'wiki', ref: id },
      agentSessionId: x.agentSessionId ?? null,
      origin: 'wiki',
      body:
        type === 'ADDENDUM'
          ? { evidence: line.evidence, note: line.note, ...(line.quorum !== undefined ? { quorum: line.quorum } : {}), ...extraOf(line, type) }
          : { kind: line.kind, opinion: line.opinion, target: line.target, ...extraOf(line, type) },
    },
    links: x.links.map((l) => ({ fromId: l.fromId, toId: l.toId, type: l.type })),
  };
}

/** Why a TB or UV line can't land as truth here, if it can't. */
function entryRoute(d: DecodedWikiLine, entry: NewEntry, signers: SignerRegistry | null, isAgent: AgentClassifier): Route | null {
  const body = entry.body as { signedBy?: string | null; quorum?: QuorumMember[] };
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
  // Agents settle only together: an agent's TB is truth only with a quorum of agents (the codec checked its rules)
  if (entry.type === 'TB' && isAgent(body.signedBy!)) {
    const why = !body.quorum ? 'no quorum' : nonAgentMember(body.quorum, signers, isAgent);
    if (why) {
      return {
        reason: 'agent-without-quorum',
        detail:
          `wiki TB ${entry.id} is signed by agent ${body.signedBy} with ${why === 'no quorum' ? 'no quorum' : `a quorum that isn't all agents (${why})`}: ` +
          'agents settle a claim only as two or more agent sessions agreeing from different angles within 15 minutes, or a person signs it',
      };
    }
  }
  return null;
}

/**
 * A derived line whose pin names content this ledger doesn't hold: the
 * premise it rests on is held here with another body (which the stream
 * filed as a conflict when it arrived), so what the signer attested to
 * isn't what this ledger has. Filed as a conflict too. A premise not held
 * here is no conflict: the entry lands, clouded (`premise-missing`).
 */
function premiseConflict(ledger: TruthLedger, entry: NewEntry, links: TruthLink[]): Route | null {
  for (const l of links) {
    if (l.type !== 'derives' || l.fromId !== entry.id) continue;
    const held = ledger.contentHashOf(l.toId);
    if (held !== null && held !== l.contentHash) {
      return {
        reason: 'conflict',
        detail: `wiki ${entry.type} ${entry.id} derives from ${l.toId} pinned by content hash ${l.contentHash}, but the copy this ledger holds hashes to ${held}`,
      };
    }
  }
  return null;
}

/**
 * Why an ADDENDUM or RULING can't be applied here, if it can't. An
 * override, a strike or any ruling is a person's act on live paths, so its
 * author must be one; a resolution may come from an agent, with a quorum of
 * agents (each member's contempt check is importChange's).
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
  signers: SignerRegistry | null,
  isAgent: AgentClassifier
): string | null {
  const judicial = entry.type === 'RULING' || links.some((l) => l.type === 'overrides' || l.type === 'strikes');
  try {
    resolveIdentity(entry.author, judicial ? ['human'] : ['human', 'agent'], 'author', signers);
  } catch (err) {
    return messageOf(err);
  }
  // Agents settle only together, and never override, strike or rule (spec, Agent quorum)
  if (isAgent(entry.author)) {
    if (judicial) {
      return `${entry.type === 'RULING' ? 'a ruling' : 'an override'} is a person's act, and ${entry.author} is an agent`;
    }
    if (links.some((l) => l.type === 'verifies' || l.type === 'refutes')) {
      const quorum = (entry.body as { quorum?: QuorumMember[] }).quorum;
      if (!quorum) {
        return (
          `${entry.author}'s resolution applies only with a quorum: two or more agent sessions agreeing from different ` +
          'angles within 15 minutes'
        );
      }
      const person = nonAgentMember(quorum, signers, isAgent);
      if (person) return `${entry.author}'s resolution has a quorum that isn't all agents: ${person}`;
      // Verifying a contest would override its TB: a person's act, whatever the agents agree
      for (const link of links) {
        if (link.type !== 'verifies' || link.fromId !== entry.id) continue;
        const uv = ledger.getEntry(link.toId);
        const contested = uv?.type === 'UV' ? (uv as UvEntry).body.contests : null;
        if (contested) {
          return (
            `${entry.author}'s quorum verifies UV ${link.toId}, which contests TB ${contested}: verifying it would override TB ` +
            `${contested}, which agents never do, together or alone — a person does`
          );
        }
      }
    }
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
 * Why a quorum isn't all agents, if it isn't: the first member who is not
 * one. With a signer registry, an agent is an identity it lists with role
 * `agent` (the spec's definition): an unlisted `agent:` name is no witness.
 * Without one, the classifier says (the `agent:` prefix).
 */
function nonAgentMember(quorum: QuorumMember[], signers: SignerRegistry | null, isAgent: AgentClassifier): string | null {
  for (const m of quorum) {
    if (signers) {
      try {
        resolveIdentity(m.author, ['agent'], 'quorum member', signers);
      } catch (err) {
        return `quorum member ${m.author} is not an agent (${messageOf(err)})`;
      }
    } else if (!isAgent(m.author)) {
      return `quorum member ${m.author} is not an agent`;
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
  const open = ledger.findOpenProposal({
    kind,
    targetRef: id,
    author: WIKI_SYNC_DETECTOR,
    requiresNotary: true,
    source: 'wiki-reconciliation',
  });
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

/** A link as a line carries it: its content hash too, on a `derives` link. */
function importedLink(l: TruthLink): TruthLink {
  return { fromId: l.fromId, toId: l.toId, type: l.type, ...(l.contentHash !== undefined ? { contentHash: l.contentHash } : {}) };
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

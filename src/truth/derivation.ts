/**
 * Stenographer — derivation: content hashes and premises
 *
 * A derived entry links to the entries it was built on with `derives`
 * links, each pinned by the premise's content hash (spec/truth-format,
 * "Derivation"): the SHA-256 of the JCS form of the premise's type,
 * author and content, the bytes import rule 2 compares. Neither the line
 * hash nor the ledger hash will do: both depend on chain position, so the
 * same premise hashes differently in two teammates' streams.
 *
 * The same functions read premises off a ledger record and off a wiki
 * line, so the ledger's cached standing and a stream reader's fold agree.
 */

import { canonicalize, sha256Hex } from './jcs.js';
import { LINE_BODY_FIELDS, LINE_ENVELOPE_FIELDS } from './format.js';
import type { TruthEntryType, TruthLink } from './types.js';

/** A premise an entry rests on: pinned (a `derives` link) or unpinned (a `wiki` evidence ref). */
export interface PremiseRef {
  id: string;
  kind: 'derives' | 'wiki';
  /** On a `derives` premise: the content hash the derived entry pinned it by. */
  contentHash?: string;
}

/**
 * The content a derivation pins: the entry's type, author, and body as
 * written, without its status (a state, not content) and with the fields a
 * newer writer added spread back to the top level, as they sit on a line.
 */
export function contentRecord(type: TruthEntryType, author: string, body: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, extra, ...rest } = body as { status?: unknown; extra?: Record<string, unknown> };
  return { type, author, ...rest, ...(extra ?? {}) };
}

/** sha256hex(JCS(content)): the hash a `derives` link carries for this entry. */
export function contentHash(type: TruthEntryType, author: string, body: Record<string, unknown>): string {
  return sha256Hex(canonicalize(contentRecord(type, author, body)));
}

/**
 * The same hash computed from a TB or UV line: `type`, `author` and the
 * line's top-level fields except the envelope, `x-steno` and `status`.
 * Equal to the ledger's for the entry the line describes.
 */
export function lineContentHash(line: Record<string, unknown>): string {
  const content: Record<string, unknown> = { type: line.type, author: line.author };
  for (const [key, value] of Object.entries(line)) {
    if (LINE_ENVELOPE_FIELDS.includes(key) || key === 'status') continue;
    content[key] = value;
  }
  return sha256Hex(canonicalize(content));
}

/** The `derives` links among `links` that start at `id`, as premises. */
export function pinnedPremises(id: string, links: readonly TruthLink[]): PremiseRef[] {
  return links
    .filter((l) => l.type === 'derives' && l.fromId === id)
    .map((l) => ({ id: l.toId, kind: 'derives' as const, ...(l.contentHash !== undefined ? { contentHash: l.contentHash } : {}) }));
}

/** The `wiki` evidence refs in an evidence list, as unpinned premises, each once. */
export function citedPremises(evidence: unknown): PremiseRef[] {
  if (!Array.isArray(evidence)) return [];
  const seen = new Set<string>();
  const out: PremiseRef[] = [];
  for (const item of evidence as Array<{ kind?: unknown; ref?: unknown }>) {
    if (!item || item.kind !== 'wiki' || typeof item.ref !== 'string' || seen.has(item.ref)) continue;
    seen.add(item.ref);
    out.push({ id: item.ref, kind: 'wiki' });
  }
  return out;
}

/**
 * Every premise of a TB or UV: its pinned premises in link order, then the
 * entries its evidence cites. Other entry types rest on nothing.
 */
export function premisesOf(entry: { id: string; type: TruthEntryType; body: Record<string, unknown>; links: readonly TruthLink[] }): PremiseRef[] {
  if (entry.type !== 'TB' && entry.type !== 'UV') return [];
  const pinned = pinnedPremises(entry.id, entry.links);
  const cited = citedPremises(entry.body.evidence).filter((c) => !pinned.some((p) => p.id === c.id));
  return [...pinned, ...cited];
}

/** The premises a TB or UV line names: its `derives` links in `x-steno.links`, then the `wiki` refs in its evidence. */
export function premisesOfLine(line: Record<string, unknown>): PremiseRef[] {
  if (line.type !== 'TB' && line.type !== 'UV') return [];
  const x = (line['x-steno'] ?? {}) as { links?: TruthLink[] };
  return premisesOf({ id: line.id as string, type: line.type, body: line, links: x.links ?? [] });
}

/** Whether `field` is a body field of a `type` line (as opposed to a newer writer's). */
export function isLineBodyField(type: keyof typeof LINE_BODY_FIELDS, field: string): boolean {
  return LINE_BODY_FIELDS[type].includes(field);
}

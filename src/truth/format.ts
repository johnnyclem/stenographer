/**
 * Stenographer — the truth format's field tables and markers
 *
 * What a wiki line of each type carries, which links each entry type writes
 * and may carry into itself, and the markers consumers render truth with.
 * Shared by the ledger's admission check, the wiki codec and every reader
 * of the `truth-format` subpath, so one table answers "is this field the
 * line's own, or a newer writer's?" everywhere.
 */

import type { LinkType, TruthEntryType } from './types.js';

/**
 * A wiki line's top-level fields that aren't its entry's body: the envelope,
 * the chain, and this ledger's own `x-steno`, which the export writes afresh.
 */
export const LINE_ENVELOPE_FIELDS: readonly string[] = ['schemaVersion', 'seq', 'id', 'type', 'ts', 'author', 'prevHash', 'hash', 'x-steno'];

/**
 * The body fields a wiki line of each entry type carries (spec/truth-format).
 * Any other top-level field of an imported line is a newer writer's: it is
 * kept in the body's `extra` and exported again as written.
 */
export const LINE_BODY_FIELDS: Readonly<Record<'TB' | 'UV' | 'ADDENDUM' | 'RULING', readonly string[]>> = {
  TB: ['claim', 'evidence', 'signedBy', 'literals', 'quorum', 'inference', 'answerableBy', 'approvals', 'status'],
  UV: ['assertion', 'basis', 'verifyBy', 'contests', 'inference', 'status'],
  ADDENDUM: ['evidence', 'note', 'quorum'],
  RULING: ['kind', 'opinion', 'target', 'answerableBy', 'scope'],
};

/** The links each entry type writes from itself. */
export const OUTBOUND_LINKS: Record<TruthEntryType, readonly LinkType[]> = {
  TB: ['supersedes', 'signs', 'derives'],
  UV: ['contests', 'signs', 'derives'],
  ADDENDUM: ['verifies', 'refutes', 'overrides', 'corroborates'],
  RULING: ['strikes', 'dismisses', 'supersedes'],
  PROPOSAL: [],
  MARKER: ['supersedes', 'contests', 'verifies', 'refutes', 'signs', 'overrides', 'strikes', 'dismisses', 'derives', 'corroborates'],
};

/** Links into itself an imported entry may carry: its own history, written in a ledger we don't hold. */
export const INBOUND_LINKS: Partial<Record<TruthEntryType, readonly LinkType[]>> = {
  TB: ['overrides', 'contests', 'supersedes', 'strikes'],
  UV: ['verifies', 'refutes', 'supersedes', 'strikes', 'corroborates'],
};

/**
 * The markers consumers render current truth with (short-hand, smallchat
 * and HyperVault print the same strings). A TB may be relied on; a TB
 * under appeal (status `contested`) carries its appeal and is never grounds
 * for a denial; a clouded TB (standing `clouded`) carries its weak premise;
 * an open UV is the dragon marker: flag, don't block, and a corroborated
 * one (nominated by three agent sessions) says so, with the same rule. An
 * unsupported entry is history and gets no marker.
 */
export const MARKERS = {
  TB: '[TB]',
  TB_UNDER_APPEAL: '[TB ⚠ UNDER APPEAL]',
  TB_CLOUDED: '[TB ⚠ CLOUDED]',
  UV: '[UV — UNVERIFIED]',
  UV_CORROBORATED: '[UV · CORROBORATED]',
} as const;

/**
 * A status as a person reads it: `contested` is shown as "under appeal"
 * (the wire value stays `contested`), and a struck entry is "struck". A
 * precedent reads `current` or `superseded`.
 */
export function displayStatus(status: string | null | undefined, struck = false): string {
  if (struck) return 'struck';
  if (status === 'contested') return 'under appeal';
  return status ?? 'unknown';
}

/** The marker for a current TB or UV, by status, standing and (a UV) nomination; null for one consumers don't cite. */
export function markerFor(type: TruthEntryType, status: string | null | undefined, standing?: string | null, corroborated?: boolean): string | null {
  if (standing === 'unsupported') return null;
  if (type === 'UV') return status === 'open' ? (corroborated ? MARKERS.UV_CORROBORATED : MARKERS.UV) : null;
  if (type !== 'TB') return null;
  if (status === 'contested') return MARKERS.TB_UNDER_APPEAL;
  if (status === 'active') return standing === 'clouded' ? MARKERS.TB_CLOUDED : MARKERS.TB;
  return null;
}

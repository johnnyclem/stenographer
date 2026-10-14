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
  TB: ['claim', 'evidence', 'signedBy', 'literals', 'quorum', 'inference', 'status'],
  UV: ['assertion', 'basis', 'verifyBy', 'contests', 'inference', 'status'],
  ADDENDUM: ['evidence', 'note', 'quorum'],
  RULING: ['kind', 'opinion', 'target'],
};

/** The links each entry type writes from itself. */
export const OUTBOUND_LINKS: Record<TruthEntryType, readonly LinkType[]> = {
  TB: ['supersedes', 'signs', 'derives'],
  UV: ['contests', 'signs', 'derives'],
  ADDENDUM: ['verifies', 'refutes', 'overrides'],
  RULING: ['strikes', 'dismisses'],
  PROPOSAL: [],
  MARKER: ['supersedes', 'contests', 'verifies', 'refutes', 'signs', 'overrides', 'strikes', 'dismisses', 'derives'],
};

/** Links into itself an imported entry may carry: its own history, written in a ledger we don't hold. */
export const INBOUND_LINKS: Partial<Record<TruthEntryType, readonly LinkType[]>> = {
  TB: ['overrides', 'contests', 'supersedes', 'strikes'],
  UV: ['verifies', 'refutes', 'supersedes', 'strikes'],
};

/**
 * The markers consumers render current truth with (short-hand, smallchat
 * and HyperVault print the same strings). A TB may be relied on, a
 * contested TB carries its dispute, and an open UV is the dragon marker:
 * flag, don't block.
 */
export const MARKERS = {
  TB: '[TB]',
  TB_CONTESTED: '[TB ⚠ CONTESTED]',
  UV: '[UV — UNVERIFIED]',
} as const;

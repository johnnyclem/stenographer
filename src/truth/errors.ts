/**
 * Stenographer — the truth layer's error classes
 *
 * Kept apart from the ledger so the codec (the `truth-format` subpath,
 * which loads no SQLite driver) can throw and recognize them too.
 */

export class TruthWriteError extends Error {}
/** Contempt of corpus: corroboration must be provenance-independent (§11). */
export class ContemptError extends TruthWriteError {}
/** An agent-drafted proposal reached a signing path that isn't the notary's. */
export class NotarizationRequiredError extends TruthWriteError {}

/**
 * Stenographer — the suspicion detector (PRD R4)
 *
 * When an ADDENDUM refutes a UV or overrides a TB that was derived from
 * premises, on settling evidence that isn't another ledger entry, something
 * underneath may be wrong too: the inference, or one of the premises. The
 * detector files one PROPOSAL per premise that is a TB, a UV draft that
 * contests it, ranked so a person reviews the likeliest first: a premise
 * shared by two or more falsified entries, then derived TBs, then observed
 * roots. A premise that is an open UV gets no proposal (it moves to the
 * front of the verification queue instead); a precedent gets nothing, since
 * evidence doesn't refute a fiat. One level only: if a person later verifies
 * one of these contests and that overrides a derived premise, the trigger
 * fires again from there.
 *
 * Pure: entries and links in, proposal drafts out. Nothing here loads the
 * ledger, so the codec subpath ships it. The ledger wires it into every
 * path that writes a refuting or overriding ADDENDUM (ledger.ts
 * fileSuspicion), and each ledger that applies a refutation runs it
 * locally, since proposals never travel in wiki streams. Dismissing every
 * proposal for one refuted entry with reason `inference-at-fault` closes
 * the review; the dedupe on `targetRef` keeps it from being raised twice.
 */

import { evidenceClass } from './types.js';

/** The detector's identity: a reserved `detector:*` author, which only files proposals. */
export const DERIVATION_DETECTOR = 'detector:derivation';

/** The dismissal reason that closes a derivation review: the inference was wrong, not a premise. */
export const INFERENCE_AT_FAULT = 'inference-at-fault';

/** A premise of the falsified entry, as the detector reads it. */
export interface SuspectPremise {
  id: string;
  type: 'TB' | 'UV' | 'RULING' | string;
  /** The premise's derived status (`active`, `open`, …) and whether it was struck. */
  status: string | null;
  struck: boolean;
  /** Whether the premise itself derives from premises (a derived TB), or is an observed root. */
  derived: boolean;
  /** The premise's claim or assertion, for the draft's text. */
  text: string;
  /** Other falsified entries (refuted or overridden) that rest on this premise, besides the one that triggered. */
  sharedWith: string[];
}

export interface SuspicionInput {
  /** The entry the ADDENDUM falsified. */
  falsified: { id: string; type: 'TB' | 'UV'; text: string; outcome: 'refuted' | 'overridden' };
  /** The ADDENDUM's evidence. */
  evidence: Array<{ kind: string; ref: string; detail?: string }>;
  premises: SuspectPremise[];
}

/** One proposal the detector files: the premise it contests, its rank, and the draft. */
export interface SuspicionDraft {
  premise: string;
  rank: number;
  /** Why it ranks where it does. */
  because: 'shared' | 'derived' | 'root';
  coSuspects: string[];
  kind: 'uv';
  draft: { assertion: string; basis: string; verifyBy: { kind: 'inspect'; value: string; detail: string }; contests: string };
  signal: { source: 'detector:derivation'; detail: string };
  targetRef: string;
}

export interface Suspicion {
  proposals: SuspicionDraft[];
  /** Premises that are open UVs: no proposal, but first in the verification queue. */
  suspectUvs: string[];
}

/** The trigger's evidence condition: at least one settling item whose kind is not `wiki`. */
export function triggersSuspicion(evidence: ReadonlyArray<{ kind: string }>): boolean {
  return evidence.some((e) => e.kind !== 'wiki' && evidenceClass(e.kind) === 'settling');
}

/** The dedupe key of the proposal against `premise` for `falsified`: `derivation:<refuted id>:<premise id>`. */
export function suspicionTargetRef(falsified: string, premise: string): string {
  return `derivation:${falsified}:${premise}`;
}

const isDead = (p: SuspectPremise) =>
  p.struck || (p.type === 'TB' && p.status === 'overridden') || (p.type === 'UV' && (p.status === 'refuted' || p.status === 'verified'));

/**
 * The proposals a refutation files against the premises of what it
 * falsified, ranked, and the open UV premises it moves up the queue. Empty
 * when the evidence doesn't trigger (only `wiki` or question-class items)
 * or the entry has no pinned premises.
 */
export function detectSuspects(input: SuspicionInput): Suspicion {
  if (!triggersSuspicion(input.evidence) || input.premises.length === 0) return { proposals: [], suspectUvs: [] };
  const suspectUvs = input.premises.filter((p) => p.type === 'UV' && p.status === 'open' && !p.struck).map((p) => p.id);
  // Only a live TB premise is contested: a dead one is already history, a precedent is a fiat, a UV goes up the queue
  const suspects = input.premises.filter((p) => p.type === 'TB' && !isDead(p));
  const because = (p: SuspectPremise): SuspicionDraft['because'] => (p.sharedWith.length > 0 ? 'shared' : p.derived ? 'derived' : 'root');
  const tier = { shared: 0, derived: 1, root: 2 };
  const ranked = [...suspects].sort(
    (a, b) => tier[because(a)] - tier[because(b)] || b.sharedWith.length - a.sharedWith.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const cited = input.evidence
    .filter((e) => e.kind !== 'wiki' && evidenceClass(e.kind) === 'settling')
    .map((e) => `${e.kind} ${e.ref}`)
    .join(', ');
  const f = input.falsified;
  const proposals = ranked.map((p, i): SuspicionDraft => {
    const rank = i + 1;
    const coSuspects = ranked.filter((o) => o.id !== p.id).map((o) => o.id);
    const why =
      because(p) === 'shared'
        ? `shared by ${p.sharedWith.length + 1} falsified entries (${[f.id, ...p.sharedWith].join(', ')})`
        : because(p) === 'derived'
          ? 'a derived TB'
          : 'an observed root';
    const detail = coSuspects.length === 0 ? `sole-suspect; ${why}` : `rank ${rank} of ${ranked.length}; ${why}; co-suspects: ${coSuspects.join(', ')}`;
    return {
      premise: p.id,
      rank,
      because: because(p),
      coSuspects,
      kind: 'uv',
      draft: {
        assertion: `Premise ${p.id} ("${p.text}") may be wrong: ${f.type} ${f.id} ("${f.text}") was derived from it and was ${f.outcome} on ${cited}.`,
        basis: `The suspicion detector: a derived entry fell to evidence that is not a ledger entry, so what it rested on is suspect. This premise is ${why}.`,
        verifyBy: { kind: 'inspect', value: p.id, detail: `Check the premise against the evidence that falsified ${f.id}: ${cited}` },
        contests: p.id,
      },
      signal: { source: 'detector:derivation', detail },
      targetRef: suspicionTargetRef(f.id, p.id),
    };
  });
  return { proposals, suspectUvs };
}

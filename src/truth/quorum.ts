/**
 * Stenographer — The agent quorum (spec/truth-format, "Agent quorum")
 *
 * Agents settle claims only together: two or more agent sessions agreeing
 * from different angles at the same time. An agent on its own can only
 * attest. A settlement by agents — an ADDENDUM verifying or refuting a UV,
 * or a TB an agent signs — is valid only when its line carries a `quorum`:
 * one member per agreeing session, each with the evidence it brought.
 *
 * The rules (spec numbering):
 *   1. Two or more members, from distinct agent sessions, each an
 *      accountable identity.
 *   2. The writer is a member; a TB is signed by its writer.
 *   3. From different angles: every member cites settling evidence, no
 *      evidence item appears in two members, and the members' settling
 *      evidence spans two kinds or more.
 *   4. At the same time: the members' and the line's timestamps lie within
 *      15 minutes of each other.
 *   5. Agreeing: an ADDENDUM's members carry the verdict its link applies,
 *      and a quorum never overrides. (A TB's members drafted the same
 *      literals: the writer's obligation, which no reader can check.)
 *   6. The line shows its evidence: the members' items, and no others.
 *
 * checkQuorum is line-local, like the link rules: the codec and the
 * ledger's admission both apply it. chooseQuorum picks, deterministically,
 * the quorum an attestation or a draft completes, or says what is missing.
 */

import { canonicalize } from './jcs.js';
import {
  evidenceClass,
  hasControlCharacters,
  identityKey,
  isAnonymousIdentity,
  isReservedIdentity,
  isRfc3339DateTime,
  MIGRATION_AUTHOR,
  DETECTOR_PREFIX,
  SETTLING_EVIDENCE_KINDS,
} from './types.js';

/** Members' and the line's timestamps lie within this of each other: 15 minutes. */
export const QUORUM_WINDOW_MS = 900_000;
/** The fewest agent sessions that settle a claim together. */
export const QUORUM_MIN_MEMBERS = 2;

/** Without a signer registry, an agent is an identity whose key starts with this. */
export const AGENT_PREFIX = 'agent:';

/** Decides whether an identity is an agent's (a signer registry, or the `agent:` prefix). */
export type AgentClassifier = (identity: string) => boolean;

/** The rule a reader applies without a signer registry: the identity's key starts with `agent:`. */
export function hasAgentPrefix(identity: string): boolean {
  return typeof identity === 'string' && identityKey(identity).startsWith(AGENT_PREFIX);
}

export type QuorumVerdict = 'verified' | 'refuted';

/** One agreeing agent session: who, which session, when, and the evidence it brought. */
export interface QuorumMember {
  author: string;
  agentSessionId: string;
  ts: string;
  evidence: Array<{ kind: string; ref: string; detail?: string }>;
  /** ADDENDUM members: the verdict the session filed. */
  verdict?: QuorumVerdict;
}

/** What a resolution link applies to its UV. */
const VERDICT_OF: Record<string, QuorumVerdict> = { verifies: 'verified', refutes: 'refuted' };

/** An evidence item's identity in the quorum rules: its kind and its ref, the ref trimmed. */
export function evidenceKey(item: { kind: string; ref: string }): string {
  return JSON.stringify([item.kind, item.ref.trim()]);
}

const describeItem = (item: { kind: string; ref: string }) => `${item.kind} ${item.ref.trim()}`;

/** The identity rules (spec, Identities), for a quorum member: never anonymous, generic, reserved or with control characters. */
function identityIssue(identity: string): string | null {
  if (isAnonymousIdentity(identity)) return `'${identity}' is anonymous or generic`;
  if (hasControlCharacters(identity)) return 'its identity contains control characters';
  if (isReservedIdentity(identity)) return `'${identity}' is reserved ('${MIGRATION_AUTHOR}' and '${DETECTOR_PREFIX}*')`;
  return null;
}

/** What checkQuorum reads: a wiki line (links from `x-steno.links`), or an entry about to be appended. */
export interface QuorumSubject {
  type: unknown;
  id?: unknown;
  author: unknown;
  ts: unknown;
  evidence: unknown;
  quorum: unknown;
  signedBy?: unknown;
  /** The links the line writes. Omitted: read from `x-steno.links` (those starting at `id`); absent there too, unknown. */
  links?: ReadonlyArray<{ type: string; fromId?: string }> | null;
  'x-steno'?: unknown;
}

function isEvidenceList(value: unknown): value is Array<{ kind: string; ref: string }> {
  return (
    Array.isArray(value) &&
    value.every((e) => e && typeof e === 'object' && typeof (e as { kind: unknown }).kind === 'string' && typeof (e as { ref: unknown }).ref === 'string')
  );
}

function linksOf(subject: QuorumSubject): ReadonlyArray<{ type: string }> | null {
  if (subject.links !== undefined) return subject.links;
  const x = subject['x-steno'] as { links?: unknown } | undefined;
  if (!x || !Array.isArray(x.links)) return null;
  return (x.links as Array<{ type: string; fromId?: string }>).filter((l) => l && typeof l === 'object' && l.fromId === subject.id);
}

/**
 * The rules a line carrying a `quorum` breaks, each as one message naming
 * its rule; empty when it keeps them all. Line-local: a reader needs nothing
 * but the line. Rule 5's TB half (the members drafted the same literals) is
 * the writer's obligation, not checked here.
 */
export function checkQuorum(subject: QuorumSubject): string[] {
  if (subject.type !== 'TB' && subject.type !== 'ADDENDUM') {
    return [`a quorum appears only on TB and ADDENDUM lines, not on a ${String(subject.type)} line`];
  }
  const raw = subject.quorum;
  if (!Array.isArray(raw)) return ['a quorum is an array of members'];

  // The members' shape, before any rule can be read
  const shape: string[] = [];
  raw.forEach((m, i) => {
    const n = i + 1;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return void shape.push(`quorum member ${n} is not an object`);
    const member = m as Record<string, unknown>;
    if (typeof member.author !== 'string') shape.push(`quorum member ${n} has no author`);
    if (typeof member.agentSessionId !== 'string') shape.push(`quorum member ${n} has no agent session (rule 1)`);
    if (typeof member.ts !== 'string' || !isRfc3339DateTime(member.ts)) shape.push(`quorum member ${n}'s ts is not an RFC 3339 date-time`);
    if (!isEvidenceList(member.evidence) || member.evidence.length === 0) shape.push(`quorum member ${n} cites no evidence`);
    if (subject.type === 'ADDENDUM' && member.verdict !== 'verified' && member.verdict !== 'refuted') {
      shape.push(`quorum member ${n}'s verdict is verified or refuted`);
    }
  });
  if (shape.length > 0) return shape;
  const members = raw as QuorumMember[];
  const issues: string[] = [];

  // Rule 1: two or more, distinct sessions, accountable identities
  if (members.length < QUORUM_MIN_MEMBERS) {
    issues.push(`a quorum needs at least ${QUORUM_MIN_MEMBERS} members, and this one has ${members.length} (rule 1)`);
  }
  const sessions = new Map<string, number>();
  members.forEach((m, i) => {
    const session = m.agentSessionId.trim();
    if (session.length === 0) {
      issues.push(`quorum member ${i + 1} names no agent session (rule 1)`);
    } else if (sessions.has(session)) {
      issues.push(`quorum members ${sessions.get(session)} and ${i + 1} share agent session ${session}: one session is one witness (rule 1)`);
    } else {
      sessions.set(session, i + 1);
    }
    const who = identityIssue(m.author);
    if (who) issues.push(`quorum member ${i + 1}: ${who} (rule 1)`);
  });

  // Rule 2: the writer is a member; a TB is signed by its writer
  const author = typeof subject.author === 'string' ? subject.author : '';
  if (!members.some((m) => identityKey(m.author) === identityKey(author))) {
    issues.push(`the line's author ${author} is not a quorum member: the agent whose attestation completed the quorum writes it (rule 2)`);
  }
  if (subject.type === 'TB' && (typeof subject.signedBy !== 'string' || identityKey(subject.signedBy) !== identityKey(author))) {
    issues.push(`a quorum TB is signed by its author (rule 2): signedBy ${String(subject.signedBy)} is not ${author}`);
  }

  // Rule 3: from different angles
  const citedBy = new Map<string, number>();
  const settlingKinds = new Set<string>();
  members.forEach((m, i) => {
    const settling = m.evidence.filter((e) => evidenceClass(e.kind) === 'settling');
    if (settling.length === 0) {
      issues.push(`quorum member ${i + 1} cites no settling evidence (${SETTLING_EVIDENCE_KINDS.join(', ')}) (rule 3)`);
    }
    for (const e of settling) settlingKinds.add(e.kind);
    for (const e of new Map(m.evidence.map((e) => [evidenceKey(e), e])).values()) {
      const key = evidenceKey(e);
      const prior = citedBy.get(key);
      if (prior !== undefined) {
        issues.push(`quorum members ${prior} and ${i + 1} both cite ${describeItem(e)}: each member brings evidence of its own (rule 3)`);
      } else {
        citedBy.set(key, i + 1);
      }
    }
  });
  if (settlingKinds.size === 1) {
    issues.push(`a quorum's settling evidence spans at least two settling kinds, and this one cites only ${[...settlingKinds][0]} (rule 3)`);
  }

  // Rule 4: at the same time
  const times = [...members.map((m) => m.ts), subject.ts].map((t) => (typeof t === 'string' ? Date.parse(t) : NaN));
  if (times.some((t) => !Number.isFinite(t))) {
    issues.push(`the line's ts is not a timestamp (rule 4)`);
  } else {
    const span = Math.max(...times) - Math.min(...times);
    if (span > QUORUM_WINDOW_MS) {
      issues.push(`the quorum's members and its line lie more than 15 minutes apart (${span} ms) (rule 4)`);
    }
  }

  // Rule 5: agreeing (an ADDENDUM's verdicts; a TB's literals are the writer's obligation)
  if (subject.type === 'ADDENDUM') {
    const verdicts = new Set(members.map((m) => m.verdict));
    if (verdicts.size > 1) issues.push(`the quorum's members disagree: ${[...verdicts].join(' and ')} (rule 5)`);
    const links = linksOf(subject);
    if (links) {
      if (links.some((l) => l.type === 'overrides')) {
        issues.push('a quorum ADDENDUM never overrides a TB: overriding is a person\'s act (rule 5)');
      }
      const resolutions = links.filter((l) => l.type in VERDICT_OF);
      if (resolutions.length === 0) issues.push('a quorum ADDENDUM verifies or refutes a UV: its links name neither (rule 5)');
      for (const link of resolutions) {
        members.forEach((m, i) => {
          if (m.verdict !== VERDICT_OF[link.type]) {
            issues.push(`quorum member ${i + 1}'s verdict ${m.verdict} is not the one its line's ${link.type} link applies (${VERDICT_OF[link.type]}) (rule 5)`);
          }
        });
      }
    }
  }

  // Rule 6: the line's evidence is the members' evidence
  if (!isEvidenceList(subject.evidence)) {
    issues.push(`the line's evidence is not an evidence list (rule 6)`);
  } else {
    const shown = new Set(subject.evidence.map(evidenceKey));
    members.forEach((m, i) => {
      for (const e of m.evidence) {
        if (!shown.has(evidenceKey(e))) issues.push(`the line's evidence lacks quorum member ${i + 1}'s ${describeItem(e)} (rule 6)`);
      }
    });
    for (const e of subject.evidence) {
      if (!citedBy.has(evidenceKey(e))) issues.push(`the line's evidence holds ${describeItem(e)}, which no quorum member cites (rule 6)`);
    }
  }
  return issues;
}

/** The members' evidence, in member order, each item once (by kind and trimmed ref): a quorum line's `evidence`. */
export function quorumEvidence<E extends { kind: string; ref: string }>(members: Array<{ evidence: E[] }>): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const m of members) {
    for (const e of m.evidence) {
      const key = evidenceKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/**
 * A literal set's canonical form: each literal as `{subject?, dead, current?}`
 * in JCS, sorted, each once. Two agent drafts agree on a tombstone when their
 * sets' forms are equal.
 */
export function literalSetKey(literals: ReadonlyArray<{ dead: string; subject?: string; current?: string }>): string {
  const forms = literals.map((l) =>
    canonicalize({ dead: l.dead, ...(l.subject !== undefined ? { subject: l.subject } : {}), ...(l.current !== undefined ? { current: l.current } : {}) })
  );
  return JSON.stringify([...new Set(forms)].sort());
}

/** Where a quorum stands, for an attestation or a draft that didn't complete one. */
export interface QuorumProgress {
  /** Agent sessions, this one included, that agree within the window. */
  agreeing: number;
  needed: number;
  /** When this attestation or draft leaves the window. */
  windowEndsAt: string;
  /**
   * What is still needed: 'a settling evidence item' (this one cites none),
   * 'another session' (no other session agrees within the window with
   * settling evidence), 'other evidence' (every one that does cites one of
   * this one's items), 'a second evidence kind' (together they cite one
   * settling kind).
   */
  missing: string[];
}

/** An attestation or a draft that may join a quorum. */
export interface QuorumCandidate {
  id: string;
  author: string;
  agentSessionId: string | null;
  createdAt: string;
  evidence: Array<{ kind: string; ref: string; detail?: string }>;
}

/**
 * The quorum `self` completes with the agreeing `candidates` at `now`
 * (`members`, ordered by time; null when none forms), and where it stands.
 * Candidates count when they lie within the window of now (so of each
 * other) and come from another session. Deterministic: `self`, the earliest
 * candidate that makes a valid pair with it, then every later candidate
 * that keeps the rules. (Any quorum holds a valid pair with `self`, so
 * searching pairs finds one whenever one exists.)
 */
export function chooseQuorum<C extends QuorumCandidate>(
  self: C,
  candidates: C[],
  now: number
): { members: C[] | null; progress: QuorumProgress } {
  const time = (c: C) => Date.parse(c.createdAt);
  const session = (c: C) => c.agentSessionId?.trim() ?? '';
  const inWindow = (c: C) => time(c) >= now - QUORUM_WINDOW_MS && time(c) <= now;
  const keys = (c: C) => new Set(c.evidence.map(evidenceKey));
  const settling = (c: C) => c.evidence.some((e) => evidenceClass(e.kind) === 'settling');
  const kinds = (cs: C[]) => new Set(cs.flatMap((c) => c.evidence.filter((e) => evidenceClass(e.kind) === 'settling').map((e) => e.kind)));
  const disjoint = (a: C, b: C) => {
    const bk = keys(b);
    return [...keys(a)].every((k) => !bk.has(k));
  };
  const byTime = (a: C, b: C) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const pool = session(self)
    ? candidates.filter((c) => c.id !== self.id && session(c) && session(c) !== session(self) && inWindow(c)).sort(byTime)
    : [];
  const fits = (members: C[], c: C) => settling(c) && members.every((m) => session(m) !== session(c) && disjoint(m, c));
  const base = {
    agreeing: new Set([session(self), ...pool.map(session)].filter(Boolean)).size || 1,
    needed: QUORUM_MIN_MEMBERS,
    windowEndsAt: new Date(time(self) + QUORUM_WINDOW_MS).toISOString(),
  };

  if (session(self) && inWindow(self) && settling(self)) {
    const partner = pool.find((c) => fits([self], c) && kinds([self, c]).size >= 2);
    if (partner) {
      const members = [self, partner];
      for (const c of pool) if (c !== partner && fits(members, c)) members.push(c);
      return { members: members.sort(byTime), progress: { ...base, missing: [] } };
    }
  }

  const missing: string[] = [];
  const partners = pool.filter(settling);
  if (!settling(self)) missing.push('a settling evidence item');
  if (partners.length === 0 || !inWindow(self)) missing.push('another session');
  else if (settling(self)) missing.push(partners.some((c) => disjoint(self, c)) ? 'a second evidence kind' : 'other evidence');
  return { members: null, progress: { ...base, missing } };
}

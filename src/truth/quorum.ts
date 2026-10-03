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
 *      evidence item appears in two members (in any spelling: refs compare
 *      normalized for their kind, sameEvidence), and the members' settling
 *      evidence spans two kinds or more. A kind the reader doesn't know is
 *      an unknown value, not a broken rule: it may be a newer writer's
 *      settling kind, so it never makes a line fail these clauses (the
 *      import fails closed on it instead).
 *   4. At the same time: the members' and the line's timestamps lie within
 *      15 minutes of each other, read to the millisecond.
 *   5. Agreeing: an ADDENDUM's members agree, and carry the verdict each
 *      of its resolution links applies (those its `x-steno.links` lists: a
 *      top-level `links` is an unknown field), and a quorum never overrides.
 *      A TB carries the literals its members agreed on. (That the members
 *      drafted those literals is the writer's obligation: no reader sees
 *      the drafts.)
 *   6. The line shows its evidence: the members' items, and no others.
 *
 * Sessions and refs are trimmed of Unicode White_Space (trimWhiteSpace), so
 * every codec trims the same characters. checkQuorum is line-local, like
 * the link rules: the codec and the ledger's admission both apply it.
 * chooseQuorum picks, deterministically, the quorum an attestation or a
 * draft completes, or says what is missing.
 */

import { canonicalize } from './jcs.js';
import {
  evidenceClass,
  EVIDENCE_KINDS,
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

/**
 * Removes leading and trailing Unicode White_Space: the characters every
 * codec trims from a quorum member's session and an evidence ref. (Not
 * String.prototype.trim, which also removes U+FEFF and keeps U+0085.)
 */
export function trimWhiteSpace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

/** An evidence item as rule 6 compares it: its kind and its ref, the ref trimmed. */
export function evidenceKey(item: { kind: string; ref: string }): string {
  return JSON.stringify([item.kind, trimWhiteSpace(item.ref)]);
}

/**
 * A ref as rule 3 compares it, normalized for its kind so that one piece
 * of evidence spelled two ways is one item: a `commit` lowercased; a `file`
 * path with `\` read as `/` and empty and `.` segments dropped (`./src//x.ts`
 * is `src/x.ts`); a `test` or `claimed-command` with each run of White_Space
 * read as one space. Every ref is trimmed first.
 */
export function evidenceRefKey(item: { kind: string; ref: string }): string {
  const ref = trimWhiteSpace(item.ref);
  switch (item.kind) {
    case 'commit':
      return ref.toLowerCase();
    case 'file': {
      const segments = ref.replace(/\\/g, '/').split('/');
      const absolute = segments[0] === '';
      const kept = segments.filter((s) => s !== '' && s !== '.');
      return (absolute ? '/' : '') + kept.join('/');
    }
    case 'test':
    case 'claimed-command':
      return ref.replace(/\p{White_Space}+/gu, ' ');
    default:
      return ref;
  }
}

/**
 * Whether two evidence items are the same evidence (rule 3): the same kind,
 * and refs equal once normalized for it (evidenceRefKey), where a `commit`
 * one is a prefix of the other also counts (an abbreviated hash).
 */
export function sameEvidence(a: { kind: string; ref: string }, b: { kind: string; ref: string }): boolean {
  if (a.kind !== b.kind) return false;
  const x = evidenceRefKey(a);
  const y = evidenceRefKey(b);
  return x === y || (a.kind === 'commit' && x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x)));
}

/** Whether this version knows an evidence kind; one it doesn't know may be a newer writer's settling kind. */
const isKnownKind = (kind: string) => (EVIDENCE_KINDS as readonly string[]).includes(kind);

/**
 * A timestamp as rule 4 reads it: to the millisecond, any further
 * fractional digits dropped (not rounded). NaN when it isn't one.
 */
export function quorumTime(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
}

const describeItem = (item: { kind: string; ref: string }) => `${item.kind} ${trimWhiteSpace(item.ref)}`;

/** The identity rules (spec, Identities), for a quorum member: never anonymous, generic, reserved or with control characters. */
function identityIssue(identity: string): string | null {
  if (isAnonymousIdentity(identity)) return `'${identity}' is anonymous or generic`;
  if (hasControlCharacters(identity)) return 'its identity contains control characters';
  if (isReservedIdentity(identity)) return `'${identity}' is reserved ('${MIGRATION_AUTHOR}' and '${DETECTOR_PREFIX}*')`;
  return null;
}

/**
 * What `checkQuorum` reads: a wiki line, or an entry about to be appended
 * (the ledger gives its own links as `x-steno.links`). Any parsed line
 * object will do: it reads the fields below and no others, so a field this
 * version doesn't define never hides a rule or triggers one, a top-level
 * `links` among them (spec: Unknown values).
 */
export interface QuorumSubject {
  type: unknown;
  id?: unknown;
  author: unknown;
  ts: unknown;
  evidence: unknown;
  quorum: unknown;
  signedBy?: unknown;
  /** A TB's literals: a quorum TB carries the ones its members agreed on. */
  literals?: unknown;
  /**
   * Where an ADDENDUM's links are read (rule 5): `x-steno.links`, those
   * starting at `id`. Absent, or no list there: the line lists no link.
   */
  'x-steno'?: unknown;
}

function isEvidenceList(value: unknown): value is Array<{ kind: string; ref: string }> {
  return (
    Array.isArray(value) &&
    value.every((e) => e && typeof e === 'object' && typeof (e as { kind: unknown }).kind === 'string' && typeof (e as { ref: unknown }).ref === 'string')
  );
}

/**
 * The links an ADDENDUM writes, as rule 5 reads them: the ones its
 * `x-steno.links` lists starting at its `id` (spec: Agent quorum, "on an
 * ADDENDUM, rule 5 reads the links in `x-steno.links`"). Nothing else on the
 * line: a top-level `links` is a field this version doesn't define.
 */
function linksOf(subject: QuorumSubject): ReadonlyArray<{ type: unknown }> {
  const x = subject['x-steno'] as { links?: unknown } | undefined;
  if (!x || typeof x !== 'object' || !Array.isArray(x.links)) return [];
  return (x.links as unknown[]).filter(
    (l): l is { type: unknown; fromId: unknown } => !!l && typeof l === 'object' && (l as { fromId?: unknown }).fromId === subject.id
  );
}

/**
 * The rules a line carrying a `quorum` breaks, each as one message naming
 * its rule; empty when it keeps them all. Line-local: a reader needs nothing
 * but the line. That a TB's members drafted the literals it carries (rule
 * 5) is the writer's obligation, not checked here; that it carries some is.
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
    const session = trimWhiteSpace(m.agentSessionId);
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

  // Rule 3: from different angles. A kind this version doesn't know may be a
  // newer writer's settling kind: an unknown value, which never refuses a line
  const settlingKinds = new Set<string>();
  const unknownKinds = members.some((m) => m.evidence.some((e) => !isKnownKind(e.kind)));
  members.forEach((m, i) => {
    const settling = m.evidence.filter((e) => evidenceClass(e.kind) === 'settling');
    if (settling.length === 0 && m.evidence.every((e) => isKnownKind(e.kind))) {
      issues.push(`quorum member ${i + 1} cites no settling evidence (${SETTLING_EVIDENCE_KINDS.join(', ')}) (rule 3)`);
    }
    for (const e of settling) settlingKinds.add(e.kind);
  });
  members.forEach((m, i) => {
    for (let j = 0; j < i; j++) {
      const shared = m.evidence.find((e) => members[j].evidence.some((o) => sameEvidence(e, o)));
      if (shared) {
        issues.push(`quorum members ${j + 1} and ${i + 1} both cite ${describeItem(shared)}: each member brings evidence of its own (rule 3)`);
        break;
      }
    }
  });
  if (settlingKinds.size === 1 && !unknownKinds) {
    issues.push(`a quorum's settling evidence spans at least two settling kinds, and this one cites only ${[...settlingKinds][0]} (rule 3)`);
  }

  // Rule 4: at the same time, to the millisecond
  const times = [...members.map((m) => m.ts), subject.ts].map((t) => (typeof t === 'string' ? quorumTime(t) : NaN));
  if (times.some((t) => !Number.isFinite(t))) {
    issues.push(`the line's ts is not a timestamp (rule 4)`);
  } else {
    const span = Math.max(...times) - Math.min(...times);
    if (span > QUORUM_WINDOW_MS) {
      issues.push(`the quorum's members and its line lie more than 15 minutes apart (${span} ms) (rule 4)`);
    }
  }

  // Rule 5: agreeing. An ADDENDUM's verdicts agree, with each other and with
  // the links its x-steno.links lists (one that lists no resolution link, or
  // only types this version doesn't know, is checked for agreeing verdicts
  // only); a TB carries the literals its members agreed on
  if (subject.type === 'TB' && (!Array.isArray(subject.literals) || subject.literals.length === 0)) {
    issues.push('a quorum TB carries the literals its members agreed on (literals, at least one) (rule 5)');
  }
  if (subject.type === 'ADDENDUM') {
    const verdicts = new Set(members.map((m) => m.verdict));
    if (verdicts.size > 1) issues.push(`the quorum's members disagree: ${[...verdicts].join(' and ')} (rule 5)`);
    const links = linksOf(subject);
    if (links.some((l) => l.type === 'overrides')) {
      issues.push('a quorum ADDENDUM never overrides a TB: overriding is a person\'s act (rule 5)');
    }
    for (const type of links.map((l) => l.type)) {
      if (typeof type !== 'string' || !Object.hasOwn(VERDICT_OF, type)) continue;
      members.forEach((m, i) => {
        if (m.verdict !== VERDICT_OF[type]) {
          issues.push(`quorum member ${i + 1}'s verdict ${m.verdict} is not the one its line's ${type} link applies (${VERDICT_OF[type]}) (rule 5)`);
        }
      });
    }
  }

  // Rule 6: the line's evidence is the members' evidence (items compare by kind and trimmed ref)
  if (!isEvidenceList(subject.evidence)) {
    issues.push(`the line's evidence is not an evidence list (rule 6)`);
  } else {
    const citedBy = new Set(members.flatMap((m) => m.evidence.map(evidenceKey)));
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

/** The members' evidence, in member order, each item once (by kind and trimmed ref, evidenceKey): a quorum line's `evidence`. */
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
  /**
   * Agent sessions, this one included, that agree within the window and
   * cite settling evidence: the ones that could join a quorum.
   */
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
  const time = (c: C) => quorumTime(c.createdAt);
  const session = (c: C) => (c.agentSessionId ? trimWhiteSpace(c.agentSessionId) : '');
  const inWindow = (c: C) => time(c) >= now - QUORUM_WINDOW_MS && time(c) <= now;
  const settling = (c: C) => c.evidence.some((e) => evidenceClass(e.kind) === 'settling');
  const kinds = (cs: C[]) => new Set(cs.flatMap((c) => c.evidence.filter((e) => evidenceClass(e.kind) === 'settling').map((e) => e.kind)));
  const disjoint = (a: C, b: C) => a.evidence.every((e) => !b.evidence.some((o) => sameEvidence(e, o)));
  const byTime = (a: C, b: C) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const pool = session(self)
    ? candidates.filter((c) => c.id !== self.id && session(c) && session(c) !== session(self) && inWindow(c)).sort(byTime)
    : [];
  const fits = (members: C[], c: C) => settling(c) && members.every((m) => session(m) !== session(c) && disjoint(m, c));
  // Who could join a quorum: this session, when it cites settling evidence and is in the window, and every partner that does
  const able = [...(session(self) && inWindow(self) && settling(self) ? [self] : []), ...pool.filter(settling)];
  const base = {
    agreeing: new Set(able.map(session)).size,
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

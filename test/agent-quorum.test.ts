/**
 * Agents settle claims only together (spec/truth-format, "Agent quorum").
 *
 * The user's rule, verbatim: "agents can only settle claims together,
 * meaning 2 or more agreeing from different angles at the same time". An
 * agent on its own can only attest; a claim settles when two or more agent
 * sessions agree from different angles (disjoint evidence, two settling
 * kinds) within 15 minutes, or when a person signs. Overriding, striking
 * and ruling stay a person's acts, by every path: MCP, the ledger API and
 * wiki import. The 15-minute window runs on an injected clock.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TruthLedger, ContemptError } from '../src/truth/ledger.js';
import { StenographerServer, runCLI } from '../src/mcp/server.js';
import { SignerRegistry } from '../src/truth/identity.js';
import { StateStore } from '../src/store/index.js';
import { Stenographer } from '../src/core/stenographer.js';
import { settleTombstoneQuorum } from '../src/truth/attestations.js';
import { decodeWikiLine, exportWikiEntries, importWikiEntries, wikiLineHash } from '../src/truth/wiki.js';
import { QUORUM_MIN_MEMBERS, QUORUM_WINDOW_MS, checkQuorum, type QuorumMember } from '../src/truth/quorum.js';
import { CONSUMPTION_RULES, type AddendumEntry, type ProposalEntry, type TbEntry, type UvEntry } from '../src/truth/types.js';
import type { StenographerConfig } from '../src/types.js';

const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

const COMMIT = { kind: 'commit', ref: 'a1b2c3', detail: 'config.ts sets LOG_BUDGET = 100' };
const FILE = { kind: 'file', ref: 'config.ts:3', detail: 'LOG_BUDGET = 100' };
const TEST = { kind: 'test', ref: 'test/config.test.ts', detail: 'budget is 100' };
const CLAIMED = { kind: 'command', ref: 'grep -n LOG_BUDGET config.ts', detail: 'config.ts:3:LOG_BUDGET = 100' };

const AGENT = 'agent:claude-code';
const LITERALS = [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }, { dead: 'legacyRateLimiter' }];

// ─────────────────────────────────────────────────────────────
// The rules (checkQuorum): what every reader checks on a line
// ─────────────────────────────────────────────────────────────

describe('checkQuorum: the rules a line with a quorum must keep', () => {
  const member = (over: Partial<QuorumMember> = {}): QuorumMember => ({
    author: AGENT,
    agentSessionId: 'sess-a',
    ts: at(0),
    evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
    verdict: 'verified',
    ...over,
  });
  const second = (over: Partial<QuorumMember> = {}) =>
    member({ agentSessionId: 'sess-b', ts: at(5 * MIN), evidence: [{ kind: 'file', ref: 'config.ts:3' }], ...over });
  // An ADDENDUM's links are the ones its x-steno.links lists starting at its id
  const linked = (...types: string[]) => ({ 'x-steno': { links: types.map((type, i) => ({ fromId: 'ADD1', toId: `UV${i + 1}`, type })) } });
  const addendum = (over: Record<string, unknown> = {}) => {
    const quorum = (over.quorum as QuorumMember[] | undefined) ?? [member(), second()];
    return {
      type: 'ADDENDUM',
      id: 'ADD1',
      author: AGENT,
      ts: at(5 * MIN),
      evidence: quorum.flatMap((m) => m.evidence),
      quorum,
      ...linked('verifies'),
      ...over,
    };
  };

  it('passes two sessions agreeing from different angles at the same time', () => {
    expect(QUORUM_MIN_MEMBERS).toBe(2);
    expect(QUORUM_WINDOW_MS).toBe(900_000);
    expect(checkQuorum(addendum())).toEqual([]);
    // Two sessions may share one identity: distinct sessions are distinct witnesses
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'Agent:Claude-Code' })] }))).toEqual([]);
    // A TB: no verdicts; signed by its author
    const { verdict: _a, ...a } = member();
    const { verdict: _b, ...b } = second();
    const tb = { type: 'TB', author: AGENT, signedBy: AGENT, ts: at(5 * MIN), evidence: [...a.evidence, ...b.evidence], quorum: [a, b], literals: LITERALS };
    expect(checkQuorum(tb)).toEqual([]);
  });

  it('rule 1: two or more members, from distinct sessions, each an accountable identity', () => {
    const one = [member()];
    expect(checkQuorum(addendum({ quorum: one, evidence: one[0].evidence })).join()).toMatch(/at least 2 members.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: 'sess-a' })] })).join()).toMatch(/share agent session sess-a.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: '  ' })] })).join()).toMatch(/agent session.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'Assistant' })] })).join()).toMatch(/anonymous.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'detector:x' })] })).join()).toMatch(/reserved.*rule 1/);
  });

  it('rule 2: the writer is a member, and a TB is signed by its author', () => {
    expect(checkQuorum(addendum({ author: 'agent:other' })).join()).toMatch(/agent:other is not a quorum member.*rule 2/);
    const { verdict: _a, ...a } = member();
    const { verdict: _b, ...b } = second();
    const tb = { type: 'TB', author: AGENT, signedBy: 'kim', ts: at(5 * MIN), evidence: [...a.evidence, ...b.evidence], quorum: [a, b], literals: LITERALS };
    expect(checkQuorum(tb).join()).toMatch(/signed by its author.*rule 2/);
    // signedBy compares with the author by key, like every identity
    expect(checkQuorum({ ...tb, signedBy: 'AGENT:CLAUDE-CODE' })).toEqual([]);
  });

  it('rule 1: sessions compare trimmed of Unicode White_Space, and only of it', () => {
    for (const spelling of [' sess-a', 'sess-a\t', '\u00a0sess-a\u3000']) {
      expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: spelling })] })).join(), JSON.stringify(spelling)).toMatch(
        /share agent session sess-a.*rule 1/
      );
    }
    // U+FEFF is not White_Space: another session id (String.prototype.trim would have removed it)
    expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: 'sess-a\ufeff' })] }))).toEqual([]);
  });

  it('rule 3: from different angles — settling evidence each, no item shared, two settling kinds', () => {
    const chat = second({ evidence: [{ kind: 'chat', ref: 'slack:C01/p17' }] });
    expect(checkQuorum(addendum({ quorum: [member({ evidence: [COMMIT, TEST] }), chat] })).join()).toMatch(/member 2 cites no settling evidence.*rule 3/);
    // Items compare by kind and ref, the ref trimmed
    const shared = second({ evidence: [{ kind: 'commit', ref: ' a1b2c3 ' }, { kind: 'file', ref: 'config.ts:3' }] });
    expect(checkQuorum(addendum({ quorum: [member(), shared], evidence: [{ kind: 'commit', ref: 'a1b2c3' }, { kind: 'file', ref: 'config.ts:3' }] })).join()).toMatch(
      /both cite commit a1b2c3.*rule 3/
    );
    const oneKind = second({ evidence: [{ kind: 'commit', ref: 'd4e5f6' }] });
    expect(checkQuorum(addendum({ quorum: [member(), oneKind] })).join()).toMatch(/two settling kinds.*rule 3/);
    // Question-class evidence only: message, chat, ticket, doc, pre-1.0 command
    for (const kind of ['message', 'chat', 'ticket', 'doc', 'command']) {
      const q = [member({ evidence: [{ kind, ref: 'x1' }] }), second({ evidence: [{ kind, ref: 'x2' }] })];
      expect(checkQuorum(addendum({ quorum: q })).join(), kind).toMatch(/cites no settling evidence.*rule 3/);
    }
  });

  it('rule 3: a kind the reader does not know is an unknown value, not a broken rule (the import fails closed on it)', () => {
    // A newer writer's settling kind: this reader can't tell, so it doesn't refuse the line under rule 3
    const bench = { kind: 'benchmark', ref: 'bench/retry' };
    expect(checkQuorum(addendum({ quorum: [member({ evidence: [{ kind: 'commit', ref: 'a1b2c3' }, { kind: 'file', ref: 'x.ts:1' }] }), second({ evidence: [bench] })] }))).toEqual([]);
    expect(checkQuorum(addendum({ quorum: [member(), second({ evidence: [{ kind: 'commit', ref: 'd4e5f6' }, bench] })] }))).toEqual([]);
    // ...but the rules it can read still hold: an item two members cite, whatever its kind
    expect(checkQuorum(addendum({ quorum: [member({ evidence: [{ kind: 'commit', ref: 'a1b2c3' }, bench] }), second({ evidence: [{ kind: 'file', ref: 'f' }, bench] })] })).join()).toMatch(
      /both cite benchmark bench\/retry.*rule 3/
    );
  });

  it('rule 3: the same evidence in another spelling is one angle (refs compare normalized for their kind)', () => {
    const test = { kind: 'test', ref: 'test/a.test.ts' };
    const file = { kind: 'file', ref: 'src/b.ts:1' };
    const twice = (a: { kind: string; ref: string }, b: { kind: string; ref: string }) =>
      checkQuorum(addendum({ quorum: [member({ evidence: [a, test] }), second({ evidence: [b, file] })] })).join();
    const same: Array<[string, string, string]> = [
      ['commit', 'a1b2c3d', 'A1B2C3D'],
      ['commit', 'a1b2c3d', 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e'],
      ['commit', ' a1b2c3d\u00a0', 'a1b2c3d'],
      ['file', 'src/retry.ts:10', './src/retry.ts:10'],
      ['file', 'src/retry.ts:10', 'src//retry.ts:10'],
      ['file', 'src/retry.ts:10', 'src\\retry.ts:10'],
      ['file', 'src/retry.ts:10', 'src/./retry.ts:10'],
      ['test', 'retry budget is per tenant', 'retry  budget is\tper tenant'],
      ['claimed-command', 'grep -n LOG_BUDGET config.ts', 'grep  -n LOG_BUDGET\tconfig.ts'],
    ];
    for (const [kind, a, b] of same) {
      expect(twice({ kind, ref: a }, { kind, ref: b }), `${kind}: ${JSON.stringify(a)} and ${JSON.stringify(b)}`).toMatch(/both cite.*rule 3/);
    }
    const different: Array<[string, string, string]> = [
      ['commit', 'a1b2c3d', 'b1b2c3d'],
      ['file', 'src/retry.ts:10', 'src/retry.ts:12'],
      ['file', 'src/retry.ts', 'lib/src/retry.ts'],
      ['test', 'retry budget', 'Retry budget'],
      // U+FEFF is not White_Space, so it is not trimmed
      ['wiki', '01J9ABC', '01J9ABC\ufeff'],
    ];
    for (const [kind, a, b] of different) {
      expect(twice({ kind, ref: a }, { kind, ref: b }), `${kind}: ${JSON.stringify(a)} and ${JSON.stringify(b)}`).not.toMatch(/both cite/);
    }
  });

  it('rule 4: every member and the line within 15 minutes of each other', () => {
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: at(15 * MIN) })], ts: at(15 * MIN) }))).toEqual([]);
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: at(15 * MIN + 1) })], ts: at(15 * MIN + 1) })).join()).toMatch(
      /more than 15 minutes.*rule 4/
    );
    // The line's own ts counts too
    expect(checkQuorum(addendum({ ts: at(20 * MIN) })).join()).toMatch(/rule 4/);
    // To the millisecond: digits past the third fractional digit are dropped, not rounded
    const subMs = '2026-09-01T12:15:00.0009Z';
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: subMs })], ts: subMs }))).toEqual([]);
    const pastEdge = '2026-09-01T12:15:00.001Z';
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: pastEdge })], ts: pastEdge })).join()).toMatch(/900001 ms.*rule 4/);
  });

  it('rule 5: agreeing — every verdict is the one the link applies, and a quorum never overrides', () => {
    expect(checkQuorum(addendum({ quorum: [member(), second({ verdict: 'refuted' })] })).join()).toMatch(/verdict refuted.*verifies.*rule 5/);
    expect(checkQuorum(addendum(linked('refutes'))).join()).toMatch(/rule 5/);
    expect(checkQuorum(addendum(linked('verifies', 'overrides'))).join()).toMatch(/never overrides.*rule 5/);
    // A line that lists no resolution link (no x-steno.links, an empty list, or only types the reader doesn't
    // know) is checked for agreeing verdicts only
    for (const xSteno of [undefined, {}, { links: [] }, linked('corroborates')['x-steno']]) {
      const subject = { ...addendum(), 'x-steno': xSteno };
      expect(checkQuorum(subject), JSON.stringify(xSteno)).toEqual([]);
      expect(checkQuorum({ ...subject, quorum: [member(), second({ verdict: 'refuted' })] }).join(), JSON.stringify(xSteno)).toMatch(/disagree.*rule 5/);
    }
  });

  it("rule 5 reads an ADDENDUM's links from x-steno.links: those it writes", () => {
    const line = addendum({ quorum: [member({ verdict: 'refuted' }), second({ verdict: 'refuted' })] });
    const refutes = { ...line, 'x-steno': { links: [{ fromId: 'ADD1', toId: 'UV1', type: 'refutes' }] } };
    expect(checkQuorum(refutes)).toEqual([]);
    const verifies = { ...refutes, 'x-steno': { links: [{ fromId: 'ADD1', toId: 'UV1', type: 'verifies' }] } };
    expect(checkQuorum(verifies).join()).toMatch(/verdict refuted.*verifies.*rule 5/);
    // A link that starts at another entry is not one this line writes
    expect(checkQuorum({ ...refutes, 'x-steno': { links: [{ fromId: 'ADD2', toId: 'UV1', type: 'verifies' }] } })).toEqual([]);
  });

  it('rule 5: a quorum TB carries the literals its members agreed on (at least one)', () => {
    const { verdict: _a, ...a } = member();
    const { verdict: _b, ...b } = second();
    const tb = { type: 'TB', author: AGENT, signedBy: AGENT, ts: at(5 * MIN), evidence: [...a.evidence, ...b.evidence], quorum: [a, b] };
    expect(checkQuorum(tb).join()).toMatch(/literals.*rule 5/);
    expect(checkQuorum({ ...tb, literals: [] }).join()).toMatch(/literals.*rule 5/);
    expect(checkQuorum({ ...tb, literals: LITERALS })).toEqual([]);
  });

  it('rule 6: the line shows its evidence — the members\' items, and only theirs', () => {
    expect(checkQuorum(addendum({ evidence: [{ kind: 'commit', ref: 'a1b2c3' }] })).join()).toMatch(/lacks quorum member 2's file config\.ts:3.*rule 6/);
    const extra = [{ kind: 'commit', ref: 'a1b2c3' }, { kind: 'file', ref: 'config.ts:3' }, { kind: 'test', ref: 't' }];
    expect(checkQuorum(addendum({ evidence: extra })).join()).toMatch(/test t, which no quorum member cites.*rule 6/);
  });

  it('appears only on a TB or an ADDENDUM', () => {
    expect(checkQuorum({ ...addendum(), type: 'UV' }).join()).toMatch(/only on TB and ADDENDUM lines/);
  });
});

// ─────────────────────────────────────────────────────────────
// The ledger enforces it, not just the MCP boundary
// ─────────────────────────────────────────────────────────────

describe('the ledger: an agent settles only with a quorum, and never overrides, strikes or rules', () => {
  const fresh = (opts?: ConstructorParameters<typeof TruthLedger>[1]) => new TruthLedger(new Database(':memory:'), opts);
  const personTb = (l: TruthLedger) =>
    l.assertTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], signedBy: 'kim', literals: LITERALS }, { author: 'kim' });
  const personUv = (l: TruthLedger, contests?: string) =>
    l.assertUv(
      { assertion: 'LOG_BUDGET is still 30 in production.', basis: 'a dashboard', verifyBy: { kind: 'inspect', value: 'deploy/prod.env' }, contests },
      { author: 'sam' }
    );
  const quorum = (verdict?: 'verified' | 'refuted', over: Array<Partial<QuorumMember>> = [{}, {}]): QuorumMember[] => {
    const base: QuorumMember[] = [
      { author: AGENT, agentSessionId: 'sess-a', ts: at(0), evidence: [COMMIT] },
      { author: AGENT, agentSessionId: 'sess-b', ts: at(MIN), evidence: [FILE] },
    ];
    return base.map((m, i) => ({ ...m, ...(verdict ? { verdict } : {}), ...over[i] }));
  };

  it('refuses an agent signing a TB, resolving a UV, overriding, striking or ruling on its own', () => {
    const l = fresh();
    const tb = personTb(l);
    const uv = personUv(l);
    const draft = l.draftTombstone({ claim: 'fetchV1 is dead', evidence: [COMMIT], literals: [{ dead: 'fetchV1' }] }, { author: AGENT, agentSessionId: 'sess-a' });
    const before = l.getChainedRecords().length;

    expect(() => l.assertTombstone({ claim: 'fetchV1 is dead', evidence: [COMMIT], signedBy: AGENT }, { author: AGENT })).toThrow(/quorum/);
    expect(() => l.signProposal(draft.id, 'agent:other', undefined, { notarized: true })).toThrow(/quorum/);
    expect(() => l.resolveUv(uv.id, 'verified', [COMMIT, FILE], { author: AGENT, agentSessionId: 'sess-a' })).toThrow(/quorum/);
    expect(() => l.resolveUv(uv.id, 'refuted', [COMMIT], { author: AGENT, agentSessionId: 'sess-a' })).toThrow(/quorum/);
    expect(() => l.overrideTombstone(tb.id, { evidence: [COMMIT] }, { author: AGENT })).toThrow(/person/);
    for (const kind of ['strike', 'promotion', 'contempt'] as const) {
      expect(() => l.fileRuling({ kind, opinion: 'it is wrong', target: tb.id }, { author: AGENT }), kind).toThrow(/person/);
    }
    expect(() => l.dismissProposal(draft.id, AGENT, 'not needed')).toThrow(/person/);
    expect(() => l.fileObjectionRuling({ objectionId: 'obj-1', tbId: tb.id, outcome: 'overruled', opinion: 'fine' }, { author: AGENT })).toThrow(/person/);

    expect(l.getChainedRecords()).toHaveLength(before);
    expect((l.getEntry(tb.id) as TbEntry).body.status).toBe('active');
    expect((l.getEntry(uv.id) as UvEntry).body.status).toBe('open');
    // A person still acts alone
    expect(l.resolveUv(uv.id, 'verified', [COMMIT], { author: 'alex' }).uv.body.status).toBe('verified');
    expect(l.fileRuling({ kind: 'strike', opinion: 'abandoned branch', target: tb.id }, { author: 'johnnyclem' }).ruling.type).toBe('RULING');
  });

  it('takes who is an agent from an injected classifier (default: the agent: prefix)', () => {
    const l = fresh({ isAgent: (id) => id === 'bot-7' });
    expect(l.isAgent('bot-7')).toBe(true);
    expect(l.isAgent(AGENT)).toBe(false);
    expect(() => l.assertTombstone({ claim: 'fetchV1 is dead', evidence: [COMMIT], signedBy: 'bot-7' }, { author: 'bot-7' })).toThrow(/quorum/);
    expect(l.assertTombstone({ claim: 'fetchV1 is dead', evidence: [COMMIT], signedBy: AGENT }, { author: AGENT }).type).toBe('TB');
    const byPrefix = fresh();
    expect(byPrefix.isAgent(' Agent:Claude-Code ')).toBe(true);
    expect(byPrefix.isAgent('kim')).toBe(false);
  });

  it('settles a UV by quorum, and refuses a quorum that breaks a rule', () => {
    const l = fresh();
    const uv = personUv(l);
    // One member, a shared session, one settling kind: each refused by admission
    expect(() => l.resolveUvByQuorum(uv.id, 'verified', quorum('verified').slice(0, 1), { author: AGENT, agentSessionId: 'sess-a', timestamp: at(MIN) })).toThrow(/rule 1/);
    expect(() =>
      l.resolveUvByQuorum(uv.id, 'verified', quorum('verified', [{}, { agentSessionId: 'sess-a' }]), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) })
    ).toThrow(/rule 1/);
    expect(() =>
      l.resolveUvByQuorum(uv.id, 'verified', quorum('verified', [{}, { evidence: [{ kind: 'commit', ref: 'ffff' }] }]), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) })
    ).toThrow(/rule 3/);
    expect(() => l.resolveUvByQuorum(uv.id, 'verified', quorum('verified'), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(20 * MIN) })).toThrow(/rule 4/);
    expect(() => l.resolveUvByQuorum(uv.id, 'verified', quorum('refuted'), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) })).toThrow(/rule 5/);
    expect((l.getEntry(uv.id) as UvEntry).body.status).toBe('open');

    const { addendum, uv: settled } = l.resolveUvByQuorum(uv.id, 'verified', quorum('verified'), {
      author: AGENT,
      agentSessionId: 'sess-b',
      timestamp: at(MIN),
      opinion: 'config.ts says 100',
    });
    expect(settled.body.status).toBe('verified');
    expect(addendum.body).toEqual({
      evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }, FILE],
      note: 'config.ts says 100',
      quorum: quorum('verified'),
    });
    expect(l.verify().ok).toBe(true);
  });

  it('a quorum never overrides a TB, and every member meets the contempt rule', () => {
    const l = fresh();
    const tb = personTb(l);
    const contest = personUv(l, tb.id);
    expect(() => l.resolveUvByQuorum(contest.id, 'verified', quorum('verified'), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) })).toThrow(/person/);
    expect((l.getEntry(tb.id) as TbEntry).body.status).toBe('contested');

    // A member who stands behind the UV (its author), or behind the contested TB when refuting it
    const uv = personUv(l);
    expect(() =>
      l.resolveUvByQuorum(uv.id, 'verified', quorum('verified', [{ author: 'sam' }, {}]), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) })
    ).toThrow(ContemptError);
    expect(() =>
      l.resolveUvByQuorum(contest.id, 'refuted', quorum('refuted', [{ author: 'kim' }, {}]), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) })
    ).toThrow(ContemptError);
    // Refuting a contest by quorum is settling a UV: the TB is active again
    l.resolveUvByQuorum(contest.id, 'refuted', quorum('refuted'), { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) });
    expect((l.getEntry(tb.id) as TbEntry).body.status).toBe('active');
  });

  it('a person\'s line may carry a quorum too, but never a broken one', () => {
    const l = fresh();
    const uv = personUv(l);
    expect(() => l.resolveUvByQuorum(uv.id, 'verified', quorum('verified'), { author: 'kim', agentSessionId: null, timestamp: at(MIN) })).toThrow(/not a quorum member.*rule 2/);
  });

  it('a quorum the ledger admits from an agent is all agents: a person\'s draft or verdict is no agent\'s second witness', () => {
    const l = fresh();
    const mine = l.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], literals: LITERALS }, { author: AGENT, agentSessionId: 'sess-a', timestamp: at(0) });
    const kims = l.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [FILE], literals: LITERALS }, { author: 'kim', agentSessionId: 'kim-laptop', timestamp: at(MIN) });
    expect(() => l.mintTombstoneByQuorum([mine.id, kims.id], { author: AGENT, agentSessionId: 'sess-a', timestamp: at(MIN) })).toThrow(/quorum member kim is not an agent/);
    const uv = personUv(l);
    expect(() =>
      l.resolveUvByQuorum(uv.id, 'verified', quorum('verified', [{}, { author: 'kim', agentSessionId: 'kim-laptop' }]), { author: AGENT, agentSessionId: 'sess-a', timestamp: at(MIN) })
    ).toThrow(/quorum member kim is not an agent/);
    expect(l.getStats().tombstones).toBe(0);
    expect((l.getEntry(uv.id) as UvEntry).body.status).toBe('open');
    for (const p of [mine, kims]) expect((l.getEntry(p.id) as ProposalEntry).body.status).toBe('open');
  });

  it('admission refuses a TB with a quorum but no literals: the agreement it certifies would name nothing', () => {
    const l = fresh();
    const members = quorum().map(({ verdict: _v, ...m }) => m);
    const tb = {
      id: '01J9QUORUMTBNOLITERALS0000',
      type: 'TB' as const,
      createdAt: at(MIN),
      author: AGENT,
      provenance: { kind: 'wiki' as const, ref: '01J9QUORUMTBNOLITERALS0000' },
      agentSessionId: 'sess-b',
      origin: 'wiki' as const,
      body: { claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT, FILE], signedBy: AGENT, quorum: members },
    };
    expect(() => l.importEntry(tb, [])).toThrow(/literals.*rule 5/);
    expect(l.importEntry({ ...tb, body: { ...tb.body, literals: LITERALS } }, [])).toBe('inserted');
  });

  it('an agent quorum never verifies a contest, by any path: that overrides the TB, which a person does', () => {
    const l = fresh();
    const tb = personTb(l);
    const contest = personUv(l, tb.id);
    const id = '01J9QUORUMVERIFIESCONTEST0';
    const verifying = {
      id,
      type: 'ADDENDUM' as const,
      createdAt: at(MIN),
      author: AGENT,
      provenance: { kind: 'wiki' as const, ref: id },
      agentSessionId: 'sess-b',
      origin: 'wiki' as const,
      body: { evidence: [COMMIT, FILE], note: null, quorum: quorum('verified') },
    };
    const outcome = l.importChange(verifying, [{ fromId: id, toId: contest.id, type: 'verifies' }]);
    expect(outcome).toMatchObject({ outcome: 'held' });
    expect((outcome as { reason: string }).reason).toMatch(/would override TB .*a person/);
    expect(l.getEntry(id)).toBeNull();
    expect((l.getEntry(contest.id) as UvEntry).body.status).toBe('open');
    expect((l.getEntry(tb.id) as TbEntry).body.status).toBe('contested');
    // ...while refuting the contest by quorum is settling a UV, which agents may do
    const refuting = { ...verifying, body: { ...verifying.body, quorum: quorum('refuted') } };
    expect(l.importChange(refuting, [{ fromId: id, toId: contest.id, type: 'refutes' }])).toEqual({ outcome: 'inserted' });
    expect((l.getEntry(tb.id) as TbEntry).body.status).toBe('active');
  });

  it('mints a TB from agent drafts that agree, signing each draft', () => {
    const l = fresh();
    const a = l.draftTombstone({ claim: 'LOG_BUDGET 30 is dead; it is 100.', evidence: [COMMIT], literals: LITERALS }, { author: AGENT, agentSessionId: 'sess-a', timestamp: at(0) });
    const b = l.draftTombstone(
      { claim: 'The 30 budget is gone.', evidence: [FILE], literals: [...LITERALS].reverse() },
      { author: AGENT, agentSessionId: 'sess-b', timestamp: at(2 * MIN) }
    );
    const other = l.draftTombstone({ claim: 'x', evidence: [TEST], literals: [{ dead: 'fetchV1' }] }, { author: AGENT, agentSessionId: 'sess-c', timestamp: at(2 * MIN) });
    expect(() => l.mintTombstoneByQuorum([a.id, other.id], { author: AGENT, agentSessionId: 'sess-c', timestamp: at(3 * MIN) })).toThrow(/literal/);
    expect(() => l.mintTombstoneByQuorum([a.id], { author: AGENT, agentSessionId: 'sess-a', timestamp: at(3 * MIN) })).toThrow(/rule 1/);

    const tb = l.mintTombstoneByQuorum([a.id, b.id], { author: AGENT, agentSessionId: 'sess-b', timestamp: at(3 * MIN) });
    expect(tb.author).toBe(AGENT);
    expect(tb.body).toMatchObject({
      claim: a.body.draft.claim,
      signedBy: AGENT,
      status: 'active',
      evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }, FILE],
      literals: LITERALS,
      quorum: [
        { author: AGENT, agentSessionId: 'sess-a', ts: at(0), evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }] },
        { author: AGENT, agentSessionId: 'sess-b', ts: at(2 * MIN), evidence: [FILE] },
      ],
    });
    expect(tb.links.filter((x) => x.type === 'signs').map((x) => x.toId).sort()).toEqual([a.id, b.id].sort());
    expect((l.getEntry(a.id) as ProposalEntry).body.status).toBe('signed');
    expect((l.getEntry(b.id) as ProposalEntry).body.status).toBe('signed');
    expect(l.verify().ok).toBe(true);
    // ...and the line it exports is one every reader accepts
    for (const line of exportWikiEntries(l).lines) expect(() => decodeWikiLine(line)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// MCP: resolve_uv attests; settles only together
// ─────────────────────────────────────────────────────────────

let dir: string | null = null;
let servers: StenographerServer[] = [];
let channel: Server | null = null;

afterEach(() => {
  for (const s of servers) s.engine.stop();
  servers = [];
  channel?.close();
  channel = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A stand-in smallchat channel bridge that records what it receives. */
async function startChannel(): Promise<{ url: string; events: any[] }> {
  const events: any[] = [];
  channel = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      events.push(JSON.parse(data));
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => channel!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(channel.address() as { port: number }).port}`, events };
}

/**
 * Agent-profile servers on one state file, one per session (a session is
 * its log's name), all under one agent identity, on one injected clock.
 */
async function sessions(names: string[], overrides: Partial<StenographerConfig> = {}) {
  dir ??= mkdtempSync(join(tmpdir(), 'steno-quorum-'));
  const clock = { now: T0 };
  const statePath = join(dir, 'state.db');
  const out: Record<string, { call: (tool: string, args: Record<string, unknown>) => Promise<any>; engine: StenographerServer['engine'] }> = {};
  for (const name of names) {
    writeFileSync(join(dir, `${name}.jsonl`), '');
    const server = new StenographerServer({
      logPath: join(dir, `${name}.jsonl`),
      statePath,
      mode: 'catchup',
      embeddingModel: 'hashed',
      agentIdentity: AGENT,
      clock: () => clock.now,
      ...overrides,
    });
    servers.push(server);
    await server.engine.start();
    out[name] = {
      call: (tool, args) => (server as unknown as { callTool: (n: string, a: Record<string, unknown>) => Promise<any> }).callTool(tool, args),
      engine: server.engine,
    };
  }
  const engine = out[names[0]].engine;
  const ledger = engine.store.truth;
  const uv = (contests?: string) =>
    engine.assertUv({ assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' }, contests, author: 'sam' });
  const personTb = async () => {
    const draft = ledger.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], literals: LITERALS }, { author: 'agent:setup' });
    return (await engine.notarizeProposal(draft.id, 'johnnyclem')) as TbEntry;
  };
  const addenda = () => ledger.getChainedRecords().filter((r) => r.type === 'ADDENDUM');
  return { s: out, clock, ledger, engine, uv, personTb, addenda };
}

const resolve = (uvId: string, resolution: 'verified' | 'refuted', evidence: unknown[], opinion?: string) => ({
  uvId,
  resolution,
  evidence,
  ...(opinion ? { opinion } : {}),
});

describe('resolve_uv: an agent attests; two sessions agreeing from different angles within 15 minutes settle', () => {
  it('two sessions with disjoint evidence of two kinds, within the window, settle the UV', async () => {
    const { s, clock, ledger, uv } = await sessions(['sess-a', 'sess-b']);
    const target = await uv();

    const first = await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    expect(first.status).toBe('attested');
    expect(first.quorum).toEqual({ agreeing: 1, needed: 2, windowEndsAt: at(15 * MIN), missing: ['another session'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');

    clock.now = T0 + 5 * MIN;
    const second = await s['sess-b'].call('resolve_uv', resolve(target.id, 'verified', [FILE], 'config.ts:3 says 100'));
    expect(second.status).toBe('settled');
    expect(second.uv.body.status).toBe('verified');
    const addendum = second.addendum as AddendumEntry;
    expect(addendum).toMatchObject({ author: AGENT, agentSessionId: 'sess-b', createdAt: at(5 * MIN) });
    expect(addendum.body).toEqual({
      evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }, FILE],
      note: 'config.ts:3 says 100',
      quorum: [
        { author: AGENT, agentSessionId: 'sess-a', ts: at(0), evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }], verdict: 'verified' },
        { author: AGENT, agentSessionId: 'sess-b', ts: at(5 * MIN), evidence: [FILE], verdict: 'verified' },
      ],
    });
    expect(addendum.links).toContainEqual({ fromId: addendum.id, toId: target.id, type: 'verifies' });
    expect(ledger.verify().ok).toBe(true);

    // The settlement travels: its line decodes, and a teammate's ledger applies it
    const { lines } = exportWikiEntries(ledger);
    for (const line of lines) expect(() => decodeWikiLine(line)).not.toThrow();
    const teammate = new TruthLedger(new Database(':memory:'));
    expect(importWikiEntries(teammate, { lines })).toMatchObject({ committed: true, held: [], proposals: [] });
    expect((teammate.getEntry(target.id) as UvEntry).body.status).toBe('verified');
  });

  it('one agent alone never settles, however much evidence it brings', async () => {
    const { s, ledger, uv, addenda } = await sessions(['sess-a']);
    const target = await uv();
    for (const evidence of [[COMMIT, FILE, TEST], [CLAIMED]]) {
      const res = await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', evidence));
      expect(res.status).toBe('attested');
      expect(res.quorum.missing).toEqual(['another session']);
    }
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');
    expect(addenda()).toEqual([]);
  });

  it('the same session twice is one witness, even from two servers on one log', async () => {
    const { s, clock, ledger, uv, addenda } = await sessions(['sess-a']);
    const twin = await sessions(['sess-a']);
    const target = await uv();
    await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    clock.now = twin.clock.now = T0 + MIN;
    const again = await twin.s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [FILE]));
    expect(again.status).toBe('attested');
    expect(again.quorum).toMatchObject({ agreeing: 1, missing: ['another session'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');
    expect(addenda()).toEqual([]);
  });

  it('one connection is one witness, whichever session its log names later', async () => {
    dir ??= mkdtempSync(join(tmpdir(), 'steno-quorum-'));
    const log = join(dir, 'transcript.jsonl');
    const line = (uuid: string, sessionId: string) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'check the budget' }] },
        uuid,
        timestamp: '2026-09-01T12:00:00Z',
        sessionId,
      }) + '\n';
    writeFileSync(log, line('u-1', 'conv-1'));
    const clock = { now: T0 };
    const server = new StenographerServer({
      logPath: log,
      statePath: join(dir, 'live.db'),
      mode: 'live',
      adapter: 'claude-code',
      embeddingModel: 'hashed',
      agentIdentity: AGENT,
      clock: () => clock.now,
    });
    servers.push(server);
    const engine = server.engine;
    await engine.start();
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) {
        await new Promise((r) => setTimeout(r, 30));
        await engine.flush();
      }
    };
    await until(() => engine.getSessionId() === 'conv-1');
    const call = (tool: string, a: Record<string, unknown>) =>
      (server as unknown as { callTool: (n: string, a: Record<string, unknown>) => Promise<any> }).callTool(tool, a);
    const target = await engine.assertUv({ assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' }, author: 'sam' });
    const first = await call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    expect(first.attestation.agentSessionId).toBe('conv-1');

    // The log the server follows names another session (a resumed transcript, a log that aggregates sessions)
    appendFileSync(log, line('u-2', 'conv-2'));
    await until(() => engine.getSessionId() === 'conv-2');
    expect(engine.getSessionId()).toBe('conv-2');
    clock.now = T0 + MIN;
    const again = await call('resolve_uv', resolve(target.id, 'verified', [FILE]));
    expect(again.status).toBe('attested');
    expect(again.attestation.agentSessionId).toBe('conv-1');
    expect((engine.store.truth.getEntry(target.id) as UvEntry).body.status).toBe('open');
  });

  it('shared evidence is one angle: the items compare by kind and trimmed ref', async () => {
    const { s, ledger, uv } = await sessions(['sess-a', 'sess-b']);
    const target = await uv();
    await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    const res = await s['sess-b'].call('resolve_uv', resolve(target.id, 'verified', [{ kind: 'commit', ref: ' a1b2c3 ' }, FILE]));
    expect(res.status).toBe('attested');
    expect(res.quorum).toMatchObject({ agreeing: 2, missing: ['other evidence'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');
  });

  it('one settling kind is one angle', async () => {
    const { s, ledger, uv } = await sessions(['sess-a', 'sess-b']);
    const target = await uv();
    await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    const res = await s['sess-b'].call('resolve_uv', resolve(target.id, 'verified', [{ kind: 'commit', ref: 'd4e5f6' }]));
    expect(res.status).toBe('attested');
    expect(res.quorum).toMatchObject({ agreeing: 2, missing: ['a second evidence kind'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');
  });

  it('the same evidence spelled another way is one angle: a commit in upper case, a path with ./', async () => {
    const { s, clock, ledger, uv } = await sessions(['sess-a', 'sess-b']);
    const target = await uv();
    await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [{ kind: 'commit', ref: 'a1b2c3d' }, { kind: 'file', ref: 'src/retry.ts:10' }]));
    clock.now = T0 + MIN;
    const res = await s['sess-b'].call('resolve_uv', resolve(target.id, 'verified', [{ kind: 'commit', ref: 'A1B2C3D' }, { kind: 'file', ref: './src/retry.ts:10' }]));
    expect(res.status).toBe('attested');
    expect(res.quorum).toMatchObject({ agreeing: 2, missing: ['other evidence'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');
  });

  it('progress counts only the sessions that could join a quorum, and tells a verdict without settling evidence what to do', async () => {
    const { s, clock, uv } = await sessions(['sess-a', 'sess-b']);
    const target = await uv();
    const said = await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [{ kind: 'message', ref: 'msg_0042' }]));
    expect(said.status).toBe('attested');
    expect(said.quorum).toMatchObject({ agreeing: 0, missing: ['a settling evidence item', 'another session'] });
    expect(said.detail).toMatch(/can't count toward a quorum/);
    expect(said.detail).toMatch(/commit, file, test, claimed-command or wiki/);
    expect(said.detail).not.toMatch(/settles when another agent session agrees/);
    clock.now = T0 + MIN;
    const checked = await s['sess-b'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT, FILE]));
    expect(checked.status).toBe('attested');
    // sess-a's message-only verdict is no partner: one session could join a quorum, and it needs another
    expect(checked.quorum).toMatchObject({ agreeing: 1, needed: 2, missing: ['another session'] });
    expect(checked.detail).toMatch(/settles when another agent session agrees/);
  });

  it('question-class evidence settles nothing: what someone said or wrote down is not a check', async () => {
    const { s, clock, ledger, uv } = await sessions(['sess-a', 'sess-b', 'sess-c']);
    const target = await uv();
    const said = [
      { kind: 'message', ref: 'msg_0042' },
      { kind: 'chat', ref: 'slack:C01/p1700000000' },
      { kind: 'ticket', ref: 'LIN-123' },
      { kind: 'doc', ref: 'https://wiki.example/budget' },
    ];
    const a = await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', said.slice(0, 2)));
    expect(a.quorum.missing).toEqual(['a settling evidence item', 'another session']);
    const b = await s['sess-b'].call('resolve_uv', resolve(target.id, 'verified', said.slice(2)));
    expect(b.status).toBe('attested');
    // Neither can join a quorum, so neither counts as agreeing
    expect(b.quorum).toMatchObject({ agreeing: 0, missing: ['a settling evidence item', 'another session'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');

    // ...and doesn't count toward a quorum: the next settling attestation still needs a partner
    clock.now = T0 + MIN;
    const c = await s['sess-c'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    expect(c.status).toBe('attested');
    expect(c.quorum).toMatchObject({ agreeing: 1, missing: ['another session'] });
  });

  it('outside the 15-minute window, no quorum forms; at its edge, one does', async () => {
    const { s, clock, ledger, uv } = await sessions(['sess-a', 'sess-b']);
    const late = await uv();
    await s['sess-a'].call('resolve_uv', resolve(late.id, 'verified', [COMMIT]));
    clock.now = T0 + QUORUM_WINDOW_MS + 1;
    const res = await s['sess-b'].call('resolve_uv', resolve(late.id, 'verified', [FILE]));
    expect(res.status).toBe('attested');
    expect(res.quorum).toMatchObject({ agreeing: 1, missing: ['another session'] });
    expect((ledger.getEntry(late.id) as UvEntry).body.status).toBe('open');

    const edge = await uv();
    clock.now = T0;
    await s['sess-a'].call('resolve_uv', resolve(edge.id, 'verified', [COMMIT]));
    clock.now = T0 + QUORUM_WINDOW_MS;
    expect((await s['sess-b'].call('resolve_uv', resolve(edge.id, 'verified', [FILE]))).status).toBe('settled');
  });

  it('dissent: no quorum forms while the other verdict stands, and a person hears of it once', async () => {
    const { url, events } = await startChannel();
    const { s, clock, ledger, uv } = await sessions(['sess-a', 'sess-b', 'sess-c', 'sess-d'], {
      objectionSinks: [{ kind: 'channel', url }],
    });
    const target = await uv();
    await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    clock.now = T0 + MIN;
    const b = await s['sess-b'].call('resolve_uv', resolve(target.id, 'refuted', [FILE]));
    expect(b.status).toBe('disputed');
    expect(b.dissent).toEqual([{ author: AGENT, agentSessionId: 'sess-a', resolution: 'verified', createdAt: at(0) }]);
    expect(b.raisedTo).toEqual([url]);
    expect(events).toHaveLength(1);
    expect(events[0].meta).toMatchObject({ kind: 'uv_dispute', uv_id: target.id });
    expect(events[0].content).toContain(target.body.assertion);

    // Two refutations from different angles, but sess-a's verification stands within the window
    clock.now = T0 + 2 * MIN;
    const c = await s['sess-c'].call('resolve_uv', resolve(target.id, 'refuted', [TEST]));
    expect(c.status).toBe('disputed');
    expect(c.raisedTo).toEqual([]);
    expect(events).toHaveLength(1);
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');

    // Once it has left the window, agreeing sessions within it settle
    clock.now = T0 + 17 * MIN;
    const d = await s['sess-d'].call('resolve_uv', resolve(target.id, 'refuted', [CLAIMED]));
    expect(d.status).toBe('settled');
    expect(d.uv.body.status).toBe('refuted');
    expect((d.addendum as AddendumEntry).body.quorum!.map((m) => m.agentSessionId)).toEqual(['sess-c', 'sess-d']);
  });

  it('a contest verified by a quorum stays a standing verdict: refutations within the window are a dispute, not a settlement', async () => {
    const { s, clock, ledger, uv, personTb, addenda } = await sessions(['sess-a', 'sess-b', 'sess-c', 'sess-d']);
    const tb = await personTb();
    const contest = await uv(tb.id);
    await s['sess-a'].call('resolve_uv', resolve(contest.id, 'verified', [COMMIT]));
    clock.now = T0 + MIN;
    expect((await s['sess-b'].call('resolve_uv', resolve(contest.id, 'verified', [FILE]))).status).toBe('raised');
    // Two sessions now refute, from two other angles, while a person is asked to override
    clock.now = T0 + 2 * MIN;
    const c = await s['sess-c'].call('resolve_uv', resolve(contest.id, 'refuted', [TEST]));
    expect(c.status).toBe('disputed');
    expect(c.dissent.map((d: { agentSessionId: string }) => d.agentSessionId)).toEqual(['sess-a', 'sess-b']);
    clock.now = T0 + 3 * MIN;
    expect((await s['sess-d'].call('resolve_uv', resolve(contest.id, 'refuted', [CLAIMED]))).status).toBe('disputed');
    expect(addenda()).toEqual([]);
    expect((ledger.getEntry(contest.id) as UvEntry).body.status).toBe('open');
    expect((ledger.getEntry(tb.id) as TbEntry).body.status).toBe('contested');
  });

  it('one session reversing its own verdict within the window is a dispute too, and says so', async () => {
    const { s, clock, uv } = await sessions(['sess-a']);
    const target = await uv();
    await s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    clock.now = T0 + MIN;
    const back = await s['sess-a'].call('resolve_uv', resolve(target.id, 'refuted', [FILE]));
    expect(back.status).toBe('disputed');
    expect(back.dissent).toMatchObject([{ agentSessionId: 'sess-a', resolution: 'verified' }]);
    expect(back.detail).toMatch(/opposite verdicts/);
    expect(back.detail).toMatch(/this session's own/);
    expect(back.detail).not.toMatch(/agent sessions disagree/);
  });

  it('a verified contest is raised to a person: agents never override a TB', async () => {
    const { url, events } = await startChannel();
    const { s, clock, ledger, uv, personTb, addenda } = await sessions(['sess-a', 'sess-b', 'sess-c'], {
      objectionSinks: [{ kind: 'channel', url }],
    });
    const tb = await personTb();
    const contest = await uv(tb.id);
    await s['sess-a'].call('resolve_uv', resolve(contest.id, 'verified', [COMMIT]));
    clock.now = T0 + MIN;
    const raised = await s['sess-b'].call('resolve_uv', resolve(contest.id, 'verified', [FILE]));
    expect(raised.status).toBe('raised');
    expect(raised.detail).toMatch(new RegExp(`2 agent sessions verified this contest from different angles; overriding TB ${tb.id} needs a person`));
    expect(raised.raisedTo).toEqual([url]);
    expect(events).toHaveLength(1);
    expect(events[0].meta).toMatchObject({ kind: 'uv_contest_verified', uv_id: contest.id, tb_id: tb.id });

    expect(addenda()).toEqual([]);
    expect((ledger.getEntry(tb.id) as TbEntry).body.status).toBe('contested');
    expect((ledger.getEntry(contest.id) as UvEntry).body.status).toBe('open');

    // The raised attestations are spent: a third session starts over
    clock.now = T0 + 2 * MIN;
    const third = await s['sess-c'].call('resolve_uv', resolve(contest.id, 'verified', [TEST]));
    expect(third.status).toBe('attested');
    expect(third.quorum).toMatchObject({ agreeing: 1, missing: ['another session'] });
  });

  it('a refuted contest settles by quorum, and the TB is active again', async () => {
    const { s, clock, ledger, uv, personTb } = await sessions(['sess-a', 'sess-b']);
    const tb = await personTb();
    const contest = await uv(tb.id);
    await s['sess-a'].call('resolve_uv', resolve(contest.id, 'refuted', [COMMIT]));
    clock.now = T0 + MIN;
    const res = await s['sess-b'].call('resolve_uv', resolve(contest.id, 'refuted', [TEST]));
    expect(res.status).toBe('settled');
    expect((ledger.getEntry(tb.id) as TbEntry).body.status).toBe('active');
  });

  it('keeps the checks a resolution meets: an open UV, evidence, and contempt of corpus', async () => {
    const { s, engine, uv } = await sessions(['sess-a']);
    const target = await uv();
    await expect(s['sess-a'].call('resolve_uv', resolve('01NOSUCHUV0000000000000000', 'verified', [COMMIT]))).rejects.toThrow(/no such entry/);
    await expect(s['sess-a'].call('resolve_uv', resolve(target.id, 'verified', []))).rejects.toThrow(/evidence/);
    // The agent's own UV, from its own session: one opinion wearing two hats
    const own = await s['sess-a'].call('assert_uv', { assertion: 'The cache is shared.', basis: 'a trace', verifyBy: { kind: 'ask', value: 'ops' } });
    await expect(s['sess-a'].call('resolve_uv', resolve(own.id, 'verified', [COMMIT]))).rejects.toThrow(/contempt/);
    expect(engine.store.attestations.list(own.id)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// MCP: propose_tombstone settles by quorum
// ─────────────────────────────────────────────────────────────

describe('propose_tombstone: agent drafts that agree from different angles within 15 minutes mint a TB', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    claim: 'LOG_BUDGET 30 is dead; the budget is 100',
    evidence: [COMMIT],
    literals: LITERALS,
    ...over,
  });

  it('two sessions drafting the same literals with disjoint evidence of two kinds settle it', async () => {
    const { s, clock, ledger } = await sessions(['sess-a', 'sess-b']);
    const first = await s['sess-a'].call('propose_tombstone', draft({ rationale: 'config.ts was bumped' }));
    expect(first.status).toMatch(/awaiting notarization/);
    expect(first.quorum).toEqual({ agreeing: 1, needed: 2, windowEndsAt: at(15 * MIN), missing: ['another session'] });

    clock.now = T0 + 3 * MIN;
    // The same set of literals, in another order, with another claim
    const second = await s['sess-b'].call('propose_tombstone', draft({ claim: 'The old budget (30) is gone.', evidence: [FILE], literals: [...LITERALS].reverse() }));
    expect(second.status).toBe('settled by quorum');
    const tb = second.tombstone as TbEntry;
    expect(tb).toMatchObject({ type: 'TB', author: AGENT, agentSessionId: 'sess-b', createdAt: at(3 * MIN) });
    expect(tb.body).toMatchObject({
      claim: 'LOG_BUDGET 30 is dead; the budget is 100',
      signedBy: AGENT,
      status: 'active',
      literals: LITERALS,
      evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }, FILE],
      quorum: [
        { author: AGENT, agentSessionId: 'sess-a', ts: at(0), evidence: [{ kind: 'commit', ref: 'a1b2c3', detail: COMMIT.detail }] },
        { author: AGENT, agentSessionId: 'sess-b', ts: at(3 * MIN), evidence: [FILE] },
      ],
    });
    const signs = tb.links.filter((x) => x.type === 'signs').map((x) => x.toId);
    expect(signs.sort()).toEqual([first.proposal.id, second.proposal.id].sort());
    for (const id of signs) expect((ledger.getEntry(id) as ProposalEntry).body.status).toBe('signed');
    expect(ledger.getMatchableTombstones().map((t) => t.id)).toContain(tb.id);
    expect(ledger.verify().ok).toBe(true);

    // It travels as an agent-signed TB with a quorum, which a teammate takes as truth
    const teammate = new TruthLedger(new Database(':memory:'));
    const { lines } = exportWikiEntries(ledger);
    expect(importWikiEntries(teammate, { lines })).toMatchObject({ committed: true, proposals: [] });
    expect((teammate.getEntry(tb.id) as TbEntry).body.status).toBe('active');
  });

  it('one agent alone never settles: its drafts wait for a person', async () => {
    const { s, clock, ledger } = await sessions(['sess-a']);
    const a = await s['sess-a'].call('propose_tombstone', draft({ targetRef: 'budget-1' }));
    clock.now = T0 + MIN;
    const b = await s['sess-a'].call('propose_tombstone', draft({ targetRef: 'budget-2', evidence: [FILE] }));
    expect(b.status).toMatch(/awaiting notarization/);
    expect(b.quorum).toMatchObject({ agreeing: 1, missing: ['another session'] });
    expect(ledger.getStats().tombstones).toBe(0);
    for (const p of [a.proposal, b.proposal]) expect((ledger.getEntry(p.id) as ProposalEntry).body.status).toBe('open');
  });

  it('drafts of different literals, outside the window, or from one angle do not agree', async () => {
    const { s, clock, ledger } = await sessions(['sess-a', 'sess-b']);
    await s['sess-a'].call('propose_tombstone', draft());
    const otherSet = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE], literals: [LITERALS[0]] }));
    expect(otherSet.quorum).toMatchObject({ agreeing: 1, missing: ['another session'] });
    const oneKind = await s['sess-b'].call('propose_tombstone', draft({ evidence: [{ kind: 'commit', ref: 'd4e5f6' }], targetRef: 'k' }));
    expect(oneKind.quorum).toMatchObject({ agreeing: 2, missing: ['a second evidence kind'] });
    clock.now = T0 + QUORUM_WINDOW_MS + 1;
    const late = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE], targetRef: 'late' }));
    expect(late.status).toMatch(/awaiting notarization/);
    expect(ledger.getStats().tombstones).toBe(0);
  });

  it('a draft without literals or settling evidence can\'t settle', async () => {
    const { s } = await sessions(['sess-a']);
    const bare = await s['sess-a'].call('propose_tombstone', { claim: 'fetchV1 is dead', evidence: [{ kind: 'chat', ref: 'slack:C01' }] });
    expect(bare.quorum.missing).toEqual(['literals', 'a settling evidence item', 'another session']);
    expect(bare.quorum.agreeing).toBe(0);
    // ...and says what it lacks
    expect(bare.status).toMatch(/can't count toward a quorum/);
    expect(bare.status).toMatch(/literals/);
    expect(bare.status).toMatch(/commit, file, test, claimed-command or wiki/);
  });

  it('mints nothing when an active TB already holds every literal', async () => {
    const { s, clock, ledger, personTb } = await sessions(['sess-a', 'sess-b']);
    const tb = await personTb();
    await s['sess-a'].call('propose_tombstone', draft());
    clock.now = T0 + MIN;
    const res = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE], literals: [LITERALS[1]] }));
    // A subset of the held TB's literals: already truth, and the result says so rather than wait for a quorum
    expect(res.status).toMatch(new RegExp(`already truth: TB ${tb.id} holds every literal`));
    expect(res.status).not.toMatch(/until a person signs it or a quorum/);
    const again = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE], targetRef: 'again' }));
    expect(again.status).toMatch(new RegExp(`already truth: TB ${tb.id} holds every literal`));
    expect(again.quorum).toMatchObject({ heldBy: tb.id, missing: [] });
    expect(ledger.getStats().tombstones).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// MCP surface: what agents are told, and what they can't do
// ─────────────────────────────────────────────────────────────

describe('the agent profile', () => {
  it('tells the agent its confidence settles nothing, in its initialize instructions', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-quorum-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    const server = new StenographerServer({ logPath: join(dir, 'log.jsonl'), statePath: ':memory:', mode: 'catchup', embeddingModel: 'hashed' });
    servers.push(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(clientSide);
    expect(client.getInstructions()).toContain(
      'Your confidence is not evidence and settles nothing. On your own you can only attest: a claim settles when two or ' +
        'more agent sessions agree from different angles within 15 minutes, or when a person signs. Agents never override ' +
        'or strike a tombstone.'
    );
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('assert_tombstone');
    expect(Object.keys(tools.find((t) => t.name === 'resolve_uv')!.inputSchema.properties ?? {}).sort()).toEqual(['evidence', 'opinion', 'resolution', 'uvId']);
    const description = (name: string) => tools.find((t) => t.name === name)!.description!;
    // Each draft must bring settling evidence of its own; a held claim mints nothing
    expect(description('propose_tombstone')).toMatch(/Each draft must cite settling evidence of its own/);
    expect(description('propose_tombstone')).toMatch(/already truth/);
    // An override is never undone, by a refuted contest either
    expect(description('resolve_uv')).toMatch(/active again unless another contest is open or it has been overridden \(an override is never undone\)/);
    const res = (await client.callTool({ name: 'assert_tombstone', arguments: { claim: 'x', evidence: [COMMIT] } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/propose_tombstone.*two or more agent sessions/);
  });

  it('the operator profile\'s import_wiki_entries says an agent\'s line lands only with a quorum of agents', async () => {
    dir ??= mkdtempSync(join(tmpdir(), 'steno-quorum-'));
    writeFileSync(join(dir, 'op.jsonl'), '');
    const server = new StenographerServer({ logPath: join(dir, 'op.jsonl'), statePath: ':memory:', mode: 'catchup', embeddingModel: 'hashed', profile: 'operator' });
    servers.push(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'notary-ui', version: '1.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const text = tools.find((t) => t.name === 'import_wiki_entries')!.description!;
    expect(text).toMatch(/when an agent signed it, with a valid quorum of agents/);
    expect(text).toMatch(/agent-without-quorum/);
    expect(text).toMatch(/an override, strike or ruling never applies from an agent/);
  });

  it('ships the consumption rule that says a verdict settles only with another session, or a person', () => {
    expect(CONSUMPTION_RULES).toContain(
      'If your current task can check the UV, file your verdict and evidence with resolve_uv: it settles only when another ' +
        'agent session agrees from a different angle (other evidence, another kind) within 15 minutes, or when a person rules.'
    );
    expect(CONSUMPTION_RULES).not.toMatch(/settle the UV cheaply/);
  });
});

describe('--allow-agent-assert is removed', () => {
  it('refuses the flag at startup, saying how agents settle claims now', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errors: string[] = [];
    const log = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
    try {
      await expect(runCLI(['--allow-agent-assert', '/nonexistent/log.jsonl', ':memory:'])).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
    const said = errors.join('\n');
    expect(said).toMatch(/--allow-agent-assert was removed/);
    expect(said).toMatch(/two or more agent sessions agreeing from different angles within 15 minutes, or a person signs/);
    expect(said).toMatch(/MIGRATION/);
  });

  it('refuses the old config option too, on the server and on the engine a library caller builds', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-quorum-'));
    expect(
      () =>
        new StenographerServer({ logPath: join(dir!, 'log.jsonl'), statePath: ':memory:', mode: 'catchup', allowAgentAssert: true } as StenographerConfig)
    ).toThrow(/allowAgentAssert was removed/);
    expect(
      () => new Stenographer({ logPath: join(dir!, 'log.jsonl'), statePath: ':memory:', mode: 'catchup', embeddingModel: 'hashed', allowAgentAssert: true } as StenographerConfig)
    ).toThrow(/allowAgentAssert was removed/);
  });
});

// ─────────────────────────────────────────────────────────────
// Concurrency: the window reads the clock under the write lock
// ─────────────────────────────────────────────────────────────

describe('attestations from several processes on one state file', () => {
  it('a verdict whose clock was read before another session\'s opposite verdict committed still sees it as dissent', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-quorum-'));
    const path = join(dir, 'state.db');
    const one = new StateStore(path);
    const two = new StateStore(path);
    try {
      const uv = one.truth.assertUv(
        { assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' } },
        { author: 'sam' }
      );
      const attest = (store: StateStore, agentSessionId: string, resolution: 'verified' | 'refuted', evidence: typeof COMMIT[], now: number) =>
        store.attestations.attest({ uvId: uv.id, resolution, evidence, author: AGENT, agentSessionId }, now);
      expect(attest(one, 'sess-a', 'verified', [COMMIT], T0).status).toBe('attested');
      // sess-b read its clock later than sess-c, but took the write lock first
      expect(attest(two, 'sess-b', 'refuted', [FILE], T0 + MIN + 1).status).toBe('disputed');
      // sess-c's clock reads before sess-b's verdict: it stands all the same, so no quorum forms
      expect(attest(one, 'sess-c', 'verified', [TEST], T0 + MIN).status).toBe('disputed');
      expect((two.truth.getEntry(uv.id) as UvEntry).body.status).toBe('open');
    } finally {
      one.close();
      two.close();
    }
  });

  it('reads the clock inside the write transaction, for attestations and for drafts', () => {
    const store = new StateStore(':memory:');
    try {
      const db = (store as unknown as { db: Database.Database }).db;
      const read: boolean[] = [];
      const clock = (at: number) => () => {
        read.push(db.inTransaction);
        return at;
      };
      const uv = store.truth.assertUv(
        { assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' } },
        { author: 'sam' }
      );
      store.attestations.attest({ uvId: uv.id, resolution: 'verified', evidence: [COMMIT], author: AGENT, agentSessionId: 'sess-a' }, clock(T0));
      const draft = store.truth.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], literals: LITERALS }, { author: AGENT, agentSessionId: 'sess-a', timestamp: at(0) });
      settleTombstoneQuorum(store.truth, draft, { author: AGENT, agentSessionId: 'sess-a', now: clock(T0) });
      expect(read).toEqual([true, true]);
    } finally {
      store.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Import: the same rules for lines another ledger wrote
// ─────────────────────────────────────────────────────────────

describe('wiki import: agent lines land only with a valid quorum of agents', () => {
  const REGISTRY = {
    signers: [
      { id: 'kim', role: 'human' },
      { id: 'sam', role: 'human' },
      { id: 'johnnyclem', role: 'human' },
      { id: 'agent:*', role: 'agent' },
    ],
  };
  /** Chains lines into one stream, as a writer would. */
  const stream = (bodies: Array<Record<string, unknown>>): string[] => {
    let prev: string | null = null;
    return bodies.map((body, i) => {
      const { schemaVersion: _v, seq: _s, prevHash: _p, hash: _h, ...rest } = body;
      const unhashed = { schemaVersion: 2, seq: i + 1, ...rest, prevHash: prev };
      const hash = wikiLineHash(unhashed);
      prev = hash;
      return JSON.stringify({ ...unhashed, hash });
    });
  };
  const parse = (l: string) => JSON.parse(l) as Record<string, any>;

  /** A writer's ledger: a quorum TB, and a UV settled by quorum. */
  function writer() {
    const l = new TruthLedger(new Database(':memory:'));
    const a = l.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], literals: LITERALS }, { author: AGENT, agentSessionId: 'sess-a', timestamp: at(0) });
    const b = l.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [FILE], literals: LITERALS }, { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) });
    const tb = l.mintTombstoneByQuorum([a.id, b.id], { author: AGENT, agentSessionId: 'sess-b', timestamp: at(MIN) });
    // An agent's UV: its identity and its session stand behind it
    const uv = l.assertUv(
      { assertion: 'Retries are idempotent.', basis: 'the design doc', verifyBy: { kind: 'inspect', value: 'src/retry.ts' } },
      { author: 'agent:researcher', agentSessionId: 'sess-u', timestamp: at(2 * MIN) }
    );
    const members: QuorumMember[] = [
      { author: AGENT, agentSessionId: 'sess-a', ts: at(2 * MIN), evidence: [COMMIT], verdict: 'verified' },
      { author: AGENT, agentSessionId: 'sess-b', ts: at(3 * MIN), evidence: [TEST], verdict: 'verified' },
    ];
    const { addendum } = l.resolveUvByQuorum(uv.id, 'verified', members, { author: AGENT, agentSessionId: 'sess-b', timestamp: at(3 * MIN) });
    const lines = exportWikiEntries(l).lines.map(parse);
    return { lines, tb, uv, addendum };
  }

  it('takes an agent-signed TB with a valid quorum as truth, with or without a registry', () => {
    const { lines, tb } = writer();
    for (const signers of [null, SignerRegistry.load(REGISTRY)]) {
      const ledger = new TruthLedger(new Database(':memory:'));
      const result = importWikiEntries(ledger, { lines: lines.map((l) => JSON.stringify(l)) }, { signers });
      expect(result).toMatchObject({ committed: true, proposals: [], held: [] });
      expect((ledger.getEntry(tb.id) as TbEntry).body).toMatchObject({ status: 'active', quorum: (tb.body as TbEntry['body']).quorum });
    }
  });

  // A TB's members carry no verdict: only an ADDENDUM's do. On a TB member,
  // `verdict` is a field this version doesn't define, so whatever its value
  // the line is kept like one with any other unknown field (spec, Unknown
  // values). Admission held every member to an ADDENDUM's verdict enum, so a
  // file with `verdict: "bogus"` on a TB member rolled back whole.
  it('takes a quorum TB whose member carries a verdict, a field a TB member does not define, whatever its value', () => {
    const { lines, tb } = writer();
    const tbLine = lines.find((l) => l.id === tb.id)!;
    for (const verdict of ['bogus', 'verified', 7]) {
      const line = { ...tbLine, quorum: [{ ...tbLine.quorum[0], verdict }, tbLine.quorum[1]] };
      const [encoded] = stream([line]);
      expect(() => decodeWikiLine(encoded), String(verdict)).not.toThrow();
      for (const signers of [null, SignerRegistry.load(REGISTRY)]) {
        const ledger = new TruthLedger(new Database(':memory:'));
        const result = importWikiEntries(ledger, { lines: [encoded] }, { signers });
        expect(result, String(verdict)).toMatchObject({ committed: true, errors: [], proposals: [], held: [] });
        expect((ledger.getEntry(tb.id) as TbEntry).body).toMatchObject({ status: 'active', quorum: line.quorum });
        // Kept as it came, and exported again verbatim
        const exported = exportWikiEntries(ledger).lines.map(parse).find((l) => l.id === tb.id)!;
        expect(exported.quorum).toEqual(line.quorum);
      }
    }
  });

  it('files an agent-signed TB without a valid quorum of agents as a proposal', () => {
    const { lines, tb } = writer();
    const tbLine = lines.find((l) => l.id === tb.id)!;
    const { quorum: _q, ...noQuorum } = tbLine;
    const humanMember = { ...tbLine, quorum: [tbLine.quorum[0], { ...tbLine.quorum[1], author: 'kim' }] };
    for (const [line, why] of [
      [noQuorum, /no quorum/],
      [humanMember, /kim is not an agent/],
    ] as const) {
      for (const signers of [null, SignerRegistry.load(REGISTRY)]) {
        const ledger = new TruthLedger(new Database(':memory:'));
        const result = importWikiEntries(ledger, { lines: stream([line]) }, { signers });
        expect(result.committed).toBe(true);
        expect(result.proposals).toMatchObject([{ id: tb.id, reason: 'agent-without-quorum' }]);
        expect(result.proposals[0].detail).toMatch(why);
        expect(ledger.getEntry(tb.id)).toBeNull();
      }
    }
  });

  it('applies an agent\'s resolution only with a valid quorum of agents, each independent of the UV', () => {
    const { lines, uv, addendum } = writer();
    const uvLine = lines.find((l) => l.id === uv.id)!;
    const resolution = lines.find((l) => l.id === addendum.id)!;
    const run = (change: Record<string, unknown>, signers: SignerRegistry | null = null) => {
      const ledger = new TruthLedger(new Database(':memory:'));
      const result = importWikiEntries(ledger, { lines: stream([uvLine, change]) }, { signers });
      return { result, status: (ledger.getEntry(uv.id) as UvEntry).body.status };
    };
    expect(run(resolution)).toMatchObject({ result: { committed: true, held: [] }, status: 'verified' });
    expect(run(resolution, SignerRegistry.load(REGISTRY))).toMatchObject({ result: { committed: true, held: [] }, status: 'verified' });

    const { quorum: _q, ...noQuorum } = resolution;
    const byUvAuthor = { ...resolution, quorum: [{ ...resolution.quorum[0], author: 'agent:researcher' }, resolution.quorum[1]] };
    const bySession = { ...resolution, quorum: [{ ...resolution.quorum[0], agentSessionId: 'sess-u' }, resolution.quorum[1]] };
    const byPerson = { ...resolution, quorum: [{ ...resolution.quorum[0], author: 'kim' }, resolution.quorum[1]] };
    for (const [change, why] of [
      [noQuorum, /only with a quorum/],
      [byUvAuthor, /contempt of corpus.*agent:researcher/],
      [bySession, /contempt of corpus.*sess-u/],
      [byPerson, /kim is not an agent/],
    ] as const) {
      const { result, status } = run(change);
      expect(result.committed).toBe(true);
      expect(result.held, JSON.stringify(why)).toHaveLength(1);
      expect(result.held[0].reason).toMatch(why);
      expect(status).toBe('open');
    }
  });

  it('holds a resolution that fails the contempt rule, as Importing rule 6 says, rather than failing the file', () => {
    const l = new TruthLedger(new Database(':memory:'));
    const uv = l.assertUv({ assertion: 'Backups run nightly.', basis: 'the runbook', verifyBy: { kind: 'inspect', value: 'cron.d/backup' } }, { author: 'sam', timestamp: at(0) });
    l.resolveUv(uv.id, 'verified', [FILE], { author: 'alex', timestamp: at(MIN) });
    const lines = exportWikiEntries(l).lines.map(parse);
    // The UV's own author verifying it: one person corroborating themselves
    const self = lines.map((line) => (line.type === 'ADDENDUM' || line.type === 'TRANSITION' ? { ...line, author: 'sam' } : line));
    const ledger = new TruthLedger(new Database(':memory:'));
    const result = importWikiEntries(ledger, { lines: stream(self) });
    expect(result).toMatchObject({ committed: true, errors: [] });
    expect(result.held).toHaveLength(1);
    expect(result.held[0].reason).toMatch(/contempt of corpus.*sam/);
    expect((ledger.getEntry(uv.id) as UvEntry).body.status).toBe('open');
  });

  it('never applies an agent\'s override, strike or ruling, with or without a registry', () => {
    const l = new TruthLedger(new Database(':memory:'));
    const tb = l.assertTombstone({ claim: 'The cron box is gone.', evidence: [COMMIT], signedBy: 'kim' }, { author: 'kim', timestamp: at(0) });
    l.overrideTombstone(tb.id, { evidence: [FILE] }, { author: 'johnnyclem', timestamp: at(MIN) });
    l.fileRuling({ kind: 'strike', opinion: 'abandoned branch', target: tb.id }, { author: 'johnnyclem', timestamp: at(2 * MIN) });
    const lines = exportWikiEntries(l).lines.map(parse);
    const asAgent = lines.map((line) => (line.type === 'ADDENDUM' || line.type === 'RULING' || line.type === 'TRANSITION' ? { ...line, author: AGENT } : line));
    for (const signers of [null, SignerRegistry.load(REGISTRY)]) {
      const ledger = new TruthLedger(new Database(':memory:'));
      const result = importWikiEntries(ledger, { lines: stream(asAgent) }, { signers });
      expect(result.committed).toBe(true);
      expect(result.held.map((h) => parse(stream(asAgent)[h.line - 1]).type)).toEqual(['ADDENDUM', 'RULING']);
      expect((ledger.getEntry(tb.id) as TbEntry).body.status).toBe('active');
    }
  });

  it('holds an agent quorum that verifies a contest, with or without a registry: that would override the TB', () => {
    const l = new TruthLedger(new Database(':memory:'));
    const tb = l.assertTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], signedBy: 'kim', literals: LITERALS }, { author: 'kim', timestamp: at(0) });
    const contest = l.assertUv(
      { assertion: 'LOG_BUDGET went back to 30.', basis: 'the hotfix notes', verifyBy: { kind: 'inspect', value: 'config.ts' }, contests: tb.id },
      { author: 'sam', timestamp: at(MIN) }
    );
    const lines = exportWikiEntries(l).lines.map(parse);
    const id = '01J9QUORUMVERIFIESCONTEST0';
    const verifying = {
      id,
      type: 'ADDENDUM',
      ts: at(3 * MIN),
      author: AGENT,
      evidence: [FILE, TEST],
      note: null,
      quorum: [
        { author: AGENT, agentSessionId: 'sess-a', ts: at(2 * MIN), evidence: [FILE], verdict: 'verified' },
        { author: AGENT, agentSessionId: 'sess-b', ts: at(3 * MIN), evidence: [TEST], verdict: 'verified' },
      ],
      'x-steno': { agentSessionId: 'sess-b', links: [{ fromId: id, toId: contest.id, type: 'verifies' }] },
    };
    // The writer's TRANSITIONs after it, as a writer that let agents override would send them
    const transitions = [
      { id: `${id}:${contest.id}`, type: 'TRANSITION', ts: at(3 * MIN), author: AGENT, target: contest.id, status: 'verified', cause: { kind: 'verify', ref: id } },
      { id: `${id}:${tb.id}`, type: 'TRANSITION', ts: at(3 * MIN), author: AGENT, target: tb.id, status: 'active', cause: { kind: 'verify', ref: id } },
    ];
    const sent = stream([...lines, verifying, ...transitions]);
    for (const line of sent) expect(() => decodeWikiLine(line)).not.toThrow();
    for (const signers of [null, SignerRegistry.load(REGISTRY)]) {
      const ledger = new TruthLedger(new Database(':memory:'));
      const result = importWikiEntries(ledger, { lines: sent }, { signers });
      expect(result).toMatchObject({ committed: true, errors: [] });
      expect(result.held.map((h) => h.id)).toEqual([id]);
      expect(result.held[0].reason).toMatch(/would override TB .*a person/);
      expect((ledger.getEntry(contest.id) as UvEntry).body.status).toBe('open');
      expect((ledger.getEntry(tb.id) as TbEntry).body.status).toBe('contested');
      expect(ledger.getEntry(id)).toBeNull();
    }
  });

  it('with a signer registry, every quorum member is one it lists as an agent: an unlisted agent: name is no witness', () => {
    const registry = SignerRegistry.load({ signers: [{ id: 'kim', role: 'human' }, { id: 'sam', role: 'human' }, { id: 'agent:ci', role: 'agent' }] });
    expect(registry.lookup('agent:ghost')).toBeNull();
    // A TB signed by the listed agent:ci, whose second member is the unlisted agent:ghost
    const w = new TruthLedger(new Database(':memory:'));
    const a = w.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [COMMIT], literals: LITERALS }, { author: 'agent:ci', agentSessionId: 'sess-a', timestamp: at(0) });
    const b = w.draftTombstone({ claim: 'LOG_BUDGET 30 is dead', evidence: [FILE], literals: LITERALS }, { author: 'agent:ghost', agentSessionId: 'sess-b', timestamp: at(MIN) });
    const tb = w.mintTombstoneByQuorum([a.id, b.id], { author: 'agent:ci', agentSessionId: 'sess-a', timestamp: at(MIN) });
    const uv = w.assertUv({ assertion: 'Retries are idempotent.', basis: 'the design doc', verifyBy: { kind: 'inspect', value: 'src/retry.ts' } }, { author: 'sam', timestamp: at(2 * MIN) });
    const { addendum } = w.resolveUvByQuorum(
      uv.id,
      'verified',
      [
        { author: 'agent:ci', agentSessionId: 'sess-a', ts: at(2 * MIN), evidence: [COMMIT], verdict: 'verified' },
        { author: 'agent:ghost', agentSessionId: 'sess-b', ts: at(3 * MIN), evidence: [TEST], verdict: 'verified' },
      ],
      { author: 'agent:ci', agentSessionId: 'sess-a', timestamp: at(3 * MIN) }
    );
    const lines = exportWikiEntries(w).lines;
    const ledger = new TruthLedger(new Database(':memory:'));
    const result = importWikiEntries(ledger, { lines }, { signers: registry });
    expect(result.committed).toBe(true);
    expect(result.proposals).toMatchObject([{ id: tb.id, reason: 'agent-without-quorum' }]);
    expect(result.proposals[0].detail).toMatch(/agent:ghost/);
    expect(result.held.map((h) => h.id)).toEqual([addendum.id]);
    expect(result.held[0].reason).toMatch(/agent:ghost/);
    expect(ledger.getEntry(tb.id)).toBeNull();
    expect((ledger.getEntry(uv.id) as UvEntry).body.status).toBe('open');
    // Without a registry, the agent: prefix is the rule: both land
    const open = new TruthLedger(new Database(':memory:'));
    expect(importWikiEntries(open, { lines })).toMatchObject({ committed: true, proposals: [], held: [] });
  });

  it('decodes a quorum line with values it does not know, and holds it: unknown values never refuse a line', () => {
    const { lines, uv, addendum } = writer();
    const uvLine = lines.find((l) => l.id === uv.id)!;
    const resolution = lines.find((l) => l.id === addendum.id)!;
    const bench = { kind: 'benchmark', ref: 'bench/retry' };
    // A member whose only evidence is a kind this version doesn't know (a newer writer's settling kind, perhaps)
    const quorum = [{ ...resolution.quorum[0], evidence: [COMMIT, FILE] }, { ...resolution.quorum[1], evidence: [bench] }];
    const newKind = { ...resolution, quorum, evidence: [COMMIT, FILE, bench] };
    // Its only link of a type this version doesn't know, or no link at all
    const newLink = { ...resolution, 'x-steno': { ...resolution['x-steno'], links: [{ fromId: resolution.id, toId: uv.id, type: 'corroborates' }] } };
    const noLink = { ...resolution, 'x-steno': { ...resolution['x-steno'], links: [] } };
    for (const [change, why] of [
      [newKind, /evidence kind 'benchmark'/],
      [newLink, /link type 'corroborates'/],
      [noLink, /lists no links/],
    ] as const) {
      const sent = stream([uvLine, change]);
      expect(() => decodeWikiLine(sent[1]), JSON.stringify(why)).not.toThrow();
      const ledger = new TruthLedger(new Database(':memory:'));
      const result = importWikiEntries(ledger, { lines: sent });
      expect(result, JSON.stringify(why)).toMatchObject({ committed: true, errors: [] });
      expect(result.held.map((h) => h.reason)).toEqual([expect.stringMatching(why)]);
      expect((ledger.getEntry(uv.id) as UvEntry).body.status).toBe('open');
    }
  });

  it('refuses a quorum TB without literals, and a quorum on a v1 line', () => {
    const { lines, tb } = writer();
    const { literals: _l, ...noLiterals } = lines.find((l) => l.id === tb.id)!;
    expect(() => decodeWikiLine(stream([noLiterals])[0])).toThrow(/literals.*rule 5/);
    const v1 = { id: '01J9V1TB000000000000000000', type: 'TB', ts: at(0), author: 'johnnyclem', claim: 'x is dead', evidence: [COMMIT], signedBy: 'johnnyclem', quorum: noLiterals.quorum };
    expect(() => decodeWikiLine(JSON.stringify(v1))).toThrow(/v1 line carries no quorum/);
  });
});

// ─────────────────────────────────────────────────────────────
// Rule 5 reads x-steno.links: a line's top-level `links` is an unknown field
// ─────────────────────────────────────────────────────────────

describe("rule 5 reads an ADDENDUM's x-steno.links: a top-level links field is an unknown field (spec: Agent quorum, Unknown values)", () => {
  // The lines a three-way differential test found this codec (and short-hand's) reading wrongly, against
  // smallchat-swift and the spec, as it wrote them (cases 79, 163, 80, 164 and 81), and the UV they resolve.
  // Each is correctly hashed, so a reader that refuses one refuses it for its quorum. checkQuorum read a
  // top-level `links` in place of x-steno.links: null or [] hid a rule 5 break, a list refused a line that
  // keeps rule 5, and a string threw a TypeError out of the codec
  const UV1 =
    '{"schemaVersion":2,"seq":1,"id":"UV-1","type":"UV","ts":"2026-09-01T09:00:00.000Z","author":"kim","assertion":"The search cache expires after 10 minutes.","basis":"The config file says so.","verifyBy":{"kind":"inspect","value":"src/cache.ts"},"contests":null,"status":"open","x-steno":{"origin":"local","provenance":{"kind":"manual"},"agentSessionId":null,"targetRef":null,"links":[]},"prevHash":null,"hash":"344b076227661a908303fa05a0a6100f8101a1b88812ef2e7a01c0f30761c9af"}';
  const probe = (links: unknown, verdict: 'verified' | 'refuted', resolution: 'verifies' | 'refutes', hash: string) =>
    JSON.stringify({
      schemaVersion: 2,
      seq: 1,
      id: 'ADQ',
      type: 'ADDENDUM',
      ts: '2026-09-01T10:14:00.000Z',
      author: 'agent:codex',
      evidence: [
        { kind: 'commit', ref: 'c4fe0b1' },
        { kind: 'file', ref: 'src/api/search.ts:1' },
      ],
      note: null,
      quorum: [
        { author: 'agent:claude-code', agentSessionId: 'sess_a', ts: '2026-09-01T10:13:00.000Z', evidence: [{ kind: 'commit', ref: 'c4fe0b1' }], verdict },
        { author: 'agent:codex', agentSessionId: 'sess_b', ts: '2026-09-01T10:14:00.000Z', evidence: [{ kind: 'file', ref: 'src/api/search.ts:1' }], verdict },
      ],
      links,
      'x-steno': { origin: 'local', provenance: { kind: 'manual' }, agentSessionId: 'sess_b', targetRef: null, links: [{ fromId: 'ADQ', toId: 'UV-1', type: resolution }] },
      prevHash: null,
      hash,
    });
  const parse = (l: string) => JSON.parse(l) as Record<string, any>;
  // Both members say verified, and the line's x-steno link refutes UV-1: rule 5 is broken, whatever links says
  const HIDDEN = [
    ['79', probe(null, 'verified', 'refutes', '9b470f9b4ebd01d35f371b48f8b80ca278830aa01e98deb9b8c9ece3a9361cb1')],
    ['163', probe([], 'verified', 'refutes', '8237234f86768b859133c6e44851ef3a1d0ff68b06d99265f02ca4856e6d8110')],
  ] as const;
  // The verdicts are the ones the line's x-steno links apply: rule 5 is kept, whatever links holds
  const KEPT = [
    ['80', probe([{ type: 'overrides' }], 'verified', 'verifies', '64c385fd3b2b076132f836daf923e942defd62877f76b1225181b3ca1f2f3f26'), 'verified'],
    ['164', probe([{ fromId: 'ADQ', toId: 'UV-1', type: 'verifies' }], 'refuted', 'refutes', 'ab56c7e44d916541035ec0e5f6b239784b4c40eafa2fb66cf4e4de138e57c5f4'), 'refuted'],
    ['81', probe('corroborates', 'verified', 'verifies', '3278f0e12b68aca9ecabfc55bb81846af2ab5f77be87dd5c6bca35dea90ebb68'), 'verified'],
  ] as const;
  /** UV-1 imported on its own, then the probe on its own, into a fresh ledger: as the differential test did. */
  const afterUv1 = (line: string) => {
    const ledger = new TruthLedger(new Database(':memory:'));
    expect(importWikiEntries(ledger, { lines: [UV1] })).toMatchObject({ committed: true, inserted: 1 });
    return { ledger, result: importWikiEntries(ledger, { lines: [line] }) };
  };
  const RULE_5 = (n: number) => new RegExp(`quorum member ${n}'s verdict verified is not the one its line's refutes link applies \\(refuted\\) \\(rule 5\\)`);

  it('the lines are the differential test\'s, correctly hashed', () => {
    for (const [name, line] of [['UV-1', UV1], ...HIDDEN, ...KEPT]) expect(wikiLineHash(line), name).toBe(parse(line).hash);
  });

  it('refuses a quorum ADDENDUM whose verdicts break rule 5 against its x-steno links, whatever a links field says', () => {
    for (const [name, line] of HIDDEN) {
      expect(() => decodeWikiLine(line), name).toThrow(RULE_5(1));
      expect(() => decodeWikiLine(line), name).toThrow(RULE_5(2));
      // The import refuses the line for the same reason (it had decoded it, and only the ledger's admission refused it)
      const { ledger, result } = afterUv1(line);
      expect(result.committed, name).toBe(false);
      expect(result.errors.map((e) => e.error).join(), name).toMatch(RULE_5(1));
      expect((ledger.getEntry('UV-1') as UvEntry).body.status, name).toBe('open');
    }
  });

  it('reads a quorum ADDENDUM that keeps rule 5 against its x-steno links, whatever a links field holds, and applies it', () => {
    for (const [name, line, status] of KEPT) {
      expect(decodeWikiLine(line), name).toMatchObject({ version: 2, type: 'ADDENDUM' });
      const { ledger, result } = afterUv1(line);
      expect(result, name).toMatchObject({ committed: true, inserted: 1, errors: [], proposals: [], held: [] });
      expect((ledger.getEntry('UV-1') as UvEntry).body.status, name).toBe(status);
      // The unknown field is kept with the entry, and exported again verbatim
      const exported = exportWikiEntries(ledger).lines.map(parse).find((l) => l.id === 'ADQ')!;
      expect(exported.links, name).toEqual(parse(line).links);
    }
  });

  it("checkQuorum(line) reads the line's x-steno links, never its links field, and never throws on one", () => {
    for (const [name, line] of HIDDEN) expect(checkQuorum(parse(line)).join(), name).toMatch(RULE_5(1));
    for (const [name, line] of KEPT) expect(checkQuorum(parse(line)), name).toEqual([]);
    // Any value a newer writer might put there, on an otherwise valid line
    const line = parse(KEPT[0][1]);
    for (const links of [null, [], 'corroborates', 7, true, {}, { type: 'overrides' }, [{ type: 'overrides' }], [{ type: 'refutes' }], [null], [7]]) {
      const what = JSON.stringify(links);
      expect(() => checkQuorum({ ...line, links }), what).not.toThrow();
      expect(checkQuorum({ ...line, links }), what).toEqual([]);
      const { hash: _h, ...rest } = { ...line, links };
      expect(decodeWikiLine(JSON.stringify({ ...rest, hash: wikiLineHash(rest) })), what).toMatchObject({ version: 2, type: 'ADDENDUM' });
      // ...and rule 5 still reads the x-steno links beside it
      const refutes = { ...rest, 'x-steno': { ...line['x-steno'], links: [{ fromId: 'ADQ', toId: 'UV-1', type: 'refutes' }] } };
      expect(() => decodeWikiLine(JSON.stringify({ ...refutes, hash: wikiLineHash(refutes) })), what).toThrow(RULE_5(1));
    }
  });
});

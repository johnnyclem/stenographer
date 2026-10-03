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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TruthLedger, ContemptError } from '../src/truth/ledger.js';
import { StenographerServer, runCLI } from '../src/mcp/server.js';
import { SignerRegistry } from '../src/truth/identity.js';
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
  const addendum = (over: Record<string, unknown> = {}) => {
    const quorum = (over.quorum as QuorumMember[] | undefined) ?? [member(), second()];
    return {
      type: 'ADDENDUM',
      author: AGENT,
      ts: at(5 * MIN),
      evidence: quorum.flatMap((m) => m.evidence),
      quorum,
      links: [{ type: 'verifies' }],
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
    const tb = { type: 'TB', author: AGENT, signedBy: AGENT, ts: at(5 * MIN), evidence: [...a.evidence, ...b.evidence], quorum: [a, b] };
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
    const tb = { type: 'TB', author: AGENT, signedBy: 'kim', ts: at(5 * MIN), evidence: [...a.evidence, ...b.evidence], quorum: [a, b] };
    expect(checkQuorum(tb).join()).toMatch(/signed by its author.*rule 2/);
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
    // Question-class evidence only: message, chat, ticket, doc, pre-1.0 command, and kinds a reader doesn't know
    for (const kind of ['message', 'chat', 'ticket', 'doc', 'command', 'screenshot']) {
      const q = [member({ evidence: [{ kind, ref: 'x1' }] }), second({ evidence: [{ kind, ref: 'x2' }] })];
      expect(checkQuorum(addendum({ quorum: q })).join(), kind).toMatch(/cites no settling evidence.*rule 3/);
    }
  });

  it('rule 4: every member and the line within 15 minutes of each other', () => {
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: at(15 * MIN) })], ts: at(15 * MIN) }))).toEqual([]);
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: at(15 * MIN + 1) })], ts: at(15 * MIN + 1) })).join()).toMatch(
      /more than 15 minutes.*rule 4/
    );
    // The line's own ts counts too
    expect(checkQuorum(addendum({ ts: at(20 * MIN) })).join()).toMatch(/rule 4/);
  });

  it('rule 5: agreeing — every verdict is the one the link applies, and a quorum never overrides', () => {
    expect(checkQuorum(addendum({ quorum: [member(), second({ verdict: 'refuted' })] })).join()).toMatch(/verdict refuted.*verifies.*rule 5/);
    expect(checkQuorum(addendum({ links: [{ type: 'refutes' }] })).join()).toMatch(/rule 5/);
    expect(checkQuorum(addendum({ links: [{ type: 'verifies' }, { type: 'overrides' }] })).join()).toMatch(/never overrides.*rule 5/);
    expect(checkQuorum(addendum({ links: [] })).join()).toMatch(/verifies or refutes.*rule 5/);
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
    expect(b.quorum).toMatchObject({ agreeing: 2, missing: ['a settling evidence item', 'another session'] });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');

    // ...and doesn't count toward a quorum: the next settling attestation still needs a partner
    clock.now = T0 + MIN;
    const c = await s['sess-c'].call('resolve_uv', resolve(target.id, 'verified', [COMMIT]));
    expect(c.status).toBe('attested');
    expect(c.quorum).toMatchObject({ agreeing: 3, missing: ['another session'] });
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
  });

  it('mints nothing when an active TB already holds every literal', async () => {
    const { s, clock, ledger, personTb } = await sessions(['sess-a', 'sess-b']);
    const tb = await personTb();
    await s['sess-a'].call('propose_tombstone', draft());
    clock.now = T0 + MIN;
    const res = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE], literals: [LITERALS[1]] }));
    // A subset of the held TB's literals: already truth
    expect(res.status).toMatch(/awaiting notarization/);
    const again = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE], targetRef: 'again' }));
    expect(again.status).toMatch(/awaiting notarization/);
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
    const res = (await client.callTool({ name: 'assert_tombstone', arguments: { claim: 'x', evidence: [COMMIT] } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/propose_tombstone.*two or more agent sessions/);
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

  it('refuses the old config option too', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-quorum-'));
    expect(
      () =>
        new StenographerServer({ logPath: join(dir!, 'log.jsonl'), statePath: ':memory:', mode: 'catchup', allowAgentAssert: true } as StenographerConfig)
    ).toThrow(/allowAgentAssert was removed/);
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
});

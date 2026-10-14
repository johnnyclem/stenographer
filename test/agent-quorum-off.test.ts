/**
 * The agent quorum setting (`--agent-quorum off`, config `agentQuorum`).
 *
 * Since 1.1 agents settle nothing on any live path (PRD R5): drafts mint
 * nothing and verdicts are approvals a person completes, whatever the
 * setting. The setting still governs the library's 1.0 quorum writes
 * (resolveUvByQuorum, mintTombstoneByQuorum), lives in the state file so
 * every process on it obeys, and is turned back on only by an operator.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TruthLedger, NotarizationRequiredError } from '../src/truth/ledger.js';
import { exportWikiEntries, importWikiEntries } from '../src/truth/wiki.js';
import { StenographerServer, runCLI } from '../src/mcp/server.js';
import type { ProposalEntry, TbEntry, UvEntry } from '../src/truth/types.js';
import type { StenographerConfig } from '../src/types.js';

const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const MIN = 60_000;

const COMMIT = { kind: 'commit', ref: 'a1b2c3', detail: 'config.ts sets LOG_BUDGET = 100' };
const FILE = { kind: 'file', ref: 'config.ts:3', detail: 'LOG_BUDGET = 100' };

const AGENT = 'agent:claude-code';
const LITERALS = [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }, { dead: 'legacyRateLimiter' }];
const draft = (over: Record<string, unknown> = {}) => ({ claim: 'LOG_BUDGET 30 is dead; the budget is 100', evidence: [COMMIT], literals: LITERALS, ...over });
const resolve = (uvId: string, resolution: 'verified' | 'refuted', evidence: unknown[]) => ({ uvId, resolution, evidence });

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

/** Servers on one state file, one per session; each name maps to its own config overrides. */
async function sessions(configs: Record<string, Partial<StenographerConfig>>) {
  dir ??= mkdtempSync(join(tmpdir(), 'steno-quorum-off-'));
  const clock = { now: T0 };
  const statePath = join(dir, 'state.db');
  const out: Record<string, { call: (tool: string, args: Record<string, unknown>) => Promise<any>; server: StenographerServer }> = {};
  for (const [name, overrides] of Object.entries(configs)) {
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
      server,
    };
  }
  const engine = out[Object.keys(configs)[0]].server.engine;
  return { s: out, clock, statePath, engine, ledger: engine.store.truth };
}

describe('the ledger keeps the setting, and its quorum writes refuse while it is off', () => {
  it("reads 'on' until set, and the setting persists in the state file", () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-quorum-off-'));
    const path = join(dir, 'state.db');
    const a = new TruthLedger(new Database(path));
    expect(a.agentQuorum()).toBe('on');
    a.setAgentQuorum('off');
    // Another process opening the same file reads the same answer
    const db = new Database(path);
    expect(new TruthLedger(db).agentQuorum()).toBe('off');
    db.close();
    expect(() => a.setAgentQuorum('maybe' as 'on')).toThrow(/'on' or 'off'/);
  });

  it('refuses to mint a TB or settle a UV by quorum while off, writing nothing', () => {
    const l = new TruthLedger(new Database(':memory:'));
    const a = l.draftTombstone(draft(), { author: AGENT, agentSessionId: 'sess-a', timestamp: new Date(T0).toISOString() });
    const b = l.draftTombstone(draft({ evidence: [FILE] }), { author: AGENT, agentSessionId: 'sess-b', timestamp: new Date(T0 + MIN).toISOString() });
    const uv = l.assertUv({ assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' } }, { author: 'sam' });
    l.setAgentQuorum('off');
    const before = l.getChainedRecords().length;
    expect(() => l.mintTombstoneByQuorum([a.id, b.id], { author: AGENT, agentSessionId: 'sess-b' })).toThrow(NotarizationRequiredError);
    const quorum = [
      { author: AGENT, agentSessionId: 'sess-a', ts: new Date(T0).toISOString(), evidence: [COMMIT], verdict: 'verified' as const },
      { author: AGENT, agentSessionId: 'sess-b', ts: new Date(T0 + MIN).toISOString(), evidence: [FILE], verdict: 'verified' as const },
    ];
    expect(() => l.resolveUvByQuorum(uv.id, 'verified', quorum, { author: AGENT, agentSessionId: 'sess-b' })).toThrow(/agent quorum is off/);
    expect(l.getChainedRecords().length).toBe(before);
    expect(l.verify().ok).toBe(true);
  });
});

describe('propose_tombstone, on or off: agreeing drafts wait for a person', () => {
  it('two sessions drafting the same literals from different angles mint nothing; a person signs one', async () => {
    const { s, clock, ledger, engine } = await sessions({ 'sess-a': { agentQuorum: 'off' }, 'sess-b': { agentQuorum: 'off' } });
    const first = await s['sess-a'].call('propose_tombstone', draft());
    expect(first.status).toBe('awaiting notarization — not truth until a person signs it in review: no number of agent sessions mints a TB');
    expect(first.quorum.quorumOff).toBeUndefined();

    clock.now = T0 + 3 * MIN;
    const second = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE] }));
    expect(second.status).toMatch(/awaiting notarization/);
    expect(second.tombstone).toBeUndefined();
    expect(second.quorum).toMatchObject({ agreeing: 2, missing: [] });
    expect(ledger.getStats().tombstones).toBe(0);
    for (const p of [first.proposal, second.proposal]) expect((ledger.getEntry(p.id) as ProposalEntry).body.status).toBe('open');

    // The notary path is untouched: a person signs, and that is the TB
    const tb = (await engine.notarizeProposal(second.proposal.id, 'johnnyclem')) as TbEntry;
    expect(tb.body).toMatchObject({ signedBy: 'johnnyclem', answerableBy: 'johnnyclem', status: 'active' });
    expect(tb.body.quorum).toBeUndefined();
    expect(ledger.verify().ok).toBe(true);
  });

  it('a session whose process did not pass the flag reads the setting from the ledger', async () => {
    const { s, clock, ledger } = await sessions({ desk: { agentQuorum: 'off' }, 'sess-a': {}, 'sess-b': {} });
    expect(s['sess-a'].server.engine.agentQuorum()).toBe('off');
    await s['sess-a'].call('propose_tombstone', draft());
    clock.now = T0 + MIN;
    const res = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE] }));
    expect(res.status).toMatch(/awaiting notarization/);
    expect(ledger.getStats().tombstones).toBe(0);
  });
});

describe('resolve_uv, on or off: agreeing verdicts are approvals a person completes', () => {
  it('two sessions verifying from different angles leave the UV open, and nobody is paged', async () => {
    const { url, events } = await startChannel();
    const { s, clock, ledger, engine } = await sessions({
      'sess-a': { agentQuorum: 'off' },
      'sess-b': { agentQuorum: 'off', objectionSinks: [{ kind: 'channel', url }] },
    });
    const uv = await engine.assertUv({ assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' }, author: 'sam' });

    const first = await s['sess-a'].call('resolve_uv', resolve(uv.id, 'verified', [COMMIT]));
    expect(first.status).toBe('approved');
    clock.now = T0 + 5 * MIN;
    const second = await s['sess-b'].call('resolve_uv', resolve(uv.id, 'verified', [FILE]));
    expect(second.status).toBe('approved');
    expect(second.approvals).toMatchObject({ approvers: 2, human: false, missing: ['a human approval'] });
    expect((ledger.getEntry(uv.id) as UvEntry).body.status).toBe('open');
    expect(ledger.getChainedRecords().filter((r) => r.type === 'ADDENDUM')).toEqual([]);
    expect(events).toHaveLength(0);

    // A person's approval promotes it, with the agents' evidence
    const promoted = await engine.approveUv({ uvId: uv.id, role: 'human', by: 'johnnyclem' });
    expect(promoted.status).toBe('promoted');
    expect((ledger.getEntry(uv.id) as UvEntry).body.status).toBe('verified');
  });
});

describe("a teammate's ledger", () => {
  it('a TB their agents minted under the 1.0 quorum rule is filed for the docket, whatever the setting', async () => {
    const theirs = new TruthLedger(new Database(':memory:'));
    const a = theirs.draftTombstone(draft(), { author: AGENT, agentSessionId: 'sess-a', timestamp: new Date(T0).toISOString() });
    const b = theirs.draftTombstone(draft({ evidence: [FILE] }), { author: AGENT, agentSessionId: 'sess-b', timestamp: new Date(T0 + MIN).toISOString() });
    const minted = theirs.mintTombstoneByQuorum([a.id, b.id], { author: AGENT, agentSessionId: 'sess-b', timestamp: new Date(T0 + MIN).toISOString() });
    for (const setting of ['on', 'off'] as const) {
      const ours = new TruthLedger(new Database(':memory:'));
      ours.setAgentQuorum(setting);
      const result = importWikiEntries(ours, { lines: exportWikiEntries(theirs).lines });
      expect(result).toMatchObject({ committed: true, proposals: [{ id: minted.id, reason: 'agent-quorum' }] });
      expect(ours.getEntry(minted.id)).toBeNull();
    }
  });
});

describe('who turns it back on', () => {
  it('an agent-profile process asking for on over a ledger set to off fails to start', async () => {
    const { statePath } = await sessions({ desk: { agentQuorum: 'off' } });
    expect(
      () => new StenographerServer({ logPath: join(dir!, 'x.jsonl'), statePath, mode: 'catchup', embeddingModel: 'hashed', agentQuorum: 'on' })
    ).toThrow(/only the operator profile turns it back on/);
  });

  it('the operator profile turns it back on; agreeing drafts still mint nothing', async () => {
    const { s, clock, ledger, statePath } = await sessions({ 'sess-a': { agentQuorum: 'off' }, 'sess-b': {} });
    const operator = new StenographerServer({ logPath: join(dir!, 'op.jsonl'), statePath, mode: 'catchup', embeddingModel: 'hashed', profile: 'operator', agentQuorum: 'on' });
    servers.push(operator);
    expect(ledger.agentQuorum()).toBe('on');
    await s['sess-a'].call('propose_tombstone', draft());
    clock.now = T0 + MIN;
    const res = await s['sess-b'].call('propose_tombstone', draft({ evidence: [FILE] }));
    expect(res.status).toMatch(/awaiting notarization/);
    expect(ledger.getStats().tombstones).toBe(0);
  });
});

describe('what the agent is told', () => {
  it('its initialize instructions and tool descriptions say only a person settles, on or off', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-quorum-off-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    const server = new StenographerServer({ logPath: join(dir, 'log.jsonl'), statePath: ':memory:', mode: 'catchup', embeddingModel: 'hashed', agentQuorum: 'off' });
    servers.push(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(clientSide);
    expect(client.getInstructions()).toMatch(/Your claim is a UV until a person approves it/);
    expect(client.getInstructions()).not.toMatch(/two or more agent sessions agree/);
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description!;
    expect(description('propose_tombstone')).toMatch(/becomes truth only when a person signs it in review/);
    expect(description('propose_tombstone')).not.toMatch(/settled by quorum/);
    expect(description('resolve_uv')).toMatch(/a person rules/);
    const res = (await client.callTool({ name: 'assert_tombstone', arguments: { claim: 'x', evidence: [COMMIT] } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.content[0].text).toMatch(/when a person signs it in review/);
  });
});

describe('--agent-quorum', () => {
  it('refuses a value other than on or off', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errors: string[] = [];
    const log = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
    try {
      await expect(runCLI(['--agent-quorum', 'maybe', '/nonexistent/log.jsonl', ':memory:'])).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
    expect(errors.join('\n')).toMatch(/Unknown --agent-quorum 'maybe'. Available: on, off/);
  });
});

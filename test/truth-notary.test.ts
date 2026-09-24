import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TruthLedger, NotarizationRequiredError, ContemptError } from '../src/truth/ledger.js';
import { StenographerServer } from '../src/mcp/server.js';
import { notarySecretMatches } from '../src/truth/notary.js';
import type { StenographerConfig } from '../src/types.js';
import type { TbEntry } from '../src/truth/types.js';

const DRAFT = {
  claim: 'LOG_BUDGET 30 is dead; the budget is 100',
  evidence: [{ kind: 'commit' as const, ref: 'a1b2c3' }],
  literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
  rationale: 'config.ts was bumped in a1b2c3',
};
const AGENT = 'claude-code:@ingest';

describe('agent-drafted tombstones (ledger)', () => {
  const ledger = () => new TruthLedger(new Database(':memory:'));

  it('files a draft as an open proposal that requires a notary and keeps its literals', () => {
    const l = ledger();
    const p = l.draftTombstone(DRAFT, { author: AGENT, agentSessionId: 'sess-1' });
    expect(p.type).toBe('PROPOSAL');
    expect(p.body.status).toBe('open');
    expect(p.body.requiresNotary).toBe(true);
    expect(p.body.signal).toEqual({ source: 'agent-draft', detail: DRAFT.rationale });
    expect(p.body.draft).toMatchObject({ claim: DRAFT.claim, literals: DRAFT.literals });
  });

  it('validates drafts like a TB: evidence required, bare values need a subject', () => {
    const l = ledger();
    expect(() => l.draftTombstone({ ...DRAFT, evidence: [] }, { author: AGENT })).toThrow(/evidence/);
    expect(() => l.draftTombstone({ ...DRAFT, literals: [{ dead: '30' }] }, { author: AGENT })).toThrow(/subject/);
    expect(() => l.draftTombstone(DRAFT, { author: 'assistant' })).toThrow(/accountable/);
  });

  it('refuses to mint a draft through the ordinary signing path', () => {
    const l = ledger();
    const p = l.draftTombstone(DRAFT, { author: AGENT });
    expect(() => l.signProposal(p.id, 'johnny')).toThrow(NotarizationRequiredError);
    expect(l.getEntry(p.id)!.body).toMatchObject({ status: 'open' });
  });

  it('mints a TB with the literals when a person notarizes it', () => {
    const l = ledger();
    const p = l.draftTombstone(DRAFT, { author: AGENT });
    const tb = l.signProposal(p.id, 'johnny', undefined, { notarized: true }) as TbEntry;
    expect(tb.type).toBe('TB');
    expect(tb.body.signedBy).toBe('johnny');
    expect(tb.body.literals).toEqual(DRAFT.literals);
    expect(tb.links).toContainEqual({ fromId: tb.id, toId: p.id, type: 'signs' });
    expect(l.getEntry(p.id)!.body).toMatchObject({ status: 'signed' });
  });

  it('still applies contempt of corpus: the drafter cannot notarize its own draft', () => {
    const l = ledger();
    const p = l.draftTombstone(DRAFT, { author: AGENT });
    expect(() => l.signProposal(p.id, AGENT, undefined, { notarized: true })).toThrow(ContemptError);
  });
});

describe('notary secret', () => {
  it('matches only an identical, non-empty secret', () => {
    expect(notarySecretMatches('s3cret', 's3cret')).toBe(true);
    expect(notarySecretMatches('s3cret', 's3creT')).toBe(false);
    expect(notarySecretMatches('s3cret', undefined)).toBe(false);
    expect(notarySecretMatches(undefined, 's3cret')).toBe(false);
    expect(notarySecretMatches('', '')).toBe(false);
  });
});

describe('agent-drafted tombstones (MCP + REST)', () => {
  let dir: string;
  let server: StenographerServer | null = null;
  let channel: Server | null = null;

  afterEach(() => {
    server?.engine.stop();
    server = null;
    channel?.close();
    channel = null;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in smallchat channel bridge that records what it receives. */
  async function startChannel(): Promise<{ url: string; events: Array<{ secret?: string; body: any }> }> {
    const events: Array<{ secret?: string; body: any }> = [];
    channel = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        events.push({ secret: req.headers['x-channel-secret'] as string | undefined, body: JSON.parse(data) });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => channel!.listen(0, '127.0.0.1', resolve));
    const address = channel.address() as { port: number };
    return { url: `http://127.0.0.1:${address.port}`, events };
  }

  async function start(overrides: Partial<StenographerConfig> = {}) {
    dir = mkdtempSync(join(tmpdir(), 'steno-notary-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    server = new StenographerServer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
      restPort: 0,
      ...overrides,
    });
    await server.engine.start();
    const call = (name: string, args: Record<string, unknown>) =>
      (server as unknown as { callTool: (n: string, a: Record<string, unknown>) => Promise<any> }).callTool(name, args);
    const base = `http://127.0.0.1:${server.engine.restPort}`;
    return { call, base };
  }

  const post = (url: string, body: unknown, secret?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Notary-Secret': secret } : {}) },
      body: JSON.stringify(body),
    });

  it('propose_tombstone raises the draft to the smallchat channel, with where to notarize it', async () => {
    const { url, events } = await startChannel();
    const { call, base } = await start({
      objectionSinks: [{ kind: 'channel', url, secret: 'chan' }],
      notarySecret: 'n0tary',
    });

    const result = await call('propose_tombstone', { ...DRAFT, proposedBy: AGENT, agentSessionId: 'sess-1' });
    expect(result.status).toMatch(/awaiting notarization/);
    expect(result.raisedTo).toEqual([url]);

    expect(events).toHaveLength(1);
    expect(events[0].secret).toBe('chan');
    expect(events[0].body.meta).toEqual({
      kind: 'proposal',
      proposal_id: result.proposal.id,
      drafted_by: AGENT,
      session_ids: 'sess-1',
      notarize_url: `${base}/proposals/${result.proposal.id}/notarize`,
    });
    expect(events[0].body.content).toContain(DRAFT.claim);
  });

  it('an agent cannot sign its draft over MCP; a person notarizes it over REST', async () => {
    const { call, base } = await start({ notarySecret: 'n0tary' });
    const { proposal } = await call('propose_tombstone', { ...DRAFT, proposedBy: AGENT });

    await expect(call('sign_proposal', { proposalId: proposal.id, signedBy: 'johnny' })).rejects.toThrow(
      /must be notarized by a person/
    );

    const inbox = await (await fetch(`${base}/proposals?status=open`)).json();
    expect(inbox.map((p: { id: string }) => p.id)).toEqual([proposal.id]);

    const notarize = `${base}/proposals/${proposal.id}/notarize`;
    expect((await post(notarize, { notary: 'johnny' })).status).toBe(401);
    expect((await post(notarize, { notary: 'johnny' }, 'wrong')).status).toBe(401);
    expect((await post(notarize, {}, 'n0tary')).status).toBe(400);

    const ok = await post(notarize, { notary: 'johnny' }, 'n0tary');
    expect(ok.status).toBe(200);
    const tb = await ok.json();
    expect(tb).toMatchObject({ type: 'TB', body: { signedBy: 'johnny', literals: DRAFT.literals } });

    // Already signed: a ledger rule, reported as such
    expect((await post(notarize, { notary: 'johnny' }, 'n0tary')).status).toBe(422);
  });

  it('a person can decline a draft over REST, with a reason', async () => {
    const { call, base } = await start({ notarySecret: 'n0tary' });
    const { proposal } = await call('propose_tombstone', { ...DRAFT, proposedBy: AGENT });
    const res = await post(`${base}/proposals/${proposal.id}/dismiss`, { dismissedBy: 'johnny', reason: 'still 30 in prod' }, 'n0tary');
    expect(res.status).toBe(200);
    expect((await res.json()).body).toMatchObject({ status: 'dismissed', dismissReason: 'still 30 in prod' });
  });

  it('REST notarization is off when no notary secret is configured', async () => {
    const { call, base } = await start();
    const { proposal } = await call('propose_tombstone', { ...DRAFT, proposedBy: AGENT });
    expect((await post(`${base}/proposals/${proposal.id}/notarize`, { notary: 'johnny' }, 'anything')).status).toBe(403);
  });

  it('--require-notary stops agents asserting tombstones directly', async () => {
    const { call } = await start({ requireNotary: true });
    await expect(call('assert_tombstone', { ...DRAFT, signedBy: 'johnny' })).rejects.toThrow(/propose_tombstone/);
  });

  it('without --require-notary, assert_tombstone keeps working', async () => {
    const { call } = await start();
    const tb = await call('assert_tombstone', { ...DRAFT, signedBy: 'johnny' });
    expect(tb.type).toBe('TB');
  });
});

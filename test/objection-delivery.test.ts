import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Stenographer } from '../src/core/stenographer.js';
import { StenographerServer } from '../src/mcp/server.js';
import { evaluateGate } from '../src/truth/gate.js';
import {
  createSinkTransport,
  createMcpChannelTransport,
  formatObjection,
  redactUrl,
  webhookHeaders,
} from '../src/truth/delivery.js';
import { formatProposalNotice } from '../src/truth/notary.js';
import type { ProposalEntry } from '../src/truth/types.js';
import type { ObjectionSinkConfig } from '../src/truth/delivery.js';
import type { Objection } from '../src/truth/objections.js';
import type { StenographerConfig } from '../src/types.js';

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  raw: string;
  body: any;
}

/**
 * A local receiver that records every POST; `failNext` makes it answer 500
 * once, and `answer` picks a status per request body (default 200).
 */
async function receiver(answer?: (raw: string) => number): Promise<{
  url: string;
  received: Received[];
  attempts: () => number;
  failNext: () => void;
  close: () => void;
}> {
  const received: Received[] = [];
  let fail = 0;
  let attempts = 0;
  const server: HttpServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      attempts++;
      if (fail > 0) {
        fail--;
        res.writeHead(500).end();
        return;
      }
      const status = answer?.(raw) ?? 200;
      if (status !== 200) {
        res.writeHead(status).end();
        return;
      }
      received.push({ path: req.url ?? '/', headers: req.headers, raw, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    attempts: () => attempts,
    failNext: () => (fail = 1),
    close: () => server.close(),
  };
}

const assistant = (id: string, content: string) =>
  JSON.stringify({ id, role: 'assistant', content, timestamp: '2026-09-18T10:00:00Z' }) + '\n';

const BUDGET = { subject: 'LOG_BUDGET', dead: '30', current: '100' };
/** A webhook secret long enough for Standard Webhooks (24+ bytes). */
const RAW_SECRET = 'stenographer-test-secret-0123456789';

async function settle(engine: Stenographer): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  await engine.flush();
  await engine.deliverObjections();
}

describe('objection delivery (webhooks)', () => {
  let dir: string;
  let engine: Stenographer | null = null;
  let recv: Awaited<ReturnType<typeof receiver>> | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    recv?.close();
    recv = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(
    sinks: (url: string) => ObjectionSinkConfig[],
    overrides: Partial<StenographerConfig> = {},
    answer?: (raw: string) => number
  ): Promise<{ e: Stenographer; log: string; statePath: string }> {
    dir = mkdtempSync(join(tmpdir(), 'steno-deliver-'));
    recv = await receiver(answer);
    const log = join(dir, 'log.jsonl');
    const statePath = join(dir, 'state.db');
    writeFileSync(log, '');
    engine = new Stenographer({
      logPath: log,
      statePath,
      mode: 'live',
      embeddingModel: 'hashed',
      objectionMode: 'deliver',
      objectionSinks: sinks(recv.url),
      ...overrides,
    });
    await engine.start();
    return { e: engine, log, statePath };
  }

  /** Three TBs so one session can raise three distinct objections. */
  async function seedTombstones(e: Stenographer): Promise<void> {
    for (const [subject, dead] of [
      ['LOG_BUDGET', '30'],
      ['RETRY_LIMIT', '5'],
      ['POOL_SIZE', '8'],
    ]) {
      await e.assertTombstone({
        claim: `${subject} ${dead} is dead`,
        evidence: [{ kind: 'commit', ref: `c-${subject}` }],
        signedBy: 'johnnyclem',
        literals: [{ subject, dead }],
      });
    }
  }

  it('channel sink: pushes each objection to the smallchat bridge as it is discovered', async () => {
    const { e, log } = await start((url) => [{ kind: 'channel', url, secret: 's3cret' }]);
    await e.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead; the budget is 100',
      evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
      signedBy: 'johnnyclem',
      literals: [BUDGET],
    });

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);

    expect(recv!.received).toHaveLength(1);
    const [event] = recv!.received;
    expect(event.path).toBe('/event');
    expect(event.headers['x-channel-secret']).toBe('s3cret');
    expect(event.body.channel).toBe('stenographer');
    expect(event.body.sender).toBe('stenographer');
    expect(event.body.content).toContain('LOG_BUDGET = 30');
    expect(event.body.content).toContain('rule_on_objection');
    expect(event.body.meta).toMatchObject({ kind: 'objection', count: '1' });
    // smallchat drops meta keys that aren't identifier-only
    for (const key of Object.keys(event.body.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    const [flag] = await e.getObjections();
    expect(event.body.meta.objection_ids).toBe(flag.id);
  });

  it('webhook sink (no interrupts): holds objections until a batch of three', async () => {
    const { e, log } = await start((url) => [{ kind: 'webhook', url: `${url}/hook` }]);
    await seedTombstones(e);

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30') + assistant('a2', 'RETRY_LIMIT = 5'));
    await settle(e);
    expect(recv!.received).toHaveLength(0);

    appendFileSync(log, assistant('a3', 'POOL_SIZE = 8'));
    await settle(e);
    expect(recv!.received).toHaveLength(1);
    const [batch] = recv!.received;
    expect(batch.path).toBe('/hook');
    expect(batch.body.type).toBe('stenographer.objections');
    expect(batch.body.objections.map((o: Objection) => o.messageId)).toEqual(['a1', 'a2', 'a3']);
    expect(batch.body.objections[0]).toHaveProperty('exhibit');
    expect(batch.body.objections[0]).toHaveProperty('transcriptLine');
  });

  it('webhook sink signs with Standard Webhooks headers over id.timestamp.body (T-17)', async () => {
    const { e, log } = await start((url) => [{ kind: 'webhook', url, secret: RAW_SECRET, batchSize: 1 }]);
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);

    const [hit] = recv!.received;
    const id = hit.headers['webhook-id'] as string;
    const timestamp = hit.headers['webhook-timestamp'] as string;
    expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(30);
    const expected = createHmac('sha256', RAW_SECRET).update(`${id}.${timestamp}.${hit.raw}`).digest('base64');
    expect(hit.headers['webhook-signature']).toBe(`v1,${expected}`);
    // The 0.x body-only signature is gone: it could be replayed forever
    expect(hit.headers['x-stenographer-signature']).toBeUndefined();
  });

  it('objections the judge already ruled on are not delivered', async () => {
    const { e, log } = await start((url) => [{ kind: 'webhook', url }]);
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30') + assistant('a2', 'RETRY_LIMIT = 5'));
    await settle(e);

    const [first] = await e.getObjections();
    await e.ruleOnObjection(first.id, 'sustained', { author: 'johnnyclem', opinion: 'Fixed in-session.' });

    appendFileSync(log, assistant('a3', 'POOL_SIZE = 8'));
    await settle(e);
    // Only two still pending — the batch isn't full yet
    expect(recv!.received).toHaveLength(0);
  });

  it('shadow mode sends nothing to any receiver', async () => {
    const { e, log } = await start((url) => [{ kind: 'channel', url }], { objectionMode: 'shadow' });
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    expect(recv!.received).toHaveLength(0);
    expect(await e.getObjections({ includeShadow: true })).toHaveLength(1);
  });

  it('a failed delivery is retried, not dropped', async () => {
    const { e, log } = await start((url) => [{ kind: 'channel', url, retryBaseMs: 0 }]);
    await seedTombstones(e);
    recv!.failNext();
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    // Let the on-discovery push run (and fail) without a manual retry
    await new Promise((r) => setTimeout(r, 300));
    await e.flush();
    await new Promise((r) => setTimeout(r, 100));
    expect(recv!.attempts()).toBe(1);
    expect(recv!.received).toHaveLength(0);

    await e.deliverObjections();
    expect(recv!.received).toHaveLength(1);
    // Delivered once — a later pump doesn't resend
    await e.deliverObjections();
    expect(recv!.received).toHaveLength(1);
  });

  it('a partial batch survives a restart and completes after it', async () => {
    const { e, log, statePath } = await start((url) => [{ kind: 'webhook', url }]);
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30') + assistant('a2', 'RETRY_LIMIT = 5'));
    await settle(e);
    e.stop();
    engine = null;

    const log2 = join(dir, 'log2.jsonl');
    writeFileSync(log2, '');
    engine = new Stenographer({
      logPath: log2,
      statePath,
      mode: 'live',
      embeddingModel: 'hashed',
      objectionMode: 'deliver',
      objectionSinks: [{ kind: 'webhook', url: recv!.url }],
    });
    await engine.start();
    appendFileSync(log2, assistant('b1', 'POOL_SIZE = 8'));
    await settle(engine);

    expect(recv!.received).toHaveLength(1);
    expect(recv!.received[0].body.objections.map((o: Objection) => o.messageId)).toEqual(['a1', 'a2', 'b1']);
  });

  it('a rejected objection is dead-lettered and does not block the ones behind it (T-15)', async () => {
    // smallchat's bridge refuses some events outright (403 over its size cap)
    const { e, log } = await start(
      (url) => [{ kind: 'channel', url }],
      {},
      (raw) => (raw.includes('RETRY_LIMIT') ? 403 : 200)
    );
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'RETRY_LIMIT = 5'));
    await settle(e);
    appendFileSync(log, assistant('a2', 'LOG_BUDGET = 30') + assistant('a3', 'POOL_SIZE = 8'));
    await settle(e);
    await e.deliverObjections();
    await e.deliverObjections();

    expect(recv!.received.map((r) => r.body.content.match(/Transcript \(text\): (.*)/)[1])).toEqual([
      'LOG_BUDGET = 30',
      'POOL_SIZE = 8',
    ]);
    // A permanent refusal is not retried
    expect(recv!.attempts()).toBe(3);
    const dead = e.store.objectionDelivery.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ attempts: 1, error: expect.stringMatching(/403/) });
    expect((await e.getObjectionStats()).deadLettered).toBe(1);
  });

  it('transient failures back off per objection and dead-letter after maxAttempts (T-15)', async () => {
    let failing = true;
    const { e, log } = await start(
      (url) => [{ kind: 'channel', url, retryBaseMs: 60_000, maxAttempts: 3 }],
      {},
      (raw) => (failing && raw.includes('RETRY_LIMIT') ? 503 : 200)
    );
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'RETRY_LIMIT = 5'));
    await settle(e);
    expect(recv!.attempts()).toBe(1);

    // Backing off: an immediate pump doesn't hammer the receiver ...
    await e.deliverObjections();
    expect(recv!.attempts()).toBe(1);
    // ... and doesn't hold back a later objection either
    appendFileSync(log, assistant('a2', 'LOG_BUDGET = 30'));
    await settle(e);
    expect(recv!.received).toHaveLength(1);
    expect(recv!.received[0].body.content).toContain('LOG_BUDGET = 30');

    // Due again: retried, fails again, and the third failure is the last
    const dispatcher = e.store.objectionDelivery;
    dispatcher.retryNow();
    await e.deliverObjections();
    dispatcher.retryNow();
    await e.deliverObjections();
    expect(recv!.attempts()).toBe(4);
    expect(dispatcher.deadLetters()).toHaveLength(1);
    dispatcher.retryNow();
    failing = false;
    await e.deliverObjections();
    expect(recv!.attempts()).toBe(4);
  });

  it('a batch refused as a whole is retried one objection at a time (T-15)', async () => {
    const { e, log } = await start(
      (url) => [{ kind: 'webhook', url, batchSize: 2 }],
      {},
      (raw) => (raw.includes('RETRY_LIMIT = 5') ? 413 : 200)
    );
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'RETRY_LIMIT = 5') + assistant('a2', 'LOG_BUDGET = 30'));
    await settle(e);
    await e.deliverObjections();

    expect(recv!.received).toHaveLength(1);
    expect(recv!.received[0].body.objections.map((o: Objection) => o.messageId)).toEqual(['a2']);
    expect(e.store.objectionDelivery.deadLetters().map((d) => d.objectionId)).toHaveLength(1);
  });

  it('a partial webhook batch is flushed once it has waited maxBatchDelayMs', async () => {
    const { e, log } = await start((url) => [{ kind: 'webhook', url, maxBatchDelayMs: 0 }]);
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    expect(recv!.received).toHaveLength(1);
    expect(recv!.received[0].body.objections).toHaveLength(1);
  });

  it('never follows a redirect: the body and secret stay with the configured receiver (T-16)', async () => {
    const elsewhere = await receiver();
    try {
      const redirector: HttpServer = createServer((_req, res) => {
        res.writeHead(307, { Location: `${elsewhere.url.replace('127.0.0.1', 'localhost')}/event` }).end();
      });
      await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
      const port = (redirector.address() as { port: number }).port;
      try {
        const { e, log } = await start(() => [
          { kind: 'channel', url: `http://127.0.0.1:${port}`, secret: 'CHANNEL-SECRET-123' },
        ]);
        await seedTombstones(e);
        appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
        await settle(e);
        await e.deliverObjections();

        expect(elsewhere.attempts()).toBe(0);
        const [dead] = e.store.objectionDelivery.deadLetters();
        expect(dead.error).toMatch(/redirect/);
      } finally {
        redirector.close();
      }
    } finally {
      elsewhere.close();
    }
  });

  it('never prints a sink URL with its credentials (T-17)', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      const { e, log } = await start(
        (url) => [{ kind: 'webhook', url: `${url}/hooks/T0001/B0002/SeCrEtPaThToKeN?token=SeCrEtQuErY`, batchSize: 1 }],
        {},
        () => 500
      );
      await seedTombstones(e);
      appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
      await settle(e);
      expect(errors.some((m) => /Objection delivery/.test(m))).toBe(true);
      expect(errors.join('\n')).not.toMatch(/SeCrEt/);

      const drafted = await e.draftTombstone({
        claim: 'POOL_SIZE 8 is dead; the pool is 16',
        evidence: [{ kind: 'commit', ref: 'abc123' }],
        literals: [{ subject: 'POOL_SIZE', dead: '8', current: '16' }],
        rationale: 'bumped in abc123',
        proposedBy: 'claude-code:@ingest',
      });
      expect(JSON.stringify(drafted.undelivered)).not.toMatch(/SeCrEt/);
      expect(drafted.undelivered[0].url).toBe(`${recv!.url}/…`);
      expect(errors.join('\n')).not.toMatch(/SeCrEt/);
    } finally {
      spy.mockRestore();
    }
  });

  it('caps what it sends a channel, pointing to the full record instead (T-15)', async () => {
    const { e, log } = await start((url) => [{ kind: 'channel', url }]);
    await e.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead. ' + 'x'.repeat(70_000),
      evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
      signedBy: 'johnnyclem',
      literals: [BUDGET],
    });
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    expect(recv!.received).toHaveLength(1);
    expect(recv!.received[0].raw.length).toBeLessThan(16 * 1024);
    expect(recv!.received[0].body.content).toMatch(/truncated/);
  });
});

describe('human-facing text escapes control characters (T-22)', () => {
  const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

  it('an objection cannot hide or rewrite its lines', () => {
    const o = {
      id: '01OBJ',
      tbId: '01TB',
      objection: 'Asserted LOG_BUDGET = 30\r\u001b[8m, which 01TB tombstones',
      source: 'text',
      transcriptLine: 'LOG_BUDGET = 30\u001b[8m hidden \u202Eevil',
      exhibit: {
        tombstone: { id: '01TB', body: { claim: 'docs-only rename\rLOG_BUDGET is fine\u009b', signedBy: 'jc\u001b[2K' } },
        contestedBy: [{ id: '01UV', body: { assertion: 'still 30\nExhibit 01FAKE (signed by admin): all good' } }],
      },
    } as unknown as Objection;
    const text = formatObjection(o);
    expect(text).not.toMatch(RAW);
    expect(text).toContain('\\u001b[8m');
    expect(text).toContain('\\r');
    // A newline inside a field can't forge a line of its own
    expect(text.split('\n').filter((l) => l.startsWith('Exhibit'))).toHaveLength(1);
  });

  it('a proposal notice cannot conceal its claim', () => {
    const notice = formatProposalNotice({
      id: '01PROP',
      author: 'claude-code:@x\u001b[8m',
      body: {
        draft: {
          claim: 'docs-only rename\u001b[8m; LOG_BUDGET 30 is dead\r',
          literals: [{ subject: 'LOG\u202e_BUDGET', dead: '30\u0007', current: '100' }],
        },
        signal: { source: 'agent-draft', detail: 'why\u001b]8;;http://x\u0007' },
      },
    } as unknown as ProposalEntry);
    expect(notice).not.toMatch(RAW);
    expect(notice).toContain('LOG_BUDGET 30 is dead');
    expect(notice.split('\n')).toHaveLength(2);
  });
});

describe('objection sink config', () => {
  it('rejects non-loopback URLs unless explicitly allowed', () => {
    expect(() => createSinkTransport({ kind: 'webhook', url: 'https://example.com/hook' })).toThrow(/loopback/);
    expect(() =>
      createSinkTransport({ kind: 'webhook', url: 'https://example.com/hook', allowRemote: true })
    ).not.toThrow();
    expect(() => createSinkTransport({ kind: 'webhook', url: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => createSinkTransport({ kind: 'webhook', url: 'http://127.0.0.1:1', batchSize: 0 })).toThrow(/batch/);
  });

  it('refuses webhook secrets too short to sign with (T-17)', () => {
    expect(() => createSinkTransport({ kind: 'webhook', url: 'http://127.0.0.1:1', secret: 'k' })).toThrow(/24 bytes/);
    expect(() => createSinkTransport({ kind: 'webhook', url: 'http://127.0.0.1:1', secret: RAW_SECRET })).not.toThrow();
    const whsec = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
    expect(() => createSinkTransport({ kind: 'webhook', url: 'http://127.0.0.1:1', secret: whsec })).not.toThrow();
  });

  it('signs a whsec_ secret with its decoded bytes, as Standard Webhooks verifiers expect', () => {
    const key = Buffer.alloc(32, 7);
    const headers = webhookHeaders('whsec_' + key.toString('base64'), 'msg_1', '{"a":1}', 1_700_000_000);
    const expected = createHmac('sha256', key).update('msg_1.1700000000.{"a":1}').digest('base64');
    expect(headers).toEqual({
      'webhook-id': 'msg_1',
      'webhook-timestamp': '1700000000',
      'webhook-signature': `v1,${expected}`,
    });
  });

  it('labels a transport without the secret parts of its URL', () => {
    const t = createSinkTransport({ kind: 'webhook', url: 'http://127.0.0.1:9/hooks/T1/B2/token?sig=abc' });
    expect(t.label).toBe('webhook:http://127.0.0.1:9/…');
    expect(redactUrl('http://127.0.0.1:3002')).toBe('http://127.0.0.1:3002');
    expect(redactUrl('http://user:pw@127.0.0.1:3002/')).toBe('http://127.0.0.1:3002');
  });

  it('fails engine construction on a bad sink, before anything runs', () => {
    expect(
      () =>
        new Stenographer({
          logPath: 'x.jsonl',
          statePath: ':memory:',
          mode: 'catchup',
          objectionSinks: [{ kind: 'channel', url: 'http://10.0.0.5:3002' }],
        })
    ).toThrow(/loopback/);
  });

  it('defaults: channels interrupt, webhooks batch by three', () => {
    const channel = createSinkTransport({ kind: 'channel', url: 'http://127.0.0.1:3002' });
    const webhook = createSinkTransport({ kind: 'webhook', url: 'http://127.0.0.1:9000/hook' });
    expect(channel.interrupts).toBe(true);
    expect(webhook.interrupts).toBe(false);
    expect(webhook.batchSize).toBe(3);
  });
});

describe("Claude Code's built-in channel (MCP notifications/claude/channel)", () => {
  it('delivers an objection to an attached MCP client as a channel notification', async () => {
    const server = new Server(
      { name: 'stenographer', version: 'test' },
      { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } }
    );
    const client = new Client({ name: 'claude-code', version: 'test' });
    const received: Array<{ method: string; params: any }> = [];
    client.fallbackNotificationHandler = async (n) => {
      received.push(n as any);
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const transport = createMcpChannelTransport((params) =>
      server.notification({ method: 'notifications/claude/channel', params })
    );
    const objection = {
      id: '01OBJ',
      createdAt: '2026-09-18T10:00:00Z',
      sessionId: 's1',
      messageId: 'a1',
      tbId: '01TB',
      literal: BUDGET,
      objection: 'Asserted LOG_BUDGET = 30, which 01TB tombstones; current value: 100: LOG_BUDGET 30 is dead',
      exhibit: {
        tombstone: {
          id: '01TB',
          type: 'TB',
          createdAt: '2026-09-18T09:00:00Z',
          author: 'johnnyclem',
          provenance: { kind: 'manual' },
          origin: 'local',
          links: [],
          body: { claim: 'LOG_BUDGET 30 is dead', evidence: [{ kind: 'commit', ref: 'a1' }], signedBy: 'johnnyclem', status: 'active' },
        },
        contestedBy: [],
      },
      transcriptLine: 'LOG_BUDGET = 30',
      source: 'text',
      status: 'pending',
      delivered: true,
      rulingId: null,
    } as Objection;

    expect(transport.interrupts).toBe(true);
    await transport.send([objection]);
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('notifications/claude/channel');
    expect(received[0].params.content).toBe(formatObjection(objection));
    expect(received[0].params.meta).toMatchObject({ kind: 'objection', objection_ids: '01OBJ', tb_ids: '01TB' });

    await client.close();
    await server.close();
  });

  // STENO-REV-04: every delivered objection in the state file went to the
  // attached agent, including other sessions' transcript objections and
  // gate objections their PreToolUse hooks filed in enforce mode.
  it("pushes only this server's own session's transcript objections, not other sessions' or gate ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-channel-'));
    const log = join(dir, 'log.jsonl');
    const statePath = join(dir, 'state.db');
    writeFileSync(log, '');
    const server = new StenographerServer({
      logPath: log,
      statePath,
      mode: 'live',
      embeddingModel: 'hashed',
      objectionMode: 'deliver',
    });
    try {
      await server.engine.start();
      const client = new Client({ name: 'claude-code', version: 'test' });
      const received: Array<{ method: string; params: any }> = [];
      client.fallbackNotificationHandler = async (n) => {
        received.push(n as any);
      };
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const engine = server.engine;
      await engine.assertTombstone({
        claim: 'LOG_BUDGET 30 is dead; the budget is 100',
        evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
        signedBy: 'johnnyclem',
        literals: [BUDGET],
      });

      // This session's transcript
      appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
      await settle(engine);
      // Another session's transcript, on the same state file
      engine.store.objections.scan(
        { id: 'b1', role: 'assistant', content: 'set LOG_BUDGET = 30', timestamp: '2026-09-18T10:00:00Z' },
        'someone-elses-session',
        'deliver'
      );
      // Gate objections in enforce mode: another session's, and this one's
      for (const session_id of ['someone-elses-session', engine.getSessionId()]) {
        const gate = evaluateGate(
          { session_id, tool_name: 'Write', tool_input: { file_path: 'a.ts', content: `export const LOG_BUDGET = 30; // ${session_id}` } },
          { mode: 'enforce', statePath, timeoutMs: 2000, onError: 'deny', tools: ['Write'] }
        );
        expect(gate.decision).toBe('deny');
      }
      await settle(engine);
      await new Promise((r) => setTimeout(r, 20));

      expect(received.map((n) => n.params.meta.session_ids)).toEqual([engine.getSessionId()]);
      expect(received[0].params.content).toContain('LOG_BUDGET = 30');
      await client.close();
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

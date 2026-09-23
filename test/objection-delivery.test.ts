import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Stenographer } from '../src/core/stenographer.js';
import { createSinkTransport, createMcpChannelTransport, formatObjection } from '../src/truth/delivery.js';
import type { ObjectionSinkConfig } from '../src/truth/delivery.js';
import type { Objection } from '../src/truth/objections.js';
import type { StenographerConfig } from '../src/types.js';

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  raw: string;
  body: any;
}

/** A local receiver that records every POST; `failNext` makes it answer 500 once. */
async function receiver(): Promise<{
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
    overrides: Partial<StenographerConfig> = {}
  ): Promise<{ e: Stenographer; log: string; statePath: string }> {
    dir = mkdtempSync(join(tmpdir(), 'steno-deliver-'));
    recv = await receiver();
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

  it('webhook sink signs its body with HMAC-SHA256 when given a secret', async () => {
    const { e, log } = await start((url) => [{ kind: 'webhook', url, secret: 'k', batchSize: 1 }]);
    await seedTombstones(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);

    const [hit] = recv!.received;
    const expected = 'sha256=' + createHmac('sha256', 'k').update(hit.raw).digest('hex');
    expect(hit.headers['x-stenographer-signature']).toBe(expected);
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
    const { e, log } = await start((url) => [{ kind: 'channel', url }]);
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
});

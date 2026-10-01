import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import { Tailer } from '../src/indexer/tailer.js';
import { ClaudeCodeAdapter } from '../src/indexer/adapters.js';
import type { ConversationMessage, StenographerConfig } from '../src/types.js';

/** The Claude Code session the log belongs to (its `sessionId` field). */
const HARNESS_SESSION = '3f2a9c1e-7b4d-4e2a-9f10-5c6d7e8f9a0b';

const claudeCode = (uuid: string, type: 'user' | 'assistant', text: string, sessionId = HARNESS_SESSION) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type,
    message: { role: type, content: [{ type: 'text', text }] },
    uuid,
    timestamp: '2026-09-30T10:00:00Z',
    sessionId,
  }) + '\n';

const jsonl = (id: string, role: string, content: string) =>
  JSON.stringify({ id, role, content, timestamp: '2026-09-30T10:00:00Z' }) + '\n';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('session identity in live and daemon modes (IDX-10)', () => {
  let dir: string;
  let engine: Stenographer | null = null;
  let channel: Server | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    channel?.close();
    channel = null;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in smallchat channel bridge that records `meta.session_ids`. */
  async function bridge(): Promise<{ url: string; sessionIds: string[] }> {
    const sessionIds: string[] = [];
    channel = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        sessionIds.push(JSON.parse(raw).meta.session_ids);
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => channel!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(channel.address() as { port: number }).port}`, sessionIds };
  }

  async function run(log: string, overrides: Partial<StenographerConfig> = {}): Promise<Stenographer> {
    engine = new Stenographer({
      logPath: log,
      statePath: join(dir, 'state.db'),
      mode: 'live',
      embeddingModel: 'hashed',
      objectionMode: 'deliver',
      ...overrides,
    });
    await engine.start();
    return engine;
  }

  async function seed(e: Stenographer): Promise<void> {
    await e.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead; the budget is 100',
      evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
      signedBy: 'johnnyclem',
      literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
    });
  }

  it('objections from a Claude Code log carry its harness session id, whatever the file is called', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-session-'));
    const log = join(dir, 'transcript.jsonl');
    writeFileSync(log, '');
    const { url, sessionIds } = await bridge();
    const e = await run(log, { mode: 'daemon', restPort: 0, objectionSinks: [{ kind: 'channel', url }] });
    await seed(e);

    appendFileSync(log, claudeCode('u-1', 'user', 'what is the log budget?') + claudeCode('u-2', 'assistant', 'LOG_BUDGET = 30'));
    await wait(300);
    await e.flush();
    await e.deliverObjections();

    const [objection] = await e.getObjections();
    expect(objection.sessionId).toBe(HARNESS_SESSION);
    // smallchat's messenger routes by exactly this key
    expect(sessionIds).toEqual([HARNESS_SESSION]);
    expect(e.getSessionId()).toBe(HARNESS_SESSION);
    expect((await e.getRecentMessages(10)).map((m) => m.sessionId)).toEqual([HARNESS_SESSION, HARNESS_SESSION]);
  });

  it('a log without harness ids is named after its file, never session_<ms>', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-session-'));
    const log = join(dir, 'agent-7.jsonl');
    writeFileSync(log, '');
    const e = await run(log);
    expect(e.getSessionId()).toBe('agent-7');
    await seed(e);

    appendFileSync(log, jsonl('a1', 'assistant', 'LOG_BUDGET = 30'));
    await wait(300);
    await e.flush();
    const [objection] = await e.getObjections();
    expect(objection.sessionId).toBe('agent-7');
  });

  it('the harness session id is the scope after a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-session-'));
    const log = join(dir, 'transcript.jsonl');
    writeFileSync(log, claudeCode('u-1', 'user', 'the cache is redis'));
    const first = await run(log);
    await first.flush();
    first.stop();

    const e = await run(log);
    expect(e.getSessionId()).toBe(HARNESS_SESSION);
    expect((await e.getRecentMessages(10)).map((m) => m.id)).toEqual(['u-1']);
  });
});

describe('Tailer session ids (IDX-10)', () => {
  let dir: string;
  let tailer: Tailer | null = null;

  afterEach(() => {
    tailer?.stop();
    tailer = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the session id the adapter parsed, and defaults to the log basename', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-session-'));
    const file = join(dir, 'b7c1.jsonl');
    writeFileSync(file, claudeCode('u-1', 'user', 'hello') + claudeCode('u-2', 'user', 'resumed', 'other-session'));
    const received: ConversationMessage[] = [];
    tailer = new Tailer(file, { adapter: new ClaudeCodeAdapter(), follow: false });
    tailer.on('message', (m: ConversationMessage) => received.push(m));
    await tailer.start();
    expect(received.map((m) => m.sessionId)).toEqual([HARNESS_SESSION, 'other-session']);

    const plain = join(dir, 'b7c1-plain.jsonl');
    writeFileSync(plain, jsonl('p1', 'user', 'hello'));
    const plainReceived: ConversationMessage[] = [];
    tailer = new Tailer(plain, { follow: false });
    expect(tailer.getSessionId()).toBe('b7c1-plain');
    tailer.on('message', (m: ConversationMessage) => plainReceived.push(m));
    await tailer.start();
    expect(plainReceived[0].sessionId).toBe('b7c1-plain');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tailer, JsonlAdapter } from '../src/indexer/tailer.js';
import { detectAdapter } from '../src/indexer/adapters.js';
import type { ConversationMessage } from '../src/types.js';

const line = (id: string, content: string) =>
  JSON.stringify({ id, role: 'user', content, timestamp: new Date().toISOString() }) + '\n';

describe('JsonlAdapter', () => {
  const adapter = new JsonlAdapter();

  it('parses valid message lines', () => {
    const msg = adapter.parseLine(line('m1', 'hello').trim());
    expect(msg?.id).toBe('m1');
    expect(msg?.content).toBe('hello');
  });

  it('returns null for malformed lines', () => {
    expect(adapter.parseLine('not json')).toBeNull();
    expect(adapter.parseLine('{"missing": "fields"}')).toBeNull();
  });

  it('detects its own format', () => {
    expect(adapter.detect([line('m1', 'hi').trim()])).toBe(true);
    expect(adapter.detect(['garbage'])).toBe(false);
    expect(adapter.detect([])).toBe(false);
  });
});

describe('Tailer', () => {
  let dir: string;
  let tailer: Tailer | null = null;

  afterEach(() => {
    tailer?.stop();
    tailer = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('processes existing lines on start and tags the session', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('m1', 'first') + line('m2', 'second'));

    tailer = new Tailer(file, 'session_x');
    const received: ConversationMessage[] = [];
    tailer.on('message', (m: ConversationMessage) => received.push(m));

    await tailer.start();

    expect(received.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(received[0].sessionId).toBe('session_x');
    expect(tailer.getSessionId()).toBe('session_x');
  });

  it('only emits new lines on subsequent changes (no duplicates)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('m1', 'first'));

    tailer = new Tailer(file);
    const received: ConversationMessage[] = [];
    tailer.on('message', (m: ConversationMessage) => received.push(m));

    await tailer.start();
    expect(received).toHaveLength(1);

    appendFileSync(file, line('m2', 'second'));
    // Give the fs watcher time to fire
    await new Promise((r) => setTimeout(r, 300));

    expect(received.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('detectAdapter', () => {
  it('resolves an adapter for a JSONL file', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'steno-'));
    try {
      const file = join(dir2, 'log.jsonl');
      writeFileSync(file, line('m1', 'hello'));
      const adapter = await detectAdapter(file);
      expect(adapter.parseLine(line('m2', 'x').trim())?.id).toBe('m2');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

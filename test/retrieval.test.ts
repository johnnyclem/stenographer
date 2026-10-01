import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { Stenographer } from '../src/core/stenographer.js';
import { StateStore } from '../src/store/index.js';
import { HashedEmbedder, type Embedder } from '../src/indexer/embeddings.js';
import type { StenographerConfig } from '../src/types.js';

const imp = { total: 0, stateDelta: 0, referenceFrequency: 0, trajectoryDiscontinuity: 0 };

describe('retrieval', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function index(lines: string[], overrides: Partial<StenographerConfig> = {}): Promise<Stenographer> {
    dir = mkdtempSync(join(tmpdir(), 'steno-retrieval-'));
    writeFileSync(join(dir, 'log.jsonl'), lines.join('\n') + '\n');
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
      ...overrides,
    });
    await engine.start();
    return engine;
  }

  const jsonl = (id: string, content: string, ts: string, role = 'user') =>
    JSON.stringify({ id, role, content, timestamp: ts });

  it('the context frame stays within its token budget in every section (IDX-14)', async () => {
    const topics = ['build', 'test runner', 'linter config', 'deploy script', 'cache layer', 'auth flow', 'router', 'logger', 'queue', 'scheduler'];
    const e = await index(
      Array.from({ length: 300 }, (_, i) =>
        jsonl(
          `m${i}`,
          i % 7 === 0
            ? `we decided to use ${topics[i % 10]} version ${i} for the release train ${i}`
            : `The ${topics[i % 10]} ${i} is failing again, connected to upstream service number ${i}`,
          new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          i % 2 ? 'assistant' : 'user'
        )
      )
    );

    for (const budget of [200, 500, 2000]) {
      const frame = await e.buildContextFrame(budget);
      expect(Math.ceil(frame.length / 4)).toBeLessThanOrEqual(budget);
      expect(frame).toContain('## Recent Messages');
      expect(frame).toContain('## Decisions');
    }
    // The newest message is always in the frame
    expect(await e.buildContextFrame(500)).toContain('connected to upstream service number 299');
  });

  it('GraphRAG ranks messages, not content-free entity and path chunks (IDX-16)', async () => {
    const e = await index([
      jsonl('m0', 'The database is postgres 15 running on the db host.', '2026-01-01T00:00:00Z'),
      jsonl('m1', 'We are connecting the api to the database with pgbouncer.', '2026-01-01T00:01:00Z'),
      jsonl('m2', 'The cache is redis and the database is postgres.', '2026-01-01T00:02:00Z'),
      jsonl('m3', 'The problem is that the migration is slow.', '2026-01-01T00:03:00Z'),
      jsonl('m4', 'The fix is to add an index on orders.created_at.', '2026-01-01T00:04:00Z'),
      jsonl('m5', 'Connected to the staging cluster.', '2026-01-01T00:05:00Z'),
    ]);

    const results = await e.searchGraphRAG({ query: 'which database do we run in production', k: 3 });
    expect(results.every((r) => r.type === 'message')).toBe(true);
    expect(results[0].id).toBe('m0');
    // Graph evidence rides along as metadata
    expect(results[0].meta.matchedEntities).toContain('database');
    // Scores are fused ranks, highest first
    expect(results.map((r) => r.score)).toEqual([...results.map((r) => r.score)].sort((a, b) => b - a));
  });

  it('GraphRAG context comes from the same session, nearest in order (IDX-16)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-retrieval-'));
    writeFileSync(join(dir, 'a.jsonl'), [jsonl('a0', 'alpha opening remark', '2026-01-01T00:00:00Z'), jsonl('a1', 'the ingest worker uses kafka', '2026-01-01T00:00:10Z'), jsonl('a2', 'alpha closing remark', '2026-01-01T00:00:20Z')].join('\n') + '\n');
    writeFileSync(join(dir, 'b.jsonl'), [jsonl('b0', 'beta unrelated chatter', '2026-01-01T00:00:05Z')].join('\n') + '\n');
    engine = new Stenographer({ logPath: dir, statePath: ':memory:', mode: 'watch', embeddingModel: 'hashed' });
    await engine.start();
    await engine.flush();

    const [top] = await engine.searchGraphRAG({ query: 'which queue does the ingest worker use, kafka?', k: 1 });
    expect(top.id).toBe('a1');
    const neighbors = top.meta.neighbors.map((n: { id: string }) => n.id);
    expect(neighbors).toEqual(['a0', 'a2']);
  });

  it('get_recent_messages follows log order when lines carry no timestamps (IDX-17)', async () => {
    const e = await index(
      Array.from({ length: 200 }, (_, i) =>
        JSON.stringify({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${i}` }] })
      )
    );
    expect((await e.getRecentMessages(3)).map((m) => m.content)).toEqual(['turn 199', 'turn 198', 'turn 197']);
    expect(await e.buildContextFrame(2000)).toMatch(/turn 198[\s\S]*turn 199/);
  });

  it('tool calls are searchable, and nothing empty is embedded (IDX-18)', async () => {
    const cc = (uuid: string, type: string, content: unknown) =>
      JSON.stringify({ parentUuid: null, type, uuid, timestamp: '2026-01-01T00:00:00Z', sessionId: 's1', message: { role: type, content } });
    const e = await index([
      cc('u1', 'user', 'Please fix the flaky login test in auth.spec.ts'),
      ...Array.from({ length: 8 }, (_, i) =>
        cc(`t${i}`, 'assistant', [{ type: 'tool_use', id: `x${i}`, name: 'Read', input: { file_path: `/src/file${i}.ts` } }])
      ),
      cc('p1', 'user', '...'),
      cc('a1', 'assistant', [{ type: 'text', text: 'The login test was flaky because of a race in the session mock; fixed.' }]),
    ]);

    const flaky = await e.searchSimilar('why was the login test flaky', 3);
    expect(flaky.slice(0, 2).map((m) => m.id).sort()).toEqual(['a1', 'u1']);
    const read = await e.searchSimilar('Read /src/file3.ts', 1);
    expect(read[0].id).toBe('t3');
    expect(read[0].toolCalls).toEqual([{ name: 'Read', input: { file_path: '/src/file3.ts' } }]);
    // "..." has no features: no vector, never a neighbor of anything
    expect((await e.searchSimilar('...', 20)).map((m) => m.id)).not.toContain('p1');
  });

  it('scores are cosine similarity even for vectors that are not unit length (IDX-18)', () => {
    const store = new StateStore(':memory:');
    const axis = (scale: number) => Array.from({ length: 384 }, (_, i) => (i === 0 ? scale : 0));
    store.addMessage({ id: 'long', sessionId: 's', role: 'user', content: 'x', timestamp: 't', embedding: axis(3), importanceScore: imp, entityIds: [] });
    const [hit] = store.searchSimilar(axis(1), 1);
    expect(hit.score).toBeCloseTo(1, 5);
    store.close();
  });

  it('session-scoped vector search does not starve, and k is clamped (IDX-13)', async () => {
    const store = new StateStore(':memory:');
    const h = new HashedEmbedder();
    for (let i = 0; i < 100; i++) {
      const content = `postgres database config tuning ${i}`;
      store.addMessage({ id: `a${i}`, sessionId: 'A', role: 'user', content, timestamp: 't', embedding: await h.embed(content), importanceScore: imp, entityIds: [] });
    }
    for (const [i, content] of ['hello', 'we use postgres database for orders', 'lunch?', 'ok', 'ship it'].entries()) {
      store.addMessage({ id: `b${i}`, sessionId: 'B', role: 'user', content, timestamp: 't', embedding: await h.embed(content), importanceScore: imp, entityIds: [] });
    }
    const q = await h.embed('postgres database');
    const scoped = store.searchSimilar(q, 5, 'B');
    expect(scoped[0].message.id).toBe('b1');
    expect(scoped.every((r) => r.message.sessionId === 'B')).toBe(true);
    // Past sqlite-vec's k limit: clamped, not an error
    expect(store.searchSimilar(q, 5000).length).toBe(105);
    store.close();
  });

  it('REST and MCP clamp k instead of failing (IDX-13)', async () => {
    const e = await index([jsonl('m1', 'we decided to use postgres', '2026-01-01T00:00:00Z')], { restPort: 0 });
    for (const path of ['/search?q=postgres&k=5000', '/search?q=postgres&k=4096', '/graphrag?q=postgres&k=5000']) {
      const res = await fetch(`http://127.0.0.1:${e.restPort}${path}`);
      expect(res.status).toBe(200);
    }
  });

  const filler = Array.from({ length: 700 }, (_, i) => `The ${['router', 'logger', 'scheduler', 'parser'][i % 4]} module handles case ${i} quietly.`).join(' ');
  const needle = [
    jsonl('long', `${filler} Finally: the deploy key rotates every ninety days.`, '2026-01-01T00:00:00Z'),
    jsonl('short', 'we ship the app on fridays after standup', '2026-01-01T00:01:00Z'),
  ];

  it('text past the model window stays searchable: long messages are embedded in chunks (IDX-25)', async () => {
    // Reads only its first 1,000 characters, the way MiniLM drops tokens past its window
    const hashed = new HashedEmbedder();
    const truncating: Embedder = {
      embed: (text) => hashed.embed(text.slice(0, 1000)),
      embedBatch: (texts) => Promise.all(texts.map((t) => hashed.embed(t.slice(0, 1000)))),
      dimensions: hashed.dimensions,
      identity: { kind: 'transformer', model: 'test/truncating', dimensions: hashed.dimensions, version: 1 },
      supersedeThreshold: hashed.supersedeThreshold,
    };
    const e = await index(needle, { embedder: truncating });
    expect(filler.length).toBeGreaterThan(30_000);
    const [top] = await e.searchSimilar('how often does the deploy key rotate', 1);
    expect(top.id).toBe('long');
  });

  it.skipIf(!process.env.STENOGRAPHER_TEST_MODEL_CACHE)('...and under MiniLM itself (IDX-25)', async () => {
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = process.env.STENOGRAPHER_TEST_MODEL_CACHE!;
    env.allowRemoteModels = false;
    const e = await index(needle, { embeddingModel: 'Xenova/all-MiniLM-L6-v2' });
    const [top] = await e.searchSimilar('how often does the deploy key rotate', 1);
    expect(top.id).toBe('long');
  });

  it('importance is persisted and used as a ranking prior (IDX-23)', async () => {
    const e = await index([
      jsonl('m1', 'the redis cache settings look fine to me', '2026-01-01T00:00:00Z'),
      jsonl('m2', 'actually, the redis cache settings need a larger maxmemory', '2026-01-01T00:01:00Z'),
      jsonl('m3', 'ok', '2026-01-01T00:02:00Z'),
    ]);
    const stored = e.store.getMessage('m2')!;
    expect(stored.importanceScore.total).toBeGreaterThan(0);
    const results = await e.searchGraphRAG({ query: 'redis cache settings', k: 2 });
    expect(results[0].id).toBe('m2');
    expect(results[0].meta.importance).toBeGreaterThan(results[1].meta.importance);
  });

  it('a pre-1.0 vector index is rebuilt from the stored embeddings, and old rows keep their order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-retrieval-'));
    const path = join(dir, 'state.db');
    const h = new HashedEmbedder();
    const legacy = new Database(path);
    sqliteVec.load(legacy);
    legacy.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, timestamp TEXT NOT NULL, embedding BLOB,
        importance_state_delta REAL, importance_reference_freq REAL,
        importance_trajectory_disc REAL, entity_ids TEXT);
      CREATE VIRTUAL TABLE message_vectors USING vec0(message_id TEXT PRIMARY KEY, embedding float[384]);
    `);
    const rows: Array<[string, string, string]> = [
      ['z-first', 'A', 'we run postgres for orders'],
      ['a-second', 'B', 'we run postgres for billing'],
      ['m-third', 'B', 'lunch is at noon'],
    ];
    for (const [id, session, content] of rows) {
      const blob = Buffer.from(new Float32Array(await h.embed(content)).buffer);
      // Same timestamp for all: only insertion order tells them apart
      legacy
        .prepare('INSERT INTO messages (id, session_id, role, content, timestamp, embedding, entity_ids) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, session, 'user', content, '2026-01-01T00:00:00Z', blob, '[]');
      legacy.prepare('INSERT INTO message_vectors (message_id, embedding) VALUES (?, ?)').run(id, blob);
    }
    legacy.close();

    const store = new StateStore(path);
    const scoped = store.searchSimilar(await h.embed('postgres'), 1, 'B');
    expect(scoped.map((r) => r.message.id)).toEqual(['a-second']);
    expect(store.getRecentMessages(null, 3).map((m) => m.id)).toEqual(['m-third', 'a-second', 'z-first']);
    if (store.vectorSearchBackend === 'sqlite-vec') {
      // Cosine, not L2 on unit vectors: the same text scores 1
      expect(store.searchSimilar(await h.embed('lunch is at noon'), 1)[0].score).toBeCloseTo(1, 5);
    }
    store.close();
  });
});

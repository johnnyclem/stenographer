import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HashedEmbedder,
  TransformerEmbedder,
  createEmbedder,
  cosineSimilarity,
  type Embedder,
  type EmbedderIdentity,
} from '../src/indexer/embeddings.js';
import { Stenographer } from '../src/core/stenographer.js';
import { StateStore } from '../src/store/index.js';
import type { StenographerConfig } from '../src/types.js';

const pairs = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'supersession-pairs.json'), 'utf8')) as {
    pairs: Array<['rewrite' | 'distinct', string, string]>;
  }
).pairs;

async function scorePairs(embedder: Embedder) {
  const scores = { rewrite: [] as number[], distinct: [] as number[] };
  for (const [kind, a, b] of pairs) {
    scores[kind].push(cosineSimilarity(await embedder.embed(a), await embedder.embed(b)));
  }
  return scores;
}

describe('per-embedder supersede thresholds (IDX-06)', () => {
  it('the hashed threshold separates rewrites from unrelated decisions', async () => {
    const embedder = new HashedEmbedder();
    const { rewrite, distinct } = await scorePairs(embedder);
    expect(Math.max(...distinct)).toBeLessThan(embedder.supersedeThreshold);
    expect(Math.min(...rewrite)).toBeGreaterThanOrEqual(embedder.supersedeThreshold);
  });

  // Needs the MiniLM weights on disk (no download in tests): point
  // STENOGRAPHER_TEST_MODEL_CACHE at a transformers.js cache directory.
  it.skipIf(!process.env.STENOGRAPHER_TEST_MODEL_CACHE)(
    'the MiniLM threshold separates rewrites from unrelated decisions',
    async () => {
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.STENOGRAPHER_TEST_MODEL_CACHE!;
      env.allowRemoteModels = false;
      const embedder = new TransformerEmbedder();
      await embedder.load();
      expect(embedder.dimensions).toBe(384);
      const { rewrite, distinct } = await scorePairs(embedder);
      expect(Math.max(...distinct)).toBeLessThan(embedder.supersedeThreshold);
      expect(Math.min(...rewrite)).toBeGreaterThanOrEqual(embedder.supersedeThreshold);
    }
  );
});

describe('engine supersession under the hashed embedder (IDX-06)', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const line = (id: string, content: string, ts: string) =>
    JSON.stringify({ id, role: 'user', content, timestamp: ts }) + '\n';

  it('unrelated decisions stay active; a rewrite still supersedes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-pin-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use postgres for the main database', '2026-06-09T10:00:00Z') +
        line('m2', 'we decided to use redis for the session cache', '2026-06-09T10:01:00Z') +
        line('m3', 'we decided to use jest for the unit tests', '2026-06-09T10:02:00Z') +
        line('m4', 'we decided to use tailwind for styling', '2026-06-09T10:03:00Z') +
        line('m5', 'we decided to use mysql for the main database', '2026-06-09T10:04:00Z')
    );
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
    });
    await engine.start();

    const active = (await engine.getActiveDecisions()).map((d) => d.description);
    expect(active).toEqual([
      'use redis for the session cache',
      'use jest for the unit tests',
      'use tailwind for styling',
      'use mysql for the main database',
    ]);
  });
});

describe('embedder pinning (IDX-24)', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const minilm: EmbedderIdentity = {
    kind: 'transformer',
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    version: 1,
  };

  function setup(): { log: string; statePath: string } {
    dir = mkdtempSync(join(tmpdir(), 'steno-pin-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(
      log,
      JSON.stringify({ id: 'm1', role: 'user', content: 'we decided to use postgres', timestamp: '2026-06-09T10:00:00Z' }) + '\n'
    );
    return { log, statePath: join(dir, 'state.db') };
  }

  const config = (log: string, statePath: string, extra: Partial<StenographerConfig> = {}): StenographerConfig => ({
    logPath: log,
    statePath,
    mode: 'catchup',
    embeddingModel: 'hashed',
    ...extra,
  });

  it('records the embedder in the database', async () => {
    const { log, statePath } = setup();
    engine = new Stenographer(config(log, statePath));
    await engine.start();
    expect(engine.store.getMeta('embedder')).toEqual(new HashedEmbedder().identity);
  });

  it('refuses a database indexed under another embedder, naming both and the escape hatch', async () => {
    const { log, statePath } = setup();
    const seed = new StateStore(statePath);
    seed.setMeta('embedder', minilm);
    seed.addMessage({
      id: 'old',
      sessionId: 's',
      role: 'user',
      content: 'we decided to use postgres',
      timestamp: '2026-06-09T09:00:00Z',
      embedding: new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
      importanceScore: { total: 0, stateDelta: 0, referenceFrequency: 0, trajectoryDiscontinuity: 0 },
      entityIds: [],
    });
    seed.close();

    engine = new Stenographer(config(log, statePath));
    await expect(engine.start()).rejects.toThrow(/Xenova\/all-MiniLM-L6-v2.*hashed.*--reembed/s);
    // Nothing was indexed under the wrong embedder
    expect(engine.store.getStats(null).messagesIndexed).toBe(1);
    engine.stop();

    // --reembed: every stored vector is recomputed under the new embedder
    engine = new Stenographer(config(log, statePath, { reembed: true }));
    await engine.start();
    expect(engine.store.getMeta('embedder')).toEqual(new HashedEmbedder().identity);
    const hashed = await new HashedEmbedder().embed('we decided to use postgres');
    expect(engine.store.getMessage('old')!.embedding[0]).toBeCloseTo(hashed[0], 5);
    const [top] = await engine.searchSimilar('postgres', 1);
    expect(['old', 'm1']).toContain(top.id);
  });

  it('never falls back to hashed silently', async () => {
    const { env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    await expect(createEmbedder('steno-test/no-such-model')).rejects.toThrow(/--embeddings (hashed|auto)/);

    // 'auto' opts in to the fallback, and says so loudly
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auto = await createEmbedder('auto', { model: 'steno-test/no-such-model' });
    expect(auto).toBeInstanceOf(HashedEmbedder);
    expect(errors.mock.calls.flat().join('\n')).toMatch(/falling back to the offline hashed embedder/i);
  });

  it("'auto' follows the embedder a database is pinned to", async () => {
    const pinned = await createEmbedder('auto', { pinned: new HashedEmbedder().identity });
    expect(pinned).toBeInstanceOf(HashedEmbedder);
  });
});

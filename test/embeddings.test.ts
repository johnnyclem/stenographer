import { describe, it, expect } from 'vitest';
import {
  LocalEmbedder,
  VectorIndex,
  EmbeddingCache,
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
} from '../src/indexer/embeddings.js';

describe('LocalEmbedder', () => {
  const embedder = new LocalEmbedder();

  it('produces normalized vectors of the declared dimension', async () => {
    const vec = await embedder.embed('we decided to use postgres for storage');
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);

    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic', async () => {
    const a = await embedder.embed('hello world');
    const b = await embedder.embed('hello world');
    expect(a).toEqual(b);
  });

  it('scores related text higher than unrelated text', async () => {
    const query = await embedder.embed('which database should we use');
    const related = await embedder.embed('we decided to use the postgres database');
    const unrelated = await embedder.embed('the weather in tokyo is rainy today');

    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('handles empty input', async () => {
    const vec = await embedder.embed('');
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vec.every((v) => v === 0)).toBe(true);
  });
});

describe('VectorIndex', () => {
  it('returns top-k nearest neighbors', async () => {
    const embedder = new LocalEmbedder();
    const index = new VectorIndex();

    const docs = [
      ['m1', 'we use postgres for the database'],
      ['m2', 'the frontend is built with react'],
      ['m3', 'postgres connection pooling is configured'],
    ] as const;

    for (const [id, text] of docs) {
      index.add(id, await embedder.embed(text), text);
    }

    const results = index.search(await embedder.embed('postgres database'), 2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toContain('m1');
    expect(index.size()).toBe(3);
  });
});

describe('EmbeddingCache', () => {
  it('evicts oldest entries when full', () => {
    const cache = new EmbeddingCache(4);
    for (let i = 0; i < 5; i++) {
      cache.set(`k${i}`, [i]);
    }
    expect(cache.size()).toBeLessThanOrEqual(4);
    // Newest entry survives eviction
    expect(cache.get('k4')).toEqual([4]);
  });
});

describe('cosineSimilarity', () => {
  it('handles identical, orthogonal, and mismatched vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

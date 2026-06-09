/**
 * Stenographer — Embeddings
 * Deterministic local embeddings via hashed lexical features
 * (word + character n-grams). No network, no API keys, no model download.
 *
 * Note: these are lexical embeddings, not transformer embeddings — similar
 * wording scores high, paraphrases score lower. Good enough for Tier 0
 * conversation recall; a transformer backend can be swapped in behind the
 * same LocalEmbedder interface later.
 */

export const EMBEDDING_DIMENSIONS = 384;

// FNV-1a 32-bit hash — stable across runs and platforms
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ─────────────────────────────────────────────────────────────
// Embedder (local, deterministic, no API keys)
// ─────────────────────────────────────────────────────────────

export class LocalEmbedder {
  private cache: EmbeddingCache;

  constructor(cacheSize: number = 10000) {
    this.cache = new EmbeddingCache(cacheSize);
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = tokenize(text);

    for (const token of tokens) {
      // Word-level feature (signed hashing keeps the expected dot product
      // of unrelated texts near zero)
      const h = fnv1a(token);
      vec[h % EMBEDDING_DIMENSIONS] += h & 1 ? 1 : -1;

      // Character trigram features capture morphology / partial matches
      const padded = `_${token}_`;
      for (let i = 0; i + 3 <= padded.length; i++) {
        const g = fnv1a(padded.slice(i, i + 3));
        vec[g % EMBEDDING_DIMENSIONS] += (g & 1 ? 1 : -1) * 0.5;
      }
    }

    // L2 normalize so cosine similarity reduces to a dot product
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    this.cache.set(text, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  get dimensions(): number {
    return EMBEDDING_DIMENSIONS;
  }
}

// ─────────────────────────────────────────────────────────────
// Simple in-memory vector store (Tier 0, no external DB)
// ─────────────────────────────────────────────────────────────

export class VectorIndex {
  private vectors: Map<string, number[]> = new Map();
  private texts: Map<string, string> = new Map();
  private meta: Map<string, any> = new Map();

  add(id: string, embedding: number[], text: string, meta: any = {}): void {
    this.vectors.set(id, embedding);
    this.texts.set(id, text);
    this.meta.set(id, meta);
  }

  search(queryEmbedding: number[], k: number = 5): Array<{ id: string; score: number; text: string; meta: any }> {
    const results: Array<{ id: string; score: number; text: string; meta: any }> = [];

    for (const [id, vector] of this.vectors) {
      const score = cosineSimilarity(queryEmbedding, vector);
      results.push({
        id,
        score,
        text: this.texts.get(id)!,
        meta: this.meta.get(id),
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  get(id: string): { embedding: number[]; text: string; meta: any } | null {
    const embedding = this.vectors.get(id);
    if (!embedding) return null;
    return {
      embedding,
      text: this.texts.get(id)!,
      meta: this.meta.get(id),
    };
  }

  size(): number {
    return this.vectors.size;
  }

  clear(): void {
    this.vectors.clear();
    this.texts.clear();
    this.meta.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// Cosine Similarity
// ─────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// ─────────────────────────────────────────────────────────────
// Embedding Cache (for efficiency)
// ─────────────────────────────────────────────────────────────

export class EmbeddingCache {
  private cache: Map<string, number[]> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, embedding: number[]): void {
    if (this.cache.size >= this.maxSize) {
      // Simple eviction: drop the oldest half when full
      const entries = Array.from(this.cache.entries());
      this.cache = new Map(entries.slice(Math.floor(this.maxSize / 2)));
    }
    this.cache.set(key, embedding);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

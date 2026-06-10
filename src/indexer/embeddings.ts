/**
 * Stenographer — Embeddings
 *
 * Two interchangeable embedders behind one interface:
 * - TransformerEmbedder (default): real semantic embeddings via
 *   @xenova/transformers (all-MiniLM-L6-v2, 384-dim). Downloads the model
 *   (~25MB quantized) on first use, then runs fully locally. No API keys.
 * - HashedEmbedder: deterministic hashed lexical features (word + char
 *   n-grams). Zero downloads, fully offline; weaker on paraphrase. Used as
 *   the automatic fallback when the model can't be loaded.
 */

export const EMBEDDING_DIMENSIONS = 384;

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

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
// Transformer Embedder (default — real semantic embeddings)
// ─────────────────────────────────────────────────────────────

export class TransformerEmbedder implements Embedder {
  private cache: EmbeddingCache;
  private model: string;
  private pipe: ((text: string, opts: object) => Promise<{ data: Float32Array }>) | null = null;
  private loading: Promise<void> | null = null;

  constructor(model: string = 'Xenova/all-MiniLM-L6-v2', cacheSize: number = 10000) {
    this.model = model;
    this.cache = new EmbeddingCache(cacheSize);
  }

  /** Loads the model (downloads on first ever use). Throws if unavailable. */
  async load(): Promise<void> {
    if (this.pipe) return;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline } = await import('@xenova/transformers');
        this.pipe = (await pipeline('feature-extraction', this.model, {
          quantized: true,
        })) as unknown as typeof this.pipe;
      })();
    }
    await this.loading;
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    await this.load();
    const out = await this.pipe!(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    this.cache.set(text, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await this.embed(t));
    }
    return results;
  }

  get dimensions(): number {
    return EMBEDDING_DIMENSIONS;
  }
}

// ─────────────────────────────────────────────────────────────
// Hashed Embedder (offline fallback, deterministic)
// ─────────────────────────────────────────────────────────────

export class HashedEmbedder implements Embedder {
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

// Back-compat alias: LocalEmbedder was the original exported name
export { HashedEmbedder as LocalEmbedder };

// ─────────────────────────────────────────────────────────────
// Factory — transformer by default, graceful offline fallback
// ─────────────────────────────────────────────────────────────

/**
 * Creates the configured embedder.
 * - 'hashed': offline lexical embedder
 * - any other value (or undefined): transformer model name, defaulting to
 *   Xenova/all-MiniLM-L6-v2. If the model can't be loaded (offline, missing
 *   optional dep), falls back to the hashed embedder with a warning.
 */
export async function createEmbedder(embeddingModel?: string): Promise<Embedder> {
  if (embeddingModel === 'hashed') {
    return new HashedEmbedder();
  }

  const transformer = new TransformerEmbedder(embeddingModel || 'Xenova/all-MiniLM-L6-v2');
  try {
    await transformer.load();
    return transformer;
  } catch (err) {
    console.error(
      `⚠️  Could not load transformer embeddings (${err instanceof Error ? err.message : err}); ` +
        'falling back to offline hashed embeddings'
    );
    return new HashedEmbedder();
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

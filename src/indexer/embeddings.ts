/**
 * Stenographer — Embeddings
 *
 * Two interchangeable embedders behind one interface:
 * - TransformerEmbedder (default): real semantic embeddings via
 *   @huggingface/transformers (all-MiniLM-L6-v2, 384-dim). Downloads the
 *   model (~25MB quantized) on first use, then runs fully locally. No API keys.
 * - HashedEmbedder: deterministic hashed lexical features (word + char
 *   n-grams). Zero downloads, fully offline; weaker on paraphrase. Chosen
 *   explicitly (`hashed`), or as the fallback `auto` opts in to.
 *
 * Vectors from two embedders aren't comparable, so each embedder has an
 * identity that a state database is pinned to, and its own calibrated
 * supersede threshold.
 */

export const EMBEDDING_DIMENSIONS = 384;

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** What produced a vector. Vectors are only comparable under one identity. */
export interface EmbedderIdentity {
  kind: 'hashed' | 'transformer';
  /** Model id; `hashed` for the lexical embedder. */
  model: string;
  dimensions: number;
  /** Bumped when the same model's vectors change (pooling, quantization, features). */
  version: number;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly identity: EmbedderIdentity;
  /**
   * Cosine similarity at or above which a new decision is taken as a
   * rewrite of an active one. Calibrated per embedder on
   * test/fixtures/supersession-pairs.json.
   */
  readonly supersedeThreshold: number;
}

export function sameEmbedder(a: EmbedderIdentity, b: EmbedderIdentity): boolean {
  return a.kind === b.kind && a.model === b.model && a.dimensions === b.dimensions && a.version === b.version;
}

export function describeEmbedder(identity: EmbedderIdentity): string {
  return identity.kind === 'hashed'
    ? `hashed (${identity.dimensions}-dim, v${identity.version})`
    : `${identity.model} (${identity.dimensions}-dim, v${identity.version})`;
}

/**
 * Supersede thresholds for known transformer models. all-MiniLM-L6-v2:
 * rewrites of one decision score 0.57-0.94, unrelated decisions 0.04-0.44.
 * Other models get the same default; calibrate with `supersedeThreshold`.
 */
const TRANSFORMER_THRESHOLDS: Record<string, number> = {
  [DEFAULT_EMBEDDING_MODEL]: 0.45,
};
const DEFAULT_TRANSFORMER_THRESHOLD = 0.45;

/**
 * Hashed features share function words and n-grams ("use … for the …"):
 * unrelated decisions score 0.04-0.56, rewrites of one decision 0.84-0.93.
 */
const HASHED_SUPERSEDE_THRESHOLD = 0.75;

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

type FeaturePipeline = (text: string, opts: object) => Promise<{ data: Float32Array }>;

export class TransformerEmbedder implements Embedder {
  private cache: EmbeddingCache;
  private model: string;
  private pipe: FeaturePipeline | null = null;
  private loading: Promise<void> | null = null;
  private width: number | null = null;

  constructor(model: string = DEFAULT_EMBEDDING_MODEL, cacheSize: number = 10000) {
    this.model = model;
    this.cache = new EmbeddingCache(cacheSize);
  }

  /** Loads the model (downloads on first ever use). Throws if unavailable. */
  async load(): Promise<void> {
    if (this.pipe) return;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const pipe = (await pipeline('feature-extraction', this.model, {
          // q8: same quantized weights as the old `quantized: true` option
          dtype: 'q8',
        })) as unknown as FeaturePipeline;
        // The model's output width, not an assumed 384
        const probe = await pipe('dimension probe', { pooling: 'mean', normalize: true });
        this.width = probe.data.length;
        this.pipe = pipe;
      })();
      // A failed load can be retried
      this.loading.catch(() => {
        this.loading = null;
      });
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

  /** The model's output width; known once loaded. */
  get dimensions(): number {
    return this.width ?? EMBEDDING_DIMENSIONS;
  }

  get identity(): EmbedderIdentity {
    return { kind: 'transformer', model: this.model, dimensions: this.dimensions, version: 1 };
  }

  get supersedeThreshold(): number {
    return TRANSFORMER_THRESHOLDS[this.model] ?? DEFAULT_TRANSFORMER_THRESHOLD;
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

  get identity(): EmbedderIdentity {
    return { kind: 'hashed', model: 'hashed', dimensions: EMBEDDING_DIMENSIONS, version: 1 };
  }

  get supersedeThreshold(): number {
    return HASHED_SUPERSEDE_THRESHOLD;
  }
}

// Back-compat alias: LocalEmbedder was the original exported name
export { HashedEmbedder as LocalEmbedder };

// ─────────────────────────────────────────────────────────────
// Factory — no silent fallback
// ─────────────────────────────────────────────────────────────

export interface CreateEmbedderOptions {
  /** The embedder a state database is pinned to; `auto` uses it. */
  pinned?: EmbedderIdentity | null;
  /** The transformer model `auto` tries first (default all-MiniLM-L6-v2). */
  model?: string;
}

function fromIdentity(identity: EmbedderIdentity): Embedder {
  return identity.kind === 'hashed' ? new HashedEmbedder() : new TransformerEmbedder(identity.model);
}

async function loadTransformer(model: string): Promise<TransformerEmbedder> {
  const transformer = new TransformerEmbedder(model);
  try {
    await transformer.load();
  } catch (err) {
    throw new Error(
      `Could not load embedding model '${model}' (${err instanceof Error ? err.message : err}). ` +
        "Pass --embeddings hashed for the offline embedder, or --embeddings auto to fall back to it when the model can't load.",
      { cause: err }
    );
  }
  return transformer;
}

/**
 * Creates the configured embedder:
 * - 'hashed': the offline lexical embedder.
 * - 'auto': the embedder the state database is pinned to, if any;
 *   otherwise the default transformer, falling back to hashed — loudly —
 *   when it can't be loaded.
 * - any other value (or undefined): that transformer model (default
 *   all-MiniLM-L6-v2). A model that can't be loaded is an error, never a
 *   silent switch of embedding space.
 */
export async function createEmbedder(
  embeddingModel?: string,
  options: CreateEmbedderOptions = {}
): Promise<Embedder> {
  if (embeddingModel === 'hashed') {
    return new HashedEmbedder();
  }

  if (embeddingModel === 'auto') {
    if (options.pinned) {
      const embedder = fromIdentity(options.pinned);
      if (embedder instanceof TransformerEmbedder) return loadTransformer(options.pinned.model);
      return embedder;
    }
    const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    try {
      return await loadTransformer(model);
    } catch (err) {
      console.error(
        [
          `⚠️  --embeddings auto: could not load '${model}' (${err instanceof Error ? (err.cause as Error)?.message ?? err.message : err}).`,
          '⚠️  Falling back to the offline hashed embedder. Search is lexical, not semantic, and this',
          '⚠️  state database is pinned to hashed from now on (switching back needs --reembed).',
        ].join('\n')
      );
      return new HashedEmbedder();
    }
  }

  return loadTransformer(embeddingModel || DEFAULT_EMBEDDING_MODEL);
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

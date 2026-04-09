/**
 * Stenographer — Embeddings
 * ONNX-based local embeddings (all-MiniLM-L6-v2)
 * No API keys required
 */

import { getEmbedding } from 'onigasm';
import type { ConversationMessage } from '../types.js';

// ─────────────────────────────────────────────────────────────
// Embedder (ONNX-based, local, no API keys)
// ─────────────────────────────────────────────────────────────

export class LocalEmbedder {
  private model = 'all-MiniLM-L6-v2'; // 384-dim, ~90MB

  async embed(text: string): Promise<number[]> {
    // onigasm loads the WASM model automatically
    const result = await getEmbedding(text);
    return Array.from(result);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  get dimensions(): number {
    return 384; // all-MiniLM-L6-v2 output dim
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
      // Simple eviction: clear half when full
      const entries = Array.from(this.cache.entries());
      this.cache = new Map(entries.slice(0, this.maxSize / 2));
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

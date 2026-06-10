/**
 * Stenographer — GraphRAG Retriever
 * Hybrid search: vector similarity + graph traversal + contextual ranking
 * Inspired by neo4j-graphrag-python patterns
 */

import { HashedEmbedder, VectorIndex, type Embedder } from './embeddings.js';
import type { ConversationMessage, EntityNode, EntityRelation } from '../types.js';

// ─────────────────────────────────────────────────────────────
// GraphRAG Query Engine
// ─────────────────────────────────────────────────────────────

export interface QueryContext {
  query: string;
  sessionId?: string;
  k?: number;
  graphDepth?: number;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  type: 'message' | 'entity' | 'decision' | 'path';
  meta: any;
}

// ─────────────────────────────────────────────────────────────
// Hybrid Retriever (Vector + Graph)
// ─────────────────────────────────────────────────────────────

export class GraphRAGRetriever {
  private embedder: Embedder;
  private vectorIndex: VectorIndex;
  private entityIndex: Map<string, EntityNode>;
  private relationIndex: Map<string, EntityRelation[]>;
  private messages: Map<string, ConversationMessage>;

  constructor(embedder?: Embedder) {
    this.embedder = embedder ?? new HashedEmbedder();
    this.vectorIndex = new VectorIndex();
    this.entityIndex = new Map();
    this.relationIndex = new Map();
    this.messages = new Map();
  }

  /** Swap the embedder (e.g. once the transformer model has loaded). */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  // ─────────────────────────────────────────────────────────
  // Indexing Phase
  // ─────────────────────────────────────────────────────────

  async indexMessage(msg: ConversationMessage, precomputedEmbedding?: number[]): Promise<void> {
    const embedding = precomputedEmbedding ?? (await this.embedder.embed(msg.content));

    // Add to vector index
    this.vectorIndex.add(msg.id, embedding, msg.content, {
      role: msg.role,
      timestamp: msg.timestamp,
      sessionId: msg.sessionId,
    });

    // Store message
    this.messages.set(msg.id, msg);
  }

  indexEntity(entity: EntityNode): void {
    this.entityIndex.set(entity.id, entity);
  }

  indexRelation(from: string, to: string, relation: string): void {
    // Keyed by source entity so graphTraversal can look up outgoing edges
    const existing = this.relationIndex.get(from) || [];
    const now = new Date().toISOString();
    const duplicate = existing.find((r) => r.to === to && r.relation === relation);
    if (duplicate) {
      duplicate.lastSeen = now;
      return;
    }
    existing.push({ from, to, relation, firstSeen: now, lastSeen: now });
    this.relationIndex.set(from, existing);
  }

  // ─────────────────────────────────────────────────────────
  // Retrieval Phase (Hybrid Search)
  // ─────────────────────────────────────────────────────────

  async search(ctx: QueryContext): Promise<RetrievedChunk[]> {
    const { query, k = 5, graphDepth = 2 } = ctx;

    // Step 1: Vector search (semantic similarity)
    const queryEmbedding = await this.embedder.embed(query);
    const vectorResults = this.vectorIndex.search(queryEmbedding, k * 2);

    // Step 2: Extract entities from query
    const queryEntities = this.extractEntitiesFromQuery(query);

    // Step 3: Graph traversal (expand from relevant entities)
    const graphChunks = await this.graphTraversal(queryEntities, graphDepth);

    // Step 4: Merge and re-rank
    const merged = this.mergeResults(vectorResults, graphChunks, k);

    // Step 5: Add context (neighbors, paths)
    return this.enrichWithContext(merged);
  }

  private extractEntitiesFromQuery(query: string): string[] {
    // Simple keyword extraction (would use NER in production)
    const queryLower = query.toLowerCase();
    const relevantEntities: string[] = [];

    for (const [id, entity] of this.entityIndex) {
      if (queryLower.includes(entity.value.toLowerCase())) {
        relevantEntities.push(id);
      }
    }

    return relevantEntities;
  }

  private async graphTraversal(
    startEntities: string[],
    depth: number
  ): Promise<RetrievedChunk[]> {
    const results: RetrievedChunk[] = [];
    const visited = new Set<string>();

    // BFS traversal
    const queue: Array<{ entityId: string; currentDepth: number }> = startEntities.map((e) => ({ entityId: e, currentDepth: 0 }));

    while (queue.length > 0) {
      const { entityId, currentDepth } = queue.shift()!;
      if (visited.has(entityId) || currentDepth > depth) continue;
      visited.add(entityId);

      const entity = this.entityIndex.get(entityId);
      if (!entity) continue;

      // Add entity to results
      results.push({
        id: entity.id,
        content: `${entity.type}: ${entity.value}`,
        score: 1 - (currentDepth * 0.3), // Higher score for closer entities
        type: 'entity',
        meta: { entityType: entity.type, depth: currentDepth },
      });

      // Find relations and queue neighbors
      const relations = this.relationIndex.get(entityId) || [];
      for (const rel of relations) {
        if (!visited.has(rel.to)) {
          queue.push({ entityId: rel.to, currentDepth: currentDepth + 1 });
        }

        // Add relation path as chunk
        results.push({
          id: `${entityId}->${rel.to}`,
          content: `${entity.value} --[${rel.relation}]--> ${rel.to}`,
          score: 0.8 - (currentDepth * 0.2),
          type: 'path',
          meta: { relation: rel.relation, depth: currentDepth },
        });
      }
    }

    return results;
  }

  private mergeResults(
    vectorResults: Array<{ id: string; score: number; text: string; meta: any }>,
    graphResults: RetrievedChunk[],
    k: number
  ): RetrievedChunk[] {
    const merged = new Map<string, RetrievedChunk>();

    // Add vector results
    for (const r of vectorResults) {
      merged.set(r.id, {
        id: r.id,
        content: r.text,
        score: r.score,
        type: 'message',
        meta: r.meta,
      });
    }

    // Merge graph results (boost if already present)
    for (const r of graphResults) {
      const existing = merged.get(r.id);
      if (existing) {
        // Combine scores (weighted average)
        existing.score = (existing.score * 0.7) + (r.score * 0.3);
      } else {
        merged.set(r.id, r);
      }
    }

    // Sort and return top-k
    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  private enrichWithContext(chunks: RetrievedChunk[]): RetrievedChunk[] {
    // Add context: include related messages for each chunk
    return chunks.map((chunk) => {
      if (chunk.type === 'message') {
        const msg = this.messages.get(chunk.id);
        if (msg) {
          // Add recent neighbors as context
          const neighbors = this.getMessageNeighbors(msg);
          if (neighbors.length > 0) {
            chunk.content += `\n\nContext: ${neighbors.join('\n')}`;
          }
        }
      }
      return chunk;
    });
  }

  private getMessageNeighbors(msg: ConversationMessage): string[] {
    const neighbors: string[] = [];
    const msgTime = new Date(msg.timestamp).getTime();

    for (const [id, m] of this.messages) {
      if (id === msg.id) continue;
      const mTime = new Date(m.timestamp).getTime();
      const timeDiff = Math.abs(msgTime - mTime);

      // Within 5 minutes = neighbor
      if (timeDiff < 5 * 60 * 1000) {
        neighbors.push(`${m.role}: ${m.content.slice(0, 100)}...`);
      }
    }

    return neighbors.slice(0, 3);
  }

  // ─────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────

  getStats(): { vectors: number; entities: number; relations: number } {
    let relations = 0;
    for (const edges of this.relationIndex.values()) {
      relations += edges.length;
    }
    return {
      vectors: this.vectorIndex.size(),
      entities: this.entityIndex.size,
      relations,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Cypher Query Builder (for future Neo4j integration)
// ─────────────────────────────────────────────────────────────

export function buildVectorCypher(
  queryEmbedding: number[],
  indexName: string = 'message_embeddings',
  k: number = 5
): string {
  const embeddingList = `[${queryEmbedding.join(',')}]`;
  return `
    CALL db.index.vector.queryNodes('${indexName}', ${Math.floor(k)}, ${embeddingList})
    YIELD node, score
    RETURN node.id AS id, node.content AS content, score
    ORDER BY score DESC
  `;
}

export function buildGraphCypher(
  entityIds: string[],
  depth: number = 2
): string {
  const entityList = entityIds.map((e) => `'${e.replace(/'/g, "\\'")}'`).join(', ');
  return `
    MATCH (e:Entity)
    WHERE e.id IN [${entityList}]
    MATCH path = (e)-[r*1..${Math.max(1, Math.floor(depth))}]-(related:Entity)
    RETURN e.id AS start, nodes(path) AS entities, relationships(path) AS relations
    LIMIT 20
  `;
}

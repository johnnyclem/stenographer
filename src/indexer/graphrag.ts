/**
 * Stenographer — GraphRAG Retriever
 * Hybrid search over messages: vector similarity, entity-graph evidence,
 * recency and importance, fused by reciprocal rank.
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

/**
 * A retrieved message. `score` is its fused reciprocal-rank score; `meta`
 * carries the evidence: vectorScore, matchedEntities, paths (entity-graph
 * edges from the query's entities), importance, seq, and neighbors (the
 * messages around it in its session).
 */
export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  /** Always 'message' since 1.0: entities and paths are evidence in `meta`. */
  type: 'message';
  meta: any;
}

/**
 * Vector search the retriever can delegate to (the engine passes the
 * store's persistent sqlite-vec index): message ids with cosine scores,
 * best first.
 */
export type VectorSearch = (
  embedding: number[],
  k: number,
  sessionId?: string
) => Array<{ id: string; score: number }>;

export interface GraphRAGOptions {
  vectorSearch?: VectorSearch;
}

/** What the retriever knows about an indexed message. */
export interface IndexedMessageInfo {
  entityIds?: string[];
  /** Importance total in [0, 1]. */
  importance?: number;
  /** Ingest order; later messages have higher seq. */
  seq?: number;
}

interface MessageRecord {
  message: ConversationMessage;
  entityIds: string[];
  importance: number;
  seq: number;
}

/** Reciprocal rank fusion constant (Cormack et al.): damps the head of each list. */
const RRF_K = 60;

/**
 * How much each ranked list counts in the fusion. With RRF_K = 60 a list's
 * top entry is worth about as much as moving eight places in another, so
 * recency is a quarter-weight list: it orders near-ties, it doesn't
 * outvote relevance.
 */
const LIST_WEIGHTS = { vector: 1, entity: 1, recency: 0.25 };

/**
 * Importance is an additive prior, at most a tenth of a top rank (for
 * importance 1): enough to lift a decision or correction over an equally
 * relevant remark, not over a more relevant message.
 */
const IMPORTANCE_PRIOR = 0.1 / (RRF_K + 1);

/** Neighbors shown on each side of a retrieved message. */
const NEIGHBORS_PER_SIDE = 1;
const NEIGHBOR_CHARS = 200;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────
// Hybrid Retriever (Vector + Graph)
// ─────────────────────────────────────────────────────────────

export class GraphRAGRetriever {
  private embedder: Embedder;
  private vectorSearch: VectorSearch | null;
  private vectorIndex: VectorIndex;
  private entityIndex: Map<string, EntityNode>;
  private relationIndex: Map<string, EntityRelation[]>;
  private messages: Map<string, MessageRecord>;
  /** Entity id → messages that mention it. */
  private mentions: Map<string, Set<string>>;
  /** Session → its message ids in ingest order. */
  private sessions: Map<string, string[]>;
  private nextSeq = 1;

  constructor(embedder?: Embedder, options: GraphRAGOptions = {}) {
    this.embedder = embedder ?? new HashedEmbedder();
    this.vectorSearch = options.vectorSearch ?? null;
    this.vectorIndex = new VectorIndex();
    this.entityIndex = new Map();
    this.relationIndex = new Map();
    this.messages = new Map();
    this.mentions = new Map();
    this.sessions = new Map();
  }

  /** Swap the embedder (e.g. once the transformer model has loaded). */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  // ─────────────────────────────────────────────────────────
  // Indexing Phase
  // ─────────────────────────────────────────────────────────

  async indexMessage(
    msg: ConversationMessage,
    precomputedEmbedding?: number[],
    info: IndexedMessageInfo = {}
  ): Promise<void> {
    // Vectors live in the delegated index when there is one
    if (!this.vectorSearch) {
      const embedding = precomputedEmbedding ?? (await this.embedder.embed(msg.content));
      if (embedding.some((v) => v !== 0)) {
        this.vectorIndex.add(msg.id, embedding, msg.content, {
          role: msg.role,
          timestamp: msg.timestamp,
          sessionId: msg.sessionId,
        });
      }
    }

    const previous = this.messages.get(msg.id);
    const seq = info.seq ?? previous?.seq ?? this.nextSeq;
    this.nextSeq = Math.max(this.nextSeq, seq + 1);
    if (previous) this.forget(previous);

    const record: MessageRecord = {
      message: msg,
      entityIds: info.entityIds ?? [],
      importance: info.importance ?? 0,
      seq,
    };
    this.messages.set(msg.id, record);
    for (const entityId of record.entityIds) {
      let set = this.mentions.get(entityId);
      if (!set) this.mentions.set(entityId, (set = new Set()));
      set.add(msg.id);
    }
    const session = msg.sessionId ?? '';
    const ids = this.sessions.get(session) ?? [];
    // Keep ingest order; hydration and live indexing arrive in order, so this is an append
    let at = ids.length;
    while (at > 0 && this.messages.get(ids[at - 1])!.seq > seq) at--;
    ids.splice(at, 0, msg.id);
    this.sessions.set(session, ids);
  }

  private forget(record: MessageRecord): void {
    for (const entityId of record.entityIds) this.mentions.get(entityId)?.delete(record.message.id);
    const ids = this.sessions.get(record.message.sessionId ?? '');
    const at = ids?.indexOf(record.message.id) ?? -1;
    if (ids && at >= 0) ids.splice(at, 1);
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

  /**
   * Top-k messages by reciprocal rank fusion of three rankings over one
   * candidate pool (vector hits plus messages that mention the query's
   * entities or their graph neighbors) — vector similarity, entity
   * evidence, recency — plus a small importance prior. Entities and paths
   * are evidence on the messages, not results of their own.
   */
  async search(ctx: QueryContext): Promise<RetrievedChunk[]> {
    const { query, sessionId } = ctx;
    const k = Math.max(1, Math.floor(ctx.k ?? 5));
    const graphDepth = ctx.graphDepth ?? 2;
    const inScope = (id: string) => {
      const record = this.messages.get(id);
      return Boolean(record) && (!sessionId || record!.message.sessionId === sessionId);
    };

    // Step 1: Vector search (semantic similarity), over-fetched as a candidate pool
    const queryEmbedding = await this.embedder.embed(query);
    const vectorHits = (
      this.vectorSearch
        ? this.vectorSearch(queryEmbedding, k * 4, sessionId)
        : this.vectorIndex
            .search(queryEmbedding, k * 4 + (sessionId ? this.vectorIndex.size() : 0))
            .map((r) => ({ id: r.id, score: r.score }))
    ).filter((hit) => inScope(hit.id));
    const vectorScore = new Map(vectorHits.map((hit) => [hit.id, hit.score]));

    // Step 2: Entities named in the query, expanded through the graph
    const reached = this.graphTraversal(this.extractEntitiesFromQuery(query), graphDepth);

    // Step 3: Messages that mention them, by entity evidence
    const entityEvidence = new Map<string, { weight: number; entities: string[] }>();
    for (const [entityId, { depth }] of reached) {
      for (const id of this.mentions.get(entityId) ?? []) {
        if (!inScope(id)) continue;
        const evidence = entityEvidence.get(id) ?? { weight: 0, entities: [] };
        evidence.weight += 1 / (1 + depth);
        evidence.entities.push(entityId);
        entityEvidence.set(id, evidence);
      }
    }

    // Step 4: Fuse — reciprocal rank over vector, entity and recency
    // rankings of one candidate pool, plus the importance prior
    const pool = new Set([...vectorScore.keys(), ...entityEvidence.keys()]);
    const candidates = [...pool].map((id) => this.messages.get(id)!);
    const ranked = {
      vector: vectorHits.map((hit) => hit.id),
      entity: [...entityEvidence.entries()]
        .sort((a, b) => b[1].weight - a[1].weight || this.messages.get(b[0])!.seq - this.messages.get(a[0])!.seq)
        .map(([id]) => id),
      recency: [...candidates].sort((a, b) => b.seq - a.seq).map((r) => r.message.id),
    };
    const fused = new Map<string, number>(candidates.map((r) => [r.message.id, IMPORTANCE_PRIOR * r.importance]));
    for (const [list, ids] of Object.entries(ranked) as Array<[keyof typeof LIST_WEIGHTS, string[]]>) {
      ids.forEach((id, rank) => {
        fused.set(id, fused.get(id)! + LIST_WEIGHTS[list] / (RRF_K + rank + 1));
      });
    }

    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || (vectorScore.get(b[0]) ?? 0) - (vectorScore.get(a[0]) ?? 0))
      .slice(0, k)
      .map(([id, score]) => {
        const record = this.messages.get(id)!;
        const matchedEntities = entityEvidence.get(id)?.entities ?? [];
        return {
          id,
          content: record.message.content,
          score,
          type: 'message',
          meta: {
            role: record.message.role,
            timestamp: record.message.timestamp,
            sessionId: record.message.sessionId,
            seq: record.seq,
            vectorScore: vectorScore.get(id) ?? null,
            importance: record.importance,
            matchedEntities: matchedEntities.map((e) => this.entityIndex.get(e)?.value ?? e),
            paths: this.pathsFrom(matchedEntities, reached),
            neighbors: this.getMessageNeighbors(record),
            ...(record.message.toolCalls ? { toolCalls: record.message.toolCalls } : {}),
            ...(record.message.tags ? { tags: record.message.tags } : {}),
          },
        };
      });
  }

  /** Entities whose value the query names, as whole words. */
  private extractEntitiesFromQuery(query: string): string[] {
    const relevantEntities: string[] = [];
    for (const [id, entity] of this.entityIndex) {
      if (!entity.value.trim()) continue;
      const word = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(entity.value)}(?![\\p{L}\\p{N}_])`, 'iu');
      if (word.test(query)) relevantEntities.push(id);
    }
    return relevantEntities;
  }

  /** Entities reachable from the start set within `depth` hops (BFS), with their distance. */
  private graphTraversal(startEntities: string[], depth: number): Map<string, { depth: number }> {
    const reached = new Map<string, { depth: number }>();
    const queue = startEntities.map((entityId) => ({ entityId, currentDepth: 0 }));

    while (queue.length > 0) {
      const { entityId, currentDepth } = queue.shift()!;
      if (reached.has(entityId) || currentDepth > depth) continue;
      reached.set(entityId, { depth: currentDepth });
      for (const rel of this.relationIndex.get(entityId) ?? []) {
        if (!reached.has(rel.to)) queue.push({ entityId: rel.to, currentDepth: currentDepth + 1 });
      }
    }
    return reached;
  }

  /** Graph edges out of a message's matched entities that stay within the traversal. */
  private pathsFrom(entityIds: string[], reached: Map<string, { depth: number }>): string[] {
    const paths: string[] = [];
    for (const entityId of entityIds) {
      const value = this.entityIndex.get(entityId)?.value ?? entityId;
      for (const rel of this.relationIndex.get(entityId) ?? []) {
        if (reached.has(rel.to)) paths.push(`${value} --[${rel.relation}]--> ${rel.to}`);
      }
    }
    return paths;
  }

  /** The messages just before and after, in the same session's ingest order. */
  private getMessageNeighbors(record: MessageRecord): Array<{ id: string; role: string; content: string }> {
    const ids = this.sessions.get(record.message.sessionId ?? '') ?? [];
    const at = ids.indexOf(record.message.id);
    if (at < 0) return [];
    return [...ids.slice(Math.max(0, at - NEIGHBORS_PER_SIDE), at), ...ids.slice(at + 1, at + 1 + NEIGHBORS_PER_SIDE)]
      .map((id) => this.messages.get(id)!.message)
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content.length > NEIGHBOR_CHARS ? `${m.content.slice(0, NEIGHBOR_CHARS)}…` : m.content,
      }));
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
      vectors: this.vectorSearch ? this.messages.size : this.vectorIndex.size(),
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

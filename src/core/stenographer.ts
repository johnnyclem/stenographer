/**
 * Stenographer — Core Engine
 * Owns the indexing pipeline (tail → score → extract → embed → persist)
 * and implements the StenographerAPI query surface that the MCP and REST
 * servers expose.
 */

import { watch, existsSync, statSync, readdirSync, type FSWatcher } from 'node:fs';
import { join, basename } from 'node:path';
import { Tailer, JsonlAdapter, type LogAdapter } from '../indexer/tailer.js';
import { getAdapter, detectAdapter } from '../indexer/adapters.js';
import { StateStore } from '../store/index.js';
import { ImportanceDetector, extractStructure } from '../indexer/importance.js';
import { GraphRAGRetriever, type QueryContext, type RetrievedChunk } from '../indexer/graphrag.js';
import { createEmbedder, cosineSimilarity, type Embedder } from '../indexer/embeddings.js';
import { RestServer } from '../api/rest.js';
import type {
  StenographerAPI,
  StenographerConfig,
  ConversationMessage,
  Decision,
  Tombstone,
  EntityNode,
  EntityRelation,
  IndexedDecision,
} from '../types.js';

// Calibrated against all-MiniLM-L6-v2: rewrites of the same decision score
// ~0.46-0.94, unrelated decisions in the same conversation score ~0.06
const DEFAULT_SUPERSEDE_THRESHOLD = 0.45;
const DEFAULT_DAEMON_REST_PORT = 8787;

export class Stenographer implements StenographerAPI {
  readonly config: StenographerConfig;
  readonly store: StateStore;
  readonly retriever: GraphRAGRetriever;

  private detector: ImportanceDetector;
  private embedder: Embedder | null = null;
  private tailers: Map<string, Tailer> = new Map();
  private dirWatcher: FSWatcher | null = null;
  private restServer: RestServer | null = null;
  private sessionId: string;
  private indexing: Promise<void> = Promise.resolve();
  private supersedeThreshold: number;

  constructor(config: StenographerConfig) {
    this.config = config;
    this.sessionId = `session_${Date.now()}`;
    this.store = new StateStore(config.statePath || './stenographer.db');
    this.detector = new ImportanceDetector();
    this.retriever = new GraphRAGRetriever();
    this.supersedeThreshold = config.supersedeThreshold ?? DEFAULT_SUPERSEDE_THRESHOLD;
  }

  /** Session scope for queries: single session in file modes, all in watch mode. */
  private get scope(): string | null {
    return this.config.mode === 'watch' ? null : this.sessionId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // ─────────────────────────────────────────────────────────
  // Lifecycle & modes
  // ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.embedder = await createEmbedder(this.config.embeddingModel);
    this.retriever.setEmbedder(this.embedder);

    switch (this.config.mode) {
      case 'live':
        await this.startFileTailer(this.config.logPath, this.sessionId, true);
        break;

      case 'catchup':
        await this.startFileTailer(this.config.logPath, this.sessionId, false);
        await this.flush();
        break;

      case 'watch':
        await this.startDirectoryWatch(this.config.logPath);
        break;

      case 'daemon':
        await this.startFileTailer(this.config.logPath, this.sessionId, true);
        break;

      default:
        throw new Error(`Unknown mode: ${this.config.mode}`);
    }

    // REST API: on by default in daemon mode, opt-in elsewhere
    const restPort =
      this.config.restPort ?? (this.config.mode === 'daemon' ? DEFAULT_DAEMON_REST_PORT : undefined);
    if (restPort !== undefined) {
      const restHost = this.config.restHost ?? '127.0.0.1';
      this.restServer = new RestServer(this);
      await this.restServer.start(restPort, restHost);
      console.error(`🌐 REST API listening on http://${restHost}:${this.restServer.port}`);
    }
  }

  stop(): void {
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
    this.tailers.clear();
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    if (this.restServer) {
      this.restServer.stop();
      this.restServer = null;
    }
    this.store.close();
  }

  /** Waits until every message received so far has been indexed. */
  async flush(): Promise<void> {
    await this.indexing;
  }

  get restPort(): number | null {
    return this.restServer?.port ?? null;
  }

  private async resolveAdapter(filePath: string): Promise<LogAdapter> {
    if (this.config.adapter) {
      return getAdapter(this.config.adapter);
    }
    if (existsSync(filePath)) {
      return detectAdapter(filePath);
    }
    return new JsonlAdapter();
  }

  private async startFileTailer(filePath: string, sessionId: string, follow: boolean): Promise<void> {
    const adapter = await this.resolveAdapter(filePath);
    const tailer = new Tailer(filePath, { sessionId, adapter, follow });
    tailer.on('message', (msg: ConversationMessage) => this.enqueue(msg));
    this.tailers.set(filePath, tailer);
    await tailer.start();
  }

  private async startDirectoryWatch(dirPath: string): Promise<void> {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      throw new Error(`Watch mode requires an existing directory: ${dirPath}`);
    }

    const tailFile = async (name: string) => {
      if (!name.endsWith('.jsonl')) return;
      const filePath = join(dirPath, name);
      if (this.tailers.has(filePath)) return;
      if (!existsSync(filePath)) return;
      // One session per log file, named after it
      await this.startFileTailer(filePath, `session_${basename(name, '.jsonl')}`, true);
    };

    // Tail files already present, then watch for new ones
    for (const name of readdirSync(dirPath)) {
      await tailFile(name);
    }

    this.dirWatcher = watch(dirPath, (_event, name) => {
      if (name) void tailFile(name.toString());
    });
  }

  // ─────────────────────────────────────────────────────────
  // Indexing pipeline
  // ─────────────────────────────────────────────────────────

  private enqueue(msg: ConversationMessage): void {
    // Serialize indexing so messages are processed in arrival order
    this.indexing = this.indexing
      .then(() => this.indexMessage(msg))
      .catch((err) => {
        console.error(`Failed to index message ${msg.id}:`, err);
      });
  }

  private async indexMessage(msg: ConversationMessage): Promise<void> {
    const sessionId = msg.sessionId || this.sessionId;

    // Score importance against recent history (detector only looks at the
    // last 20 messages, so don't load the whole session)
    const history: ConversationMessage[] = this.store
      .getRecentMessages(sessionId, 20)
      .reverse()
      .map((m) => ({
        id: m.id,
        role: m.role as ConversationMessage['role'],
        content: m.content,
        timestamp: m.timestamp,
        sessionId: m.sessionId,
      }));
    const score = this.detector.score(msg, history);

    // Extract entities, decisions, corrections
    const extracted = extractStructure(msg);

    // Embed once; shared by the vector store and the GraphRAG index
    const embedding = await this.embedder!.embed(msg.content);
    await this.retriever.indexMessage(msg, embedding);

    // Index entities (in-memory graph + durable store)
    for (const entity of extracted.entities) {
      const node: EntityNode = {
        id: entity.name,
        type: entity.type,
        value: entity.value,
        firstSeen: msg.timestamp,
        lastSeen: msg.timestamp,
        references: 1,
      };
      this.retriever.indexEntity(node);
      this.store.upsertEntity(node);
    }

    // Entities mentioned in the same message are related — record
    // co-mention edges for graph traversal
    for (let i = 0; i < extracted.entities.length; i++) {
      for (let j = i + 1; j < extracted.entities.length; j++) {
        const from = extracted.entities[i].name;
        const to = extracted.entities[j].name;
        this.retriever.indexRelation(from, to, 'co_mentioned');
        this.retriever.indexRelation(to, from, 'co_mentioned');
        this.store.upsertRelation({
          from,
          to,
          relation: 'co_mentioned',
          firstSeen: msg.timestamp,
          lastSeen: msg.timestamp,
        });
      }
    }

    // Store the message
    this.store.addMessage({
      id: msg.id,
      sessionId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      embedding,
      importanceScore: score,
      entityIds: extracted.entities.map((e) => e.name),
    });

    // Decisions: append-only with supersession. A new decision close enough
    // to an active one is a fresher version of the same fact — the old
    // record is closed (kept, with provenance) and points at its successor.
    for (const decisionText of extracted.decisions) {
      await this.recordDecision(sessionId, decisionText, msg);
    }

    // Corrections: the corrected statement is the new current version.
    // If it matches an active decision, supersede it; either way the
    // correction is recorded as a tombstone with provenance.
    // A message like "actually, we decided to use X" matches both the
    // decision and correction patterns — skip corrections that restate a
    // decision already extracted from this same message.
    const corrections = extracted.corrections.filter(
      (c) => !extracted.decisions.some((d) => c.from.includes(d) || d.includes(c.from))
    );
    for (const correction of corrections) {
      await this.recordCorrection(sessionId, correction.from, msg);
    }
  }

  private async recordDecision(
    sessionId: string,
    description: string,
    msg: ConversationMessage
  ): Promise<void> {
    const newId = `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const match = await this.findSupersededDecision(sessionId, description, msg.id);

    this.store.addDecision(sessionId, {
      id: newId,
      description,
      sourceMessageId: msg.id,
      timestamp: msg.timestamp,
    });

    if (match) {
      this.store.supersedeDecision(match.id, newId);
      this.store.addTombstone(sessionId, {
        id: `tombstone_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        superseded: match.description,
        correctedTo: description,
        reason: 'Superseded by newer decision',
        sourceMessageId: msg.id,
        supersededDecisionId: match.id,
        timestamp: msg.timestamp,
      });
    }
  }

  private async recordCorrection(
    sessionId: string,
    correctedStatement: string,
    msg: ConversationMessage
  ): Promise<void> {
    const match = await this.findSupersededDecision(sessionId, correctedStatement, msg.id);

    let supersededDecisionId: string | undefined;
    let supersededText = '';

    if (match) {
      // The correction is the fresher version of a settled decision:
      // record it as a new decision and close the old one onto it.
      const newId = `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.store.addDecision(sessionId, {
        id: newId,
        description: correctedStatement,
        sourceMessageId: msg.id,
        timestamp: msg.timestamp,
      });
      this.store.supersedeDecision(match.id, newId);
      supersededDecisionId = match.id;
      supersededText = match.description;
    }

    this.store.addTombstone(sessionId, {
      id: `tombstone_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      superseded: supersededText,
      correctedTo: correctedStatement,
      reason: match ? 'Correction superseded prior decision' : 'Correction detected',
      sourceMessageId: msg.id,
      supersededDecisionId,
      timestamp: msg.timestamp,
    });
  }

  /** Finds the active decision most similar to the given text, if above threshold. */
  private async findSupersededDecision(
    sessionId: string,
    text: string,
    excludeSourceMessageId?: string
  ): Promise<IndexedDecision | null> {
    // A message never supersedes decisions it asserted itself
    const active = this.store
      .getActiveDecisions(sessionId)
      .filter((d) => !excludeSourceMessageId || d.sourceMessageId !== excludeSourceMessageId);
    if (active.length === 0) return null;

    const textEmbedding = await this.embedder!.embed(text);
    let best: IndexedDecision | null = null;
    let bestScore = 0;

    for (const decision of active) {
      const decisionEmbedding = await this.embedder!.embed(decision.description);
      const score = cosineSimilarity(textEmbedding, decisionEmbedding);
      if (score > bestScore) {
        bestScore = score;
        best = decision;
      }
    }

    return bestScore >= this.supersedeThreshold ? best : null;
  }

  // ─────────────────────────────────────────────────────────
  // StenographerAPI
  // ─────────────────────────────────────────────────────────

  async getRecentMessages(n: number): Promise<ConversationMessage[]> {
    return this.store.getRecentMessages(this.scope, n).map((m) => ({
      id: m.id,
      role: m.role as ConversationMessage['role'],
      content: m.content,
      timestamp: m.timestamp,
      sessionId: m.sessionId,
    }));
  }

  async getEntities(): Promise<EntityNode[]> {
    return this.store.getEntities(this.scope);
  }

  async getRelations(): Promise<EntityRelation[]> {
    return this.store.getRelations();
  }

  async getActiveDecisions(): Promise<Decision[]> {
    return this.store.getActiveDecisions(this.scope).map(toDecision);
  }

  /** Full decision history including superseded versions, oldest first. */
  async getDecisionHistory(): Promise<Decision[]> {
    return this.store.getAllDecisions(this.scope).map(toDecision);
  }

  /** The supersession chain containing a decision, oldest observation first. */
  async getDecisionChain(id: string): Promise<Decision[]> {
    return this.store.getDecisionChain(id).map(toDecision);
  }

  async getTombstones(): Promise<Tombstone[]> {
    return this.store.getTombstones(this.scope).map((t) => ({
      id: t.id,
      superseded: t.superseded,
      correctedTo: t.correctedTo,
      reason: t.reason,
      createdAt: t.timestamp,
      sourceMessageId: t.sourceMessageId,
      supersededDecisionId: t.supersededDecisionId,
    }));
  }

  async searchSimilar(query: string, k: number): Promise<ConversationMessage[]> {
    if (!this.embedder) {
      this.embedder = await createEmbedder(this.config.embeddingModel);
    }
    const embedding = await this.embedder.embed(query);
    return this.store.searchSimilar(embedding, k, this.scope).map(({ message }) => ({
      id: message.id,
      role: message.role as ConversationMessage['role'],
      content: message.content,
      timestamp: message.timestamp,
      sessionId: message.sessionId,
    }));
  }

  /** Hybrid GraphRAG search (vector + entity graph traversal). */
  async searchGraphRAG(ctx: QueryContext): Promise<RetrievedChunk[]> {
    return this.retriever.search(ctx);
  }

  async buildContextFrame(tokenBudget: number): Promise<string> {
    const messages = this.store.getRecentMessages(this.scope, 10).reverse();
    const decisions = this.store.getActiveDecisions(this.scope);
    const entities = this.store.getEntities(this.scope);

    const parts: string[] = [];

    // Add entities (most compact)
    if (entities.length > 0) {
      parts.push(`## Entities\n${entities.map((e) => `- ${e.value} (${e.type})`).join('\n')}`);
    }

    // Add decisions
    if (decisions.length > 0) {
      parts.push(`## Decisions\n${decisions.map((d) => `- ${d.description}`).join('\n')}`);
    }

    // Add recent messages (most expensive)
    let currentTokens = estimateTokens(parts.join('\n'));
    const recentMessages: string[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgText = `\n${msg.role}: ${msg.content.slice(0, 200)}`;
      const msgTokens = estimateTokens(msgText);

      if (currentTokens + msgTokens > tokenBudget) break;

      recentMessages.unshift(msgText);
      currentTokens += msgTokens;
    }

    if (recentMessages.length > 0) {
      parts.push(`## Recent Messages${recentMessages.join('')}`);
    }

    return parts.join('\n\n');
  }

  async getStatus(): Promise<{
    messagesIndexed: number;
    entities: number;
    decisions: number;
    tombstones: number;
  }> {
    return this.store.getStats(this.scope);
  }
}

function toDecision(d: IndexedDecision): Decision {
  return {
    id: d.id,
    description: d.description,
    alternatives: [],
    firstSeen: d.timestamp,
    superseded: d.superseded,
    supersededBy: d.supersededBy,
    sourceMessageId: d.sourceMessageId,
  };
}

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token
  return Math.ceil(text.length / 4);
}

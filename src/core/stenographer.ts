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
import {
  exportWikiEntries,
  importWikiEntries,
  type ImportResult,
} from '../truth/wiki.js';
import type { TruthFilter } from '../truth/ledger.js';
import type { Objection, ObjectionMode, ObjectionStatus, ObjectionStats } from '../truth/objections.js';
import type {
  Evidence,
  VerifyBy,
  TbEntry,
  UvEntry,
  ProposalEntry,
  AddendumEntry,
  RulingEntry,
  ProposalBody,
  TombstonedLiteral,
} from '../truth/types.js';
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

/** Registered identity for the embedding-similarity supersession detector. */
const DETECTOR_AUTHOR = 'detector:supersession';

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
  private truthMode: 'shadow' | 'assert';
  private objectionMode: ObjectionMode;

  constructor(config: StenographerConfig) {
    this.config = config;
    this.sessionId = `session_${Date.now()}`;
    this.store = new StateStore(config.statePath || './stenographer.db');
    this.detector = new ImportanceDetector();
    this.retriever = new GraphRAGRetriever();
    this.supersedeThreshold = config.supersedeThreshold ?? DEFAULT_SUPERSEDE_THRESHOLD;
    this.truthMode = config.truthMode ?? 'shadow';
    this.objectionMode = config.objectionMode ?? 'shadow';
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

    // Real-time objections (§12): opposing counsel reads the same stream.
    // Catch-up replays history, so its objections are recorded for shadow
    // judging but never delivered as if they were live.
    try {
      this.store.objections.scan(
        msg,
        sessionId,
        this.objectionMode === 'deliver' && this.config.mode === 'catchup' ? 'shadow' : this.objectionMode
      );
    } catch (err) {
      // Counsel failing must never cost the record
      console.error(`Objection scan failed for message ${msg.id}:`, err);
    }

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
      // Detection is proposal-only: the detector may never write truth.
      this.writeSupersessionProposal(sessionId, match, { id: newId, description }, msg);

      if (this.truthMode === 'shadow') {
        // Phase 0: auto-close continues alongside proposals
        this.store.supersedeDecision(match.decision.id, newId);
        this.store.addTombstone(sessionId, {
          id: `tombstone_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          superseded: match.decision.description,
          correctedTo: description,
          reason: 'Superseded by newer decision',
          sourceMessageId: msg.id,
          supersededDecisionId: match.decision.id,
          timestamp: msg.timestamp,
        });
      }
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
    let newId: string | undefined;

    if (match) {
      // The correction is the fresher version of a settled decision:
      // record it as a new decision; closing the old one is truth-mode-gated.
      newId = `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.store.addDecision(sessionId, {
        id: newId,
        description: correctedStatement,
        sourceMessageId: msg.id,
        timestamp: msg.timestamp,
      });
      this.writeSupersessionProposal(
        sessionId,
        match,
        { id: newId, description: correctedStatement },
        msg
      );
      supersededDecisionId = match.decision.id;
      supersededText = match.decision.description;
    }

    if (this.truthMode === 'shadow') {
      // Phase 0: legacy auto-close + inferred tombstone continue
      if (match && newId) {
        this.store.supersedeDecision(match.decision.id, newId);
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
    } else if (!match) {
      // Assert mode, unmatched correction: still worth a reviewable proposal
      this.store.truth.addProposal(
        {
          kind: 'tombstone',
          draft: {
            claim: `Correction detected: ${correctedStatement}`,
            evidence: [{ kind: 'message', ref: msg.id, detail: correctedStatement }],
          },
          signal: { source: 'supersession-detector', detail: 'correction pattern, no matching decision' },
          targetRef: `correction:${msg.id}`,
        },
        {
          author: DETECTOR_AUTHOR,
          provenance: { kind: 'sourceMessageId', ref: msg.id },
          timestamp: msg.timestamp,
        }
      );
    }
  }

  /**
   * Writes a PROPOSAL(kind: tombstone) for a detected supersession — the
   * detector's only write surface into the truth layer. Signing it (an
   * accountable author) is what closes the superseded decision in assert
   * mode; dismissing it costs nothing.
   */
  private writeSupersessionProposal(
    sessionId: string,
    match: { decision: IndexedDecision; score: number },
    successor: { id: string; description: string },
    msg: ConversationMessage
  ): void {
    this.store.truth.addProposal(
      {
        kind: 'tombstone',
        draft: {
          claim: `"${match.decision.description}" is superseded by "${successor.description}"`,
          evidence: [{ kind: 'message', ref: msg.id, detail: successor.description }],
        },
        signal: {
          source: 'supersession-detector',
          score: match.score,
          threshold: this.supersedeThreshold,
        },
        targetRef: match.decision.id,
        meta: {
          supersededDecisionId: match.decision.id,
          successorDecisionId: successor.id,
          sessionId,
        },
      },
      {
        author: DETECTOR_AUTHOR,
        provenance: { kind: 'sourceMessageId', ref: msg.id },
        timestamp: msg.timestamp,
      }
    );
  }

  /** Finds the active decision most similar to the given text, if above threshold. */
  private async findSupersededDecision(
    sessionId: string,
    text: string,
    excludeSourceMessageId?: string
  ): Promise<{ decision: IndexedDecision; score: number } | null> {
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

    return best && bestScore >= this.supersedeThreshold
      ? { decision: best, score: bestScore }
      : null;
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

  // ─────────────────────────────────────────────────────────
  // TB/UV v2 — Asserted truth layer
  // ─────────────────────────────────────────────────────────

  private async ensureEmbedder(): Promise<Embedder> {
    if (!this.embedder) {
      this.embedder = await createEmbedder(this.config.embeddingModel);
    }
    return this.embedder;
  }

  getTruthMode(): 'shadow' | 'assert' {
    return this.truthMode;
  }

  /** The review inbox. */
  async listProposals(
    status?: ProposalBody['status'],
    kind?: ProposalBody['kind']
  ): Promise<ProposalEntry[]> {
    return this.store.truth.listProposals(status, kind);
  }

  /**
   * Mints the TB/UV from a proposal under an accountable signer, and closes
   * the superseded decision the proposal targeted (idempotent in shadow
   * mode, where auto-close already did it).
   */
  async signProposal(
    proposalId: string,
    signedBy: string,
    edits?: Record<string, unknown>,
    agentSessionId?: string
  ): Promise<TbEntry | UvEntry> {
    const proposal = this.store.truth.getEntry(proposalId) as ProposalEntry | null;
    const draft = { ...(proposal?.body.draft ?? {}), ...(edits ?? {}) };
    const text = (draft.claim as string) ?? (draft.assertion as string) ?? '';
    const embedding = text ? await (await this.ensureEmbedder()).embed(text) : undefined;

    const entry = this.store.truth.signProposal(proposalId, signedBy, edits, {
      embedding,
      agentSessionId,
    });

    const meta = proposal?.body.meta;
    if (meta?.supersededDecisionId && meta?.successorDecisionId) {
      this.store.supersedeDecision(
        meta.supersededDecisionId as string,
        meta.successorDecisionId as string
      );
    }
    return entry;
  }

  async dismissProposal(
    proposalId: string,
    dismissedBy: string,
    reason: string
  ): Promise<ProposalEntry> {
    return this.store.truth.dismissProposal(proposalId, dismissedBy, reason);
  }

  /** Direct TB, skipping the proposal path — for authors who already know. */
  async assertTombstone(input: {
    claim: string;
    evidence: Evidence[];
    signedBy: string;
    literals?: TombstonedLiteral[];
    author?: string;
    agentSessionId?: string;
  }): Promise<TbEntry> {
    const embedding = await (await this.ensureEmbedder()).embed(input.claim);
    return this.store.truth.assertTombstone(
      { claim: input.claim, evidence: input.evidence, signedBy: input.signedBy, literals: input.literals },
      {
        author: input.author ?? input.signedBy,
        agentSessionId: input.agentSessionId ?? null,
        embedding,
      }
    );
  }

  async assertUv(input: {
    assertion: string;
    basis: string;
    verifyBy: VerifyBy;
    contests?: string;
    author: string;
    agentSessionId?: string;
  }): Promise<UvEntry> {
    const embedding = await (await this.ensureEmbedder()).embed(input.assertion);
    return this.store.truth.assertUv(
      {
        assertion: input.assertion,
        basis: input.basis,
        verifyBy: input.verifyBy,
        contests: input.contests,
      },
      { author: input.author, agentSessionId: input.agentSessionId ?? null, embedding }
    );
  }

  async resolveUv(
    uvId: string,
    resolution: 'verified' | 'refuted',
    evidence: Evidence[],
    opts: {
      author: string;
      signedBy?: string;
      opinion?: string;
      mintTombstone?: string;
      agentSessionId?: string;
    }
  ): Promise<{
    uv: UvEntry;
    addendum: AddendumEntry;
    tombstone: TbEntry | null;
    ruling: RulingEntry | null;
  }> {
    const uv = this.store.truth.getEntry(uvId) as UvEntry | null;
    const embedding = uv
      ? await (await this.ensureEmbedder()).embed(uv.body.assertion)
      : undefined;
    return this.store.truth.resolveUv(uvId, resolution, evidence, {
      author: opts.author,
      signedBy: opts.signedBy,
      opinion: opts.opinion,
      mintTombstone: opts.mintTombstone,
      agentSessionId: opts.agentSessionId ?? null,
      embedding,
    });
  }

  /** The force path — fails without evidence. */
  async overrideTombstone(
    tbId: string,
    addendum: { evidence: Evidence[]; note?: string },
    opts: { author: string; agentSessionId?: string }
  ): Promise<{ tombstone: TbEntry; addendum: AddendumEntry }> {
    return this.store.truth.overrideTombstone(tbId, addendum, {
      author: opts.author,
      agentSessionId: opts.agentSessionId ?? null,
    });
  }

  async fileRuling(input: {
    kind: 'strike' | 'promotion' | 'contempt';
    opinion: string;
    target: string;
    author: string;
    agentSessionId?: string;
  }): Promise<{ ruling: RulingEntry; conductTombstone: TbEntry | null }> {
    return this.store.truth.fileRuling(
      { kind: input.kind, opinion: input.opinion, target: input.target },
      { author: input.author, agentSessionId: input.agentSessionId ?? null }
    );
  }

  /**
   * Open UVs ranked for opportunistic verification (§6): contested pairs
   * first, then relevance to the caller's working context, then age.
   * `ask`-shaped UVs are deprioritized for agents — they surface in
   * human-facing views instead. (Reference frequency, the PRD's second
   * criterion, needs retrieval tracking — a fast-follow.)
   */
  async getVerificationQueue(
    context?: string,
    k: number = 10
  ): Promise<Array<UvEntry & { queueRank: { contesting: boolean; relevance: number; deprioritized: boolean } }>> {
    const uvs = this.store.truth.getOpenUvs();
    const ctxEmbedding = context ? await (await this.ensureEmbedder()).embed(context) : null;

    const scored = uvs.map((uv) => {
      const contesting = Boolean(uv.body.contests);
      const relevance =
        ctxEmbedding && uv.embedding ? cosineSimilarity(ctxEmbedding, uv.embedding) : 0;
      const deprioritized = uv.body.verifyBy.kind === 'ask';
      return { uv, contesting, relevance, deprioritized };
    });

    scored.sort(
      (a, b) =>
        Number(b.contesting) - Number(a.contesting) ||
        Number(a.deprioritized) - Number(b.deprioritized) ||
        b.relevance - a.relevance ||
        a.uv.createdAt.localeCompare(b.uv.createdAt)
    );

    return scored.slice(0, k).map(({ uv, contesting, relevance, deprioritized }) => {
      const { embedding: _drop, ...entry } = uv;
      return { ...entry, queueRank: { contesting, relevance, deprioritized } };
    });
  }

  /** All TB+UV disputes, for humans and dashboards. */
  async getContestedTruth(): Promise<Array<{ tombstone: TbEntry; contestedBy: UvEntry[] }>> {
    return this.store.truth.getContested();
  }

  /** Truth entries by filter; ties between TB and UV break toward the TB. */
  async getTruth(filter: TruthFilter = 'current'): Promise<Array<TbEntry | UvEntry>> {
    return this.store.truth.getTruth(filter).map(({ embedding: _drop, ...entry }) => entry);
  }

  /**
   * Truth entries relevant to a query, ranked by embedding similarity.
   * Ties between a TB and a UV covering the same subject break toward the
   * TB; UVs are not down-weighted into invisibility — the dragon marker
   * only works if you can see it.
   */
  async searchTruth(
    query: string,
    k: number = 5,
    filter: TruthFilter = 'current'
  ): Promise<Array<(TbEntry | UvEntry) & { relevance: number }>> {
    const entries = this.store.truth.getTruth(filter);
    if (entries.length === 0) return [];
    const queryEmbedding = await (await this.ensureEmbedder()).embed(query);

    return entries
      .map((entry) => {
        const { embedding, ...rest } = entry;
        const relevance = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
        return { ...rest, relevance };
      })
      .sort(
        (a, b) =>
          b.relevance - a.relevance ||
          // Equal relevance: the asserted, proven record wins the tie
          Number(b.type === 'TB') - Number(a.type === 'TB')
      )
      .slice(0, k);
  }

  async getTruthStats(): Promise<{
    tombstones: number;
    uvs: number;
    openUvs: number;
    openProposals: number;
    contested: number;
    rulings: number;
  }> {
    return this.store.truth.getStats();
  }

  // ─────────────────────────────────────────────────────────
  // Real-time objections (§12)
  // ─────────────────────────────────────────────────────────

  getObjectionMode(): ObjectionMode {
    return this.objectionMode;
  }

  /** Objections emitted on /flags; `includeShadow` adds the would-have-beens. */
  async getObjections(
    options: { since?: string; status?: ObjectionStatus; includeShadow?: boolean; limit?: number } = {}
  ): Promise<Objection[]> {
    return this.store.objections.list(options);
  }

  /**
   * The judge rules. Sustained lands in the record as corroboration for
   * the TB; overruled is signal for tightening the matcher. Either way the
   * ruling is an ordinary RULING in the ledger, with a written opinion.
   */
  async ruleOnObjection(
    objectionId: string,
    outcome: 'sustained' | 'overruled',
    opts: { author: string; opinion: string; agentSessionId?: string }
  ): Promise<{ objection: Objection; ruling: RulingEntry }> {
    const objection = this.store.objections.get(objectionId);
    if (!objection) throw new Error(`no such objection: ${objectionId}`);
    if (objection.status !== 'pending') {
      throw new Error(`objection ${objectionId} was already ${objection.status}`);
    }
    const ruling = this.store.truth.fileObjectionRuling(
      { objectionId, tbId: objection.tbId, outcome, opinion: opts.opinion },
      {
        author: opts.author,
        agentSessionId: opts.agentSessionId ?? null,
        provenance: { kind: 'sourceMessageId', ref: objection.messageId },
      }
    );
    this.store.objections.markRuled(objectionId, outcome, ruling.id);
    return { objection: this.store.objections.get(objectionId)!, ruling };
  }

  /** The tuning dial: a falling sustain rate means tighten the matcher. */
  async getObjectionStats(): Promise<ObjectionStats & { mode: ObjectionMode }> {
    return { ...this.store.objections.stats(), mode: this.objectionMode };
  }

  /** §8 export: signed truth only, x-steno namespaced extras. */
  async exportWikiEntries(options: { since?: string; path?: string } = {}): Promise<{
    lines: string[];
    count: number;
  }> {
    return exportWikiEntries(this.store.truth, options);
  }

  /** §8 import: wiki entries keep their ids/authors; conflicts become proposals. */
  async importWikiEntries(input: { path?: string; lines?: string[] }): Promise<ImportResult> {
    return importWikiEntries(this.store.truth, input);
  }

  /**
   * Phase 1 backfill: existing auto-closed supersessions become queryably
   * second-class TBs (author 'migration', signedBy null). No history is
   * rewritten; each can be re-signed or contested like anything else.
   */
  async backfillLegacyTombstones(): Promise<number> {
    let count = 0;
    for (const legacy of this.store.getTombstones(null)) {
      const entry = this.store.truth.backfillLegacyTombstone({
        id: legacy.id,
        superseded: legacy.superseded,
        correctedTo: legacy.correctedTo,
        reason: legacy.reason,
        timestamp: legacy.timestamp,
      });
      if (entry) count++;
    }
    return count;
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

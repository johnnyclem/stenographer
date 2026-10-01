/**
 * Stenographer — Core Engine
 * Owns the indexing pipeline (tail → score → extract → embed → persist)
 * and implements the StenographerAPI query surface that the MCP and REST
 * servers expose.
 */

import { watch, existsSync, statSync, readdirSync, type FSWatcher } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { Tailer, logSessionId, type LogAdapter, type IngestPosition } from '../indexer/tailer.js';
import { getAdapter, matchAdapterFromLines } from '../indexer/adapters.js';
import { contentId } from '../indexer/ids.js';
import { StateStore } from '../store/index.js';
import { ImportanceDetector, extractStructure } from '../indexer/importance.js';
import { GraphRAGRetriever, type QueryContext, type RetrievedChunk } from '../indexer/graphrag.js';
import {
  createEmbedder,
  cosineSimilarity,
  chunkText,
  embeddingText,
  describeEmbedder,
  sameEmbedder,
  type Embedder,
  type EmbedderIdentity,
} from '../indexer/embeddings.js';
import { RestServer } from '../api/rest.js';
import { resolveRestToken, type RestToken } from '../api/auth.js';
import {
  exportWikiEntries,
  importWikiEntries,
  wikiLineTexts,
  type ImportResult,
} from '../truth/wiki.js';
import { appendWikiFile, defaultWikiDir, readWikiFile, type WikiFileTarget } from '../truth/wiki-file.js';
import type { TruthFilter } from '../truth/ledger.js';
import type { Objection, ObjectionMode, ObjectionStatus, ObjectionStats } from '../truth/objections.js';
import { createSinkTransport, type ObjectionTransport } from '../truth/delivery.js';
import { formatProposalNotice, raiseForNotarization } from '../truth/notary.js';
import { ContemptError } from '../truth/ledger.js';
import { SignerRegistry, resolveIdentity, type SignerRole } from '../truth/identity.js';
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
  FiledRulingKind,
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
  IndexedMessage,
} from '../types.js';

// Until the embedder is known; each embedder carries its calibrated threshold
const DEFAULT_SUPERSEDE_THRESHOLD = 0.45;
const DEFAULT_DAEMON_REST_PORT = 8787;

/** index_meta key holding the identity of the embedder the vectors were made with. */
const EMBEDDER_META_KEY = 'embedder';
/** Messages re-embedded per transaction by --reembed. */
const REEMBED_BATCH = 256;

/**
 * The state database holds vectors from another embedder. Mixing embedding
 * spaces makes every similarity score meaningless, so the engine refuses to
 * start rather than silently degrade.
 */
export class EmbedderMismatchError extends Error {
  constructor(
    readonly pinned: EmbedderIdentity,
    readonly requested: EmbedderIdentity
  ) {
    super(
      `state database is pinned to embedder ${describeEmbedder(pinned)}, but this run uses ` +
        `${describeEmbedder(requested)}. Vectors from different embedders aren't comparable. Start with ` +
        `--embeddings ${pinned.kind === 'hashed' ? 'hashed' : pinned.model} (or --embeddings auto), or pass ` +
        '--reembed to re-embed every stored message and truth entry under the new embedder.'
    );
    this.name = 'EmbedderMismatchError';
  }
}

/** Registered identity for the embedding-similarity supersession detector. */
const DETECTOR_AUTHOR = 'detector:supersession';

/**
 * What supersession matching needs, embedded before the commit transaction
 * (which can't await): the decisions active before the message, and the
 * texts it asserts.
 */
interface SupersessionContext {
  candidates: Array<{ decision: IndexedDecision; embedding: number[] }>;
  embeddings: Map<string, number[]>;
}

export class Stenographer implements StenographerAPI {
  readonly config: StenographerConfig;
  readonly store: StateStore;
  readonly retriever: GraphRAGRetriever;

  private detector: ImportanceDetector;
  private embedder: Embedder | null = null;
  /** Keyed by absolute log path; at most one tailer per log. */
  private tailers: Map<string, Tailer> = new Map();
  private dirWatcher: FSWatcher | null = null;
  private stopped = false;
  private restServer: RestServer | null = null;
  private restAuth: RestToken | null = null;
  private sessionId: string;
  private indexing: Promise<void> = Promise.resolve();
  private supersedeThreshold: number;
  private truthMode: 'shadow' | 'assert';
  private objectionMode: ObjectionMode;
  private sinkTransports: ObjectionTransport[];
  private signers: SignerRegistry | null;

  constructor(config: StenographerConfig) {
    this.config = config;
    // Until a line names its harness session (Claude Code's sessionId), a
    // log's session is its basename — stable across restarts, never minted
    this.sessionId = logSessionId(config.logPath);
    this.store = new StateStore(config.statePath || './stenographer.db');
    this.detector = new ImportanceDetector();
    // Vector candidates come from the persistent index (chunks, session partitions)
    this.retriever = new GraphRAGRetriever(undefined, {
      vectorSearch: (embedding, k, sessionId) =>
        this.store.searchSimilar(embedding, k, sessionId).map(({ message, score }) => ({ id: message.id, score })),
    });
    this.supersedeThreshold = config.supersedeThreshold ?? DEFAULT_SUPERSEDE_THRESHOLD;
    this.truthMode = config.truthMode ?? 'shadow';
    this.objectionMode = config.objectionMode ?? 'shadow';
    // Validate sinks up front: a bad or non-loopback URL fails at startup,
    // not at the first objection
    this.sinkTransports = (config.objectionSinks ?? []).map(createSinkTransport);
    this.signers = config.signerRegistry ? SignerRegistry.load(config.signerRegistry) : null;
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
    for (const transport of this.sinkTransports) {
      this.store.objectionDelivery.register(transport);
    }

    await this.ensureEmbedder();

    // A log indexed before keeps its session across restarts
    if (this.config.mode !== 'watch') {
      const checkpoint = this.store.getCheckpoint(this.config.logPath);
      if (checkpoint?.sessionId) this.sessionId = checkpoint.sessionId;
    }
    // Ingestion resumes at each log's checkpoint instead of re-reading it,
    // so the in-memory graph is rebuilt from what earlier runs committed
    await this.hydrateRetriever();

    switch (this.config.mode) {
      case 'live':
      case 'daemon':
        await this.startFileTailer(this.config.logPath, this.sessionId, {
          follow: true,
          replayExisting: true,
        }).start();
        break;

      case 'catchup':
        await this.startFileTailer(this.config.logPath, this.sessionId, {
          follow: false,
          replayExisting: true,
        }).start();
        await this.flush();
        break;

      case 'watch':
        await this.startDirectoryWatch(this.config.logPath);
        break;

      default:
        throw new Error(`Unknown mode: ${this.config.mode}`);
    }

    // REST API: on by default in daemon mode, opt-in elsewhere
    const restPort =
      this.config.restPort ?? (this.config.mode === 'daemon' ? DEFAULT_DAEMON_REST_PORT : undefined);
    if (restPort !== undefined) {
      const restHost = this.config.restHost ?? '127.0.0.1';
      const auth = this.config.restInsecure
        ? null
        : resolveRestToken(this.config.statePath || './stenographer.db', this.config.restToken);
      this.restAuth = auth;
      this.restServer = new RestServer(this, {
        token: auth?.token,
        insecure: this.config.restInsecure,
        allowedHosts: [restHost, ...(this.config.restAllowedHosts ?? [])],
      });
      await this.restServer.start(restPort, restHost);
      console.error(`🌐 REST API listening on http://${restHost}:${this.restServer.port}`);
      if (!auth) {
        console.error('⚠️  REST API has no bearer token (--rest-insecure): any local process can read transcripts');
      } else if (auth.path) {
        console.error(`🔑 REST bearer token${auth.created ? ' created' : ''}: ${auth.path} (send Authorization: Bearer <contents>)`);
      } else {
        console.error(`🔑 REST bearer token: ${this.config.restToken ? 'as configured' : 'in memory only (in-memory state)'}`);
      }
    }
  }

  stop(): void {
    this.stopped = true;
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
    // Undelivered objections stay queued in the store for the next run
    this.store.objectionDelivery.stop();
    this.store.close();
  }

  /** Waits until every message received so far has been indexed. */
  async flush(): Promise<void> {
    await this.indexing;
  }

  get restPort(): number | null {
    return this.restServer?.port ?? null;
  }

  /** The bearer token REST requires; null when REST is off or started with --rest-insecure. */
  get restToken(): string | null {
    return this.restServer ? (this.restAuth?.token ?? null) : null;
  }

  /** Where that token is stored (`<state dir>/rest-token`); null when configured or in memory. */
  get restTokenPath(): string | null {
    return this.restServer ? (this.restAuth?.path ?? null) : null;
  }

  /** The embedder in use (and the state database is pinned to), once started. */
  get embedderIdentity(): EmbedderIdentity | null {
    return this.embedder?.identity ?? null;
  }

  /**
   * Creates the embedder and pins the state database to it. A database
   * whose vectors came from another embedder is refused — unless `reembed`
   * is set, which recomputes every stored vector first. A database from
   * before pinning is assumed to match (with a warning) unless re-embedded.
   */
  private async openEmbedder(): Promise<Embedder> {
    const pinned = this.store.getMeta<EmbedderIdentity>(EMBEDDER_META_KEY);
    const embedder = this.config.embedder ?? (await createEmbedder(this.config.embeddingModel, { pinned }));
    const identity = embedder.identity;
    const legacy = !pinned && this.store.hasEmbeddings();

    if (pinned && !sameEmbedder(pinned, identity) && !this.config.reembed) {
      throw new EmbedderMismatchError(pinned, identity);
    }
    this.store.configureVectors(identity.dimensions);
    if (this.config.reembed) {
      await this.reembed(embedder);
    } else if (legacy) {
      console.error(
        `⚠️  ${this.config.statePath || './stenographer.db'} predates embedder pinning; assuming its vectors ` +
          `came from ${describeEmbedder(identity)}. If they didn't, restart with --reembed.`
      );
    }
    this.store.setMeta(EMBEDDER_META_KEY, identity);
    if (this.config.supersedeThreshold === undefined) {
      this.supersedeThreshold = embedder.supersedeThreshold;
    }
    this.retriever.setEmbedder(embedder);
    return embedder;
  }

  /** Recomputes every stored vector — messages and truth entries — under `embedder`. */
  private async reembed(embedder: Embedder): Promise<void> {
    const started = Date.now();
    let batch: Array<{ id: string; vectors: number[][] }> = [];
    let count = 0;
    const commit = () => {
      const pending = batch;
      batch = [];
      this.store.transaction(() => {
        for (const { id, vectors } of pending) this.store.setMessageEmbeddings(id, vectors);
      });
    };
    for (const message of this.store.listMessageTexts()) {
      batch.push({ id: message.id, vectors: await this.embedMessage(message, embedder) });
      count++;
      if (batch.length >= REEMBED_BATCH) commit();
    }
    commit();

    const truth = this.store.listTruthEmbeddingTexts();
    const vectors = await Promise.all(truth.map((entry) => embedder.embed(entry.text)));
    this.store.transaction(() => {
      truth.forEach((entry, i) => this.store.setTruthEmbedding(entry.id, vectors[i]));
    });
    console.error(
      `🔁 Re-embedded ${count} messages and ${truth.length} truth entries under ` +
        `${describeEmbedder(embedder.identity)} (${Date.now() - started} ms)`
    );
  }

  /**
   * A message's vectors, one per window of its content and tool calls;
   * none when there's nothing to embed. A vector with no direction (text
   * with no features) is dropped: it would score the same against every
   * query.
   */
  private async embedMessage(
    msg: { content: string; toolCalls?: ConversationMessage['toolCalls'] },
    embedder: Embedder = this.embedder!
  ): Promise<number[][]> {
    const text = embeddingText(msg);
    if (!text.trim()) return [];
    const vectors: number[][] = [];
    for (const chunk of chunkText(text)) {
      const vector = await embedder.embed(chunk);
      if (vector.some((v) => v !== 0)) vectors.push(vector);
    }
    return vectors;
  }

  /** Rebuilds the in-memory GraphRAG graph (messages, mentions, entities) from the store. */
  private async hydrateRetriever(): Promise<void> {
    // Collect first: the store's cursor must not stay open across an await
    const pending: Promise<void>[] = [];
    for (const m of this.store.iterateMessages(this.scope, { embeddings: false })) {
      pending.push(this.retriever.indexMessage(toConversationMessage(m), undefined, retrieverInfo(m)));
    }
    await Promise.all(pending);
    for (const entity of this.store.getEntities(this.scope)) {
      this.retriever.indexEntity(entity);
    }
    for (const relation of this.store.getRelations()) {
      this.retriever.indexRelation(relation.from, relation.to, relation.relation);
    }
  }

  /**
   * Creates and registers the tailer for a log. Registration is synchronous,
   * before anything awaits, so two events for one new file can't both start
   * a tailer for it.
   */
  private startFileTailer(
    filePath: string,
    sessionId: string,
    options: { follow: boolean; replayExisting: boolean }
  ): Tailer {
    const source = resolve(filePath);
    const checkpoint = this.store.getCheckpoint(source);
    const tailer = new Tailer(filePath, {
      sessionId: checkpoint?.sessionId ?? sessionId,
      // No --adapter: detect from the first complete lines, not at open,
      // so a log created empty isn't locked into the wrong format
      adapter: this.config.adapter ? getAdapter(this.config.adapter) : undefined,
      detect: matchAdapterFromLines,
      follow: options.follow,
      replayExisting: options.replayExisting,
      resumeFrom: checkpoint,
    });
    tailer.on('message', (msg: ConversationMessage, position: IngestPosition) => this.enqueue(msg, position));
    tailer.on('progress', (position: IngestPosition) => this.enqueueCheckpoint(position, tailer.getSessionId()));
    if (!this.config.adapter) {
      tailer.on('adapter', (adapter: LogAdapter) => {
        console.error(`📄 ${filePath}: ${adapter.constructor.name}`);
      });
    }
    this.tailers.set(source, tailer);
    return tailer;
  }

  private async startDirectoryWatch(dirPath: string): Promise<void> {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      throw new Error(`Watch mode requires an existing directory: ${dirPath}`);
    }

    // Files found by the startup scan hold history, replayed as shadow;
    // files that appear afterwards are live sessions
    let scanning = true;
    const tailFile = (name: string): Promise<void> => {
      if (this.stopped || !name.endsWith('.jsonl')) return Promise.resolve();
      const filePath = join(dirPath, name);
      const source = resolve(filePath);
      if (this.tailers.has(source) || !existsSync(filePath)) return Promise.resolve();
      // One session per log file, named after it. Claude Code names each
      // session log after its session id, and receivers (smallchat's
      // messenger) route objections by that id — so the bare basename is the
      // session id, with no prefix.
      const tailer = this.startFileTailer(filePath, basename(name, '.jsonl'), {
        follow: true,
        replayExisting: scanning,
      });
      tailer.on('removed', () => {
        // The session log is gone: stop following it. If it comes back, the
        // directory watch starts a new tailer, which resumes at the
        // checkpoint only if it is recognizably the same log.
        tailer.stop();
        if (this.tailers.get(source) === tailer) this.tailers.delete(source);
      });
      return tailer.start();
    };

    // Watch first, so a session created during the scan isn't missed
    this.dirWatcher = watch(dirPath, (_event, name) => {
      if (!name) return;
      tailFile(name.toString()).catch((err) => console.error(`⚠️  tailing ${name}:`, err));
    });
    this.dirWatcher.on('error', (err) => console.error(`⚠️  watching ${dirPath}:`, err));

    for (const name of readdirSync(dirPath)) {
      await tailFile(name);
    }
    scanning = false;
  }

  // ─────────────────────────────────────────────────────────
  // Indexing pipeline
  // ─────────────────────────────────────────────────────────

  private enqueue(msg: ConversationMessage, position?: IngestPosition): void {
    // Serialize indexing so messages are processed in arrival order
    this.indexing = this.indexing
      .then(() => (this.stopped ? undefined : this.indexMessage(msg, position)))
      .catch((err) => {
        console.error(`Failed to index message ${msg.id}:`, err);
      });
  }

  /** Lines that produced no message still move the checkpoint, in order. */
  private enqueueCheckpoint(position: IngestPosition, sessionId: string): void {
    this.indexing = this.indexing
      .then(() => {
        if (!this.stopped) this.saveCheckpoint(position, sessionId);
      })
      .catch((err) => {
        console.error(`Failed to checkpoint ${position.source}:`, err);
      });
  }

  private saveCheckpoint(position: IngestPosition, sessionId: string): void {
    this.store.saveCheckpoint({
      source: position.source,
      dev: position.dev,
      inode: position.inode,
      headHash: position.headHash,
      headLength: position.headLength,
      offset: position.offset,
      seq: position.seq,
      sessionId,
    });
  }

  /**
   * Indexes one message in two phases: derive (async — scoring, embedding)
   * with nothing written, then commit the message, everything derived from
   * it and the log checkpoint in one transaction. A restart resumes after
   * the last committed line; a line can't be half-applied or applied twice.
   */
  private async indexMessage(msg: ConversationMessage, position?: IngestPosition): Promise<void> {
    const sessionId = msg.sessionId || this.sessionId;
    // File modes follow one log: its latest session is the query scope
    if (this.config.mode !== 'watch') this.sessionId = sessionId;
    const checkpoint = () => {
      if (position) this.saveCheckpoint(position, sessionId);
    };

    // A line already indexed — a rewritten or re-read log, a transcript
    // copied into a resumed session — is a no-op for every derived record
    const indexed = this.store.getMessage(msg.id);
    if (indexed && indexed.content === msg.content) {
      const moved = indexed.sessionId !== sessionId;
      this.store.transaction(() => {
        if (moved) this.store.reattributeMessage(msg.id, sessionId);
        checkpoint();
      });
      // Now in this session's scope, which the startup hydration didn't cover
      if (moved) {
        await this.retriever.indexMessage({ ...toConversationMessage(indexed), sessionId }, undefined, retrieverInfo(indexed));
      }
      return;
    }

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

    // Extract entities, decisions, corrections — from user and assistant
    // prose only; tool output and tagged records assert nothing
    const extracted = extractStructure(msg);

    // Embed once; shared by the vector store and the GraphRAG index
    const vectors = await this.embedMessage(msg);
    const embedding = vectors[0] ?? [];

    // Each sentence yields a decision or a correction, never both
    const corrections = extracted.corrections;
    const supersession = await this.prepareSupersession(sessionId, msg.id, [
      ...extracted.decisions,
      ...corrections.map((c) => c.to),
    ]);

    // stop() closed the store while this message was being derived
    if (this.stopped) return;

    const nodes: EntityNode[] = extracted.entities.map((entity) => ({
      id: entity.name,
      type: entity.type,
      value: entity.value,
      firstSeen: msg.timestamp,
      lastSeen: msg.timestamp,
      references: 1,
    }));
    const replay = this.config.mode === 'catchup' || position?.replay === true;
    let raised: Objection[] = [];

    this.store.transaction(() => {
      for (const node of nodes) {
        this.store.upsertEntity(node);
      }

      // Entities mentioned in the same message are related — record
      // co-mention edges for graph traversal
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          this.store.upsertRelation({
            from: nodes[i].id,
            to: nodes[j].id,
            relation: 'co_mentioned',
            firstSeen: msg.timestamp,
            lastSeen: msg.timestamp,
          });
        }
      }

      this.store.addMessage({
        id: msg.id,
        sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        embedding,
        ...(vectors.length > 1 ? { chunkEmbeddings: vectors } : {}),
        importanceScore: score,
        entityIds: nodes.map((n) => n.id),
        tags: msg.tags,
        toolCalls: msg.toolCalls ?? (msg.toolCall ? [msg.toolCall] : undefined),
      });

      raised = this.scanForObjections(msg, sessionId, replay);

      // Decisions: append-only with supersession. A new decision close enough
      // to an active one is a fresher version of the same fact — the old
      // record is closed (kept, with provenance) and points at its successor.
      extracted.decisions.forEach((description, index) => {
        this.recordDecision(sessionId, description, index, msg, supersession);
      });

      // Corrections: the corrected statement is the new current version.
      // If it matches an active decision, supersede it; either way the
      // correction is recorded as a tombstone with provenance.
      corrections.forEach((correction, index) => {
        this.recordCorrection(sessionId, correction, index, msg, supersession);
      });

      checkpoint();
    });

    // The in-memory graph follows the committed record
    await this.retriever.indexMessage({ ...msg, sessionId }, embedding, {
      entityIds: nodes.map((n) => n.id),
      importance: score.total,
      seq: this.store.getMessageSeq(msg.id) ?? undefined,
    });
    for (const node of nodes) {
      this.retriever.indexEntity(node);
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        this.retriever.indexRelation(nodes[i].id, nodes[j].id, 'co_mentioned');
        this.retriever.indexRelation(nodes[j].id, nodes[i].id, 'co_mentioned');
      }
    }

    // Push as discovered — don't hold up indexing on a receiver
    if (raised.some((o) => o.delivered)) void this.store.objectionDelivery.pump();
  }

  /**
   * Real-time objections (§12): opposing counsel reads the same stream.
   * Replayed history — catch-up, and whatever a log already held when
   * tailing started, in every mode — is recorded for shadow judging but
   * never delivered as if it were live.
   */
  private scanForObjections(msg: ConversationMessage, sessionId: string, replay: boolean): Objection[] {
    const mode = replay && this.objectionMode === 'deliver' ? 'shadow' : this.objectionMode;
    try {
      // Its own savepoint: counsel failing must never cost the record
      return this.store.transaction(() => this.store.objections.scan(msg, sessionId, mode));
    } catch (err) {
      console.error(`Objection scan failed for message ${msg.id}:`, err);
      return [];
    }
  }

  private recordDecision(
    sessionId: string,
    description: string,
    index: number,
    msg: ConversationMessage,
    supersession: SupersessionContext
  ): void {
    // Derived from the source line, so re-deriving it can't mint a twin
    const newId = contentId('decision', 'decision', msg.id, String(index), description);
    const match = this.matchSuperseded(sessionId, description, supersession);

    this.store.addDecision(sessionId, {
      id: newId,
      description,
      sourceMessageId: msg.id,
      timestamp: msg.timestamp,
    });

    if (match) {
      this.recordSupersession(sessionId, match, { id: newId, description, timestamp: msg.timestamp }, msg, {
        id: contentId('tombstone', 'decision', msg.id, String(index), description),
        reason: 'Superseded by newer decision',
      });
    }
  }

  private recordCorrection(
    sessionId: string,
    correction: { to: string; from: string },
    index: number,
    msg: ConversationMessage,
    supersession: SupersessionContext
  ): void {
    const correctedStatement = correction.to;
    const match = this.matchSuperseded(sessionId, correctedStatement, supersession);
    const tombstoneId = contentId('tombstone', 'correction', msg.id, String(index), correctedStatement);

    if (match) {
      // The correction is the fresher version of a settled decision:
      // record it as a new decision; closing the old one is truth-mode-gated.
      const newId = contentId('decision', 'correction', msg.id, String(index), correctedStatement);
      this.store.addDecision(sessionId, {
        id: newId,
        description: correctedStatement,
        sourceMessageId: msg.id,
        timestamp: msg.timestamp,
      });
      this.recordSupersession(
        sessionId,
        match,
        { id: newId, description: correctedStatement, timestamp: msg.timestamp },
        msg,
        { id: tombstoneId, reason: 'Correction superseded prior decision' }
      );
    } else if (this.truthMode === 'shadow') {
      // Phase 0: the inferred tombstone continues; it names what the
      // correction replaces when the sentence does ("X instead of Y")
      this.store.addTombstone(sessionId, {
        id: tombstoneId,
        superseded: correction.from,
        correctedTo: correctedStatement,
        reason: 'Correction detected',
        sourceMessageId: msg.id,
        timestamp: msg.timestamp,
      });
    } else {
      // Assert mode, unmatched correction: still worth a reviewable proposal
      this.fileDetectorProposal(msg, () =>
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
        )
      );
    }
  }

  /**
   * A new decision and an active one are versions of one fact: the newer
   * closes the older, whichever was indexed first — watch mode replays logs
   * in directory order, not time order. Detection is proposal-only (the
   * detector may never write truth); in shadow mode (Phase 0) the auto-close
   * and the inferred tombstone continue alongside the proposal.
   */
  private recordSupersession(
    sessionId: string,
    match: { decision: IndexedDecision; score: number },
    incoming: { id: string; description: string; timestamp: string },
    msg: ConversationMessage,
    tombstone: { id: string; reason: string }
  ): void {
    const late = isAfter(match.decision.timestamp, incoming.timestamp);
    const [older, newer] = late ? [incoming, match.decision] : [match.decision, incoming];
    this.writeSupersessionProposal(sessionId, older, newer, match.score, msg);

    if (this.truthMode === 'shadow') {
      this.store.supersedeDecision(older.id, newer.id);
      this.store.addTombstone(sessionId, {
        id: tombstone.id,
        superseded: older.description,
        correctedTo: newer.description,
        reason: late ? 'Superseded by a newer version indexed earlier' : tombstone.reason,
        sourceMessageId: msg.id,
        supersededDecisionId: older.id,
        timestamp: msg.timestamp,
      });
    }
  }

  /**
   * Writes a PROPOSAL(kind: tombstone) for a detected supersession — the
   * detector's only write surface into the truth layer. Signing it (an
   * accountable author) is what closes the superseded decision in assert
   * mode; dismissing it costs nothing. Proposals are deduped per
   * (superseded, successor) pair, so a second successor of one decision
   * gets its own proposal instead of being swallowed by the first.
   */
  private writeSupersessionProposal(
    sessionId: string,
    superseded: { id: string; description: string },
    successor: { id: string; description: string },
    score: number,
    msg: ConversationMessage
  ): void {
    this.fileDetectorProposal(msg, () =>
      this.store.truth.addProposal(
        {
          kind: 'tombstone',
          draft: {
            claim: `"${superseded.description}" is superseded by "${successor.description}"`,
            evidence: [{ kind: 'message', ref: msg.id, detail: successor.description }],
          },
          signal: {
            source: 'supersession-detector',
            score,
            threshold: this.supersedeThreshold,
          },
          targetRef: `${superseded.id}->${successor.id}`,
          meta: {
            supersededDecisionId: superseded.id,
            successorDecisionId: successor.id,
            sessionId,
          },
        },
        {
          author: DETECTOR_AUTHOR,
          provenance: { kind: 'sourceMessageId', ref: msg.id },
          timestamp: msg.timestamp,
        }
      )
    );
  }

  /**
   * Files a detector proposal in its own savepoint, inside the message's
   * transaction. The ledger admits every entry the way it admits a live
   * write, and an entry it refuses (one it can't canonicalize, say) must
   * not cost the record it was derived from: the message, its decisions
   * and the checkpoint commit without the proposal.
   */
  private fileDetectorProposal(msg: ConversationMessage, write: () => unknown): void {
    try {
      this.store.transaction(write);
    } catch (err) {
      console.error(`⚠️  The ledger refused a proposal derived from message ${msg.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Applies a signed supersession. When the superseded decision was already
   * closed by another version, the newer of that chain's current version
   * and the signed successor closes the other — so signing every proposal
   * against one decision, in any order, leaves one current version.
   */
  private applySupersession(supersededId: string, successorId: string): void {
    const superseded = this.store.getDecision(supersededId);
    const successor = this.store.getDecision(successorId);
    if (!superseded || !successor || successor.superseded) return;
    if (!superseded.superseded) {
      this.store.supersedeDecision(supersededId, successorId);
      return;
    }
    const chain = this.store.getDecisionChain(supersededId);
    const current = chain[chain.length - 1];
    if (!current || current.superseded || current.id === successorId) return;
    const [older, newer] = isAfter(successor.timestamp, current.timestamp) ? [current, successor] : [successor, current];
    this.store.supersedeDecision(older.id, newer.id);
  }

  /**
   * Where a new decision looks for the versions it supersedes: its session
   * in file modes; in watch mode every session in the database, because
   * each conversation (and each /clear) is a new log, but one project's
   * decisions supersede each other across them.
   */
  private supersessionScope(sessionId: string): string | null {
    return this.config.mode === 'watch' ? null : sessionId;
  }

  /**
   * Embeds, ahead of the commit, the decisions a message could supersede —
   * those active before it; a message never supersedes decisions it
   * asserted itself — and the texts it asserts.
   */
  private async prepareSupersession(
    sessionId: string,
    messageId: string,
    texts: string[]
  ): Promise<SupersessionContext> {
    const context: SupersessionContext = { candidates: [], embeddings: new Map() };
    if (texts.length === 0) return context;

    const active = this.store
      .getActiveDecisions(this.supersessionScope(sessionId))
      .filter((d) => d.sourceMessageId !== messageId);
    if (active.length === 0) return context;

    for (const decision of active) {
      context.candidates.push({ decision, embedding: await this.embedder!.embed(decision.description) });
    }
    for (const text of texts) {
      if (!context.embeddings.has(text)) context.embeddings.set(text, await this.embedder!.embed(text));
    }
    return context;
  }

  /** The still-active candidate most similar to the given text, if above threshold. */
  private matchSuperseded(
    sessionId: string,
    text: string,
    supersession: SupersessionContext
  ): { decision: IndexedDecision; score: number } | null {
    const textEmbedding = supersession.embeddings.get(text);
    if (!textEmbedding) return null;

    // Re-read inside the transaction: an earlier text in this message (or a
    // signing while this one was being derived) may have closed a candidate
    const active = new Set(this.store.getActiveDecisions(this.supersessionScope(sessionId)).map((d) => d.id));
    let best: IndexedDecision | null = null;
    let bestScore = 0;

    for (const { decision, embedding } of supersession.candidates) {
      if (!active.has(decision.id)) continue;
      const score = cosineSimilarity(textEmbedding, embedding);
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
    return this.store.getRecentMessages(this.scope, n).map(toConversationMessage);
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
    const embedding = await (await this.ensureEmbedder()).embed(query);
    return this.store.searchSimilar(embedding, k, this.scope).map(({ message }) => toConversationMessage(message));
  }

  /**
   * Hybrid GraphRAG search: messages ranked by reciprocal rank fusion of
   * vector similarity, entity-graph evidence, recency and importance.
   */
  async searchGraphRAG(ctx: QueryContext): Promise<RetrievedChunk[]> {
    await this.ensureEmbedder();
    return this.retriever.search({ ...ctx, sessionId: ctx.sessionId ?? this.scope ?? undefined });
  }

  /**
   * A markdown frame of the current state for an LLM, within `tokenBudget`
   * (estimated at 4 characters per token) across every section. Each
   * section has a share of the budget — recent messages 50%, decisions 35%,
   * entities 15% — and what one leaves unused passes to the others. Within
   * a section, items get room in priority order: the newest message, then
   * the rest of the recent window by importance; the newest decisions; the
   * most-referenced entities. Messages and decisions are shown in order.
   */
  async buildContextFrame(tokenBudget: number): Promise<string> {
    const limit = Math.max(0, Math.floor(tokenBudget)) * CHARS_PER_TOKEN;
    const recent = this.store.getRecentMessages(this.scope, FRAME_MESSAGE_WINDOW); // newest first
    const decisions = this.store.getActiveDecisions(this.scope); // oldest first
    const entities = this.store
      .getEntities(this.scope)
      .sort((a, b) => b.references - a.references || b.lastSeen.localeCompare(a.lastSeen));

    const sections: FrameSection[] = [
      {
        header: '## Entities',
        items: entities.map((e) => `- ${clip(e.value, FRAME_ENTITY_CHARS)} (${e.type})`),
        priority: entities.map((_, i) => i),
        share: 0.15,
      },
      {
        header: '## Decisions',
        items: decisions.map((d) => `- ${clip(d.description, FRAME_ITEM_CHARS)}`),
        priority: decisions.map((_, i) => decisions.length - 1 - i),
        share: 0.35,
      },
      {
        header: '## Recent Messages',
        // Shown oldest first
        items: [...recent].reverse().map((m) => `${m.role}: ${clip(embeddingText(m), FRAME_ITEM_CHARS)}`),
        priority: recent
          .map((m, age) => ({ age, importance: m.importanceScore.total }))
          .sort((a, b) => (a.age === 0 ? -1 : b.age === 0 ? 1 : b.importance - a.importance || a.age - b.age))
          .map(({ age }) => recent.length - 1 - age),
        share: 0.5,
      },
    ];

    // Fill order: messages, decisions, entities — by share, then leftovers
    const fillOrder = [sections[2], sections[1], sections[0]];
    let remaining = limit;
    for (const section of fillOrder) remaining -= fillSection(section, Math.min(remaining, Math.floor(limit * section.share)));
    for (const section of fillOrder) remaining -= fillSection(section, remaining);

    return sections
      .filter((section) => section.chosen && section.chosen.size > 0)
      .map((section) => {
        const shown = [...section.chosen!].sort((a, b) => a - b).map((i) => section.items[i]);
        return [section.header, ...shown].join('\n');
      })
      .join('\n\n');
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
      this.embedder = await this.openEmbedder();
    }
    return this.embedder;
  }

  getTruthMode(): 'shadow' | 'assert' {
    return this.truthMode;
  }

  /**
   * Validates an identity for an act only `roles` may perform: canonical,
   * never anonymous or reserved, and — when a signer registry is configured
   * — listed with one of those roles. Returns the canonical spelling.
   */
  resolveIdentity(raw: string, roles: SignerRole[], what: string): string {
    return resolveIdentity(raw, roles, what, this.signers);
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
   * mode, where auto-close already did it). Agent drafts are refused here:
   * they mint only through notarizeProposal.
   */
  async signProposal(
    proposalId: string,
    signedBy: string,
    edits?: Record<string, unknown>,
    agentSessionId?: string
  ): Promise<TbEntry | UvEntry> {
    const signer = this.resolveIdentity(signedBy, ['human'], 'signer');
    return this.mintProposal(proposalId, signer, edits, { agentSessionId });
  }

  /**
   * An agent drafts a tombstone it may not sign (§15). The draft is raised
   * to the operator's receivers and printed to stderr; it mints only when a
   * person notarizes it.
   */
  async draftTombstone(input: {
    claim: string;
    evidence: Evidence[];
    literals?: TombstonedLiteral[];
    rationale?: string;
    targetRef?: string;
    proposedBy: string;
    agentSessionId?: string;
  }): Promise<{
    proposal: ProposalEntry;
    /** Set when the drafter already had an open draft for this targetRef: that one is returned, unchanged. */
    dedupedInto?: string;
    raisedTo: string[];
    undelivered: Array<{ url: string; error?: string }>;
  }> {
    const proposedBy = this.resolveIdentity(input.proposedBy, ['agent', 'human'], 'drafter');
    const prior = input.targetRef
      ? this.store.truth.findOpenProposal({
          kind: 'tombstone',
          targetRef: input.targetRef,
          author: proposedBy,
          requiresNotary: true,
        })
      : null;
    const embedding = await (await this.ensureEmbedder()).embed(input.claim);
    const proposal = this.store.truth.draftTombstone(input, {
      author: proposedBy,
      agentSessionId: input.agentSessionId ?? null,
      embedding,
    });
    // Already raised when it was first drafted — don't page the notary twice
    if (prior && prior.id === proposal.id) {
      return { proposal, dedupedInto: proposal.id, raisedTo: [], undelivered: [] };
    }
    console.error(formatProposalNotice(proposal));
    const results = await raiseForNotarization(
      this.config.objectionSinks ?? [],
      proposal,
      this.notarizeUrl(proposal.id)
    );
    return {
      proposal,
      raisedTo: results.filter((r) => !r.error).map((r) => r.url),
      undelivered: results.filter((r) => r.error),
    };
  }

  /**
   * The notary path: a person approves an agent-drafted proposal. Callers
   * (REST with the notary secret, the interactive CLI) are responsible for
   * establishing that a person is on the other end.
   */
  async notarizeProposal(
    proposalId: string,
    notary: string,
    edits?: Record<string, unknown>
  ): Promise<TbEntry | UvEntry> {
    const signer = this.resolveIdentity(notary, ['human'], 'notary');
    return this.mintProposal(proposalId, signer, edits, { notarized: true });
  }

  /** Where a notary approves a proposal over REST, when the API is up. */
  notarizeUrl(proposalId: string): string | undefined {
    const port = this.restServer?.port;
    if (!port) return undefined;
    const host = this.config.restHost && this.config.restHost !== '0.0.0.0' ? this.config.restHost : '127.0.0.1';
    return `http://${host}:${port}/proposals/${encodeURIComponent(proposalId)}/notarize`;
  }

  private async mintProposal(
    proposalId: string,
    signedBy: string,
    edits: Record<string, unknown> | undefined,
    opts: { agentSessionId?: string; notarized?: boolean }
  ): Promise<TbEntry | UvEntry> {
    const proposal = this.store.truth.getEntry(proposalId) as ProposalEntry | null;
    const draft = { ...(proposal?.body.draft ?? {}), ...(edits ?? {}) };
    const text = (draft.claim as string) ?? (draft.assertion as string) ?? '';
    const embedding = text ? await (await this.ensureEmbedder()).embed(text) : undefined;

    const entry = this.store.truth.signProposal(proposalId, signedBy, edits, {
      embedding,
      agentSessionId: opts.agentSessionId,
      notarized: opts.notarized,
    });

    const meta = proposal?.body.meta;
    if (meta?.supersededDecisionId && meta?.successorDecisionId) {
      this.applySupersession(meta.supersededDecisionId as string, meta.successorDecisionId as string);
    }
    return entry;
  }

  async dismissProposal(
    proposalId: string,
    dismissedBy: string,
    reason: string
  ): Promise<ProposalEntry> {
    const dismisser = this.resolveIdentity(dismissedBy, ['human'], 'dismisser');
    return this.store.truth.dismissProposal(proposalId, dismisser, reason);
  }

  /**
   * Direct TB, skipping the proposal path — for authors who already know.
   * The signer may be a person or (single-user setups) an agent identity;
   * a registry decides which, when configured.
   */
  async assertTombstone(input: {
    claim: string;
    evidence: Evidence[];
    signedBy: string;
    literals?: TombstonedLiteral[];
    author?: string;
    agentSessionId?: string;
  }): Promise<TbEntry> {
    const signedBy = this.resolveIdentity(input.signedBy, ['human', 'agent'], 'signer');
    const author = input.author ? this.resolveIdentity(input.author, ['human', 'agent'], 'author') : signedBy;
    const embedding = await (await this.ensureEmbedder()).embed(input.claim);
    return this.store.truth.assertTombstone(
      { claim: input.claim, evidence: input.evidence, signedBy, literals: input.literals },
      {
        author,
        agentSessionId: input.agentSessionId ?? null,
        embedding,
      }
    );
  }

  async assertUv(input: {
    assertion: string;
    basis: string;
    verifyBy: VerifyBy;
    contests?: string | null;
    author: string;
    agentSessionId?: string;
  }): Promise<UvEntry> {
    const author = this.resolveIdentity(input.author, ['human', 'agent'], 'author');
    const embedding = await (await this.ensureEmbedder()).embed(input.assertion);
    return this.store.truth.assertUv(
      {
        assertion: input.assertion,
        basis: input.basis,
        verifyBy: input.verifyBy,
        contests: input.contests,
      },
      { author, agentSessionId: input.agentSessionId ?? null, embedding }
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
      /** False refuses any resolution that would mint a TB (the MCP agent profile). */
      allowMint?: boolean;
    }
  ): Promise<{
    uv: UvEntry;
    addendum: AddendumEntry;
    tombstone: TbEntry | null;
    ruling: RulingEntry | null;
  }> {
    const author = this.resolveIdentity(opts.author, ['human', 'agent'], 'resolver');
    const signedBy = opts.signedBy ? this.resolveIdentity(opts.signedBy, ['human'], 'signer') : undefined;
    const uv = this.store.truth.getEntry(uvId) as UvEntry | null;
    const embedding = uv
      ? await (await this.ensureEmbedder()).embed(uv.body.assertion)
      : undefined;
    return this.store.truth.resolveUv(uvId, resolution, evidence, {
      author,
      signedBy,
      opinion: opts.opinion,
      mintTombstone: opts.mintTombstone,
      agentSessionId: opts.agentSessionId ?? null,
      allowMint: opts.allowMint,
      embedding,
    });
  }

  /** The force path — fails without evidence. A person's act. */
  async overrideTombstone(
    tbId: string,
    addendum: { evidence: Evidence[]; note?: string },
    opts: { author: string; agentSessionId?: string }
  ): Promise<{ tombstone: TbEntry; addendum: AddendumEntry }> {
    return this.store.truth.overrideTombstone(tbId, addendum, {
      author: this.resolveIdentity(opts.author, ['human'], 'author'),
      agentSessionId: opts.agentSessionId ?? null,
    });
  }

  /** Rulings are judgments: a person's act. */
  async fileRuling(input: {
    kind: FiledRulingKind;
    opinion: string;
    target: string;
    author: string;
    agentSessionId?: string;
  }): Promise<{ ruling: RulingEntry; conductTombstone: TbEntry | null }> {
    return this.store.truth.fileRuling(
      { kind: input.kind, opinion: input.opinion, target: input.target },
      {
        author: this.resolveIdentity(input.author, ['human'], 'ruling author'),
        agentSessionId: input.agentSessionId ?? null,
      }
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
    const ctxEmbedding = context ? await (await this.ensureEmbedder()).embed(context) : null;
    const uvs = ctxEmbedding ? await this.withEmbeddings(this.store.truth.getOpenUvs()) : this.store.truth.getOpenUvs();

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
    const found = this.store.truth.getTruth(filter);
    if (found.length === 0) return [];
    const queryEmbedding = await (await this.ensureEmbedder()).embed(query);
    const entries = await this.withEmbeddings(found);

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

  /**
   * Fills in the embedding of entries that have none (imported by a caller
   * without an embedder, or before 1.0 embedded imports) and caches it, so
   * relevance ranking never scores a relevant entry 0 for lack of one.
   */
  private async withEmbeddings<T extends (TbEntry | UvEntry) & { embedding: number[] | null }>(entries: T[]): Promise<T[]> {
    if (entries.every((e) => e.embedding)) return entries;
    const embedder = await this.ensureEmbedder();
    const filled: T[] = [];
    for (const entry of entries) {
      if (entry.embedding) {
        filled.push(entry);
        continue;
      }
      const embedding = await embedder.embed(entry.type === 'TB' ? entry.body.claim : entry.body.assertion);
      this.store.truth.cacheEmbedding(entry.id, embedding);
      filled.push({ ...entry, embedding });
    }
    return filled;
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
   * The judge is a person, and never the session the objection was raised
   * against: the defendant doesn't rule on its own objection.
   */
  async ruleOnObjection(
    objectionId: string,
    outcome: 'sustained' | 'overruled',
    opts: { author: string; opinion: string; agentSessionId?: string }
  ): Promise<{ objection: Objection; ruling: RulingEntry }> {
    const author = this.resolveIdentity(opts.author, ['human'], 'judge');
    const objection = this.store.objections.get(objectionId);
    if (!objection) throw new Error(`no such objection: ${objectionId}`);
    if (objection.status !== 'pending') {
      throw new Error(`objection ${objectionId} was already ${objection.status}`);
    }
    if (opts.agentSessionId && opts.agentSessionId.trim() === objection.sessionId.trim()) {
      throw new ContemptError(
        `contempt of corpus: session ${objection.sessionId} cannot rule on objection ${objectionId} raised against it`
      );
    }
    const ruling = this.store.truth.fileObjectionRuling(
      { objectionId, tbId: objection.tbId, outcome, opinion: opts.opinion },
      {
        author,
        agentSessionId: opts.agentSessionId ?? null,
        provenance: { kind: 'sourceMessageId', ref: objection.messageId },
      }
    );
    this.store.objections.markRuled(objectionId, outcome, ruling.id);
    return { objection: this.store.objections.get(objectionId)!, ruling };
  }

  /**
   * Adds a delivery target at runtime — used by the MCP server to push
   * objections to its attached client as Claude Code channel events.
   */
  addObjectionTransport(transport: ObjectionTransport): void {
    this.store.objectionDelivery.register(transport);
  }

  /** Delivers whatever is due now (interrupting receivers, full batches). */
  async deliverObjections(): Promise<void> {
    await this.store.objectionDelivery.pump();
  }

  /**
   * The tuning dial: a falling sustain rate means tighten the matcher.
   * `deadLettered` counts objections a receiver refused for good or never
   * took within its attempts.
   */
  async getObjectionStats(): Promise<ObjectionStats & { mode: ObjectionMode; deadLettered: number }> {
    return {
      ...this.store.objections.stats(),
      mode: this.objectionMode,
      deadLettered: this.store.objectionDelivery.deadLetterCount(),
    };
  }

  /** A file in the wiki directory (`wikiDir`, default `<state dir>/wiki`); never the state file. */
  private wikiFile(file: string): WikiFileTarget {
    const statePath = this.config.statePath || './stenographer.db';
    const memory = statePath === ':memory:';
    return {
      dir: this.config.wikiDir ?? defaultWikiDir(memory ? './stenographer.db' : statePath),
      file,
      statePath: memory ? undefined : statePath,
    };
  }

  /**
   * §8 export, truth format v2 (spec/truth-format): this ledger's
   * hash-chained line stream — TB, UV, and the addenda and rulings that
   * change a status, with a TRANSITION line for each change. Never
   * proposals. With `file` (inside the wiki directory, and this ledger's
   * own: one writer per file), appends the lines the file doesn't hold yet;
   * without it, returns the lines after `sinceSeq` (or, deprecated, from
   * the first line written after `since`).
   */
  async exportWikiEntries(options: { sinceSeq?: number; since?: string; file?: string } = {}): Promise<{
    lines?: string[];
    count: number;
    lastSeq: number;
    skipped: Array<{ id: string; error: string }>;
    file?: string;
    appended?: number;
    present?: number;
  }> {
    if (options.file === undefined) {
      return exportWikiEntries(this.store.truth, { sinceSeq: options.sinceSeq, since: options.since });
    }
    if (options.sinceSeq !== undefined || options.since !== undefined) {
      throw new Error('a file export appends whatever the file lacks: sinceSeq and since apply to inline exports only');
    }
    const target = this.wikiFile(options.file);
    const stream = exportWikiEntries(this.store.truth);
    const written = appendWikiFile(target, stream.lines);
    return {
      file: target.file,
      count: stream.count,
      lastSeq: stream.lastSeq,
      appended: written.appended,
      present: written.present,
      skipped: stream.skipped,
    };
  }

  /**
   * §8 import: one transaction per file, whose v2 lines must chain.
   * Entries keep their ids and authors; a TB lands as truth only signed and
   * verifiable (hash-chained, and a signer the registry lists, when there
   * is one) — otherwise as a reconciliation proposal. Status changes are
   * applied from the addenda and rulings that cause them. Imported claims
   * and assertions are embedded, so search ranks them.
   */
  async importWikiEntries(input: { file?: string; lines?: string[] }): Promise<ImportResult> {
    const lines = input.lines ?? readWikiFile(this.wikiFile(input.file ?? ''));
    const embedder = await this.ensureEmbedder();
    const embeddings = new Map<string, number[]>();
    for (const [id, text] of wikiLineTexts(lines)) {
      // Only what this import can add: a re-import embeds nothing
      if (!this.store.truth.getEntry(id)) embeddings.set(id, await embedder.embed(text));
    }
    return importWikiEntries(this.store.truth, { lines }, { signers: this.signers, embeddings });
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

function retrieverInfo(m: IndexedMessage): { entityIds: string[]; importance: number; seq?: number } {
  return { entityIds: m.entityIds, importance: m.importanceScore.total, seq: m.seq };
}

function toConversationMessage(m: IndexedMessage): ConversationMessage {
  return {
    id: m.id,
    role: m.role as ConversationMessage['role'],
    content: m.content,
    timestamp: m.timestamp,
    sessionId: m.sessionId,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.tags ? { tags: m.tags } : {}),
  };
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

/** Whether timestamp `a` is strictly later than `b`; unparseable timestamps are never later. */
function isAfter(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

// Context frame: ~4 characters per token
const CHARS_PER_TOKEN = 4;
const FRAME_MESSAGE_WINDOW = 20;
const FRAME_ITEM_CHARS = 200;
const FRAME_ENTITY_CHARS = 48;

interface FrameSection {
  header: string;
  items: string[];
  /** Item indexes, most deserving of room first. */
  priority: number[];
  share: number;
  chosen?: Set<number>;
}

/** Adds the section's items that fit in `allowance` characters, in priority order; returns what they cost. */
function fillSection(section: FrameSection, allowance: number): number {
  const chosen = (section.chosen ??= new Set());
  let spent = 0;
  for (const index of section.priority) {
    if (chosen.has(index)) continue;
    // The first item also pays for the header and the blank line before it
    const cost = section.items[index].length + 1 + (chosen.size === 0 ? section.header.length + 2 : 0);
    if (cost > allowance - spent) continue;
    chosen.add(index);
    spent += cost;
  }
  return spent;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

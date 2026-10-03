/**
 * Stenographer — SQLite State Store
 * Durable indexed state for conversation history.
 *
 * Vector search is backed by sqlite-vec when the extension loads
 * (prebuilt binaries per platform); otherwise falls back to brute-force
 * cosine over stored embeddings.
 */

import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrate } from './migrations.js';
import { cosineSimilarity, EMBEDDING_DIMENSIONS } from '../indexer/embeddings.js';
import { TruthLedger } from '../truth/ledger.js';
import { UvAttestations } from '../truth/attestations.js';
import type { AgentClassifier } from '../truth/quorum.js';
import { ObjectionLog } from '../truth/objections.js';
import { ObjectionDispatcher } from '../truth/delivery.js';
import type {
  IndexedMessage,
  IndexedDecision,
  IndexedTombstone,
  EntityNode,
  EntityRelation,
} from '../types.js';

export interface StateStoreOptions {
  dimensions?: number;
  /** Who the truth ledger treats as an agent (TruthLedgerOptions.isAgent). Default: the `agent:` prefix. */
  isAgent?: AgentClassifier;
}

/** Everything but the embedding blob, for reads that don't need vectors. */
const MESSAGE_COLUMNS_WITHOUT_EMBEDDING = `id, session_id, role, content, timestamp, importance_state_delta,
  importance_reference_freq, importance_trajectory_disc, importance_total, entity_ids, tags, tool_calls, seq`;

/** sqlite-vec's cap on k in one KNN query. */
const VEC_MAX_K = 4096;

/** The vector row id of a message's `index`th chunk; the first chunk uses the message id. */
function chunkId(messageId: string, index: number): string {
  return index === 0 ? messageId : `${messageId}#${index}`;
}

function toBlob(vectors: number[][]): Buffer {
  const flat = new Float32Array(vectors.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const v of vectors) {
    flat.set(v, offset);
    offset += v.length;
  }
  // Serialize the underlying bytes — Buffer.from(typedArray) without
  // .buffer would truncate each float to a single byte
  return Buffer.from(flat.buffer);
}

/** A zero vector has no direction: cosine distance to it is undefined. */
function hasDirection(vector: number[]): boolean {
  return vector.some((v) => v !== 0);
}

/**
 * How far a log has been indexed. `offset` is the byte just past the last
 * line whose records are committed; `dev`/`inode` and the hash of the first
 * `headLength` bytes identify the file, so a restart can tell the same log
 * grown from a truncated, rotated or replaced one.
 */
export interface IngestCheckpoint {
  /** Absolute path of the log. */
  source: string;
  dev: string;
  inode: string;
  headHash: string;
  headLength: number;
  offset: number;
  /** Lines consumed up to `offset`. */
  seq: number;
  /** Session the log's messages are indexed under. */
  sessionId: string | null;
  updatedAt: string;
}

export class StateStore {
  private db: Database.Database;
  private dimensions: number;
  private vecEnabled: boolean = false;
  private truthLedger: TruthLedger | null = null;
  private isAgent: AgentClassifier | undefined;
  private uvAttestations: UvAttestations | null = null;
  private objectionLog: ObjectionLog | null = null;
  private dispatcher: ObjectionDispatcher | null = null;
  private statements: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string, options: StateStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.dimensions = options.dimensions ?? 0;
    this.isAgent = options.isAgent;
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
    } catch (err) {
      console.error(
        `⚠️  sqlite-vec unavailable (${err instanceof Error ? err.message : err}); ` +
          'vector search will use brute-force cosine'
      );
    }
    this.init();
  }

  /** Whether vector search is index-backed (sqlite-vec) or brute-force. */
  get vectorSearchBackend(): 'sqlite-vec' | 'brute-force' {
    return this.vecEnabled ? 'sqlite-vec' : 'brute-force';
  }

  /** The append-only asserted-truth ledger (TB/UV v2), on the same database. */
  get truth(): TruthLedger {
    if (!this.truthLedger) {
      this.truthLedger = new TruthLedger(this.db, { isAgent: this.isAgent });
    }
    return this.truthLedger;
  }

  /** Agents' verdicts on open UVs, until a quorum settles them: operational state beside the ledger. */
  get attestations(): UvAttestations {
    if (!this.uvAttestations) {
      this.uvAttestations = new UvAttestations(this.db, this.truth);
    }
    return this.uvAttestations;
  }

  /** Real-time objections (§12): operational log beside the ledger. */
  get objections(): ObjectionLog {
    if (!this.objectionLog) {
      this.objectionLog = new ObjectionLog(this.db, this.truth);
    }
    return this.objectionLog;
  }

  /** Webhook/channel delivery of objections, with durable per-sink state. */
  get objectionDelivery(): ObjectionDispatcher {
    if (!this.dispatcher) {
      this.dispatcher = new ObjectionDispatcher(this.db, this.objections);
    }
    return this.dispatcher;
  }

  private init(): void {
    // WAL: readers (the notary CLI, a second process on the same state) don't
    // block the indexer's writes, and each message's commit is one append.
    // In-memory databases stay in 'memory' mode.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db);
    // Unless told otherwise, the width of the embedder the database is pinned to
    this.configureVectors(
      this.dimensions || this.getMeta<{ dimensions: number }>('embedder')?.dimensions || EMBEDDING_DIMENSIONS
    );
  }

  /** Embedding width the vector index is built for. */
  get vectorDimensions(): number {
    return this.dimensions;
  }

  /**
   * Builds the vector index (sqlite-vec) for `dimensions`-wide embeddings:
   * one row per message chunk, cosine distance, partitioned by session so a
   * session-scoped query searches inside its partition instead of filtering
   * a global top-k. A table from an older build, or for another width, is
   * rebuilt from the embeddings stored on the messages. Outside the
   * migrations: it exists only when the extension loads on this machine.
   */
  configureVectors(dimensions: number): void {
    this.dimensions = dimensions;
    if (!this.vecEnabled) return;
    const definition =
      `CREATE VIRTUAL TABLE message_vectors USING vec0(chunk_id TEXT PRIMARY KEY, ` +
      `session_id TEXT PARTITION KEY, embedding float[${dimensions}] distance_metric=cosine, +message_id TEXT)`;
    const existing = () =>
      (
        this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_vectors'").get() as
          | { sql: string }
          | undefined
      )?.sql;
    if (existing() === definition) return;

    // Under the write lock, looked at again: another process opening the
    // same file may have just built it
    this.db.transaction(() => {
      const current = existing();
      if (current === definition) return;
      if (current !== undefined) this.db.exec('DROP TABLE message_vectors');
      this.db.exec(definition);
      // In pages: the connection can't write while a cursor is open
      const page = this.db.prepare(
        'SELECT rowid, id, session_id, embedding FROM messages WHERE embedding IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT 500'
      );
      for (let after = 0; ; ) {
        const rows = page.all(after) as Array<{ rowid: number; id: string; session_id: string; embedding: Buffer }>;
        if (rows.length === 0) break;
        for (const row of rows) this.insertVectors(row.id, row.session_id, this.decodeVectors(row.embedding));
        after = rows[rows.length - 1].rowid;
      }
    }).immediate();
  }

  // ─────────────────────────────────────────────────────────
  // Index metadata
  // ─────────────────────────────────────────────────────────

  getMeta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value));
  }

  /** Whether anything has been embedded: messages, or truth entries. */
  hasEmbeddings(): boolean {
    const message = this.db.prepare('SELECT 1 FROM messages WHERE embedding IS NOT NULL LIMIT 1').get();
    if (message) return true;
    const truthTable = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'truth_entries'")
      .get();
    return Boolean(truthTable && this.db.prepare('SELECT 1 FROM truth_entries WHERE embedding IS NOT NULL LIMIT 1').get());
  }

  /**
   * Runs `fn` in one transaction (a savepoint when already inside one), so
   * a message and everything derived from it commit, or roll back, together.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─────────────────────────────────────────────────────────
  // Ingest checkpoints
  // ─────────────────────────────────────────────────────────

  getCheckpoint(source: string): IngestCheckpoint | null {
    const row = this.statement('SELECT * FROM ingest_checkpoints WHERE source = ?')
      .get(resolve(source)) as any;
    if (!row) return null;
    return {
      source: row.source,
      dev: row.dev,
      inode: row.inode,
      headHash: row.head_hash,
      headLength: row.head_length,
      offset: row.offset,
      seq: row.seq,
      sessionId: row.session_id ?? null,
      updatedAt: row.updated_at,
    };
  }

  saveCheckpoint(checkpoint: Omit<IngestCheckpoint, 'updatedAt'>): void {
    this.statement(`
        INSERT INTO ingest_checkpoints (source, dev, inode, head_hash, head_length, offset, seq,
          session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          dev = excluded.dev,
          inode = excluded.inode,
          head_hash = excluded.head_hash,
          head_length = excluded.head_length,
          offset = excluded.offset,
          seq = excluded.seq,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `)
      .run(
        resolve(checkpoint.source),
        checkpoint.dev,
        checkpoint.inode,
        checkpoint.headHash,
        checkpoint.headLength,
        checkpoint.offset,
        checkpoint.seq,
        checkpoint.sessionId,
        new Date().toISOString()
      );
  }

  // ─────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────

  addMessage(msg: IndexedMessage): void {
    const vectors = msg.chunkEmbeddings ?? (msg.embedding.length > 0 ? [msg.embedding] : []);
    const previous = this.statement('SELECT embedding FROM messages WHERE id = ?').get(msg.id) as
      | { embedding: Buffer | null }
      | undefined;

    // OR REPLACE: a message whose content changed under the same id (an
    // edited or colliding line) replaces the old row, keeping its place in
    // the ingest order. Unchanged re-deliveries never get here — the engine
    // skips them.
    this.statement(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp,
        embedding, importance_state_delta, importance_reference_freq,
        importance_trajectory_disc, importance_total, entity_ids, tags, tool_calls, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT seq FROM messages WHERE id = ?), (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages)))
    `).run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.content,
      msg.timestamp,
      vectors.length > 0 ? toBlob(vectors) : null,
      msg.importanceScore.stateDelta,
      msg.importanceScore.referenceFrequency,
      msg.importanceScore.trajectoryDiscontinuity,
      msg.importanceScore.total,
      JSON.stringify(msg.entityIds),
      msg.tags && msg.tags.length > 0 ? JSON.stringify(msg.tags) : null,
      msg.toolCalls && msg.toolCalls.length > 0 ? JSON.stringify(msg.toolCalls) : null,
      msg.id
    );

    if (this.vecEnabled) {
      // vec0 has no upsert; delete + insert keeps re-indexing idempotent
      if (previous?.embedding) this.deleteVectors(msg.id, this.decodeVectors(previous.embedding).length);
      this.insertVectors(msg.id, msg.sessionId, vectors);
    }
  }

  /** Replaces a message's vectors (re-embedding under another embedder). */
  setMessageEmbeddings(id: string, vectors: number[][]): void {
    const row = this.statement('SELECT session_id, embedding FROM messages WHERE id = ?').get(id) as
      | { session_id: string; embedding: Buffer | null }
      | undefined;
    if (!row) return;
    this.statement('UPDATE messages SET embedding = ? WHERE id = ?').run(vectors.length > 0 ? toBlob(vectors) : null, id);
    if (this.vecEnabled) {
      if (row.embedding) this.deleteVectors(id, this.decodeVectors(row.embedding).length);
      this.insertVectors(id, row.session_id, vectors);
    }
  }

  /** What re-embedding needs of every message, in ingest order. */
  listMessageTexts(): Array<{ id: string; content: string; toolCalls?: IndexedMessage['toolCalls'] }> {
    const rows = this.db.prepare('SELECT id, content, tool_calls FROM messages ORDER BY seq ASC').all() as Array<{
      id: string;
      content: string;
      tool_calls: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      ...(row.tool_calls ? { toolCalls: JSON.parse(row.tool_calls) } : {}),
    }));
  }

  /**
   * Truth entries that carry an embedding, with the text it was made from
   * (a TB's claim, a UV's assertion, a proposal draft's claim).
   */
  listTruthEmbeddingTexts(): Array<{ id: string; text: string }> {
    const rows = this.db
      .prepare('SELECT id, body FROM truth_entries WHERE embedding IS NOT NULL')
      .all() as Array<{ id: string; body: string }>;
    const out: Array<{ id: string; text: string }> = [];
    for (const row of rows) {
      const body = JSON.parse(row.body);
      const text = body.claim ?? body.assertion ?? body.draft?.claim ?? body.draft?.assertion;
      if (typeof text === 'string' && text) out.push({ id: row.id, text });
    }
    return out;
  }

  /** Replaces a truth entry's embedding — derived state, not part of the record. */
  setTruthEmbedding(id: string, embedding: number[]): void {
    this.db
      .prepare('UPDATE truth_entries SET embedding = ? WHERE id = ?')
      .run(Buffer.from(new Float32Array(embedding).buffer), id);
  }

  private insertVectors(messageId: string, sessionId: string, vectors: number[][]): void {
    const insert = this.statement(
      'INSERT INTO message_vectors (chunk_id, session_id, embedding, message_id) VALUES (?, ?, ?, ?)'
    );
    vectors.forEach((vector, index) => {
      // A width the index isn't built for, or a zero vector, has no neighbors
      if (vector.length !== this.dimensions || !hasDirection(vector)) return;
      insert.run(chunkId(messageId, index), sessionId, Buffer.from(new Float32Array(vector).buffer), messageId);
    });
  }

  private deleteVectors(messageId: string, chunks: number): void {
    const remove = this.statement('DELETE FROM message_vectors WHERE chunk_id = ?');
    for (let index = 0; index < Math.max(1, chunks); index++) remove.run(chunkId(messageId, index));
  }

  /** A stored embedding blob as its chunk vectors (one, for a short or pre-chunking message). */
  private decodeVectors(blob: Buffer | null): number[][] {
    if (!blob || blob.byteLength === 0) return [];
    const flat = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    if (flat.length <= this.dimensions || flat.length % this.dimensions !== 0) return [Array.from(flat)];
    const vectors: number[][] = [];
    for (let offset = 0; offset < flat.length; offset += this.dimensions) {
      vectors.push(Array.from(flat.subarray(offset, offset + this.dimensions)));
    }
    return vectors;
  }

  /** Prepared once per SQL text: indexing runs these for every message. */
  private statement(sql: string): Database.Statement {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  getMessage(id: string): IndexedMessage | null {
    const row = this.statement('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this.rowToMessage(row) : null;
  }

  /**
   * Moves an indexed message, and the decisions and tombstones it produced,
   * to another session — when the same line reappears in a different log
   * (e.g. a resumed session's copy of its history). Nothing is re-derived.
   */
  reattributeMessage(id: string, sessionId: string): void {
    const row = this.statement('SELECT session_id, embedding FROM messages WHERE id = ?').get(id) as
      | { session_id: string; embedding: Buffer | null }
      | undefined;
    this.db.prepare('UPDATE messages SET session_id = ? WHERE id = ?').run(sessionId, id);
    this.db.prepare('UPDATE decisions SET session_id = ? WHERE source_message_id = ?').run(sessionId, id);
    this.db.prepare('UPDATE tombstones SET session_id = ? WHERE source_message_id = ?').run(sessionId, id);
    // The session is the vectors' partition key
    if (this.vecEnabled && row?.embedding) {
      const vectors = this.decodeVectors(row.embedding);
      this.deleteVectors(id, vectors.length);
      this.insertVectors(id, sessionId, vectors);
    }
  }

  /** A message's position in the ingest order. */
  getMessageSeq(id: string): number | null {
    const row = this.statement('SELECT seq FROM messages WHERE id = ?').get(id) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  /** Every indexed message (optionally one session's), in ingest order. */
  *iterateMessages(
    sessionId: string | null,
    options: { embeddings?: boolean } = {}
  ): IterableIterator<IndexedMessage> {
    const columns = options.embeddings === false ? MESSAGE_COLUMNS_WITHOUT_EMBEDDING : '*';
    const stmt = sessionId
      ? this.db.prepare(`SELECT ${columns} FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      : this.db.prepare(`SELECT ${columns} FROM messages ORDER BY seq ASC`);
    const rows = (sessionId ? stmt.iterate(sessionId) : stmt.iterate()) as IterableIterator<any>;
    for (const row of rows) yield this.rowToMessage(row);
  }

  /**
   * The last `n` messages indexed (optionally in one session), newest first,
   * by ingest order: provider timestamps are missing or re-stamped at parse
   * time for several formats. Embeddings are left out.
   */
  getRecentMessages(sessionId: string | null, n: number): IndexedMessage[] {
    const columns = MESSAGE_COLUMNS_WITHOUT_EMBEDDING;
    const stmt = sessionId
      ? this.statement(`SELECT ${columns} FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`)
      : this.statement(`SELECT ${columns} FROM messages ORDER BY seq DESC LIMIT ?`);

    const rows = sessionId ? stmt.all(sessionId, n) : stmt.all(n);
    return rows.map((row) => this.rowToMessage(row));
  }

  getMessagesBySession(sessionId: string): IndexedMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY seq ASC
    `);

    return stmt.all(sessionId).map((row) => this.rowToMessage(row));
  }

  /**
   * K-nearest-neighbor search over stored message embeddings: cosine
   * similarity of the best-matching chunk of each message, highest first.
   * `k` is clamped to [1, 4096].
   */
  searchSimilar(
    embedding: number[],
    k: number,
    sessionId?: string | null
  ): Array<{ message: IndexedMessage; score: number }> {
    k = Math.max(1, Math.min(VEC_MAX_K, Math.floor(k) || 1));
    if (!hasDirection(embedding)) return [];

    if (this.vecEnabled && embedding.length === this.dimensions) {
      const query = Buffer.from(new Float32Array(embedding).buffer);
      const knn = sessionId
        ? this.statement(`
            SELECT message_id, distance FROM message_vectors
            WHERE embedding MATCH ? AND k = ? AND session_id = ?
            ORDER BY distance
          `)
        : this.statement(`
            SELECT message_id, distance FROM message_vectors
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
          `);

      // Chunks of one long message can crowd the top-k: widen until k
      // distinct messages are found or the partition is exhausted
      let fetchK = Math.min(VEC_MAX_K, k * 2);
      const best = new Map<string, number>();
      for (;;) {
        const rows = (sessionId ? knn.all(query, fetchK, sessionId) : knn.all(query, fetchK)) as Array<{
          message_id: string;
          distance: number | null;
        }>;
        best.clear();
        for (const row of rows) {
          if (row.distance === null || best.has(row.message_id)) continue;
          best.set(row.message_id, 1 - row.distance);
        }
        if (best.size >= k || rows.length < fetchK || fetchK === VEC_MAX_K) break;
        fetchK = Math.min(VEC_MAX_K, fetchK * 4);
      }

      return [...best]
        .slice(0, k)
        .map(([id, score]) => ({ message: this.getMessage(id)!, score }))
        .filter((r) => r.message);
    }

    // Brute-force fallback
    const candidates = sessionId
      ? this.getMessagesBySession(sessionId)
      : (this.db.prepare('SELECT * FROM messages').all() as any[]).map((row) => this.rowToMessage(row));

    return candidates
      .filter((m) => m.embedding.length > 0)
      .map((message) => ({
        message,
        score: Math.max(
          ...(message.chunkEmbeddings ?? [message.embedding]).map((v) => cosineSimilarity(embedding, v))
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  private rowToMessage(row: any): IndexedMessage {
    const vectors = this.decodeVectors(row.embedding ?? null);

    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      embedding: vectors[0] ?? [],
      ...(vectors.length > 1 ? { chunkEmbeddings: vectors } : {}),
      importanceScore: {
        total: row.importance_total || 0,
        stateDelta: row.importance_state_delta || 0,
        referenceFrequency: row.importance_reference_freq || 0,
        trajectoryDiscontinuity: row.importance_trajectory_disc || 0,
      },
      entityIds: JSON.parse(row.entity_ids || '[]'),
      ...(row.tags ? { tags: JSON.parse(row.tags) } : {}),
      ...(row.tool_calls ? { toolCalls: JSON.parse(row.tool_calls) } : {}),
      ...(typeof row.seq === 'number' ? { seq: row.seq } : {}),
    };
  }

  // ─────────────────────────────────────────────────────────
  // Decisions — append-only supersession chain
  // ─────────────────────────────────────────────────────────

  addDecision(
    sessionId: string,
    decision: { id: string; description: string; sourceMessageId?: string; timestamp?: string }
  ): void {
    // Ids are derived from the source line: a re-derived decision is the same row
    const stmt = this.statement(`
      INSERT OR IGNORE INTO decisions (id, session_id, description, timestamp, source_message_id)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      decision.id,
      sessionId,
      decision.description,
      decision.timestamp || new Date().toISOString(),
      decision.sourceMessageId ?? null
    );
  }

  /**
   * Marks a decision as superseded by a newer one. The old record is kept
   * (never deleted) — "close" means "we have a fresher version", not
   * "this died". The chain is walkable via superseded_by.
   */
  supersedeDecision(oldId: string, newId: string): void {
    this.statement('UPDATE decisions SET superseded = 1, superseded_by = ? WHERE id = ?')
      .run(newId, oldId);
  }

  getDecision(id: string): IndexedDecision | null {
    const row = this.statement('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? this.rowToDecision(row) : null;
  }

  getActiveDecisions(sessionId: string | null): IndexedDecision[] {
    const stmt = sessionId
      ? this.statement('SELECT * FROM decisions WHERE session_id = ? AND superseded = 0 ORDER BY timestamp ASC')
      : this.statement('SELECT * FROM decisions WHERE superseded = 0 ORDER BY timestamp ASC');

    const rows = sessionId ? stmt.all(sessionId) : stmt.all();
    return rows.map(this.rowToDecision);
  }

  /** All decisions including superseded ones — the full observation history. */
  getAllDecisions(sessionId: string | null): IndexedDecision[] {
    const stmt = sessionId
      ? this.db.prepare('SELECT * FROM decisions WHERE session_id = ? ORDER BY timestamp ASC')
      : this.db.prepare('SELECT * FROM decisions ORDER BY timestamp ASC');

    const rows = sessionId ? stmt.all(sessionId) : stmt.all();
    return rows.map(this.rowToDecision);
  }

  /**
   * Walks the supersession chain containing the given decision,
   * oldest observation first. Each entry was current ground truth at its
   * timestamp; the last entry is the current version.
   */
  getDecisionChain(id: string): IndexedDecision[] {
    const byId = this.db.prepare('SELECT * FROM decisions WHERE id = ?');
    const predecessorOf = this.db.prepare('SELECT * FROM decisions WHERE superseded_by = ?');

    let current: any = byId.get(id);
    if (!current) return [];

    // Walk back to the chain root
    let root = current;
    const seen = new Set<string>([root.id]);
    for (;;) {
      const prev: any = predecessorOf.get(root.id);
      if (!prev || seen.has(prev.id)) break;
      seen.add(prev.id);
      root = prev;
    }

    // Walk forward from the root
    const chain: IndexedDecision[] = [];
    const visited = new Set<string>();
    let node: any = root;
    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      chain.push(this.rowToDecision(node));
      node = node.superseded_by ? byId.get(node.superseded_by) : null;
    }

    return chain;
  }

  private rowToDecision = (row: any): IndexedDecision => ({
    id: row.id,
    sessionId: row.session_id,
    description: row.description,
    timestamp: row.timestamp,
    superseded: Boolean(row.superseded),
    supersededBy: row.superseded_by ?? null,
    sourceMessageId: row.source_message_id ?? null,
  });

  // ─────────────────────────────────────────────────────────
  // Tombstones
  // ─────────────────────────────────────────────────────────

  addTombstone(sessionId: string, tombstone: {
    id: string;
    superseded: string;
    correctedTo: string;
    reason: string;
    sourceMessageId?: string;
    supersededDecisionId?: string;
    timestamp?: string;
  }): void {
    const stmt = this.statement(`
      INSERT OR IGNORE INTO tombstones (id, session_id, superseded, corrected_to, reason, timestamp,
        source_message_id, superseded_decision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      tombstone.id,
      sessionId,
      tombstone.superseded,
      tombstone.correctedTo,
      tombstone.reason,
      tombstone.timestamp || new Date().toISOString(),
      tombstone.sourceMessageId ?? null,
      tombstone.supersededDecisionId ?? null
    );
  }

  getTombstones(sessionId: string | null): IndexedTombstone[] {
    const stmt = sessionId
      ? this.db.prepare('SELECT * FROM tombstones WHERE session_id = ? ORDER BY timestamp DESC')
      : this.db.prepare('SELECT * FROM tombstones ORDER BY timestamp DESC');

    const rows = sessionId ? stmt.all(sessionId) : stmt.all();
    return rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      superseded: row.superseded,
      correctedTo: row.corrected_to,
      reason: row.reason,
      timestamp: row.timestamp,
      sourceMessageId: row.source_message_id ?? null,
      supersededDecisionId: row.superseded_decision_id ?? null,
    }));
  }

  // ─────────────────────────────────────────────────────────
  // Entities
  // ─────────────────────────────────────────────────────────

  upsertEntity(entity: EntityNode): void {
    const stmt = this.statement(`
      INSERT INTO entities (id, type, value, first_seen, last_seen, ref_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = excluded.last_seen,
        ref_count = ref_count + 1
    `);

    stmt.run(entity.id, entity.type, entity.value, entity.firstSeen, entity.lastSeen);
  }

  upsertRelation(relation: EntityRelation): void {
    const stmt = this.statement(`
      INSERT INTO entity_relations (entity_from, entity_to, relation, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_from, entity_to, relation) DO UPDATE SET
        last_seen = excluded.last_seen
    `);

    stmt.run(relation.from, relation.to, relation.relation, relation.firstSeen, relation.lastSeen);
  }

  getRelations(): EntityRelation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM entity_relations ORDER BY first_seen ASC
    `);

    return stmt.all().map((row: any) => ({
      from: row.entity_from,
      to: row.entity_to,
      relation: row.relation,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));
  }

  getEntities(sessionId: string | null): EntityNode[] {
    const rowToNode = (row: any): EntityNode => ({
      id: row.id,
      type: row.type,
      value: row.value,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      references: row.ref_count,
    });

    if (!sessionId) {
      return (this.db.prepare('SELECT * FROM entities').all() as any[]).map(rowToNode);
    }

    // entity_ids is a raw (unescaped) extracted-text id, so it can't be
    // matched with SQL LIKE without false positives on substrings or
    // wildcard characters — join in application code instead.
    const entityIdRows = this.db
      .prepare('SELECT entity_ids FROM messages WHERE session_id = ?')
      .all(sessionId) as Array<{ entity_ids: string }>;

    const referencedIds = new Set<string>();
    for (const row of entityIdRows) {
      for (const id of JSON.parse(row.entity_ids || '[]') as string[]) {
        referencedIds.add(id);
      }
    }
    if (referencedIds.size === 0) return [];

    const allEntities = this.db.prepare('SELECT * FROM entities').all() as any[];
    return allEntities.filter((row) => referencedIds.has(row.id)).map(rowToNode);
  }

  // ─────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────

  getStats(sessionId: string | null): {
    messagesIndexed: number;
    entities: number;
    decisions: number;
    tombstones: number;
  } {
    const count = (sql: string, scoped: string): number => {
      if (sessionId) {
        return (this.db.prepare(scoped).get(sessionId) as { count: number }).count;
      }
      return (this.db.prepare(sql).get() as { count: number }).count;
    };

    return {
      messagesIndexed: count(
        'SELECT COUNT(*) as count FROM messages',
        'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
      ),
      entities: (this.db.prepare('SELECT COUNT(DISTINCT id) as count FROM entities').get() as { count: number }).count,
      decisions: count(
        'SELECT COUNT(*) as count FROM decisions WHERE superseded = 0',
        'SELECT COUNT(*) as count FROM decisions WHERE session_id = ? AND superseded = 0'
      ),
      tombstones: count(
        'SELECT COUNT(*) as count FROM tombstones',
        'SELECT COUNT(*) as count FROM tombstones WHERE session_id = ?'
      ),
    };
  }

  // ─────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

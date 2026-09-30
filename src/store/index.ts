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
  private objectionLog: ObjectionLog | null = null;
  private dispatcher: ObjectionDispatcher | null = null;

  constructor(dbPath: string, options: StateStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
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
      this.truthLedger = new TruthLedger(this.db);
    }
    return this.truthLedger;
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
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db);

    // Vector index (sqlite-vec virtual table). Outside the migrations: it
    // exists only when the extension loads on this machine.
    if (this.vecEnabled) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(
          message_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}]
        )
      `);
    }
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
    const row = this.db
      .prepare('SELECT * FROM ingest_checkpoints WHERE source = ?')
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
    this.db
      .prepare(`
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
    // OR REPLACE: a message whose content changed under the same id (an
    // edited or colliding line) replaces the old row. Unchanged re-deliveries
    // never get here — the engine skips them.
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp,
        embedding, importance_state_delta, importance_reference_freq,
        importance_trajectory_disc, entity_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.content,
      msg.timestamp,
      // Serialize the underlying bytes — Buffer.from(typedArray) without
      // .buffer would truncate each float to a single byte
      Buffer.from(new Float32Array(msg.embedding).buffer),
      msg.importanceScore.stateDelta,
      msg.importanceScore.referenceFrequency,
      msg.importanceScore.trajectoryDiscontinuity,
      JSON.stringify(msg.entityIds)
    );

    if (this.vecEnabled && msg.embedding.length === this.dimensions) {
      // vec0 has no upsert; delete + insert keeps re-indexing idempotent
      this.db.prepare('DELETE FROM message_vectors WHERE message_id = ?').run(msg.id);
      this.db
        .prepare('INSERT INTO message_vectors (message_id, embedding) VALUES (?, ?)')
        .run(msg.id, Buffer.from(new Float32Array(msg.embedding).buffer));
    }
  }

  getMessage(id: string): IndexedMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this.rowToMessage(row) : null;
  }

  /**
   * Moves an indexed message, and the decisions and tombstones it produced,
   * to another session — when the same line reappears in a different log
   * (e.g. a resumed session's copy of its history). Nothing is re-derived.
   */
  reattributeMessage(id: string, sessionId: string): void {
    this.db.prepare('UPDATE messages SET session_id = ? WHERE id = ?').run(sessionId, id);
    this.db.prepare('UPDATE decisions SET session_id = ? WHERE source_message_id = ?').run(sessionId, id);
    this.db.prepare('UPDATE tombstones SET session_id = ? WHERE source_message_id = ?').run(sessionId, id);
  }

  /** Every indexed message (optionally one session's), oldest first. */
  *iterateMessages(sessionId: string | null): IterableIterator<IndexedMessage> {
    const stmt = sessionId
      ? this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
      : this.db.prepare('SELECT * FROM messages ORDER BY timestamp ASC');
    const rows = (sessionId ? stmt.iterate(sessionId) : stmt.iterate()) as IterableIterator<any>;
    for (const row of rows) yield this.rowToMessage(row);
  }

  getRecentMessages(sessionId: string | null, n: number): IndexedMessage[] {
    const stmt = sessionId
      ? this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?');

    const rows = sessionId ? stmt.all(sessionId, n) : stmt.all(n);
    return rows.map(this.rowToMessage);
  }

  getMessagesBySession(sessionId: string): IndexedMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);

    return stmt.all(sessionId).map(this.rowToMessage);
  }

  /**
   * K-nearest-neighbor search over stored message embeddings.
   * Returns messages with a cosine-similarity score in [0, 1]-ish range.
   */
  searchSimilar(
    embedding: number[],
    k: number,
    sessionId?: string | null
  ): Array<{ message: IndexedMessage; score: number }> {
    if (this.vecEnabled && embedding.length === this.dimensions) {
      // Over-fetch when session-scoped, then filter
      const fetchK = sessionId ? k * 4 : k;
      const rows = this.db
        .prepare(`
          SELECT m.*, v.distance FROM message_vectors v
          JOIN messages m ON m.id = v.message_id
          WHERE v.embedding MATCH ? AND v.k = ?
          ORDER BY v.distance
        `)
        .all(Buffer.from(new Float32Array(embedding).buffer), fetchK) as any[];

      return rows
        .filter((r) => !sessionId || r.session_id === sessionId)
        .slice(0, k)
        .map((r) => ({
          message: this.rowToMessage(r),
          // vec0 distance is L2; for unit vectors, cos = 1 - d²/2
          score: 1 - (r.distance * r.distance) / 2,
        }));
    }

    // Brute-force fallback
    const candidates = sessionId
      ? this.getMessagesBySession(sessionId)
      : (this.db.prepare('SELECT * FROM messages').all() as any[]).map(this.rowToMessage);

    return candidates
      .filter((m) => m.embedding.length > 0)
      .map((message) => ({ message, score: cosineSimilarity(embedding, message.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  private rowToMessage(row: any): IndexedMessage {
    const embedding = row.embedding
      ? Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4))
      : [];

    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      embedding,
      importanceScore: {
        total: 0,
        stateDelta: row.importance_state_delta || 0,
        referenceFrequency: row.importance_reference_freq || 0,
        trajectoryDiscontinuity: row.importance_trajectory_disc || 0,
      },
      entityIds: JSON.parse(row.entity_ids || '[]'),
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
    const stmt = this.db.prepare(`
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
    this.db
      .prepare('UPDATE decisions SET superseded = 1, superseded_by = ? WHERE id = ?')
      .run(newId, oldId);
  }

  getActiveDecisions(sessionId: string | null): IndexedDecision[] {
    const stmt = sessionId
      ? this.db.prepare('SELECT * FROM decisions WHERE session_id = ? AND superseded = 0 ORDER BY timestamp ASC')
      : this.db.prepare('SELECT * FROM decisions WHERE superseded = 0 ORDER BY timestamp ASC');

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
    const stmt = this.db.prepare(`
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
    const stmt = this.db.prepare(`
      INSERT INTO entities (id, type, value, first_seen, last_seen, ref_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = excluded.last_seen,
        ref_count = ref_count + 1
    `);

    stmt.run(entity.id, entity.type, entity.value, entity.firstSeen, entity.lastSeen);
  }

  upsertRelation(relation: EntityRelation): void {
    const stmt = this.db.prepare(`
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

/**
 * Stenographer — SQLite State Store
 * Durable indexed state for conversation history.
 *
 * Vector search is backed by sqlite-vec when the extension loads
 * (prebuilt binaries per platform); otherwise falls back to brute-force
 * cosine over stored embeddings.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { cosineSimilarity, EMBEDDING_DIMENSIONS } from '../indexer/embeddings.js';
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

export class StateStore {
  private db: Database.Database;
  private dimensions: number;
  private vecEnabled: boolean = false;

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

  private init(): void {
    // Messages table with embedding
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        embedding BLOB,
        importance_state_delta REAL,
        importance_reference_freq REAL,
        importance_trajectory_disc REAL,
        entity_ids TEXT
      )
    `);

    // Decisions table — append-only with supersession chain.
    // A superseded decision is never deleted: it keeps its provenance and
    // points at its successor (the "current version of the fact").
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        description TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        superseded INTEGER DEFAULT 0,
        superseded_by TEXT,
        source_message_id TEXT
      )
    `);

    // Tombstones (supersession/correction records with provenance)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tombstones (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        superseded TEXT NOT NULL,
        corrected_to TEXT NOT NULL,
        reason TEXT,
        timestamp TEXT NOT NULL,
        source_message_id TEXT,
        superseded_decision_id TEXT
      )
    `);

    // Migrate pre-existing databases that lack the provenance columns
    this.addColumnIfMissing('decisions', 'source_message_id', 'TEXT');
    this.addColumnIfMissing('tombstones', 'source_message_id', 'TEXT');
    this.addColumnIfMissing('tombstones', 'superseded_decision_id', 'TEXT');

    // Entities (knowledge graph nodes)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        ref_count INTEGER DEFAULT 1
      )
    `);

    // Entity relations (edges)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_from TEXT NOT NULL,
        entity_to TEXT NOT NULL,
        relation TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        UNIQUE(entity_from, entity_to, relation)
      )
    `);

    // Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        message_count INTEGER DEFAULT 0
      )
    `);

    // Vector index (sqlite-vec virtual table)
    if (this.vecEnabled) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(
          message_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}]
        )
      `);
    }

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    `);
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────

  addMessage(msg: IndexedMessage): void {
    // OR REPLACE: the tailer may re-deliver lines (e.g. on restart or
    // partial-write re-reads), so inserts must be idempotent by id.
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
    const stmt = this.db.prepare(`
      INSERT INTO decisions (id, session_id, description, timestamp, source_message_id)
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
      INSERT INTO tombstones (id, session_id, superseded, corrected_to, reason, timestamp,
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
    // Get entities that appear in this session's messages (or all)
    const stmt = sessionId
      ? this.db.prepare(`
          SELECT DISTINCT e.* FROM entities e
          JOIN messages m ON m.entity_ids LIKE '%' || e.id || '%'
          WHERE m.session_id = ?
        `)
      : this.db.prepare('SELECT * FROM entities');

    const rows = sessionId ? stmt.all(sessionId) : stmt.all();
    return rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      value: row.value,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      references: row.ref_count,
    }));
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

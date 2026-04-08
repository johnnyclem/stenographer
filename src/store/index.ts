/**
 * Stenographer — SQLite State Store
 * Durable indexed state for conversation history
 */

import Database from 'better-sqlite3';
import type {
  IndexedMessage,
  IndexedDecision,
  IndexedTombstone,
  EntityNode,
  EntityRelation,
} from './types.js';

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.init();
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

    // Decisions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        description TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        superseded INTEGER DEFAULT 0,
        superseded_by TEXT
      )
    `);

    // Tombstones (corrections)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tombstones (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        superseded TEXT NOT NULL,
        corrected_to TEXT NOT NULL,
        reason TEXT,
        timestamp TEXT NOT NULL
      )
    `);

    // Entities (knowledge graph nodes)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        references INTEGER DEFAULT 1
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

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    `);
  }

  // ─────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────

  addMessage(msg: IndexedMessage): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, 
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
      Buffer.from(new Float32Array(msg.embedding)),
      msg.importanceScore.stateDelta,
      msg.importanceScore.referenceFrequency,
      msg.importanceScore.trajectoryDiscontinuity,
      JSON.stringify(msg.entityIds)
    );
  }

  getRecentMessages(sessionId: string, n: number): IndexedMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages 
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    
    return stmt.all(sessionId, n).map(this.rowToMessage);
  }

  getMessagesBySession(sessionId: string): IndexedMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages 
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);
    
    return stmt.all(sessionId).map(this.rowToMessage);
  }

  private rowToMessage(row: any): IndexedMessage {
    const embedding = row.embedding 
      ? Array.from(new Float32Array(row.embedding)) 
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
  // Decisions
  // ─────────────────────────────────────────────────────────

  addDecision(sessionId: string, decision: { id: string; description: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO decisions (id, session_id, description, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(decision.id, sessionId, decision.description, new Date().toISOString());
  }

  getActiveDecisions(sessionId: string): IndexedDecision[] {
    const stmt = this.db.prepare(`
      SELECT * FROM decisions 
      WHERE session_id = ? AND superseded = 0
      ORDER BY timestamp ASC
    `);
    
    return stmt.all(sessionId).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      description: row.description,
      timestamp: row.timestamp,
      superseded: Boolean(row.superseded),
    }));
  }

  // ─────────────────────────────────────────────────────────
  // Tombstones
  // ─────────────────────────────────────────────────────────

  addTombstone(sessionId: string, tombstone: {
    id: string;
    superseded: string;
    correctedTo: string;
    reason: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO tombstones (id, session_id, superseded, corrected_to, reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      tombstone.id,
      sessionId,
      tombstone.superseded,
      tombstone.correctedTo,
      tombstone.reason,
      new Date().toISOString()
    );
  }

  getTombstones(sessionId: string): IndexedTombstone[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tombstones 
      WHERE session_id = ?
      ORDER BY timestamp DESC
    `);
    
    return stmt.all(sessionId).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      superseded: row.superseded,
      correctedTo: row.corrected_to,
      reason: row.reason,
      timestamp: row.timestamp,
    }));
  }

  // ─────────────────────────────────────────────────────────
  // Entities
  // ─────────────────────────────────────────────────────────

  upsertEntity(entity: EntityNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO entities (id, type, value, first_seen, last_seen, references)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = excluded.last_seen,
        references = references + 1
    `);
    
    stmt.run(entity.id, entity.type, entity.value, entity.firstSeen, entity.lastSeen);
  }

  getEntities(sessionId: string): EntityNode[] {
    // Get entities that appear in this session's messages
    const stmt = this.db.prepare(`
      SELECT DISTINCT e.* FROM entities e
      JOIN messages m ON m.entity_ids LIKE '%' || e.id || '%'
      WHERE m.session_id = ?
    `);
    
    return stmt.all(sessionId).map((row: any) => ({
      id: row.id,
      type: row.type,
      value: row.value,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      references: row.references,
    }));
  }

  // ─────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────

  getStats(sessionId: string): {
    messagesIndexed: number;
    entities: number;
    decisions: number;
    tombstones: number;
  } {
    const msgCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    
    const entCount = this.db.prepare(
      'SELECT COUNT(DISTINCT id) as count FROM entities'
    ).get() as { count: number };
    
    const decCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM decisions WHERE session_id = ? AND superseded = 0'
    ).get(sessionId) as { count: number };
    
    const tomCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM tombstones WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    
    return {
      messagesIndexed: msgCount.count,
      entities: entCount.count,
      decisions: decCount.count,
      tombstones: tomCount.count,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

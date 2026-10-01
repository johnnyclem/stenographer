/**
 * Stenographer — Index schema migrations
 * An ordered list of steps; PRAGMA user_version records how many have run.
 * Each step runs in one transaction with its version bump, so a database is
 * never left half-migrated. Steps are append-only: never edit a released one.
 */

import type Database from 'better-sqlite3';

export type Migration = (db: Database.Database) => void;

function addColumnIfMissing(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export const MIGRATIONS: Migration[] = [
  // 1 — the pre-1.0 index schema. Idempotent, because databases written
  // before schema versioning (user_version 0) may already have any of it.
  (db) => {
    db.exec(`
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
    db.exec(`
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
    db.exec(`
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

    // Early databases lack the provenance columns
    addColumnIfMissing(db, 'decisions', 'source_message_id', 'TEXT');
    addColumnIfMissing(db, 'tombstones', 'source_message_id', 'TEXT');
    addColumnIfMissing(db, 'tombstones', 'superseded_decision_id', 'TEXT');

    // Entities (knowledge graph nodes)
    db.exec(`
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
    db.exec(`
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        message_count INTEGER DEFAULT 0
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    `);
  },

  // 2 — ingest checkpoints: how far each log has been indexed, and which
  // file that was (dev/inode + a hash of its first bytes), written in the
  // same transaction as each message so a restart resumes exactly there.
  (db) => {
    db.exec(`
      CREATE TABLE ingest_checkpoints (
        source TEXT PRIMARY KEY,
        dev TEXT NOT NULL,
        inode TEXT NOT NULL,
        head_hash TEXT NOT NULL,
        head_length INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        session_id TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source_message_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tombstones_source ON tombstones(source_message_id)');
  },

  // 3 — retrieval. `seq` is the order messages were indexed in: provider
  // timestamps are missing (anthropic) or parse-time (openai without
  // `created`) for several formats, so "recent" can't be ordered by them.
  // Record tags and tool calls, the importance total, and index_meta, which
  // pins the embedder the stored vectors were made with.
  (db) => {
    addColumnIfMissing(db, 'messages', 'seq', 'INTEGER');
    addColumnIfMissing(db, 'messages', 'tags', 'TEXT');
    addColumnIfMissing(db, 'messages', 'tool_calls', 'TEXT');
    addColumnIfMissing(db, 'messages', 'importance_total', 'REAL');
    // Existing rows keep the order they were inserted in
    db.exec('UPDATE messages SET seq = rowid WHERE seq IS NULL');
    db.exec(`
      UPDATE messages SET importance_total = MIN(1,
        0.45 * COALESCE(importance_state_delta, 0) +
        0.25 * COALESCE(importance_reference_freq, 0) +
        0.30 * COALESCE(importance_trajectory_disc, 0))
      WHERE importance_total IS NULL
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_decisions_active ON decisions(superseded, session_id);
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
];

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings the database up to SCHEMA_VERSION. Refuses a database written by a
 * newer build rather than guessing at a schema it doesn't know.
 */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(
      `state database schema v${current} is newer than this stenographer supports (v${migrations.length}); upgrade stenographer`
    );
  }
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      migrations[version](db);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

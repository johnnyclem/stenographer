import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../src/store/index.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { verifyStateFile } from '../src/truth/verify-cli.js';
import { evaluateGate, DEFAULT_GATE_TOOLS } from '../src/truth/gate.js';

// One schema version for the whole state database: the index tables and the
// truth layer (ledger, objections, delivery) migrate in one ordered runner.

const LEDGER_0X = readFileSync(join(import.meta.dirname, 'fixtures', 'truth-ledger-0.x.sql'), 'utf8');

/** The 0.x objections table: unique per message, not per session (STENO-T-14). */
const OBJECTIONS_0X = `
  CREATE TABLE objections (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    tb_id TEXT NOT NULL, dead TEXT NOT NULL, record TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    delivered INTEGER NOT NULL DEFAULT 1, ruling_id TEXT, UNIQUE(message_id, tb_id, dead)
  );
  INSERT INTO objections (id, created_at, session_id, message_id, tb_id, dead, record)
    VALUES ('o1', '2026-01-01T00:00:00Z', 's1', 'm1', 'tb1', '30', '{}');
`;

const tables = (db: Database.Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map(
    (r) => r.name
  );

const tableSql = (db: Database.Database, name: string): string =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql: string }).sql;

describe('state database schema: index and truth layer in one runner', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steno-schema-'));
    path = join(dir, 'state.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new state database has the truth layer at the current schema version, before anything touches it', () => {
    new StateStore(path).close();

    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'truth_entries',
        'truth_links',
        'truth_meta',
        'objections',
        'objection_sinks',
        'objection_deliveries',
        'objection_delivery_attempts',
      ])
    );
    const columns = (db.prepare('PRAGMA table_info(truth_entries)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['seq', 'prev_hash', 'hash', 'appended_links']));
    expect(db.prepare(`SELECT value FROM truth_meta WHERE key = 'chain_version'`).get()).toBeTruthy();
    expect(tableSql(db, 'objections')).toMatch(/UNIQUE\s*\(\s*session_id\s*,\s*message_id/i);
    db.close();
  });

  it('migrates a 0.x state database, ledger and objections included, in the versioned runner', () => {
    const legacy = new Database(path);
    legacy.exec(LEDGER_0X);
    legacy.exec(OBJECTIONS_0X);
    legacy.close();

    new StateStore(path).close();

    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    // Chained once, behind the migration marker
    expect(db.prepare(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'MARKER'`).get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM truth_entries WHERE hash IS NULL').get()).toEqual({ c: 0 });
    // Objections moved to the per-session key, rows kept
    expect(tableSql(db, 'objections')).toMatch(/UNIQUE\s*\(\s*session_id\s*,\s*message_id/i);
    expect(db.prepare('SELECT id, session_id FROM objections').all()).toEqual([{ id: 'o1', session_id: 's1' }]);
    db.close();

    // ...and a second open has nothing left to do
    const store = new StateStore(path);
    expect(store.truth.verify().ok).toBe(true);
    store.close();
  });

  describe('a database written by a newer build', () => {
    beforeEach(() => {
      const db = new Database(path);
      db.exec(LEDGER_0X);
      db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      db.close();
    });

    const untouched = () => {
      const db = new Database(path);
      try {
        // Not chained, not even given the chain columns
        expect(tables(db)).not.toContain('truth_meta');
        const columns = (db.prepare('PRAGMA table_info(truth_entries)').all() as Array<{ name: string }>).map((c) => c.name);
        expect(columns).not.toContain('hash');
      } finally {
        db.close();
      }
    };

    it('is refused by stenographer verify, which leaves it as it was', () => {
      const check = verifyStateFile(path);
      expect(check).toMatchObject({ outcome: 'error', error: expect.stringMatching(/newer/) });
      untouched();
    });

    it('is refused by the gate (on-error decides), which leaves it as it was', () => {
      const result = evaluateGate(
        { tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'export const LOG_BUDGET = 30;' }, session_id: 's' },
        { mode: 'enforce', statePath: path, timeoutMs: 2000, onError: 'deny', tools: [...DEFAULT_GATE_TOOLS] }
      );
      expect(result.decision).toBe('deny');
      expect(result.error).toMatch(/newer/);
      untouched();
    });

    it('is refused by StateStore, as before', () => {
      expect(() => new StateStore(path)).toThrow(/newer/);
      untouched();
    });
  });
});

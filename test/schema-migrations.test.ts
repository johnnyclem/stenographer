import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { StateStore } from '../src/store/index.js';
import { SCHEMA_VERSION, MIGRATIONS, migrate, type Migration } from '../src/store/migrations.js';
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

/**
 * Runs `race` right after `db` first reads something matching `pattern`
 * (a pragma or a query): another process acting between this connection's
 * read and its write.
 */
function raceAfterRead(db: Database.Database, pattern: RegExp, race: () => void): void {
  let fired = false;
  const fire = () => {
    if (!fired) {
      fired = true;
      race();
    }
  };
  const pragma = db.pragma.bind(db);
  db.pragma = ((source: string, options?: Database.PragmaOptions) => {
    const result = pragma(source, options);
    if (pattern.test(source)) fire();
    return result;
  }) as typeof db.pragma;
  const prepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    const statement = prepare(source);
    if (!pattern.test(source)) return statement;
    const get = statement.get.bind(statement);
    statement.get = ((...params: unknown[]) => {
      const row = get(...params);
      fire();
      return row;
    }) as typeof statement.get;
    return statement;
  }) as typeof db.prepare;
}

const exec = promisify(execFile);
const HELPERS = join(import.meta.dirname, 'helpers');

/** Opens a StateStore on `path` in a separate node process: `ok` or `FAIL <message>`. */
async function openInProcess(path: string): Promise<string> {
  const { stdout } = await exec(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      join(HELPERS, 'ts-hooks.mjs'),
      join(HELPERS, 'open-store.mjs'),
      path,
    ],
    { timeout: 30_000 }
  );
  return stdout.trim();
}

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

  // STENO-REV-01: two sessions starting at once on one state file, or
  // `stenographer proposals` run while the server starts.
  describe('concurrent openers', () => {
    it('skip a migration step another process applied after they read the version, never writing it back lower', () => {
      const b = new Database(path);
      const a = new Database(path);
      // B has read user_version 0 when A runs the whole migration
      raceAfterRead(b, /user_version/, () => migrate(a));
      const versions: number[] = [];
      const steps: Migration[] = MIGRATIONS.map((step) => (db) => {
        step(db);
        versions.push(db.pragma('user_version', { simple: true }) as number);
      });

      expect(() => migrate(b, steps)).not.toThrow();
      // Nothing re-run behind A's back
      expect(versions).toEqual([]);
      expect(b.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      a.close();
      b.close();

      // ...and the file still opens
      expect(() => new StateStore(path).close()).not.toThrow();
    });

    it('build the vector index once when another opener built it after they looked', () => {
      const store = new StateStore(path);
      if (store.vectorSearchBackend !== 'sqlite-vec') {
        store.close();
        return;
      }
      const dimensions = store.vectorDimensions;
      const db = (store as unknown as { db: Database.Database }).db;
      db.exec('DROP TABLE message_vectors');
      // This store has looked for the table when another process builds it
      raceAfterRead(db, /name = 'message_vectors'/, () => {
        const other = new Database(path);
        sqliteVec.load(other);
        other.exec(
          `CREATE VIRTUAL TABLE message_vectors USING vec0(chunk_id TEXT PRIMARY KEY, ` +
            `session_id TEXT PARTITION KEY, embedding float[${dimensions}] distance_metric=cosine, +message_id TEXT)`
        );
        other.close();
      });

      expect(() => store.configureVectors(dimensions)).not.toThrow();
      store.close();
      expect(() => new StateStore(path).close()).not.toThrow();
    });

    it('in separate processes all open a new state file, which still opens afterwards', async () => {
      for (let round = 0; round < 10; round++) {
        const file = join(dir, `race-${round}.db`);
        const results = await Promise.all([openInProcess(file), openInProcess(file), openInProcess(file)]);
        expect(results).toEqual(['ok', 'ok', 'ok']);
        expect(await openInProcess(file)).toBe('ok');
        const db = new Database(file);
        expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
        db.close();
      }
    }, 120_000);
  });
});

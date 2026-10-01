import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Tailer, type IngestPosition } from '../src/indexer/tailer.js';
import { detectAdapter, OpenAIAdapter } from '../src/indexer/adapters.js';
import { Stenographer } from '../src/core/stenographer.js';
import { StateStore } from '../src/store/index.js';
import type { ConversationMessage, StenographerConfig } from '../src/types.js';

const line = (id: string, content: string, ts = '2026-06-09T10:00:00Z', role = 'user') =>
  JSON.stringify({ id, role, content, timestamp: ts }) + '\n';

const assistant = (id: string, content: string) => line(id, content, '2026-09-18T10:00:00Z', 'assistant');

const openai = (role: string, content: string) => JSON.stringify({ role, content }) + '\n';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `pred` holds, or gives up after `timeout` ms (the assertion that follows reports it). */
async function until(pred: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!pred() && Date.now() < deadline) await wait(20);
}

// ─────────────────────────────────────────────────────────────
// Tailer: partial lines, BOM, missing files, deletion, rotation
// ─────────────────────────────────────────────────────────────

describe('Tailer ingestion edge cases', () => {
  let dir: string;
  let tailer: Tailer | null = null;
  let received: ConversationMessage[];

  function tail(file: string): Tailer {
    received = [];
    tailer = new Tailer(file, 'session_t');
    tailer.on('message', (m: ConversationMessage) => received.push(m));
    return tailer;
  }

  const ids = () => received.map((m) => m.id);

  afterEach(() => {
    tailer?.stop();
    tailer = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a line written in two chunks is emitted once its newline arrives (IDX-03)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('m1', 'first'));
    await tail(file).start();

    const big = line('m2', 'x'.repeat(5000));
    appendFileSync(file, big.slice(0, 300));
    await wait(200);
    appendFileSync(file, big.slice(300));
    appendFileSync(file, line('m3', 'third'));

    await until(() => received.length >= 3);
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
    expect(received[1].content).toHaveLength(5000);
  });

  it('strips a UTF-8 BOM at the start of the file (IDX-27)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, '﻿' + line('m1', 'first') + line('m2', 'second'));
    await tail(file).start();
    expect(ids()).toEqual(['m1', 'm2']);
  });

  it('waits for a log that does not exist yet (IDX-28)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'later.jsonl');
    await tail(file).start();
    expect(received).toEqual([]);

    writeFileSync(file, line('l1', 'created after start'));
    await until(() => received.length >= 1);
    expect(ids()).toEqual(['l1']);
  });

  it('survives the tailed file being deleted, and picks it up when re-created (IDX-04)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('d1', 'before delete'));
    const t = tail(file);
    let removed = 0;
    t.on('removed', () => removed++);
    await t.start();

    // A write immediately followed by the unlink: the change event is
    // handled after the file is gone
    appendFileSync(file, line('dx', 'written just before delete'));
    unlinkSync(file);
    await until(() => removed > 0);
    expect(removed).toBe(1);

    writeFileSync(file, line('d2', 'after re-create'));
    await until(() => ids().includes('d2'));
    expect(ids()[0]).toBe('d1');
    expect(ids()).toContain('d2');
  });

  it('follows the path through a rename rotation (IDX-20)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('a1', 'old file'));
    await tail(file).start();

    renameSync(file, `${file}.1`);
    appendFileSync(`${file}.1`, line('a2', 'late write to the rotated file'));
    writeFileSync(file, line('a3', 'new file'));
    appendFileSync(file, line('a4', 'new file again'));

    await until(() => received.length >= 4);
    expect(ids()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('a truncate + rewrite larger than the old offset restarts from the top (IDX-20)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('b1', 'one') + line('b2', 'two'));
    await tail(file).start();

    writeFileSync(file, line('c1', 'rewritten one') + line('c2', 'rewritten two') + line('c3', 'rewritten three'));

    await until(() => received.length >= 5);
    expect(ids()).toEqual(['b1', 'b2', 'c1', 'c2', 'c3']);
  });

  it('indexes lines appended while the startup catch-up is running (IDX-19)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('s1', 'present at startup'));
    const t = tail(file);
    // Append from inside the catch-up read: the write lands after the
    // tailer sized the file, before it would otherwise start watching
    t.on('message', (m: ConversationMessage) => {
      if (m.id === 's1') appendFileSync(file, line('late', 'appended during catch-up'));
    });
    await t.start();

    await until(() => received.length >= 2);
    expect(ids()).toEqual(['s1', 'late']);
  });
});

describe('Tailer positions', () => {
  let dir: string;
  let tailer: Tailer | null = null;

  afterEach(() => {
    tailer?.stop();
    tailer = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function readAll(file: string, options: ConstructorParameters<typeof Tailer>[1] = {}) {
    const messages: Array<[string, IngestPosition]> = [];
    const progress: IngestPosition[] = [];
    const resets: string[] = [];
    tailer = new Tailer(file, { sessionId: 's', ...(options as object) });
    tailer.on('message', (m: ConversationMessage, p: IngestPosition) => messages.push([m.id, p]));
    tailer.on('progress', (p: IngestPosition) => progress.push(p));
    tailer.on('reset', (reason: string) => resets.push(reason));
    await tailer.start();
    return { messages, progress, resets };
  }

  it('resumes at a checkpoint for the same log, and starts over for a different one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-pos-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('p1', 'one') + line('p2', 'two'));

    const first = await readAll(file, { follow: false });
    const checkpoint = first.messages[1][1];
    expect(checkpoint.offset).toBe(Buffer.byteLength(line('p1', 'one') + line('p2', 'two')));
    expect(checkpoint.seq).toBe(2);

    appendFileSync(file, line('p3', 'three'));
    const resumed = await readAll(file, { follow: false, resumeFrom: checkpoint });
    expect(resumed.messages.map(([id]) => id)).toEqual(['p3']);
    expect(resumed.messages[0][1].seq).toBe(3);

    // Same path, different log (rotated while stopped): read from the top
    writeFileSync(file, line('q1', 'another log entirely') + line('q2', 'with more') + line('q3', 'lines'));
    const other = await readAll(file, { follow: false, resumeFrom: checkpoint });
    expect(other.messages.map(([id]) => id)).toEqual(['q1', 'q2', 'q3']);
    expect(other.resets).toEqual(['replaced']);
  });

  it('lines that are not messages still move the position', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-pos-'));
    const file = join(dir, 'log.jsonl');
    const content = line('k1', 'kept') + '{"type":"queue-operation"}\n\n';
    writeFileSync(file, content);
    const { progress } = await readAll(file, { follow: false });
    expect(progress.at(-1)?.offset).toBe(Buffer.byteLength(content));
    expect(progress.at(-1)?.seq).toBe(3);
  });

  it("catchup indexes a last line without a newline, but doesn't move the position past it", async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-pos-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('u1', 'terminated') + line('u2', 'unterminated').trimEnd());
    const { messages } = await readAll(file, { follow: false });
    expect(messages.map(([id]) => id)).toEqual(['u1', 'u2']);
    expect(messages[1][1].offset).toBe(Buffer.byteLength(line('u1', 'terminated')));
  });

  it('marks lines already in the file at start as replay, and later ones as live', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-pos-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, line('h1', 'history'));
    const { messages } = await readAll(file);
    appendFileSync(file, line('n1', 'new'));
    await until(() => messages.length >= 2);
    expect(messages.map(([id, p]) => [id, p.replay])).toEqual([
      ['h1', true],
      ['n1', false],
    ]);
  });
});

describe('adapter detection', () => {
  it('sees through a BOM (IDX-27)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    try {
      const file = join(dir, 'log.jsonl');
      writeFileSync(file, '﻿' + openai('user', 'hi') + openai('assistant', 'hello'));
      expect(await detectAdapter(file)).toBeInstanceOf(OpenAIAdapter);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Engine: restart idempotency, replay, detection, watch races
// ─────────────────────────────────────────────────────────────

const SUPERSESSION_LOG =
  line('m1', 'we decided to use postgres for the main database', '2026-06-09T10:00:00Z') +
  line('m2', 'we decided to use mysql for the main database', '2026-06-09T11:00:00Z');

describe('engine ingestion', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(overrides: Partial<StenographerConfig>): Promise<Stenographer> {
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: join(dir, 'state.db'),
      mode: 'live',
      embeddingModel: 'hashed',
      supersedeThreshold: 0.4,
      ...overrides,
    });
    await engine.start();
    await wait(100);
    await engine.flush();
    return engine;
  }

  async function snapshot(e: Stenographer) {
    const history = await e.getDecisionHistory();
    return {
      messages: (await e.getStatus()).messagesIndexed,
      decisions: history.map((d) => [d.id, d.description, d.superseded, d.supersededBy]),
      tombstones: (await e.getTombstones()).map((t) => t.id).sort(),
      proposals: (await e.listProposals()).map((p) => [p.id, p.body.targetRef, p.body.status]),
      entities: (await e.getEntities()).map((n) => [n.id, n.references]).sort(),
    };
  }

  for (const mode of ['live', 'catchup'] as const) {
    it(`a ${mode} restart on the same state is a no-op for every derived record (IDX-01)`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
      writeFileSync(join(dir, 'log.jsonl'), SUPERSESSION_LOG);

      const first = await snapshot(await run({ mode }));
      engine!.stop();
      engine = null;

      const e = await run({ mode });
      const second = await snapshot(e);
      expect(second).toEqual(first);

      // The chain still runs postgres → mysql: nothing was inverted
      const active = await e.getActiveDecisions();
      expect(active).toHaveLength(1);
      expect(active[0].description).toContain('mysql');
      const chain = await e.getDecisionChain(active[0].id);
      expect(chain.map((d) => d.sourceMessageId)).toEqual(['m1', 'm2']);
      expect(await e.listProposals('open')).toHaveLength(1);
      expect(await e.backfillLegacyTombstones()).toBe(1);
    });
  }

  it('assert mode keeps one active decision per fact across restarts (IDX-01)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    writeFileSync(join(dir, 'log.jsonl'), SUPERSESSION_LOG);

    await run({ truthMode: 'assert' });
    engine!.stop();
    engine = null;
    await run({ truthMode: 'assert' });
    engine!.stop();
    engine = null;

    const e = await run({ truthMode: 'assert' });
    expect(await e.getActiveDecisions()).toHaveLength(2);
    expect(await e.listProposals('open')).toHaveLength(1);
  });

  it('resumes from the checkpoint: lines written while stopped are indexed, earlier ones are not re-read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, line('r1', 'the cache is redis on port 6379'));

    const first = await run({});
    const sessionId = first.getSessionId();
    first.stop();
    engine = null;

    appendFileSync(log, line('r2', 'the queue is sqs in us-east-1'));
    const e = await run({});

    // Same log, same session: history from the first run stays in scope
    expect(e.getSessionId()).toBe(sessionId);
    expect((await e.getRecentMessages(10)).map((m) => m.id).sort()).toEqual(['r1', 'r2']);
    const refs = Object.fromEntries((await e.getEntities()).map((n) => [n.value, n.references]));
    expect(refs).toEqual({ cache: 1, queue: 1 });

    // The in-memory GraphRAG index covers messages indexed before the restart
    const hits = await e.searchGraphRAG({ query: 'cache redis port 6379', k: 5 });
    expect(hits.some((h) => h.id === 'r1')).toBe(true);

    const store = e.store;
    const checkpoint = store.getCheckpoint(log);
    expect(checkpoint?.offset).toBe(
      Buffer.byteLength(line('r1', 'the cache is redis on port 6379') + line('r2', 'the queue is sqs in us-east-1'))
    );
    expect(checkpoint?.seq).toBe(2);
    expect(checkpoint?.sessionId).toBe(sessionId);
  });

  it('a rewrite of the log with the same lines does not duplicate or invert anything', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, SUPERSESSION_LOG);
    const e = await run({});
    const before = await snapshot(e);

    // A harness rewriting the session file on resume/compaction
    writeFileSync(log, SUPERSESSION_LOG);
    await wait(300);
    await e.flush();
    expect(await snapshot(e)).toEqual(before);
  });

  it('startup replay never delivers objections, in any mode (IDX-02, T-11)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const log = join(dir, 'log.jsonl');
    const statePath = join(dir, 'state.db');
    writeFileSync(log, assistant('a1', 'Setting LOG_BUDGET = 30'));

    // Yesterday's session ran before the TB existed
    let e = await run({ objectionMode: 'deliver' });
    await e.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead',
      evidence: [{ kind: 'commit', ref: 'c1' }],
      signedBy: 'johnnyclem',
      literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
    });
    await e.assertTombstone({
      claim: 'RETRY_LIMIT 5 is dead',
      evidence: [{ kind: 'commit', ref: 'c2' }],
      signedBy: 'johnnyclem',
      literals: [{ subject: 'RETRY_LIMIT', dead: '5' }],
    });
    e.stop();
    engine = null;

    // Restart with no new lines: nothing historical is objected to
    e = await run({ objectionMode: 'deliver' });
    expect(await e.getObjections()).toEqual([]);
    e.stop();
    engine = null;

    // A second log that predates startup is replayed as shadow
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, assistant('o1', 'Setting LOG_BUDGET = 30'));
    e = await run({ objectionMode: 'deliver', logPath: other, statePath });
    expect(await e.getObjections()).toEqual([]);
    const shadow = await e.getObjections({ includeShadow: true });
    expect(shadow.map((o) => [o.messageId, o.delivered])).toEqual([['o1', false]]);

    // ...and a line appended after startup is live
    appendFileSync(other, assistant('o2', 'RETRY_LIMIT = 5'));
    await until(() => false, 300);
    await e.flush();
    expect((await e.getObjections()).map((o) => o.messageId)).toEqual(['o2']);
  });

  it('a replayed line does not silence a live objection to the same literal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    let e = await run({ objectionMode: 'deliver' });
    await e.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead',
      evidence: [{ kind: 'commit', ref: 'c1' }],
      signedBy: 'johnnyclem',
      literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
    });
    e.stop();
    engine = null;

    // The log already holds the mistake when stenographer starts: shadow
    writeFileSync(log, assistant('h1', 'Setting LOG_BUDGET = 30'));
    e = await run({ objectionMode: 'deliver' });
    expect((await e.getObjections({ includeShadow: true })).map((o) => [o.messageId, o.delivered])).toEqual([['h1', false]]);

    // The agent makes it again, live, in the same session: delivered
    appendFileSync(log, assistant('l1', 'LOG_BUDGET = 30 again'));
    await until(() => false, 300);
    await e.flush();
    expect((await e.getObjections()).map((o) => o.messageId)).toEqual(['l1']);
  });

  it('a ledger refusal while indexing a line does not cost the line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    // A truncated emoji leaves a lone surrogate in the successor decision.
    // The supersession proposal quoting it can't be canonicalized (RFC 8785),
    // so the ledger refuses it; the message and its decision are still indexed.
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use postgres for the main database', '2026-06-09T10:00:00Z') +
        line('m2', 'we decided to use mysql for the main database \ud83d', '2026-06-09T10:05:00Z')
    );
    const e = await run({ mode: 'catchup' });
    expect((await e.getStatus()).messagesIndexed).toBe(2);
    const history = await e.getDecisionHistory();
    expect(history.map((d) => d.sourceMessageId).sort()).toEqual(['m1', 'm2']);
  });

  it('auto-detection waits for the first line of an empty log (IDX-05)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const e = await run({});

    appendFileSync(log, openai('user', 'hello there') + openai('assistant', 'general kenobi'));
    await wait(300);
    await e.flush();
    expect((await e.getStatus()).messagesIndexed).toBe(2);
  });

  it('a BOM-prefixed OpenAI log is detected and indexed (IDX-27)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    writeFileSync(join(dir, 'log.jsonl'), '﻿' + openai('user', 'hello there') + openai('assistant', 'hi'));
    const e = await run({ mode: 'catchup' });
    expect((await e.getStatus()).messagesIndexed).toBe(2);
  });

  it('identical id-less lines stay distinct messages, with ids stable across restarts (IDX-26)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      openai('user', 'continue') + openai('assistant', 'done step one') + openai('user', 'continue')
    );
    let e = await run({ mode: 'catchup', adapter: 'openai' });
    const ids = (await e.getRecentMessages(10)).map((m) => m.id).sort();
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
    e.stop();
    engine = null;

    e = await run({ mode: 'catchup', adapter: 'openai' });
    expect((await e.getRecentMessages(10)).map((m) => m.id).sort()).toEqual(ids);
  });

  it('live mode waits for a log that does not exist yet (IDX-28)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const e = await run({});
    writeFileSync(join(dir, 'log.jsonl'), line('w1', 'first line of a new session'));
    await wait(300);
    await e.flush();
    expect((await e.getStatus()).messagesIndexed).toBe(1);
  });

  it('watch mode starts exactly one tailer for a new file (IDX-21)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const e = await run({ mode: 'watch', logPath: dir, statePath: ':memory:' });

    writeFileSync(join(dir, 'n.jsonl'), line('n1', 'we decided to use redis for caching'));
    await wait(400);
    await e.flush();
    const decisions = await e.getDecisionHistory();
    expect(decisions.map((d) => d.sourceMessageId)).toEqual(['n1']);
  });

  it('a transcript copied into a new session file is not re-derived (watch mode)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    const decision = line('x1', 'we decided to use redis for caching');
    writeFileSync(join(dir, 'a.jsonl'), decision);
    const e = await run({ mode: 'watch', logPath: dir, statePath: ':memory:' });

    // A resumed session opens a new log that starts with the old turns
    writeFileSync(join(dir, 'b.jsonl'), decision + line('x2', 'the cache is redis'));
    await wait(400);
    await e.flush();
    const history = await e.getDecisionHistory();
    expect(history.map((d) => d.sourceMessageId)).toEqual(['x1']);
    const messages = await e.getRecentMessages(10);
    expect(messages.map((m) => [m.id, m.sessionId]).sort()).toEqual([
      ['x1', 'b'],
      ['x2', 'b'],
    ]);
  });

  it('watch mode survives a session file being deleted (IDX-04)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-ingest-'));
    writeFileSync(join(dir, 'a.jsonl'), line('a1', 'alpha'));
    writeFileSync(join(dir, 'b.jsonl'), line('b1', 'beta'));
    const e = await run({ mode: 'watch', logPath: dir, statePath: ':memory:' });

    appendFileSync(join(dir, 'a.jsonl'), line('a2', 'written just before delete'));
    unlinkSync(join(dir, 'a.jsonl'));
    await wait(200);
    appendFileSync(join(dir, 'b.jsonl'), line('b2', 'beta again'));
    await wait(300);
    await e.flush();
    const ids = (await e.getRecentMessages(10)).map((m) => m.id);
    expect(ids).toContain('b2');
  });
});

// ─────────────────────────────────────────────────────────────
// Store: schema versioning, WAL, checkpoints
// ─────────────────────────────────────────────────────────────

describe('StateStore schema', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records its schema version and runs in WAL mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-schema-'));
    const store = new StateStore(join(dir, 'state.db'));
    store.close();

    const db = new Database(join(dir, 'state.db'));
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(2);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('migrates a pre-1.0 database in place, keeping its rows', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-schema-'));
    const path = join(dir, 'state.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, timestamp TEXT NOT NULL, embedding BLOB,
        importance_state_delta REAL, importance_reference_freq REAL,
        importance_trajectory_disc REAL, entity_ids TEXT);
      CREATE TABLE decisions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, description TEXT NOT NULL,
        timestamp TEXT NOT NULL, superseded INTEGER DEFAULT 0, superseded_by TEXT);
      CREATE TABLE tombstones (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, superseded TEXT NOT NULL,
        corrected_to TEXT NOT NULL, reason TEXT, timestamp TEXT NOT NULL);
      INSERT INTO decisions (id, session_id, description, timestamp) VALUES ('d1', 's', 'use postgres', 't');
    `);
    legacy.close();

    const store = new StateStore(path);
    expect(store.getAllDecisions(null).map((d) => [d.id, d.sourceMessageId])).toEqual([['d1', null]]);
    expect(store.getCheckpoint('/nowhere.jsonl')).toBeNull();
    store.close();
  });

  it('refuses a database written by a newer schema', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-schema-'));
    const path = join(dir, 'state.db');
    const db = new Database(path);
    db.pragma('user_version = 999');
    db.close();
    expect(() => new StateStore(path)).toThrow(/newer/);
  });
});

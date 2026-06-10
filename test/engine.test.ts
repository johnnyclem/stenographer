import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import type { StenographerConfig } from '../src/types.js';

const line = (id: string, content: string, ts: string) =>
  JSON.stringify({ id, role: 'user', content, timestamp: ts }) + '\n';

// Tests use the hashed embedder: deterministic, offline, no model download.
function makeEngine(dir: string, overrides: Partial<StenographerConfig> = {}): Stenographer {
  return new Stenographer({
    logPath: join(dir, 'log.jsonl'),
    statePath: ':memory:',
    mode: 'catchup',
    embeddingModel: 'hashed',
    ...overrides,
  });
}

describe('Stenographer engine', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('catchup mode indexes a completed file end-to-end', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-eng-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use postgres for the database', '2026-06-09T10:00:00Z') +
        line('m2', 'the deploy runs on github actions', '2026-06-09T10:01:00Z')
    );

    engine = makeEngine(dir);
    await engine.start();

    const status = await engine.getStatus();
    expect(status.messagesIndexed).toBe(2);
    expect(status.decisions).toBe(1);

    const results = await engine.searchSimilar('postgres database decision', 1);
    expect(results[0].id).toBe('m1');

    const frame = await engine.buildContextFrame(2000);
    expect(frame).toContain('## Decisions');
  });

  it('supersedes a decision when a similar newer decision arrives', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-eng-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use postgres for the main database', '2026-06-09T10:00:00Z') +
        line('m2', 'we decided to use mysql for the main database', '2026-06-09T11:00:00Z')
    );

    engine = makeEngine(dir, { supersedeThreshold: 0.4 });
    await engine.start();

    const active = await engine.getActiveDecisions();
    expect(active).toHaveLength(1);
    expect(active[0].description).toContain('mysql');

    const history = await engine.getDecisionHistory();
    expect(history).toHaveLength(2);
    const old = history.find((d) => d.description.includes('postgres'))!;
    expect(old.superseded).toBe(true);
    expect(old.supersededBy).toBe(active[0].id);

    // Chain walks oldest → current from either end
    const chain = await engine.getDecisionChain(old.id);
    expect(chain.map((d) => d.id)).toEqual([old.id, active[0].id]);
    expect(await engine.getDecisionChain(active[0].id)).toEqual(chain);

    // The supersession left a tombstone with provenance
    const tombstones = await engine.getTombstones();
    const ts = tombstones.find((t) => t.supersededDecisionId === old.id)!;
    expect(ts.correctedTo).toContain('mysql');
    expect(ts.sourceMessageId).toBe('m2');
  });

  it('a correction supersedes the matching decision', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-eng-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use port 5432 for the postgres database', '2026-06-09T10:00:00Z') +
        line('m2', 'actually, use port 5433 for the postgres database', '2026-06-09T11:00:00Z')
    );

    engine = makeEngine(dir, { supersedeThreshold: 0.4 });
    await engine.start();

    const active = await engine.getActiveDecisions();
    expect(active).toHaveLength(1);
    expect(active[0].description).toContain('5433');

    const history = await engine.getDecisionHistory();
    expect(history).toHaveLength(2);
    expect(history.filter((d) => d.superseded)).toHaveLength(1);
  });

  it('dissimilar decisions stay independently active', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-eng-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use postgres for storage', '2026-06-09T10:00:00Z') +
        line('m2', 'we decided to deploy on fridays after standup', '2026-06-09T11:00:00Z')
    );

    engine = makeEngine(dir);
    await engine.start();

    expect(await engine.getActiveDecisions()).toHaveLength(2);
  });

  it('watch mode indexes every session file in a directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-eng-'));
    writeFileSync(join(dir, 'a.jsonl'), line('a1', 'alpha message about caching', '2026-06-09T10:00:00Z'));
    writeFileSync(join(dir, 'b.jsonl'), line('b1', 'beta message about deploys', '2026-06-09T10:01:00Z'));

    engine = makeEngine(dir, { mode: 'watch', logPath: dir });
    await engine.start();
    await engine.flush();

    const status = await engine.getStatus();
    expect(status.messagesIndexed).toBe(2);

    const messages = await engine.getRecentMessages(10);
    const sessions = new Set(messages.map((m) => m.sessionId));
    expect(sessions).toEqual(new Set(['session_a', 'session_b']));
  });

  it('rejects watch mode on a non-directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-eng-'));
    engine = makeEngine(dir, { mode: 'watch', logPath: join(dir, 'missing') });
    await expect(engine.start()).rejects.toThrow(/existing directory/);
    engine = null;
  });
});

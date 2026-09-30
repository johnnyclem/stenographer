import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import type { StenographerConfig } from '../src/types.js';

const line = (id: string, content: string, ts: string) =>
  JSON.stringify({ id, role: 'user', content, timestamp: ts }) + '\n';

describe('supersession scope and order', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (overrides: Partial<StenographerConfig>) =>
    new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
      ...overrides,
    });

  it('watch mode supersedes across sessions (IDX-12)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-supersede-'));
    writeFileSync(
      join(dir, 'monday.jsonl'),
      line('mon1', 'we decided to use port 5432 for the postgres database', '2026-06-08T10:00:00Z')
    );
    writeFileSync(
      join(dir, 'tuesday.jsonl'),
      line('tue1', 'we decided to use port 5433 for the postgres database', '2026-06-09T10:00:00Z')
    );

    engine = make({ mode: 'watch', logPath: dir });
    await engine.start();
    await engine.flush();

    const active = await engine.getActiveDecisions();
    expect(active.map((d) => d.description)).toEqual(['use port 5433 for the postgres database']);
    const history = await engine.getDecisionHistory();
    expect(history.find((d) => d.sourceMessageId === 'mon1')?.supersededBy).toBe(active[0].id);
  });

  it('a decision indexed after a newer version of itself is closed by it, not the other way round (IDX-12)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-supersede-'));
    // Directory order replays the newer session first
    writeFileSync(
      join(dir, 'a-tuesday.jsonl'),
      line('tue1', 'we decided to use port 5433 for the postgres database', '2026-06-09T10:00:00Z')
    );
    writeFileSync(
      join(dir, 'b-monday.jsonl'),
      line('mon1', 'we decided to use port 5432 for the postgres database', '2026-06-08T10:00:00Z')
    );

    engine = make({ mode: 'watch', logPath: dir });
    await engine.start();
    await engine.flush();

    const active = await engine.getActiveDecisions();
    expect(active.map((d) => d.sourceMessageId)).toEqual(['tue1']);
    const tombstone = (await engine.getTombstones())[0];
    expect(tombstone.superseded).toContain('5432');
    expect(tombstone.correctedTo).toContain('5433');
  });

  it('assert mode proposes every supersession, and signing them all leaves one current version (IDX-22)', async () => {
    for (const order of ['forward', 'reverse'] as const) {
      dir = mkdtempSync(join(tmpdir(), 'steno-supersede-'));
      writeFileSync(
        join(dir, 'log.jsonl'),
        line('m1', 'we decided to use postgres 14 for the main database', '2026-06-09T10:00:00Z') +
          line('m2', 'we decided to use mysql for the main database', '2026-06-09T11:00:00Z') +
          line('m3', 'we decided to use postgres 16 for the main database', '2026-06-09T12:00:00Z')
      );
      engine = make({ truthMode: 'assert', supersedeThreshold: 0.4 });
      await engine.start();

      const open = await engine.listProposals('open');
      expect(open).toHaveLength(2);
      const successors = open.map((p) => p.body.meta?.successorDecisionId);
      expect(new Set(successors).size).toBe(2);

      for (const p of order === 'forward' ? open : [...open].reverse()) {
        await engine.signProposal(p.id, 'johnny');
      }
      expect((await engine.getActiveDecisions()).map((d) => d.description)).toEqual([
        'use postgres 16 for the main database',
      ]);

      engine.stop();
      engine = null;
      rmSync(dir, { recursive: true, force: true });
    }
    dir = mkdtempSync(join(tmpdir(), 'steno-supersede-'));
  });
});

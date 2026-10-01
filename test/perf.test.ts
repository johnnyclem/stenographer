import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';

/**
 * Indexing cost must stay flat per message as a session grows (IDX-15).
 * Before 1.0 it grew with session length: a full sort of the session per
 * message and no index for it — 1k messages took 2.2 s and 4k took 19.7 s
 * (8.8x for 4x the messages). The bound: 4,000 messages, one session,
 * hashed embedder, file-backed state, at most 20 s, and at most 6x the time
 * of 1,000 (linear is 4x).
 */
describe('indexing performance (IDX-15)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const topics = ['build', 'test runner', 'linter config', 'deploy script', 'cache layer', 'auth flow', 'router', 'logger', 'queue', 'scheduler'];

  async function timeIndexing(n: number): Promise<number> {
    const dir = mkdtempSync(join(tmpdir(), 'steno-perf-'));
    dirs.push(dir);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = topics[i % 10];
      const content =
        i % 50 === 0
          ? `we decided to use ${t} version ${i} for the release`
          : i % 3 === 0
            ? `The ${t} ${i} is failing again because the ${t} config drifted after the ${i} change`
            : `looking at ${t} ${i}: the output mentions ${t} and some other details about step ${i}`;
      lines.push(
        JSON.stringify({
          id: `m${i}`,
          role: i % 2 ? 'assistant' : 'user',
          content,
          timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        })
      );
    }
    writeFileSync(join(dir, 'log.jsonl'), lines.join('\n') + '\n');

    const started = performance.now();
    const engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: join(dir, 'state.db'),
      mode: 'catchup',
      embeddingModel: 'hashed',
    });
    await engine.start();
    const elapsed = performance.now() - started;
    expect((await engine.getStatus()).messagesIndexed).toBe(n);
    engine.stop();
    return elapsed;
  }

  it('indexes a 4,000-message session in linear time', async () => {
    const small = await timeIndexing(1000);
    const large = await timeIndexing(4000);
    expect(large).toBeLessThan(20_000);
    expect(large / small).toBeLessThan(6);
  }, 60_000);
});

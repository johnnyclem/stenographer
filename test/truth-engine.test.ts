import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import type { StenographerConfig } from '../src/types.js';

const line = (id: string, content: string, ts: string) =>
  JSON.stringify({ id, role: 'user', content, timestamp: ts }) + '\n';

// Two decisions similar enough for the hashed embedder to cross 0.4
const SUPERSESSION_LOG =
  line('m1', 'we decided to use postgres for the main database', '2026-06-09T10:00:00Z') +
  line('m2', 'we decided to use mysql for the main database', '2026-06-09T11:00:00Z');

function makeEngine(dir: string, overrides: Partial<StenographerConfig> = {}): Stenographer {
  return new Stenographer({
    logPath: join(dir, 'log.jsonl'),
    statePath: ':memory:',
    mode: 'catchup',
    embeddingModel: 'hashed',
    supersedeThreshold: 0.4,
    ...overrides,
  });
}

describe('engine truth layer (TB/UV v2)', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('shadow mode (Phase 0): auto-close continues AND a proposal is written', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-truth-'));
    writeFileSync(join(dir, 'log.jsonl'), SUPERSESSION_LOG);

    engine = makeEngine(dir); // truthMode defaults to shadow
    await engine.start();

    // Legacy behavior intact
    const active = await engine.getActiveDecisions();
    expect(active).toHaveLength(1);
    expect(active[0].description).toContain('mysql');
    expect(await engine.getTombstones()).toHaveLength(1);

    // ...and the same detection landed as a proposal, not truth
    const proposals = await engine.listProposals('open', 'tombstone');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].author).toBe('detector:supersession');
    expect(proposals[0].body.signal.source).toBe('supersession-detector');
    expect(proposals[0].body.signal.score).toBeGreaterThanOrEqual(0.4);
    expect(await engine.getTruth('current')).toHaveLength(0);
  });

  it('assert mode (Phase 1): detection is proposal-only; signing closes the decision', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-truth-'));
    writeFileSync(join(dir, 'log.jsonl'), SUPERSESSION_LOG);

    engine = makeEngine(dir, { truthMode: 'assert' });
    await engine.start();

    // No inferred write landed as truth: both decisions still active
    const active = await engine.getActiveDecisions();
    expect(active).toHaveLength(2);
    expect(await engine.getTombstones()).toHaveLength(0);

    const proposals = await engine.listProposals('open');
    expect(proposals).toHaveLength(1);

    // An accountable author signs — now it is truth, and the decision closes
    const tb = await engine.signProposal(proposals[0].id, 'johnny');
    expect(tb.type).toBe('TB');
    expect((tb.body as { signedBy: string }).signedBy).toBe('johnny');

    const afterSign = await engine.getActiveDecisions();
    expect(afterSign).toHaveLength(1);
    expect(afterSign[0].description).toContain('mysql');
    expect(await engine.getTruth('current')).toHaveLength(1);
  });

  it('dismissing a proposal in assert mode leaves the ledger untouched', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-truth-'));
    writeFileSync(join(dir, 'log.jsonl'), SUPERSESSION_LOG);

    engine = makeEngine(dir, { truthMode: 'assert' });
    await engine.start();

    const proposals = await engine.listProposals('open');
    await engine.dismissProposal(proposals[0].id, 'johnny', 'not the same decision');

    expect(await engine.getActiveDecisions()).toHaveLength(2);
    expect(await engine.getTruth('current')).toHaveLength(0);
    expect(await engine.listProposals('open')).toHaveLength(0);
  });

  it('verification queue ranks contested first, deprioritizes ask, uses context relevance', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-truth-'));
    writeFileSync(join(dir, 'log.jsonl'), line('m1', 'hello', '2026-06-09T10:00:00Z'));

    engine = makeEngine(dir, { truthMode: 'assert' });
    await engine.start();

    const tb = await engine.assertTombstone({
      claim: 'the rate limiter uses a fixed window',
      evidence: [{ kind: 'commit', ref: 'abc1234' }],
      signedBy: 'johnny',
    });
    const askUv = await engine.assertUv({
      assertion: 'the deploy pipeline caches stale artifacts sometimes',
      basis: 'tribal knowledge',
      verifyBy: { kind: 'ask', value: 'ops-team' },
      author: 'sam',
    });
    const relevantUv = await engine.assertUv({
      assertion: 'the rate limiter sliding window resets on config reload',
      basis: 'observed in staging',
      verifyBy: { kind: 'command', value: 'npm test -- rate-limiter' },
      author: 'sam',
    });
    const contestingUv = await engine.assertUv({
      assertion: 'the fixed window claim is outdated since the v2 refactor',
      basis: 'code reading',
      verifyBy: { kind: 'inspect', value: 'src/limiter.ts' },
      contests: tb.id,
      author: 'alex',
    });

    const queue = await engine.getVerificationQueue('editing rate limiter sliding window code');
    expect(queue.map((q) => q.id)[0]).toBe(contestingUv.id);
    expect(queue[0].queueRank.contesting).toBe(true);
    // ask-shaped UV sorts after the machine-checkable ones
    expect(queue.map((q) => q.id).indexOf(askUv.id)).toBeGreaterThan(
      queue.map((q) => q.id).indexOf(relevantUv.id)
    );
    expect(queue.find((q) => q.id === askUv.id)!.queueRank.deprioritized).toBe(true);
  });

  it('searchTruth ranks by relevance and search_conversation-style filters work', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-truth-'));
    writeFileSync(join(dir, 'log.jsonl'), line('m1', 'hello', '2026-06-09T10:00:00Z'));

    engine = makeEngine(dir, { truthMode: 'assert' });
    await engine.start();

    await engine.assertTombstone({
      claim: 'the billing service no longer reads the legacy invoices table',
      evidence: [{ kind: 'commit', ref: 'def5678' }],
      signedBy: 'johnny',
    });
    await engine.assertUv({
      assertion: 'the search index rebuild is believed to skip archived docs',
      basis: 'a user report',
      verifyBy: { kind: 'command', value: 'npm run rebuild -- --dry-run' },
      author: 'sam',
    });

    const results = await engine.searchTruth('billing invoices legacy table', 2);
    expect(results[0].type).toBe('TB');
    expect((results[0].body as { claim: string }).claim).toContain('billing');
    expect(results[0].relevance).toBeGreaterThan(results[1].relevance);
  });

  it('backfills legacy tombstones once and reports them in truth stats', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-truth-'));
    writeFileSync(join(dir, 'log.jsonl'), SUPERSESSION_LOG);

    engine = makeEngine(dir); // shadow: creates one legacy tombstone
    await engine.start();

    expect(await engine.backfillLegacyTombstones()).toBe(1);
    expect(await engine.backfillLegacyTombstones()).toBe(0);

    const stats = await engine.getTruthStats();
    expect(stats.tombstones).toBe(1);
    const truth = await engine.getTruth('current');
    const migrated = truth.find((e) => e.author === 'migration')!;
    expect(migrated).toBeDefined();
    expect((migrated.body as { signedBy: string | null }).signedBy).toBeNull();
  });
});

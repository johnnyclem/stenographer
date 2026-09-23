import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Stenographer } from '../src/core/stenographer.js';
import { TruthLedger } from '../src/truth/ledger.js';
import { findLiteralHits, assertedText } from '../src/truth/objections.js';
import { entryToWikiLine, wikiLineToEntry, importWikiEntries } from '../src/truth/wiki.js';
import { TbInputSchema, type TbEntry } from '../src/truth/types.js';
import type { StenographerConfig } from '../src/types.js';

const LOG_BUDGET = { subject: 'LOG_BUDGET', dead: '30', current: '100' };

describe('literal matcher (precision over recall)', () => {
  it('matches a dead value next to its subject across naming conventions', () => {
    expect(findLiteralHits('const LOG_BUDGET = 30;', LOG_BUDGET)).toEqual(['const LOG_BUDGET = 30;']);
    expect(findLiteralHits('logBudget: 30,', LOG_BUDGET)).toHaveLength(1);
    expect(findLiteralHits("I'll set the log budget to 30 lines.", LOG_BUDGET)).toHaveLength(1);
    expect(findLiteralHits('use 30 as the log-budget', LOG_BUDGET)).toHaveLength(1);
  });

  it('does not match other numbers, other identifiers, or distant values', () => {
    expect(findLiteralHits('const LOG_BUDGET = 300;', LOG_BUDGET)).toEqual([]);
    expect(findLiteralHits('const LOG_BUDGET = 30.5;', LOG_BUDGET)).toEqual([]);
    expect(findLiteralHits('const LOG_BUDGET_MAX = 30;', LOG_BUDGET)).toEqual([]);
    expect(findLiteralHits('const maxLogBudget = 30;', LOG_BUDGET)).toEqual([]);
    expect(findLiteralHits('const RETRIES = 30;', LOG_BUDGET)).toEqual([]);
    expect(
      findLiteralHits('LOG_BUDGET = computeFromEnvironmentAndDefaults(); const retries = 30', LOG_BUDGET)
    ).toEqual([]);
  });

  it('skips lines that discuss the change rather than assert the dead value', () => {
    expect(findLiteralHits('bumped LOG_BUDGET from 30 to 100', LOG_BUDGET)).toEqual([]);
  });

  it('matches a distinctive identifier standing alone', () => {
    const literal = { dead: 'legacyRateLimiter', current: 'TokenBucket' };
    expect(findLiteralHits('let limiter = legacyRateLimiter()', literal)).toHaveLength(1);
    expect(findLiteralHits('let limiter = legacyRateLimiterV2()', literal)).toEqual([]);
  });

  it('rejects literals too vague to match precisely', () => {
    const base = { claim: 'x', evidence: [{ kind: 'commit' as const, ref: 'abc' }], signedBy: 'jc' };
    expect(() => TbInputSchema.parse({ ...base, literals: [{ dead: '30' }] })).toThrow(/subject/);
    expect(() => TbInputSchema.parse({ ...base, literals: [{ dead: 'ab' }] })).toThrow(/subject/);
    expect(() => TbInputSchema.parse({ ...base, literals: [{ subject: 'X', dead: '30' }] })).not.toThrow();
  });

  it('reads the new side of edits and skips the old side', () => {
    const sources = assertedText({
      id: 'm',
      role: 'assistant',
      content: 'Updating the budget.',
      timestamp: '2026-09-01T00:00:00Z',
      toolCalls: [
        { name: 'Edit', input: { file_path: 'log.ts', old_string: 'LOG_BUDGET = 30', new_string: 'LOG_BUDGET = 50' } },
      ],
    });
    const text = sources.map((s) => s.text).join('\n');
    expect(text).toContain('LOG_BUDGET = 50');
    expect(text).not.toContain('LOG_BUDGET = 30');
  });
});

// ─────────────────────────────────────────────────────────────

const assistant = (id: string, content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, role: 'assistant', content, timestamp: '2026-09-18T10:00:00Z', ...extra }) + '\n';

async function settle(engine: Stenographer): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  await engine.flush();
}

describe('engine objections (§12)', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function liveEngine(overrides: Partial<StenographerConfig> = {}): Promise<{ engine: Stenographer; log: string }> {
    dir = mkdtempSync(join(tmpdir(), 'steno-obj-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    engine = new Stenographer({
      logPath: log,
      statePath: ':memory:',
      mode: 'live',
      embeddingModel: 'hashed',
      ...overrides,
    });
    await engine.start();
    return { engine, log };
  }

  async function assertBudgetTb(e: Stenographer): Promise<TbEntry> {
    return e.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead; the budget is 100',
      evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
      signedBy: 'johnnyclem',
      literals: [LOG_BUDGET],
    });
  }

  it('deliver mode: raises an objection with objection, exhibit, and transcript line', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    const tb = await assertBudgetTb(e);

    appendFileSync(log, assistant('a1', 'Plan: set LOG_BUDGET = 30 so the logs stay small.'));
    await settle(e);

    const flags = await e.getObjections();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      tbId: tb.id,
      messageId: 'a1',
      status: 'pending',
      delivered: true,
      transcriptLine: 'Plan: set LOG_BUDGET = 30 so the logs stay small.',
      source: 'text',
    });
    expect(flags[0].objection).toContain(tb.id);
    expect(flags[0].objection).toContain('current value: 100');
    expect(flags[0].exhibit.tombstone.id).toBe(tb.id);
    expect(flags[0].exhibit.tombstone.body.claim).toBe(tb.body.claim);
  });

  it('only objects to assistant output, and catches values in tool-call edits', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    await assertBudgetTb(e);

    appendFileSync(
      log,
      JSON.stringify({ id: 'u1', role: 'user', content: 'should LOG_BUDGET = 30?', timestamp: '2026-09-18T10:00:00Z' }) + '\n' +
        assistant('a2', 'Editing config.', {
          toolCalls: [{ name: 'Edit', input: { old_string: 'LOG_BUDGET = 100', new_string: 'LOG_BUDGET = 30' } }],
        })
    );
    await settle(e);

    const flags = await e.getObjections();
    expect(flags).toHaveLength(1);
    expect(flags[0].messageId).toBe('a2');
    expect(flags[0].source).toBe('tool:Edit');
  });

  it('shadow mode (default): records objections but never emits them on /flags', async () => {
    const { engine: e, log } = await liveEngine();
    await assertBudgetTb(e);

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);

    expect(await e.getObjections()).toEqual([]);
    const shadow = await e.getObjections({ includeShadow: true });
    expect(shadow).toHaveLength(1);
    expect(shadow[0].delivered).toBe(false);
    expect((await e.getObjectionStats()).shadow).toBe(1);
  });

  it('off mode: the detector does not run', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'off' });
    await assertBudgetTb(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    expect(await e.getObjections({ includeShadow: true })).toEqual([]);
  });

  it('counsel does not repeat itself while an objection is pending or overruled', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    await assertBudgetTb(e);

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30') + assistant('a2', 'again, LOG_BUDGET = 30'));
    await settle(e);
    const [first] = await e.getObjections();
    expect(await e.getObjections()).toHaveLength(1);

    // Sustained: a recurrence of the same mistake is objected to again
    await e.ruleOnObjection(first.id, 'sustained', { author: 'johnnyclem', opinion: 'Budget is 100.' });
    appendFileSync(log, assistant('a3', 'reverting to LOG_BUDGET = 30'));
    await settle(e);
    const flags = await e.getObjections();
    expect(flags).toHaveLength(2);

    // Overruled: not raised again this session
    await e.ruleOnObjection(flags[1].id, 'overruled', { author: 'johnnyclem', opinion: 'Test fixture, immaterial.' });
    appendFileSync(log, assistant('a4', 'fixture LOG_BUDGET = 30'));
    await settle(e);
    expect(await e.getObjections()).toHaveLength(2);
  });

  it('rulings land in the record as ordinary RULINGs and drive the sustain rate', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    const tb = await assertBudgetTb(e);
    await e.assertTombstone({
      claim: 'legacyRateLimiter is gone; use TokenBucket',
      evidence: [{ kind: 'file', ref: 'src/limit.ts:10' }],
      signedBy: 'johnnyclem',
      literals: [{ dead: 'legacyRateLimiter', current: 'TokenBucket' }],
    });

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30\nconst l = legacyRateLimiter()'));
    await settle(e);
    const flags = await e.getObjections();
    expect(flags).toHaveLength(2);

    const budgetFlag = flags.find((f) => f.tbId === tb.id)!;
    const { objection, ruling } = await e.ruleOnObjection(budgetFlag.id, 'sustained', {
      author: 'johnnyclem',
      opinion: 'The budget was raised to 100 in a1b2c3.',
    });
    expect(objection.status).toBe('sustained');
    expect(objection.rulingId).toBe(ruling.id);
    expect(ruling.type).toBe('RULING');
    expect(ruling.body).toMatchObject({ kind: 'objection', outcome: 'sustained', target: tb.id, objectionId: budgetFlag.id });
    expect(ruling.provenance).toEqual({ kind: 'sourceMessageId', ref: 'a1' });

    // The TB itself is untouched: a ruling corroborates, it doesn't transition
    expect((await e.getTruth('current')).find((t) => t.id === tb.id)?.body).toMatchObject({ status: 'active' });

    const other = flags.find((f) => f.tbId !== tb.id)!;
    await e.ruleOnObjection(other.id, 'overruled', { author: 'johnnyclem', opinion: 'Quoted in a migration note.' });
    const stats = await e.getObjectionStats();
    expect(stats).toMatchObject({ raised: 2, sustained: 1, overruled: 1, pending: 0, sustainRate: 0.5, mode: 'deliver' });
    expect((await e.getTruthStats()).rulings).toBe(2);
  });

  it('rulings require an accountable judge, an opinion, and a pending objection', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    await assertBudgetTb(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    const [flag] = await e.getObjections();

    await expect(e.ruleOnObjection(flag.id, 'sustained', { author: 'assistant', opinion: 'x' })).rejects.toThrow(/accountable/);
    await expect(e.ruleOnObjection(flag.id, 'sustained', { author: 'johnnyclem', opinion: ' ' })).rejects.toThrow(/opinion/);
    await e.ruleOnObjection(flag.id, 'overruled', { author: 'johnnyclem', opinion: 'fine' });
    await expect(e.ruleOnObjection(flag.id, 'sustained', { author: 'johnnyclem', opinion: 'x' })).rejects.toThrow(/already/);
  });

  it('overridden TBs stop raising objections (the active-TB cache follows the ledger)', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    const tb = await assertBudgetTb(e);

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    const [flag] = await e.getObjections();
    // Sustained, so session dedupe would let a recurrence through — only
    // the override can be what silences the next one
    await e.ruleOnObjection(flag.id, 'sustained', { author: 'johnnyclem', opinion: 'Budget is 100.' });

    await e.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'revert99' }] }, { author: 'reviewer-2' });
    appendFileSync(log, assistant('a2', 'LOG_BUDGET = 30 in the new session plan'));
    await settle(e);
    expect(await e.getObjections()).toHaveLength(1);
  });

  it('contested TBs still object, with the contest in the exhibit', async () => {
    const { engine: e, log } = await liveEngine({ objectionMode: 'deliver' });
    const tb = await assertBudgetTb(e);
    const uv = await e.assertUv({
      assertion: 'The log budget of 30 was actually fine for the worker pool.',
      basis: 'observed behavior',
      verifyBy: { kind: 'command', value: 'npm run bench:logs' },
      contests: tb.id,
      author: 'reviewer-2',
    });

    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    const [flag] = await e.getObjections();
    expect(flag.objection).toContain('contested');
    expect(flag.exhibit.contestedBy.map((u) => u.id)).toEqual([uv.id]);
  });

  it('catch-up replays are recorded for shadow judging, never delivered', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-obj-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    const statePath = join(dir, 'state.db');

    // Seed the TB in the state file, then replay history against it
    const seed = new Stenographer({ logPath: join(dir, 'empty.jsonl'), statePath, mode: 'catchup', embeddingModel: 'hashed' });
    writeFileSync(join(dir, 'empty.jsonl'), '');
    await seed.start();
    await assertBudgetTb(seed);
    seed.stop();

    engine = new Stenographer({ logPath: log, statePath, mode: 'catchup', embeddingModel: 'hashed', objectionMode: 'deliver' });
    await engine.start();
    expect(await engine.getObjections()).toEqual([]);
    expect(await engine.getObjections({ includeShadow: true })).toHaveLength(1);
  });
});

describe('REST /flags', () => {
  let dir: string;
  let engine: Stenographer;

  afterEach(() => {
    engine?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves delivered objections with a since cursor', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-flags-'));
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    engine = new Stenographer({
      logPath: log,
      statePath: ':memory:',
      mode: 'live',
      embeddingModel: 'hashed',
      objectionMode: 'deliver',
      restPort: 0,
    });
    await engine.start();
    await engine.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead',
      evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
      signedBy: 'johnnyclem',
      literals: [LOG_BUDGET],
    });
    await engine.assertTombstone({
      claim: 'legacyRateLimiter is gone',
      evidence: [{ kind: 'commit', ref: 'd4e5f6' }],
      signedBy: 'johnnyclem',
      literals: [{ dead: 'legacyRateLimiter' }],
    });
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30') + assistant('a2', 'legacyRateLimiter()'));
    await settle(engine);

    const base = `http://localhost:${engine.restPort}`;
    const all = await (await fetch(`${base}/flags`)).json();
    expect(all).toHaveLength(2);
    expect(all[0]).toHaveProperty('exhibit');
    expect(all[0]).toHaveProperty('transcriptLine');

    const after = await (await fetch(`${base}/flags?since=${all[0].id}`)).json();
    expect(after.map((f: { id: string }) => f.id)).toEqual([all[1].id]);

    expect((await fetch(`${base}/flags?status=bogus`)).status).toBe(400);
    // Still read-only: rulings go through MCP, not REST
    expect((await fetch(`${base}/flags`, { method: 'POST' })).status).toBe(405);
  });
});

describe('wiki interop carries literals', () => {
  it('round-trips a TB with literals byte-stably, and one without unchanged', () => {
    const ledger = new TruthLedger(new Database(':memory:'));
    const withLiterals = ledger.assertTombstone(
      { claim: 'LOG_BUDGET 30 is dead', evidence: [{ kind: 'commit', ref: 'a1' }], signedBy: 'jc', literals: [LOG_BUDGET] },
      { author: 'jc' }
    );
    const without = ledger.assertTombstone(
      { claim: 'old doc link is dead', evidence: [{ kind: 'commit', ref: 'a2' }], signedBy: 'jc' },
      { author: 'jc' }
    );
    expect('literals' in without.body).toBe(false);

    for (const entry of [withLiterals, without]) {
      const line = entryToWikiLine(entry);
      expect(JSON.stringify(wikiLineToEntry(line).body)).toBe(JSON.stringify(entry.body));
    }
    expect(entryToWikiLine(withLiterals).literals).toEqual([LOG_BUDGET]);
  });

  it('rejects wiki lines whose literals cannot be matched precisely', () => {
    const ledger = new TruthLedger(new Database(':memory:'));
    const result = importWikiEntries(ledger, {
      lines: [
        JSON.stringify({
          id: '01J0000000000000000000000A',
          type: 'TB',
          ts: '2026-09-18T00:00:00Z',
          author: 'jc',
          claim: 'x',
          evidence: [{ kind: 'commit', ref: 'a' }],
          signedBy: 'jc',
          literals: [{ dead: '30' }],
          status: 'active',
        }),
      ],
    });
    expect(result.inserted).toBe(0);
    expect(result.errors[0].error).toMatch(/literals/);
  });
});

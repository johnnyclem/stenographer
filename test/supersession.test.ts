import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import { HashedEmbedder, cosineSimilarity } from '../src/indexer/embeddings.js';
import { canonicalize, sha256Hex } from '../src/truth/jcs.js';
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

// Under the hashed embedder (threshold 0.75), "use postgres 16 for the main
// database" scores 0.961 against "use postgres for the main database" and
// 0.923 against "use postgres 15 for the main database": it supersedes both,
// 0.038 apart, inside the default 0.05 margin. The first test checks it.
// ("postgres" itself scores 0.961 against 16 and 0.960 against 15.)
const PG15 = 'use postgres 15 for the main database';
const PG = 'use postgres for the main database';
const PG16 = 'use postgres 16 for the main database';
const said = (decision: string) => `we decided to ${decision}`;
const T = (hour: number) => `2026-06-09T${String(hour).padStart(2, '0')}:00:00Z`;
// One message asserting both. A message never supersedes its own decisions,
// so both stay active in shadow mode too, where a later one would close the other
const BOTH = line('m1', `${said(PG15)}. ${said(PG)}.`, T(10));

/** The PROPOSALs the detector filed, in ledger order: [targetRef, signal.detail]. */
const filed = (e: Stenographer) =>
  e.store.truth
    .getChainedRecords()
    .filter((r) => r.type === 'PROPOSAL')
    .map((r) => [r.targetRef, (r.body.signal as { detail?: string }).detail]);

const decisionIds = async (e: Stenographer): Promise<Record<string, string>> =>
  Object.fromEntries((await e.getDecisionHistory()).map((d) => [d.description, d.id]));

/** Everything the detector derived — decisions, index tombstones, PROPOSAL records less their ids and hashes — hashed. */
async function derived(e: Stenographer): Promise<string> {
  const proposals = e.store.truth
    .getChainedRecords()
    .filter((r) => r.type === 'PROPOSAL')
    .map(({ id: _id, hash: _hash, ...rest }) => rest);
  return sha256Hex(
    canonicalize({ decisions: await e.getDecisionHistory(), tombstones: await e.getTombstones(), proposals })
  );
}

describe('supersession near-ties', () => {
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

  /** Runs `log` in a fresh directory and returns the started engine. */
  async function run(log: string, overrides: Partial<StenographerConfig> = {}): Promise<Stenographer> {
    engine?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'steno-near-tie-'));
    writeFileSync(join(dir, 'log.jsonl'), log);
    engine = make(overrides);
    await engine.start();
    return engine;
  }

  it('the fixture near-ties above the hashed threshold, inside the default margin', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-near-tie-'));
    const hashed = new HashedEmbedder();
    const [pg15, pg, pg16] = await Promise.all([PG15, PG, PG16].map((t) => hashed.embed(t)));
    const best = cosineSimilarity(pg16, pg);
    const runnerUp = cosineSimilarity(pg16, pg15);
    expect(runnerUp).toBeGreaterThanOrEqual(hashed.supersedeThreshold);
    expect(best).toBeGreaterThan(runnerUp);
    // Inside the default margin (0.05), outside the 0.03 one used below
    expect(best - runnerUp).toBeLessThan(0.05);
    expect(best - runnerUp).toBeGreaterThan(0.03);
  });

  it('assert mode proposes every near-tied decision, not only the best match', async () => {
    for (const order of ['forward', 'reverse'] as const) {
      const e = await run(BOTH + line('m2', said(PG16), T(11)), { truthMode: 'assert' });
      const id = await decisionIds(e);
      // m2 near-ties both, the best match first
      expect(filed(e)).toEqual([
        [`${id[PG]}->${id[PG16]}`, `near-tie with ${id[PG15]}`],
        [`${id[PG15]}->${id[PG16]}`, `near-tie with ${id[PG]}`],
      ]);
      expect(await e.getActiveDecisions()).toHaveLength(3);

      // Signing every proposal, in any order, leaves one current version
      const open = await e.listProposals('open');
      for (const p of order === 'forward' ? open : [...open].reverse()) {
        await e.signProposal(p.id, 'johnny');
      }
      expect((await e.getActiveDecisions()).map((d) => d.description)).toEqual([PG16]);
    }
  });

  it('a runner-up with an open proposal into the near-tie is not proposed again', async () => {
    for (const order of ['forward', 'reverse'] as const) {
      const e = await run(
        line('m1', said(PG15), T(10)) + line('m2', said(PG), T(11)) + line('m3', said(PG16), T(12)),
        { truthMode: 'assert' }
      );
      const id = await decisionIds(e);
      // m3 near-ties m2 and m1, but m1 is already proposed as superseded by
      // m2: signing that closes it into the same chain, so m3 adds nothing
      expect(filed(e)).toEqual([
        [`${id[PG15]}->${id[PG]}`, undefined],
        [`${id[PG]}->${id[PG16]}`, undefined],
      ]);

      // Either order, including m1's proposal after its successor closed
      const open = await e.listProposals('open');
      for (const p of order === 'forward' ? open : [...open].reverse()) {
        await e.signProposal(p.id, 'johnny');
      }
      expect((await e.getActiveDecisions()).map((d) => d.description), order).toEqual([PG16]);
      expect((await e.getDecisionChain(id[PG15])).map((d) => d.description), order).toEqual([PG15, PG, PG16]);
    }
  });

  // m1 asserts postgres 16 and postgres 15; "postgres" (0.961 and 0.960
  // against them) is then restated in each of ten messages
  const RESTATED = 10;
  const restatements =
    line('m1', `${said(PG16)}. ${said(PG15)}.`, T(0)) +
    Array.from({ length: RESTATED }, (_, i) => line(`r${i + 1}`, said(PG), T(i + 1))).join('');

  /** How many PROPOSALs each message filed, and how many name each decision as superseded. */
  async function tally(e: Stenographer) {
    const proposals = await e.listProposals();
    const perMessage: Record<string, number> = {};
    const perSuperseded: Record<string, number> = {};
    for (const p of proposals) {
      perMessage[p.provenance.ref] = (perMessage[p.provenance.ref] ?? 0) + 1;
      const superseded = p.body.meta?.supersededDecisionId as string;
      perSuperseded[superseded] = (perSuperseded[superseded] ?? 0) + 1;
    }
    return { total: proposals.length, perMessage, perSuperseded };
  }

  it('restating a decision does not propose its near-ties again (shadow)', async () => {
    const e = await run(restatements);
    const id = await decisionIds(e);
    const { total, perMessage, perSuperseded } = await tally(e);

    // r1 near-ties both; every restatement after it supersedes the one before
    expect(perMessage).toEqual(
      Object.fromEntries(Array.from({ length: RESTATED }, (_, i) => [`r${i + 1}`, i === 0 ? 2 : 1]))
    );
    expect(total).toBe(RESTATED + 1);
    expect(perSuperseded[id[PG15]]).toBe(1);
    expect(perSuperseded[id[PG16]]).toBe(1);

    // r1 closed postgres 16; postgres 15, the runner-up, waits on a person.
    // Its proposal names r1, closed since: signing it closes postgres 15 all the same
    const active = await e.getActiveDecisions();
    expect(active.map((d) => [d.description, d.sourceMessageId])).toEqual([
      [PG15, 'm1'],
      [PG, `r${RESTATED}`],
    ]);
    const runnerUp = (await e.listProposals('open')).find((p) => p.body.meta?.supersededDecisionId === id[PG15])!;
    await e.signProposal(runnerUp.id, 'johnny');
    expect((await e.getActiveDecisions()).map((d) => d.sourceMessageId)).toEqual([`r${RESTATED}`]);
  });

  it('restating a decision files at most two proposals a message (assert)', async () => {
    for (const order of ['forward', 'reverse'] as const) {
      const e = await run(restatements, { truthMode: 'assert' });
      const id = await decisionIds(e);
      const { total, perMessage, perSuperseded } = await tally(e);

      // Nothing closes until a person signs, so every restatement is still
      // active and matches the next one exactly. Each files against its best
      // match and at most one version not proposed yet; m1's two once each
      expect(Math.max(...Object.values(perMessage))).toBeLessThanOrEqual(2);
      expect(total).toBeLessThanOrEqual(2 * RESTATED);
      expect(perSuperseded[id[PG15]]).toBe(1);
      expect(perSuperseded[id[PG16]]).toBe(1);

      const open = await e.listProposals('open');
      for (const p of order === 'forward' ? open : [...open].reverse()) {
        await e.signProposal(p.id, 'johnny');
      }
      expect(await e.getActiveDecisions(), order).toHaveLength(1);
    }
  });

  it('restating a rewrite files at most two proposals a message (assert)', async () => {
    // postgres, then postgres 16 (0.961) restated: each restatement matches
    // the earlier ones exactly and the first decision within the margin
    const e = await run(
      [PG, ...Array<string>(RESTATED).fill(PG16)].map((d, i) => line(`r${i}`, said(d), T(i))).join(''),
      { truthMode: 'assert' }
    );
    const id = await decisionIds(e);
    const { total, perMessage, perSuperseded } = await tally(e);
    expect(Math.max(...Object.values(perMessage))).toBeLessThanOrEqual(2);
    expect(total).toBeLessThanOrEqual(2 * RESTATED);
    expect(perSuperseded[id[PG]]).toBe(1);
  });

  it('a near-tie across an out-of-order replay closes every proposed decision when signed (watch)', async () => {
    // Directory order replays a.jsonl first: y (08:00) and x (12:00) score
    // 0.719, below the threshold, so neither closes the other. Then i
    // (10:00) near-ties x (0.869) and y (0.849): x, later, supersedes i, and
    // i supersedes y. Signing y's proposal after i closed must still close y
    const MYSQL = 'use mysql for the main database';
    const PRIMARY = 'use postgres for the primary database';
    for (const truthMode of ['shadow', 'assert'] as const) {
      for (const order of ['forward', 'reverse'] as const) {
        engine?.stop();
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = mkdtempSync(join(tmpdir(), 'steno-near-tie-'));
        writeFileSync(join(dir, 'a.jsonl'), line('y', said(MYSQL), T(8)) + line('x', said(PRIMARY), T(12)));
        writeFileSync(join(dir, 'b.jsonl'), line('i', said(PG), T(10)));
        engine = make({ mode: 'watch', logPath: dir, truthMode });
        await engine.start();
        await engine.flush();
        const e = engine;
        const id = await decisionIds(e);

        expect(filed(e), truthMode).toEqual([
          [`${id[PG]}->${id[PRIMARY]}`, `near-tie with ${id[MYSQL]}`],
          [`${id[MYSQL]}->${id[PG]}`, `near-tie with ${id[PRIMARY]}`],
        ]);
        const open = await e.listProposals('open');
        for (const p of order === 'forward' ? open : [...open].reverse()) {
          await e.signProposal(p.id, 'johnny');
        }
        expect((await e.getActiveDecisions()).map((d) => d.description), `${truthMode} ${order}`).toEqual([PRIMARY]);
        expect((await e.getDecisionChain(id[MYSQL])).map((d) => d.description), `${truthMode} ${order}`).toEqual([
          MYSQL,
          PG,
          PRIMARY,
        ]);
      }
    }
  });

  it('shadow mode still auto-closes only the best match, and proposes the runner-up too', async () => {
    const e = await run(BOTH + line('m2', said(PG16), T(11)));
    const id = await decisionIds(e);

    // Phase 0's auto-close and its index tombstone, as before
    expect((await e.getActiveDecisions()).map((d) => d.description)).toEqual([PG15, PG16]);
    expect((await e.getTombstones()).map((t) => [t.superseded, t.correctedTo, t.supersededDecisionId, t.reason])).toEqual([
      [PG, PG16, id[PG], 'Superseded by newer decision'],
    ]);

    // The runner-up, dropped before, is now a proposal a person can sign
    expect(filed(e)).toEqual([
      [`${id[PG]}->${id[PG16]}`, `near-tie with ${id[PG15]}`],
      [`${id[PG15]}->${id[PG16]}`, `near-tie with ${id[PG]}`],
    ]);
    const runnerUp = (await e.listProposals('open')).find((p) => p.body.targetRef === `${id[PG15]}->${id[PG16]}`)!;
    await e.signProposal(runnerUp.id, 'johnny');
    expect((await e.getActiveDecisions()).map((d) => d.description)).toEqual([PG16]);
  });

  it('a correction that near-ties is proposed against each match, in both truth modes', async () => {
    for (const truthMode of ['shadow', 'assert'] as const) {
      const e = await run(BOTH + line('m2', 'actually, use postgres 16 for the main database instead of postgres 15', T(11)), {
        truthMode,
      });
      const id = await decisionIds(e);
      expect(filed(e), truthMode).toEqual([
        [`${id[PG]}->${id[PG16]}`, `near-tie with ${id[PG15]}`],
        [`${id[PG15]}->${id[PG16]}`, `near-tie with ${id[PG]}`],
      ]);
      const tombstones = (await e.getTombstones()).map((t) => [t.superseded, t.supersededDecisionId, t.reason]);
      if (truthMode === 'shadow') {
        expect((await e.getActiveDecisions()).map((d) => d.description)).toEqual([PG15, PG16]);
        expect(tombstones).toEqual([[PG, id[PG], 'Correction superseded prior decision']]);
      } else {
        expect(await e.getActiveDecisions()).toHaveLength(3);
        expect(tombstones).toEqual([]);
      }
    }
  });

  it('every near-tied decision is proposed and named: there is no cap', async () => {
    const PG14 = 'use postgres 14 for the main database';
    const e = await run(line('m1', `${said(PG15)}. ${said(PG)}. ${said(PG14)}.`, T(10)) + line('m2', said(PG16), T(11)), {
      truthMode: 'assert',
    });
    const id = await decisionIds(e);
    // 14 and 15 score alike against 16 (0.923), so the decision id orders them
    const [a, b] = [id[PG14], id[PG15]].sort();
    expect(filed(e)).toEqual([
      [`${id[PG]}->${id[PG16]}`, `near-tie with ${a}, ${b}`],
      [`${a}->${id[PG16]}`, `near-tie with ${id[PG]}, ${b}`],
      [`${b}->${id[PG16]}`, `near-tie with ${id[PG]}, ${a}`],
    ]);
  });

  it('an exact tie is ordered by decision id, and shadow mode closes the first', async () => {
    // Hashed embeddings ignore case and punctuation: these two score exactly alike
    const UPPER = 'use Postgres for the main database';
    const e = await run(line('m1', `${said(UPPER)}. ${said(PG)}!`, T(10)) + line('m2', said(PG16), T(11)));
    const id = await decisionIds(e);
    const [first, second] = [id[UPPER], id[PG]].sort();
    expect(filed(e)).toEqual([
      [`${first}->${id[PG16]}`, `near-tie with ${second}`],
      [`${second}->${id[PG16]}`, `near-tie with ${first}`],
    ]);
    const scores = (await e.listProposals()).map((p) => p.body.signal.score);
    expect(scores[0]).toBe(scores[1]);
    expect((await e.getTombstones()).map((t) => t.supersededDecisionId)).toEqual([first]);
  });

  it('supersedeMargin widens the near-tie', async () => {
    // 16 scores 0.923 against 14 and 0.819 against mysql: 0.105 apart
    const PG14 = 'use postgres 14 for the main database';
    const MYSQL = 'use mysql for the main database';
    const log = line('m1', said(PG14), T(10)) + line('m2', said(MYSQL), T(11)) + line('m3', said(PG16), T(12));
    const e = await run(log, { truthMode: 'assert', supersedeMargin: 0.2 });
    const id = await decisionIds(e);
    expect(filed(e)).toEqual([
      [`${id[PG14]}->${id[MYSQL]}`, undefined],
      [`${id[PG14]}->${id[PG16]}`, `near-tie with ${id[MYSQL]}`],
      [`${id[MYSQL]}->${id[PG16]}`, `near-tie with ${id[PG14]}`],
    ]);
  });

  // What the argmax detector wrote for the same logs before near-ties were
  // proposed (`derived` of each run, captured from that code): with one
  // match, or matches farther apart than the margin, nothing changes
  type Case = [name: string, log: string, config: Partial<StenographerConfig>, derived: { shadow: string; assert: string }];
  const SINGLE: Case[] = [
    [
      'a rewrite',
      line('m1', said(PG), T(10)) + line('m2', said('use mysql for the main database'), T(11)),
      {},
      {
        shadow: '857ec71287721ce9d4097706c96c929b4c8fe4e5aa8cdfd858a933fbb91cecd6',
        assert: '92a7e19a66ed8ca322b19a0ae170b316bfda0f47f53487e8039947b02a72641d',
      },
    ],
    [
      'a correction',
      line('m1', said(PG15), T(10)) + line('m2', 'actually, use postgres 16 for the main database instead of postgres 15', T(11)),
      {},
      {
        shadow: '5f8169fc876f5bd5862709a3b94974a0f85c7238a247f75b57eb4a0cf94fdca0',
        assert: 'c6a977b4afd32a03dc35d505610ff7124da4c7640737f77aa8102e0fd1c952fe',
      },
    ],
    [
      'two matches 0.105 apart (IDX-22 at the default threshold)',
      line('m1', said('use postgres 14 for the main database'), T(10)) +
        line('m2', said('use mysql for the main database'), T(11)) +
        line('m3', said(PG16), T(12)),
      {},
      {
        shadow: '2bb3bed9dc32187f6ae67189461e530a72e579e91564773d636ff1f3fe252414',
        assert: '160515243fa23d052e9afa3d3a3e811d8888db0c9a3a79a444b62eb409d10fe2',
      },
    ],
    ...[0.03, 0].map((margin): Case => [
      `a near-tie 0.038 apart, margin ${margin}`,
      BOTH + line('m2', said(PG16), T(11)),
      { supersedeMargin: margin },
      {
        shadow: '099d68caa3c2f9048bbc05e3cd5d0e83a971ea8699663123019eced3ea7af75d',
        assert: '52622e8b314eb5b0f6a93dfcb5e7f6428b721c1e44ad0e78b50b900087ed8a1e',
      },
    ]),
  ];

  for (const [name, log, config, expected] of SINGLE) {
    it(`without a near-tie the output is byte-identical to the argmax detector's: ${name}`, async () => {
      for (const truthMode of ['shadow', 'assert'] as const) {
        const e = await run(log, { ...config, truthMode });
        for (const [, detail] of filed(e)) expect(detail).toBeUndefined();
        expect(await derived(e), truthMode).toBe(expected[truthMode]);
      }
    });
  }

  it('a near-tie found again files no second proposal for either pair', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-near-tie-'));
    const statePath = join(dir, 'state.db');
    const log = BOTH + line('m2', said(PG16), T(11));
    writeFileSync(join(dir, 'log.jsonl'), log);
    engine = make({ truthMode: 'assert', statePath });
    await engine.start();
    const first = (await engine.listProposals()).map((p) => p.id).sort();
    expect(first).toHaveLength(2);
    engine.stop();

    // A restart resumes at its checkpoint; the same line rewritten under its
    // id is indexed again, re-derives its decision and matches both again
    writeFileSync(join(dir, 'log.jsonl'), log + line('m2', `${said(PG16)}. thanks!`, T(11)));
    engine = make({ truthMode: 'assert', statePath });
    await engine.start();
    expect((await engine.listProposals()).map((p) => p.id).sort()).toEqual(first);
  });

  it('supersedeMargin must be a finite number in [0, 1), checked at construction', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-near-tie-'));
    for (const bad of [-0.01, 1, 1.5, NaN, Infinity, -Infinity, '0.05']) {
      expect(() => make({ supersedeMargin: bad as number }), String(bad)).toThrow(
        /supersedeMargin must be a finite number in \[0, 1\)/
      );
    }
    for (const good of [0, 0.05, 0.999]) make({ supersedeMargin: good }).stop();
  });
});

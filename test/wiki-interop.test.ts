import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { StateStore } from '../src/store/index.js';
import { Stenographer } from '../src/core/stenographer.js';
import { exportWikiEntries, importWikiEntries, decodeWikiLine, wikiLineHash } from '../src/truth/wiki.js';
import { SignerRegistry } from '../src/truth/identity.js';
import { appendWikiFile } from '../src/truth/wiki-file.js';
import type { TruthLedger } from '../src/truth/ledger.js';
import type { Evidence, TbEntry, UvEntry } from '../src/truth/types.js';

const commitEvidence: Evidence[] = [{ kind: 'commit', ref: 'abc1234' }];
const TEAM = SignerRegistry.load({
  signers: [
    { id: 'johnny', role: 'human' },
    { id: 'sam', role: 'human' },
    { id: 'alex', role: 'human' },
    { id: 'kim', role: 'human' },
  ],
});

function seedLedger(ledger: TruthLedger): { tb: TbEntry; uv: UvEntry; contest: UvEntry } {
  const tb = ledger.assertTombstone(
    { claim: 'The API is REST-only; the gRPC port was removed', evidence: commitEvidence, signedBy: 'johnny' },
    { author: 'johnny', timestamp: '2026-02-01T00:00:00Z' }
  );
  const uv = ledger.assertUv(
    {
      assertion: 'I believe the retry budget is shared across tenants',
      basis: 'observed cross-tenant throttling in staging',
      verifyBy: { kind: 'inspect', value: 'src/retry.ts', detail: 'look for a per-tenant key' },
    },
    { author: 'sam', timestamp: '2026-02-02T00:00:00Z' }
  );
  const contest = ledger.assertUv(
    {
      assertion: 'The gRPC port still answers on staging',
      basis: 'a dashboard panel still shows traffic',
      verifyBy: { kind: 'command', value: 'grpcurl staging:443 list' },
      contests: tb.id,
    },
    { author: 'alex', timestamp: '2026-02-03T00:00:00Z' }
  );
  return { tb, uv, contest };
}

const status = (ledger: TruthLedger, id: string) => (ledger.getEntry(id)!.body as { status: string }).status;
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));
/** A line without what its writer adds: chain fields, and where the writer got the entry. */
const content = (lines: string[]) =>
  parse(lines).map(({ prevHash: _p, hash: _h, 'x-steno': x, ...rest }) => {
    if (!x) return rest;
    const { origin: _o, ledgerHash: _l, ...steno } = x;
    return { ...rest, 'x-steno': steno };
  });
/** A one-line stream of `fields`, hashed as a writer would. */
const streamLine = (fields: Record<string, unknown>) => {
  const line = { schemaVersion: 2, seq: 1, ...fields, prevHash: null };
  return JSON.stringify({ ...line, hash: wikiLineHash(line) });
};

describe('wiki interop (§8)', () => {
  let storeA: StateStore;
  let storeB: StateStore;

  beforeEach(() => {
    storeA = new StateStore(':memory:');
    storeB = new StateStore(':memory:');
  });

  afterEach(() => {
    storeA.close();
    storeB.close();
  });

  it('round-trip invariant: import(export(ledger)) holds the same truth, and exports it again line for line', () => {
    const { tb } = seedLedger(storeA.truth);

    const first = exportWikiEntries(storeA.truth);
    expect(parse(first.lines).map((l) => l.type)).toEqual(['TB', 'UV', 'UV', 'TRANSITION']);

    const result = importWikiEntries(storeB.truth, { lines: first.lines });
    expect(result).toMatchObject({ committed: true, inserted: 3, derived: 1, proposals: [], errors: [] });

    // The same lines, but B is their writer: its own chain, and the entries came from the wiki
    const second = exportWikiEntries(storeB.truth);
    expect(content(second.lines)).toEqual(content(first.lines));
    expect(parse(second.lines).every((l) => l.type === 'TRANSITION' || l['x-steno'].origin === 'wiki')).toBe(true);

    // The contest travelled with the UV: the TB is contested in B too
    expect(storeB.truth.getContested()).toHaveLength(1);
    expect(status(storeB.truth, tb.id)).toBe('contested');
  });

  it('writes one hash-chained stream: seq, prevHash, hash over the line, and the ledger hash under x-steno', () => {
    const { tb, contest } = seedLedger(storeA.truth);
    const lines = parse(exportWikiEntries(storeA.truth).lines);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(lines[0]).toMatchObject({ schemaVersion: 2, id: tb.id, type: 'TB', status: 'active', prevHash: null });
    for (const [i, line] of lines.entries()) {
      expect(line.hash).toBe(wikiLineHash(line));
      if (i > 0) expect(line.prevHash).toBe(lines[i - 1].hash);
    }
    expect(lines[0]['x-steno'].ledgerHash).toBe(storeA.truth.getChainedRecords()[0].hash);
    // The contest is the UV's line, and the TB's change of status is a TRANSITION it caused
    expect(lines[3]).toMatchObject({
      type: 'TRANSITION',
      target: tb.id,
      status: 'contested',
      cause: { kind: 'contest', ref: contest.id },
      author: 'alex',
    });
    expect(decodeWikiLine(JSON.stringify(lines[0]))).toMatchObject({ version: 2, seq: 1 });
  });

  it('re-import is a no-op (unchanged), never a duplicate', () => {
    seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines });
    const again = importWikiEntries(storeB.truth, { lines });
    expect(again).toMatchObject({ committed: true, inserted: 0, unchanged: 3, derived: 1, proposals: [] });
    expect(storeB.truth.getStats().tombstones).toBe(1);
  });

  it('a contradicting wiki entry generates a reconciliation proposal — it does not auto-win — once', () => {
    seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines });

    // Another writer's stream, with a different body under an id B already holds
    const { seq: _s, prevHash: _p, hash: _h, ...tb } = JSON.parse(lines[0]);
    const tampered = [streamLine({ ...tb, claim: 'A conflicting claim from the wiki' })];

    const result = importWikiEntries(storeB.truth, { lines: tampered });
    expect(result.conflicts).toHaveLength(1);
    expect(result.proposals).toMatchObject([{ reason: 'conflict' }]);

    // The local copy is untouched; the conflict sits in the review inbox
    const proposals = storeB.truth.listProposals('open');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].body.signal.source).toBe('wiki-reconciliation');
    const local = storeB.truth.getEntry(result.conflicts[0].id)!;
    expect((local.body as { claim: string }).claim).not.toContain('conflicting');

    // Re-importing the same file raises nothing new
    const again = importWikiEntries(storeB.truth, { lines: tampered });
    expect(again).toMatchObject({ proposals: [], conflicts: [] });
    expect(storeB.truth.listProposals()).toHaveLength(1);
  });

  it('accepts wiki-native UV lines without x-steno and preserves ids/authors', () => {
    const line = JSON.stringify({
      id: '01WIKI00000000000000000000',
      type: 'UV',
      ts: '2026-01-15T00:00:00Z',
      author: 'teammate',
      assertion: 'The cron box has a stale hosts file',
      basis: 'deploys skip it',
      verifyBy: { kind: 'ask', value: 'ops' },
      contests: null,
      status: 'open',
    });

    const result = importWikiEntries(storeB.truth, { lines: [line] });
    expect(result.inserted).toBe(1);
    const entry = storeB.truth.getEntry('01WIKI00000000000000000000')!;
    expect(entry.author).toBe('teammate');
    expect(entry.origin).toBe('wiki');
    expect(entry.provenance.kind).toBe('wiki');
  });

  it('chains imported entries, so the importing ledger still verifies', () => {
    seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines });
    expect(storeB.truth.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('never exports proposals — the wiki only ever sees signed truth', () => {
    seedLedger(storeA.truth);
    storeA.truth.addProposal(
      {
        kind: 'tombstone',
        draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] },
        signal: { source: 'supersession-detector' },
        targetRef: 'd1',
      },
      { author: 'detector:supersession' }
    );
    const { lines } = exportWikiEntries(storeA.truth);
    expect(lines).toHaveLength(4);
    expect(parse(lines).map((l) => l.type)).not.toContain('PROPOSAL');
  });
});

describe('STENO-T-03: import runs the write-time invariants', () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(':memory:');
  });
  afterEach(() => store.close());

  const tbLine = (over: Record<string, unknown>) =>
    JSON.stringify({
      id: '01WIKITB000000000000000000',
      type: 'TB',
      ts: '2026-01-15T00:00:00Z',
      author: 'kim',
      claim: 'The cron box was retired',
      evidence: [{ kind: 'wiki', ref: 'ops/cron' }],
      signedBy: 'kim',
      status: 'active',
      ...over,
    });

  it.each([
    ['an anonymous author', { author: 'system' }, /anonymous|generic/],
    ['an anonymous signer', { signedBy: 'assistant' }, /anonymous|generic/],
    ['a reserved author', { author: 'detector:wiki-sync' }, /reserved/],
    ['no evidence', { evidence: [] }, /evidence/],
    ['no claim', { claim: undefined }, /claim/],
  ])('rejects a TB line with %s', (_what, over, message) => {
    const result = importWikiEntries(store.truth, { lines: [tbLine(over)] });
    expect(result.committed).toBe(false);
    expect(result.errors).toMatchObject([{ line: 1, error: expect.stringMatching(message) }]);
    expect(store.truth.getEntry('01WIKITB000000000000000000')).toBeNull();
    expect(store.truth.listProposals()).toHaveLength(0);
  });

  it('fails closed on a status it does not know: a proposal, never truth', () => {
    const result = importWikiEntries(store.truth, { lines: [tbLine({ status: 'totally-made-up' })] });
    expect(result).toMatchObject({ committed: true, inserted: 0, proposals: [{ reason: 'unknown-status' }] });
    expect(store.truth.getTruth('all')).toHaveLength(0);
  });

  it('files an unhashed (v1) TB as a proposal, never as active truth', () => {
    const result = importWikiEntries(store.truth, { lines: [tbLine({})] });
    expect(result).toMatchObject({ committed: true, inserted: 0, proposals: [{ line: 1, reason: 'unverifiable' }] });
    expect(store.truth.getEntry('01WIKITB000000000000000000')).toBeNull();
    expect(store.truth.getTruth('all')).toHaveLength(0);
    const [proposal] = store.truth.listProposals('open');
    expect(proposal).toMatchObject({
      author: 'detector:wiki-sync',
      body: { kind: 'tombstone', requiresNotary: true, targetRef: '01WIKITB000000000000000000', signal: { source: 'wiki-reconciliation' } },
    });
  });

  it('files an unsigned TB (signedBy null) as a proposal', () => {
    const result = importWikiEntries(store.truth, { lines: [tbLine({ signedBy: null })] });
    expect(result.proposals).toMatchObject([{ reason: 'unsigned' }]);
    expect(store.truth.getStats().tombstones).toBe(0);
  });

  it('files a hashed TB whose signer the signer registry does not list as a proposal', () => {
    const origin = new StateStore(':memory:');
    origin.truth.assertTombstone({ claim: 'The cron box was retired', evidence: commitEvidence, signedBy: 'mallory' }, { author: 'mallory' });
    const { lines } = exportWikiEntries(origin.truth);
    origin.close();

    const result = importWikiEntries(store.truth, { lines }, { signers: TEAM });
    expect(result.proposals).toMatchObject([{ reason: 'unverifiable' }]);
    expect(store.truth.getStats().tombstones).toBe(0);
  });

  it('a reconciliation proposal is raised once: re-imports after it is dismissed or signed raise nothing and mint nothing', () => {
    importWikiEntries(store.truth, { lines: [tbLine({})] });
    const [proposal] = store.truth.listProposals('open');
    store.truth.dismissProposal(proposal.id, 'johnny', 'not ours');
    expect(importWikiEntries(store.truth, { lines: [tbLine({})] })).toMatchObject({ unchanged: 1, proposals: [] });

    const other = tbLine({ id: '01WIKITB000000000000000001', claim: 'The batch box was retired' });
    importWikiEntries(store.truth, { lines: [other] });
    const [open] = store.truth.listProposals('open');
    store.truth.signProposal(open.id, 'johnny', undefined, { notarized: true });
    expect(store.truth.getStats().tombstones).toBe(1);
    expect(importWikiEntries(store.truth, { lines: [other] })).toMatchObject({ unchanged: 1, proposals: [] });
    expect(store.truth.getStats().tombstones).toBe(1);
    expect(store.truth.listProposals('open')).toHaveLength(0);
  });

  it('the ledger admits an imported entry by the same check as a live write', () => {
    const entry = {
      id: '01DIRECTTB0000000000000000',
      type: 'TB' as const,
      createdAt: '2026-01-15T00:00:00Z',
      author: 'kim',
      provenance: { kind: 'wiki' as const },
      agentSessionId: null,
      origin: 'wiki' as const,
      body: { claim: 'c', evidence: [{ kind: 'commit', ref: 'a1' }], signedBy: 'system' },
    };
    expect(() => store.truth.importEntry(entry, [])).toThrow(/signer 'system' is not an accountable identity/);
    expect(() => store.truth.importEntry({ ...entry, body: { ...entry.body, signedBy: 'kim', evidence: [] } }, [])).toThrow(/evidence/);
    expect(() => store.truth.importEntry({ ...entry, body: { ...entry.body, signedBy: 'kim', status: 'made-up' } }, [])).toThrow(/status/);
    expect(() =>
      store.truth.importEntry({ ...entry, body: { ...entry.body, signedBy: 'kim' } }, [{ fromId: entry.id, toId: 'x', type: 'overrides' }])
    ).toThrow(/cannot write a 'overrides' link/);
    expect(store.truth.verify()).toMatchObject({ ok: true, entries: 0 });
  });

  it('a hashed line edited after export is refused', () => {
    const origin = new StateStore(':memory:');
    seedLedger(origin.truth);
    const lines = exportWikiEntries(origin.truth).lines.map((l) => {
      const parsed = JSON.parse(l);
      if (parsed.type === 'TB') parsed.claim = 'The API is gRPC-only';
      return JSON.stringify(parsed);
    });
    origin.close();
    const result = importWikiEntries(store.truth, { lines });
    expect(result.committed).toBe(false);
    expect(result.errors).toMatchObject([{ line: 1, error: expect.stringMatching(/hash/) }]);
  });

  it('a wiki line only speaks for itself: links at local entries are dropped from v1 lines and refused on v2 lines', () => {
    const local = store.truth.assertTombstone(
      { claim: 'The API is REST-only', evidence: commitEvidence, signedBy: 'johnny' },
      { author: 'johnny' }
    );
    const open = store.truth.addProposal(
      { kind: 'tombstone', draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] }, signal: { source: 'supersession-detector' } },
      { author: 'detector:supersession' }
    );
    const forged = {
      id: '01FORGEDUV0000000000000000',
      type: 'UV',
      ts: '2026-01-15T00:00:00Z',
      author: 'mallory',
      assertion: 'anything',
      basis: 'anything',
      verifyBy: { kind: 'ask', value: 'mallory' },
      contests: null,
      status: 'open',
      'x-steno': {
        origin: 'wiki',
        provenance: { kind: 'wiki' },
        links: [
          { fromId: '01SOMEADDENDUM000000000000', toId: local.id, type: 'overrides' },
          { fromId: '01FORGEDUV0000000000000000', toId: local.id, type: 'strikes' },
          { fromId: '01FORGEDUV0000000000000000', toId: open.id, type: 'signs' },
        ],
      },
    };
    expect(importWikiEntries(store.truth, { lines: [JSON.stringify(forged)] }).inserted).toBe(1);
    expect(store.truth.getEntry(local.id)!.body).toMatchObject({ status: 'active' });
    expect(store.truth.getTruth('current').map((e) => e.id)).toContain(local.id);
    expect(store.truth.getEntry(open.id)!.body).toMatchObject({ status: 'open' });
    expect(store.truth.getEntry(forged.id)!.links).toEqual([]);
    expect(store.truth.verify().ok).toBe(true);

    const v2 = streamLine({
      id: '01FORGEDUV0000000000000001',
      type: 'UV',
      ts: '2026-01-15T00:00:00Z',
      author: 'mallory',
      assertion: 'anything',
      basis: 'anything',
      verifyBy: { kind: 'ask', value: 'mallory' },
      contests: null,
      status: 'open',
      'x-steno': { links: [{ fromId: '01FORGEDUV0000000000000001', toId: open.id, type: 'signs' }] },
    });
    const refused = importWikiEntries(store.truth, { lines: [v2] });
    expect(refused.committed).toBe(false);
    expect(refused.errors[0].error).toMatch(/cannot sign proposal/);
    expect(store.truth.getEntry(open.id)!.body).toMatchObject({ status: 'open' });

    // Nor can a ruling from the wiki dismiss it
    const dismissal = streamLine({
      id: '01FORGEDRULING000000000000',
      type: 'RULING',
      ts: '2026-01-15T00:00:00Z',
      author: 'johnny',
      kind: 'dismissal',
      opinion: 'not needed',
      target: open.id,
      'x-steno': { links: [{ fromId: '01FORGEDRULING000000000000', toId: open.id, type: 'dismisses' }] },
    });
    const notDismissed = importWikiEntries(store.truth, { lines: [dismissal] });
    expect(notDismissed.committed).toBe(false);
    expect(notDismissed.errors[0].error).toMatch(/cannot dismiss proposal/);
    expect(store.truth.getEntry(open.id)!.body).toMatchObject({ status: 'open' });
  });
});

describe('STENO-T-09: one transaction per file, with a per-line report', () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(':memory:');
  });
  afterEach(() => store.close());

  const uv = (id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id,
      type: 'UV',
      ts: '2026-01-15T00:00:00Z',
      author: 'teammate',
      assertion: `Belief ${id}`,
      basis: 'b',
      verifyBy: { kind: 'ask', value: 'ops' },
      contests: null,
      status: 'open',
      ...over,
    });

  it('a bad line in the middle rolls back the whole file, reports it, and does not throw', () => {
    const lines = [uv('01GOOD1'), uv('01BAD', { author: null }), uv('01GOOD2')];
    const result = importWikiEntries(store.truth, { lines });
    expect(result).toMatchObject({ committed: false, inserted: 0, errors: [{ line: 2, id: '01BAD' }] });
    expect(store.truth.getEntry('01GOOD1')).toBeNull();
    expect(store.truth.getEntry('01GOOD2')).toBeNull();
    expect(store.truth.verify()).toMatchObject({ ok: true, entries: 0 });
  });

  it('reports every bad line, not just the first', () => {
    const badLink = uv('01BADLINK', {
      'x-steno': { origin: 'wiki', provenance: { kind: 'wiki' }, links: [{ fromId: 42, toId: '01X', type: 'contests' }] },
    });
    const result = importWikiEntries(store.truth, {
      lines: ['not json', uv('01GOOD1'), badLink, '{"type":"PROPOSAL","id":"x"}'],
    });
    expect(result.committed).toBe(false);
    expect(result.errors.map((e) => e.line)).toEqual([1, 3, 4]);
  });

  it('commits a clean file', () => {
    const result = importWikiEntries(store.truth, { lines: [uv('01GOOD1'), uv('01GOOD2')] });
    expect(result).toMatchObject({ committed: true, inserted: 2, errors: [] });
  });
});

describe('STENO-T-07: transitions travel, and reconciliation converges', () => {
  let storeA: StateStore;
  let storeB: StateStore;
  beforeEach(() => {
    storeA = new StateStore(':memory:');
    storeB = new StateStore(':memory:');
  });
  afterEach(() => {
    storeA.close();
    storeB.close();
  });

  it('a strike on A strikes the entry on B', () => {
    const { tb } = seedLedger(storeA.truth);
    storeA.truth.fileRuling({ kind: 'strike', opinion: 'cites an abandoned branch', target: tb.id }, { author: 'kim' });
    const { lines } = exportWikiEntries(storeA.truth);
    expect(parse(lines).map((l) => l.type)).toEqual(['TB', 'UV', 'UV', 'TRANSITION', 'RULING', 'TRANSITION']);
    const ruling = parse(lines)[4];
    expect(ruling).toMatchObject({ kind: 'strike', target: tb.id });
    expect(parse(lines)[5]).toMatchObject({ target: tb.id, status: 'struck', cause: { kind: 'strike', ref: ruling.id } });

    importWikiEntries(storeB.truth, { lines });
    expect(storeB.truth.getTruth('current').map((e) => e.id)).not.toContain(tb.id);
    expect(storeB.truth.getMatchableTombstones()).toHaveLength(0);
  });

  it('an override after the first export is exported by time of the transition, and applied on B', () => {
    const { tb } = seedLedger(storeA.truth);
    const first = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines: first.lines });
    expect(status(storeB.truth, tb.id)).toBe('contested');

    storeA.truth.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'feed123' }], note: 'gRPC came back' }, {
      author: 'kim',
      timestamp: '2026-03-01T00:00:00Z',
    });
    const incremental = exportWikiEntries(storeA.truth, { sinceSeq: first.lastSeq });
    const [addendum, transition] = parse(incremental.lines);
    expect(addendum).toMatchObject({ seq: first.lastSeq + 1, type: 'ADDENDUM' });
    expect(transition).toMatchObject({ type: 'TRANSITION', target: tb.id, status: 'overridden', cause: { kind: 'override', ref: addendum.id } });
    // The deprecated timestamp alias returns the same run
    expect(exportWikiEntries(storeA.truth, { since: '2026-02-15T00:00:00Z' }).lines).toEqual(incremental.lines);

    const result = importWikiEntries(storeB.truth, { lines: incremental.lines });
    expect(result).toMatchObject({ committed: true, inserted: 1, derived: 1, proposals: [], conflicts: [] });
    expect(status(storeB.truth, tb.id)).toBe('overridden');
    expect(storeB.truth.verify().ok).toBe(true);
  });

  it('re-importing the whole file after transitions changes nothing: no conflicts, no proposals, no second TB', () => {
    const { tb, contest } = seedLedger(storeA.truth);
    storeA.truth.resolveUv(contest.id, 'verified', [{ kind: 'commit', ref: 'feed123' }], {
      author: 'kim',
      signedBy: 'kim',
      opinion: 'the port answers',
    });
    const { lines } = exportWikiEntries(storeA.truth);
    const first = importWikiEntries(storeB.truth, { lines });
    expect(first).toMatchObject({ committed: true, proposals: [], held: [] });
    expect(status(storeB.truth, tb.id)).toBe('overridden');
    expect(status(storeB.truth, contest.id)).toBe('verified');
    const tombstones = storeB.truth.getStats().tombstones;

    const again = importWikiEntries(storeB.truth, { lines });
    const transitions = parse(lines).filter((l) => l.type === 'TRANSITION').length;
    expect(transitions).toBe(3);
    expect(again).toMatchObject({ inserted: 0, unchanged: lines.length - transitions, derived: transitions, proposals: [], conflicts: [] });
    expect(storeB.truth.getStats().tombstones).toBe(tombstones);
    expect(storeB.truth.listProposals()).toHaveLength(0);
  });

  it('a local contest on B is not a conflict with A\'s unchanged lines', () => {
    const { tb } = seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines });
    storeB.truth.assertUv(
      { assertion: 'gRPC is still used by the batch jobs', basis: 'cron logs', verifyBy: { kind: 'ask', value: 'ops' }, contests: tb.id },
      { author: 'lee' }
    );
    expect(importWikiEntries(storeB.truth, { lines })).toMatchObject({ unchanged: 3, derived: 1, conflicts: [], proposals: [] });
  });

  it('transitions are applied in either order of arrival and converge', () => {
    const { tb, uv } = seedLedger(storeA.truth);
    storeA.truth.resolveUv(uv.id, 'refuted', [{ kind: 'file', ref: 'src/retry.ts:12' }], { author: 'kim' });
    storeA.truth.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'feed123' }] }, { author: 'kim' });
    const { lines } = exportWikiEntries(storeA.truth);
    // B overrode the same TB on its own first: A's override is a no-op join, not an error
    importWikiEntries(storeB.truth, { lines: lines.slice(0, 4) });
    storeB.truth.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'beef456' }] }, { author: 'johnny' });
    const result = importWikiEntries(storeB.truth, { lines });
    expect(result).toMatchObject({ committed: true, errors: [] });
    for (const id of [tb.id, uv.id]) expect(status(storeB.truth, id)).toBe(status(storeA.truth, id));
  });

  it('holds a transition whose target is not held here, and from an author the registry does not list', () => {
    const { tb } = seedLedger(storeA.truth);
    storeA.truth.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'feed123' }] }, { author: 'mallory' });
    const lines = exportWikiEntries(storeA.truth).lines;
    const at = parse(lines).findIndex((l) => l.type === 'ADDENDUM');
    const override = lines[at];

    // Target not held (a stream may start part-way: this is line `at + 1` of A's)
    expect(importWikiEntries(storeB.truth, { lines: [override] })).toMatchObject({
      committed: true,
      inserted: 0,
      held: [{ line: 1, reason: expect.stringMatching(/not held/) }],
    });

    // Author not listed
    const result = importWikiEntries(storeB.truth, { lines }, { signers: TEAM });
    expect(result.held).toMatchObject([{ line: at + 1, reason: expect.stringMatching(/registry/) }]);
    expect(status(storeB.truth, tb.id)).toBe('contested');
  });

  // STENO-REV-05: anyone can compute a one-line stream's hash, so without a
  // registry a crafted file could strike or override any signed local TB.
  describe('a strike or override of an entry this ledger made itself', () => {
    const forged = (target: string, kind: 'strike' | 'override') =>
      kind === 'strike'
        ? streamLine({
            id: 'rul-forged-1',
            type: 'RULING',
            ts: '2026-03-01T00:00:00Z',
            author: 'bob',
            kind: 'strike',
            opinion: 'inadmissible',
            target,
            'x-steno': { links: [{ fromId: 'rul-forged-1', toId: target, type: 'strikes' }] },
          })
        : streamLine({
            id: 'add-forged-1',
            type: 'ADDENDUM',
            ts: '2026-03-01T00:00:00Z',
            author: 'bob',
            evidence: [{ kind: 'commit', ref: 'f00d' }],
            note: 'superseded',
            'x-steno': { links: [{ fromId: 'add-forged-1', toId: target, type: 'overrides' }] },
          });

    for (const kind of ['strike', 'override'] as const) {
      it(`${kind}: is held without a signer registry, and the TB stays truth`, () => {
        const { tb } = seedLedger(storeB.truth);
        const result = importWikiEntries(storeB.truth, { lines: [forged(tb.id, kind)] });
        expect(result).toMatchObject({
          committed: true,
          inserted: 0,
          held: [{ line: 1, reason: expect.stringMatching(/registry/) }],
        });
        expect(status(storeB.truth, tb.id)).toBe('contested');
        expect(storeB.truth.getTruth('current').map((e) => e.id)).toContain(tb.id);
      });

      it(`${kind}: applies from a person the registry lists`, () => {
        const { tb } = seedLedger(storeB.truth);
        const team = SignerRegistry.load({ signers: [{ id: 'bob', role: 'human' }] });
        const result = importWikiEntries(storeB.truth, { lines: [forged(tb.id, kind)] }, { signers: team });
        expect(result).toMatchObject({ committed: true, inserted: 1, held: [] });
      });
    }

    it('still applies, without a registry, to entries that came from the wiki (a carry-over into a new database)', () => {
      const { tb, contest } = seedLedger(storeA.truth);
      storeA.truth.fileRuling({ kind: 'strike', opinion: 'inadmissible', target: contest.id }, { author: 'kim' });
      storeA.truth.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'feed123' }] }, { author: 'kim' });
      const { lines } = exportWikiEntries(storeA.truth);
      expect(importWikiEntries(storeB.truth, { lines })).toMatchObject({ committed: true, held: [] });
      expect(status(storeB.truth, tb.id)).toBe('overridden');
      const current = storeB.truth.getTruth('current').map((e) => e.id);
      expect(storeB.truth.getEntry(contest.id)).toBeTruthy();
      expect(current).not.toContain(contest.id);
    });
  });
});

describe('STENO-T-04 / STENO-T-05: confined, append-only wiki files', () => {
  let dir: string;
  let wikiDir: string;
  let statePath: string;
  let engine: Stenographer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steno-wiki-'));
    wikiDir = join(dir, 'wiki');
    statePath = join(dir, 'stenographer.db');
    writeFileSync(join(dir, 'log.jsonl'), '');
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath,
      mode: 'catchup',
      embeddingModel: 'hashed',
    });
  });

  afterEach(() => {
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults the wiki directory to <state dir>/wiki and writes cat-able JSONL there', async () => {
    seedLedger(engine.store.truth);
    const result = await engine.exportWikiEntries({ file: 'truth.jsonl' });
    expect(result).toMatchObject({ count: 4, lastSeq: 4, appended: 4, present: 0 });
    const raw = readFileSync(join(wikiDir, 'truth.jsonl'), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(4);
  });

  it('refuses paths outside the wiki directory', async () => {
    seedLedger(engine.store.truth);
    for (const file of ['../stenographer.db', '/etc/passwd', 'sub/../../x.jsonl', join(dir, 'x.jsonl'), 'truth.db', '']) {
      await expect(engine.exportWikiEntries({ file })).rejects.toThrow();
      await expect(engine.importWikiEntries({ file })).rejects.toThrow();
    }
    // The ledger is still a database, and intact
    expect(readFileSync(statePath).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(engine.store.truth.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('refuses a symlink that escapes the wiki directory, and the state file itself', async () => {
    seedLedger(engine.store.truth);
    mkdirSync(wikiDir, { recursive: true });
    symlinkSync('/etc/passwd', join(wikiDir, 'passwd.jsonl'));
    symlinkSync(statePath, join(wikiDir, 'state.jsonl'));
    for (const file of ['passwd.jsonl', 'state.jsonl']) {
      await expect(engine.importWikiEntries({ file })).rejects.toThrow(/outside|state/);
      await expect(engine.exportWikiEntries({ file })).rejects.toThrow(/outside|state/);
    }
    expect(engine.store.truth.verify().ok).toBe(true);
  });

  it('refuses a hard link to the state file', async () => {
    mkdirSync(wikiDir, { recursive: true });
    linkSync(statePath, join(wikiDir, 'linked.jsonl'));
    await expect(engine.importWikiEntries({ file: 'linked.jsonl' })).rejects.toThrow(/state file/);
    await expect(engine.exportWikiEntries({ file: 'linked.jsonl' })).rejects.toThrow(/state file/);
  });

  it('never truncates: one writer per file, so a file holding a teammate\'s lines is refused, untouched', async () => {
    mkdirSync(wikiDir, { recursive: true });
    const teammate = JSON.stringify({
      id: '01TEAMMATE0000000000000000',
      type: 'UV',
      ts: '2026-01-15T00:00:00Z',
      author: 'teammate',
      assertion: 'The cron box has a stale hosts file',
      basis: 'deploys skip it',
      verifyBy: { kind: 'ask', value: 'ops' },
      contests: null,
      status: 'open',
    });
    const shared = join(wikiDir, 'shared.jsonl');
    writeFileSync(shared, teammate); // no trailing newline
    seedLedger(engine.store.truth);
    await expect(engine.exportWikiEntries({ file: 'shared.jsonl' })).rejects.toThrow(/one writer per wiki file/);
    expect(readFileSync(shared, 'utf8')).toBe(teammate);
  });

  it('appends only the lines its own file does not hold yet', async () => {
    const { tb } = seedLedger(engine.store.truth);
    const path = join(wikiDir, 'mine.jsonl');
    expect(await engine.exportWikiEntries({ file: 'mine.jsonl' })).toMatchObject({ appended: 4, present: 0 });
    const before = readFileSync(path, 'utf8');

    // A second export appends nothing; an override appends its addendum and the TRANSITION it causes
    expect(await engine.exportWikiEntries({ file: 'mine.jsonl' })).toMatchObject({ appended: 0, present: 4 });
    engine.store.truth.overrideTombstone(tb.id, { evidence: commitEvidence }, { author: 'kim' });
    expect(await engine.exportWikiEntries({ file: 'mine.jsonl' })).toMatchObject({ appended: 2, present: 4 });
    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split('\n')).toHaveLength(6);

    // An edited line makes the file not this ledger's: refused, untouched
    writeFileSync(path, after.replace('REST-only', 'gRPC-only'));
    await expect(engine.exportWikiEntries({ file: 'mine.jsonl' })).rejects.toThrow(/one writer per wiki file/);
  });

  it('STENO-T-10: imported entries are embedded, so search ranks them', async () => {
    const origin = new StateStore(':memory:');
    seedLedger(origin.truth);
    const { lines } = exportWikiEntries(origin.truth);
    origin.close();
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'team.jsonl'), lines.join('\n') + '\n');

    const result = await engine.importWikiEntries({ file: 'team.jsonl' });
    expect(result).toMatchObject({ committed: true, inserted: 3 });
    for (const entry of engine.store.truth.getTruth('all')) expect(entry.embedding).not.toBeNull();
    const [top] = await engine.searchTruth('retry budget shared across tenants', 1);
    expect(top.relevance).toBeGreaterThan(0);
    expect(top.type).toBe('UV');
  });

  it('STENO-T-10: entries imported without an embedding get one when search reaches them', async () => {
    const origin = new StateStore(':memory:');
    seedLedger(origin.truth);
    const { lines } = exportWikiEntries(origin.truth);
    origin.close();
    // The library import has no embedder: these land without embeddings
    importWikiEntries(engine.store.truth, { lines });
    expect(engine.store.truth.getTruth('all').every((e) => e.embedding === null)).toBe(true);
    const [top] = await engine.searchTruth('retry budget shared across tenants', 1);
    expect(top.relevance).toBeGreaterThan(0);
    expect(engine.store.truth.getTruth('all').every((e) => e.embedding !== null)).toBe(true);
  });
});

describe('the stream states what the ledger derives', () => {
  it('a migrated pre-1.0 ledger exports a valid stream whose fold matches every status', () => {
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'truth-ledger-0.x.sql'), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'steno-migrated-'));
    try {
      const path = join(dir, 'state.db');
      const raw = new Database(path);
      raw.exec(fixture);
      raw.close();
      const store = new StateStore(path);
      const { lines, skipped } = exportWikiEntries(store.truth);
      expect(skipped).toEqual([]);
      // Readers' fold: the highest-seq TRANSITION, else the entry line's status
      const folded = new Map<string, string>();
      for (const line of parse(lines)) {
        if (line.type === 'TB' || line.type === 'UV') folded.set(line.id, line.status);
        if (line.type === 'TRANSITION') folded.set(line.target, line.status);
      }
      for (const entry of store.truth.getTruth('all')) {
        const current = store.truth.getTruth('current').some((e) => e.id === entry.id);
        const status = (entry.body as { status: string }).status;
        const want = folded.get(entry.id);
        if (want === 'struck') expect(current, entry.id).toBe(false);
        else expect(want, entry.id).toBe(status);
      }
      // And a fresh ledger importing it holds the same current truth
      const other = new StateStore(':memory:');
      const result = importWikiEntries(other.truth, { lines });
      expect(result.committed).toBe(true);
      const ids = (s: StateStore) => s.truth.getTruth('current').map((e) => e.id).sort();
      // TBs land as proposals only when unsigned (the backfilled one); everything else lands as written
      expect(result.proposals.map((p) => p.reason)).toEqual(['unsigned']);
      expect(ids(other)).toEqual(ids(store).filter((id) => store.truth.getEntry(id)!.author !== 'migration'));
      other.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('appendWikiFile', () => {
  it('appends an incremental export after the run it continues, and refuses a gap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-append-'));
    try {
      const store = new StateStore(':memory:');
      const { tb } = seedLedger(store.truth);
      const target = { dir, file: 'mine.jsonl' };
      const first = exportWikiEntries(store.truth);
      expect(appendWikiFile(target, first.lines)).toMatchObject({ appended: 4, present: 0 });

      store.truth.overrideTombstone(tb.id, { evidence: commitEvidence }, { author: 'kim' });
      const next = exportWikiEntries(store.truth, { sinceSeq: first.lastSeq });
      expect(appendWikiFile(target, next.lines)).toMatchObject({ appended: 2, present: 4 });
      expect(appendWikiFile(target, next.lines)).toMatchObject({ appended: 0, present: 6 });

      store.truth.fileRuling({ kind: 'strike', opinion: 'abandoned branch', target: tb.id }, { author: 'kim' });
      const all = exportWikiEntries(store.truth).lines;
      const gap = join(dir, 'gap.jsonl');
      writeFileSync(gap, first.lines.join('\n') + '\n');
      expect(() => appendWikiFile({ dir, file: 'gap.jsonl' }, all.slice(-2))).toThrow(/gap/);
      expect(readFileSync(gap, 'utf8')).toBe(first.lines.join('\n') + '\n');
      // An empty ledger owns no lines: a file holding any is someone else's
      expect(() => appendWikiFile(target, [])).toThrow(/one writer per wiki file/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

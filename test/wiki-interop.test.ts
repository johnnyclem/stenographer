import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store/index.js';
import { exportWikiEntries, importWikiEntries } from '../src/truth/wiki.js';
import type { TruthLedger } from '../src/truth/ledger.js';
import type { Evidence } from '../src/truth/types.js';

const commitEvidence: Evidence[] = [{ kind: 'commit', ref: 'abc1234' }];

function seedLedger(ledger: TruthLedger): void {
  const tb = ledger.assertTombstone(
    { claim: 'The API is REST-only; the gRPC port was removed', evidence: commitEvidence, signedBy: 'johnny' },
    { author: 'johnny', timestamp: '2026-02-01T00:00:00Z' }
  );
  ledger.assertUv(
    {
      assertion: 'I believe the retry budget is shared across tenants',
      basis: 'observed cross-tenant throttling in staging',
      verifyBy: { kind: 'inspect', value: 'src/retry.ts', detail: 'look for a per-tenant key' },
    },
    { author: 'sam', timestamp: '2026-02-02T00:00:00Z' }
  );
  ledger.assertUv(
    {
      assertion: 'The gRPC port still answers on staging',
      basis: 'a dashboard panel still shows traffic',
      verifyBy: { kind: 'command', value: 'grpcurl staging:443 list' },
      contests: tb.id,
    },
    { author: 'alex', timestamp: '2026-02-03T00:00:00Z' }
  );
}

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

  it('round-trip invariant: import(export(ledger)) == ledger, byte-stable', () => {
    seedLedger(storeA.truth);

    const first = exportWikiEntries(storeA.truth);
    expect(first.count).toBe(3);

    const result = importWikiEntries(storeB.truth, { lines: first.lines });
    expect(result.inserted).toBe(3);
    expect(result.conflicts).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const second = exportWikiEntries(storeB.truth);
    expect(second.lines).toEqual(first.lines);

    // Statuses carried over: the contested TB is still contested in B
    const contested = storeB.truth.getContested();
    expect(contested).toHaveLength(1);
  });

  it('re-import is a no-op (unchanged), never a duplicate', () => {
    seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines });
    const again = importWikiEntries(storeB.truth, { lines });
    expect(again.inserted).toBe(0);
    expect(again.unchanged).toBe(3);
    expect(storeB.truth.getStats().tombstones).toBe(1);
  });

  it('a contradicting wiki entry generates a reconciliation proposal — it does not auto-win', () => {
    seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    importWikiEntries(storeB.truth, { lines });

    const tampered = lines.map((l) => {
      const parsed = JSON.parse(l);
      if (parsed.type === 'TB') parsed.claim = 'A conflicting claim from the wiki';
      return JSON.stringify(parsed);
    });

    const result = importWikiEntries(storeB.truth, { lines: tampered });
    expect(result.conflicts).toHaveLength(1);

    // The local copy is untouched; the conflict sits in the review inbox
    const proposals = storeB.truth.listProposals('open');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].body.signal.source).toBe('wiki-reconciliation');
    const local = storeB.truth.getEntry(result.conflicts[0].id)!;
    expect((local.body as { claim: string }).claim).not.toContain('conflicting');
  });

  it('accepts wiki-native lines without x-steno and preserves ids/authors', () => {
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
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => ['TB', 'UV'].includes(JSON.parse(l).type))).toBe(true);
  });

  it('reads and writes JSONL files (cat-able, diffable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-wiki-'));
    try {
      seedLedger(storeA.truth);
      const path = join(dir, 'truth.jsonl');
      exportWikiEntries(storeA.truth, { path });

      const raw = readFileSync(path, 'utf8').trim().split('\n');
      expect(raw).toHaveLength(3);

      const result = importWikiEntries(storeB.truth, { path });
      expect(result.inserted).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed lines with a per-line error, not a failed import', () => {
    seedLedger(storeA.truth);
    const { lines } = exportWikiEntries(storeA.truth);
    const result = importWikiEntries(storeB.truth, {
      lines: ['not json', ...lines, '{"type":"PROPOSAL","id":"x"}'],
    });
    expect(result.inserted).toBe(3);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].line).toBe(1);
  });
});

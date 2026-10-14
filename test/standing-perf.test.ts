import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store/index.js';

/**
 * Standing must stay cheap as a ledger grows (PRD R2). Every append
 * re-derives the standing of what it touches and everything resting on it,
 * so a deep chain of derived entries is the worst case: the last entry
 * rests on every one before it. The bound: a chain of 600 TBs, each
 * deriving from the three before it, then a strike at the root, which
 * re-derives all 600, in a file-backed state. Measured at 3.4 s (chain),
 * 29 ms (strike) and 60 ms (verify) on the development machine; the budgets
 * are about 3.5x, 10x and 15x that. A fold that walked the whole closure on
 * every append measured 157 s for the chain, so the budget catches it.
 */
describe('standing performance (R2)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('appends a 600-entry derivation chain and re-derives it after a strike within budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-standing-perf-'));
    dirs.push(dir);
    const store = new StateStore(join(dir, 'state.db'));
    const ledger = store.truth;
    const ids: string[] = [];
    const started = performance.now();
    for (let i = 0; i < 600; i++) {
      const premises = ids.slice(-3).map((id) => ({ id, contentHash: ledger.contentHashOf(id)! }));
      const tb = ledger.assertTombstone(
        {
          claim: `Fact ${i} is dead.`,
          evidence: [{ kind: 'commit', ref: `c${i.toString(16).padStart(6, '0')}` }],
          signedBy: 'johnny',
          ...(premises.length > 0 ? { premises, inference: `Follows from the ${premises.length} before it.` } : {}),
        },
        { author: 'johnny' }
      );
      ids.push(tb.id);
    }
    const chain = performance.now() - started;
    expect(ledger.getEntry(ids[599])!.standing).toBe('sound');

    const struck = performance.now();
    ledger.fileRuling({ kind: 'strike', opinion: 'the root was wrong', target: ids[0] }, { author: 'johnny' });
    const strike = performance.now() - struck;
    expect(ledger.getEntry(ids[599])!.standing).toBe('unsupported');
    expect(ledger.getTruth('current')).toHaveLength(0);

    const verified = performance.now();
    expect(ledger.verify().ok).toBe(true);
    const verify = performance.now() - verified;
    store.close();

    console.log(`standing perf: chain ${chain.toFixed(0)} ms, strike ${strike.toFixed(0)} ms, verify ${verify.toFixed(0)} ms`);
    expect(chain).toBeLessThan(12_000);
    expect(strike).toBeLessThan(300);
    expect(verify).toBeLessThan(1_000);
  }, 60_000);
});

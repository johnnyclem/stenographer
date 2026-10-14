/**
 * stenographer trace / get_derivation (PRD R6): the derivation tree with
 * status, standing, signer and answerable person on each node, and the
 * failing premise marked. Pinned by a snapshot over the derivation fixture.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../src/store/index.js';
import { TruthLedger } from '../src/truth/ledger.js';
import { importWikiEntries } from '../src/truth/wiki.js';
import { buildDerivation, formatDerivation, runTraceCLI } from '../src/truth/trace.js';

const FIXTURE = join(import.meta.dirname, '..', 'spec', 'truth-format', 'fixtures', 'valid', 'derivation.jsonl');
const lines = () => readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.length > 0);
const ids = () => lines().map((l) => JSON.parse(l) as { id: string; type: string; inference?: string; assertion?: string });

function imported(): TruthLedger {
  const ledger = new TruthLedger(new Database(':memory:'));
  const result = importWikiEntries(ledger, { lines: lines() });
  expect(result).toMatchObject({ committed: true, proposals: [], held: [], errors: [] });
  return ledger;
}

describe('trace (R6)', () => {
  it('prints the tree below a derived UV with the struck root marked, down to the premise that failed', () => {
    const ledger = imported();
    const perTenant = ids().find((l) => l.type === 'UV' && l.inference)!.id;
    const tree = buildDerivation(ledger, perTenant, 'down')!;
    expect(formatDerivation(tree, 'down')).toMatchInlineSnapshot(`
      [
        "UV 01M1E6JK8T990YNBMTS1KP26ZW [open · unsupported] by sam: "The per-tenant cap is 5 too."",
        "└─ derives TB 01M1E6JK8SQAJ8K0JBRHTD10YG [active · unsupported] signed by johnnyclem: "Retries are capped at 5; the old cap of 3 is dead."",
        "   ├─ derives TB 01M1E6JK8QHST8RZF45PNRBMXG [struck] signed by johnnyclem: "The retry budget is 100." ✗ premise-struck",
        "   └─ derives UV 01M1E6JK8RY2RTGX9TRXJABTWR [verified] by sam: "Each retry costs 20."",
      ]
    `);
    // The JSON tree carries the same, with the wire status and the standing fold's reasons
    expect(tree).toMatchObject({ type: 'UV', status: 'open', standing: 'unsupported', failing: null, reasons: [{ reason: 'premise-struck' }] });
    expect(tree.children[0].children.map((c) => [c.id, c.failing])).toEqual([
      ['01M1E6JK8QHST8RZF45PNRBMXG', 'premise-struck'],
      ['01M1E6JK8RY2RTGX9TRXJABTWR', null],
    ]);
  });

  it('prints what rests on an entry with --up, through pinned premises and wiki evidence refs alike', () => {
    const ledger = imported();
    const root = '01M1E6JK8QHST8RZF45PNRBMXG';
    expect(formatDerivation(buildDerivation(ledger, root, 'up')!, 'up')).toMatchInlineSnapshot(`
      [
        "TB 01M1E6JK8QHST8RZF45PNRBMXG [struck] signed by johnnyclem: "The retry budget is 100."",
        "├─ derives TB 01M1E6JK8SQAJ8K0JBRHTD10YG [active · unsupported] signed by johnnyclem: "Retries are capped at 5; the old cap of 3 is dead."",
        "│  └─ derives UV 01M1E6JK8T990YNBMTS1KP26ZW [open · unsupported] by sam: "The per-tenant cap is 5 too."",
        "└─ wiki TB 01M1E6JK8VNTSQ9WD7KZ8AG3GA [active · unsupported] signed by kim: "The retry budget flag is gone."",
      ]
    `);
  });

  it('shows a premise not held here, a root, and a TB under appeal by its reading name', () => {
    const ledger = new TruthLedger(new Database(':memory:'));
    const [derived] = lines().filter((l) => JSON.parse(l).inference);
    importWikiEntries(ledger, { lines: [derived] });
    const id = JSON.parse(derived).id as string;
    const out = formatDerivation(buildDerivation(ledger, id)!);
    expect(out[0]).toContain('[active · clouded]');
    expect(out.slice(1)).toEqual([
      '├─ derives 01M1E6JK8QHST8RZF45PNRBMXG (not held here) ✗ premise-missing',
      '└─ derives 01M1E6JK8RY2RTGX9TRXJABTWR (not held here) ✗ premise-missing',
    ]);
    const root = ledger.assertTombstone({ claim: 'A root.', evidence: [{ kind: 'commit', ref: 'abc1234' }], signedBy: 'kim' }, { author: 'kim' });
    expect(formatDerivation(buildDerivation(ledger, root.id)!)).toEqual([`TB ${root.id} [active] signed by kim: "A root."`, '(a root: it rests on no entry)']);
    ledger.assertUv({ assertion: 'Not so.', basis: 'a hunch', verifyBy: { kind: 'ask', value: 'ops' }, contests: root.id }, { author: 'sam' });
    expect(formatDerivation(buildDerivation(ledger, root.id)!)[0]).toContain('[under appeal]');
    expect(buildDerivation(ledger, root.id)!.status).toBe('contested');
    expect(buildDerivation(ledger, 'nope')).toBeNull();
  });

  it('the CLI prints the tree, or JSON, and exits 1 for an unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-trace-'));
    try {
      const path = join(dir, 'state.db');
      const store = new StateStore(path);
      importWikiEntries(store.truth, { lines: lines() });
      store.close();
      const printed: string[] = [];
      const io = { print: (l: string) => printed.push(l) };
      expect(await runTraceCLI(['01M1E6JK8SQAJ8K0JBRHTD10YG', '--state', path], io)).toBe(0);
      expect(printed[0]).toMatch(/^TB 01M1E6JK8SQAJ8K0JBRHTD10YG \[active · unsupported\]/);
      expect(printed.some((l) => l.includes('✗ premise-struck'))).toBe(true);
      printed.length = 0;
      expect(await runTraceCLI(['01M1E6JK8QHST8RZF45PNRBMXG', '--up', '--json', '--state', path], io)).toBe(0);
      expect(JSON.parse(printed.join('\n'))).toMatchObject({ direction: 'up', tree: { id: '01M1E6JK8QHST8RZF45PNRBMXG' } });
      printed.length = 0;
      expect(await runTraceCLI(['nope', '--state', path], io)).toBe(1);
      expect(await runTraceCLI(['a', '--up', '--down', '--state', path], io)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

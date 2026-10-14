/**
 * @stenographer/core/truth-format loads without the SQLite driver (PRD R8).
 *
 * HyperVault runs the codec where better-sqlite3 cannot load. Here the
 * driver is replaced by a module that throws when imported, so any file in
 * the subpath's import graph that loads it fails the test. CI repeats the
 * check on the built package with a module hook (test/helpers/forbid-sqlite.mjs).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('better-sqlite3', () => {
  throw new Error('better-sqlite3 must not load from the truth-format subpath');
});

const ROOT = join(import.meta.dirname, '..');

describe('the truth-format subpath', () => {
  it('imports in a process where better-sqlite3 cannot load, and exports the codec, the folds, the rules and JCS', async () => {
    const format = await import('../src/truth-format.js');
    for (const name of [
      'decodeWikiLine',
      'checkWikiChain',
      'wikiLineHash',
      'deriveStatus',
      'deriveAll',
      'deriveStanding',
      'contentHash',
      'lineContentHash',
      'premisesOfLine',
      'checkQuorum',
      'resolveIdentity',
      'SignerRegistry',
      'LiteralMatcher',
      'findLiteralHits',
      'canonicalize',
      'sha256Hex',
      'CONSUMPTION_RULES',
      'MARKERS',
      'LINK_TYPES',
      'EVIDENCE_KINDS',
    ]) {
      expect(format, name).toHaveProperty(name);
    }
    // And the ledger, which does load the driver, is not reachable from it
    expect(format).not.toHaveProperty('TruthLedger');
    expect(format).not.toHaveProperty('StateStore');
  });

  it('the package root still loads the driver (so the subpath is the one to import without it)', async () => {
    await expect(import('../src/index.js')).rejects.toThrow();
  });

  it('is declared in package.json exports, and CI runs the built subpath under the module hook', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, { types: string; default: string }> };
    expect(pkg.exports['./truth-format']).toEqual({ types: './dist/truth-format.d.ts', default: './dist/truth-format.js' });
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('node --import ./test/helpers/forbid-sqlite.mjs');
    expect(ci).toContain("import('./dist/truth-format.js')");
  });
});

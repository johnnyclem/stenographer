/**
 * Stenographer — ledger integrity check
 *
 *   stenographer verify [state-path] [--json]
 *
 * Validates the truth ledger's hash chain, checks that the link table holds
 * exactly the links its entries wrote, and re-derives every status from
 * links, reporting the first divergence. Exit codes: 0 intact, 1 integrity
 * failure, 2 could not run (no such file, unreadable database).
 *
 * A pre-1.0 ledger is chained on first open, here as on every other entry
 * point; the report says so, and that its chain covers those entries from
 * then on, not from when they were written.
 */

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { TruthLedger } from './ledger.js';
import type { IntegrityReport } from './chain.js';

const DEFAULT_STATE = './stenographer.db';

export type LedgerCheck =
  | { outcome: 'ok' | 'failed'; report: IntegrityReport; migrated: boolean }
  | { outcome: 'no-ledger' }
  | { outcome: 'error'; error: string };

/**
 * Opens the state file at `path` (never creating it) and verifies its truth
 * ledger. A file without a ledger has nothing to verify.
 */
export function verifyStateFile(path: string): LedgerCheck {
  if (!existsSync(path)) return { outcome: 'error', error: `no state file at ${path}` };
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { fileMustExist: true });
    const hasLedger = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'truth_entries'`).get();
    if (!hasLedger) return { outcome: 'no-ledger' };
    const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'truth_meta'`).get();
    const chained = hasMeta && db.prepare(`SELECT 1 FROM truth_meta WHERE key = 'chain_version'`).get();
    const report = new TruthLedger(db).verify();
    return {
      outcome: report.ok ? 'ok' : 'failed',
      report,
      migrated: !chained && report.chainedAtMigration !== null,
    };
  } catch (err) {
    return { outcome: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

/** Human-readable lines for a check's result. */
export function formatLedgerCheck(path: string, check: LedgerCheck): string[] {
  switch (check.outcome) {
    case 'error':
      return [`Could not verify ${path}: ${check.error}`];
    case 'no-ledger':
      return [`${path} has no truth ledger yet — nothing to verify.`];
    default: {
      const { report } = check;
      const lines: string[] = [];
      if (check.migrated) {
        lines.push(
          `Chained ${report.chainedAtMigration!.entries} pre-1.0 entries at migration (marker ${report.chainedAtMigration!.markerId}).`
        );
      }
      if (report.ok) {
        lines.push(`OK: ${report.entries} entries, ${report.links} links; chain intact and every status matches its links.`);
      } else {
        lines.push(`INTEGRITY FAILURE (${report.failure!.kind}): ${report.failure!.message}`);
      }
      if (report.chainedAtMigration) {
        lines.push(
          `Entries up to marker ${report.chainedAtMigration.markerId} were written before the ledger was chained; ` +
            `the chain covers them from ${report.chainedAtMigration.at} on.`
        );
      }
      if (report.head) {
        lines.push(
          `Head: #${report.head.seq} ${report.head.id} ${report.head.hash}`,
          'Keep the head hash somewhere the state file is not: a truncated or fully rewritten chain only shows against it.'
        );
      }
      return lines;
    }
  }
}

/**
 * The check `stenographer start` runs before serving: a ledger that fails
 * it is refused unless the operator passed --skip-verify. A state file that
 * doesn't exist yet (or ':memory:') has nothing to check.
 */
export function startupLedgerCheck(statePath: string, opts: { skipVerify?: boolean } = {}): { refuse: boolean; lines: string[] } {
  if (opts.skipVerify) {
    return { refuse: false, lines: ["⚠️  --skip-verify: the truth ledger's integrity was not checked"] };
  }
  if (statePath === ':memory:' || !existsSync(statePath)) return { refuse: false, lines: [] };
  const check = verifyStateFile(statePath);
  if (check.outcome === 'failed' || check.outcome === 'error') {
    const [reason] = formatLedgerCheck(statePath, check).filter((line) => /^(INTEGRITY FAILURE|Could not verify)/.test(line));
    return {
      refuse: true,
      lines: [
        `❌ ${reason}`,
        `❌ Refusing to start: the truth ledger in ${statePath} ${check.outcome === 'failed' ? 'failed its integrity check' : 'could not be checked'}. ` +
          `Run 'stenographer verify ${statePath}' for details, or start with --skip-verify to serve it anyway.`,
      ],
    };
  }
  if (check.outcome === 'no-ledger') return { refuse: false, lines: [] };
  return {
    refuse: false,
    lines: [
      ...(check.migrated ? [`🔗 ${formatLedgerCheck(statePath, check)[0]}`] : []),
      `🔗 Truth ledger verified: ${check.report.entries} entries, chain intact`,
    ],
  };
}

export async function runVerifyCLI(
  args: string[],
  io: { print(line: string): void } = { print: (line) => console.log(line) }
): Promise<number> {
  let path: string;
  let json: boolean;
  try {
    const { positionals, values } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: true });
    path = positionals[0] || DEFAULT_STATE;
    json = Boolean(values.json);
  } catch (err) {
    io.print(`usage: stenographer verify [state-path] [--json] — ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const check = verifyStateFile(path);
  if (json) io.print(JSON.stringify({ path, ...check }, null, 2));
  else for (const line of formatLedgerCheck(path, check)) io.print(line);
  return check.outcome === 'failed' ? 1 : check.outcome === 'error' ? 2 : 0;
}

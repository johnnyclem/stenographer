/**
 * Stenographer — the decision model's record
 *
 *   stenographer advice [state-path] [--json] [--export <file>] [--all] [--limit <n>]
 *
 * Prints how the configured decision model has done against the judge
 * (verdicts, graded, rewarded, corrected, accuracy) and the latest
 * verdicts, and with --export writes the graded verdicts as JSONL training
 * rows (state, questions, the model's answers, the ruling's truth), or
 * every verdict with --all. Read-only: it opens the state file without
 * creating it and writes nothing to it. Exit codes: 0, 2 could not run.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { assertSchemaSupported } from '../store/migrations.js';
import { DecisionAdviser } from './advisor.js';
import { DecisionModelClient, DEFAULT_D1_BASE_URL } from './model.js';

const DEFAULT_STATE = './stenographer.db';

export async function runAdviceCLI(args: string[], out: (line: string) => void = console.log): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
      export: { type: 'string' },
      all: { type: 'boolean' },
      limit: { type: 'string' },
    },
    allowPositionals: true,
  });
  const path = positionals[0] ?? DEFAULT_STATE;
  if (!existsSync(path)) {
    console.error(`no state file at ${path}`);
    return 2;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { fileMustExist: true, readonly: true });
    assertSchemaSupported(db);
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision_advice'").get();
    if (!hasTable) {
      if (values.json) out(JSON.stringify({ stats: null, advice: [] }));
      else out('No decision model has advised on this state file (start with --decision-model d1, jev or <url>).');
      return 0;
    }
    // A placeholder client: the record is read, the model is never asked here
    const adviser = new DecisionAdviser(db, new DecisionModelClient({ name: 'd1', baseURL: DEFAULT_D1_BASE_URL }));
    const stats = adviser.stats();
    const limit = values.limit ? Number.parseInt(values.limit, 10) : 20;
    const advice = adviser.list({ limit: Number.isFinite(limit) && limit > 0 ? limit : 20 });
    if (values.export) {
      const rows = adviser.export({ all: Boolean(values.all) });
      writeFileSync(values.export, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
      if (!values.json) out(`Wrote ${rows.length} ${values.all ? 'verdict' : 'graded verdict'}${rows.length === 1 ? '' : 's'} to ${values.export}`);
    }
    if (values.json) {
      out(JSON.stringify({ stats, advice }, null, 2));
      return 0;
    }
    out(`Decision model advice in ${path}`);
    out(`  objections advised: ${stats.objections}   consults: ${stats.consults}   errors: ${stats.errors}`);
    out(`  graded by a person: ${stats.graded}   rewarded: ${stats.rewarded}   corrected: ${stats.corrected}   accuracy: ${stats.accuracy === null ? 'n/a' : (stats.accuracy * 100).toFixed(0) + '%'}`);
    if (advice.length) out('');
    for (const a of advice) {
      const verdict = a.error
        ? `no answer (${a.error})`
        : a.kind === 'objection'
          ? `reasserts ${a.reasserts === null ? '?' : a.reasserts.toFixed(2)}`
          : `contradicts ${a.contradicts === null ? '?' : a.contradicts.toFixed(2)}${a.cites ? `, cites ${a.cites}` : ''}`;
      const grade = a.grade ? `  ${a.grade} (${a.truth})` : '';
      out(`  ${a.createdAt}  ${a.kind.padEnd(9)} ${a.subjectId}  ${a.adviser}/${a.model}  ${verdict}${grade}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    db?.close();
  }
}

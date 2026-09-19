/**
 * Stenographer — Team llm-wiki Interop (§8)
 *
 * Emits and consumes the team's append-only JSONL entry format losslessly.
 * Stenographer-specific fields travel under a namespaced `x-steno` key that
 * the wiki tooling ignores. Proposals are never exported — the wiki only
 * ever sees signed truth.
 *
 * Round-trip invariant: import(export(ledger)) == ledger for all signed
 * entries, byte-stable modulo the x-steno namespace. The test on this
 * invariant gates release.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { TruthLedger, type WriteContext } from './ledger.js';
import type { TbEntry, UvEntry, TruthEntry, TruthLink } from './types.js';

/** One line of the wiki's append-only JSONL ledger. */
export interface WikiEntryLine {
  id: string;
  type: 'TB' | 'UV';
  ts: string;
  author: string;
  // TB fields
  claim?: string;
  evidence?: unknown[];
  signedBy?: string | null;
  // UV fields
  assertion?: string;
  basis?: string;
  verifyBy?: unknown;
  contests?: string | null;
  status: string;
  /** Stenographer-namespaced extras; wiki tooling ignores this key. */
  'x-steno'?: {
    origin: 'local' | 'wiki';
    provenance: unknown;
    agentSessionId?: string | null;
    links: TruthLink[];
  };
}

export function entryToWikiLine(entry: TbEntry | UvEntry): WikiEntryLine {
  const base = {
    id: entry.id,
    type: entry.type,
    ts: entry.createdAt,
    author: entry.author,
  };
  const xSteno: WikiEntryLine['x-steno'] = {
    origin: entry.origin,
    provenance: entry.provenance,
    agentSessionId: entry.agentSessionId ?? null,
    links: entry.links,
  };

  if (entry.type === 'TB') {
    return {
      ...base,
      claim: entry.body.claim,
      evidence: entry.body.evidence,
      signedBy: entry.body.signedBy,
      status: entry.body.status,
      'x-steno': xSteno,
    };
  }
  return {
    ...base,
    assertion: entry.body.assertion,
    basis: entry.body.basis,
    verifyBy: entry.body.verifyBy,
    contests: entry.body.contests ?? null,
    status: entry.body.status,
    'x-steno': xSteno,
  };
}

export function wikiLineToEntry(line: WikiEntryLine): TruthEntry {
  const x = line['x-steno'];
  const envelope = {
    id: line.id,
    createdAt: line.ts,
    author: line.author,
    provenance: (x?.provenance as TruthEntry['provenance']) ?? { kind: 'wiki' as const, ref: line.id },
    agentSessionId: x?.agentSessionId ?? null,
    origin: x?.origin ?? ('wiki' as const),
    links: x?.links ?? [],
  };

  if (line.type === 'TB') {
    return {
      ...envelope,
      type: 'TB',
      body: {
        claim: line.claim ?? '',
        evidence: (line.evidence as any) ?? [],
        signedBy: line.signedBy ?? null,
        status: (line.status as 'active' | 'contested' | 'overridden') ?? 'active',
      },
    };
  }
  return {
    ...envelope,
    type: 'UV',
    body: {
      assertion: line.assertion ?? '',
      basis: line.basis ?? '',
      verifyBy: (line.verifyBy as any) ?? { kind: 'ask', value: line.author },
      contests: line.contests ?? null,
      status: (line.status as 'open' | 'verified' | 'refuted') ?? 'open',
    },
  };
}

/**
 * Exports signed TB/UV entries as append-only JSONL. Returns the lines;
 * when `path` is given, appends (or creates) the file.
 */
export function exportWikiEntries(
  ledger: TruthLedger,
  options: { since?: string; path?: string } = {}
): { lines: string[]; count: number } {
  const entries = ledger.getExportableEntries(options.since);
  const lines = entries.map((e) => JSON.stringify(entryToWikiLine(e)));

  if (options.path) {
    if (existsSync(options.path) && options.since) {
      appendFileSync(options.path, lines.map((l) => l + '\n').join(''));
    } else {
      writeFileSync(options.path, lines.map((l) => l + '\n').join(''));
    }
  }
  return { lines, count: lines.length };
}

export interface ImportResult {
  inserted: number;
  unchanged: number;
  /** Wiki entries that contradict a local entry — each generated a reconciliation PROPOSAL. */
  conflicts: Array<{ id: string; proposalId: string }>;
  errors: Array<{ line: number; error: string }>;
}

/**
 * Ingests the wiki's JSONL. Entries originating in the wiki keep their
 * original ids and authors. A wiki entry that contradicts a local entry
 * generates a PROPOSAL for reconciliation — it does not auto-win and does
 * not auto-lose.
 */
export function importWikiEntries(
  ledger: TruthLedger,
  input: { path?: string; lines?: string[] },
  ctx?: Partial<WriteContext>
): ImportResult {
  const lines =
    input.lines ?? readFileSync(input.path!, 'utf8').split('\n').filter((l) => l.trim().length > 0);

  const result: ImportResult = { inserted: 0, unchanged: 0, conflicts: [], errors: [] };

  for (let i = 0; i < lines.length; i++) {
    let entry: TruthEntry;
    try {
      const parsed = JSON.parse(lines[i]) as WikiEntryLine;
      if (parsed.type !== 'TB' && parsed.type !== 'UV') {
        throw new Error(`unsupported entry type: ${parsed.type}`);
      }
      entry = wikiLineToEntry(parsed);
    } catch (err) {
      result.errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const outcome = ledger.importEntry(entry);
    if (outcome === 'inserted') {
      result.inserted++;
    } else if (outcome === 'unchanged') {
      result.unchanged++;
    } else {
      const proposal = ledger.addProposal(
        {
          kind: entry.type === 'TB' ? 'tombstone' : 'uv',
          draft: entry.body as unknown as Record<string, unknown>,
          signal: {
            source: 'wiki-reconciliation',
            detail: `wiki entry ${entry.id} contradicts the local copy`,
          },
          targetRef: entry.id,
        },
        {
          author: ctx?.author ?? 'detector:wiki-sync',
          provenance: { kind: 'wiki', ref: entry.id },
          agentSessionId: ctx?.agentSessionId ?? null,
        }
      );
      result.conflicts.push({ id: entry.id, proposalId: proposal.id });
    }
  }

  return result;
}

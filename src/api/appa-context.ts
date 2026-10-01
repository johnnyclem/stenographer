/**
 * Stenographer — OpenAPPA context provider (consult protocol v1, kind=context)
 *
 * OpenAPPA asks every configured context provider about a proposed tool call
 * before its annotator labels the call, and hands the answers to the
 * annotator as facts. Stenographer's fact is the ledger's: which literals in
 * the call's arguments a signed tombstone (TB) declares dead, who wrote and
 * signed that claim, and whether an open UV contests it.
 *
 *   request:  {"version": 1, "kind": "context", "name", "declaration": {},
 *              "artifact": {"tool", "arguments", "cwd"?}}
 *   response: {"version": 1, "answer": {"about", "hits": [...]}}  or
 *             {"version": 1, "answer": null} when the ledger has nothing to say
 *
 * Read-only. Matching is the objection detector's (`findLiteralHits`):
 * exact tokens, a subject next to its value, a line that also names the
 * current value is discussion, and keys naming the old side of an edit
 * (`old_string`, ...) are skipped. Facts, not labels: what the annotator
 * makes of a hit is its policy's business.
 *
 *   [externals.context.stenographer]
 *   url = "http://127.0.0.1:8787/appa/context"
 *   token_env = "APPA_STENOGRAPHER_TOKEN"   # the REST bearer token
 */

import { z } from 'zod';
import { findLiteralHits } from '../truth/objections.js';
import type { TruthLedger } from '../truth/ledger.js';
import type { UvEntry } from '../truth/types.js';

export const ContextConsultSchema = z.object({
  version: z.literal(1),
  kind: z.literal('context'),
  name: z.string().optional(),
  declaration: z.record(z.unknown()).optional(),
  artifact: z.object({
    tool: z.string().min(1),
    arguments: z.unknown(),
    cwd: z.string().optional(),
  }),
});

export type ContextConsult = z.infer<typeof ContextConsultSchema>;

/** A UV disputing the TB behind a hit. */
export interface ContestFact {
  uv_id: string;
  assertion: string;
  author: string;
  status: string;
}

/** One tombstoned literal found in the call's arguments. */
export interface ContextHit {
  tb_id: string;
  subject?: string;
  dead: string;
  current?: string;
  /** The TB's claim, in its author's words. */
  claim: string;
  /** Who signed the TB; null for a migrated one. */
  signer: string | null;
  author: string;
  /** `active`, or `contested` (an open UV disputes it; see contested_by). */
  status: string;
  /** Where in the arguments: `command`, `edits[0].new_string`, ... */
  argument: string;
  /** The argument line that asserts the literal. */
  line: string;
  contested_by: ContestFact[];
}

export interface ContextAnswer {
  about: string;
  hits: ContextHit[];
}

const ABOUT =
  "Literals in this call's arguments that a signed tombstone (TB) in stenographer's asserted-truth ledger " +
  'declares dead. claim is the TB text, written by author and signed by signer; status contested means an ' +
  'open UV disputes it (contested_by). Facts from the ledger, not a judgment of the call.';

const MAX_DEPTH = 8;
const MAX_STRINGS = 2_000;

/** Every string in the arguments with its path, skipping the old side of edits. */
function argumentStrings(value: unknown): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_STRINGS) return;
    if (typeof v === 'string') {
      out.push({ path: path || '(arguments)', text: v });
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        // Replacing a dead value is the fix, not the mistake (as assertedText)
        if (/^old/i.test(key)) continue;
        walk(item, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  walk(value, '', 0);
  return out;
}

/** The ledger's facts about one proposed call; null when it has none. */
export function answerContextConsult(
  ledger: TruthLedger,
  artifact: ContextConsult['artifact']
): ContextAnswer | null {
  const strings = argumentStrings(artifact.arguments);
  if (strings.length === 0) return null;
  const tombstones = ledger.getMatchableTombstones();
  if (tombstones.length === 0) return null;

  let contests: Map<string, UvEntry[]> | null = null;
  const contestsOf = (tbId: string): UvEntry[] => {
    contests ??= new Map(ledger.getContested().map((c) => [c.tombstone.id, c.contestedBy]));
    return contests.get(tbId) ?? [];
  };

  const hits: ContextHit[] = [];
  for (const tb of tombstones) {
    for (const literal of tb.body.literals ?? []) {
      let found: { path: string; line: string } | null = null;
      for (const { path, text } of strings) {
        const [line] = findLiteralHits(text, literal);
        if (line !== undefined) {
          found = { path, line };
          break;
        }
      }
      if (!found) continue;
      hits.push({
        tb_id: tb.id,
        ...(literal.subject ? { subject: literal.subject } : {}),
        dead: literal.dead,
        ...(literal.current ? { current: literal.current } : {}),
        claim: tb.body.claim,
        signer: tb.body.signedBy ?? null,
        author: tb.author,
        status: tb.body.status,
        argument: found.path,
        line: found.line,
        contested_by:
          tb.body.status === 'contested'
            ? contestsOf(tb.id).map((uv) => ({
                uv_id: uv.id,
                assertion: uv.body.assertion,
                author: uv.author,
                status: uv.body.status,
              }))
            : [],
      });
    }
  }
  return hits.length > 0 ? { about: ABOUT, hits } : null;
}

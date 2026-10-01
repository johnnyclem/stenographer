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
 * Read-only. What is read, and how it matches, is exactly what the
 * objection detector and `stenographer gate` use, so the three agree on
 * what a call asserts: only the fields that carry new content
 * (`assertingFields` — a Write's content, the new side of an edit, the
 * writing parts of a shell command; never a search, a read, a commit
 * message or the old side of an edit), matched by the shared clause
 * matcher (`LiteralMatcher`). Facts, not labels: what the annotator makes
 * of a hit is its policy's business.
 *
 *   [externals.context.stenographer]
 *   url = "http://127.0.0.1:8789/appa/context"  # --rest-port 8789: OpenAPPA's runtime holds 8787
 *   token_env = "APPA_STENOGRAPHER_TOKEN"        # the REST bearer token
 */

import { z } from 'zod';
import { compileTombstones, type CompiledTombstones } from '../truth/objections.js';
import { assertingFields } from '../truth/asserting.js';
import type { TruthLedger } from '../truth/ledger.js';
import type { TbEntry, TombstonedLiteral, UvEntry } from '../truth/types.js';

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
  "Literals this call asserts (in the arguments that carry new content: file content, the new side of an edit, " +
  "the writing parts of a shell command) that a signed tombstone (TB) in stenographer's asserted-truth ledger " +
  'declares dead. claim is the TB text, written by author and signed by signer; status contested means an ' +
  'open UV disputes it (contested_by). Facts from the ledger, not a judgment of the call.';

/**
 * The ledger's facts about one proposed call; null when it has none.
 * `compiled` is the active-TB matcher; pass a cached one (the objection
 * log's, recompiled only when the ledger changes) to skip compiling it
 * per consult.
 */
export function answerContextConsult(
  ledger: TruthLedger,
  artifact: ContextConsult['artifact'],
  compiled?: CompiledTombstones
): ContextAnswer | null {
  const fields = assertingFields(artifact.tool, artifact.arguments);
  if (fields.length === 0) return null;
  const { tombstones, matcher } = compiled ?? compileTombstones(ledger.getMatchableTombstones());
  if (tombstones.length === 0) return null;

  // The first asserting field per literal, in ledger order
  const found = new Map<number, { tb: TbEntry; literal: TombstonedLiteral; path: string; line: string }>();
  for (const { field, text } of fields) {
    for (const hit of matcher.match(text, { skip: (key) => found.has(key.order) })) {
      found.set(hit.key.order, { tb: hit.key.tb, literal: hit.key.literal, path: field, line: hit.line });
    }
  }
  if (found.size === 0) return null;

  let contests: Map<string, UvEntry[]> | null = null;
  const contestsOf = (tbId: string): UvEntry[] => {
    contests ??= new Map(ledger.getContested().map((c) => [c.tombstone.id, c.contestedBy]));
    return contests.get(tbId) ?? [];
  };

  const hits: ContextHit[] = [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { tb, literal, path, line }]) => ({
      tb_id: tb.id,
      ...(literal.subject ? { subject: literal.subject } : {}),
      dead: literal.dead,
      ...(literal.current ? { current: literal.current } : {}),
      claim: tb.body.claim,
      signer: tb.body.signedBy ?? null,
      author: tb.author,
      status: tb.body.status,
      argument: path,
      line,
      contested_by:
        tb.body.status === 'contested'
          ? contestsOf(tb.id).map((uv) => ({
              uv_id: uv.id,
              assertion: uv.body.assertion,
              author: uv.author,
              status: uv.body.status,
            }))
          : [],
    }));
  return { about: ABOUT, hits };
}

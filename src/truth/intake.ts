/**
 * Stenographer — Proposal-draft intake (Option B seam, PRD §13 Q6).
 *
 * Consumes candidate-truth JSONL emitted by an external compactor
 * (short-hand's `exportProposalDrafts`). Every line is filed as a
 * PROPOSAL — the intake has no path to TB or UV, so external tools can
 * only ever propose. Dedupe rides on `addProposal`'s targetRef batching:
 * re-importing the same export is idempotent while the proposals stay open.
 *
 * The detector identity that files these drafts is accountable in the
 * ledger sense (it names the pipeline), but it can never sign them —
 * signing its own intake would be exactly the one-hat corroboration the
 * contempt check rejects.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { TruthLedger, type WriteContext } from './ledger.js';
import { EvidenceSchema, VerifyBySchema, type ProposalEntry } from './types.js';

/** Default author for drafts arriving from a short-hand compactor. */
export const COMPACTION_DETECTOR = 'detector:short-hand';

const TombstoneDraftSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
  signedBy: z.null().optional(),
});

const UvDraftSchema = z.object({
  assertion: z.string().min(1),
  basis: z.string().min(1),
  verifyBy: VerifyBySchema,
  contests: z.string().nullable().optional(),
});

/**
 * Two emitters share this seam and their lines differ only in dressing:
 * - short-hand's `exportProposalDrafts`: bare `{kind, draft, signal, targetRef?, provenance?}`
 *   with `signal.source: 'compaction-candidate'`.
 * - smallchat's vendored compactor (`proposeInvariants`, also mirrored in
 *   smallchat-swift): the same body inside a `PROPOSAL` envelope —
 *   `{type: 'PROPOSAL', id, ts, author, agentSessionId?, …}` with
 *   `signal.source: 'shorthand-compaction'`.
 * Both file as `PROPOSAL(signal.source: 'compaction-candidate')`; the
 * envelope's own id/author/source are kept under `meta` for traceability.
 */
const CompactionSignalSchema = z.object({
  source: z.enum(['compaction-candidate', 'shorthand-compaction']),
  detail: z.string().optional(),
});

const EnvelopeFields = {
  type: z.literal('PROPOSAL').optional(),
  id: z.string().optional(),
  ts: z.string().optional(),
  author: z.string().optional(),
  agentSessionId: z.string().nullable().optional(),
  targetRef: z.string().nullable().optional(),
  provenance: z.object({ kind: z.literal('sourceMessageId'), ref: z.string() }).optional(),
};

const ProposalDraftLineSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tombstone'),
    draft: TombstoneDraftSchema,
    signal: CompactionSignalSchema,
    ...EnvelopeFields,
  }),
  z.object({
    kind: z.literal('uv'),
    draft: UvDraftSchema,
    signal: CompactionSignalSchema,
    ...EnvelopeFields,
  }),
]);

export interface IntakeResult {
  /** Newly filed open proposals. */
  filed: ProposalEntry[];
  /** Lines that matched an already-open proposal for the same target. */
  deduped: number;
  errors: Array<{ line: number; error: string }>;
}

/**
 * Files each draft line as a PROPOSAL. Malformed lines are reported and
 * skipped; the rest of the intake proceeds.
 */
export function importProposalDrafts(
  ledger: TruthLedger,
  input: { path?: string; lines?: string[] },
  ctx?: Partial<WriteContext>
): IntakeResult {
  const lines =
    input.lines ?? readFileSync(input.path!, 'utf8').split('\n').filter((l) => l.trim().length > 0);

  const result: IntakeResult = { filed: [], deduped: 0, errors: [] };
  const seen = new Set(ledger.listProposals('open').map((p) => p.id));

  for (let i = 0; i < lines.length; i++) {
    let draft: z.infer<typeof ProposalDraftLineSchema>;
    try {
      draft = ProposalDraftLineSchema.parse(JSON.parse(lines[i]));
    } catch (err) {
      result.errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const fromEnvelope =
      draft.type === 'PROPOSAL' || draft.id || draft.author || draft.signal.source !== 'compaction-candidate';
    const proposal = ledger.addProposal(
      {
        kind: draft.kind,
        draft: draft.draft as Record<string, unknown>,
        signal: { source: 'compaction-candidate', ...(draft.signal.detail ? { detail: draft.signal.detail } : {}) },
        targetRef: draft.targetRef ?? null,
        ...(fromEnvelope
          ? {
              meta: {
                intake: {
                  source: draft.signal.source,
                  ...(draft.id ? { id: draft.id } : {}),
                  ...(draft.author ? { author: draft.author } : {}),
                },
              },
            }
          : {}),
      },
      {
        author: ctx?.author ?? COMPACTION_DETECTOR,
        provenance: draft.provenance ?? { kind: 'manual' },
        agentSessionId: ctx?.agentSessionId ?? draft.agentSessionId ?? null,
        timestamp: ctx?.timestamp ?? draft.ts,
      }
    );

    if (seen.has(proposal.id)) {
      result.deduped++;
    } else {
      seen.add(proposal.id);
      result.filed.push(proposal);
    }
  }

  return result;
}

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
 *
 * The suite's PROPOSAL envelope (truth format v2, spec/truth-format) is
 * `{schemaVersion: 2, seq, type: "PROPOSAL", id, ts, author, kind: "tb"|"uv",
 * draft, targetRef, signal: {source: "compaction-candidate"|"detector:<name>"|
 * "agent"}, agentSessionId?, prevHash, hash}`, hash-chained like a wiki
 * stream. The older bare and envelope dialects are still read.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { TruthLedger, type WriteContext } from './ledger.js';
import { EvidenceSchema, TombstonedLiteralSchema, VerifyBySchema, type ProposalEntry } from './types.js';
import { checkWikiChain, decodeWikiLine, type DecodedWikiLine } from './wiki.js';

/** Default author for drafts arriving from a short-hand compactor. */
export const COMPACTION_DETECTOR = 'detector:short-hand';

const TombstoneDraftSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
  literals: z.array(TombstonedLiteralSchema).optional(),
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

/** The v2 envelope's own fields, after decodeWikiLine checked the line's structure and hash. */
const V2SignalSchema = z
  .object({
    source: z.string().refine((s) => s === 'compaction-candidate' || s === 'agent' || /^detector:.+/.test(s), {
      message: "signal.source is 'compaction-candidate', 'agent' or 'detector:<name>'",
    }),
    detail: z.string().optional(),
  })
  .passthrough();
const ProposalEnvelopeV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tb'), draft: TombstoneDraftSchema, signal: V2SignalSchema }).passthrough(),
  z.object({ kind: z.literal('uv'), draft: UvDraftSchema, signal: V2SignalSchema }).passthrough(),
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

  // v2 envelope lines are hash-chained: check the chain before filing any of them
  const v2 = lines.map((text): DecodedWikiLine | null => {
    try {
      return JSON.parse(text)?.schemaVersion === 2 ? decodeWikiLine(text) : null;
    } catch {
      return null; // reported below, line by line
    }
  });
  const broken = new Map(checkWikiChain(v2).map(({ index, error }) => [index, error]));

  for (let i = 0; i < lines.length; i++) {
    let draft: z.infer<typeof ProposalDraftLineSchema> & { hash?: string };
    let v2Source: string | null = null;
    try {
      const raw = JSON.parse(lines[i]);
      if (raw?.schemaVersion === 2) {
        const decoded = decodeWikiLine(lines[i]);
        if (decoded.type !== 'PROPOSAL') throw new Error(`a ${decoded.type} line is not a proposal`);
        if (broken.has(i)) throw new Error(broken.get(i));
        const envelope = ProposalEnvelopeV2Schema.parse(raw);
        v2Source = envelope.signal.source;
        draft = {
          kind: envelope.kind === 'tb' ? 'tombstone' : 'uv',
          draft: envelope.draft,
          signal: { source: 'compaction-candidate', ...(envelope.signal.detail ? { detail: envelope.signal.detail } : {}) },
          type: 'PROPOSAL',
          id: raw.id,
          ts: raw.ts,
          author: raw.author,
          agentSessionId: raw.agentSessionId ?? null,
          targetRef: raw.targetRef,
          hash: decoded.hash!,
        } as typeof draft;
      } else {
        draft = ProposalDraftLineSchema.parse(raw);
      }
    } catch (err) {
      result.errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    // A v2 envelope is filed once, whatever became of it: its id is the dedupe key
    const targetRef = draft.targetRef ?? (v2Source && draft.id ? `intake:${draft.id}` : null);
    if (v2Source && draft.id && ledger.proposalsFor(targetRef!).some((p) => (p.body.meta?.intake as { id?: string } | undefined)?.id === draft.id)) {
      result.deduped++;
      continue;
    }

    const fromEnvelope =
      draft.type === 'PROPOSAL' || draft.id || draft.author || draft.signal.source !== 'compaction-candidate';
    const proposal = ledger.addProposal(
      {
        kind: draft.kind,
        draft: draft.draft as Record<string, unknown>,
        signal: { source: 'compaction-candidate', ...(draft.signal.detail ? { detail: draft.signal.detail } : {}) },
        targetRef,
        ...(fromEnvelope
          ? {
              meta: {
                intake: {
                  source: v2Source ?? draft.signal.source,
                  ...(draft.id ? { id: draft.id } : {}),
                  ...(draft.author ? { author: draft.author } : {}),
                  ...(draft.hash ? { hash: draft.hash } : {}),
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

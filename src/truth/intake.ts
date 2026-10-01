/**
 * Stenographer — Proposal-draft intake (Option B seam, PRD §13 Q6).
 *
 * Consumes candidate-truth JSONL emitted by an external compactor
 * (short-hand's `exportProposalDrafts`). Every line is filed as a
 * PROPOSAL — the intake has no path to TB or UV, so external tools can
 * only ever propose. A v2 envelope is filed once by its id (a different
 * envelope under a filed id is refused); the older dialects dedupe on
 * `addProposal`'s targetRef batching, so re-importing the same export is
 * idempotent while the proposals stay open.
 *
 * The detector identity that files these drafts is accountable in the
 * ledger sense (it names the pipeline), but it can never sign them —
 * signing its own intake would be exactly the one-hat corroboration the
 * contempt check rejects.
 *
 * A tool that authors truth outside stenographer submits one envelope at
 * a time over REST (`POST /proposals`, submitProposalEnvelope): the same
 * reader and filer, filed under the envelope's author as checked by the
 * caller, and marked `requiresNotary`.
 *
 * The suite's PROPOSAL envelope (truth format v2, spec/truth-format) is
 * `{schemaVersion: 2, seq, type: "PROPOSAL", id, ts, author, kind: "tb"|"uv",
 * draft, targetRef, signal: {source: "compaction-candidate"|"detector:<name>"|
 * "agent"}, agentSessionId?, prevHash, hash}`, hash-chained like a wiki
 * stream. The older bare and envelope dialects are still read.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalize, sha256Hex } from './jcs.js';
import { TruthLedger, type WriteContext } from './ledger.js';
import { EVIDENCE_KINDS, EvidenceSchema, TombstonedLiteralSchema, VerifyBySchema, type ProposalEntry } from './types.js';
import { checkWikiChain, decodeWikiLine, wikiLineHash, type DecodedWikiLine } from './wiki.js';

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

/**
 * The v2 envelope's own fields, after decodeWikiLine checked the line's
 * structure and hash. Open where the spec says readers must be: an unknown
 * `signal.source`, evidence kind or `verifyBy` kind is kept as written and
 * recorded under `meta.intake.unknown` — a proposal is never truth, and a
 * person sees it before anything is signed.
 */
const V2SignalSchema = z.object({ source: z.string().min(1), detail: z.string().optional() }).passthrough();
const OpenEvidenceSchema = z.union([
  EvidenceSchema,
  z.object({ kind: z.string().min(1), ref: z.string().min(1), detail: z.string().optional() }).passthrough(),
]);
const OpenVerifyBySchema = z.union([
  VerifyBySchema,
  z.object({ kind: z.string().min(1), value: z.string().min(1), detail: z.string().optional() }).passthrough(),
]);
const ProposalEnvelopeV2Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tb'),
      draft: TombstoneDraftSchema.extend({ evidence: z.array(OpenEvidenceSchema).min(1) }),
      signal: V2SignalSchema,
    })
    .passthrough(),
  z.object({ kind: z.literal('uv'), draft: UvDraftSchema.extend({ verifyBy: OpenVerifyBySchema }), signal: V2SignalSchema }).passthrough(),
]);
type ProposalEnvelopeV2 = z.infer<typeof ProposalEnvelopeV2Schema>;

const VERIFY_BY_KINDS: readonly string[] = VerifyBySchema.shape.kind.options;

/** The values in a v2 envelope this stenographer doesn't define. */
function unknownValues(envelope: ProposalEnvelopeV2): string[] {
  const out: string[] = [];
  const source = envelope.signal.source;
  if (source !== 'compaction-candidate' && source !== 'agent' && !/^detector:.+/.test(source)) {
    out.push(`signal.source '${source}'`);
  }
  if (envelope.kind === 'tb') {
    for (const e of envelope.draft.evidence) {
      if (!(EVIDENCE_KINDS as readonly string[]).includes(e.kind)) out.push(`evidence kind '${e.kind}'`);
    }
  } else if (!VERIFY_BY_KINDS.includes(envelope.draft.verifyBy.kind)) {
    out.push(`verifyBy kind '${envelope.draft.verifyBy.kind}'`);
  }
  return out;
}

/** An error as one readable line (zod's own message is a JSON dump). */
function messageOf(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

export interface IntakeResult {
  /** Newly filed open proposals. */
  filed: ProposalEntry[];
  /** Lines already filed: a v2 envelope with this id, or (older dialects) an open proposal for the same target. */
  deduped: number;
  errors: Array<{ line: number; error: string }>;
}

/** One proposal line, read and validated: what the intake files. */
interface ProposalLine {
  draft: z.infer<typeof ProposalDraftLineSchema> & { hash?: string };
  /** A v2 envelope's own `signal.source`, the values it uses that stenographer doesn't define, and its digest. Null for the older dialects. */
  v2: { source: string; unknown: string[]; digest: string } | null;
}

/**
 * What an envelope is compared by when its id comes back: its JCS form
 * without `seq`, `prevHash` and `hash`, so the same envelope at another
 * place in another stream (or submitted on its own) is the same envelope.
 */
function envelopeDigest(raw: Record<string, unknown>): string {
  const { seq: _seq, prevHash: _prev, hash: _hash, ...envelope } = raw;
  return sha256Hex(canonicalize(envelope));
}

/** Reads one line in any dialect the intake takes. Throws when it can't be filed; `chainError` is the stream's verdict on it. */
function readProposalLine(text: string, chainError?: string): ProposalLine {
  const raw = JSON.parse(text);
  if (raw?.schemaVersion !== 2) return { draft: ProposalDraftLineSchema.parse(raw), v2: null };

  const decoded = decodeWikiLine(text);
  if (decoded.type !== 'PROPOSAL') throw new Error(`a ${decoded.type} line is not a proposal`);
  if (chainError) throw new Error(chainError);
  const envelope = ProposalEnvelopeV2Schema.parse(raw);
  return {
    draft: {
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
    } as ProposalLine['draft'],
    v2: { source: envelope.signal.source, unknown: unknownValues(envelope), digest: envelopeDigest(raw) },
  };
}

export type FileOutcome =
  /** Filed now. */
  | 'filed'
  /** Already filed: a v2 envelope with this id and content, or (older dialects) an open proposal for the same target. */
  | 'duplicate'
  /** A v2 envelope with this id was filed with different content. Nothing is filed. */
  | 'conflict';

/**
 * Files one line as a PROPOSAL, or finds it already filed. A v2 envelope
 * is filed once, whatever became of it: its id is the key, not its target
 * (envelopes from several writers can share one).
 */
function fileProposalLine(
  ledger: TruthLedger,
  { draft, v2 }: ProposalLine,
  ctx: Partial<WriteContext> | undefined,
  opts: { requiresNotary?: boolean } = {}
): { outcome: FileOutcome; proposal: ProposalEntry } {
  const author = ctx?.author ?? COMPACTION_DETECTOR;
  const targetRef = draft.targetRef ?? (v2 ? `intake:${draft.id}` : null);
  if (v2) {
    const prior = ledger.intakeProposal(draft.id!);
    if (prior) {
      const same = (prior.body.meta?.intake as { digest?: string } | undefined)?.digest === v2.digest;
      return { outcome: same ? 'duplicate' : 'conflict', proposal: prior };
    }
  } else if (targetRef) {
    // The older dialects batch by target while the proposal is open
    const open = ledger.findOpenProposal({ kind: draft.kind, targetRef, author, requiresNotary: Boolean(opts.requiresNotary) });
    if (open) return { outcome: 'duplicate', proposal: open };
  }

  const fromEnvelope =
    draft.type === 'PROPOSAL' || draft.id || draft.author || draft.signal.source !== 'compaction-candidate';
  const proposal = ledger.addProposal(
    {
      kind: draft.kind,
      draft: draft.draft as Record<string, unknown>,
      signal: { source: 'compaction-candidate', ...(draft.signal.detail ? { detail: draft.signal.detail } : {}) },
      targetRef,
      ...(opts.requiresNotary ? { requiresNotary: true } : {}),
      ...(fromEnvelope
        ? {
            meta: {
              intake: {
                source: v2?.source ?? draft.signal.source,
                ...(draft.id ? { id: draft.id } : {}),
                ...(draft.author ? { author: draft.author } : {}),
                ...(draft.hash ? { hash: draft.hash } : {}),
                ...(v2 ? { digest: v2.digest } : {}),
                ...(v2 && v2.unknown.length > 0 ? { unknown: v2.unknown } : {}),
              },
            },
          }
        : {}),
    },
    {
      author,
      provenance: draft.provenance ?? { kind: 'manual' },
      agentSessionId: ctx?.agentSessionId ?? draft.agentSessionId ?? null,
      timestamp: ctx?.timestamp ?? draft.ts,
    },
    { reuseOpen: false }
  );
  return { outcome: 'filed', proposal };
}

/**
 * Files each draft line as a PROPOSAL. Malformed lines are reported and
 * skipped; the rest of the intake proceeds. Blank lines are skipped, and
 * counted in the line numbers errors report.
 */
export function importProposalDrafts(
  ledger: TruthLedger,
  input: { path?: string; lines?: string[] },
  ctx?: Partial<WriteContext>
): IntakeResult {
  const lines = (input.lines ?? readFileSync(input.path!, 'utf8').split('\n'))
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => text.trim().length > 0);

  const result: IntakeResult = { filed: [], deduped: 0, errors: [] };

  // v2 envelope lines are hash-chained: check the chain before filing any of them
  const v2 = lines.map(({ text }): DecodedWikiLine | null => {
    try {
      return JSON.parse(text)?.schemaVersion === 2 ? decodeWikiLine(text) : null;
    } catch {
      return null; // reported below, line by line
    }
  });
  const broken = new Map(checkWikiChain(v2).map(({ index, error }) => [index, error]));

  for (let i = 0; i < lines.length; i++) {
    let read: ProposalLine;
    try {
      read = readProposalLine(lines[i].text, broken.get(i));
    } catch (err) {
      result.errors.push({ line: lines[i].line, error: messageOf(err) });
      continue;
    }
    const { outcome, proposal } = fileProposalLine(ledger, read, ctx);
    if (outcome === 'filed') result.filed.push(proposal);
    else if (outcome === 'duplicate') result.deduped++;
    else result.errors.push({ line: lines[i].line, error: conflictMessage(read.draft.id!, proposal) });
  }

  return result;
}

function conflictMessage(envelopeId: string, prior: ProposalEntry): string {
  return `envelope ${envelopeId} was already filed (proposal ${prior.id}) with different content — an id names one envelope`;
}

/** An envelope submitted on its own that can't be filed: the caller's to fix. */
export class ProposalEnvelopeError extends Error {}

/** A filed id came back with different content. */
export class ProposalConflictError extends Error {
  constructor(
    readonly proposal: ProposalEntry,
    envelopeId: string
  ) {
    super(conflictMessage(envelopeId, proposal));
  }
}

/**
 * Files one PROPOSAL envelope submitted on its own (REST `POST /proposals`)
 * through the same reader and filer as a proposals stream. It must be a v2
 * envelope; `seq`, `prevHash` and `hash` may be left out (it is then a
 * stream of one, `seq` 1), and are checked when present. It is filed as
 * needing a notary, under the identity `fileAs` returns for the envelope's
 * author (which throws to refuse it).
 *
 * Returns `filed` the first time and `duplicate` when this envelope was
 * filed before. Throws ProposalEnvelopeError for an envelope that doesn't
 * validate, and ProposalConflictError for a different envelope under an id
 * already filed.
 */
export function submitProposalEnvelope(
  ledger: TruthLedger,
  envelope: Record<string, unknown>,
  fileAs: (author: string) => string
): { outcome: Exclude<FileOutcome, 'conflict'>; proposal: ProposalEntry } {
  if (envelope.schemaVersion !== 2 || envelope.type !== 'PROPOSAL') {
    throw new ProposalEnvelopeError('a submission is one truth format v2 PROPOSAL envelope: schemaVersion 2, type "PROPOSAL"');
  }
  let read: ProposalLine;
  try {
    read = readProposalLine(JSON.stringify(asStream(envelope)));
  } catch (err) {
    throw new ProposalEnvelopeError(messageOf(err));
  }
  // meta.intake.hash records a hash the envelope carried, not one computed for it here
  if (!('hash' in envelope)) read = { ...read, draft: { ...read.draft, hash: undefined } };
  const author = fileAs(read.draft.author!);
  const { outcome, proposal } = fileProposalLine(ledger, read, { author }, { requiresNotary: true });
  if (outcome === 'conflict') throw new ProposalConflictError(proposal, read.draft.id!);
  return { outcome, proposal };
}

/** A lone envelope without a hash, as the first line of a stream of its own; chain fields it has are kept as given. */
function asStream(envelope: Record<string, unknown>): Record<string, unknown> {
  if ('hash' in envelope) return envelope;
  const seq = 'seq' in envelope ? envelope.seq : 1;
  const line = { ...envelope, seq, ...('prevHash' in envelope ? {} : seq === 1 ? { prevHash: null } : {}) };
  return { ...line, hash: wikiLineHash(line) };
}

/**
 * Stenographer — TB/UV v2 Asserted Truth Layer: Types
 *
 * Five record types in one append-only, hash-chained ledger (plus the
 * MARKERs the ledger writes about itself). Every entry carries two
 * axes: provenance (where did this come from) and confidence type
 * (how much should you trust it). TB and UV are the two values of the
 * second axis — collapsing them back into one field is a regression.
 *
 * Machines detect; authors assert. Inference only ever produces
 * PROPOSALs — a proposal nobody signs is just a proposal, forever.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Authorship — the stand-behind-it standard
// ─────────────────────────────────────────────────────────────

/**
 * Identities that cannot stand behind anything. Writes carrying one are
 * rejected at the schema level — accountability requires a specific
 * author (human handle or agent identity tied to an operator). This is a
 * floor, not an allowlist: the signer registry (identity.ts) is the
 * allowlist, when the operator configures one.
 */
const ANONYMOUS_IDENTITIES = new Set([
  '',
  'system',
  'assistant',
  'agent',
  'ai',
  'bot',
  'anonymous',
  'unknown',
  'user',
  'human',
  'admin',
  'null',
  'none',
  'me',
]);

/** Reserved identity for Phase-1 backfill of pre-assertion tombstones. */
export const MIGRATION_AUTHOR = 'migration';

/** Reserved prefix for the pipelines that file proposals (supersession, wiki sync, intake). */
export const DETECTOR_PREFIX = 'detector:';

/**
 * The stored form of an identity: trimmed, Unicode NFC. Two spellings of
 * the same handle store the same way; comparisons go through identityKey.
 */
export function canonicalIdentity(identity: string): string {
  return identity.normalize('NFC').trim();
}

/**
 * The comparison form of an identity: compatibility-normalized (NFKC, so
 * full-width and ligature look-alikes fold), invisible code points
 * removed, trimmed, case-folded. "Alice", " alice " and "ａｌｉｃｅ" are one
 * person to the contempt check.
 */
export function identityKey(identity: string): string {
  return identity
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim()
    .toLowerCase();
}

export function isAnonymousIdentity(identity: string): boolean {
  return ANONYMOUS_IDENTITIES.has(identityKey(identity));
}

/** 'migration' and 'detector:*' belong to internal write paths only. */
export function isReservedIdentity(identity: string): boolean {
  const key = identityKey(identity);
  return key === MIGRATION_AUTHOR || key.startsWith(DETECTOR_PREFIX);
}

/** Control characters (newlines, escapes) have no place in a name someone stands behind. */
export function hasControlCharacters(identity: string): boolean {
  return /\p{Cc}/u.test(identity);
}

const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Whether `s` is shaped like an RFC 3339 date-time (`T` and `Z` upper case), whatever its field values. */
export function hasRfc3339Shape(s: string): boolean {
  return RFC3339_DATE_TIME.test(s);
}

/**
 * Whether `s` is an RFC 3339 date-time whose fields name a real time: no
 * February 30, no 24:00, no offset past 23:59, and no leap second, which
 * Date.parse would otherwise roll over or refuse. Never looser than JSON
 * Schema's `date-time` format, so a line stenographer writes passes it.
 */
export function isRfc3339DateTime(s: string): boolean {
  const m = RFC3339_DATE_TIME.exec(s);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  return Number.isFinite(Date.parse(s));
}

/** Author string: never blank, never a generic non-identity, never a reserved one. */
export const AuthorSchema = z
  .string()
  .refine((s) => !isAnonymousIdentity(s), {
    message:
      'anonymous or generic identities cannot assert truth — use a registered human handle or agent identity',
  })
  .refine((s) => !hasControlCharacters(s), { message: 'identities cannot contain control characters' })
  .refine((s) => !isReservedIdentity(s), {
    message: `'${MIGRATION_AUTHOR}' and '${DETECTOR_PREFIX}*' are reserved for the backfill and detector paths`,
  })
  .transform(canonicalIdentity);

// ─────────────────────────────────────────────────────────────
// Provenance & evidence
// ─────────────────────────────────────────────────────────────

export const ProvenanceSchema = z.object({
  kind: z.enum(['sourceMessageId', 'commitSha', 'filePath', 'manual', 'wiki', 'migration']),
  /** Message id, commit sha, file path, or wiki entry id, per kind. */
  ref: z.string().optional(),
  /** Line number when kind is filePath. */
  line: z.number().int().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * The evidence kinds this version knows (spec/truth-format, "Evidence
 * classes"). `wiki` is the id of an entry in a truth ledger, this one or a
 * teammate's; a team wiki page is a `doc`. `chat` is a chat message or
 * thread, `ticket` an issue or ticket, `doc` a document or page outside the
 * truth ledger.
 */
export const EVIDENCE_KINDS = ['commit', 'file', 'test', 'command', 'claimed-command', 'wiki', 'message', 'chat', 'ticket', 'doc'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Evidence that points at something a reader can check against the code or
 * the ledger. Every other kind (`message`, `chat`, `ticket`, `doc`, pre-1.0
 * `command`) is question-class: it can prompt a check, but isn't one. In 1.0
 * the classes bind agents only; a person may sign on any evidence.
 */
export const SETTLING_EVIDENCE_KINDS = ['commit', 'file', 'test', 'claimed-command', 'wiki'] as const;
export type EvidenceClass = 'settling' | 'question';

/** An evidence kind's class. A kind this version doesn't know is question-class: it fails closed. */
export function evidenceClass(kind: string): EvidenceClass {
  return (SETTLING_EVIDENCE_KINDS as readonly string[]).includes(kind) ? 'settling' : 'question';
}

/**
 * Evidence as a caller submits it. A `command` the caller says it ran, with
 * the output it says it saw, is a claim: it is recorded as
 * `claimed-command`. `command` in the ledger is reserved for a check
 * stenographer executed itself — and 1.0 ships no runner, so nothing a
 * caller submits is recorded as `command`.
 */
export const EvidenceSchema = z.object({
  kind: z
    .enum(EVIDENCE_KINDS)
    .transform((kind): EvidenceKind => (kind === 'command' ? 'claimed-command' : kind)),
  /** Commit sha, file/line, test name, command line, truth entry id, message id, chat message or thread, ticket, or document. */
  ref: z.string().min(1),
  /** What the evidence shows (e.g. captured command output). */
  detail: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Evidence that signs for itself (summary judgment, §6): only a check
 * stenographer ran. Caller-submitted command output is `claimed-command`
 * after parsing, so it never self-signs: an unexecuted claim cannot mint truth.
 */
export function isSelfSigningEvidence(evidence: Evidence[]): boolean {
  return evidence.some((e) => e.kind === 'command');
}

// ─────────────────────────────────────────────────────────────
// Matchable literals — what a real-time objection can cite (§12)
// ─────────────────────────────────────────────────────────────

/**
 * A tombstoned literal: a numeric constant, identifier, or config value
 * that is dead. v1 matching is precision over recall — literals, not
 * paraphrases — so a bare number is unmatchable without a `subject`
 * (the identifier it belongs to): "30" alone would object to everything.
 */
const TombstonedLiteralObject = z.object({
  /** The dead value or identifier, e.g. "30" or "legacyRateLimit". */
  dead: z.string().trim().min(1),
  /** The identifier the value belongs to, e.g. "LOG_BUDGET". */
  subject: z.string().trim().min(1).optional(),
  /** What replaced it, if anything — cited in the objection. */
  current: z.string().trim().min(1).optional(),
});

const MATCHABLE_LITERAL = {
  message:
    'a literal without a subject must be a distinctive identifier (≥4 chars, contains a letter) — name the subject of bare values',
};
const isMatchableLiteral = (l: { dead: string; subject?: string }) =>
  l.subject !== undefined || isDistinctiveIdentifier(l.dead);

export const TombstonedLiteralSchema = TombstonedLiteralObject.refine(isMatchableLiteral, MATCHABLE_LITERAL);
/** The same literal with unknown keys rejected — what tool callers may send. */
export const StrictTombstonedLiteralSchema = TombstonedLiteralObject.strict().refine(isMatchableLiteral, MATCHABLE_LITERAL);
export type TombstonedLiteral = z.infer<typeof TombstonedLiteralSchema>;

function isDistinctiveIdentifier(value: string): boolean {
  return value.length >= 4 && /[A-Za-z]/.test(value);
}

// ─────────────────────────────────────────────────────────────
// verifyBy — what makes a UV pickable from the queue
// ─────────────────────────────────────────────────────────────

export const VerifyBySchema = z.object({
  kind: z.enum(['command', 'inspect', 'ask', 'observe']),
  /** The command to run, file/symbol to read, person to ask, or condition to observe. */
  value: z.string().min(1),
  /** For `inspect`: what to look for. */
  detail: z.string().optional(),
});
export type VerifyBy = z.infer<typeof VerifyBySchema>;

// ─────────────────────────────────────────────────────────────
// Links — the lifecycle state machine is the graph over these
// ─────────────────────────────────────────────────────────────

export const LINK_TYPES = [
  'supersedes',
  'contests',
  'verifies',
  'refutes',
  'signs',
  'overrides',
  'strikes',
  'dismisses',
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface TruthLink {
  fromId: string;
  toId: string;
  type: LinkType;
}

// ─────────────────────────────────────────────────────────────
// Record types
// ─────────────────────────────────────────────────────────────

export type TruthEntryType = 'TB' | 'UV' | 'PROPOSAL' | 'ADDENDUM' | 'RULING' | 'MARKER';

export type TbStatus = 'active' | 'contested' | 'overridden';
export type UvStatus = 'open' | 'verified' | 'refuted';
export type ProposalStatus = 'open' | 'signed' | 'dismissed';

/**
 * Statuses are derived, never stored: each is a fold over the entry's
 * inbound links (see status.ts). `body.status` on a returned entry is that
 * derivation.
 */

/** Shared envelope for every ledger entry. */
export interface TruthEnvelope {
  /** ULID — sortable, unique. */
  id: string;
  type: TruthEntryType;
  createdAt: string;
  /** Human handle or registered agent identity — never blank, never "system". */
  author: string;
  provenance: Provenance;
  /** Agent session lineage, for the provenance-independence check (§11). */
  agentSessionId?: string | null;
  /** 'wiki' entries are authoritative in the wiki file; content is mirrored here. */
  origin: 'local' | 'wiki';
  links: TruthLink[];
}

/**
 * Fields a newer writer put on a wiki line that this version doesn't define,
 * kept as the line gave them so the export writes them back verbatim
 * (spec/truth-format, "Unknown values"). Only wiki import sets it; live
 * writes never do.
 */
export type ExtraFields = Record<string, unknown>;

/** TB — asserted tombstone: a prior statement is provably stale or wrong. */
export interface TbBody {
  /** What is dead and what replaces it (if anything). */
  claim: string;
  /** At least one required — the proof. */
  evidence: Evidence[];
  /** The asserting author (distinct from `author` when an agent drafted and a human signed). */
  signedBy: string | null;
  status: TbStatus;
  /** Matchable dead literals — optional; only TBs carrying them can raise objections (§12). */
  literals?: TombstonedLiteral[];
  extra?: ExtraFields;
}

/** UV — unverified assertion: believed true, stated before verification exists. */
export interface UvBody {
  /** The belief, in full sentences — no shorthand. */
  assertion: string;
  /** Why the author believes it. */
  basis: string;
  /** Machine-actionable verification hint. */
  verifyBy: VerifyBy;
  /** Id of a TB this UV disputes — this link puts the TB into `contested`. */
  contests?: string | null;
  status: UvStatus;
  extra?: ExtraFields;
}

/** PROPOSAL — machine-drafted candidate. Never truth until signed. */
export interface ProposalBody {
  kind: 'tombstone' | 'uv';
  /** The full TB or UV body it proposes. */
  draft: Record<string, unknown>;
  /** What triggered it (embedding score + threshold, sync scan diff, manual flag). */
  signal: {
    source:
      | 'supersession-detector'
      | 'sync-scan'
      | 'manual-flag'
      | 'wiki-reconciliation'
      | 'compaction-candidate'
      | 'agent-draft';
    score?: number;
    threshold?: number;
    detail?: string;
  };
  /** Dedupe key — the entity/decision this proposal targets. */
  targetRef?: string | null;
  /** Engine bookkeeping (e.g. decision ids to close when signed). */
  meta?: Record<string, unknown>;
  /**
   * Agent-drafted proposals must be notarized by a person before they mint:
   * only the notary paths sign them (REST with the notary secret, the
   * terminal notary, or sign_proposal in the operator profile) — never a
   * tool in the agent profile.
   */
  requiresNotary?: boolean;
  status: ProposalStatus;
  /** From the dismissal RULING that closed it (read-side; the proposal itself is never rewritten). */
  dismissedBy?: string | null;
  dismissReason?: string | null;
}

/** ADDENDUM — evidence attached after the fact. */
export interface AddendumBody {
  evidence: Evidence[];
  note?: string | null;
  extra?: ExtraFields;
}

/** RULING — a signed judgment about an existing entry (§11). */
export type RulingKind = 'strike' | 'promotion' | 'contempt' | 'objection' | 'dismissal';

/** Ruling kinds filed through fileRuling; objection rulings have their own path. */
export const FILED_RULING_KINDS = ['strike', 'promotion', 'contempt'] as const;
export type FiledRulingKind = (typeof FILED_RULING_KINDS)[number];

export interface RulingBody {
  kind: RulingKind;
  /** Required written reasoning — rulings are retrievable precedent. */
  opinion: string;
  /** Entry id, or registered author identity for contempt. */
  target: string;
  /** Objection rulings (§12): the objection ruled on, and the outcome. */
  objectionId?: string;
  outcome?: 'sustained' | 'overruled';
  extra?: ExtraFields;
}

/**
 * MARKER — a note the ledger writes about itself. `chained-at-migration`
 * closes the one-time migration of a pre-1.0 ledger: the entries before it
 * were hash-chained when it was written, not when they were.
 */
export interface MarkerBody {
  kind: 'chained-at-migration';
  note: string;
  /** Entries and links that existed before the ledger was chained. */
  entries: number;
  links: number;
  /** Hash of the last entry chained at migration. */
  through: string | null;
  /** Cached statuses the pre-1.0 bookkeeping got wrong, corrected by derivation. */
  statusCorrections: Array<{ id: string; field: 'status' | 'struck'; was: string | null; now: string | null }>;
}

export type TruthBody = TbBody | UvBody | ProposalBody | AddendumBody | RulingBody | MarkerBody;

export interface TruthEntry extends TruthEnvelope {
  body: TruthBody;
}

export type TbEntry = TruthEnvelope & { type: 'TB'; body: TbBody };
export type UvEntry = TruthEnvelope & { type: 'UV'; body: UvBody };
export type ProposalEntry = TruthEnvelope & { type: 'PROPOSAL'; body: ProposalBody };
export type AddendumEntry = TruthEnvelope & { type: 'ADDENDUM'; body: AddendumBody };
export type RulingEntry = TruthEnvelope & { type: 'RULING'; body: RulingBody };
export type MarkerEntry = TruthEnvelope & { type: 'MARKER'; body: MarkerBody };

// ─────────────────────────────────────────────────────────────
// Write-time validation schemas
// ─────────────────────────────────────────────────────────────

export const TbInputSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1, 'a TB requires at least one piece of evidence'),
  signedBy: AuthorSchema,
  literals: z.array(TombstonedLiteralSchema).optional(),
});

/** What an agent may draft: a TB body minus the signature it can't give itself. */
export const TombstoneDraftInputSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1, 'a tombstone draft requires at least one piece of evidence'),
  literals: z.array(TombstonedLiteralSchema).optional(),
});

export const UvInputSchema = z.object({
  assertion: z.string().min(1),
  basis: z.string().min(1),
  verifyBy: VerifyBySchema,
  // Wiki lines and intake drafts carry `contests: null` for "contests nothing"
  contests: z
    .string()
    .min(1)
    .nullish()
    .transform((v) => v ?? undefined),
});

/**
 * Corrections a notary may make to a draft when signing it: the draft's own
 * fields, nothing else (never a signer). The operator profile's
 * sign_proposal and the REST notary route both take exactly this.
 */
export const DraftEditsSchema = z
  .object({
    claim: z.string().min(1),
    evidence: z.array(EvidenceSchema.strict()).min(1),
    literals: z.array(StrictTombstonedLiteralSchema),
    assertion: z.string().min(1),
    basis: z.string().min(1),
    verifyBy: VerifyBySchema.strict(),
    contests: z.string().min(1).nullable(),
  })
  .partial()
  .strict()
  .describe('Corrections to the draft, applied at signing time (TB: claim/evidence/literals; UV: assertion/basis/verifyBy/contests)');

// ─────────────────────────────────────────────────────────────
// Downstream consumption rules (§7) — shipped verbatim inside
// MCP tool descriptions so consuming agents inherit them.
// ─────────────────────────────────────────────────────────────

export const CONSUMPTION_RULES = `Consumption rules by confidence type:
- Active TB: treat as ground truth. A reviewer may block on it; a code agent may rely on it.
- Contested TB: ground truth with a visible asterisk — cite both the TB and the contesting UV.
- Open UV: FLAG, DON'T BLOCK. A finding grounded only in a UV is phrased as a question or heads-up, never a demanded change. If your current task would settle the UV cheaply, do so via resolve_uv.
- Refuted UV / overridden TB: retrievable for history, excluded from current-truth by default, never citable as support for a claim.`;

// ─────────────────────────────────────────────────────────────
// ULID (Crockford base32, time-prefixed) — no new dependency
// ─────────────────────────────────────────────────────────────

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRandom: number[] = [];

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }

  let rand: number[];
  if (now === lastTime) {
    // Monotonic within the same millisecond: increment the random part
    rand = [...lastRandom];
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  lastTime = now;
  lastRandom = rand;

  return time + rand.map((v) => B32[v]).join('');
}

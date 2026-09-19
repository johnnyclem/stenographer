/**
 * Stenographer — TB/UV v2 Asserted Truth Layer: Types
 *
 * Five record types in one append-only ledger. Every entry carries two
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
 * rejected at the schema level — accountability requires a specific,
 * registered author (human handle or agent identity tied to an operator).
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

export function isAnonymousIdentity(identity: string): boolean {
  return ANONYMOUS_IDENTITIES.has(identity.trim().toLowerCase());
}

/** Author string: never blank, never a generic non-identity. */
export const AuthorSchema = z
  .string()
  .refine((s) => !isAnonymousIdentity(s), {
    message:
      'anonymous or generic identities cannot assert truth — use a registered human handle or agent identity',
  })
  .refine((s) => s.trim().toLowerCase() !== MIGRATION_AUTHOR, {
    message: `'${MIGRATION_AUTHOR}' is reserved for the backfill path`,
  });

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

export const EvidenceSchema = z.object({
  kind: z.enum(['commit', 'file', 'test', 'command', 'wiki', 'message']),
  /** Commit sha, file/line, test name, command line, wiki entry id, or message id. */
  ref: z.string().min(1),
  /** What the evidence shows (e.g. captured command output). */
  detail: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** `command` results are reproducible by anyone, so they self-sign (§6). */
export function isSelfSigningEvidence(evidence: Evidence[]): boolean {
  return evidence.some((e) => e.kind === 'command');
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

export type TruthEntryType = 'TB' | 'UV' | 'PROPOSAL' | 'ADDENDUM' | 'RULING';

export type TbStatus = 'active' | 'contested' | 'overridden';
export type UvStatus = 'open' | 'verified' | 'refuted';
export type ProposalStatus = 'open' | 'signed' | 'dismissed';

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

/** TB — asserted tombstone: a prior statement is provably stale or wrong. */
export interface TbBody {
  /** What is dead and what replaces it (if anything). */
  claim: string;
  /** At least one required — the proof. */
  evidence: Evidence[];
  /** The asserting author (distinct from `author` when an agent drafted and a human signed). */
  signedBy: string | null;
  status: TbStatus;
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
}

/** PROPOSAL — machine-drafted candidate. Never truth until signed. */
export interface ProposalBody {
  kind: 'tombstone' | 'uv';
  /** The full TB or UV body it proposes. */
  draft: Record<string, unknown>;
  /** What triggered it (embedding score + threshold, sync scan diff, manual flag). */
  signal: {
    source: 'supersession-detector' | 'sync-scan' | 'manual-flag' | 'wiki-reconciliation';
    score?: number;
    threshold?: number;
    detail?: string;
  };
  /** Dedupe key — the entity/decision this proposal targets. */
  targetRef?: string | null;
  /** Engine bookkeeping (e.g. decision ids to close when signed). */
  meta?: Record<string, unknown>;
  status: ProposalStatus;
  dismissedBy?: string | null;
  dismissReason?: string | null;
}

/** ADDENDUM — evidence attached after the fact. */
export interface AddendumBody {
  evidence: Evidence[];
  note?: string | null;
}

/** RULING — a signed judgment about an existing entry (§11). */
export interface RulingBody {
  kind: 'strike' | 'promotion' | 'contempt';
  /** Required written reasoning — rulings are retrievable precedent. */
  opinion: string;
  /** Entry id, or registered author identity for contempt. */
  target: string;
}

export type TruthBody = TbBody | UvBody | ProposalBody | AddendumBody | RulingBody;

export interface TruthEntry extends TruthEnvelope {
  body: TruthBody;
}

export type TbEntry = TruthEnvelope & { type: 'TB'; body: TbBody };
export type UvEntry = TruthEnvelope & { type: 'UV'; body: UvBody };
export type ProposalEntry = TruthEnvelope & { type: 'PROPOSAL'; body: ProposalBody };
export type AddendumEntry = TruthEnvelope & { type: 'ADDENDUM'; body: AddendumBody };
export type RulingEntry = TruthEnvelope & { type: 'RULING'; body: RulingBody };

// ─────────────────────────────────────────────────────────────
// Write-time validation schemas
// ─────────────────────────────────────────────────────────────

export const TbInputSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1, 'a TB requires at least one piece of evidence'),
  signedBy: AuthorSchema,
});

export const UvInputSchema = z.object({
  assertion: z.string().min(1),
  basis: z.string().min(1),
  verifyBy: VerifyBySchema,
  contests: z.string().optional(),
});

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

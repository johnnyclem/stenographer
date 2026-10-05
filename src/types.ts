/**
 * Stenographer — Core Types
 * MCP court reporter for real-time conversation indexing
 */

import { z } from 'zod';
import type { ObjectionSinkConfig } from './truth/delivery.js';
import type { SignerRegistryFile } from './truth/identity.js';
import type { Embedder } from './indexer/embeddings.js';

// ─────────────────────────────────────────────────────────────
// Message Schema (input from JSONL tailer)
// ─────────────────────────────────────────────────────────────

/**
 * What a record is when it isn't first-hand prose: a tool's output
 * (`tool_result`), harness bookkeeping such as Claude Code's isMeta caveats
 * and slash-command echoes (`meta`), a subagent's transcript (`sidechain`),
 * or a compaction summary (`compact_summary`). Tagged records stay
 * searchable, but are never mined for decisions, corrections or entities.
 */
export const MessageTagSchema = z.enum(['tool_result', 'meta', 'sidechain', 'compact_summary']);

export type MessageTag = z.infer<typeof MessageTagSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  timestamp: z.string(),
  toolCall: z.object({
    name: z.string(),
    input: z.record(z.unknown()),
  }).optional(),
  toolCalls: z.array(z.object({
    name: z.string(),
    input: z.record(z.unknown()),
  })).optional(),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.array(MessageTagSchema).optional(),
});

export type ConversationMessage = z.infer<typeof MessageSchema>;

// ─────────────────────────────────────────────────────────────
// Entity Graph Types
// ─────────────────────────────────────────────────────────────

export interface EntityNode {
  id: string;
  type: string;
  value: string;
  firstSeen: string;
  lastSeen: string;
  references: number;
}

export interface EntityRelation {
  from: string;
  to: string;
  relation: string;
  firstSeen: string;
  lastSeen: string;
}

export interface EntityGraph {
  nodes: Map<string, EntityNode>;
  edges: Map<string, EntityRelation[]>;
}

// ─────────────────────────────────────────────────────────────
// Importance Scoring
// ─────────────────────────────────────────────────────────────

export interface ImportanceScore {
  total: number;
  stateDelta: number;
  referenceFrequency: number;
  trajectoryDiscontinuity: number;
}

// ─────────────────────────────────────────────────────────────
// Decisions & Tombstones
// ─────────────────────────────────────────────────────────────

export interface Decision {
  id: string;
  description: string;
  alternatives: Array<{
    description: string;
    reason: string;
  }>;
  firstSeen: string;
  superseded: boolean;
  supersededBy: string | null;
  /** Provenance: the message that asserted this decision. */
  sourceMessageId?: string | null;
}

export interface Tombstone {
  id: string;
  superseded: string;
  correctedTo: string;
  reason: string;
  createdAt: string;
  /** Provenance: the message that triggered the supersession. */
  sourceMessageId?: string | null;
  /** The decision record this tombstone closed, if any. */
  supersededDecisionId?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Indexed State (SQLite backing)
// ─────────────────────────────────────────────────────────────

export interface IndexedMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: string;
  /** The message's vector, or its first chunk's; [] when it has no text to embed. */
  embedding: number[];
  /** Every chunk's vector, for a message long enough to be embedded in windows. */
  chunkEmbeddings?: number[][];
  importanceScore: ImportanceScore;
  entityIds: string[];
  tags?: MessageTag[];
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Position in the database's ingest order: later-indexed messages have higher seq. */
  seq?: number;
}

export interface IndexedDecision {
  id: string;
  sessionId: string;
  description: string;
  timestamp: string;
  superseded: boolean;
  supersededBy: string | null;
  sourceMessageId: string | null;
}

export interface IndexedTombstone {
  id: string;
  sessionId: string;
  superseded: string;
  correctedTo: string;
  reason: string;
  timestamp: string;
  sourceMessageId: string | null;
  supersededDecisionId: string | null;
}

// ─────────────────────────────────────────────────────────────
// MCP Tool Interface
// ─────────────────────────────────────────────────────────────

export interface StenographerAPI {
  // Query current conversation state
  getRecentMessages(n: number): Promise<ConversationMessage[]>;
  getEntities(): Promise<EntityNode[]>;
  getRelations(): Promise<EntityRelation[]>;
  getActiveDecisions(): Promise<Decision[]>;
  getTombstones(): Promise<Tombstone[]>;
  
  // Semantic search
  searchSimilar(query: string, k: number): Promise<ConversationMessage[]>;
  
  // Context frame for LLM
  buildContextFrame(tokenBudget: number): Promise<string>;
  
  // Stats
  getStatus(): Promise<{
    messagesIndexed: number;
    entities: number;
    decisions: number;
    tombstones: number;
  }>;
}

// ─────────────────────────────────────────────────────────────
// Operational Modes
// ─────────────────────────────────────────────────────────────

export type StenographerMode = 
  | 'live'    // Tailing active JSONL
  | 'catchup' // Batch processing completed JSONL  
  | 'watch'   // Watching directory for new files
  | 'daemon'; // Long-running service

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export interface StenographerConfig {
  /** File to tail ('live'/'catchup'/'daemon') or directory to watch ('watch'). */
  logPath: string;
  mode: StenographerMode;
  /** Log format adapter; omit to auto-detect from file content. */
  adapter?: 'jsonl' | 'anthropic' | 'openai' | 'claude-code' | 'generic';
  statePath?: string;
  /**
   * 'hashed' for the offline lexical embedder; a transformer model name
   * (default: Xenova/all-MiniLM-L6-v2), which fails to start if it can't be
   * loaded; or 'auto': the embedder the state database is pinned to, else
   * the default model with a loud fallback to hashed.
   */
  embeddingModel?: string;
  /** An embedder instance to use instead of `embeddingModel` (library use). */
  embedder?: Embedder;
  /**
   * The state database is pinned to the embedder that wrote its vectors,
   * and refuses to open under another. Set this to re-embed every stored
   * message and truth entry under the configured embedder at startup.
   */
  reembed?: boolean;
  /** Cosine-similarity threshold at or above which a new decision/correction
   *  supersedes an existing active decision. Default: the embedder's
   *  calibrated threshold (MiniLM 0.45, hashed 0.75). */
  supersedeThreshold?: number;
  /**
   * How close to the best match another active decision must score to be
   * proposed as superseded too: every active decision at or above
   * `supersedeThreshold` and within this margin of the best score gets a
   * PROPOSAL, best first, each naming the others proposed with it in
   * `signal.detail` ("near-tie with <ids>"). A runner-up that already has
   * an open supersession proposal into one of those decisions' chains is
   * not proposed again, so restating a decision doesn't re-propose its
   * near-ties. Shadow mode still auto-closes only the best match. A finite
   * number in [0, 1); the constructor throws otherwise. 0 proposes exact
   * ties only. Default 0.05.
   */
  supersedeMargin?: number;
  /**
   * TB/UV v2 rollout mode for the asserted-truth ledger:
   * - 'shadow' (default, Phase 0): the supersession detector keeps its
   *   auto-close behavior AND writes PROPOSALs to the truth ledger.
   * - 'assert' (Phase 1): auto-close is disabled; detection is
   *   proposal-only and truth requires an accountable signer.
   */
  truthMode?: 'shadow' | 'assert';
  /**
   * Real-time objections (§12, Phase 5): assistant output asserting a
   * tombstoned literal raises an objection citing the TB.
   * - 'shadow' (default): objections are recorded and rulable (for shadow
   *   judging against MR catches) but never emitted on /flags.
   * - 'deliver': objections are emitted on GET /flags.
   * - 'off': the detector doesn't run.
   */
  objectionMode?: 'off' | 'shadow' | 'deliver';
  /**
   * Webhook receivers for delivered objections (§14.8: webhooks). Channel
   * sinks (smallchat's channel bridge → Claude Code channel events) get each
   * objection as it's discovered; plain webhooks, for harnesses that can't
   * be interrupted, get batches of `batchSize` (default 3). URLs must be
   * loopback unless `allowRemote` is set.
   */
  objectionSinks?: ObjectionSinkConfig[];
  /**
   * When serving MCP, push each delivered objection to the attached client
   * as a Claude Code channel event (`notifications/claude/channel`).
   * Default true; ignored in watch mode, where one MCP connection can't be
   * mapped to the many sessions being watched.
   */
  objectionMcpChannel?: boolean;
  /**
   * Shared secret for the REST notary routes (`X-Notary-Secret`). Give it to
   * your approval UI (e.g. smallchat), never to agents. Unset disables
   * notarization over REST; the interactive CLI still works.
   */
  notarySecret?: string;
  /**
   * Which MCP tools this server exposes, and who its writes are attributed to.
   * - 'agent' (default): read tools plus propose_tombstone, assert_uv and
   *   resolve_uv. Every write is attributed to `agentIdentity` and this
   *   server's session; tool arguments cannot name anyone. An agent alone
   *   only drafts and attests: a claim settles when two or more agent
   *   sessions agree from different angles within 15 minutes (the agent
   *   quorum), or when a person signs. No tool in this profile signs with a
   *   person's name, dismisses, overrides, strikes or rules.
   * - 'operator': the judicial and destructive tools (sign_proposal,
   *   dismiss_proposal, override_tombstone, file_ruling, rule_on_objection,
   *   assert_tombstone, wiki import/export, backfill), for a notary UI or
   *   CLI a person drives. Identities come from the caller and are checked
   *   against `signerRegistry`. Never give this profile to an agent.
   */
  profile?: 'agent' | 'operator';
  /**
   * Whether agent quorums may settle claims on this ledger (`--agent-quorum`).
   * The setting is kept in the state file, so every process on it obeys it.
   * - 'off': nothing an agent files settles. Agreeing drafts stay open and
   *   agreeing verdicts are raised to a person; only a person signs or
   *   resolves. Any process may turn it off.
   * - 'on': two or more agent sessions agreeing from different angles within
   *   15 minutes settle (the agent quorum). Turning it back on over a ledger
   *   set to 'off' takes the operator profile; an agent-profile process
   *   asking for it fails to start.
   * - unset (default): leave the ledger as it is ('on' for a new ledger).
   */
  agentQuorum?: 'on' | 'off';
  /**
   * The identity agent-profile writes are attributed to (`--agent-identity`).
   * Default: `agent:<name>` from the MCP client's clientInfo. This ledger
   * treats it as an agent's whatever its spelling; other readers go by
   * their signer registry or, without one, the `agent:` prefix.
   */
  agentIdentity?: string;
  /**
   * The clock (epoch milliseconds) the agent quorum's 15-minute window reads,
   * and agent drafts and attestations are stamped with. Default `Date.now`;
   * tests pin it.
   */
  clock?: () => number;
  /**
   * Signer registry (`--signer-registry`): a JSON file path, or the parsed
   * file — `{"signers": [{"id", "role": "human"|"agent"|"detector", "aliases"?}]}`.
   * When set, operator paths accept only listed identities with a role that
   * may perform the act (people sign, notarize, rule; agents draft and
   * attest), and the ledger takes who is an agent from it.
   */
  signerRegistry?: string | SignerRegistryFile;
  /**
   * The directory wiki import and export read and write (`--wiki-dir`).
   * Default: `wiki/` next to the state file. Files are named relative to it;
   * paths outside it, symlinks out of it, non-`.jsonl` names and the state
   * file itself are refused.
   */
  wikiDir?: string;
  /** Port for the REST API. Defaults to 8787 in daemon mode, off otherwise. */
  restPort?: number;
  /**
   * Host/interface for the REST API to bind to. Defaults to `127.0.0.1` —
   * the API serves transcripts, so it stays loopback-only unless the
   * operator explicitly opts into wider exposure (e.g. `0.0.0.0` in a
   * container reached only through a trusted network boundary). A named
   * host is also accepted in the Host header.
   */
  restHost?: string;
  /**
   * Bearer token every REST request must carry (`STENOGRAPHER_REST_TOKEN`,
   * at least 16 characters). Default: one generated on first run into
   * `<state dir>/rest-token`, mode 0600, and reused after.
   */
  restToken?: string;
  /**
   * Serve REST without a bearer token (`--rest-insecure`). Host and Origin
   * are still checked, so a web page can't read it by DNS rebinding.
   */
  restInsecure?: boolean;
  /**
   * Host names REST answers to besides loopback and `restHost`
   * (`--rest-allow-host`, e.g. the name a container is reached by).
   */
  restAllowedHosts?: string[];
  /** Reserved for Tier-1 model-based extraction (roadmap). */
  extractionThreshold?: number;
  /** Reserved (roadmap). */
  memtableSize?: number;
}

/**
 * Stenographer — Core Types
 * MCP court reporter for real-time conversation indexing
 */

import { z } from 'zod';
import type { ObjectionSinkConfig } from './truth/delivery.js';
import type { SignerRegistryFile } from './truth/identity.js';

// ─────────────────────────────────────────────────────────────
// Message Schema (input from JSONL tailer)
// ─────────────────────────────────────────────────────────────

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
  embedding: number[];
  importanceScore: ImportanceScore;
  entityIds: string[];
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
  /** 'hashed' for the offline lexical embedder, or a transformer model name
   *  (default: Xenova/all-MiniLM-L6-v2; falls back to hashed if unavailable). */
  embeddingModel?: string;
  /** Cosine-similarity threshold above which a new decision/correction
   *  supersedes an existing active decision. Default 0.6. */
  supersedeThreshold?: number;
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
   * - 'agent' (default): read tools plus propose_tombstone, assert_uv and a
   *   resolve_uv that cannot mint TBs. Every write is attributed to
   *   `agentIdentity`; tool arguments cannot name anyone. No tool in this
   *   profile mints a TB, signs, dismisses, overrides, strikes or rules.
   * - 'operator': the judicial and destructive tools (sign_proposal,
   *   dismiss_proposal, override_tombstone, file_ruling, rule_on_objection,
   *   assert_tombstone, wiki import/export, backfill), for a notary UI or
   *   CLI a person drives. Identities come from the caller and are checked
   *   against `signerRegistry`. Never give this profile to an agent.
   */
  profile?: 'agent' | 'operator';
  /**
   * The identity agent-profile writes are attributed to (`--agent-identity`).
   * Default: `agent:<name>` from the MCP client's clientInfo.
   */
  agentIdentity?: string;
  /**
   * Single-user opt-out (`--allow-agent-assert`): the agent profile also
   * exposes assert_tombstone and lets resolve_uv mint TBs from `command`
   * evidence, signed by the agent identity (never a person's name). Off by
   * default, so every agent-authored TB is notarized by a person.
   */
  allowAgentAssert?: boolean;
  /**
   * Signer registry (`--signer-registry`): a JSON file path, or the parsed
   * file — `{"signers": [{"id", "role": "human"|"agent"|"detector", "aliases"?}]}`.
   * When set, operator paths accept only listed identities with a role that
   * may perform the act (people sign, notarize, rule; agents draft).
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
   * the API has no authentication, so it stays loopback-only unless the
   * operator explicitly opts into wider exposure (e.g. `0.0.0.0` in a
   * container reached only through a trusted network boundary).
   */
  restHost?: string;
  /** Reserved for Tier-1 model-based extraction (roadmap). */
  extractionThreshold?: number;
  /** Reserved (roadmap). */
  memtableSize?: number;
}

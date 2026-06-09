/**
 * Stenographer — Core Types
 * MCP court reporter for real-time conversation indexing
 */

import { z } from 'zod';

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
  /** Port for the REST API. Defaults to 8787 in daemon mode, off otherwise. */
  restPort?: number;
  /** Reserved for Tier-1 model-based extraction (roadmap). */
  extractionThreshold?: number;
  /** Reserved (roadmap). */
  memtableSize?: number;
}

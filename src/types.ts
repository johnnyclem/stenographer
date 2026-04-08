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
}

export interface Tombstone {
  id: string;
  superseded: string;
  correctedTo: string;
  reason: string;
  createdAt: string;
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
}

export interface IndexedTombstone {
  id: string;
  sessionId: string;
  superseded: string;
  correctedTo: string;
  reason: string;
  timestamp: string;
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
    tomb stones: number;
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
  logPath: string;
  mode: StenographerMode;
  adapter?: 'jsonl' | 'anthropic' | 'openai' | 'claude-code' | 'generic';
  statePath?: string;
  extractionThreshold?: number;
  memtableSize?: number;
  embeddingModel?: string;
}

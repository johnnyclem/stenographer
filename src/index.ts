// Stenographer — Main Entry Point
export { Stenographer } from './core/stenographer.js';
export { StenographerServer, runCLI } from './mcp/server.js';
export { RestServer } from './api/rest.js';
export { StateStore, type StateStoreOptions } from './store/index.js';
export { Tailer, JsonlAdapter, type LogAdapter, type TailerOptions } from './indexer/tailer.js';
export {
  OpenAIAdapter,
  AnthropicAdapter,
  ClaudeCodeAdapter,
  GenericAdapter,
  adapters,
  getAdapter,
  detectAdapter,
  detectAdapterFromLines,
} from './indexer/adapters.js';
export { ImportanceDetector, extractStructure, extractEntities, type ExtractedStructure } from './indexer/importance.js';
export {
  LocalEmbedder,
  HashedEmbedder,
  TransformerEmbedder,
  createEmbedder,
  VectorIndex,
  EmbeddingCache,
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
  type Embedder,
} from './indexer/embeddings.js';
export {
  GraphRAGRetriever,
  buildVectorCypher,
  buildGraphCypher,
  type QueryContext,
  type RetrievedChunk,
} from './indexer/graphrag.js';
export {
  TruthLedger,
  TruthWriteError,
  ContemptError,
  type WriteContext,
  type TruthFilter,
} from './truth/ledger.js';
export {
  exportWikiEntries,
  importWikiEntries,
  entryToWikiLine,
  wikiLineToEntry,
  type WikiEntryLine,
  type ImportResult,
} from './truth/wiki.js';
export {
  importProposalDrafts,
  COMPACTION_DETECTOR,
  type IntakeResult,
} from './truth/intake.js';
export {
  ObjectionLog,
  findLiteralHits,
  assertedText,
  type Objection,
  type ObjectionMode,
  type ObjectionStatus,
  type ObjectionStats,
} from './truth/objections.js';
export {
  ObjectionDispatcher,
  createSinkTransport,
  createMcpChannelTransport,
  formatObjection,
  formatObjectionBatch,
  DEFAULT_OBJECTION_BATCH_SIZE,
  type ObjectionSinkConfig,
  type ObjectionTransport,
} from './truth/delivery.js';
export * from './truth/types.js';
export * from './types.js';

// Stenographer — Main Entry Point
export { Stenographer, EmbedderMismatchError } from './core/stenographer.js';
export { StenographerServer, runCLI } from './mcp/server.js';
export { RestServer } from './api/rest.js';
export { StateStore, type StateStoreOptions, type IngestCheckpoint } from './store/index.js';
export {
  Tailer,
  JsonlAdapter,
  logSessionId,
  type LogAdapter,
  type LineContext,
  type TailerOptions,
  type TailPosition,
  type IngestPosition,
} from './indexer/tailer.js';
export { type RestServerOptions } from './api/rest.js';
export { resolveRestToken, restTokenPath, REST_TOKEN_FILE, type RestToken } from './api/auth.js';
export {
  OpenAIAdapter,
  AnthropicAdapter,
  ClaudeCodeAdapter,
  GenericAdapter,
  adapters,
  getAdapter,
  detectAdapter,
  detectAdapterFromLines,
  matchAdapterFromLines,
} from './indexer/adapters.js';
export {
  ImportanceDetector,
  extractStructure,
  extractEntities,
  assertableProse,
  type ExtractedStructure,
} from './indexer/importance.js';
export {
  LocalEmbedder,
  HashedEmbedder,
  TransformerEmbedder,
  createEmbedder,
  VectorIndex,
  EmbeddingCache,
  cosineSimilarity,
  sameEmbedder,
  describeEmbedder,
  EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
  type EmbedderIdentity,
  type CreateEmbedderOptions,
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
  NotarizationRequiredError,
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
  redactUrl,
  webhookHeaders,
  webhookId,
  assertWebhookSecret,
  DeliveryError,
  DEFAULT_OBJECTION_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_MAX_BATCH_DELAY_MS,
  MIN_WEBHOOK_SECRET_BYTES,
  type ObjectionSinkConfig,
  type ObjectionTransport,
  type DeadLetter,
} from './truth/delivery.js';
export { displayText } from './truth/display.js';
export {
  raiseForNotarization,
  formatProposalNotice,
  notarySecretMatches,
  NOTARY_SECRET_HEADER,
} from './truth/notary.js';
export { runNotaryCLI } from './truth/notary-cli.js';
export * from './truth/types.js';
export * from './types.js';

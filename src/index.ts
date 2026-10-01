// Stenographer — Main Entry Point
export { Stenographer } from './core/stenographer.js';
export { StenographerServer, runCLI, type ToolProfile } from './mcp/server.js';
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
  NotarizationRequiredError,
  type WriteContext,
  type TruthFilter,
  type NewEntry,
  type LedgerRecord,
} from './truth/ledger.js';
export {
  verifyLedger,
  chainRecord,
  recordHash,
  CHAIN_VERSION,
  type IntegrityReport,
  type IntegrityFailure,
  type IntegrityFailureKind,
} from './truth/chain.js';
export { deriveStatus, deriveStruck, deriveAll, type InboundLink, type DerivedState } from './truth/status.js';
export { canonicalize, sha256Hex, CanonicalizationError } from './truth/jcs.js';
export { runVerifyCLI, verifyStateFile, formatLedgerCheck, startupLedgerCheck, type LedgerCheck } from './truth/verify-cli.js';
export {
  exportWikiEntries,
  importWikiEntries,
  decodeWikiLine,
  checkWikiChain,
  wikiLineHash,
  wikiLineTexts,
  WikiLineError,
  WIKI_SCHEMA_VERSION,
  WIKI_SYNC_DETECTOR,
  WIKI_STATUSES,
  CAUSE_KINDS,
  type CauseKind,
  type WikiLine,
  type DecodedWikiLine,
  type WikiExportResult,
  type ImportOptions,
  type ImportResult,
  type ReconciliationReason,
} from './truth/wiki.js';
export {
  resolveWikiFile,
  readWikiFile,
  appendWikiFile,
  defaultWikiDir,
  WikiPathError,
  MAX_WIKI_FILE_BYTES,
  type WikiFileTarget,
  type WikiAppendResult,
} from './truth/wiki-file.js';
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
export {
  raiseForNotarization,
  formatProposalNotice,
  notarySecretMatches,
  NOTARY_SECRET_HEADER,
} from './truth/notary.js';
export { runNotaryCLI, type NotaryIO } from './truth/notary-cli.js';
export {
  SignerRegistry,
  SignerRegistryFileSchema,
  IdentityError,
  resolveIdentity,
  type SignerRegistryFile,
  type SignerRole,
} from './truth/identity.js';
export * from './truth/types.js';
export * from './types.js';

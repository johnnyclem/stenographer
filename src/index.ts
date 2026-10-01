// Stenographer — Main Entry Point
export { Stenographer, EmbedderMismatchError } from './core/stenographer.js';
export { StenographerServer, runCLI, type ToolProfile } from './mcp/server.js';
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
  answerContextConsult,
  ContextConsultSchema,
  CONSULT_BUDGET_MS,
  type ConsultBudget,
  type ContextConsult,
  type ContextAnswer,
  type ContextHit,
  type ContestFact,
} from './api/appa-context.js';
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
  assertedText,
  compileTombstones,
  ensureObjectionSchema,
  findGateRuling,
  gateMessageId,
  SCAN_BUDGET_MS,
  type ScanBudget,
  type CompiledTombstones,
  type GateCall,
  type Objection,
  type ObjectionMode,
  type ObjectionStatus,
  type ObjectionStats,
} from './truth/objections.js';
export {
  LiteralMatcher,
  findLiteralHits,
  MatchDeadlineError,
  MAX_SCANNED_CHARS,
  type LiteralHit,
  type MatchOptions,
} from './truth/literal-matcher.js';
export { assertingFields, shellAssertingText, addedLines, type AssertedField } from './truth/asserting.js';
export {
  evaluateGate,
  runGateCLI,
  wikiMatchableTombstones,
  callDigest,
  harnessToolId,
  GateTimeoutError,
  CLAUDE_CODE_HOOK_TIMEOUT_MS,
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_GATE_TOOLS,
  type GateMode,
  type GateOnError,
  type GateOptions,
  type GateHit,
  type GateResult,
  type GateIO,
} from './truth/gate.js';
export {
  ObjectionDispatcher,
  createSinkTransport,
  createMcpChannelTransport,
  ensureDeliverySchema,
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

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
export * from './types.js';

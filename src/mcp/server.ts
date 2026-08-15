/**
 * Stenographer — MCP Server
 * Exposes the StenographerAPI surface as MCP tools over stdio.
 * All indexing/query logic lives in the core engine (../core/stenographer.js).
 */

import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Stenographer } from '../core/stenographer.js';
import type { StenographerConfig, StenographerMode } from '../types.js';

const VERSION = '0.1.0-alpha.2';

// ─────────────────────────────────────────────────────────────
// MCP Server Implementation
// ─────────────────────────────────────────────────────────────

export class StenographerServer {
  readonly engine: Stenographer;
  private server: Server;

  constructor(config: StenographerConfig) {
    this.engine = new Stenographer(config);

    this.server = new Server(
      { name: 'stenographer', version: VERSION },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  async start(): Promise<void> {
    await this.engine.start();

    // Serve MCP over stdio (stdout is the protocol channel — all logging
    // in this process must go to stderr)
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  stop(): void {
    this.engine.stop();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'get_recent_messages',
          description: 'Get the N most recent messages from the conversation',
          inputSchema: {
            type: 'object',
            properties: {
              n: { type: 'number', description: 'Number of messages to retrieve', default: 10 },
            },
          },
        },
        {
          name: 'get_entities',
          description: 'Get all entities extracted from the conversation',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_relations',
          description: 'Get all entity relations (knowledge graph edges) from the conversation',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_decisions',
          description: 'Get all active (non-superseded) decisions made in the conversation',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_decision_history',
          description:
            'Get the full decision history including superseded versions. Each superseded decision keeps its provenance and points at its successor.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_decision_chain',
          description:
            'Get the supersession chain containing a decision, oldest observation first. The last entry is the current version of that decision.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Decision id anywhere in the chain' },
            },
            required: ['id'],
          },
        },
        {
          name: 'get_corrections',
          description: 'Get all corrections/tombstones from the conversation',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'search_conversation',
          description:
            'Search the conversation semantically using GraphRAG - hybrid vector + graph search',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              k: { type: 'number', description: 'Number of results', default: 5 },
              graph_depth: { type: 'number', description: 'Graph traversal depth', default: 2 },
            },
          },
        },
        {
          name: 'search_similar',
          description: 'Pure vector similarity search over indexed messages (persistent index)',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              k: { type: 'number', description: 'Number of results', default: 5 },
            },
          },
        },
        {
          name: 'get_context_frame',
          description: 'Build a context frame within a token budget for the next LLM call',
          inputSchema: {
            type: 'object',
            properties: {
              budget: { type: 'number', description: 'Token budget', default: 2000 },
            },
          },
        },
        {
          name: 'get_status',
          description: 'Get stenographer status and statistics',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.callTool(name, (args ?? {}) as Record<string, unknown>);
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_recent_messages':
        return this.engine.getRecentMessages((args.n as number) || 10);

      case 'get_entities':
        return this.engine.getEntities();

      case 'get_relations':
        return this.engine.getRelations();

      case 'get_decisions':
        return this.engine.getActiveDecisions();

      case 'get_decision_history':
        return this.engine.getDecisionHistory();

      case 'get_decision_chain': {
        const id = args.id as string;
        if (!id) throw new Error('Missing required argument: id');
        return this.engine.getDecisionChain(id);
      }

      case 'get_corrections':
        return this.engine.getTombstones();

      case 'search_conversation': {
        const query = (args.query as string) || '';
        const k = (args.k as number) || 5;
        const graphDepth = (args.graph_depth as number) || 2;
        const results = await this.engine.searchGraphRAG({ query, k, graphDepth });
        return { query, results, stats: this.engine.retriever.getStats() };
      }

      case 'search_similar':
        return this.engine.searchSimilar((args.query as string) || '', (args.k as number) || 5);

      case 'get_context_frame':
        return this.engine.buildContextFrame((args.budget as number) || 2000);

      case 'get_status': {
        const stats = await this.engine.getStatus();
        return {
          ...stats,
          retriever: this.engine.retriever.getStats(),
          vectorBackend: this.engine.store.vectorSearchBackend,
          sessionId: this.engine.getSessionId(),
          mode: this.engine.config.mode,
          restPort: this.engine.restPort,
          version: VERSION,
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────

const MODES: StenographerMode[] = ['live', 'catchup', 'watch', 'daemon'];

export async function runCLI(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      mode: { type: 'string', short: 'm' },
      adapter: { type: 'string', short: 'a' },
      'rest-port': { type: 'string' },
      'rest-host': { type: 'string' },
      embeddings: { type: 'string', short: 'e' },
    },
    allowPositionals: true,
  });

  const logPath = positionals[0] || './conversation.jsonl';
  const statePath = positionals[1] || './stenographer.db';

  const mode = (values.mode as StenographerMode) || 'live';
  if (!MODES.includes(mode)) {
    console.error(`Unknown mode '${mode}'. Available: ${MODES.join(', ')}`);
    process.exit(1);
  }

  const config: StenographerConfig = {
    logPath,
    statePath,
    mode,
    adapter: values.adapter as StenographerConfig['adapter'],
    embeddingModel: values.embeddings,
    restPort: values['rest-port'] ? Number.parseInt(values['rest-port'], 10) : undefined,
    restHost: values['rest-host'] as string | undefined,
  };

  // Log to stderr — stdout carries the MCP stdio protocol
  console.error(`🤖 Starting Stenographer v${VERSION}`);
  console.error(`📄 ${mode === 'watch' ? 'Watching directory' : 'Watching'}: ${logPath}`);
  console.error(`💾 State: ${statePath}`);
  console.error(`🎛  Mode: ${mode}${config.adapter ? `, adapter: ${config.adapter}` : ' (adapter auto-detect)'}`);

  const server = new StenographerServer(config);
  await server.start();

  console.error('✅ Stenographer is running. Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    console.error('\n👋 Shutting down...');
    server.stop();
    process.exit(0);
  });
}

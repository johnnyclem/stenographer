/**
 * Stenographer — MCP Server
 * Exposes conversation index as MCP tools with GraphRAG search
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Tailer } from '../indexer/tailer.js';
import { StateStore } from '../store/index.js';
import { ImportanceDetector } from '../indexer/importance.js';
import { GraphRAGRetriever } from '../indexer/graphrag.js';
import type { StenographerConfig, ConversationMessage } from '../types.js';

// ─────────────────────────────────────────────────────────────
// MCP Server Implementation
// ─────────────────────────────────────────────────────────────

export class StenographerServer {
  private server: Server;
  private tailer: Tailer;
  private store: StateStore;
  private detector: ImportanceDetector;
  private retriever: GraphRAGRetriever;
  private sessionId: string;

  constructor(config: StenographerConfig) {
    this.sessionId = `session_${Date.now()}`;
    this.store = new StateStore(config.statePath || './stenographer.db');
    this.tailer = new Tailer(config.logPath, this.sessionId);
    this.detector = new ImportanceDetector();
    this.retriever = new GraphRAGRetriever();

    // Set up message handler
    this.tailer.on('message', async (msg: ConversationMessage) => {
      await this.indexMessage(msg);
    });

    // Create MCP server
    this.server = new Server(
      {
        name: 'stenographer',
        version: '0.1.0-alpha.2',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  async start(): Promise<void> {
    await this.tailer.start();
  }

  stop(): void {
    this.tailer.stop();
    this.store.close();
  }

  private async indexMessage(msg: ConversationMessage): Promise<void> {
    // Score importance
    const history = this.store.getMessagesBySession(this.sessionId);
    const score = this.detector.score(msg, history);

    // Extract entities
    const extracted = this.detector.extractStructure(msg.content);

    // Index in GraphRAG retriever (for semantic search)
    await this.retriever.indexMessage(msg);

    // Index entities and relations
    for (const entity of extracted.entities) {
      this.retriever.indexEntity({
        id: entity.name,
        type: entity.type,
        value: entity.value,
        firstSeen: msg.timestamp,
        lastSeen: msg.timestamp,
        references: 1,
      });
    }

    // Store in SQLite
    this.store.addMessage({
      id: msg.id,
      sessionId: this.sessionId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      embedding: [], // TODO: embed and store
      importanceScore: score,
      entityIds: extracted.entities.map((e) => e.name),
    });

    // Store decisions
    for (const decision of extracted.decisions) {
      this.store.addDecision(this.sessionId, {
        id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        description: decision,
      });
    }

    // Store tombstones (corrections)
    for (const correction of extracted.corrections) {
      this.store.addTombstone(this.sessionId, {
        id: `tombstone_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        superseded: correction.from,
        correctedTo: correction.to,
        reason: 'Correction detected',
      });
    }
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
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_decisions',
          description: 'Get all active (non-superseded) decisions made in the conversation',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_corrections',
          description: 'Get all corrections/tombstones from the conversation',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'search_conversation',
          description: 'Search the conversation semantically using GraphRAG - hybrid vector + graph search',
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
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request;

      try {
        switch (name) {
          case 'get_recent_messages': {
            const n = (args as any).n || 10;
            const messages = this.store.getRecentMessages(this.sessionId, n);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(messages, null, 2),
                },
              ],
            };
          }

          case 'get_entities': {
            const entities = this.store.getEntities(this.sessionId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(entities, null, 2),
                },
              ],
            };
          }

          case 'get_decisions': {
            const decisions = this.store.getActiveDecisions(this.sessionId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(decisions, null, 2),
                },
              ],
            };
          }

          case 'get_corrections': {
            const tombstones = this.store.getTombstones(this.sessionId);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(tombstones, null, 2),
                },
              ],
            };
          }

          case 'search_conversation': {
            const query = (args as any).query || '';
            const k = (args as any).k || 5;
            const graphDepth = (args as any).graph_depth || 2;

            // Use GraphRAG retriever
            const results = await this.retriever.search({
              query,
              k,
              graphDepth,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    query,
                    results,
                    stats: this.retriever.getStats(),
                  }, null, 2),
                },
              ],
            };
          }

          case 'get_context_frame': {
            const budget = (args as any).budget || 2000;
            const messages = this.store.getMessagesBySession(this.sessionId);
            const decisions = this.store.getActiveDecisions(this.sessionId);
            const entities = this.store.getEntities(this.sessionId);

            // Build context frame within budget
            const frame = this.buildContextFrame(messages, decisions, entities, budget);

            return {
              content: [
                {
                  type: 'text',
                  text: frame,
                },
              ],
            };
          }

          case 'get_status': {
            const stats = this.store.getStats(this.sessionId);
            const retrieverStats = this.retriever.getStats();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...stats,
                    retriever: retrieverStats,
                    sessionId: this.sessionId,
                    version: '0.1.0-alpha.2',
                  }, null, 2),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
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

  private buildContextFrame(
    messages: any[],
    decisions: any[],
    entities: any[],
    budget: number
  ): string {
    const parts: string[] = [];

    // Add entities (most compact)
    if (entities.length > 0) {
      parts.push(`## Entities\n${entities.map((e) => `- ${e.value} (${e.type})`).join('\n')}`);
    }

    // Add decisions
    if (decisions.length > 0) {
      parts.push(`## Decisions\n${decisions.map((d) => `- ${d.description}`).join('\n')}`);
    }

    // Add recent messages (most expensive)
    let currentTokens = this.estimateTokens(parts.join('\n'));
    const recentMessages: string[] = [];

    for (const msg of messages.slice(-10)) {
      const msgText = `\n${msg.role}: ${msg.content.slice(0, 200)}`;
      const msgTokens = this.estimateTokens(msgText);

      if (currentTokens + msgTokens > budget) break;

      recentMessages.unshift(msgText);
      currentTokens += msgTokens;
    }

    if (recentMessages.length > 0) {
      parts.push(`## Recent Messages${recentMessages.join('')}`);
    }

    return parts.join('\n\n');
  }

  private estimateTokens(text: string): number {
    // Rough heuristic: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

// ─────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────

export async function runCLI(args: string[]): Promise<void> {
  const logPath = args[0] || './conversation.jsonl';
  const statePath = args[1] || './stenographer.db';

  console.log(`🤖 Starting Stenographer v0.1.0-alpha.2`);
  console.log(`📄 Watching: ${logPath}`);
  console.log(`💾 State: ${statePath}`);
  console.log(`🔍 GraphRAG: Enabled (hybrid vector + graph search)`);

  const server = new StenographerServer({
    logPath,
    statePath,
    mode: 'live',
  });

  await server.start();

  console.log('✅ Stenographer is running. Press Ctrl+C to stop.');

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    server.stop();
    process.exit(0);
  });
}

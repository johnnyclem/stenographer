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
import { CONSUMPTION_RULES } from '../truth/types.js';
import type { Evidence, VerifyBy, ProposalBody, TombstonedLiteral } from '../truth/types.js';
import type { TruthFilter } from '../truth/ledger.js';
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
            'Search the conversation semantically using GraphRAG - hybrid vector + graph search. ' +
            'Results include relevant truth-ledger entries (per truthFilter, default "current"). ' +
            CONSUMPTION_RULES,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              k: { type: 'number', description: 'Number of results', default: 5 },
              graph_depth: { type: 'number', description: 'Graph traversal depth', default: 2 },
              truthFilter: {
                type: 'string',
                enum: ['current', 'all', 'contested'],
                description: 'Which truth entries to include alongside results',
                default: 'current',
              },
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
        // ── TB/UV v2: asserted truth layer ──────────────────
        {
          name: 'list_proposals',
          description:
            'The review inbox: machine-drafted PROPOSAL entries awaiting an accountable sign/dismiss. ' +
            'A proposal that nobody signs is just a proposal, forever — it never becomes truth on its own.',
          inputSchema: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['open', 'signed', 'dismissed'], description: 'Filter by status' },
              kind: { type: 'string', enum: ['tombstone', 'uv'], description: 'Filter by proposed record kind' },
            },
          },
        },
        {
          name: 'sign_proposal',
          description:
            'Sign a proposal under an accountable identity, minting the real TB/UV with a signs-link back. ' +
            'edits corrects the draft at signing time — the signed version is what is true, the draft is history. ' +
            'A signer sharing the drafting agent session is rejected (contempt of corpus: corroboration must be provenance-independent).',
          inputSchema: {
            type: 'object',
            properties: {
              proposalId: { type: 'string' },
              signedBy: { type: 'string', description: 'Accountable signer — anonymous identities are rejected' },
              edits: { type: 'object', description: 'Corrections to the draft, applied at signing time' },
              agentSessionId: { type: 'string', description: 'Calling agent session, for the independence check' },
            },
            required: ['proposalId', 'signedBy'],
          },
        },
        {
          name: 'dismiss_proposal',
          description:
            'Dismiss a proposal with a required reason. Dismissal reasons are kept — they are training data for tuning the detector.',
          inputSchema: {
            type: 'object',
            properties: {
              proposalId: { type: 'string' },
              dismissedBy: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['proposalId', 'dismissedBy', 'reason'],
          },
        },
        {
          name: 'assert_tombstone',
          description:
            'Directly assert a TB (skipping the proposal path) — for authors who already know. ' +
            'A TB claims a prior statement/decision is provably stale or wrong; at least one piece of evidence is required.',
          inputSchema: {
            type: 'object',
            properties: {
              claim: { type: 'string', description: 'What is dead and what replaces it (if anything)' },
              evidence: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['commit', 'file', 'test', 'command', 'wiki', 'message'] },
                    ref: { type: 'string' },
                    detail: { type: 'string' },
                  },
                  required: ['kind', 'ref'],
                },
              },
              signedBy: { type: 'string', description: 'The asserting author — anonymous identities are rejected' },
              literals: {
                type: 'array',
                description:
                  'Matchable dead literals — numeric constants, identifiers, config values. Only TBs carrying them ' +
                  'can raise real-time objections. A bare value needs its subject (e.g. {subject: "LOG_BUDGET", dead: "30", current: "100"}); ' +
                  'a distinctive identifier may stand alone (e.g. {dead: "legacyRateLimiter"}).',
                items: {
                  type: 'object',
                  properties: {
                    dead: { type: 'string', description: 'The dead value or identifier' },
                    subject: { type: 'string', description: 'The identifier the value belongs to' },
                    current: { type: 'string', description: 'What replaced it, if anything' },
                  },
                  required: ['dead'],
                },
              },
              author: { type: 'string', description: 'Drafting author when distinct from signedBy' },
              agentSessionId: { type: 'string' },
            },
            required: ['claim', 'evidence', 'signedBy'],
          },
        },
        {
          name: 'assert_uv',
          description:
            'Assert a UV — an unverified assertion ("there be dragons"): believed true, stated before verification exists. ' +
            'Written in full sentences with a machine-actionable verifyBy hint. ' +
            'Set contests to a TB id to dispute it: the TB becomes contested but remains active truth.',
          inputSchema: {
            type: 'object',
            properties: {
              assertion: { type: 'string', description: 'The belief, in full sentences — no shorthand' },
              basis: { type: 'string', description: 'Why the author believes it' },
              verifyBy: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['command', 'inspect', 'ask', 'observe'] },
                  value: { type: 'string' },
                  detail: { type: 'string' },
                },
                required: ['kind', 'value'],
              },
              contests: { type: 'string', description: 'TB id this UV disputes (optional)' },
              author: { type: 'string' },
              agentSessionId: { type: 'string' },
            },
            required: ['assertion', 'basis', 'verifyBy', 'author'],
          },
        },
        {
          name: 'resolve_uv',
          description:
            'Resolve an open UV as verified or refuted, filing an evidence-bearing ADDENDUM. ' +
            'command evidence is self-signing (reproducible by anyone); any resolution that mints a TB from ' +
            'other evidence requires a human signedBy and files a promotion RULING. ' +
            'Resolver must be provenance-independent of the UV author (contempt of corpus). ' +
            'A verified contesting UV overrides its TB; a refuted one restores the TB to active.',
          inputSchema: {
            type: 'object',
            properties: {
              uvId: { type: 'string' },
              resolution: { type: 'string', enum: ['verified', 'refuted'] },
              evidence: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['commit', 'file', 'test', 'command', 'wiki', 'message'] },
                    ref: { type: 'string' },
                    detail: { type: 'string' },
                  },
                  required: ['kind', 'ref'],
                },
              },
              author: { type: 'string', description: 'The resolving agent/human identity' },
              signedBy: { type: 'string', description: 'Human signer, required when non-command evidence mints a TB' },
              opinion: { type: 'string', description: 'Written reasoning, recorded as promotion-ruling precedent' },
              mintTombstone: { type: 'string', description: 'Claim text to mint a TB from this resolution (e.g. when a refuted UV propagated)' },
              agentSessionId: { type: 'string' },
            },
            required: ['uvId', 'resolution', 'evidence', 'author'],
          },
        },
        {
          name: 'override_tombstone',
          description:
            'The force path: override an active TB with a proven ADDENDUM. Fails without evidence — ' +
            'like force-pushing a protected branch: possible, deliberate, and logged. ' +
            '(The other legal path is assert_uv with contests, which marks the TB contested without flipping it.)',
          inputSchema: {
            type: 'object',
            properties: {
              tbId: { type: 'string' },
              evidence: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['commit', 'file', 'test', 'command', 'wiki', 'message'] },
                    ref: { type: 'string' },
                    detail: { type: 'string' },
                  },
                  required: ['kind', 'ref'],
                },
              },
              note: { type: 'string' },
              author: { type: 'string' },
              agentSessionId: { type: 'string' },
            },
            required: ['tbId', 'evidence', 'author'],
          },
        },
        {
          name: 'get_verification_queue',
          description:
            'Open UVs ranked for opportunistic verification: contested pairs first, then relevance to your ' +
            'stated working context, then age. ask-shaped UVs are deprioritized for agents. If your current ' +
            'task would settle one cheaply, resolve it via resolve_uv. ' + CONSUMPTION_RULES,
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'string', description: 'Files/entities you are touching, for relevance ranking' },
              k: { type: 'number', default: 10 },
            },
          },
        },
        {
          name: 'get_contested',
          description:
            'All TB+UV disputes: contested TBs paired with their live contesting UVs. Contested is information, ' +
            'not noise — "we proved X, but someone credible believes not-X". ' + CONSUMPTION_RULES,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_truth',
          description:
            'Truth-ledger entries by filter (default "current": active/contested TBs and open UVs; struck and ' +
            'overridden entries excluded). ' + CONSUMPTION_RULES,
          inputSchema: {
            type: 'object',
            properties: {
              truthFilter: { type: 'string', enum: ['current', 'all', 'contested'], default: 'current' },
            },
          },
        },
        {
          name: 'search_truth',
          description:
            'Truth-ledger entries ranked by embedding relevance to a query. Ties break toward the TB. ' +
            CONSUMPTION_RULES,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              k: { type: 'number', default: 5 },
              truthFilter: { type: 'string', enum: ['current', 'all', 'contested'], default: 'current' },
            },
            required: ['query'],
          },
        },
        {
          name: 'file_ruling',
          description:
            'File a signed RULING with a required written opinion (rulings are retrievable precedent). ' +
            'strike: declares an entry inadmissible for retrieval (kept in history, excluded from current truth). ' +
            'promotion: records who ruled UV evidence sufficient and why. ' +
            'contempt: judges an author\'s conduct and mints exactly one TB about it — no reputation system.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['strike', 'promotion', 'contempt'] },
              opinion: { type: 'string' },
              target: { type: 'string', description: 'Entry id, or author identity for contempt' },
              author: { type: 'string' },
              agentSessionId: { type: 'string' },
            },
            required: ['kind', 'opinion', 'target', 'author'],
          },
        },
        // ── Real-time objections (§12) ──────────────────────
        {
          name: 'list_objections',
          description:
            'Real-time objections: assistant output that asserted a tombstoned literal, each with the objection, ' +
            'the exhibit (the full TB record) and the transcript line. An objection is a warning with a citation ' +
            'attached — whoever is in the session decides what to do with it, then rules via rule_on_objection. ' +
            'includeShadow adds shadow-mode objections (recorded, never delivered) for shadow judging.',
          inputSchema: {
            type: 'object',
            properties: {
              since: { type: 'string', description: 'Exclusive objection-id cursor' },
              status: { type: 'string', enum: ['pending', 'sustained', 'overruled'] },
              includeShadow: { type: 'boolean', default: false },
              limit: { type: 'number', default: 100 },
            },
          },
        },
        {
          name: 'rule_on_objection',
          description:
            'Rule on a real-time objection, with a written opinion. sustained: the session corrects course and the ' +
            'ruling lands in the record as corroboration for the TB. overruled: the objection was wrong or ' +
            'immaterial — signal for tightening the matcher. Either way an ordinary RULING is filed; the TB\'s status ' +
            'does not change.',
          inputSchema: {
            type: 'object',
            properties: {
              objectionId: { type: 'string' },
              outcome: { type: 'string', enum: ['sustained', 'overruled'] },
              opinion: { type: 'string' },
              author: { type: 'string', description: 'The judge — anonymous identities are rejected' },
              agentSessionId: { type: 'string' },
            },
            required: ['objectionId', 'outcome', 'opinion', 'author'],
          },
        },
        {
          name: 'export_wiki_entries',
          description:
            'Export signed TB/UV entries as team llm-wiki append-only JSONL. Stenographer-specific fields travel ' +
            'under the x-steno key. Proposals are never exported — the wiki only ever sees signed truth.',
          inputSchema: {
            type: 'object',
            properties: {
              since: { type: 'string', description: 'ISO timestamp; only entries created after it' },
              path: { type: 'string', description: 'File to write/append; omit to return lines inline' },
            },
          },
        },
        {
          name: 'import_wiki_entries',
          description:
            'Ingest the team llm-wiki JSONL. Wiki entries keep their original ids and authors; the wiki file stays ' +
            'authoritative for their content. A wiki entry contradicting a local one generates a reconciliation ' +
            'PROPOSAL — it does not auto-win and does not auto-lose.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
        {
          name: 'backfill_legacy_tombstones',
          description:
            'Phase-1 migration: backfill pre-assertion auto-closed supersessions as queryably second-class TBs ' +
            '(author "migration", signedBy null). Idempotent; no history is rewritten.',
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
        const truthFilter = (args.truthFilter as TruthFilter) || 'current';
        const results = await this.engine.searchGraphRAG({ query, k, graphDepth });
        const truth = await this.engine.searchTruth(query, k, truthFilter);
        return { query, results, truth, stats: this.engine.retriever.getStats() };
      }

      case 'search_similar':
        return this.engine.searchSimilar((args.query as string) || '', (args.k as number) || 5);

      case 'get_context_frame':
        return this.engine.buildContextFrame((args.budget as number) || 2000);

      case 'get_status': {
        const stats = await this.engine.getStatus();
        return {
          ...stats,
          truth: await this.engine.getTruthStats(),
          truthMode: this.engine.getTruthMode(),
          objections: await this.engine.getObjectionStats(),
          retriever: this.engine.retriever.getStats(),
          vectorBackend: this.engine.store.vectorSearchBackend,
          sessionId: this.engine.getSessionId(),
          mode: this.engine.config.mode,
          restPort: this.engine.restPort,
          version: VERSION,
        };
      }

      // ── TB/UV v2: asserted truth layer ──────────────────

      case 'list_proposals':
        return this.engine.listProposals(
          args.status as ProposalBody['status'] | undefined,
          args.kind as ProposalBody['kind'] | undefined
        );

      case 'sign_proposal': {
        const { proposalId, signedBy, edits, agentSessionId } = args as {
          proposalId: string;
          signedBy: string;
          edits?: Record<string, unknown>;
          agentSessionId?: string;
        };
        if (!proposalId || !signedBy) throw new Error('proposalId and signedBy are required');
        return this.engine.signProposal(proposalId, signedBy, edits, agentSessionId);
      }

      case 'dismiss_proposal': {
        const { proposalId, dismissedBy, reason } = args as {
          proposalId: string;
          dismissedBy: string;
          reason: string;
        };
        if (!proposalId || !dismissedBy || !reason) {
          throw new Error('proposalId, dismissedBy, and reason are required');
        }
        return this.engine.dismissProposal(proposalId, dismissedBy, reason);
      }

      case 'assert_tombstone':
        return this.engine.assertTombstone({
          claim: args.claim as string,
          evidence: args.evidence as Evidence[],
          signedBy: args.signedBy as string,
          literals: args.literals as TombstonedLiteral[] | undefined,
          author: args.author as string | undefined,
          agentSessionId: args.agentSessionId as string | undefined,
        });

      case 'assert_uv':
        return this.engine.assertUv({
          assertion: args.assertion as string,
          basis: args.basis as string,
          verifyBy: args.verifyBy as VerifyBy,
          contests: args.contests as string | undefined,
          author: args.author as string,
          agentSessionId: args.agentSessionId as string | undefined,
        });

      case 'resolve_uv':
        return this.engine.resolveUv(
          args.uvId as string,
          args.resolution as 'verified' | 'refuted',
          args.evidence as Evidence[],
          {
            author: args.author as string,
            signedBy: args.signedBy as string | undefined,
            opinion: args.opinion as string | undefined,
            mintTombstone: args.mintTombstone as string | undefined,
            agentSessionId: args.agentSessionId as string | undefined,
          }
        );

      case 'override_tombstone':
        return this.engine.overrideTombstone(
          args.tbId as string,
          {
            evidence: args.evidence as Evidence[],
            note: args.note as string | undefined,
          },
          {
            author: args.author as string,
            agentSessionId: args.agentSessionId as string | undefined,
          }
        );

      case 'get_verification_queue':
        return this.engine.getVerificationQueue(
          args.context as string | undefined,
          (args.k as number) || 10
        );

      case 'get_contested':
        return this.engine.getContestedTruth();

      case 'get_truth':
        return this.engine.getTruth((args.truthFilter as TruthFilter) || 'current');

      case 'search_truth':
        return this.engine.searchTruth(
          (args.query as string) || '',
          (args.k as number) || 5,
          (args.truthFilter as TruthFilter) || 'current'
        );

      case 'file_ruling':
        return this.engine.fileRuling({
          kind: args.kind as 'strike' | 'promotion' | 'contempt',
          opinion: args.opinion as string,
          target: args.target as string,
          author: args.author as string,
          agentSessionId: args.agentSessionId as string | undefined,
        });

      case 'list_objections':
        return this.engine.getObjections({
          since: args.since as string | undefined,
          status: args.status as 'pending' | 'sustained' | 'overruled' | undefined,
          includeShadow: args.includeShadow === true,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });

      case 'rule_on_objection': {
        const { objectionId, outcome, opinion, author, agentSessionId } = args as {
          objectionId: string;
          outcome: 'sustained' | 'overruled';
          opinion: string;
          author: string;
          agentSessionId?: string;
        };
        if (!objectionId || !opinion || !author || !['sustained', 'overruled'].includes(outcome)) {
          throw new Error('objectionId, outcome (sustained|overruled), opinion, and author are required');
        }
        return this.engine.ruleOnObjection(objectionId, outcome, { author, opinion, agentSessionId });
      }

      case 'export_wiki_entries':
        return this.engine.exportWikiEntries({
          since: args.since as string | undefined,
          path: args.path as string | undefined,
        });

      case 'import_wiki_entries': {
        const path = args.path as string;
        if (!path) throw new Error('Missing required argument: path');
        return this.engine.importWikiEntries({ path });
      }

      case 'backfill_legacy_tombstones': {
        const backfilled = await this.engine.backfillLegacyTombstones();
        return { backfilled };
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
      objections: { type: 'string' },
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

  const objectionMode = (values.objections as StenographerConfig['objectionMode']) ?? 'shadow';
  if (!['off', 'shadow', 'deliver'].includes(objectionMode!)) {
    console.error(`Unknown objections mode '${objectionMode}'. Available: off, shadow, deliver`);
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
    objectionMode,
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

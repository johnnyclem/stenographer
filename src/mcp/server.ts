/**
 * Stenographer — MCP Server
 * Exposes the StenographerAPI surface as MCP tools over stdio.
 * All indexing/query logic lives in the core engine (../core/stenographer.js).
 *
 * Authority model (see README "Notarization, identity and the threat model"):
 * - The server runs one tool profile. 'agent' (default) serves read tools
 *   and the drafting tools; no tool in it mints a TB without a person,
 *   signs, dismisses, overrides, strikes, or rules. 'operator' serves the
 *   judicial and destructive tools to a notary UI or CLI a person drives.
 * - In the agent profile the server binds identity: every write carries
 *   the agent identity and this server's session, never a name from the
 *   tool arguments. Operator paths take the signer's name from the caller
 *   and check it against the signer registry.
 * - Every tool's arguments are parsed with one strict zod schema before
 *   dispatch; the advertised inputSchema is derived from that schema.
 */

import { parseArgs } from 'node:util';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { Stenographer } from '../core/stenographer.js';
import {
  CONSUMPTION_RULES,
  EvidenceSchema,
  VerifyBySchema,
  StrictTombstonedLiteralSchema,
  FILED_RULING_KINDS,
} from '../truth/types.js';
import { createMcpChannelTransport, type ObjectionSinkConfig } from '../truth/delivery.js';
import type { StenographerConfig, StenographerMode } from '../types.js';

const VERSION = '0.1.0-alpha.2';

export type ToolProfile = 'agent' | 'operator';
const PROFILES: ToolProfile[] = ['agent', 'operator'];

/** Read by clients that support Claude Code channels (claude/channel). */
const CHANNEL_INSTRUCTIONS: Record<ToolProfile, string> = {
  agent:
    'Events from the stenographer channel are real-time objections: something you just asserted contradicts a ' +
    'signed tombstone (TB) in the truth ledger. Each cites the TB (the exhibit) and the transcript line. Treat the TB ' +
    'as ground truth unless the objection says it is contested: correct course before continuing, and tell the user. ' +
    'If you believe the objection is wrong or immaterial, say so to the user — a person rules on objections, not the ' +
    'session they were raised against.',
  operator:
    'Events from the stenographer channel are real-time objections: an agent asserted something that contradicts a ' +
    'signed tombstone (TB) in the truth ledger. Each cites the TB (the exhibit) and the transcript line. ' +
    'Rule on them with rule_on_objection.',
};

/** Judicial and destructive tools: only ever served in the operator profile. */
const OPERATOR_TOOLS = new Set([
  'sign_proposal',
  'dismiss_proposal',
  'override_tombstone',
  'file_ruling',
  'rule_on_objection',
  'assert_tombstone',
  'import_wiki_entries',
  'export_wiki_entries',
  'backfill_legacy_tombstones',
]);

// ─────────────────────────────────────────────────────────────
// Tool table
// ─────────────────────────────────────────────────────────────

interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  annotations: ToolAnnotations;
  run: (args: any) => Promise<unknown>;
}

/** Keeps each tool's handler typed against its own schema. */
function tool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.output<S>) => Promise<unknown>;
}): ToolSpec {
  return spec;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const APPEND: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const args = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const NO_ARGS = args({});

/** An integer limit: a default, clamped to [min, max] rather than handed to SQL as-is. */
const limit = (description: string, fallback: number, max: number, min = 1) =>
  z
    .number()
    .int()
    .describe(`${description} (clamped to ${min}–${max})`)
    .default(fallback)
    .transform((n) => Math.min(Math.max(n, min), max));

const Evidence = z
  .array(EvidenceSchema.strict())
  .min(1)
  .describe('At least one piece of evidence: {kind: commit|file|test|command|wiki|message, ref, detail?}');
const Literals = z
  .array(StrictTombstonedLiteralSchema)
  .describe(
    'Matchable dead literals the stenographer objects to — numeric constants, identifiers, config values. A bare ' +
      'value needs its subject (e.g. {subject: "LOG_BUDGET", dead: "30", current: "100"}); a distinctive identifier ' +
      'may stand alone (e.g. {dead: "legacyRateLimiter"}).'
  );
const TruthFilterArg = z
  .enum(['current', 'all', 'contested'])
  .describe('Which truth entries to include')
  .default('current');
const Id = (description: string) => z.string().min(1).describe(description);
const Text = (description: string) => z.string().min(1).describe(description);
const Signer = (description: string) =>
  z.string().min(1).describe(`${description} — checked against the signer registry when one is configured`);

const DraftEdits = z
  .object({
    claim: z.string().min(1),
    evidence: z.array(EvidenceSchema.strict()).min(1),
    literals: z.array(StrictTombstonedLiteralSchema),
    assertion: z.string().min(1),
    basis: z.string().min(1),
    verifyBy: VerifyBySchema.strict(),
    contests: z.string().min(1).nullable(),
  })
  .partial()
  .strict()
  .describe('Corrections to the draft, applied at signing time (TB: claim/evidence/literals; UV: assertion/basis/verifyBy/contests)');

const UvFields = {
  assertion: Text('The belief, in full sentences — no shorthand'),
  basis: Text('Why the author believes it'),
  verifyBy: VerifyBySchema.strict().describe('Machine-actionable verification hint: {kind: command|inspect|ask|observe, value, detail?}'),
  contests: Id('TB id this UV disputes (optional)').optional(),
};

const ResolveFields = {
  uvId: Id('The open UV to resolve'),
  resolution: z.enum(['verified', 'refuted']),
  evidence: Evidence,
  opinion: z.string().min(1).describe('Written reasoning, recorded with the resolution').optional(),
};

// ─────────────────────────────────────────────────────────────
// MCP Server Implementation
// ─────────────────────────────────────────────────────────────

export class StenographerServer {
  readonly engine: Stenographer;
  readonly profile: ToolProfile;
  private server: Server;
  private tools: Map<string, ToolSpec>;
  private toolList: Tool[];
  private boundIdentity: string | null = null;

  constructor(config: StenographerConfig) {
    const profile = config.profile ?? 'agent';
    if (!PROFILES.includes(profile)) {
      throw new Error(`Unknown profile '${profile}'. Available: ${PROFILES.join(', ')}`);
    }
    if (config.allowAgentAssert && profile !== 'agent') {
      throw new Error('--allow-agent-assert only applies to the agent profile');
    }
    this.profile = profile;
    this.engine = new Stenographer(config);

    // A misconfigured identity fails at startup, not at the first write
    if (profile === 'agent' && config.agentIdentity !== undefined) {
      try {
        this.agentIdentity();
      } catch (err) {
        this.engine.stop();
        throw err;
      }
    }

    this.server = new Server(
      { name: 'stenographer', version: VERSION },
      {
        // claude/channel: Claude Code's built-in channel protocol — lets this
        // server push objections into the attached session as they're raised
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        instructions: CHANNEL_INSTRUCTIONS[profile],
      }
    );

    const specs = [...this.readTools(), ...(profile === 'agent' ? this.agentTools() : this.operatorTools())];
    this.tools = new Map(specs.map((t) => [t.name, t]));
    this.toolList = specs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchemaOf(t.input),
      annotations: t.annotations,
    }));

    this.setupHandlers();
  }

  async start(): Promise<void> {
    await this.engine.start();
    // Serve MCP over stdio (stdout is the protocol channel — all logging
    // in this process must go to stderr)
    await this.connect(new StdioServerTransport());
  }

  /** Attaches an MCP transport (stdio in the CLI; in-memory in tests). */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);

    // Objections go to the attached client as channel events the moment
    // they're raised. Watch mode tails many sessions over one connection,
    // so it can't know which objections belong to this client — skip there.
    const { config } = this.engine;
    if (config.objectionMcpChannel !== false && config.mode !== 'watch') {
      this.engine.addObjectionTransport(
        createMcpChannelTransport((params) =>
          this.server.notification({ method: 'notifications/claude/channel', params })
        )
      );
    }
  }

  stop(): void {
    this.engine.stop();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.toolList }));

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
          content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    });
  }

  /** Looks the tool up in this profile, validates its arguments, dispatches. */
  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const spec = this.tools.get(name);
    if (!spec) throw new Error(this.unavailable(name));
    const parsed = spec.input.safeParse(args);
    if (!parsed.success) {
      throw new Error(`invalid arguments for ${name}: ${formatIssues(parsed.error)}`);
    }
    return spec.run(parsed.data);
  }

  private unavailable(name: string): string {
    if (this.profile === 'agent' && name === 'assert_tombstone') {
      return (
        'assert_tombstone is not available to agents: draft the tombstone with propose_tombstone and a person will ' +
        'notarize it (single-user setups can start stenographer with --allow-agent-assert)'
      );
    }
    if (this.profile === 'agent' && OPERATOR_TOOLS.has(name)) {
      return `${name} is an operator tool: it is not available in the agent profile — a person runs it from a notary UI or CLI (--profile operator)`;
    }
    if (this.profile === 'operator' && name === 'propose_tombstone') {
      return 'propose_tombstone is an agent tool; in the operator profile, assert or sign directly';
    }
    return `Unknown tool: ${name}`;
  }

  /**
   * The identity every agent-profile write is attributed to: --agent-identity,
   * or 'agent:' + the MCP client's name. Bound once; tool arguments never
   * override it. With a signer registry it must be registered as an agent.
   */
  private agentIdentity(): string {
    if (this.boundIdentity) return this.boundIdentity;
    const configured = this.engine.config.agentIdentity;
    const clientName = this.server?.getClientVersion()?.name?.trim();
    if (configured === undefined && !clientName) {
      throw new Error(
        'no agent identity: the MCP client sent no name — start stenographer with --agent-identity <id>'
      );
    }
    this.boundIdentity = this.engine.resolveIdentity(
      configured ?? `agent:${clientName}`,
      ['agent'],
      'the agent identity'
    );
    return this.boundIdentity;
  }

  /**
   * The agent session writes are attributed to, for the contempt check: this
   * server's session. Subagents sharing the connection share it, which is
   * the point — one session corroborating itself is one witness.
   */
  private agentSessionId(): string {
    return this.engine.getSessionId();
  }

  // ─────────────────────────────────────────────────────────
  // Read tools (both profiles)
  // ─────────────────────────────────────────────────────────

  private readTools(): ToolSpec[] {
    const e = this.engine;
    return [
      tool({
        name: 'get_recent_messages',
        description: 'Get the N most recent messages from the conversation',
        input: args({ n: limit('Number of messages to retrieve', 10, 500) }),
        annotations: READ_ONLY,
        run: ({ n }) => e.getRecentMessages(n),
      }),
      tool({
        name: 'get_entities',
        description: 'Get all entities extracted from the conversation',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getEntities(),
      }),
      tool({
        name: 'get_relations',
        description: 'Get all entity relations (knowledge graph edges) from the conversation',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getRelations(),
      }),
      tool({
        name: 'get_decisions',
        description: 'Get all active (non-superseded) decisions made in the conversation',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getActiveDecisions(),
      }),
      tool({
        name: 'get_decision_history',
        description:
          'Get the full decision history including superseded versions. Each superseded decision keeps its provenance and points at its successor.',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getDecisionHistory(),
      }),
      tool({
        name: 'get_decision_chain',
        description:
          'Get the supersession chain containing a decision, oldest observation first. The last entry is the current version of that decision.',
        input: args({ id: Id('Decision id anywhere in the chain') }),
        annotations: READ_ONLY,
        run: ({ id }) => e.getDecisionChain(id),
      }),
      tool({
        name: 'get_corrections',
        description: 'Get all corrections/tombstones from the conversation',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getTombstones(),
      }),
      tool({
        name: 'search_conversation',
        description:
          'Search the conversation semantically using GraphRAG - hybrid vector + graph search. ' +
          'Results include relevant truth-ledger entries (per truthFilter, default "current"). ' +
          CONSUMPTION_RULES,
        input: args({
          query: z.string().describe('Search query').default(''),
          k: limit('Number of results', 5, 50),
          graph_depth: limit('Graph traversal depth', 2, 5),
          truthFilter: TruthFilterArg,
        }),
        annotations: READ_ONLY,
        run: async ({ query, k, graph_depth, truthFilter }) => {
          const results = await e.searchGraphRAG({ query, k, graphDepth: graph_depth });
          const truth = await e.searchTruth(query, k, truthFilter);
          return { query, results, truth, stats: e.retriever.getStats() };
        },
      }),
      tool({
        name: 'search_similar',
        description: 'Pure vector similarity search over indexed messages (persistent index)',
        input: args({ query: z.string().describe('Search query').default(''), k: limit('Number of results', 5, 50) }),
        annotations: READ_ONLY,
        run: ({ query, k }) => e.searchSimilar(query, k),
      }),
      tool({
        name: 'get_context_frame',
        description: 'Build a context frame within a token budget for the next LLM call',
        input: args({ budget: limit('Token budget', 2000, 100_000) }),
        annotations: READ_ONLY,
        run: ({ budget }) => e.buildContextFrame(budget),
      }),
      tool({
        name: 'get_status',
        description: 'Get stenographer status and statistics, including this server\'s profile and the identity its writes are attributed to',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: async () => ({
          ...(await e.getStatus()),
          truth: await e.getTruthStats(),
          truthMode: e.getTruthMode(),
          objections: await e.getObjectionStats(),
          retriever: e.retriever.getStats(),
          vectorBackend: e.store.vectorSearchBackend,
          sessionId: e.getSessionId(),
          mode: e.config.mode,
          profile: this.profile,
          ...(this.profile === 'agent'
            ? { agentIdentity: this.tryAgentIdentity(), allowAgentAssert: Boolean(e.config.allowAgentAssert) }
            : {}),
          restPort: e.restPort,
          version: VERSION,
        }),
      }),
      // ── TB/UV v2: asserted truth layer ──────────────────
      tool({
        name: 'list_proposals',
        description:
          'The review inbox: machine- and agent-drafted PROPOSAL entries awaiting a person\'s sign/dismiss. ' +
          'A proposal that nobody signs is just a proposal, forever — it never becomes truth on its own.',
        input: args({
          status: z.enum(['open', 'signed', 'dismissed']).describe('Filter by status').optional(),
          kind: z.enum(['tombstone', 'uv']).describe('Filter by proposed record kind').optional(),
        }),
        annotations: READ_ONLY,
        run: ({ status, kind }) => e.listProposals(status, kind),
      }),
      tool({
        name: 'get_verification_queue',
        description:
          'Open UVs ranked for opportunistic verification: contested pairs first, then relevance to your ' +
          'stated working context, then age. ask-shaped UVs are deprioritized for agents. If your current ' +
          'task would settle one cheaply, resolve it via resolve_uv. ' + CONSUMPTION_RULES,
        input: args({
          context: z.string().describe('Files/entities you are touching, for relevance ranking').optional(),
          k: limit('Number of UVs', 10, 100),
        }),
        annotations: READ_ONLY,
        run: ({ context, k }) => e.getVerificationQueue(context, k),
      }),
      tool({
        name: 'get_contested',
        description:
          'All TB+UV disputes: contested TBs paired with their live contesting UVs. Contested is information, ' +
          'not noise — "we proved X, but someone credible believes not-X". ' + CONSUMPTION_RULES,
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getContestedTruth(),
      }),
      tool({
        name: 'get_truth',
        description:
          'Truth-ledger entries by filter (default "current": active/contested TBs and open UVs; struck and ' +
          'overridden entries excluded). ' + CONSUMPTION_RULES,
        input: args({ truthFilter: TruthFilterArg }),
        annotations: READ_ONLY,
        run: ({ truthFilter }) => e.getTruth(truthFilter),
      }),
      tool({
        name: 'search_truth',
        description:
          'Truth-ledger entries ranked by embedding relevance to a query. Ties break toward the TB. ' +
          CONSUMPTION_RULES,
        input: args({ query: Text('Search query'), k: limit('Number of results', 5, 50), truthFilter: TruthFilterArg }),
        annotations: READ_ONLY,
        run: ({ query, k, truthFilter }) => e.searchTruth(query, k, truthFilter),
      }),
      // ── Real-time objections (§12) ──────────────────────
      tool({
        name: 'list_objections',
        description:
          'Real-time objections: assistant output that asserted a tombstoned literal, each with the objection, ' +
          'the exhibit (the full TB record) and the transcript line. An objection is a warning with a citation ' +
          'attached — whoever is in the session decides what to do with it; a person rules on it ' +
          '(rule_on_objection, operator profile). includeShadow adds shadow-mode objections (recorded, never ' +
          'delivered) for shadow judging.',
        input: args({
          since: z.string().describe('Exclusive objection-id cursor').optional(),
          status: z.enum(['pending', 'sustained', 'overruled']).optional(),
          includeShadow: z.boolean().default(false),
          limit: limit('Maximum objections', 100, 1000),
        }),
        annotations: READ_ONLY,
        run: ({ since, status, includeShadow, limit }) => e.getObjections({ since, status, includeShadow, limit }),
      }),
    ];
  }

  private tryAgentIdentity(): string | null {
    try {
      return this.agentIdentity();
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Agent profile: drafting, never judging
  // ─────────────────────────────────────────────────────────

  private agentTools(): ToolSpec[] {
    const e = this.engine;
    const allowAssert = Boolean(e.config.allowAgentAssert);
    const bound = 'Attributed to this server\'s agent identity and session — arguments cannot name anyone.';

    const tools: ToolSpec[] = [
      tool({
        name: 'propose_tombstone',
        description:
          'Draft a tombstone for a person to notarize. Use this when you have found that a prior statement, decision ' +
          'or value is provably dead: you gather the evidence and name the literals, a person approves. The draft is ' +
          'raised to them immediately and is NOT truth until they sign it — you cannot sign or notarize it yourself, ' +
          'and neither can any other agent. targetRef dedupes only against your own open drafts (reported as ' +
          `dedupedInto). ${bound} Tell the user you have raised it and what it would object to.`,
        input: args({
          claim: Text('What is dead and what replaces it (if anything)'),
          evidence: Evidence,
          literals: Literals.optional(),
          rationale: z.string().min(1).describe('Why you believe it — shown to the person approving').optional(),
          targetRef: z
            .string()
            .min(1)
            .describe('Dedupe key: your own open draft for the same target is returned instead of a new one')
            .optional(),
        }),
        annotations: { ...APPEND, openWorldHint: true },
        run: async (a) => {
          const result = await e.draftTombstone({
            ...a,
            proposedBy: this.agentIdentity(),
            agentSessionId: this.agentSessionId(),
          });
          return {
            proposal: result.proposal,
            status: result.dedupedInto
              ? `deduped into your open draft ${result.dedupedInto} for ${a.targetRef} — it is unchanged and still ` +
                'awaiting notarization; not truth until a person signs it'
              : 'awaiting notarization — not truth until a person signs it',
            ...(result.dedupedInto ? { dedupedInto: result.dedupedInto } : {}),
            raisedTo: result.raisedTo,
            undelivered: result.undelivered,
          };
        },
      }),
      tool({
        name: 'assert_uv',
        description:
          'Assert a UV — an unverified assertion ("there be dragons"): believed true, stated before verification exists. ' +
          'Written in full sentences with a machine-actionable verifyBy hint. ' +
          `Set contests to a TB id to dispute it: the TB becomes contested but remains active truth. ${bound}`,
        input: args(UvFields),
        annotations: APPEND,
        run: (a) => e.assertUv({ ...a, author: this.agentIdentity(), agentSessionId: this.agentSessionId() }),
      }),
      tool({
        name: 'resolve_uv',
        description:
          'Resolve an open UV as verified or refuted, filing an evidence-bearing ADDENDUM. You must be ' +
          'provenance-independent of the UV: not its author, not the same session (contempt of corpus). A refuted ' +
          'contest restores its TB to active. ' +
          (allowAssert
            ? 'A verified contest overrides its TB and mints a successor: command evidence self-signs it under this ' +
              'server\'s agent identity (mintTombstone supplies the claim for other mints); non-command evidence needs a ' +
              'person\'s signature and is refused here. '
            : 'Resolutions that would mint a TB — verifying a UV that contests a TB, which overrides it — are refused: ' +
              'they need a person. Leave the UV open with your findings, or draft the successor with propose_tombstone. ') +
          bound,
        input: allowAssert
          ? args({
              ...ResolveFields,
              mintTombstone: z
                .string()
                .min(1)
                .describe('Claim text to mint a TB from this resolution (e.g. when a refuted UV propagated)')
                .optional(),
            })
          : args(ResolveFields),
        annotations: APPEND,
        run: (a: { uvId: string; resolution: 'verified' | 'refuted'; evidence: z.infer<typeof Evidence>; opinion?: string; mintTombstone?: string }) =>
          e.resolveUv(a.uvId, a.resolution, a.evidence, {
            author: this.agentIdentity(),
            opinion: a.opinion,
            mintTombstone: a.mintTombstone,
            agentSessionId: this.agentSessionId(),
            allowMint: allowAssert,
          }),
      }),
    ];

    if (allowAssert) {
      tools.push(
        tool({
          name: 'assert_tombstone',
          description:
            'Directly assert a TB, signed by this server\'s agent identity (never a person\'s name). Enabled only by ' +
            '--allow-agent-assert, for single-user setups; otherwise agents draft with propose_tombstone. ' +
            'A TB claims a prior statement/decision is provably stale or wrong; at least one piece of evidence is required.',
          input: args({
            claim: Text('What is dead and what replaces it (if anything)'),
            evidence: Evidence,
            literals: Literals.optional(),
          }),
          annotations: APPEND,
          run: (a) =>
            e.assertTombstone({ ...a, signedBy: this.agentIdentity(), agentSessionId: this.agentSessionId() }),
        })
      );
    }
    return tools;
  }

  // ─────────────────────────────────────────────────────────
  // Operator profile: the notary's and judge's tools
  // ─────────────────────────────────────────────────────────

  private operatorTools(): ToolSpec[] {
    const e = this.engine;
    return [
      tool({
        name: 'sign_proposal',
        description:
          'Notarize a proposal: sign it under a person\'s identity, minting the real TB/UV with a signs-link back. ' +
          'This is the notary act — it signs agent drafts too. edits corrects the draft at signing time; the signed ' +
          'version is what is true, the draft is history. The drafter cannot sign its own draft (contempt of corpus).',
        input: args({ proposalId: Id('The open proposal'), signedBy: Signer('The person signing'), edits: DraftEdits.optional() }),
        annotations: DESTRUCTIVE,
        run: ({ proposalId, signedBy, edits }) => e.notarizeProposal(proposalId, signedBy, edits),
      }),
      tool({
        name: 'dismiss_proposal',
        description:
          'Dismiss a proposal with a required reason. Dismissal reasons are kept — they are training data for tuning the detector.',
        input: args({ proposalId: Id('The open proposal'), dismissedBy: Signer('The person dismissing'), reason: Text('Why') }),
        annotations: DESTRUCTIVE,
        run: ({ proposalId, dismissedBy, reason }) => e.dismissProposal(proposalId, dismissedBy, reason),
      }),
      tool({
        name: 'assert_tombstone',
        description:
          'Directly assert a TB (skipping the proposal path) — for people who already know. A TB claims a prior ' +
          'statement/decision is provably stale or wrong; at least one piece of evidence is required.',
        input: args({
          claim: Text('What is dead and what replaces it (if anything)'),
          evidence: Evidence,
          signedBy: Signer('The person asserting it'),
          literals: Literals.optional(),
          author: Signer('Drafting author when distinct from signedBy (a person or an agent identity)').optional(),
        }),
        annotations: APPEND,
        run: (a) =>
          e.assertTombstone({ ...a, signedBy: e.resolveIdentity(a.signedBy, ['human'], 'signer') }),
      }),
      tool({
        name: 'assert_uv',
        description:
          'Assert a UV — an unverified assertion ("there be dragons"): believed true, stated before verification exists. ' +
          'Written in full sentences with a machine-actionable verifyBy hint. ' +
          'Set contests to a TB id to dispute it: the TB becomes contested but remains active truth.',
        input: args({ ...UvFields, author: Signer('Who believes it') }),
        annotations: APPEND,
        run: (a) => e.assertUv(a),
      }),
      tool({
        name: 'resolve_uv',
        description:
          'Resolve an open UV as verified or refuted, filing an evidence-bearing ADDENDUM. ' +
          'command evidence is self-signing (reproducible by anyone); any resolution that mints a TB from ' +
          'other evidence requires a person\'s signedBy and files a promotion RULING. ' +
          'Resolver and signer must be provenance-independent of the UV author (contempt of corpus). ' +
          'A verified contesting UV overrides its TB; a refuted one restores the TB to active.',
        input: args({
          ...ResolveFields,
          author: Signer('The resolving identity'),
          signedBy: Signer('The person signing, required when non-command evidence mints a TB').optional(),
          mintTombstone: z
            .string()
            .min(1)
            .describe('Claim text to mint a TB from this resolution (e.g. when a refuted UV propagated)')
            .optional(),
        }),
        annotations: DESTRUCTIVE,
        run: (a) =>
          e.resolveUv(a.uvId, a.resolution, a.evidence, {
            author: a.author,
            signedBy: a.signedBy,
            opinion: a.opinion,
            mintTombstone: a.mintTombstone,
          }),
      }),
      tool({
        name: 'override_tombstone',
        description:
          'The force path: override an active TB with a proven ADDENDUM. Fails without evidence — ' +
          'like force-pushing a protected branch: possible, deliberate, and logged. ' +
          '(The other legal path is assert_uv with contests, which marks the TB contested without flipping it.)',
        input: args({
          tbId: Id('The TB to override'),
          evidence: Evidence,
          note: z.string().min(1).optional(),
          author: Signer('The person overriding it'),
        }),
        annotations: DESTRUCTIVE,
        run: ({ tbId, evidence, note, author }) => e.overrideTombstone(tbId, { evidence, note }, { author }),
      }),
      tool({
        name: 'file_ruling',
        description:
          'File a signed RULING with a required written opinion (rulings are retrievable precedent). ' +
          'strike: declares an entry inadmissible for retrieval (kept in history, excluded from current truth). ' +
          'promotion: records who ruled UV evidence sufficient and why. ' +
          'contempt: judges an author\'s conduct and mints exactly one TB about it — no reputation system.',
        input: args({
          kind: z.enum(FILED_RULING_KINDS),
          opinion: Text('Written reasoning — rulings are precedent'),
          target: Id('Entry id, or author identity for contempt'),
          author: Signer('The person ruling'),
        }),
        annotations: DESTRUCTIVE,
        run: (a) => e.fileRuling(a),
      }),
      tool({
        name: 'rule_on_objection',
        description:
          'Rule on a real-time objection, with a written opinion. sustained: the session corrects course and the ' +
          'ruling lands in the record as corroboration for the TB. overruled: the objection was wrong or ' +
          'immaterial — signal for tightening the matcher. Either way an ordinary RULING is filed; the TB\'s status ' +
          'does not change.',
        input: args({
          objectionId: Id('The pending objection'),
          outcome: z.enum(['sustained', 'overruled']),
          opinion: Text('Written reasoning'),
          author: Signer('The judge'),
        }),
        annotations: APPEND,
        run: ({ objectionId, outcome, opinion, author }) => e.ruleOnObjection(objectionId, outcome, { author, opinion }),
      }),
      tool({
        name: 'export_wiki_entries',
        description:
          'Export signed TB/UV entries as team llm-wiki append-only JSONL. Stenographer-specific fields travel ' +
          'under the x-steno key. Proposals are never exported — the wiki only ever sees signed truth.',
        input: args({
          since: z.string().describe('ISO timestamp; only entries created after it').optional(),
          path: z.string().min(1).describe('File to write/append; omit to return lines inline').optional(),
        }),
        annotations: DESTRUCTIVE,
        run: ({ since, path }) => e.exportWikiEntries({ since, path }),
      }),
      tool({
        name: 'import_wiki_entries',
        description:
          'Ingest the team llm-wiki JSONL. Wiki entries keep their original ids and authors; the wiki file stays ' +
          'authoritative for their content. A wiki entry contradicting a local one generates a reconciliation ' +
          'PROPOSAL — it does not auto-win and does not auto-lose.',
        input: args({ path: Text('The wiki JSONL file') }),
        annotations: APPEND,
        run: ({ path }) => e.importWikiEntries({ path }),
      }),
      tool({
        name: 'backfill_legacy_tombstones',
        description:
          'Phase-1 migration: backfill pre-assertion auto-closed supersessions as queryably second-class TBs ' +
          '(author "migration", signedBy null). Idempotent; no history is rewritten.',
        input: NO_ARGS,
        annotations: { ...APPEND, idempotentHint: true },
        run: async () => ({ backfilled: await e.backfillLegacyTombstones() }),
      }),
    ];
  }
}

/** JSON Schema for a tool's arguments, derived from the same zod schema that parses them. */
function inputSchemaOf(schema: z.ZodTypeAny): Tool['inputSchema'] {
  const { $schema: _drop, ...json } = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  return json as Tool['inputSchema'];
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return formatIssues(error);
  return error instanceof Error ? error.message : String(error);
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
      'objection-channel': { type: 'string', multiple: true },
      'objection-webhook': { type: 'string', multiple: true },
      'objection-batch-size': { type: 'string' },
      'no-mcp-channel': { type: 'boolean' },
      profile: { type: 'string' },
      'agent-identity': { type: 'string' },
      'allow-agent-assert': { type: 'boolean' },
      'signer-registry': { type: 'string' },
      // Accepted for 0.x configs: notarization is now the agent-profile default
      'require-notary': { type: 'boolean' },
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

  const profile = ((values.profile as string | undefined) ?? 'agent') as ToolProfile;
  if (!PROFILES.includes(profile)) {
    console.error(`Unknown profile '${profile}'. Available: ${PROFILES.join(', ')}`);
    process.exit(1);
  }
  if (values['allow-agent-assert'] && profile !== 'agent') {
    console.error('--allow-agent-assert only applies to the agent profile');
    process.exit(1);
  }
  if (values['require-notary'] && values['allow-agent-assert']) {
    console.error('--require-notary and --allow-agent-assert contradict each other');
    process.exit(1);
  }
  if (values['require-notary']) {
    console.error('ℹ️  --require-notary is now the default for the agent profile; the flag is no longer needed');
  }

  // Webhook receivers (§14.8). Secrets come from the environment so they
  // don't land in shell history or process listings.
  const batchSize = values['objection-batch-size']
    ? Number.parseInt(values['objection-batch-size'] as string, 10)
    : undefined;
  const objectionSinks: ObjectionSinkConfig[] = [
    ...((values['objection-channel'] as string[] | undefined) ?? []).map((url) => ({
      kind: 'channel' as const,
      url,
      secret: process.env.SMALLCHAT_CHANNEL_SECRET,
    })),
    ...((values['objection-webhook'] as string[] | undefined) ?? []).map((url) => ({
      kind: 'webhook' as const,
      url,
      secret: process.env.STENOGRAPHER_WEBHOOK_SECRET,
      batchSize,
    })),
  ];

  const config: StenographerConfig = {
    logPath,
    statePath,
    mode,
    adapter: values.adapter as StenographerConfig['adapter'],
    embeddingModel: values.embeddings,
    restPort: values['rest-port'] ? Number.parseInt(values['rest-port'], 10) : undefined,
    restHost: values['rest-host'] as string | undefined,
    objectionMode,
    objectionSinks,
    objectionMcpChannel: !values['no-mcp-channel'],
    notarySecret: process.env.STENOGRAPHER_NOTARY_SECRET || undefined,
    profile,
    agentIdentity: values['agent-identity'] as string | undefined,
    allowAgentAssert: Boolean(values['allow-agent-assert']),
    signerRegistry: values['signer-registry'] as string | undefined,
  };

  // Log to stderr — stdout carries the MCP stdio protocol
  console.error(`🤖 Starting Stenographer v${VERSION}`);
  console.error(`📄 ${mode === 'watch' ? 'Watching directory' : 'Watching'}: ${logPath}`);
  console.error(`💾 State: ${statePath}`);
  console.error(`🎛  Mode: ${mode}${config.adapter ? `, adapter: ${config.adapter}` : ' (adapter auto-detect)'}`);
  console.error(
    `🔏 Profile: ${profile}` +
      (profile === 'agent'
        ? config.allowAgentAssert
          ? ' — agents may assert TBs under their own identity (--allow-agent-assert)'
          : ' — agents draft, a person notarizes'
        : ' — judicial tools exposed; for a notary UI or CLI, never an agent')
  );

  let server: StenographerServer;
  try {
    server = new StenographerServer(config);
  } catch (err) {
    // Configuration errors (identity, registry) — no stack trace needed
    console.error(`❌ ${errorMessage(err)}`);
    process.exit(1);
  }
  await server.start();

  console.error('✅ Stenographer is running. Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    console.error('\n👋 Shutting down...');
    server.stop();
    process.exit(0);
  });
}

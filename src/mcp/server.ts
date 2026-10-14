/**
 * Stenographer — MCP Server
 * Exposes the StenographerAPI surface as MCP tools over stdio.
 * All indexing/query logic lives in the core engine (../core/stenographer.js).
 *
 * Authority model (see README "Notarization, identity and the threat model"):
 * - The server runs one tool profile. 'agent' (default) serves read tools,
 *   drafting, attesting and approving: an agent's claim is a UV until a
 *   person approves it and one other approver agrees (truth/approvals.ts);
 *   three agent sessions agreeing nominate it for review and settle
 *   nothing. No tool in it signs with a person's name, dismisses,
 *   overrides, strikes, or rules. 'operator' serves the judicial and
 *   destructive tools to a notary UI or CLI a person drives.
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
import { ALLOW_AGENT_ASSERT_REMOVED, Stenographer } from '../core/stenographer.js';
import type { TombstoneQuorumProgress } from '../truth/attestations.js';
import {
  CONSUMPTION_RULES,
  PremiseSchema,
  MAX_PREMISES,
  EvidenceSchema,
  VerifyBySchema,
  StrictTombstonedLiteralSchema,
  DraftEditsSchema,
  FILED_RULING_KINDS,
} from '../truth/types.js';
import { createMcpChannelTransport, type ObjectionSinkConfig } from '../truth/delivery.js';
import { startupLedgerCheck } from '../truth/verify-cli.js';
import type { StenographerConfig, StenographerMode } from '../types.js';

const VERSION = '1.1.0';

export type ToolProfile = 'agent' | 'operator';
const PROFILES: ToolProfile[] = ['agent', 'operator'];

/** What an agent is told at initialize: its standing in the truth ledger. */
export const AGENT_STANDING =
  'Your confidence is not evidence and settles nothing. Your claim is a UV until a person approves it: a UV becomes ' +
  'a TB when a person approves it and one other approver agrees (an agent session with its own settling evidence, ' +
  'or stenographer citing the record). Three agent sessions agreeing from different angles nominate a UV for the ' +
  'person\'s review; it stays a UV until then. Agents never promote, override or strike a tombstone.';

/** @deprecated Since 1.1 agents settle nothing whatever the setting: the standing is AGENT_STANDING. */
export const AGENT_STANDING_QUORUM_OFF = AGENT_STANDING;

const AGENT_CHANNEL_EVENTS =
  ' Events from the stenographer channel are real-time objections: something you just asserted contradicts a ' +
    'signed tombstone (TB) in the truth ledger. Each cites the TB (the exhibit) and the transcript line. Treat the TB ' +
    'as ground truth unless the objection says it is contested: correct course before continuing, and tell the user. ' +
    'If you believe the objection is wrong or immaterial, say so to the user — a person rules on objections, not the ' +
    'session they were raised against.';

/** Read by MCP clients at initialize; clients that support Claude Code channels (claude/channel) read the events part too. */
const CHANNEL_INSTRUCTIONS: Record<ToolProfile, string> = {
  agent: AGENT_STANDING + AGENT_CHANNEL_EVENTS,
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

/** Upper bounds for list sizes (the REST API clamps to the same): larger requests are clamped, not refused. */
const MAX_K = 200;
const MAX_MESSAGES = 1000;
const MAX_DEPTH = 5;

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
  .describe(
    'At least one piece of evidence: {kind: commit|file|test|command|wiki|message|chat|ticket|doc, ref, detail?}. ' +
      'wiki is a truth-ledger entry id; chat a chat message or thread (Slack, Teams, Discord); ticket an issue or ' +
      'ticket (Jira, Linear, GitHub issues); doc a document or page outside the truth ledger (design doc, team wiki ' +
      'page, README). Command output you report is recorded as kind claimed-command: stenographer did not run it, so ' +
      'it never signs for itself.'
  );
const Literals = z
  .array(StrictTombstonedLiteralSchema)
  .describe(
    'Matchable dead literals the stenographer objects to — numeric constants, identifiers, config values. A bare ' +
      'value needs its subject (e.g. {subject: "LOG_BUDGET", dead: "30", current: "100"}); a distinctive identifier ' +
      'may stand alone (e.g. {dead: "legacyRateLimiter"}).'
  );
const Premises = z
  .array(PremiseSchema.strict())
  .min(1)
  .max(MAX_PREMISES)
  .describe(
    'The entries this one is derived from, each pinned by the contentHash get_truth and search_truth return for it ' +
      `(1–${MAX_PREMISES}). The ledger refuses a premise it does not hold, one whose content changed, or a dead one ` +
      '(overridden, refuted, struck, or unsupported); an open UV or a TB under appeal is allowed, and the entry starts ' +
      'clouded. Comes with inference.'
  );
const Inference = z
  .string()
  .min(1)
  .describe('One sentence stating the inference from the premises to this claim. Required with premises, refused without.');
const DerivationFields = { premises: Premises.optional(), inference: Inference.optional() };
const TruthFilterArg = z
  .enum(['current', 'all', 'contested'])
  .describe('Which truth entries to include')
  .default('current');
const Id = (description: string) => z.string().min(1).describe(description);
const Text = (description: string) => z.string().min(1).describe(description);
const WikiFile = z
  .string()
  .min(1)
  .describe(
    'A .jsonl file in the wiki directory (--wiki-dir), named relative to it. Absolute paths, "..", symlinks out ' +
      'of the directory and the state file are refused.'
  );
const Signer = (description: string) =>
  z.string().min(1).describe(`${description} — checked against the signer registry when one is configured`);

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

/**
 * What propose_tombstone says of a draft: already truth (a TB holds every
 * literal), nominated (three agent sessions drafted the same literals from
 * different angles), or awaiting a person, and what keeps this draft out
 * of any nomination.
 */
function draftStatus(result: { dedupedInto?: string; quorum?: TombstoneQuorumProgress }, targetRef?: string): string {
  const quorum = result.quorum;
  if (quorum?.heldBy) {
    return (
      `already truth: TB ${quorum.heldBy} holds every literal this draft names, so nothing is minted; the draft stays ` +
      'open for a person, who may dismiss it'
    );
  }
  const until = 'not truth until a person signs it in review: no number of agent sessions mints a TB';
  const waiting = result.dedupedInto
    ? `deduped into your open draft ${result.dedupedInto} for ${targetRef} — it is unchanged and still awaiting ` +
      `notarization; ${until}`
    : `awaiting notarization — ${until}`;
  if (quorum?.nominated) return `nominated: three or more agent sessions drafted these literals from different angles, so it goes first on the docket; ${waiting}`;
  const lacks = [
    ...(quorum?.missing.includes('literals') ? ['names no literals'] : []),
    ...(quorum?.missing.includes('a settling evidence item')
      ? ['cites no settling evidence (commit, file, test, claimed-command or wiki)']
      : []),
  ];
  return lacks.length > 0 ? `${waiting}. This draft can't count toward a nomination: it ${lacks.join(' and ')}` : waiting;
}

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
  private boundSession: string | null = null;

  constructor(config: StenographerConfig) {
    const profile = config.profile ?? 'agent';
    if (!PROFILES.includes(profile)) {
      throw new Error(`Unknown profile '${profile}'. Available: ${PROFILES.join(', ')}`);
    }
    this.profile = profile;
    // Refuses a config that still asks for agents to assert alone (allowAgentAssert)
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
        instructions:
          CHANNEL_INSTRUCTIONS[profile],
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
    // Otherwise only this server's own sessions' transcript objections go
    // to it: other sessions write objections to the same state file, and a
    // gate objection's deny reason was already shown by the harness.
    const { config } = this.engine;
    if (config.objectionMcpChannel !== false && config.mode !== 'watch') {
      this.engine.addObjectionTransport(
        createMcpChannelTransport(
          (params) => this.server.notification({ method: 'notifications/claude/channel', params }),
          (objection) => !objection.gate && this.engine.carriesSession(objection.sessionId)
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
        'assert_tombstone is not available to agents: draft the tombstone with propose_tombstone. It becomes truth ' +
        'when a person signs it in review; three agent sessions drafting the same literals from different angles ' +
        'nominate it, and no number of agent sessions mints a TB'
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
   * The agent session writes are attributed to, for the contempt check and
   * the agent quorum: this server's session when the connection first
   * wrote, bound like the identity. Subagents sharing the connection share
   * it, which is the point — one session corroborating itself is one
   * witness — and so does every later write on it, whatever session the log
   * the server follows names by then (a resumed transcript, a log that
   * aggregates sessions): one connection is never a second witness.
   */
  private agentSessionId(): string {
    this.boundSession ??= this.engine.getSessionId();
    return this.boundSession;
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
        input: args({ n: limit('Number of messages to retrieve', 10, MAX_MESSAGES) }),
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
          'Search the conversation with GraphRAG: messages ranked by reciprocal rank fusion of vector ' +
          'similarity, entity-graph evidence, recency and importance (the evidence is in each result\'s meta). ' +
          'Results include relevant truth-ledger entries (per truthFilter, default "current"). ' +
          CONSUMPTION_RULES,
        input: args({
          query: z.string().describe('Search query').default(''),
          k: limit('Number of results', 5, MAX_K),
          graph_depth: limit('Graph traversal depth', 2, MAX_DEPTH, 0),
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
        input: args({ query: z.string().describe('Search query').default(''), k: limit('Number of results', 5, MAX_K) }),
        annotations: READ_ONLY,
        run: ({ query, k }) => e.searchSimilar(query, k),
      }),
      tool({
        name: 'get_context_frame',
        description:
          'Build a context frame for the next LLM call: entities, active decisions and recent messages, ' +
          'all within the token budget (estimated at 4 characters per token)',
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
          embedder: e.embedderIdentity,
          sessionId: e.getSessionId(),
          mode: e.config.mode,
          profile: this.profile,
          ...(this.profile === 'agent' ? { agentIdentity: this.tryAgentIdentity() } : {}),
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
          'Open UVs ranked for opportunistic verification: suspect premises of a refuted entry first, then contested ' +
          'pairs, then relevance to your stated working context, then age. ask-shaped UVs are deprioritized for ' +
          'agents. If your current task can check one, approve it with your evidence (approve) or file a refuting ' +
          'verdict (resolve_uv). ' + CONSUMPTION_RULES,
        input: args({
          context: z.string().describe('Files/entities you are touching, for relevance ranking').optional(),
          k: limit('Number of UVs', 10, 100),
        }),
        annotations: READ_ONLY,
        run: ({ context, k }) => e.getVerificationQueue(context, k),
      }),
      tool({
        name: 'get_docket',
        description:
          'The review docket: everything that waits on a person, grouped by subject. Open UVs (the ones agents ' +
          'nominated first), TBs under appeal (as their contesting UVs), the suspicion detector\'s derivation ' +
          'reviews, and agents\' tombstone drafts, each with its evidence, approvals, derivation tree and the ' +
          'passages of the record found for it. A person rules on it with stenographer review or the operator ' +
          'profile\'s approve, resolve_uv, file_ruling and dismiss_proposal.',
        input: NO_ARGS,
        annotations: READ_ONLY,
        run: () => e.getDocket(),
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
        name: 'get_derivation',
        description:
          'The derivation tree of a truth entry: what it rests on (direction "down", the default: its pinned premises and ' +
          'the entries its evidence cites, all the way down) or what rests on it ("up"). Each node carries its status, ' +
          'standing, signer and answerable person, and a failing premise is marked (failing: premise-struck, ' +
          'premise-overridden, premise-refuted, premise-open, premise-under-appeal or premise-missing). This is the answer ' +
          'to "why is this clouded or unsupported": the exact premise that failed and who signed it. Null for an id the ' +
          'ledger does not hold.',
        input: args({ id: Id('The entry id'), direction: z.enum(['down', 'up']).describe('Premises below it, or entries above it').default('down') }),
        annotations: READ_ONLY,
        run: ({ id, direction }) => e.getDerivation(id, direction),
      }),
      tool({
        name: 'get_truth',
        description:
          'Truth-ledger entries by filter (default "current": active/contested TBs and open UVs; struck, ' +
          'overridden and unsupported entries excluded). Every entry carries its standing (sound, clouded or ' +
          'unsupported: what happened to the premises below it) with reasons naming the weak premise, and the ' +
          'contentHash to pin it by as a premise. ' + CONSUMPTION_RULES,
        input: args({ truthFilter: TruthFilterArg }),
        annotations: READ_ONLY,
        run: ({ truthFilter }) => e.getTruth(truthFilter),
      }),
      tool({
        name: 'search_truth',
        description:
          'Truth-ledger entries ranked by embedding relevance to a query. Ties break toward the TB. Each carries its ' +
          'standing and the contentHash to pin it by as a premise. ' + CONSUMPTION_RULES,
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
    const bound = 'Attributed to this server\'s agent identity and session — arguments cannot name anyone.';
    const draftSettles =
      'It becomes truth only when a person signs it in review: no number of agent sessions mints a TB. When three ' +
      'or more agent sessions draft the same set of literals from different angles (each citing settling evidence ' +
      'of its own — commit, file, test, claimed-command or wiki; no item another draft cites; two settling kinds ' +
      'between them), the drafts are nominated and go first on the docket (status "nominated"). When an active or ' +
      'contested TB already holds every literal, the claim is already truth and nothing is minted (status "already ' +
      'truth").';
    const approvalSettles =
      'A UV becomes a TB when a person approves it and one other approver agrees: this session (with its own ' +
      'settling evidence — commit, file, test, claimed-command or wiki; not message, chat, ticket or doc) or ' +
      'stenographer citing the record. Three agent sessions approving from different angles nominate it for the ' +
      'person\'s review (status "nominated"); it stays a UV until then. Your approval alone promotes nothing ' +
      '(status "approved", with what promotion still needs). One session is one approver, and you cannot approve ' +
      'what you or your session asserted (contempt of corpus).';

    return [
      tool({
        name: 'propose_tombstone',
        description:
          'Draft a tombstone. Use this when you have found that a prior statement, decision or value is provably ' +
          'dead: you gather the evidence and name the literals. The draft is raised to a person immediately and is ' +
          'NOT truth on your word: you cannot sign or notarize it. ' +
          draftSettles +
          ' targetRef dedupes only against your own open drafts (reported ' +
          `as dedupedInto). ${bound} Tell the user what you have raised and what it would object to.`,
        input: args({
          claim: Text('What is dead and what replaces it (if anything)'),
          evidence: Evidence,
          literals: Literals.optional(),
          ...DerivationFields,
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
            status: draftStatus(result, a.targetRef),
            ...(result.dedupedInto ? { dedupedInto: result.dedupedInto } : {}),
            raisedTo: result.raisedTo,
            undelivered: result.undelivered,
            ...(result.quorum ? { quorum: result.quorum } : {}),
          };
        },
      }),
      tool({
        name: 'assert_uv',
        description:
          'Assert a UV — an unverified assertion ("there be dragons"): believed true, stated before verification exists. ' +
          'Written in full sentences with a machine-actionable verifyBy hint. ' +
          `Set contests to a TB id to dispute it: the TB goes under appeal but remains active truth. ${bound}`,
        input: args({ ...UvFields, ...DerivationFields }),
        annotations: APPEND,
        run: (a) => e.assertUv({ ...a, author: this.agentIdentity(), agentSessionId: this.agentSessionId() }),
      }),
      tool({
        name: 'approve',
        description:
          'Approve an open UV with the evidence you checked: this session\'s approval. ' +
          approvalSettles +
          ` A UV that contests a TB is an appeal: a person's approval of it overrides the TB, yours nominates. ${bound}`,
        input: args({
          uvId: Id('The open UV to approve'),
          evidence: Evidence,
          note: z.string().min(1).describe('What you checked, in a sentence').optional(),
        }),
        annotations: APPEND,
        run: (a) =>
          e.approveUv({ uvId: a.uvId, role: 'agent', by: this.agentIdentity(), agentSessionId: this.agentSessionId(), evidence: a.evidence, note: a.note }),
      }),
      tool({
        name: 'resolve_uv',
        description:
          'File your verdict on an open UV — verified or refuted — with the evidence you checked. On its own it ' +
          'settles nothing. A verified verdict is this session\'s approval (the same as approve): ' +
          approvalSettles +
          ' A refuted verdict is recorded as your attestation for the docket (status "attested"); when other ' +
          'sessions refute it too from different angles the agreement is shown there (status "agreed"), and a ' +
          'person rules. A verdict the other way within 15 minutes is a dispute (status "disputed"), raised to a ' +
          `person. You must be provenance-independent of the UV: not its author, not the same session. ${bound}`,
        input: args(ResolveFields),
        annotations: APPEND,
        run: (a) =>
          e.attestUv(a.uvId, a.resolution, a.evidence, {
            author: this.agentIdentity(),
            opinion: a.opinion,
            agentSessionId: this.agentSessionId(),
          }),
      }),
    ];
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
        input: args({ proposalId: Id('The open proposal'), signedBy: Signer('The person signing'), edits: DraftEditsSchema.optional() }),
        annotations: DESTRUCTIVE,
        run: ({ proposalId, signedBy, edits }) => e.notarizeProposal(proposalId, signedBy, edits),
      }),
      tool({
        name: 'approve',
        description:
          'A person\'s approval of an open UV (or stenographer\'s, as the reporter). Promotion takes two approvals, one ' +
          'of them a person\'s: with a second approver (an agent session, or the reporter citing the record) the UV ' +
          'becomes a TB signed by the person, who becomes answerable for it (answerableBy). A person\'s approval of ' +
          'a UV that contests a TB overrides the TB. role reporter records stenographer\'s own approval, which must ' +
          'cite indexed message ids (cites) and never counts as the person. Nobody approves what they drafted.',
        input: args({
          uvId: Id('The open UV'),
          by: Signer('The person approving').optional(),
          role: z.enum(['human', 'reporter']).describe('human (default): the person named by `by`; reporter: stenographer, citing the record').default('human'),
          evidence: Evidence.optional(),
          cites: z.array(z.string().min(1)).min(1).describe('role reporter: ids of the indexed messages that support the claim').optional(),
          note: z.string().min(1).optional(),
        }),
        annotations: DESTRUCTIVE,
        run: ({ uvId, by, role, evidence, cites, note }) => e.approveUv({ uvId, role, by, evidence, cites, note }),
      }),
      tool({
        name: 'dismiss_proposal',
        description:
          'Dismiss a proposal with a required reason. Dismissal reasons are kept — they are training data for tuning ' +
          'the detector. Dismissing every derivation review of one refuted entry with reason inference-at-fault closes that review.',
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
          ...DerivationFields,
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
        input: args({ ...UvFields, ...DerivationFields, author: Signer('Who believes it') }),
        annotations: APPEND,
        run: (a) => e.assertUv(a),
      }),
      tool({
        name: 'resolve_uv',
        description:
          'Resolve an open UV as verified or refuted, filing an evidence-bearing ADDENDUM. ' +
          'Any resolution that mints a TB requires a person\'s signedBy and files a promotion RULING: submitted ' +
          'command output is recorded as claimed-command and does not self-sign, since stenographer did not run it. ' +
          'Resolver and signer must be provenance-independent of the UV author (contempt of corpus). ' +
          'A verified contesting UV overrides its TB; a refuted one closes its contest, and the TB is active again ' +
          'unless another contest is open or it has been overridden (an override is never undone).',
        input: args({
          ...ResolveFields,
          author: Signer('The resolving identity'),
          signedBy: Signer('The person signing, required when the resolution mints a TB').optional(),
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
          'Export this ledger as team llm-wiki JSONL, truth format v2 (spec/truth-format): a hash-chained line ' +
          'stream (seq, prevHash, hash) of TB and UV lines, the addenda and rulings that change a status, and a ' +
          'TRANSITION line for every status change. Proposals are never exported. With file, appends the lines ' +
          'that file (this ledger\'s own: one writer per file) does not hold yet; it never truncates or rewrites a ' +
          'line. Without it, returns the lines after sinceSeq.',
        input: args({
          sinceSeq: z.number().int().min(0).describe('Return the lines after this seq (the lastSeq of your previous export)').optional(),
          since: z.string().describe('Deprecated: return the stream from the first line written after this ISO timestamp').optional(),
          file: WikiFile.optional(),
        }),
        annotations: { ...APPEND, idempotentHint: true },
        run: ({ sinceSeq, since, file }) => e.exportWikiEntries({ sinceSeq, since, file }),
      }),
      tool({
        name: 'import_wiki_entries',
        description:
          'Ingest a team llm-wiki JSONL file (truth format v2; v1 lines are still read) in one transaction: every ' +
          'line lands or none does, with a per-line error report, and the file\'s hash chain must hold. Entries ' +
          'keep their ids and authors. A TB lands as truth only when signed by a person and verifiable (hash-chained, ' +
          'and its signer listed in the signer registry when one is configured); a TB agents minted under the 1.0 ' +
          'quorum rule is filed as a nominated draft for the docket (agent-quorum), and any other TB that can\'t land ' +
          'becomes a reconciliation PROPOSAL (an agent\'s TB without a quorum: agent-without-quorum), as does a line ' +
          'that contradicts a local entry or whose status is unknown. An ' +
          'agent\'s resolution of a UV applies only with a valid quorum of agents, never one that verifies a ' +
          'contest; an override, strike or ruling never applies from an agent. Those are held, and reported. ' +
          'Re-importing a file changes nothing.',
        input: args({ file: WikiFile }),
        annotations: { ...APPEND, idempotentHint: true },
        run: ({ file }) => e.importWikiEntries({ file }),
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
  // Refused before anything else is read: it used to let one agent sign alone
  if (args.some((a) => a === '--allow-agent-assert' || a.startsWith('--allow-agent-assert='))) {
    console.error(`❌ ${ALLOW_AGENT_ASSERT_REMOVED}`);
    process.exit(1);
  }

  const { positionals, values } = parseArgs({
    args,
    options: {
      mode: { type: 'string', short: 'm' },
      adapter: { type: 'string', short: 'a' },
      'rest-port': { type: 'string' },
      'rest-host': { type: 'string' },
      'rest-allow-host': { type: 'string', multiple: true },
      'rest-insecure': { type: 'boolean' },
      embeddings: { type: 'string', short: 'e' },
      reembed: { type: 'boolean' },
      'supersede-threshold': { type: 'string' },
      objections: { type: 'string' },
      'objection-channel': { type: 'string', multiple: true },
      'objection-webhook': { type: 'string', multiple: true },
      'objection-batch-size': { type: 'string' },
      'no-mcp-channel': { type: 'boolean' },
      profile: { type: 'string' },
      'agent-identity': { type: 'string' },
      'signer-registry': { type: 'string' },
      'agent-quorum': { type: 'string' },
      'wiki-dir': { type: 'string' },
      // Accepted for 0.x configs: notarization is now the agent-profile default
      'require-notary': { type: 'boolean' },
      'skip-verify': { type: 'boolean' },
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
  const agentQuorum = values['agent-quorum'] as StenographerConfig['agentQuorum'];
  if (agentQuorum !== undefined && agentQuorum !== 'on' && agentQuorum !== 'off') {
    console.error(`Unknown --agent-quorum '${agentQuorum}'. Available: on, off`);
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

  const supersedeThreshold =
    values['supersede-threshold'] !== undefined ? Number(values['supersede-threshold']) : undefined;
  if (supersedeThreshold !== undefined && !(supersedeThreshold > 0 && supersedeThreshold <= 1)) {
    console.error(`--supersede-threshold must be a number in (0, 1], got '${values['supersede-threshold']}'`);
    process.exit(1);
  }

  const config: StenographerConfig = {
    logPath,
    statePath,
    mode,
    adapter: values.adapter as StenographerConfig['adapter'],
    embeddingModel: values.embeddings,
    reembed: Boolean(values.reembed),
    supersedeThreshold,
    restPort: values['rest-port'] ? Number.parseInt(values['rest-port'], 10) : undefined,
    restHost: values['rest-host'] as string | undefined,
    // Like the other secrets, the REST token comes from the environment
    restToken: process.env.STENOGRAPHER_REST_TOKEN || undefined,
    restInsecure: Boolean(values['rest-insecure']),
    restAllowedHosts: values['rest-allow-host'] as string[] | undefined,
    objectionMode,
    objectionSinks,
    objectionMcpChannel: !values['no-mcp-channel'],
    notarySecret: process.env.STENOGRAPHER_NOTARY_SECRET || undefined,
    profile,
    agentIdentity: values['agent-identity'] as string | undefined,
    signerRegistry: values['signer-registry'] as string | undefined,
    agentQuorum,
    wikiDir: values['wiki-dir'] as string | undefined,
  };

  // Log to stderr — stdout carries the MCP stdio protocol
  console.error(`🤖 Starting Stenographer v${VERSION}`);
  console.error(`📄 ${mode === 'watch' ? 'Watching directory' : 'Watching'}: ${logPath}`);
  console.error(`💾 State: ${statePath}`);
  console.error(`🎛  Mode: ${mode}${config.adapter ? `, adapter: ${config.adapter}` : ' (adapter auto-detect)'}`);
  console.error(
    `🔏 Profile: ${profile}` +
      (profile === 'agent'
        ? ' — agents draft and attest; a person notarizes, or two or more agent sessions agree'
        : ' — judicial tools exposed; for a notary UI or CLI, never an agent')
  );

  // A ledger that fails its integrity check is not served as ground truth
  // unless the operator says so
  const ledgerCheck = startupLedgerCheck(statePath, { skipVerify: Boolean(values['skip-verify']) });
  for (const line of ledgerCheck.lines) console.error(line);
  if (ledgerCheck.refuse) process.exit(1);

  let server: StenographerServer;
  try {
    server = new StenographerServer(config);
  } catch (err) {
    // Configuration errors (identity, registry) — no stack trace needed
    console.error(`❌ ${errorMessage(err)}`);
    process.exit(1);
  }
  console.error(
    server.engine.agentQuorum() === 'off'
      ? '🗳  Agent quorum: off — nothing an agent files settles; only a person signs or resolves'
      : '🗳  Agent quorum: on — two or more agent sessions agreeing from different angles within 15 minutes settle'
  );
  await server.start();

  console.error('✅ Stenographer is running. Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    console.error('\n👋 Shutting down...');
    server.stop();
    process.exit(0);
  });
}

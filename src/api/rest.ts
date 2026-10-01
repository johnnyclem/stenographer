/**
 * Stenographer — REST API
 * Thin HTTP layer over the StenographerAPI surface. No framework — node:http.
 *
 * Every route checks Host and Origin, and requires `Authorization: Bearer
 * <token>` unless the server was started with --rest-insecure (./auth.ts).
 * Query parameters are validated: a malformed one gets 400, an oversized
 * count is clamped.
 *
 * OpenAPPA context provider (consult protocol v1, ./appa-context.ts):
 *   POST /appa/context  {version: 1, kind: "context", artifact: {tool, arguments, cwd?}}
 *
 * Routes:
 *   GET /status
 *   GET /messages?n=10
 *   GET /entities
 *   GET /relations
 *   GET /decisions            (active)
 *   GET /decisions/history    (full supersession history)
 *   GET /decisions/:id/chain  (one supersession chain, oldest first)
 *   GET /tombstones
 *   GET /flags?since=<id>&status=pending&include=shadow  (real-time objections, §12)
 *   GET /search?q=...&k=5     (semantic vector search)
 *   GET /graphrag?q=...&k=5&depth=2  (hybrid vector + graph search)
 *   GET /context-frame?budget=2000
 *   GET /proposals?status=open&kind=tombstone  (the review inbox)
 *
 * Notary routes (§15) — require X-Notary-Secret; disabled when no secret is set.
 * The notary/dismisser name is checked against the signer registry when one
 * is configured (it must be a person):
 *   POST /proposals/:id/notarize  {notary, edits?}
 *   POST /proposals/:id/dismiss   {dismissedBy, reason}
 *
 * Proposal submission — same secret, for a tool that authors truth outside
 * stenographer (the Swift messenger; one writer per wiki file): one truth
 * format v2 PROPOSAL envelope, filed by the proposals-stream intake as an
 * open proposal that needs a notary. Its author must be a person or an agent
 * (registered as one, with a signer registry). 201 {proposalId} when filed,
 * 200 {proposalId} when this envelope was submitted before, 409 for a
 * different envelope under a filed id or one a proposals stream filed:
 *   POST /proposals               {schemaVersion: 2, type: "PROPOSAL", id, ts, author, kind, draft, …}
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Stenographer } from '../core/stenographer.js';
import { TruthWriteError } from '../truth/ledger.js';
import { ProposalConflictError, ProposalEnvelopeError } from '../truth/intake.js';
import { DraftEditsSchema } from '../truth/types.js';
import { NOTARY_SECRET_HEADER, notarySecretMatches } from '../truth/notary.js';
import { allowedHostNames, bearerMatches, hostHeaderName, originAllowed } from './auth.js';
import { ContextConsultSchema, answerContextConsult } from './appa-context.js';

const MAX_BODY_BYTES = 64 * 1024;
/** A consult carries the whole proposed call (a Write's file content, say). */
const MAX_CONSULT_BYTES = 1024 * 1024;
/** Upper bounds for list sizes: larger requests are clamped, not refused. */
const MAX_K = 200;
const MAX_MESSAGES = 1000;
const MAX_DEPTH = 5;
const MAX_FLAGS = 1000;
const MAX_BUDGET = 100_000;
const MAX_QUERY_CHARS = 2_000;

/** A positive integer parameter (0 allowed with `min: 0`): `fallback` when absent, clamped to `max`. */
const count = (fallback: number, max: number, min: number = 1) =>
  z.coerce
    .number()
    .int()
    .min(min)
    .default(fallback)
    .transform((n) => Math.min(n, max));

const query = z.string().min(1).max(MAX_QUERY_CHARS);

const QUERIES = {
  messages: z.object({ n: count(10, MAX_MESSAGES) }),
  flags: z.object({
    since: z.string().max(64).optional(),
    status: z.enum(['pending', 'sustained', 'overruled']).optional(),
    include: z.literal('shadow').optional(),
    limit: count(100, MAX_FLAGS),
  }),
  search: z.object({ q: query, k: count(5, MAX_K) }),
  graphrag: z.object({ q: query, k: count(5, MAX_K), depth: count(2, MAX_DEPTH, 0) }),
  proposals: z.object({
    status: z.enum(['open', 'signed', 'dismissed']).optional(),
    kind: z.enum(['tombstone', 'uv']).optional(),
  }),
  contextFrame: z.object({ budget: count(2000, MAX_BUDGET) }),
};

const nonBlank = (what: string) => z.string().refine((v) => v.trim().length > 0, `${what} is required`);

/** Notary request bodies: exactly what the operator profile's tools take, no stray identities. */
const BODIES = {
  notarize: z.object({ notary: nonBlank('notary'), edits: DraftEditsSchema.optional() }).strict(),
  dismiss: z.object({ dismissedBy: nonBlank('dismissedBy'), reason: nonBlank('reason') }).strict(),
};

/** A request the caller has to fix: answered with its status, never 500. */
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, url: URL): z.infer<T> {
  const result = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`);
    throw new RequestError(400, `Invalid query parameter — ${issues.join('; ')}`);
  }
  return result.data;
}

function parseBody<T extends z.ZodTypeAny>(schema: T, body: Record<string, unknown>): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new RequestError(400, `Invalid request body — ${issues.join('; ')}`);
  }
  return result.data;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestError(400, 'Malformed percent-encoding in path');
  }
}

export interface RestServerOptions {
  /** The bearer token every request must carry. */
  token?: string | null;
  /** Serve without a token (`--rest-insecure`). Host and Origin are still checked. */
  insecure?: boolean;
  /** Host names to answer to besides loopback: the bind host, `--rest-allow-host`. */
  allowedHosts?: string[];
}

export class RestServer {
  private engine: Stenographer;
  private server: Server | null = null;
  private boundPort: number | null = null;
  private token: string | null;
  private hosts: Set<string>;

  constructor(engine: Stenographer, options: RestServerOptions) {
    if (!options?.token && !options?.insecure) {
      throw new Error('RestServer needs a bearer token (or insecure: true to serve without one)');
    }
    this.engine = engine;
    this.token = options.token || null;
    this.hosts = allowedHostNames(options.allowedHosts);
  }

  get port(): number | null {
    return this.boundPort;
  }

  /**
   * Starts the REST server. Binds to `host` (default `127.0.0.1`): the API
   * serves transcripts, so it listens on all interfaces only when the
   * operator asks (e.g. `--rest-host 0.0.0.0` in a container, with
   * `--rest-allow-host` for the name clients use).
   */
  start(port: number, host: string = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          const status = err instanceof RequestError ? err.status : 500;
          sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        });
      });
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const address = this.server!.address();
        this.boundPort = typeof address === 'object' && address ? address.port : port;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.boundPort = null;
  }

  /**
   * Host, Origin and bearer token, before anything else is read: a refused
   * request learns nothing but its status.
   */
  private refuse(req: IncomingMessage, res: ServerResponse): boolean {
    const host = hostHeaderName(req.headers.host);
    let refusal: { status: number; error: string; headers?: Record<string, string> } | null = null;
    if (!host || !this.hosts.has(host)) {
      refusal = { status: 421, error: 'Host not allowed (DNS rebinding guard); use a loopback name or --rest-allow-host' };
    } else if (!originAllowed(req.headers.origin, this.hosts)) {
      refusal = { status: 403, error: 'Cross-origin requests are not allowed' };
    } else if (this.token && !bearerMatches(this.token, req.headers.authorization)) {
      refusal = {
        status: 401,
        error: 'Missing or invalid bearer token (see <state dir>/rest-token)',
        headers: { 'WWW-Authenticate': 'Bearer realm="stenographer"' },
      };
    }
    if (!refusal) return false;
    req.resume();
    sendJson(res, refusal.status, { error: refusal.error }, refusal.headers);
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.refuse(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'POST' && path === '/appa/context') {
      await this.handleContextConsult(req, res);
      return;
    }
    if (req.method === 'POST') {
      await this.handleNotary(req, res, path);
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const chainMatch = path.match(/^\/decisions\/([^/]+)\/chain$/);
    if (chainMatch) {
      sendJson(res, 200, await this.engine.getDecisionChain(decodeSegment(chainMatch[1])));
      return;
    }

    switch (path) {
      case '/':
      case '/status':
        sendJson(res, 200, {
          ...(await this.engine.getStatus()),
          sessionId: this.engine.getSessionId(),
          retriever: this.engine.retriever.getStats(),
          vectorBackend: this.engine.store.vectorSearchBackend,
          embedder: this.engine.embedderIdentity,
        });
        return;

      case '/messages': {
        const { n } = parseQuery(QUERIES.messages, url);
        sendJson(res, 200, await this.engine.getRecentMessages(n));
        return;
      }

      case '/entities':
        sendJson(res, 200, await this.engine.getEntities());
        return;

      case '/relations':
        sendJson(res, 200, await this.engine.getRelations());
        return;

      case '/decisions':
        sendJson(res, 200, await this.engine.getActiveDecisions());
        return;

      case '/decisions/history':
        sendJson(res, 200, await this.engine.getDecisionHistory());
        return;

      case '/tombstones':
        sendJson(res, 200, await this.engine.getTombstones());
        return;

      case '/flags': {
        // Pull transport: consumers poll with the last id they saw. SSE vs
        // webhook push is an open question (§14.8); both can layer on this.
        const { since, status, include, limit } = parseQuery(QUERIES.flags, url);
        sendJson(
          res,
          200,
          await this.engine.getObjections({ since, status, includeShadow: include === 'shadow', limit })
        );
        return;
      }

      case '/search': {
        const { q, k } = parseQuery(QUERIES.search, url);
        sendJson(res, 200, await this.engine.searchSimilar(q, k));
        return;
      }

      case '/graphrag': {
        const { q, k, depth } = parseQuery(QUERIES.graphrag, url);
        sendJson(res, 200, await this.engine.searchGraphRAG({ query: q, k, graphDepth: depth }));
        return;
      }

      case '/proposals': {
        const { status, kind } = parseQuery(QUERIES.proposals, url);
        sendJson(res, 200, await this.engine.listProposals(status, kind));
        return;
      }

      case '/context-frame': {
        const { budget } = parseQuery(QUERIES.contextFrame, url);
        const frame = await this.engine.buildContextFrame(budget);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(frame);
        return;
      }

      default:
        sendJson(res, 404, { error: `Not found: ${path}` });
    }
  }

  /**
   * OpenAPPA context provider: the ledger's facts about one proposed call.
   * Read-only; the response is exactly `{version: 1, answer}`.
   */
  private async handleContextConsult(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const consult = ContextConsultSchema.safeParse(await readJson(req, MAX_CONSULT_BYTES));
    if (!consult.success) {
      const issues = consult.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
      throw new RequestError(400, `Not a v1 context consult — ${issues.join('; ')}`);
    }
    // The objection log's matcher: compiled once per ledger generation, not per consult
    const { truth, objections } = this.engine.store;
    sendJson(res, 200, { version: 1, answer: answerContextConsult(truth, consult.data.artifact, objections.compiled()) });
  }

  /**
   * The notary routes: a person approving (or declining) a proposal from a UI
   * that holds the notary secret, and that UI submitting a proposal for it.
   * The agent MCP profile has no tool that reaches them; the secret itself
   * is only as private as this process's environment (see the README's
   * threat model).
   */
  private async handleNotary(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const submission = path === '/proposals';
    const match = path.match(/^\/proposals\/([^/]+)\/(notarize|dismiss)$/);
    if (!submission && !match) {
      // Everything else is read-only
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const engine = this.engine;
    const secret = engine.config.notarySecret;
    if (!secret) {
      sendJson(res, 403, { error: 'notarization over REST is disabled — set STENOGRAPHER_NOTARY_SECRET' });
      return;
    }
    const given = req.headers[NOTARY_SECRET_HEADER];
    if (!notarySecretMatches(secret, Array.isArray(given) ? given[0] : given)) {
      sendJson(res, 401, { error: 'invalid or missing notary secret' });
      return;
    }
    if (submission) {
      await this.handleSubmission(req, res);
      return;
    }

    // Malformed requests are the caller's to fix (400, 413), before anything is written
    const [, id, action] = match!;
    const proposalId = decodeSegment(id);
    const body = await readJson(req);
    try {
      if (action === 'notarize') {
        const { notary, edits } = parseBody(BODIES.notarize, body);
        sendJson(res, 200, await engine.notarizeProposal(proposalId, notary, edits));
      } else {
        const { dismissedBy, reason } = parseBody(BODIES.dismiss, body);
        sendJson(res, 200, await engine.dismissProposal(proposalId, dismissedBy, reason));
      }
    } catch (err) {
      if (err instanceof RequestError) throw err;
      // Ledger rules (contempt, already-signed, invalid literals) are the caller's to fix
      const status = err instanceof TruthWriteError || (err as { name?: string })?.name === 'ZodError' ? 422 : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * One PROPOSAL envelope from a tool that authors truth outside
   * stenographer, filed the way the intake files a proposals stream.
   * Idempotent by envelope id.
   */
  private async handleSubmission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const envelope = await readJson(req);
    try {
      const { outcome, proposal } = await this.engine.submitProposal(envelope);
      sendJson(res, outcome === 'filed' ? 201 : 200, { proposalId: proposal.id });
    } catch (err) {
      if (err instanceof ProposalEnvelopeError) throw new RequestError(400, `Invalid PROPOSAL envelope — ${err.message}`);
      if (err instanceof ProposalConflictError) {
        sendJson(res, 409, { error: err.message, proposalId: err.proposal.id });
        return;
      }
      // An author the identity rules or the signer registry refuse
      const status = err instanceof TruthWriteError ? 422 : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function readJson(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new RequestError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new RequestError(400, 'body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError(400, 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body, null, 2));
}

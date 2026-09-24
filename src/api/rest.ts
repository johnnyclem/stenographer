/**
 * Stenographer — REST API
 * Thin HTTP layer over the StenographerAPI surface. No framework — node:http.
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
 * Notary routes (§15) — require X-Notary-Secret; disabled when no secret is set:
 *   POST /proposals/:id/notarize  {notary, edits?}
 *   POST /proposals/:id/dismiss   {dismissedBy, reason}
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Stenographer } from '../core/stenographer.js';
import { TruthWriteError } from '../truth/ledger.js';
import { NOTARY_SECRET_HEADER, notarySecretMatches } from '../truth/notary.js';
import type { ProposalBody } from '../truth/types.js';

const MAX_BODY_BYTES = 64 * 1024;

export class RestServer {
  private engine: Stenographer;
  private server: Server | null = null;
  private boundPort: number | null = null;

  constructor(engine: Stenographer) {
    this.engine = engine;
  }

  get port(): number | null {
    return this.boundPort;
  }

  /**
   * Starts the REST server. Binds to `host` (default `127.0.0.1`) — this API
   * has no authentication, so it must not listen on all interfaces unless
   * the caller explicitly opts in (e.g. `--rest-host 0.0.0.0` in a
   * container where the operator accepts that tradeoff).
   */
  start(port: number, host: string = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

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
      sendJson(res, 200, await this.engine.getDecisionChain(decodeURIComponent(chainMatch[1])));
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
        });
        return;

      case '/messages': {
        const n = intParam(url, 'n', 10);
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
        const status = url.searchParams.get('status');
        if (status && !['pending', 'sustained', 'overruled'].includes(status)) {
          sendJson(res, 400, { error: `Invalid status: ${status}` });
          return;
        }
        sendJson(
          res,
          200,
          await this.engine.getObjections({
            since: url.searchParams.get('since') ?? undefined,
            status: (status as 'pending' | 'sustained' | 'overruled' | null) ?? undefined,
            includeShadow: url.searchParams.get('include') === 'shadow',
            limit: intParam(url, 'limit', 100),
          })
        );
        return;
      }

      case '/search': {
        const q = url.searchParams.get('q');
        if (!q) {
          sendJson(res, 400, { error: 'Missing query parameter: q' });
          return;
        }
        sendJson(res, 200, await this.engine.searchSimilar(q, intParam(url, 'k', 5)));
        return;
      }

      case '/graphrag': {
        const q = url.searchParams.get('q');
        if (!q) {
          sendJson(res, 400, { error: 'Missing query parameter: q' });
          return;
        }
        sendJson(
          res,
          200,
          await this.engine.searchGraphRAG({
            query: q,
            k: intParam(url, 'k', 5),
            graphDepth: intParam(url, 'depth', 2),
          })
        );
        return;
      }

      case '/proposals': {
        const status = url.searchParams.get('status');
        if (status && !['open', 'signed', 'dismissed'].includes(status)) {
          sendJson(res, 400, { error: `Invalid status: ${status}` });
          return;
        }
        const kind = url.searchParams.get('kind');
        if (kind && !['tombstone', 'uv'].includes(kind)) {
          sendJson(res, 400, { error: `Invalid kind: ${kind}` });
          return;
        }
        sendJson(
          res,
          200,
          await this.engine.listProposals(
            (status as ProposalBody['status'] | null) ?? undefined,
            (kind as ProposalBody['kind'] | null) ?? undefined
          )
        );
        return;
      }

      case '/context-frame': {
        const frame = await this.engine.buildContextFrame(intParam(url, 'budget', 2000));
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(frame);
        return;
      }

      default:
        sendJson(res, 404, { error: `Not found: ${path}` });
    }
  }

  /**
   * The notary routes: a person approving (or declining) a proposal from a UI
   * that holds the notary secret. Agents are never given the secret, so this
   * is the path their MCP tools can't take.
   */
  private async handleNotary(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const match = path.match(/^\/proposals\/([^/]+)\/(notarize|dismiss)$/);
    if (!match) {
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

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const proposalId = decodeURIComponent(match[1]);
    try {
      if (match[2] === 'notarize') {
        const notary = body.notary;
        if (typeof notary !== 'string' || !notary.trim()) {
          sendJson(res, 400, { error: 'notary is required' });
          return;
        }
        const edits = body.edits && typeof body.edits === 'object' ? (body.edits as Record<string, unknown>) : undefined;
        sendJson(res, 200, await engine.notarizeProposal(proposalId, notary, edits));
      } else {
        const { dismissedBy, reason } = body as { dismissedBy?: unknown; reason?: unknown };
        if (typeof dismissedBy !== 'string' || typeof reason !== 'string') {
          sendJson(res, 400, { error: 'dismissedBy and reason are required' });
          return;
        }
        sendJson(res, 200, await engine.dismissProposal(proposalId, dismissedBy, reason));
      }
    } catch (err) {
      // Ledger rules (contempt, already-signed, invalid literals) are the caller's to fix
      const status = err instanceof TruthWriteError || (err as { name?: string })?.name === 'ZodError' ? 422 : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

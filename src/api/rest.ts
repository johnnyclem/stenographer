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
 *   GET /search?q=...&k=5     (semantic vector search)
 *   GET /graphrag?q=...&k=5&depth=2  (hybrid vector + graph search)
 *   GET /context-frame?budget=2000
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Stenographer } from '../core/stenographer.js';

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
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

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

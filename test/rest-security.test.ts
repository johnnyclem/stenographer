import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import { RestServer } from '../src/api/rest.js';
import type { StenographerConfig } from '../src/types.js';

const line = (id: string, content: string) =>
  JSON.stringify({ id, role: 'user', content, timestamp: '2026-06-09T10:00:00Z' }) + '\n';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so the test controls Host and Origin (fetch rewrites Host). */
function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('REST security (IDX-11)', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(overrides: Partial<StenographerConfig> = {}): Promise<{ e: Stenographer; port: number }> {
    dir = mkdtempSync(join(tmpdir(), 'steno-rest-sec-'));
    writeFileSync(join(dir, 'log.jsonl'), line('m1', 'my AWS key is AKIA29 and the database is postgres'));
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: join(dir, 'state.db'),
      mode: 'catchup',
      embeddingModel: 'hashed',
      restPort: 0,
      ...overrides,
    });
    await engine.start();
    return { e: engine, port: engine.restPort! };
  }

  const auth = (e: Stenographer) => ({ Authorization: `Bearer ${e.restToken}` });

  it('rejects a rebound Host header even with a valid token', async () => {
    const { e, port } = await start();
    const res = await send(port, '/messages', { headers: { Host: `attacker.example:${port}`, ...auth(e) } });
    expect(res.status).toBe(421);
    expect(res.body).not.toContain('AKIA29');
  });

  it('accepts loopback names in Host', async () => {
    const { e, port } = await start();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'localhost']) {
      const res = await send(port, '/status', { headers: { Host: host, ...auth(e) } });
      expect(res.status, host).toBe(200);
    }
  });

  it('rejects a cross-site Origin', async () => {
    const { e, port } = await start();
    const res = await send(port, '/messages', {
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://attacker.example', ...auth(e) },
    });
    expect(res.status).toBe(403);
    const same = await send(port, '/messages', {
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://localhost:${port}`, ...auth(e) },
    });
    expect(same.status).toBe(200);
  });

  it('requires the bearer token on every route by default', async () => {
    const { e, port } = await start();
    const host = { Host: `127.0.0.1:${port}` };
    for (const path of ['/status', '/messages', '/search?q=key', '/flags', '/proposals', '/context-frame']) {
      const res = await send(port, path, { headers: host });
      expect(res.status, path).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect(res.body).not.toContain('AKIA29');
    }
    expect((await send(port, '/messages', { headers: { ...host, Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await send(port, '/messages', { headers: { ...host, ...auth(e) } })).status).toBe(200);
    // POST routes too, before any body is read
    const post = await send(port, '/appa/context', { method: 'POST', headers: host, body: '{}' });
    expect(post.status).toBe(401);
  });

  it('generates the token on first run into <state dir>/rest-token, mode 0600, and reuses it', async () => {
    const { e } = await start();
    const path = join(dir, 'rest-token');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const token = readFileSync(path, 'utf8').trim();
    expect(token).toBe(e.restToken);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(e.restTokenPath).toBe(path);

    e.stop();
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: join(dir, 'state.db'),
      mode: 'catchup',
      embeddingModel: 'hashed',
      restPort: 0,
    });
    await engine.start();
    expect(engine.restToken).toBe(token);
  });

  it('a configured token is used instead of a generated one', async () => {
    const { e, port } = await start({ restToken: 'operator-chosen-token-0123456789abcdef' });
    expect(e.restToken).toBe('operator-chosen-token-0123456789abcdef');
    expect(existsSync(join(dir, 'rest-token'))).toBe(false);
    const res = await send(port, '/status', {
      headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer operator-chosen-token-0123456789abcdef' },
    });
    expect(res.status).toBe(200);
  });

  it('--rest-insecure drops the token but still checks Host', async () => {
    const { e, port } = await start({ restInsecure: true });
    expect(e.restToken).toBeNull();
    expect(existsSync(join(dir, 'rest-token'))).toBe(false);
    expect((await send(port, '/status', { headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200);
    expect((await send(port, '/status', { headers: { Host: 'attacker.example' } })).status).toBe(421);
  });

  it('allows the configured --rest-host and extra allowed hosts', async () => {
    const { e, port } = await start({ restHost: '127.0.0.1', restAllowedHosts: ['stenographer.internal'] });
    const ok = await send(port, '/status', { headers: { Host: `stenographer.internal:${port}`, ...auth(e) } });
    expect(ok.status).toBe(200);
  });

  it('a RestServer refuses to start without a token unless insecure is explicit', () => {
    expect(() => new RestServer(engine as unknown as Stenographer, {} as never)).toThrow(/token/);
  });
});

describe('REST query validation', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<{ port: number; headers: Record<string, string> }> {
    dir = mkdtempSync(join(tmpdir(), 'steno-rest-q-'));
    writeFileSync(join(dir, 'log.jsonl'), line('m1', 'we decided to use postgres for the database'));
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
      restPort: 0,
    });
    await engine.start();
    const port = engine.restPort!;
    return { port, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${engine.restToken}` } };
  }

  it('answers 400 for malformed parameters instead of guessing or failing', async () => {
    const { port, headers } = await start();
    for (const path of [
      '/search?q=postgres&k=abc',
      '/search?q=postgres&k=0',
      '/search?q=postgres&k=-3',
      '/search?q=postgres&k=2.5',
      '/graphrag?q=postgres&depth=-1',
      '/messages?n=ten',
      '/flags?limit=0',
      '/context-frame?budget=lots',
      '/flags?include=everything',
      '/decisions/%E0%A4%A/chain',
    ]) {
      const res = await send(port, path, { headers });
      expect(res.status, path).toBe(400);
      expect(JSON.parse(res.body).error, path).toBeTruthy();
    }
  });

  it('clamps oversized counts rather than refusing them', async () => {
    const { port, headers } = await start();
    expect((await send(port, '/search?q=postgres&k=100000', { headers })).status).toBe(200);
    expect((await send(port, '/messages?n=999999999', { headers })).status).toBe(200);
    expect((await send(port, '/graphrag?q=postgres&depth=99', { headers })).status).toBe(200);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';

const line = (id: string, content: string, ts: string) =>
  JSON.stringify({ id, role: 'user', content, timestamp: ts }) + '\n';

describe('REST API', () => {
  let dir: string;
  let engine: Stenographer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-rest-'));
    writeFileSync(
      join(dir, 'log.jsonl'),
      line('m1', 'we decided to use postgres for the database', '2026-06-09T10:00:00Z') +
        line('m2', 'actually, we decided to use sqlite for the database', '2026-06-09T11:00:00Z')
    );

    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
      supersedeThreshold: 0.4,
      restPort: 0, // ephemeral port
    });
    await engine.start();
    base = `http://localhost:${engine.restPort}`;
  });

  afterAll(() => {
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const getJson = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };

  it('serves status', async () => {
    const { status, body } = await getJson('/status');
    expect(status).toBe(200);
    expect(body.messagesIndexed).toBe(2);
    expect(body.vectorBackend).toMatch(/sqlite-vec|brute-force/);
  });

  it('serves messages, entities, decisions, tombstones', async () => {
    expect((await getJson('/messages?n=1')).body).toHaveLength(1);
    expect((await getJson('/decisions')).body.length).toBeGreaterThan(0);
    expect((await getJson('/tombstones')).body.length).toBeGreaterThan(0);
    expect((await getJson('/entities')).status).toBe(200);
    expect((await getJson('/relations')).status).toBe(200);
  });

  it('serves decision history and chains', async () => {
    const history = (await getJson('/decisions/history')).body;
    expect(history.length).toBeGreaterThanOrEqual(2);

    const superseded = history.find((d: any) => d.superseded);
    expect(superseded).toBeTruthy();

    const chain = (await getJson(`/decisions/${superseded.id}/chain`)).body;
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0].id).toBe(superseded.id);
  });

  it('serves semantic and graphrag search', async () => {
    const { body } = await getJson('/search?q=database+decision&k=1');
    expect(body).toHaveLength(1);

    const gr = await getJson('/graphrag?q=database&k=3');
    expect(gr.status).toBe(200);
    expect(Array.isArray(gr.body)).toBe(true);

    expect((await getJson('/search')).status).toBe(400);
  });

  it('serves a context frame as markdown', async () => {
    const res = await fetch(`${base}/context-frame?budget=500`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toContain('## Decisions');
  });

  it('404s unknown routes and 405s non-GET', async () => {
    expect((await getJson('/nope')).status).toBe(404);
    const res = await fetch(`${base}/status`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('binds to loopback by default, not all interfaces', () => {
    // The REST API has no authentication — it must not default to 0.0.0.0.
    const address = (engine as any).restServer.server.address();
    expect(address.address).toMatch(/^(127\.0\.0\.1|::1)$/);
  });
});

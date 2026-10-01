import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import type { TbEntry, UvEntry } from '../src/truth/types.js';

interface RecordedRequest {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

const FIXTURE: { requests: RecordedRequest[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'appa-context-consult.json'), 'utf8')
);
const recorded = (name: string) => FIXTURE.requests.find((r) => r.name === name)!;

describe('OpenAPPA context provider (POST /appa/context)', () => {
  let dir: string;
  let engine: Stenographer;
  let base: string;
  let budget: TbEntry;
  let limiter: TbEntry;
  let contest: UvEntry;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-appa-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
      restPort: 0,
    });
    await engine.start();
    base = `http://127.0.0.1:${engine.restPort}`;

    budget = await engine.assertTombstone({
      claim: 'LOG_BUDGET 30 is dead; the budget is 100',
      evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
      signedBy: 'johnnyclem',
      literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
    });
    limiter = await engine.assertTombstone({
      claim: 'legacyRateLimiter was deleted in the v2 refactor; use TokenBucket',
      evidence: [{ kind: 'commit', ref: 'd4e5f6' }],
      signedBy: 'alex',
      literals: [{ dead: 'legacyRateLimiter', current: 'TokenBucket' }],
    });
    contest = await engine.assertUv({
      assertion: 'legacyRateLimiter is still deployed in the eu region',
      basis: 'saw it in the eu dashboard',
      verifyBy: { kind: 'inspect', value: 'deploy/eu/limiter.yaml' },
      contests: limiter.id,
      author: 'sam',
    });
  });

  afterAll(() => {
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Replays a recorded consult with this server's token. */
  const replay = (r: RecordedRequest, token: string | null = engine.restToken) =>
    fetch(`${base}${r.path}`, {
      method: r.method,
      headers: {
        ...r.headers,
        authorization: token ? `Bearer ${token}` : '',
      },
      body: JSON.stringify(r.body),
    });

  it('answers a recorded APPA consult with the TB literal hits in the arguments', async () => {
    const res = await replay(recorded('bash-asserts-dead-literal'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const reply = await res.json();

    // Exactly the consult response envelope: APPA rejects extra keys
    expect(Object.keys(reply).sort()).toEqual(['answer', 'version']);
    expect(reply.version).toBe(1);

    const hits = reply.answer.hits;
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      tb_id: budget.id,
      subject: 'LOG_BUDGET',
      dead: '30',
      current: '100',
      claim: 'LOG_BUDGET 30 is dead; the budget is 100',
      signer: 'johnnyclem',
      author: 'johnnyclem',
      status: 'active',
      argument: 'command',
      line: expect.stringContaining('LOG_BUDGET=30'),
      contested_by: [],
    });
    expect(hits[1]).toMatchObject({
      tb_id: limiter.id,
      dead: 'legacyRateLimiter',
      current: 'TokenBucket',
      signer: 'alex',
      status: 'contested',
      argument: 'command',
      contested_by: [
        {
          uv_id: contest.id,
          assertion: 'legacyRateLimiter is still deployed in the eu region',
          author: 'sam',
          status: 'open',
        },
      ],
    });
    expect(hits[1]).not.toHaveProperty('subject');
  });

  it('does not report the old side of an edit (replacing a dead value is the fix)', async () => {
    const res = await replay(recorded('edit-removes-dead-literal'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, answer: null });
  });

  /** A consult in the recorded wire shape, for another proposed call. */
  const consult = async (tool: string, args: Record<string, unknown>) => {
    const r = recorded('bash-asserts-dead-literal');
    const res = await fetch(`${base}${r.path}`, {
      method: 'POST',
      headers: { ...r.headers, authorization: `Bearer ${engine.restToken}` },
      body: JSON.stringify({ ...r.body, artifact: { tool, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).answer;
  };

  it('reads what the call asserts, as the gate and the objection detector do: searches and commit messages are not hits', async () => {
    expect(await consult('Grep', { pattern: 'legacyRateLimiter', path: 'src' })).toBeNull();
    expect(
      await consult('Bash', {
        command: 'grep -rn legacyRateLimiter src/ && git commit -m "Remove legacyRateLimiter; LOG_BUDGET = 30 is gone"',
        description: 'Check the dead limiter is gone, then commit',
      })
    ).toBeNull();
    // A description that names a dead value asserts nothing either
    expect(await consult('Bash', { command: 'npm test', description: 'run with LOG_BUDGET = 30' })).toBeNull();
  });

  it('reports what a write or an edit asserts, by the field that asserts it', async () => {
    const write = await consult('Write', { file_path: 'src/config.ts', content: 'export const LOG_BUDGET = 30;\n' });
    expect(write.hits.map((h: { tb_id: string; argument: string }) => [h.tb_id, h.argument])).toEqual([[budget.id, 'content']]);
    const multi = await consult('MultiEdit', {
      file_path: 'src/limit.ts',
      edits: [
        { old_string: 'TokenBucket', new_string: 'TokenBucket' },
        { old_string: 'x', new_string: 'const limiter = legacyRateLimiter()' },
      ],
    });
    expect(multi.hits.map((h: { tb_id: string; argument: string }) => [h.tb_id, h.argument])).toEqual([
      [limiter.id, 'edits[1].new_string'],
    ]);
  });

  it('answers null when the ledger has nothing to say about the call', async () => {
    const res = await replay(recorded('unrelated-fetch'));
    expect(await res.json()).toEqual({ version: 1, answer: null });
  });

  it('is behind the same bearer token as every other route', async () => {
    const res = await replay(recorded('bash-asserts-dead-literal'), null);
    expect(res.status).toBe(401);
  });

  it('refuses requests that are not a v1 context consult', async () => {
    const r = recorded('bash-asserts-dead-literal');
    const bad = async (body: unknown) =>
      (
        await fetch(`${base}/appa/context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${engine.restToken}` },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        })
      ).status;
    expect(await bad({ ...r.body, version: 2 })).toBe(400);
    expect(await bad({ ...r.body, kind: 'authority' })).toBe(400);
    expect(await bad({ ...r.body, artifact: { arguments: {} } })).toBe(400);
    expect(await bad('{not json')).toBe(400);
  });

  it('is read-only: the ledger is unchanged by a consult', async () => {
    const before = await engine.getTruthStats();
    await replay(recorded('bash-asserts-dead-literal'));
    expect(await engine.getTruthStats()).toEqual(before);
  });
});

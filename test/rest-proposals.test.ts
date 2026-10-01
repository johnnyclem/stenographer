/**
 * POST /proposals: a tool that authors truth outside stenographer (the
 * Swift messenger) submits one truth-format v2 PROPOSAL envelope, and a
 * person notarizes it (release plan, Addendum D). It never appends to a
 * wiki file. The route files through the proposals-stream intake.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StenographerServer } from '../src/mcp/server.js';
import { NotarizationRequiredError } from '../src/truth/ledger.js';
import { wikiLineHash } from '../src/truth/wiki.js';
import type { StenographerConfig } from '../src/types.js';
import type { ProposalEntry } from '../src/truth/types.js';

const REST_TOKEN = 'proposal-tests-rest-token-0123456789';
const SECRET = 'n0tary';

/** What the messenger sends: no seq, prevHash or hash. */
const ENVELOPE = {
  schemaVersion: 2,
  type: 'PROPOSAL',
  id: '01J9MSGRTB0000000000000001',
  ts: '2026-09-30T12:00:00.000Z',
  author: 'agent:messenger',
  kind: 'tb',
  draft: {
    claim: 'LOG_BUDGET 30 is dead; the budget is 100',
    evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
    literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
  },
  targetRef: 'config:LOG_BUDGET',
  signal: { source: 'agent', detail: 'typed in the messenger' },
  agentSessionId: 'sess_msgr',
};

/** The same envelope as the first line of a stream: chain fields present and checked. */
function chained(envelope: Record<string, unknown>): Record<string, unknown> {
  const line = { ...envelope, seq: 1, prevHash: null };
  return { ...line, hash: wikiLineHash(line) };
}

describe('POST /proposals', () => {
  let dir: string;
  let server: StenographerServer | null = null;

  afterEach(() => {
    server?.engine.stop();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(overrides: Partial<StenographerConfig> = {}) {
    dir = mkdtempSync(join(tmpdir(), 'steno-proposals-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    server = new StenographerServer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      restToken: REST_TOKEN,
      mode: 'catchup',
      embeddingModel: 'hashed',
      restPort: 0,
      agentIdentity: 'agent:claude-code',
      notarySecret: SECRET,
      ...overrides,
    });
    await server.engine.start();
    return `http://127.0.0.1:${server.engine.restPort}`;
  }

  const post = (url: string, body: unknown, secret: string | null = SECRET) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${REST_TOKEN}`,
        ...(secret ? { 'X-Notary-Secret': secret } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const proposals = () => server!.engine.store.truth.listProposals();

  it('needs the notary secret, exactly like the notary routes', async () => {
    const base = await start();
    expect((await post(`${base}/proposals`, ENVELOPE, null)).status).toBe(401);
    expect((await post(`${base}/proposals`, ENVELOPE, 'wrong')).status).toBe(401);
    // The bearer token is still checked first
    const noBearer = await fetch(`${base}/proposals`, {
      method: 'POST',
      headers: { 'X-Notary-Secret': SECRET },
      body: JSON.stringify(ENVELOPE),
    });
    expect(noBearer.status).toBe(401);
    expect(proposals()).toEqual([]);

    server!.engine.stop();
    rmSync(dir, { recursive: true, force: true });
    const off = await start({ notarySecret: undefined });
    const res = await post(`${off}/proposals`, ENVELOPE, 'anything');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/STENOGRAPHER_NOTARY_SECRET/);
    expect(proposals()).toEqual([]);
  });

  it('files the envelope as an open proposal that needs a notary, keeping the envelope under meta.intake', async () => {
    const base = await start();
    const res = await post(`${base}/proposals`, ENVELOPE);
    expect(res.status).toBe(201);
    const { proposalId } = await res.json();

    const inbox = (await (await fetch(`${base}/proposals?status=open`, { headers: { Authorization: `Bearer ${REST_TOKEN}` } })).json()) as ProposalEntry[];
    expect(inbox.map((p) => p.id)).toEqual([proposalId]);
    const [p] = inbox;
    expect(p.author).toBe('agent:messenger');
    expect(p.agentSessionId).toBe('sess_msgr');
    expect(p.createdAt).toBe(ENVELOPE.ts);
    expect(p.body).toMatchObject({
      kind: 'tombstone',
      status: 'open',
      requiresNotary: true,
      draft: ENVELOPE.draft,
      targetRef: 'config:LOG_BUDGET',
      meta: { intake: { id: ENVELOPE.id, author: 'agent:messenger', source: 'agent' } },
    });
    // It carried no hash, so none is recorded as its own
    expect(p.body.meta?.intake).not.toHaveProperty('hash');
    // Nothing is truth until a person notarizes it, and the plain signing path can't
    expect(server!.engine.store.truth.getTruth('all')).toEqual([]);
    expect(() => server!.engine.store.truth.signProposal(proposalId, 'johnny')).toThrow(NotarizationRequiredError);
  });

  it('is idempotent by envelope id: the same envelope again is a 200 with the same proposal', async () => {
    const base = await start();
    const first = await post(`${base}/proposals`, ENVELOPE);
    expect(first.status).toBe(201);
    const { proposalId } = await first.json();

    for (const again of [ENVELOPE, chained(ENVELOPE), { ...ENVELOPE, draft: { ...ENVELOPE.draft } }]) {
      const res = await post(`${base}/proposals`, again);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ proposalId });
    }
    expect(proposals()).toHaveLength(1);

    // ...whatever became of it: a notarized proposal is not filed again either
    expect((await post(`${base}/proposals/${proposalId}/notarize`, { notary: 'johnny' })).status).toBe(200);
    const after = await post(`${base}/proposals`, ENVELOPE);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ proposalId });
    expect(proposals()).toHaveLength(1);
  });

  it('refuses a different envelope under an id already used (409), wherever it points', async () => {
    const base = await start();
    const { proposalId } = await (await post(`${base}/proposals`, ENVELOPE)).json();

    for (const changed of [
      { ...ENVELOPE, draft: { ...ENVELOPE.draft, claim: 'LOG_BUDGET 30 is dead; the budget is 200' } },
      { ...ENVELOPE, targetRef: 'config:OTHER' },
      { ...ENVELOPE, author: 'agent:other' },
    ]) {
      const res = await post(`${base}/proposals`, changed);
      expect(res.status, JSON.stringify(changed)).toBe(409);
      const body = await res.json();
      expect(body.proposalId).toBe(proposalId);
      expect(body.error).toMatch(/already filed/);
    }
    expect(proposals()).toHaveLength(1);
  });

  it('answers 400 with the validation errors, and files nothing', async () => {
    const base = await start();
    const { schemaVersion: _v, ...unversioned } = ENVELOPE;
    const cases: Array<[string, unknown, RegExp]> = [
      ['no evidence', { ...ENVELOPE, draft: { claim: 'x is dead', evidence: [] } }, /draft\.evidence/],
      ['kind outside the v2 vocabulary', { ...ENVELOPE, kind: 'tombstone' }, /kind/],
      ['no schemaVersion (an older dialect)', unversioned, /schemaVersion 2/],
      ['a TB line, not a proposal', { ...ENVELOPE, type: 'TB' }, /PROPOSAL/],
      ['a bad id', { ...ENVELOPE, id: 'has space' }, /id/],
      ['a bad ts', { ...ENVELOPE, ts: '2026-02-30T00:00:00Z' }, /ts/],
      ['an edited line', { ...chained(ENVELOPE), targetRef: 'elsewhere' }, /hash mismatch/],
      ['a hash without its seq and prevHash', { ...ENVELOPE, hash: chained(ENVELOPE).hash }, /seq|prevHash/],
      ['seq 2 with no prevHash', { ...ENVELOPE, seq: 2 }, /prevHash/],
      ['seq 1 with a prevHash', { ...ENVELOPE, seq: 1, prevHash: 'a'.repeat(64) }, /prevHash/],
      ['a non-integer seq', { ...ENVELOPE, seq: 1.5, prevHash: null }, /seq/],
      ['not JSON', '{"schemaVersion": 2,', /JSON/],
      ['an array', [ENVELOPE], /object/],
    ];
    for (const [what, body, error] of cases) {
      const res = await post(`${base}/proposals`, body);
      expect(res.status, what).toBe(400);
      expect((await res.json()).error, what).toMatch(error);
    }
    expect(proposals()).toEqual([]);
  });

  it('answers 413 to an oversized body', async () => {
    const base = await start();
    const res = await post(`${base}/proposals`, { ...ENVELOPE, draft: { ...ENVELOPE.draft, claim: 'x'.repeat(70 * 1024) } });
    expect(res.status).toBe(413);
    expect(proposals()).toEqual([]);
  });

  it('checks the author against the signer registry, and never files under a reserved identity', async () => {
    const base = await start({
      signerRegistry: { signers: [{ id: 'johnny', role: 'human' }, { id: 'agent:*', role: 'agent' }] },
    });
    // A detector may author a PROPOSAL line, but a submission stands behind a person or an agent
    for (const author of ['mallory', 'detector:messenger']) {
      const res = await post(`${base}/proposals`, { ...ENVELOPE, author });
      expect(res.status, author).toBe(422);
      expect((await res.json()).error, author).toMatch(/registry|reserved/);
    }
    // ...and no PROPOSAL line is authored by 'migration' at all (the format refuses it)
    expect((await post(`${base}/proposals`, { ...ENVELOPE, author: 'migration' })).status).toBe(400);
    expect(proposals()).toEqual([]);

    const res = await post(`${base}/proposals`, { ...ENVELOPE, author: ' Agent:Messenger ' });
    expect(res.status).toBe(201);
    const [p] = proposals();
    expect(p.author).toBe('Agent:Messenger');
    expect(p.body.meta?.intake).toMatchObject({ author: ' Agent:Messenger ' });
  });

  it('then the existing notarize route mints the TB, signed by the notary, with the draft literals', async () => {
    const base = await start({
      signerRegistry: { signers: [{ id: 'johnny', role: 'human' }, { id: 'sam', role: 'human' }, { id: 'agent:*', role: 'agent' }] },
    });
    const { proposalId } = await (await post(`${base}/proposals`, ENVELOPE)).json();
    // An agent is never the notary
    expect((await post(`${base}/proposals/${proposalId}/notarize`, { notary: 'agent:messenger' })).status).toBe(422);
    // The author can't notarize its own submission: contempt of corpus
    const bySam = { ...ENVELOPE, id: '01J9MSGRTB0000000000000002', author: 'sam' };
    const { proposalId: samsId } = await (await post(`${base}/proposals`, bySam)).json();
    const own = await post(`${base}/proposals/${samsId}/notarize`, { notary: 'Sam' });
    expect(own.status).toBe(422);
    expect((await own.json()).error).toMatch(/contempt of corpus/);

    const res = await post(`${base}/proposals/${proposalId}/notarize`, { notary: 'johnny' });
    expect(res.status).toBe(200);
    const tb = await res.json();
    expect(tb).toMatchObject({
      type: 'TB',
      author: 'johnny',
      body: { claim: ENVELOPE.draft.claim, signedBy: 'johnny', literals: ENVELOPE.draft.literals, status: 'active' },
    });
    expect(tb.links).toContainEqual(expect.objectContaining({ fromId: tb.id, toId: proposalId, type: 'signs' }));
    expect(server!.engine.store.truth.getMatchableTombstones().map((t) => t.id)).toEqual([tb.id]);
  });

  it('files a uv envelope too', async () => {
    const base = await start();
    const uv = {
      ...ENVELOPE,
      id: '01J9MSGRUV0000000000000001',
      kind: 'uv',
      draft: { assertion: 'Retries are idempotent.', basis: 'design doc', verifyBy: { kind: 'ask', value: 'sam' }, contests: null },
      targetRef: null,
      signal: { source: 'detector:messenger-lint' },
    };
    const res = await post(`${base}/proposals`, uv);
    expect(res.status).toBe(201);
    const [p] = proposals();
    expect(p.body).toMatchObject({ kind: 'uv', requiresNotary: true, meta: { intake: { id: uv.id, source: 'detector:messenger-lint' } } });

    const minted = await post(`${base}/proposals/${p.id}/notarize`, { notary: 'johnny' });
    expect(minted.status).toBe(200);
    expect(await minted.json()).toMatchObject({ type: 'UV', author: 'johnny', body: { assertion: 'Retries are idempotent.', status: 'open' } });
  });
});

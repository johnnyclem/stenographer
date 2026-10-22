/**
 * The decision model: the client's wire and error codes, the state the
 * model is told (graded entries, bounded transcript), the adviser's second
 * opinion on objections and how a person's ruling grades it (rewarded,
 * corrected), consults, the REST routes, the MCP tool, and the `advice`
 * command.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Stenographer } from '../src/core/stenographer.js';
import {
  DecisionAdviser,
  DecisionModelClient,
  DecisionModelError,
  buildDecisionState,
  consultQuestions,
  decisionModelFromConfig,
  gradeEntry,
  gradeReassertion,
  objectionQuestions,
  parseDecisionBody,
  stateText,
} from '../src/decision/index.js';
import { runAdviceCLI } from '../src/decision/advice-cli.js';
import { TruthLedger } from '../src/truth/ledger.js';
import type { StenographerConfig } from '../src/types.js';

const LOG_BUDGET = { subject: 'LOG_BUDGET', dead: '30', current: '100' };
const assistant = (id: string, content: string) =>
  JSON.stringify({ id, role: 'assistant', content, timestamp: '2026-09-18T10:00:00Z' }) + '\n';
const user = (id: string, content: string) => JSON.stringify({ id, role: 'user', content, timestamp: '2026-09-18T09:59:00Z' }) + '\n';

/** A System One server in a function: answers `reasserts` and `cites` as told, and records what it was asked. */
function fakeModel(opts: { reasserts?: number; contradicts?: number; cites?: string; status?: number; body?: string; model?: string } = {}) {
  const seen: Array<{ url: string; auth: string | null; body: any }> = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init!.body));
    seen.push({ url, auth: (init!.headers as Record<string, string>).Authorization ?? null, body });
    if (opts.status && opts.status !== 200) return new Response(opts.body ?? 'nope', { status: opts.status });
    if (opts.body !== undefined) return new Response(opts.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions as Record<string, { type: string; criteria?: unknown }>)) {
      if (q.type === 'noul') answers[name] = { type: 'noul', noul: name === 'reasserts' ? (opts.reasserts ?? 0.9) : (opts.contradicts ?? 0.8) };
      else if (q.type === 'choice') {
        const keys = Object.keys(q.criteria as Record<string, string>);
        const choice = opts.cites ?? keys[0];
        answers[name] = { type: 'choice', choice, confidence: 0.7, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) };
      }
    }
    return new Response(JSON.stringify({ ...(opts.model ? { model: opts.model } : {}), answers, usage: { input_tokens: 10, output_tokens: 0 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, seen };
}

function client(fake: ReturnType<typeof fakeModel>, extra: Partial<ConstructorParameters<typeof DecisionModelClient>[0]> = {}): DecisionModelClient {
  return new DecisionModelClient({ name: 'd1', baseURL: 'http://127.0.0.1:8080', fetch: fake.fetch, ...extra });
}

describe('the decision model client', () => {
  it('sends the System One request, with a bearer token only when it has a key', async () => {
    const fake = fakeModel({ model: 'd1-omni-600M-q8' });
    const result = await client(fake).decide('s', objectionQuestions());
    expect(fake.seen[0].url).toBe('http://127.0.0.1:8080/v1/systemone');
    expect(fake.seen[0].auth).toBeNull();
    expect(fake.seen[0].body).toMatchObject({ model: 'd1-omni-600M', state: 's' });
    expect(result.answers.reasserts).toEqual({ type: 'noul', noul: 0.9 });
    expect(result.model).toBe('d1-omni-600M-q8');
    await client(fake, { apiKey: 'k' }).decide('s', objectionQuestions());
    expect(fake.seen[1].auth).toBe('Bearer k');
  });

  it('is loopback-only unless allowed, needs a key for jev, and validates its options', () => {
    expect(() => new DecisionModelClient({ name: 'endpoint', baseURL: 'https://model.example.com' })).toThrow(/allowRemote/);
    expect(() => new DecisionModelClient({ name: 'endpoint', baseURL: 'https://model.example.com', allowRemote: true })).not.toThrow();
    expect(() => new DecisionModelClient({ name: 'endpoint', baseURL: 'http://model.example.com', allowRemote: true })).toThrow(/https/);
    expect(() => new DecisionModelClient({ name: 'jev', baseURL: 'https://api.typesafe.ai', allowRemote: true })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => new DecisionModelClient({ name: 'd1', baseURL: 'http://127.0.0.1:8080', timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(JSON.stringify(new DecisionModelClient({ name: 'd1', baseURL: 'http://127.0.0.1:8080', apiKey: 'secret-key' }))).not.toContain('secret-key');
  });

  it('maps failures to fixed codes and echoes nothing the server said', async () => {
    for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMITED'], [503, 'HTTP_503']] as const) {
      const err = await client(fakeModel({ status, body: 'secret detail' })).decide('s', objectionQuestions()).catch((e) => e);
      expect(err).toBeInstanceOf(DecisionModelError);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain('secret detail');
    }
    const malformed = await client(fakeModel({ body: '{"answers": {"reasserts": {"type": "noul", "noul": 7}}}' })).decide('s', objectionQuestions()).catch((e) => e);
    expect(malformed.code).toBe('MALFORMED');
    const down = await new DecisionModelClient({ name: 'd1', baseURL: 'http://127.0.0.1:1', fetch: async () => { throw new Error('ECONNREFUSED'); } }).decide('s', objectionQuestions()).catch((e) => e);
    expect(down.code).toBe('NETWORK');
    expect(parseDecisionBody('not json')).toBeNull();
    expect(parseDecisionBody('{"answers": {"x": {"type": "score", "score": 1.5, "probabilities": [0.2, 0.8]}}}')!.answers.x).toMatchObject({ type: 'score', score: 1.5 });
  });

  it('is built from a --decision-model spec', () => {
    expect(decisionModelFromConfig(undefined)).toBeNull();
    expect(decisionModelFromConfig({ spec: 'off' })).toBeNull();
    expect(decisionModelFromConfig({ spec: 'd1' }, {})!.baseURL).toBe('http://127.0.0.1:8080');
    expect(decisionModelFromConfig({ spec: 'd1' }, { STENOGRAPHER_DECISION_MODEL_URL: 'http://localhost:9000' })!.baseURL).toBe('http://localhost:9000');
    expect(decisionModelFromConfig({ spec: 'jev' }, { TYPESAFE_API_KEY: 'k' })!.name).toBe('jev');
    expect(() => decisionModelFromConfig({ spec: 'jev' }, {})).toThrow(/TYPESAFE_API_KEY/);
    expect(decisionModelFromConfig({ spec: 'http://127.0.0.1:7000', model: 'ranker' }, {})!.model).toBe('ranker');
    expect(() => decisionModelFromConfig({ spec: 'magic' }, {})).toThrow(/--decision-model takes/);
  });
});

describe('the state the model is told', () => {
  function ledger(): TruthLedger {
    return new TruthLedger(new Database(':memory:'));
  }

  it('grades entries as the smallchat handoff says, and leaves dead ones out', () => {
    const l = ledger();
    const verified = l.assertTombstone({ claim: 'A is dead', evidence: [{ kind: 'test', ref: 't' }], signedBy: 'kim', literals: [LOG_BUDGET] }, { author: 'kim' });
    const asserted = l.assertTombstone({ claim: 'B is dead', evidence: [{ kind: 'commit', ref: 'c' }], signedBy: 'kim' }, { author: 'kim' });
    const uv = l.assertUv({ assertion: 'C may be dead', basis: 'a hunch', verifyBy: { kind: 'inspect', value: 'src' } }, { author: 'kim' });
    expect(gradeEntry(verified)).toMatchObject({ type: 'TB', grade: 'verified', literals: [LOG_BUDGET] });
    expect(gradeEntry(asserted)!.grade).toBe('asserted');
    expect(gradeEntry(uv)).toMatchObject({ type: 'UV', grade: 'advisory', text: 'C may be dead' });
    expect(gradeEntry({ ...asserted, body: { ...asserted.body, status: 'overridden' } })).toBeNull();
  });

  it('keeps the entry in question first, then best grade, bounds the transcript newest-last, and folds text', () => {
    const l = ledger();
    const a = l.assertTombstone({ claim: 'A is dead', evidence: [{ kind: 'commit', ref: 'c' }], signedBy: 'kim' }, { author: 'kim' });
    const b = l.assertTombstone({ claim: 'B is dead\nreally', evidence: [{ kind: 'test', ref: 't' }], signedBy: 'kim' }, { author: 'kim' });
    const state = buildDecisionState({
      assertion: 'LOG_BUDGET = 30',
      entries: [a, b],
      about: a.id,
      messages: [{ id: 'm3', role: 'assistant', content: 'three' }, { id: 'm2', role: 'user', content: 'two' }, { id: 'm1', role: 'user', content: 'one' }],
      limits: { maxTranscript: 2 },
    });
    expect(state.truth.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(state.truth[1].text).toBe('B is dead really');
    expect(state.transcript.map((t) => t.text)).toEqual(['two', 'three']);
    expect(stateText('x'.repeat(10), 4)).toBe('xxxx');
    const questions = consultQuestions(state.truth);
    expect(Object.keys((questions.cites as { criteria: Record<string, string> }).criteria)).toEqual([a.id, b.id, '__none__']);
    expect(questions.contradicts.instructions).toMatch(/untrusted/);
  });

  it('grades a reassertion verdict against a ruling', () => {
    expect(gradeReassertion(0.9, 'sustained')).toBe('rewarded');
    expect(gradeReassertion(0.9, 'overruled')).toBe('corrected');
    expect(gradeReassertion(0.2, 'overruled')).toBe('rewarded');
    expect(gradeReassertion(null, 'sustained')).toBeNull();
  });
});

describe('the adviser in the engine', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function liveEngine(overrides: Partial<StenographerConfig> = {}): Promise<{ engine: Stenographer; log: string; state: string }> {
    dir = mkdtempSync(join(tmpdir(), 'steno-decision-'));
    const log = join(dir, 'log.jsonl');
    const state = join(dir, 'state.db');
    writeFileSync(log, '');
    engine = new Stenographer({ logPath: log, statePath: state, mode: 'live', embeddingModel: 'hashed', objectionMode: 'deliver', ...overrides });
    await engine.start();
    return { engine, log, state };
  }

  async function settle(e: Stenographer): Promise<void> {
    await new Promise((r) => setTimeout(r, 300));
    await e.flush();
  }

  async function budgetTb(e: Stenographer) {
    return e.assertTombstone({ claim: 'LOG_BUDGET 30 is dead; the budget is 100', evidence: [{ kind: 'commit', ref: 'a1b2c3' }], signedBy: 'johnnyclem', literals: [LOG_BUDGET] });
  }

  it('asks the model about each objection with the tombstone and the transcript, and a ruling grades the verdict', async () => {
    const fake = fakeModel({ reasserts: 0.92 });
    const { engine: e, log, state } = await liveEngine({ decisionModel: client(fake) });
    const tb = await budgetTb(e);
    appendFileSync(log, user('u1', 'what should the budget be?') + assistant('a1', 'Plan: set LOG_BUDGET = 30 so the logs stay small.'));
    await settle(e);

    const [flag] = await e.getObjections();
    expect(flag.advice).toMatchObject({ kind: 'objection', subjectId: flag.id, adviser: 'd1', reasserts: 0.92, grade: null, error: null });
    const asked = fake.seen[0].body;
    expect(asked.state.assertion).toBe('Plan: set LOG_BUDGET = 30 so the logs stay small.');
    expect(asked.state.truth[0]).toMatchObject({ id: tb.id, type: 'TB', grade: 'asserted', literals: [LOG_BUDGET] });
    expect(asked.state.transcript.map((t: { id: string }) => t.id)).toEqual(['u1', 'a1']);
    expect(asked.questions.reasserts.type).toBe('noul');
    expect(await e.getDecisionModelStats()).toMatchObject({ adviser: 'd1', objections: 1, graded: 0, accuracy: null });

    // The person agrees: rewarded
    const { objection } = await e.ruleOnObjection(flag.id, 'sustained', { author: 'johnnyclem', opinion: 'Budget is 100.' });
    expect(objection.advice).toMatchObject({ grade: 'rewarded', truth: 'sustained' });
    expect(objection.advice!.rulingId).toBe(objection.rulingId);
    expect(await e.getDecisionModelStats()).toMatchObject({ graded: 1, rewarded: 1, corrected: 0, accuracy: 1 });

    // A second objection the model gets wrong: corrected
    appendFileSync(log, assistant('a2', 'reverting to LOG_BUDGET = 30'));
    await settle(e);
    const second = (await e.getObjections()).find((o) => o.messageId === 'a2')!;
    await e.ruleOnObjection(second.id, 'overruled', { author: 'johnnyclem', opinion: 'A fixture; immaterial.' });
    expect(await e.getDecisionModelStats()).toMatchObject({ graded: 2, rewarded: 1, corrected: 1, accuracy: 0.5 });
    const graded = await e.listDecisionAdvice({ graded: true });
    expect(graded.map((a) => a.grade)).toEqual(['rewarded', 'corrected']);

    // The export carries state, questions, answers and the ruling's truth
    const adviser = e.getDecisionAdviser()!;
    const rows = adviser.export();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ grade: 'corrected', truth: { reasserts: false }, answers: { reasserts: { noul: 0.92 } } });
    expect(rows[1].state.assertion).toBe('reverting to LOG_BUDGET = 30');

    // The advice command reads the same file
    e.stop();
    engine = null;
    const lines: string[] = [];
    const exportPath = join(dir, 'advice.jsonl');
    expect(await runAdviceCLI([state, '--export', exportPath], (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toMatch(/graded by a person: 2 {3}rewarded: 1 {3}corrected: 1 {3}accuracy: 50%/);
    expect(readFileSync(exportPath, 'utf8').trim().split('\n')).toHaveLength(2);
    const json: string[] = [];
    expect(await runAdviceCLI([state, '--json'], (l) => json.push(l))).toBe(0);
    expect(JSON.parse(json.join('')).stats.graded).toBe(2);
  });

  it('a model that is down records its error; the objection stands and nothing is graded', async () => {
    const down = new DecisionModelClient({ name: 'd1', baseURL: 'http://127.0.0.1:1', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    const { engine: e, log } = await liveEngine({ decisionModel: down });
    await budgetTb(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    const [flag] = await e.getObjections();
    expect(flag.status).toBe('pending');
    expect(flag.advice).toMatchObject({ error: 'NETWORK', reasserts: null });
    await e.ruleOnObjection(flag.id, 'sustained', { author: 'johnnyclem', opinion: 'Yes.' });
    expect(await e.getDecisionModelStats()).toMatchObject({ errors: 1, graded: 0 });
  });

  it('without a model nothing is asked, objections carry no advice, and a consult is refused', async () => {
    const { engine: e, log } = await liveEngine();
    await budgetTb(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    const [flag] = await e.getObjections();
    expect(flag.advice).toBeUndefined();
    expect(await e.getDecisionModelStats()).toBeNull();
    expect(e.getDecisionAdviser()).toBeNull();
    await expect(e.consultDecisionModel({ assertion: 'LOG_BUDGET = 30' })).rejects.toThrow(/--decision-model/);
    expect(await e.listDecisionAdvice()).toEqual([]);
  });

  it('a consult offers the entries that bear on the assertion and records the verdict', async () => {
    const fake = fakeModel({ contradicts: 0.85 });
    const { engine: e } = await liveEngine({ decisionModel: client(fake) });
    const tb = await budgetTb(e);
    const verdict = await e.consultDecisionModel({ assertion: 'I will set LOG_BUDGET to 30', k: 4 });
    expect(verdict).toMatchObject({ adviser: 'd1', contradicts: 0.85, cites: tb.id, error: null });
    expect(verdict.entries.map((x) => x.id)).toEqual([tb.id]);
    expect(fake.seen[0].body.questions.cites.criteria).toHaveProperty(tb.id);
    expect(await e.listDecisionAdvice({ kind: 'consult' })).toHaveLength(1);
    expect((await e.getDecisionModelStats())!.consults).toBe(1);
    const abstaining = await e.consultDecisionModel({ assertion: 'unrelated', subjectId: 'c2' });
    expect(abstaining.cites).toBe(tb.id);
  });

  it('a bad --decision-model spec fails at startup', () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-decision-'));
    expect(() => new Stenographer({ logPath: join(dir, 'l.jsonl'), statePath: ':memory:', mode: 'live', embeddingModel: 'hashed', decisionModel: { spec: 'magic' } })).toThrow(/--decision-model/);
    expect(() => new Stenographer({ logPath: join(dir, 'l.jsonl'), statePath: ':memory:', mode: 'live', embeddingModel: 'hashed', decisionModel: { spec: 'https://model.example.com' } })).toThrow(/allowRemote/);
  });

  it('serves the verdicts and a consult over REST', async () => {
    const fake = fakeModel({ reasserts: 0.3, contradicts: 0.6 });
    const { engine: e, log } = await liveEngine({ decisionModel: client(fake), restPort: 0, restInsecure: true });
    const tb = await budgetTb(e);
    appendFileSync(log, assistant('a1', 'LOG_BUDGET = 30'));
    await settle(e);
    const base = `http://127.0.0.1:${e.restPort}`;
    const stats = await (await fetch(`${base}/advice/stats`)).json();
    expect(stats).toMatchObject({ adviser: 'd1', objections: 1 });
    const advice = await (await fetch(`${base}/advice?kind=objection`)).json();
    expect(advice).toHaveLength(1);
    expect(advice[0].reasserts).toBe(0.3);
    const consult = await fetch(`${base}/advice/consult`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assertion: 'LOG_BUDGET = 30' }) });
    expect(consult.status).toBe(200);
    expect(await consult.json()).toMatchObject({ contradicts: 0.6, cites: tb.id });
    const bad = await fetch(`${base}/advice/consult`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: 1 }) });
    expect(bad.status).toBe(400);
  });

  it('the advice command on a state file no model ever touched says so', async () => {
    const { engine: e, state } = await liveEngine();
    await budgetTb(e);
    e.stop();
    engine = null;
    const lines: string[] = [];
    expect(await runAdviceCLI([state], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toMatch(/No decision model/);
    expect(await runAdviceCLI([join(dir, 'missing.db')])).toBe(2);
  });
});

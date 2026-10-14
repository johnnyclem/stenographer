/**
 * PRD phase C: promotion, approvals and answerability (R5), the review
 * session (R9) and the suspicion detector (R4).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TruthLedger, ContemptError, TruthWriteError } from '../src/truth/ledger.js';
import { UvApprovals } from '../src/truth/approvals.js';
import { UvAttestations } from '../src/truth/attestations.js';
import { buildDocket, formatDocketItem, lexicalPassages } from '../src/truth/docket.js';
import { detectSuspects, triggersSuspicion, DERIVATION_DETECTOR, INFERENCE_AT_FAULT } from '../src/truth/suspicion.js';
import { runReviewCLI, parseEvidenceLines } from '../src/truth/review-cli.js';
import { exportWikiEntries, importWikiEntries } from '../src/truth/wiki.js';
import { StateStore } from '../src/store/index.js';
import { Stenographer } from '../src/core/stenographer.js';
import { StenographerServer } from '../src/mcp/server.js';
import { markerFor } from '../src/truth/format.js';
import { REPORTER_IDENTITY, type ProposalEntry, type TbEntry, type UvEntry } from '../src/truth/types.js';
import type { NotaryIO } from '../src/truth/notary-cli.js';
import type { StenographerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const COMMIT = { kind: 'commit' as const, ref: 'a1b2c3', detail: 'config.ts sets LOG_BUDGET = 100' };
const FILE = { kind: 'file' as const, ref: 'config.ts:3', detail: 'LOG_BUDGET = 100' };
const TEST = { kind: 'test' as const, ref: 'test/config.test.ts', detail: 'LOG_BUDGET is 100' };
const AGENT = 'agent:claude-code';

/** A ledger with approvals and attestations on one in-memory database. */
function fresh() {
  const db = new Database(':memory:');
  const ledger = new TruthLedger(db);
  const approvals = new UvApprovals(db, ledger);
  const attestations = new UvAttestations(db, ledger);
  const uv = (over: Partial<{ author: string; agentSessionId: string | null; contests: string; timestamp: string }> = {}) =>
    ledger.assertUv(
      { assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' }, ...(over.contests ? { contests: over.contests } : {}) },
      { author: over.author ?? 'agent:researcher', agentSessionId: over.agentSessionId ?? 'sess-u', timestamp: over.timestamp ?? at(0) }
    );
  const personTb = () =>
    ledger.assertTombstone(
      { claim: 'LOG_BUDGET 30 is dead; the budget is 100', evidence: [COMMIT], signedBy: 'johnnyclem', literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }] },
      { author: 'johnnyclem', timestamp: at(0) }
    );
  return { db, ledger, approvals, attestations, uv, personTb };
}

describe('R5: approvals, promotion and answerability', () => {
  it('a UV with one agent approval and one human approval becomes a TB with answerableBy set to the human', () => {
    const { ledger, approvals, uv } = fresh();
    const target = uv();
    const agent = approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0 + MIN);
    expect(agent.status).toBe('approved');
    expect((agent as { approvals: { missing: string[] } }).approvals.missing).toEqual(['a human approval', 'a second approver']);
    const human = approvals.approve({ uvId: target.id, by: 'johnnyclem', role: 'human', note: 'checked it' }, T0 + 2 * MIN);
    expect(human.status).toBe('promoted');
    const { tombstone, addendum, ruling } = human as { tombstone: TbEntry; addendum: { body: { evidence: unknown[] } }; ruling: { body: { kind: string; answerableBy?: string } } | null };
    expect(tombstone.body).toMatchObject({
      claim: target.body.assertion,
      signedBy: 'johnnyclem',
      answerableBy: 'johnnyclem',
      status: 'active',
      evidence: [COMMIT],
      approvals: [
        { by: AGENT, role: 'agent', ts: at(MIN), agentSessionId: 'sess-a' },
        { by: 'johnnyclem', role: 'human', ts: at(2 * MIN) },
      ],
    });
    expect(tombstone.author).toBe('johnnyclem');
    expect(tombstone.links).toContainEqual({ fromId: tombstone.id, toId: target.id, type: 'supersedes' });
    expect(addendum.body.evidence).toEqual([COMMIT]);
    expect(ruling!.body).toMatchObject({ kind: 'promotion', answerableBy: 'johnnyclem' });
    expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('verified');
    expect(approvals.list(target.id).map((a) => a.consumedBy)).toEqual([tombstone.id, tombstone.id]);
    expect(ledger.verify().ok).toBe(true);
  });

  it('three agent approvals write a nomination, leave the UV open, and put it first on the docket', () => {
    const { ledger, approvals, attestations, uv } = fresh();
    const older = uv({ timestamp: at(-MIN) });
    const target = uv();
    approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0 + MIN);
    approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-b', evidence: [FILE] }, T0 + 2 * MIN);
    const third = approvals.approve({ uvId: target.id, by: 'agent:codex', role: 'agent', agentSessionId: 'sess-c', evidence: [TEST] }, T0 + 3 * 24 * 60 * MIN);
    expect(third.status).toBe('nominated');
    const nominated = ledger.getEntry(target.id) as UvEntry;
    expect(nominated.body.status).toBe('open');
    expect(nominated.corroborated).toBe(true);
    expect(markerFor('UV', 'open', 'sound', nominated.corroborated)).toBe('[UV · CORROBORATED]');
    const { addendum } = third as { addendum: { author: string; links: unknown[]; body: { quorum: Array<{ agentSessionId: string; verdict: string }> } } };
    expect(addendum.author).toBe('agent:codex');
    expect(addendum.links).toEqual([{ fromId: (addendum as { id: string }).id, toId: target.id, type: 'corroborates' }]);
    expect(addendum.body.quorum.map((m) => [m.agentSessionId, m.verdict])).toEqual([['sess-a', 'verified'], ['sess-b', 'verified'], ['sess-c', 'verified']]);
    // Nominated first, before an older item
    const docket = buildDocket({ ledger, approvals, attestations }, T0 + 4 * 24 * 60 * MIN);
    expect(docket.groups.map((g) => g.items.map((i) => [i.id, i.nominated]))).toEqual([[[target.id, true]], [[older.id, false]]]);
    expect(docket.nominated).toBe(1);
    expect(docket.oldest).toMatchObject({ id: older.id });
    // A fourth agent nominates nothing twice, and still promotes nothing
    const fourth = approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-d', evidence: [{ kind: 'claimed-command', ref: 'grep LOG_BUDGET config.ts' }] }, T0 + 5 * MIN);
    expect(fourth.status).toBe('approved');
    expect(ledger.getChainedRecords().filter((r) => r.type === 'ADDENDUM')).toHaveLength(1);
    expect(ledger.getStats().tombstones).toBe(0);
    expect(ledger.verify().ok).toBe(true);
  });

  it('a reporter approval with no citation is refused, and one that cites the record never counts as the human', () => {
    const store = new StateStore(':memory:');
    try {
      const { truth: ledger, approvals } = store;
      const target = ledger.assertUv({ assertion: 'The cache is shared.', basis: 'a trace', verifyBy: { kind: 'ask', value: 'ops' } }, { author: 'agent:researcher', agentSessionId: 'sess-u' });
      expect(() => approvals.approve({ uvId: target.id, by: REPORTER_IDENTITY, role: 'reporter' }, T0)).toThrow(/citing passages of the indexed record/);
      expect(() => approvals.approve({ uvId: target.id, by: REPORTER_IDENTITY, role: 'reporter', cites: ['msg-404'] }, T0)).toThrow(/message msg-404, which the record doesn't hold/);
      expect(() => approvals.approve({ uvId: target.id, by: 'kim', role: 'reporter', cites: ['msg-1'] }, T0)).toThrow(/the reporter's approval is 'stenographer's/);
      store.addMessage({
        id: 'msg-1',
        sessionId: 'sess-x',
        role: 'assistant',
        content: 'The cache is shared between the workers, see cache.ts',
        timestamp: at(0),
        embedding: [],
        importanceScore: { total: 0.5, stateDelta: 0.5, referenceFrequency: 0, trajectoryDiscontinuity: 0 },
        entityIds: [],
      });
      const cited = approvals.approve({ uvId: target.id, by: REPORTER_IDENTITY, role: 'reporter', cites: ['msg-1'] }, T0);
      expect(cited.status).toBe('approved');
      expect((cited as { approvals: { human: boolean; reporter: boolean; missing: string[] } }).approvals).toMatchObject({ human: false, reporter: true, missing: ['a human approval', 'a second approver'] });
      // The person's approval completes it: the TB carries the reporter's citation
      const promoted = approvals.approve({ uvId: target.id, by: 'johnnyclem', role: 'human' }, T0 + MIN);
      expect(promoted.status).toBe('promoted');
      const tb = (promoted as { tombstone: TbEntry }).tombstone;
      expect(tb.body.approvals).toEqual([
        { by: REPORTER_IDENTITY, role: 'reporter', ts: at(0), cites: ['msg-1'] },
        { by: 'johnnyclem', role: 'human', ts: at(MIN) },
      ]);
      expect(tb.body.evidence).toEqual([{ kind: 'message', ref: 'msg-1', detail: 'a passage of the indexed record' }]);
    } finally {
      store.close();
    }
  });

  it('a person cannot be the second approver of their own draft, and one session or identity approves once', () => {
    const { approvals, uv } = fresh();
    const own = uv({ author: 'johnnyclem', agentSessionId: null });
    expect(() => approvals.approve({ uvId: own.id, by: 'johnnyclem', role: 'human' }, T0)).toThrow(ContemptError);
    expect(() => approvals.approve({ uvId: own.id, by: 'JohnnyClem', role: 'human' }, T0)).toThrow(/cannot approve/);
    // The agent whose session asserted it can't approve it either
    const theirs = uv({ author: AGENT, agentSessionId: 'sess-a' });
    expect(() => approvals.approve({ uvId: theirs.id, by: 'agent:codex', role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0)).toThrow(/same agent session/);
    expect(approvals.list(theirs.id)).toEqual([]);
    const target = uv();
    approvals.approve({ uvId: target.id, by: 'kim', role: 'human' }, T0);
    expect(() => approvals.approve({ uvId: target.id, by: ' KIM ', role: 'human' }, T0 + 1)).toThrow(/already approved/);
    approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0 + 2);
  });

  it('roles are checked: a person is not an agent, an agent names its session and settling evidence, and nothing is approved on a dead UV', () => {
    const { ledger, approvals, uv } = fresh();
    const target = uv();
    expect(() => approvals.approve({ uvId: target.id, by: AGENT, role: 'human' }, T0)).toThrow(/is an agent/);
    expect(() => approvals.approve({ uvId: target.id, by: 'kim', role: 'agent', agentSessionId: 'sess-k', evidence: [COMMIT] }, T0)).toThrow(/is not an agent/);
    expect(() => approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', evidence: [COMMIT] }, T0)).toThrow(/names its session/);
    expect(() => approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [{ kind: 'chat', ref: 'slack:C01' }] }, T0)).toThrow(/settling evidence of its own/);
    expect(() => approvals.approve({ uvId: target.id, by: 'kim', role: 'judge' as 'human' }, T0)).toThrow(/human, agent or reporter/);
    ledger.resolveUv(target.id, 'refuted', [FILE], { author: 'kim', timestamp: at(MIN) });
    expect(() => approvals.approve({ uvId: target.id, by: 'sam', role: 'human' }, T0 + 2 * MIN)).toThrow(/already refuted/);
    expect(() => approvals.approve({ uvId: 'nope', by: 'sam', role: 'human' }, T0)).toThrow(/no such UV/);
  });

  it('two people with no evidence between them wait for something to cite; the next approval with evidence promotes', () => {
    const { approvals, uv } = fresh();
    const target = uv();
    approvals.approve({ uvId: target.id, by: 'kim', role: 'human' }, T0);
    const second = approvals.approve({ uvId: target.id, by: 'sam', role: 'human' }, T0 + MIN);
    expect(second.status).toBe('approved');
    expect((second as { approvals: { missing: string[] } }).approvals.missing).toEqual(['evidence']);
    const third = approvals.approve({ uvId: target.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [TEST] }, T0 + 2 * MIN);
    expect(third.status).toBe('promoted');
    // The latest human signs and answers
    expect((third as { tombstone: TbEntry }).tombstone.body).toMatchObject({ signedBy: 'sam', answerableBy: 'sam', evidence: [TEST] });
  });

  it("a person's approval of an appeal overrides the TB; a promoted derived UV keeps its premises", () => {
    const { ledger, approvals, uv, personTb } = fresh();
    const tb = personTb();
    const appeal = uv({ contests: tb.id });
    approvals.approve({ uvId: appeal.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [TEST] }, T0 + MIN);
    const promoted = approvals.approve({ uvId: appeal.id, by: 'kim', role: 'human' }, T0 + 2 * MIN);
    expect(promoted.status).toBe('promoted');
    expect((ledger.getEntry(tb.id) as TbEntry).body.status).toBe('overridden');
    const successor = (promoted as { tombstone: TbEntry }).tombstone;
    expect(successor.links.filter((l) => l.type === 'supersedes').map((l) => l.toId).sort()).toEqual([tb.id, appeal.id].sort());

    const root = ledger.assertTombstone({ claim: 'The budget is 100.', evidence: [COMMIT], signedBy: 'johnnyclem' }, { author: 'johnnyclem', timestamp: at(0) });
    const derived = ledger.assertUv(
      { assertion: 'The per-tenant budget is 100.', basis: 'the budget is global', verifyBy: { kind: 'inspect', value: 'src/budget.ts' }, premises: [{ id: root.id, contentHash: root.contentHash! }], inference: 'A global budget binds each tenant.' },
      { author: 'agent:researcher', agentSessionId: 'sess-u', timestamp: at(0) }
    );
    approvals.approve({ uvId: derived.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [FILE] }, T0 + MIN);
    const tb2 = (approvals.approve({ uvId: derived.id, by: 'kim', role: 'human' }, T0 + 2 * MIN) as { tombstone: TbEntry }).tombstone;
    expect(tb2.body.inference).toBe('A global budget binds each tenant.');
    expect(tb2.links).toContainEqual({ fromId: tb2.id, toId: root.id, type: 'derives', contentHash: root.contentHash });
    expect(tb2.standing).toBe('sound');
    expect(ledger.verify().ok).toBe(true);
  });

  it('a TB a person asserts directly, a notarized draft and a contempt TB are answered for by that person; rulings by their author', () => {
    const { ledger } = fresh();
    const tb = ledger.assertTombstone({ claim: 'x is dead', evidence: [COMMIT], signedBy: 'kim' }, { author: 'kim', timestamp: at(0) });
    expect(tb.body.answerableBy).toBe('kim');
    const draft = ledger.draftTombstone({ claim: 'y is dead', evidence: [FILE] }, { author: AGENT, agentSessionId: 'sess-a', timestamp: at(0) });
    const signed = ledger.signProposal(draft.id, 'sam', undefined, { notarized: true, timestamp: at(MIN) }) as TbEntry;
    expect(signed.body.answerableBy).toBe('sam');
    const { ruling, conductTombstone } = ledger.fileRuling({ kind: 'contempt', opinion: 'three hats', target: 'agent:x' }, { author: 'johnnyclem', timestamp: at(2 * MIN) });
    expect(ruling.body.answerableBy).toBe('johnnyclem');
    expect(conductTombstone!.body.answerableBy).toBe('johnnyclem');
    // On the wire: top-level fields; a reader keeps them, and the lines travel
    const lines = exportWikiEntries(ledger).lines.map((l) => JSON.parse(l));
    expect(lines.find((l) => l.id === tb.id).answerableBy).toBe('kim');
    const other = new TruthLedger(new Database(':memory:'));
    expect(importWikiEntries(other, { lines: exportWikiEntries(ledger).lines })).toMatchObject({ committed: true, proposals: [], held: [] });
    expect((other.getEntry(signed.id) as TbEntry).body.answerableBy).toBe('sam');
  });
});

describe('R4: the suspicion detector', () => {
  const derivedStory = () => {
    const { ledger, approvals, attestations } = fresh();
    const y = ledger.assertTombstone({ claim: 'The retry budget is 100.', evidence: [COMMIT], signedBy: 'johnnyclem' }, { author: 'johnnyclem', timestamp: at(0) });
    const z = ledger.assertTombstone(
      { claim: 'Each retry costs 20.', evidence: [{ kind: 'file', ref: 'pricing.md:4' }], signedBy: 'johnnyclem', premises: [{ id: y.id, contentHash: y.contentHash! }], inference: 'The pricing doc prices one retry against the budget.' },
      { author: 'johnnyclem', timestamp: at(MIN) }
    );
    const x = ledger.assertTombstone(
      {
        claim: 'Retries are capped at 5; the old cap of 3 is dead.',
        evidence: [TEST],
        signedBy: 'johnnyclem',
        literals: [{ subject: 'MAX_RETRIES', dead: '3', current: '5' }],
        premises: [{ id: y.id, contentHash: y.contentHash! }, { id: z.id, contentHash: z.contentHash! }],
        inference: 'The budget divided by the cost.',
      },
      { author: 'johnnyclem', timestamp: at(2 * MIN) }
    );
    return { ledger, approvals, attestations, x, y, z };
  };

  it('X derived from Y and Z, refuted with a commit: two ranked proposals, a derived TB before an observed root', () => {
    const { ledger, x, y, z } = derivedStory();
    const { suspects } = ledger.overrideTombstone(x.id, { evidence: [{ kind: 'commit', ref: 'd4e5f6', detail: 'MAX_RETRIES = 7' }] }, { author: 'kim', timestamp: at(3 * MIN) });
    expect(suspects.map((p) => (p.body.draft as { contests: string }).contests)).toEqual([z.id, y.id]);
    expect(suspects.map((p) => p.body.signal.detail)).toEqual([
      `rank 1 of 2; a derived TB; co-suspects: ${y.id}`,
      `rank 2 of 2; an observed root; co-suspects: ${z.id}`,
    ]);
    for (const p of suspects) {
      expect(p).toMatchObject({ author: DERIVATION_DETECTOR, body: { kind: 'uv', status: 'open', requiresNotary: false, signal: { source: 'detector:derivation' } } });
      expect(p.body.targetRef).toBe(`derivation:${x.id}:${(p.body.draft as { contests: string }).contests}`);
      expect((p.body.draft as { assertion: string }).assertion).toMatch(/may be wrong: TB .* was derived from it and was overridden on commit d4e5f6/);
    }
    // The premises are not under appeal until a person signs a contest: proposals are not truth
    expect((ledger.getEntry(y.id) as TbEntry).body.status).toBe('active');
    // Signing one puts the premise under appeal; dismissing the other as inference-at-fault closes it; neither is raised twice
    const signed = ledger.signProposal(suspects[0].id, 'kim', undefined, { timestamp: at(4 * MIN) }) as UvEntry;
    expect(signed.body.contests).toBe(z.id);
    expect((ledger.getEntry(z.id) as TbEntry).body.status).toBe('contested');
    ledger.dismissProposal(suspects[1].id, 'kim', INFERENCE_AT_FAULT, { timestamp: at(4 * MIN) });
    expect(ledger.listProposals('open')).toEqual([]);
    expect(ledger.verify().ok).toBe(true);
  });

  it('the same refutation citing only wiki evidence files nothing; one premise is the sole suspect; a UV premise goes first in the queue', async () => {
    const quiet = derivedStory();
    const other = quiet.ledger.assertTombstone({ claim: 'Something else.', evidence: [COMMIT], signedBy: 'kim' }, { author: 'kim', timestamp: at(0) });
    expect(quiet.ledger.overrideTombstone(quiet.x.id, { evidence: [{ kind: 'wiki', ref: other.id }] }, { author: 'kim', timestamp: at(3 * MIN) }).suspects).toEqual([]);
    expect(quiet.ledger.listProposals('open')).toEqual([]);

    // One premise: sole-suspect. A UV premise gets no proposal, and is flagged in the queue instead.
    const { ledger, y } = derivedStory();
    const open = ledger.assertUv({ assertion: 'The cost is per call.', basis: 'a guess', verifyBy: { kind: 'ask', value: 'ops' } }, { author: 'sam', timestamp: at(0) });
    const w = ledger.assertUv(
      { assertion: 'Calls are capped at 4.', basis: 'the cost', verifyBy: { kind: 'inspect', value: 'src/calls.ts' }, premises: [{ id: y.id, contentHash: y.contentHash! }, { id: open.id, contentHash: open.contentHash! }], inference: 'Budget over cost.' },
      { author: 'sam', timestamp: at(MIN) }
    );
    const { suspects } = ledger.resolveUv(w.id, 'refuted', [{ kind: 'test', ref: 'test/calls.test.ts' }], { author: 'kim', timestamp: at(4 * MIN) });
    expect(suspects).toHaveLength(1);
    expect(suspects[0].body.signal.detail).toBe('sole-suspect; an observed root');
    expect(suspects[0].body.targetRef).toBe(`derivation:${w.id}:${y.id}`);
    expect(ledger.suspectUvs()).toEqual(new Set([open.id]));

    const dir = mkdtempSync(join(tmpdir(), 'steno-review-'));
    try {
      writeFileSync(join(dir, 'log.jsonl'), '');
      const engine = new Stenographer({ logPath: join(dir, 'log.jsonl'), statePath: join(dir, 'state.db'), mode: 'catchup', embeddingModel: 'hashed' });
      await engine.start();
      try {
        const store = engine.store.truth;
        const older = store.assertUv({ assertion: 'An older open UV.', basis: 'x', verifyBy: { kind: 'inspect', value: 'a' } }, { author: 'sam', timestamp: at(0) });
        const premise = store.assertUv({ assertion: 'A premise.', basis: 'x', verifyBy: { kind: 'inspect', value: 'b' } }, { author: 'sam', timestamp: at(MIN) });
        const dependent = store.assertUv(
          { assertion: 'Rests on the premise.', basis: 'x', verifyBy: { kind: 'inspect', value: 'c' }, premises: [{ id: premise.id, contentHash: premise.contentHash! }], inference: 'Follows.' },
          { author: 'sam', timestamp: at(2 * MIN) }
        );
        await engine.resolveUv(dependent.id, 'refuted', [TEST], { author: 'kim' });
        const queue = await engine.getVerificationQueue();
        expect(queue.map((u) => [u.id, u.queueRank.suspect])).toEqual([[premise.id, true], [older.id, false]]);
      } finally {
        engine.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a premise shared by two falsified entries ranks first; the trigger fires again one level down, and an imported refutation runs it here', () => {
    const { ledger, x, y, z } = derivedStory();
    const v = ledger.assertTombstone(
      { claim: 'The budget covers five retries.', evidence: [{ kind: 'file', ref: 'docs/retries.md' }], signedBy: 'johnnyclem', premises: [{ id: y.id, contentHash: y.contentHash! }], inference: 'Five times twenty.' },
      { author: 'johnnyclem', timestamp: at(2 * MIN) }
    );
    ledger.overrideTombstone(v.id, { evidence: [{ kind: 'commit', ref: 'f00d123' }] }, { author: 'kim', timestamp: at(3 * MIN) });
    const { suspects } = ledger.overrideTombstone(x.id, { evidence: [{ kind: 'commit', ref: 'd4e5f6' }] }, { author: 'kim', timestamp: at(4 * MIN) });
    // y is shared by v and x: first, before the derived z
    expect(suspects.map((p) => (p.body.draft as { contests: string }).contests)).toEqual([y.id, z.id]);
    expect(suspects[0].body.signal.detail).toMatch(new RegExp(`rank 1 of 2; shared by 2 falsified entries \\(${x.id}, ${v.id}\\)`));
    // One level only: nothing is filed against y's own premises until z itself falls
    expect(ledger.listProposals('open').map((p) => p.body.targetRef).sort()).toEqual([`derivation:${v.id}:${y.id}`, `derivation:${x.id}:${y.id}`, `derivation:${x.id}:${z.id}`].sort());
    const appeal = ledger.signProposal(suspects[1].id, 'kim', undefined, { timestamp: at(5 * MIN) }) as UvEntry;
    const fired = ledger.resolveUv(appeal.id, 'verified', [{ kind: 'test', ref: 'test/pricing.test.ts' }], { author: 'sam', signedBy: 'sam', timestamp: at(6 * MIN) });
    expect((ledger.getEntry(z.id) as TbEntry).body.status).toBe('overridden');
    // z fell: its premise y is already under review from x's fall, so nothing new is filed for that pair
    expect(fired.suspects.map((p) => p.body.targetRef)).toEqual([`derivation:${z.id}:${y.id}`]);

    // A teammate's refutation, imported, runs the detector here: proposals never travel
    const theirs = new TruthLedger(new Database(':memory:'));
    const lines = exportWikiEntries(ledger).lines;
    const result = importWikiEntries(theirs, { lines });
    expect(result.committed).toBe(true);
    expect(result.suspicions.map((s) => s.premise)).toContain(y.id);
    expect(theirs.listProposals('open').every((p) => p.author === DERIVATION_DETECTOR)).toBe(true);
    expect(theirs.verify().ok).toBe(true);
  });

  it('is a pure function in the codec: entries and links in, ranked drafts out', () => {
    expect(triggersSuspicion([{ kind: 'wiki', ref: 'x' }, { kind: 'message', ref: 'm' }])).toBe(false);
    expect(triggersSuspicion([{ kind: 'wiki', ref: 'x' }, { kind: 'claimed-command', ref: 'ls' }])).toBe(true);
    const premise = (id: string, over: Partial<Parameters<typeof detectSuspects>[0]['premises'][number]> = {}) => ({ id, type: 'TB', status: 'active', struck: false, derived: false, text: id, sharedWith: [], ...over });
    const out = detectSuspects({
      falsified: { id: 'X', type: 'TB', text: 'x', outcome: 'refuted' },
      evidence: [{ kind: 'commit', ref: 'abc' }],
      premises: [premise('root'), premise('derived', { derived: true }), premise('shared', { sharedWith: ['W'] }), premise('dead', { status: 'overridden' }), premise('uv', { type: 'UV', status: 'open' }), premise('fiat', { type: 'RULING' })],
    });
    expect(out.proposals.map((p) => [p.premise, p.rank, p.because])).toEqual([['shared', 1, 'shared'], ['derived', 2, 'derived'], ['root', 3, 'root']]);
    expect(out.suspectUvs).toEqual(['uv']);
    expect(out.proposals[0].draft.contests).toBe('shared');
  });
});

describe('R9: the review docket and session', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function fakeIO(answers: string[], interactive = true) {
    const printed: string[] = [];
    const questions: string[] = [];
    let i = 0;
    const io: NotaryIO = {
      interactive,
      print: (line) => printed.push(line),
      ask: async (question) => {
        questions.push(question);
        const code = question.match(/type the code ([0-9A-Z]+)/);
        if (code) return code[1];
        return answers[i++] ?? '';
      },
    };
    return { io, printed, questions };
  }

  it('a scripted session: a UV with one agent approval is approved and becomes a TB; an appeal is refuted and its TB returns to active; a deferred item stays', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-review-'));
    const statePath = join(dir, 'state.db');
    const store = new StateStore(statePath);
    const uv = store.truth.assertUv({ assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' } }, { author: 'agent:researcher', agentSessionId: 'sess-u', timestamp: at(0) });
    store.approvals.approve({ uvId: uv.id, by: AGENT, role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0 + MIN);
    const tb = store.truth.assertTombstone({ claim: 'fetchV1 is dead.', evidence: [COMMIT], signedBy: 'kim', literals: [{ dead: 'fetchV1' }] }, { author: 'kim', timestamp: at(0) });
    const appeal = store.truth.assertUv({ assertion: 'fetchV1 is still called.', basis: 'a trace', verifyBy: { kind: 'command', value: 'grep fetchV1' }, contests: tb.id }, { author: 'sam', timestamp: at(2 * MIN) });
    const deferred = store.truth.assertUv({ assertion: 'Exports run hourly.', basis: 'the cron table', verifyBy: { kind: 'inspect', value: 'cron.d/export' } }, { author: 'sam', timestamp: at(3 * MIN) });
    store.addMessage({
      id: 'msg-7',
      sessionId: 'sess-x',
      role: 'assistant',
      content: 'LOG_BUDGET is 100 everywhere now, config.ts was bumped',
      timestamp: at(0),
      embedding: [],
      importanceScore: { total: 0.5, stateDelta: 0.5, referenceFrequency: 0, trajectoryDiscontinuity: 0 },
      entityIds: [],
    });
    store.close();

    // Without --as: the docket is printed, nothing is written
    const listing = fakeIO([]);
    expect(await runReviewCLI(['--state', statePath], listing.io, () => T0 + 10 * MIN)).toBe(0);
    expect(listing.printed.join('\n')).toMatch(/3 items on the docket \(0 nominated\), oldest 10m old/);
    expect(listing.printed.join('\n')).toMatch(/from the record:\n\s+msg-7/);
    expect(listing.questions).toEqual([]);

    // Not a terminal: refused before anything is shown for ruling
    await expect(runReviewCLI(['--state', statePath, '--as', 'johnnyclem'], fakeIO([], false).io, () => T0)).rejects.toThrow(/interactive terminal/);

    // Ordered oldest first: the UV (approve, citing the passage shown as evidence), the appeal (refute), the deferred item
    const session = fakeIO(['a', '', 'y', 'the config change is in', 'r', 'test test/fetch.test.ts no caller left', '', 'callers are gone', 'd']);
    expect(await runReviewCLI(['--state', statePath, '--as', 'johnnyclem'], session.io, () => T0 + 10 * MIN)).toBe(0);
    const out = session.printed.join('\n');
    expect(out).toMatch(/Promoted: TB \S+, signed by johnnyclem, who answers for it/);
    expect(out).toMatch(/Refuted UV \S+\. TB \S+ is active again/);
    expect(out).toMatch(/Docket done: 2 rulings written/);

    const after = new StateStore(statePath);
    try {
      const promoted = after.truth.getTruth('current').find((e) => e.type === 'TB' && (e.body as { claim: string }).claim === uv.body.assertion) as TbEntry;
      expect(promoted.body).toMatchObject({ signedBy: 'johnnyclem', answerableBy: 'johnnyclem', evidence: [COMMIT, { kind: 'message', ref: 'msg-7' }] });
      expect((after.truth.getEntry(uv.id) as UvEntry).body.status).toBe('verified');
      expect((after.truth.getEntry(appeal.id) as UvEntry).body.status).toBe('refuted');
      expect((after.truth.getEntry(tb.id) as TbEntry).body.status).toBe('active');
      const docket = buildDocket({ ledger: after.truth, approvals: after.approvals, attestations: after.attestations }, T0 + 11 * MIN);
      expect(docket.groups.flatMap((g) => g.items.map((i) => i.id))).toEqual([deferred.id]);
      expect(after.truth.verify().ok).toBe(true);
    } finally {
      after.close();
    }
  });

  it('groups items by subject, shows the derivation tree, and the review session handles derivation reviews and drafts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-review-'));
    const statePath = join(dir, 'state.db');
    const store = new StateStore(statePath);
    const { truth: ledger } = store;
    const y = ledger.assertTombstone({ claim: 'The retry budget is 100.', evidence: [COMMIT], signedBy: 'johnnyclem' }, { author: 'johnnyclem', timestamp: at(0) });
    const x = ledger.assertTombstone(
      { claim: 'Retries are capped at 5.', evidence: [TEST], signedBy: 'johnnyclem', premises: [{ id: y.id, contentHash: y.contentHash! }], inference: 'Budget over cost.' },
      { author: 'johnnyclem', timestamp: at(MIN) }
    );
    ledger.overrideTombstone(x.id, { evidence: [{ kind: 'commit', ref: 'd4e5f6' }] }, { author: 'kim', timestamp: at(2 * MIN) });
    const draftA = ledger.draftTombstone({ claim: 'fetchV1 is dead.', evidence: [COMMIT], literals: [{ dead: 'fetchV1' }] }, { author: AGENT, agentSessionId: 'sess-a', timestamp: at(3 * MIN) });
    ledger.draftTombstone({ claim: 'fetchV1 was removed.', evidence: [FILE], literals: [{ dead: 'fetchV1' }] }, { author: AGENT, agentSessionId: 'sess-b', timestamp: at(4 * MIN) });
    ledger.draftTombstone({ claim: 'No more fetchV1.', evidence: [TEST], literals: [{ dead: 'fetchV1' }] }, { author: 'agent:codex', agentSessionId: 'sess-c', timestamp: at(5 * MIN) });
    const docket = buildDocket({ ledger, approvals: store.approvals, attestations: store.attestations }, T0 + 10 * MIN);
    // Nominated drafts first (three sessions, three angles), grouped by their literal set; then the derivation review
    expect(docket.groups.map((g) => [g.subject.split(':')[0], g.items.length, g.items[0].kind, g.items[0].nominated])).toEqual([
      ['literals', 3, 'draft', true],
      ['derivation', 1, 'derivation-review', false],
    ]);
    const review = docket.groups[1].items[0];
    expect(review.review).toMatchObject({ contests: y.id, detail: 'sole-suspect; an observed root' });
    expect(review.derivation).toMatchObject({ id: y.id, type: 'TB' });
    expect(formatDocketItem(review)).toMatch(/^DERIVATION-REVIEW .* \(\d+m old\)\n/);
    expect(formatDocketItem(docket.groups[0].items[0])).toMatch(/NOMINATED/);
    expect(formatDocketItem(docket.groups[0].items[0])).toMatch(/3 agent drafts name this set/);
    store.close();

    // In review: notarize one draft, decline another, defer the third; sign the derivation review (y goes under appeal)
    const session = fakeIO(['a', 'x', 'drafted twice', 'd', 'a']);
    expect(await runReviewCLI(['--state', statePath, '--as', 'johnnyclem'], session.io, () => T0 + 10 * MIN)).toBe(0);
    expect(session.printed.join('\n')).toMatch(/Notarized: TB \S+, signed by johnnyclem, who answers for it/);
    expect(session.printed.join('\n')).toMatch(/Signed: UV \S+ contests/);
    const after = new StateStore(statePath);
    try {
      expect((after.truth.getEntry(draftA.id) as ProposalEntry).body.status).toBe('signed');
      expect(after.truth.listProposals('open')).toHaveLength(1);
      expect((after.truth.getEntry(y.id) as TbEntry).body.status).toBe('contested');
      expect(after.truth.verify().ok).toBe(true);
    } finally {
      after.close();
    }
    // --json prints the docket
    const json = fakeIO([]);
    await runReviewCLI(['--state', statePath, '--json'], json.io, () => T0);
    expect(JSON.parse(json.printed.join('\n'))).toMatchObject({ size: 2 });
  });

  it('the engine: get_status reports the docket, get_docket and GET /docket return it, approve works in both profiles, and ask answers from the record', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-review-'));
    writeFileSync(join(dir, 'log.jsonl'), JSON.stringify({ id: 'm1', role: 'assistant', content: 'LOG_BUDGET is 100 everywhere since the config change', timestamp: at(0) }) + '\n');
    const config: StenographerConfig = { logPath: join(dir, 'log.jsonl'), statePath: join(dir, 'state.db'), mode: 'catchup', embeddingModel: 'hashed', agentIdentity: AGENT, restPort: 0, clock: () => T0 + 30 * MIN };
    const agent = new StenographerServer(config);
    const operator = new StenographerServer({ ...config, restPort: undefined, profile: 'operator' });
    const call = (server: StenographerServer, tool: string, args: Record<string, unknown>) =>
      (server as unknown as { callTool: (n: string, a: Record<string, unknown>) => Promise<any> }).callTool(tool, args);
    try {
      await agent.engine.start();
      await operator.engine.start();
      const engine = agent.engine;
      const uv = await engine.assertUv({ assertion: 'LOG_BUDGET is 100 everywhere.', basis: 'the config change', verifyBy: { kind: 'inspect', value: 'config.ts' }, author: 'sam' });
      const status = await engine.getTruthStats();
      expect(status.docket).toEqual({ size: 1, nominated: 0, oldest: { id: uv.id, createdAt: uv.createdAt, ageMs: expect.any(Number) } });
      expect((await call(agent, 'get_status', {})).truth.docket.size).toBe(1);

      const approved = await call(agent, 'approve', { uvId: uv.id, evidence: [COMMIT], note: 'the commit says so' });
      expect(approved.status).toBe('approved');
      expect(approved.approval).toMatchObject({ by: AGENT, role: 'agent', agentSessionId: engine.getSessionId() });
      const docket = await call(agent, 'get_docket', {});
      expect(docket.groups[0].items[0]).toMatchObject({ id: uv.id, approvals: { agentSessions: 1, human: false } });
      expect(docket.groups[0].items[0].passages.map((p: { id: string }) => p.id)).toEqual(['m1']);

      const base = `http://127.0.0.1:${engine.restPort}`;
      const res = await globalThis.fetch(`${base}/docket`, { headers: { Authorization: `Bearer ${engine.restToken}` } });
      expect(res.status).toBe(200);
      expect((await res.json()).size).toBe(1);
      expect((await (await globalThis.fetch(`${base}/status`, { headers: { Authorization: `Bearer ${engine.restToken}` } })).json()).docket).toBeUndefined();

      // The author's session isn't carried by this engine: stenographer answers from the record
      const asked = await engine.callOnAuthor(uv.id, 'Where did you see it?', { by: 'johnnyclem' });
      expect(asked).toMatchObject({ asked: false, reason: expect.stringMatching(/answers from the record/) });
      expect((asked as { passages: Array<{ id: string }> }).passages.map((p) => p.id)).toEqual(['m1']);

      // A person's approval over the operator profile promotes it; the reporter's never counts as the person
      expect(await call(operator, 'approve', { uvId: uv.id, role: 'reporter', cites: ['m1'] })).toMatchObject({ status: 'approved', approvals: { reporter: true, missing: ['a human approval'] } });
      await expect(call(operator, 'approve', { uvId: uv.id, role: 'reporter' })).rejects.toThrow(/cites/);
      const promoted = await call(operator, 'approve', { uvId: uv.id, by: 'johnnyclem' });
      expect(promoted.status).toBe('promoted');
      expect(promoted.tombstone.body).toMatchObject({ answerableBy: 'johnnyclem', approvals: [{ role: 'agent' }, { role: 'reporter', cites: ['m1'] }, { role: 'human' }] });
      expect((await engine.getTruthStats()).docket.size).toBe(0);
      expect(await call(agent, 'get_docket', {})).toMatchObject({ size: 0, oldest: null });
    } finally {
      agent.engine.stop();
      operator.engine.stop();
    }
  });

  it('parses evidence lines and finds passages lexically', () => {
    expect(parseEvidenceLines('commit abc123 the fix\n\nfile src/x.ts:1')).toEqual([
      { kind: 'commit', ref: 'abc123', detail: 'the fix' },
      { kind: 'file', ref: 'src/x.ts:1' },
    ]);
    expect(() => parseEvidenceLines('bogus ref')).toThrow();
    const found = lexicalPassages(
      [
        { id: 'a', content: 'the retry budget is one hundred per tenant' },
        { id: 'b', content: 'unrelated chatter about lunch' },
        { id: 'c', content: 'budget' },
      ],
      'The retry budget is 100 per tenant.',
      2
    );
    expect(found.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('TruthWriteError on bad input', () => {
  it('approve on a struck UV is refused', () => {
    const { ledger, approvals, uv } = fresh();
    const target = uv();
    ledger.fileRuling({ kind: 'strike', opinion: 'inadmissible', target: target.id }, { author: 'kim', timestamp: at(MIN) });
    expect(() => approvals.approve({ uvId: target.id, by: 'sam', role: 'human' }, T0 + 2 * MIN)).toThrow(TruthWriteError);
  });
});

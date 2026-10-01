import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/store/index.js';
import { TruthLedger, TruthWriteError, ContemptError } from '../src/truth/ledger.js';
import { exportWikiEntries } from '../src/truth/wiki.js';
import type { Evidence, TbEntry } from '../src/truth/types.js';

const commandEvidence: Evidence[] = [
  { kind: 'command', ref: 'npm test -- rate-limiter', detail: 'all 12 tests pass' },
];
const commitEvidence: Evidence[] = [{ kind: 'commit', ref: 'abc1234' }];

describe('TruthLedger', () => {
  let store: StateStore;
  let ledger: TruthLedger;

  beforeEach(() => {
    store = new StateStore(':memory:');
    ledger = store.truth;
  });

  afterEach(() => {
    store.close();
  });

  const tb = (overrides: Partial<{ claim: string; signedBy: string }> = {}): TbEntry =>
    ledger.assertTombstone(
      {
        claim: overrides.claim ?? 'The rate limiter uses a fixed window, not sliding',
        evidence: commitEvidence,
        signedBy: overrides.signedBy ?? 'johnny',
      },
      { author: overrides.signedBy ?? 'johnny' }
    );

  // ── Write authority ─────────────────────────────────────

  it('rejects anonymous and generic identities at the schema level', () => {
    for (const identity of ['', 'system', 'assistant', 'AI', 'Bot', '  unknown ']) {
      expect(() =>
        ledger.assertTombstone(
          { claim: 'x', evidence: commitEvidence, signedBy: identity },
          { author: identity }
        )
      ).toThrow();
    }
    expect(() =>
      ledger.assertUv(
        { assertion: 'x', basis: 'y', verifyBy: { kind: 'ask', value: 'johnny' } },
        { author: 'system' }
      )
    ).toThrow(TruthWriteError);
  });

  it("reserves 'migration' for the backfill path", () => {
    expect(() =>
      ledger.assertTombstone(
        { claim: 'x', evidence: commitEvidence, signedBy: 'migration' },
        { author: 'migration' }
      )
    ).toThrow(/reserved/);
  });

  it('requires at least one piece of evidence for a TB', () => {
    expect(() =>
      ledger.assertTombstone({ claim: 'x', evidence: [], signedBy: 'johnny' }, { author: 'johnny' })
    ).toThrow(/evidence/);
  });

  // ── Proposals ───────────────────────────────────────────

  it('proposal lifecycle: open → signed mints a TB with a signs link', () => {
    const proposal = ledger.addProposal(
      {
        kind: 'tombstone',
        draft: {
          claim: '"use postgres" is superseded by "use mysql"',
          evidence: [{ kind: 'message', ref: 'm2' }],
        },
        signal: { source: 'supersession-detector', score: 0.71, threshold: 0.45 },
        targetRef: 'decision_1',
      },
      { author: 'detector:supersession' }
    );
    expect(proposal.body.status).toBe('open');

    const minted = ledger.signProposal(proposal.id, 'johnny') as TbEntry;
    expect(minted.type).toBe('TB');
    expect(minted.body.signedBy).toBe('johnny');
    expect(minted.body.status).toBe('active');
    expect(minted.links).toContainEqual({ fromId: minted.id, toId: proposal.id, type: 'signs' });
    expect((ledger.getEntry(proposal.id)!.body as { status: string }).status).toBe('signed');
  });

  it('applies edits at signing time — the signed version is what is true', () => {
    const proposal = ledger.addProposal(
      {
        kind: 'tombstone',
        draft: { claim: 'draft claim', evidence: [{ kind: 'message', ref: 'm1' }] },
        signal: { source: 'supersession-detector' },
        targetRef: 'd1',
      },
      { author: 'detector:supersession' }
    );
    const minted = ledger.signProposal(proposal.id, 'johnny', {
      claim: 'corrected claim',
    }) as TbEntry;
    expect(minted.body.claim).toBe('corrected claim');
    // The draft is history, unchanged
    const stored = ledger.getEntry(proposal.id)!;
    expect((stored.body as { draft: { claim: string } }).draft.claim).toBe('draft claim');
  });

  it('dedupes open proposals by target', () => {
    const args = {
      kind: 'tombstone' as const,
      draft: { claim: 'c', evidence: [{ kind: 'message' as const, ref: 'm1' }] },
      signal: { source: 'supersession-detector' as const },
      targetRef: 'decision_1',
    };
    const first = ledger.addProposal(args, { author: 'detector:supersession' });
    const second = ledger.addProposal(args, { author: 'detector:supersession' });
    expect(second.id).toBe(first.id);
    expect(ledger.listProposals('open')).toHaveLength(1);
  });

  it('dismissal requires a reason and is kept as detector training data', () => {
    const proposal = ledger.addProposal(
      {
        kind: 'tombstone',
        draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] },
        signal: { source: 'supersession-detector' },
        targetRef: 'd1',
      },
      { author: 'detector:supersession' }
    );
    expect(() => ledger.dismissProposal(proposal.id, 'johnny', '')).toThrow(/reason/);

    const dismissed = ledger.dismissProposal(proposal.id, 'johnny', 'false positive: unrelated decisions');
    expect(dismissed.body.status).toBe('dismissed');
    expect(dismissed.body.dismissReason).toContain('false positive');
    // A dismissed proposal is closed for good
    expect(() => ledger.signProposal(proposal.id, 'johnny')).toThrow(/already dismissed/);
  });

  // ── Override protocol ───────────────────────────────────

  it('contest path: a contesting UV marks the TB contested but it remains truth', () => {
    const tombstone = tb();
    const uv = ledger.assertUv(
      {
        assertion: 'I believe the limiter actually slides the window since the v2 refactor',
        basis: 'observed behavior in staging',
        verifyBy: { kind: 'command', value: 'npm test -- rate-limiter' },
        contests: tombstone.id,
      },
      { author: 'sam' }
    );

    const stored = ledger.getEntry(tombstone.id) as TbEntry;
    expect(stored.body.status).toBe('contested');
    expect(uv.links).toContainEqual({ fromId: uv.id, toId: tombstone.id, type: 'contests' });

    const contested = ledger.getContested();
    expect(contested).toHaveLength(1);
    expect(contested[0].tombstone.id).toBe(tombstone.id);
    expect(contested[0].contestedBy.map((u) => u.id)).toEqual([uv.id]);

    // Contested TB still appears in current truth
    expect(ledger.getTruth('current').map((e) => e.id)).toContain(tombstone.id);
  });

  it('verified contest overrides the TB (proven override, path 2)', () => {
    const tombstone = tb();
    const uv = ledger.assertUv(
      {
        assertion: 'The limiter slides the window',
        basis: 'staging observation',
        verifyBy: { kind: 'command', value: 'npm test' },
        contests: tombstone.id,
      },
      { author: 'sam' }
    );

    // Command output the resolver says it saw is a claim: it doesn't self-sign
    expect(() => ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'alex' })).toThrow(/signedBy/);
    expect((ledger.getEntry(tombstone.id) as TbEntry).body.status).toBe('contested');

    const result = ledger.resolveUv(uv.id, 'verified', commandEvidence, {
      author: 'alex',
      signedBy: 'johnny',
      opinion: 'reran the suite myself; the window slides',
    });
    expect(result.uv.body.status).toBe('verified');
    expect((ledger.getEntry(tombstone.id) as TbEntry).body.status).toBe('overridden');
    expect(result.tombstone!.body.signedBy).toBe('johnny');
    expect(result.tombstone!.body.evidence).toEqual([{ ...commandEvidence[0], kind: 'claimed-command' }]);
    expect(result.addendum.body.evidence[0].kind).toBe('claimed-command');
    expect(result.ruling!.body.kind).toBe('promotion');
    // Overridden TB drops out of current truth
    expect(ledger.getTruth('current').map((e) => e.id)).not.toContain(tombstone.id);
  });

  it('refuted contest restores the TB to active', () => {
    const tombstone = tb();
    const uv = ledger.assertUv(
      {
        assertion: 'wrong belief',
        basis: 'hunch',
        verifyBy: { kind: 'command', value: 'npm test' },
        contests: tombstone.id,
      },
      { author: 'sam' }
    );
    const result = ledger.resolveUv(uv.id, 'refuted', commandEvidence, { author: 'alex' });
    expect(result.uv.body.status).toBe('refuted');
    expect((ledger.getEntry(tombstone.id) as TbEntry).body.status).toBe('active');
  });

  it('non-command evidence cannot self-sign a minted TB — requires a human signer + promotion ruling', () => {
    const tombstone = tb();
    const uv = ledger.assertUv(
      {
        assertion: 'belief that flips the TB',
        basis: 'code reading',
        verifyBy: { kind: 'inspect', value: 'src/limiter.ts' },
        contests: tombstone.id,
      },
      { author: 'sam' }
    );

    expect(() =>
      ledger.resolveUv(uv.id, 'verified', commitEvidence, { author: 'agent:reviewer-1' })
    ).toThrow(/signedBy/);

    const result = ledger.resolveUv(uv.id, 'verified', commitEvidence, {
      author: 'agent:reviewer-1',
      signedBy: 'johnny',
      opinion: 'The commit plainly changes the window logic; evidence sufficient.',
    });
    expect(result.tombstone!.body.signedBy).toBe('johnny');
    expect(result.ruling).not.toBeNull();
    expect(result.ruling!.body.kind).toBe('promotion');
    expect(result.ruling!.body.opinion).toContain('sufficient');
  });

  it('overriding a TB without evidence is rejected at the storage layer', () => {
    const tombstone = tb();
    expect(() =>
      ledger.overrideTombstone(tombstone.id, { evidence: [] }, { author: 'johnny' })
    ).toThrow(/evidence/);

    const { tombstone: flipped, addendum } = ledger.overrideTombstone(
      tombstone.id,
      { evidence: commitEvidence, note: 'proven wrong by refactor' },
      { author: 'johnny' }
    );
    expect(flipped.body.status).toBe('overridden');
    expect(addendum.links).toContainEqual({
      fromId: addendum.id,
      toId: tombstone.id,
      type: 'overrides',
    });
  });

  // ── Contempt of corpus ──────────────────────────────────

  it('rejects self-corroboration: an author cannot verify its own UV', () => {
    const uv = ledger.assertUv(
      { assertion: 'a', basis: 'b', verifyBy: { kind: 'command', value: 'true' } },
      { author: 'agent:worker-1' }
    );
    expect(() =>
      ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'agent:worker-1' })
    ).toThrow(ContemptError);
  });

  it('rejects corroboration sharing the agent session of its target', () => {
    const uv = ledger.assertUv(
      { assertion: 'a', basis: 'b', verifyBy: { kind: 'command', value: 'true' } },
      { author: 'agent:parent', agentSessionId: 'sess_1' }
    );
    // A subagent of the same session is one opinion wearing two hats
    expect(() =>
      ledger.resolveUv(uv.id, 'verified', commandEvidence, {
        author: 'agent:subagent',
        agentSessionId: 'sess_1',
      })
    ).toThrow(ContemptError);
  });

  it('rejects a signer who drafted the proposal', () => {
    const proposal = ledger.addProposal(
      {
        kind: 'tombstone',
        draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] },
        signal: { source: 'manual-flag' },
        targetRef: 'd1',
      },
      { author: 'agent:drafter', agentSessionId: 'sess_9' }
    );
    expect(() => ledger.signProposal(proposal.id, 'agent:drafter')).toThrow(ContemptError);
    expect(() =>
      ledger.signProposal(proposal.id, 'agent:other', undefined, { agentSessionId: 'sess_9' })
    ).toThrow(ContemptError);
    // An independent signer is fine
    expect(() => ledger.signProposal(proposal.id, 'johnny')).not.toThrow();
  });

  it('a contempt ruling mints exactly one conduct TB — no reputation system', () => {
    const { ruling, conductTombstone } = ledger.fileRuling(
      {
        kind: 'contempt',
        opinion: 'agent:worker-1 corroborated its own assertion in entries A, B, C',
        target: 'agent:worker-1',
      },
      { author: 'johnny' }
    );
    expect(ruling.body.kind).toBe('contempt');
    expect(conductTombstone).not.toBeNull();
    expect(conductTombstone!.body.claim).toContain('agent:worker-1');
    expect(conductTombstone!.body.signedBy).toBe('johnny');
  });

  // ── Rulings ─────────────────────────────────────────────

  it('rulings require a written opinion', () => {
    const tombstone = tb();
    expect(() =>
      ledger.fileRuling({ kind: 'strike', opinion: '  ', target: tombstone.id }, { author: 'johnny' })
    ).toThrow(/opinion/);
  });

  it('strike makes an entry inadmissible without deleting it', () => {
    const tombstone = tb();
    const { ruling } = ledger.fileRuling(
      { kind: 'strike', opinion: 'evidence was fabricated in the source message', target: tombstone.id },
      { author: 'johnny' }
    );
    expect(ruling.links).toContainEqual({ fromId: ruling.id, toId: tombstone.id, type: 'strikes' });
    // Excluded from current truth, retained in history
    expect(ledger.getTruth('current').map((e) => e.id)).not.toContain(tombstone.id);
    expect(ledger.getTruth('all').map((e) => e.id)).toContain(tombstone.id);
    expect(ledger.getEntry(tombstone.id)).not.toBeNull();
  });

  // ── Migration ───────────────────────────────────────────

  it('backfills legacy tombstones as second-class TBs, idempotently', () => {
    const legacy = {
      id: 'tombstone_123',
      superseded: 'use postgres',
      correctedTo: 'use mysql',
      reason: 'Superseded by newer decision',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const entry = ledger.backfillLegacyTombstone(legacy);
    expect(entry).not.toBeNull();
    expect(entry!.author).toBe('migration');
    expect(entry!.body.signedBy).toBeNull();
    expect(entry!.provenance.kind).toBe('migration');
    // Idempotent
    expect(ledger.backfillLegacyTombstone(legacy)).toBeNull();
    expect(ledger.getStats().tombstones).toBe(1);
  });

  // ── Queries ─────────────────────────────────────────────

  it('current truth orders TBs before UVs and excludes resolved entries', () => {
    const uv = ledger.assertUv(
      { assertion: 'open belief', basis: 'hunch', verifyBy: { kind: 'observe', value: 'prod' } },
      { author: 'sam', timestamp: '2026-01-01T00:00:00Z' }
    );
    const tombstone = tb();
    const current = ledger.getTruth('current');
    expect(current[0].id).toBe(tombstone.id);
    expect(current.map((e) => e.id)).toContain(uv.id);

    ledger.resolveUv(uv.id, 'refuted', commandEvidence, { author: 'alex' });
    expect(ledger.getTruth('current').map((e) => e.id)).not.toContain(uv.id);
    expect(ledger.getTruth('all').map((e) => e.id)).toContain(uv.id);
  });

  it('every status change traces to a linked artifact with an author (no silent rewrites)', () => {
    const tombstone = tb();
    const uv = ledger.assertUv(
      {
        assertion: 'contest',
        basis: 'b',
        verifyBy: { kind: 'command', value: 'true' },
        contests: tombstone.id,
      },
      { author: 'sam' }
    );
    ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'alex', signedBy: 'lee', opinion: 'reproduced' });

    // Audit: who changed the TB and on what basis always has an answer
    const flipped = ledger.getEntry(tombstone.id) as TbEntry;
    const overrideLinks = flipped.links.filter((l) => l.type === 'overrides');
    expect(overrideLinks).toHaveLength(1);
    const addendum = ledger.getEntry(overrideLinks[0].fromId)!;
    expect(addendum.type).toBe('ADDENDUM');
    expect(addendum.author).toBe('alex');
  });
});

// F14: a struck contesting UV still counted as an open contest, so striking
// an inadmissible contest left the TB contested, citing the struck UV.
describe('a struck contest', () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(':memory:');
  });
  afterEach(() => store.close());

  const contestedTb = () => {
    const ledger = store.truth;
    const tb = ledger.assertTombstone({ claim: 'LOG_BUDGET is 100', evidence: commitEvidence, signedBy: 'johnny' }, { author: 'johnny' });
    const contest = (assertion: string) =>
      ledger.assertUv(
        { assertion, basis: 'a dashboard', verifyBy: { kind: 'ask', value: 'ops' }, contests: tb.id },
        { author: 'alex' }
      );
    return { ledger, tb, contest };
  };
  const statusOf = (id: string) => (store.truth.getEntry(id)!.body as { status: string }).status;

  it('no longer contests: the TB is active again, and nothing cites the struck UV', () => {
    const { ledger, tb, contest } = contestedTb();
    const uv = contest('LOG_BUDGET is 30 in staging');
    expect(statusOf(tb.id)).toBe('contested');
    ledger.fileRuling({ kind: 'strike', opinion: 'inadmissible: no evidence', target: uv.id }, { author: 'kim' });
    expect(statusOf(tb.id)).toBe('active');
    expect(ledger.getContested()).toEqual([]);
    expect(ledger.verify().ok).toBe(true);
  });

  it('leaves the TB contested while another contest is open, citing only that one', () => {
    const { ledger, tb, contest } = contestedTb();
    const struck = contest('LOG_BUDGET is 30 in staging');
    const open = contest('LOG_BUDGET is 30 in prod');
    ledger.fileRuling({ kind: 'strike', opinion: 'inadmissible: no evidence', target: struck.id }, { author: 'kim' });
    expect(statusOf(tb.id)).toBe('contested');
    expect(ledger.getContested().map((c) => c.contestedBy.map((u) => u.id))).toEqual([[open.id]]);
  });

  it('travels: the stream has the TB back to active, caused by the strike', () => {
    const { ledger, tb, contest } = contestedTb();
    const uv = contest('LOG_BUDGET is 30 in staging');
    const { ruling } = ledger.fileRuling({ kind: 'strike', opinion: 'inadmissible: no evidence', target: uv.id }, { author: 'kim' });
    const lines = exportWikiEntries(ledger).lines.map((l) => JSON.parse(l));
    const transitions = lines.filter((l) => l.type === 'TRANSITION').map((l) => [l.target, l.status, l.cause.kind, l.cause.ref]);
    expect(transitions).toEqual([
      [tb.id, 'contested', 'contest', uv.id],
      [uv.id, 'struck', 'strike', ruling.id],
      [tb.id, 'active', 'strike', ruling.id],
    ]);
  });
});

describe('TruthLedger authority invariants', () => {
  let store: StateStore;
  let ledger: TruthLedger;

  beforeEach(() => {
    store = new StateStore(':memory:');
    ledger = store.truth;
  });

  afterEach(() => {
    store.close();
  });

  const uvBy = (author: string, extra: { contests?: string; agentSessionId?: string } = {}) =>
    ledger.assertUv(
      {
        assertion: 'Retries are idempotent.',
        basis: 'I wrote it',
        verifyBy: { kind: 'command', value: 'npm test' },
        ...(extra.contests ? { contests: extra.contests } : {}),
      },
      { author, agentSessionId: extra.agentSessionId }
    );

  const tb = (overrides: Partial<{ signedBy: string }> = {}): TbEntry =>
    ledger.assertTombstone(
      {
        claim: 'The rate limiter uses a fixed window, not sliding',
        evidence: commitEvidence,
        signedBy: overrides.signedBy ?? 'johnny',
      },
      { author: overrides.signedBy ?? 'johnny' }
    );

  // ── Contempt of corpus uses canonical identities (STENO-T-19) ──

  it('rejects self-corroboration through case, whitespace, width and invisible-character variants', () => {
    for (const variant of ['Alice', ' alice ', 'ALICE', 'ａｌｉｃｅ', 'al​ice']) {
      const uv = uvBy('alice');
      expect(() => ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: variant }), variant).toThrow(
        ContemptError
      );
    }
  });

  it('checks the human signer too: a UV author cannot promote their own belief through a proxy resolver', () => {
    const tombstone = tb();
    const uv = ledger.assertUv(
      { assertion: 'Budget is 30 again.', basis: 'mine', verifyBy: { kind: 'inspect', value: 'config.ts' }, contests: tombstone.id },
      { author: 'alice' }
    );
    expect(() =>
      ledger.resolveUv(uv.id, 'verified', [{ kind: 'file', ref: 'config.ts:3' }], {
        author: 'bot-1',
        signedBy: 'Alice',
        opinion: 'looks right',
      })
    ).toThrow(ContemptError);
    expect((ledger.getEntry(tombstone.id) as TbEntry).body.status).toBe('contested');
  });

  it('compares agent sessions canonically', () => {
    const uv = uvBy('agent:parent', { agentSessionId: 'sess_1' });
    expect(() =>
      ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'agent:sub', agentSessionId: ' sess_1 ' })
    ).toThrow(ContemptError);
  });

  it("a TB's own author cannot refute the contest against it", () => {
    const tombstone = tb({ signedBy: 'johnny' });
    const uv = uvBy('sam', { contests: tombstone.id });
    expect(() => ledger.resolveUv(uv.id, 'refuted', commandEvidence, { author: 'Johnny' })).toThrow(ContemptError);
    // Conceding is not corroboration: the TB's author may verify the contest
    expect(() =>
      ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'johnny', signedBy: 'lee', opinion: 'conceded' })
    ).not.toThrow();
  });

  it('a resolution that would mint a TB is refused when minting is not allowed', () => {
    const tombstone = tb();
    const uv = uvBy('sam', { contests: tombstone.id });
    expect(() =>
      ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'alex', allowMint: false })
    ).toThrow(/notar/);
    expect((ledger.getEntry(uv.id) as { body: { status: string } }).body.status).toBe('open');
    // Refuting mints nothing, so it is allowed
    expect(ledger.resolveUv(uv.id, 'refuted', commandEvidence, { author: 'alex', allowMint: false }).tombstone).toBeNull();
  });

  // ── Reserved identities (STENO-T-24) ──

  it("reserves 'migration' and 'detector:*' as author as well as signer", () => {
    const input = { claim: 'x', evidence: commitEvidence, signedBy: 'bob' };
    expect(() => ledger.assertTombstone(input, { author: 'migration' })).toThrow(/reserved/);
    expect(() => ledger.assertTombstone(input, { author: ' Migration ' })).toThrow(/reserved/);
    expect(() => ledger.assertTombstone(input, { author: 'detector:supersession' })).toThrow(/reserved/);
    expect(() => ledger.assertTombstone({ ...input, signedBy: 'detector:x' }, { author: 'bob' })).toThrow(/reserved/);
    expect(() =>
      ledger.assertUv({ assertion: 'a', basis: 'b', verifyBy: { kind: 'ask', value: 'x' } }, { author: 'migration' })
    ).toThrow(/reserved/);
    expect(() =>
      ledger.draftTombstone({ claim: 'x', evidence: commitEvidence }, { author: 'detector:supersession' })
    ).toThrow(/reserved/);
    // Detectors still file proposals through their own path
    expect(() =>
      ledger.addProposal(
        { kind: 'tombstone', draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] }, signal: { source: 'supersession-detector' } },
        { author: 'detector:supersession' }
      )
    ).not.toThrow();
  });

  it('rejects identities carrying control characters', () => {
    expect(() =>
      ledger.assertTombstone({ claim: 'x', evidence: commitEvidence, signedBy: 'johnny\n' }, { author: 'johnny' })
    ).toThrow();
    expect(() =>
      ledger.assertUv({ assertion: 'a', basis: 'b', verifyBy: { kind: 'ask', value: 'x' } }, { author: 'sam\u0007' })
    ).toThrow(TruthWriteError);
  });

  // ── Dedupe never crosses authors (STENO-T-26) ──

  it('dedupes open proposals only within the same author and notary requirement', () => {
    const detector = ledger.addProposal(
      { kind: 'tombstone', draft: { claim: 'detector draft', evidence: [{ kind: 'message', ref: 'm' }] }, signal: { source: 'supersession-detector' }, targetRef: 'decision_42' },
      { author: 'detector:supersession' }
    );
    const draft = ledger.draftTombstone(
      { claim: 'agent draft', evidence: commitEvidence, literals: [{ dead: 'oldThingy' }], targetRef: 'decision_42' },
      { author: 'agent:a' }
    );
    expect(draft.id).not.toBe(detector.id);
    expect(draft.body.requiresNotary).toBe(true);
    expect(draft.body.draft).toMatchObject({ claim: 'agent draft', literals: [{ dead: 'oldThingy' }] });

    const otherAgent = ledger.draftTombstone(
      { claim: 'another agent draft', evidence: commitEvidence, targetRef: 'decision_42' },
      { author: 'agent:b' }
    );
    expect(otherAgent.id).not.toBe(draft.id);

    const again = ledger.draftTombstone(
      { claim: 'agent draft, restated', evidence: commitEvidence, targetRef: 'decision_42' },
      { author: 'Agent:A' }
    );
    expect(again.id).toBe(draft.id);
    expect(ledger.findOpenProposal({ kind: 'tombstone', targetRef: 'decision_42', author: 'agent:a', requiresNotary: true })!.id).toBe(draft.id);
  });

  // ── Rulings and filters reject unknown values (STENO-T-23) ──

  it('rejects an unknown ruling kind instead of falling through to contempt', () => {
    expect(() =>
      ledger.fileRuling({ kind: 'bogus' as 'strike', opinion: 'the agent opinion', target: 'x' }, { author: 'johnny' })
    ).toThrow(/kind/);
    expect(ledger.getStats()).toMatchObject({ tombstones: 0, rulings: 0 });
  });

  it('rejects an unknown truth filter instead of building invalid SQL', () => {
    expect(() => ledger.getTruth('bogus' as 'current')).toThrow(TruthWriteError);
  });

  // ── contests: null proposals are signable (STENO-T-08) ──

  it('signs a UV proposal whose draft carries contests: null', () => {
    const proposal = ledger.addProposal(
      {
        kind: 'uv',
        draft: {
          assertion: 'The cron box has a stale hosts file.',
          basis: 'deploys skip it',
          verifyBy: { kind: 'ask', value: 'ops' },
          contests: null,
          status: 'open',
        },
        signal: { source: 'wiki-reconciliation', detail: 'wiki entry W contradicts the local copy' },
        targetRef: 'W',
      },
      { author: 'detector:wiki-sync' }
    );
    const minted = ledger.signProposal(proposal.id, 'johnny');
    expect(minted.type).toBe('UV');
    expect((minted.body as { contests?: string | null }).contests).toBeNull();
    expect((minted.body as { status: string }).status).toBe('open');
  });

  it('lets signing edits unset a contest with null', () => {
    const tombstone = tb();
    const proposal = ledger.addProposal(
      {
        kind: 'uv',
        draft: { assertion: 'a', basis: 'b', verifyBy: { kind: 'ask', value: 'x' }, contests: tombstone.id },
        signal: { source: 'manual-flag' },
      },
      { author: 'detector:manual' }
    );
    const minted = ledger.signProposal(proposal.id, 'johnny', { contests: null });
    expect((minted.body as { contests?: string | null }).contests).toBeNull();
    expect((ledger.getEntry(tombstone.id) as TbEntry).body.status).toBe('active');
  });
});

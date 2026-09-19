import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/store/index.js';
import { TruthLedger, TruthWriteError, ContemptError } from '../src/truth/ledger.js';
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

    const result = ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'alex' });
    expect(result.uv.body.status).toBe('verified');
    expect((ledger.getEntry(tombstone.id) as TbEntry).body.status).toBe('overridden');
    // Command evidence self-signs: a successor TB is minted without a human signer
    expect(result.tombstone).not.toBeNull();
    expect(result.tombstone!.body.signedBy).toBe('alex');
    expect(result.ruling).toBeNull();
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
    ledger.resolveUv(uv.id, 'verified', commandEvidence, { author: 'alex' });

    // Audit: who changed the TB and on what basis always has an answer
    const flipped = ledger.getEntry(tombstone.id) as TbEntry;
    const overrideLinks = flipped.links.filter((l) => l.type === 'overrides');
    expect(overrideLinks).toHaveLength(1);
    const addendum = ledger.getEntry(overrideLinks[0].fromId)!;
    expect(addendum.type).toBe('ADDENDUM');
    expect(addendum.author).toBe('alex');
  });
});

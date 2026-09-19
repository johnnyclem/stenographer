import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/store/index.js';
import { importProposalDrafts, COMPACTION_DETECTOR } from '../src/truth/intake.js';

// Lines shaped exactly like short-hand's exportProposalDrafts output.
function uvDraftLine(key = 'database', value = 'PostgreSQL'): string {
  return JSON.stringify({
    kind: 'uv',
    draft: {
      assertion: `The invariant "${key}" holds: ${value}.`,
      basis: `Survived short-hand compaction to L4 (established in message msg-3).`,
      verifyBy: {
        kind: 'inspect',
        value: 'message:msg-3',
        detail: 'confirm the source message still supports this invariant',
      },
    },
    signal: { source: 'compaction-candidate', detail: `short-hand L4 invariant "${key}"` },
    targetRef: `shorthand:invariant:${key}`,
    provenance: { kind: 'sourceMessageId', ref: 'msg-3' },
  });
}

function tombstoneDraftLine(): string {
  return JSON.stringify({
    kind: 'tombstone',
    draft: {
      claim: '"We use MySQL" no longer holds — superseded by "PostgreSQL". Reason: user correction.',
      evidence: [{ kind: 'message', ref: 'm5', detail: 'user correction' }],
      signedBy: null,
    },
    signal: { source: 'compaction-candidate', detail: 'short-hand correction tombstone' },
    targetRef: 'shorthand:tombstone:m1',
    provenance: { kind: 'sourceMessageId', ref: 'm5' },
  });
}

describe('proposal-draft intake (short-hand seam)', () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('files each draft as an open PROPOSAL under the detector identity', () => {
    const result = importProposalDrafts(store.truth, {
      lines: [uvDraftLine(), tombstoneDraftLine()],
    });
    expect(result.errors).toHaveLength(0);
    expect(result.filed).toHaveLength(2);
    expect(result.deduped).toBe(0);

    const open = store.truth.listProposals('open');
    expect(open).toHaveLength(2);
    for (const p of open) {
      expect(p.type).toBe('PROPOSAL');
      expect(p.author).toBe(COMPACTION_DETECTOR);
      expect(p.body.status).toBe('open');
      expect(p.body.signal.source).toBe('compaction-candidate');
    }
    // Nothing became truth: proposals only.
    expect(store.truth.getTruth('all')).toHaveLength(0);
  });

  it('re-importing the same export dedupes against open proposals', () => {
    importProposalDrafts(store.truth, { lines: [uvDraftLine()] });
    const second = importProposalDrafts(store.truth, { lines: [uvDraftLine()] });
    expect(second.filed).toHaveLength(0);
    expect(second.deduped).toBe(1);
    expect(store.truth.listProposals('open')).toHaveLength(1);
  });

  it('reports malformed lines and files the rest', () => {
    const bad = JSON.stringify({ kind: 'uv', draft: { assertion: '' }, signal: { source: 'compaction-candidate' } });
    const result = importProposalDrafts(store.truth, {
      lines: ['not json', bad, tombstoneDraftLine()],
    });
    expect(result.errors).toHaveLength(2);
    expect(result.filed).toHaveLength(1);
  });

  it('rejects an anonymous author override', () => {
    expect(() =>
      importProposalDrafts(store.truth, { lines: [uvDraftLine()] }, { author: 'system' })
    ).toThrow(/anonymous/);
  });

  it('a filed draft can be signed by an independent human into a UV', () => {
    const { filed } = importProposalDrafts(store.truth, { lines: [uvDraftLine()] });
    const minted = store.truth.signProposal(filed[0].id, 'johnny');
    expect(minted.type).toBe('UV');
    expect(store.truth.getOpenUvs()).toHaveLength(1);
  });

  it('the detector cannot sign its own intake (one hat, not two)', () => {
    const { filed } = importProposalDrafts(store.truth, { lines: [uvDraftLine()] });
    expect(() => store.truth.signProposal(filed[0].id, COMPACTION_DETECTOR)).toThrow();
  });
});

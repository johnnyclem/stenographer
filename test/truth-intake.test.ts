import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store/index.js';
import { importProposalDrafts, COMPACTION_DETECTOR } from '../src/truth/intake.js';
import { wikiLineHash } from '../src/truth/wiki.js';

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

  // The same seam as smallchat's vendored compactor emits it
  // (`proposeInvariants` / `appendProposalsFile`, mirrored in smallchat-swift's
  // `InvariantProposal`): a PROPOSAL envelope around the same draft body.
  function smallchatEnvelopeLine(name = 'database', session = 'sess-42'): string {
    return JSON.stringify({
      type: 'PROPOSAL',
      kind: 'uv',
      id: '01J9SMALLCHATULID000000000',
      ts: '2026-09-23T13:58:31.000Z',
      author: 'smallchat:compactor',
      draft: {
        assertion: `The invariant "${name}" holds: PostgreSQL.`,
        basis: 'Survived compaction to L4.',
        verifyBy: {
          kind: 'inspect',
          value: 'message:msg-9',
          detail: 'confirm the compacted value still holds in the source conversation',
        },
      },
      signal: { source: 'shorthand-compaction', detail: `level 4, round 2, session ${session}` },
      targetRef: `entity:${session}:${name}`,
      agentSessionId: session,
    });
  }

  it("accepts smallchat's PROPOSAL envelope dialect and files it as a compaction candidate", () => {
    const result = importProposalDrafts(store.truth, { lines: [smallchatEnvelopeLine()] });
    expect(result.errors).toHaveLength(0);
    expect(result.filed).toHaveLength(1);

    const [p] = result.filed;
    expect(p.author).toBe(COMPACTION_DETECTOR);
    expect(p.body.kind).toBe('uv');
    expect(p.body.signal.source).toBe('compaction-candidate');
    expect(p.body.signal.detail).toContain('level 4');
    expect(p.body.targetRef).toBe('entity:sess-42:database');
    // The envelope's own identity travels as bookkeeping, never as authorship
    expect(p.body.meta).toMatchObject({
      intake: { source: 'shorthand-compaction', id: '01J9SMALLCHATULID000000000', author: 'smallchat:compactor' },
    });
    expect(p.agentSessionId).toBe('sess-42');
    expect(p.createdAt).toBe('2026-09-23T13:58:31.000Z');
    expect(store.truth.getTruth('all')).toHaveLength(0);
  });

  it('dedupes across dialects by targetRef', () => {
    importProposalDrafts(store.truth, { lines: [smallchatEnvelopeLine('cache')] });
    const again = importProposalDrafts(store.truth, { lines: [smallchatEnvelopeLine('cache')] });
    expect(again.deduped).toBe(1);
    expect(store.truth.listProposals('open')).toHaveLength(1);
  });

  it('still rejects an unknown signal source', () => {
    const line = JSON.parse(smallchatEnvelopeLine());
    line.signal.source = 'somebody-else';
    const result = importProposalDrafts(store.truth, { lines: [JSON.stringify(line)] });
    expect(result.filed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('a UV draft carrying contests: null can be signed (STENO-T-08)', () => {
    const line = JSON.parse(uvDraftLine('queue'));
    line.draft.contests = null;
    const { filed, errors } = importProposalDrafts(store.truth, { lines: [JSON.stringify(line)] });
    expect(errors).toHaveLength(0);
    const minted = store.truth.signProposal(filed[0].id, 'johnny');
    expect(minted.type).toBe('UV');
  });

  it('the detector cannot sign its own intake (one hat, not two)', () => {
    const { filed } = importProposalDrafts(store.truth, { lines: [uvDraftLine()] });
    expect(() => store.truth.signProposal(filed[0].id, COMPACTION_DETECTOR)).toThrow();
  });
});

describe('the suite PROPOSAL envelope (truth format v2)', () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(':memory:');
  });
  afterEach(() => store.close());

  /** A proposals stream, hash-chained as the spec says. */
  function stream(...bodies: Array<Record<string, unknown>>): string[] {
    const lines: string[] = [];
    let prevHash: string | null = null;
    bodies.forEach((body, i) => {
      const line = { schemaVersion: 2, seq: i + 1, type: 'PROPOSAL', ts: '2026-09-30T12:00:00.000Z', ...body, prevHash };
      const hash = wikiLineHash(line);
      lines.push(JSON.stringify({ ...line, hash }));
      prevHash = hash;
    });
    return lines;
  }
  const tb = {
    id: '01J9PROPTB0000000000000000',
    author: 'detector:short-hand',
    kind: 'tb',
    draft: {
      claim: 'LOG_BUDGET 30 is dead; it is 100.',
      evidence: [{ kind: 'message', ref: 'm5' }],
      literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
    },
    targetRef: 'shorthand:tombstone:m5',
    signal: { source: 'compaction-candidate', detail: 'L4 correction' },
  };
  const uv = {
    id: '01J9PROPUV0000000000000000',
    author: 'agent:claude-code',
    kind: 'uv',
    draft: { assertion: 'Retries are idempotent.', basis: 'design doc', verifyBy: { kind: 'ask', value: 'sam' }, contests: null },
    targetRef: null,
    signal: { source: 'agent' },
    agentSessionId: 'sess_9',
  };

  it('files tb and uv drafts, keeping literals, with the envelope under meta.intake', () => {
    const lines = stream(tb, uv);
    const result = importProposalDrafts(store.truth, { lines });
    expect(result.errors).toEqual([]);
    expect(result.filed).toHaveLength(2);
    const [t, u] = result.filed;
    expect(t.body).toMatchObject({ kind: 'tombstone', draft: { literals: tb.draft.literals }, signal: { source: 'compaction-candidate' } });
    expect(t.body.meta).toMatchObject({
      intake: { source: 'compaction-candidate', id: tb.id, author: 'detector:short-hand', hash: JSON.parse(lines[0]).hash },
    });
    expect(u.body).toMatchObject({ kind: 'uv', meta: { intake: { source: 'agent', id: uv.id } } });
    expect(u.agentSessionId).toBe('sess_9');
    // Re-importing the same stream files nothing new
    expect(importProposalDrafts(store.truth, { lines })).toMatchObject({ filed: [], deduped: 2 });
  });

  it('refuses a line whose hash does not match, or that breaks the chain', () => {
    const lines = stream(tb, uv);
    const edited = JSON.stringify({ ...JSON.parse(lines[0]), targetRef: 'elsewhere' });
    const gap = stream(tb, uv, { ...uv, id: '01J9PROPUV0000000000000001' });
    const result = importProposalDrafts(store.truth, { lines: [edited] });
    expect(result.errors).toMatchObject([{ line: 1, error: expect.stringMatching(/hash mismatch/) }]);
    const broken = importProposalDrafts(store.truth, { lines: [gap[0], gap[2]] });
    expect(broken.errors).toMatchObject([{ line: 2, error: expect.stringMatching(/chain broken/) }]);
  });

  it('refuses a kind the envelope does not define, with a readable message', () => {
    const lines = stream({ ...tb, kind: 'tombstone' });
    const { errors } = importProposalDrafts(store.truth, { lines });
    expect(errors).toMatchObject([{ line: 1 }]);
    expect(errors[0].error).not.toMatch(/\n|^\[/);
  });

  // F2: envelopes were batched by targetRef into one open proposal under the
  // intake's author, so a second envelope for the same target was dropped.
  it('files every envelope once by its id, even when envelopes share a targetRef', () => {
    const p1 = { ...tb, id: '01J9PROPTB0000000000000011', draft: { ...tb.draft, claim: 'MAX_RETRIES 3 is dead' }, targetRef: 'cfg:MAX_RETRIES' };
    const p2 = {
      ...tb,
      id: '01J9PROPTB0000000000000012',
      author: 'agent:claude-code',
      draft: { ...tb.draft, claim: 'MAX_RETRIES 5 is dead; it is 7' },
      targetRef: 'cfg:MAX_RETRIES',
      signal: { source: 'agent' },
    };
    const lines = stream(p1, p2);
    const result = importProposalDrafts(store.truth, { lines });
    expect(result).toMatchObject({ deduped: 0, errors: [] });
    expect(result.filed.map((p) => [p.body.draft.claim, p.body.meta?.intake])).toEqual([
      ['MAX_RETRIES 3 is dead', expect.objectContaining({ id: p1.id, author: 'detector:short-hand' })],
      ['MAX_RETRIES 5 is dead; it is 7', expect.objectContaining({ id: p2.id, author: 'agent:claude-code' })],
    ]);
    expect(store.truth.listProposals('open')).toHaveLength(2);
    expect(importProposalDrafts(store.truth, { lines })).toMatchObject({ filed: [], deduped: 2 });
  });

  // F3: the spec says readers MUST NOT reject a line for an unknown evidence
  // or verifyBy kind or proposal signal.source; a proposal is never truth.
  it('files a line with values it does not know, recording them for the notary', () => {
    const lines = stream(
      { ...tb, id: '01J9PROPTB0000000000000021', signal: { source: 'human-review' } },
      { ...uv, id: '01J9PROPUV0000000000000022', draft: { ...uv.draft, verifyBy: { kind: 'query', value: 'SELECT 1' } } },
      { ...tb, id: '01J9PROPTB0000000000000023', targetRef: 'other', draft: { ...tb.draft, evidence: [{ kind: 'url', ref: 'https://example.com' }] } },
      { ...uv, id: '01J9PROPUV0000000000000024', signal: { source: 'shorthand-compaction' } }
    );
    const result = importProposalDrafts(store.truth, { lines });
    expect(result.errors).toEqual([]);
    expect(result.filed.map((p) => (p.body.meta?.intake as { unknown?: string[] }).unknown)).toEqual([
      ["signal.source 'human-review'"],
      ["verifyBy kind 'query'"],
      ["evidence kind 'url'"],
      ["signal.source 'shorthand-compaction'"],
    ]);
    expect(result.filed[1].body.draft).toMatchObject({ verifyBy: { kind: 'query', value: 'SELECT 1' } });
    expect(result.filed[2].body.draft).toMatchObject({ evidence: [{ kind: 'url', ref: 'https://example.com' }] });
    expect(store.truth.getTruth('all')).toHaveLength(0);
  });
});

// F4: the spec says readers skip blank lines and count them in line numbers.
describe('intake line numbers', () => {
  let store: StateStore;
  let dir: string;
  beforeEach(() => {
    store = new StateStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'steno-intake-'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts blank lines in a file, and skips them', () => {
    const path = join(dir, 'proposals.jsonl');
    writeFileSync(path, `\n\n${uvDraftLine()}\n{"not":"valid"}\n`);
    const result = importProposalDrafts(store.truth, { path });
    expect(result.filed).toHaveLength(1);
    expect(result.errors.map((e) => e.line)).toEqual([4]);
  });

  it('skips blank lines passed as lines', () => {
    const result = importProposalDrafts(store.truth, { lines: ['', uvDraftLine(), '  ', '{"not":"valid"}'] });
    expect(result.filed).toHaveLength(1);
    expect(result.errors.map((e) => e.line)).toEqual([4]);
  });
});

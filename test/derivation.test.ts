/**
 * Derivation and standing (PRD "derivation, suspicion and answerability", R1 and R2).
 *
 * A TB or UV may derive from the entries it was built on: `derives` links,
 * each pinned by the premise's content hash, and an `inference`. Standing
 * is a second fold beside status: what happened underneath an entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '../src/store/index.js';
import { TruthLedger, TruthWriteError } from '../src/truth/ledger.js';
import { contentHash, lineContentHash, premisesOfLine } from '../src/truth/derivation.js';
import { deriveStanding, type StandingNode } from '../src/truth/status.js';
import { exportWikiEntries, importWikiEntries, decodeWikiLine, wikiLineHash } from '../src/truth/wiki.js';
import type { Evidence, TbEntry, UvEntry, Premise } from '../src/truth/types.js';

const commit = (ref: string): Evidence[] => [{ kind: 'commit', ref }];
const parse = (text: string) => JSON.parse(text) as Record<string, any>;

describe('derivation (R1)', () => {
  let store: StateStore;
  let ledger: TruthLedger;
  beforeEach(() => {
    store = new StateStore(':memory:');
    ledger = store.truth;
  });
  afterEach(() => store.close());

  const tb = (claim: string, extra: Partial<{ premises: Premise[]; inference: string; evidence: Evidence[]; signedBy: string }> = {}): TbEntry =>
    ledger.assertTombstone(
      { claim, evidence: extra.evidence ?? commit('a1b2c3d'), signedBy: extra.signedBy ?? 'johnny', premises: extra.premises, inference: extra.inference },
      { author: extra.signedBy ?? 'johnny' }
    );
  const uv = (assertion: string, extra: Partial<{ premises: Premise[]; inference: string; contests: string; author: string }> = {}): UvEntry =>
    ledger.assertUv(
      { assertion, basis: 'the design doc', verifyBy: { kind: 'inspect', value: 'src/retry.ts' }, contests: extra.contests, premises: extra.premises, inference: extra.inference },
      { author: extra.author ?? 'sam' }
    );
  const pin = (entry: { id: string; contentHash?: string }): Premise => ({ id: entry.id, contentHash: entry.contentHash! });

  it('every TB and UV carries its contentHash, the hash of its type, author and content', () => {
    const root = tb('The budget is 100.');
    expect(root.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const stored = ledger.getEntry(root.id)!;
    const { status: _s, ...content } = stored.body as Record<string, unknown>;
    expect(root.contentHash).toBe(contentHash('TB', 'johnny', content));
    // Status is not content: a contest changes the TB's status, never its hash
    uv('The budget went back to 30.', { contests: root.id });
    expect(ledger.getEntry(root.id)!.contentHash).toBe(root.contentHash);
  });

  it('a derived entry writes one derives link per premise, pinned, and carries the inference', () => {
    const budget = tb('The budget is 100.');
    const cost = uv('Each retry costs 20.');
    const derived = tb('Retries are capped at 5.', {
      premises: [pin(budget), pin(cost)],
      inference: 'The budget in the first premise divided by the cost in the second.',
    });
    const links = derived.links.filter((l) => l.type === 'derives');
    expect(links).toEqual([
      { fromId: derived.id, toId: budget.id, type: 'derives', contentHash: budget.contentHash },
      { fromId: derived.id, toId: cost.id, type: 'derives', contentHash: cost.contentHash },
    ]);
    expect(derived.body.inference).toBe('The budget in the first premise divided by the cost in the second.');
    expect(derived.standing).toBe('clouded');
    expect(derived.reasons).toEqual([{ premise: cost.id, reason: 'premise-open' }]);
    expect(ledger.verify().ok).toBe(true);
  });

  it('refuses a dead premise: overridden, refuted or struck', () => {
    const overridden = tb('The cron box is gone.');
    ledger.overrideTombstone(overridden.id, { evidence: commit('f00d123') }, { author: 'kim' });
    const refuted = uv('Exports run hourly.');
    ledger.resolveUv(refuted.id, 'refuted', [{ kind: 'file', ref: 'cron.d/export:1' }], { author: 'kim' });
    const struck = tb('The batch box is gone.');
    ledger.fileRuling({ kind: 'strike', opinion: 'abandoned branch', target: struck.id }, { author: 'johnny' });
    for (const [dead, status] of [
      [overridden, 'overridden'],
      [refuted, 'refuted'],
      [struck, 'struck'],
    ] as const) {
      expect(() => tb('Built on the dead.', { premises: [pin(ledger.getEntry(dead.id)!)], inference: 'Because.' })).toThrow(
        new RegExp(`premise ${dead.id} is ${status}: nothing is signed on a dead premise`)
      );
    }
    // Resting on something dead counts too: an unsupported premise is refused
    const root = tb('The queue is Redis.');
    const onRoot = tb('Jobs are Redis lists.', { premises: [pin(root)], inference: 'Redis queues are lists.' });
    ledger.fileRuling({ kind: 'strike', opinion: 'wrong box', target: root.id }, { author: 'johnny' });
    expect(ledger.getEntry(onRoot.id)!.standing).toBe('unsupported');
    expect(() => tb('Deeper.', { premises: [pin(ledger.getEntry(onRoot.id)!)], inference: 'Because.' })).toThrow(/is unsupported \(premise-struck/);
  });

  it('refuses a hash mismatch, an unknown id, a self-reference and premises without an inference', () => {
    const root = tb('The budget is 100.');
    const wrong = { id: root.id, contentHash: root.contentHash!.replace(/^./, root.contentHash![0] === 'a' ? 'b' : 'a') };
    expect(() => tb('x', { premises: [wrong], inference: 'y' })).toThrow(/not the premise the signer attested to/);
    expect(() => tb('x', { premises: [{ id: '01NOPE000000000000000000000', contentHash: root.contentHash! }], inference: 'y' })).toThrow(/no such entry/);
    expect(() => tb('x', { premises: [pin(root)] })).toThrow(/premises and inference come together/);
    expect(() => tb('x', { inference: 'alone' })).toThrow(/premises and inference come together/);
    expect(() => tb('x', { premises: [pin(root), pin(root)], inference: 'twice' })).toThrow(/named once/);
    expect(() => tb('x', { premises: [{ id: root.id, contentHash: 'nothex' }], inference: 'y' })).toThrow(/64 lowercase hex/);
    // A self-reference can only arrive by import: the codec refuses the line
    const line = parse(exportWikiEntries(ledger).lines[0]);
    const selfish = { ...line, inference: 'I rest on myself.', 'x-steno': { ...line['x-steno'], links: [{ fromId: line.id, toId: line.id, type: 'derives', contentHash: root.contentHash }] } };
    expect(() => decodeWikiLine(JSON.stringify(selfish))).toThrow(/cannot derive from itself/);
    expect(ledger.getTruth('all')).toHaveLength(1);
  });

  it('a caller-submitted wiki evidence ref must resolve to an entry this ledger holds, alive', () => {
    const struck = tb('The batch box is gone.');
    ledger.fileRuling({ kind: 'strike', opinion: 'abandoned branch', target: struck.id }, { author: 'johnny' });
    expect(() => tb('Cites the struck.', { evidence: [{ kind: 'wiki', ref: struck.id }] })).toThrow(/wiki evidence .* is struck/);
    expect(() => tb('Cites nothing.', { evidence: [{ kind: 'wiki', ref: 'legacy:17' }] })).toThrow(/names no entry this ledger holds/);
    // Drafts and resolutions hear it when they are filed
    expect(() => ledger.draftTombstone({ claim: 'x', evidence: [{ kind: 'wiki', ref: struck.id }] }, { author: 'agent:claude-code' })).toThrow(/is struck/);
    const open = uv('Backups run nightly.');
    expect(() => ledger.resolveUv(open.id, 'verified', [{ kind: 'wiki', ref: 'nope' }], { author: 'kim' })).toThrow(/names no entry/);
    // A live ref that resolves is an unpinned premise: the citing entry follows its standing
    const alive = tb('The cron box is gone.');
    const citing = tb('So nothing runs there.', { evidence: [{ kind: 'wiki', ref: alive.id }] });
    expect(citing.standing).toBe('sound');
    ledger.overrideTombstone(alive.id, { evidence: commit('f00d123') }, { author: 'kim' });
    expect(ledger.getEntry(citing.id)).toMatchObject({ standing: 'unsupported', reasons: [{ premise: alive.id, reason: 'premise-overridden' }] });
  });

  it('a notarized draft keeps a wiki ref this ledger does not hold (it came from a line), but not one that died here', () => {
    // A teammate's line citing an entry of theirs we don't hold: imported, the ref is an unresolved premise, which is no premise
    const unhashed = {
      schemaVersion: 2,
      seq: 1,
      id: '01THEIRTB00000000000000000',
      type: 'TB',
      ts: '2026-09-01T10:00:00.000Z',
      author: 'mallory',
      claim: 'Their box is gone.',
      evidence: [{ kind: 'wiki', ref: '01THEIRS000000000000000000' }],
      signedBy: 'mallory',
      status: 'active',
      prevHash: null,
    };
    const line = JSON.stringify({ ...unhashed, hash: wikiLineHash(unhashed) });
    const result = importWikiEntries(ledger, { lines: [line] }, { signers: null });
    expect(result).toMatchObject({ committed: true, inserted: 1 });
    expect(ledger.getEntry(unhashed.id)).toMatchObject({ standing: 'sound', reasons: [] });
    const dead = tb('Dead soon.');
    ledger.fileRuling({ kind: 'strike', opinion: 'no', target: dead.id }, { author: 'johnny' });
    const draft = ledger.addProposal(
      { kind: 'tombstone', draft: { claim: 'x', evidence: [{ kind: 'wiki', ref: dead.id }] }, signal: { source: 'manual-flag' } },
      { author: 'detector:wiki-sync' }
    );
    expect(() => ledger.signProposal(draft.id, 'johnny')).toThrow(/is struck/);
  });

  it('the draft path carries premises through to the signed entry, and a draft is refused on a premise it misnames', () => {
    const root = tb('The budget is 100.');
    const draft = ledger.draftTombstone(
      { claim: 'Retries are capped at 5.', evidence: commit('c4fe0b1'), premises: [pin(root)], inference: 'Budget over cost.' },
      { author: 'agent:claude-code', agentSessionId: 'sess_1' }
    );
    expect(draft.body.draft).toMatchObject({ premises: [pin(root)], inference: 'Budget over cost.' });
    const signed = ledger.signProposal(draft.id, 'johnny', undefined, { notarized: true }) as TbEntry;
    expect(signed.links.filter((l) => l.type === 'derives')).toEqual([{ fromId: signed.id, toId: root.id, type: 'derives', contentHash: root.contentHash }]);
    expect(signed.body.inference).toBe('Budget over cost.');
    expect(() =>
      ledger.draftTombstone({ claim: 'x', evidence: commit('c4fe0b1'), premises: [{ id: root.id, contentHash: '0'.repeat(64) }], inference: 'y' }, { author: 'agent:claude-code' })
    ).toThrow(/hashes to/);
    // A notary's edit can add premises, pinned the same way
    const second = ledger.draftTombstone({ claim: 'Another.', evidence: commit('d00d000') }, { author: 'agent:codex', agentSessionId: 'sess_2' });
    const edited = ledger.signProposal(second.id, 'johnny', { premises: [pin(root)], inference: 'Added at signing.' }, { notarized: true }) as TbEntry;
    expect(edited.links.some((l) => l.type === 'derives' && l.toId === root.id)).toBe(true);
  });

  it('round-trips through the wiki stream: the line carries the pin and the inference, and a reader recomputes the hash from the premise line', () => {
    const budget = tb('The budget is 100.');
    const derived = tb('Retries are capped at 5.', { premises: [pin(budget)], inference: 'Budget over cost.' });
    const { lines } = exportWikiEntries(ledger);
    const [budgetLine, derivedLine] = lines.map(parse);
    expect(derivedLine.inference).toBe('Budget over cost.');
    expect(derivedLine['x-steno'].links).toEqual([{ fromId: derived.id, toId: budget.id, type: 'derives', contentHash: budget.contentHash }]);
    expect(lineContentHash(budgetLine)).toBe(budget.contentHash);
    expect(premisesOfLine(derivedLine)).toEqual([{ id: budget.id, kind: 'derives', contentHash: budget.contentHash }]);

    const other = new TruthLedger(new Database(':memory:'));
    const result = importWikiEntries(other, { lines });
    expect(result).toMatchObject({ committed: true, inserted: 2, proposals: [], held: [] });
    expect(other.getEntry(derived.id)).toMatchObject({ standing: 'sound', links: derivedLine['x-steno'].links, body: { inference: 'Budget over cost.' } });
    expect(other.verify().ok).toBe(true);
    // Re-exported from the importing ledger: the same content, pins and inference (x-steno is that ledger's own record)
    const again = exportWikiEntries(other).lines.map(parse);
    expect(again.map((l) => [l.id, l.inference ?? null, lineContentHash(l), l['x-steno'].links])).toEqual(
      lines.map(parse).map((l) => [l.id, l.inference ?? null, lineContentHash(l), l['x-steno'].links])
    );
  });

  it('on import, a premise not held clouds the entry, one held with other content files it as a conflict, and a cycle is refused', () => {
    const budget = tb('The budget is 100.');
    const derived = tb('Retries are capped at 5.', { premises: [pin(budget)], inference: 'Budget over cost.' });
    const [budgetLine, derivedLine] = exportWikiEntries(ledger).lines;

    // Not held: clouded, premise-missing; the premise arriving later makes it sound
    const later = new TruthLedger(new Database(':memory:'));
    expect(importWikiEntries(later, { lines: [derivedLine] })).toMatchObject({ committed: true, inserted: 1 });
    expect(later.getEntry(derived.id)).toMatchObject({ standing: 'clouded', reasons: [{ premise: budget.id, reason: 'premise-missing' }] });
    expect(importWikiEntries(later, { lines: [budgetLine] })).toMatchObject({ committed: true, inserted: 1 });
    expect(later.getEntry(derived.id)).toMatchObject({ standing: 'sound', reasons: [] });
    expect(later.verify().ok).toBe(true);

    // Held with other content: the derived line is filed as a conflict, never truth
    const differs = new TruthLedger(new Database(':memory:'));
    const theirs = parse(budgetLine);
    const edited = { ...theirs, claim: 'The budget is 200.' };
    const { hash: _hash, ...unhashed } = edited;
    const editedLine = JSON.stringify({ ...unhashed, hash: wikiLineHash(unhashed) });
    expect(importWikiEntries(differs, { lines: [editedLine] })).toMatchObject({ committed: true, inserted: 1 });
    const conflict = importWikiEntries(differs, { lines: [derivedLine] });
    expect(conflict).toMatchObject({ committed: true, inserted: 0, proposals: [{ reason: 'conflict' }] });
    expect(conflict.proposals[0].detail).toMatch(/pinned by content hash/);
    expect(differs.getEntry(derived.id)).toBeNull();

    // A cycle: B derives A (held clouded), then A arrives deriving B
    const cyclic = new TruthLedger(new Database(':memory:'));
    const aId = '01CYCLEA000000000000000000';
    const bId = '01CYCLEB000000000000000000';
    const base = { schemaVersion: 2, type: 'TB', ts: '2026-09-01T10:00:00.000Z', author: 'kim', evidence: commit('abc1234'), signedBy: 'kim', status: 'active' };
    const hashOf = (line: Record<string, unknown>) => wikiLineHash(line);
    const bLine = { ...base, seq: 1, id: bId, claim: 'B', inference: 'from A', prevHash: null, 'x-steno': { links: [{ fromId: bId, toId: aId, type: 'derives', contentHash: '1'.repeat(64) }] } };
    const b = JSON.stringify({ ...bLine, hash: hashOf(bLine) });
    expect(importWikiEntries(cyclic, { lines: [b] })).toMatchObject({ committed: true, inserted: 1 });
    const bHash = cyclic.contentHashOf(bId)!;
    const aLine = { ...base, seq: 1, id: aId, claim: 'A', inference: 'from B', prevHash: null, 'x-steno': { links: [{ fromId: aId, toId: bId, type: 'derives', contentHash: bHash }] } };
    const a = JSON.stringify({ ...aLine, hash: hashOf(aLine) });
    const result = importWikiEntries(cyclic, { lines: [a] });
    expect(result.committed).toBe(false);
    expect(result.errors[0].error).toMatch(/acyclic/);
  });

});

describe('standing (R2)', () => {
  let store: StateStore;
  let ledger: TruthLedger;
  beforeEach(() => {
    store = new StateStore(':memory:');
    ledger = store.truth;
  });
  afterEach(() => store.close());

  const pin = (id: string): Premise => ({ id, contentHash: ledger.contentHashOf(id)! });
  const tb = (claim: string, premises: string[] = []) =>
    ledger.assertTombstone(
      { claim, evidence: commit('a1b2c3d'), signedBy: 'johnny', ...(premises.length ? { premises: premises.map(pin), inference: 'Because.' } : {}) },
      { author: 'johnny' }
    );
  const uv = (assertion: string, premises: string[] = [], contests?: string) =>
    ledger.assertUv(
      { assertion, basis: 'the doc', verifyBy: { kind: 'ask', value: 'ops' }, contests, ...(premises.length ? { premises: premises.map(pin), inference: 'Because.' } : {}) },
      { author: 'sam' }
    );
  const standing = (id: string) => ledger.getEntry(id)!.standing;

  it('is sound for roots, clouded over an open UV or a TB under appeal, unsupported over a dead premise, and reversible', () => {
    const a = tb('A');
    const b = uv('B');
    const c = tb('C', [a.id, b.id]);
    const d = uv('D', [c.id]);
    expect([a, b].map((e) => e.standing)).toEqual(['sound', 'sound']);
    expect(ledger.getEntry(c.id)).toMatchObject({ standing: 'clouded', reasons: [{ premise: b.id, reason: 'premise-open' }] });
    // D's nearest failing premise is B, reached through C
    expect(ledger.getEntry(d.id)).toMatchObject({ standing: 'clouded', reasons: [{ premise: b.id, reason: 'premise-open', via: c.id }] });
    // Verifying B clears the cloud all the way up
    ledger.resolveUv(b.id, 'verified', [{ kind: 'file', ref: 'src/retry.ts:12' }], { author: 'kim' });
    expect([c, d].map((e) => standing(e.id))).toEqual(['sound', 'sound']);
    // An appeal on A clouds C and D; refuting it restores them
    const appeal = uv('Not A', [], a.id);
    expect(ledger.getEntry(c.id)).toMatchObject({ standing: 'clouded', reasons: [{ premise: a.id, reason: 'premise-under-appeal' }] });
    expect(standing(d.id)).toBe('clouded');
    ledger.resolveUv(appeal.id, 'refuted', [{ kind: 'file', ref: 'config.ts:3' }], { author: 'kim' });
    expect([c, d].map((e) => standing(e.id))).toEqual(['sound', 'sound']);
    // Overriding A makes everything on it unsupported, and nothing takes that back
    ledger.overrideTombstone(a.id, { evidence: commit('f00d123') }, { author: 'kim' });
    expect(ledger.getEntry(c.id)).toMatchObject({ standing: 'unsupported', reasons: [{ premise: a.id, reason: 'premise-overridden' }] });
    expect(ledger.getEntry(d.id)).toMatchObject({ standing: 'unsupported', reasons: [{ premise: a.id, reason: 'premise-overridden', via: c.id }] });
    expect(ledger.verify().ok).toBe(true);
  });

  it('a dead root beneath a weak premise still makes the entry unsupported (P10 through an open UV)', () => {
    // A ← B (open UV, derives A) ← C (derives B): B clouds C on its own, and
    // striking A must reach C through B rather than stop at the cloud.
    const a = uv('A');
    const b = uv('B', [a.id]);
    const c = uv('C', [b.id]);
    // Before the strike, both open UVs beneath C are reasons, and the worst of them only clouds
    expect(ledger.getEntry(c.id)).toMatchObject({
      standing: 'clouded',
      reasons: [
        { premise: b.id, reason: 'premise-open' },
        { premise: a.id, reason: 'premise-open', via: b.id },
      ],
    });
    ledger.fileRuling({ kind: 'strike', opinion: 'abandoned', target: a.id }, { author: 'johnny' });
    expect(ledger.getEntry(b.id)).toMatchObject({ standing: 'unsupported', reasons: [{ premise: a.id, reason: 'premise-struck' }] });
    expect(ledger.getEntry(c.id)).toMatchObject({
      standing: 'unsupported',
      reasons: [
        { premise: b.id, reason: 'premise-open' },
        { premise: a.id, reason: 'premise-struck', via: b.id },
      ],
    });
    // A is struck and B and C are unsupported: nothing is current
    expect(ledger.getTruth('current')).toEqual([]);
    expect(ledger.verify().ok).toBe(true);
    // The same fold, read cold (no cached standing): stenographer verify and stream readers see the same
    const cold = new Map<string, StandingNode>([
      ['a', { type: 'UV', status: 'open', struck: true, standing: null, premises: [] }],
      ['b', { type: 'UV', status: 'open', struck: false, standing: null, premises: [{ id: 'a', kind: 'derives' }] }],
      ['c', { type: 'UV', status: 'open', struck: false, standing: null, premises: [{ id: 'b', kind: 'derives' }] }],
    ]);
    expect(deriveStanding(['c'], (id) => cold.get(id)).get('c')!.standing).toBe('unsupported');
  });

  it('the current filter leaves unsupported entries out; all and the stats still count them', () => {
    const a = tb('A');
    const c = tb('C', [a.id]);
    expect(ledger.getTruth('current').map((e) => e.id)).toEqual([a.id, c.id]);
    ledger.fileRuling({ kind: 'strike', opinion: 'no', target: a.id }, { author: 'johnny' });
    expect(ledger.getTruth('current').map((e) => e.id)).toEqual([]);
    expect(ledger.getTruth('all').map((e) => [e.id, e.standing])).toEqual([
      [a.id, 'sound'],
      [c.id, 'unsupported'],
    ]);
    expect(ledger.getStats().standing).toEqual({ sound: 0, clouded: 0, unsupported: 1 });
  });

  it('property: striking any entry makes exactly its descendants unsupported; resolving the last open contest under an entry returns it to sound', () => {
    // A seeded DAG: each entry derives from up to three earlier ones
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ids: string[] = [];
    const parents = new Map<string, string[]>();
    for (let i = 0; i < 40; i++) {
      const pool = ids.filter(() => rand() < 0.15).slice(0, 3);
      const id = i % 3 === 0 ? tb(`TB ${i}`, pool).id : uv(`UV ${i}`, pool).id;
      ids.push(id);
      parents.set(id, pool);
    }
    // UVs are open, so anything resting on one is clouded; verify them all to start from sound
    for (const id of ids) {
      const entry = ledger.getEntry(id)!;
      if (entry.type === 'UV') ledger.resolveUv(id, 'verified', [{ kind: 'file', ref: `f/${id}` }], { author: 'kim' });
    }
    for (const id of ids) expect(standing(id), id).toBe('sound');
    const descendants = (root: string): Set<string> => {
      const out = new Set<string>();
      for (const id of ids) if (parents.get(id)!.some((p) => p === root || out.has(p))) out.add(id);
      return out;
    };
    const victim = ids[Math.floor(ids.length / 3)];
    ledger.fileRuling({ kind: 'strike', opinion: 'no', target: victim }, { author: 'johnny' });
    const expected = descendants(victim);
    for (const id of ids) {
      if (id === victim) continue;
      expect(standing(id), id).toBe(expected.has(id) ? 'unsupported' : 'sound');
    }
    expect(ledger.verify().ok).toBe(true);

    // The reversible side: a TB with two open contests clouds its dependents until the last contest closes
    const root = tb('Root');
    const dep = tb('Dep', [root.id]);
    const c1 = uv('Not root 1', [], root.id);
    const c2 = uv('Not root 2', [], root.id);
    expect(standing(dep.id)).toBe('clouded');
    ledger.resolveUv(c1.id, 'refuted', [{ kind: 'file', ref: 'a:1' }], { author: 'kim' });
    expect(standing(dep.id)).toBe('clouded');
    ledger.resolveUv(c2.id, 'refuted', [{ kind: 'file', ref: 'b:1' }], { author: 'kim' });
    expect(standing(dep.id)).toBe('sound');
  });

  it('deriveStanding is cycle-safe and reads unpinned premises as nothing when they do not resolve', () => {
    const nodes = new Map<string, StandingNode>([
      ['a', { type: 'TB', status: 'active', struck: false, premises: [{ id: 'b', kind: 'wiki' }, { id: 'ghost', kind: 'wiki' }] }],
      ['b', { type: 'TB', status: 'active', struck: false, premises: [{ id: 'a', kind: 'wiki' }, { id: 'open', kind: 'derives' }] }],
      ['open', { type: 'UV', status: 'open', struck: false, premises: [] }],
    ]);
    const out = deriveStanding(['a', 'b'], (id) => nodes.get(id));
    expect(out.get('b')).toEqual({ standing: 'clouded', reasons: [{ premise: 'open', reason: 'premise-open' }] });
    expect(out.get('a')).toEqual({ standing: 'clouded', reasons: [{ premise: 'open', reason: 'premise-open', via: 'b' }] });
  });

  it('verify re-derives standing, the premise index and link hashes, and reports the first divergence', () => {
    const a = tb('A');
    const c = tb('C', [a.id]);
    const db = store.db;
    const check = (sql: string, params: unknown[], kind: string) => {
      db.prepare(sql).run(...params);
      expect(ledger.verify().failure).toMatchObject({ kind });
    };
    db.exec('BEGIN');
    check(`UPDATE truth_entries SET standing = 'unsupported' WHERE id = ?`, [c.id], 'standing');
    db.exec('ROLLBACK; BEGIN');
    check(`UPDATE truth_links SET content_hash = ? WHERE link_type = 'derives'`, ['0'.repeat(64)], 'link-hash');
    db.exec('ROLLBACK; BEGIN');
    check(`DELETE FROM truth_premises WHERE entry_id = ?`, [c.id], 'premises');
    db.exec('ROLLBACK; BEGIN');
    check(`INSERT INTO truth_premises (entry_id, premise_id, kind) VALUES (?, ?, 'wiki')`, [a.id, c.id], 'premises');
    db.exec('ROLLBACK');
    expect(ledger.verify().ok).toBe(true);
  });

  it('a 1.0 ledger gains the premise index and standing on first open, without rewriting what the chain covers', () => {
    const a = tb('A');
    const citing = ledger.assertTombstone({ claim: 'Cites A', evidence: [{ kind: 'wiki', ref: a.id }], signedBy: 'johnny' }, { author: 'johnny' });
    ledger.fileRuling({ kind: 'strike', opinion: 'no', target: a.id }, { author: 'johnny' });
    const head = ledger.verify().head!.hash;
    const db = store.db;
    db.exec('DROP TABLE truth_premises; ALTER TABLE truth_entries DROP COLUMN standing; ALTER TABLE truth_links DROP COLUMN content_hash');
    const reopened = new TruthLedger(db);
    expect(reopened.getEntry(citing.id)).toMatchObject({ standing: 'unsupported', reasons: [{ premise: a.id, reason: 'premise-struck' }] });
    const report = reopened.verify();
    expect(report.ok).toBe(true);
    expect(report.head!.hash).toBe(head);
  });
});

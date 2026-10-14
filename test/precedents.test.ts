/**
 * PRD phase D: precedent rulings (R7). A RULING of kind `precedent` with a
 * scope: human-only, standalone, superseded by a later precedent on its
 * scope, usable as a premise, searched before a person is asked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TruthLedger, TruthWriteError } from '../src/truth/ledger.js';
import { UvApprovals } from '../src/truth/approvals.js';
import { UvAttestations } from '../src/truth/attestations.js';
import { buildDocket, formatDocketItem } from '../src/truth/docket.js';
import { buildDerivation, formatDerivation } from '../src/truth/trace.js';
import { exportWikiEntries, importWikiEntries } from '../src/truth/wiki.js';
import { decodeWikiLine } from '../src/truth/wiki-codec.js';
import { StenographerServer } from '../src/mcp/server.js';
import { CONSUMPTION_RULES, SCOPE_PATTERN, type RulingEntry, type TbEntry } from '../src/truth/types.js';
import type { StenographerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const COMMIT = { kind: 'commit' as const, ref: 'a1b2c3', detail: 'the merge queue change' };

const fresh = () => new TruthLedger(new Database(':memory:'));
const precedent = (ledger: TruthLedger, opinion: string, over: { scope?: string; supersedes?: string; author?: string; ms?: number } = {}) =>
  ledger.fileRuling(
    { kind: 'precedent', opinion, scope: over.scope ?? 'ci.merge-on-red', ...(over.supersedes ? { supersedes: over.supersedes } : {}) },
    { author: over.author ?? 'johnnyclem', timestamp: at(over.ms ?? 0) }
  ).ruling;

describe('filing a precedent', () => {
  it('a first precedent on a scope targets itself, reads as current, names its scope and who answers for it', () => {
    const ledger = fresh();
    const p = precedent(ledger, 'A red main is never merged into.');
    expect(p.body).toMatchObject({ kind: 'precedent', scope: 'ci.merge-on-red', target: p.id, status: 'current', answerableBy: 'johnnyclem' });
    expect(p.links).toEqual([]);
    expect(ledger.getPrecedents().map((x) => x.id)).toEqual([p.id]);
    expect(ledger.currentPrecedent('ci.merge-on-red')!.id).toBe(p.id);
    expect(ledger.currentPrecedent('ci.other')).toBeNull();
    expect(ledger.verify().ok).toBe(true);
  });

  it('a later precedent on the scope supersedes the current one: it targets it, links to it, and the old one is history', () => {
    const ledger = fresh();
    const first = precedent(ledger, 'Never merge on red.');
    const second = precedent(ledger, 'Merge on red only for a revert that makes it green.', { supersedes: first.id, ms: MIN });
    expect(second.body).toMatchObject({ target: first.id, status: 'current' });
    expect(second.links).toEqual([{ fromId: second.id, toId: first.id, type: 'supersedes' }]);
    expect((ledger.getEntry(first.id) as RulingEntry).body.status).toBe('superseded');
    expect(ledger.getPrecedents().map((x) => x.id)).toEqual([second.id]);
    expect(ledger.getPrecedents({ all: true }).map((x) => x.id)).toEqual([first.id, second.id]);
    expect(ledger.getPrecedents({ scope: 'ci' }).map((x) => x.id)).toEqual([second.id]);
    expect(ledger.getPrecedents({ scope: 'ci.merge' })).toEqual([]);
    // The superseded one can't be superseded again; a third supersedes the second
    expect(() => precedent(ledger, 'x', { supersedes: first.id, ms: 2 * MIN })).toThrow(/already superseded/);
    const third = precedent(ledger, 'Merge on red for a revert, and for a hotfix the on-call signs.', { supersedes: second.id, ms: 3 * MIN });
    expect(ledger.getPrecedents().map((x) => x.id)).toEqual([third.id]);
    expect(ledger.verify().ok).toBe(true);
  });

  it('is human-only, needs a well-formed scope, supersedes only a current precedent on its own scope, and takes no target', () => {
    const ledger = fresh();
    const p = precedent(ledger, 'Never merge on red.');
    expect(() => precedent(ledger, 'x', { author: 'agent:claude-code' })).toThrow(/a person's act/);
    expect(() => ledger.fileRuling({ kind: 'precedent', opinion: 'x' }, { author: 'kim' })).toThrow(/names its scope/);
    for (const scope of ['CI.Merge', 'ci..merge', '.ci', 'ci.-x', 'ci merge']) {
      expect(() => precedent(ledger, 'x', { scope }), scope).toThrow(/lowercase dotted slug/);
    }
    expect(SCOPE_PATTERN.test('ci.merge-on-red')).toBe(true);
    expect(() => precedent(ledger, 'x', { supersedes: p.id, scope: 'ci.release' })).toThrow(/is on scope ci.merge-on-red, not ci.release/);
    expect(() => ledger.fileRuling({ kind: 'precedent', opinion: 'x', scope: 'ci.x', target: 'somewhere' }, { author: 'kim' })).toThrow(/target is derived/);
    const strike = ledger.fileRuling({ kind: 'strike', opinion: 'wrong', target: p.id }, { author: 'kim' }).ruling;
    expect(() => precedent(ledger, 'x', { supersedes: strike.id })).toThrow(/not a precedent/);
    expect(() => precedent(ledger, 'x', { supersedes: p.id })).toThrow(/is struck/);
    // Other ruling kinds still name a target, and never a scope
    expect(() => ledger.fileRuling({ kind: 'strike', opinion: 'x' }, { author: 'kim' })).toThrow(/names its target/);
    expect(ledger.verify().ok).toBe(true);
  });
});

describe('a precedent as a premise', () => {
  it('a TB derived from a precedent is sound; superseding or striking the precedent makes it unsupported', () => {
    const ledger = fresh();
    const first = precedent(ledger, 'Never merge on red.');
    const tb = ledger.assertTombstone(
      {
        claim: 'The hotfix bypass is gone.',
        evidence: [COMMIT],
        signedBy: 'kim',
        premises: [{ id: first.id, contentHash: ledger.contentHashOf(first.id)! }],
        inference: 'The precedent admits no exception.',
      },
      { author: 'kim', timestamp: at(MIN) }
    );
    expect(tb.standing).toBe('sound');
    expect(ledger.premisesOf(tb.id)).toEqual([{ id: first.id, kind: 'derives', contentHash: ledger.contentHashOf(first.id) }]);
    const tree = formatDerivation(buildDerivation(ledger, tb.id)!);
    expect(tree[1]).toMatch(new RegExp(`└─ derives RULING ${first.id} \\[current\\] by johnnyclem, who answers: "Never merge on red."`));

    precedent(ledger, 'Merge on red for a revert.', { supersedes: first.id, ms: 2 * MIN });
    const after = ledger.getEntry(tb.id) as TbEntry;
    expect(after.standing).toBe('unsupported');
    expect(after.reasons).toEqual([{ premise: first.id, reason: 'premise-superseded' }]);
    expect(ledger.getTruth('current').map((e) => e.id)).not.toContain(tb.id);
    expect(formatDerivation(buildDerivation(ledger, tb.id)!)[1]).toMatch(/\[superseded\].*✗ premise-superseded/);

    // Nothing is signed on a superseded precedent; a strike undermines the same way
    expect(() =>
      ledger.assertTombstone(
        { claim: 'x', evidence: [COMMIT], signedBy: 'kim', premises: [{ id: first.id, contentHash: ledger.contentHashOf(first.id)! }], inference: 'y' },
        { author: 'kim' }
      )
    ).toThrow(/superseded.*nothing is signed on a dead premise/);
    const other = precedent(ledger, 'Releases ship on Tuesdays.', { scope: 'release.cadence' });
    const uv = ledger.assertUv(
      { assertion: 'Next release is Tuesday.', basis: 'the cadence', verifyBy: { kind: 'ask', value: 'release' }, premises: [{ id: other.id, contentHash: ledger.contentHashOf(other.id)! }], inference: 'Follows.' },
      { author: 'sam' }
    );
    ledger.fileRuling({ kind: 'strike', opinion: 'retracted', target: other.id }, { author: 'johnnyclem' });
    expect(ledger.getEntry(uv.id)).toMatchObject({ standing: 'unsupported', reasons: [{ premise: other.id, reason: 'premise-struck' }] });
    // Only a precedent is a premise among rulings
    const strike = ledger.getChainedRecords().find((r) => r.type === 'RULING' && (r.body as { kind: string }).kind === 'strike')!;
    expect(() =>
      ledger.assertUv({ assertion: 'x', basis: 'y', verifyBy: { kind: 'ask', value: 'z' }, premises: [{ id: strike.id, contentHash: ledger.contentHashOf(strike.id)! }], inference: 'w' }, { author: 'sam' })
    ).toThrow(/only a precedent ruling is a premise/);
    expect(ledger.verify().ok).toBe(true);
  });

  it('evidence does not refute a fiat: the suspicion detector files nothing against a precedent premise', () => {
    const ledger = fresh();
    const p = precedent(ledger, 'Never merge on red.');
    const tb = ledger.assertTombstone(
      { claim: 'The hotfix bypass is gone.', evidence: [COMMIT], signedBy: 'kim', premises: [{ id: p.id, contentHash: ledger.contentHashOf(p.id)! }], inference: 'No exception.' },
      { author: 'kim', timestamp: at(MIN) }
    );
    const { suspects } = ledger.overrideTombstone(tb.id, { evidence: [{ kind: 'commit', ref: 'f00d123' }] }, { author: 'sam', timestamp: at(2 * MIN) });
    expect(suspects).toEqual([]);
  });
});

describe('precedents travel and are read', () => {
  it('export carries precedent lines (scope, target, supersedes); a teammate folds the same statuses and standing', () => {
    const ledger = fresh();
    const first = precedent(ledger, 'Never merge on red.');
    const tb = ledger.assertTombstone(
      { claim: 'The hotfix bypass is gone.', evidence: [COMMIT], signedBy: 'kim', premises: [{ id: first.id, contentHash: ledger.contentHashOf(first.id)! }], inference: 'No exception.' },
      { author: 'kim', timestamp: at(MIN) }
    );
    const second = precedent(ledger, 'Merge on red for a revert.', { supersedes: first.id, ms: 2 * MIN });
    const { lines } = exportWikiEntries(ledger);
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['RULING', 'TB', 'RULING']);
    for (const line of lines) expect(() => decodeWikiLine(line)).not.toThrow();
    const teammate = fresh();
    expect(importWikiEntries(teammate, { lines })).toMatchObject({ committed: true, inserted: 3, held: [], proposals: [] });
    expect((teammate.getEntry(first.id) as RulingEntry).body).toMatchObject({ status: 'superseded', scope: 'ci.merge-on-red' });
    expect(teammate.getPrecedents().map((p) => p.id)).toEqual([second.id]);
    expect(teammate.getEntry(tb.id)).toMatchObject({ standing: 'unsupported' });
    expect(importWikiEntries(teammate, { lines })).toMatchObject({ inserted: 0, unchanged: 3 });
    expect(teammate.verify().ok).toBe(true);
    // The codec refuses a precedent line without a scope, with two supersedes links, or targeting elsewhere
    const [firstLine] = lines.map((l) => JSON.parse(l));
    const { scope: _s, ...noScope } = firstLine;
    expect(() => decodeWikiLine(JSON.stringify({ ...noScope, hash: '0'.repeat(64) }))).toThrow(/names its scope/);
    expect(() => decodeWikiLine(JSON.stringify({ ...firstLine, target: 'elsewhere', hash: '0'.repeat(64) }))).toThrow(/targets itself/);
  });

  it('CONSUMPTION_RULES tells agents to search precedents before asking a person', () => {
    expect(CONSUMPTION_RULES).toMatch(/Before asking a person to decide, search precedents .*follow it and cite its id/);
  });

  it('the docket shows the nearest precedents beside each item', () => {
    const db = new Database(':memory:');
    const ledger = new TruthLedger(db);
    precedent(ledger, 'A red main is never merged into; a merge waits for green.');
    precedent(ledger, 'Releases ship on Tuesdays after the release checklist.', { scope: 'release.cadence' });
    ledger.assertUv({ assertion: 'We can merge the hotfix into main while it is red.', basis: 'urgency', verifyBy: { kind: 'ask', value: 'ops' } }, { author: 'agent:x', agentSessionId: 's' });
    const docket = buildDocket({ ledger, approvals: new UvApprovals(db, ledger), attestations: new UvAttestations(db, ledger) });
    const item = docket.groups[0].items[0];
    expect(item.precedents.map((p) => p.scope)).toEqual(['ci.merge-on-red']);
    expect(formatDocketItem(item)).toMatch(/precedents:\n\s+\S+ \[ci\.merge-on-red\] A red main is never merged into/);
  });
});

describe('the engine, MCP and REST surfaces', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('file_ruling files a precedent, get_precedents and GET /precedents list them, search_truth ranks them, and the context frame names them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'steno-precedent-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    const config: StenographerConfig = { logPath: join(dir, 'log.jsonl'), statePath: join(dir, 'state.db'), mode: 'catchup', embeddingModel: 'hashed', profile: 'operator', restPort: 0 };
    const server = new StenographerServer(config);
    const call = (tool: string, args: Record<string, unknown>) => (server as unknown as { callTool: (n: string, a: Record<string, unknown>) => Promise<any> }).callTool(tool, args);
    try {
      const engine = server.engine;
      await engine.start();
      const first = (await call('file_ruling', { kind: 'precedent', scope: 'ci.merge-on-red', opinion: 'A red main is never merged into.', author: 'johnnyclem' })).ruling as RulingEntry;
      expect(first.body).toMatchObject({ kind: 'precedent', scope: 'ci.merge-on-red', status: 'current' });
      await expect(call('file_ruling', { kind: 'precedent', opinion: 'x', author: 'johnnyclem' })).rejects.toThrow(/names its scope/);
      await expect(call('file_ruling', { kind: 'precedent', scope: 'ci.merge-on-red', opinion: 'x', author: 'agent:claude-code' })).rejects.toThrow(/person's act/);
      const second = (
        await call('file_ruling', { kind: 'precedent', scope: 'ci.merge-on-red', opinion: 'Merging into a red main is allowed for a revert that makes it green.', supersedes: first.id, author: 'johnnyclem' })
      ).ruling as RulingEntry;
      await call('file_ruling', { kind: 'precedent', scope: 'release.cadence', opinion: 'Releases ship on Tuesdays.', author: 'johnnyclem' });
      expect((await call('get_precedents', {})).map((p: RulingEntry) => p.id)).toEqual([second.id, expect.any(String)]);
      expect((await call('get_precedents', { scope: 'ci', all: true })).map((p: RulingEntry) => p.id)).toEqual([first.id, second.id]);

      const base = `http://127.0.0.1:${engine.restPort}`;
      const headers = { Authorization: `Bearer ${engine.restToken}` };
      const res = await globalThis.fetch(`${base}/precedents?scope=ci`, { headers });
      expect(res.status).toBe(200);
      expect((await res.json()).map((p: RulingEntry) => p.id)).toEqual([second.id]);
      expect((await (await globalThis.fetch(`${base}/precedents?all=true`, { headers })).json()).length).toBe(3);
      expect((await globalThis.fetch(`${base}/precedents?all=yes`, { headers })).status).toBe(400);

      const found = await engine.searchTruth('merging into a red main for a revert', 3);
      expect(found[0]).toMatchObject({ id: second.id, type: 'RULING' });
      expect(found.map((e) => e.id)).not.toContain(first.id);
      expect((await engine.searchTruth('red main revert', 5, 'all')).map((e) => e.id)).toContain(first.id);

      const frame = await engine.buildContextFrame(4000);
      expect(frame).toMatch(/## Precedents\n- ci\.merge-on-red: Merging into a red main is allowed for a revert that makes it green\. \(/);
      expect(frame).not.toContain('A red main is never merged into.');
      expect((await call('get_status', {})).truth.rulings).toBe(3);
    } finally {
      server.engine.stop();
    }
  });

  it('refuses a precedent kind from the library with a bad scope before anything is written', () => {
    const ledger = fresh();
    expect(() => ledger.fileRuling({ kind: 'precedent', scope: 'Ci', opinion: 'x' }, { author: 'kim' })).toThrow(TruthWriteError);
    expect(ledger.getChainedRecords()).toEqual([]);
  });
});

describe('admission holds the precedent rules on import too', () => {
  it('refuses a second supersession of one precedent, so a scope keeps one current precedent', () => {
    const ledger = fresh();
    const first = precedent(ledger, 'Never merge on red.');
    precedent(ledger, 'Merge on red for a revert.', { supersedes: first.id, ms: MIN });
    const id = '01J9PRECEDENTTWICE00000000';
    const entry = {
      id,
      type: 'RULING' as const,
      createdAt: at(2 * MIN),
      author: 'kim',
      provenance: { kind: 'wiki' as const, ref: id },
      agentSessionId: null,
      origin: 'wiki' as const,
      body: { kind: 'precedent', opinion: 'Merge on red whenever.', target: first.id, scope: 'ci.merge-on-red' },
    };
    expect(() => ledger.importChange(entry, [{ fromId: id, toId: first.id, type: 'supersedes' }])).toThrow(/already superseded/);
    expect(ledger.getPrecedents()).toHaveLength(1);
  });
});

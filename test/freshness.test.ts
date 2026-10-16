/**
 * UV freshness, computed at read time (markspace review, Item 2; decision D7).
 *
 * A TB is an action and never decays. A UV is an observation: past its
 * horizon a reader renders it stale, which is a rendering state and not a
 * status. Freshness is a pure function of the lines and the clock, and
 * every time claim it makes carries its derivation.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TruthLedger, TruthWriteError } from '../src/truth/ledger.js';
import { UvApprovals } from '../src/truth/approvals.js';
import { UvAttestations } from '../src/truth/attestations.js';
import { buildDocket, formatDocketItem } from '../src/truth/docket.js';
import { DEFAULT_UV_HORIZON_SECONDS, effectiveHorizon, freshness, reattestationsOf, streamFreshness } from '../src/truth/freshness.js';
import { markerFor, MARKERS, LINE_BODY_FIELDS } from '../src/truth/format.js';
import { decodeWikiLine, exportWikiEntries, importWikiEntries } from '../src/truth/wiki.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stenographer } from '../src/core/stenographer.js';
import type { UvEntry, TbEntry } from '../src/truth/types.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const COMMIT = { kind: 'commit' as const, ref: 'a1b2c3', detail: 'config.ts sets LOG_BUDGET = 100' };
const FILE = { kind: 'file' as const, ref: 'config.ts:3', detail: 'LOG_BUDGET = 100' };
const TEST = { kind: 'test' as const, ref: 'test/config.test.ts', detail: 'LOG_BUDGET is 100' };

function fresh(horizon?: number) {
  const db = new Database(':memory:');
  const ledger = new TruthLedger(db, horizon !== undefined ? { uvHorizonSeconds: horizon } : {});
  const approvals = new UvApprovals(db, ledger);
  const attestations = new UvAttestations(db, ledger);
  const uv = (over: Partial<{ assertion: string; author: string; timestamp: string; horizon: number; premises: Array<{ id: string; contentHash: string }>; inference: string }> = {}) =>
    ledger.assertUv(
      {
        assertion: over.assertion ?? 'LOG_BUDGET is 100 everywhere.',
        basis: 'the config change',
        verifyBy: { kind: 'inspect', value: 'config.ts' },
        ...(over.horizon !== undefined ? { horizon: over.horizon } : {}),
        ...(over.premises ? { premises: over.premises, inference: over.inference ?? 'It follows.' } : {}),
      },
      { author: over.author ?? 'agent:researcher', agentSessionId: 'sess-u', timestamp: over.timestamp ?? at(0) }
    );
  return { db, ledger, approvals, attestations, uv };
}

describe('the pure function', () => {
  it('a UV is fresh until its horizon, measured from its chain timestamp, and stale after', () => {
    const uv = { ts: at(0) };
    const before = freshness(uv, [], T0 + 21 * DAY);
    expect(before.state).toBe('fresh');
    expect(before).toMatchObject({ horizonSeconds: DEFAULT_UV_HORIZON_SECONDS, since: at(0), at: at(21 * DAY), expiresAt: at(21 * DAY), elapsedSeconds: 21 * 24 * 3600, anchor: { kind: 'asserted' } });
    const after = freshness(uv, [], T0 + 21 * DAY + 1000);
    expect(after.state).toBe('stale');
    expect(after.at).toBe(at(21 * DAY + 1000));
  });

  it('the default horizon is 21 days (D7); a line may shorten it, never lengthen it', () => {
    expect(DEFAULT_UV_HORIZON_SECONDS).toBe(21 * 24 * 3600);
    expect(effectiveHorizon(undefined)).toBe(DEFAULT_UV_HORIZON_SECONDS);
    expect(effectiveHorizon(3600)).toBe(3600);
    expect(effectiveHorizon(DEFAULT_UV_HORIZON_SECONDS * 10)).toBe(DEFAULT_UV_HORIZON_SECONDS);
    expect(effectiveHorizon(-5)).toBe(DEFAULT_UV_HORIZON_SECONDS);
    expect(effectiveHorizon('3600')).toBe(DEFAULT_UV_HORIZON_SECONDS);
    expect(effectiveHorizon(3600, 60)).toBe(60);
    expect(freshness({ ts: at(0), horizon: 3600 }, [], T0 + 3601 * 1000).state).toBe('stale');
  });

  it('a re-attestation moves the anchor to the newest re-attesting line and says which one', () => {
    const f = freshness({ ts: at(0) }, [{ id: 'A', ts: at(10 * DAY) }, { id: 'B', ts: at(20 * DAY) }], T0 + 30 * DAY);
    expect(f.state).toBe('fresh');
    expect(f.since).toBe(at(20 * DAY));
    expect(f.anchor).toEqual({ kind: 'reattested', by: 'B' });
    expect(f.expiresAt).toBe(at(41 * DAY));
  });

  it('a timestamp that names no time is stale, failing closed', () => {
    expect(freshness({ ts: 'yesterday' }, [], T0).state).toBe('stale');
  });

  it('reads re-attestations off a stream: corroborates and derives links into the UV', () => {
    const lines = [
      { id: 'uv', type: 'UV', ts: at(0), 'x-steno': { links: [] } },
      { id: 'tb', type: 'TB', ts: at(1 * DAY), 'x-steno': { links: [{ fromId: 'tb', toId: 'uv', type: 'derives', contentHash: 'x' }] } },
      { id: 'add', type: 'ADDENDUM', ts: at(2 * DAY), 'x-steno': { links: [{ fromId: 'add', toId: 'uv', type: 'corroborates' }] } },
      { id: 'other', type: 'ADDENDUM', ts: at(3 * DAY), 'x-steno': { links: [{ fromId: 'other', toId: 'uv', type: 'verifies' }] } },
    ];
    expect(reattestationsOf('uv', lines)).toEqual([
      { id: 'tb', ts: at(1 * DAY) },
      { id: 'add', ts: at(2 * DAY) },
    ]);
    const all = streamFreshness(lines, T0 + 22 * DAY);
    expect(all.get('uv')!.since).toBe(at(2 * DAY));
    expect(all.get('uv')!.state).toBe('fresh');
    expect(all.has('tb')).toBe(false);
  });
});

describe('the ledger', () => {
  it('returns a UV\'s freshness by the clock the reader passes, and nothing for a TB', () => {
    const { ledger, uv } = fresh();
    const entry = uv();
    const tb = ledger.assertTombstone({ claim: 'The budget is 100.', evidence: [COMMIT], signedBy: 'johnny' }, { author: 'johnny', timestamp: at(0) });
    expect(ledger.freshnessOf(entry.id, T0 + DAY)!.state).toBe('fresh');
    expect(ledger.freshnessOf(entry.id, T0 + 22 * DAY)!.state).toBe('stale');
    expect(ledger.freshnessOf(tb.id, T0 + 1000 * DAY)).toBeNull();
    // Reads stored nothing: the stale UV is still open, and the chain verifies
    expect((ledger.getEntry(entry.id) as UvEntry).body.status).toBe('open');
    expect(ledger.verify().ok).toBe(true);
  });

  it('a writer may set a shorter horizon, never a longer one, and the line carries it', () => {
    const { ledger, uv } = fresh();
    const short = uv({ horizon: 3600 });
    expect(short.body.horizon).toBe(3600);
    expect(ledger.freshnessOf(short.id, T0 + 3601 * 1000)).toMatchObject({ state: 'stale', horizonSeconds: 3600 });
    expect(() => uv({ horizon: DEFAULT_UV_HORIZON_SECONDS + 1 })).toThrow(TruthWriteError);
    expect(() => uv({ horizon: DEFAULT_UV_HORIZON_SECONDS + 1 })).toThrow(/shorter than this ledger's default/);
    expect(() => uv({ horizon: 0 })).toThrow();
    const team = fresh(7 * 24 * 3600);
    expect(() => team.uv({ horizon: 8 * 24 * 3600 })).toThrow(TruthWriteError);
    expect(team.uv({ horizon: 6 * 24 * 3600 }).body.horizon).toBe(6 * 24 * 3600);
    expect(team.ledger.freshnessOf(team.uv().id, T0 + 8 * DAY)!.state).toBe('stale');
  });

  it('a derived entry citing the UV re-attests it: the horizon restarts from the derived line', () => {
    const { ledger, uv } = fresh();
    const premise = uv();
    const derived = ledger.assertTombstone(
      { claim: 'So the cap is 5.', evidence: [COMMIT], signedBy: 'johnny', premises: [{ id: premise.id, contentHash: premise.contentHash! }], inference: 'Budget over cost.' },
      { author: 'johnny', timestamp: at(20 * DAY) }
    );
    const f = ledger.freshnessOf(premise.id, T0 + 30 * DAY)!;
    expect(f).toMatchObject({ state: 'fresh', since: at(20 * DAY), anchor: { kind: 'reattested', by: derived.id } });
    // Striking the re-attesting line takes its re-attestation with it
    ledger.fileRuling({ kind: 'strike', opinion: 'wrong inference', target: derived.id }, { author: 'johnny', timestamp: at(21 * DAY) });
    expect(ledger.freshnessOf(premise.id, T0 + 30 * DAY)!).toMatchObject({ state: 'stale', anchor: { kind: 'asserted' } });
  });

  it('a nomination re-attests the UV too', () => {
    const { ledger, approvals, uv } = fresh();
    const target = uv();
    approvals.approve({ uvId: target.id, by: 'agent:a', role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0 + DAY);
    approvals.approve({ uvId: target.id, by: 'agent:b', role: 'agent', agentSessionId: 'sess-b', evidence: [FILE] }, T0 + 2 * DAY);
    const third = approvals.approve({ uvId: target.id, by: 'agent:c', role: 'agent', agentSessionId: 'sess-c', evidence: [TEST] }, T0 + 20 * DAY);
    expect(third.status).toBe('nominated');
    const f = ledger.freshnessOf(target.id, T0 + 30 * DAY)!;
    expect(f.state).toBe('fresh');
    expect(f.anchor).toEqual({ kind: 'reattested', by: (third as { addendum: { id: string } }).addendum.id });
  });

  it('the horizon travels in a wiki stream and is a known UV field', () => {
    expect(LINE_BODY_FIELDS.UV).toContain('horizon');
    const { ledger, uv } = fresh();
    uv({ horizon: 7200 });
    const { lines } = exportWikiEntries(ledger);
    const line = decodeWikiLine(lines[0]);
    expect(line.line.horizon).toBe(7200);
    const other = fresh();
    expect(importWikiEntries(other.ledger, { lines }).committed).toBe(true);
    const held = other.ledger.getTruth('current')[0] as UvEntry;
    expect(held.body.horizon).toBe(7200);
    expect(other.ledger.freshnessOf(held.id, T0 + 7201 * 1000)!.state).toBe('stale');
    // A longer horizon from another team's stream is clamped by the reader, not refused
    const strict = fresh(3600);
    expect(importWikiEntries(strict.ledger, { lines }).committed).toBe(true);
    expect(strict.ledger.freshnessOf(held.id, T0 + 3601 * 1000)!).toMatchObject({ state: 'stale', horizonSeconds: 3600 });
  });
});

describe('rendering', () => {
  it('a stale open UV gets the stale marker; a nominated one keeps its marker; nothing else changes', () => {
    expect(markerFor('UV', 'open', 'sound', false, true)).toBe(MARKERS.UV_STALE);
    expect(markerFor('UV', 'open', 'sound', false, false)).toBe(MARKERS.UV);
    expect(markerFor('UV', 'open', 'sound', true, true)).toBe(MARKERS.UV_CORROBORATED);
    expect(markerFor('UV', 'verified', 'sound', false, true)).toBeNull();
    expect(markerFor('TB', 'active', 'sound', false, true)).toBe(MARKERS.TB);
  });

  it('the docket lists nominated, then stale, then the rest, and states the clock it measured against', () => {
    const { ledger, approvals, attestations, uv } = fresh();
    const plain = uv({ assertion: 'Plain and fresh.', timestamp: at(0) });
    const stale = uv({ assertion: 'Old and unchecked.', timestamp: at(-30 * DAY) });
    const nominated = uv({ assertion: 'Three agents saw it.', timestamp: at(-40 * DAY) });
    approvals.approve({ uvId: nominated.id, by: 'agent:a', role: 'agent', agentSessionId: 'sess-a', evidence: [COMMIT] }, T0 - 39 * DAY);
    approvals.approve({ uvId: nominated.id, by: 'agent:b', role: 'agent', agentSessionId: 'sess-b', evidence: [FILE] }, T0 - 38 * DAY);
    approvals.approve({ uvId: nominated.id, by: 'agent:c', role: 'agent', agentSessionId: 'sess-c', evidence: [TEST] }, T0 - 37 * DAY);
    const docket = buildDocket({ ledger, approvals, attestations }, T0 + DAY);
    expect(docket.asOf).toBe(at(DAY));
    expect(docket.stale).toBe(2);
    expect(docket.groups.map((g) => g.items[0].id)).toEqual([nominated.id, stale.id, plain.id]);
    const item = docket.groups[1].items[0];
    expect(item.stale).toBe(true);
    expect(item.freshness).toMatchObject({ state: 'stale', since: at(-30 * DAY), at: at(DAY) });
    expect(formatDocketItem(item)).toContain('STALE');
    expect(formatDocketItem(item)).toContain(`measured at ${at(DAY)}`);
    // Stale blocks nothing: the stale UV is open, promotable, and carries no status change
    expect((ledger.getEntry(stale.id) as UvEntry).body.status).toBe('open');
  });

  it('the engine attaches freshness to every UV it reads, by its own clock, and to no TB', async () => {
    let now = T0 + 30 * DAY;
    const dir = mkdtempSync(join(tmpdir(), 'steno-freshness-'));
    const engine = new Stenographer({ logPath: join(dir, 'log.jsonl'), statePath: join(dir, 'state.db'), mode: 'catchup', embeddingModel: 'hashed', clock: () => now });
    try {
      const uv = await engine.assertUv({ assertion: 'The cap is read once.', basis: 'config.ts', verifyBy: { kind: 'inspect', value: 'config.ts' }, author: 'agent:x', agentSessionId: 'sess-x' });
      await engine.assertTombstone({ claim: 'The budget is 100.', evidence: [COMMIT], signedBy: 'johnny' });
      const read = await engine.getTruth('current');
      const readUv = read.find((e) => e.id === uv.id) as UvEntry;
      const readTb = read.find((e) => e.type === 'TB') as TbEntry;
      expect(readUv.freshness).toMatchObject({ state: 'fresh', at: at(30 * DAY) });
      expect(readTb.freshness).toBeUndefined();
      now = T0 + 60 * DAY;
      expect(((await engine.getTruth('current')).find((e) => e.id === uv.id) as UvEntry).freshness!.state).toBe('stale');
      const status = await engine.getTruthStats();
      expect(status.docket).toMatchObject({ stale: 1, asOf: at(60 * DAY) });
    } finally {
      engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

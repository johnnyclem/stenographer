/**
 * The numbered properties of the truth format (spec/truth-format/README.md,
 * "Properties"), each a fast-check test named for it. A MUST in the spec is
 * a property here; a reimplementation of the format is conforming when the
 * mandatory ones hold for it.
 *
 * P1–P2 the chain · P3–P4 identities · P5–P6 corroboration · P7–P9
 * derivation · P10–P11 standing and suspicion · P12 promotion · P13–P16
 * freshness · P17 read purity.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { TruthLedger, TruthWriteError } from '../src/truth/ledger.js';
import { UvApprovals } from '../src/truth/approvals.js';
import { UvAttestations } from '../src/truth/attestations.js';
import { buildDocket } from '../src/truth/docket.js';
import { chooseNomination, chooseQuorum, NOMINATION_MIN_MEMBERS, type QuorumMember } from '../src/truth/quorum.js';
import { DERIVATION_DETECTOR } from '../src/truth/suspicion.js';
import { DEFAULT_UV_HORIZON_SECONDS, freshness, type Reattestation } from '../src/truth/freshness.js';
import { SignerRegistry } from '../src/truth/identity.js';
import { checkWikiChain, decodeWikiLine, exportWikiEntries, importWikiEntries, wikiLineHash } from '../src/truth/wiki.js';
import type { Evidence, TbEntry, UvEntry, TruthEntry } from '../src/truth/types.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const COMMIT: Evidence = { kind: 'commit', ref: 'a1b2c3d', detail: 'the change' };
const FILE: Evidence = { kind: 'file', ref: 'config.ts:3', detail: 'LOG_BUDGET = 100' };
const TEST: Evidence = { kind: 'test', ref: 'test/config.test.ts', detail: 'it passes' };
const SETTLING: Evidence[] = [COMMIT, FILE, TEST, { kind: 'claimed-command', ref: 'grep LOG_BUDGET config.ts', detail: '100' }];
const REGISTRY = SignerRegistry.load({ signers: [{ id: 'johnny', role: 'human' }, { id: 'kim', role: 'human' }, { id: 'sam', role: 'human' }, { id: 'agent:*', role: 'agent' }] });

/** Short sentences that pass every text rule (letters, four or more characters). */
const sentence = fc.array(fc.constantFrom('the', 'budget', 'retries', 'cache', 'cluster', 'region', 'cap', 'queue', 'is', 'reads', 'once', 'twice', 'small', 'large'), { minLength: 2, maxLength: 6 }).map((w) => `${w.join(' ')}.`);
const agentId = fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/).map((s) => `agent:${s}`);
/** Approver sessions; never `sess-u`, the session the `uv` helper writes an agent's target under (an approval from it is contempt, not a witness). */
const session = fc.stringMatching(/^sess-[a-z0-9]{1,6}$/).filter((s) => s !== 'sess-u');

/** A ledger on its own in-memory database. */
const fresh = () => {
  const db = new Database(':memory:');
  const ledger = new TruthLedger(db);
  return { db, ledger };
};
const tb = (ledger: TruthLedger, claim: string, ts: string, extra: { premises?: Array<{ id: string; contentHash: string }>; signedBy?: string; evidence?: Evidence[] } = {}): TbEntry =>
  ledger.assertTombstone(
    { claim, evidence: extra.evidence ?? [COMMIT], signedBy: extra.signedBy ?? 'johnny', premises: extra.premises, inference: extra.premises ? 'It follows.' : undefined },
    { author: extra.signedBy ?? 'johnny', timestamp: ts }
  );
const uv = (ledger: TruthLedger, assertion: string, ts: string, extra: { premises?: Array<{ id: string; contentHash: string }>; author?: string; horizon?: number } = {}): UvEntry =>
  ledger.assertUv(
    { assertion, basis: 'the design doc', verifyBy: { kind: 'inspect', value: 'src/x.ts' }, premises: extra.premises, inference: extra.premises ? 'It follows.' : undefined, horizon: extra.horizon },
    { author: extra.author ?? 'sam', agentSessionId: extra.author?.startsWith('agent:') ? 'sess-u' : null, timestamp: ts }
  );
const pin = (e: TruthEntry) => ({ id: e.id, contentHash: e.contentHash! });

/**
 * A random derivation graph, written through the ledger: `n` entries, each a
 * TB or a UV, each deriving from a random subset of the entries before it.
 * Returns the entries in ledger order and each one's direct premises.
 */
const graph = fc.array(fc.tuple(fc.boolean(), fc.array(fc.nat(15), { maxLength: 3 }), sentence), { minLength: 1, maxLength: 8 });
function build(ledger: TruthLedger, shape: Array<[boolean, number[], string]>): { entries: TruthEntry[]; premises: Map<string, string[]> } {
  const entries: TruthEntry[] = [];
  const premises = new Map<string, string[]>();
  shape.forEach(([isTb, picks, text], i) => {
    const chosen = [...new Set(picks.filter((p) => p < entries.length))].map((p) => entries[p]);
    const ts = at(i * MIN);
    const entry = isTb ? tb(ledger, text, ts, chosen.length ? { premises: chosen.map(pin) } : {}) : uv(ledger, text, ts, chosen.length ? { premises: chosen.map(pin) } : {});
    entries.push(entry);
    premises.set(entry.id, chosen.map((c) => c.id));
  });
  return { entries, premises };
}
/** Every entry resting on `id`, transitively. */
function closure(ledger: TruthLedger, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const d of ledger.dependentsOf(stack.pop()!)) if (!out.has(d.id)) (out.add(d.id), stack.push(d.id));
  }
  return out;
}
const RUNS = { numRuns: 40 };

describe('the chain (spec: Streams)', () => {
  it('P1 every line hashes over its predecessor: a mutation anywhere breaks verification from that line forward', () => {
    fc.assert(
      fc.property(graph, fc.nat(), fc.boolean(), (shape, pick, rehash) => {
        const { ledger } = fresh();
        build(ledger, shape);
        const lines = exportWikiEntries(ledger).lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        const k = pick % lines.length;
        const mutated = { ...lines[k], mutated: 'x' } as Record<string, unknown>;
        if (rehash) mutated.hash = wikiLineHash(mutated);
        const texts = lines.map((l, i) => JSON.stringify(i === k ? mutated : l));
        const decoded = texts.map((t) => {
          try {
            return decodeWikiLine(t);
          } catch {
            return null;
          }
        });
        if (!rehash) {
          // The line's own hash no longer matches: the codec refuses it
          expect(decoded[k]).toBeNull();
        } else if (k + 1 < lines.length) {
          // Its hash changed, so the next line's prevHash no longer names it
          expect(checkWikiChain(decoded).map((b) => b.index)).toContain(k + 1);
        }
        const other = fresh().ledger;
        expect(importWikiEntries(other, { lines: texts }).committed).toBe(rehash && k === lines.length - 1);
      }),
      RUNS
    );
  });

  it('P2 the ledger detects a change to any chained row at that row', () => {
    fc.assert(
      fc.property(graph, fc.nat(), (shape, pick) => {
        const { db, ledger } = fresh();
        const { entries } = build(ledger, shape);
        expect(ledger.verify().ok).toBe(true);
        const victim = entries[pick % entries.length];
        db.prepare(`UPDATE truth_entries SET body = json_set(body, '$.tampered', 1) WHERE id = ?`).run(victim.id);
        const report = ledger.verify();
        expect(report.ok).toBe(false);
        expect(report.failure).toMatchObject({ kind: 'hash', id: victim.id });
      }),
      RUNS
    );
  });
});

describe('identities (spec: Identities, Importing rule 3)', () => {
  it('P3 the identity on a line is bound into its hash: a line never verifies under another author or signer', () => {
    fc.assert(
      fc.property(graph, fc.nat(), fc.constantFrom('author', 'signedBy'), (shape, pick, field) => {
        const { ledger } = fresh();
        build(ledger, shape);
        const lines = exportWikiEntries(ledger).lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        const k = pick % lines.length;
        if (field === 'signedBy' && lines[k].type !== 'TB') return;
        const swapped = { ...lines[k], [field]: 'mallory' };
        expect(() => decodeWikiLine(JSON.stringify(swapped))).toThrow(/hash mismatch/);
      }),
      RUNS
    );
  });

  it('P4 a TB an agent signs alone is refused at write and never lands as truth on import, whatever its name and with or without a registry', () => {
    fc.assert(
      fc.property(agentId, sentence, fc.boolean(), (agent, claim, registry) => {
        // At write: the ledger's admission check refuses it
        const writer = fresh().ledger;
        expect(() => tb(writer, claim, at(0), { signedBy: agent })).toThrow(/needs a quorum/);
        // At import: a line that claims it anyway (a person's TB with the names swapped, re-hashed as a writer would) is filed, never truth
        const human = tb(writer, claim, at(0));
        const line = JSON.parse(exportWikiEntries(writer).lines[0]) as Record<string, unknown>;
        const { hash: _h, ...forged } = { ...line, author: agent, signedBy: agent };
        const text = JSON.stringify({ ...forged, hash: wikiLineHash(forged) });
        const reader = fresh().ledger;
        const result = importWikiEntries(reader, { lines: [text] }, { signers: registry ? REGISTRY : null });
        expect(result.committed).toBe(true);
        expect(reader.getEntry(human.id)).toBeNull();
        expect(result.proposals.map((p) => p.reason)).toEqual(['agent-without-quorum']);
        expect(reader.getTruth('current')).toHaveLength(0);
      }),
      RUNS
    );
  });
});

describe('corroboration (spec: Agent quorum, Nomination)', () => {
  const candidate = fc.record({
    id: fc.stringMatching(/^c[0-9]{1,4}$/),
    agentSessionId: session,
    createdAt: fc.nat(1000).map((m) => at(m * MIN)),
    evidence: fc.subarray(SETTLING, { minLength: 1 }),
  });

  it('P5 attestations sharing a session or a provenance root never count as independent', () => {
    fc.assert(
      fc.property(fc.array(candidate, { minLength: 2, maxLength: 8 }), session, fc.constantFrom(...SETTLING), (cands, one, item) => {
        // One session, however many verdicts: never a nomination, never a quorum
        const sameSession = cands.map((c) => ({ ...c, agentSessionId: one }));
        expect(chooseNomination(sameSession)).toBeNull();
        expect(chooseQuorum(sameSession[0], sameSession, Number.MAX_SAFE_INTEGER).members ?? null).toBeNull();
        // Distinct sessions, one shared evidence item each: the same root, never independent
        const sameRoot = cands.map((c, i) => ({ ...c, agentSessionId: `sess-${i}`, evidence: [item] }));
        expect(chooseNomination(sameRoot)).toBeNull();
      }),
      RUNS
    );
  });

  it('P6 N copies of one attestation corroborate exactly as much as one', () => {
    fc.assert(
      fc.property(candidate, fc.integer({ min: 1, max: 10 }), (c, n) => {
        const copies = Array.from({ length: n }, (_, i) => ({ ...c, id: `${c.id}-${i}` }));
        expect(chooseNomination(copies)).toEqual(chooseNomination([c]));
        expect(chooseNomination(copies)).toBeNull();
      }),
      RUNS
    );
    // And in the ledger: a session approves once; its later approvals are refused, and it stays one approver
    const { db, ledger } = fresh();
    const approvals = new UvApprovals(db, ledger);
    const target = uv(ledger, 'The cap is read once.', at(0), { author: 'agent:researcher' });
    approvals.approve({ uvId: target.id, by: 'agent:claude', role: 'agent', agentSessionId: 'sess-same', evidence: [COMMIT] }, T0 + MIN);
    for (let i = 1; i < 5; i++) {
      expect(() => approvals.approve({ uvId: target.id, by: 'agent:claude', role: 'agent', agentSessionId: 'sess-same', evidence: [SETTLING[i % SETTLING.length]] }, T0 + (i + 1) * MIN)).toThrow(/one session is one approver/);
    }
    expect(approvals.summary(target.id)).toMatchObject({ approvers: 1, human: false, nominated: false });
    expect(ledger.getEntry(target.id)).toMatchObject({ body: { status: 'open' } });
    expect((ledger.getEntry(target.id) as UvEntry).corroborated).toBeUndefined();
  });
});

describe('derivation (spec: Derivation)', () => {
  it('P7 the premise graph is acyclic by construction: every premise precedes the entry that rests on it', () => {
    fc.assert(
      fc.property(graph, (shape) => {
        const { ledger } = fresh();
        build(ledger, shape);
        const seq = new Map(ledger.getChainedRecords().map((r) => [r.id, r.seq]));
        for (const r of ledger.getChainedRecords()) for (const l of r.links) if (l.type === 'derives') expect(seq.get(l.toId)!).toBeLessThan(r.seq);
        expect(ledger.verify().ok).toBe(true);
        // An entry can't rest on itself or on an id the ledger doesn't hold
        const last = ledger.getChainedRecords().at(-1)!;
        expect(() => tb(ledger, 'Circular.', at(DAY), { premises: [{ id: last.id, contentHash: ledger.contentHashOf(last.id)! }, { id: 'nope', contentHash: 'a'.repeat(64) }] })).toThrow(TruthWriteError);
      }),
      RUNS
    );
  });

  it('P8 a write citing a dead premise is refused', () => {
    fc.assert(
      fc.property(graph, fc.nat(), fc.constantFrom('strike', 'kill'), (shape, pick, how) => {
        const { ledger } = fresh();
        const { entries } = build(ledger, shape);
        const victim = entries[pick % entries.length];
        if (how === 'strike') ledger.fileRuling({ kind: 'strike', opinion: 'abandoned', target: victim.id }, { author: 'johnny', timestamp: at(DAY) });
        else if (victim.type === 'TB') ledger.overrideTombstone(victim.id, { evidence: [FILE] }, { author: 'kim', timestamp: at(DAY) });
        else ledger.resolveUv(victim.id, 'refuted', [FILE], { author: 'kim', timestamp: at(DAY) });
        expect(() => tb(ledger, 'Rests on the dead.', at(2 * DAY), { premises: [pin(victim)] })).toThrow(TruthWriteError);
        expect(() => uv(ledger, 'Rests on the dead.', at(2 * DAY), { premises: [pin(victim)] })).toThrow(TruthWriteError);
      }),
      RUNS
    );
  });

  it('P9 a contentHash that is not the premise\'s is refused', () => {
    fc.assert(
      fc.property(graph, fc.nat(), fc.stringMatching(/^[0-9a-f]{64}$/), (shape, pick, hash) => {
        const { ledger } = fresh();
        const { entries } = build(ledger, shape);
        const premise = entries[pick % entries.length];
        fc.pre(hash !== premise.contentHash);
        expect(() => tb(ledger, 'Pinned wrong.', at(DAY), { premises: [{ id: premise.id, contentHash: hash }] })).toThrow(TruthWriteError);
      }),
      RUNS
    );
  });
});

describe('standing and suspicion (spec: Derivation, the suspicion detector)', () => {
  it('P10 striking a premise makes exactly its transitive dependents unsupported, and changes no other standing', () => {
    fc.assert(
      fc.property(graph, fc.nat(), (shape, pick) => {
        const { ledger } = fresh();
        const { entries } = build(ledger, shape);
        const before = new Map(entries.map((e) => [e.id, ledger.standingOf(e.id).standing]));
        const victim = entries[pick % entries.length];
        ledger.fileRuling({ kind: 'strike', opinion: 'abandoned', target: victim.id }, { author: 'johnny', timestamp: at(DAY) });
        const affected = closure(ledger, victim.id);
        for (const e of entries) {
          if (e.id === victim.id) continue;
          const now = ledger.standingOf(e.id).standing;
          if (affected.has(e.id)) expect(now).toBe('unsupported');
          else expect(now).toBe(before.get(e.id));
        }
        expect(ledger.verify().ok).toBe(true);
      }),
      RUNS
    );
  });

  it('P11 refuting a derived entry on independent evidence files one review per live TB premise and changes no premise\'s status', () => {
    fc.assert(
      fc.property(graph, (shape) => {
        const { ledger } = fresh();
        const { entries, premises } = build(ledger, shape);
        const derived = entries.find((e) => e.type === 'UV' && premises.get(e.id)!.length > 0) as UvEntry | undefined;
        fc.pre(derived !== undefined);
        const statusBefore = new Map(premises.get(derived!.id)!.map((id) => [id, ledger.getEntry(id)!.body.status]));
        const { suspects } = ledger.resolveUv(derived!.id, 'refuted', [FILE], { author: 'kim', timestamp: at(DAY) });
        const liveTbs = premises.get(derived!.id)!.filter((id) => ledger.getEntry(id)!.type === 'TB' && ledger.getEntry(id)!.body.status !== 'overridden' && !ledger.isStruck(id));
        expect(suspects.map((p) => p.body.targetRef).sort()).toEqual(liveTbs.map((id) => `derivation:${derived!.id}:${id}`).sort());
        for (const p of suspects) expect(p.author).toBe(DERIVATION_DETECTOR);
        for (const [id, status] of statusBefore) expect(ledger.getEntry(id)!.body.status).toBe(status);
      }),
      RUNS
    );
  });
});

describe('promotion (spec: Approvals and promotion)', () => {
  const agentApproval = fc.record({ by: agentId, agentSessionId: session, evidence: fc.subarray(SETTLING, { minLength: 1 }) });

  it('P12 no sequence of agent or reporter approvals mints a TB; a person\'s approval plus one more does', () => {
    fc.assert(
      fc.property(fc.uniqueArray(agentApproval, { minLength: 0, maxLength: 8, selector: (a) => a.agentSessionId }), (approvalsIn) => {
        const { db, ledger } = fresh();
        const approvals = new UvApprovals(db, ledger);
        const target = uv(ledger, 'The cap is read once.', at(0), { author: 'agent:researcher' });
        approvalsIn.forEach((a, i) => {
          const out = approvals.approve({ uvId: target.id, role: 'agent', ...a }, T0 + (i + 1) * MIN);
          expect(out.status).not.toBe('promoted');
        });
        expect(ledger.getTruth('all').filter((e) => e.type === 'TB')).toHaveLength(0);
        expect((ledger.getEntry(target.id) as UvEntry).body.status).toBe('open');
        // A person's approval with one other approver promotes, and the person answers for the TB
        const human = approvals.approve({ uvId: target.id, by: 'johnny', role: 'human', note: 'checked' }, T0 + 100 * MIN);
        if (approvalsIn.length === 0) {
          expect(human.status).toBe('approved');
          expect(approvals.approve({ uvId: target.id, by: 'agent:other', role: 'agent', agentSessionId: 'sess-z', evidence: [COMMIT] }, T0 + 101 * MIN).status).toBe('promoted');
        } else {
          expect(human.status).toBe('promoted');
        }
        const minted = ledger.getTruth('current').filter((e) => e.type === 'TB') as TbEntry[];
        expect(minted).toHaveLength(1);
        expect(minted[0].body).toMatchObject({ signedBy: 'johnny', answerableBy: 'johnny' });
      }),
      RUNS
    );
  });
});

describe('freshness (spec: Freshness)', () => {
  const reattestations = fc.array(fc.record({ id: fc.stringMatching(/^r[0-9]{1,3}$/), ts: fc.nat(60).map((d) => at(d * DAY)) }), { maxLength: 4 });
  const clocks = fc.array(fc.nat(120).map((d) => T0 + d * DAY), { minLength: 2, maxLength: 6 });
  const horizon = fc.option(fc.integer({ min: 1, max: 40 * 24 * 3600 }), { nil: undefined });

  it('P13 for a fixed line, freshness is monotone in the clock: once stale, stale', () => {
    fc.assert(
      fc.property(fc.nat(30).map((d) => at(d * DAY)), horizon, reattestations, clocks, (ts, h, re, cs) => {
        const states = [...cs].sort((a, b) => a - b).map((now) => freshness({ ts, horizon: h }, re, now).state);
        for (let i = 1; i < states.length; i++) if (states[i - 1] === 'stale') expect(states[i]).toBe('stale');
        const elapsed = [...cs].sort((a, b) => a - b).map((now) => freshness({ ts, horizon: h }, re, now).elapsedSeconds);
        for (let i = 1; i < elapsed.length; i++) expect(elapsed[i]).toBeGreaterThanOrEqual(elapsed[i - 1]);
      }),
      { numRuns: 200 }
    );
  });

  it('P14 a TB\'s rendering is invariant under the clock: it has no freshness at any time', () => {
    fc.assert(
      fc.property(graph, clocks, (shape, cs) => {
        const { ledger } = fresh();
        const { entries } = build(ledger, shape);
        for (const e of entries.filter((e) => e.type === 'TB')) for (const now of cs) expect(ledger.freshnessOf(e.id, now)).toBeNull();
        for (const e of entries.filter((e) => e.type === 'UV')) for (const now of cs) expect(ledger.freshnessOf(e.id, now)).not.toBeNull();
      }),
      RUNS
    );
  });

  it('P15 a re-attestation resets freshness from its own timestamp, and the horizon never exceeds the default', () => {
    fc.assert(
      fc.property(fc.nat(30).map((d) => at(d * DAY)), horizon, reattestations, (ts, h, re) => {
        const f = freshness({ ts, horizon: h }, re, T0 + 200 * DAY);
        const newest = [...re.map((r) => r.ts), ts].sort().at(-1)!;
        expect(f.since).toBe(newest);
        expect(f.horizonSeconds).toBeLessThanOrEqual(DEFAULT_UV_HORIZON_SECONDS);
        if (h !== undefined) expect(f.horizonSeconds).toBe(Math.min(h, DEFAULT_UV_HORIZON_SECONDS));
        // Right up to the horizon it is fresh; one second past, stale
        expect(freshness({ ts, horizon: h }, re, Date.parse(newest) + f.horizonSeconds * 1000).state).toBe('fresh');
        expect(freshness({ ts, horizon: h }, re, Date.parse(newest) + (f.horizonSeconds + 1) * 1000).state).toBe('stale');
      }),
      { numRuns: 200 }
    );
  });

  it('P16 the docket orders nominated, then stale, then plain open UVs, and a stale UV blocks nothing', () => {
    const member = (s: string, e: Evidence, ts: string): QuorumMember => ({ author: 'agent:claude', agentSessionId: s, ts, evidence: [e], verdict: 'verified' });
    fc.assert(
      fc.property(fc.array(fc.record({ age: fc.nat(60), nominated: fc.boolean(), text: sentence }), { minLength: 1, maxLength: 7 }), (uvsIn) => {
        const { db, ledger } = fresh();
        const approvals = new UvApprovals(db, ledger);
        const attestations = new UvAttestations(db, ledger);
        const now = T0 + 61 * DAY;
        const expectStale = new Map<string, boolean>();
        for (const u of uvsIn) {
          const entry = uv(ledger, u.text, at(u.age * DAY), { author: 'agent:researcher' });
          if (u.nominated) {
            // A nomination at the UV's own time re-attests it, so its staleness is measured from there too
            ledger.nominateUv(entry.id, [member('sess-a', COMMIT, at(u.age * DAY)), member('sess-b', FILE, at(u.age * DAY)), member('sess-c', TEST, at(u.age * DAY))], { author: 'agent:claude', agentSessionId: 'sess-c', timestamp: at(u.age * DAY) });
          }
          expectStale.set(entry.id, (61 - u.age) * DAY > DEFAULT_UV_HORIZON_SECONDS * 1000);
        }
        const docket = buildDocket({ ledger, approvals, attestations }, now);
        const items = docket.groups.flatMap((g) => g.items);
        const rank = (i: (typeof items)[number]) => (i.nominated ? 0 : i.stale ? 1 : 2);
        for (let i = 1; i < items.length; i++) {
          expect(rank(items[i])).toBeGreaterThanOrEqual(rank(items[i - 1]));
          if (rank(items[i]) === rank(items[i - 1])) expect(items[i].createdAt >= items[i - 1].createdAt).toBe(true);
        }
        for (const item of items) {
          expect(item.stale).toBe(expectStale.get(item.id));
          expect(item.freshness!.at).toBe(new Date(now).toISOString());
          expect((ledger.getEntry(item.id) as UvEntry).body.status).toBe('open');
        }
        expect(docket.asOf).toBe(new Date(now).toISOString());
      }),
      RUNS
    );
  });
});

describe('reads (spec: Reading)', () => {
  it('P17 no read changes the ledger: its bytes and its stream are the same after any sequence of reads', () => {
    const reads: Array<(ledger: TruthLedger, db: Database.Database, ids: string[], now: number) => unknown> = [
      (l, _d, ids) => ids.map((id) => l.getEntry(id)),
      (l) => l.getTruth('current'),
      (l) => l.getTruth('all'),
      (l) => l.getTruth('contested'),
      (l) => l.getOpenUvs(),
      (l) => l.getContested(),
      (l) => l.getPrecedents({ all: true }),
      (l, _d, ids, now) => ids.map((id) => l.freshnessOf(id, now)),
      (l, _d, ids) => ids.map((id) => l.standingOf(id)),
      (l, _d, ids) => ids.map((id) => l.dependentsOf(id)),
      (l) => l.verify(),
      (l) => exportWikiEntries(l),
      (l, d, _ids, now) => buildDocket({ ledger: l, approvals: new UvApprovals(d, l), attestations: new UvAttestations(d, l) }, now),
      (l) => l.getStats(),
    ];
    fc.assert(
      fc.property(graph, fc.array(fc.nat(reads.length - 1), { minLength: 1, maxLength: 12 }), fc.nat(120), (shape, picks, days) => {
        const { db, ledger } = fresh();
        const { entries } = build(ledger, shape);
        // Approvals and attestations tables exist before the snapshot, so the docket read creates nothing
        new UvApprovals(db, ledger);
        new UvAttestations(db, ledger);
        const bytes = db.serialize();
        const stream = exportWikiEntries(ledger).lines;
        const head = ledger.verify().head;
        for (const p of picks) reads[p](ledger, db, entries.map((e) => e.id), T0 + days * DAY);
        expect(db.serialize().equals(bytes)).toBe(true);
        expect(exportWikiEntries(ledger).lines).toEqual(stream);
        expect(ledger.verify().head).toEqual(head);
      }),
      RUNS
    );
  });
});

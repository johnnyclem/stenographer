import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StateStore } from '../src/store/index.js';
import { TruthLedger } from '../src/truth/ledger.js';
import { chainRecord, type LedgerRow } from '../src/truth/chain.js';
import { canonicalize, sha256Hex } from '../src/truth/jcs.js';
import { runVerifyCLI, startupLedgerCheck } from '../src/truth/verify-cli.js';
import { runNotaryCLI } from '../src/truth/notary-cli.js';
import { importWikiEntries } from '../src/truth/wiki.js';
import {
  EVIDENCE_KINDS,
  SETTLING_EVIDENCE_KINDS,
  EvidenceSchema,
  evidenceClass,
  isSelfSigningEvidence,
  type Evidence,
  type MarkerBody,
  type ProposalEntry,
  type TbEntry,
  type UvEntry,
} from '../src/truth/types.js';

const commitEvidence: Evidence[] = [{ kind: 'commit', ref: 'abc1234' }];
const fileEvidence: Evidence[] = [{ kind: 'file', ref: 'src/limiter.ts:12', detail: 'sliding window' }];

describe('derived status (STENO-T-06)', () => {
  let store: StateStore;
  let ledger: TruthLedger;

  beforeEach(() => {
    store = new StateStore(':memory:');
    ledger = store.truth;
  });

  afterEach(() => {
    store.close();
  });

  const tb = (): TbEntry =>
    ledger.assertTombstone(
      {
        claim: 'LOG_BUDGET 30 is dead; it is 100',
        evidence: commitEvidence,
        signedBy: 'johnny',
        literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
      },
      { author: 'johnny' }
    );
  const contest = (tbId: string, author: string): UvEntry =>
    ledger.assertUv(
      {
        assertion: `LOG_BUDGET is still 30 (${author})`,
        basis: 'a dashboard',
        verifyBy: { kind: 'inspect', value: 'config.ts' },
        contests: tbId,
      },
      { author }
    );
  const status = (id: string) => (ledger.getEntry(id)!.body as { status: string }).status;
  const matchable = () => ledger.getMatchableTombstones().map((t) => t.id);

  it('refuting the second contest of an overridden TB does not resurrect it', () => {
    const dead = tb();
    const uv1 = contest(dead.id, 'sam');
    const uv2 = contest(dead.id, 'alex');

    ledger.resolveUv(uv1.id, 'verified', fileEvidence, { author: 'kim', signedBy: 'lee', opinion: 'the file says so' });
    expect(status(dead.id)).toBe('overridden');

    ledger.resolveUv(uv2.id, 'refuted', fileEvidence, { author: 'kim' });
    expect(status(uv2.id)).toBe('refuted');
    expect(status(dead.id)).toBe('overridden');
    expect(matchable()).not.toContain(dead.id);
    expect(ledger.getTruth('current').map((e) => e.id)).not.toContain(dead.id);
  });

  it('refuting the contest of a force-overridden TB does not resurrect it', () => {
    const dead = tb();
    const uv = contest(dead.id, 'sam');
    ledger.overrideTombstone(dead.id, { evidence: commitEvidence, note: 'reverted' }, { author: 'lee' });
    expect(status(dead.id)).toBe('overridden');

    ledger.resolveUv(uv.id, 'refuted', fileEvidence, { author: 'kim' });
    expect(status(dead.id)).toBe('overridden');
    expect(matchable()).not.toContain(dead.id);
  });

  it('a TB stays contested while any contest is open, and is active again once all are refuted', () => {
    const live = tb();
    const uv1 = contest(live.id, 'sam');
    const uv2 = contest(live.id, 'alex');
    ledger.resolveUv(uv1.id, 'refuted', fileEvidence, { author: 'kim' });
    expect(status(live.id)).toBe('contested');
    ledger.resolveUv(uv2.id, 'refuted', fileEvidence, { author: 'kim' });
    expect(status(live.id)).toBe('active');
    expect(matchable()).toContain(live.id);
  });
});

// ─────────────────────────────────────────────────────────────
// Hash chain, verify, append-only dismissal, migration
// ─────────────────────────────────────────────────────────────

/** A ledger exercising every write path, on a database the test can tamper with. */
function seed(ledger: TruthLedger) {
  const tb = ledger.assertTombstone(
    { claim: 'LOG_BUDGET 30 is dead', evidence: commitEvidence, signedBy: 'johnny', literals: [{ subject: 'LOG_BUDGET', dead: '30' }] },
    { author: 'johnny' }
  );
  const uv1 = ledger.assertUv(
    { assertion: 'It is 30 again.', basis: 'hotfix', verifyBy: { kind: 'inspect', value: 'config.ts' }, contests: tb.id },
    { author: 'sam' }
  );
  const uv2 = ledger.assertUv(
    { assertion: 'Staging says 30.', basis: 'dashboard', verifyBy: { kind: 'command', value: 'grep LOG_BUDGET .env' }, contests: tb.id },
    { author: 'alex' }
  );
  const resolved = ledger.resolveUv(uv1.id, 'verified', fileEvidence, { author: 'kim', signedBy: 'lee', opinion: 'config.ts says 30' });
  ledger.resolveUv(uv2.id, 'refuted', [{ kind: 'command', ref: 'grep LOG_BUDGET .env', detail: '100' }], { author: 'kim' });
  const proposal = ledger.addProposal(
    { kind: 'tombstone', draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] }, signal: { source: 'supersession-detector' }, targetRef: 'd1' },
    { author: 'detector:supersession' }
  );
  const dismissed = ledger.dismissProposal(proposal.id, 'johnny', 'false positive');
  const signedDraft = ledger.draftTombstone({ claim: 'fetchV1 is dead', evidence: commitEvidence, literals: [{ dead: 'fetchV1' }] }, { author: 'agent:a' });
  const signed = ledger.signProposal(signedDraft.id, 'johnny', undefined, { notarized: true });
  const struck = ledger.assertTombstone({ claim: 'The cron box is gone', evidence: commitEvidence, signedBy: 'lee' }, { author: 'lee' });
  ledger.fileRuling({ kind: 'strike', opinion: 'wrong branch', target: struck.id }, { author: 'johnny' });
  ledger.backfillLegacyTombstone({ id: 't1', superseded: 'a', correctedTo: 'b', reason: 'r', timestamp: '2026-01-01T00:00:00Z' });
  return { tb, uv1, uv2, successor: resolved.tombstone!, proposal, dismissed, signed, struck };
}

describe('hash chain and verify', () => {
  let db: Database.Database;
  let ledger: TruthLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TruthLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  const rows = () =>
    db.prepare('SELECT * FROM truth_entries ORDER BY seq').all() as LedgerRow[];

  it('chains every entry to the one before it, in insertion order', () => {
    seed(ledger);
    const all = rows();
    expect(all.length).toBeGreaterThan(10);
    all.forEach((row, i) => {
      expect(row.seq).toBe(i + 1);
      expect(row.prev_hash).toBe(i === 0 ? null : all[i - 1].hash);
      expect(row.hash).toBe(sha256Hex(canonicalize(chainRecord(row))));
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    });
    const report = ledger.verify();
    expect(report).toMatchObject({ ok: true, failure: null, entries: all.length, chainedAtMigration: null });
    expect(report.head).toEqual({ seq: all.length, id: all.at(-1)!.id, hash: all.at(-1)!.hash });
  });

  it('covers the links each entry wrote', () => {
    const { uv1, tb } = seed(ledger);
    const row = db.prepare('SELECT appended_links FROM truth_entries WHERE id = ?').get(uv1.id) as { appended_links: string };
    expect(JSON.parse(row.appended_links)).toEqual([{ fromId: uv1.id, toId: tb.id, type: 'contests' }]);
  });

  it('a row edited in SQLite fails verify at that entry', () => {
    const { tb } = seed(ledger);
    db.prepare(`UPDATE truth_entries SET body = json_set(body, '$.claim', 'LOG_BUDGET 100 is dead') WHERE id = ?`).run(tb.id);
    const report = ledger.verify();
    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ kind: 'hash', id: tb.id, seq: 1 });
  });

  it('an edited author, target ref or agent session fails verify too', () => {
    const { signed, proposal } = seed(ledger);
    for (const [sql, id] of [
      [`UPDATE truth_entries SET author = 'mallory' WHERE id = ?`, signed.id],
      [`UPDATE truth_entries SET target_ref = 'other' WHERE id = ?`, proposal.id],
      [`UPDATE truth_entries SET agent_session_id = 'sess_x' WHERE id = ?`, signed.id],
    ] as const) {
      db.exec('SAVEPOINT t');
      db.prepare(sql).run(id);
      expect(ledger.verify().failure, sql).toMatchObject({ kind: 'hash', id });
      db.exec('ROLLBACK TO t; RELEASE t');
    }
    expect(ledger.verify().ok).toBe(true);
  });

  it('a cached status its links do not justify fails verify (the T-06 resurrection, done by hand)', () => {
    const { tb, struck } = seed(ledger);
    db.exec('SAVEPOINT t');
    db.prepare(`UPDATE truth_entries SET status = 'active' WHERE id = ?`).run(tb.id);
    expect(ledger.verify().failure).toMatchObject({ kind: 'status', id: tb.id });
    db.exec('ROLLBACK TO t; RELEASE t');

    db.prepare(`UPDATE truth_entries SET struck = 0 WHERE id = ?`).run(struck.id);
    expect(ledger.verify().failure).toMatchObject({ kind: 'struck', id: struck.id });
  });

  it('a deleted or forged link fails verify', () => {
    const { tb, uv1 } = seed(ledger);
    db.exec('SAVEPOINT t');
    db.prepare(`DELETE FROM truth_links WHERE link_type = 'overrides' AND to_id = ?`).run(tb.id);
    expect(ledger.verify().failure).toMatchObject({ kind: 'missing-link' });
    db.exec('ROLLBACK TO t; RELEASE t');

    db.prepare(`INSERT INTO truth_links (from_id, to_id, link_type) VALUES (?, ?, 'strikes')`).run(uv1.id, tb.id);
    expect(ledger.verify().failure).toMatchObject({ kind: 'undeclared-link', id: tb.id });
  });

  it('a deleted, reordered or unchained entry fails verify', () => {
    const { uv2, signed } = seed(ledger);
    db.exec('SAVEPOINT t');
    db.prepare('DELETE FROM truth_entries WHERE id = ?').run(uv2.id);
    expect(ledger.verify().failure).toMatchObject({ kind: 'sequence' });
    db.exec('ROLLBACK TO t; RELEASE t');

    db.exec('SAVEPOINT t');
    // Swap two entries' positions
    const a = db.prepare('SELECT seq FROM truth_entries WHERE id = ?').get(signed.id) as { seq: number };
    db.prepare('UPDATE truth_entries SET seq = -1 WHERE seq = ?').run(a.seq - 1);
    db.prepare('UPDATE truth_entries SET seq = ? WHERE seq = ?').run(a.seq - 1, a.seq);
    db.prepare('UPDATE truth_entries SET seq = ? WHERE seq = -1').run(a.seq);
    expect(ledger.verify().failure).toMatchObject({ kind: 'prev-hash' });
    db.exec('ROLLBACK TO t; RELEASE t');

    // Written around the ledger, as a pre-1.0 stenographer would
    db.prepare(`
      INSERT INTO truth_entries (id, type, created_at, author, provenance, origin, body, status)
      VALUES ('01FORGED', 'TB', '2026-01-01T00:00:00Z', 'johnny', '{"kind":"manual"}', 'local', '{"claim":"x","evidence":[],"signedBy":"johnny"}', 'active')
    `).run();
    expect(ledger.verify().failure).toMatchObject({ kind: 'unchained-entry', id: '01FORGED' });
  });

  it('does not re-chain over a ledger whose chain record was removed', () => {
    const { tb } = seed(ledger);
    db.prepare(`UPDATE truth_entries SET body = json_set(body, '$.claim', 'forged') WHERE id = ?`).run(tb.id);
    db.prepare(`DELETE FROM truth_meta`).run();
    const reopened = new TruthLedger(db);
    expect(reopened.verify().failure).toMatchObject({ kind: 'not-chained' });
    expect(db.prepare(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'MARKER'`).get()).toEqual({ c: 0 });
  });

  it('keeps one chain across connections to the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-chain-'));
    try {
      const path = join(dir, 'state.db');
      const a = new StateStore(path);
      const b = new StateStore(path);
      for (let i = 0; i < 5; i++) {
        a.truth.assertUv({ assertion: `a${i}`, basis: 'b', verifyBy: { kind: 'ask', value: 'x' } }, { author: 'sam' });
        b.truth.assertUv({ assertion: `b${i}`, basis: 'b', verifyBy: { kind: 'ask', value: 'x' } }, { author: 'alex' });
      }
      expect(a.truth.verify()).toMatchObject({ ok: true, entries: 10 });
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('append-only dismissal', () => {
  it('dismissing appends a ruling and never rewrites the proposal', () => {
    const db = new Database(':memory:');
    const ledger = new TruthLedger(db);
    const proposal = ledger.addProposal(
      { kind: 'tombstone', draft: { claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] }, signal: { source: 'supersession-detector' }, targetRef: 'd1' },
      { author: 'detector:supersession' }
    );
    const raw = () => db.prepare('SELECT body, hash FROM truth_entries WHERE id = ?').get(proposal.id);
    const before = raw();
    expect(JSON.parse((before as { body: string }).body)).not.toHaveProperty('status');

    const dismissed = ledger.dismissProposal(proposal.id, 'johnny', 'false positive: unrelated decisions');
    expect(raw()).toEqual(before);
    expect(dismissed.body).toMatchObject({ status: 'dismissed', dismissedBy: 'johnny', dismissReason: 'false positive: unrelated decisions' });

    const rulingLink = dismissed.links.find((l) => l.type === 'dismisses')!;
    const ruling = ledger.getEntry(rulingLink.fromId)!;
    expect(ruling).toMatchObject({ type: 'RULING', author: 'johnny', body: { kind: 'dismissal', target: proposal.id } });
    expect(ledger.listProposals('dismissed').map((p) => p.id)).toEqual([proposal.id]);
    expect(ledger.verify().ok).toBe(true);
    db.close();
  });

  it('no write path rewrites a stored body', () => {
    const db = new Database(':memory:');
    const ledger = new TruthLedger(db);
    const snapshot = new Map<string, string>();
    const capture = () => {
      for (const r of db.prepare('SELECT id, body, hash FROM truth_entries').all() as Array<{ id: string; body: string; hash: string }>) {
        const prior = snapshot.get(r.id);
        if (prior) expect(`${r.body}|${r.hash}`, r.id).toBe(prior);
        snapshot.set(r.id, `${r.body}|${r.hash}`);
      }
    };
    const { tb, signed } = seed(ledger);
    capture();
    ledger.overrideTombstone(signed.id, { evidence: commitEvidence }, { author: 'lee' });
    ledger.fileObjectionRuling({ objectionId: 'o1', tbId: tb.id, outcome: 'sustained', opinion: 'caught it' }, { author: 'lee' });
    capture();
    expect(ledger.verify().ok).toBe(true);
    db.close();
  });
});

describe('entries that cannot be canonicalized', () => {
  it('are refused as a write error, and as a per-line error on wiki import', () => {
    const store = new StateStore(':memory:');
    expect(() =>
      store.truth.assertUv({ assertion: 'bad \ud800 text', basis: 'b', verifyBy: { kind: 'ask', value: 'x' } }, { author: 'sam' })
    ).toThrow(/can't be hashed.*lone surrogate/);
    const line = '{"id":"01WIKIBAD0000000000000000","type":"UV","ts":"2026-01-01T00:00:00Z","author":"teammate",' +
      '"assertion":"bad \\ud800","basis":"b","verifyBy":{"kind":"ask","value":"x"},"contests":null,"status":"open"}';
    const result = importWikiEntries(store.truth, { lines: [line] });
    expect(result).toMatchObject({ inserted: 0, errors: [{ line: 1 }] });
    expect(store.truth.verify()).toMatchObject({ ok: true, entries: 0 });
    store.close();
  });
});

describe('evidence semantics', () => {
  it('records command output a caller submits as claimed-command, which never self-signs', () => {
    const store = new StateStore(':memory:');
    const ledger = store.truth;
    const tb = ledger.assertTombstone(
      { claim: 'x is dead', evidence: [{ kind: 'command', ref: 'npm test', detail: 'pass' }], signedBy: 'johnny' },
      { author: 'johnny' }
    );
    expect(tb.body.evidence).toEqual([{ kind: 'claimed-command', ref: 'npm test', detail: 'pass' }]);
    const draft = ledger.draftTombstone({ claim: 'y is dead', evidence: [{ kind: 'command', ref: 'grep y' }] }, { author: 'agent:a' });
    expect((draft.body.draft as { evidence: Evidence[] }).evidence[0].kind).toBe('claimed-command');
    expect(isSelfSigningEvidence([EvidenceSchema.parse({ kind: 'command', ref: 'true' })])).toBe(false);

    // Neither spelling mints a TB without a person
    for (const kind of ['command', 'claimed-command'] as const) {
      const live = ledger.assertTombstone({ claim: `z ${kind}`, evidence: commitEvidence, signedBy: 'johnny' }, { author: 'johnny' });
      const uv = ledger.assertUv(
        { assertion: 'z lives', basis: 'b', verifyBy: { kind: 'command', value: 'true' }, contests: live.id },
        { author: 'sam' }
      );
      expect(() => ledger.resolveUv(uv.id, 'verified', [{ kind, ref: 'true', detail: 'exit 0' }], { author: 'alex' })).toThrow(
        /signedBy/
      );
      expect((ledger.getEntry(live.id) as TbEntry).body.status).toBe('contested');
    }
    store.close();
  });

  it('knows chat, ticket and doc evidence, and records them as given', () => {
    const store = new StateStore(':memory:');
    const evidence = [
      { kind: 'chat', ref: 'slack:#infra/p1712345678', detail: 'ops confirmed the box is gone' },
      { kind: 'ticket', ref: 'OPS-1432' },
      { kind: 'doc', ref: 'https://wiki.example.com/runbooks/cron' },
    ] as Evidence[];
    expect(evidence.map((e) => EvidenceSchema.parse(e))).toEqual(evidence);
    const tb = store.truth.assertTombstone({ claim: 'The cron box is retired.', evidence, signedBy: 'johnny' }, { author: 'johnny' });
    expect(tb.body.evidence).toEqual(evidence);
    store.close();
  });

  it('sorts every evidence kind into a class: settling, or question (which any kind it does not know falls into)', () => {
    expect([...SETTLING_EVIDENCE_KINDS]).toEqual(['commit', 'file', 'test', 'claimed-command', 'wiki']);
    for (const kind of ['commit', 'file', 'test', 'claimed-command', 'wiki']) expect(evidenceClass(kind), kind).toBe('settling');
    // Pre-1.0 `command` is output nobody re-ran: a question, like a message or a page
    for (const kind of ['message', 'chat', 'ticket', 'doc', 'command']) expect(evidenceClass(kind), kind).toBe('question');
    // Fail closed: a kind this version doesn't know never settles
    for (const kind of ['screenshot', 'url', '', 'Commit', 'commit ']) expect(evidenceClass(kind), JSON.stringify(kind)).toBe('question');
    // Every known kind has a class, and every settling kind is a known one
    for (const kind of EVIDENCE_KINDS) expect(['settling', 'question']).toContain(evidenceClass(kind));
    for (const kind of SETTLING_EVIDENCE_KINDS) expect(EVIDENCE_KINDS).toContain(kind);
  });
});

describe('stenographer verify', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steno-verify-'));
    path = join(dir, 'state.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (args: string[]) => {
    const lines: string[] = [];
    const code = await runVerifyCLI(args, { print: (l) => lines.push(l) });
    return { code, out: lines.join('\n') };
  };

  it('exits 0 on an intact ledger and prints the head hash', async () => {
    const store = new StateStore(path);
    seed(store.truth);
    const head = store.truth.verify().head!;
    store.close();
    const { code, out } = await run([path]);
    expect(code).toBe(0);
    expect(out).toMatch(/^OK: \d+ entries/);
    expect(out).toContain(head.hash);
  });

  it('exits 1 and names the first divergence when a row was tampered with', async () => {
    const store = new StateStore(path);
    const { tb } = seed(store.truth);
    store.close();
    const db = new Database(path);
    db.prepare(`UPDATE truth_entries SET body = json_set(body, '$.signedBy', 'mallory') WHERE id = ?`).run(tb.id);
    db.close();

    const { code, out } = await run([path]);
    expect(code).toBe(1);
    expect(out).toContain('INTEGRITY FAILURE (hash)');
    expect(out).toContain(tb.id);

    const json = await run([path, '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ outcome: 'failed', report: { ok: false, failure: { kind: 'hash', id: tb.id } } });
  });

  it('exits 2 when it cannot run, and never creates the file', async () => {
    const missing = join(dir, 'nope.db');
    expect((await run([missing])).code).toBe(2);
    expect(existsSync(missing)).toBe(false);
    writeFileSync(path, 'not a database');
    expect((await run([path])).code).toBe(2);
  });

  it('start refuses a ledger that fails verification unless --skip-verify is given', () => {
    const store = new StateStore(path);
    const { tb } = seed(store.truth);
    store.close();
    expect(startupLedgerCheck(path)).toMatchObject({ refuse: false });
    expect(startupLedgerCheck(join(dir, 'fresh.db'))).toEqual({ refuse: false, lines: [] });

    const db = new Database(path);
    db.prepare(`UPDATE truth_entries SET status = 'active' WHERE id = ?`).run(tb.id);
    db.close();
    const refused = startupLedgerCheck(path);
    expect(refused.refuse).toBe(true);
    expect(refused.lines.join('\n')).toMatch(/Refusing to start.*--skip-verify/s);
    expect(startupLedgerCheck(path, { skipVerify: true }).refuse).toBe(false);
  });

  it('the terminal notary signs nothing onto a ledger that fails verification', async () => {
    const store = new StateStore(path);
    const { tb } = seed(store.truth);
    const draft = store.truth.draftTombstone({ claim: 'q is dead', evidence: commitEvidence }, { author: 'agent:a' });
    store.close();
    const db = new Database(path);
    db.prepare(`UPDATE truth_entries SET status = 'active' WHERE id = ?`).run(tb.id);
    db.close();

    const io = { interactive: true, print: () => {}, ask: async (q: string) => q.match(/code ([0-9A-Z]+)/)![1] };
    await expect(runNotaryCLI('notarize', [draft.id, '--as', 'johnny', '--state', path], io)).rejects.toThrow(/integrity/);
    const after = new StateStore(path);
    expect((after.truth.getEntry(draft.id) as ProposalEntry).body.status).toBe('open');
    after.close();
  });
});

describe('migration of a pre-1.0 ledger', () => {
  const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'truth-ledger-0.x.sql'), 'utf8');
  // Ids in the fixture (see its header)
  const RESURRECTED_TB = '01M3TB7QCFHZXMB9K5Y9GSKHRG';
  const DISMISSED = '01M3TB7QCQ8YGXH6MS0MN4YP5T';
  const STRUCK_TB = '01M3TB7QCT52HJ8AZ3TPAD8XG9';
  const FORCE_OVERRIDDEN_TB = '01M3TB7QCWJFX4W3SQ3VSK1Y37';
  const WIKI_TB = '01JWIKI0000000000000000001';

  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steno-migrate-'));
    path = join(dir, 'state.db');
    const db = new Database(path);
    db.exec(FIXTURE);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('chains the existing rows as they are, behind a chained-at-migration marker', () => {
    const raw = new Database(path);
    const original = raw.prepare('SELECT id, body FROM truth_entries ORDER BY rowid').all() as Array<{ id: string; body: string }>;
    raw.close();

    const store = new StateStore(path);
    const ledger = store.truth;
    const report = ledger.verify();
    expect(report.ok).toBe(true);
    expect(report.entries).toBe(original.length + 1);
    expect(report.chainedAtMigration).toMatchObject({ entries: original.length });

    const marker = ledger.getEntry(report.chainedAtMigration!.markerId)!;
    expect(marker).toMatchObject({ type: 'MARKER', author: 'migration', provenance: { kind: 'migration' } });
    expect((marker.body as MarkerBody).statusCorrections).toEqual([
      { id: RESURRECTED_TB, field: 'status', was: 'active', now: 'overridden' },
    ]);
    // A link whose endpoints are both elsewhere would be the marker's; this fixture has none
    expect(marker.links).toEqual([]);
    store.close();

    // Nothing was rewritten: bodies are byte-identical, chained in insertion order
    const db = new Database(path);
    const after = db.prepare('SELECT id, body, seq FROM truth_entries ORDER BY seq').all() as Array<{ id: string; body: string; seq: number }>;
    expect(after.slice(0, original.length).map(({ id, body }) => ({ id, body }))).toEqual(original);
    expect(after.at(-1)!.id).toBe(report.chainedAtMigration!.markerId);
    db.close();
  });

  it('fixes the STENO-T-06 resurrection and keeps every other status', () => {
    const store = new StateStore(path);
    const ledger = store.truth;
    const status = (id: string) => (ledger.getEntry(id)!.body as { status: string }).status;
    expect(status(RESURRECTED_TB)).toBe('overridden');
    expect(ledger.getMatchableTombstones().map((t) => t.id)).not.toContain(RESURRECTED_TB);
    expect(status(FORCE_OVERRIDDEN_TB)).toBe('overridden');
    // The wiki line arrived overridden; its overriding addendum stayed in the teammate's ledger
    expect(status(WIKI_TB)).toBe('overridden');
    expect(ledger.getEntry(DISMISSED)!.body).toMatchObject({
      status: 'dismissed',
      dismissedBy: 'johnny',
      dismissReason: 'false positive: unrelated decisions',
    });
    expect(ledger.getTruth('current').map((e) => e.id)).not.toContain(STRUCK_TB);
    expect(ledger.getTruth('all').map((e) => e.id)).toContain(STRUCK_TB);
    // New writes chain on after the marker
    ledger.assertUv({ assertion: 'a', basis: 'b', verifyBy: { kind: 'ask', value: 'x' } }, { author: 'sam' });
    expect(ledger.verify().ok).toBe(true);
    store.close();
  });

  it('runs once', () => {
    new StateStore(path).close();
    const store = new StateStore(path);
    expect(store.truth.getStats()).toMatchObject({ tombstones: 7 });
    expect(store.truth.verify().ok).toBe(true);
    store.close();
    const db = new Database(path);
    expect(db.prepare(`SELECT COUNT(*) c FROM truth_entries WHERE type = 'MARKER'`).get()).toEqual({ c: 1 });
    db.close();
  });

  it('leaves a row it cannot hash out of the chain, for verify to report, instead of failing to open', () => {
    const raw = new Database(path);
    const { body } = raw.prepare('SELECT body FROM truth_entries WHERE id = ?').get(STRUCK_TB) as { body: string };
    // JSON.stringify writes a lone surrogate as the escape \ud800, which parses back to one
    const withLoneSurrogate = JSON.stringify({ ...JSON.parse(body), claim: 'dead \ud800' });
    raw.prepare('UPDATE truth_entries SET body = ? WHERE id = ?').run(withLoneSurrogate, STRUCK_TB);
    raw.close();
    const store = new StateStore(path);
    expect(store.truth.verify().failure).toMatchObject({ kind: 'unchained-entry', id: STRUCK_TB });
    expect(startupLedgerCheck(path).refuse).toBe(true);
    store.close();
  });

  it('stenographer verify on a pre-1.0 file migrates it and says so', async () => {
    const lines: string[] = [];
    const code = await runVerifyCLI([path], { print: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^Chained 17 pre-1\.0 entries at migration/);
    expect(lines.join('\n')).toMatch(/written before the ledger was chained/);
  });
});

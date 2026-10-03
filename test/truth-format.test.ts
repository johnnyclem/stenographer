/**
 * The truth format v2 contract (spec/truth-format).
 *
 * The golden fixtures are built here, from a real ledger with the clock and
 * the random source pinned, and must equal the committed files byte for
 * byte: the fixtures are what this codec writes. To regenerate them after
 * a deliberate format change:
 *
 *   UPDATE_TRUTH_FORMAT_FIXTURES=1 npx vitest run test/truth-format.test.ts
 *
 * Every fixture is then checked against the JSON Schema and the live codec,
 * folded, and imported. short-hand, smallchat and smallchat-swift run the
 * same files.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { TruthLedger } from '../src/truth/ledger.js';
import { SignerRegistry } from '../src/truth/identity.js';
import { UvAttestations, settleTombstoneQuorum } from '../src/truth/attestations.js';
import { quorumEvidence, type QuorumMember } from '../src/truth/quorum.js';
import { importProposalDrafts } from '../src/truth/intake.js';
import { canonicalize } from '../src/truth/jcs.js';
import { decodeWikiLine, exportWikiEntries, importWikiEntries, wikiLineHash, WIKI_STATUSES } from '../src/truth/wiki.js';
import { EVIDENCE_KINDS, evidenceClass, type ProposalEntry, type TbEntry } from '../src/truth/types.js';

const SPEC = join(import.meta.dirname, '..', 'spec', 'truth-format');
const FIXTURES = join(SPEC, 'fixtures');
const read = (path: string) => readFileSync(join(SPEC, path), 'utf8');
const lines = (path: string) => read(path).split('\n').filter((l) => l.length > 0);
const expected = <T>(path: string): T => JSON.parse(read(path));

// ─────────────────────────────────────────────────────────────
// Building the fixtures
// ─────────────────────────────────────────────────────────────

const T = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const jsonl = (items: unknown[]) => items.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n').join('');
const parse = (text: string) => JSON.parse(text) as Record<string, any>;
const rehash = (line: Record<string, unknown>) => ({ ...line, hash: wikiLineHash(line) });

const SIGNERS = {
  signers: [
    // `keys` is reserved for key signing in 1.x: every 1.0 reader must accept it, and ignore it.
    // (A placeholder, not a real key: base64url SHA-256 of 'stenographer truth-format fixture: johnnyclem/2026-09'.)
    { id: 'johnnyclem', role: 'human', keys: [{ alg: 'ed25519', id: 'johnnyclem/2026-09', publicKey: 'vwK0Oit9S-qSuXboNLd6z8x_ZT3Cikae7d8UUSPaxoE' }] },
    { id: 'sam', role: 'human' },
    { id: 'alex', role: 'human' },
    { id: 'kim', role: 'human' },
    { id: 'lee', role: 'human' },
    { id: 'agent:*', role: 'agent' },
  ],
};

/** Runs `fn` with Date.now() and Math.random() pinned, so ULIDs come out the same every time. */
function pinned<R>(fn: () => R): R {
  let clock = Date.parse('2026-09-01T10:00:00.000Z');
  let seed = 0x5eed;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock++);
  const random = vi.spyOn(Math, 'random').mockImplementation(() => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  try {
    return fn();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
}

/** Chains hand-written lines into one stream (seq from `from`), as a writer would. */
function stream(bodies: Array<Record<string, unknown>>, from = 1, prev: string | null = null): string[] {
  const out: string[] = [];
  bodies.forEach((body, i) => {
    const unhashed = { schemaVersion: 2, seq: from + i, ...body, prevHash: prev };
    const hash = wikiLineHash(unhashed);
    out.push(JSON.stringify({ ...unhashed, hash }));
    prev = hash;
  });
  return out;
}

/** The top-level fields the spec defines, per line type: anything else on a line is a newer writer's. */
const ENVELOPE_FIELDS = ['schemaVersion', 'seq', 'id', 'type', 'ts', 'author', 'prevHash', 'hash', 'x-steno'];
const BODY_FIELDS: Record<string, string[]> = {
  TB: ['claim', 'evidence', 'signedBy', 'literals', 'quorum', 'status'],
  UV: ['assertion', 'basis', 'verifyBy', 'contests', 'status'],
  ADDENDUM: ['evidence', 'note', 'quorum'],
  RULING: ['kind', 'opinion', 'target'],
  TRANSITION: ['target', 'status', 'cause'],
};
const unknownFields = (line: Record<string, unknown>) =>
  Object.keys(line).filter((k) => !ENVELOPE_FIELDS.includes(k) && !BODY_FIELDS[line.type as string].includes(k));

/** The fold every reader applies: the highest-seq TRANSITION's status, else the entry line's own. */
function fold(stream: string[]): Record<string, { type: string; status: string | null; current: boolean }> {
  const out: Record<string, { type: string; status: string | null; current: boolean }> = {};
  const sorted = stream.map(parse).sort((a, b) => a.seq - b.seq);
  for (const line of sorted) {
    if (line.type === 'TB' || line.type === 'UV') out[line.id] = { type: line.type, status: line.status ?? null, current: false };
  }
  for (const line of sorted) {
    if (line.type === 'TRANSITION' && out[line.target]) out[line.target].status = line.status;
  }
  for (const entry of Object.values(out)) {
    entry.current = entry.type === 'TB' ? ['active', 'contested'].includes(entry.status!) : entry.status === 'open';
  }
  return out;
}

function buildFixtures(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('signers.json', json(SIGNERS));

  // valid/ledger.jsonl: one ledger's story, every kind of wiki line
  const db = new Database(':memory:');
  const ledger = new TruthLedger(db);
  const budget = ledger.assertTombstone(
    {
      claim: 'LOG_BUDGET is 100; the old value 30 is dead.',
      evidence: [
        { kind: 'commit', ref: '9f2c1ab' },
        { kind: 'command', ref: 'grep LOG_BUDGET config.ts', detail: 'LOG_BUDGET = 100' },
      ],
      signedBy: 'johnnyclem',
      literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }, { dead: 'legacyRateLimiter' }],
    },
    { author: 'johnnyclem', timestamp: T(0) }
  );
  ledger.assertUv(
    {
      assertion: 'Retries are idempotent across regions.',
      basis: 'the design doc says so',
      verifyBy: { kind: 'inspect', value: 'src/retry.ts', detail: 'a region-scoped idempotency key' },
    },
    { author: 'sam', timestamp: T(1) }
  );
  const hotfix = ledger.assertUv(
    {
      assertion: 'LOG_BUDGET went back to 30 in the hotfix.',
      basis: 'the hotfix notes',
      verifyBy: { kind: 'command', value: 'grep LOG_BUDGET config.ts' },
      contests: budget.id,
    },
    { author: 'alex', timestamp: T(2) }
  );
  // One addendum verifies the contest and overrides the TB; the successor supersedes it
  // (the promotion ruling stays in the ledger: it changes no status)
  ledger.resolveUv(hotfix.id, 'verified', [{ kind: 'file', ref: 'config.ts:3', detail: 'LOG_BUDGET = 30' }], {
    author: 'kim',
    signedBy: 'kim',
    opinion: 'config.ts says 30 again',
    timestamp: T(3),
  });
  const cron = ledger.assertTombstone(
    { claim: 'The cron box is decommissioned.', evidence: [{ kind: 'commit', ref: 'c0ffee1' }], signedBy: 'lee' },
    { author: 'lee', timestamp: T(4) }
  );
  ledger.fileRuling(
    { kind: 'strike', opinion: 'the cited commit is on an abandoned branch', target: cron.id },
    { author: 'johnnyclem', timestamp: T(5) }
  );
  const region = ledger.assertUv(
    { assertion: 'The staging cluster runs in us-east-1.', basis: 'an old runbook', verifyBy: { kind: 'ask', value: 'ops' } },
    { author: 'agent:claude-code', agentSessionId: 'sess_7f3a', provenance: { kind: 'sourceMessageId', ref: 'msg_0042' }, timestamp: T(6) }
  );
  ledger.resolveUv(region.id, 'refuted', [{ kind: 'file', ref: 'infra/staging.tf:12', detail: 'region = "eu-west-1"' }], {
    author: 'kim',
    timestamp: T(7),
  });
  // An agent's draft a person notarized: its signs link names a proposal that doesn't travel
  const draft = ledger.draftTombstone(
    {
      claim: 'fetchV1 is superseded by fetchV2.',
      evidence: [{ kind: 'commit', ref: 'b4d1dea' }],
      literals: [{ dead: 'fetchV1', current: 'fetchV2' }],
      targetRef: 'api:fetch',
    },
    { author: 'agent:claude-code', agentSessionId: 'sess_7f3a', provenance: { kind: 'sourceMessageId', ref: 'msg_0057' }, timestamp: T(8) }
  );
  ledger.signProposal(draft.id, 'johnnyclem', undefined, { notarized: true, timestamp: T(9) });
  // The stream only grows at the end: these lines stay the first ones once the agents' part below is added
  const story = exportWikiEntries(ledger);
  const at = (type: string, n = 0) => story.lines.map(parse).filter((l) => l.type === type)[n];
  const tbLine = at('TB');
  const contestLine = story.lines.map(parse).find((l) => l.type === 'UV' && l.contests)!;
  const strikeLine = at('RULING');
  const transitionLine = at('TRANSITION');

  // valid/proposals.jsonl: the suite PROPOSAL envelope
  const proposals = stream([
    {
      id: '01J9PROPTB0000000000000000',
      type: 'PROPOSAL',
      ts: T(20),
      author: 'detector:short-hand',
      kind: 'tb',
      draft: {
        claim: 'MAX_RETRIES 3 is dead; it is 5.',
        evidence: [{ kind: 'message', ref: 'msg_0101', detail: 'user correction' }],
        literals: [{ subject: 'MAX_RETRIES', dead: '3', current: '5' }],
      },
      targetRef: 'shorthand:tombstone:msg_0101',
      signal: { source: 'compaction-candidate', detail: 'short-hand correction' },
    },
    {
      id: '01J9PROPUV0000000000000000',
      type: 'PROPOSAL',
      ts: T(21),
      author: 'agent:claude-code',
      kind: 'uv',
      draft: { assertion: 'The cache is shared across tenants.', basis: 'a trace', verifyBy: { kind: 'inspect', value: 'src/cache.ts' }, contests: null },
      targetRef: null,
      signal: { source: 'agent' },
      agentSessionId: 'sess_7f3a',
    },
    {
      id: '01J9PROPUV0000000000000001',
      type: 'PROPOSAL',
      ts: T(22),
      author: 'detector:supersession',
      kind: 'uv',
      draft: { assertion: 'Deploys go through the canary.', basis: 'a decision in msg_0120', verifyBy: { kind: 'ask', value: 'ops' }, contests: null },
      targetRef: 'decision_17',
      signal: { source: 'detector:supersession', score: 0.71 },
    },
    // Another writer's draft for line 1's target, with values this version doesn't define
    {
      id: '01J9PROPTB0000000000000001',
      type: 'PROPOSAL',
      ts: T(23),
      author: 'agent:claude-code',
      kind: 'tb',
      draft: {
        claim: 'MAX_RETRIES 3 is dead; it is 7.',
        evidence: [{ kind: 'url', ref: 'https://example.com/runbook#retries' }],
        literals: [{ subject: 'MAX_RETRIES', dead: '3', current: '7' }],
      },
      targetRef: 'shorthand:tombstone:msg_0101',
      signal: { source: 'human-review' },
      agentSessionId: 'sess_7f3a',
    },
  ]);
  files.set('valid/proposals.jsonl', jsonl(proposals));
  files.set(
    'valid/proposals.expected.json',
    json(
      proposals.map((l, i) => ({
        line: i + 1,
        outcome: 'filed',
        kind: parse(l).kind === 'tb' ? 'tombstone' : 'uv',
        ...(i === 3 ? { unknown: ["signal.source 'human-review'", "evidence kind 'url'"] } : {}),
      }))
    )
  );

  // valid/unknown.jsonl: what a newer writer may send; readers keep it and fail closed
  const unknown = stream([
    { ...pick(tbLine, ['type', 'ts', 'author', 'claim', 'evidence', 'signedBy']), id: '01J9UNKNOWNTB00000000000001', status: 'active', reviewers: ['sam'] },
    { ...pick(tbLine, ['type', 'ts', 'author', 'claim', 'evidence', 'signedBy']), id: '01J9UNKNOWNTB00000000000002', status: 'retracted' },
    { ...pick(tbLine, ['type', 'ts', 'author', 'claim', 'signedBy']), id: '01J9UNKNOWNTB00000000000003', evidence: [{ kind: 'url', ref: 'https://example.com/changelog' }], status: 'active' },
    {
      id: '01J9UNKNOWNUV00000000000001',
      type: 'UV',
      ts: T(30),
      author: 'sam',
      assertion: 'The p99 latency regressed last week.',
      basis: 'a dashboard',
      verifyBy: { kind: 'query', value: 'latency_p99[7d]' },
      contests: null,
      status: 'open',
    },
    {
      id: '01J9UNKNOWNTR00000000000001',
      type: 'TRANSITION',
      ts: T(31),
      author: 'johnnyclem',
      target: '01J9UNKNOWNTB00000000000001',
      status: 'archived',
      cause: { kind: 'archive', ref: null },
    },
  ]);
  files.set('valid/unknown.jsonl', jsonl(unknown));
  files.set(
    'valid/unknown.expected.json',
    json({
      fold: fold(unknown),
      import: [
        { line: 1, outcome: 'inserted', note: 'the unknown field is kept with the entry and exported again verbatim' },
        { line: 2, outcome: 'proposal', reason: 'unknown-status' },
        { line: 3, outcome: 'proposal', reason: 'unknown-value', note: "evidence kind 'url'" },
        { line: 4, outcome: 'proposal', reason: 'unknown-value', note: "verifyBy kind 'query'" },
        { line: 5, outcome: 'held', note: "status 'archived' is not one stenographer 1.0 knows; readers fold it and fail closed" },
      ],
    })
  );

  // valid/routing.jsonl: valid lines stenographer doesn't simply take as truth (each imported alone)
  const other = new TruthLedger(new Database(':memory:'));
  other.backfillLegacyTombstone({ id: 'tombstone_17', superseded: 'use redis', correctedTo: 'use memcached', reason: 'Superseded by newer decision', timestamp: T(40) });
  const mallorys = other.assertTombstone({ claim: 'The batch box is gone.', evidence: [{ kind: 'commit', ref: 'deadbee' }], signedBy: 'mallory' }, { author: 'mallory', timestamp: T(41) });
  other.overrideTombstone(mallorys.id, { evidence: [{ kind: 'commit', ref: 'f00d123' }] }, { author: 'mallory', timestamp: T(42) });
  importWikiEntries(other, {
    lines: [
      JSON.stringify({
        id: '01J9V1REFUTED0000000000000',
        type: 'UV',
        ts: T(43),
        author: 'sam',
        assertion: 'The batch jobs still call fetchV1.',
        basis: 'an old trace',
        verifyBy: { kind: 'observe', value: 'fetchV1 calls in the batch logs' },
        contests: null,
        status: 'refuted',
      }),
    ],
  });
  const otherStream = exportWikiEntries(other).lines.map(parse);
  const kimRefutes = ledger.getChainedRecords().find((r) => r.type === 'ADDENDUM' && r.links.some((l) => l.type === 'refutes'))!;
  // valid/ledger.jsonl, continued (after the other ledgers, so their ids don't move). Agents settle only together: two sessions (one identity) verify a UV from different angles within 15 minutes...
  const tenant = ledger.assertUv(
    { assertion: 'The retry budget is per tenant.', basis: 'the design doc', verifyBy: { kind: 'inspect', value: 'src/retry.ts', detail: 'tenantKey' } },
    { author: 'sam', timestamp: T(10) }
  );
  const attestations = new UvAttestations(db, ledger);
  const agent = { author: 'agent:claude-code', resolution: 'verified' as const, uvId: tenant.id };
  attestations.attest({ ...agent, agentSessionId: 'sess_7f3a', evidence: [{ kind: 'commit', ref: '7e1d2c9', detail: 'tenantKey added to the budget' }] }, Date.parse(T(11)));
  const settled = attestations.attest(
    { ...agent, agentSessionId: 'sess_9c1d', evidence: [{ kind: 'test', ref: 'test/retry.test.ts', detail: 'per-tenant budget' }], note: 'the retry test pins it' },
    Date.parse(T(12))
  );
  expect(settled.status).toBe('settled');
  // ...and two agents' drafts of the same literals, from different angles, mint a TB together
  ledger.draftTombstone(
    { claim: 'The v1 search endpoint is gone; searchV2 replaced it.', evidence: [{ kind: 'commit', ref: 'c4fe0b1' }], literals: [{ dead: 'searchV1', current: 'searchV2' }] },
    { author: 'agent:claude-code', agentSessionId: 'sess_7f3a', timestamp: T(13) }
  );
  const second = ledger.draftTombstone(
    { claim: 'searchV1 was removed.', evidence: [{ kind: 'file', ref: 'src/api/search.ts:1', detail: 'export { searchV2 }' }], literals: [{ dead: 'searchV1', current: 'searchV2' }] },
    { author: 'agent:codex', agentSessionId: 'sess_2b8e', timestamp: T(14) }
  );
  expect(settleTombstoneQuorum(ledger, second, { author: 'agent:codex', agentSessionId: 'sess_2b8e', now: Date.parse(T(14)) })).toHaveProperty('tombstone');

  const full = exportWikiEntries(ledger);
  expect(full.skipped).toEqual([]);
  expect(full.lines.slice(0, story.lines.length)).toEqual(story.lines);
  files.set('valid/ledger.jsonl', jsonl(full.lines));
  files.set('valid/ledger.expected.json', json(fold(full.lines)));
  const quorumAddendum = full.lines.map(parse).find((l) => l.type === 'ADDENDUM' && l.quorum)!;
  const quorumTb = full.lines.map(parse).find((l) => l.type === 'TB' && l.quorum)!;

  // A writer that knew no agents (stenographer before the agent quorum) let one agent sign and resolve alone
  const unaware = new TruthLedger(new Database(':memory:'), { isAgent: () => false });
  unaware.assertTombstone(
    { claim: 'fetchV1 is dead.', evidence: [{ kind: 'commit', ref: 'b4d1dea' }], signedBy: 'agent:claude-code', literals: [{ dead: 'fetchV1' }] },
    { author: 'agent:claude-code', agentSessionId: 'sess_7f3a', timestamp: T(44) }
  );
  const lone = unaware.assertUv({ assertion: 'Exports run hourly.', basis: 'the cron table', verifyBy: { kind: 'inspect', value: 'cron.d/export' } }, { author: 'sam', timestamp: T(45) });
  unaware.resolveUv(lone.id, 'verified', [{ kind: 'file', ref: 'cron.d/export:1', detail: '0 * * * *' }], { author: 'agent:claude-code', agentSessionId: 'sess_7f3a', timestamp: T(46) });
  const unawareStream = exportWikiEntries(unaware).lines.map(parse);
  const routing: Array<[unknown, Record<string, unknown>]> = [
    [otherStream.find((l) => l.author === 'migration'), { outcome: 'proposal', reason: 'unsigned', note: "a backfilled TB: author 'migration', no signer" }],
    [otherStream.find((l) => l.type === 'TB' && l.author === 'mallory'), { outcome: 'proposal', reason: 'unverifiable', note: 'a signer signers.json does not list' }],
    [otherStream.find((l) => l.type === 'ADDENDUM'), { outcome: 'held', note: 'an override by someone signers.json does not list' }],
    [otherStream.find((l) => l.type === 'UV'), { outcome: 'inserted', status: 'refuted', note: 'a terminal status on the entry line is kept' }],
    [story.lines.map(parse).find((l) => l.id === kimRefutes.id), { outcome: 'held', note: 'a refutation of a UV this ledger does not hold' }],
    [unawareStream.find((l) => l.type === 'TB'), { outcome: 'proposal', reason: 'agent-without-quorum', note: 'a TB an agent signed alone: agents settle claims only as a quorum' }],
    [unawareStream.find((l) => l.type === 'ADDENDUM'), { outcome: 'held', note: "an agent's verification without a quorum" }],
  ];
  files.set('valid/routing.jsonl', jsonl(routing.map(([line]) => line)));
  files.set('valid/routing.expected.json', json(routing.map(([, want], i) => ({ line: i + 1, ...want }))));

  // v1/legacy.jsonl: 0.x lines, still read
  const legacy: Array<[unknown, Record<string, unknown>]> = [
    [
      {
        id: '01J9V1TB000000000000000000',
        type: 'TB',
        ts: '2026-03-01T09:01:00.000Z',
        author: 'johnnyclem',
        claim: 'The API is REST-only; the gRPC port was removed.',
        evidence: [{ kind: 'commit', ref: '9f2c1ab' }],
        signedBy: 'johnnyclem',
        status: 'active',
        'x-steno': { origin: 'local', provenance: { kind: 'manual' }, agentSessionId: null, links: [] },
      },
      { outcome: 'proposal', reason: 'unverifiable', note: 'a v1 TB carries no hash: it is filed for a person to sign' },
    ],
    [
      {
        id: '01J9V1TBCMD000000000000000',
        type: 'TB',
        ts: '2026-03-01T09:02:00.000Z',
        author: 'kim',
        claim: 'The retry budget is per tenant.',
        evidence: [{ kind: 'command', ref: 'grep -n tenant src/retry.ts', detail: 'retry.ts:12 tenantKey' }],
        signedBy: 'kim',
        status: 'active',
      },
      { outcome: 'proposal', reason: 'unverifiable', draftEvidenceKinds: ['claimed-command'], note: "v1 'command' evidence is read as claimed-command" },
    ],
    [
      { id: '01J9V1UV000000000000000000', type: 'UV', ts: '2026-03-01T09:03:00.000Z', author: 'sam', assertion: 'The cron box has a stale hosts file.', basis: 'deploys skip it', verifyBy: { kind: 'ask', value: 'ops' }, contests: null, status: 'open' },
      { outcome: 'inserted', status: 'open' },
    ],
    [
      { id: '01J9V1UVREF000000000000000', type: 'UV', ts: '2026-03-01T09:04:00.000Z', author: 'alex', assertion: 'Staging runs in us-east-1.', basis: 'an old runbook', verifyBy: { kind: 'ask', value: 'ops' }, contests: null, status: 'refuted' },
      { outcome: 'inserted', status: 'refuted', note: 'a terminal v1 status is kept' },
    ],
  ];
  files.set('v1/legacy.jsonl', jsonl(legacy.map(([line]) => line)));
  files.set('v1/legacy.expected.json', json(legacy.map(([, want], i) => ({ line: i + 1, ...want }))));

  // invalid/schema.jsonl: refused by the schema and the codec (each re-hashed, so only the defect fails)
  const { evidence: _e, ...noEvidence } = tbLine;
  const { cause: _c, ...noCause } = transitionLine;
  const schemaInvalid: Array<[Record<string, unknown>, string]> = [
    [rehash(noEvidence), 'a TB without evidence'],
    [rehash({ ...tbLine, evidence: [] }), 'a TB with an empty evidence list'],
    [rehash({ ...tbLine, literals: [{ dead: '30' }] }), 'a bare literal with no subject'],
    [rehash({ ...tbLine, literals: [{ subject: 'LOG_BUDGET', dead: ' 30' }] }), 'a literal with surrounding whitespace'],
    [rehash({ ...tbLine, seq: 0 }), 'seq below 1'],
    [rehash({ ...tbLine, seq: '1' }), 'seq as a string'],
    [rehash({ ...tbLine, prevHash: transitionLine.hash }), 'a first line (seq 1) with a prevHash'],
    [rehash({ ...strikeLine, prevHash: null }), 'a later line without a prevHash'],
    [(({ hash: _h, ...rest }) => rest)(tbLine), 'a line without a hash'],
    [{ ...tbLine, hash: tbLine.hash.toUpperCase() }, 'a hash in uppercase hex'],
    [rehash({ ...tbLine, schemaVersion: 3 }), 'an unknown schemaVersion'],
    [rehash({ ...tbLine, ts: 'yesterday' }), 'a timestamp that is not RFC 3339'],
    [rehash({ ...tbLine, type: 'MARKER' }), 'a line type the format does not define'],
    [rehash({ ...strikeLine, opinion: '   ' }), 'a ruling with a blank opinion'],
    [rehash(noCause), 'a TRANSITION without a cause'],
    [rehash({ ...contestLine, 'x-steno': { ...contestLine['x-steno'], links: [...contestLine['x-steno'].links, ...contestLine['x-steno'].links] } }), 'a link listed twice'],
    [rehash({ ...tbLine, ts: '2026-02-30T10:00:00.000Z' }), 'a date that does not exist (February 30)'],
    [rehash({ ...tbLine, ts: '2026-09-01T24:00:00Z' }), 'an hour out of range (24:00)'],
    [rehash({ ...tbLine, status: '' }), 'an empty status'],
    [rehash({ ...quorumAddendum, quorum: quorumAddendum.quorum.slice(0, 1), evidence: quorumAddendum.quorum[0].evidence }), 'a quorum of one member'],
    [
      rehash({ ...quorumAddendum, quorum: quorumAddendum.quorum.map(({ verdict: _v, ...m }: Record<string, unknown>) => m) }),
      'a quorum ADDENDUM whose members carry no verdict',
    ],
  ];
  files.set('invalid/schema.jsonl', jsonl(schemaInvalid.map(([line]) => line)));
  files.set('invalid/schema.expected.json', json(schemaInvalid.map(([, reason], i) => ({ line: i + 1, reason }))));

  // invalid/codec.jsonl: valid against the schema, refused by the codec
  const codecInvalid: Array<[Record<string, unknown>, string, string]> = [
    [{ ...tbLine, claim: 'LOG_BUDGET is 30.' }, 'a line edited after it was written', 'hash mismatch'],
    [rehash({ ...contestLine, author: 'system' }), 'an anonymous author', 'anonymous'],
    [rehash({ ...tbLine, signedBy: 'Assistant' }), 'an anonymous signer (identities compare case-folded)', 'anonymous'],
    [rehash({ ...contestLine, author: 'detector:wiki-sync' }), 'a reserved author', 'reserved'],
    [rehash({ ...tbLine, signedBy: 'kim', author: 'migration' }), "'migration' authoring a signed TB", 'reserved'],
    [rehash({ ...contestLine, 'x-steno': { ...contestLine['x-steno'], links: [] } }), 'a contesting UV without its contests link', 'contests link'],
    [
      rehash({ ...tbLine, 'x-steno': { ...tbLine['x-steno'], links: [{ fromId: tbLine.id, toId: contestLine.id, type: 'overrides' }] } }),
      'a TB carrying a link only an addendum writes',
      'cannot carry the link',
    ],
    [
      rehash({ ...strikeLine, 'x-steno': { ...strikeLine['x-steno'], links: [{ fromId: tbLine.id, toId: strikeLine.target, type: 'strikes' }] } }),
      'a ruling listing a link it did not write',
      'only the links it writes',
    ],
    [rehash({ ...parse(proposals[1]), author: 'system' }), 'a proposal with an anonymous author', 'anonymous'],
    [rehash({ ...transitionLine, author: 'migration' }), "'migration' authoring a TRANSITION", 'reserved'],
    [rehash({ ...transitionLine, author: 'detector:supersession' }), 'a detector authoring a TRANSITION', 'reserved'],
    // The agent quorum: one line per rule a quorum can break
    ...quorumInvalid(quorumAddendum, quorumTb, contestLine, tbLine),
  ];
  files.set('invalid/codec.jsonl', jsonl(codecInvalid.map(([line]) => line)));
  files.set('invalid/codec.expected.json', json(codecInvalid.map(([, reason, error], i) => ({ line: i + 1, reason, error }))));

  // invalid/chain-*.jsonl: valid lines that don't form one stream
  const third = parse(story.lines[2]);
  files.set('invalid/chain-gap.jsonl', jsonl([story.lines[0], story.lines[1], story.lines[3]]));
  files.set('invalid/chain-fork.jsonl', jsonl([story.lines[0], story.lines[1], rehash({ ...third, prevHash: transitionLine.hash })]));
  files.set(
    'invalid/chain.expected.json',
    json({
      'chain-gap.jsonl': [{ line: 3, reason: 'a line is missing', error: 'chain broken: seq' }],
      'chain-fork.jsonl': [{ line: 3, reason: 'a line from another stream', error: 'chain broken: prevHash' }],
    })
  );
  return files;
}

/**
 * Lines that break one quorum rule each (spec, Agent quorum), from a valid
 * quorum ADDENDUM and TB: the schema takes them, the codec refuses them.
 */
function quorumInvalid(
  addendum: Record<string, any>,
  tb: Record<string, any>,
  uvLine: Record<string, any>,
  overridden: Record<string, any>
): Array<[Record<string, unknown>, string, string]> {
  const [m1, m2] = addendum.quorum as QuorumMember[];
  /** The addendum with these members, its evidence their union (so rule 6 holds unless the case breaks it). */
  const members = (quorum: QuorumMember[]) => rehash({ ...addendum, quorum, evidence: quorumEvidence(quorum) });
  const minutesBefore = (ts: string, n: number) => new Date(Date.parse(ts) - n * 60_000).toISOString();
  return [
    [members([m1, { ...m2, agentSessionId: m1.agentSessionId }]), 'quorum rule 1: two members from one agent session', 'share agent session'],
    [members([m1, { ...m2, author: 'assistant' }]), 'quorum rule 1: a member with a generic identity', 'anonymous or generic'],
    [rehash({ ...addendum, author: 'agent:reviewer' }), "quorum rule 2: the line's author is not a member", 'is not a quorum member'],
    [rehash({ ...tb, signedBy: 'johnnyclem' }), 'quorum rule 2: a quorum TB signed by someone other than its author', 'signed by its author'],
    [
      members([{ ...m1, evidence: [...m1.evidence, { kind: 'file', ref: 'src/retry.ts:40' }] }, { ...m2, evidence: [{ kind: 'chat', ref: 'slack:C0123/p1700000000' }] }]),
      'quorum rule 3: a member with no settling evidence (chat is question-class)',
      'cites no settling evidence',
    ],
    [members([m1, { ...m2, evidence: [...m2.evidence, m1.evidence[0]] }]), 'quorum rule 3: an evidence item two members both cite', 'both cite'],
    [members([m1, { ...m2, evidence: [{ kind: m1.evidence[0].kind, ref: 'a9b8c7d' }] }]), 'quorum rule 3: one settling kind only', 'two settling kinds'],
    [members([{ ...m1, ts: minutesBefore(addendum.ts, 16) }, m2]), 'quorum rule 4: members more than 15 minutes apart', 'more than 15 minutes'],
    [members([m1, { ...m2, verdict: 'refuted' }]), "quorum rule 5: a member's verdict is not the one the addendum's link applies", 'verdict refuted'],
    [
      rehash({
        ...addendum,
        'x-steno': { ...addendum['x-steno'], links: [...addendum['x-steno'].links, { fromId: addendum.id, toId: overridden.id, type: 'overrides' }] },
      }),
      'quorum rule 5: a quorum ADDENDUM that overrides a TB',
      'never overrides',
    ],
    [rehash({ ...addendum, evidence: addendum.evidence.slice(0, 1) }), "quorum rule 6: the line's evidence lacks a member's item", 'lacks quorum member'],
    [
      rehash({ ...addendum, evidence: [...addendum.evidence, { kind: 'commit', ref: 'f00dfee' }] }),
      "quorum rule 6: the line's evidence holds an item no member cites",
      'no quorum member cites',
    ],
    [rehash({ ...uvLine, quorum: addendum.quorum }), 'a quorum on a UV line', 'only on TB and ADDENDUM lines'],
  ];
}

function pick(line: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, line[k]]));
}

// ─────────────────────────────────────────────────────────────
// Checking them
// ─────────────────────────────────────────────────────────────

// ajv-formats is CommonJS: its default export arrives wrapped under ESM interop
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const schema = JSON.parse(read('wiki-line.v2.schema.json'));
const validate = ajv.compile(schema);
const schemaValid = (line: string) => validate(JSON.parse(line)) as boolean;
const signers = () => SignerRegistry.load(join(FIXTURES, 'signers.json'));
const fresh = () => new TruthLedger(new Database(':memory:'));

describe('golden fixtures', () => {
  it('are what this codec writes, byte for byte', () => {
    const built = pinned(buildFixtures);
    const update = process.env.UPDATE_TRUTH_FORMAT_FIXTURES === '1';
    for (const [path, content] of built) {
      const file = join(FIXTURES, path);
      if (update) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      expect(existsSync(file) ? readFileSync(file, 'utf8') : null, `${path} (UPDATE_TRUTH_FORMAT_FIXTURES=1 rewrites it)`).toBe(content);
    }
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [relative(FIXTURES, join(dir, e.name))]));
    expect(walk(FIXTURES).sort(), 'no stale fixture files').toEqual([...built.keys()].sort());
  });
});

describe('valid/ledger.jsonl: one ledger, every kind of wiki line', () => {
  const fixture = () => lines('fixtures/valid/ledger.jsonl');

  it('every line passes the schema and the codec, and the lines form one chain', () => {
    const all = fixture();
    for (const [i, line] of all.entries()) {
      expect(schemaValid(line), `line ${i + 1}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(decodeWikiLine(line)).toMatchObject({ version: 2, seq: i + 1 });
      expect(parse(line).hash).toBe(wikiLineHash(line));
      expect(parse(line).prevHash).toBe(i === 0 ? null : parse(all[i - 1]).hash);
    }
  });

  it('covers every transition the wiki carries, contests, literals and the x-steno fields', () => {
    const parsed = fixture().map(parse);
    expect(new Set(parsed.map((l) => l.type))).toEqual(new Set(['TB', 'UV', 'ADDENDUM', 'RULING', 'TRANSITION']));
    const causes = parsed.filter((l) => l.type === 'TRANSITION').map((l) => `${l.cause.kind}:${l.status}`);
    expect(new Set(causes)).toEqual(new Set(['contest:contested', 'verify:verified', 'override:overridden', 'strike:struck', 'refute:refuted']));
    expect(parsed.some((l) => l.literals?.some((x: { subject?: string }) => x.subject))).toBe(true);
    expect(parsed.some((l) => l.evidence?.some((e: { kind: string }) => e.kind === 'claimed-command'))).toBe(true);
    expect(parsed.some((l) => l['x-steno']?.agentSessionId)).toBe(true);
    expect(parsed.some((l) => l['x-steno']?.links?.some((k: { type: string }) => k.type === 'supersedes'))).toBe(true);
    expect(parsed.some((l) => l['x-steno']?.links?.some((k: { type: string }) => k.type === 'signs'))).toBe(true);
    // Agents settling together: a UV verified by a two-session quorum, and a TB two agents' drafts minted
    const quorums = parsed.filter((l) => l.quorum);
    expect(quorums.map((l) => l.type).sort()).toEqual(['ADDENDUM', 'TB']);
    for (const line of quorums) expect(line.quorum.length, line.id).toBeGreaterThanOrEqual(2);
  });

  it('folds, by the readers\' rule, to the expected statuses', () => {
    expect(fold(fixture())).toEqual(expected('fixtures/valid/ledger.expected.json'));
  });

  it('imports in one transaction, and stenographer derives the same statuses from the causes', () => {
    const ledger = fresh();
    const all = fixture();
    const transitions = all.filter((l) => parse(l).type === 'TRANSITION').length;
    const result = importWikiEntries(ledger, { lines: all }, { signers: signers() });
    expect(result).toMatchObject({ committed: true, inserted: all.length - transitions, derived: transitions, proposals: [], held: [], errors: [] });
    for (const [id, want] of Object.entries(expected<Record<string, { status: string; current: boolean }>>('fixtures/valid/ledger.expected.json'))) {
      const entry = ledger.getEntry(id)!;
      const current = ledger.getTruth('current').some((e) => e.id === id);
      expect(current, id).toBe(want.current);
      if (want.status !== 'struck') expect((entry.body as { status: string }).status, id).toBe(want.status);
    }
    expect(ledger.verify().ok).toBe(true);
    // Exported again by the importer: the same lines but for what the writer adds
    const strip = (l: string) => {
      const { prevHash: _p, hash: _h, 'x-steno': x, ...rest } = parse(l);
      return x ? { ...rest, 'x-steno': { ...x, origin: undefined, ledgerHash: undefined } } : rest;
    };
    expect(exportWikiEntries(ledger).lines.map(strip)).toEqual(all.map(strip));
    expect(importWikiEntries(ledger, { lines: all }, { signers: signers() })).toMatchObject({ inserted: 0, unchanged: all.length - transitions });
  });

  it('literals travel: an imported TB objects to the same dead values', () => {
    const ledger = fresh();
    importWikiEntries(ledger, { lines: fixture() }, { signers: signers() });
    const literals = ledger.getMatchableTombstones().flatMap((t: TbEntry) => t.body.literals ?? []);
    expect(literals.map((l) => l.dead)).toContain('fetchV1');
    // The overridden TB's literals no longer object
    expect(literals.map((l) => l.dead)).not.toContain('legacyRateLimiter');
  });
});

describe('valid/proposals.jsonl: the suite PROPOSAL envelope', () => {
  it('passes the schema and the codec, and the intake files every line', () => {
    const fixture = lines('fixtures/valid/proposals.jsonl');
    for (const line of fixture) {
      expect(schemaValid(line), ajv.errorsText(validate.errors)).toBe(true);
      expect(decodeWikiLine(line)).toMatchObject({ version: 2, type: 'PROPOSAL' });
    }
    const ledger = fresh();
    const result = importProposalDrafts(ledger, { lines: fixture });
    expect(result.errors).toEqual([]);
    const want = expected<Array<{ line: number; kind: string; unknown?: string[] }>>('fixtures/valid/proposals.expected.json');
    expect(result.filed.map((p: ProposalEntry) => p.body.kind)).toEqual(want.map((w) => w.kind));
    // Each envelope is filed, even two for one target; unknown values are kept and listed
    expect(result.filed.map((p: ProposalEntry) => (p.body.meta?.intake as { unknown?: string[] }).unknown)).toEqual(
      want.map((w) => w.unknown)
    );
    expect(importProposalDrafts(ledger, { lines: fixture })).toMatchObject({ filed: [], deduped: fixture.length });
    // A wiki import refuses them: proposals never travel in a wiki stream
    expect(importWikiEntries(fresh(), { lines: fixture }).committed).toBe(false);
  });
});

describe('valid/unknown.jsonl: what a newer writer may send', () => {
  const fixture = () => lines('fixtures/valid/unknown.jsonl');
  const want = () =>
    expected<{ fold: Record<string, unknown>; import: Array<{ line: number; outcome: string; reason?: string }> }>('fixtures/valid/unknown.expected.json');

  it('passes the schema and the codec, and folds with unknown statuses failing closed', () => {
    for (const line of fixture()) {
      expect(schemaValid(line), ajv.errorsText(validate.errors)).toBe(true);
      expect(() => decodeWikiLine(line)).not.toThrow();
    }
    expect(fold(fixture())).toEqual(want().fold);
  });

  it('stenographer imports it without guessing: unknown values never become truth', () => {
    const ledger = fresh();
    const result = importWikiEntries(ledger, { lines: fixture() }, { signers: signers() });
    expect(result.committed).toBe(true);
    for (const w of want().import) {
      const id = parse(fixture()[w.line - 1]).id;
      if (w.outcome === 'inserted') expect(ledger.getEntry(id), `line ${w.line}`).not.toBeNull();
      if (w.outcome === 'proposal') expect(result.proposals.find((p) => p.line === w.line), `line ${w.line}`).toMatchObject({ reason: w.reason });
      if (w.outcome === 'held') expect(result.held.map((h) => h.line), `line ${w.line}`).toContain(w.line);
    }
  });

  it('stenographer keeps the unknown fields of each entry it takes, and exports them again verbatim', () => {
    const ledger = fresh();
    importWikiEntries(ledger, { lines: fixture() }, { signers: signers() });
    const exported = new Map(exportWikiEntries(ledger).lines.map(parse).map((l) => [l.id, l]));
    const taken = want()
      .import.filter((w) => w.outcome === 'inserted')
      .map((w) => parse(fixture()[w.line - 1]));
    expect(taken.flatMap(unknownFields), 'an unknown field on a line stenographer takes').not.toEqual([]);
    for (const line of taken) {
      const out = exported.get(line.id)!;
      expect(unknownFields(out).sort(), line.id).toEqual(unknownFields(line).sort());
      for (const key of unknownFields(line)) expect(canonicalize(out[key]), `${line.id}: ${key}`).toBe(canonicalize(line[key]));
    }
  });

  it('so does every entry line type: TB, UV, ADDENDUM and RULING; a TRANSITION, derived on export, does not', () => {
    // A writer's stream: a TB, a UV a person verifies, and a strike of the TB
    const origin = fresh();
    const tb = origin.assertTombstone({ claim: 'The cron box is decommissioned.', evidence: [{ kind: 'commit', ref: 'c0ffee1' }], signedBy: 'kim' }, { author: 'kim', timestamp: T(50) });
    const uv = origin.assertUv({ assertion: 'Backups run nightly.', basis: 'the runbook', verifyBy: { kind: 'inspect', value: 'cron.d/backup' } }, { author: 'sam', timestamp: T(51) });
    origin.resolveUv(uv.id, 'verified', [{ kind: 'file', ref: 'cron.d/backup:1', detail: '0 2 * * *' }], { author: 'alex', opinion: 'it runs at 02:00', timestamp: T(52) });
    origin.fileRuling({ kind: 'strike', opinion: 'the commit is on an abandoned branch', target: tb.id }, { author: 'johnnyclem', timestamp: T(53) });

    // ...as a newer writer would send it: fields this version doesn't define, on every line
    const added: Record<string, Record<string, unknown>> = {
      TB: { reviewers: ['sam', 'alex'], expires: '2027-01-01' },
      UV: { severity: 3, tags: [] },
      ADDENDUM: { confidence: 0.92, attachments: [{ name: 'trace.txt', bytes: 2048, sha: null }] },
      // An own `__proto__` key is a field like any other (JSON.parse makes it one), never the object's prototype
      RULING: { appealBy: null, precedent: { cites: ['RULING-17'], binding: false }, ...JSON.parse('{"__proto__":{"polluted":true}}') },
      TRANSITION: { reason: 'derived by the writer' },
    };
    const sent = stream(
      exportWikiEntries(origin).lines.map((l) => {
        const { schemaVersion: _v, seq: _s, prevHash: _p, hash: _h, ...line } = parse(l);
        return { ...line, ...added[line.type] };
      })
    );
    expect(sent.map((l) => parse(l).type)).toEqual(['TB', 'UV', 'ADDENDUM', 'TRANSITION', 'RULING', 'TRANSITION']);
    for (const line of sent) expect(schemaValid(line), ajv.errorsText(validate.errors)).toBe(true);

    const ledger = fresh();
    expect(importWikiEntries(ledger, { lines: sent }, { signers: signers() })).toMatchObject({ committed: true, inserted: 4, derived: 2, proposals: [], held: [] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const back = exportWikiEntries(ledger).lines;
    expect(back.map((l) => parse(l).type)).toEqual(['TB', 'UV', 'ADDENDUM', 'TRANSITION', 'RULING', 'TRANSITION']);
    for (const [i, line] of sent.map(parse).entries()) {
      const out = parse(back[i]);
      expect(schemaValid(back[i]), ajv.errorsText(validate.errors)).toBe(true);
      if (line.type === 'TRANSITION') {
        // This ledger writes its own TRANSITIONs from the causes it applied
        expect(unknownFields(out), `line ${i + 1}`).toEqual([]);
        continue;
      }
      expect(unknownFields(out).sort(), `line ${i + 1}`).toEqual(unknownFields(line).sort());
      for (const key of unknownFields(line)) expect(canonicalize(out[key]), `line ${i + 1}: ${key}`).toBe(canonicalize(line[key]));
      // ...and the rest of the line is the writer's too, but for where this ledger got it
      const { 'x-steno': x, prevHash: _p, hash: _h, ...rest } = out;
      const { 'x-steno': sx, prevHash: _sp, hash: _sh, ...sentRest } = line;
      expect(canonicalize(rest), `line ${i + 1}`).toBe(canonicalize(sentRest));
      expect({ ...x, origin: undefined, ledgerHash: undefined }).toEqual({ ...sx, origin: undefined, ledgerHash: undefined });
    }

    // Kept as part of the entry: the same line again is a no-op, and so is this ledger's own export of it
    expect(importWikiEntries(ledger, { lines: sent }, { signers: signers() })).toMatchObject({ committed: true, inserted: 0, unchanged: 4, proposals: [] });
    expect(importWikiEntries(ledger, { lines: back }, { signers: signers() })).toMatchObject({ committed: true, inserted: 0, unchanged: 4, proposals: [] });
    expect(exportWikiEntries(ledger).lines).toEqual(back);
    expect(ledger.verify().ok).toBe(true);
  });
});

describe('valid/routing.jsonl: lines stenographer does not simply take as truth', () => {
  it('pass the schema and the codec, and import (each on its own) as expected', () => {
    const fixture = lines('fixtures/valid/routing.jsonl');
    const want = expected<Array<{ line: number; outcome: string; reason?: string; status?: string }>>('fixtures/valid/routing.expected.json');
    for (const w of want) {
      const line = fixture[w.line - 1];
      expect(schemaValid(line), `line ${w.line}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      const ledger = fresh();
      const result = importWikiEntries(ledger, { lines: [line] }, { signers: signers() });
      const id = parse(line).id;
      expect(result.committed, `line ${w.line}`).toBe(true);
      if (w.outcome === 'inserted') expect((ledger.getEntry(id)!.body as { status: string }).status).toBe(w.status);
      if (w.outcome === 'proposal') expect(result.proposals, `line ${w.line}`).toMatchObject([{ reason: w.reason }]);
      if (w.outcome === 'held') expect(result.held, `line ${w.line}`).toHaveLength(1);
      if (w.outcome !== 'inserted') expect(ledger.getEntry(id)).toBeNull();
    }
  });
});

describe('v1/legacy.jsonl: 0.x lines are still read', () => {
  it('decode as version 1 (the v2 schema does not take them) and import as expected', () => {
    const fixture = lines('fixtures/v1/legacy.jsonl');
    for (const line of fixture) {
      expect(decodeWikiLine(line)).toMatchObject({ version: 1 });
      expect(schemaValid(line)).toBe(false);
    }
    const ledger = fresh();
    const result = importWikiEntries(ledger, { lines: fixture }, { signers: signers() });
    expect(result.committed).toBe(true);
    for (const w of expected<Array<{ line: number; outcome: string; reason?: string; status?: string; draftEvidenceKinds?: string[] }>>('fixtures/v1/legacy.expected.json')) {
      const id = parse(fixture[w.line - 1]).id;
      if (w.outcome === 'inserted') {
        expect((ledger.getEntry(id)!.body as { status: string }).status).toBe(w.status);
        continue;
      }
      const filed = result.proposals.find((p) => p.id === id)!;
      expect(filed).toMatchObject({ reason: w.reason });
      if (w.draftEvidenceKinds) {
        const proposal = ledger.getEntry(filed.proposalId) as ProposalEntry;
        expect((proposal.body.draft.evidence as Array<{ kind: string }>).map((e) => e.kind)).toEqual(w.draftEvidenceKinds);
      }
    }
  });
});

describe('invalid fixtures', () => {
  it('invalid/schema.jsonl: every line fails the schema and the codec', () => {
    const fixture = lines('fixtures/invalid/schema.jsonl');
    const want = expected<Array<{ line: number; reason: string }>>('fixtures/invalid/schema.expected.json');
    expect(want).toHaveLength(fixture.length);
    for (const [i, line] of fixture.entries()) {
      expect(schemaValid(line), `line ${i + 1} (${want[i].reason})`).toBe(false);
      expect(() => decodeWikiLine(line), `line ${i + 1} (${want[i].reason})`).toThrow();
    }
  });

  it('invalid/codec.jsonl: every line passes the schema and fails the codec with the expected error', () => {
    const fixture = lines('fixtures/invalid/codec.jsonl');
    const want = expected<Array<{ line: number; reason: string; error: string }>>('fixtures/invalid/codec.expected.json');
    expect(want).toHaveLength(fixture.length);
    for (const [i, line] of fixture.entries()) {
      expect(schemaValid(line), `line ${i + 1} (${want[i].reason}): ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(() => decodeWikiLine(line), `line ${i + 1} (${want[i].reason})`).toThrow(new RegExp(want[i].error));
    }
  });

  // F7: admission only checked Date.parse, which rolls February 30 over, so
  // the ledger could store, and export, a ts schema-validating readers refuse
  it('the ledger refuses a createdAt naming no real time, as the format does', () => {
    const ledger = fresh();
    const uv = { assertion: 'The cache is shared.', basis: 'a trace', verifyBy: { kind: 'ask' as const, value: 'ops' } };
    for (const timestamp of ['2026-02-30T10:00:00.000Z', '2026-09-01T24:00:00Z', '2026-09-01T10:00:00+24:00']) {
      expect(() => ledger.assertUv(uv, { author: 'sam', timestamp }), timestamp).toThrow(/real time/);
    }
    expect(ledger.assertUv(uv, { author: 'sam', timestamp: '2028-02-29T23:59:59.999+05:30' }).createdAt).toBe('2028-02-29T23:59:59.999+05:30');
  });

  it('invalid/chain-*.jsonl: valid lines that are not one stream; the import writes nothing', () => {
    for (const [file, want] of Object.entries(expected<Record<string, Array<{ line: number; error: string }>>>('fixtures/invalid/chain.expected.json'))) {
      const fixture = lines(`fixtures/invalid/${file}`);
      for (const line of fixture) expect(schemaValid(line), file).toBe(true);
      const ledger = fresh();
      const result = importWikiEntries(ledger, { lines: fixture });
      expect(result.committed, file).toBe(false);
      for (const w of want) {
        expect(result.errors.some((e) => e.line === w.line && e.error.startsWith(w.error)), `${file} line ${w.line}`).toBe(true);
      }
      expect(ledger.getTruth('all')).toHaveLength(0);
    }
  });
});

describe('the spec document', () => {
  it("states the worked example's canonical form and hash, which the codec recomputes", () => {
    const readme = read('README.md');
    const example = readme.match(/<!-- worked-example -->\s*```json\n([^\n]+)\n```/);
    expect(example, 'README.md has a worked example').not.toBeNull();
    const line = example![1];
    expect(lines('fixtures/valid/ledger.jsonl')).toContain(line);
    const { hash, ...rest } = parse(line);
    expect(readme).toContain(canonicalize(rest));
    expect(readme).toContain(hash);
    expect(wikiLineHash(line)).toBe(hash);
  });

  it('lists the statuses the codec knows', () => {
    const readme = read('README.md');
    for (const status of [...WIKI_STATUSES.TB, ...WIKI_STATUSES.UV]) expect(readme).toContain(`\`${status}\``);
  });

  it('lists the evidence kinds the codec knows, in the TB row and the schema, and gives each the class the codec does', () => {
    const readme = read('README.md');
    const row = readme.split('\n').find((l) => l.startsWith('| `evidence` |'))!;
    for (const kind of EVIDENCE_KINDS) expect(row, kind).toContain(`\`${kind}\``);
    const described = new Set((schema.$defs.evidence.properties.kind.description as string).split(/[^a-z-]+/));
    for (const kind of EVIDENCE_KINDS) expect(described.has(kind), `the schema's evidence kind description lists ${kind}`).toBe(true);

    // The "Evidence classes" table: one row per known kind, with its class
    const section = readme.slice(readme.indexOf('\n## Evidence classes\n'), readme.indexOf('\n## ', readme.indexOf('\n## Evidence classes\n') + 1));
    const classes = new Map(
      [...section.matchAll(/^\| `([^`]+)` \|.*\| (settling|question) \|$/gm)].map((m) => [m[1], m[2]])
    );
    expect([...classes.keys()].sort()).toEqual([...EVIDENCE_KINDS].sort());
    for (const [kind, cls] of classes) expect(cls, kind).toBe(evidenceClass(kind));
    expect(section).toMatch(/any kind (a|the) reader doesn't know is question-class/i);
  });

  it('documents the signer registry fields, keys included', () => {
    const readme = read('README.md');
    for (const field of ['`id`', '`role`', '`aliases`', '`keys`', '`alg`', '`publicKey`']) expect(readme, field).toContain(field);
  });
});

describe('signers.json: the registry the fixtures assume', () => {
  it('has an entry carrying keys, reserved for key signing in 1.x, which a 1.0 registry accepts and ignores', () => {
    const file = expected<{ signers: Array<{ id: string; role: string; keys?: Array<Record<string, string>> }> }>('fixtures/signers.json');
    const keyed = file.signers.filter((s) => s.keys !== undefined);
    expect(keyed).toHaveLength(1);
    for (const key of keyed[0].keys!) expect(Object.keys(key).sort()).toEqual(['alg', 'id', 'publicKey']);
    const registry = signers();
    for (const s of file.signers.filter((s) => !s.id.endsWith('*'))) expect(registry.lookup(s.id), s.id).toEqual({ id: s.id, role: s.role });
  });
});

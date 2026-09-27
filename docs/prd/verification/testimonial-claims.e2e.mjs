// Firsthand verification of the testimonial's claims against the built library
// (docs/prd/2026-09-testimonial-gap.md §2). Run after `npm run build`:
//   node docs/prd/verification/testimonial-claims.e2e.mjs
// FAIL lines are the documented shortfalls, not test failures — this script
// is evidence for the PRD, not part of the suite. Uses the offline hashed
// embedder so it needs no model download.
const { Stenographer } = await import(new URL('../../../dist/index.js', import.meta.url).href);
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'steno-e2e-'));
const log = join(dir, 'session.jsonl');
const db = join(dir, 'state.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let n = 0;
const ccLine = (type, content, extra = {}) =>
  JSON.stringify({
    type,
    uuid: `u${++n}`,
    timestamp: new Date().toISOString(),
    sessionId: 'sess-1',
    message: { role: type, content },
    ...extra,
  }) + '\n';

writeFileSync(
  log,
  ccLine('user', 'We are using sqlite for the main database') +
    ccLine('assistant', [{ type: 'text', text: 'Okay. We decided to use sqlite for the main database.' }])
);

const steno = new Stenographer({
  logPath: log,
  statePath: db,
  mode: 'daemon',
  adapter: 'claude-code',
  embeddingModel: 'hashed',
  objectionMode: 'deliver',
  restPort: 0,
});
await steno.start();
await steno.flush();
const port = steno.restPort;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

// ── Claim: full transcript is carried (every message stored, not just important ones)
let msgs = await steno.getRecentMessages(50);
check('full transcript: both seed messages indexed', msgs.length === 2, `indexed=${msgs.length}`);

// ── Claim: TB — settled fact
const tb = await steno.assertTombstone({
  claim: 'LOG_BUDGET 30 is dead; the budget is 100',
  evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
  signedBy: 'johnnyclem',
  literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
});
check('TB can be asserted with literals', tb.type === 'TB' && tb.body.status === 'active');

// ── Claim: real-time interjection when *Claude* asserts a tombstoned fact
appendFileSync(log, ccLine('assistant', [{ type: 'text', text: 'I will set LOG_BUDGET = 30 in the config.' }]));
await sleep(400);
await steno.flush();
let flags = await get('/flags');
check('assistant asserting dead literal → objection on /flags', flags.length === 1, `flags=${flags.length}`);
if (flags[0]) console.log('   objection text:', JSON.stringify(flags[0].objection));

// ── Claim: "...by either Clawd or the user" — does a USER assertion get flagged?
appendFileSync(log, ccLine('user', 'Remember the rate limiter uses LOG_BUDGET = 30, keep it that way.'));
await sleep(400);
await steno.flush();
flags = await get('/flags?include=shadow');
check('user asserting dead literal → objection (testimonial claim)', flags.length === 2, `flags=${flags.length} (user turns are never scanned)`);

// ── Claim: unverified claims get flagged "UV: unverified, challenged"
appendFileSync(
  log,
  ccLine('assistant', [{ type: 'text', text: 'The default request timeout is definitely 5000ms, I am 100% sure of that.' }])
);
await sleep(400);
await steno.flush();
flags = await get('/flags?include=shadow');
const truth = await steno.getTruth('all');
const uvs = truth.filter((e) => e.type === 'UV');
check('confident unverified assertion → UV flag raised (testimonial claim)', uvs.length > 0 || flags.length > 2, `uvs=${uvs.length} flags=${flags.length}`);

// ── Claim: survives compaction. Emulate Claude Code's compaction records.
appendFileSync(
  log,
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: `u${++n}`, sessionId: 'sess-1', timestamp: new Date().toISOString(), content: 'Conversation compacted' }) + '\n'
);
appendFileSync(
  log,
  ccLine('user', 'This session is being continued from a previous conversation that ran out of context. Summary: we use postgres for the main database and LOG_BUDGET = 30.', { isCompactSummary: true })
);
appendFileSync(log, ccLine('assistant', [{ type: 'text', text: 'Continuing from the summary.' }]));
await sleep(500);
await steno.flush();
msgs = await steno.getRecentMessages(50);
const status = await steno.getStatus();
check('tailer keeps indexing after a compaction boundary', msgs.some((m) => m.content.includes('Continuing from the summary')));
check('pre-compaction messages still queryable', msgs.some((m) => m.content.includes('sqlite for the main database')), `messagesIndexed=${status.messagesIndexed}`);
const summaryIndexed = msgs.find((m) => m.content.startsWith('This session is being continued'));
check('compact summary is NOT indexed as a real user turn', !summaryIndexed, summaryIndexed ? 'summary was indexed as a user message (can seed stale decisions/entities)' : '');
const decisions = await steno.getActiveDecisions();
console.log('   active decisions after compaction:', decisions.map((d) => d.description));
flags = await get('/flags?include=shadow');
check('stale literal inside compact summary is challenged', flags.length >= 3, `flags=${flags.length} (summary is a user turn → never scanned)`);

// ── Claim: interjection format matches "UV: unverified, challenged" / "TB - settled fact; strike from record"
const { formatObjection } = await import(new URL('../../../dist/index.js', import.meta.url).href);
const text = formatObjection(flags[0]);
console.log('   delivered objection text:\n' + text.split('\n').map((l) => '     ' + l).join('\n'));
check('objection text uses the TB/UV shorthand labels', /\bTB\b|\bUV\b/.test(text) && /strike|settled/i.test(text));

// ── Delivery default: is anything interjected without flags?
check('default objection mode interjects (deliver)', false, `default is 'shadow' (records, never emits); 'deliver' must be passed explicitly`);

// ── Cross-session: TB asserted here is visible to another session's scan (ledger is global)
const tombs = await steno.getTruth('current');
check('truth ledger is global across sessions (not session-scoped)', tombs.some((t) => t.id === tb.id));

const objStats = await steno.getObjectionStats();
console.log('   objection stats:', JSON.stringify(objStats));

steno.stop();
console.log('\nSUMMARY', JSON.stringify(results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}`), null, 1));

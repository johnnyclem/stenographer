import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractStructure, type ExtractedStructure } from '../src/indexer/importance.js';
import { Stenographer } from '../src/core/stenographer.js';
import type { ConversationMessage, MessageTag } from '../src/types.js';

interface LabeledCase {
  role: ConversationMessage['role'];
  content: string;
  tags?: MessageTag[];
  decisions?: string[];
  corrections?: Array<{ to: string; from?: string }>;
}

const corpus = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'extraction-corpus.json'), 'utf8')
) as { cases: LabeledCase[] };

// The pre-1.0 extractor, kept verbatim as the baseline the rewrite is measured against
const LEGACY_DECISIONS = [
  /we (?:decided|agreed|settled) (?:on|to|that) (.+)/i,
  /let'?s (?:use|go with) (.+)/i,
  /i'?ll (?:use|implement) (.+)/i,
  /the (?:plan|decision) is (.+)/i,
];
const LEGACY_CORRECTIONS = [
  /actually,? (.+)/i,
  /no,? (?:wait|that'?s wrong)/i,
  /i mean (.+)/i,
  /instead,? (.+)/i,
  /not (.+),? (?:but|rather) (.+)/i,
  /correction:? (.+)/i,
];
function legacyExtract(msg: ConversationMessage): ExtractedStructure {
  const decisions: string[] = [];
  for (const re of LEGACY_DECISIONS) {
    const m = msg.content.match(re);
    if (m?.[1]) decisions.push(m[1].trim());
  }
  const corrections: ExtractedStructure['corrections'] = [];
  for (const re of LEGACY_CORRECTIONS) {
    const m = msg.content.match(re);
    // Legacy semantics: `from` held the captured (current) text
    if (m?.[1]) corrections.push({ from: '', to: m[1].trim() });
  }
  return { entities: [], decisions, corrections };
}

const has = (text: string, key: string) => text.toLowerCase().includes(key.toLowerCase());

/** Precision and recall over the corpus; each expected item matches at most one extracted item. */
function score(extract: (msg: ConversationMessage) => ExtractedStructure) {
  let extracted = 0;
  let expected = 0;
  let truePositives = 0;
  const falsePositives: string[] = [];
  const misses: string[] = [];

  for (const c of corpus.cases) {
    const out = extract({
      id: 'x',
      role: c.role,
      content: c.content,
      timestamp: '2026-09-30T00:00:00Z',
      ...(c.tags ? { tags: c.tags } : {}),
    });
    const items = [
      ...out.decisions.map((d) => ({ to: d, from: '' })),
      ...out.corrections.map((x) => ({ to: x.to, from: x.from })),
    ];
    const wanted = [
      ...(c.decisions ?? []).map((to) => ({ to, from: undefined as string | undefined })),
      ...(c.corrections ?? []),
    ];
    extracted += items.length;
    expected += wanted.length;

    const used = new Set<number>();
    for (const w of wanted) {
      const i = items.findIndex(
        (item, idx) => !used.has(idx) && has(item.to, w.to) && (!w.from || has(item.from, w.from))
      );
      if (i >= 0) {
        used.add(i);
        truePositives++;
      } else {
        misses.push(`${c.content} → ${w.to}`);
      }
    }
    items.forEach((item, idx) => {
      if (!used.has(idx)) falsePositives.push(`${c.content} → ${item.to}`);
    });
  }

  return {
    precision: extracted === 0 ? 1 : truePositives / extracted,
    recall: expected === 0 ? 1 : truePositives / expected,
    falsePositives,
    misses,
  };
}

describe('extraction precision on the labeled corpus (IDX-07, IDX-08)', () => {
  it('meets its precision and recall floors, and beats the legacy extractor', () => {
    const current = score(extractStructure);
    const legacy = score(legacyExtract);

    expect(current.falsePositives).toEqual([]);
    expect(current.precision).toBeGreaterThanOrEqual(0.95);
    expect(current.recall).toBeGreaterThanOrEqual(0.9);
    // The legacy extractor on the same corpus (precision ≈ 0.3): tool output,
    // narration, substrings ("factually", "will use") and inverted polarity
    expect(legacy.precision).toBeLessThan(0.5);
    expect(current.precision - legacy.precision).toBeGreaterThan(0.4);
  });
});

describe('extractStructure', () => {
  const msg = (content: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
    id: 'x',
    role: 'user',
    content,
    timestamp: '2026-09-30T00:00:00Z',
    ...overrides,
  });

  it('records the chosen side of "X instead of Y" as current', () => {
    const out = extractStructure(msg('Switch to pnpm workspaces instead of npm workspaces'));
    expect(out.decisions).toEqual([]);
    expect(out.corrections).toEqual([{ to: 'Switch to pnpm workspaces', from: 'npm workspaces' }]);
  });

  it('drops the rejected option from a decision', () => {
    const out = extractStructure(msg("Let's use sqlite instead of postgres for local dev."));
    expect(out.decisions).toEqual(['use sqlite']);
    expect(out.corrections).toEqual([]);
  });

  it('mines nothing from tool output, tagged records or system turns', () => {
    for (const m of [
      msg('We decided to use MongoDB for the event store.', { role: 'tool', tags: ['tool_result'] }),
      msg("let's use yarn for installs", { tags: ['sidechain'] }),
      msg('Actually, do not respond.', { tags: ['meta'] }),
      msg('We decided to use Redis.', { tags: ['compact_summary'] }),
      msg('We decided to use postgres.', { role: 'system' }),
    ]) {
      expect(extractStructure(m)).toEqual({ entities: [], decisions: [], corrections: [] });
    }
  });

  it('caps entity names', () => {
    const out = extractStructure(
      msg(
        'Connected to the database at postgres://prod-db:5432/app?sslmode=require and everything looks fine, proceeding with the migration now'
      )
    );
    for (const e of out.entities) {
      expect(e.name.length).toBeLessThanOrEqual(48);
      expect(e.name.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });
});

describe('Claude Code session mining (IDX-08)', () => {
  let dir: string;
  let engine: Stenographer | null = null;

  afterEach(() => {
    engine?.stop();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('mines decisions and corrections only from user and assistant prose', async () => {
    const sid = 'c0ffee00-1111-2222-3333-444455556666';
    let n = 0;
    const ts = () => new Date(Date.UTC(2026, 8, 30, 10, 0, n++)).toISOString();
    const rec = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type,
        uuid: `u${n}`,
        timestamp: ts(),
        sessionId: sid,
        message: { role: type, content },
        ...extra,
      });
    const text = (t: string) => [{ type: 'text', text: t }];
    const tool = (name: string, input: unknown) => [{ type: 'tool_use', id: `t${n}`, name, input }];
    const result = (out: string) => [{ type: 'tool_result', tool_use_id: `t${n - 1}`, content: out }];
    const lines = [
      rec('user', 'The checkout flow times out under load. We decided to use Redis for the session store last sprint. Can you take a look?'),
      rec('assistant', text("I'll use the Grep tool to find where the session store is configured.")),
      rec('assistant', tool('Grep', { pattern: 'SessionStore', path: 'src' })),
      rec('user', result('src/session/store.ts:12: // We decided to use an in-memory LRU for tests only\nsrc/session/store.ts:40: // Actually, this path is only hit in dev mode.\nsrc/config.ts:8: the timeout is 30s')),
      rec('assistant', text("I'll use the Read tool to open src/session/store.ts.")),
      rec('assistant', tool('Read', { file_path: 'src/session/store.ts' })),
      rec('user', result('export class SessionStore {\n  // The plan is to migrate to Valkey in Q3\n  // Instead, keep ioredis until then\n  constructor(private client = new Redis()) {}\n}')),
      rec('user', 'Caveat: The messages below were generated by the user while running local commands. Actually, ignore them.', { isMeta: true }),
      rec('assistant', text('The store looks fine. This will use the connection pool from ioredis, so the timeout is probably elsewhere.')),
      rec('assistant', text("Actually, the timeout comes from the payment gateway client, not Redis. I'll implement a circuit breaker around the gateway call.")),
      rec('user', "Sounds good. Let's go with the circuit breaker, but keep the 30s timeout."),
    ];
    dir = mkdtempSync(join(tmpdir(), 'steno-extract-'));
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
    engine = new Stenographer({
      logPath: join(dir, `${sid}.jsonl`),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
    });
    await engine.start();

    const decisions = (await engine.getDecisionHistory()).map((d) => d.description);
    expect(decisions).toEqual([
      'use Redis for the session store last sprint',
      'implement a circuit breaker around the gateway call',
      'go with the circuit breaker, but keep the 30s timeout',
    ]);
    const tombstones = await engine.getTombstones();
    expect(tombstones.map((t) => [t.superseded, t.correctedTo])).toEqual([
      ['Redis', 'the timeout comes from the payment gateway client'],
    ]);

    // Tool output stays searchable, attributed to the tool
    const recent = await engine.getRecentMessages(20);
    const outputs = recent.filter((m) => m.role === 'tool');
    expect(outputs).toHaveLength(2);
    expect(outputs.every((m) => m.tags?.includes('tool_result'))).toBe(true);
    expect(recent.find((m) => m.content.startsWith('Caveat'))?.tags).toEqual(['meta']);
    expect((await engine.getEntities()).map((e) => e.id)).not.toContain('timeout');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TruthLedger } from '../src/truth/ledger.js';
import { ObjectionLog, findLiteralHits, assertedText } from '../src/truth/objections.js';
import { LiteralMatcher } from '../src/truth/literal-matcher.js';
import type { TombstonedLiteral } from '../src/truth/types.js';
import type { ConversationMessage } from '../src/types.js';

interface CorpusCase {
  literal: string;
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
  hit: boolean;
  why: string;
}

const corpus = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'literal-corpus.json'), 'utf8')) as {
  literals: Record<string, TombstonedLiteral>;
  cases: CorpusCase[];
};

const message = (c: CorpusCase): ConversationMessage => ({
  id: 'm',
  role: 'assistant',
  content: c.text ?? '',
  timestamp: '2026-09-18T10:00:00Z',
  ...(c.tool ? { toolCalls: [{ name: c.tool.name, input: c.tool.input }] } : {}),
});

describe('golden false-positive / false-negative corpus (STENO-T-12)', () => {
  for (const c of corpus.cases) {
    const label = c.text ?? `${c.tool!.name} ${JSON.stringify(c.tool!.input)}`;
    it(`${c.hit ? 'objects to' : 'lets pass'}: ${label.slice(0, 90)} — ${c.why}`, () => {
      const literal = corpus.literals[c.literal];
      const hits = assertedText(message(c)).flatMap(({ text }) => findLiteralHits(text, literal));
      expect(hits.length > 0).toBe(c.hit);
    });
  }
});

describe('objection scan performance (STENO-T-13)', () => {
  it('scans 1,000 literals against a 100 KB Write in under 150 ms', () => {
    const db = new Database(':memory:');
    const ledger = new TruthLedger(db);
    ledger.atomically(() => {
      for (let i = 0; i < 500; i++) {
        ledger.assertTombstone(
          {
            claim: `setting ${i} moved`,
            evidence: [{ kind: 'commit', ref: `c${i}` }],
            signedBy: 'johnnyclem',
            literals: [
              { subject: `SETTING_${i}_VALUE`, dead: String(1000 + i), current: String(5000 + i) },
              { dead: `legacyThing${i}Impl` },
            ],
          },
          { author: 'johnnyclem' }
        );
      }
    });
    const log = new ObjectionLog(db, ledger);

    // Dead values appear all over the file, but next to the wrong subjects:
    // every one of them has to be checked and let pass
    const lines: string[] = [];
    for (let i = 0; lines.join('\n').length < 100_000; i++) {
      lines.push(`const value${i} = computeSomething(argumentOne, ${1000 + (i % 500)}) + 42; // filler text`);
    }
    const content = [...lines, 'export const SETTING_499_VALUE = 1499;'].join('\n');
    expect(content.length).toBeGreaterThan(100_000);
    const msg: ConversationMessage = {
      id: 'big',
      role: 'assistant',
      content: '',
      timestamp: '2026-09-18T10:00:00Z',
      toolCalls: [{ name: 'Write', input: { file_path: 'settings.ts', content } }],
    };

    log.scan({ ...msg, id: 'warm' }, 'warm-up', 'shadow');
    const started = performance.now();
    const raised = log.scan(msg, 's1', 'shadow');
    const elapsed = performance.now() - started;

    expect(raised.map((o) => o.transcriptLine)).toEqual(['export const SETTING_499_VALUE = 1499;']);
    expect(elapsed).toBeLessThan(150);
  });
});

// STENO-REV-02: every dead-value occurrence that didn't assert its literal
// looked for its line again, back to the line's start and on to its end, so
// a long single-line text cost occurrences × line length (1 MiB of '30 '
// took over two minutes, synchronously on the server's only thread).
describe('matching cost on long single-line texts (STENO-REV-02)', () => {
  const time = (fn: () => unknown): number => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };

  it('stays linear when the dead value is everywhere on one line, never next to its subject', () => {
    const matcher = new LiteralMatcher([{ key: 0, literal: { subject: 'LOG_BUDGET', dead: '30', current: '100' } }]);
    const text = '30 '.repeat(Math.floor((1 << 20) / 3));
    matcher.match('30 '.repeat(1000));
    let hits: unknown[] = [];
    const elapsed = time(() => (hits = matcher.match(text)));
    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(3000);
  });

  it('stays linear for negated mentions of a subject-less literal on one line', () => {
    const matcher = new LiteralMatcher([{ key: 0, literal: { dead: 'legacyRateLimiter' } }]);
    const text = 'do not use legacyRateLimiter, '.repeat(Math.floor((1 << 20) / 30));
    let hits: unknown[] = [];
    const elapsed = time(() => (hits = matcher.match(text)));
    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(3000);
  });

  it('still quotes the right line when occurrences span many lines', () => {
    const matcher = new LiteralMatcher([{ key: 0, literal: { subject: 'LOG_BUDGET', dead: '30', current: '100' } }]);
    const text = ['30 30 30', 'x = 30', 'LOG_BUDGET = 30', 'y = 30 30'].join('\n');
    expect(matcher.match(text, { allLines: true }).map((h) => h.line)).toEqual(['LOG_BUDGET = 30']);
  });

  it('lets the live scan stop at its budget (fail open), keeping what it already found', () => {
    const db = new Database(':memory:');
    const ledger = new TruthLedger(db);
    ledger.assertTombstone(
      {
        claim: 'LOG_BUDGET 30 is dead',
        evidence: [{ kind: 'commit', ref: 'c1' }],
        signedBy: 'johnnyclem',
        literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
      },
      { author: 'johnnyclem' }
    );
    ledger.assertTombstone(
      {
        claim: 'legacyRateLimiter is gone',
        evidence: [{ kind: 'commit', ref: 'c2' }],
        signedBy: 'johnnyclem',
        literals: [{ dead: 'legacyRateLimiter' }],
      },
      { author: 'johnnyclem' }
    );
    const log = new ObjectionLog(db, ledger);
    const msg: ConversationMessage = {
      id: 'huge',
      role: 'assistant',
      content: 'Setting LOG_BUDGET = 30 now.',
      timestamp: '2026-09-18T10:00:00Z',
      toolCalls: [
        { name: 'Write', input: { file_path: 'big.txt', content: `${'30 '.repeat(20_000)}\nuse(legacyRateLimiter);` } },
      ],
    };
    // The clock passes the deadline once the prose has been read
    let reads = 0;
    const now = () => (reads++ < 2 ? 0 : 10_000);
    const raised = log.scan(msg, 's1', 'shadow', { budgetMs: 1_000, now });
    expect(raised.map((o) => o.transcriptLine)).toEqual(['Setting LOG_BUDGET = 30 now.']);
  });
});

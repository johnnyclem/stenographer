import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TruthLedger } from '../src/truth/ledger.js';
import { ObjectionLog, findLiteralHits, assertedText } from '../src/truth/objections.js';
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

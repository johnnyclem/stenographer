import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { TruthLedger } from '../src/truth/ledger.js';
import { ObjectionLog } from '../src/truth/objections.js';
import { Stenographer } from '../src/core/stenographer.js';
import {
  evaluateGate,
  runGateCLI,
  callDigest,
  harnessToolId,
  wikiMatchableTombstones,
  DEFAULT_GATE_TOOLS,
  type GateOptions,
} from '../src/truth/gate.js';
import { assertingFields, shellAssertingText } from '../src/truth/asserting.js';
import { LiteralMatcher, MatchDeadlineError } from '../src/truth/literal-matcher.js';
import type { TbEntry } from '../src/truth/types.js';

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'gate', `${name}.json`), 'utf8'));

const LOG_BUDGET = { subject: 'LOG_BUDGET', dead: '30', current: '100' };
const LIMITER = { dead: 'legacyRateLimiter', current: 'TokenBucket' };

let dir: string;
let statePath: string;
let budgetTb: TbEntry;
let limiterTb: TbEntry;

function seed(path: string): void {
  const db = new Database(path);
  const ledger = new TruthLedger(db);
  budgetTb = ledger.assertTombstone(
    { claim: 'LOG_BUDGET 30 is dead; the budget is 100', evidence: [{ kind: 'commit', ref: 'a1b2c3' }], signedBy: 'johnnyclem', literals: [LOG_BUDGET] },
    { author: 'johnnyclem' }
  );
  limiterTb = ledger.assertTombstone(
    { claim: 'legacyRateLimiter is gone; use TokenBucket', evidence: [{ kind: 'file', ref: 'src/limit.ts:10' }], signedBy: 'sam', literals: [LIMITER] },
    { author: 'sam' }
  );
  db.close();
}

const options = (overrides: Partial<GateOptions> = {}): GateOptions => ({
  mode: 'enforce',
  statePath,
  timeoutMs: 2000,
  onError: 'deny',
  tools: [...DEFAULT_GATE_TOOLS],
  ...overrides,
});

function objections(path = statePath) {
  const db = new Database(path);
  try {
    const ledger = new TruthLedger(db);
    return new ObjectionLog(db, ledger).list({ includeShadow: true });
  } finally {
    db.close();
  }
}

function reasonOf(output: string | null): string {
  const parsed = JSON.parse(output!);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steno-gate-'));
  statePath = join(dir, 'state.db');
  seed(statePath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gate: hook fixtures (enforce)', () => {
  it('Write: denies content asserting a dead literal, citing TB, claim, dead → current, signer and objection', () => {
    const result = evaluateGate(fixture('write'), options());
    expect(result.decision).toBe('deny');
    const reason = reasonOf(result.output);
    expect(reason).toContain(budgetTb.id);
    expect(reason).toContain('LOG_BUDGET 30 is dead; the budget is 100');
    expect(reason).toContain('LOG_BUDGET: 30 → 100');
    expect(reason).toContain('signed by johnnyclem');
    expect(reason).toContain('export const LOG_BUDGET = 30;');

    const [objection] = objections();
    expect(reason).toContain(objection.id);
    expect(objection).toMatchObject({
      tbId: budgetTb.id,
      sessionId: '8f1c2a7e-5b2d-4c1e-9a0b-3d4e5f6a7b8c',
      status: 'pending',
      delivered: true,
      source: 'tool:Write',
      gate: { toolName: 'Write', toolUseId: 'toolu_01WriteConfig', field: 'content', digest: result.digest },
    });
    expect(objection.messageId).toBe(`gate:${result.digest}`);
  });

  it('Edit: denies the new side, and lets a fix (dead value on the old side) through', () => {
    const edit = evaluateGate(fixture('edit'), options());
    expect(edit.decision).toBe('deny');
    expect(reasonOf(edit.output)).toContain('legacyRateLimiter → TokenBucket');
    expect(reasonOf(edit.output)).toContain('signed by sam');

    const fix = evaluateGate(fixture('edit-fix'), options());
    expect(fix).toMatchObject({ decision: 'allow', output: null, hits: [] });
  });

  it('Bash: denies a command that writes the dead value, not one that searches for it or commits its removal', () => {
    const write = evaluateGate(fixture('bash'), options());
    expect(write.decision).toBe('deny');
    expect(reasonOf(write.output)).toContain('In command: echo "LOG_BUDGET=30" >> .env');

    const search = evaluateGate(fixture('bash-search'), options());
    expect(search).toMatchObject({ decision: 'allow', output: null, hits: [] });
  });

  it('Read: never read, so it passes even when the gate could not open its state', () => {
    const result = evaluateGate(fixture('read'), options({ statePath: join(dir, 'missing.db') }));
    expect(result).toMatchObject({ decision: 'allow', output: null, error: null });
    expect(evaluateGate(fixture('write'), options({ tools: ['Edit'] }))).toMatchObject({ decision: 'allow', output: null });
  });

  it('retrying the same call files no second objection', () => {
    evaluateGate(fixture('write'), options());
    const again = evaluateGate(fixture('write'), options());
    expect(again.decision).toBe('deny');
    expect(objections()).toHaveLength(1);
    expect(again.hits[0].objection!.id).toBe(objections()[0].id);
  });
});

describe('gate: shadow mode', () => {
  it('records a shadow objection and allows the call', () => {
    const result = evaluateGate(fixture('write'), options({ mode: 'shadow', onError: 'allow' }));
    expect(result).toMatchObject({ decision: 'allow', output: null, error: null });
    expect(result.hits).toHaveLength(1);
    expect(result.notes.join('\n')).toContain('would deny this Write call');

    const [objection] = objections();
    expect(objection).toMatchObject({ tbId: budgetTb.id, status: 'pending', delivered: false });
    expect(result.notes.join('\n')).toContain(objection.id);
  });

  it('reports to stderr and the log when there is nowhere to file the objection (--wiki)', async () => {
    const wiki = join(__dirname, '..', 'spec', 'truth-format', 'fixtures', 'valid', 'ledger.jsonl');
    const log = join(dir, 'gate.log');
    const input = { ...fixture('write'), tool_input: { file_path: 'a.ts', content: 'const data = await fetchV1(url);' } };
    const { code, stdout, stderr } = await runCli(['--wiki', wiki, '--log', log], JSON.stringify(input));
    expect({ code, stdout }).toEqual({ code: 0, stdout: '' });
    expect(stderr).toContain('would deny this Write call');
    const [entry] = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entry).toMatchObject({ mode: 'shadow', decision: 'allow', toolName: 'Write', hits: [{ tbId: '01M1E6JK8BVGAAP733SN0VCW9W', objectionId: null }] });
  });
});

describe('gate: rulings on retry (overrule path)', () => {
  it('an overruled objection lets the same call through; a different call is still denied', async () => {
    const engine = new Stenographer({
      logPath: join(dir, 'log.jsonl'),
      statePath,
      mode: 'catchup',
      embeddingModel: 'hashed',
    });
    writeFileSync(join(dir, 'log.jsonl'), '');
    await engine.start();
    try {
      const first = evaluateGate(fixture('write'), options());
      const objectionId = first.hits[0].objection!.id;
      // The server sees the gate's objection like any other
      expect((await engine.getObjections()).map((o) => o.id)).toEqual([objectionId]);

      await engine.ruleOnObjection(objectionId, 'overruled', { author: 'johnnyclem', opinion: 'Load-test fixture, intended.' });

      const retry = evaluateGate(fixture('write'), options());
      expect(retry).toMatchObject({ decision: 'allow', output: null });
      expect(retry.hits[0].ruling).toMatchObject({ id: objectionId, status: 'overruled' });
      expect(retry.notes.join('\n')).toContain('overruled');

      // The ruling is scoped to this exact call (tool + input), in any session
      expect(evaluateGate({ ...fixture('write'), session_id: 'other-session' }, options()).decision).toBe('allow');
      const changed = { ...fixture('write'), tool_input: { ...fixture('write').tool_input, file_path: '/home/dev/app/src/other.ts' } };
      expect(evaluateGate(changed, options()).decision).toBe('deny');
      expect(await engine.getObjections()).toHaveLength(2);
    } finally {
      engine.stop();
    }
  });

  it('a sustained objection keeps denying the same call, without filing another', () => {
    const first = evaluateGate(fixture('write'), options());
    const objectionId = first.hits[0].objection!.id;
    const db = new Database(statePath);
    const ledger = new TruthLedger(db);
    const ruling = ledger.fileObjectionRuling(
      { objectionId, tbId: budgetTb.id, outcome: 'sustained', opinion: 'The budget is 100.' },
      { author: 'johnnyclem', provenance: { kind: 'sourceMessageId', ref: `gate:${first.digest}` } }
    );
    new ObjectionLog(db, ledger).markRuled(objectionId, 'sustained', ruling.id);
    db.close();

    const retry = evaluateGate({ ...fixture('write'), session_id: 'another-session' }, options());
    expect(retry.decision).toBe('deny');
    expect(reasonOf(retry.output)).toContain(`sustained objection ${objectionId}`);
    expect(reasonOf(retry.output)).toContain(ruling.id);
    expect(objections()).toHaveLength(1);
  });
});

describe('gate: budget and errors', () => {
  /** A clock that moves `step` ms every time it's read. */
  const ticking = (step: number) => {
    let t = 1_000_000;
    return () => (t += step);
  };

  it('past the budget, shadow allows and enforce denies (by default)', () => {
    const shadow = evaluateGate(fixture('write'), options({ mode: 'shadow', onError: 'allow', timeoutMs: 50 }), { now: ticking(20) });
    expect(shadow).toMatchObject({ decision: 'allow', output: null });
    expect(shadow.error).toMatch(/50 ms budget/);

    const enforce = evaluateGate(fixture('write'), options({ timeoutMs: 50 }), { now: ticking(20) });
    expect(enforce.decision).toBe('deny');
    expect(reasonOf(enforce.output)).toMatch(/could not check this call \(ran past its 50 ms budget\)/);
    // Nothing was decided on the merits, so nothing was filed
    expect(objections()).toEqual([]);
  });

  it('--on-error overrides the mode default', () => {
    const missing = options({ statePath: join(dir, 'missing.db') });
    expect(evaluateGate(fixture('write'), { ...missing, onError: 'allow' })).toMatchObject({ decision: 'allow', error: expect.stringMatching(/no state file/) });
    expect(evaluateGate(fixture('write'), { ...missing, mode: 'shadow', onError: 'deny' }).decision).toBe('deny');
  });

  it('the matcher gives up mid-text at its deadline', () => {
    const matcher = new LiteralMatcher([{ key: 0, literal: LOG_BUDGET }]);
    const text = 'x'.repeat(200_000);
    let t = 0;
    expect(() => matcher.match(text, { deadline: 10, now: () => (t += 1) })).toThrow(MatchDeadlineError);
  });

  it('CLI: a stdin that never closes is cut off at the budget', async () => {
    const stdin = new PassThrough();
    stdin.write('{"session_id":"s","tool_name":"Write",');
    const started = Date.now();
    const { code, stdout } = await runCli(['--state', statePath, '--mode', 'enforce', '--timeout-ms', '100'], null, stdin);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(code).toBe(0);
    expect(reasonOf(stdout.trim())).toMatch(/stdin was not closed within the budget/);
  });

  it('CLI: rejects a budget at or over the harness hook timeout, failing closed in enforce mode', async () => {
    const shadow = await runCli(['--state', statePath, '--timeout-ms', '60000'], JSON.stringify(fixture('write')));
    expect(shadow).toMatchObject({ code: 1, stdout: '' });
    expect(shadow.stderr).toMatch(/--timeout-ms must be .*below the harness hook timeout/);

    const enforce = await runCli(['--state', statePath, '--mode', 'enforce', '--timeout-ms', '60000'], JSON.stringify(fixture('write')));
    expect(enforce.code).toBe(0);
    expect(reasonOf(enforce.stdout.trim())).toMatch(/fails closed/);
  });

  it('CLI: input that is not a PreToolUse event follows --on-error', async () => {
    const shadow = await runCli(['--state', statePath], 'not json');
    expect(shadow).toMatchObject({ code: 1, stdout: '' });
    const enforce = await runCli(['--state', statePath, '--mode', 'enforce'], '{"hook_event_name":"PreToolUse"}');
    expect(reasonOf(enforce.stdout.trim())).toMatch(/not a PreToolUse event/);
  });

  it('CLI: allowing prints nothing, so the harness permission flow still applies', async () => {
    const { code, stdout, stderr } = await runCli(['--state', statePath, '--mode', 'enforce'], JSON.stringify(fixture('edit-fix')));
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

describe('gate: wiki source', () => {
  const wiki = join(__dirname, '..', 'spec', 'truth-format', 'fixtures', 'valid', 'ledger.jsonl');

  it('folds statuses: overridden and struck TBs are not enforced, active ones are', () => {
    const lines = readFileSync(wiki, 'utf8').split('\n');
    const { tombstones } = wikiMatchableTombstones(lines);
    // The LOG_BUDGET TB was overridden (seq 7); only fetchV1's carries literals and is active
    expect(tombstones.map((t) => t.id)).toEqual(['01M1E6JK8BVGAAP733SN0VCW9W']);

    const write = (content: string) => ({ ...fixture('write'), tool_input: { file_path: 'a.ts', content } });
    expect(evaluateGate(write('export const LOG_BUDGET = 30;'), options({ wikiPath: wiki })).decision).toBe('allow');
    const denied = evaluateGate(write('const data = await fetchV1(url);'), options({ wikiPath: wiki }));
    expect(denied.decision).toBe('deny');
    expect(reasonOf(denied.output)).toContain('fetchV1 → fetchV2');
    expect(reasonOf(denied.output)).toContain('a person must override or strike the TB');
    expect(existsSync(statePath)).toBe(true);
    expect(objections()).toEqual([]);
  });

  // F10: the wiki source never checked the chain and took v1 lines as truth,
  // so deleting or editing a TRANSITION brought an overridden TB back, and an
  // unhashed v1 TB written by anyone was enforced.
  it('refuses a file whose chain is broken or that holds an edited line: --on-error decides', () => {
    const lines = readFileSync(wiki, 'utf8').split('\n').filter(Boolean);
    const override = lines.findIndex((l) => JSON.parse(l).type === 'TRANSITION' && JSON.parse(l).status === 'overridden');
    expect(override).toBeGreaterThan(0);
    const deleted = [...lines.slice(0, override), ...lines.slice(override + 1)];
    expect(() => wikiMatchableTombstones(deleted)).toThrow(/line \d+: chain broken/);
    const edited = [...lines];
    edited[override] = JSON.stringify({ ...JSON.parse(lines[override]), status: 'active' });
    expect(() => wikiMatchableTombstones(edited)).toThrow(/line \d+: .*hash/);

    const broken = join(dir, 'broken.jsonl');
    writeFileSync(broken, deleted.join('\n') + '\n');
    const write = { ...fixture('write'), tool_input: { file_path: 'a.ts', content: 'export const LOG_BUDGET = 30;' } };
    const result = evaluateGate(write, options({ wikiPath: broken }));
    expect(result.decision).toBe('deny');
    expect(result.error).toMatch(/chain broken/);
    expect(evaluateGate(write, options({ wikiPath: broken, onError: 'allow' })).decision).toBe('allow');
  });

  it('leaves out v1 TBs (unhashed, so unverifiable) and unsigned TBs', () => {
    const v1 = JSON.stringify({
      id: '01V1TB0000000000000000000A',
      type: 'TB',
      ts: '2026-01-01T00:00:00Z',
      author: 'mallory',
      claim: 'fetchV2 is dead',
      evidence: [{ kind: 'commit', ref: 'abc' }],
      signedBy: 'mallory',
      literals: [{ dead: 'fetchV2' }],
      status: 'active',
    });
    expect(wikiMatchableTombstones([v1])).toMatchObject({ tombstones: [], skipped: 1 });
  });
});

describe('gate: call digest', () => {
  it('is the suite canonical call digest over the harness tool id', () => {
    expect(harnessToolId('Write')).toBe('claude-code/Write');
    expect(harnessToolId('mcp__github__create_issue')).toBe('github/create_issue');
    // Key order and whitespace don't change it; the input does
    const a = callDigest('claude-code/Write', { file_path: 'a', content: 'x' });
    expect(callDigest('claude-code/Write', { content: 'x', file_path: 'a' })).toBe(a);
    expect(callDigest('claude-code/Write', { content: 'y', file_path: 'a' })).not.toBe(a);
    expect(callDigest('claude-code/Edit', { content: 'x', file_path: 'a' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('asserting fields', () => {
  it('reads each known tool by its asserting fields only', () => {
    expect(assertingFields('Write', { file_path: 'a', content: 'c' })).toEqual([{ field: 'content', text: 'c' }]);
    expect(assertingFields('Edit', { file_path: 'a', old_string: 'o', new_string: 'n' })).toEqual([{ field: 'new_string', text: 'n' }]);
    expect(assertingFields('MultiEdit', { edits: [{ old_string: 'o', new_string: 'n1' }, { new_string: 'n2' }] })).toEqual([
      { field: 'edits[0].new_string', text: 'n1' },
      { field: 'edits[1].new_string', text: 'n2' },
    ]);
    expect(assertingFields('NotebookEdit', { new_source: 's', cell_id: 'c' })).toEqual([{ field: 'new_source', text: 's' }]);
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite']) {
      expect(assertingFields(tool, { file_path: 'legacyRateLimiter', pattern: 'legacyRateLimiter', content: 'legacyRateLimiter' })).toEqual([]);
    }
  });

  it('reads patches by their added lines and shells by what writes', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-const l = legacyRateLimiter();\n+const l = new TokenBucket();\n*** End Patch';
    expect(assertingFields('apply_patch', { input: patch })).toEqual([{ field: 'patch', text: 'const l = new TokenBucket();' }]);
    expect(assertingFields('shell', { command: ['bash', '-lc', 'rg legacyRateLimiter'] })).toEqual([]);
    expect(assertingFields('shell', { command: ['bash', '-lc', 'echo LOG_BUDGET=30 > .env'] })).toEqual([
      { field: 'command', text: 'echo LOG_BUDGET=30 > .env' },
    ]);
  });

  it('splits shell commands into what they write', () => {
    expect(shellAssertingText('grep -r x . | head -3 2>/dev/null')).toEqual([]);
    expect(shellAssertingText('cat <<EOF\nLOG_BUDGET = 30\nEOF')).toEqual([]);
    expect(shellAssertingText("cat > a.ts <<'EOF'\nLOG_BUDGET = 30\nEOF\nnpm test")).toEqual(["cat > a.ts <<'EOF'", 'LOG_BUDGET = 30', 'npm test']);
    expect(shellAssertingText("rg -l old | xargs sed -i 's/legacyRateLimiter/TokenBucket/g'")).toEqual(['TokenBucket']);
    expect(shellAssertingText('git -C app commit -am "LOG_BUDGET = 30"')).toEqual([]);
    expect(shellAssertingText("git apply <<'EOF'\n--- a/x\n+++ b/x\n-a\n+LOG_BUDGET = 30\nEOF")).toEqual(['LOG_BUDGET = 30']);
    expect(shellAssertingText('FOO=1 rg x')).toEqual(['FOO=1']);
  });
});

// STENO-REV-03: jq, yq, sort, find… were read as searches even when they
// wrote a file, so these ordinary ways of setting a config value got past
// the gate in enforce mode (and the live scan, and consults).
describe('gate: commands that search or transform but write a file', () => {
  const bash = (command: string) =>
    evaluateGate({ tool_name: 'Bash', tool_input: { command }, session_id: 's1' }, options());

  it.each([
    ["yq -i '.LOG_BUDGET = 30' config.yaml"],
    ["yq eval --inplace '.LOG_BUDGET = 30' config.yaml"],
    ["jq '.LOG_BUDGET = 30' config.json > config.tmp && mv config.tmp config.json"],
    ["jq '.LOG_BUDGET = 30' config.json | sponge config.json"],
    ["sort <<< 'LOG_BUDGET=30' > .env"],
    ["sort -o .env <<< 'LOG_BUDGET=30'"],
    ["find . -name config.ts -exec sed -i 's/LOG_BUDGET = 100/LOG_BUDGET = 30/' {} +"],
    ["find . -name config.ts -execdir sed -i 's/LOG_BUDGET = 100/LOG_BUDGET = 30/' {} \\;"],
    ["fd config.ts -x sed -i 's/LOG_BUDGET = 100/LOG_BUDGET = 30/'"],
    ["find . -name '*.env' -exec sh -c 'echo LOG_BUDGET=30 >> \"$1\"' _ {} \\;"],
  ])('denies %s', (command) => {
    expect(bash(command).decision).toBe('deny');
  });

  it.each([
    ["jq '.LOG_BUDGET' config.json"],
    ["yq '.LOG_BUDGET' config.yaml"],
    ["grep -rn 'LOG_BUDGET = 30' src > /tmp/hits.txt"],
    ["find . -name '*.ts' -exec grep -l 'LOG_BUDGET = 30' {} +"],
    ["find . -name config.ts -exec sed -i 's/LOG_BUDGET = 30/LOG_BUDGET = 100/' {} +"],
    ["sort .env | uniq"],
  ])('lets a search or a fix through: %s', (command) => {
    expect(bash(command)).toMatchObject({ decision: 'allow', hits: [] });
  });
});

describe('gate performance', () => {
  it('decides on 1,000 literals against a 100 KB Write in under 500 ms, opening the state each time', () => {
    const big = join(dir, 'big.db');
    const db = new Database(big);
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
    db.close();

    const lines: string[] = [];
    for (let i = 0; lines.join('\n').length < 100_000; i++) {
      lines.push(`const value${i} = computeSomething(argumentOne, ${1000 + (i % 500)}) + 42; // filler text`);
    }
    const content = lines.join('\n');
    const input = { ...fixture('write'), tool_input: { file_path: 'settings.ts', content } };

    evaluateGate(input, options({ statePath: big })); // warm the module caches, as a long-lived install would be
    const started = performance.now();
    const clean = evaluateGate(input, options({ statePath: big }));
    const elapsed = performance.now() - started;
    expect(clean).toMatchObject({ decision: 'allow', error: null, hits: [] });
    expect(elapsed).toBeLessThan(500);

    const dirty = evaluateGate(
      { ...input, tool_input: { file_path: 'settings.ts', content: `${content}\nexport const SETTING_7_VALUE = 1007;` } },
      options({ statePath: big })
    );
    expect(dirty.decision).toBe('deny');
    expect(dirty.hits.map((h) => h.line)).toEqual(['export const SETTING_7_VALUE = 1007;']);
  });
});

async function runCli(
  args: string[],
  stdinText: string | null,
  stdinStream?: PassThrough
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = stdinStream ?? new PassThrough();
  if (stdinText !== null) stdin.end(stdinText);
  let stdout = '';
  let stderr = '';
  const code = await runGateCLI(args, {
    stdin,
    stdout: { write: (s: string) => ((stdout += s), true) } as any,
    stderr: { write: (s: string) => ((stderr += s), true) } as any,
  });
  return { code, stdout, stderr };
}

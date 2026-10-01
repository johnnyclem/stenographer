import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store/index.js';
import { runNotaryCLI, type NotaryIO } from '../src/truth/notary-cli.js';
import type { ProposalEntry, TbEntry } from '../src/truth/types.js';

function fakeIO(answer: (question: string) => string, interactive = true) {
  const printed: string[] = [];
  const questions: string[] = [];
  const io: NotaryIO = {
    interactive,
    print: (line) => printed.push(line),
    ask: async (question) => {
      questions.push(question);
      return answer(question);
    },
  };
  return { io, printed, questions };
}

describe('terminal notary (STENO-T-20)', () => {
  let dir: string;
  let statePath: string;
  let proposalId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steno-notary-cli-'));
    statePath = join(dir, 'state.db');
    const store = new StateStore(statePath);
    proposalId = store.truth.draftTombstone(
      { claim: 'LOG_BUDGET 30 is dead', evidence: [{ kind: 'commit', ref: 'a1' }], literals: [{ subject: 'LOG_BUDGET', dead: '30' }] },
      { author: 'agent:drafter' }
    ).id;
    store.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const read = <T>(fn: (store: StateStore) => T): T => {
    const store = new StateStore(statePath);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  it('the confirmation code is not derived from the id the caller passed', async () => {
    const { io, printed } = fakeIO(() => proposalId.slice(-4));
    await runNotaryCLI('notarize', [proposalId, '--as', 'johnny', '--state', statePath], io);
    expect(printed.join('\n')).toMatch(/Not confirmed/);
    expect(read((s) => (s.truth.getEntry(proposalId) as ProposalEntry).body.status)).toBe('open');
  });

  it('notarizes when the challenge shown on the terminal is typed back', async () => {
    const { io, questions } = fakeIO((q) => q.match(/type the code ([0-9A-Z]+)/)![1]);
    await runNotaryCLI('notarize', [proposalId, '--as', 'johnny', '--state', statePath], io);
    expect(questions).toHaveLength(1);
    const minted = read((s) => s.truth.listProposals('signed'));
    expect(minted).toHaveLength(1);
    const tb = read((s) => s.truth.getTruth('current'))[0] as TbEntry;
    expect(tb.body.signedBy).toBe('johnny');
  });

  it('draws a fresh challenge every time', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { io, questions } = fakeIO(() => 'nope');
      await runNotaryCLI('notarize', [proposalId, '--as', 'johnny', '--state', statePath], io);
      codes.add(questions[0].match(/type the code ([0-9A-Z]+)/)![1]);
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it('refuses without an interactive terminal', async () => {
    const { io } = fakeIO(() => '', false);
    await expect(runNotaryCLI('notarize', [proposalId, '--as', 'johnny', '--state', statePath], io)).rejects.toThrow(
      /interactive terminal/
    );
  });

  it('validates --as against the signer registry before asking anything', async () => {
    const registry = join(dir, 'signers.json');
    writeFileSync(registry, JSON.stringify({ signers: [{ id: 'johnnyclem', role: 'human' }, { id: 'agent:*', role: 'agent' }] }));
    for (const as of ['mallory', 'agent:drafter']) {
      const { io, questions } = fakeIO(() => '');
      await expect(
        runNotaryCLI('notarize', [proposalId, '--as', as, '--state', statePath, '--signer-registry', registry], io)
      ).rejects.toThrow(/registry|human/);
      expect(questions).toHaveLength(0);
    }

    const { io } = fakeIO((q) => q.match(/type the code ([0-9A-Z]+)/)![1]);
    await runNotaryCLI('notarize', [proposalId, '--as', 'JohnnyClem', '--state', statePath, '--signer-registry', registry], io);
    const tb = read((s) => s.truth.getTruth('current'))[0] as TbEntry;
    expect(tb.body.signedBy).toBe('johnnyclem');
  });

  it('refuses reserved identities as the notary', async () => {
    const { io } = fakeIO(() => '');
    await expect(
      runNotaryCLI('notarize', [proposalId, '--as', 'detector:supersession', '--state', statePath], io)
    ).rejects.toThrow(/reserved/);
  });
});

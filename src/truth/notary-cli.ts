/**
 * Stenographer — terminal notary (§15)
 *
 *   stenographer proposals [state-path]
 *   stenographer notarize <proposal-id> --as <name> [--state <path>] [--signer-registry <path>]
 *   stenographer notarize <proposal-id> --as <name> --decline "<reason>"
 *
 * Notarizing needs an interactive terminal and a typed confirmation code.
 * The code is drawn at random and shown only on the terminal, so a caller
 * can't prepare the answer from the arguments it passed (piping the id's
 * last characters into this command used to work).
 *
 * This is a deliberate-confirmation step, not proof that a person is
 * present: anything that can drive a pseudo-terminal (script(1), expect, a
 * pty library) can read the code and type it back. It separates an agent
 * from the operator only when the agent cannot run commands as the
 * operator's user — see the README's threat model.
 */

import { parseArgs } from 'node:util';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { StateStore } from '../store/index.js';
import { formatProposalNotice } from './notary.js';
import { SignerRegistry, resolveIdentity } from './identity.js';
import type { ProposalEntry } from './types.js';

const DEFAULT_STATE = './stenographer.db';

/** Crockford base32 (no I, L, O or U to misread): easy to read off a terminal and type back. */
const CHALLENGE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHALLENGE_LENGTH = 6;

/** The terminal the notary talks to — injectable for tests. */
export interface NotaryIO {
  /** Both ends are a TTY. */
  interactive: boolean;
  print(line: string): void;
  ask(question: string): Promise<string>;
}

function terminalIO(): NotaryIO {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: (line) => console.log(line),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

function challengeCode(): string {
  let code = '';
  for (let i = 0; i < CHALLENGE_LENGTH; i++) code += CHALLENGE_ALPHABET[randomInt(CHALLENGE_ALPHABET.length)];
  return code;
}

export async function runNotaryCLI(
  command: 'proposals' | 'notarize',
  args: string[],
  io: NotaryIO = terminalIO()
): Promise<void> {
  if (command === 'proposals') {
    const store = new StateStore(args[0] || DEFAULT_STATE);
    const open = store.truth.listProposals('open');
    if (open.length === 0) {
      io.print('No open proposals.');
    }
    for (const p of open) {
      io.print(formatProposalNotice(p) + (p.body.requiresNotary ? '\n  (needs your notarization)' : ''));
    }
    store.close();
    return;
  }

  const { positionals, values } = parseArgs({
    args,
    options: {
      as: { type: 'string' },
      state: { type: 'string' },
      decline: { type: 'string' },
      'signer-registry': { type: 'string' },
    },
    allowPositionals: true,
  });
  const proposalId = positionals[0];
  if (!proposalId || !values.as) {
    throw new Error(
      'usage: stenographer notarize <proposal-id> --as <name> [--state <path>] [--signer-registry <path>] [--decline "<reason>"]'
    );
  }
  if (!io.interactive) {
    throw new Error('notarizing requires an interactive terminal — a person has to confirm it');
  }
  // Checked before anything is shown: an unlisted or non-human name never gets a prompt
  const registry = values['signer-registry'] ? SignerRegistry.load(values['signer-registry']) : null;
  const notary = resolveIdentity(values.as, ['human'], 'notary', registry);

  const store = new StateStore(values.state || DEFAULT_STATE);
  try {
    // Nothing is signed onto a ledger that fails its integrity check
    const integrity = store.truth.verify();
    if (!integrity.ok) {
      throw new Error(
        `the truth ledger failed its integrity check (${integrity.failure!.message}) — nothing was signed; ` +
          `run 'stenographer verify ${values.state || DEFAULT_STATE}'`
      );
    }
    const proposal = store.truth.getEntry(proposalId) as ProposalEntry | null;
    if (!proposal || proposal.type !== 'PROPOSAL') throw new Error(`no proposal ${proposalId}`);
    io.print(formatProposalNotice(proposal));
    io.print(JSON.stringify(proposal.body.draft, null, 2));

    const code = challengeCode();
    const verb = values.decline !== undefined ? 'decline' : 'notarize';
    const typed = await io.ask(`\nTo ${verb} this as '${notary}', type the code ${code}: `);
    if (typed.trim().toUpperCase() !== code) {
      io.print('Not confirmed. Nothing was written.');
      return;
    }

    if (values.decline !== undefined) {
      store.truth.dismissProposal(proposalId, notary, values.decline || 'declined by notary');
      io.print(`Declined ${proposalId}.`);
    } else {
      const minted = store.truth.signProposal(proposalId, notary, undefined, { notarized: true });
      io.print(`Notarized: ${minted.type} ${minted.id}, signed by ${notary}.`);
    }
  } finally {
    store.close();
  }
}

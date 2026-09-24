/**
 * Stenographer — terminal notary (§15)
 *
 *   stenographer proposals [state-path]
 *   stenographer notarize <proposal-id> --as <name> [--state <path>]
 *   stenographer notarize <proposal-id> --as <name> --decline "<reason>"
 *
 * Notarizing needs an interactive terminal and a typed confirmation, so an
 * agent driving a non-interactive shell can't approve its own draft by
 * piping "y" into this command.
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { StateStore } from '../store/index.js';
import { formatProposalNotice } from './notary.js';
import type { ProposalEntry } from './types.js';

const DEFAULT_STATE = './stenographer.db';

export async function runNotaryCLI(command: 'proposals' | 'notarize', args: string[]): Promise<void> {
  if (command === 'proposals') {
    const store = new StateStore(args[0] || DEFAULT_STATE);
    const open = store.truth.listProposals('open');
    if (open.length === 0) {
      console.log('No open proposals.');
    }
    for (const p of open) {
      console.log(formatProposalNotice(p) + (p.body.requiresNotary ? '\n  (needs your notarization)' : ''));
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
    },
    allowPositionals: true,
  });
  const proposalId = positionals[0];
  const notary = values.as;
  if (!proposalId || !notary) {
    throw new Error('usage: stenographer notarize <proposal-id> --as <name> [--state <path>] [--decline "<reason>"]');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('notarizing requires an interactive terminal — a person has to confirm it');
  }

  const store = new StateStore(values.state || DEFAULT_STATE);
  try {
    const proposal = store.truth.getEntry(proposalId) as ProposalEntry | null;
    if (!proposal || proposal.type !== 'PROPOSAL') throw new Error(`no proposal ${proposalId}`);
    console.log(formatProposalNotice(proposal));
    console.log(JSON.stringify(proposal.body.draft, null, 2));

    const code = proposalId.slice(-4);
    const verb = values.decline !== undefined ? 'decline' : 'notarize';
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`\nTo ${verb} this as '${notary}', type the last 4 characters of its id (${'•'.repeat(4)}): `);
    rl.close();
    if (typed.trim().toUpperCase() !== code.toUpperCase()) {
      console.log('Not confirmed. Nothing was written.');
      return;
    }

    if (values.decline !== undefined) {
      store.truth.dismissProposal(proposalId, notary, values.decline || 'declined by notary');
      console.log(`Declined ${proposalId}.`);
    } else {
      const minted = store.truth.signProposal(proposalId, notary, undefined, { notarized: true });
      console.log(`Notarized: ${minted.type} ${minted.id}, signed by ${notary}.`);
    }
  } finally {
    store.close();
  }
}

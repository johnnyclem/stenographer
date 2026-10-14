/**
 * Stenographer — the review session (PRD R9)
 *
 *   stenographer review [--state <path>] [--as <name>] [--signer-registry <path>] [--json]
 *
 * A meeting a person holds, not a queue that pings them: the docket of
 * everything waiting on a person (docket.ts), one item at a time, with
 * the outcomes a person can reach: approve, refute, defer, strike, cite
 * the record, or ask. A person's approval plus one more promotes a UV
 * (approvals.ts), and that person becomes answerable for the TB.
 *
 * Without `--as` (or with `--json`) the docket is printed and nothing is
 * written. With it, ruling needs an interactive terminal and a typed
 * confirmation code, as the notary does: a deliberate-confirmation step,
 * not proof a person is present (see the README's threat model).
 *
 * `ask` answers from the record: the session that authored the item is not
 * reachable from a terminal, so stenographer shows the passages it found
 * and says that is what it is doing. The engine's callOnAuthor reaches a
 * live session over the delivery channel (meta.kind `called-on`).
 */

import { parseArgs } from 'node:util';
import { randomInt } from 'node:crypto';
import { StateStore } from '../store/index.js';
import { SignerRegistry, resolveIdentity } from './identity.js';
import { buildDocket, formatDocketItem, lexicalPassages, type Docket, type DocketItem } from './docket.js';
import { INFERENCE_AT_FAULT } from './suspicion.js';
import { EvidenceSchema, REPORTER_IDENTITY, type Evidence, type TbEntry } from './types.js';
import type { NotaryIO } from './notary-cli.js';

const DEFAULT_STATE = './stenographer.db';
const CHALLENGE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHALLENGE_LENGTH = 6;

function terminalIO(): NotaryIO {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: (line) => console.log(line),
    ask: async (question) => {
      const { createInterface } = await import('node:readline/promises');
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

/** `kind ref [detail…]`, one item per line; blank for none. */
export function parseEvidenceLines(text: string): Evidence[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [kind, ref, ...rest] = l.split(/\s+/);
      return EvidenceSchema.parse({ kind, ref, ...(rest.length > 0 ? { detail: rest.join(' ') } : {}) });
    });
}

const ACTIONS: Record<DocketItem['kind'], string> = {
  uv: '[a]pprove  [r]efute  [c]ite the record  [s]trike  as[k]  [d]efer  [q]uit',
  appeal: '[a]pprove the appeal (overrides the TB)  [r]efute it (the TB is active again)  [c]ite the record  [s]trike  as[k]  [d]efer  [q]uit',
  'derivation-review': '[a]pprove (sign the contest: the premise goes under appeal)  [x] dismiss as inference-at-fault  [d]efer  [q]uit',
  draft: '[a]pprove (notarize the draft)  [x] decline  [d]efer  [q]uit',
};

export async function runReviewCLI(args: string[], io: NotaryIO = terminalIO(), now: () => number = Date.now): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      as: { type: 'string' },
      state: { type: 'string' },
      json: { type: 'boolean' },
      'signer-registry': { type: 'string' },
    },
    allowPositionals: false,
  });
  const store = new StateStore(values.state || DEFAULT_STATE);
  try {
    const docket = withPassages(store, buildDocket({ ledger: store.truth, approvals: store.approvals, attestations: store.attestations }, now()));
    if (values.json) {
      io.print(JSON.stringify(docket, null, 2));
      return 0;
    }
    printDocket(io, docket);
    if (!values.as) return 0;
    if (docket.size === 0) return 0;
    if (!io.interactive) throw new Error('ruling in review requires an interactive terminal — a person has to confirm it');
    // Checked before anything is shown for ruling: an unlisted or non-human name never gets a prompt
    const registry = values['signer-registry'] ? SignerRegistry.load(values['signer-registry']) : null;
    const person = resolveIdentity(values.as, ['human'], 'reviewer', registry);
    const integrity = store.truth.verify();
    if (!integrity.ok) {
      throw new Error(`the truth ledger failed its integrity check (${integrity.failure!.message}) — nothing was written; run 'stenographer verify'`);
    }
    const code = challengeCode();
    const typed = await io.ask(`\nTo review as '${person}', type the code ${code}: `);
    if (typed.trim().toUpperCase() !== code) {
      io.print('Not confirmed. Nothing was written.');
      return 1;
    }

    let written = 0;
    for (const group of docket.groups) {
      if (group.items.length > 1) io.print(`\n── ${group.items.length} items on ${group.subject} ──`);
      for (const item of group.items) {
        io.print('\n' + formatDocketItem(item));
        const outcome = await rule(store, item, person, io, now);
        if (outcome === 'quit') {
          io.print(`Review ended: ${written} ruling${written === 1 ? '' : 's'} written.`);
          return 0;
        }
        if (outcome === 'written') written++;
      }
    }
    io.print(`\nDocket done: ${written} ruling${written === 1 ? '' : 's'} written.`);
    return 0;
  } finally {
    store.close();
  }
}

function printDocket(io: NotaryIO, docket: Docket): void {
  if (docket.size === 0) {
    io.print('The docket is empty: nothing waits on a person.');
    return;
  }
  io.print(`${docket.size} item${docket.size === 1 ? '' : 's'} on the docket (${docket.nominated} nominated), oldest ${docket.oldest ? formatDocketAge(docket.oldest.ageMs) : '-'}.`);
  for (const group of docket.groups) {
    if (group.items.length > 1) io.print(`\n── ${group.items.length} items on ${group.subject} ──`);
    for (const item of group.items) io.print('\n' + formatDocketItem(item));
  }
}

function formatDocketAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
}

/** The record's passages for every item, found lexically (no models in a terminal). */
function withPassages(store: StateStore, docket: Docket): Docket {
  const messages = store.listMessageTexts();
  for (const group of docket.groups) {
    for (const item of group.items) item.passages = lexicalPassages(messages, item.text, 3);
  }
  return docket;
}

async function askEvidence(io: NotaryIO, prompt: string): Promise<Evidence[]> {
  const text = await io.ask(`${prompt} (one per line as "kind ref [detail]", end with an empty line):\n`);
  const lines = [text];
  while (lines[lines.length - 1].trim() !== '') lines.push(await io.ask(''));
  return parseEvidenceLines(lines.join('\n'));
}

async function rule(store: StateStore, item: DocketItem, person: string, io: NotaryIO, now: () => number): Promise<'written' | 'deferred' | 'quit'> {
  const answer = (await io.ask(`${ACTIONS[item.kind]}\n> `)).trim().toLowerCase();
  const action = answer[0] ?? 'd';
  try {
    if (action === 'q') return 'quit';
    if (action === 'd' || answer === '') return 'deferred';
    switch (item.kind) {
      case 'uv':
      case 'appeal': {
        if (action === 'a') {
          let evidence = await askEvidence(io, 'What you checked, if anything');
          if (evidence.length === 0 && (item.passages?.length ?? 0) > 0) {
            const cite = (await io.ask('No evidence given. Cite the passages shown as evidence? [y/N] ')).trim().toLowerCase();
            if (cite.startsWith('y')) evidence = item.passages!.map((p) => ({ kind: 'message' as const, ref: p.id }));
          }
          const note = (await io.ask('Note (optional): ')).trim() || null;
          const outcome = store.approvals.approve({ uvId: item.id, by: person, role: 'human', evidence, note }, now);
          io.print(
            outcome.status === 'promoted'
              ? `Promoted: TB ${outcome.tombstone.id}, signed by ${person}, who answers for it.`
              : `Approved. Promotion needs ${outcome.approvals.missing.join(' and ') || 'nothing more'}.`
          );
          return 'written';
        }
        if (action === 'r') {
          const evidence = await askEvidence(io, 'The evidence that refutes it');
          const opinion = (await io.ask('Why (optional): ')).trim() || undefined;
          const result = store.truth.resolveUv(item.id, 'refuted', evidence, { author: person, opinion, timestamp: new Date(now()).toISOString() });
          const tbStatus = item.appeals ? (store.truth.getEntry(item.appeals.tombstone.id) as TbEntry).body.status : null;
          io.print(`Refuted UV ${item.id}.${item.appeals ? ` TB ${item.appeals.tombstone.id} is ${tbStatus === 'active' ? 'active again' : 'still under appeal'}.` : ''}`);
          if (result.suspects.length > 0) io.print(`The suspicion detector filed ${result.suspects.length} derivation review${result.suspects.length === 1 ? '' : 's'}: ${result.suspects.map((p) => p.id).join(', ')}.`);
          return 'written';
        }
        if (action === 'c') {
          const cites = (item.passages ?? []).map((p) => p.id);
          if (cites.length === 0) {
            io.print('The record holds no passage for it: nothing to cite.');
            return 'deferred';
          }
          const outcome = store.approvals.approve({ uvId: item.id, by: REPORTER_IDENTITY, role: 'reporter', cites }, now);
          io.print(outcome.status === 'promoted' ? `Promoted: TB ${outcome.tombstone.id}.` : `Stenographer cited ${cites.length} passage${cites.length === 1 ? '' : 's'}; promotion still needs ${outcome.approvals.missing.join(' and ') || 'nothing more'}.`);
          return 'written';
        }
        if (action === 's') {
          const opinion = (await io.ask('Opinion (required; rulings are precedent): ')).trim();
          store.truth.fileRuling({ kind: 'strike', opinion, target: item.id }, { author: person, timestamp: new Date(now()).toISOString() });
          io.print(`Struck ${item.id}.`);
          return 'written';
        }
        if (action === 'k') {
          io.print(
            `The session that authored ${item.id} (${item.author}${item.agentSessionId ? `, session ${item.agentSessionId}` : ''}) is not reachable from a terminal; stenographer answers from the record:`
          );
          if ((item.passages?.length ?? 0) === 0) io.print('  (the record holds no passage for it)');
          for (const p of item.passages ?? []) io.print(`  ${p.id} [${p.role}] ${p.content}`);
          return 'deferred';
        }
        break;
      }
      case 'derivation-review': {
        if (action === 'a') {
          const uv = store.truth.signProposal(item.id, person, undefined, { timestamp: new Date(now()).toISOString() });
          io.print(`Signed: UV ${uv.id} contests ${item.review!.contests}, which is under appeal now.`);
          return 'written';
        }
        if (action === 'x') {
          const reason = (await io.ask(`Reason [${INFERENCE_AT_FAULT}]: `)).trim() || INFERENCE_AT_FAULT;
          store.truth.dismissProposal(item.id, person, reason, { timestamp: new Date(now()).toISOString() });
          io.print(`Dismissed ${item.id} (${reason}).`);
          return 'written';
        }
        break;
      }
      case 'draft': {
        if (action === 'a') {
          const minted = store.truth.signProposal(item.id, person, undefined, { notarized: true, timestamp: new Date(now()).toISOString() });
          io.print(`Notarized: TB ${minted.id}, signed by ${person}, who answers for it.`);
          return 'written';
        }
        if (action === 'x') {
          const reason = (await io.ask('Reason: ')).trim() || 'declined in review';
          store.truth.dismissProposal(item.id, person, reason, { timestamp: new Date(now()).toISOString() });
          io.print(`Declined ${item.id}.`);
          return 'written';
        }
        break;
      }
    }
    io.print(`'${answer}' is not an action here; deferred.`);
    return 'deferred';
  } catch (err) {
    io.print(`Not written: ${err instanceof Error ? err.message : String(err)}`);
    return 'deferred';
  }
}

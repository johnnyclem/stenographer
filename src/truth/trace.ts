/**
 * Stenographer — trace: what an entry rests on, and what rests on it
 *
 *   stenographer trace <id> [--up|--down] [--json] [--state <path>]
 *
 * The answer a person gives when asked about a conclusion: the tree of
 * premises below it (or the entries above it, with --up), each node with
 * its status, standing, signer and answerable person, and the failing
 * premise marked. The MCP read tool get_derivation and REST
 * GET /truth/:id/derivation return the same tree.
 */

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { TruthLedger } from './ledger.js';
import { premiseFailure } from './status.js';
import { displayStatus } from './format.js';
import { displayText } from './display.js';
import { assertSchemaSupported } from '../store/migrations.js';
import type { Standing, StandingReason, StandingReasonKind, TruthEntry, TruthEntryType } from './types.js';

export type TraceDirection = 'down' | 'up';

/** How deep a trace goes before it stops (a derivation is acyclic, but wiki refs can cross). */
export const MAX_TRACE_DEPTH = 32;

export interface DerivationNode {
  id: string;
  /** How this node hangs off its parent: a pinned premise, a wiki evidence ref, or the root. */
  via: 'derives' | 'wiki' | null;
  /** Set when this ledger doesn't hold the entry: nothing else is known about it. */
  missing?: true;
  type?: TruthEntryType;
  /** The wire status (`contested`, not "under appeal"). */
  status?: string | null;
  struck?: boolean;
  standing?: Standing;
  reasons?: StandingReason[];
  author?: string;
  signedBy?: string | null;
  /** The human who answers for it, when the entry names one (phase C); null until then. */
  answerableBy?: string | null;
  /** The claim, assertion or opinion. */
  text?: string;
  /** Why this node fails as a premise of its parent, if it does: the mark a person looks for. */
  failing: StandingReasonKind | null;
  /** Set when the walk stopped here: the depth cap, or a cycle through wiki refs. */
  truncated?: true;
  /** Down: the premises this node rests on. Up: the entries resting on it. */
  children: DerivationNode[];
}

const textOf = (entry: TruthEntry): string | undefined => {
  const b = entry.body as { claim?: string; assertion?: string; opinion?: string; note?: string | null };
  return b.claim ?? b.assertion ?? b.opinion ?? b.note ?? undefined;
};

/**
 * The derivation tree of `id`: down (what it rests on) or up (what rests
 * on it). Each node is read from the ledger; a premise it doesn't hold is
 * a `missing` node. The root's `failing` is null; a child's is what it does
 * to its parent, read the way the standing fold reads it.
 */
export function buildDerivation(ledger: TruthLedger, id: string, direction: TraceDirection = 'down'): DerivationNode | null {
  const root = ledger.getEntry(id);
  if (!root) return null;
  const path = new Set<string>();

  const node = (entry: TruthEntry, via: DerivationNode['via'], depth: number): DerivationNode => {
    const struck = Boolean((entry.body as { status?: unknown }).status === 'struck') || isStruck(ledger, entry.id);
    const status = ((entry.body as { status?: string | null }).status ?? null) as string | null;
    const failing =
      via === null
        ? null
        : premiseFailure({ type: entry.type, status, struck, premises: [] });
    const out: DerivationNode = {
      id: entry.id,
      via,
      type: entry.type,
      status,
      struck,
      ...(entry.standing ? { standing: entry.standing, reasons: entry.reasons ?? [] } : {}),
      author: entry.author,
      signedBy: entry.type === 'TB' ? ((entry.body as { signedBy?: string | null }).signedBy ?? null) : undefined,
      answerableBy: ((entry.body as { answerableBy?: string | null }).answerableBy ?? null) as string | null,
      ...(textOf(entry) !== undefined ? { text: textOf(entry) } : {}),
      failing: direction === 'down' ? failing : null,
      children: [],
    };
    if (depth >= MAX_TRACE_DEPTH || path.has(entry.id)) {
      out.truncated = true;
      return out;
    }
    // A failing premise is the nearest one on its path: nothing below it is read
    if (direction === 'down' && failing && failing !== 'premise-missing') return out;
    path.add(entry.id);
    const next =
      direction === 'down'
        ? ledger.premisesOf(entry.id).map((p) => ({ id: p.id, via: p.kind }))
        : ledger.dependentsOf(entry.id).map((d) => ({ id: d.id, via: d.kind }));
    for (const child of next) {
      const held = ledger.getEntry(child.id);
      if (!held) {
        out.children.push({ id: child.id, via: child.via, missing: true, failing: child.via === 'derives' && direction === 'down' ? 'premise-missing' : null, children: [] });
        continue;
      }
      out.children.push(node(held, child.via, depth + 1));
    }
    path.delete(entry.id);
    return out;
  };
  return node(root, null, 0);
}

function isStruck(ledger: TruthLedger, id: string): boolean {
  return ledger.isStruck(id);
}

/** The tree as lines a person reads, the failing premise marked with ✗. */
export function formatDerivation(tree: DerivationNode, direction: TraceDirection = 'down'): string[] {
  const lines: string[] = [];
  const describe = (n: DerivationNode): string => {
    if (n.missing) return `${n.id} (not held here)`;
    const state = [displayStatus(n.status, n.struck), ...(n.standing && n.standing !== 'sound' ? [n.standing] : [])].join(' · ');
    // Who stands behind it, and who answers for it: the signer, when they are one and the same
    const answers = (who: string | null | undefined) =>
      n.type === 'TB' || n.type === 'RULING' ? (n.answerableBy ? (n.answerableBy === who ? ', who answers' : `, ${n.answerableBy} answers`) : ', nobody answers') : '';
    const who = n.type === 'TB' ? `signed by ${n.signedBy ?? 'nobody'}${answers(n.signedBy)}` : `by ${n.author}${answers(n.author)}`;
    const text = n.text !== undefined ? `: "${displayText(n.text, 120)}"` : '';
    return `${n.type} ${n.id} [${state}] ${who}${text}`;
  };
  const walk = (n: DerivationNode, prefix: string, last: boolean, root: boolean) => {
    const edge = root ? '' : `${last ? '└─ ' : '├─ '}${n.via ?? ''} `;
    const mark = n.failing ? ` ✗ ${n.failing}` : '';
    const cut = n.truncated ? ' …' : '';
    lines.push(`${prefix}${edge}${describe(n)}${mark}${cut}`);
    const childPrefix = root ? '' : `${prefix}${last ? '   ' : '│  '}`;
    n.children.forEach((c, i) => walk(c, childPrefix, i === n.children.length - 1, false));
  };
  walk(tree, '', true, true);
  if (tree.children.length === 0) lines.push(direction === 'down' ? '(a root: it rests on no entry)' : '(nothing rests on it)');
  return lines;
}

export async function runTraceCLI(
  args: string[],
  io: { print(line: string): void } = { print: (line) => console.log(line) }
): Promise<number> {
  let id: string;
  let direction: TraceDirection;
  let json: boolean;
  let path: string;
  try {
    const { positionals, values } = parseArgs({
      args,
      options: { up: { type: 'boolean' }, down: { type: 'boolean' }, json: { type: 'boolean' }, state: { type: 'string' } },
      allowPositionals: true,
    });
    if (positionals.length !== 1) throw new Error('one entry id');
    if (values.up && values.down) throw new Error('--up or --down, not both');
    id = positionals[0];
    direction = values.up ? 'up' : 'down';
    json = Boolean(values.json);
    path = values.state ?? './stenographer.db';
  } catch (err) {
    io.print(`usage: stenographer trace <id> [--up|--down] [--json] [--state <path>] — ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!existsSync(path)) {
    io.print(`no state file at ${path}`);
    return 2;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { fileMustExist: true });
    assertSchemaSupported(db);
    const tree = buildDerivation(new TruthLedger(db), id, direction);
    if (!tree) {
      io.print(`no such entry: ${id}`);
      return 1;
    }
    if (json) io.print(JSON.stringify({ direction, tree }, null, 2));
    else for (const line of formatDerivation(tree, direction)) io.print(line);
    return 0;
  } catch (err) {
    io.print(`Could not trace ${id} in ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    db?.close();
  }
}

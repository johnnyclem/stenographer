/**
 * Stenographer — derived status
 *
 * Status is not stored state. An entry's status is a fold over the links
 * that point at it, joined on a lattice, so no sequence of writes can move
 * it anywhere its links don't justify:
 *
 *   TB        active < contested < overridden
 *   UV        open < verified < refuted
 *   PROPOSAL  open < dismissed < signed
 *   RULING    current < superseded   (precedents only: other rulings have no status)
 *
 * `overrides` makes a TB overridden and nothing takes that back: refuting a
 * contest only removes that contest's contribution (STENO-T-06). A TB is
 * contested while at least one contesting UV is open and not struck.
 * `strikes` makes any entry struck, for good.
 *
 * A body may also record a terminal status it arrived with — a wiki line
 * that was already overridden, or a pre-1.0 row. That acts as a floor on
 * the lattice: it can hold an entry at a terminal status, never lift one
 * out of it. Non-terminal recorded statuses are ignored; links decide.
 *
 * The ledger's cached status column is this derivation, recomputed on every
 * write and checked by `stenographer verify`.
 */

import type { LinkType, Standing, StandingReason, StandingReasonKind, TruthEntryType, TruthLink } from './types.js';

const ORDER: Partial<Record<TruthEntryType, readonly string[]>> = {
  TB: ['active', 'contested', 'overridden'],
  UV: ['open', 'verified', 'refuted'],
  PROPOSAL: ['open', 'dismissed', 'signed'],
  RULING: ['current', 'superseded'],
};

const TERMINAL: Partial<Record<TruthEntryType, readonly string[]>> = {
  TB: ['overridden'],
  UV: ['verified', 'refuted'],
  PROPOSAL: ['dismissed', 'signed'],
  RULING: ['superseded'],
};

/** What `recordedStatus` answers for a precedent ruling without a recorded status: the lattice's floor, so it reads `current`. */
export const PRECEDENT_FLOOR = 'current';

export interface InboundLink {
  type: LinkType;
  /**
   * The entry the link comes from, with its derived status and whether it
   * was struck; null when that entry isn't in this ledger (a link carried
   * in by a wiki import).
   */
  from: { type: TruthEntryType; status: string | null; struck?: boolean } | null;
}

/** What one inbound link says about its target's status, if anything. */
function contribution(type: TruthEntryType, link: InboundLink): string | null {
  switch (type) {
    case 'TB':
      if (link.type === 'overrides') return 'overridden';
      // A contest counts while its UV is open and not struck (inadmissible).
      // A contest from a UV this ledger doesn't hold can't be shown closed,
      // so it still counts.
      if (
        link.type === 'contests' &&
        (link.from === null || (link.from.type === 'UV' && link.from.status === 'open' && !link.from.struck))
      ) {
        return 'contested';
      }
      return null;
    case 'UV':
      if (link.type === 'verifies') return 'verified';
      if (link.type === 'refutes') return 'refuted';
      return null;
    case 'PROPOSAL':
      if (link.type === 'signs') return 'signed';
      if (link.type === 'dismisses') return 'dismissed';
      return null;
    case 'RULING':
      // A precedent is superseded by a later precedent's supersedes link (spec, Precedents)
      if (link.type === 'supersedes' && (link.from === null || link.from.type === 'RULING')) return 'superseded';
      return null;
    default:
      return null;
  }
}

/** The status of an entry of `type`, from its inbound links and any status its body recorded. */
export function deriveStatus(type: TruthEntryType, recorded: unknown, inbound: InboundLink[]): string | null {
  const order = ORDER[type];
  if (!order) return null;
  // Only a precedent ruling has a status: recordedStatus answers for it, and nothing for any other ruling
  if (type === 'RULING' && typeof recorded !== 'string') return null;
  let rank = 0;
  const join = (status: string | null) => {
    if (status !== null) rank = Math.max(rank, order.indexOf(status));
  };
  if (typeof recorded === 'string' && TERMINAL[type]!.includes(recorded)) join(recorded);
  for (const link of inbound) join(contribution(type, link));
  return order[rank];
}

export function deriveStruck(inbound: InboundLink[]): boolean {
  return inbound.some((l) => l.type === 'strikes');
}

/**
 * A body's recorded status, from its stored JSON. A precedent ruling (kind
 * `precedent`) answers `current` when it records none: it is the one ruling
 * with a status, and it starts current.
 */
export function recordedStatus(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { status?: unknown; kind?: unknown };
  if (b.kind === 'precedent' && b.status === undefined) return PRECEDENT_FLOOR;
  return b.status;
}

export interface DerivedState {
  status: string | null;
  struck: boolean;
}

/**
 * Derives every entry's status from scratch — what the cache must equal.
 * UVs and proposals first, then TBs, whose contests read their UVs' status.
 */
export function deriveAll(
  entries: Array<{ id: string; type: TruthEntryType; recorded: unknown }>,
  links: TruthLink[]
): Map<string, DerivedState> {
  const types = new Map(entries.map((e) => [e.id, e.type]));
  const inbound = new Map<string, TruthLink[]>();
  for (const link of links) {
    const list = inbound.get(link.toId);
    if (list) list.push(link);
    else inbound.set(link.toId, [link]);
  }

  const derived = new Map<string, DerivedState>();
  const derive = (entry: { id: string; type: TruthEntryType; recorded: unknown }) => {
    const links = (inbound.get(entry.id) ?? []).map((link): InboundLink => {
      const fromType = types.get(link.fromId);
      return {
        type: link.type,
        from: fromType
          ? { type: fromType, status: derived.get(link.fromId)?.status ?? null, struck: derived.get(link.fromId)?.struck ?? false }
          : null,
      };
    });
    derived.set(entry.id, { status: deriveStatus(entry.type, entry.recorded, links), struck: deriveStruck(links) });
  };
  for (const entry of entries) if (entry.type !== 'TB') derive(entry);
  for (const entry of entries) if (entry.type === 'TB') derive(entry);
  return derived;
}

// ─────────────────────────────────────────────────────────────
// Standing: what happened underneath an entry
// ─────────────────────────────────────────────────────────────

/**
 * What the standing fold reads of an entry: its type, its derived status
 * and struck flag, and the ids of its premises (the targets of its
 * `derives` links, and the `wiki` evidence refs it cites). The ledger reads
 * nodes from its tables; a stream reader builds them from the lines it
 * folded (derivation.ts premisesOfLine).
 */
export interface StandingNode {
  type: TruthEntryType;
  status: string | null;
  struck: boolean;
  premises: Array<{ id: string; kind: 'derives' | 'wiki' }>;
  /**
   * The standing this reader has cached for the entry, when it has one and
   * it is current. A sound premise outside the set being derived is not
   * walked: it contributes nothing. Leave it out to walk everything.
   */
  standing?: Standing | null;
}

export interface DerivedStanding {
  standing: Standing;
  /** The nearest failing premise on each path below the entry, in premise order. */
  reasons: StandingReason[];
}

const UNSUPPORTING: readonly StandingReasonKind[] = ['premise-overridden', 'premise-refuted', 'premise-superseded', 'premise-struck'];

/** Why a premise fails on its own, if it does: dead (unsupporting), or weak (clouding). */
export function premiseFailure(node: StandingNode): StandingReasonKind | null {
  if (node.struck) return 'premise-struck';
  if (node.type === 'TB') {
    if (node.status === 'overridden') return 'premise-overridden';
    if (node.status === 'contested') return 'premise-under-appeal';
    return null;
  }
  if (node.type === 'UV') {
    if (node.status === 'refuted') return 'premise-refuted';
    if (node.status === 'open') return 'premise-open';
    return null;
  }
  // A precedent: evidence doesn't refute a fiat, but a later precedent supersedes it
  if (node.type === 'RULING' && node.status === 'superseded') return 'premise-superseded';
  return null;
}

/** The standing a set of reasons adds up to: the worst of them. */
export function standingOf(reasons: readonly StandingReason[]): Standing {
  if (reasons.some((r) => UNSUPPORTING.includes(r.reason))) return 'unsupported';
  return reasons.length > 0 ? 'clouded' : 'sound';
}

/**
 * Derives the standing of `ids` from the premises below each, all the way
 * down (spec/truth-format, "Standing"). `node` reads one entry; it answers
 * undefined for an id the reader doesn't hold.
 *
 * A pinned premise (`derives`) the reader doesn't hold clouds the entry
 * (`premise-missing`); an unpinned one (a `wiki` evidence ref) that doesn't
 * resolve is no premise at all. A premise that fails on its own — struck,
 * overridden, refuted, under appeal, or an open UV — is the nearest failing
 * premise on that path, and nothing below it is read. A premise that holds
 * on its own passes its own reasons up, each marked `via` that premise. An
 * entry with no premises, or whose premises all hold, is sound. The walk is
 * memoized and cycle-safe: a premise reached again on the path it is on
 * contributes nothing (the ledger never writes a `derives` cycle, but
 * imported `wiki` refs can cross).
 *
 * `ids` are derived in full. A premise outside them whose node carries a
 * cached standing of `sound` is taken at its word, so a write re-derives
 * what it touched and what rests on that, not the whole ledger below.
 */
export function deriveStanding(
  ids: Iterable<string>,
  node: (id: string) => StandingNode | undefined,
  memo: Map<string, DerivedStanding> = new Map()
): Map<string, DerivedStanding> {
  const dirty = new Set(ids);
  const visiting = new Set<string>();
  const walk = (id: string, entry: StandingNode): DerivedStanding => {
    const done = memo.get(id);
    if (done) return done;
    visiting.add(id);
    // Each failing premise once per direct premise it is reached through: two
    // premises resting on one dead root give two reasons, not one per path
    // (a deep chain has exponentially many paths)
    const seen = new Set<string>();
    const reasons: StandingReason[] = [];
    const add = (r: StandingReason) => {
      const key = `${r.premise}\u0000${r.reason}\u0000${r.via ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        reasons.push(r);
      }
    };
    for (const premise of entry.premises) {
      if (premise.id === id || visiting.has(premise.id)) continue;
      const below = node(premise.id);
      if (!below) {
        if (premise.kind === 'derives') add({ premise: premise.id, reason: 'premise-missing' });
        continue;
      }
      const own = premiseFailure(below);
      if (own) {
        add({ premise: premise.id, reason: own });
        continue;
      }
      if (!dirty.has(premise.id) && !memo.has(premise.id) && below.standing === 'sound') continue;
      for (const r of walk(premise.id, below).reasons) add({ premise: r.premise, reason: r.reason, via: premise.id });
    }
    visiting.delete(id);
    const derived = { standing: standingOf(reasons), reasons };
    memo.set(id, derived);
    return derived;
  };
  const out = new Map<string, DerivedStanding>();
  for (const id of dirty) {
    const entry = node(id);
    if (entry) out.set(id, walk(id, entry));
  }
  return out;
}

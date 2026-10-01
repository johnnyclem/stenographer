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

import type { LinkType, TruthEntryType, TruthLink } from './types.js';

const ORDER: Partial<Record<TruthEntryType, readonly string[]>> = {
  TB: ['active', 'contested', 'overridden'],
  UV: ['open', 'verified', 'refuted'],
  PROPOSAL: ['open', 'dismissed', 'signed'],
};

const TERMINAL: Partial<Record<TruthEntryType, readonly string[]>> = {
  TB: ['overridden'],
  UV: ['verified', 'refuted'],
  PROPOSAL: ['dismissed', 'signed'],
};

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
    default:
      return null;
  }
}

/** The status of an entry of `type`, from its inbound links and any status its body recorded. */
export function deriveStatus(type: TruthEntryType, recorded: unknown, inbound: InboundLink[]): string | null {
  const order = ORDER[type];
  if (!order) return null;
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

/** A body's recorded status, from its stored JSON. */
export function recordedStatus(body: unknown): unknown {
  return body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined;
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

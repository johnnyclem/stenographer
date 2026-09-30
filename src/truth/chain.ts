/**
 * Stenographer — ledger hash chain and integrity check
 *
 * Every ledger entry is chained, in insertion order, to the one before it:
 *
 *   hash = sha256hex(JCS(record))
 *   record = { id, type, createdAt, author, provenance, agentSessionId,
 *              origin, body, targetRef, links, prevHash }
 *
 * `links` are the links that entry's append wrote, `prevHash` is the
 * previous entry's hash (null for the first), and JCS is RFC 8785. The
 * cached `status`/`struck` columns and the embedding are not hashed:
 * status is derived from links (status.ts) and re-derived here.
 *
 * What this detects: any change to a chained entry or link, an entry or link
 * inserted or deleted anywhere but the tail, reordering, and a cached status
 * that its links don't justify. What it does not: truncating the newest
 * entries, or rewriting the whole chain from some point on — anyone who can
 * write the SQLite file can recompute every later hash. Comparing the head
 * hash `stenographer verify` prints against a copy kept elsewhere catches
 * both.
 */

import type Database from 'better-sqlite3';
import { canonicalize, sha256Hex } from './jcs.js';
import { deriveAll, recordedStatus } from './status.js';
import type { LinkType, MarkerBody, TruthEntryType, TruthLink } from './types.js';

/** Version of the record layout above, kept in truth_meta. */
export const CHAIN_VERSION = '1';

/** A truth_entries row as SQLite returns it. */
export interface LedgerRow {
  id: string;
  type: string;
  created_at: string;
  author: string;
  provenance: string;
  agent_session_id: string | null;
  origin: string;
  body: string;
  status: string | null;
  target_ref: string | null;
  struck: number;
  seq: number | null;
  prev_hash: string | null;
  hash: string | null;
  appended_links: string | null;
}

/** The hashed fields of a row. Parses the stored JSON, so appends and checks hash the same values. */
export function chainRecord(
  row: Pick<
    LedgerRow,
    'id' | 'type' | 'created_at' | 'author' | 'provenance' | 'agent_session_id' | 'origin' | 'body' | 'target_ref' | 'appended_links' | 'prev_hash'
  >
): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    createdAt: row.created_at,
    author: row.author,
    provenance: JSON.parse(row.provenance),
    agentSessionId: row.agent_session_id ?? null,
    origin: row.origin,
    body: JSON.parse(row.body),
    targetRef: row.target_ref ?? null,
    links: JSON.parse(row.appended_links ?? '[]'),
    prevHash: row.prev_hash ?? null,
  };
}

export function recordHash(record: Record<string, unknown>): string {
  return sha256Hex(canonicalize(record));
}

export function linkKey(link: { fromId: string; toId: string; type: string }): string {
  return `${link.fromId}\u0000${link.toId}\u0000${link.type}`;
}

export type IntegrityFailureKind =
  | 'not-chained'
  | 'sequence'
  | 'prev-hash'
  | 'hash'
  | 'unreadable'
  | 'unchained-entry'
  | 'undeclared-link'
  | 'missing-link'
  | 'status'
  | 'struck';

export interface IntegrityFailure {
  kind: IntegrityFailureKind;
  /** The entry where the chain or derivation first diverges, when there is one. */
  id?: string;
  seq?: number;
  message: string;
}

export interface IntegrityReport {
  ok: boolean;
  entries: number;
  links: number;
  /** The newest chained entry — record its hash elsewhere to detect truncation or a rewrite. */
  head: { seq: number; id: string; hash: string } | null;
  /** Set when the ledger predates the chain: entries up to the marker were chained when it was written. */
  chainedAtMigration: { markerId: string; at: string; entries: number } | null;
  /** The first divergence found, in chain order, then links, then derived status. */
  failure: IntegrityFailure | null;
}

/**
 * Validates the chain, the link table against the links entries declare,
 * and every cached status against its derivation. Reads only.
 */
export function verifyLedger(db: Database.Database): IntegrityReport {
  const report: IntegrityReport = { ok: false, entries: 0, links: 0, head: null, chainedAtMigration: null, failure: null };
  const fail = (failure: IntegrityFailure): IntegrityReport => ({ ...report, failure });

  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'truth_meta'`).get();
  const version = hasMeta
    ? (db.prepare(`SELECT value FROM truth_meta WHERE key = 'chain_version'`).get() as { value: string } | undefined)?.value
    : undefined;
  if (version !== CHAIN_VERSION) {
    return fail({
      kind: 'not-chained',
      message: version
        ? `ledger chain version ${version} is not one this stenographer reads (${CHAIN_VERSION})`
        : 'ledger has not been hash-chained (a pre-1.0 ledger is chained when stenographer opens it)',
    });
  }

  const rows = db.prepare('SELECT * FROM truth_entries WHERE seq IS NOT NULL ORDER BY seq').all() as LedgerRow[];
  const tableLinks = db.prepare('SELECT from_id, to_id, link_type FROM truth_links ORDER BY rowid').all() as Array<{
    from_id: string;
    to_id: string;
    link_type: string;
  }>;
  report.entries = rows.length;
  report.links = tableLinks.length;

  // 1. The chain, in insertion order
  const declared = new Map<string, string>();
  const bodies = new Map<string, unknown>();
  let prev: LedgerRow | null = null;
  for (const row of rows) {
    const expectedSeq = (prev?.seq ?? 0) + 1;
    if (row.seq !== expectedSeq) {
      return fail({
        kind: 'sequence',
        id: row.id,
        seq: row.seq!,
        message: `entry ${row.id} is at position ${row.seq}, expected ${expectedSeq} — an entry before it was removed`,
      });
    }
    if ((row.prev_hash ?? null) !== (prev?.hash ?? null)) {
      return fail({
        kind: 'prev-hash',
        id: row.id,
        seq: row.seq,
        message: `entry ${row.id} (#${row.seq}) does not follow the entry before it: prevHash ${row.prev_hash ?? 'null'}, expected ${prev?.hash ?? 'null'}`,
      });
    }
    let hash: string;
    try {
      hash = recordHash(chainRecord(row));
      for (const link of JSON.parse(row.appended_links ?? '[]') as TruthLink[]) declared.set(linkKey(link), row.id);
      bodies.set(row.id, JSON.parse(row.body));
    } catch (err) {
      return fail({
        kind: 'unreadable',
        id: row.id,
        seq: row.seq,
        message: `entry ${row.id} (#${row.seq}) can't be read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (hash !== row.hash) {
      return fail({
        kind: 'hash',
        id: row.id,
        seq: row.seq,
        message: `entry ${row.id} (#${row.seq}) was changed after it was written: its content hashes to ${hash}, the chain recorded ${row.hash}`,
      });
    }
    if (row.type === 'MARKER') {
      const body = bodies.get(row.id) as MarkerBody;
      if (body.kind === 'chained-at-migration' && !report.chainedAtMigration) {
        report.chainedAtMigration = { markerId: row.id, at: row.created_at, entries: body.entries };
      }
    }
    prev = row;
  }
  if (prev) report.head = { seq: prev.seq!, id: prev.id, hash: prev.hash! };

  const unchained = db.prepare('SELECT id FROM truth_entries WHERE seq IS NULL ORDER BY rowid LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (unchained) {
    return fail({
      kind: 'unchained-entry',
      id: unchained.id,
      message: `entry ${unchained.id} is not in the chain — it was written around the ledger (directly or by a pre-1.0 stenographer)`,
    });
  }

  // 2. Links: the table holds exactly the links entries declared
  const present = new Set<string>();
  for (const l of tableLinks) {
    const key = linkKey({ fromId: l.from_id, toId: l.to_id, type: l.link_type });
    present.add(key);
    if (!declared.has(key)) {
      return fail({
        kind: 'undeclared-link',
        id: l.to_id,
        message: `link ${l.from_id} -${l.link_type}-> ${l.to_id} was not written by any entry in the chain`,
      });
    }
  }
  for (const [key, owner] of declared) {
    if (!present.has(key)) {
      const [fromId, toId, type] = key.split('\u0000');
      return fail({
        kind: 'missing-link',
        id: owner,
        message: `link ${fromId} -${type}-> ${toId}, written with entry ${owner}, is missing`,
      });
    }
  }

  // 3. Cached status equals the derivation from links
  const derived = deriveAll(
    rows.map((r) => ({ id: r.id, type: r.type as TruthEntryType, recorded: recordedStatus(bodies.get(r.id)) })),
    tableLinks.map((l) => ({ fromId: l.from_id, toId: l.to_id, type: l.link_type as LinkType }))
  );
  for (const row of rows) {
    const want = derived.get(row.id)!;
    if ((row.status ?? null) !== want.status) {
      return fail({
        kind: 'status',
        id: row.id,
        seq: row.seq!,
        message: `${row.type} ${row.id} is cached as ${row.status ?? 'null'}, but its links make it ${want.status ?? 'null'}`,
      });
    }
    if (Boolean(row.struck) !== want.struck) {
      return fail({
        kind: 'struck',
        id: row.id,
        seq: row.seq!,
        message: `${row.type} ${row.id} is cached as ${row.struck ? '' : 'not '}struck, but its links make it ${want.struck ? '' : 'not '}struck`,
      });
    }
  }

  return { ...report, ok: true };
}

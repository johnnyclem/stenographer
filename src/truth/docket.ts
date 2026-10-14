/**
 * Stenographer — the review docket (PRD R9)
 *
 * One docket holds everything that waits on a person: open UVs (the ones
 * agents nominated first), TBs under appeal (read through their contesting
 * UVs, so approving the appeal or refuting it is one act on one item),
 * the suspicion detector's derivation reviews (R4), and agents' tombstone
 * drafts (nominated ones first). Items are grouped by subject so related
 * claims are ruled on together. Each item shows the claim, its evidence,
 * who approved or attested, and its derivation tree; the engine adds the
 * passages of the record it finds for it.
 *
 * A person starts the session (`stenographer review`, get_docket, GET
 * /docket) or sets a cadence. Nothing notifies per item: get_status shows
 * the docket's size and the age of its oldest item instead.
 */

import type { TruthLedger } from './ledger.js';
import type { UvApprovals, ApprovalSummary, UvApproval } from './approvals.js';
import type { UvAttestations, Attestation } from './attestations.js';
import { draftNominated } from './attestations.js';
import { buildDerivation, type DerivationNode } from './trace.js';
import { literalSetKey } from './quorum.js';
import { DERIVATION_DETECTOR } from './suspicion.js';
import { displayStatus } from './format.js';
import type { Evidence, TbEntry, TombstonedLiteral, UvEntry } from './types.js';

export type DocketItemKind = 'uv' | 'appeal' | 'derivation-review' | 'draft';

/** A passage of the indexed record the engine found for an item. */
export interface RecordPassage {
  id: string;
  role: string;
  timestamp: string;
  content: string;
  score: number;
}

export interface DocketItem {
  kind: DocketItemKind;
  /** The UV's or proposal's id. */
  id: string;
  /** What the item is about: the TB under appeal, the refuted entry, the literal set, or the item itself. */
  subject: string;
  createdAt: string;
  ageMs: number;
  /** Agents nominated it: three or more sessions from different angles. Listed first. */
  nominated: boolean;
  /** A UV that is a premise of a refuted or overridden entry (R4): first in the verification queue. */
  suspect: boolean;
  /** The assertion or claim. */
  text: string;
  author: string;
  agentSessionId: string | null;
  evidence: Evidence[];
  /** A UV: why its author believes it, and how to check. */
  basis?: string;
  verifyBy?: UvEntry['body']['verifyBy'];
  /** An appeal: the TB under appeal. */
  appeals?: { tombstone: TbEntry; status: string };
  /** A derivation review: the premise it contests and the detector's ranking. */
  review?: { contests: string; detail: string };
  /** A draft: its literals, and how many agent sessions drafted the same set. */
  draft?: { literals: TombstonedLiteral[]; proposalsOfSameLiterals: number };
  approvals?: ApprovalSummary & { list: UvApproval[] };
  /** Agents' standing verdicts on a UV. */
  attestations?: Array<Pick<Attestation, 'author' | 'agentSessionId' | 'resolution' | 'createdAt' | 'evidence' | 'note'>>;
  standing?: UvEntry['standing'];
  derivation: DerivationNode | null;
  /** The nearest current precedents (R7), by the words they share with the item, so a person rules consistently. */
  precedents: Array<{ id: string; scope: string; opinion: string; score: number }>;
  /** Passages of the indexed record, when the engine built the docket. */
  passages?: RecordPassage[];
}

export interface Docket {
  groups: Array<{ subject: string; items: DocketItem[] }>;
  size: number;
  nominated: number;
  /** The oldest item: a neglected docket is visible without being loud. */
  oldest: { id: string; kind: DocketItemKind; createdAt: string; ageMs: number } | null;
}

export interface DocketSources {
  ledger: TruthLedger;
  approvals: UvApprovals;
  attestations: UvAttestations;
}

/** The docket as of `now` (epoch ms). */
export function buildDocket(sources: DocketSources, now: number = Date.now()): Docket {
  const { ledger, approvals, attestations } = sources;
  const items: DocketItem[] = [];
  const suspects = ledger.suspectUvs();
  const precedents = ledger.getPrecedents().map((p) => ({ id: p.id, scope: p.body.scope ?? '', opinion: p.body.opinion }));
  const nearest = (text: string) =>
    lexicalPassages(
      precedents.map((p) => ({ id: p.id, content: `${p.scope.replace(/[.-]/g, ' ')} ${p.opinion}` })),
      text,
      3
    ).map((hit) => {
      const p = precedents.find((x) => x.id === hit.id)!;
      return { id: p.id, scope: p.scope, opinion: p.opinion, score: hit.score };
    });

  for (const uv of ledger.getOpenUvs()) {
    const contested = uv.body.contests ? (ledger.getEntry(uv.body.contests) as TbEntry | null) : null;
    const summary = approvals.summary(uv.id);
    items.push({
      kind: contested ? 'appeal' : 'uv',
      id: uv.id,
      subject: contested ? contested.id : uv.id,
      createdAt: uv.createdAt,
      ageMs: Math.max(0, now - Date.parse(uv.createdAt)),
      nominated: Boolean(uv.corroborated),
      suspect: suspects.has(uv.id),
      text: uv.body.assertion,
      author: uv.author,
      agentSessionId: uv.agentSessionId ?? null,
      evidence: [],
      basis: uv.body.basis,
      verifyBy: uv.body.verifyBy,
      ...(contested ? { appeals: { tombstone: contested, status: displayStatus(contested.body.status, ledger.isStruck(contested.id)) } } : {}),
      approvals: { ...summary, list: approvals.list(uv.id).filter((a) => a.consumedBy === null) },
      attestations: attestations
        .list(uv.id)
        .filter((a) => a.consumedBy === null)
        .map(({ author, agentSessionId, resolution, createdAt, evidence, note }) => ({ author, agentSessionId, resolution, createdAt, evidence, note })),
      standing: uv.standing,
      derivation: buildDerivation(ledger, uv.id, 'down'),
      precedents: nearest(uv.body.assertion),
    });
  }

  const open = ledger.listProposals('open');
  for (const p of open) {
    if (p.body.kind === 'uv' && p.body.signal?.source === 'detector:derivation' && p.author === DERIVATION_DETECTOR) {
      const draft = p.body.draft as { assertion: string; contests: string };
      const refuted = p.body.targetRef?.split(':')[1] ?? p.id;
      items.push({
        kind: 'derivation-review',
        id: p.id,
        subject: `derivation:${refuted}`,
        createdAt: p.createdAt,
        ageMs: Math.max(0, now - Date.parse(p.createdAt)),
        nominated: false,
        suspect: false,
        text: draft.assertion,
        author: p.author,
        agentSessionId: null,
        evidence: [],
        review: { contests: draft.contests, detail: p.body.signal.detail ?? '' },
        derivation: buildDerivation(ledger, draft.contests, 'down'),
        precedents: nearest(draft.assertion),
      });
    } else if (
      p.body.kind === 'tombstone' &&
      p.body.requiresNotary &&
      ((p.body.signal?.source === 'agent-draft' && ledger.isAgent(p.author)) || p.body.meta?.nominated === true)
    ) {
      // An agent's draft, or a TB agents minted under 1.0's quorum rule that a teammate's stream carried (filed nominated on import)
      const draft = p.body.draft as { claim: string; evidence: Evidence[]; literals?: TombstonedLiteral[] };
      const literals = draft.literals ?? [];
      const set = literals.length > 0 ? literalSetKey(literals) : null;
      const same = set
        ? open.filter(
            (o) =>
              o.body.kind === 'tombstone' &&
              o.body.signal?.source === 'agent-draft' &&
              ledger.isAgent(o.author) &&
              literalSetKey(((o.body.draft as { literals?: TombstonedLiteral[] }).literals ?? []) as TombstonedLiteral[]) === set
          ).length
        : 1;
      items.push({
        kind: 'draft',
        id: p.id,
        subject: set ? `literals:${set}` : p.id,
        createdAt: p.createdAt,
        ageMs: Math.max(0, now - Date.parse(p.createdAt)),
        nominated: p.body.meta?.nominated === true || draftNominated(ledger, p),
        suspect: false,
        text: draft.claim,
        author: p.author,
        agentSessionId: p.agentSessionId ?? null,
        evidence: draft.evidence ?? [],
        draft: { literals, proposalsOfSameLiterals: same },
        derivation: null,
        precedents: nearest(draft.claim),
      });
    }
  }

  // Nominated first, then oldest first; groups keep the order their first item has
  items.sort((a, b) => Number(b.nominated) - Number(a.nominated) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const groups = new Map<string, DocketItem[]>();
  for (const item of items) {
    const group = groups.get(item.subject) ?? [];
    group.push(item);
    groups.set(item.subject, group);
  }
  const oldest = items.reduce<DocketItem | null>((o, i) => (o === null || i.createdAt < o.createdAt ? i : o), null);
  return {
    groups: [...groups.entries()].map(([subject, items]) => ({ subject, items })),
    size: items.length,
    nominated: items.filter((i) => i.nominated).length,
    oldest: oldest ? { id: oldest.id, kind: oldest.kind, createdAt: oldest.createdAt, ageMs: oldest.ageMs } : null,
  };
}

/** One line per item, for a terminal or a chat: what it is, how old, and who stands where. */
export function formatDocketItem(item: DocketItem): string {
  const age = formatAge(item.ageMs);
  const flags = [item.nominated ? 'NOMINATED' : '', item.suspect ? 'SUSPECT' : ''].filter(Boolean).join(' ');
  const head = `${item.kind.toUpperCase()} ${item.id} (${age} old${flags ? `, ${flags}` : ''})`;
  const lines = [head, `  ${item.text}`];
  if (item.appeals) lines.push(`  appeals TB ${item.appeals.tombstone.id} (${item.appeals.status}): ${item.appeals.tombstone.body.claim}`);
  if (item.review) lines.push(`  contests ${item.review.contests}; ${item.review.detail}`);
  if (item.basis) lines.push(`  basis: ${item.basis}`);
  if (item.verifyBy) lines.push(`  verify by ${item.verifyBy.kind}: ${item.verifyBy.value}`);
  if (item.evidence.length > 0) lines.push(`  evidence: ${item.evidence.map((e) => `${e.kind} ${e.ref}`).join(', ')}`);
  if (item.draft) {
    lines.push(`  literals: ${item.draft.literals.map((l) => `${l.subject ? `${l.subject} = ` : ''}${l.dead}${l.current ? ` → ${l.current}` : ''}`).join(', ')}`);
    if (item.draft.proposalsOfSameLiterals > 1) lines.push(`  ${item.draft.proposalsOfSameLiterals} agent drafts name this set`);
  }
  if (item.approvals) {
    const a = item.approvals;
    const who = a.list.map((x) => `${x.by}${x.role === 'agent' ? ` (session ${x.agentSessionId})` : x.role === 'reporter' ? ' (reporter)' : ''}`).join(', ');
    lines.push(`  approvals: ${a.list.length === 0 ? 'none' : who}${a.missing.length > 0 ? `; promotion needs ${a.missing.join(' and ')}` : ''}`);
  }
  if (item.attestations && item.attestations.length > 0) {
    lines.push(`  agents' verdicts: ${item.attestations.map((t) => `${t.author} ${t.resolution} (session ${t.agentSessionId})`).join(', ')}`);
  }
  if (item.standing && item.standing !== 'sound') lines.push(`  standing: ${item.standing}`);
  if (item.precedents.length > 0) {
    lines.push('  precedents:');
    for (const p of item.precedents) lines.push(`    ${p.id} [${p.scope}] ${p.opinion.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (item.passages && item.passages.length > 0) {
    lines.push('  from the record:');
    for (const p of item.passages) lines.push(`    ${p.id} [${p.role}] ${p.content.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return lines.join('\n');
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Passages of the record for an item, without an embedder: messages that
 * share the most distinctive words with the item's text (a word is four or
 * more letters). The engine ranks by embedding instead; this is what the
 * terminal review uses, since it runs without the models.
 */
export function lexicalPassages(
  messages: Array<{ id: string; role?: string; timestamp?: string; content: string }>,
  text: string,
  k: number = 3
): RecordPassage[] {
  const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []).filter((w) => !STOP.has(w)));
  const wanted = words(text);
  if (wanted.size === 0) return [];
  return messages
    .map((m) => {
      const have = words(m.content);
      let shared = 0;
      for (const w of wanted) if (have.has(w)) shared++;
      return { id: m.id, role: m.role ?? '', timestamp: m.timestamp ?? '', content: m.content, score: shared / Math.sqrt(wanted.size * Math.max(have.size, 1)) };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}

const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'were', 'what', 'when', 'then', 'than', 'they', 'them', 'there', 'their', 'which', 'will', 'would', 'should', 'could', 'about', 'into', 'also', 'because']);

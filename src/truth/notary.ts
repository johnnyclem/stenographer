/**
 * Stenographer — Notarization of agent-drafted tombstones (§15)
 *
 * Agents may draft tombstones (`propose_tombstone`) but never sign them
 * alone. A draft is raised to the person running stenographer through the
 * same receivers objections use — smallchat's channel bridge and operator
 * webhooks, never the attached MCP client, which is the drafting agent —
 * and mints once that person notarizes it, or once two or more agent
 * sessions agree on it (the agent quorum, attestations.ts). Agents' verdicts
 * on a UV that dispute each other, or that would override a TB, are raised
 * the same way (raiseUvForPerson).
 *
 * The notary paths are the ones the agent MCP profile doesn't serve:
 * - REST `POST /proposals/:id/notarize` with `X-Notary-Secret`, the secret
 *   the operator shares with their approval UI (smallchat) and not with
 *   agents;
 * - `sign_proposal` in the operator MCP profile, for a notary UI;
 * - `stenographer notarize <id>`, which requires an interactive terminal.
 *
 * This is a guard against an agent approving its own draft through its
 * MCP tools, not a sandbox. The secret lives in the environment of the
 * process that serves REST — typically the agent-spawned MCP server — so an
 * agent that can read that environment or its MCP config, edit that config
 * to the operator profile, or drive a terminal as the operator can do what
 * the operator can. Separating those needs OS-level separation (the agent
 * runs as another user or in a sandbox); see the README's threat model.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  CHANNEL_NAME,
  SENDER,
  post,
  redactUrl,
  webhookHeaders,
  webhookId,
  type ObjectionSinkConfig,
} from './delivery.js';
import { displayText } from './display.js';
import type { ProposalEntry, TombstonedLiteral, UvEntry } from './types.js';

/** Longest claim a notice shows; the draft itself is in the review inbox. */
const MAX_NOTICE_CLAIM = 2_000;

/** Header the notary secret travels in on REST notary routes. */
export const NOTARY_SECRET_HEADER = 'x-notary-secret';

/** Constant-time comparison; a missing secret on either side never matches. */
export function notarySecretMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One line a person can read in a chat or a terminal (plus the drafter's
 * reason on a second). Everything the drafter wrote is escaped, so control
 * characters can't conceal or overwrite the claim being approved.
 */
export function formatProposalNotice(p: ProposalEntry): string {
  const draft = p.body.draft as { claim?: string; literals?: TombstonedLiteral[] };
  const literals = (draft.literals ?? [])
    .map((l) => `${l.subject ? `${l.subject} = ` : ''}${l.dead}${l.current ? ` → ${l.current}` : ''}`)
    .join(', ');
  return (
    `✍️ ${displayText(p.author)} drafted a tombstone for your approval (${displayText(p.id)}): ` +
    displayText(draft.claim ?? '', MAX_NOTICE_CLAIM) +
    (literals ? ` — would object to ${displayText(literals, MAX_NOTICE_CLAIM)}` : '') +
    (p.body.signal.detail ? `\nWhy: ${displayText(p.body.signal.detail, MAX_NOTICE_CLAIM)}` : '')
  );
}

/** Channel meta: flat strings, identifier-only keys (Claude Code drops others). */
export function proposalMeta(p: ProposalEntry, notarizeUrl?: string): Record<string, string> {
  return {
    kind: 'proposal',
    proposal_id: p.id,
    drafted_by: p.author,
    ...(p.agentSessionId ? { session_ids: p.agentSessionId } : {}),
    ...(notarizeUrl ? { notarize_url: notarizeUrl } : {}),
  };
}

/**
 * Raises a draft to every operator-configured receiver. Best effort: a
 * receiver that's down misses the push, but the draft stays in the review
 * inbox (`GET /proposals?status=open`) until a person rules on it. Results
 * name each receiver by its redacted URL (they reach the drafting agent).
 */
export async function raiseForNotarization(
  sinks: ObjectionSinkConfig[],
  proposal: ProposalEntry,
  notarizeUrl?: string
): Promise<Array<{ url: string; error?: string }>> {
  return Promise.all(
    sinks.map(async (sink) => {
      try {
        if (sink.kind === 'channel') {
          const base = sink.url.endsWith('/') ? sink.url : sink.url + '/';
          await post(
            new URL('event', base).href,
            JSON.stringify({
              channel: CHANNEL_NAME,
              sender: SENDER,
              content: formatProposalNotice(proposal),
              meta: proposalMeta(proposal, notarizeUrl),
            }),
            sink.secret ? { 'X-Channel-Secret': sink.secret } : {}
          );
        } else {
          const body = JSON.stringify({ type: 'stenographer.proposal', proposal, notarizeUrl: notarizeUrl ?? null });
          const id = webhookId('stenographer.proposal', [proposal.id]);
          const headers: Record<string, string> = {
            'X-Stenographer-Event': 'proposal',
            ...(sink.secret ? webhookHeaders(sink.secret, id, body) : { 'webhook-id': id }),
          };
          await post(sink.url, body, headers);
        }
        return { url: redactUrl(sink.url) };
      } catch (err) {
        return { url: redactUrl(sink.url), error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
}

/**
 * Why agents' verdicts on a UV went to a person: they disagree within the
 * window (`dispute`), or a quorum verified a contest, which would override
 * the TB (`contest-verified`).
 */
export interface UvRaise {
  reason: 'dispute' | 'contest-verified' | 'quorum-off';
  uv: UvEntry;
  /** One line saying what the agents did and what is left to a person. */
  detail: string;
  /** The contested TB, for a verified contest. */
  tbId?: string;
  /** The attestation that raised it: one raise, one webhook id. */
  cause: string;
}

/** One line a person can read: what the agents said about the UV, and the UV itself (escaped). */
export function formatUvNotice(raise: UvRaise): string {
  return (
    `⚖️ ${displayText(raise.detail, MAX_NOTICE_CLAIM)} — UV ${displayText(raise.uv.id)}: ` +
    displayText(raise.uv.body.assertion, MAX_NOTICE_CLAIM)
  );
}

/**
 * Raises a UV to a person through the receivers drafts use. Best effort, as
 * for drafts: the UV stays open in the verification queue until a person
 * rules on it (resolve_uv in the operator profile).
 */
export async function raiseUvForPerson(sinks: ObjectionSinkConfig[], raise: UvRaise): Promise<Array<{ url: string; error?: string }>> {
  const kind = { dispute: 'uv_dispute', 'contest-verified': 'uv_contest_verified', 'quorum-off': 'uv_agents_agree' }[raise.reason];
  return Promise.all(
    sinks.map(async (sink) => {
      try {
        if (sink.kind === 'channel') {
          const base = sink.url.endsWith('/') ? sink.url : sink.url + '/';
          await post(
            new URL('event', base).href,
            JSON.stringify({
              channel: CHANNEL_NAME,
              sender: SENDER,
              content: formatUvNotice(raise),
              meta: { kind, uv_id: raise.uv.id, ...(raise.tbId ? { tb_id: raise.tbId } : {}) },
            }),
            sink.secret ? { 'X-Channel-Secret': sink.secret } : {}
          );
        } else {
          const body = JSON.stringify({ type: 'stenographer.uv', reason: raise.reason, uv: raise.uv, detail: raise.detail, tbId: raise.tbId ?? null });
          const id = webhookId(`stenographer.uv.${raise.reason}`, [raise.uv.id, raise.cause]);
          const headers: Record<string, string> = {
            'X-Stenographer-Event': 'uv',
            ...(sink.secret ? webhookHeaders(sink.secret, id, body) : { 'webhook-id': id }),
          };
          await post(sink.url, body, headers);
        }
        return { url: redactUrl(sink.url) };
      } catch (err) {
        return { url: redactUrl(sink.url), error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
}

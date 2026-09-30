/**
 * Stenographer — Notarization of agent-drafted tombstones (§15)
 *
 * Agents may draft tombstones (`propose_tombstone`) but never sign them.
 * A draft is raised to the person running stenographer through the same
 * receivers objections use — smallchat's channel bridge and operator
 * webhooks, never the attached MCP client, which is the drafting agent —
 * and only mints once that person notarizes it.
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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { CHANNEL_NAME, SENDER, post, type ObjectionSinkConfig } from './delivery.js';
import type { ProposalEntry, TombstonedLiteral } from './types.js';

/** Header the notary secret travels in on REST notary routes. */
export const NOTARY_SECRET_HEADER = 'x-notary-secret';

/** Constant-time comparison; a missing secret on either side never matches. */
export function notarySecretMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One line a person can read in a chat or a terminal. */
export function formatProposalNotice(p: ProposalEntry): string {
  const draft = p.body.draft as { claim?: string; literals?: TombstonedLiteral[] };
  const literals = (draft.literals ?? [])
    .map((l) => `${l.subject ? `${l.subject} = ` : ''}${l.dead}${l.current ? ` → ${l.current}` : ''}`)
    .join(', ');
  return (
    `✍️ ${p.author} drafted a tombstone for your approval (${p.id}): ${draft.claim ?? ''}` +
    (literals ? ` — would object to ${literals}` : '') +
    (p.body.signal.detail ? `\nWhy: ${p.body.signal.detail}` : '')
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
 * inbox (`GET /proposals?status=open`) until a person rules on it.
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
          const headers: Record<string, string> = { 'X-Stenographer-Event': 'proposal' };
          if (sink.secret) {
            headers['X-Stenographer-Signature'] = 'sha256=' + createHmac('sha256', sink.secret).update(body).digest('hex');
          }
          await post(sink.url, body, headers);
        }
        return { url: sink.url };
      } catch (err) {
        return { url: sink.url, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
}

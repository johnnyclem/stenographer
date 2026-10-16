/**
 * Stenographer — UV freshness, computed at read time
 *
 * A TB is an action: a fact someone settled, and it does not decay. A UV is
 * an observation: a belief stated before anyone verified it, and "there be
 * dragons" should not mean dragons forever. So an open UV has a horizon, in
 * seconds from the chain timestamp it was last attested at, past which a
 * reader renders it STALE. Stale is a rendering state, never a status: a
 * stale UV is still open, still a flag and never a block, still promotable,
 * and nothing in the ledger changes when it goes stale. The hash chain is
 * untouched.
 *
 * Freshness is a pure function of the lines and the clock:
 *
 *   anchor  = the newest of the UV's own `ts` and the `ts` of every line
 *             that re-attests it: a line with a `corroborates` link into it
 *             (a nomination) or a `derives` link into it (a derived entry,
 *             whose signer attested the premise was in good standing when
 *             it was signed), from an entry that isn't struck
 *   horizon = min(the line's own `horizon`, the reader's default)
 *   stale   = now - anchor > horizon
 *
 * The default horizon is the team's sprint length, 21 days (decision D7);
 * a writer may set a UV's `horizon` shorter than the default, never longer,
 * and a reader clamps a longer one from another team's stream. Every time
 * claim this module makes carries its derivation: the chain timestamp it
 * was measured from and the clock reading it used. No reader infers
 * elapsed time from anything else.
 */

/** The default UV horizon: the team's sprint length, 21 days (D7). */
export const DEFAULT_UV_HORIZON_SECONDS = 21 * 24 * 60 * 60;

/** The largest horizon the format admits: ten years, so a value is a duration and not a typo for a timestamp. */
export const MAX_UV_HORIZON_SECONDS = 10 * 365 * 24 * 60 * 60;

export type FreshnessState = 'fresh' | 'stale';

/** A line that re-attests a UV: its id and chain timestamp. */
export interface Reattestation {
  id: string;
  ts: string;
}

/** The link types whose target is re-attested by the line that carries them. */
export const REATTESTING_LINKS: readonly string[] = ['corroborates', 'derives'];

export interface Freshness {
  state: FreshnessState;
  /** The horizon that applied, in seconds: the line's own when it is shorter, else the reader's default. */
  horizonSeconds: number;
  /** The chain timestamp the clock was measured from: the UV's own `ts`, or the newest re-attestation's. */
  since: string;
  /** What set `since`: the UV's own line, or the line that re-attested it last. */
  anchor: { kind: 'asserted' } | { kind: 'reattested'; by: string };
  /** The clock reading freshness was computed at. */
  at: string;
  /** `since` plus the horizon: when the UV goes (or went) stale by this clock. */
  expiresAt: string;
  /** `at` minus `since`, in whole seconds: the elapsed time, stated so no reader has to infer it. */
  elapsedSeconds: number;
}

/** A positive whole number of seconds no larger than the cap, else null. */
export function horizonSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_UV_HORIZON_SECONDS ? value : null;
}

/**
 * The horizon a reader applies to a UV: the line's own `horizon` when it
 * is valid and shorter than the reader's default, else the default. A
 * writer may shorten the horizon, never lengthen it; a longer one from
 * another team's stream is clamped here rather than refused.
 */
export function effectiveHorizon(lineHorizon: unknown, defaultSeconds: number = DEFAULT_UV_HORIZON_SECONDS): number {
  const own = horizonSeconds(lineHorizon);
  return own !== null && own < defaultSeconds ? own : defaultSeconds;
}

/** Epoch ms of a chain timestamp; NaN when it names no time. */
function epoch(ts: string): number {
  return Date.parse(ts);
}

/**
 * The freshness of a UV as of `now` (epoch ms): from its own chain
 * timestamp, the lines that re-attest it, and its horizon. Pure: reads
 * nothing, writes nothing. A UV whose anchor names no readable time is
 * stale, failing closed. Monotone: for fixed inputs, later clocks never
 * make a stale UV fresh.
 */
export function freshness(
  uv: { ts: string; horizon?: unknown },
  reattestations: readonly Reattestation[],
  now: number,
  defaultSeconds: number = DEFAULT_UV_HORIZON_SECONDS
): Freshness {
  const horizon = effectiveHorizon(uv.horizon, defaultSeconds);
  let since = uv.ts;
  let sinceMs = epoch(uv.ts);
  let anchor: Freshness['anchor'] = { kind: 'asserted' };
  for (const r of reattestations) {
    const ms = epoch(r.ts);
    if (Number.isFinite(ms) && (!Number.isFinite(sinceMs) || ms > sinceMs)) {
      since = r.ts;
      sinceMs = ms;
      anchor = { kind: 'reattested', by: r.id };
    }
  }
  const at = new Date(now).toISOString();
  if (!Number.isFinite(sinceMs)) {
    return { state: 'stale', horizonSeconds: horizon, since, anchor, at, expiresAt: since, elapsedSeconds: Number.POSITIVE_INFINITY };
  }
  const elapsedSeconds = Math.floor((now - sinceMs) / 1000);
  return {
    state: elapsedSeconds > horizon ? 'stale' : 'fresh',
    horizonSeconds: horizon,
    since,
    anchor,
    at,
    expiresAt: new Date(sinceMs + horizon * 1000).toISOString(),
    elapsedSeconds,
  };
}

/**
 * The lines of a stream that re-attest `uvId`: each TB, UV or ADDENDUM line
 * whose `x-steno.links` carry a `corroborates` or `derives` link into it.
 * A stream reader passes the lines it folded; one that folds strikes should
 * leave struck lines out first. Chain order is kept.
 */
export function reattestationsOf(uvId: string, lines: Iterable<Record<string, unknown>>): Reattestation[] {
  const out: Reattestation[] = [];
  for (const line of lines) {
    if (typeof line.id !== 'string' || typeof line.ts !== 'string' || line.id === uvId) continue;
    const steno = line['x-steno'];
    const links = steno && typeof steno === 'object' ? (steno as { links?: unknown }).links : undefined;
    if (!Array.isArray(links)) continue;
    if (links.some((l) => l && typeof l === 'object' && (l as { toId?: unknown }).toId === uvId && REATTESTING_LINKS.includes(String((l as { type?: unknown }).type)))) {
      out.push({ id: line.id, ts: line.ts });
    }
  }
  return out;
}

/** The freshness of each open UV line in a stream, by id, as of `now`. */
export function streamFreshness(
  lines: ReadonlyArray<Record<string, unknown>>,
  now: number,
  defaultSeconds: number = DEFAULT_UV_HORIZON_SECONDS
): Map<string, Freshness> {
  const out = new Map<string, Freshness>();
  for (const line of lines) {
    if (line.type !== 'UV' || typeof line.id !== 'string' || typeof line.ts !== 'string') continue;
    out.set(line.id, freshness({ ts: line.ts, horizon: line.horizon }, reattestationsOf(line.id, lines), now, defaultSeconds));
  }
  return out;
}

/**
 * Stenographer — Objection Delivery (§12, transport per §14.8: webhooks)
 *
 * Objections are pushed the moment they're raised to receivers that can
 * interrupt their agent, and batched for those that can't:
 *
 * - **Interrupt-capable** (default for channels): every objection is
 *   delivered as soon as it's discovered. This covers smallchat's channel
 *   HTTP bridge and Claude Code's built-in channel notifications
 *   (`notifications/claude/channel`) — the agent-to-agent messaging path.
 * - **Non-interrupting** (default for plain webhooks): objections queue
 *   until a batch of `batchSize` (default 3) is reached, then deliver
 *   together — a harness that can't be interrupted shouldn't be pinged
 *   for every single one.
 *
 * Delivery state is durable (SQLite, beside the objection log): a partial
 * batch survives a restart, and a partial batch that has waited
 * `maxBatchDelayMs` (default 5 min) is sent as it is. Retries are per
 * objection: a transient failure (network, 5xx, 408, 429) backs off
 * exponentially from `retryBaseMs` (default 15 s); a permanent refusal (any
 * other 4xx, a redirect) or `maxAttempts` (default 8) failures dead-letters
 * that objection for that receiver, so one the receiver will never take
 * can't hold back the ones behind it. A batch refused as a whole is retried
 * one objection at a time. Only objections still pending are delivered —
 * one the judge already ruled on is no longer news.
 *
 * Passivity holds: this module emits objections to receivers the operator
 * configured. It never writes into a conversation itself, and webhook
 * URLs must be loopback unless the operator explicitly allows otherwise
 * (objections carry transcript lines). Redirects are never followed, so a
 * receiver can't forward the body and its secret somewhere else, and logs
 * and tool results name a receiver without the path or query of its URL,
 * where chat webhooks keep their tokens.
 *
 * Webhooks are signed per Standard Webhooks (standardwebhooks.com):
 * `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature:
 * v1,<base64 HMAC-SHA256 over "<id>.<timestamp>.<body>">`, so a receiver can
 * reject replays. A `whsec_<base64>` secret signs with its decoded bytes,
 * any other secret with its UTF-8 bytes.
 */

import { createHash, createHmac } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Objection, ObjectionLog } from './objections.js';
import { displayText } from './display.js';

export const DEFAULT_OBJECTION_BATCH_SIZE = 3;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_RETRY_BASE_MS = 15_000;
export const DEFAULT_MAX_BATCH_DELAY_MS = 5 * 60_000;
/** Standard Webhooks recommends 24–64 byte secrets. */
export const MIN_WEBHOOK_SECRET_BYTES = 24;
const RETRY_INTERVAL_MS = 15_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const DELIVERY_TIMEOUT_MS = 5_000;
/** Longest line of an objection notice; the full record is one MCP call away. */
const MAX_NOTICE_LINE = 2_000;
export const CHANNEL_NAME = 'stenographer';
export const SENDER = 'stenographer';

/** An operator-configured webhook receiver. */
export interface ObjectionSinkConfig {
  /**
   * - 'channel': a smallchat channel HTTP bridge (`POST <url>/event`), which
   *   relays into the agent's session as a Claude Code channel event.
   * - 'webhook': a generic JSON webhook.
   */
  kind: 'channel' | 'webhook';
  url: string;
  /**
   * channel: sent as X-Channel-Secret. webhook: the Standard Webhooks signing
   * key (`whsec_<base64>`, or any string of at least 24 bytes).
   */
  secret?: string;
  /** Whether the receiver can interrupt its agent. Default: true for channel, false for webhook. */
  interrupts?: boolean;
  /** Batch size for non-interrupting receivers. Default 3. */
  batchSize?: number;
  /** Non-interrupting receivers: send a partial batch once its oldest objection has waited this long. Default 5 min. */
  maxBatchDelayMs?: number;
  /** Failed attempts per objection before it is dead-lettered for this receiver. Default 8. */
  maxAttempts?: number;
  /** Delay before the first retry after a transient failure; doubles per attempt, at most an hour. Default 15 s. */
  retryBaseMs?: number;
  /** Allow a non-loopback URL. Objections carry transcript lines — opt in deliberately. */
  allowRemote?: boolean;
}

/** A resolved delivery target: where objections go and how. */
export interface ObjectionTransport {
  id: string;
  /** How logs name it: the id without the secret parts of a URL. Default: `id`. */
  label?: string;
  interrupts: boolean;
  batchSize: number;
  maxBatchDelayMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  /**
   * Ephemeral transports (e.g. the MCP channel of the currently attached
   * session) only receive objections raised after they register; durable
   * ones pick up where they left off across restarts.
   */
  ephemeral?: boolean;
  /** Limits which objections this transport receives (e.g. one session's). */
  accepts?: (objection: Objection) => boolean;
  send: (batch: Objection[]) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Message formatting — shared by every channel-style receiver
// ─────────────────────────────────────────────────────────────

/**
 * Human-readable objection for an agent's session: the objection, the
 * exhibit, the transcript line, and how to rule. Kept compact — channel
 * bridges cap payload size, and the full record is one MCP call away.
 */
export function formatObjection(o: Objection): string {
  const tb = o.exhibit.tombstone;
  const lines = [
    `Objection ${o.id}: ${o.objection}`,
    `Transcript (${o.source}): ${o.transcriptLine}`,
    `Exhibit ${tb.id} (signed by ${tb.body.signedBy ?? 'migration'}): ${tb.body.claim}`,
  ];
  if (o.exhibit.contestedBy.length > 0) {
    lines.push(`Contested by: ${o.exhibit.contestedBy.map((uv) => `${uv.id} — ${uv.body.assertion}`).join('; ')}`);
  }
  lines.push(
    `If the objection is right, correct course. Rule with rule_on_objection(objectionId: "${o.id}", outcome: "sustained" | "overruled", opinion, author).`
  );
  // Agent text can't add, hide or rewrite lines, and stays under bridge caps
  return lines.map((line) => displayText(line, MAX_NOTICE_LINE)).join('\n');
}

export function formatObjectionBatch(batch: Objection[]): string {
  if (batch.length === 1) return formatObjection(batch[0]);
  return [`${batch.length} objections from stenographer:`, ...batch.map(formatObjection)].join('\n\n');
}

/** Channel meta keys must be identifier-only; values strings. */
export function objectionMeta(batch: Objection[]): Record<string, string> {
  return {
    kind: 'objection',
    objection_ids: batch.map((o) => o.id).join(','),
    tb_ids: [...new Set(batch.map((o) => o.tbId))].join(','),
    session_ids: [...new Set(batch.map((o) => o.sessionId))].join(','),
    count: String(batch.length),
  };
}

// ─────────────────────────────────────────────────────────────
// Transports
// ─────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function sinkId(config: ObjectionSinkConfig): string {
  return `${config.kind}:${config.url}`;
}

/**
 * A URL as logs and tool results show it: scheme, host and port. Chat
 * webhooks carry their token in the path or query, so those are elided.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '<invalid URL>';
  }
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : `${parsed.origin}/…`;
}

/** A sink id (`<kind>:<url>`) as logs show it. */
function redactSinkId(id: string): string {
  const colon = id.indexOf(':');
  return colon > 0 && /^https?:/.test(id.slice(colon + 1)) ? `${id.slice(0, colon)}:${redactUrl(id.slice(colon + 1))}` : id;
}

/** A failed POST. Permanent ones (a redirect, 4xx other than 408/429) aren't retried. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

function isPermanentStatus(status: number): boolean {
  if (status >= 300 && status < 400) return true;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** POSTs JSON to a receiver. Never follows a redirect; errors name the URL redacted. */
export async function post(url: string, body: string, headers: Record<string, string>): Promise<void> {
  const where = redactUrl(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: unknown } })?.cause?.message;
    if (cause === 'unexpected redirect') {
      throw new DeliveryError(`${where} answered with a redirect, which is never followed`, true);
    }
    const reason =
      (err as { name?: string })?.name === 'TimeoutError'
        ? 'timed out'
        : `unreachable (${typeof cause === 'string' ? cause : err instanceof Error ? err.message : String(err)})`;
    throw new DeliveryError(`${where} ${reason}`, false);
  }
  if (!res.ok) {
    throw new DeliveryError(`${where} responded ${res.status}`, isPermanentStatus(res.status), res.status);
  }
}

function webhookKey(secret: string): Buffer {
  return secret.startsWith('whsec_') ? Buffer.from(secret.slice('whsec_'.length), 'base64') : Buffer.from(secret, 'utf8');
}

/** Throws unless `secret` is long enough to sign with. */
export function assertWebhookSecret(secret: string): void {
  if (webhookKey(secret).length < MIN_WEBHOOK_SECRET_BYTES) {
    throw new Error(
      `webhook secret must be at least ${MIN_WEBHOOK_SECRET_BYTES} bytes (a whsec_ secret: once base64-decoded)`
    );
  }
}

/**
 * A stable Standard Webhooks message id for an event about `ids`: retries
 * of the same delivery reuse it, so receivers can deduplicate.
 */
export function webhookId(event: string, ids: string[]): string {
  return 'msg_' + createHash('sha256').update(`${event}:${ids.join(',')}`).digest('hex').slice(0, 32);
}

/** Standard Webhooks headers: the signature covers id, timestamp and body. */
export function webhookHeaders(
  secret: string,
  id: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): Record<string, string> {
  const signature = createHmac('sha256', webhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
}

/** Builds the transport for an operator-configured webhook sink. Throws on unsafe config. */
export function createSinkTransport(config: ObjectionSinkConfig): ObjectionTransport {
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new Error(`invalid objection ${config.kind} URL`);
  }
  const shown = redactUrl(config.url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`objection ${config.kind} URL must be http(s): ${shown}`);
  }
  if (!config.allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `objection ${config.kind} URL ${shown} is not loopback — objections carry transcript lines; set allowRemote to opt in`
    );
  }
  const batchSize = config.batchSize ?? DEFAULT_OBJECTION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`objection batch size must be a positive integer, got ${config.batchSize}`);
  }
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`objection maxAttempts must be a positive integer, got ${config.maxAttempts}`);
  }
  if (config.kind === 'webhook' && config.secret !== undefined) assertWebhookSecret(config.secret);
  const policy = {
    id: sinkId(config),
    label: `${config.kind}:${shown}`,
    batchSize,
    maxAttempts,
    retryBaseMs: config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    maxBatchDelayMs: config.maxBatchDelayMs ?? DEFAULT_MAX_BATCH_DELAY_MS,
  };

  if (config.kind === 'channel') {
    // smallchat channel bridge: POST /event {channel, content, meta, sender}
    const eventUrl = new URL('event', parsed.href.endsWith('/') ? parsed.href : parsed.href + '/').href;
    return {
      ...policy,
      interrupts: config.interrupts ?? true,
      send: (batch) =>
        post(
          eventUrl,
          JSON.stringify({
            channel: CHANNEL_NAME,
            sender: SENDER,
            content: formatObjectionBatch(batch),
            meta: objectionMeta(batch),
          }),
          config.secret ? { 'X-Channel-Secret': config.secret } : {}
        ),
    };
  }

  return {
    ...policy,
    interrupts: config.interrupts ?? false,
    send: (batch) => {
      const body = JSON.stringify({ type: 'stenographer.objections', objections: batch });
      const id = webhookId('stenographer.objections', batch.map((o) => o.id));
      const headers: Record<string, string> = {
        'X-Stenographer-Event': 'objections',
        ...(config.secret ? webhookHeaders(config.secret, id, body) : { 'webhook-id': id }),
      };
      return post(config.url, body, headers);
    },
  };
}

/**
 * Claude Code's built-in channel: the attached MCP client receives each
 * objection as a `notifications/claude/channel` event. `notify` is the MCP
 * server's notification sender.
 */
export function createMcpChannelTransport(
  notify: (params: { content: string; meta: Record<string, string> }) => Promise<void>,
  accepts?: (objection: Objection) => boolean
): ObjectionTransport {
  return {
    id: 'mcp-channel',
    interrupts: true,
    batchSize: 1,
    ephemeral: true,
    accepts,
    send: (batch) => notify({ content: formatObjectionBatch(batch), meta: objectionMeta(batch) }),
  };
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────

/** An objection a receiver will not get: refused for good, or out of attempts. */
export interface DeadLetter {
  objectionId: string;
  /** The receiver, as logs name it. */
  sink: string;
  attempts: number;
  error: string | null;
  deadAt: string;
}

interface DueObjection {
  objection: Objection;
  /** Retried alone: it was in a batch the receiver refused as a whole. */
  solo: boolean;
}

export class ObjectionDispatcher {
  private db: Database.Database;
  private log: ObjectionLog;
  private transports = new Map<string, ObjectionTransport>();
  private pumping = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(db: Database.Database, log: ObjectionLog) {
    this.db = db;
    this.log = log;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objection_sinks (
        id TEXT PRIMARY KEY,
        registered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS objection_deliveries (
        objection_id TEXT NOT NULL,
        sink_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY (objection_id, sink_id)
      );
      CREATE TABLE IF NOT EXISTS objection_delivery_attempts (
        objection_id TEXT NOT NULL,
        sink_id TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        solo INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        dead_at TEXT,
        PRIMARY KEY (objection_id, sink_id)
      );
    `);
  }

  get size(): number {
    return this.transports.size;
  }

  register(transport: ObjectionTransport): void {
    const now = new Date().toISOString();
    if (transport.ephemeral) {
      this.db
        .prepare('INSERT OR REPLACE INTO objection_sinks (id, registered_at) VALUES (?, ?)')
        .run(transport.id, now);
    } else {
      this.db
        .prepare('INSERT OR IGNORE INTO objection_sinks (id, registered_at) VALUES (?, ?)')
        .run(transport.id, now);
    }
    this.transports.set(transport.id, transport);

    if (!this.timer) {
      this.timer = setInterval(() => void this.pump(), RETRY_INTERVAL_MS);
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Delivers whatever is due on every transport. Safe to call often. */
  async pump(): Promise<void> {
    await Promise.all([...this.transports.values()].map((t) => this.pumpOne(t)));
  }

  /** Makes every backed-off delivery due now (say, once a receiver is fixed). Dead letters stay dead. */
  retryNow(): void {
    this.db.prepare('UPDATE objection_delivery_attempts SET next_attempt_at = 0 WHERE dead_at IS NULL').run();
  }

  /** Objections a receiver will not get, oldest first. */
  deadLetters(): DeadLetter[] {
    const rows = this.db
      .prepare(`
        SELECT objection_id, sink_id, attempts, last_error, dead_at FROM objection_delivery_attempts
        WHERE dead_at IS NOT NULL ORDER BY dead_at ASC, objection_id ASC
      `)
      .all() as Array<{ objection_id: string; sink_id: string; attempts: number; last_error: string | null; dead_at: string }>;
    return rows.map((r) => ({
      objectionId: r.objection_id,
      sink: this.labelOf(r.sink_id),
      attempts: r.attempts,
      error: r.last_error,
      deadAt: r.dead_at,
    }));
  }

  deadLetterCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM objection_delivery_attempts WHERE dead_at IS NOT NULL')
      .get() as { c: number };
    return row.c;
  }

  private labelOf(sinkId: string): string {
    return this.transports.get(sinkId)?.label ?? redactSinkId(sinkId);
  }

  private pumpOne(transport: ObjectionTransport): Promise<void> {
    const running = this.pumping.get(transport.id);
    if (running) {
      // Something arrived mid-delivery: go around again when this one ends
      this.rerun.add(transport.id);
      return running;
    }
    const run = this.deliver(transport)
      .catch((err) => {
        console.error(
          `Objection delivery to ${transport.label ?? transport.id} failed:`,
          err instanceof Error ? err.message : err
        );
      })
      .finally(() => {
        this.pumping.delete(transport.id);
        if (this.rerun.delete(transport.id) && !this.stopped) void this.pumpOne(transport);
      });
    this.pumping.set(transport.id, run);
    return run;
  }

  /**
   * Interrupt-capable: each objection as discovered. Otherwise: full
   * batches, and a partial batch once it has waited `maxBatchDelayMs`. A
   * failure is recorded against the objections it carried and delivery
   * moves on, so nothing waits behind an objection the receiver refuses.
   */
  private async deliver(transport: ObjectionTransport): Promise<void> {
    if (this.stopped) return;
    const due = this.pending(transport);
    const size = transport.interrupts ? 1 : transport.batchSize;

    const batches: Objection[][] = [];
    const grouped: Objection[] = [];
    for (const { objection, solo } of due) {
      if (solo || size === 1) batches.push([objection]);
      else grouped.push(objection);
    }
    let i = 0;
    for (; i + size <= grouped.length; i += size) batches.push(grouped.slice(i, i + size));
    const partial = grouped.slice(i);
    const maxDelay = transport.maxBatchDelayMs ?? DEFAULT_MAX_BATCH_DELAY_MS;
    if (partial.length > 0 && Date.now() - Date.parse(partial[0].createdAt) >= maxDelay) {
      batches.push(partial);
    }

    for (const batch of batches) {
      if (this.stopped) return;
      try {
        await transport.send(batch);
      } catch (err) {
        this.recordFailure(transport, batch, err);
        continue;
      }
      this.markDelivered(transport.id, batch);
    }
  }

  private pending(transport: ObjectionTransport): DueObjection[] {
    const sink = this.db
      .prepare('SELECT registered_at FROM objection_sinks WHERE id = ?')
      .get(transport.id) as { registered_at: string } | undefined;
    if (!sink) return [];

    const rows = this.db
      .prepare(`
        SELECT o.id, a.solo FROM objections o
        LEFT JOIN objection_delivery_attempts a ON a.objection_id = o.id AND a.sink_id = ?
        WHERE o.delivered = 1 AND o.status = 'pending' AND o.created_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM objection_deliveries d WHERE d.objection_id = o.id AND d.sink_id = ?
          )
          AND (a.objection_id IS NULL OR (a.dead_at IS NULL AND a.next_attempt_at <= ?))
        ORDER BY o.id ASC
        LIMIT 500
      `)
      .all(transport.id, sink.registered_at, transport.id, Date.now()) as Array<{ id: string; solo: number | null }>;

    const due: DueObjection[] = [];
    for (const row of rows) {
      const objection = this.log.get(row.id);
      if (objection && (!transport.accepts || transport.accepts(objection))) {
        due.push({ objection, solo: row.solo === 1 });
      }
    }
    return due;
  }

  /**
   * One failed send: a transient failure backs off, a permanent one (or the
   * last attempt) dead-letters. A batch refused as a whole is split, so the
   * objection the receiver refuses is found and the rest still go through.
   */
  private recordFailure(transport: ObjectionTransport, batch: Objection[], err: unknown): void {
    if (this.stopped) return;
    const label = transport.label ?? transport.id;
    const error = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof DeliveryError && err.permanent;
    const maxAttempts = transport.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseMs = transport.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const now = Date.now();

    const previous = this.db.prepare(
      'SELECT attempts FROM objection_delivery_attempts WHERE objection_id = ? AND sink_id = ?'
    );
    const upsert = this.db.prepare(`
      INSERT INTO objection_delivery_attempts
        (objection_id, sink_id, attempts, next_attempt_at, solo, last_error, dead_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (objection_id, sink_id) DO UPDATE SET
        attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
        solo = MAX(solo, excluded.solo), last_error = excluded.last_error, dead_at = excluded.dead_at
    `);
    const split = permanent && batch.length > 1;
    const notes: string[] = [];

    this.db.transaction(() => {
      for (const o of batch) {
        const attempts = ((previous.get(o.id, transport.id) as { attempts: number } | undefined)?.attempts ?? 0) + 1;
        const dead = attempts >= maxAttempts || (permanent && !split);
        const delay = split ? 0 : Math.min(baseMs * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
        upsert.run(o.id, transport.id, attempts, now + delay, split ? 1 : 0, error, dead ? new Date(now).toISOString() : null);
        if (dead) notes.push(`gave up on objection ${o.id} after ${attempts} attempt${attempts === 1 ? '' : 's'}`);
        else if (!split) notes.push(`will retry objection ${o.id} in ${Math.round(delay / 1000)}s`);
      }
    })();

    if (split) notes.unshift(`refused a batch of ${batch.length}; retrying them one at a time`);
    console.error(`Objection delivery to ${label} failed (${error}): ${notes.join('; ')}`);
  }

  private markDelivered(sinkId: string, batch: Objection[]): void {
    if (this.stopped) return;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO objection_deliveries (objection_id, sink_id, delivered_at) VALUES (?, ?, ?)'
    );
    const clear = this.db.prepare('DELETE FROM objection_delivery_attempts WHERE objection_id = ? AND sink_id = ?');
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const o of batch) {
        insert.run(o.id, sinkId, now);
        clear.run(o.id, sinkId);
      }
    })();
  }
}

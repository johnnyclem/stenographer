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
 * batch survives a restart, and a failed delivery is retried on the next
 * objection or retry tick. Only objections still pending are delivered —
 * one the judge already ruled on is no longer news.
 *
 * Passivity holds: this module emits objections to receivers the operator
 * configured. It never writes into a conversation itself, and webhook
 * URLs must be loopback unless the operator explicitly allows otherwise
 * (objections carry transcript lines).
 */

import { createHmac } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Objection, ObjectionLog } from './objections.js';

export const DEFAULT_OBJECTION_BATCH_SIZE = 3;
const RETRY_INTERVAL_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 5_000;
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
  /** channel: sent as X-Channel-Secret. webhook: HMAC-SHA256 key for X-Stenographer-Signature. */
  secret?: string;
  /** Whether the receiver can interrupt its agent. Default: true for channel, false for webhook. */
  interrupts?: boolean;
  /** Batch size for non-interrupting receivers. Default 3. */
  batchSize?: number;
  /** Allow a non-loopback URL. Objections carry transcript lines — opt in deliberately. */
  allowRemote?: boolean;
}

/** A resolved delivery target: where objections go and how. */
export interface ObjectionTransport {
  id: string;
  interrupts: boolean;
  batchSize: number;
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
  return lines.join('\n');
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

export async function post(url: string, body: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
}

/** Builds the transport for an operator-configured webhook sink. Throws on unsafe config. */
export function createSinkTransport(config: ObjectionSinkConfig): ObjectionTransport {
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new Error(`invalid objection ${config.kind} URL: ${config.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`objection ${config.kind} URL must be http(s): ${config.url}`);
  }
  if (!config.allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `objection ${config.kind} URL ${config.url} is not loopback — objections carry transcript lines; set allowRemote to opt in`
    );
  }
  const batchSize = config.batchSize ?? DEFAULT_OBJECTION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`objection batch size must be a positive integer, got ${config.batchSize}`);
  }

  if (config.kind === 'channel') {
    // smallchat channel bridge: POST /event {channel, content, meta, sender}
    const eventUrl = new URL('event', parsed.href.endsWith('/') ? parsed.href : parsed.href + '/').href;
    return {
      id: sinkId(config),
      interrupts: config.interrupts ?? true,
      batchSize,
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
    id: sinkId(config),
    interrupts: config.interrupts ?? false,
    batchSize,
    send: (batch) => {
      const body = JSON.stringify({ type: 'stenographer.objections', objections: batch });
      const headers: Record<string, string> = { 'X-Stenographer-Event': 'objections' };
      if (config.secret) {
        headers['X-Stenographer-Signature'] =
          'sha256=' + createHmac('sha256', config.secret).update(body).digest('hex');
      }
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

  private pumpOne(transport: ObjectionTransport): Promise<void> {
    const running = this.pumping.get(transport.id);
    if (running) {
      // Something arrived mid-delivery: go around again when this one ends
      this.rerun.add(transport.id);
      return running;
    }
    const run = this.deliver(transport)
      .catch((err) => {
        console.error(`Objection delivery to ${transport.id} failed (will retry):`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.pumping.delete(transport.id);
        if (this.rerun.delete(transport.id) && !this.stopped) void this.pumpOne(transport);
      });
    this.pumping.set(transport.id, run);
    return run;
  }

  private async deliver(transport: ObjectionTransport): Promise<void> {
    if (this.stopped) return;
    const pending = this.pending(transport);
    const size = transport.interrupts ? 1 : transport.batchSize;

    // Interrupt-capable: each as discovered. Otherwise: full batches only;
    // a partial batch waits (durably) for the next objection.
    for (let i = 0; i + size <= pending.length; i += size) {
      if (this.stopped) return;
      const batch = pending.slice(i, i + size);
      await transport.send(batch);
      this.markDelivered(transport.id, batch);
    }
  }

  private pending(transport: ObjectionTransport): Objection[] {
    const sink = this.db
      .prepare('SELECT registered_at FROM objection_sinks WHERE id = ?')
      .get(transport.id) as { registered_at: string } | undefined;
    if (!sink) return [];

    const rows = this.db
      .prepare(`
        SELECT id FROM objections o
        WHERE o.delivered = 1 AND o.status = 'pending' AND o.created_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM objection_deliveries d WHERE d.objection_id = o.id AND d.sink_id = ?
          )
        ORDER BY o.id ASC
      `)
      .all(sink.registered_at, transport.id) as Array<{ id: string }>;

    return rows
      .map((r) => this.log.get(r.id))
      .filter((o): o is Objection => o !== null && (!transport.accepts || transport.accepts(o)));
  }

  private markDelivered(sinkId: string, batch: Objection[]): void {
    if (this.stopped) return;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO objection_deliveries (objection_id, sink_id, delivered_at) VALUES (?, ?, ?)'
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const o of batch) insert.run(o.id, sinkId, now);
    })();
  }
}

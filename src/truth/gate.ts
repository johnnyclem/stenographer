/**
 * Stenographer — the pre-dispatch gate (§12, before the call runs)
 *
 *   stenographer gate [--state <path> | --wiki <file>] [--mode shadow|enforce]
 *                     [--timeout-ms <n>] [--on-error allow|deny]
 *                     [--tools <list>] [--log <file>]
 *
 * A Claude Code PreToolUse hook. It reads the hook's JSON from stdin
 * ({session_id, tool_name, tool_input, ...}), takes only what the call
 * asserts (asserting.ts: Write content, the new side of Edit / MultiEdit /
 * NotebookEdit, the writing parts of a Bash command — never Read, Grep or
 * Glob inputs, never old_string), and runs the same literal matcher as the
 * live objection engine over it, against the literals of active and
 * contested TBs.
 *
 *   - enforce: a hit denies the call. The deny reason cites the TB (id,
 *     claim, dead → current, signer) and the objection filed for it, so a
 *     person can rule. An overruled objection for this TB and this exact
 *     call (the canonical call digest of the tool and its input) lets the
 *     same call through on retry; a sustained one keeps denying it.
 *   - shadow (default): a hit is recorded as a shadow objection (or, when
 *     nothing can be written, reported on stderr and in --log) and the call
 *     proceeds, so the sustain rate can be measured before enforcing.
 *
 * Allowing prints nothing: the call goes on through the harness's normal
 * permission flow (the gate never grants a permission, it only denies).
 *
 * TBs come from the state file, opened read-only (the ledger is never
 * migrated or written from here; objections are written on a separate
 * connection, only on a hit), or from a wiki JSONL file (--wiki), folded
 * per truth format v2. With --wiki there is nowhere to file objections or
 * read rulings: hits are reported, and an enforce-mode denial can only be
 * lifted by overriding or striking the TB.
 *
 * Budget: everything after startup runs within --timeout-ms (default 2000),
 * which must stay below the harness's hook timeout (Claude Code: 60 s by
 * default). Past it, or on any error, --on-error decides: allow (default in
 * shadow) or deny (default in enforce).
 *
 * Not covered: paraphrases ("the old budget"), values split across lines,
 * tools whose input doesn't carry the content (a script that computes the
 * value, an MCP tool with an unknown schema), and anything past the first
 * 1,048,576 characters of a field.
 */

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { TruthLedger } from './ledger.js';
import { canonicalize, sha256Hex } from './jcs.js';
import { assertingFields } from './asserting.js';
import { MatchDeadlineError } from './literal-matcher.js';
import { compileTombstones, findGateRuling, ObjectionLog, type GateCall, type Objection } from './objections.js';
import { checkWikiChain, decodeWikiLine, type DecodedWikiLine } from './wiki.js';
import { MAX_WIKI_FILE_BYTES } from './wiki-file.js';
import { TombstonedLiteralSchema, type TbEntry, type TombstonedLiteral } from './types.js';
import { assertSchemaSupported } from '../store/migrations.js';

export type GateMode = 'shadow' | 'enforce';
export type GateOnError = 'allow' | 'deny';

/** Claude Code's documented default timeout for a command hook. */
export const CLAUDE_CODE_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_GATE_TIMEOUT_MS = 2_000;
/** The tools the gate reads unless --tools says otherwise. */
export const DEFAULT_GATE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'] as const;
const DEFAULT_STATE = './stenographer.db';

export interface GateOptions {
  mode: GateMode;
  /** The state file to read TBs from (and file objections in). Ignored with `wikiPath`. */
  statePath: string;
  /** Read TBs from this wiki JSONL file instead of the state file. */
  wikiPath?: string;
  timeoutMs: number;
  onError: GateOnError;
  /** Tool names the gate reads; `*` reads every tool. Others pass unread. */
  tools: readonly string[];
}

export interface GateHit {
  tb: TbEntry;
  literal: TombstonedLiteral;
  /** The input field that asserted it. */
  field: string;
  line: string;
  /** Open UVs contesting the TB. */
  contestedBy: string[];
  /** The objection on file for this call (state mode). */
  objection: Objection | null;
  /** A person's ruling on this TB for this exact call, if any. */
  ruling: Objection | null;
}

export interface GateResult {
  decision: 'allow' | 'deny';
  /** What to print on stdout: Claude Code hook JSON, or null to print nothing. */
  output: string | null;
  sessionId: string | null;
  toolName: string | null;
  /** Canonical call digest, once computed. */
  digest: string | null;
  hits: GateHit[];
  /** For stderr and the log. */
  notes: string[];
  error: string | null;
}

export class GateTimeoutError extends Error {}

// ─────────────────────────────────────────────────────────────
// Call identity
// ─────────────────────────────────────────────────────────────

/**
 * The canonical tool id of a harness tool name: `claude-code/<name>` for a
 * built-in, `<server>/<tool>` for an MCP tool (`mcp__<server>__<tool>`).
 */
export function harnessToolId(toolName: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return mcp ? `${mcp[1]}/${mcp[2]}` : `claude-code/${toolName}`;
}

/** A lone UTF-16 surrogate: no UTF-8 encoding, so no canonical bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The suite's canonical call digest (smallchat.call.v1, owned by smallchat's
 * spec/call-digest, whose vectors test/gate.test.ts runs):
 * sha256hex("smallchat.call.v1" 0x00 toolId 0x00 JCS(arguments)).
 * `toolId` is `<providerId>/<toolName>`, both non-empty, the provider
 * without `/`, with no U+0000 and no lone surrogate; `args` is a JSON
 * object with finite numbers. Anything else throws rather than digesting
 * a different value.
 */
export function callDigest(toolId: string, args: Record<string, unknown>): string {
  if (typeof toolId !== 'string' || !/^[^/]+\/[\s\S]+$/.test(toolId)) {
    throw new TypeError(`call digest: '${toolId}' is not a canonical tool id (<providerId>/<toolName>)`);
  }
  if (toolId.includes('\u0000') || LONE_SURROGATE.test(toolId)) {
    throw new TypeError('call digest: a tool id cannot contain U+0000 or a lone surrogate');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('call digest: arguments must be a JSON object');
  }
  return sha256Hex(`smallchat.call.v1\u0000${toolId}\u0000${canonicalize(args)}`);
}

// ─────────────────────────────────────────────────────────────
// Where TBs come from
// ─────────────────────────────────────────────────────────────

interface TombstoneSource {
  tombstones: TbEntry[];
  contestedBy(tbId: string): string[];
  /** The state file's read-only connection and ledger (state mode only). */
  state: { db: Database.Database; ledger: TruthLedger } | null;
  close(): void;
}

function openState(path: string, timeoutMs: number): TombstoneSource {
  if (!existsSync(path)) throw new Error(`no state file at ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: Math.max(0, timeoutMs) });
  try {
    assertSchemaSupported(db);
    const has = (table: string) =>
      Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
    if (!has('truth_entries')) {
      db.close();
      return { tombstones: [], contestedBy: () => [], state: null, close: () => {} };
    }
    if (!has('truth_meta') || !db.prepare(`SELECT 1 FROM truth_meta WHERE key = 'chain_version'`).get()) {
      throw new Error(`the ledger in ${path} predates 1.0 and needs its one-time migration: run 'stenographer verify ${path}' once`);
    }
    const ledger = new TruthLedger(db);
    const tombstones = ledger.getMatchableTombstones();
    let contested: Map<string, string[]> | null = null;
    return {
      tombstones,
      contestedBy: (tbId) => {
        contested ??= new Map(ledger.getContested().map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)]));
        return contested.get(tbId) ?? [];
      },
      state: { db, ledger },
      close: () => db.close(),
    };
  } catch (err) {
    if (db.open) db.close();
    throw err;
  }
}

const ACTIVE = new Set(['active', 'contested']);

/**
 * The TBs a wiki file holds as current truth, with matchable literals, per
 * truth format v2: a line's current status is that of the highest-seq
 * TRANSITION targeting it, else its own; only active and contested TBs
 * count, and only signed ones (an unsigned line is a proposal, not truth).
 * A file with an unreadable or edited line, or a broken chain, is refused
 * (thrown, so the gate's --on-error decides): a missing or edited
 * TRANSITION would otherwise bring an overridden TB back. A v1 TB carries
 * no hash, so it is unverifiable and left out, as import files it as a
 * proposal; so are unknown statuses and unmatchable literals (fail closed).
 * Line numbers count `lines` as given, blank ones included.
 */
export function wikiMatchableTombstones(
  lines: string[],
  checkDeadline: () => void = () => {}
): { tombstones: TbEntry[]; contestedBy: Map<string, string[]>; skipped: number } {
  let skipped = 0;
  const tbs: Array<{ line: Record<string, unknown> }> = [];
  const uvs: Array<{ id: string; contests: unknown; status: unknown }> = [];
  const latest = new Map<string, { seq: number; status: unknown }>();

  const read: Array<{ lineNo: number; decoded: DecodedWikiLine }> = [];
  lines.forEach((text, i) => {
    checkDeadline();
    if (!text.trim()) return;
    try {
      read.push({ lineNo: i + 1, decoded: decodeWikiLine(text) });
    } catch (err) {
      throw new Error(`wiki line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const [broken] = checkWikiChain(read.map((r) => r.decoded));
  if (broken) throw new Error(`wiki line ${read[broken.index].lineNo}: ${broken.error}`);

  for (const { decoded } of read) {
    checkDeadline();
    const line = decoded.line;
    if (decoded.type === 'TB' && decoded.version !== 2) skipped++;
    else if (decoded.type === 'TB') tbs.push({ line });
    else if (decoded.type === 'UV') uvs.push({ id: String(line.id), contests: line.contests, status: line.status });
    else if (decoded.type === 'TRANSITION' && decoded.seq !== null) {
      const target = String(line.target);
      const prior = latest.get(target);
      if (!prior || decoded.seq > prior.seq) latest.set(target, { seq: decoded.seq, status: line.status });
    }
  }
  const statusOf = (id: string, own: unknown) => (latest.has(id) ? latest.get(id)!.status : own);

  const tombstones: TbEntry[] = [];
  for (const { line } of tbs) {
    const id = String(line.id);
    const status = statusOf(id, line.status);
    if (typeof status !== 'string' || !ACTIVE.has(status)) continue;
    if (typeof line.signedBy !== 'string' || !line.signedBy) continue;
    const literals = (Array.isArray(line.literals) ? line.literals : []).flatMap((l) => {
      const parsed = TombstonedLiteralSchema.safeParse(l);
      return parsed.success ? [parsed.data] : [];
    });
    if (literals.length === 0) continue;
    tombstones.push({
      id,
      type: 'TB',
      createdAt: String(line.ts),
      author: String(line.author),
      provenance: { kind: 'wiki', ref: id },
      agentSessionId: null,
      origin: 'wiki',
      links: [],
      body: {
        claim: String(line.claim),
        evidence: Array.isArray(line.evidence) ? (line.evidence as TbEntry['body']['evidence']) : [],
        signedBy: line.signedBy,
        status: status as TbEntry['body']['status'],
        literals,
      },
    });
  }

  const contestedBy = new Map<string, string[]>();
  for (const uv of uvs) {
    if (typeof uv.contests !== 'string' || statusOf(uv.id, uv.status) !== 'open') continue;
    contestedBy.set(uv.contests, [...(contestedBy.get(uv.contests) ?? []), uv.id]);
  }
  return { tombstones, contestedBy, skipped };
}

function openWiki(path: string, checkDeadline: () => void): TombstoneSource & { skipped: number } {
  if (!existsSync(path)) throw new Error(`no wiki file at ${path}`);
  const size = statSync(path).size;
  if (size > MAX_WIKI_FILE_BYTES) throw new Error(`wiki file ${path} is ${size} bytes, over the ${MAX_WIKI_FILE_BYTES}-byte limit`);
  const { tombstones, contestedBy, skipped } = wikiMatchableTombstones(readFileSync(path, 'utf8').split('\n'), checkDeadline);
  return { tombstones, contestedBy: (id) => contestedBy.get(id) ?? [], state: null, close: () => {}, skipped };
}

// ─────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────

/** Control characters and runs of whitespace flattened, so quoted text can't forge structure. */
function clean(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeHit(hit: GateHit): string {
  const { tb, literal } = hit;
  const subject = literal.subject ? `${clean(literal.subject, 80)}: ` : '';
  const change = `${subject}${clean(literal.dead, 80)} → ${literal.current ? clean(literal.current, 80) : '(removed)'}`;
  const signer = tb.body.signedBy ? `signed by ${clean(tb.body.signedBy, 80)}` : 'unsigned';
  const contest =
    hit.contestedBy.length > 0
      ? ` It is contested by ${hit.contestedBy.join(', ')} (still ground truth until a person resolves it).`
      : '';
  let filed = '';
  if (hit.ruling?.status === 'sustained') {
    const ruling = hit.ruling.rulingId ? ` (ruling ${hit.ruling.rulingId})` : '';
    filed = ` A person sustained objection ${hit.ruling.id} against this exact call${ruling}: don't retry it.`;
  } else if (hit.objection) {
    filed = ` Objection ${hit.objection.id} is on file.`;
  }
  return (
    `- ${change}, per TB ${tb.id} (${signer}): "${clean(tb.body.claim, 300)}".${contest}${filed}\n` +
    `  In ${hit.field}: ${clean(hit.line, 200)}`
  );
}

function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

function denyReason(toolName: string, hits: GateHit[]): string {
  const pending = hits.filter((h) => h.objection && h.ruling?.status !== 'sustained').map((h) => h.objection!.id);
  const lift =
    pending.length > 0
      ? `a person can overrule ${pending.length > 1 ? 'objections' : 'objection'} ${pending.join(', ')} (rule_on_objection); retrying this exact call then passes.`
      : 'a person must override or strike the TB.';
  const next = `Follow the TB: use the current value, or drop the dead one. If the dead value is intended here, ${lift}`;
  return [`Stenographer gate: this ${toolName} call asserts a tombstoned literal.`, ...hits.map(describeHit), next].join('\n');
}

const result = (partial: Partial<GateResult> & Pick<GateResult, 'decision'>): GateResult => ({
  output: null,
  sessionId: null,
  toolName: null,
  digest: null,
  hits: [],
  notes: [],
  error: null,
  ...partial,
});

/** The decision when the gate couldn't decide (error or budget), per --on-error. */
function failed(error: string, options: GateOptions, partial: Partial<GateResult> = {}): GateResult {
  if (options.onError === 'deny') {
    return result({
      ...partial,
      decision: 'deny',
      error,
      output: denyOutput(
        `Stenographer gate could not check this call (${clean(error, 300)}) and fails closed (--on-error deny). ` +
          'A person needs to fix the gate (stenographer gate --help) or set --on-error allow.'
      ),
      notes: [...(partial.notes ?? []), `stenographer gate: ${error}; denied (--on-error deny)`],
    });
  }
  const notes = [...(partial.notes ?? []), `stenographer gate: ${error}; allowed (--on-error allow)`];
  return result({ ...partial, decision: 'allow', error, notes });
}

/**
 * Decides one PreToolUse call. `startedAt` is when the budget began (the
 * CLI passes its own start, so reading stdin counts against it).
 */
export function evaluateGate(
  hookInput: unknown,
  options: GateOptions,
  clock: { now?: () => number; startedAt?: number } = {}
): GateResult {
  const now = clock.now ?? Date.now;
  const deadline = (clock.startedAt ?? now()) + options.timeoutMs;
  const remaining = () => deadline - now();
  const checkDeadline = () => {
    if (now() > deadline) throw new GateTimeoutError(`ran past its ${options.timeoutMs} ms budget`);
  };
  const partial: Partial<GateResult> = {};
  let source: TombstoneSource | null = null;

  try {
    const input = hookInput && typeof hookInput === 'object' && !Array.isArray(hookInput) ? (hookInput as Record<string, unknown>) : null;
    const toolName = input?.tool_name;
    const toolInput = input?.tool_input;
    if (typeof toolName !== 'string' || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
      throw new Error('hook input is not a PreToolUse event (needs tool_name and an object tool_input)');
    }
    partial.toolName = toolName;
    partial.sessionId = typeof input!.session_id === 'string' && input!.session_id ? input!.session_id : null;

    if (!options.tools.includes('*') && !options.tools.includes(toolName)) return result({ ...partial, decision: 'allow' });
    const fields = assertingFields(toolName, toolInput);
    if (fields.length === 0) return result({ ...partial, decision: 'allow' });

    checkDeadline();
    source = options.wikiPath ? openWiki(options.wikiPath, checkDeadline) : openState(options.statePath, remaining());
    if (source.tombstones.length === 0) return result({ ...partial, decision: 'allow' });

    checkDeadline();
    const { matcher } = compileTombstones(source.tombstones);
    // First asserting field per literal, in ledger order
    const found = new Map<number, { tb: TbEntry; literal: TombstonedLiteral; field: string; line: string; order: number }>();
    for (const { field, text } of fields) {
      for (const hit of matcher.match(text, { deadline, now, skip: (k) => found.has(k.order) })) {
        found.set(hit.key.order, { tb: hit.key.tb, literal: hit.key.literal, field, line: hit.line, order: hit.key.order });
      }
    }
    if (found.size === 0) return result({ ...partial, decision: 'allow' });

    checkDeadline();
    const digest = callDigest(harnessToolId(toolName), toolInput as Record<string, unknown>);
    partial.digest = digest;
    const call: Omit<GateCall, 'field'> = {
      toolName,
      toolUseId: typeof input!.tool_use_id === 'string' ? input!.tool_use_id : null,
      digest,
    };
    const notes: string[] = [];
    const hits: GateHit[] = [...found.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ tb, literal, field, line }) => ({
        tb,
        literal,
        field,
        line,
        contestedBy: source!.contestedBy(tb.id),
        objection: null,
        ruling: source!.state ? findGateRuling(source!.state.db, tb.id, digest) : null,
      }));

    // A person's ruling on this TB for this exact call is honored
    const open = hits.filter((h) => h.ruling?.status !== 'overruled');
    for (const h of hits.filter((h) => h.ruling?.status === 'overruled')) {
      notes.push(`stenographer gate: ${h.tb.id} matched, but objection ${h.ruling!.id} was overruled for this exact call; allowed`);
    }

    // File objections for what isn't ruled on yet
    const unruled = open.filter((h) => !h.ruling);
    if (unruled.length > 0 && source.state && partial.sessionId) {
      checkDeadline();
      let rw: Database.Database | null = null;
      try {
        rw = new Database(options.statePath, { fileMustExist: true, timeout: Math.max(0, remaining()) });
        const log = new ObjectionLog(rw, source.state.ledger);
        for (const h of unruled) {
          h.objection = log.raiseAtGate({
            sessionId: partial.sessionId,
            tb: h.tb,
            literal: h.literal,
            line: h.line,
            call: { ...call, field: h.field },
            delivered: options.mode === 'enforce',
          });
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        notes.push(`stenographer gate: could not file the objection in ${options.statePath} (${why})`);
      } finally {
        rw?.close();
      }
    } else if (unruled.length > 0 && source.state) {
      notes.push('stenographer gate: the hook input has no session_id, so the objection was not filed');
    }

    if (open.length === 0) return result({ ...partial, decision: 'allow', hits, notes });
    const reason = denyReason(toolName, open);
    if (options.mode === 'enforce') {
      return result({ ...partial, decision: 'deny', output: denyOutput(reason), hits, notes });
    }
    const filed = open.filter((h) => h.objection).map((h) => h.objection!.id);
    notes.push(
      `stenographer gate (shadow): would deny this ${toolName} call${filed.length > 0 ? `; filed as objection ${filed.join(', ')}` : ''}`,
      reason
    );
    return result({ ...partial, decision: 'allow', hits, notes });
  } catch (err) {
    const message =
      err instanceof GateTimeoutError || err instanceof MatchDeadlineError
        ? `ran past its ${options.timeoutMs} ms budget`
        : err instanceof Error
          ? err.message
          : String(err);
    return failed(message, options, partial);
  } finally {
    source?.close();
  }
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

const USAGE =
  'usage: stenographer gate [--state <path> | --wiki <file>] [--mode shadow|enforce] [--timeout-ms <n>] ' +
  '[--on-error allow|deny] [--tools <list>] [--log <file>]';

export interface GateIO {
  stdin: Readable;
  stdout: Pick<Writable, 'write'>;
  stderr: Pick<Writable, 'write'>;
}

/** Reads all of stdin, or throws once `ms` pass. */
function readAll(stream: Readable, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      stream.destroy();
      reject(new GateTimeoutError('stdin was not closed within the budget'));
    }, Math.max(0, ms));
    const onData = (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

function appendLog(path: string, entry: Record<string, unknown>, io: GateIO): void {
  try {
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch (err) {
    io.stderr.write(`stenographer gate: could not write --log ${path} (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

/**
 * The `stenographer gate` command. Returns the exit code: 0 when the gate
 * decided (the decision is in the JSON it printed, or in printing nothing),
 * 1 when it allowed a call it could not check (so the harness surfaces
 * stderr without blocking).
 */
export async function runGateCLI(
  args: string[],
  io: GateIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  clock: { now?: () => number } = {}
): Promise<number> {
  const now = clock.now ?? Date.now;
  const startedAt = now();
  let options: GateOptions;
  let logPath: string | undefined;
  try {
    const { values } = parseArgs({
      args,
      options: {
        state: { type: 'string' },
        wiki: { type: 'string' },
        mode: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'on-error': { type: 'string' },
        tools: { type: 'string' },
        log: { type: 'string' },
      },
      allowPositionals: false,
    });
    const mode = values.mode ?? 'shadow';
    if (mode !== 'shadow' && mode !== 'enforce') throw new Error(`--mode must be shadow or enforce, not ${mode}`);
    const onError = values['on-error'] ?? (mode === 'enforce' ? 'deny' : 'allow');
    if (onError !== 'allow' && onError !== 'deny') throw new Error(`--on-error must be allow or deny, not ${onError}`);
    const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_GATE_TIMEOUT_MS : Number(values['timeout-ms']);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= CLAUDE_CODE_HOOK_TIMEOUT_MS) {
      throw new Error(
        `--timeout-ms must be a whole number of milliseconds from 1 to ${CLAUDE_CODE_HOOK_TIMEOUT_MS - 1} (below the harness hook timeout)`
      );
    }
    if (values.state && values.wiki) throw new Error('pass --state or --wiki, not both');
    const tools = values.tools
      ? values.tools.split(',').map((t) => t.trim()).filter(Boolean)
      : [...DEFAULT_GATE_TOOLS];
    options = { mode, onError, timeoutMs, tools, statePath: values.state ?? DEFAULT_STATE, wikiPath: values.wiki };
    logPath = values.log;
  } catch (err) {
    // A misconfigured gate still answers, and fails closed if it was meant to enforce
    const said = (flag: string, value: string) => args.some((a, i) => a === `${flag}=${value}` || (a === value && args[i - 1] === flag));
    const enforce = said('--mode', 'enforce') && !said('--on-error', 'allow');
    const message = `${err instanceof Error ? err.message : String(err)} — ${USAGE}`;
    const decided = failed(message, {
      mode: enforce ? 'enforce' : 'shadow',
      onError: enforce ? 'deny' : 'allow',
      timeoutMs: 1,
      tools: [],
      statePath: '',
    });
    if (decided.output) io.stdout.write(decided.output + '\n');
    for (const note of decided.notes) io.stderr.write(note + '\n');
    return decided.decision === 'deny' ? 0 : 1;
  }

  let decided: GateResult;
  try {
    const raw = await readAll(io.stdin, options.timeoutMs - (now() - startedAt));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('hook input on stdin is not JSON');
    }
    decided = evaluateGate(parsed, options, { now, startedAt });
  } catch (err) {
    decided = failed(err instanceof Error ? err.message : String(err), options);
  }

  if (decided.output) io.stdout.write(decided.output + '\n');
  for (const note of decided.notes) io.stderr.write(note + '\n');
  if (logPath && (decided.hits.length > 0 || decided.error)) {
    appendLog(
      logPath,
      {
        ts: new Date().toISOString(),
        mode: options.mode,
        decision: decided.decision,
        sessionId: decided.sessionId,
        toolName: decided.toolName,
        digest: decided.digest,
        error: decided.error,
        hits: decided.hits.map((h) => ({
          tbId: h.tb.id,
          literal: h.literal,
          signedBy: h.tb.body.signedBy,
          field: h.field,
          line: h.line,
          objectionId: h.objection?.id ?? null,
          ruling: h.ruling ? { objectionId: h.ruling.id, status: h.ruling.status, rulingId: h.ruling.rulingId } : null,
        })),
      },
      io
    );
  }
  return decided.error && decided.decision === 'allow' ? 1 : 0;
}

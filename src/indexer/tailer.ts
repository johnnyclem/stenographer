/**
 * Stenographer — JSONL Tailer
 * Follows a conversation log the way `tail -F` does, as a small state
 * machine: waiting (no file yet) → open (reading to EOF, holding back a
 * partial last line until its newline arrives) → waiting again when the file
 * is deleted, or reopened when the path is rotated, replaced or truncated.
 */

import { watch, type FSWatcher } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, dirname, resolve } from 'node:path';
import { MessageSchema, type ConversationMessage } from '../types.js';

/** Where a line sits in its log, so id-less formats can derive stable ids. */
export interface LineContext {
  /** Absolute path of the log. */
  source: string;
  /** Byte offset of the line's first byte. */
  offset: number;
}

export interface LogAdapter {
  parseLine(line: string, context?: LineContext): ConversationMessage | null;
  detect(lines: string[]): boolean;
}

// ─────────────────────────────────────────────────────────────
// Standard JSONL Adapter
// ─────────────────────────────────────────────────────────────

export class JsonlAdapter implements LogAdapter {
  parseLine(line: string): ConversationMessage | null {
    try {
      const parsed = JSON.parse(line);
      return MessageSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  detect(lines: string[]): boolean {
    return lines.some((line) => {
      try {
        return MessageSchema.safeParse(JSON.parse(line)).success;
      } catch {
        return false;
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// File Tailer
// ─────────────────────────────────────────────────────────────

/**
 * A point in a log: the byte just past the last consumed line, plus what
 * identifies the file (dev/inode, a hash of its first `headLength` bytes).
 */
export interface TailPosition {
  dev: string;
  inode: string;
  headHash: string;
  headLength: number;
  offset: number;
  /** Lines consumed up to `offset`. */
  seq: number;
}

/** Emitted with every message (and on `progress`): where the log now stands. */
export interface IngestPosition extends TailPosition {
  /** Absolute path of the log. */
  source: string;
  /**
   * The line was already in the log when tailing started: history being
   * replayed, not live output.
   */
  replay: boolean;
}

export interface TailerOptions {
  sessionId?: string;
  /** Fixed log format. Omit it and pass `detect` to choose one from the first lines. */
  adapter?: LogAdapter;
  /**
   * Chooses an adapter from the first complete lines, or null when it can't
   * tell yet. Detection waits for lines, so an empty log isn't locked into
   * a format before anything is written.
   */
  detect?: (lines: string[]) => LogAdapter | null;
  /** When false, process the file once and don't watch for changes (catchup mode). Default true. */
  follow?: boolean;
  /** Continue from here (a stored checkpoint) if the file is still that log. */
  resumeFrom?: TailPosition | null;
  /**
   * Mark lines already in the file at start() as replay. Default true; false
   * for a file that appeared after the process started, which is all live.
   */
  replayExisting?: boolean;
  /** Safety-net poll for filesystems whose watch events go missing. Default 1000; 0 disables. */
  pollIntervalMs?: number;
}

/** Bytes hashed to recognize a file again (after a restart, or a replace). */
const HEAD_BYTES = 4096;
const READ_CHUNK = 64 * 1024;
/** Lines to wait for a format match before falling back to JSONL. */
const DETECTION_MAX_LINES = 8;
const DEFAULT_POLL_MS = 1000;
const BOM = '﻿';

interface Line {
  text: string;
  offset: number;
  end: number;
  seq: number;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Events: `message` (msg, IngestPosition) for each parsed line; `progress`
 * (IngestPosition) when consumed non-message lines move the position;
 * `adapter` (LogAdapter) once the format is known; `reset` (reason) when the
 * file was truncated, rewritten or replaced and is being read from the top;
 * `removed` when the file is deleted (the tailer waits for it to reappear).
 */
export class Tailer extends EventEmitter {
  private adapter: LogAdapter | null;
  private detector: ((lines: string[]) => LogAdapter | null) | null;
  private filePath: string;
  private source: string;
  private sessionId: string;
  private follow: boolean;
  private replayExisting: boolean;
  private pollIntervalMs: number;
  private resumeFrom: TailPosition | null;
  private isRunning: boolean = false;

  // The open file
  private handle: FileHandle | null = null;
  private opens = 0;
  private dev = '';
  private inode = '';
  /** Next byte to read. */
  private readOffset = 0;
  /** Bytes after the last newline read, waiting for the rest of their line. */
  private partial: Buffer = Buffer.alloc(0);
  /** The file's first min(HEAD_BYTES, readOffset) bytes. */
  private head: Buffer = Buffer.alloc(0);
  /** Lines consumed before `readOffset - partial.length`. */
  private seq = 0;
  /** Lines ending at or before this offset were in the file at start(). */
  private replayUntil = 0;
  private lastSize = -1;
  private lastReported = -1;
  /** Lines held until the format is known. */
  private undetected: Line[] = [];

  private fileWatcher: FSWatcher | null = null;
  private dirWatcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private pumping: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(filePath: string, sessionIdOrOptions?: string | TailerOptions, adapter?: LogAdapter) {
    super();
    const options: TailerOptions =
      typeof sessionIdOrOptions === 'string' || sessionIdOrOptions === undefined
        ? { sessionId: sessionIdOrOptions, adapter }
        : sessionIdOrOptions;

    this.filePath = filePath;
    this.source = resolve(filePath);
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.detector = options.detect ?? null;
    this.adapter = options.adapter ?? (this.detector ? null : new JsonlAdapter());
    this.follow = options.follow ?? true;
    this.replayExisting = options.replayExisting ?? true;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.resumeFrom = options.resumeFrom ?? null;
  }

  /**
   * Reads what the log holds now, then (when following) keeps reading as it
   * grows. A missing log is waited for, except in catchup mode where it is
   * an error. Resolves once the initial read is done.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Whatever the log already holds is history: replayed, never live
    if (this.replayExisting) {
      this.replayUntil = await stat(this.filePath).then((s) => s.size, () => 0);
    }

    if (!this.follow) {
      try {
        if (!(await this.openFile())) {
          throw new Error(`log not found: ${this.filePath}`);
        }
        await this.drain();
        this.finish();
      } finally {
        this.isRunning = false;
        await this.closeHandle();
      }
      return;
    }

    // Watch before the first read, so a line appended during catch-up
    // raises an event instead of slipping between the read and the watch
    this.watchDirectory();
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.schedule(), this.pollIntervalMs);
      this.pollTimer.unref();
    }
    await this.schedule();
  }

  stop(): void {
    this.isRunning = false;
    this.fileWatcher?.close();
    this.fileWatcher = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    void this.closeHandle();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // ─────────────────────────────────────────────────────────
  // State machine
  // ─────────────────────────────────────────────────────────

  /** Runs a pass now, or after the one in flight; bursts of events coalesce. */
  private schedule(): Promise<void> {
    if (!this.isRunning) return Promise.resolve();
    this.dirty = true;
    if (!this.pumping) {
      this.pumping = this.pump().finally(() => {
        this.pumping = null;
      });
    }
    return this.pumping;
  }

  private async pump(): Promise<void> {
    while (this.dirty && this.isRunning) {
      this.dirty = false;
      try {
        await this.step();
        this.lastError = null;
      } catch (err) {
        // A failed pass must never take the process down or wedge the
        // tailer: report it (once, not every poll) and let the next event
        // or poll retry
        const message = err instanceof Error ? err.message : String(err);
        if (this.isRunning && message !== this.lastError) {
          console.error(`⚠️  tailing ${this.filePath}: ${message}`);
        }
        this.lastError = message;
      }
    }
  }

  private async step(): Promise<void> {
    // Waiting: nothing to do until the file exists
    if (!this.handle && !(await this.openFile())) return;

    await this.drain();
    if (!this.isRunning) return;

    // Has the path moved on from the file we have open?
    let current;
    try {
      current = await stat(this.filePath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.closeHandle();
      this.resetPosition();
      console.error(`📭 ${this.filePath} was removed; it is picked up again if it reappears`);
      this.emit('removed');
      return;
    }
    if (String(current.dev) !== this.dev || String(current.ino) !== this.inode) {
      // Rotated or replaced. The old file is drained; open whatever is at
      // the path now (openFile continues from here if it is the same log)
      await this.closeHandle();
      this.dirty = true;
    }
  }

  /** Opens the log if it exists; false while it doesn't. */
  private async openFile(): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.filePath, 'r');
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    if (!this.isRunning) {
      await handle.close();
      return false;
    }
    const st = await handle.stat();

    // Continue from a checkpoint (first open) or from where the previous
    // file left off (a replace) — but only if this is recognizably that log
    const from = this.resumeFrom ?? (this.opens > 0 ? this.position(this.consumedOffset(), this.seq, false) : null);
    this.resumeFrom = null;
    const firstOpen = this.opens === 0;
    this.opens++;

    this.handle = handle;
    this.dev = String(st.dev);
    this.inode = String(st.ino);
    this.resetPosition();
    // Only the file that was there at start() holds replayed history
    if (!firstOpen) this.replayUntil = 0;

    if (from && from.offset > 0) {
      const head = await this.readHead(Math.min(HEAD_BYTES, from.offset));
      if (st.size >= from.offset && head.length === from.headLength && sha256(head) === from.headHash) {
        this.readOffset = from.offset;
        this.seq = from.seq;
        this.head = head;
      } else {
        console.error(`↺ ${this.filePath} is not the log last read there; reading it from the start`);
        this.emit('reset', 'replaced');
      }
    }

    this.watchFile();
    return true;
  }

  /** Reads from the current offset to EOF, emitting every complete line. */
  private async drain(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;

    const { size } = await handle.stat();
    // Truncated (copytruncate), or rewritten in place past our offset
    if (size < this.readOffset || (size !== this.lastSize && !(await this.headMatches()))) {
      console.error(`↺ ${this.filePath} was truncated or rewritten; reading it from the start`);
      this.resetPosition();
      this.replayUntil = 0;
      this.emit('reset', 'truncated');
    }

    // Read until a read comes back empty, not to a size sampled up front:
    // anything appended while this pass runs is picked up by it
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    while (this.isRunning && this.handle === handle) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, this.readOffset);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      this.extendHead(chunk);
      this.readOffset += bytesRead;
      this.consume(chunk);
    }
    this.lastSize = this.readOffset;
    this.reportProgress();
  }

  /** Catchup's end of file: the last line may lack its newline. */
  private finish(): void {
    if (this.partial.length > 0) {
      const offset = this.consumedOffset();
      // Indexed, but the position stays before it: if the file turns out
      // to still be growing, a later run re-reads the whole line
      this.acceptLine(this.decode(this.partial, offset), offset, offset, this.seq);
      this.partial = Buffer.alloc(0);
    }
    if (!this.adapter && this.undetected.length > 0) {
      this.lockAdapter(this.detector?.(this.undetected.map((l) => l.text)) ?? new JsonlAdapter());
    }
  }

  // ─────────────────────────────────────────────────────────
  // Lines
  // ─────────────────────────────────────────────────────────

  private consume(chunk: Buffer): void {
    const data = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    const base = this.readOffset - data.length;
    let pos = 0;
    let newline: number;
    while ((newline = data.indexOf(0x0a, pos)) !== -1) {
      const offset = base + pos;
      this.seq++;
      this.acceptLine(this.decode(data.subarray(pos, newline), offset), offset, base + newline + 1, this.seq);
      pos = newline + 1;
    }
    // Copy: `chunk` is a view of the reused read buffer
    this.partial = Buffer.from(data.subarray(pos));
  }

  private decode(bytes: Buffer, offset: number): string {
    let text = bytes.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (offset === 0 && text.startsWith(BOM)) text = text.slice(BOM.length);
    return text;
  }

  private acceptLine(text: string, offset: number, end: number, seq: number): void {
    if (!text.trim()) return;
    const line = { text, offset, end, seq };
    if (this.adapter) {
      this.emitLine(line);
      return;
    }
    this.undetected.push(line);
    const adapter = this.detector?.(this.undetected.map((l) => l.text)) ?? null;
    if (adapter || this.undetected.length >= DETECTION_MAX_LINES) {
      this.lockAdapter(adapter ?? new JsonlAdapter());
    }
  }

  private lockAdapter(adapter: LogAdapter): void {
    this.adapter = adapter;
    this.emit('adapter', adapter);
    const held = this.undetected;
    this.undetected = [];
    for (const line of held) this.emitLine(line);
  }

  private emitLine(line: Line): void {
    if (!this.isRunning) return;
    const msg = this.adapter!.parseLine(line.text, { source: this.source, offset: line.offset });
    if (!msg) return;
    this.lastReported = line.end;
    this.emit(
      'message',
      { ...msg, sessionId: this.sessionId },
      this.position(line.end, line.seq, line.end <= this.replayUntil)
    );
  }

  /** Tells listeners about consumed lines that produced no message. */
  private reportProgress(): void {
    // Held (undetected) lines aren't consumed yet
    const [held] = this.undetected;
    const offset = held ? held.offset : this.consumedOffset();
    if (offset === this.lastReported || !this.isRunning) return;
    this.lastReported = offset;
    this.emit('progress', this.position(offset, held ? held.seq - 1 : this.seq, false));
  }

  // ─────────────────────────────────────────────────────────
  // Position & identity
  // ─────────────────────────────────────────────────────────

  private consumedOffset(): number {
    return this.readOffset - this.partial.length;
  }

  private position(offset: number, seq: number, replay: boolean): IngestPosition {
    const headLength = Math.min(HEAD_BYTES, offset);
    return {
      source: this.source,
      dev: this.dev,
      inode: this.inode,
      headHash: sha256(this.head.subarray(0, headLength)),
      headLength,
      offset,
      seq,
      replay,
    };
  }

  private resetPosition(): void {
    this.readOffset = 0;
    this.partial = Buffer.alloc(0);
    this.head = Buffer.alloc(0);
    this.seq = 0;
    this.lastSize = -1;
    this.lastReported = -1;
    this.undetected = [];
  }

  /** Keeps `head` equal to the file's first min(HEAD_BYTES, readOffset) bytes. */
  private extendHead(chunk: Buffer): void {
    if (this.readOffset >= HEAD_BYTES) return;
    const take = Math.min(HEAD_BYTES - this.readOffset, chunk.length);
    this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
  }

  private async readHead(length: number): Promise<Buffer> {
    if (!this.handle || length === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  }

  private async headMatches(): Promise<boolean> {
    if (this.head.length === 0) return true;
    return (await this.readHead(this.head.length)).equals(this.head);
  }

  // ─────────────────────────────────────────────────────────
  // Watching
  // ─────────────────────────────────────────────────────────

  private watchFile(): void {
    if (!this.follow) return;
    this.fileWatcher?.close();
    this.fileWatcher = null;
    try {
      const watcher = watch(this.filePath, () => void this.schedule());
      watcher.on('error', () => {
        watcher.close();
        if (this.fileWatcher === watcher) this.fileWatcher = null;
        void this.schedule();
      });
      this.fileWatcher = watcher;
    } catch {
      // Gone already: the directory watch and the poll cover it
    }
  }

  /** The parent directory sees creation, rename and deletion of the path. */
  private watchDirectory(): void {
    const name = basename(this.filePath);
    try {
      const watcher = watch(dirname(this.filePath), (_event, changed) => {
        if (!changed || changed.toString() === name) void this.schedule();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.dirWatcher === watcher) this.dirWatcher = null;
      });
      this.dirWatcher = watcher;
    } catch {
      // No parent directory (yet): the poll covers it
    }
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.fileWatcher?.close();
    this.fileWatcher = null;
    if (handle) await handle.close().catch(() => {});
  }
}

// Adapter registry and format detection live in ./adapters.ts

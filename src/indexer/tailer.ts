/**
 * Stenographer — JSONL Tailer
 * Watches and processes conversation log files
 */

import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { MessageSchema, type ConversationMessage } from '../types.js';

export interface LogAdapter {
  parseLine(line: string): ConversationMessage | null;
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
    if (lines.length === 0) return false;
    try {
      const first = JSON.parse(lines[0]);
      return MessageSchema.safeParse(first).success;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// File Tailer
// ─────────────────────────────────────────────────────────────

export interface TailerOptions {
  sessionId?: string;
  adapter?: LogAdapter;
  /** When false, process the file once and don't watch for changes (catchup mode). Default true. */
  follow?: boolean;
}

export class Tailer extends EventEmitter {
  private adapter: LogAdapter;
  private filePath: string;
  private position: number = 0;
  private watcher: FSWatcher | null = null;
  private sessionId: string;
  private isRunning: boolean = false;
  private follow: boolean;
  private processing: Promise<void> = Promise.resolve();

  constructor(filePath: string, sessionIdOrOptions?: string | TailerOptions, adapter?: LogAdapter) {
    super();
    const options: TailerOptions =
      typeof sessionIdOrOptions === 'string' || sessionIdOrOptions === undefined
        ? { sessionId: sessionIdOrOptions, adapter }
        : sessionIdOrOptions;

    this.filePath = filePath;
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.adapter = options.adapter ?? new JsonlAdapter();
    this.follow = options.follow ?? true;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial catchup — process the file from the beginning
    await this.readFrom(0);

    if (!this.follow) {
      this.isRunning = false;
      return;
    }

    // Watch for new lines; serialize reads so overlapping change events
    // can't process the same byte range twice
    this.watcher = watch(this.filePath, (eventType) => {
      if (eventType === 'change') {
        this.processing = this.processing.then(() => this.readFrom(this.position));
      }
    });
  }

  stop(): void {
    this.isRunning = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private async readFrom(start: number): Promise<void> {
    const { size } = await stat(this.filePath);
    if (size < start) {
      // File was truncated/rotated — start over
      start = 0;
    }
    if (size === start) return;

    const stream = createReadStream(this.filePath, { start, end: size - 1 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (line.trim()) {
        const msg = this.adapter.parseLine(line);
        if (msg) {
          this.emit('message', { ...msg, sessionId: this.sessionId });
        }
      }
    }

    this.position = size;
  }
}

// Adapter registry and format detection live in ./adapters.ts

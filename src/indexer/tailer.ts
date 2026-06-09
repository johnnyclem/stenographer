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

export class Tailer extends EventEmitter {
  private adapter: LogAdapter;
  private filePath: string;
  private position: number = 0;
  private watcher: FSWatcher | null = null;
  private sessionId: string;
  private isRunning: boolean = false;
  private processing: Promise<void> = Promise.resolve();

  constructor(filePath: string, sessionId?: string, adapter?: LogAdapter) {
    super();
    this.filePath = filePath;
    this.sessionId = sessionId || `session_${Date.now()}`;
    this.adapter = adapter ?? new JsonlAdapter();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial catchup — process the file from the beginning
    await this.readFrom(0);

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

// ─────────────────────────────────────────────────────────────
// Adapter Registry
// ─────────────────────────────────────────────────────────────

export const adapters: Map<string, LogAdapter> = new Map([
  ['jsonl', new JsonlAdapter()],
]);

export function detectAdapter(filePath: string): Promise<LogAdapter> {
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { end: 1024 * 10 });
    const rl = createInterface({ input: stream });
    const lines: string[] = [];

    rl.on('line', (line) => {
      if (line.trim()) {
        lines.push(line);
        if (lines.length >= 5) rl.close();
      }
    });

    rl.on('close', () => {
      for (const adapter of adapters.values()) {
        if (adapter.detect(lines)) {
          resolve(adapter);
          return;
        }
      }
      resolve(new JsonlAdapter());
    });

    stream.on('error', () => resolve(new JsonlAdapter()));
  });
}

/**
 * Stenographer — JSONL Tailer
 * Watches and processes conversation log files
 */

import { createReadStream, FSWatcher } from 'node:fs';
import { createInterface } from 'node:readline';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { MessageSchema, type ConversationMessage } from '../types.js';

export interface JsonlAdapter {
  parseLine(line: string): ConversationMessage | null;
  detect(lines: string[]): boolean;
}

// ─────────────────────────────────────────────────────────────
// Standard JSONL Adapter
// ─────────────────────────────────────────────────────────────

export class JsonlAdapter implements JsonlAdapter {
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
  private adapter: JsonlAdapter;
  private filePath: string;
  private position: number = 0;
  private watcher: FSWatcher | null = null;
  private sessionId: string;
  private isRunning: boolean = false;

  constructor(filePath: string, sessionId?: string) {
    super();
    this.filePath = filePath;
    this.sessionId = sessionId || `session_${Date.now()}`;
    this.adapter = new JsonlAdapter();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial catchup — process entire file
    await this.processFile();

    // Watch for new lines
    this.watcher = watch(this.filePath, (eventType) => {
      if (eventType === 'change') {
        this.processNew();
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

  private async processFile(): Promise<void> {
    const stream = createReadStream(this.filePath);
    const rl = createInterface({ input: stream });
    const lines: string[] = [];

    for await (const line of rl) {
      if (line.trim()) {
        lines.push(line);
        const msg = this.adapter.parseLine(line);
        if (msg) {
          this.emit('message', { ...msg, sessionId: this.sessionId });
        }
      }
    }

    // Save position for incremental reads
    this.position = 0; // Would track actual position in production
  }

  private async processNew(): Promise<void> {
    const stream = createReadStream(this.filePath, { start: this.position });
    const rl = createInterface({ input: stream });

    for await (const line of rl) {
      if (line.trim()) {
        const msg = this.adapter.parseLine(line);
        if (msg) {
          this.emit('message', { ...msg, sessionId: this.sessionId });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Adapter Registry (for future provider adapters)
// ─────────────────────────────────────────────────────────────

export const adapters: Map<string, JsonlAdapter> = new Map([
  ['jsonl', new JsonlAdapter()],
]);

export function detectAdapter(filePath: string): Promise<JsonlAdapter> {
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { end: 1024 * 10 });
    const rl = createInterface({ input: stream });
    const lines: string[] = [];
    let collected = 0;

    rl.on('line', (line) => {
      if (line.trim()) {
        lines.push(line);
        collected++;
        if (collected >= 5) rl.close();
      }
    });

    rl.on('close', () => {
      // Auto-detect: prefer JSONL for now
      resolve(new JsonlAdapter());
    });
  });
}

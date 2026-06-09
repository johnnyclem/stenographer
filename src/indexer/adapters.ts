/**
 * Stenographer — Provider Log Adapters
 * Parse conversation log lines from different providers into the common
 * ConversationMessage shape. Messages lacking ids get deterministic ids
 * hashed from the raw line, so re-tailing a file stays idempotent.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ConversationMessage } from '../types.js';
import { JsonlAdapter, type LogAdapter } from './tailer.js';

type Role = ConversationMessage['role'];

const ROLES: Role[] = ['system', 'user', 'assistant', 'tool'];

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

// FNV-1a hash for deterministic synthetic message ids
function lineHash(line: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Flattens provider content blocks into text + tool calls. */
function flattenContent(content: unknown): { text: string; toolCalls: ToolCall[] } {
  if (typeof content === 'string') {
    return { text: content, toolCalls: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', toolCalls: [] };
  }

  const parts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolCalls.push({ name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
      } else if (b.type === 'tool_result') {
        const inner = flattenContent(b.content);
        if (inner.text) parts.push(inner.text);
      }
    }
  }
  return { text: parts.join('\n'), toolCalls };
}

function build(
  line: string,
  role: Role,
  content: unknown,
  extras: { id?: string; timestamp?: string; model?: string; sessionId?: string } = {}
): ConversationMessage | null {
  const { text, toolCalls } = flattenContent(content);
  if (!text && toolCalls.length === 0) return null;

  return {
    id: extras.id || `msg_${lineHash(line)}`,
    role,
    content: text,
    timestamp: extras.timestamp || new Date().toISOString(),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(extras.model ? { model: extras.model } : {}),
    ...(extras.sessionId ? { sessionId: extras.sessionId } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// OpenAI chat format: {"role": "...", "content": "..."} per line
// ─────────────────────────────────────────────────────────────

export class OpenAIAdapter implements LogAdapter {
  parseLine(line: string): ConversationMessage | null {
    try {
      const obj = JSON.parse(line);
      if (!isRole(obj.role)) return null;

      // OpenAI tool calls: {role: "assistant", tool_calls: [{function: {name, arguments}}]}
      const toolCalls: ToolCall[] = Array.isArray(obj.tool_calls)
        ? obj.tool_calls
            .filter((t: any) => t?.function?.name)
            .map((t: any) => ({
              name: t.function.name,
              input: safeJson(t.function.arguments),
            }))
        : [];

      const { text } = flattenContent(obj.content ?? '');
      if (!text && toolCalls.length === 0) return null;

      return {
        id: typeof obj.id === 'string' ? obj.id : `msg_${lineHash(line)}`,
        role: obj.role,
        content: text,
        timestamp:
          typeof obj.created === 'number'
            ? new Date(obj.created * 1000).toISOString()
            : new Date().toISOString(),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(typeof obj.model === 'string' ? { model: obj.model } : {}),
      };
    } catch {
      return null;
    }
  }

  detect(lines: string[]): boolean {
    return detectBy(lines, (obj) =>
      isRole(obj.role) &&
      (typeof obj.content === 'string' || Array.isArray(obj.tool_calls)) &&
      obj.id === undefined &&
      obj.type === undefined
    );
  }
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return (value as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

// ─────────────────────────────────────────────────────────────
// Anthropic messages format: content as block arrays
// ─────────────────────────────────────────────────────────────

export class AnthropicAdapter implements LogAdapter {
  parseLine(line: string): ConversationMessage | null {
    try {
      const obj = JSON.parse(line);
      if (!isRole(obj.role)) return null;
      return build(line, obj.role, obj.content, {
        id: typeof obj.id === 'string' ? obj.id : undefined,
        model: typeof obj.model === 'string' ? obj.model : undefined,
      });
    } catch {
      return null;
    }
  }

  detect(lines: string[]): boolean {
    return detectBy(lines, (obj) =>
      isRole(obj.role) &&
      Array.isArray(obj.content) &&
      obj.content.some((b: any) => b && typeof b === 'object' && ('text' in b || b.type === 'tool_use'))
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Claude Code session format:
// {"type": "user"|"assistant", "message": {...}, "uuid", "timestamp", "sessionId"}
// ─────────────────────────────────────────────────────────────

export class ClaudeCodeAdapter implements LogAdapter {
  parseLine(line: string): ConversationMessage | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'user' && obj.type !== 'assistant') return null;
      const inner = obj.message;
      if (!inner || typeof inner !== 'object') return null;
      const role: Role = isRole(inner.role) ? inner.role : (obj.type as Role);
      return build(line, role, inner.content, {
        id: typeof obj.uuid === 'string' ? obj.uuid : undefined,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
        model: typeof inner.model === 'string' ? inner.model : undefined,
        sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
      });
    } catch {
      return null;
    }
  }

  detect(lines: string[]): boolean {
    return detectBy(lines, (obj) =>
      (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'summary') &&
      (obj.message !== undefined || obj.type === 'summary')
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Generic best-effort: find role-ish and content-ish fields
// ─────────────────────────────────────────────────────────────

export class GenericAdapter implements LogAdapter {
  parseLine(line: string): ConversationMessage | null {
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== 'object') return null;

      const roleRaw = obj.role ?? obj.speaker ?? obj.from ?? obj.author;
      const role: Role = isRole(roleRaw) ? roleRaw : roleRaw === 'human' ? 'user' : roleRaw === 'ai' || roleRaw === 'bot' ? 'assistant' : 'user';

      const content = obj.content ?? obj.text ?? obj.message ?? obj.body;
      if (typeof content !== 'string' && !Array.isArray(content)) return null;

      return build(line, role, content, {
        id: typeof obj.id === 'string' ? obj.id : undefined,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
      });
    } catch {
      return null;
    }
  }

  detect(lines: string[]): boolean {
    return detectBy(lines, (obj) => this.parseLine(JSON.stringify(obj)) !== null);
  }
}

function detectBy(lines: string[], predicate: (obj: any) => boolean): boolean {
  if (lines.length === 0) return false;
  try {
    return predicate(JSON.parse(lines[0]));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Registry & detection — most specific format first
// ─────────────────────────────────────────────────────────────

export const adapters: Map<string, LogAdapter> = new Map<string, LogAdapter>([
  ['jsonl', new JsonlAdapter()],
  ['claude-code', new ClaudeCodeAdapter()],
  ['anthropic', new AnthropicAdapter()],
  ['openai', new OpenAIAdapter()],
  ['generic', new GenericAdapter()],
]);

const DETECTION_ORDER = ['jsonl', 'claude-code', 'anthropic', 'openai', 'generic'];

export function getAdapter(name: string): LogAdapter {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`Unknown adapter '${name}'. Available: ${[...adapters.keys()].join(', ')}`);
  }
  return adapter;
}

export function detectAdapterFromLines(lines: string[]): LogAdapter {
  for (const name of DETECTION_ORDER) {
    const adapter = adapters.get(name)!;
    if (adapter.detect(lines)) return adapter;
  }
  return adapters.get('jsonl')!;
}

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

    rl.on('close', () => resolve(detectAdapterFromLines(lines)));
    stream.on('error', () => resolve(adapters.get('jsonl')!));
  });
}

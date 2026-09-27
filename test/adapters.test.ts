import { describe, it, expect } from 'vitest';
import {
  OpenAIAdapter,
  AnthropicAdapter,
  ClaudeCodeAdapter,
  GenericAdapter,
  getAdapter,
  detectAdapterFromLines,
} from '../src/indexer/adapters.js';
import { JsonlAdapter } from '../src/indexer/tailer.js';

describe('OpenAIAdapter', () => {
  const adapter = new OpenAIAdapter();

  it('parses chat messages and synthesizes deterministic ids', () => {
    const line = '{"role":"user","content":"hello there"}';
    const msg = adapter.parseLine(line);
    expect(msg?.role).toBe('user');
    expect(msg?.content).toBe('hello there');
    expect(msg?.id).toBe(adapter.parseLine(line)?.id);
  });

  it('parses tool calls', () => {
    const msg = adapter.parseLine(
      '{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"tokyo\\"}"}}]}'
    );
    expect(msg?.toolCalls?.[0]).toEqual({ name: 'get_weather', input: { city: 'tokyo' } });
  });

  it('detects its format', () => {
    expect(adapter.detect(['{"role":"user","content":"hi"}'])).toBe(true);
    expect(adapter.detect(['{"type":"user","message":{}}'])).toBe(false);
  });
});

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter();

  it('flattens content blocks', () => {
    const msg = adapter.parseLine(
      '{"role":"assistant","content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}]}'
    );
    expect(msg?.content).toBe('part one\npart two');
  });

  it('extracts tool_use blocks', () => {
    const msg = adapter.parseLine(
      '{"role":"assistant","content":[{"type":"tool_use","name":"bash","input":{"cmd":"ls"}}]}'
    );
    expect(msg?.toolCalls?.[0]).toEqual({ name: 'bash', input: { cmd: 'ls' } });
  });

  it('detects block-array content', () => {
    expect(adapter.detect(['{"role":"user","content":[{"type":"text","text":"hi"}]}'])).toBe(true);
    expect(adapter.detect(['{"role":"user","content":"plain"}'])).toBe(false);
  });
});

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'u-123',
    timestamp: '2026-06-09T10:00:00Z',
    sessionId: 's-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'claude-x' },
  });

  it('maps session log entries', () => {
    const msg = adapter.parseLine(line);
    expect(msg).toMatchObject({
      id: 'u-123',
      role: 'assistant',
      content: 'done',
      timestamp: '2026-06-09T10:00:00Z',
      sessionId: 's-1',
      model: 'claude-x',
    });
  });

  it('skips non-message lines', () => {
    expect(adapter.parseLine('{"type":"summary","summary":"stuff"}')).toBeNull();
  });

  it('detects its format', () => {
    expect(adapter.detect([line])).toBe(true);
    expect(adapter.detect(['{"role":"user","content":"hi"}'])).toBe(false);
  });

  it('detects a real session log that opens with bookkeeping records', () => {
    // Shape observed in ~/.claude/projects/<proj>/<session>.jsonl: the first
    // lines are queue/title records, and turns carry parentUuid + sessionId.
    const sample = [
      '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-27T17:43:49Z","sessionId":"s-1","content":"do the thing"}',
      '{"type":"ai-title","sessionId":"s-1","title":"Do the thing"}',
      '{"type":"last-prompt","sessionId":"s-1","lastPrompt":"do the thing"}',
      '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"do the thing"},"uuid":"u-1","timestamp":"2026-09-27T17:43:50Z","sessionId":"s-1"}',
    ];
    expect(adapter.detect(sample)).toBe(true);
    expect(detectAdapterFromLines(sample)).toBeInstanceOf(ClaudeCodeAdapter);
    // Even a sample that never reaches a turn is recognisable by its envelope
    expect(adapter.detect(sample.slice(0, 2))).toBe(true);
    // A truncated (unparseable) line in the sample doesn't break detection
    expect(adapter.detect([sample[3].slice(0, 40), sample[3]])).toBe(true);
  });
});

describe('GenericAdapter', () => {
  const adapter = new GenericAdapter();

  it('maps loose role/text field names', () => {
    const msg = adapter.parseLine('{"speaker":"human","text":"hello"}');
    expect(msg?.role).toBe('user');
    expect(msg?.content).toBe('hello');
  });

  it('rejects lines with no content-ish field', () => {
    expect(adapter.parseLine('{"foo":1}')).toBeNull();
  });
});

describe('adapter registry & detection', () => {
  it('resolves adapters by name and rejects unknown names', () => {
    expect(getAdapter('openai')).toBeInstanceOf(OpenAIAdapter);
    expect(() => getAdapter('nope')).toThrow(/Unknown adapter/);
  });

  it('prefers the most specific matching format', () => {
    const strict = JSON.stringify({
      id: 'm1',
      role: 'user',
      content: 'hi',
      timestamp: '2026-06-09T10:00:00Z',
    });
    expect(detectAdapterFromLines([strict])).toBeInstanceOf(JsonlAdapter);

    const cc = '{"type":"user","message":{"role":"user","content":"hi"}}';
    expect(detectAdapterFromLines([cc])).toBeInstanceOf(ClaudeCodeAdapter);

    const oa = '{"role":"user","content":"hi"}';
    expect(detectAdapterFromLines([oa])).toBeInstanceOf(OpenAIAdapter);
  });
});

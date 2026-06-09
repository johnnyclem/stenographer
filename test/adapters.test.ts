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

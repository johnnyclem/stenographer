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

describe('Claude Code record kinds (IDX-08)', () => {
  const adapter = new ClaudeCodeAdapter();
  const record = (fields: Record<string, unknown>, content: unknown) =>
    JSON.stringify({
      parentUuid: 'u-0',
      isSidechain: false,
      type: 'user',
      uuid: `u-${Math.random().toString(36).slice(2)}`,
      timestamp: '2026-09-27T17:44:00Z',
      sessionId: 's-1',
      message: { role: 'user', content },
      ...fields,
    });

  it('maps a tool_result-only user record to role tool, tagged tool_result', () => {
    const msg = adapter.parseLine(
      record({ toolUseResult: { stdout: '...' } }, [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: '# ADR-004\nWe decided to use MongoDB for the event store.\nActually, this ADR was later rejected.',
        },
      ])
    )!;
    expect(msg.role).toBe('tool');
    expect(msg.tags).toEqual(['tool_result']);
    // Still searchable
    expect(msg.content).toContain('MongoDB');
  });

  it('keeps a user record with prose as a user turn, without the tool output', () => {
    const msg = adapter.parseLine(
      record({}, [
        { type: 'tool_result', tool_use_id: 't1', content: 'we decided to use MongoDB' },
        { type: 'text', text: 'looks good, carry on' },
      ])
    )!;
    expect(msg.role).toBe('user');
    expect(msg.tags).toBeUndefined();
    expect(msg.content).toBe('looks good, carry on');
  });

  it('tags isMeta, sidechain and compact-summary records', () => {
    const meta = adapter.parseLine(
      record({ isMeta: true }, 'Caveat: The messages below were generated by the user while running local commands.')
    )!;
    expect(meta.role).toBe('user');
    expect(meta.tags).toEqual(['meta']);

    const command = adapter.parseLine(
      record({}, '<command-name>/clear</command-name>\n<command-message>clear</command-message>')
    )!;
    expect(command.tags).toEqual(['meta']);

    const side = adapter.parseLine(record({ isSidechain: true }, "Subagent task: let's use yarn for installs"))!;
    expect(side.tags).toEqual(['sidechain']);

    const summary = adapter.parseLine(
      record({ isCompactSummary: true }, 'This session is being continued from a previous conversation...')
    )!;
    expect(summary.tags).toEqual(['compact_summary']);

    const sideResult = adapter.parseLine(
      record({ isSidechain: true }, [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }])
    )!;
    expect(sideResult.role).toBe('tool');
    expect(sideResult.tags).toEqual(['tool_result', 'sidechain']);
  });

  it('leaves an ordinary user turn untagged', () => {
    const msg = adapter.parseLine(record({}, "let's use redis for the cache"))!;
    expect(msg.role).toBe('user');
    expect(msg.tags).toBeUndefined();
  });
});

describe('Anthropic logs with string content (IDX-09)', () => {
  const lines = [
    JSON.stringify({ role: 'user', content: 'Bump the log budget' }),
    JSON.stringify({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'edit_file', input: { path: 'config.ts', new_string: 'LOG_BUDGET = 30' } }],
    }),
    JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Updating config' },
        { type: 'tool_use', id: 't2', name: 'bash', input: { cmd: 'npm test' } },
      ],
    }),
    JSON.stringify({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '12 passed' }] }),
  ];

  it('keeps every tool_use block whichever chat adapter the first line selects', () => {
    // The first line alone can't tell OpenAI from Anthropic
    for (const adapter of [detectAdapterFromLines(lines.slice(0, 1)), new OpenAIAdapter(), new AnthropicAdapter()]) {
      const toolOnly = adapter.parseLine(lines[1]);
      expect(toolOnly?.toolCalls).toEqual([
        { name: 'edit_file', input: { path: 'config.ts', new_string: 'LOG_BUDGET = 30' } },
      ]);
      const mixed = adapter.parseLine(lines[2]);
      expect(mixed?.content).toBe('Updating config');
      expect(mixed?.toolCalls).toEqual([{ name: 'bash', input: { cmd: 'npm test' } }]);
      const result = adapter.parseLine(lines[3]);
      expect(result?.role).toBe('tool');
      expect(result?.tags).toEqual(['tool_result']);
    }
  });

  it('detects a log with any block-array line as anthropic', () => {
    expect(detectAdapterFromLines(lines)).toBeInstanceOf(AnthropicAdapter);
  });

  it('still reads OpenAI tool_calls and created timestamps', () => {
    const msg = new AnthropicAdapter().parseLine(
      JSON.stringify({
        role: 'assistant',
        content: null,
        created: 1760000000,
        tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"tokyo"}' } }],
      })
    );
    expect(msg?.toolCalls).toEqual([{ name: 'get_weather', input: { city: 'tokyo' } }]);
    expect(msg?.timestamp).toBe(new Date(1760000000 * 1000).toISOString());
  });
});

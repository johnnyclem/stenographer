import { describe, it, expect } from 'vitest';
import { ImportanceDetector, extractStructure, extractEntities } from '../src/indexer/importance.js';
import type { ConversationMessage } from '../src/types.js';

const msg = (content: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: `m_${Math.random().toString(36).slice(2)}`,
  role: 'user',
  content,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe('ImportanceDetector', () => {
  const detector = new ImportanceDetector();

  it('scores decisions higher than chit-chat', () => {
    const decision = detector.score(msg("we decided to use postgres for storage"), []);
    const chitchat = detector.score(msg('ok sounds good'), []);

    expect(decision.total).toBeGreaterThan(chitchat.total);
    expect(decision.stateDelta).toBeGreaterThan(0);
  });

  it('flags corrections as state changes', () => {
    const score = detector.score(msg('actually, the port should be 5433'), []);
    expect(score.stateDelta).toBeGreaterThanOrEqual(0.7);
  });

  it('counts tool calls toward state delta', () => {
    const score = detector.score(
      msg('running the query', { role: 'assistant', toolCall: { name: 'sql', input: {} } }),
      []
    );
    expect(score.stateDelta).toBeGreaterThanOrEqual(0.3);
  });

  it('detects topic shifts as trajectory discontinuity', () => {
    const history = [msg('a'), msg('b'), msg('c')];
    const score = detector.score(msg('by the way, can we talk about deployment'), history);
    expect(score.trajectoryDiscontinuity).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps total within [0, 1]', () => {
    const score = detector.score(
      msg("actually, we decided to use postgres. by the way, let's use redis too", {
        toolCall: { name: 'x', input: {} },
      }),
      [msg('postgres'), msg('postgres again'), msg('more postgres')]
    );
    expect(score.total).toBeLessThanOrEqual(1);
    expect(score.total).toBeGreaterThan(0);
  });
});

describe('extractStructure', () => {
  it('extracts decisions', () => {
    const result = extractStructure(msg('we decided to use postgres for the database'));
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.decisions[0]).toContain('postgres');
  });

  it('extracts corrections', () => {
    const result = extractStructure(msg('actually, the timeout should be 30 seconds'));
    expect(result.corrections.length).toBeGreaterThan(0);
  });

  it('extracts entities without throwing', () => {
    const result = extractStructure(msg("we're using redis for caching"));
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities[0].name).toBe('redis');
  });
});

describe('extractEntities', () => {
  it('pulls entity names from known patterns', () => {
    expect(extractEntities("we're using postgres for storage")).toContain('postgres');
    expect(extractEntities('nothing interesting here')).toEqual([]);
  });
});

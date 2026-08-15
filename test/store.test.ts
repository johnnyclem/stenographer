import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/store/index.js';

describe('StateStore', () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const sampleMessage = (id: string, overrides: Partial<Parameters<StateStore['addMessage']>[0]> = {}) => ({
    id,
    sessionId: 'session_test',
    role: 'user',
    content: `message ${id}`,
    timestamp: new Date().toISOString(),
    embedding: [0.1, 0.2, 0.3],
    importanceScore: { total: 0.5, stateDelta: 0.5, referenceFrequency: 0, trajectoryDiscontinuity: 0 },
    entityIds: ['postgres'],
    ...overrides,
  });

  it('stores and retrieves messages with embeddings', () => {
    store.addMessage(sampleMessage('m1'));
    const messages = store.getMessagesBySession('session_test');

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
    expect(messages[0].embedding[0]).toBeCloseTo(0.1);
    expect(messages[0].entityIds).toEqual(['postgres']);
  });

  it('is idempotent on duplicate message ids', () => {
    store.addMessage(sampleMessage('m1'));
    store.addMessage(sampleMessage('m1', { content: 'updated' }));

    const messages = store.getMessagesBySession('session_test');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });

  it('limits recent messages and orders newest first', () => {
    for (let i = 0; i < 5; i++) {
      store.addMessage(sampleMessage(`m${i}`, { timestamp: new Date(2026, 0, 1, 0, i).toISOString() }));
    }
    const recent = store.getRecentMessages('session_test', 2);
    expect(recent.map((m) => m.id)).toEqual(['m4', 'm3']);
  });

  it('upserts entities and increments reference counts', () => {
    const entity = {
      id: 'postgres',
      type: 'database',
      value: 'postgres',
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
      references: 1,
    };
    store.upsertEntity(entity);
    store.upsertEntity({ ...entity, lastSeen: '2026-01-02T00:00:00Z' });

    store.addMessage(sampleMessage('m1', { entityIds: ['postgres'] }));
    const entities = store.getEntities('session_test');

    expect(entities).toHaveLength(1);
    expect(entities[0].references).toBe(2);
    expect(entities[0].lastSeen).toBe('2026-01-02T00:00:00Z');
  });

  it('does not return entities whose id is merely a substring of a referenced one', () => {
    store.upsertEntity({
      id: 'sql',
      type: 'extracted',
      value: 'sql',
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
      references: 1,
    });
    store.upsertEntity({
      id: 'postgresql',
      type: 'extracted',
      value: 'postgresql',
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
      references: 1,
    });
    // Only "postgresql" is actually referenced — "sql" is a substring of it
    // but was never mentioned on its own, so a LIKE-based join would
    // incorrectly pull it in too.
    store.addMessage(sampleMessage('m1', { entityIds: ['postgresql'] }));

    const entities = store.getEntities('session_test');
    expect(entities.map((e) => e.id)).toEqual(['postgresql']);
  });

  it('stores and retrieves relations', () => {
    store.upsertRelation({
      from: 'postgres',
      to: 'api',
      relation: 'co_mentioned',
      firstSeen: '2026-01-01T00:00:00Z',
      lastSeen: '2026-01-01T00:00:00Z',
    });
    // Duplicate upsert only bumps last_seen
    store.upsertRelation({
      from: 'postgres',
      to: 'api',
      relation: 'co_mentioned',
      firstSeen: '2026-01-03T00:00:00Z',
      lastSeen: '2026-01-03T00:00:00Z',
    });

    const relations = store.getRelations();
    expect(relations).toHaveLength(1);
    expect(relations[0].firstSeen).toBe('2026-01-01T00:00:00Z');
    expect(relations[0].lastSeen).toBe('2026-01-03T00:00:00Z');
  });

  it('stores decisions and tombstones and reports stats', () => {
    store.addMessage(sampleMessage('m1'));
    store.addDecision('session_test', { id: 'd1', description: 'use postgres' });
    store.addTombstone('session_test', {
      id: 't1',
      superseded: 'use mysql',
      correctedTo: 'use postgres',
      reason: 'performance',
    });

    expect(store.getActiveDecisions('session_test')).toHaveLength(1);
    expect(store.getTombstones('session_test')).toHaveLength(1);

    const stats = store.getStats('session_test');
    expect(stats).toEqual({ messagesIndexed: 1, entities: 0, decisions: 1, tombstones: 1 });
  });
});

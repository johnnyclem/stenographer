import { describe, it, expect } from 'vitest';
import { GraphRAGRetriever, buildVectorCypher, buildGraphCypher } from '../src/indexer/graphrag.js';
import type { ConversationMessage, EntityNode } from '../src/types.js';

const msg = (id: string, content: string): ConversationMessage => ({
  id,
  role: 'user',
  content,
  timestamp: new Date().toISOString(),
  sessionId: 'session_test',
});

const entity = (id: string, type = 'tech'): EntityNode => ({
  id,
  type,
  value: id,
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
  references: 1,
});

describe('GraphRAGRetriever', () => {
  it('indexes messages and finds them by semantic search', async () => {
    const retriever = new GraphRAGRetriever();
    await retriever.indexMessage(msg('m1', 'we use postgres for the main database'));
    await retriever.indexMessage(msg('m2', 'the deploy pipeline runs on github actions'));

    const results = await retriever.search({ query: 'postgres database', k: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('m1');
  });

  it('brings in messages that mention entities reachable from the query, with the path as evidence', async () => {
    const retriever = new GraphRAGRetriever();
    retriever.indexEntity(entity('postgres'));
    retriever.indexEntity(entity('pgbouncer'));
    retriever.indexRelation('postgres', 'pgbouncer', 'uses');
    await retriever.indexMessage(msg('m1', 'connection pooling sits in front of the primary'), undefined, {
      entityIds: ['pgbouncer'],
    });
    await retriever.indexMessage(msg('m2', 'lunch at noon'));

    const results = await retriever.search({ query: 'tell me about postgres', k: 10 });

    // Only messages are ranked; entities and paths are evidence on them
    expect(results.every((r) => r.type === 'message')).toBe(true);
    expect(results[0].id).toBe('m1');
    expect(results[0].meta.matchedEntities).toEqual(['pgbouncer']);
    // Depth 1 from the query's entity: no outgoing edge of its own to show
    expect(results[0].meta.paths).toEqual([]);

    const direct = await retriever.search({ query: 'tell me about pgbouncer', k: 1 });
    expect(direct[0].id).toBe('m1');
  });

  it('matches query entities as whole words', async () => {
    const retriever = new GraphRAGRetriever();
    retriever.indexEntity(entity('cache'));
    await retriever.indexMessage(msg('m1', 'lunch at noon'), undefined, { entityIds: ['cache'] });
    const results = await retriever.search({ query: 'is the cached value stale', k: 1 });
    expect(results[0]?.meta.matchedEntities ?? []).toEqual([]);
  });

  it('deduplicates repeated relations', () => {
    const retriever = new GraphRAGRetriever();
    retriever.indexEntity(entity('a'));
    retriever.indexRelation('a', 'b', 'uses');
    retriever.indexRelation('a', 'b', 'uses');

    expect(retriever.getStats().relations).toBe(1);
  });

  it('reports stats', async () => {
    const retriever = new GraphRAGRetriever();
    await retriever.indexMessage(msg('m1', 'hello'));
    retriever.indexEntity(entity('postgres'));
    retriever.indexRelation('postgres', 'api', 'serves');

    expect(retriever.getStats()).toEqual({ vectors: 1, entities: 1, relations: 1 });
  });
});

describe('cypher builders', () => {
  it('builds a vector index query', () => {
    const cypher = buildVectorCypher([0.1, 0.2], 'embeddings_index', 3);
    expect(cypher).toContain("db.index.vector.queryNodes('embeddings_index', 3");
    expect(cypher).toContain('[0.1,0.2]');
  });

  it('escapes quotes in entity ids', () => {
    const cypher = buildGraphCypher(["o'brien"], 2);
    expect(cypher).toContain("\\'");
    expect(cypher).toContain('*1..2');
  });
});

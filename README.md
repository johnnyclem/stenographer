# Stenographer 🤖

> MCP court reporter with GraphRAG — queryable conversation index for AI agents

**Version:** 0.1.0-alpha.2

Stenographer is an MCP server that watches your conversation logs and builds a queryable index. Think of it as a court reporter sitting in the room — it doesn't participate, but it's always listening and ready to answer questions.

## What's New in 0.1.0-alpha.2

- **GraphRAG Search** — Hybrid vector similarity + graph traversal
- **Local Embeddings** — ONNX-based (all-MiniLM-L6-v2), no API keys
- **Contextual Ranking** — Merges vector and graph results with weighted scoring

## The Stack

```
Stenographer (MCP) ──► short-hand ──► AgentVault Wiki
    ↑                          ↑
    └──────── smallchat ────────┘
```

See [Agent Stack](https://github.com/johnnyclem/stenographer) for the full ecosystem.

## Install

```bash
npm install @stenographer/core
```

## Quick Start

```bash
# Start watching a conversation log
npx stenographer start ./conversation.jsonl
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_recent_messages` | Get N most recent messages |
| `get_entities` | Get all extracted entities |
| `get_decisions` | Get active decisions |
| `get_corrections` | Get all corrections/tombstones |
| **`search_conversation`** | **GraphRAG semantic search** |
| `get_context_frame` | Build token-budgeted context |
| `get_status` | Get statistics |

## GraphRAG Search

The `search_conversation` tool performs **hybrid retrieval**:

1. **Vector Search** — Semantic similarity on message embeddings
2. **Entity Extraction** — Find relevant entities from query
3. **Graph Traversal** — Expand to related entities (configurable depth)
4. **Merge & Re-rank** — Weighted combination of vector + graph scores
5. **Context Enrichment** — Add neighboring messages as context

```typescript
// Example: Semantic search via MCP
{
  "name": "search_conversation",
  "arguments": {
    "query": "what database did we decide to use",
    "k": 5,
    "graph_depth": 2
  }
}
```

Returns ranked results with scores, types (message/entity/path), and context.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     JSONL Log File                          │
└─────────────────────────┬───────────────────────────────────┘
                          │ tail
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                       Tailer                                │
│              Watches file, parses messages                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌─────────────────────┐         ┌─────────────────────────┐
│ Importance Detector │         │  Local Embedder         │
│  3-signal scoring   │         │  (all-MiniLM-L6-v2)    │
└─────────┬───────────┘         └───────────┬─────────────┘
          │                                 │
          ▼                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                   GraphRAG Retriever                        │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐   │
│  │Vector Index │  │Entity Index│  │Relation Index    │   │
│  │(in-memory)  │  │(entities) │  │(graph edges)     │   │
│  └──────┬───────┘  └─────┬──────┘  └────────┬─────────┘   │
│         │                │                  │              │
│         └────────────────┼──────────────────┘              │
│                          ▼                                 │
│              ┌────────────────────────┐                     │
│              │  Hybrid Search Engine │                     │
│              │  (merge + re-rank)    │                     │
│              └────────────────────────┘                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     MCP Server                               │
│              Queryable tools for the LLM                     │
└─────────────────────────────────────────────────────────────┘
```

## Neo4j Integration (Coming Soon)

Future versions will support Neo4j for persistent graph storage:

```typescript
// Cypher queries for Neo4j integration
const vectorCypher = buildVectorCypher(embedding, 'message_embeddings', 5);
const graphCypher = buildGraphCypher(['entity1', 'entity2'], 2);
```

## Development

```bash
npm install
npm run build
npm test
```

## Credits

Built from @johnnyclem's tools:
- [smallchat](https://github.com/johnnyclem/smallchat) — Tool dispatch
- [short-hand](https://github.com/johnnyclem/short-hand) — Context compaction
- [agentvault](https://github.com/johnnyclem/agentvault) — Wiki + deployment

Inspired by:
- [Neo4j GraphRAG Python](https://github.com/neo4j/neo4j-graphrag-python)
- Andrej Karpathy's LLM Wiki pattern

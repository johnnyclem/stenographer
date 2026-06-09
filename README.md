# Stenographer 🤖

> MCP court reporter with GraphRAG — queryable conversation index for AI agents

**Version:** 0.1.0-alpha.2

Stenographer is an MCP server that watches your conversation logs and builds a queryable index. Think of it as a court reporter sitting in the room — it doesn't participate, but it's always listening and ready to answer questions.

## Features

- **GraphRAG Search** — Hybrid vector similarity + graph traversal
- **Real Local Embeddings** — all-MiniLM-L6-v2 via `@xenova/transformers` (~25MB model, downloaded once, runs fully locally, no API keys). Offline hashed-lexical fallback when the model can't load, or opt in with `--embeddings hashed`.
- **Persistent Vector Index** — `sqlite-vec` KNN index in the same SQLite file as everything else (brute-force cosine fallback if the extension can't load)
- **Decision Supersession (Tombstones)** — decisions are append-only; a newer decision or an "actually, …" correction closes the old record onto its successor, keeping full provenance
- **Four Modes** — `live`, `catchup`, `watch` (a directory of session logs), `daemon` (live + REST API)
- **Provider Adapters** — `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`, auto-detected from file content
- **Two Query Surfaces** — MCP over stdio, REST over HTTP (GraphQL: roadmap)

## Install

```bash
npm install @stenographer/core
```

## Quick Start

```bash
# Tail a conversation log and serve MCP over stdio
npx stenographer start ./conversation.jsonl

# Daemon mode: also serve the REST API on :8787
npx stenographer start ./conversation.jsonl ./state.db --mode daemon

# Watch a directory of Claude Code session logs
npx stenographer start ~/.claude/projects/myproj --mode watch --adapter claude-code

# Index a completed log once (no file watcher)
npx stenographer start ./finished.jsonl --mode catchup

# Fully offline (no model download)
npx stenographer start ./conversation.jsonl --embeddings hashed
```

Options: `--mode live|catchup|watch|daemon`, `--adapter jsonl|claude-code|anthropic|openai|generic`, `--embeddings <model|hashed>`, `--rest-port <port>`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_recent_messages` | Get N most recent messages |
| `get_entities` | Get all extracted entities |
| `get_relations` | Get entity-graph edges |
| `get_decisions` | Get active (non-superseded) decisions |
| `get_decision_history` | Full decision history including superseded versions |
| `get_decision_chain` | Walk one supersession chain, oldest → current |
| `get_corrections` | Get all corrections/tombstones |
| **`search_conversation`** | **GraphRAG hybrid semantic search** |
| `search_similar` | Pure vector search over the persistent index |
| `get_context_frame` | Build token-budgeted context |
| `get_status` | Statistics, vector backend, mode |

## REST API (daemon mode or `--rest-port`)

```
GET /status                  GET /decisions
GET /messages?n=10           GET /decisions/history
GET /entities                GET /decisions/:id/chain
GET /relations               GET /tombstones
GET /search?q=...&k=5        GET /graphrag?q=...&k=5&depth=2
GET /context-frame?budget=2000
```

## Decision Supersession

Decisions are never deleted — they're **closed onto their successor**. A tombstone records the current version of a fact with its provenance; currency is inherently overridable.

```
"we decided to use postgres for the main database"     (m1)
"actually, we decided to use sqlite — local-first"     (m3)
```

produces:

- decision A (postgres): `superseded: true`, `supersededBy: B`, `sourceMessageId: m1`
- decision B (sqlite): active, `sourceMessageId: m3`
- a tombstone: what was superseded, what corrected it, why, and the triggering message

Matching uses embedding similarity (`supersedeThreshold`, default 0.45, calibrated for MiniLM: rewrites of the same decision score ~0.46–0.94, unrelated decisions ~0.06). `get_decision_chain` walks any chain oldest → current.

## GraphRAG Search

The `search_conversation` tool performs **hybrid retrieval**:

1. **Vector Search** — Semantic similarity on message embeddings
2. **Entity Extraction** — Find relevant entities from query
3. **Graph Traversal** — Expand to related entities (configurable depth)
4. **Merge & Re-rank** — Weighted combination of vector + graph scores
5. **Context Enrichment** — Add neighboring messages as context

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│            JSONL Log File(s) — any supported format          │
└─────────────────────────┬───────────────────────────────────┘
                          │ tail (live/catchup/watch/daemon)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Tailer + Provider Adapter (auto-detected)       │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Core Engine (StenographerAPI)               │
│  Importance Detector → Structure Extraction → Embedder      │
│  Decision supersession (tombstones, provenance chains)      │
│  GraphRAG retriever (entity graph + in-memory vectors)      │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│      SQLite: messages, decisions, tombstones, entities,      │
│      relations + sqlite-vec persistent vector index          │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌──────────────────────────────┬──────────────────────────────┐
│        MCP Server (stdio)    │     REST API (daemon)        │
└──────────────────────────────┴──────────────────────────────┘
```

## Roadmap

- **The Agent Stack** — warm-state handoff to [short-hand](https://github.com/johnnyclem/short-hand) (compaction), [smallchat](https://github.com/johnnyclem/smallchat) (tool dispatch), [agentvault](https://github.com/johnnyclem/agentvault) (deployment). See `wiki/` for the ground-truth/roadmap split.
- **Tier 1.5 extraction** — local model (Gemma) for high-importance messages, gated by `extractionThreshold`
- **GraphQL** query surface
- **Neo4j** persistent graph backend (Cypher builders ship today: `buildVectorCypher`, `buildGraphCypher`)
- **Agent profiles** — per-agent-type importance weights

## Development

```bash
npm install
npm run build
npm test
```

## Credits

Inspired by:
- [Neo4j GraphRAG Python](https://github.com/neo4j/neo4j-graphrag-python)
- Andrej Karpathy's LLM Wiki pattern

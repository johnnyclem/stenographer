# Stenographer 🤖

[![CI](https://github.com/johnnyclem/stenographer/actions/workflows/ci.yml/badge.svg)](https://github.com/johnnyclem/stenographer/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha.2-orange)](https://github.com/johnnyclem/stenographer/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> MCP court reporter with GraphRAG — a queryable conversation index for AI agents

Stenographer is an MCP server that watches your conversation logs and builds a queryable index in real time. Think of it as a court reporter sitting in the room: it doesn't participate in the conversation, but it's always listening, and it can answer questions about everything that's been said — who decided what, when they changed their mind, and why.

Point it at a JSONL log, and it gives your agent stack a semantic memory: entities, decisions, corrections, and hybrid vector+graph search, all backed by a local SQLite file — no external services required.

## Why Stenographer

- **Passive by design** — it never writes back to the conversation or takes actions; it only observes and indexes, so it's safe to attach to any agent loop.
- **Decisions don't just vanish when an agent changes its mind** — supersession chains keep the old answer, the new answer, and the provenance linking them, instead of silently overwriting history.
- **Runs fully local** — embeddings, vector search, and storage all happen on-disk with no API keys and no network calls (see [Offline mode](#offline-mode)).
- **Two ways in** — MCP over stdio for agent tool calls, REST over HTTP for everything else (dashboards, scripts, curl).

## Features

- **GraphRAG Search** — hybrid vector similarity + entity-graph traversal, merged and re-ranked in one query
- **Real Local Embeddings** — `all-MiniLM-L6-v2` via `@xenova/transformers` (~25MB model, downloaded once, runs fully locally, no API keys). Offline hashed-lexical fallback when the model can't load, or opt in explicitly with `--embeddings hashed`
- **Persistent Vector Index** — `sqlite-vec` KNN index in the same SQLite file as everything else (brute-force cosine fallback if the extension can't load)
- **Importance Scoring** — a three-signal model (state delta, reference frequency, trajectory discontinuity) flags which messages matter, so retrieval and context-framing can prioritize signal over noise
- **Decision Supersession (Tombstones)** — decisions are append-only; a newer decision or an "actually, …" correction closes the old record onto its successor, keeping full provenance
- **Four Modes** — `live`, `catchup`, `watch` (a directory of session logs), `daemon` (live + REST API)
- **Provider Adapters** — `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`, auto-detected from file content
- **Two Query Surfaces** — MCP over stdio, REST over HTTP (GraphQL: roadmap)

## Requirements

- Node.js >= 20

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

### CLI Options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `-m, --mode` | `live` \| `catchup` \| `watch` \| `daemon` | `live` | `live`: tail a file and serve MCP. `catchup`: index a completed file, then serve. `watch`: watch a directory for `*.jsonl` session logs. `daemon`: live + REST API |
| `-a, --adapter` | `jsonl` \| `claude-code` \| `anthropic` \| `openai` \| `generic` | auto-detect | Log format adapter |
| `-e, --embeddings` | model name \| `hashed` | `Xenova/all-MiniLM-L6-v2` | Transformer model, or the offline lexical embedder (see [Offline mode](#offline-mode)) |
| `--rest-port` | port number | `8787` in daemon mode, off otherwise | Serve the REST API on this port |
| `--rest-host` | hostname/IP | `127.0.0.1` | Interface for the REST API to bind to. The API has no authentication, so it stays loopback-only unless you explicitly opt into wider exposure (e.g. `0.0.0.0` behind a trusted network boundary) |

Positional args: `stenographer start <log-path> [state-path]` — `state-path` defaults to `./stenographer.db`.

### Offline mode

By default, Stenographer downloads a ~25MB embedding model on first run and does everything else locally after that — no ongoing network calls, no API keys, ever. If you need to skip even that one-time download, pass `--embeddings hashed` to use an offline hashed-lexical embedder instead; the same fallback kicks in automatically if the transformer model fails to load.

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
GET /relations                GET /tombstones
GET /search?q=...&k=5        GET /graphrag?q=...&k=5&depth=2
GET /context-frame?budget=2000
```

There's no authentication on these routes, so the server binds to `127.0.0.1` by default — pass `--rest-host` if you deliberately want it reachable from elsewhere.

## Importance Scoring

Every indexed message gets a three-signal importance score, used to prioritize what surfaces in search results and context frames:

| Signal | Weight | What it captures |
|--------|--------|-------------------|
| **State delta** | 45% | Decisions, corrections, and tool calls — moments where conversation state actually changed |
| **Trajectory discontinuity** | 30% | Topic shifts and length deviation from the recent baseline |
| **Reference frequency** | 25% | How often the message's entities have been referenced recently |

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

- **The Agent Stack** — warm-state handoff to [short-hand](https://github.com/johnnyclem/short-hand) (compaction), [smallchat](https://github.com/johnnyclem/smallchat) (tool dispatch), [agentvault](https://github.com/johnnyclem/agentvault) (deployment). This is a design target, not shipped code — see `wiki/` for the ground-truth/roadmap split and [`docs/ecosystem/`](./docs/ecosystem/executive-summary.md) for a source-verified evaluation of what's actually wired today.
- **Tier 1.5 extraction** — local model (Gemma) for high-importance messages, gated by `extractionThreshold`
- **GraphQL** query surface
- **Neo4j** persistent graph backend (Cypher builders ship today: `buildVectorCypher`, `buildGraphCypher`)
- **Agent profiles** — per-agent-type importance weights

## Development

```bash
npm install
npm run build   # tsc (core) + tsc -p tsconfig.cli.json (CLI)
npm test        # vitest
npm run lint    # tsc --noEmit
```

Tests live in [`test/`](./test), covering the core engine, GraphRAG retriever, embeddings, importance scoring, provider adapters, the tailer, the SQLite store, and the REST API.

## Contributing

Issues and pull requests are welcome. Before opening a PR, make sure `npm run lint`, `npm test`, and `npm run build` all pass.

## License

[MIT](./LICENSE)

## Credits

Inspired by:
- [Neo4j GraphRAG Python](https://github.com/neo4j/neo4j-graphrag-python)
- Andrej Karpathy's LLM Wiki pattern

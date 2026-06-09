---
title: Stenographer
date: 2026-06-09
tags: [llm, context, streaming, indexing, observer, mcp, graphrag]
sources: [stenographer repo (ground truth), project specification draft (roadmap)]
---

# Stenographer

> A streaming companion observer for continuous conversation indexing.

**Version:** 0.1.0-alpha.2
**Author:** Johnny Clem

**Stenographer** is a background process that continuously reads conversation output (JSONL log files) and maintains a running semantic index — without participating in the conversation.

Think of a **court stenographer**: they don't argue cases, they don't make decisions. They produce a structured, indexed, queryable record of everything that was said. That's the model.

---

## Current State (ground truth of the repo)

Everything in this section is implemented and tested in the repository as of 2026-06-09.

### Pipeline

| Stage | What It Does |
|-------|--------------|
| 1. Parse & Normalize | Provider adapter → ConversationMessage |
| 2. Score Importance | Three-signal model (regex Tier 0) |
| 3. Extract Structure | Regex patterns: entities, decisions, corrections |
| 4. Embed | 384-dim transformer (all-MiniLM-L6-v2 via @xenova/transformers), offline hashed-lexical fallback |
| 5. Persist | SQLite (better-sqlite3) + sqlite-vec vector index |

### Modes

- **live** — tail a single JSONL file, serve MCP over stdio
- **catchup** — index a completed file once (no watcher), then serve
- **watch** — watch a directory; every `*.jsonl` file becomes its own session
- **daemon** — live + REST API (default port 8787)

### Adapters

`jsonl` (native schema), `claude-code` (session logs), `anthropic` (content-block messages), `openai` (chat format incl. tool_calls), `generic` (best-effort field mapping). Auto-detected from file content when not specified.

### Importance Scoring (Three-Signal Model)

- **State delta (45%)** — decisions, corrections, tool calls
- **Reference frequency (25%)** — how often the message's entities were referenced recently
- **Trajectory discontinuity (30%)** — topic-shift indicators, length deviation

### Decisions, Tombstones, Supersession

Decisions are **append-only with a supersession chain**. A tombstone does not bind a conclusion forever — it records the *current version* of a fact with its provenance, and currency is inherently overridable:

- A new decision (or an "actually, …" correction) whose embedding is close enough to an active decision **closes** the old record: `superseded = true`, `superseded_by → successor`. Close means "we have a fresher version", not "this died".
- The old record is never deleted; it keeps its provenance (`source_message_id`, timestamp).
- A tombstone row records each supersession event: what was superseded, what it was corrected to, why, and the message that triggered it.
- The chain is walkable from any link (`get_decision_chain`); the last entry is the current version.

### Query Surface

One engine (`Stenographer` class, implements `StenographerAPI`) exposed two ways:

**MCP tools (stdio):** `get_recent_messages`, `get_entities`, `get_relations`, `get_decisions`, `get_decision_history`, `get_decision_chain`, `get_corrections`, `search_conversation` (GraphRAG hybrid), `search_similar` (persistent vector index), `get_context_frame`, `get_status`

**REST (daemon mode or `--rest-port`):** `/status`, `/messages`, `/entities`, `/relations`, `/decisions`, `/decisions/history`, `/decisions/:id/chain`, `/tombstones`, `/search`, `/graphrag`, `/context-frame`

### GraphRAG Search

`search_conversation` merges vector similarity with entity-graph traversal (co-mention edges, BFS to configurable depth), re-ranks with weighted scores, and enriches results with temporally neighboring messages.

---

## Roadmap (aspirational — not yet built)

Everything below is design intent carried forward from the original specification. None of it exists in the repo today.

### The Stack

```
Stenographer (real-time index)
    ↓ warm state
Short-hand (compaction)
    ↓ context
Smallchat (tool dispatch)
    ↓ execution
AgentVault (deployment)
```

The `@shorthand/core` dependency and warm-start handoff to the compactor are unimplemented. See [[short-hand]], [[smallchat]], [[agentvault]].

### Tier 1.5 Extraction: Local Model (Gemma)

Model-based structured extraction for high-importance messages (~20-30%), replacing/augmenting the regex Tier 0:

| Model | Size | Speed |
|-------|------|-------|
| Gemma E2B | ~1.5 GB | ~50 tok/s |
| Gemma E4B | ~3 GB | ~30 tok/s |

The `extractionThreshold` config key is reserved for gating this.

### Agent Profiles

Custom importance weights + extraction per agent type (coding, paralegal, image-gen).

### Integration Patterns

1. **Middleware** — intercept LLM requests, replace raw history with context frame
2. **SDK Wrapper** — transparently manage context
   (MCP tool integration is the one pattern that exists today.)

### Other roadmap items

- GraphQL query surface (REST + MCP exist today)
- Neo4j persistent graph backend (Cypher builders exist; no driver/connection)
- `getCompactedState(level)` compaction-level API from the original spec
- Cross-session entity resolution and tombstone truth-base semantics shared with [[short-hand]]
- Performance targets (sub-10ms message latency without model; memory budgets)

## Related

- [[short-hand]] — Post-hoc compaction (roadmap integration)
- [[smallchat]] — Tool dispatch (roadmap integration)
- [[agentvault]] — Deployment (roadmap integration)

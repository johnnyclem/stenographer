---
title: Stenographer
date: 2026-04-08
tags: [llm, context, streaming, indexing, observer]
sources: [Project specification draft]
---

# Stenographer

> A streaming companion observer for continuous conversation indexing.

**Version:** 0.1.0-draft
**Author:** Johnny Clem
**Depends on:** `@shorthand/core`

## What It Is

**Stenographer** is a background process that continuously reads conversation output (JSONL log file) and maintains a running semantic index — without participating in the conversation.

Think of a **court stenographer**: they don't argue cases, they don't make decisions. They produce a structured, indexed, queryable record of everything that was said. That's the model.

## Why Not Just Compact After the Fact?

Post-hoc compaction works (that's what [[short-hand]] does), but it's **batch-oriented**. You have to wait for the conversation to end (or a breakpoint) before compaction runs.

Stenographer operates in **real time** — by the time a compaction pass is needed, Stenographer has already built the entity graph, scored importance, and identified corrections. The compactor can use Stenographer's state as a **warm start** instead of processing from raw messages.

## Architecture

```
┌─────────────────────────────────────┐
│ HOST PROCESS                        │
│ User ←→ Host LLM → conversation.jsonl │
└─────────────────────────────────────┘
              (file tail)
┌─────────────────────────────────────┐
│ STENOGRAPHER PROCESS               │
│                                    │
│ JSONL Tailer → Message Parser       │
│                          ↓        │
│                 Importance Detector │
│                          ↓        │
│                 Entity Graph (State) │
│                          ↓        │
│                 SQLite Sidecar      │
│                          ↓        │
│                 Query Interface     │
└─────────────────────────────────────┘
```

## Five-Stage Pipeline

| Stage | What It Does |
|-------|--------------|
| 1. Parse & Normalize | JSONL → ConversationMessage |
| 2. Embed | 384-dim vector (ONNX all-MiniLM-L6-v2) |
| 3. Score Importance | Three-signal model |
| 4. Extract Structure | Regex (Tier 0) or Gemma (Tier 1.5) |
| 5. Persist | SQLite sidecar |

## Importance Scoring (Three-Signal Model)

- **State delta (45%)** — Does message change entity graph?
- **Reference frequency (25%)** — How often are entities referenced later?
- **Trajectory discontinuity (30%)** — Does message shift conversation direction?

## Query Interface

```typescript
interface StenographerAPI {
  getCompactedState(level: CompactionLevel): Promise<CompactedState>;
  getImportantMessages(n: number): Promise<ImportanceScore[]>;
  getEntityGraph(): Promise<{ nodes: EntityNode[]; edges: EntityRelation[] }>;
  getActiveDecisions(): Promise<Decision[]>;
  getTombstones(): Promise<Tombstone[]>;
  searchSimilar(query: string, k: number): Promise<ScoredMessage[]>;
  buildContextFrame(tokenBudget: number): Promise<ContextFrame>;
  getStatus(): Promise<StenographerStatus>;
}
```

## Local Model: Gemma 4

Only invoked for high-importance messages (~20-30%):

| Model | Size | Speed |
|-------|------|-------|
| Gemma 4 E2B | ~1.5 GB | ~50 tok/s |
| Gemma 4 E4B | ~3 GB | ~30 tok/s |

Why Gemma:
- Apache 2.0 license (no commercial restrictions)
- Native JSON output
- Native function calling
- 128K context window

## Agent Profiles

Custom importance weights + extraction per agent type:

- **Coding** — architecture, bugs, tests (stateDelta: 50%)
- **Paralegal** — cases, deadlines (referenceFrequency: 35%)
- **Image Gen** — styles, corrections (trajectoryDiscontinuity: 50%)

## Integration Patterns

1. **Middleware** (recommended) — intercepts LLM requests, replaces raw history with context frame
2. **MCP Tool** — host LLM queries via tool calls
3. **SDK Wrapper** — transparently manages context

## Implementation Phases

| Phase | Features |
|-------|----------|
| v0.1.0 | Core pipeline, JSONL tailer, embedding, SQLite (2-3 weeks) |
| v0.2.0 | Query server, context frames (2 weeks) |
| v0.3.0 | Gemma integration, agent profiles (3 weeks) |
| v0.4.0 | Daemon mode, cross-session (3 weeks) |
| v0.5.0 | Resilience, provider portability (2 weeks) |

## Performance Targets

| Metric | Target |
|--------|--------|
| Message latency (no model) | < 10ms |
| Message latency (with model) | < 500ms |
| Memory (no model) | < 100 MB |
| Memory (E2B) | < 1.7 GB |

## The Full Stack

```
Stenographer (real-time index)
    ↓ warm state
Short-hand (compaction)
    ↓ context
Smallchat (tool dispatch)
    ↓ execution
AgentVault (deployment)
```

## Related

- [[short-hand]] — Post-hoc compaction
- [[smallchat]] — Tool dispatch
- [[agentvault]] — Deployment
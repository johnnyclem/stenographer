---
title: Short-hand
date: 2026-04-08
tags: [llm, context, memory, compaction]
sources: [github.com/johnnyclem/short-hand]
---

# Short-hand

> Progressive context compaction for LLMs. Old computer science for new constraints.

## What It Is

**Short-hand** uses an **LSM-tree inspired architecture** to progressively compact conversation history across five levels, reducing token usage while preserving critical information.

## The Problem

Long conversations with LLMs accumulate context that eventually hits token limits. Naive truncation loses important information (decisions, corrections, entity relationships).

## Five-Level Architecture

| Level | Name | Contents | Fidelity |
|-------|------|----------|----------|
| L0 | Memtable | Raw recent messages | Verbatim |
| L1 | Compacted | Noise-stripped, deduplicated | High |
| L2 | Summaries | Topic-clustered with entity/decision extraction | Medium |
| L3 | Graph | Entity-relationship knowledge graph | Structural |
| L4 | Invariants | Core facts that must survive indefinitely | Minimal |

Messages enter L0 → progressively compact to deeper levels. When building context frame: **L4 → L0** (invariants first, recent last) within token budget.

## Key Features

### Tombstones
When a correction is detected ("Actually, we're using Postgres, not MySQL"), short-hand creates a tombstone tracking superseded info. Prevents stale facts from resurfacing.

### Importance Scoring (Three-Signal Model)
- **State delta (45%)** — Does message change entity graph or override prior info?
- **Reference frequency (25%)** — How often are message's entities referenced later?
- **Trajectory discontinuity (30%)** — Does message shift conversation direction?

### CRDTs for Multi-Agent
- `LWWRegister` — Last-Writer-Wins for L4 invariants
- `ORSet` — Observed-Remove Set for L3 entities
- `GSet` — Grow-Only Set for L2 summaries

### Safety & Recall
- `InvariantChecker` — Verify five safety invariants against compacted state
- `RecallTester` — Generate quiz questions, evaluate recall score

### Compaction Tiers
| Tier | Strategy | Status |
|------|----------|--------|
| 0 | Regex | Stable (zero deps) |
| 1 | Local LM | Planned (ONNX) |
| 2 | Host LLM | Planned |

## Usage

```typescript
const engine = new CompactionEngine({
  memtableSize: 10,
  contextBudget: 4000,
});

await engine.addMessage(message);
await engine.flush();
const frame = engine.buildContextFrame(2000);
// frame.sections: L4 invariants → L3 graph → L2 summaries → L1 compacted → L0 raw
```

## Related

- Complements [[smallchat]] — short-hand manages context, smallchat manages tool dispatch

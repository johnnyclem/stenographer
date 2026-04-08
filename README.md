# Agent Stack 🦞

> A complete agent memory stack — from real-time context to persistent knowledge

Inspired by Andrej Karpathy's LLM Wiki pattern. Built from @johnnyclem's tools.

## The Problem

AI agents need memory at multiple timescales:

- **Right now** — What are we working on? What did we decide?
- **This session** — Fit everything in the context window
- **Across sessions** — What do we know from all our conversations?

## The Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Stenographer (MCP)                       │
│             Court reporter — queryable in-flight            │
│         "What have we decided about the database?"          │
└─────────────────────────┬───────────────────────────────────┘
                          │ warm state
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      short-hand                              │
│           Progressive context compaction (LSM-tree)         │
│              L0 → L1 → L2 → L3 → L4                         │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentVault Wiki                            │
│          Persistent knowledge base (Karpathy pattern)       │
│              Ingest → Synthesize → Query → Lint             │
└─────────────────────────────────────────────────────────────┘
                          ▲
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                      smallchat                               │
│            Semantic tool dispatch (Obj-C inspired)          │
└─────────────────────────────────────────────────────────────┘
```

## Components

| Component | Scope | Access | Description |
|-----------|-------|--------|-------------|
| **Stenographer** | Current session | MCP tool | Real-time conversation index. Queryable during conversation. |
| **short-hand** | Current session | Library | LSM-tree compaction. Progressive compression L0→L4. |
| **AgentVault Wiki** | Cross-session | CLI | Karpathy LLM Wiki pattern. Sources → synthesis → persistent pages |
| **smallchat** | Runtime | Library | Semantic tool dispatch. Intent → tool via vector similarity |

## Quick Start

```bash
# Clone and explore
git clone https://github.com/johnnyclem/agent-stack.git
cd agent-stack

# Read the wiki
cat wiki/index.md
cat wiki/stenographer.md
cat wiki/short-hand.md
cat wiki/agentvault.md
```

## Docs

- [Stenographer](./wiki/stenographer.md) — MCP court reporter
- [short-hand](./wiki/short-hand.md) — Context compaction
- [AgentVault Wiki](./wiki/agentvault.md) — Persistent knowledge
- [smallchat](./wiki/smallchat.md) — Tool dispatch

## Credits

Built from @johnnyclem's tools:
- https://github.com/johnnyclem/smallchat
- https://github.com/johnnyclem/short-hand
- https://github.com/johnnyclem/agentvault

Inspired by Andrej Karpathy's LLM Wiki:
- https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

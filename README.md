# Stenographer 🤖

> MCP court reporter — queryable conversation index for AI agents

**Version:** 0.1.0-alpha.1

Stenographer is an MCP server that watches your conversation logs and builds a queryable index. Think of it as a court reporter sitting in the room — it doesn't participate, but it's always listening and ready to answer questions.

## Why

AI agents need memory at multiple timescales:

- **Right now** — "What are we working on? What did we decide?"
- **This session** — "Fit everything in the context window"
- **Across sessions** — "What do we know from all our conversations?"

Stenographer handles **right now** — fast, in-flight queries via MCP.

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

Stenographer will:
1. Tail the JSONL file in real-time
2. Extract entities, decisions, and corrections
3. Score message importance
4. Expose MCP tools for queries

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_recent_messages` | Get N most recent messages |
| `get_entities` | Get all extracted entities |
| `get_decisions` | Get active decisions |
| `get_corrections` | Get all corrections/tombstones |
| `search_conversation` | Semantic search (coming soon) |
| `get_context_frame` | Build token-budgeted context |
| `get_status` | Get statistics |

## Usage in Code

```typescript
import { StenographerServer } from '@stenographer/core';

const server = new StenographerServer({
  logPath: './conversation.jsonl',
  statePath: './stenographer.db',
  mode: 'live',
});

await server.start();
// MCP server is now running and queryable
```

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
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Importance Detector                        │
│        Three-signal scoring (state, reference, trajectory) │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      State Store                            │
│            SQLite: messages, entities, decisions           │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     MCP Server                               │
│              Queryable tools for the LLM                     │
└─────────────────────────────────────────────────────────────┘
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

Inspired by Andrej Karpathy's LLM Wiki pattern.

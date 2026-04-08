---
title: Smallchat
date: 2026-04-08
tags: [ai-agents, tools, mcp, compiler]
sources: [github.com/johnnyclem/smallchat]
---

# Smallchat

> Object-oriented inference. A tool compiler for the age of agents.

## What It Is

Smallchat solves the **context window bloat** problem. When your agent has 50+ tools, passing all of them to the LLM every turn burns tokens and degrades selection accuracy. Smallchat compiles your tools into a **dispatch table** that resolves intent semantically at runtime.

## Core Idea

Inspired by **Smalltalk/Objective-C runtime**:
- **Tools are objects**
- **Intents are messages**
- **Dispatch is semantic** (vector similarity + caching + superclass traversal)

The LLM says what it wants → runtime figures out which tool handles it. No routing code, no tool selection prompts.

## CLI Commands

| Command | Description |
|---------|-------------|
| `compile` | Compile manifests into dispatch artifact |
| `serve` | Start MCP-compatible server |
| `resolve` | Test intent-to-tool resolution |
| `init` | Scaffold new project |
| `repl` | Interactive testing shell |

## Packages

- `@smallchat/core` — Runtime, compiler, CLI
- `@smallchat/react` — React hooks
- `@smallchat/nextjs` — Next.js integration
- `@smallchat/testing` — Testing utilities
- `smallchat-vscode` — VS Code extension

## Why It Matters

Traditional approach: Stuff all tools into context →LLM picks one → waste
Smallchat approach: LLM expresses intent → semantic dispatch → microseconds

## See Also

- [Architecture doc](https://github.com/johnnyclem/smallchat/blob/main/ARCHITECTURE.md)
- [Reference](https://github.com/johnnyclem/smallchat/blob/main/docs/REFERENCE.md)
- Website: [smallchat.dev](https://smallchat.dev)

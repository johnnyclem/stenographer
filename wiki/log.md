# Wiki Log

Append-only chronological record of wiki activity.

## [2026-04-08] init | Wiki system created

- Created `wiki/` directory structure
- Created `SCHEMA.md` with layer definitions and workflows
- Created `index.md` as content catalog
- Inspired by Karpathy's LLM Wiki pattern: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## [2026-04-08] ingest | smallchat

- Fetched repo info from github.com/johnnyclem/smallchat
- Created source note: `wiki/raw/sources/smallchat.md`
- Created wiki page: `wiki/wiki/smallchat.md`
- Updated index.md
- Summary: Tool compiler for AI agents - compiles tools into dispatch tables using object-oriented inference (Smalltalk/Obj-C inspired)

## [2026-04-08] ingest | short-hand

- Fetched repo info from github.com/johnnyclem/short-hand
- Created source: `wiki/raw/sources/short-hand.md`
- Created wiki page: `wiki/wiki/short-hand.md`
- Summary: Progressive context compaction for LLMs using 5-level LSM-tree architecture (L0 memtable → L4 invariants)

## [2026-04-08] ingest | agentvault

- Fetched repo info from github.com/johnnyclem/agentvault
- Created source: `wiki/raw/sources/agentvault.md`
- Created wiki page: `wiki/wiki/agentvault.md`
- Summary: Persistent on-chain AI agent platform - deploy to ICP canisters for 24/7 execution with multi-chain wallet support

## [2026-04-08] ingest | stenographer (project spec)

- Created from project specification draft (Johnny Clem)
- Created source: `wiki/raw/sources/stenographer.md`
- Created wiki page: `wiki/wiki/stenographer.md`
- Summary: Streaming companion observer for real-time conversation indexing. Background process that tails JSONL, builds entity graph, scores importance, provides warm start for short-hand compaction. Uses Gemma 4 for structured extraction.

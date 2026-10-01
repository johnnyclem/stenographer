# Stenographer 🤖

[![CI](https://github.com/johnnyclem/stenographer/actions/workflows/ci.yml/badge.svg)](https://github.com/johnnyclem/stenographer/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](./CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> MCP court reporter with GraphRAG — a queryable conversation index for AI agents

Stenographer is an MCP server that watches your conversation logs and builds a queryable index in real time. Think of it as a court reporter sitting in the room: unless you ask it to object, it doesn't participate in the conversation, but it's always listening, and it can answer questions about everything that's been said — who decided what, when they changed their mind, and why.

Point it at a JSONL log, and it gives your agent stack a semantic memory: entities, decisions, corrections, and hybrid vector+graph search, all backed by a local SQLite file — no external services required.

On top of the index sits an asserted-truth ledger. When a fact goes stale (a config value bumped, a class deleted), a person signs a tombstone (TB) for the dead value; agents can draft one, but only a person signs it. Stenographer then objects when an agent writes the dead value again, and the optional [pre-dispatch gate](#pre-dispatch-gate) can refuse the tool call before it runs.

Upgrading from 0.1.0-alpha.x? Read [MIGRATION.md](./MIGRATION.md); every change is in the [CHANGELOG](./CHANGELOG.md).

## Why Stenographer

- **Observes by default** — indexing never writes into the conversation or runs anything. Two opt-in paths act on it: `--objections deliver` pushes objections to the attached MCP client and receivers you configure, and `stenographer gate` in `--mode enforce` denies tool calls (see [Real-time objections](#real-time-objections)).
- **Decisions don't just vanish when an agent changes its mind** — supersession chains keep the old answer, the new answer, and the provenance linking them, instead of silently overwriting history.
- **Runs locally** — embeddings, vector search, and storage all happen on disk with no API keys. The network is used once, to download the embedding model (never with `--embeddings hashed`, see [Offline mode](#offline-mode)), and for objection receivers you configure, which must be loopback unless a sink opts in with `allowRemote`.
- **Several ways in** — MCP over stdio for agent tool calls, REST over HTTP for dashboards and scripts, and CLI commands for the notary, the gate and ledger verification.

## Features

- **GraphRAG Search** — messages ranked by reciprocal rank fusion of vector similarity, entity-graph evidence and recency, with an importance prior; the graph evidence comes back with each result
- **Real Local Embeddings** — `all-MiniLM-L6-v2` via `@huggingface/transformers` (~25MB model, downloaded once, runs fully locally, no API keys), or the offline hashed-lexical embedder with `--embeddings hashed`. The state database is pinned to the embedder that wrote it (see [Offline mode](#offline-mode))
- **Persistent Vector Index** — `sqlite-vec` KNN index (cosine, partitioned by session, long messages in overlapping windows) in the same SQLite file as everything else (brute-force cosine fallback if the extension can't load)
- **Importance Scoring** — a three-signal model (state delta, reference frequency, trajectory discontinuity) scores each message; GraphRAG search uses it as a ranking prior and context frames use it to choose which recent messages get room
- **Decision Supersession (Tombstones)** — decisions are append-only; a newer decision or an "actually, …" correction closes the old record onto its successor, keeping full provenance. Only what people and the assistant said is mined: tool output, harness records, subagent transcripts and compaction summaries are indexed and searchable, but never read as decisions
- **Four Modes** — `live`, `catchup`, `watch` (a directory of session logs), `daemon` (live + REST API)
- **Provider Adapters** — `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`, auto-detected from the first lines written (a log created empty waits for its first line)
- **Resumable Ingestion** — a per-log checkpoint commits with each message, so a restart picks up where the last run stopped instead of re-reading the log (see [Restarts and log rotation](#restarts-and-log-rotation))
- **Two Query Surfaces** — MCP over stdio, REST over HTTP (GraphQL: roadmap)
- **Asserted truth ledger** — signed tombstones (TBs) and unverified assertions (UVs) with evidence, in an append-only, hash-chained ledger whose statuses are derived from links (see [Asserted Truth Layer](#asserted-truth-layer-tbuv-v2))
- **Agent and operator profiles** — the default `agent` MCP profile drafts and never signs; signing, overrides, rulings and wiki import live in the `operator` profile, the REST notary routes and `stenographer notarize` (see [Notarization, identity and the threat model](#notarization-identity-and-the-threat-model))
- **Ledger verification** — `stenographer verify` re-checks the hash chain and every derived status; `start` refuses a ledger that fails (see [Ledger integrity](#ledger-integrity))
- **Team wiki** — ledgers sync through append-only, hash-chained JSONL in [truth format v2](./spec/truth-format/README.md), which short-hand, smallchat and smallchat-swift also read (see [Team wiki](#team-wiki-the-truth-format))
- **Real-time objections** — when assistant output asserts a tombstoned literal, an objection with the TB as its exhibit: recorded in shadow by default, delivered to Claude Code, smallchat or a webhook with `--objections deliver` (see [Real-time objections](#real-time-objections))
- **Pre-dispatch gate** — `stenographer gate`, a Claude Code `PreToolUse` hook that denies a Write, Edit or Bash call reintroducing a tombstoned literal before it runs, with the TB as the exhibit (see [Pre-dispatch gate](#pre-dispatch-gate))
- **OpenAPPA integration** — a policy battery for every MCP tool, and a context provider that tells OpenAPPA's annotators which TB literals a proposed call asserts (see [OpenAPPA battery](#openappa-battery) and [OpenAPPA context provider](#openappa-context-provider))

## Guarantees and where they stop

Each guarantee below states the property that is enforced, and where it stops. The linked sections give the details.

| Guarantee | What is enforced | Where it stops |
|---|---|---|
| **Agents draft, people sign** | In the `agent` profile (the default), no MCP tool mints an active TB, signs with a person's name, or overrides, strikes, dismisses or rules. Those tools aren't served there, and the ledger refuses a resolution that would mint a TB. | Anything that runs as the operator's user can act as the operator: read `STENOGRAPHER_NOTARY_SECRET` or the REST token, edit the MCP config to `--profile operator`, write the SQLite file, or drive `stenographer notarize` through a pseudo-terminal. `--allow-agent-assert` lets the agent assert TBs under its own identity. ([Threat model](#notarization-identity-and-the-threat-model)) |
| **Server-bound identity** | Agent-profile writes carry `--agent-identity` (default `agent:<MCP client name>`) and the server's session id; tool arguments can't name anyone. | Operator paths take the signer's name from the caller. `--signer-registry` is an allowlist, not authentication: whoever reaches an operator path can use any listed person's name. Key-based signing is planned for 1.x. |
| **Contempt of corpus** | A verification, signature or refutation is refused when its actor shares the target's author, signer, drafter or session, comparing identities after Unicode normalization and case-folding. | It compares names and sessions. One person writing under two unlisted names isn't caught. |
| **Append-only, tamper-evident ledger** | Entries are inserted, never updated. Status is derived from links. Every entry is hash-chained (SHA-256 over RFC 8785 JSON), and `stenographer verify` (and `start`, before serving) detects an entry or link that was edited, reordered, or inserted or deleted anywhere but the end, and a cached status its links don't justify. | Deleting the newest entries, or rewriting from some entry on and recomputing every later hash, is caught only by comparing with a head hash kept outside the state file. The chain shows *that* the ledger changed, not *who* wrote an entry. ([Ledger integrity](#ledger-integrity)) |
| **Idempotent ingestion** | A log line and everything derived from it commit in one SQLite transaction with the log's checkpoint, so a restart resumes after the last applied line and re-reading a line derives nothing twice. | Within one state database. Ids for formats without their own (`openai`, `anthropic`, `generic`) hash the log path, offset and line, so the same line in a different file is a different message. ([Restarts](#restarts-and-log-rotation)) |
| **Objections and the gate** | Only TBs that declare `literals` object. Matching is by exact token within a clause, over what a tool call asserts. The gate in `enforce` mode denies a matching Write, Edit, MultiEdit, NotebookEdit or Bash call within its time budget. | Precision over recall: paraphrases, values computed at runtime, content a tool's input doesn't carry, and shell commands the classifier misreads get through. Objections arrive after the write; the gate is a guardrail against accidents, not a security boundary, and anyone who can edit `settings.json` can remove it. ([Pre-dispatch gate](#pre-dispatch-gate)) |
| **Team wiki** | Import is all-or-nothing and admits each line like a live write. A TB lands as truth only when it is a hash-chained v2 line and signed (by a listed signer, with a registry). The chain shows lines unchanged and complete up to the last one read. | The chain doesn't show who wrote a line, or that trailing lines were removed. Without a registry, any accountable name is accepted. ([Team wiki](#team-wiki-the-truth-format)) |
| **REST access** | Every route checks the `Host` (DNS rebinding), a cross-site `Origin`, and a bearer token, and binds to 127.0.0.1 by default. | A process running as you can read the token file. `--rest-insecure` drops the token. ([REST API](#rest-api-daemon-mode-or---rest-port)) |
| **OpenAPPA battery** | In an OpenAPPA-protected session, every ledger write but a draft needs a trusted session, and acts in a person's name need that person's approval. | Only with OpenAPPA 0.30.0 and the battery installed. The REST API and the terminal notary are outside it. ([OpenAPPA battery](#openappa-battery)) |
| **Extraction quality** | Precision and recall on a labeled corpus are floored in CI (0.95 / 0.90). | The corpus is a 46-turn development set, not a benchmark. Extraction is pattern-based. |

## Requirements

- Node.js >= 22

## Install

```bash
npm install @stenographer/core
```

## Quick Start

```bash
# Tail a conversation log and serve MCP over stdio (agent profile)
npx -y @stenographer/core start ./conversation.jsonl

# Daemon mode: also serve the REST API on :8787 (bearer token in ./rest-token)
npx -y @stenographer/core start ./conversation.jsonl ./state.db --mode daemon

# Watch a directory of Claude Code session logs
npx -y @stenographer/core start ~/.claude/projects/myproj --mode watch --adapter claude-code

# Index a completed log once (no file watcher)
npx -y @stenographer/core start ./finished.jsonl --mode catchup

# Fully offline (no model download)
npx -y @stenographer/core start ./conversation.jsonl --embeddings hashed

# Check the truth ledger's hash chain and statuses
npx -y @stenographer/core verify ./stenographer.db
```

Once `@stenographer/core` is installed, the binary is `stenographer` (`node_modules/.bin/stenographer`). An unscoped `npx stenographer` runs a different npm package.

In an MCP client config (Claude Code's `.mcp.json`, for example):

```json
{
  "mcpServers": {
    "stenographer": {
      "command": "npx",
      "args": ["-y", "@stenographer/core", "start", "./conversation.jsonl", "./stenographer.db"]
    }
  }
}
```

### CLI Options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `-m, --mode` | `live` \| `catchup` \| `watch` \| `daemon` | `live` | `live`: tail a file and serve MCP. `catchup`: index a completed file, then serve. `watch`: watch a directory for `*.jsonl` session logs. `daemon`: live + REST API |
| `-a, --adapter` | `jsonl` \| `claude-code` \| `anthropic` \| `openai` \| `generic` | auto-detect | Log format adapter |
| `-e, --embeddings` | model name \| `hashed` \| `auto` | `Xenova/all-MiniLM-L6-v2` | Transformer model (fails to start if it can't load), the offline lexical embedder, or `auto`: the embedder the state database is pinned to, else the default model with a loud fallback to hashed (see [Offline mode](#offline-mode)) |
| `--reembed` | — | off | Re-embed every stored message and truth entry under the chosen embedder before starting. Needed to switch a state database to another embedder |
| `--supersede-threshold` | number in (0, 1] | per embedder: MiniLM `0.45`, hashed `0.75` | Cosine similarity at which a new decision supersedes an active one (see [Decision Supersession](#decision-supersession)) |
| `--rest-port` | port number | `8787` in daemon mode, off otherwise | Serve the REST API on this port |
| `--objections` | `off` \| `shadow` \| `deliver` | `shadow` | Real-time objections to tombstoned literals (see [Real-time objections](#real-time-objections)) |
| `--objection-channel` | URL (repeatable) | — | smallchat channel bridge to push each objection to as it's raised. Secret from `SMALLCHAT_CHANNEL_SECRET` |
| `--objection-webhook` | URL (repeatable) | — | Webhook for harnesses that can't be interrupted: objections arrive in batches. Standard Webhooks signing key from `STENOGRAPHER_WEBHOOK_SECRET` (at least 24 bytes) |
| `--objection-batch-size` | number | `3` | Batch size for `--objection-webhook` |
| `--no-mcp-channel` | — | — | Don't push objections to the attached MCP client as Claude Code channel events |
| `--profile` | `agent` \| `operator` | `agent` | Which MCP tools are served. `agent`: read tools plus drafting (`propose_tombstone`, `assert_uv`, a `resolve_uv` that can't mint TBs). `operator`: the judicial and destructive tools, for a notary UI or CLI a person drives — never an agent. See [Notarization, identity and the threat model](#notarization-identity-and-the-threat-model) |
| `--agent-identity` | identity | `agent:<MCP client name>` | Who agent-profile writes are attributed to. Tool arguments can't override it |
| `--allow-agent-assert` | — | off | Single-user opt-out: the agent profile also serves `assert_tombstone`, signed by the agent identity (never a person's name). Off, every agent-authored TB is notarized by a person |
| `--signer-registry` | path | — | JSON allowlist of signers and roles; operator paths (MCP operator profile, REST notary routes, `stenographer notarize`) accept only listed identities in a role that may act, and wiki import takes TBs and overrides only from listed signers |
| `--wiki-dir` | directory | `wiki/` next to the state file | Where `export_wiki_entries` and `import_wiki_entries` read and write. Files are named relative to it; absolute paths, `..`, symlinks out of it, non-`.jsonl` names and the state file are refused (see [Team wiki](#team-wiki-the-truth-format)) |
| `--rest-host` | hostname/IP | `127.0.0.1` | Interface for the REST API to bind to. The API serves transcripts, so it stays loopback-only unless you explicitly opt into wider exposure (e.g. `0.0.0.0` behind a trusted network boundary) |
| `--rest-allow-host` | host name (repeatable) | — | Also answer to this `Host` name. Loopback names and `--rest-host` always are; anything else gets 421 (see [REST API](#rest-api-daemon-mode-or---rest-port)) |
| `--rest-insecure` | — | off | Serve REST without a bearer token. Host and Origin checks still apply |
| `--skip-verify` | — | off | Serve even if the truth ledger fails its integrity check. By default `start` runs the same check as `stenographer verify` and refuses to serve a ledger that fails it (see [Ledger integrity](#ledger-integrity)) |

Positional args: `stenographer start <log-path> [state-path]` — `state-path` defaults to `./stenographer.db`.

### Restarts and log rotation

Each log has a checkpoint in the state database: the byte offset after the last indexed line, plus what identifies the file (device/inode and a hash of its first 4 KB). The checkpoint is written in the same SQLite transaction as the message and everything derived from it (entities, decisions, supersessions, proposals, objections), so after a crash or restart a line has either been applied completely or not at all, and indexing resumes right after the last applied line. A log keeps its session id across restarts.

Scope of the idempotency: within one state database, a line whose message id and content are already indexed is skipped for every derived record, whether it is re-read after a truncate-and-rewrite or copied into another session's log (the message moves to the newer session; nothing is re-derived). Decisions and supersession tombstones get ids hashed (128-bit) from the line they came from, and so do messages whose format has no id of its own (`openai`, `anthropic`, `generic`): log path, byte offset and line content. Two identical `continue` turns therefore stay two messages.

The tailer holds back a partially written line until its newline arrives (`catchup` indexes a final unterminated line but leaves the checkpoint before it). It strips a UTF-8 BOM. It waits for a log that doesn't exist yet. When a log is deleted it waits for the log to reappear (in `watch` mode it drops that session), and it follows the path through a rename rotation or atomic replace after draining the old file. If the file is truncated or rewritten, it reads it again from the top, where the lines it has already indexed are skipped. State databases record their schema version (`PRAGMA user_version`), migrate in place on start and run in WAL mode. One versioned runner migrates the whole file, the index tables and the truth layer (ledger, objections, delivery state) alike, and every opener (`start`, `verify`, `notarize`, the gate) refuses a database written by a newer stenographer instead of touching it.

### Offline mode

By default, Stenographer downloads a ~25MB embedding model on first run and does everything else locally after that — no ongoing network calls, no API keys, ever. If you need to skip even that one-time download, pass `--embeddings hashed` to use an offline hashed-lexical embedder instead. Hashed search is lexical (shared words and spellings), not semantic.

Vectors from two embedders aren't comparable, so the state database records the embedder that wrote it (model, width, version) and refuses to open under a different one, naming both. To switch, restart with the new `--embeddings` and `--reembed`, which recomputes every stored message and truth-entry vector. A model that fails to load is an error, not a silent switch to hashed. If you want the fallback, `--embeddings auto` opts in: it uses the embedder the database is already pinned to, or tries the default model and falls back to hashed with a warning on stderr (the database is then pinned to hashed). `get_status` and `GET /status` report the embedder in use.

## MCP Tools

A server runs one profile (`--profile`): `agent` (the default) serves 20 tools, 21 with `--allow-agent-assert`, and `operator` serves 28. The index tools below are served in both.

| Tool | Description |
|------|-------------|
| `get_recent_messages` | Get N most recent messages |
| `get_entities` | Get all extracted entities |
| `get_relations` | Get entity-graph edges |
| `get_decisions` | Get active (non-superseded) decisions |
| `get_decision_history` | Full decision history including superseded versions |
| `get_decision_chain` | Walk one supersession chain, oldest → current |
| `get_corrections` | Get the index's supersession tombstones (closed decisions; not ledger TBs) |
| **`search_conversation`** | **GraphRAG hybrid search: fused vector, entity-graph and recency ranks** (`k` ≤ 200) |
| `search_similar` | Pure vector search over the persistent index (`k` ≤ 200) |
| `get_context_frame` | Entities, active decisions and recent messages within a token budget |
| `get_status` | Statistics, version, vector backend, embedder, mode, profile and agent identity, objection stats |

### Truth-layer tools (TB/UV v2)

Which tools a server serves depends on its `--profile`. Every tool's arguments are validated against a strict schema before anything runs (unknown arguments, out-of-set enums and wrong types are rejected; limits are clamped), and the advertised `inputSchema` is derived from that same schema.

| Tool | Profile | Description |
|------|---------|-------------|
| `list_proposals` | both | The review inbox: drafted candidates awaiting a person's sign/dismiss |
| `get_verification_queue` | both | Open UVs ranked for opportunistic verification |
| `get_contested` | both | All TB+UV disputes |
| `get_truth` / `search_truth` | both | Truth entries by filter / by embedding relevance |
| `list_objections` | both | Real-time objections (objection + exhibit + transcript line); `includeShadow` for shadow judging |
| `propose_tombstone` | agent | Draft a TB (claim, evidence, literals, rationale); it's raised to a person and never mints until they notarize it. `targetRef` dedupes only against the same agent's open drafts |
| `assert_uv` | agent, operator | Assert an unverified belief with a machine-actionable `verifyBy`; `contests` disputes a TB. In the agent profile the author is the agent identity |
| `resolve_uv` | agent, operator | Verify/refute a UV with evidence. In the agent profile a resolution that would mint a TB (verifying a contest) is refused; in the operator profile it needs a person's `signedBy` and files a promotion ruling. Submitted `command` output is recorded as `claimed-command` and never signs for itself |
| `assert_tombstone` | operator (agent with `--allow-agent-assert`) | Direct TB, evidence required. With `--allow-agent-assert` it is signed by the agent identity |
| `sign_proposal` | operator | Notarize a proposal under a person's identity (`edits` supported) — signs agent drafts too |
| `dismiss_proposal` | operator | Dismiss with a required reason (kept as detector training data) |
| `override_tombstone` | operator | The force path: override a TB with a proven addendum |
| `file_ruling` | operator | Strike, promotion, or contempt ruling with a written opinion; any other `kind` is rejected |
| `rule_on_objection` | operator | Sustain or overrule an objection with a written opinion — files a `RULING` |
| `export_wiki_entries` / `import_wiki_entries` | operator | Team llm-wiki interop in [truth format v2](./spec/truth-format/README.md): export appends this ledger's hash-chained stream (state changes included) to its own file in `--wiki-dir`; import takes a teammate's file in one transaction |
| `backfill_legacy_tombstones` | operator | Phase-1 migration of pre-assertion supersessions |

Tools carry MCP annotations: read tools are `readOnlyHint`, and the ones that close, flip or strike records (`sign_proposal`, `dismiss_proposal`, `override_tombstone`, `file_ruling`, operator `resolve_uv`) are `destructiveHint`. Wiki export and import are append-only and `idempotentHint`: repeating one changes nothing.

## REST API (daemon mode or `--rest-port`)

```
GET /status                  GET /decisions
GET /messages?n=10           GET /decisions/history
GET /entities                GET /decisions/:id/chain
GET /relations                GET /tombstones
GET /search?q=...&k=5        GET /graphrag?q=...&k=5&depth=2
GET /context-frame?budget=2000
GET /flags?since=<id>&status=pending&include=shadow
GET /proposals?status=open&kind=tombstone

POST /proposals/:id/notarize  {notary, edits?}      X-Notary-Secret required
POST /proposals/:id/dismiss   {dismissedBy, reason} X-Notary-Secret required
POST /appa/context            OpenAPPA consult (kind: context), read-only
```

**Access.** The routes serve transcripts, including any secret someone pasted into a session, so every request is checked before anything is read:

- **Host** must be `localhost`, `127.0.0.1`, `[::1]`, the `--rest-host`, or a `--rest-allow-host` name; anything else gets `421`. This stops DNS rebinding, where a web page points its own hostname at 127.0.0.1 and reads the API as its own origin.
- **Origin**, when a browser sends one, must be on one of those hosts (`403` otherwise).
- **`Authorization: Bearer <token>`** is required on every route (`401` otherwise). The token is `STENOGRAPHER_REST_TOKEN` when set (at least 16 characters); otherwise stenographer generates one on first run into `rest-token` next to the state database, with mode 0600, prints that path on startup, and reuses it. `--rest-insecure` drops the token requirement (the Host and Origin checks stay). If the state database lives inside a repository, add `rest-token` to its `.gitignore`.

The notary routes need the bearer token and `X-Notary-Secret`. The token keeps out web pages, other users and other machines. It doesn't keep out processes running as you, which can read the token file, so treat it like the notary secret (see [the threat model](#notarization-identity-and-the-threat-model)). The notary routes check `notary`/`dismissedBy` like any operator path: canonicalized, never anonymous or reserved, and a registered person when `--signer-registry` is set (otherwise `422`). Their bodies take exactly what the operator profile's `sign_proposal` and `dismiss_proposal` take: `edits` holds only the draft's own fields, and any other field (a `signedBy`, say) is a `400`.

The server binds to `127.0.0.1` by default. Pass `--rest-host` if you deliberately want it reachable from elsewhere, plus `--rest-allow-host` for the name clients use.

Query parameters are validated: a malformed one (`k=abc`, `n=0`, an unknown `status`) gets `400`, and oversized counts are clamped (`k` ≤ 200, `n` ≤ 1,000, `depth` ≤ 5, `limit` ≤ 1,000, `budget` ≤ 100,000). The MCP tools clamp to the same bounds.

### OpenAPPA context provider

[OpenAPPA](https://github.com/archestra-ai/openappa) asks configured context providers about each proposed tool call before its annotator labels the call. `POST /appa/context` implements consult protocol v1 for `kind: "context"`. It takes `{version: 1, kind: "context", name, declaration: {}, artifact: {tool, arguments, cwd?}}` and answers `{version: 1, answer}`. The answer is `null` when the ledger has nothing to say. Otherwise it is `{about, hits}`, with one hit per tombstoned literal the call asserts:

```json
{ "tb_id": "01J…", "subject": "LOG_BUDGET", "dead": "30", "current": "100",
  "claim": "LOG_BUDGET 30 is dead; the budget is 100", "signer": "johnnyclem", "author": "johnnyclem",
  "status": "active", "argument": "command", "line": "printf 'LOG_BUDGET=30\\n' >> .env",
  "contested_by": [] }
```

The call is read exactly as the objection detector and [`stenographer gate`](#pre-dispatch-gate) read it: only the arguments that carry new content (a Write's `content`, the new side of an edit, the writing parts of a shell command, content-like fields of tools it doesn't know), matched by the same clause matcher. A search, a read, a commit message or the old side of an edit is not a hit, so a consult reports what the gate in `enforce` mode would deny. The tool may be named as the harness names it (`Bash`) or as OpenAPPA's runtime does (`host/claude-code/Bash`); an MCP tool (`mcp/<server>/<tool>`) is read through its content-like fields. A contested TB lists the open UVs that dispute it, with their authors. The answer is facts for the annotator, not a label. Whether a hit matters is the policy's call. The route is read-only and uses the same bearer token. Matching a consult has a 1 s budget: past it, the answer holds the hits found so far and a `note` naming the argument where reading stopped (an answer with no hits but a `note` is incomplete, not clean).

OpenAPPA's runtime also listens on `127.0.0.1:8787` by default, so run the daemon on another port next to it (for example `--rest-port 8789`) and point the binding there:

```toml
[externals.context.stenographer]
url = "http://127.0.0.1:8789/appa/context"
token_env = "APPA_STENOGRAPHER_TOKEN"   # the contents of <state dir>/rest-token
```

OpenAPPA asks context providers only for calls that need a new annotation, and only annotators read the answer, so this informs labeling. It doesn't block a call by itself; `stenographer gate` does. Bind it to a battery or annotator rule, never to a bare root rule for a built-in tool (see [`integrations/openappa/`](./integrations/openappa/README.md#do-not-bind-stenographer-annotators-to-broad-root-rules)).

## Importance Scoring

Every indexed message gets a three-signal importance score (stored with it). GraphRAG search adds it as a small prior to the fused rank, enough to lift a decision or correction over an equally relevant remark but not over a more relevant message, and the context frame gives room to the most important of the recent messages after the newest one. Pure vector search (`search_similar`) doesn't use it.

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

Matching uses embedding similarity at a threshold calibrated per embedder on [`test/fixtures/supersession-pairs.json`](./test/fixtures/supersession-pairs.json): MiniLM `0.45` (rewrites of one decision score 0.57–0.94, unrelated decisions 0.04–0.44) and hashed `0.75` (rewrites 0.84–0.93, unrelated 0.04–0.56). Other transformer models get 0.45 until you calibrate them with `--supersede-threshold`. Of two matching versions, the one with the later timestamp closes the other, whichever was indexed first. In `watch` mode, matching spans every session in the state database (each conversation is its own log); other modes match within the log's session. `get_decision_chain` walks any chain oldest → current.

What gets mined is a heuristic (Tier 0 patterns), applied sentence by sentence to user and assistant prose only, without code blocks, quoted lines or harness blocks. Each sentence yields at most one decision or correction. "Use X instead of Y", "X rather than Y", "X, not Y" and "not X but Y" record X as current and Y as what it replaces, unless the phrase is inside a quotation. Questions, first-person tool narration ("I'll use the Read tool to …") and narration of the next step ("Let me X instead of Y") are skipped. Claude Code tool results become role `tool` (tagged `tool_result`), and `isMeta`, slash-command, `isSidechain` and `isCompactSummary` records are tagged `meta`, `sidechain` and `compact_summary`. All of them stay searchable. Precision and recall are measured in CI on a labeled corpus ([`test/fixtures/extraction-corpus.json`](./test/fixtures/extraction-corpus.json), floors 0.95 and 0.90). It's a small development set, not a benchmark.

## Asserted Truth Layer (TB/UV v2)

The tombstone pipeline is split into **detection** (automatic, proposal-only) and **assertion** (accountable, signed). Machines detect; authors assert. Detectors (supersession, wiki reconciliation, proposal intake) only file `PROPOSAL`s, which become truth when someone signs them. The one exception is `backfill_legacy_tombstones`, an operator tool that turns 0.x auto-closed supersessions into TBs authored by `migration`, unsigned, without literals (so they never object), and queryable as second-class.

Five record types live in one append-only, hash-chained ledger (`truth_entries`, exported to wiki JSONL):

- **`TB`** — asserted tombstone: a prior statement is provably stale/wrong. Requires evidence and a signer.
- **`UV`** — unverified assertion ("there be dragons"): believed true, stated before verification exists, with a machine-actionable `verifyBy` hint.
- **`PROPOSAL`** — what the supersession detector now emits. Signing mints the TB/UV; dismissing costs nothing, so thresholds can be tuned for recall.
- **`ADDENDUM`** — evidence attached after the fact (UV resolutions, TB overrides).
- **`RULING`** — a signed judgment with a required written opinion: `strike` (inadmissible, never deleted), `promotion` (evidence ruled sufficient), `contempt` (self-corroboration called out — mints one conduct TB, no karma system), `dismissal` (a proposal declined, with the reason).

The ledger also writes `MARKER` entries about itself; today the only one is `chained-at-migration` (see [Ledger integrity](#ledger-integrity)).

**Status is derived, never stored.** A TB, UV or proposal's status is a fold over the links that point at it: `overrides` makes a TB overridden, and nothing takes that back; a TB is contested while at least one contesting UV is open; `verifies`/`refutes` resolve a UV; `signs`/`dismisses` close a proposal; `strikes` makes any entry struck. No write rewrites an entry — dismissing a proposal appends a `dismissal` ruling — so the ledger is append-only in the literal sense: rows are inserted, never updated. (A cached status column exists for queries; it is recomputed from links on every write and checked by `stenographer verify`.)

**Evidence.** A `command` a caller says it ran, with the output it says it saw, is a claim: it is recorded as `claimed-command`. Only a check stenographer executed itself would be recorded as `command` and sign for itself, and 1.0 ships no runner — so every resolution that mints a TB needs a person's signature and a promotion ruling.

**Override protocol** (force semantics): flipping an active TB requires either a contesting UV (`contests` — TB becomes `contested` but stays truth) or a proven addendum with evidence (`overrides`). Refuting a contest closes that contest only: an overridden TB stays overridden. The ledger's admission check enforces this on every append, live writes and wiki imports alike: there is no third path, and no path for anonymous writes. Generic identities (`system`, `assistant`, …) and identities with control characters are rejected, and `migration` and `detector:*` are reserved for the backfill and detector paths, as author and as signer. A program that writes the SQLite file directly bypasses the admission check; `stenographer verify` reports the change unless the writer recomputed the hash chain (see [Ledger integrity](#ledger-integrity)).

**Contempt of corpus**: corroboration must be provenance-independent (by name and session; it can't tell one person using two unlisted names). A `verifies`/`signs`/`refutes` whose actor — the resolver *and* any signer — shares the author, signer, drafter or agent session of its target is rejected at write time — three subagents affirming their parent's UV is one opinion wearing three hats. Identities compare canonically (Unicode NFKC, invisible characters removed, trimmed, case-folded), so `Alice`, ` alice ` and `ａｌｉｃｅ` are one person. Refuting a contest can return its TB to active, so the TB's own author, signer or drafter can't be the one to refute it (conceding, by verifying the contest, is allowed).

**Rollout** is governed by `truthMode` (`StenographerConfig.truthMode`; `stenographer start` has no flag for it and runs `shadow`):
- `shadow` (default, Phase 0): auto-close keeps working *and* every detection lands as a proposal — observe quality, tune.
- `assert` (Phase 1): auto-close is disabled; detection is proposal-only, and signing a proposal is what closes the superseded decision. `backfill_legacy_tombstones` migrates pre-assertion supersessions as queryably second-class TBs (`author: migration`).

Downstream consumers get the confidence type in every result, with the consumption rules embedded in the tool descriptions: active TB = ground truth; contested TB = truth with a visible asterisk; open UV = **flag, don't block**; refuted/overridden = history, never citable.

**Proposal intake** (`importProposalDrafts`, a library function; no MCP tool or CLI command runs it in 1.0): external tools — today [short-hand](https://github.com/johnnyclem/short-hand)'s compactor, which exports its L4 candidate invariants and detected corrections as draft JSONL — can file candidates into the ledger. Every line lands as a `PROPOSAL` under a detector identity (`detector:short-hand`); intake never writes a TB or UV itself, the detector cannot sign its own intake, and `targetRef` dedupe makes re-imports idempotent. This is the Option B seam from the TB/UV v2 handoff (§13 Q6): format-level interop, no code dependency in either direction. Lines are the suite's PROPOSAL envelope from [truth format v2](./spec/truth-format/README.md#the-proposal-envelope) — `{schemaVersion: 2, seq, type: "PROPOSAL", id, ts, author, kind: "tb"|"uv", draft, targetRef, signal: {source: "compaction-candidate"|"agent"|"detector:<name>"}, prevHash, hash}`, hash-chained like a wiki file and filed once per id, whatever became of it. The older dialects are still read: short-hand's bare `{kind, draft, signal: {source: "compaction-candidate"}}`, and the unversioned envelope with `signal.source: "shorthand-compaction"`. The envelope's own id, author, source and hash are kept under `meta.intake` for traceability; authorship stays with the detector identity.

### Notarization, identity and the threat model

Agents often find the dead value first — the config that was bumped, the class that was deleted. They can draft the tombstone, but a person signs it. Two mechanisms carry that: **tool profiles**, which decide what an MCP client can do at all, and **server-bound identity**, which decides whose name lands on each write.

**Profiles.** A stenographer MCP server runs one profile (`--profile`, default `agent`):

- **`agent`** — what you put in an agent's MCP config. Read tools, plus `propose_tombstone`, `assert_uv`, and a `resolve_uv` that refuses any resolution that would mint a TB. Nothing in this profile signs, notarizes, dismisses, overrides, strikes, rules, imports, or asserts a TB. Every path the 0.x audit found to mint a TB without a person — `sign_proposal` with edits, `resolve_uv` with `mintTombstone` or a verified contest, `file_ruling` with an unknown kind, `import_wiki_entries`, `assert_tombstone` — is either absent from this profile or refused by it.
- **`operator`** — for a notary UI or CLI that a person drives (smallchat-swift's approval view, a terminal). It serves `sign_proposal` (the notary act, which also signs agent drafts), `dismiss_proposal`, `override_tombstone`, `file_ruling`, `rule_on_objection`, `assert_tombstone`, wiki import/export and the backfill. Never give it to an agent.

`--allow-agent-assert` is the explicit opt-out for single-user setups: the agent profile also serves `assert_tombstone`. Those TBs are signed by the agent identity, never by a person's name. A `resolve_uv` that would mint a TB still needs a person's signature: evidence the agent submits, command output included, is a claim, not a check stenographer ran.

**Identity.** In the agent profile the server binds identity: every write carries `--agent-identity` (default `agent:<name the MCP client sent in clientInfo>`) and this server's session id. Agent tools take no `author`, `signedBy`, `proposedBy`, `dismissedBy` or `agentSessionId` argument; passing one is a validation error. Subagents that share the connection share the session, so they can't corroborate each other. Operator paths take the signer's name from the caller and check it: canonicalized, never anonymous or reserved (`migration`, `detector:*`), and — with `--signer-registry` — listed in a role that may act:

```json
{ "signers": [
    { "id": "johnnyclem", "role": "human", "aliases": ["johnny"] },
    { "id": "agent:*",    "role": "agent" } ] }
```

People sign, notarize, dismiss, override, strike and rule; agents draft and assert UVs. An alias resolves to its `id`, `agent:*` matches any identity with that prefix, and an agent identity the registry lists as a person is refused at startup.

**The notary flow.**

1. **Drafted.** `propose_tombstone` files a `PROPOSAL` marked `requiresNotary`, authored by the agent identity. `targetRef` dedupes only against the same agent's open drafts (the result says `dedupedInto`); it never folds a draft into someone else's proposal.
2. **Raised.** The draft goes to the same receivers as objections — smallchat's channel bridge (`meta.kind: "proposal"`, with a `notarize_url`) and operator webhooks (`type: "stenographer.proposal"`) — never to the attached MCP client, which is the drafter. It's also printed to stderr and stays in `GET /proposals?status=open`. Notices escape control characters and bidi overrides in whatever the agent wrote (as `\u001b`, `\r`, …), so a claim can't conceal or overwrite itself in a terminal or chat.
3. **Notarized.** A person approves or declines it through a path the agent profile doesn't serve:
   - REST `POST /proposals/:id/notarize` / `dismiss` with `X-Notary-Secret` — the secret in `STENOGRAPHER_NOTARY_SECRET`, shared with your approval UI (smallchat) and not with agents — and the REST bearer token, like every route. Unset, the notary routes answer 403.
   - `sign_proposal` / `dismiss_proposal` on an `--profile operator` server.
   - `stenographer notarize <id> --as <name> [--state <path>] [--signer-registry <path>]` (or `--decline "<reason>"`), which needs an interactive terminal and typing back a random code it prints there.
4. **Minted.** The TB is signed by the notary, keeps the draft's literals (so it can object immediately), and links back to the draft. Contempt of corpus still applies: the drafting identity can't notarize its own draft.

**What this protects, and what it doesn't.** The property: an agent whose only access to the ledger is an agent-profile MCP connection cannot mint an active TB, attach a person's name to anything, or neutralize a signed TB or an objection (override, strike, dismiss, rule). It can contest a TB with a UV, which marks the TB contested and leaves it truth. The boundary is the MCP connection:

- **Anything that can run commands or read files as the operator's user is the operator.** It can read `STENOGRAPHER_NOTARY_SECRET` from the environment of the process serving REST — usually the agent-spawned MCP server itself, configured in the agent host's MCP config — and the REST token from `<state dir>/rest-token`, edit that config to `--profile operator`, open the SQLite file directly, or drive `stenographer notarize` through a pseudo-terminal (`script`, `expect`): the typed code stops blind or pre-scripted approval, not a program that reads the terminal. Separating those needs OS-level separation: run the agent as another user or in a sandbox without access to the operator's config, environment, state file and terminal. Editing the SQLite file shows up in `stenographer verify` unless the editor recomputes the chain from the edit on; only a head hash kept outside the file catches that (see [Ledger integrity](#ledger-integrity)).
- **The signer registry is an allowlist, not authentication.** Whoever reaches an operator path can use any listed person's name; the registry stops typos, unlisted names, and agent identities on person-only acts. Key-based signing, where the notary signs with a key the server doesn't hold, is planned for 1.x.
- Without `--signer-registry`, operator paths accept any non-anonymous, non-reserved name, and `--agent-identity` accepts any non-reserved identity the operator configures.

### Ledger integrity

Every ledger entry is chained to the one before it, in insertion order: it stores `prevHash` (the previous entry's hash, `null` for the first) and `hash = sha256hex(JCS(entry))`, where the hashed entry is its id, type, timestamp, author, provenance, agent session, origin, body, target ref, the links its append wrote, and `prevHash`, canonicalized with JCS ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)). The cached status columns and embeddings are not hashed; status is re-derived instead.

```bash
stenographer verify ./stenographer.db          # exit 0 intact, 1 integrity failure, 2 could not run
stenographer verify ./stenographer.db --json   # the same report, machine-readable
```

`verify` walks the chain, checks that the link table holds exactly the links entries wrote, re-derives every status from links, and reports the first divergence. It prints the head hash. `stenographer start` runs the same check before serving and refuses a ledger that fails it; `--skip-verify` serves it anyway. The terminal notary won't sign onto a ledger that fails it.

What the chain shows, and what it doesn't:

- **Detected:** an edited entry (body, author, provenance, target ref, links), an entry or link inserted or deleted anywhere but the end, reordered entries, a row written around the ledger (e.g. by a pre-1.0 stenographer), and a cached status its links don't justify.
- **Not detected by the file alone:** deleting the newest entries, or rewriting everything from some entry on and recomputing the hashes — anyone who can write the file can do that. Record the head hash `verify` prints somewhere the state file isn't (a commit, a ticket, a teammate) and compare: a truncated or rewritten chain won't reproduce it.
- **Not signatures.** A hash chain shows *that* the ledger changed, not *who* wrote an entry. Key-based signing is planned for 1.x.

A pre-1.0 ledger is chained the first time a 1.0 stenographer opens it. Its rows are chained as they are, in insertion order, and a `MARKER` entry (`chained-at-migration`, author `migration`) closes the run: for those entries the chain attests to "unchanged since the migration", not "since written". Statuses are then re-derived from links; the marker lists any the 0.x bookkeeping had wrong (such as a TB that refuting a second contest had set back to active after it was overridden, STENO-T-06).

### Team wiki: the truth format

Teams share truth through JSONL files in a wiki directory (`--wiki-dir`), in [truth format v2](./spec/truth-format/README.md). short-hand, smallchat and smallchat-swift read the same format and run its golden fixtures. The spec is normative; in short:

- **One writer per file.** `export_wiki_entries({file: "<you>.jsonl"})` appends this ledger's line stream to a file of its own: the TBs and UVs, the addenda and rulings that change a status, and a `TRANSITION` line for every status change (contested, overridden, verified, refuted, struck). It appends only what the file lacks. It never truncates or rewrites a line, and it refuses a file that holds anyone else's lines. Teammates import each other's files.
- **Hash-chained.** Every line has `seq`, `prevHash` and `hash` (SHA-256 over the line's JCS form). Import refuses an edited line, a gap, or two writers' lines in one file. That shows the lines are unchanged and complete up to the last line read. It doesn't show who wrote them; key signatures are planned for 1.x.
- **Status is a fold.** A reader's current status for an entry is the status of the latest `TRANSITION` for it, else the entry line's own. An unknown or missing status is not current truth: readers fail closed.
- **Import is all-or-nothing, and validated like a live write.** `import_wiki_entries({file})` runs a file in one transaction. Every line goes through the same admission check as a live write: anonymous identities, evidence-less TBs and malformed lines are errors, the import writes nothing, and the result lists each bad line. A TB lands as truth only when it's signed and verifiable: a hash-chained v2 line, signed by someone `--signer-registry` lists if you use one. Anything else (unsigned, a 0.x v1 line, an unlisted signer, an unknown status or value, a line that contradicts a local entry) becomes a reconciliation `PROPOSAL` a person must notarize. Overrides and strikes apply only from a person the registry lists. Imported entries are embedded, so `search_truth` ranks them. Re-importing a file changes nothing: no duplicate TBs, and no proposal raised twice.

0.x wiki files (v1: a `status` field, no hash) are still read. See the spec's upgrade notes.

### Real-time objections

§11 rules on the record after the fact; objections reach the same court earlier — while the transcript is still being written. One detector (*assertion-contradicts-TB*) reads the stream stenographer already tails, backed by an in-memory cache of active TBs, and records an objection whenever **assistant output** asserts a **tombstoned literal**: its prose, and what its tool calls assert (the content of a Write, the new side of an Edit, MultiEdit or NotebookEdit, the parts of a shell command that write something). Searches and reads (Grep, Glob, Read, `grep`, `rg`, `git log -S`), commit messages and the old side of an edit are not read: an agent cleaning up a dead value has to be able to look for it. The [pre-dispatch gate](#pre-dispatch-gate) runs the same matcher before a tool call executes.

Only TBs that declare `literals` can object — an objection can only cite what the record actually contains:

```json
{ "claim": "LOG_BUDGET 30 is dead; the budget is 100",
  "evidence": [{ "kind": "commit", "ref": "a1b2c3" }],
  "signedBy": "johnnyclem",
  "literals": [{ "subject": "LOG_BUDGET", "dead": "30", "current": "100" },
               { "dead": "legacyRateLimiter", "current": "TokenBucket" }] }
```

v1 is precision over recall: exact tokens (`30` never matches `300` or `1.30`), the subject tolerates naming drift (`LOG_BUDGET` / `logBudget` / "log budget", and `maxHTTPRetries` / `MAX_HTTP_RETRIES`) but must sit next to the value in the same clause, and a bare value without a `subject` is rejected at write time. A clause that also names `current` ("bumped LOG_BUDGET from 30 to 100") is discussion, not assertion, but `LOG_BUDGET = 30; MAX_RETRIES = 100` is an assertion: a clause ends at `;`, `&&`, `||`, a line comment, or where another assignment starts. Negated or past-tense mentions ("do not set LOG_BUDGET to 30", "we removed legacyRateLimiter", "LOG_BUDGET was 30") don't object. The cases are pinned in a golden false-positive/false-negative corpus (`test/fixtures/literal-corpus.json`). All active literals compile into one matcher (Aho-Corasick over the dead values), recompiled only when the ledger changes, so a message is read once whatever the number of TBs. Each text is read up to its first 1,048,576 characters. Counsel doesn't repeat itself within a session while an objection is pending or after it's overruled; the same message in another session is objected to there too. A shadow objection (replayed history, or the gate in shadow mode) was never delivered, so it doesn't stop the first live assertion in that session from being objected to.

Every objection ships the objection, the exhibit (the full TB, plus any contesting UVs), and the transcript line. A person rules via `rule_on_objection` (operator profile; the session an objection was raised against can't rule on it): **sustained** lands as an ordinary `RULING` (`kind: objection`) corroborating the TB; **overruled** is signal. The **sustain rate** (`get_status` → `objections`) is the tuning dial — a falling rate means tighten the matcher.

`--objections shadow` (default) records objections without emitting them, so they can be shadow-judged against real MR catches; `deliver` pushes them (below) and serves them on `GET /flags` (poll with the last id as `since`); `off` disables the detector. Replays are always recorded as shadow, in every mode: only lines appended after stenographer started, or lines in a session log that appeared after it started, are delivered. Whatever a log already held at startup is history, including lines written while stenographer was stopped.

**Delivery (webhooks).** In `deliver` mode, objections are pushed to every configured receiver:

| Receiver | How it's reached | When it's delivered |
|---|---|---|
| Claude Code (built-in channel) | The attached MCP client gets `notifications/claude/channel`; stenographer declares the `claude/channel` capability | As discovered |
| smallchat agent-to-agent messaging | `--objection-channel <url>` → `POST <url>/event` on smallchat's channel bridge (`X-Channel-Secret`), relayed into the agent's session | As discovered |
| Harnesses without interrupts | `--objection-webhook <url>` → `POST {type: "stenographer.objections", objections: [...]}`, signed per [Standard Webhooks](https://www.standardwebhooks.com/) | Once a batch of 3 is pending, or after the oldest has waited 5 minutes |

**Signatures.** Webhooks (objections and proposals) carry `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`, keyed by `STENOGRAPHER_WEBHOOK_SECRET`. Any Standard Webhooks verifier can check them. A `whsec_<base64>` secret is used decoded; any other secret is used as its UTF-8 bytes (`new Webhook(secret, { format: "raw" })` in the reference library), and it must be at least 24 bytes. The id is stable across retries of the same delivery, so receivers can deduplicate, and the signed timestamp lets them refuse replays.

**Retries.** Delivery state is durable: a partial batch survives a restart, and an objection the judge already ruled on is dropped from the queue. Retries are per objection and per receiver. A network error, a 5xx, 408 or 429 backs off (15 s, doubling, at most an hour). A redirect or any other 4xx dead-letters the objection for that receiver at once, and so does an 8th failed attempt. Either way, the objections behind it keep flowing. A batch refused as a whole is retried one objection at a time. `get_status` counts dead letters under `objections.deadLettered`. Channel notices cap each line at 2,000 characters; the full record is one `list_objections` call away. Redirects are never followed, so a receiver can't forward the body and its secret elsewhere. Logs and tool results name a receiver by scheme, host and port only, because chat webhooks keep their token in the path or query.

Webhook URLs must be loopback unless a sink sets `allowRemote`, since objections carry transcript lines. Watch mode skips the MCP channel because one connection can't be mapped to the many sessions it watches, so use a smallchat channel or a webhook there.

**Session ids.** An objection's `sessionId`, and `meta.session_ids` on a channel event (what smallchat's messenger routes by), is the harness's own session id when the log records one (Claude Code's `sessionId`). Otherwise it is the log file's basename (`<name>.jsonl` → `<name>`), which for Claude Code is also the session id. The same rule holds in every mode, and the id is never minted from the clock, so it survives restarts. Stenographer itself still never writes into a conversation: it emits to receivers the operator configured, and they decide what to do.

### Pre-dispatch gate

Objections arrive after the agent has written the dead value. `stenographer gate` stops it before the call runs: it is a Claude Code `PreToolUse` hook that reads the hook's JSON on stdin, takes only what the call asserts (Write `content`; Edit, MultiEdit and NotebookEdit new side; the writing parts of a Bash `command`; never Read, Grep or Glob inputs, never `old_string`), and checks it against the literals of active and contested TBs with the same matcher as live objections.

- **`--mode enforce`**: a hit denies the call (`permissionDecision: "deny"`). The reason tells the agent which TB it contradicts (id, claim, `dead → current`, signer, any contesting UV), quotes the line, and names the objection filed for it, which is on `/flags` like any other.
- **`--mode shadow`** (default): a hit is filed as a shadow objection (or, when the gate can't write, reported on stderr and in `--log`, which gets one JSON line per hit or error) and the call proceeds.
- When the gate allows a call it prints nothing, so the call goes through Claude Code's normal permission flow. The gate never grants a permission.

Add it to `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y @stenographer/core gate --state \"$CLAUDE_PROJECT_DIR/stenographer.db\" --mode shadow --log \"$CLAUDE_PROJECT_DIR/stenographer-gate.log\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The hook runs on every matched tool call. `npx -y` resolves the package each time; with `npm install -D @stenographer/core`, use `"$CLAUDE_PROJECT_DIR/node_modules/.bin/stenographer" gate …` instead (about a quarter of a second per call in our measurement: Node 22, startup included, 1,000 literals, a 100 KB write). Point `--state` at the state file your `stenographer start` uses. The gate opens it read-only for TBs and writes only to the objections table, on a hit. Or use `--wiki <file>` to read TBs from a team wiki file. Status is folded per the truth format, and only signed, active or contested TBs count. In that mode there is nowhere to file objections or read rulings.

**Budget.** After startup the gate decides within `--timeout-ms` (default 2000). The value must be below Claude Code's hook timeout, which is 60 s by default; the snippet sets `"timeout": 10`, in seconds. Keep the budget well below the hook's `timeout`: Node startup counts against the hook's timeout, not against the gate's budget. If the gate runs past its budget or fails (no state file, a locked database, input it can't read), `--on-error` decides. The default is `allow` in shadow mode and `deny` in enforce mode. A gate that allows on error exits 1, so Claude Code reports the error without blocking the call.

**Overruling a denial.** If the dead value is intended (a migration test, a fixture), a person overrules the objection named in the denial (`rule_on_objection` in the operator profile, or the messenger). The ruling is scoped to that TB and that exact call, by the suite's canonical call digest of the tool name and its input (`smallchat.call.v1`). Retrying the same call then passes, in any session. Any change to the input is a new call. A sustained objection keeps denying that call, and no second objection is filed. With `--wiki`, the only way past a denial is to override or strike the TB.

**Rolling out: shadow, then enforce.**

1. Run in shadow mode. Every would-be denial is filed as a shadow objection (`list_objections` with `includeShadow`, `get_status` → `objections`).
2. Have a person rule on them. A sustained objection means the gate caught a real reintroduction. An overruled one is a false positive.
3. Tune the literals behind the overruled ones: give a bare value a `subject`, narrow a `dead` that's too common, or override TBs that no longer hold. Check a literal with `findLiteralHits` against real snippets before you sign it.
4. Switch to `--mode enforce` once the sustain rate is where you want it, and you've decided whether a broken gate should block (`--on-error deny`, the enforce default) or let calls through (`--on-error allow`).

It composes with other `PreToolUse` hooks (for example OpenAPPA's policy hook): a deny from any of them blocks the call.

**What the gate does not cover.** It is a guardrail against reintroducing a stale fact by accident. It is not a security boundary against an agent working around it.

- Paraphrases ("the old budget"), values built at runtime (`30` computed or concatenated), and values split across lines or fields.
- Content a tool's input doesn't carry. This includes a script that writes the value (`./set-budget.sh`), `cp` of a file that contains it, a download, and an MCP tool whose input fields don't look like content. Unknown tools are read through common content field names (`content`, `new_string`, `file_text`, `code`, patches by their added lines). Pass `--tools` to choose which tools the gate reads.
- Shell commands are classified, not parsed: `eval`, aliases, functions and command substitution can hide a write, or show one that isn't there. Searches are let through (`grep`, `rg`, a `find` whose `-exec` only reads); `jq`, `yq`, `sort`, `uniq`, `cut`, `head` and `tail` are read whole when their output goes into a file (a redirect, `yq -i`, `sort -o`, a pipe into `tee` or `sponge`), and a `find`/`fd` `-exec` command is read like a command of its own.
- Only the first 1,048,576 characters of each field are read.
- Prose. The gate sees tool calls only; live objections cover what the agent says.
- Anyone who can edit `settings.json` can remove the hook.

### OpenAPPA battery

[`integrations/openappa/`](./integrations/openappa/README.md) is a policy battery for [OpenAPPA](https://github.com/archestra-ai/OpenAPPA) 0.30.0, which checks a protected Claude Code session's tool calls before they run. It names every MCP tool of both profiles (`mcp/stenographer/<tool>`): transcript and ledger reads leave the session restricted to its user and `suspicious`, every ledger write but a draft (`propose_tombstone`) needs a `trusted` session, and overrides, rulings and every act signed with a person's name also need that person's approval (`hitl`). In a protected session, text from a web page or another session's transcript can't become truth through stenographer's MCP tools unless someone approves the exact call; the REST API and the terminal notary are outside it. `appa replay` traces pin the decisions; `npm run test:openappa` runs them when `appa` is installed. The README covers installing it next to OpenAPPA's claude-code battery. Separately, the REST daemon can answer OpenAPPA's context consults with the ledger's facts about a proposed call ([OpenAPPA context provider](#openappa-context-provider)); give it a port other than the runtime's 8787.

## GraphRAG Search

The `search_conversation` tool ranks **messages** with hybrid retrieval:

1. **Vector search**: cosine similarity over the persistent index (a long message scores as its best window), over-fetched into a candidate pool
2. **Entity evidence**: entities the query names (whole words), expanded through the co-mention graph (`graph_depth`, default 2); messages that mention them join the pool
3. **Reciprocal rank fusion** (K = 60) of the vector ranking, the entity ranking and a quarter-weight recency ranking, plus a small importance prior
4. **Evidence in `meta`**: `vectorScore`, `matchedEntities`, `paths`, `importance`, and `neighbors` (the adjacent messages in the same session)

Entities and paths are evidence on messages, not results of their own. Each message is embedded with its tool calls (name and arguments), so "which file did we edit" can find the edit.

The context frame (`get_context_frame`, `GET /context-frame`) keeps every section within the budget (estimated at 4 characters per token). Recent messages get 50%, decisions 35% and entities 15%, and whatever a section leaves unused goes to the others. The newest message always gets room first.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│            JSONL Log File(s) — any supported format          │
└─────────────────────────┬───────────────────────────────────┘
                          │ tail -F (live/catchup/watch/daemon)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│     Tailer + Provider Adapter (auto-detected), checkpoints   │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Core Engine (StenographerAPI)               │
│  Importance Detector → Structure Extraction → Embedder      │
│  Decision supersession (tombstones, provenance chains)      │
│  GraphRAG retriever (fused vector, entity and recency ranks)│
│  Objection detector (TB literals) → delivery (deliver mode) │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  SQLite (WAL, versioned): messages, decisions, tombstones,   │
│  entities, relations, checkpoints, sqlite-vec index,         │
│  truth ledger (hash-chained), objections, delivery state     │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
┌──────────────────┬──────────────────┬───────────────────────┐
│ MCP (stdio),     │ REST API         │ CLI: notarize, verify,│
│ agent | operator │ (daemon / port)  │ gate (PreToolUse hook)│
└──────────────────┴──────────────────┴───────────────────────┘
```

## Roadmap

- **The Agent Stack** — what is wired today, all at the format and transport level (no code dependency in either direction): objections reach agents, and drafts reach the notary, through [smallchat](https://github.com/johnnyclem/smallchat)'s channel bridge; [short-hand](https://github.com/johnnyclem/short-hand)'s compactor files candidates through proposal intake; and short-hand, smallchat and smallchat-swift read the ledger through [truth format v2](./spec/truth-format/README.md). Still a design target: a warm-state handoff to short-hand, and anything with [agentvault](https://github.com/johnnyclem/agentvault). [`docs/ecosystem/`](./docs/ecosystem/executive-summary.md) has the cross-repo evaluation.
- **Key-based notarization** — the notary signs with a key the server doesn't hold, and a notary-only mode that doesn't index, so the notary secret can live outside the process an agent's MCP host spawns (STENO-T-21)
- **MCP 2026-07-28** — stenographer uses `@modelcontextprotocol/sdk` 1.x and advertises only what it negotiates; serving the stateless 2026-07-28 revision means moving to the SDK's v2 packages
- **Tier 1.5 extraction** — local model (Gemma) for high-importance messages, gated by `extractionThreshold`
- **GraphQL** query surface
- **Neo4j** persistent graph backend (Cypher builders ship today: `buildVectorCypher`, `buildGraphCypher`)
- **Per-agent importance weights** — importance and extraction tuned per agent type

## Development

```bash
npm install
npm run build   # tsc (core) + tsc -p tsconfig.cli.json (CLI)
npm test        # vitest
npm run lint    # tsc --noEmit
npm run test:openappa   # OpenAPPA battery checks; skipped without an appa binary
```

Tests live in [`test/`](./test), covering the core engine, ingestion across restarts, the tailer, provider adapters, extraction precision on a labeled corpus, embeddings and embedder pinning, GraphRAG retrieval, importance scoring, the SQLite store and its migrations, the REST API and its access checks, the truth ledger (authority model, notary, hash chain and `verify`, truth format v2 fixtures, wiki interop, intake), objections and their delivery, the gate, the OpenAPPA battery and context route, and an indexing-time bound. Two tests need the MiniLM weights on disk and are skipped otherwise; set `STENOGRAPHER_TEST_MODEL_CACHE` to a transformers.js cache directory to run them. CI runs lint, tests, build and `test:openappa` on Node 22 and 24.

## Contributing

Issues and pull requests are welcome. Before opening a PR, make sure `npm run lint`, `npm test`, and `npm run build` all pass.

## License

[MIT](./LICENSE)

## Credits

Inspired by:
- [Neo4j GraphRAG Python](https://github.com/neo4j/neo4j-graphrag-python)
- Andrej Karpathy's LLM Wiki pattern

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

- **GraphRAG Search** — messages ranked by reciprocal rank fusion of vector similarity, entity-graph evidence and recency, with an importance prior; the graph evidence comes back with each result
- **Real Local Embeddings** — `all-MiniLM-L6-v2` via `@huggingface/transformers` (~25MB model, downloaded once, runs fully locally, no API keys), or the offline hashed-lexical embedder with `--embeddings hashed`. The state database is pinned to the embedder that wrote it (see [Offline mode](#offline-mode))
- **Persistent Vector Index** — `sqlite-vec` KNN index (cosine, partitioned by session, long messages in overlapping windows) in the same SQLite file as everything else (brute-force cosine fallback if the extension can't load)
- **Importance Scoring** — a three-signal model (state delta, reference frequency, trajectory discontinuity) scores each message; GraphRAG search uses it as a ranking prior and context frames use it to choose which recent messages get room
- **Decision Supersession (Tombstones)** — decisions are append-only; a newer decision or an "actually, …" correction closes the old record onto its successor, keeping full provenance. Only what people and the assistant said is mined: tool output, harness records, subagent transcripts and compaction summaries are indexed and searchable, but never read as decisions
- **Four Modes** — `live`, `catchup`, `watch` (a directory of session logs), `daemon` (live + REST API)
- **Provider Adapters** — `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`, auto-detected from the first lines written (a log created empty waits for its first line)
- **Resumable Ingestion** — a per-log checkpoint commits with each message, so a restart picks up where the last run stopped instead of re-reading the log (see [Restarts and log rotation](#restarts-and-log-rotation))
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
| `-e, --embeddings` | model name \| `hashed` \| `auto` | `Xenova/all-MiniLM-L6-v2` | Transformer model (fails to start if it can't load), the offline lexical embedder, or `auto`: the embedder the state database is pinned to, else the default model with a loud fallback to hashed (see [Offline mode](#offline-mode)) |
| `--reembed` | — | off | Re-embed every stored message and truth entry under the chosen embedder before starting. Needed to switch a state database to another embedder |
| `--supersede-threshold` | number in (0, 1] | per embedder: MiniLM `0.45`, hashed `0.75` | Cosine similarity at which a new decision supersedes an active one (see [Decision Supersession](#decision-supersession)) |
| `--rest-port` | port number | `8787` in daemon mode, off otherwise | Serve the REST API on this port |
| `--objections` | `off` \| `shadow` \| `deliver` | `shadow` | Real-time objections to tombstoned literals (see [Real-time objections](#real-time-objections)) |
| `--objection-channel` | URL (repeatable) | — | smallchat channel bridge to push each objection to as it's raised. Secret from `SMALLCHAT_CHANNEL_SECRET` |
| `--objection-webhook` | URL (repeatable) | — | Webhook for harnesses that can't be interrupted: objections arrive in batches. Standard Webhooks signing key from `STENOGRAPHER_WEBHOOK_SECRET` (at least 24 bytes) |
| `--objection-batch-size` | number | `3` | Batch size for `--objection-webhook` |
| `--no-mcp-channel` | — | — | Don't push objections to the attached MCP client as Claude Code channel events |
| `--require-notary` | — | off | Agents can't assert tombstones directly: they draft with `propose_tombstone` and a person notarizes (see [Agent-drafted tombstones](#agent-drafted-tombstones-notarization)). REST notary routes need `STENOGRAPHER_NOTARY_SECRET` |
| `--rest-host` | hostname/IP | `127.0.0.1` | Interface for the REST API to bind to. The API serves transcripts, so it stays loopback-only unless you explicitly opt into wider exposure (e.g. `0.0.0.0` behind a trusted network boundary) |
| `--rest-allow-host` | host name (repeatable) | — | Also answer to this `Host` name. Loopback names and `--rest-host` always are; anything else gets 421 (see [REST API](#rest-api-daemon-mode-or---rest-port)) |
| `--rest-insecure` | — | off | Serve REST without a bearer token. Host and Origin checks still apply |

Positional args: `stenographer start <log-path> [state-path]` — `state-path` defaults to `./stenographer.db`.

### Restarts and log rotation

Each log has a checkpoint in the state database: the byte offset after the last indexed line, plus what identifies the file (device/inode and a hash of its first 4 KB). The checkpoint is written in the same SQLite transaction as the message and everything derived from it (entities, decisions, supersessions, proposals, objections), so after a crash or restart a line has either been applied completely or not at all, and indexing resumes right after the last applied line. A log keeps its session id across restarts.

Scope of the idempotency: within one state database, a line whose message id and content are already indexed is skipped for every derived record, whether it is re-read after a truncate-and-rewrite or copied into another session's log (the message moves to the newer session; nothing is re-derived). Decisions and supersession tombstones get ids hashed (128-bit) from the line they came from, and so do messages whose format has no id of its own (`openai`, `anthropic`, `generic`): log path, byte offset and line content. Two identical `continue` turns therefore stay two messages.

The tailer holds back a partially written line until its newline arrives (`catchup` indexes a final unterminated line but leaves the checkpoint before it). It strips a UTF-8 BOM. It waits for a log that doesn't exist yet. When a log is deleted it waits for the log to reappear (in `watch` mode it drops that session), and it follows the path through a rename rotation or atomic replace after draining the old file. If the file is truncated or rewritten, it reads it again from the top, where the lines it has already indexed are skipped. State databases record their schema version (`PRAGMA user_version`), migrate in place on start and run in WAL mode.

### Offline mode

By default, Stenographer downloads a ~25MB embedding model on first run and does everything else locally after that — no ongoing network calls, no API keys, ever. If you need to skip even that one-time download, pass `--embeddings hashed` to use an offline hashed-lexical embedder instead. Hashed search is lexical (shared words and spellings), not semantic.

Vectors from two embedders aren't comparable, so the state database records the embedder that wrote it (model, width, version) and refuses to open under a different one, naming both. To switch, restart with the new `--embeddings` and `--reembed`, which recomputes every stored message and truth-entry vector. A model that fails to load is an error, not a silent switch to hashed. If you want the fallback, `--embeddings auto` opts in: it uses the embedder the database is already pinned to, or tries the default model and falls back to hashed with a warning on stderr (the database is then pinned to hashed). `get_status` and `GET /status` report the embedder in use.

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
| **`search_conversation`** | **GraphRAG hybrid search: fused vector, entity-graph and recency ranks** (`k` ≤ 200) |
| `search_similar` | Pure vector search over the persistent index (`k` ≤ 200) |
| `get_context_frame` | Entities, active decisions and recent messages within a token budget |
| `get_status` | Statistics, vector backend, mode |

### Truth-layer tools (TB/UV v2)

| Tool | Description |
|------|-------------|
| `list_proposals` | The review inbox: machine-drafted candidates awaiting sign/dismiss |
| `sign_proposal` | Mint a TB/UV from a proposal under an accountable signer (`edits` supported). Refuses agent drafts — those need a notary |
| `propose_tombstone` | An agent drafts a TB (claim, evidence, literals, rationale); it's raised to a person and never mints until they notarize it |
| `dismiss_proposal` | Dismiss with a required reason (kept as detector training data) |
| `assert_tombstone` | Direct TB for authors who already know — evidence required |
| `assert_uv` | Assert an unverified belief with a machine-actionable `verifyBy`; `contests` disputes a TB |
| `resolve_uv` | Verify/refute a UV with evidence; `command` evidence self-signs |
| `override_tombstone` | The force path: override a TB with a proven addendum |
| `get_verification_queue` | Open UVs ranked for opportunistic verification |
| `get_contested` | All TB+UV disputes |
| `get_truth` / `search_truth` | Truth entries by filter / by embedding relevance |
| `file_ruling` | Strike, promotion, or contempt ruling with a written opinion |
| `export_wiki_entries` / `import_wiki_entries` | Lossless team llm-wiki JSONL interop |
| `backfill_legacy_tombstones` | Phase-1 migration of pre-assertion supersessions |
| `list_objections` | Real-time objections (objection + exhibit + transcript line); `includeShadow` for shadow judging |
| `rule_on_objection` | Sustain or overrule an objection with a written opinion — files a `RULING` |

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

The notary routes need the bearer token and `X-Notary-Secret`. The token keeps out web pages, other users and other machines. It doesn't keep out processes running as you, which can read the token file, so treat it like the notary secret.

The server binds to `127.0.0.1` by default. Pass `--rest-host` if you deliberately want it reachable from elsewhere, plus `--rest-allow-host` for the name clients use.

Query parameters are validated: a malformed one (`k=abc`, `n=0`, an unknown `status`) gets `400`, and oversized counts are clamped (`k` ≤ 200, `n` ≤ 1,000, `depth` ≤ 5, `limit` ≤ 1,000, `budget` ≤ 100,000).

### OpenAPPA context provider

[OpenAPPA](https://github.com/archestra-ai/openappa) asks configured context providers about each proposed tool call before its annotator labels the call. `POST /appa/context` implements consult protocol v1 for `kind: "context"`. It takes `{version: 1, kind: "context", name, declaration: {}, artifact: {tool, arguments, cwd?}}` and answers `{version: 1, answer}`. The answer is `null` when the ledger has nothing to say. Otherwise it is `{about, hits}`, with one hit per tombstoned literal found in the arguments:

```json
{ "tb_id": "01J…", "subject": "LOG_BUDGET", "dead": "30", "current": "100",
  "claim": "LOG_BUDGET 30 is dead; the budget is 100", "signer": "johnnyclem", "author": "johnnyclem",
  "status": "active", "argument": "command", "line": "printf 'LOG_BUDGET=30\\n' >> .env",
  "contested_by": [] }
```

Matching is the objection detector's: exact tokens, a subject next to its value, lines that also name the current value skipped, and the old side of an edit (`old_string`, …) ignored. A contested TB lists the open UVs that dispute it, with their authors. The answer is facts for the annotator, not a label. Whether a hit matters is the policy's call. The route is read-only and uses the same bearer token:

```toml
[externals.context.stenographer]
url = "http://127.0.0.1:8787/appa/context"
token_env = "APPA_STENOGRAPHER_TOKEN"   # the contents of <state dir>/rest-token
```

OpenAPPA asks context providers only for calls that need a new annotation, and only annotators read the answer, so this informs labeling. It doesn't block a call by itself.

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

The tombstone pipeline is split into **detection** (automatic, proposal-only) and **assertion** (accountable, signed). Machines detect; authors assert — no inferred write ever lands as truth.

Five record types live in one append-only ledger (`truth_entries`, mirrored to wiki JSONL):

- **`TB`** — asserted tombstone: a prior statement is provably stale/wrong. Requires evidence and a signer.
- **`UV`** — unverified assertion ("there be dragons"): believed true, stated before verification exists, with a machine-actionable `verifyBy` hint.
- **`PROPOSAL`** — what the supersession detector now emits. Signing mints the TB/UV; dismissing costs nothing, so thresholds can be tuned for recall.
- **`ADDENDUM`** — evidence attached after the fact (UV resolutions, TB overrides).
- **`RULING`** — a signed judgment with a required written opinion: `strike` (inadmissible, never deleted), `promotion` (evidence ruled sufficient), `contempt` (self-corroboration called out — mints one conduct TB, no karma system).

**Override protocol** (force semantics, enforced at the storage layer): flipping an active TB requires either a contesting UV (`contests` — TB becomes `contested` but stays truth) or a proven addendum with evidence (`overrides`). There is no third path, and no path at all for anonymous writes — generic identities (`system`, `assistant`, …) are rejected at the schema level.

**Contempt of corpus**: corroboration must be provenance-independent. A `verifies`/`signs` whose actor shares the author or agent session of its target is rejected at write time — three subagents affirming their parent's UV is one opinion wearing three hats.

**Rollout** is governed by `truthMode`:
- `shadow` (default, Phase 0): auto-close keeps working *and* every detection lands as a proposal — observe quality, tune.
- `assert` (Phase 1): auto-close is disabled; detection is proposal-only, and signing a proposal is what closes the superseded decision. `backfill_legacy_tombstones` migrates pre-assertion supersessions as queryably second-class TBs (`author: migration`).

Downstream consumers get the confidence type in every result, with the consumption rules embedded in the tool descriptions: active TB = ground truth; contested TB = truth with a visible asterisk; open UV = **flag, don't block**; refuted/overridden = history, never citable.

**Proposal intake** (`importProposalDrafts`): external tools — today [short-hand](https://github.com/johnnyclem/short-hand)'s compactor, which exports its L4 candidate invariants and detected corrections as draft JSONL — can file candidates into the ledger. Every line lands as a `PROPOSAL` under a detector identity (`detector:short-hand`); there is no external write path to TB or UV, the detector cannot sign its own intake, and `targetRef` dedupe makes re-imports idempotent. This is the Option B seam from the TB/UV v2 handoff (§13 Q6): format-level interop, no code dependency in either direction. Both dialects of the line are accepted: short-hand's bare `{kind, draft, signal: {source: "compaction-candidate"}}` and the `PROPOSAL` envelope smallchat's vendored compactor (and smallchat-swift) writes — `{type: "PROPOSAL", id, ts, author, agentSessionId, …, signal: {source: "shorthand-compaction"}}`. The envelope's own id and author are kept under `meta.intake` for traceability; authorship stays with the detector identity.

### Agent-drafted tombstones (notarization)

Agents often find the dead value first — the config that was bumped, the class that was deleted. `propose_tombstone` lets them draft the TB: claim, evidence, the literals to object to, and why. They can't sign it. The draft is a `PROPOSAL` marked `requiresNotary`, and only a person turns it into truth:

1. **Raised.** The draft goes to the same receivers as objections — smallchat's channel bridge (`meta.kind: "proposal"`, with a `notarize_url`) and operator webhooks (`type: "stenographer.proposal"`) — never to the attached MCP client, which is the drafter. It's also printed to stderr and stays in `GET /proposals?status=open`. Notices escape control characters and bidi overrides in whatever the agent wrote (as `\u001b`, `\r`, …), so a claim can't conceal or overwrite itself in a terminal or chat.
2. **Notarized.** A person approves or declines it through a path agents' tools don't reach:
   - REST `POST /proposals/:id/notarize` / `dismiss` with `X-Notary-Secret` — the secret in `STENOGRAPHER_NOTARY_SECRET`, shared with your approval UI (smallchat) and not with agents. Unset, the routes answer 403.
   - `stenographer notarize <id> --as <name> [--state <path>]` (or `--decline "<reason>"`), which needs an interactive terminal and a typed confirmation.
3. **Minted.** The TB is signed by the notary, keeps the draft's literals (so it can object immediately), and links back to the draft. Contempt of corpus still applies: the drafting identity can't notarize its own draft.

`sign_proposal` over MCP refuses agent drafts, and `--require-notary` also disables `assert_tombstone`, so with it on every agent-authored tombstone has a person's name on it. This guards against an agent approving itself through its tools; it isn't a sandbox — an agent with the operator's shell and secrets can do what the operator can.

### Real-time objections

§11 rules on the record after the fact; objections reach the same court earlier — while the transcript is still being written. One detector (*assertion-contradicts-TB*) reads the stream stenographer already tails, backed by an in-memory cache of active TBs, and records an objection whenever **assistant output** (prose, or the new side of a tool-call edit) asserts a **tombstoned literal**.

Only TBs that declare `literals` can object — an objection can only cite what the record actually contains:

```json
{ "claim": "LOG_BUDGET 30 is dead; the budget is 100",
  "evidence": [{ "kind": "commit", "ref": "a1b2c3" }],
  "signedBy": "johnnyclem",
  "literals": [{ "subject": "LOG_BUDGET", "dead": "30", "current": "100" },
               { "dead": "legacyRateLimiter", "current": "TokenBucket" }] }
```

v1 is precision over recall: exact tokens (`30` never matches `300`), the subject tolerates naming drift (`LOG_BUDGET` / `logBudget` / "log budget") but must sit next to the value, a bare value without a `subject` is rejected at write time, and a line that also mentions `current` ("bumped from 30 to 100") is discussion, not assertion. Counsel doesn't repeat itself within a session while an objection is pending or after it's overruled.

Every objection ships the objection, the exhibit (the full TB, plus any contesting UVs), and the transcript line. The judge rules via `rule_on_objection`: **sustained** lands as an ordinary `RULING` (`kind: objection`) corroborating the TB; **overruled** is signal. The **sustain rate** (`get_status` → `objections`) is the tuning dial — a falling rate means tighten the matcher.

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
│  GraphRAG retriever (entity graph; vectors via sqlite-vec)  │
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

Tests live in [`test/`](./test), covering the core engine, GraphRAG retriever, embeddings, importance scoring, extraction precision on a labeled corpus, provider adapters, the tailer, the SQLite store, the REST API, and an indexing-time bound. Two tests need the MiniLM weights on disk and are skipped otherwise; set `STENOGRAPHER_TEST_MODEL_CACHE` to a transformers.js cache directory to run them.

## Contributing

Issues and pull requests are welcome. Before opening a PR, make sure `npm run lint`, `npm test`, and `npm run build` all pass.

## License

[MIT](./LICENSE)

## Credits

Inspired by:
- [Neo4j GraphRAG Python](https://github.com/neo4j/neo4j-graphrag-python)
- Andrej Karpathy's LLM Wiki pattern

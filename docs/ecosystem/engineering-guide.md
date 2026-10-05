# Ecosystem Evaluation — Engineering Guide (Stenographer Vantage Point)

**Sourcing note:** Same scope as the [executive summary](./executive-summary.md): direct source
access to this repo (`johnnyclem/stenographer`) only. Claims about AgentVault, SmallChat, and
Short-Hand are drawn from public READMEs, GitHub repo pages, and AgentVault's own
`docs/ecosystem/` files (fetched via `WebFetch`, since AgentVault is public), and are marked
**[README-sourced]**. Cross-links: AgentVault's
[engineering guide](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md)
and
[executive summary](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/executive-summary.md).

**Updated for stenographer 1.0.0 (2026-10).** The component table, tool and REST surfaces, data
flow and verdicts below are corrected where 1.0 changed stenographer's code; line numbers are
dropped because they no longer hold. Claims about the other repos are left as evaluated on
2026-07-01.

## 1. Component reference — Stenographer (verified, this repo)

| Component | File | Role |
|---|---|---|
| Core engine (`StenographerAPI` impl) | `src/core/stenographer.ts` | Owns lifecycle, modes, indexing pipeline, all query methods |
| CLI/MCP server entry | `src/mcp/server.ts` | Wraps the engine in MCP tools over stdio, one profile per server (`agent`: 20 tools, `operator`: 28); also the `runCLI` entry point |
| REST server | `src/api/rest.ts`, `src/api/auth.ts` | `node:http` layer exposing the query surface, the notary routes and the OpenAPPA context route, behind a bearer token and a `Host` allowlist |
| CLI shim | `cli/index.ts` | `stenographer start\|proposals\|notarize\|verify\|gate` — parses the subcommand and delegates |
| Provider adapters | `src/indexer/adapters.ts` | `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`; auto-detected via `detectAdapter` |
| Tailer | `src/indexer/tailer.ts` | File-tail primitive + `JsonlAdapter`/`LogAdapter` interface |
| Importance scoring | `src/indexer/importance.ts` | Three-signal model: state delta (45%), reference frequency (25%), trajectory discontinuity (30%) |
| Embeddings | `src/indexer/embeddings.ts` | `all-MiniLM-L6-v2` via `@huggingface/transformers`, or the offline hashed-lexical embedder; the state database is pinned to one, and the fallback to hashed is opt-in (`--embeddings auto`) |
| GraphRAG retriever | `src/indexer/graphrag.ts` | Reciprocal rank fusion of vector, entity-graph and recency ranks; returns messages only |
| Persistence | `src/store/index.ts`, `src/store/migrations.ts` | `better-sqlite3` + `sqlite-vec` KNN index (brute-force cosine fallback), WAL, versioned migrations, ingest checkpoints |
| Truth ledger | `src/truth/` | Hash-chained TB/UV ledger (`ledger.ts`, `chain.ts`, `status.ts`), notary paths, objections and their delivery, wiki import/export (truth format v2), proposal intake, and the `PreToolUse` gate (`gate.ts`) |
| Types / public contract | `src/types.ts` | `StenographerAPI`, `ConversationMessage`, `Decision`, `Tombstone`, `EntityNode`, `EntityRelation`, `StenographerConfig` |

### MCP tool surface (`src/mcp/server.ts`)

The index tools `get_recent_messages`, `get_entities`, `get_relations`, `get_decisions`,
`get_decision_history`, `get_decision_chain`, `get_corrections`, `search_conversation`,
`search_similar`, `get_context_frame` and `get_status` (11, the whole 0.1.0-alpha surface) are
served in both profiles, with six truth-ledger reads. The `agent` profile (default) adds
`propose_tombstone`, `assert_uv` and `resolve_uv` (20 tools): an agent alone drafts and attests,
and a claim settles only when two or more agent sessions agree from different angles within 15
minutes (the agent quorum, `src/truth/quorum.ts` and `src/truth/attestations.ts`), or a person
signs. The `operator` profile adds the notary and judicial tools and wiki import/export instead
(28 tools). The README's tables list them all.

### REST surface (`src/api/rest.ts`)

`GET /status`, `/messages`, `/entities`, `/relations`, `/decisions`, `/decisions/history`,
`/decisions/:id/chain`, `/tombstones`, `/search`, `/graphrag`, `/context-frame`, `/flags`,
`/proposals`, plus `POST /proposals/:id/notarize`, `POST /proposals/:id/dismiss` (with
`X-Notary-Secret`) and `POST /appa/context` (read-only). Every route needs a bearer token and an
allowed `Host`. `node:http` only (no framework dependency). Only served in `daemon` mode or when
`--rest-port` is passed.

### Modes (`src/core/stenographer.ts`)

`live` (tail + serve), `catchup` (index once, no watcher), `watch` (directory of `*.jsonl`, one
session per file), `daemon` (live + REST, default port 8787).

## 2. Data flow — as built vs. as diagrammed

**As built (verified):**

```
JSONL log file(s)
   │  tail (live/catchup/watch/daemon)
   ▼
Provider adapter (auto-detected: jsonl/claude-code/anthropic/openai/generic)
   │
   ▼
Core engine: importance scoring → structure extraction (entities/decisions/corrections) → embed
   │                                   └─ objection detector (TB literals) ─→ delivery (deliver mode)
   ▼
SQLite (messages, decisions, tombstones, entities, relations, checkpoints, truth ledger,
        objections) + sqlite-vec vector index
   │
   ▼
MCP (stdio, agent | operator)  ──┬──  REST (daemon mode)  ──┬──  CLI: notarize, verify, gate
```

The indexing loop is self-contained: it calls no sibling code. In 1.0 two edges leave it, both
configured by the operator: objection and proposal delivery POSTs to smallchat's channel bridge
(or a webhook), and the ledger's wiki export and proposal intake exchange truth format v2 files
with short-hand and smallchat. Nothing calls out to AgentVault — see Key Finding 1 in the
executive summary.

**As diagrammed by the AgentVault-side guide (aspirational, unchanged by this evaluation):**

```
Stenographer (real-time index) → warm state → Short-Hand (compaction) → context →
SmallChat (tool dispatch) → execution → AgentVault (deployment)
```

No correction needed to the shape of this diagram — it's a reasonable target. The correction is to
its epistemic status: it should be labeled "target," not "current," in every repo's docs. This
repo's own `wiki/stenographer.md` already does this ("Roadmap (aspirational — not yet built)");
the top-level `README.md` Roadmap section is compatible but terser — worth keeping both in sync if
either changes.

## 3. Confirming / refuting the AgentVault-side guide's claims about Stenographer

| Claim (AgentVault-side guide) | Verdict | Detail |
|---|---|---|
| "13 MCP tools" | **Refuted (minor)** | 0.1.0-alpha had 11. 1.0 serves 20 (`agent` profile) or 28 (`operator`), 29 distinct. See `src/mcp/server.ts`. |
| REST daemon on port 8787 with `/status`, `/messages`, `/entities`, `/search`, `/graphrag` | **Confirmed** | `src/api/rest.ts`; default port `DEFAULT_DAEMON_REST_PORT = 8787` in `src/core/stenographer.ts`. Since 1.0 every route needs a bearer token. |
| Decision tombstone/supersession semantics, append-only | **Confirmed** | `src/core/stenographer.ts` supersede logic. Since 1.0 the threshold is per embedder (MiniLM 0.45, hashed 0.75), calibrated on `test/fixtures/supersession-pairs.json`. A decision that near-ties several active ones gets a proposal against each that isn't already proposed into one of their chains (`supersedeMargin`, default 0.05). A model judge to pick among near-ties was evaluated and not adopted: it would send transcript text off the machine, and a model may not settle or dismiss a claim. |
| Local `all-MiniLM-L6-v2` embeddings, offline fallback | **Confirmed, with a 1.0 change** | `src/indexer/embeddings.ts`. The fallback to hashed is opt-in (`--embeddings auto`); a model that can't load is an error. |
| Five modes: `live`, `catchup`, `watch`, `daemon`, + adapter auto-detect | **Partially refuted (wording)** | Four *modes* (`live`/`catchup`/`watch`/`daemon`); adapter auto-detection is a fifth *feature*, not a fifth mode. Functionally accurate, just miscategorized in the AgentVault-side summary. |
| Zero references to Stenographer in AgentVault's repo | **Consistent** (this repo can't verify AgentVault's source, but the converse holds: zero references to AgentVault in this repo either) | Confirms the relationship is symmetric — neither side has built the bridge. |
| Stenographer positioned as "the memory" layer | **Confirmed as an accurate label for current scope** | No dispatch, no compaction, no execution logic anywhere in `src/`. |

## 4. README-vs-reality check performed (per runbook §4)

**Claim under test:** the runbook states Short-Hand's "README bills it as 'language middleware for
Stenographer and SmallChat.'"

**Method:** `WebFetch` of `https://raw.githubusercontent.com/johnnyclem/short-hand/main/README.md`,
asked to quote verbatim any sentence containing "Stenographer," "SmallChat," "middleware," or
"integrat."

**Result:** No such sentence exists in the README as of 2026-07-01. The tagline is "Progressive
context compaction for LLMs. Old computer science for new constraints," with no reference to
either sibling project. **[README-sourced, negative result]**

**Why this matters:** it's the inverse of the failure mode the runbook warned about ("don't assert
a feature exists in another repo just because its README claims it") — here, a *prior* evaluation
asserted a README claim that isn't actually present. Two possible explanations, neither
verifiable from this session: (a) Short-Hand's README changed between when the AgentVault-side
docs were written and now, or (b) the claim was an overstatement in an earlier draft that
propagated forward. Either way, treat "Short-Hand is documented middleware for Stenographer" as
false until Short-Hand's own repo confirms it in its current README or source — do not carry the
claim forward into future docs without re-checking.

This has one concrete downstream effect: it downgrades AgentVault's engineering guide
recommendation to plug Short-Hand into `polytician-enricher.ts` from "slotting in existing,
documented middleware" to "building a new adapter against a compaction library that doesn't
currently claim awareness of either Stenographer or SmallChat." The work may still be worth doing,
but the estimate should assume adapter code needs to be written from scratch on both ends, not
just wired.

## 5. Phased integration roadmap — from Stenographer's side

**Phase 1 (near-term, low-risk):** No code changes. Point Stenographer's `watch` mode at whatever
transcript format AgentVault, SmallChat, or Short-Hand emit (Stenographer already ships a
`generic` adapter with best-effort field mapping, precisely for this case) and confirm entities/
decisions extract sensibly. Zero new dependencies, reversible, validates whether the "memory
layer" role is actually useful to the other three before investing further.

**Phase 2 (adapter, moderate effort):** If Phase 1 validates the fit, add a purpose-built adapter
(e.g. `agentvault` or a name matching whatever transcript shape AgentVault's orchestration layer
emits) to `src/indexer/adapters.ts`, following the existing `LogAdapter` interface
(`parseLine`, `detect`) already used by `OpenAIAdapter`/`AnthropicAdapter`/`ClaudeCodeAdapter`.
This is additive and low-risk — it doesn't touch the core engine, store, or query surface.

**Phase 3 (handoff, requires cross-repo coordination):** Building the "warm state → Short-Hand"
edge from the diagram requires Short-Hand to define what it expects as input (its README
currently doesn't describe an ingestion contract for external indexes, per §4 above). Given the
identical three-signal importance model in both repos (see executive summary Key Finding 5),
Phase 3 should start by deciding which project owns importance scoring for handed-off messages,
to avoid recomputing it twice with the two implementations silently drifting apart over time.

**Phase 4 (tool exposure to SmallChat):** Stenographer's MCP tools are already a valid MCP server
today (`src/mcp/server.ts`) — no new work needed on this repo's side for SmallChat to compile
against it via `@smallchat/core compile --source` **[README-sourced: this is SmallChat's
documented MCP-config-compile flow]**, if SmallChat's compiler in fact accepts arbitrary MCP
servers as a source, not only `~/.mcp.json` entries. That specific point can only be confirmed
from SmallChat's own source.

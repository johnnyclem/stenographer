# Changelog

## 1.0.0 (unreleased)

### Breaking

- **Ingestion resumes from a checkpoint instead of re-reading the log.** Each log's position is stored in the new `ingest_checkpoints` table, in the same transaction as each message. A restart no longer re-indexes a log from byte 0. Use a fresh state path to rebuild an index on purpose. (STENO-IDX-01)
- **Startup replay never delivers objections, in any mode.** Before, only `catchup` forced shadow. Now, in `live`, `daemon` and `watch` too, whatever a log held when stenographer started is recorded as shadow, and only lines appended afterwards (or logs that appear afterwards) are delivered. (STENO-IDX-02, STENO-T-11)
- **Message ids for id-less formats changed.** `openai`, `anthropic` and `generic` lines without an id used `msg_<32-bit FNV of the line>`. They now use `msg_<128-bit hash of log path, byte offset, line>`. (STENO-IDX-26)
- **Decision and tombstone ids are deterministic.** They were `decision_<ms>_<random>` and `tombstone_<ms>_<random>`. They are now `decision_<hash>` and `tombstone_<hash>`, derived from the source message, the extractor and the captured text.
- **`live`, `daemon` and `catchup` keep a log's session id across restarts.** It is stored with the checkpoint. Before, each run minted a new `session_<ms>` and re-tagged every message with it.
- **State databases run in WAL mode and carry a schema version** (`PRAGMA user_version`, migrated in place on start). A database written by a newer stenographer is refused instead of opened.
- **Format auto-detection matches on any sampled line**, not only the first, and waits for the first complete line of an empty log. `detectAdapterFromLines` keeps its JSONL fallback. The new `matchAdapterFromLines` returns `null` when nothing matches. (STENO-IDX-05)
- **`Tailer` follows the path like `tail -F`.** In follow mode it no longer throws on a missing file: it waits for the file. It emits only newline-terminated lines, holding back a partial last line. The `message` event gets a second argument (`IngestPosition`), and there are new `progress`, `adapter`, `reset` and `removed` events. `LogAdapter.parseLine` takes an optional `LineContext`.
- **The state database is pinned to its embedder.** The embedder's identity (kind, model, width, version) is stored in the new `index_meta` table. A database opens only under the same embedder; otherwise `start()` throws `EmbedderMismatchError` naming both. `--reembed` (`reembed: true`) recomputes every stored message and truth-entry vector under the new one. A pre-1.0 database is adopted with a warning. (STENO-IDX-24)
- **No silent fallback to hashed embeddings.** A transformer model that can't load is a startup error with instructions. `--embeddings auto` opts in to the fallback (loudly), and `auto` follows the embedder the database is pinned to. `createEmbedder` takes an options object. (STENO-IDX-24)
- **`Embedder` has two new required members**, `identity` and `supersedeThreshold`. Custom embedders must implement them. `TransformerEmbedder.dimensions` is the model's output width (read at load), not a fixed 384.
- **The default supersede threshold depends on the embedder:** MiniLM 0.45, hashed 0.75 (was 0.45 for all). `supersedeThreshold` / `--supersede-threshold` still override it. (STENO-IDX-06)
- **Tool results are role `tool`.** A turn made only of `tool_result` blocks (Claude Code, Anthropic) becomes role `tool`, tagged `tool_result`; a turn with prose keeps its role and only its prose. Claude Code `isMeta` and slash-command records are tagged `meta`, `isSidechain` records `sidechain`, `isCompactSummary` records `compact_summary` (new optional `tags` on `ConversationMessage`, stored and returned). (STENO-IDX-08)
- **Extraction mines user and assistant prose only, one assertion per sentence.** Tagged records, tool output, system turns, code fences, quoted lines and harness blocks yield no decisions, corrections or entities. Fewer, different decisions are extracted from the same logs. `ExtractedStructure.corrections[].to` is now the corrected (current) statement and `from` what it replaces (`''` when unnamed). Before, `from` held the captured text and `to` was always empty. (STENO-IDX-07)
- **`search_conversation` / `GET /graphrag` / `GraphRAGRetriever.search` return messages only.** Entity and path chunks are gone. Their evidence is in each result's `meta` (`matchedEntities`, `paths`), and `score` is a fused reciprocal-rank score, not a cosine. Neighboring messages move from an appended `Context:` block in `content` to `meta.neighbors`. `RetrievedChunk.type` is `'message'`. (STENO-IDX-16)
- **Recent messages are ordered by ingest order** (`messages.seq`), not timestamp. (STENO-IDX-17)
- **Context frames budget every section** and can omit entities or decisions that don't fit. (STENO-IDX-14)
- **REST and MCP clamp `k` to 200**, `n` to 1,000 and graph depth to 5. `StateStore.searchSimilar` clamps `k` to 4,096. (STENO-IDX-13)
- **Supersession proposals dedupe per (superseded, successor) pair**: `targetRef` is `<superseded>-><successor>`, no longer the superseded decision's id. In `watch` mode supersession matches across sessions. (STENO-IDX-12, -22)
- **Schema v3**: `messages` gains `seq`, `tags`, `tool_calls` and `importance_total`; `index_meta` is new. The vector table is rebuilt (one row per message window, cosine distance, partitioned by session) from the stored embeddings on first open.

### Added

- `--embeddings auto`, `--reembed` and `--supersede-threshold`. `StenographerConfig.embedder` accepts an `Embedder` instance.
- `get_status` and `GET /status` report the embedder (`embedder`).
- Exports: `assertableProse`, `EmbedderMismatchError`, `EmbedderIdentity`, `sameEmbedder`, `describeEmbedder`, `DEFAULT_EMBEDDING_MODEL`, `MessageTagSchema`.

### Fixed

- A restart no longer inverts supersession chains, duplicates decisions, tombstones, proposals or migration TBs, or re-counts entity references. (STENO-IDX-01)
- A line written in more than one chunk is no longer dropped. (STENO-IDX-03)
- Deleting a tailed log no longer crashes the process with an unhandled rejection. `watch` mode drops that session, and `live` mode waits for the log to reappear. (STENO-IDX-04)
- A log created empty is no longer locked into the JSONL adapter. Detection waits for its first line. (STENO-IDX-05)
- Lines appended during the startup catch-up are indexed right away, not at the next write. (STENO-IDX-19)
- Rename rotation, atomic replace and truncate-and-rewrite are followed. The old file is drained first. A rewritten file is read from the top instead of from a stale offset. (STENO-IDX-20)
- `watch` mode starts exactly one tailer per new file, and `stop()` stops every tailer it started. (STENO-IDX-21)
- Identical id-less lines ("continue", "ok") stay separate messages. (STENO-IDX-26)
- A UTF-8 BOM at the start of a log is stripped. (STENO-IDX-27)
- `live` and `daemon` wait for a log that doesn't exist yet instead of exiting with ENOENT. (STENO-IDX-28)
- Claude Code tool results (file reads, grep and test output), caveats and subagent prompts are no longer mined as the user's decisions and corrections. (STENO-IDX-08)
- Patterns no longer match inside words ("will use", "factually", "autocorrection:"). "Use X instead of Y" records X, not "of Y". First-person tool narration isn't a decision. A sentence-initial "Actually, …" correction is kept. On the labeled corpus, precision went from 0.27 to 1.00 and recall from 0.63 to 1.00 (a development set; CI floors 0.95 / 0.90). (STENO-IDX-07)
- An Anthropic log whose first turn is string content no longer loses its `tool_use` blocks when detection picks the OpenAI adapter: both chat adapters share one normalizer, and either reads `tool_calls`, content blocks and `created`. (STENO-IDX-09)
- Under the hashed embedder, unrelated decisions no longer supersede each other. (STENO-IDX-06)
- An offline start, or a mistyped `--embeddings`, can no longer mix two embedding spaces in one database. (STENO-IDX-24)
- In `watch` mode a decision reversed in a later session is closed. When logs replay out of time order, the newer version wins. (STENO-IDX-12)
- In `assert` mode a second successor of one decision gets its own proposal. Signing every proposal, in any order, leaves one current version. (STENO-IDX-22)
- `get_context_frame` stays within its budget in every section and keeps the newest message. (STENO-IDX-14)
- GraphRAG fuses vector, entity and recency ranks instead of ranking fixed-score entity and path chunks above messages. Neighbors come from the same session. Its vector step uses the persistent index. (STENO-IDX-16)
- `get_recent_messages` returns the last lines of logs without timestamps (anthropic, openai without `created`). (STENO-IDX-17)
- Tool-call-only turns are embedded as their calls (name and arguments) instead of empty text, and text with no features gets no vector, so it no longer scores 0.5 against every query under hashed. Scores are cosine similarity for vectors of any length. (STENO-IDX-18)
- Session-scoped vector search no longer comes back empty when other sessions crowd the global top-k, and `k` above 1,024 no longer returns a 500. (STENO-IDX-13)
- Text past MiniLM's input window (a few hundred tokens; the rest was dropped) is searchable: long messages are embedded in overlapping ~1,000-character windows (at most 64). (STENO-IDX-25)
- Indexing is linear in session length (an indexed, embedding-free history read; statements prepared once; `synchronous=NORMAL` under WAL): 1k/4k/10k messages in 0.8/3.0/7.3 s on the test workload, against 2.2/19.7 s for 1k/4k before. (STENO-IDX-15)
- Importance totals are stored and used by GraphRAG and context frames, as the README describes. (STENO-IDX-23)

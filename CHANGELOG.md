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

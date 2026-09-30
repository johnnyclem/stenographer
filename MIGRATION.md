# Migrating to 1.0

## Ingestion (checkpoints, deterministic ids)

**State database.** Opening a pre-1.0 database migrates it in place (`PRAGMA user_version` 0 → 2). Existing rows are kept, and an `ingest_checkpoints` table is added. The database switches to WAL mode, so `-wal` and `-shm` files appear next to it. Copy all three when you move a live database, or stop stenographer first. A 0.x build can't open the database after 1.0 has migrated it.

**First start on an existing database.** Pre-1.0 databases have no checkpoints, so 1.0 reads each log once from the top. For formats whose lines carry an id (`claude-code` uuids, `jsonl` ids), messages that are already indexed are recognized and skipped, and nothing is derived from them a second time. For id-less formats (`openai`, `anthropic`, `generic` lines without `id`), the message id scheme changed (32-bit FNV → 128-bit hash of path, offset and line). That first pass therefore adds each message again under its new id, next to the old row. To avoid the duplicates, index into a fresh state path and carry the signed truth over:

```bash
# export signed truth from the old database, re-index into a new one, import
stenographer start ./log.jsonl ./old.db --mode catchup   # then call export_wiki_entries
stenographer start ./log.jsonl ./new.db --mode catchup   # then call import_wiki_entries
```

**Intentional re-index.** A restart no longer re-reads a log. To rebuild derived state (after changing `supersedeThreshold`, say), use a fresh state path as above.

**Objections in `deliver` mode.** Lines a log already held when stenographer started are now scanned in shadow in every mode, not only `catchup`. If you relied on a restart to push objections for old lines, rule on them from `list_objections` with `includeShadow`.

**Session ids in `live`, `daemon` and `catchup`.** The first run on a log mints `session_<ms>` as before. Later runs on the same log and state database reuse it. Nothing needs changing unless you parsed the session id to learn when the process started.

**Library users.**

- `Tailer` in follow mode resolves `start()` even when the file is missing, and waits for it. Catchup (`follow: false`) still rejects.
- The `message` listener gets `(msg, position)`. Existing one-argument listeners keep working.
- A custom `LogAdapter.parseLine(line, context?)` can use `context.source` and `context.offset` to derive stable ids.
- Code that relied on `decision_<ms>_<random>` or `msg_<fnv>` id shapes must treat ids as opaque.

# Migrating to 1.0

## Truth layer: profiles, identity and notarization

### Agent MCP configs

Nothing to add. `stenographer start …` now serves the `agent` profile by default. Remove `--require-notary`: notarization is the default, and the flag is accepted but does nothing.

Agent tool calls no longer take identities. Drop `proposedBy` and `agentSessionId` from `propose_tombstone`, `author` and `agentSessionId` from `assert_uv`, and `author`, `signedBy` and `agentSessionId` from `resolve_uv`. Passing any of them is now a validation error. To choose the name writes are attributed to, set it once on the server:

```json
{
  "mcpServers": {
    "stenographer": {
      "command": "npx",
      "args": ["-y", "@stenographer/core", "start", "./conversation.jsonl", "--agent-identity", "claude-code:@ingest"]
    }
  }
}
```

Without `--agent-identity`, writes are attributed to `agent:<name the MCP client reports>`, e.g. `agent:claude-code`.

`resolve_uv` in the agent profile refuses resolutions that would mint a TB (verifying a UV that contests a TB, and `mintTombstone`). Leave such a UV open with your evidence, or draft the successor with `propose_tombstone`.

### Tools that moved to the operator profile

`sign_proposal`, `dismiss_proposal`, `override_tombstone`, `file_ruling`, `rule_on_objection`, `assert_tombstone`, `import_wiki_entries`, `export_wiki_entries` and `backfill_legacy_tombstones` are served only by `--profile operator`. If a notary UI or script called them over MCP, point it at a separate server started with `--profile operator`, or use the REST notary routes (with the REST bearer token and `X-Notary-Secret`; see [REST needs a bearer token](#rest-delivery-and-session-identity)) or `stenographer notarize`. Operator tools take the person's name as an argument, as before; `agentSessionId` is gone from them. `sign_proposal` in the operator profile now notarizes, so it also signs agent drafts (`requiresNotary`).

Don't give the operator profile to an agent.

### Single-user setups that let the agent assert TBs

0.x without `--require-notary` let an agent call `assert_tombstone` with any `signedBy`. The closest 1.0 equivalent is `--allow-agent-assert`: the agent profile serves `assert_tombstone` (no `signedBy` argument), signed by the agent identity. `resolve_uv` can't mint there: command evidence no longer self-signs (see [Command evidence](#command-evidence)). A TB that should carry a person's name goes through the notary paths or the operator profile.

### Library users (`Stenographer`, `TruthLedger`, `StenographerServer`)

- `StenographerConfig.requireNotary` is removed. Use `profile`, `allowAgentAssert`, `agentIdentity` and `signerRegistry`.
- `signProposal`, `notarizeProposal`, `dismissProposal`, `overrideTombstone`, `fileRuling` and `ruleOnObjection` require a person. With `signerRegistry` set, the identity must be listed as `human`; without it, any non-anonymous, non-reserved name works, as before. They throw `IdentityError` (a `TruthWriteError`) otherwise.
- `migration`, `detector:*` and identities with control characters are rejected as author or signer on every write path except the backfill and `addProposal`.
- Identities are stored trimmed and NFC-normalized, and compared case-, width- and invisible-character-insensitively. `Alice` can no longer corroborate `alice`.
- `TruthLedger.fileRuling` throws on a `kind` other than `strike`, `promotion` or `contempt`. `TruthLedger.getTruth` throws on an unknown filter.
- `addProposal` dedupes only within the same author and notary requirement. Detector pipelines that re-file the same target under the same identity still dedupe.
- `Stenographer.draftTombstone` returns `dedupedInto` when it returned the drafter's existing open draft, and doesn't raise it to the notary again.
- `StenographerServer.start()` still serves stdio. Use `connect(transport)` to attach another transport.
- `runNotaryCLI(command, args, io?)` takes an optional `NotaryIO`.

### Signer registry (optional)

```json
{ "signers": [
    { "id": "johnnyclem", "role": "human", "aliases": ["johnny"] },
    { "id": "agent:*", "role": "agent" } ] }
```

Pass it with `--signer-registry signers.json` to `stenographer start`, and to `stenographer notarize` if you use the terminal notary. With a registry, the agent identity must resolve to an `agent` entry. Add `agent:*`, or your `--agent-identity`. Otherwise agent writes fail: at startup when `--agent-identity` is set, at the first write when the identity comes from the MCP client.

### Terminal notary

`stenographer notarize` prints a random code; type that back. The last four characters of the proposal id no longer confirm.

## Truth ledger: derived status, hash chain and evidence

### Existing state files

Nothing to run. The first time a 1.0 stenographer opens a pre-1.0 state file (`start`, `verify`, `notarize`, `proposals`), it adds the chain columns and chains the existing truth entries as they are, in insertion order. Under `start`, `notarize` and `proposals` this is schema migration 4 (see [Ingestion](#ingestion-checkpoints-deterministic-ids)), in the same versioned runner as the index tables. A `MARKER` entry (`chained-at-migration`, author `migration`) closes the run. For those entries the chain shows that they have not changed since the migration, not since they were written. Statuses are re-derived from links, and the marker lists any that change: typically a TB the 0.x contest bookkeeping had set back to active after it was overridden (STENO-T-06), which is now overridden again and stops objecting.

Run `stenographer verify <state-path>` after upgrading. Keep the head hash it prints somewhere other than the state file, for example in a commit. Then a truncated or rewritten ledger shows up as a different head.

Don't point a 0.x stenographer at a migrated file. Its writes aren't chained, and its status updates rewrite rows, so `verify` fails and `start` refuses to serve the ledger until you pass `--skip-verify`.

### `stenographer start` checks the ledger

`start` runs the same check as `verify` and exits if the ledger fails it. To serve it anyway while you investigate, pass `--skip-verify`.

### Command evidence

Evidence of kind `command` is recorded as `claimed-command`. It no longer self-signs a TB minted by `resolve_uv`.

- Operator `resolve_uv` calls, and `TruthLedger.resolveUv`/`Stenographer.resolveUv`, that verify a contest or pass `mintTombstone` need `signedBy` (a person) and an `opinion`. They file a promotion ruling.
- On an `--allow-agent-assert` server, the agent's `resolve_uv` can no longer mint a TB from command evidence. Use `assert_tombstone` for TBs the agent signs, or leave the UV open for a person.
- If you grade entries by evidence kind (smallchat's handoff), `claimed-command` grades asserted, not verified.

### Library users

- Don't write to `truth_entries` or `truth_links` directly. Any row inserted, updated or deleted outside `TruthLedger` fails `verify`, and so does any change to the `status` or `struck` columns.
- `body.status` on returned entries is derived. Stored bodies no longer contain it, so a raw `SELECT body` won't show it.
- A dismissed proposal is closed by a `RULING` with `body.kind === 'dismissal'` and a `dismisses` link. Code that lists rulings may want to skip that kind. `dismissProposal` takes an optional fourth `ctx` argument (timestamp, provenance, session).
- New union members: `TruthEntryType` includes `'MARKER'`, `LinkType` includes `'dismisses'`, `RulingKind` includes `'dismissal'`, and `EvidenceSchema`'s `kind` includes `'claimed-command'`. Exhaustive `switch`es over these need a new case.

## Team wiki: truth format v2

### Wiki tools

`export_wiki_entries` and `import_wiki_entries` (operator profile) take `file`, a `.jsonl` name inside the wiki directory, instead of `path`:

```json
{ "name": "export_wiki_entries", "arguments": { "file": "johnny.jsonl" } }
{ "name": "import_wiki_entries", "arguments": { "file": "sam.jsonl" } }
```

The wiki directory is `wiki/` next to the state file. Pass `--wiki-dir <dir>` to use another, such as a git-backed team wiki checkout. Files outside it can't be named, and a symlink that points outside it is refused, so put the files themselves there.

### One writer per file

Each person's stenographer exports to a file of its own (for example `wiki/<handle>.jsonl`) and imports the others'. Export appends only what its file lacks, and refuses a file holding lines it didn't write, so a shared `truth.jsonl` that several people exported into won't take a 1.0 export: start a file per person. Tools that author truth outside stenographer (the Swift messenger) go through stenographer's API or MCP tools, not the file.

`since` exports still work but are deprecated: pass `sinceSeq` with the `lastSeq` of your previous export.

### Upgrading a team from 0.x files

1.0 still reads v1 lines, but they carry no hash, so a v1 TB is filed as a reconciliation proposal for a person to sign rather than landing as truth. v1 UVs land as before. To move to v2, each member upgrades and exports into a new file. Once everyone's v2 file is in the wiki, the v1 file can be retired.

If you use a signer registry, list your teammates in it: with one, a TB from the wiki lands as truth only when its author and signer are listed, and an override or strike applies only when a listed person filed it. Without one, any accountable name is accepted, as on live operator paths, and the hash chain shows a file is unchanged, not who wrote it.

### Reading the import result

`import_wiki_entries` runs a file in one transaction. Check `committed`: when it's `false`, nothing was written and `errors` lists each bad line (`{line, id, error}`). `proposals` lists lines filed for a person to sign or dismiss (with a `reason`), `held` lists status changes not applied (with a reason; a later import retries them), and `derived` counts TRANSITION lines, which stenographer checks against their causes rather than applies. Re-importing a file is a no-op.

### Library users

- `exportWikiEntries(ledger, {sinceSeq?, since?})` returns `{lines, count, lastSeq, skipped}` and touches no file; write with `appendWikiFile({dir, file, statePath}, lines)`. `importWikiEntries(ledger, {lines}, {signers?, embeddings?})` takes lines; read them with `readWikiFile({dir, file})`. Neither accepts `path` any more.
- `entryToWikiLine`, `wikiLineToEntry`, `WikiEntryLine` and `TruthLedger.getExportableEntries` are gone. To read lines, use `decodeWikiLine` and `checkWikiChain`. `TruthLedger.importEntry` takes `(entry, links, opts)`, and `importChange` imports addenda and rulings.
- Consumers of the format (short-hand, smallchat, smallchat-swift): follow `spec/truth-format/README.md`, and run `spec/truth-format/fixtures/` in your tests. A line's current status is its latest TRANSITION's, else the entry line's own `status`; unknown statuses fail closed.
- Proposal files: write the v2 PROPOSAL envelope (`kind: "tb"|"uv"`, `signal.source: "compaction-candidate"|"agent"|"detector:<name>"`, chained with `seq`, `prevHash`, `hash`). The bare short-hand dialect and `shorthand-compaction` are still read.

## Objections and the pre-dispatch gate

### Existing state files

The `objections` table is rebuilt the first time 1.0 opens it (schema migration 4), with `(session_id, message_id, tb_id, dead)` as its unique key instead of `(message_id, tb_id, dead)`. Rows are kept. Nothing to do. If you query the table directly: the same message id can now appear once per session, and objections the gate filed have message id `gate:<call digest>`.

### What raises an objection

Objections now read only what a tool call asserts (see the README's "Real-time objections"). If you relied on objections raised by searches, reads, commit messages or `echo` to the terminal, those were false positives and stop. A tool of your own is read through content-like field names (`content`, `new_string`, `new_str`, `file_text`, `code`, `patch`, …). If yours carries new content under another name, objections and the gate won't see it.

The matcher now works by clause. Literals you tuned around the old "a line that mentions `current` never objects" rule may object more on lines like `LOG_BUDGET = 30; MAX_RETRIES = 100`, and less on negated prose. Before you rely on a literal, run `findLiteralHits(text, literal)` on real snippets.

### Turning on the gate

The gate is opt-in. To use it, add the `PreToolUse` hook from the README's "Pre-dispatch gate" in shadow mode, rule on what it files, and move to `--mode enforce` once the sustain rate holds. Use `npx -y @stenographer/core gate`, or the installed `node_modules/.bin/stenographer gate`, not a bare `npx stenographer`, which doesn't run this package.

### Library users

- `findLiteralHits` keeps its signature. It now lives in `literal-matcher.ts` (re-exported from `objections.ts` and the package root). For many literals, compile one `LiteralMatcher`.
- `assertedText(msg)` returns only asserting text (see above). `assertingFields(toolName, input)` gives the same per tool call, field by field.
- `ObjectionLog.scan` is unchanged. `ObjectionLog.compiled()` exposes the cached matcher, and `raiseAtGate`/`gateRuling` are the gate's write and read paths.

## Ingestion (checkpoints, deterministic ids)

**State database.** Opening a pre-1.0 database migrates it in place (`PRAGMA user_version` 0 → 4). Existing rows are kept, an `ingest_checkpoints` table is added, and step 4 brings the truth layer along: the ledger is hash-chained (see [Existing state files](#existing-state-files)) and the objections table rekeyed. The database switches to WAL mode, so `-wal` and `-shm` files appear next to it. Copy all three when you move a live database, or stop stenographer first. A 0.x build can't open the database after 1.0 has migrated it. Every 1.0 opener (`start`, `notarize`, `proposals`, `verify`, `stenographer gate`) refuses a database a newer stenographer wrote, rather than touching it.

**First start on an existing database.** Pre-1.0 databases have no checkpoints, so 1.0 reads each log once from the top. For formats whose lines carry an id (`claude-code` uuids, `jsonl` ids), messages that are already indexed are recognized and skipped, and nothing is derived from them a second time. For id-less formats (`openai`, `anthropic`, `generic` lines without `id`), the message id scheme changed (32-bit FNV → 128-bit hash of path, offset and line). That first pass therefore adds each message again under its new id, next to the old row. To avoid the duplicates, index into a fresh state path and carry the signed truth over. The wiki tools are operator tools, so run these servers with `--profile operator` (from a notary UI or CLI, not an agent), and name the file inside one shared wiki directory:

```bash
# export signed truth from the old database, re-index into a new one, import
stenographer start ./log.jsonl ./old.db --mode catchup --profile operator --wiki-dir ./wiki
#   then call export_wiki_entries {"file": "carry-over.jsonl"}
stenographer start ./log.jsonl ./new.db --mode catchup --profile operator --wiki-dir ./wiki
#   then call import_wiki_entries {"file": "carry-over.jsonl"}
```

The export is a hash-chained v2 stream, so its signed TBs land as truth in the new database (with `--signer-registry`, when their signers are listed); anything else arrives as a reconciliation proposal to sign (see [Team wiki: truth format v2](#team-wiki-truth-format-v2)).

**Intentional re-index.** A restart no longer re-reads a log. To rebuild derived state (after changing `supersedeThreshold`, say), use a fresh state path as above.

**Objections in `deliver` mode.** Lines a log already held when stenographer started are now scanned in shadow in every mode, not only `catchup`. If you relied on a restart to push objections for old lines, rule on them from `list_objections` with `includeShadow`.

**Session ids in `live`, `daemon` and `catchup`.** See [Session identity](#session-identity) below: a log's session is now its harness session id or its basename, never `session_<ms>`.

**Library users.**

- `Tailer` in follow mode resolves `start()` even when the file is missing, and waits for it. Catchup (`follow: false`) still rejects.
- The `message` listener gets `(msg, position)`. Existing one-argument listeners keep working.
- A custom `LogAdapter.parseLine(line, context?)` can use `context.source` and `context.offset` to derive stable ids.
- Code that relied on `decision_<ms>_<random>` or `msg_<fnv>` id shapes must treat ids as opaque.

## Extraction and retrieval

**Embedder pinning.** The first 1.0 start on a pre-1.0 database records the embedder it runs with and prints a warning, because the database can't say which embedder wrote its vectors. If that run's `--embeddings` differs from what you used before (for example, the old build silently fell back to hashed on an offline machine), restart once with `--reembed`. After that, starting with a different `--embeddings` fails with `EmbedderMismatchError` instead of mixing vector spaces. To switch embedders on purpose, start with the new `--embeddings` and `--reembed`. Re-embedding covers messages and truth entries and costs about what embedding them cost when they were indexed.

**Offline machines.** A start without `--embeddings` that can't download or load MiniLM now exits with an error instead of switching to hashed. Pass `--embeddings hashed` on machines that are always offline, or `--embeddings auto` to keep the old fallback (it now warns, and pins the database to hashed when it falls back).

**Supersede threshold.** Under `--embeddings hashed` the default is now 0.75 (it was 0.45, which let unrelated decisions close each other). If you tuned `supersedeThreshold` for hashed, check it against `test/fixtures/supersession-pairs.json`. Decisions that were wrongly closed before stay closed: rebuild into a fresh state path (see above) to re-derive them.

**What gets mined.** Decisions, corrections and entities are now extracted only from user and assistant prose. Re-indexing an old log yields fewer decisions (tool output, caveats and subagent prompts no longer count) and some different ones ("use X instead of Y" now records X). Existing rows are not rewritten: derived state changes only for lines indexed from now on, or after a rebuild into a fresh state path.

**Message roles and tags.** Consumers of `get_recent_messages` or `GET /messages` see role `tool` (with `tags: ["tool_result"]`) for Claude Code and Anthropic tool-result turns that used to be `user`, and `tags` on harness, subagent and compaction records. Rows indexed before 1.0 keep their old role.

**GraphRAG results.** `search_conversation` and `GET /graphrag` return only messages. Code that read `type: 'entity'` or `type: 'path'` results should read `meta.matchedEntities` and `meta.paths` on the message results instead; code that parsed the `Context:` block from `content` should read `meta.neighbors`. `score` is a reciprocal-rank-fusion score (small numbers, comparable only within one query); `meta.vectorScore` keeps the cosine.

**Supersession proposals.** New proposals use `targetRef` `<superseded-id>-><successor-id>`. Open proposals written before 1.0 keep the bare decision id as `targetRef`; they still sign and dismiss as before.

**Large `k`.** REST and MCP now clamp `k` to 200 instead of passing it through. Page with smaller queries if you relied on more.

**Library users.**

- Custom `Embedder` implementations need `identity` (`{kind, model, dimensions, version}`) and `supersedeThreshold`.
- `createEmbedder(model)` throws when a transformer can't load; `createEmbedder('auto')` falls back to hashed.
- `extractStructure(msg).corrections[].to` is the current statement (read `to`, not `from`).
- `ConversationMessage` and `IndexedMessage` have optional `tags`; `IndexedMessage` has `seq`, `toolCalls` and `chunkEmbeddings`.
- `GraphRAGRetriever.indexMessage(msg, embedding?, info?)` takes `{entityIds, importance, seq}` so entity evidence, recency and importance can be ranked. The retriever accepts a `vectorSearch` option to delegate its vector step.

## REST, delivery and session identity

**REST needs a bearer token.** Every route, including the notary routes and `GET /proposals`, now needs `Authorization: Bearer <token>`. On first start with REST on, stenographer writes a token to `rest-token` next to the state database (mode 0600) and prints the path. Give its contents to each client: dashboards, scripts (`curl -H "Authorization: Bearer $(cat rest-token)"`), smallchat's notary client (it also still sends `X-Notary-Secret`), and OpenAPPA (`token_env`). To choose the token yourself, set `STENOGRAPHER_REST_TOKEN` (at least 16 characters). To keep 0.x behavior on a trusted machine, pass `--rest-insecure`. Requests must also name an allowed `Host`. Clients that connect to `localhost`, `127.0.0.1` or `[::1]` need nothing extra. If you bind `--rest-host 0.0.0.0` and clients use another name (a container hostname), add `--rest-allow-host <name>`. Library users construct `new RestServer(engine, { token })` (or `{ insecure: true }`).

**Stricter query parameters.** Values that 0.x replaced with defaults (`k=abc`, `n=0`, `depth=-1`, `include=all`) now get 400. Send integers, or leave the parameter out.

**Webhook signatures.** Receivers that checked `X-Stenographer-Signature: sha256=<hex HMAC-SHA256(secret, body)>` must switch to Standard Webhooks verification: compute `base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))` and compare it with the value after `v1,` in `webhook-signature`, and reject timestamps more than a few minutes old. The key is the secret's UTF-8 bytes, or for a `whsec_` secret its base64-decoded bytes. In the reference libraries, `new Webhook(secret, { format: "raw" })` (or a `whsec_` secret as-is) verifies it. `STENOGRAPHER_WEBHOOK_SECRET` must be at least 24 bytes, so generate a new one if yours is shorter (`openssl rand -base64 32`). `X-Stenographer-Event` is unchanged.

**Redirecting receivers.** A receiver URL that answers with a redirect now fails delivery permanently. Configure the final URL.

**Delivery retries and dead letters.** An objection a receiver refuses with a 4xx (other than 408/429) is no longer retried, and one that fails 8 times is dead-lettered. Read `get_status` → `objections.deadLettered`, or `engine.store.objectionDelivery.deadLetters()` for the details. After fixing a receiver, `retryNow()` makes backed-off deliveries due at once. Dead letters stay dead, because by then the agent has moved on. Non-interrupting webhooks now get a partial batch after 5 minutes. Set `maxBatchDelayMs` on the sink to change that.

**Redacted URLs.** `propose_tombstone`'s `raisedTo` and `undelivered[].url` now show `scheme://host:port` (plus `/…` when the URL has a path or query) instead of the full URL. Match receivers by origin if you compared these.

### Session identity

Objections, `meta.session_ids` and session-scoped queries use the harness's session id when a log line records one (Claude Code's `sessionId`), and otherwise the log's basename (`agent-7.jsonl` → `agent-7`). This is the same in every mode. In 0.x, `live`, `daemon` and `catchup` used `session_<start time>`. That changed on every restart and never matched what smallchat's messenger routes by. A pre-1.0 database has no checkpoints, so the first 1.0 start reads each log from the top (see [Ingestion](#ingestion-checkpoints-deterministic-ids)). Messages it recognizes move to the new session id along with their decisions and tombstones. Entity counts stay under the old id, so re-index into a fresh state path if you need them in scope. Watch mode already named sessions after their files, so it changes only for logs whose lines name another session. Library code that relied on `new Tailer(path)` producing `session_<ms>` gets the basename now, and a message whose adapter parsed a `sessionId` keeps it rather than being overwritten.

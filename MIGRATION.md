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
      "args": ["stenographer", "start", "./conversation.jsonl", "--agent-identity", "claude-code:@ingest"]
    }
  }
}
```

Without `--agent-identity`, writes are attributed to `agent:<name the MCP client reports>`, e.g. `agent:claude-code`.

`resolve_uv` in the agent profile refuses resolutions that would mint a TB (verifying a UV that contests a TB, and `mintTombstone`). Leave such a UV open with your evidence, or draft the successor with `propose_tombstone`.

### Tools that moved to the operator profile

`sign_proposal`, `dismiss_proposal`, `override_tombstone`, `file_ruling`, `rule_on_objection`, `assert_tombstone`, `import_wiki_entries`, `export_wiki_entries` and `backfill_legacy_tombstones` are served only by `--profile operator`. If a notary UI or script called them over MCP, point it at a separate server started with `--profile operator`, or use the REST notary routes or `stenographer notarize`. Operator tools take the person's name as an argument, as before; `agentSessionId` is gone from them. `sign_proposal` in the operator profile now notarizes, so it also signs agent drafts (`requiresNotary`).

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

Nothing to run. The first time a 1.0 stenographer opens a pre-1.0 state file (`start`, `verify`, `notarize`, `proposals`), it adds the chain columns and chains the existing truth entries as they are, in insertion order. A `MARKER` entry (`chained-at-migration`, author `migration`) closes the run. For those entries the chain shows that they have not changed since the migration, not since they were written. Statuses are re-derived from links, and the marker lists any that change: typically a TB the 0.x contest bookkeeping had set back to active after it was overridden (STENO-T-06), which is now overridden again and stops objecting.

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

The `objections` table is rebuilt the first time 1.0 opens it, with `(session_id, message_id, tb_id, dead)` as its unique key instead of `(message_id, tb_id, dead)`. Rows are kept. Nothing to do. If you query the table directly: the same message id can now appear once per session, and objections the gate filed have message id `gate:<call digest>`.

### What raises an objection

Objections now read only what a tool call asserts (see the README's "Real-time objections"). If you relied on objections raised by searches, reads, commit messages or `echo` to the terminal, those were false positives and stop. A tool of your own is read through content-like field names (`content`, `new_string`, `new_str`, `file_text`, `code`, `patch`, …). If yours carries new content under another name, objections and the gate won't see it.

The matcher now works by clause. Literals you tuned around the old "a line that mentions `current` never objects" rule may object more on lines like `LOG_BUDGET = 30; MAX_RETRIES = 100`, and less on negated prose. Before you rely on a literal, run `findLiteralHits(text, literal)` on real snippets.

### Turning on the gate

The gate is opt-in. To use it, add the `PreToolUse` hook from the README's "Pre-dispatch gate" in shadow mode, rule on what it files, and move to `--mode enforce` once the sustain rate holds. Use `npx -y @stenographer/core gate`, or the installed `node_modules/.bin/stenographer gate`, not a bare `npx stenographer`, which doesn't run this package.

### Library users

- `findLiteralHits` keeps its signature. It now lives in `literal-matcher.ts` (re-exported from `objections.ts` and the package root). For many literals, compile one `LiteralMatcher`.
- `assertedText(msg)` returns only asserting text (see above). `assertingFields(toolName, input)` gives the same per tool call, field by field.
- `ObjectionLog.scan` is unchanged. `ObjectionLog.compiled()` exposes the cached matcher, and `raiseAtGate`/`gateRuling` are the gate's write and read paths.

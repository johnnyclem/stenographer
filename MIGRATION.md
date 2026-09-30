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

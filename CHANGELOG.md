# Changelog

## 1.0.0 — unreleased

### Breaking

- **MCP tool profiles, `agent` by default** (STENO-T-01, STENO-T-02). `stenographer start` now serves one of two profiles. `--profile agent` (the default) serves read tools, `propose_tombstone`, `assert_uv` and a `resolve_uv` that refuses any resolution that would mint a TB. `--profile operator` serves the judicial and destructive tools: `sign_proposal`, `dismiss_proposal`, `override_tombstone`, `file_ruling`, `rule_on_objection`, `assert_tombstone`, `import_wiki_entries`, `export_wiki_entries`, `backfill_legacy_tombstones`. Calling an operator tool on an agent-profile server is an error. In the operator profile, `sign_proposal` is the notary act: it signs agent drafts too.
- **Notarization is the default for agents; `requireNotary` is removed** (STENO-T-01). In the agent profile no MCP path mints an active TB without a person. `StenographerConfig.requireNotary` is gone; `--require-notary` is still accepted and does nothing. `--allow-agent-assert` (`allowAgentAssert`) is the single-user opt-out: the agent profile then serves `assert_tombstone` and lets `resolve_uv` mint from `command` evidence, signed by the agent identity.
- **Identity is bound by the server in the agent profile** (STENO-T-18). Agent tools no longer accept `author`, `signedBy`, `proposedBy`, `dismissedBy` or `agentSessionId`; passing one is a validation error. Writes carry `--agent-identity` (`agentIdentity`, default `agent:<MCP clientInfo name>`) and the server's session id.
- **Strict tool arguments** (STENO-T-23). Every tool's arguments are parsed with a strict zod schema before dispatch: unknown arguments, values outside an enum and wrong types are rejected with a validation error, and numeric limits are clamped (`list_objections` `limit: -1` returns 1 objection, not all of them). The advertised `inputSchema` is derived from the same schema (`additionalProperties: false`). `file_ruling` rejects any `kind` other than `strike`, `promotion` or `contempt`; `TruthLedger.fileRuling` does too. Before, an unknown kind was filed as contempt and minted a TB. `TruthLedger.getTruth` throws `TruthWriteError` on an unknown filter instead of running invalid SQL.
- **Reserved and malformed identities are rejected on every public write path** (STENO-T-24). `migration` and `detector:*` are refused as author and as signer everywhere except the backfill and the detector paths (`addProposal`). Identities containing control characters are refused.
- **Contempt of corpus compares canonical identities and checks every actor** (STENO-T-19). Identities compare after NFKC normalization, removal of invisible characters, trimming and case-folding. Session ids are trimmed. `resolveUv` checks the signer as well as the resolver, and checks against the target's author, TB signer and the drafter of the proposal it was signed from. The author, signer or drafter of a TB can no longer refute a contest against it. `Stenographer.ruleOnObjection` refuses a ruling from the session the objection was raised against.
- **Engine write methods validate identities.** `signProposal`, `notarizeProposal`, `dismissProposal`, `overrideTombstone`, `fileRuling` and `ruleOnObjection` require a person. `draftTombstone`, `assertTombstone`, `assertUv` and `resolveUv` take a person or an agent. With a signer registry, identities must be listed in one of those roles and resolve to the registry's spelling. Without one, they are canonicalized (trimmed, NFC). `TbInputSchema` canonicalizes `signedBy` the same way.
- **Proposal dedupe no longer crosses authors** (STENO-T-26). `addProposal` returns an existing open proposal only if it has the same kind, target, author and notary requirement. `propose_tombstone` no longer hands an agent another author's proposal; when it dedupes into the agent's own open draft it says so (`dedupedInto`) and does not raise the draft again.
- **Terminal notary confirmation** (STENO-T-20). `stenographer notarize` asks you to type back a random code it prints on the terminal. It no longer uses the last four characters of the id you passed. `runNotaryCLI` takes an optional `NotaryIO` third argument.
- **Objection text no longer tells the objected agent to rule.** Channel and webhook objection text now says a person rules on it with `rule_on_objection`.
- **Dependencies:** `zod` `^3.25.28` (was `^3.22.0`); `zod-to-json-schema` is now a direct dependency (it was already installed through `@modelcontextprotocol/sdk`).

### Added

- `--profile`, `--agent-identity`, `--allow-agent-assert` and `--signer-registry` on `stenographer start`, and `--signer-registry` on `stenographer notarize`.
- Signer registry: a JSON allowlist of signers with roles `human`, `agent` or `detector`. It supports aliases and prefix entries such as `agent:*`, and operator paths check against it (MCP operator profile, REST notary routes, terminal notary). Exported as `SignerRegistry`, `resolveIdentity`, `IdentityError`, `Stenographer.resolveIdentity`.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- `StenographerServer.connect(transport)` to attach any MCP transport.
- `TruthLedger.findOpenProposal`, and `resolveUv({ allowMint: false })`.
- `get_status` reports the profile, the bound agent identity and `allowAgentAssert`.

### Fixed

- UV proposals whose draft carries `contests: null` (wiki reconciliation, short-hand and smallchat intake) can be signed. Signing edits may set `contests: null` to drop a contest (STENO-T-08).
- `get_truth` with an unknown `truthFilter` returns a validation error instead of `no such column: undefined` (STENO-T-23).

### Documentation

- README: "Notarization, identity and the threat model". It covers what the agent profile protects (an agent limited to an agent-profile MCP connection) and what it does not: anything running as the operator's user can read the notary secret, change the profile, or drive the terminal notary through a pseudo-terminal (STENO-T-20, STENO-T-21).

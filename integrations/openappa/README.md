# OpenAPPA integration

[OpenAPPA](https://github.com/archestra-ai/OpenAPPA) checks every tool call
a protected Claude Code session makes against an information-flow policy
before the call runs: who may read the data the session holds (its
audience), and whether text written outside the session has reached it
(its trust). This directory holds a policy *battery* for stenographer's
MCP tools, and the replay tests that pin down the decisions it makes.

Pinned version: **OpenAPPA 0.30.0**. The battery, the traces and the
package manifest are checked with the `appa` 0.30.0 CLI. OpenAPPA changes
its TOML format, trace grammar and manifest schema between releases
without compatibility shims, so check before moving to another version:
`npm run test:openappa` warns when the `appa` it finds is not 0.30.0.

| Path | What it is |
| --- | --- |
| `stenographer/` | The battery package: `appa-package.toml`, `appa.toml` (the rules), and a `README.md` with each rule's reasoning and its limits |
| `policy-tests/notary/` | A root config with an attention-only authority, and `appa replay` traces |
| `policy-tests/plugin-default/` | A root config with the Claude Code plugin's default authority, and a trace |
| `run-checks.mjs` | `npm run test:openappa` |

## What the battery enforces

OpenAPPA applies these rules to stenographer's MCP tool calls in a
protected Claude Code session, whichever profile serves them. Each tool
has a canonical id, `mcp/stenographer/<tool>`; OpenAPPA refuses a call
that no rule names (or hands it to the deployment's `*` annotator).

| Tools | Rule | Effect in a session |
| --- | --- | --- |
| Transcript reads: `get_recent_messages`, `search_conversation`, `search_similar`, `get_context_frame`, `get_entities`, `get_relations`, `get_decisions`, `get_decision_history`, `get_decision_chain`, `get_corrections` | result `self`, `suspicious` | In watch mode these return other sessions' text, quoting whatever those sessions read. After one, the session's data can't go to anyone but the person running it, and a call that needs trusted data needs an approval first. |
| Ledger reads: `get_truth`, `search_truth`, `get_contested`, `get_verification_queue`, `list_proposals`, `list_objections`, inline `export_wiki_entries` | result `self`, `suspicious` | Same: agent-written UVs and drafts, and quoted transcript lines. |
| `get_status` | result `self` | Keeps the session's trust. |
| `propose_tombstone` | none; records `stenographer.proposed` | A draft is not truth and runs from any session. It becomes truth only when a person signs it. |
| Truth writes: `assert_uv`, `resolve_uv`, `assert_tombstone`, `backfill_legacy_tombstones`, `export_wiki_entries` into a file | requires `trusted`; records `stenographer.changed` | Text that came from outside the session cannot become truth, contest a TB or settle a UV unless an authority approves the exact call. |
| A person's acts: `sign_proposal`, `dismiss_proposal`, `override_tombstone`, `file_ruling`, `rule_on_objection`, `assert_tombstone`/`resolve_uv` with `signedBy`, and `import_wiki_entries` (a file applies overrides, strikes and rulings in its writers' names) | requires `trusted` and the `hitl` mark; records `stenographer.ruled` too | The person approves every act done in their name, every time, even from a trusted session. |

What it does not cover:

- Calls outside a protected session's MCP traffic: the REST API, the
  terminal notary (`stenographer notarize`), other harnesses, and
  sessions without OpenAPPA. A person who signs a bad draft through any
  of them makes it truth.
- The ledger's own contents. OpenAPPA labels what a call returns, not
  what stenographer stores, so the battery labels reads by who can write
  the ledger. Write results keep the session's trust because OpenAPPA
  checks a call's requirements against the label its own result leaves;
  `stenographer/README.md` lists the three results that can still carry
  unvouched text.
- Tampering with the ledger file: that is `stenographer verify` (hash
  chain), not policy.
- Dead literals in what the agent writes to files or runs in a shell:
  that is the `stenographer gate` PreToolUse hook. It runs beside
  OpenAPPA's hook, and a deny from either one blocks the call.

## Install it next to the claude-code battery

1. Install OpenAPPA 0.30.0 and its Claude Code plugin
   (`appa plugin install claude-code`). The plugin writes the root config,
   `appa.toml`, in OpenAPPA's config directory — `~/.config/appa/` on
   Linux, `~/Library/Application Support/appa/` on macOS, or
   `$APPA_CONFIG_DIR` — and includes `batteries/claude-code/appa.toml`.
2. Register stenographer in Claude Code under the server name
   `stenographer`, so its tools arrive as `mcp__stenographer__<tool>`:

   ```json
   {
     "mcpServers": {
       "stenographer": {
         "command": "npx",
         "args": ["-y", "@stenographer/core", "start", "./conversation.jsonl"]
       }
     }
   }
   ```

   Under another name, or with the operator profile as a second server,
   map the names in the root config:

   ```toml
   [server_aliases]
   stenographer = ["stenographer", "stenographer-operator"]
   ```

3. Copy the battery into the config directory, but not into its
   `batteries/` directory: OpenAPPA replaces that directory whole, with
   the batteries of its catalog, on every `appa battery install` and
   plugin install.

   ```sh
   APPA_DIR=~/.config/appa   # macOS: ~/Library/Application\ Support/appa
   cp -R integrations/openappa/stenographer "$APPA_DIR/stenographer"
   ```

4. Include it after the claude-code battery, and protect the copy the way
   the claude-code battery protects `batteries/` (a write there asks the
   person). In the root config:

   ```toml
   include = ["batteries/claude-code/appa.toml", "stenographer/appa.toml"]

   [[policy.tool]]
   name = "host/claude-code/Write(file_path:*/appa/stenographer/*)"
   requires = { attention = ["hitl"] }
   delta = {}

   [[policy.tool]]
   name = "host/claude-code/Edit(file_path:*/appa/stenographer/*)"
   requires = { attention = ["hitl"] }
   delta = {}
   ```

   The same narrow rules can cover stenographer's signer registry and
   state file. `appa battery install` installs only batteries in
   OpenAPPA's official catalog, and this one is not there yet, so the
   installer does not manage it: `appa battery list` and `appa battery
   remove` recognize only includes the installer wrote, and an upgrade is
   another copy.
5. Check the deployment loads with both batteries:

   ```sh
   appa describe --config "$APPA_DIR/appa.toml" --check \
     --session-tools mcp__stenographer__get_truth,mcp__stenographer__assert_uv
   ```

   Its `Policy tools` line lists the `mcp/stenographer/*` rules, and it
   reports both session tools with a rule.

The plugin's default policy declares a human authority, `hitl`, that may
approve any attention mark, data below `trusted` and an audience up to
`public`. It already permits the `hitl` mark the battery requires, so
nothing else is needed. Under it a ledger write from a suspicious session
asks the person running the session instead of being denied
(`policy-tests/plugin-default/`). To have those writes denied outright,
declare the deployment's authorities without `trust_below`, as
`policy-tests/notary/appa.toml` does; that also removes the remedy for
every other battery's trust requirement.

OpenAPPA's runtime and stenographer's REST daemon both default to
`127.0.0.1:8787`. The plugin's hooks expect the runtime there and block
every action while it doesn't answer, so give the daemon another free
port with `--rest-port`, such as 8789. The daemon can then also serve
OpenAPPA's context consults (`POST /appa/context`, behind the REST bearer
token; see the main README's "OpenAPPA context provider"): bind it as
`[externals.context.stenographer]` with `url =
"http://127.0.0.1:8789/appa/context"` and `token_env` naming a variable
that holds the contents of `<state dir>/rest-token`.

## Do not bind stenographer annotators to broad root rules

The battery ships static rules only. Any stenographer-backed annotator or
context provider you add yourself must not be bound with a root rule that
names a bare built-in tool, such as `host/claude-code/Write`,
`host/claude-code/Edit` or `host/claude-code/Bash`. OpenAPPA checks root
rules before battery rules and the first match wins, so a bare root rule
for `Write` replaces every one of the claude-code battery's `Write` rules:
the `hitl` review for writes into `.claude/settings*` and the deployment's
own `appa/` policy, and the trusted-session requirement for credential
paths such as `.env` and `.ssh`. A rule carries one annotator, and an
annotator whose mandate has no marks cannot block a call anyway. For
literal objections, run `stenographer gate` as its own PreToolUse hook.

## Checks

```sh
npm run build              # the checks read the served tool list from dist/
npm run test:openappa
```

`run-checks.mjs` finds `appa` on `PATH` (or at `$APPA_BIN`). Without one it
prints that it skipped and exits 0. With one, for each root under
`policy-tests/` it runs:

- `appa describe --config <root>/appa.toml --check --session-tools …`
  with every tool the built server serves in either profile. It fails
  unless the config loads and every one of those tools has a rule.
- `appa replay --config <root>/appa.toml <root>/`. Replay proposes each
  call in a trace and checks OpenAPPA's decision; no tool runs, results
  are empty, and a stand-in approves every review.

The traces check that every read runs from a trusted session
(`notary/reads/`, one fresh session per tool), that every ledger write
runs from a trusted session with a review for each act in a person's
name (`notary/writes/`), and that every ledger write is denied once the
session is suspicious, whether the transcript or a web page made it so
(`notary/suspicious-session.appa`, `notary/outside-text.appa`). Under the
plugin's authority the same writes ask the person instead
(`plugin-default/`).

`npm test` includes `test/openappa-battery.test.ts`, which needs no
`appa`: it fails when the battery and the server's tool lists drift
apart, or when a rule breaks the invariants above.

To upstream the battery into OpenAPPA's catalog, copy `stenographer/`
into `marketplace/batteries/` of an OpenAPPA checkout and follow its
[Create your own battery](https://openappa.com/write-a-battery) guide.
The package passes OpenAPPA's own package validator at 0.30.0 (the
`appa-package` crate's `marketplace` example, which
`scripts/appa-marketplace.sh` runs).

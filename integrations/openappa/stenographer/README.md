# stenographer battery

Rules for the [stenographer](https://github.com/johnnyclem/stenographer)
MCP server, all 29 tools of its two profiles: the agent profile that
`stenographer start` serves by default (reads, drafts, UVs) and the
operator profile (`--profile operator`) that serves the notary's and
judge's tools. Plain TOML rules, no helper process or provider
credential. One namespace, `stenographer`: register the server in Claude
Code under that name, so its tools arrive as `mcp__stenographer__<tool>`
and map to `mcp/stenographer/<tool>`. The battery is not in OpenAPPA's
catalog yet: `integrations/openappa/README.md` in the stenographer
repository installs it by hand, outside the `batteries/` store an
install replaces.

## Server version

`@stenographer/core` 1.0.0 (unreleased; the `claude/suite-1.0` branch).
The tool lists are what each profile answers to `tools/list`, including
`assert_tombstone` in the agent profile under `--allow-agent-assert`.
`test/openappa-battery.test.ts` in the stenographer repository fails when
a served tool has no rule or a rule names a tool no profile serves.

## Rules

Trust follows who can write the text, and the audience follows where it
is kept.

*Transcript reads* — `get_recent_messages`, `search_conversation`,
`search_similar`, `get_context_frame`, `get_entities`, `get_relations`,
`get_decisions`, `get_decision_history`, `get_decision_chain`,
`get_corrections`. The indexer takes messages from session logs; in watch
mode those are every session's logs, quoting whatever those sessions read
(web pages, tool output, files). Results enter `suspicious` and are
restricted to `self`: the index is the person's own state file.

*Ledger reads* — `get_truth`, `search_truth`, `get_contested`,
`get_verification_queue`, `list_proposals`, `list_objections`, and
`export_wiki_entries` without `file` (the inline export). UVs and drafts
are written by agents, some in sessions no policy protected; detector
drafts come from transcripts; objections quote transcript lines; no
filter returns only TBs a person signed. Results enter `suspicious`,
restricted to `self`.

*Status* — `get_status` returns counts, modes, this server's profile and
the identity it attributes writes to. Restricted to `self`; it keeps the
session's trust.

*Drafts* — `propose_tombstone` drafts a TB for a person to notarize. A
draft is not truth: it needs no trust and records
`stenographer.proposed`. With `targetRef` the call can return the
drafter's earlier open draft for the same target, which another session
under the same agent identity may have written, so that spelling enters
`suspicious`; without it the result echoes the call's own draft.

*Truth writes* — `assert_uv`, `resolve_uv`, `assert_tombstone`,
`import_wiki_entries`, `backfill_legacy_tombstones`, and
`export_wiki_entries` with `file`. They need trusted data and record
`stenographer.changed` (`stenographer.exported` for the export). A
suspicious trajectory cannot assert a UV, contest a TB, settle a UV or
file a team wiki unless an authority approves the exact call.

*A person's acts* — `sign_proposal`, `dismiss_proposal`,
`override_tombstone`, `file_ruling`, `rule_on_objection`, and the
operator spellings that mint a TB under a person's signature,
`assert_tombstone(signedBy:*)` and `resolve_uv(signedBy:*)`. In the
operator profile the server takes the person's name from the caller and
checks it against its signer registry, if one is configured. Each call
needs trusted data and the `hitl` mark, so the person approves every act
done in their name, and records `stenographer.changed` and
`stenographer.ruled`.

Results that carry ledger entries are restricted to `self`. Write results
keep the session's trust: see the first limit below.

## Root config

The battery binds no audience source and names no credential variable.
`self` stays symbolic unless the root maps it.

The root permits the `hitl` mark. The Claude Code plugin's default policy
ships a human authority permitting every mark, data below `trusted` and
an audience up to `public`; under it a ledger write from a suspicious
trajectory asks the person running the session instead of being denied.
A root that wants those writes denied outright declares an authority for
`hitl` without `trust_below`:

```toml
[[policy.authority]]
name = "stenographer-notary"
hint = "Review the exact ledger act and the name it is signed with."
permits = { attention = ["hitl"] }

[externals.authorities.stenographer-notary]
builtin = "hitl"
```

A deployment that registers the two profiles as two servers binds both
to this namespace:

```toml
[server_aliases]
stenographer = ["stenographer", "stenographer-operator"]
```

## Limits

OpenAPPA checks a call's requirements against the label its own result
would leave, so a rule cannot require `trusted` data and also declare a
`suspicious` result: no call could meet it without an authority that
lifts trust. Write results therefore keep the session's trust. Three of
them can quote text nobody vouched for: `resolve_uv` returns the UV it
settles, `dismiss_proposal` returns the draft it rejects, and
`rule_on_objection` returns the objection with its quoted transcript
line. The two person's acts are reviewed under `hitl` before they run;
`resolve_uv` is not.

A draft needs no trust. Suspicious text can enter the proposal inbox,
comes back out of `list_proposals` as `suspicious`, and becomes truth
only when a person signs it — through `sign_proposal` (gated here), the
terminal notary (`stenographer notarize`) or the REST notary routes. The
last two are not MCP tool calls, and no OpenAPPA rule sees them.

The ledger is kept outside the trajectory. OpenAPPA labels what a call
returns, not what the ledger stores, so the battery labels every ledger
read by who can write the ledger. A deployment that exports the ledger
to a team wiki adds, with a root rule, the audience the wiki's readers
need on each write: no write requires an audience here.

The `hitl` mark is shared with the claude-code battery: an authority
that permits it reviews both batteries' calls. Root rules with their own
mark route stenographer's reviews elsewhere.

## Tests

`appa replay` traces in the stenographer repository
(`integrations/openappa/policy-tests/`) check, from a root with an
attention-only authority, that every read runs from a trusted
trajectory, lowers it to `suspicious` (except `get_status`) and keeps its
result from a public destination; that every write runs from a trusted
trajectory, with a review for each act in a person's name; and that
every truth write is denied once the trajectory is suspicious. A second
root with the Claude Code plugin's default authority checks that the
same writes ask the person instead.

```sh
npm run build
npm run test:openappa
```

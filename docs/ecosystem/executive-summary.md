# Ecosystem Evaluation — Executive Summary (Stenographer Vantage Point)

**Sourcing note:** This evaluation was produced from a GitHub session scoped to
[`johnnyclem/stenographer`](https://github.com/johnnyclem/stenographer) only. Everything about
Stenographer below comes from direct source-code inspection. Everything about **AgentVault**,
**SmallChat**, and **Short-Hand** comes from public READMEs, repo metadata pages, and
AgentVault's own `docs/ecosystem/` files fetched over HTTP (`WebFetch`) — not from browsing their
source. Those claims are marked **[README-sourced]** and should be treated as unverified until
someone with source access to that repo confirms them. This document extends and cross-checks the
AgentVault-side evaluation at
[`docs/ecosystem/executive-summary.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/executive-summary.md)
and
[`docs/ecosystem/engineering-guide.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md);
it does not repeat their AgentVault-internal analysis.

**Updated for stenographer 1.0.0 (2026-10).** Statements about stenographer's own code are corrected where 1.0 changed them: it now has format- and transport-level wiring to smallchat, short-hand and OpenAPPA, serves up to 29 MCP tools in two profiles, and can act on a session when configured to (objection delivery, the pre-dispatch gate). Claims about the other repos are left as they were evaluated on 2026-07-01.

## The four projects, one line each

| Project | Role (per the four-layer thesis) | Confidence |
|---|---|---|
| **AgentVault** | The body — durable on-chain execution, wallet, secrets | [README-sourced] |
| **SmallChat** | The reflexes — deterministic semantic tool dispatch | [README-sourced] |
| **Stenographer** | The memory — passive conversation observer + GraphRAG index | Verified (this repo) |
| **Short-Hand** | Working memory — compacts raw history into an LLM-sized context frame | [README-sourced] |

## The four-layer thesis: holds, with one correction

The AgentVault-side docs propose:

```
AgentVault   →  the body        (durable, on-chain execution + wallet + secrets)
SmallChat    →  the reflexes    (deterministic tool selection, no schema bloat)
Stenographer →  the memory      (passive conversation observer + GraphRAG index)
Short-Hand   →  working memory  (compacts raw history into an LLM-sized context frame)
```

From Stenographer's own source, the "memory" label is accurate for what's actually shipped:
Stenographer tails JSONL logs, extracts entities/decisions, embeds messages, and answers queries
over a local SQLite store. It does not dispatch tools, compact context, or execute anything.
Since 1.0 it is passive by default rather than always: with `--objections deliver` it pushes
objections into the watched session (Claude Code channel notifications, smallchat's channel bridge,
webhooks), and the opt-in `stenographer gate` hook can deny a tool call. It still never generates
conversation text of its own.

**Correction:** the AgentVault-side guide's data-flow diagram places Short-Hand strictly downstream
of Stenographer ("Stenographer → warm state → Short-Hand → context → SmallChat → execution →
AgentVault"). That diagram is aspirational on **both** ends of the Stenographer↔Short-Hand edge —
see Key Finding 2 below. It should be read as a target architecture, not a description of code that
exists today in either repo.

## Key findings, from this repo's vantage

1. **Format- and transport-level wiring, no code dependency.** (Corrected for 1.0; this finding
   originally read "zero code-level ecosystem wiring".) `package.json` still has no dependency on
   any sibling project, and there is no `agentvault` or `smallchat` log adapter (the adapter registry
   is `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`). But 1.0 does wire to its
   neighbours through formats and HTTP: objections and proposal notices go to smallchat's channel
   bridge (`src/truth/delivery.ts`); short-hand's compactor files candidates through proposal intake
   (`src/truth/intake.ts`); the ledger exports [truth format v2](../../spec/truth-format/README.md),
   which short-hand, smallchat and smallchat-swift read; the gate files objections under smallchat's
   canonical call digest (`smallchat.call.v1`); and `integrations/openappa/` plus `POST /appa/context`
   integrate with OpenAPPA. Nothing connects stenographer to AgentVault.

2. **The Short-Hand↔Stenographer edge is asserted by neither repo's code, and the specific
   "language middleware" claim in the runbook does not match Short-Hand's current README.** This
   runbook's own §4 states "its README bills it as 'language middleware for Stenographer and
   SmallChat.'" A direct fetch of `short-hand`'s README (2026-07-01) found no sentence containing
   "Stenographer," "SmallChat," "middleware," or "integrat" anywhere in the document — its tagline
   is simply "Progressive context compaction for LLMs. Old computer science for new constraints."
   Either the README changed since the runbook was written, or the claim was itself an
   overstatement carried from an earlier draft. Practically, this doesn't change the
   recommendation (a compaction library and a conversation index are still a natural pairing), but
   it means the "ready-to-slot-in middleware" framing in the AgentVault-side guide should be
   downgraded from "documented integration" to "plausible pairing with no adapter code on either
   side, and no README claim of readiness on Short-Hand's side either."

3. **Stenographer's own MCP tool and REST surfaces have grown past what the AgentVault-side guide
   assumed.** (Corrected for 1.0.) The guide described 13 MCP-ish tools; 0.1.0-alpha had 11. 1.0
   serves up to 29 in two profiles: 20 in the default `agent` profile (the 11 index tools, six
   truth-ledger reads, `propose_tombstone`, `assert_uv` and `resolve_uv`) and 28 in the `operator` profile (signing, overrides, rulings,
   wiki import/export). The REST read routes (`/status`, `/messages`, `/entities`, `/search`,
   `/graphrag`, etc.) are still there, joined by `/flags`, `/proposals`, the notary `POST` routes
   and `POST /appa/context`, and every route needs a bearer token and an allowed `Host`.

4. **Maturity signal check on the two repos this session could reach publicly:**
   Short-Hand shows 0 stars, no published release, and — notably — its GitHub default branch
   resolves to a feature branch (`claude/setup-shorthand-core-*`) rather than `main`, suggesting
   its "shipped" core may still be mid-merge. SmallChat shows 5 stars and a `0.5.0` release. Both
   figures are **[README/repo-page-sourced]** — not verified against source, since this session
   has no API access to either repo.

5. **No duplication risk found from this side.** Stenographer doesn't reimplement anything
   AgentVault, SmallChat, or Short-Hand claim to own (no on-chain logic, no tool dispatch, no
   context compaction). The one area worth watching if integration proceeds: Short-Hand's
   README-claimed importance-scoring model (state delta 45% / reference frequency 25% /
   trajectory discontinuity 30%) is **identical** to Stenographer's own three-signal model in
   `src/indexer/importance.ts`. That's either a shared design lineage (same author, same idea
   applied twice) or a sign the two projects would double-score the same messages if wired
   together naively — worth resolving explicitly before integration, not after.

## Recommendations

- Treat the four-layer diagram as a roadmap, not a status report, in every repo's docs — this
  session's own `wiki/index.md` already does this correctly ("Roadmap (aspirational stack —
  separate projects, not part of this repo)"); the top-level `README.md`'s Roadmap section should
  keep that same framing rather than implying a working handoff exists.
- If/when a Stenographer→Short-Hand handoff is built, don't have both projects independently
  recompute the same three-signal importance score on the same message — pick one owner (most
  naturally Stenographer, since it's upstream and already computes it during ingestion) and pass
  the score through rather than recomputing it.
- Before quoting Short-Hand's README as evidence of an existing Stenographer integration in any
  future doc, re-fetch it — this evaluation found the "language middleware for Stenographer and
  SmallChat" framing is not currently present in the README text.
- See the companion [`engineering-guide.md`](./engineering-guide.md) for the concrete file-level
  reference table and a phased integration roadmap from Stenographer's side.

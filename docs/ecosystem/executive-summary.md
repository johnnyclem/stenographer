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
Stenographer is a real, tested, passive observer — it tails JSONL logs, extracts entities/decisions,
embeds messages, and answers queries over an append-only SQLite store. It does not dispatch tools,
compact context, or execute anything. It never generates its own text or actions, which matches
"passive observer" precisely — there's no code path in this repo that writes back to the
conversation it watches.

**Correction:** the AgentVault-side guide's data-flow diagram places Short-Hand strictly downstream
of Stenographer ("Stenographer → warm state → Short-Hand → context → SmallChat → execution →
AgentVault"). That diagram is aspirational on **both** ends of the Stenographer↔Short-Hand edge —
see Key Finding 2 below. It should be read as a target architecture, not a description of code that
exists today in either repo.

## Key findings, from this repo's vantage

1. **Zero code-level ecosystem wiring in Stenographer.** A case-insensitive search across
   `src/`, `cli/`, and `test/` for `agentvault`, `smallchat`, `stenograph`, `short-hand`, and
   `shorthand` returns no hits outside `README.md` and `wiki/*.md`. `package.json` has no
   dependency on any sibling project. There is no `agentvault` or `smallchat` adapter in
   `src/indexer/adapters.ts` (the adapter registry is `jsonl`, `claude-code`, `anthropic`, `openai`,
   `generic` — five, not four; the README's "Provider Adapters" list is accurate). This confirms,
   from the opposite direction, what the AgentVault-side guide found when it searched *its* repo for
   Stenographer references: the "ecosystem" is a shared design philosophy and a set of markdown
   files, not a shipped integration, **on both sides of every edge in the diagram.**

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

3. **Stenographer's own MCP tool and REST surfaces match what the AgentVault-side guide assumed.**
   The AgentVault engineering guide's description of 13 MCP-ish tools (11, actually — see the table
   in the companion engineering guide) and REST routes (`/status`, `/messages`, `/entities`,
   `/search`, `/graphrag`, etc.) lines up with `src/mcp/server.ts` and `src/api/rest.ts` as they
   exist today. No corrections needed there.

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

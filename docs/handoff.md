# Handoff: TB/UV v2 Truth Ledger → short-hand

**To:** the short-hand maintainer
**From:** stenographer (TB/UV v2 shipped in [PR #7](https://github.com/johnnyclem/stenographer/pull/7), merged 2026-09-19)
**Why you're getting this:** the TB/UV v2 PRD reserved one decision that lands on your desk (§13 Q6): short-hand's compaction levels and this ledger are solving adjacent problems. Whether the ledger eventually *is* short-hand's L4, or they stay separate tools, is out of scope for v2 — but you now need enough context to weigh in, and this doc is that context.

---

## What shipped, in one paragraph

Stenographer's tombstone pipeline is now split into **detection** (automatic, proposal-only) and **assertion** (accountable, signed). The embedding-similarity supersession detector still runs, but it can only write `PROPOSAL` entries; nothing becomes truth until a named author signs it. Truth lives in an append-only ledger (`truth_entries` + `truth_links` in the same SQLite file, mirrored to JSONL) with five record types: `TB` (asserted tombstone, evidence required), `UV` (unverified assertion — "there be dragons" — with a machine-actionable `verifyBy`), `PROPOSAL`, `ADDENDUM` (evidence attached after the fact), and `RULING` (strike / promotion / contempt, with required written opinions). Overriding a signed TB requires force semantics: a contesting UV or a proven addendum, enforced at the storage layer, not by convention.

## Why this is adjacent to short-hand

Short-hand compacts conversation through L0→L4, where **L4 is invariants** — the durable residue that survives every compaction. The truth ledger is precisely a store of durable residue: current truth, with history, authorship, and evidence. Both layers answer the same question — *what survives when the context is gone?* — from opposite directions:

| | short-hand L4 | truth ledger |
|---|---|---|
| How entries arrive | Derived by compaction | Asserted by an accountable author (machine may only propose) |
| Confidence model | One bucket ("invariant") | Two types: `TB` (provable) vs `UV` (believed, unverified) |
| Provenance | Compaction lineage | Message id / commit / file+line / manual, per entry |
| Mutation | Recompaction can rewrite | Append-only; state changes are new linked entries |
| Dispute state | None | First-class (`contested`), queryable |

The design principle that matters most if these converge: **two axes, not one.** Every ledger entry carries provenance (*where did this come from*) and confidence type (*how much should you trust it*). An L4 invariant is very often actually a UV — tribal knowledge that compacted well but was never verified. Collapsing TB and UV back into a single "invariant" bucket is explicitly called out in the PRD as a regression. If L4 ever ingests ledger entries, the confidence type must ride along.

## Integration surfaces available today

You don't need to adopt anything to interoperate. In rough order of coupling:

1. **JSONL interop (lowest coupling, recommended first).** `export_wiki_entries` emits signed TB/UV records as append-only JSONL — one entry per line, readable with `cat`, diffable in a PR. Stenographer-specific fields (links, provenance, agent session) travel under a namespaced `x-steno` key you can ignore. `import_wiki_entries` ingests the same format losslessly; the round-trip invariant `import(export(ledger)) == ledger` is tested and gates release (`test/wiki-interop.test.ts`). Short-hand could read this file at compaction time without touching stenographer's SQLite or code.

2. **Library API.** `@stenographer/core` exports `TruthLedger`, `exportWikiEntries`/`importWikiEntries`, and all record types (`src/truth/types.ts`). The ledger takes a `better-sqlite3` `Database` — it does not require the rest of stenographer.

3. **MCP tools.** If stenographer is running as a server: `get_truth(truthFilter: current|all|contested)`, `search_truth` (embedding-ranked), `get_verification_queue`, `get_contested`, plus the assertion tools. The §7 consumption rules are embedded verbatim in the tool descriptions, so any MCP client inherits them without prompting.

## The contract you must not break

If short-hand consumes ledger entries (in any of the three ways above), these downstream rules apply — they are the point of the whole design:

- **Active `TB`** — ground truth. Compact it, rely on it, cite it.
- **Contested `TB`** — ground truth *with a visible asterisk*: carry both the TB and the contesting UV through compaction. Don't resolve the dispute silently in either direction.
- **Open `UV`** — **flag, don't block.** Never let compaction promote a UV into something that reads as proven. The dragon marker only works if you can see it.
- **Refuted `UV` / overridden `TB` / struck entries** — history, never citable, excluded from current-truth by default. If a compaction level cached one before it was overridden, the next sync should displace it.

And in the other direction: if short-hand ever *writes* toward the ledger, it may only write `PROPOSAL`s (there is no anonymous write path — generic identities like `system`/`assistant` are rejected at the schema level, and corroboration must be provenance-independent: a process can't sign or verify its own output).

## The convergence decision (Q6) — framing, not a verdict

Two viable shapes:

- **Option A — the ledger becomes L4's backing store.** Compaction produces candidate invariants as `PROPOSAL(kind: uv)` entries; signing promotes them; L4 reads `getTruth('current')`. Strongest version of the idea: compaction gains accountability and a dispute mechanism for free, and "invariant" stops being a confidence claim it can't back. Cost: short-hand takes a dependency on stenographer's schema and its signing workflow becomes part of your compaction loop.

- **Option B — separate tools, JSONL sync at the seam.** L4 stays yours; at compaction time you import the current-truth JSONL as high-priority input, and optionally emit your candidate invariants as a JSONL file stenographer ingests as proposals. No code dependency, format-level contract only, and the round-trip test already protects the seam.

Pragmatic recommendation: **start with B.** It's an afternoon of work against a tested, stable format, it proves whether ledger entries actually improve compaction quality, and it leaves A available with better evidence. A is a real architectural commitment and shouldn't be bought on adjacency alone. The final call is Johnny's (it's a reserved §13 decision) — this handoff's job is to make sure it's made with the seams visible.

## Decisions still open that affect you as a consumer

From §13, unresolved as of this handoff:

1. **UV TTL** — open UVs currently live forever (no expiry, no staleness marker). If you ingest UVs into compaction, assume the pile can grow.
2. **Who counts as a signer** — the floor is: `command` evidence (reproducible executable checks) self-signs; everything else needs a human. Whether trusted agents get signing rights for some entry kinds is undecided. Relevant if short-hand's compactor would want to sign its own promotions (today it can't, and the contempt check would reject the obvious workaround).
3. **Contested-TB posture** — contested TBs stay authoritative-with-asterisk (stability over caution). If that flips to UV-grade trust, your compaction weighting changes.

## Pointers

- `src/truth/types.ts` — record types, link types, consumption-rules constant, ULID
- `src/truth/ledger.ts` — the storage layer; the override protocol and contempt check live here
- `src/truth/wiki.ts` — the JSONL format (`WikiEntryLine` is the line shape)
- `test/wiki-interop.test.ts` — the round-trip invariant; read this first if you build against the JSONL
- `test/truth.test.ts` — lifecycle, override protocol, contempt, rulings
- README §"Asserted Truth Layer (TB/UV v2)" — user-facing summary
- Rollout: everything defaults to `truthMode: 'shadow'` (Phase 0 — auto-close still runs, proposals accumulate for observation). Phase 1 (`assert`) is the one-way door and hasn't been opened.

# Handoff: TB/UV v2 Truth Ledger → smallchat

**To:** the smallchat maintainer
**From:** stenographer (TB/UV v2 shipped in [PR #7](https://github.com/johnnyclem/stenographer/pull/7), merged 2026-09-19)
**The ask:** build stenographer into the dispatch table so that truth about tools biases tool selection — with **verified truth as higher signal than asserted truth**. This doc defines exactly what "verified" and "asserted" mean in the ledger's terms, how to compute the grade from an entry, and where the integration seams are.

Companion doc: [`handoff-short-hand.md`](./handoff-short-hand.md) has the general what-shipped summary; this one goes straight to dispatch.

---

## The problem this solves for dispatch

Smallchat compiles tools into dispatch tables by object-oriented inference. What inference can't see is *institutional truth about the tools themselves*: "`fetch_page` was superseded by `browse` in March," "`search` times out on queries over 1k chars," "we believe the image tool double-bills but nobody's confirmed it." Stenographer's ledger now holds exactly that — with authorship, evidence, and a confidence type on every entry. Wiring it into compilation means the dispatch table stops re-learning dead tools the hard way.

The one rule that shapes everything below: the ledger's entries are **not one kind of truth**. A claim proven by a reproducible check and a claim a human signed off on judgment are different signal strengths, and an unverified belief is a third thing again. Flattening them into one bucket at the dispatch layer would undo the ledger's whole design.

## The signal hierarchy

Grade every consumed entry, highest signal first:

| Grade | What it is | How dispatch should treat it | Suggested weight |
|---|---|---|---|
| **verified** | TB whose evidence includes a reproducible check (`command` or `test` kind), or a UV resolved `verified` by one | Authoritative. May **rewrite dispatch**: forward a superseded selector to its successor, demote/redirect a dead tool | 1.0 |
| **asserted** | Signed TB whose evidence is judgment-grade (`commit`, `file`, `wiki`, `message`) — stands on the signer's accountability | Authoritative for **ranking**, not rewiring: prefer the successor, keep the old selector callable | 0.75 |
| **migration** | Backfilled pre-assertion TB (`author: "migration"`, `signedBy: null`) — queryably second-class by design | Weak ranking bias only | 0.5 |
| **contested** | Any TB with `status: "contested"` (a live UV disputes it) | Still truth, one notch down; carry the contest into the tool's annotation so the caller can see the asterisk | ×0.8 multiplier on its base grade |
| **advisory** | Open UV | **Never moves a tool in the table.** Zero ranking weight. Attach as a warning annotation (tool description, `doesNotUnderstand`-style hint) — flag, don't block | 0 (surfaced, not scored) |
| **excluded** | Refuted UV, overridden TB, struck entry | Never consulted, never cited. If a compiled table cached one, the next compile displaces it | — |

The verified > asserted ordering is the point of the ask, and it's computable today: evidence kinds are stored per entry, so no ledger change is needed.

## Computing the grade (client-side, ~20 lines)

Pseudocode against the JSONL line shape (`WikiEntryLine` in `src/truth/wiki.ts`) or the exported types:

```
grade(entry):
  if entry is struck, or status in {overridden, refuted}   -> excluded
  if entry.type == UV:
    status == open      -> advisory
    status == verified  -> treat like verified TB (normally a TB was minted alongside; prefer that)
  # entry.type == TB
  base = verified   if any evidence.kind in {command, test}
       = migration  if author == "migration"
       = asserted   otherwise
  if status == contested -> base with ×0.8 and an asterisk annotation
  return base
```

Notes on the edges:

- A TB minted by `resolve_uv` from `command` evidence carries that evidence — it grades verified by the rule above, no lineage-walking needed.
- A TB minted under a **promotion RULING** (human ruled non-command evidence sufficient) grades **asserted**: the gavel adds accountability, not reproducibility. Don't be tempted to bump it.
- `x-steno.links` carries `contests`/`overrides`/`verifies` backrefs if you want to render *why* an entry has its status; you don't need links to compute the grade.

## Integration shape

**Compile time (recommended, lowest coupling).** Add a compile input — e.g. `--truth ./truth.jsonl` — produced by stenographer's `export_wiki_entries`. During table construction:

1. Match entries to tools. First pass: exact/substring match of tool selectors against entry text (`claim`/`assertion`) and entity values. Fallback: embedding similarity if smallchat already embeds selectors; skip otherwise — a missed match costs nothing, a wrong rewrite costs trust.
2. Apply by grade: verified supersessions become selector forwards (the Obj-C deprecated-selector move: old selector stays in the table, dispatches to the successor, annotation says why and cites the entry id). Asserted/migration entries adjust ranking weights. Advisory UVs attach to the tool's metadata so the calling agent sees the dragon marker.
3. Emit what you applied into the compile log — entry ids in, table mutations out. That log is the audit trail when someone asks why dispatch changed.

**Runtime (optional, later).** If smallchat runs beside a live stenographer, the MCP tools `get_truth(truthFilter: "current")` and `search_truth(query)` serve the same entries with the §7 consumption rules embedded in the tool descriptions. Compile-time JSONL should come first — it's deterministic and testable.

**Write-back (the interesting loop).** Dispatch telemetry is a truth *source*: a tool that failed the same way ten times is a UV waiting to be written. Smallchat may file these under a registered identity (e.g. `smallchat:compiler` — generic names like `system`/`assistant` are rejected at the schema level) with a `verifyBy` of kind `command` (the repro invocation). Two hard rules from the ledger, enforced at write time:

- Smallchat can **assert UVs and file proposals, not TBs** — minting truth needs an accountable signer, and `command`-evidence resolutions are the only self-signing path.
- **Contempt of corpus:** smallchat cannot verify or sign its own UVs, and neither can anything sharing its agent session. Its telemetry proposes; someone (or some independent check) else confirms.

## The consumption contract (short form)

Same §7 rules every ledger consumer inherits: active TB = rely on it; contested TB = rely with a visible asterisk; open UV = flag, never block — a UV alone must not remove or reroute a tool; refuted/overridden/struck = history, never citable. The weights table above is these rules made numeric for a ranker.

## Suggested first milestone

One flag, one behavior, one test: `--truth truth.jsonl` such that when the file contains a **verified** supersession TB for tool X → tool Y, compiled dispatch of X's selector lands on Y (with the annotation), and when the same claim is merely **asserted**, X still dispatches to X but Y outranks it in selection. That single test pins the verified-over-asserted ordering this handoff exists to establish, and everything else is tuning.

## Pointers

- `src/truth/wiki.ts` — `WikiEntryLine`, the JSONL shape to parse (`x-steno` is ignorable)
- `src/truth/types.ts` — evidence kinds, statuses, link types; `CONSUMPTION_RULES` constant
- `test/wiki-interop.test.ts` — the format's round-trip guarantees
- MCP: `export_wiki_entries`, `get_truth`, `search_truth`, `assert_uv`, `list_proposals`
- Weights (1.0 / 0.75 / 0.5 / ×0.8) are starting values, not gospel — tune against real dispatch outcomes, but keep the *ordering* fixed: verified > asserted > migration, contested below its base, open UV never a ranking input.

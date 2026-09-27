# PRD: Close the gap between what stenographer is said to do and what it does

**Status:** Draft for review · **Date:** 2026-09-27 · **Target:** `0.2.0`
**Owner:** Johnny Clem · **Prepared from:** firsthand verification on `master` @ `542b827` (this branch), plus read-only inspection of the sibling repos at the commits listed in §6.

---

## 0. Why this document exists

A testimonial for stenographer is circulating (it also names `https://stenographer.smallchat.dev`). It makes ten concrete product claims. This PRD checks each one against the code as it ships today, records where we meet, partially meet, or fall short of the claim, records where the smallchat family has drifted or duplicated work, and specifies the work that closes the gaps.

The testimonial, verbatim:

> Last year I encountered an issue that alot of developers have seen by now: me being 75% sure the code says A, Claude being 100% confidently that it's B, and ultimately B slips through code review, and the flaky unit tests cover B/not-B only, and it ships into production.
>
> And after having tried rags and graphQL rags, and every harness, I built my own open source tool to solve this problem for good: stenographer.
>
> The idea follows the metaphor: it's a court reporter essentially for your claude code sessions. it carries the fill transcript and it survives compaction over long sessions. and the real powerful thing that it does is it is monitoring the whole chat transcript in real time, and if at any point there is an assertion made by either Clawd or the user, stenographer will interject in the chat with either an Unverified Claim "UV: unverified, challenged" or a Tombstoned fact "TB - settled fact; strike from record"
>
> my team of eight ObjC/Swift engineers implemented stenographer two weeks ago on our main project repo's wiki, and in two weeks it has already caught 12 bugs that would've shipped into production just based on flagging an unverified claim that it already been confirmed elsewhere.

Bottom line up front: **the tombstone half of the pitch is real and tested; the unverified-claim half, the user-side half, and the "interjects by default" half are not shipped.** Compaction survival holds for the record but not for the agent. Three cross-repo contract drifts were found and fixed in the PR that carries this document.

---

## 1. How the verification was done

Everything in §2 was checked directly, not from READMEs:

- `npm ci && npm run lint && npm test && npm run build` on `master`: 143/143 tests green before changes, 147/147 after.
- An end-to-end script (`docs/prd/verification/testimonial-claims.e2e.mjs`) drives the built library in `daemon` mode over a Claude Code-format log with the offline embedder, asserts a TB with literals, then appends assistant turns, user turns, a compaction boundary, and a compact summary, and reads `/flags`. Its `FAIL` lines are the shortfalls below; re-run it after each phase.
- A real Claude Code session log (this session's own `~/.claude/projects/…/<uuid>.jsonl`) was used to check the adapter and format auto-detection against actual record shapes, not fixtures.
- Four sibling repos were cloned read-only and their stenographer-facing code was read line by line (§3, §6).

---

## 2. Claim-by-claim verdicts

| # | Claim (paraphrased) | Verdict | Evidence |
|---|---|---|---|
| C1 | Court reporter for Claude Code sessions | **Meets** | `ClaudeCodeAdapter` (`src/indexer/adapters.ts`), `watch` mode over `~/.claude/projects/<proj>`; MCP server + REST. Auto-detection of real logs was broken (opened with `queue-operation`/`ai-title` records → `generic` adapter → 0 assistant turns indexed). **Fixed in this PR.** |
| C2 | Carries the full transcript | **Meets** | Every parsed message is stored with content and embedding regardless of importance score (`Stenographer.indexMessage` → `store.addMessage`). e2e: all seed messages indexed. |
| C3 | Survives compaction over long sessions | **Partial** | The *record* survives: the tailer keeps reading after a `compact_boundary` and pre-compaction messages stay queryable (e2e PASS ×2). The *agent* does not get it back: nothing re-injects the record after compaction (no `SessionStart`/`PreCompact` hook, no plugin, no `init` that installs one). Worse, the compact summary Claude Code writes is indexed as an ordinary **user** turn (e2e FAIL), so stale facts inside the summary can seed decisions/entities and are never scanned for tombstoned literals. |
| C4 | Monitors the whole transcript in real time | **Meets** | `fs.watch` tail, message-boundary delivery, objection scan inline in the indexing pipeline. |
| C5 | Assertions by **either Claude or the user** are challenged | **Falls short** | `ObjectionLog.scan` returns `[]` unless `msg.role === 'assistant'` (`src/truth/objections.ts`). e2e: a user turn asserting a tombstoned literal raises nothing. |
| C6 | Interjects with an **Unverified Claim** flag ("UV: unverified, challenged") | **Falls short** | UVs exist as ledger records (`assert_uv`, `resolve_uv`, verification queue) but nothing detects a UV being *asserted or relied on* in the transcript, and nothing challenges confident un-evidenced claims. e2e: "definitely 5000ms, 100% sure" raises nothing. smallchat-swift already ships a Swift-side "reliance on unverified claim" detector; stenographer, the supposed owner, does not. |
| C7 | Interjects with a **Tombstoned fact** ("TB - settled fact; strike from record") | **Meets, with two caveats** | Assistant output asserting a tombstoned literal raises an objection with exhibit + transcript line (e2e PASS), delivered over the MCP channel, smallchat channel bridge, or webhooks. Caveat 1: the default is `--objections shadow`, which records and **never emits** — out of the box it does not interject (e2e FAIL). Caveat 2: the wording is "Objection <ulid>: Asserted …", not the family's `[TB]` / `[UV — UNVERIFIED]` markers nor the testimonial's one-liners (e2e FAIL). |
| C8 | "Implemented … on our main project repo's wiki" | **Partial** | `export_wiki_entries` / `import_wiki_entries` round-trip a JSONL ledger losslessly (tested), and smallchat-swift reads/writes that file. There is no documented or scripted way to keep that file in a GitHub wiki (a git repo) in sync, no `stenographer wiki …` command, and no team-signer setup story for eight people. |
| C9 | Caught N bugs "that would've shipped" | **Not measurable today** | `get_status.objections` exposes raised/sustained/overruled and a sustain rate, which is a tuning dial, not a catch count. There is no way to mark a sustained objection as "would have shipped" or to report catches per period/TB. |
| C10 | "Flagging an unverified claim that had already been confirmed elsewhere" | **Partial** | The ledger is global across sessions (e2e PASS), so a TB signed in one session objects in every other session — that is the mechanism the sentence describes. But it only fires on `literals`-bearing TBs; a *UV* confirmed elsewhere (resolved `verified`) never challenges anything. |

Non-product parts of the testimonial (the 75%/100% anecdote, "tried rags and graphQL rags", eight engineers, two weeks) are not verifiable from the repo and are out of scope. Note that GraphQL is on our roadmap, not shipped, which is consistent with the sentence.

---

## 3. Family alignment: drift, gaps, and overlaps

### 3.1 Contract drift found and fixed in this PR

| Drift | Where | Fix |
|---|---|---|
| smallchat's vendored short-hand (`shorthand/src/truth/compaction-bridge.ts`, `InvariantProposalLine`) and smallchat-swift (`InvariantProposal`) write proposal lines as `{type:"PROPOSAL", kind:"uv", id, ts, author, agentSessionId, signal:{source:"shorthand-compaction"}}`. Stenographer's `importProposalDrafts` only accepted the standalone short-hand dialect (`signal.source: "compaction-candidate"`), so **every smallchat-produced line was rejected**. | `src/truth/intake.ts` | Accept both dialects; normalise to `compaction-candidate`; keep the envelope's `id`/`author`/`source` under `meta.intake`; honour `ts` and `agentSessionId`. Authorship stays with `detector:short-hand`. Tests added. |
| `ClaudeCodeAdapter.detect` only inspected the first sampled line, and the sample window was 10 KB. Real logs open with `queue-operation`/`ai-title`/`last-prompt` records and have lines > 10 KB, so auto-detection picked `generic` and indexed 7 of 205 lines (0 assistant turns). The website's getting-started command (`stenographer start ~/.claude/projects/myproj --mode watch`, no `--adapter`) hit exactly this path. | `src/indexer/adapters.ts` | Detect across all sampled lines, recognise the session envelope (`sessionId` + `uuid`/`parentUuid`/known record types), sample 256 KB / 8 lines. Verified against a real log: now `claude-code`. Tests added. |
| Watch mode named sessions `session_<basename>`. smallchat's messenger routes objections with `MessengerModel.agent(id)` by **exact** Claude Code session id, so `meta.session_ids` never matched and objections landed as "No known session matched". | `src/core/stenographer.ts` | Session id is the bare log basename (the Claude Code session id). Engine test updated. |

### 3.2 Contracts verified as matching (no change needed)

- smallchat-swift `NotaryClient` ↔ `GET /proposals`, `POST /proposals/:id/notarize|dismiss`, `X-Notary-Secret`, `{id}` on success, `{error}` on failure, `body.requiresNotary` filter: matches `src/api/rest.ts`.
- smallchat channel bridge (TS) and smallchat-swift `ChannelBridge`: `POST /event {channel, content, meta, sender}`, `X-Channel-Secret` or Bearer, identifier-only flat string meta keys: matches `delivery.ts` / `notary.ts` (`kind`, `objection_ids`, `tb_ids`, `session_ids`, `count`, `proposal_id`, `drafted_by`, `notarize_url`).
- Wiki line codec (`WikiEntryLine`, `literals`, statuses, `x-steno`, anonymous-identity floor, literal validation rule) is mirrored consistently in short-hand, smallchat's vendored short-hand (#88), and smallchat-swift's `TruthWiki.swift`.
- Standalone short-hand `exportProposalDrafts` ↔ `importProposalDrafts`: already matched and tested.

### 3.3 Gaps on the sibling side (tracked here, owned there)

- **smallchat** has no dispatch-table integration: no `--truth` compile input, no verified/asserted/migration grading. `docs/handoff-smallchat.md`'s ask is unfulfilled. Its `docs/ecosystem/*` still say "zero references to stenographer", contradicting its own vendored codec. Its channel example puts `sender` inside `meta`, which fails its own allowlist gate.
- **short-hand** README §"Ecosystem" still says none of the integrations are wired, though its truth seam ships.
- **smallchat-swift** README/CHANGELOG don't document the notary flow (`NotaryClient`, `--require-notary`) it implements.
- **smallchat-website** getting-started omits `--objections deliver` and any receiver, so a new user following it lands in shadow mode and sees no objection.
- **stenographer** open dependabot PR #2 (vitest 1.6 → 3.2) is superseded by the audit's bump to 4.1; close it.

### 3.4 Overlap: the same code in four places

| Concern | Copies today |
|---|---|
| Three-signal importance model (45/25/30, same signal names) | stenographer `importance.ts`, short-hand, smallchat's vendored short-hand |
| Regex correction/tombstone detection | stenographer, short-hand, smallchat's vendored short-hand |
| Wiki JSONL codec + literal validator + anonymous-identity list + `CONSUMPTION_RULES` | stenographer, short-hand, smallchat's vendored short-hand, smallchat-swift (Swift) |
| Tombstoned-literal matcher (windows 40/20, 500-char cap, "mentions current = discussion") | stenographer `objections.ts`, smallchat-swift `TruthObjections`, smallchat-website `matcher.ts` |
| UV reliance detector | smallchat-swift only (stenographer, the owner, has none) |
| Proposal-line dialect | two (fixed by accepting both, but still two emitters) |

The `signal.source` drift in §3.1 is what unowned duplication produces. It will happen again unless one repo owns the format and the others consume it.

---

## 4. Requirements

Priority: **P0** = the testimonial is false without it; **P1** = the testimonial is misleading without it; **P2** = hygiene that keeps P0/P1 true.

### R1 (P0) Challenge user assertions too — C5
- Scan `user` turns for tombstoned literals with the same matcher, **prose only**: skip `tool_result` blocks, `isMeta`, `isCompactSummary` (handled by R3), and lines ending in `?`.
- Objection `source: "user"`; the delivered text addresses the person ("You asserted …") and still cites the exhibit.
- Config `--objection-scope assistant|all`, default `all`. `assistant` keeps today's behaviour.
- Acceptance: e2e "user asserting dead literal" turns PASS; a user *question* mentioning the dead value raises nothing; a grep result containing the dead value raises nothing.

### R2 (P0) Unverified-claim flags in real time — C6, C10
- **R2a Reliance on an open UV.** When assistant or user prose restates an open UV's assertion (port smallchat-swift's rule as the starting point: ≥3 shared content words and ≥60% of the assertion's words), raise a `flag` of kind `uv-reliance` carrying the UV as exhibit and its `verifyBy` hint. A UV later resolved `verified` promotes to a TB in the usual way and stops flagging; resolved `refuted` keeps flagging as "refuted, do not rely on".
- **R2b Confident un-evidenced claims.** Detect certainty language in assistant prose ("definitely", "always", "never", "100%", "I'm certain", "guaranteed") on a sentence that names a literal/identifier and matches no TB, UV, or decision. Do **not** interject; file `PROPOSAL(kind: uv, signal.source: "certainty-detector")` with `verifyBy` prefilled so the person can turn it into a UV with one click in smallchat-swift's inbox. Opt-in via `--challenge-certainty`; measure precision in shadow before defaulting on.
- Both flag kinds share the objection log, `/flags`, delivery, and rulings (`rule_on_objection` extended with `kind`).
- Acceptance: e2e "confident unverified assertion" produces a proposal; a new e2e case where an open UV is restated produces a delivered `uv-reliance` flag; stenographer becomes the single owner of the reliance rule (smallchat-swift consumes the flag instead of detecting).

### R3 (P0) Survive compaction for the agent, not just the record — C3
- **R3a Adapter.** Recognise `{"type":"system","subtype":"compact_boundary"}` and `{"type":"user","isCompactSummary":true}`. Index the summary as `role: "system"` with `kind: "compact-summary"`; exclude it from decision/entity extraction; **do** scan it for tombstoned literals and UV reliance, because the summary is precisely where a stale fact re-enters the session. Record a `compaction` event per session for `get_status`.
- **R3b Hook pack.** `stenographer init --claude-code` writes into the project: an `.mcp.json` entry for the server, and Claude Code hooks: `SessionStart` (matcher `compact|resume`) that injects the record back as `additionalContext` — active TBs with literals, open UVs, the last N decisions, and `get_context_frame` within a budget; `UserPromptSubmit` that runs the R1 scan synchronously and returns the objection as context **before** Claude answers (the only true "interject before the mistake" path for user turns); `PreCompact` that flushes the index and exports the wiki JSONL. All hooks are thin shell wrappers calling `stenographer hook <event>` over the REST API, loopback only.
- Acceptance: e2e "compact summary is NOT indexed as a real user turn" and "stale literal inside compact summary is challenged" PASS; a scripted `claude -p` session with the hooks installed shows the record in the post-compaction context.

### R4 (P1) Interject by default, and say it the way the family says it — C7
- Default `--objections deliver` when at least one interrupt-capable receiver exists (the MCP channel in `live`/`daemon`, a `--objection-channel`); otherwise keep `shadow`. Everything is still recorded, so the shadow log and sustain-rate dial are unchanged. Print the effective mode at startup.
- One label table, exported from stenographer and consumed verbatim by the siblings (like `CONSUMPTION_RULES`):
  - TB objection: `[TB] settled fact — strike from the record: <claim>` (subject = dead → current)
  - UV reliance: `[UV — UNVERIFIED] unverified — challenged: <assertion> (verify by <kind>: <value>)`
  - Contested: `[TB ⚠ CONTESTED] …`
  These reconcile the testimonial's phrasing with the `[TB]`/`[UV — UNVERIFIED]` markers smallchat, smallchat-swift, and the website already render. `formatObjection` leads with the label; channel `meta.kind` gains `uv-reliance`.
- Acceptance: e2e "objection text uses the TB/UV shorthand labels" and "default objection mode interjects" PASS; smallchat-swift renders the new label without change (content is opaque to it).

### R5 (P1) CLI parity with the documented config
- `--truth-mode shadow|assert` (README describes `truthMode`; there is no flag, so Phase 1 is unreachable from the CLI today).
- `--objection-scope`, `--challenge-certainty` (R1, R2b), `init --claude-code` (R3b).
- `STENOGRAPHER_SIGNER` env as the default signer identity for `sign_proposal`/`assert_*` when the tool call omits one, so a team member's identity is set once per machine.

### R6 (P1) Team ledger in a repo wiki — C8
- `stenographer wiki pull <path|git-url>` / `wiki push` / `wiki sync`: import then export against a JSONL file in a checked-out wiki (GitHub wikis are git repos), commit with the entry ids in the message, surface reconciliation proposals. Document the eight-engineer setup: one wiki file, `STENOGRAPHER_SIGNER` per person, `--require-notary` for agents, smallchat-swift as the approval UI.
- Acceptance: round-trip test through a bare git repo; docs page "Team setup".

### R7 (P1) Make "caught N bugs" a number the tool can produce — C9
- `rule_on_objection` gains `wouldHaveShipped?: boolean`; sustained objections with it set count as **catches**.
- `stenographer report [--since 14d]`: raised / sustained / overruled / catches, per TB hit counts, per session, per source (assistant/user/summary), sustain rate trend. Same data on `get_status.objections` and `GET /status`.
- Acceptance: the report reproduces a seeded fixture of 12 catches.

### R8 (P2) One owner per shared concern
- Publish `@stenographer/truth-format` (types, wiki codec, literal validator, matcher, label table, anonymous list, `CONSUMPTION_RULES`, proposal-line schema). short-hand and smallchat depend on it; smallchat-swift stays a port but runs the same golden fixtures (`fixtures/truth/*.jsonl` and `fixtures/objections/*.json` published from this repo).
- Importance scoring: stenographer owns it for anything it hands off; short-hand accepts a precomputed `importance` on input and skips recomputation. Record the decision in both READMEs.

### R9 (P2) Contract tests against the family in CI
- Golden payloads for channel `/event` (objection, proposal), `GET /proposals`, notarize/dismiss responses, and both proposal-line dialects, asserted byte-for-byte on our side and copied into the siblings' test fixtures.

### Non-goals for 0.2
- Writing into the transcript file or the terminal directly: stenographer stays passive and emits to receivers/hooks.
- Agents signing anything; notarization rules are unchanged.
- LLM-based semantic contradiction detection. R2 stays lexical (precision over recall) until the shadow sustain rate says otherwise; Tier 1.5 extraction remains roadmap.
- GraphQL.

---

## 5. Rollout

| Phase | Scope | Size | Exit criterion |
|---|---|---|---|
| A | R4 labels + default, R5 flags, R1 user turns, R3a summary records | S–M | e2e script: C5, C7 caveats, R3a cases PASS; sustain rate on shadow log ≥ 0.8 for user-turn objections before `all` becomes default |
| B | R3b hook pack + `init --claude-code`, R7 report | M | Fresh machine to first delivered objection < 10 min following the website; post-compaction context contains the record |
| C | R2a UV reliance (stenographer-owned), R2b certainty proposals (opt-in), R6 wiki sync | M–L | e2e C6/C10 PASS; smallchat-swift switched to consuming `uv-reliance` flags |
| D | R8 shared package + fixtures, R9 contract tests, sibling doc fixes in §3.3 | M | One codec, one matcher, one label table in TypeScript; Swift passes golden fixtures |

Sequencing rationale: Phase A makes the testimonial's tombstone half true out of the box in days. Phase B is where "survives compaction" becomes something the agent experiences. Phase C is the biggest new capability and benefits from Phase A's telemetry. Phase D stops the drift from recurring.

---

## 6. Sources inspected

| Repo | Commit | Read |
|---|---|---|
| johnnyclem/stenographer | `542b827` (master) | full source, tests, docs; e2e script; real session log |
| johnnyclem/smallchat | `4cf0740` "Keep tombstoned literals in the truth ledger codec (#88)" | `src/channel/*`, `shorthand/src/truth/*`, `src/cli/commands/compile.ts`, docs |
| johnnyclem/short-hand | `f3ee576` (PR #17) | `src/truth/*`, `src/importance/*`, `src/compaction/regex-compactor.ts`, docs |
| johnnyclem/smallchat-swift | `ceb47a1` (PR #42) | `ChannelBridge.swift`, `NotaryClient.swift`, `TruthWiki.swift`, `StenographerView.swift`, `MessengerModel.swift`, `Store.swift` |
| johnnyclem/smallchat-website | `567ed0f` (PR #12) | `artifacts/stenographer/*`, `lib/site-kit`, Home and MacAppShowcase |

---

## 7. Open questions

1. Should `--objection-scope all` be the default from day one (the testimonial promises it) or only after the shadow sustain rate for user turns clears 0.8? Recommendation: ship `all` behind `deliver`'s new auto-default, but gate the *auto-default* on a one-week shadow period per install (`get_status` shows the countdown).
2. R2b certainty proposals could be noisy on chatty models. Keep opt-in until precision on the shadow set is measured; do not let it interject in 0.2.
3. R8 packaging: separate npm package vs. a `truth-format/` subpath export from `@stenographer/core`. Subpath is less ceremony; a separate package lets short-hand keep zero runtime deps. Lean: subpath first.
4. Who is the default notary in a hook-driven flow when smallchat-swift is not running? The interactive CLI is the fallback; is a `stenographer notarize --watch` TUI worth it?

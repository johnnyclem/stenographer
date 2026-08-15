# Stenographer — Code Review & Security Audit

**Date:** 2026-08-15
**Scope:** Full repository at `master` (`@stenographer/core` v0.1.0-alpha.2) — architecture, security, dependencies, technical debt.
**Branch:** `claude/code-review-security-audit-x8c2sh`

## Summary

Stenographer is a small (~3,800 line), well-structured TypeScript codebase: an MCP server + REST API that tails JSONL conversation logs and builds a local SQLite-backed semantic index. It came into this audit in unusually good shape — clean module boundaries, no dead code, no `TODO`/`FIXME`/`HACK` markers, 59 passing tests, and a green `tsc --noEmit`/build. The work here is a small set of targeted fixes rather than a large remediation effort.

Three commits, all independently reviewable:

1. `c259a7f` — bind the REST API to `127.0.0.1` by default (security)
2. `f982d5e` — dependency updates, resolving 12 of 16 `npm audit` advisories including both criticals
3. `758a5eb` — fix a substring false-positive in session-scoped entity lookup

All three keep the public API surface backward-compatible; the new `restHost`/`--rest-host` config is additive and optional.

---

## Findings

### Critical

None found.

### High

**H1 — REST API bound to all interfaces with no authentication (fixed).**
`RestServer.start()` called `server.listen(port)` with no host argument, which binds every network interface, not just loopback. Combined with zero authentication on any route, `daemon` mode (or any explicit `--rest-port`) exposed full conversation content — messages, decisions, entities, corrections — to anyone able to reach the host on its network. This directly contradicted the README's framing of the tool as safe/local-only.
*Fix:* `RestServer.start(port, host = '127.0.0.1')`; `Stenographer` now resolves `config.restHost ?? '127.0.0.1'`. A new `--rest-host` CLI flag / `restHost` config field lets an operator opt into wider exposure deliberately (e.g. a container reached only through a trusted boundary). Added a regression test asserting the bound address is loopback by default.
*Files:* `src/api/rest.ts`, `src/core/stenographer.ts`, `src/mcp/server.ts`, `cli/index.ts`, `src/types.ts`, `test/rest.test.ts`, README.

**H2 — Critical/high dependency vulnerabilities (mostly fixed).**
See [Dependency Upgrade Summary](#dependency-upgrade-summary) below.

### Medium

**M1 — `getEntities(sessionId)` substring false-positive (fixed).**
The session-scoped entity query joined via `m.entity_ids LIKE '%' || e.id || '%'`. Entity ids are raw, unescaped extracted text, so this does uncontrolled substring matching: an entity id that happens to be a substring of another (`"sql"` inside `"postgresql"`) — or one containing a literal `%`/`_` — could match messages that never referenced it, surfacing wrong entities in `get_entities` and the context frame built for the next LLM call. Not a security issue (no injection — the query is parameterized; this is a correctness bug), but a real one given `get_context_frame` is what agents use to recover state.
*Fix:* collect the session's referenced entity ids from `entity_ids` (a JSON array column) and match by exact id in application code instead of SQL substring matching. Added a regression test.
*Files:* `src/store/index.ts`, `test/store.test.ts`.

### Low / Notes (not changed)

- **Entity `id` = raw extracted text.** `EntityNode.id` is set to the literal captured substring (`entity.name = entity.value`, from `src/indexer/importance.ts`'s regex extraction). Two different messages producing coincidentally identical free text get merged into one entity node even if they're not really "the same thing" in context; extremely long or unusual captures become primary keys. This is an existing design tradeoff (Tier-0 regex extraction, per the README's roadmap toward model-based Tier-1 extraction) rather than a bug, and reworking entity identity is out of scope for a targeted audit — flagging it here as context for whoever builds Tier-1 extraction.
- **REST API still has no authentication, no rate limiting, no request body/size limits.** Binding to loopback by default (H1) closes the main exposure vector for the tool's stated local-first use case. If a future use case needs LAN/container exposure via `--rest-host`, authentication should be added at that point — noted, not built preemptively (no current caller needs it).
- **`buildGraphCypher`/`buildVectorCypher` (`src/indexer/graphrag.ts`)** build Cypher query strings via direct interpolation (with basic quote-escaping on entity ids). These are marked in the README as roadmap/unused ("Cypher builders ship today... Neo4j persistent graph backend" is future work) and have no live Neo4j driver call site in this codebase — no current injection surface. Worth a real parameterization pass if/when the Neo4j backend actually ships and starts executing these queries.
- **No secrets or credentials anywhere in the repo** — confirmed via `git log`/`grep` sweep. The tool is genuinely offline-by-default; the only network call is the one-time embedding model download, now via `@huggingface/transformers`.

---

## Security Posture Summary

- **Injection:** All SQL goes through `better-sqlite3` prepared statements; no string-built SQL with untrusted input found. No injection vulnerabilities identified.
- **Input parsing:** All five log adapters (`jsonl`, `claude-code`, `anthropic`, `openai`, `generic`) wrap `JSON.parse` in `try/catch` and build message objects field-by-field rather than spreading raw parsed JSON into trusted structures — no prototype-pollution pattern found. The canonical `jsonl` adapter additionally validates against a `zod` schema.
- **Network exposure:** Fixed (H1). MCP transport is stdio-only; REST is opt-in and now loopback-by-default.
- **Secrets:** None in the repo; no API keys required for default operation.
- **Dependencies:** Substantially improved — see below. Four remaining high-severity advisories are upstream-blocked (no fix published) and isolated to native-binary ML inference dependencies (image/tensor codecs) not exercised by Stenographer's text-only embedding path.

---

## Dependency Upgrade Summary

`npm audit` before → after this branch:

| | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| Before | 2 | 9 | 4 | 1 | 16 |
| After | 0 | 4 | 0 | 0 | 4 |

**Applied:**

- `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 (minor).
- `vitest` 1.6.1 → 4.1.10 (major, **dev-only**, not shipped). All 60 existing tests pass unmodified — no config or test-code changes needed. This alone cleared the critical `esbuild`/`vite` advisory plus moderate `vite-node` and high `postcss`/`nanoid`.
- `@xenova/transformers` → `@huggingface/transformers` 4.2.0. `@xenova/transformers` is the original package under the author who now maintains embeddings tooling under the Hugging Face org; `@huggingface/transformers` is its actively maintained successor with the same `pipeline()` API. Verified as a true drop-in via a live smoke test (`pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', ...)` producing identical 384-dim output) and an end-to-end CLI run in `catchup` mode. One code change was required: the old `quantized: true` option was replaced by `dtype: 'q8'` in the new package's API (same quantization level, different option name). This migration cleared a **critical** `protobufjs` remote-code-execution-class advisory that had no fix available in the old package's dependency tree.
- `overrides` added for `@hono/node-server`, `hono`, `ip-address`, `body-parser`, `fast-uri` — all transitive dependencies of `@modelcontextprotocol/sdk`'s optional HTTP/SSE transport (which this project doesn't use; Stenographer only uses `StdioServerTransport`). Each override pins to the latest version already within its direct consumer's declared semver range (e.g. `express-rate-limit` already declares `ip-address: ^10.2.0`, and `10.5.0` satisfies that) — so these are patch-level fixes the existing dependency tree already permitted, just not what plain resolution picked.

**Remaining (accepted, upstream-blocked):**

`@huggingface/transformers`, `onnxruntime-node`, `onnx-proto`, and `sharp` still carry high-severity advisories with `fixAvailable: false` — these are 2026 libvips CVEs and an unpatched `onnxruntime`/`adm-zip` range with no newer release yet. I verified this isn't specific to the old package: a clean install of `@huggingface/transformers` in isolation still shows 4 high-severity advisories via the same native dependencies. This is a live upstream gap in the JS ML-inference ecosystem, not something fixable by picking a different package. Mitigating factors: (a) `sharp` handles image preprocessing for vision pipelines — Stenographer only calls the text `feature-extraction` pipeline, so that code path is never reached; (b) the model name is an operator-supplied config value (`--embeddings`), not attacker-controlled input, which limits the practical exploit surface for the tensor/protobuf-parsing advisories. **Recommendation:** track `@huggingface/transformers` releases for when upstream `sharp`/`onnxruntime` patches land, and re-run `npm audit` periodically — no action needed today beyond that.

**Not touched (deliberately):**

- `better-sqlite3`, `zod`, `@types/node`, `typescript` — already resolved to the latest version within their existing `^` ranges; no advisories affect them. Their next-major versions (`better-sqlite3` 13, `zod` 4, `typescript` 7 tag, `@types/node` 26) are breaking-change territory with no security driver, so left for a deliberate future upgrade pass rather than bundled into a security audit.

---

## Remaining Technical Debt & Recommended Next Steps

Given how clean this codebase already was, there isn't a large debt backlog. In priority order for future work:

1. **Entity identity model** (see Low/Notes above) — worth revisiting once/if Tier-1 model-based extraction (on the README roadmap) replaces the current regex-based entity capture; the raw-text-as-id design will need to change together with that.
2. **REST API hardening if exposure widens** — if `--rest-host` ever gets used in practice (LAN/container deployments), add token auth and basic rate limiting before that becomes a supported configuration, not after.
3. **Neo4j Cypher builders** (`buildVectorCypher`/`buildGraphCypher`) — parameterize properly once/if a real Neo4j driver call site is added; today they're unused string builders on the roadmap.
4. **Dependency majors** — `better-sqlite3` 11→13, `zod` 3→4, `typescript` 5→7-tag are all available; none are security-driven, so schedule as a normal maintenance pass with its own compatibility testing (zod 4 in particular has documented breaking changes to schema APIs).

## Verification

Every commit in this branch was verified with the full local check suite before being committed:
```
npm run lint   # tsc --noEmit
npm test       # vitest run — 61/61 passing
npm run build  # tsc (core) + tsc -p tsconfig.cli.json (CLI)
```
Plus a manual end-to-end smoke test: built CLI, `catchup` mode, real (non-hashed) transformer embeddings, REST API — confirmed the daemon binds to `127.0.0.1`, indexes messages with genuine 384-dim embeddings, and correctly runs decision supersession end-to-end.

# Stenographer truth format, version 2

This is the contract for truth streams: the JSONL that stenographer's `export_wiki_entries` writes and `import_wiki_entries` reads, and that [short-hand](https://github.com/johnnyclem/short-hand) (`@shorthand/core`), smallchat's vendored mirror and smallchat-swift read as ground truth. It also defines the PROPOSAL envelope that compactors write and stenographer's intake files.

- `wiki-line.v2.schema.json`: JSON Schema (2020-12) for one line.
- `fixtures/`: golden lines, valid and invalid, with the outcome each must have. Consumers run them in their own test suites (see [Fixtures](#fixtures)).
- The reference codec is `src/truth/wiki.ts` (`decodeWikiLine`, `checkWikiChain`, `wikiLineHash`) and, for PROPOSAL lines, `src/truth/intake.ts`. `test/truth-format.test.ts` builds the fixtures from a real ledger, requires them to match the committed files byte for byte, and checks each one against the schema and the codec.

"MUST", "MUST NOT", "SHOULD" and "MAY" are used as in RFC 2119.

## Streams

A truth file is UTF-8 JSONL: one JSON object per line, each ending in LF. Readers MUST skip blank lines and MUST count them when they report line numbers.

**One writer per file.** A file holds one writer's stream, and only that writer appends to it. A team shares truth by each member's stenographer exporting to a file of its own (for example `wiki/<handle>.jsonl`) and importing the others'. A tool that authors truth outside stenographer, such as the Swift messenger, writes through stenographer's API or MCP tools, never by appending to a file stenographer exports: it submits a PROPOSAL envelope (`POST /proposals` in stenographer's REST API) for a person to notarize.

**A stream is hash-chained.** Every line carries:

| Field | |
|---|---|
| `seq` | The line's position in its writer's stream: 1, 2, 3, … with no gaps. |
| `prevHash` | The previous line's `hash`; `null` on the line with `seq` 1, and only there. |
| `hash` | Lowercase hex SHA-256 of the UTF-8 bytes of the line's JCS form ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) with the `hash` field removed. |

A reader MUST refuse a line whose `hash` doesn't match, and a file in which a line's `seq` isn't the previous line's plus one or its `prevHash` isn't the previous line's `hash`. A file MAY start part-way through a stream (an incremental export); its first line's `prevHash` then names a line the file doesn't hold.

**What the chain shows, and what it doesn't.** A valid chain shows that no line was edited, removed, reordered or inserted between its first and last line, and that the lines come from one stream. It does not show who wrote them: anyone can write lines and compute their hashes. It doesn't show that lines were removed from the end either. To catch that, keep the hash of the last line you read and check that the stream still holds it. Authentication by key signature is planned for 1.x.

## Lines

Every line is a JSON object with `schemaVersion: 2`, `seq`, `id`, `type`, `ts`, `author`, `prevHash` and `hash`. A line without `schemaVersion` is version 1 (see [Version 1](#version-1-lines-and-upgrading)).

| Field | |
|---|---|
| `id` | Unique across the team's ledgers. Stenographer writes ULIDs. Letters, digits and `. _ : -`, 1–256 characters, starting with a letter or digit. |
| `type` | `TB`, `UV`, `ADDENDUM`, `RULING`, `PROPOSAL` or `TRANSITION`. |
| `ts` | RFC 3339 date-time naming a real time: no February 30, no `24:00`, no offset past `23:59`. Stenographer writes UTC with milliseconds, and its codec also refuses a leap second (`:60`) and a lower-case `t` or `z`. |
| `author` | Who wrote the entry (see [Identities](#identities)). |
| `x-steno` | Optional. Stenographer's own fields: `origin`, `provenance` (`{kind, ref?, line?}`), `agentSessionId`, `targetRef`, `links` (the links the entry's own write created, `{fromId, toId, type}`, and `contentHash` on a `derives` link) and `ledgerHash` (the entry's hash in its writer's ledger chain, which `stenographer verify` checks). Readers that only fold statuses can ignore it; readers that fold standing read the `derives` links in it ([Derivation](#derivation)). |

### TB: an asserted tombstone

A prior statement is stale or wrong, and someone stands behind saying so.

| Field | |
|---|---|
| `claim` | What is dead, and what replaced it, if anything. |
| `evidence` | At least one `{kind, ref, detail?}`. Known kinds: `commit`, `file`, `test`, `claimed-command`, `wiki`, `message`, `chat`, `ticket`, `doc`. [Evidence classes](#evidence-classes) says what each one names and which can settle a claim. `command` appears only on entries recorded before 1.0: since 1.0, command output a caller submits is recorded as `claimed-command`, because stenographer did not run it. |
| `signedBy` | The person asserting it, or an agent whose TB carries a `quorum`. `null` only on a backfilled TB (author `migration`), which is second-class and never truth on its own. |
| `inference` | Optional. On a derived TB, one sentence stating the inference from its premises to the claim ([Derivation](#derivation)). |
| `literals` | Optional, at least one; a TB with a `quorum` carries them. Dead literals an objection can cite: `{dead, subject?, current?}`, values non-empty with no surrounding whitespace. Without a `subject`, `dead` must be a distinctive identifier: at least 4 characters, at least one ASCII letter. A bare `30` would match everything. |
| `quorum` | Present when agents settled the claim: the agent sessions that drafted it together, and the literals they agreed on are its `literals` (see [Agent quorum](#agent-quorum)). A TB an agent signs is valid only with one. |
| `status` | The TB's status when the line was written: `active`, `contested`, `overridden` or `struck`. |

### UV: an unverified assertion

Believed true, stated before anyone verified it. Flag it; don't block on it.

| Field | |
|---|---|
| `assertion` | The belief, in full sentences. |
| `basis` | Why the author believes it. |
| `verifyBy` | `{kind, value, detail?}`. Known kinds: `command`, `inspect`, `ask`, `observe`. |
| `contests` | The TB this UV disputes, or `null`. **The UV's line is the contest.** No other line carries it. |
| `inference` | Optional. On a derived UV, one sentence stating the inference from its premises to the assertion ([Derivation](#derivation)). |
| `status` | The UV's status when the line was written: `open`, `verified`, `refuted` or `struck`. |

### ADDENDUM and RULING: what changed a status

| Type | Fields | |
|---|---|---|
| `ADDENDUM` | `evidence` (at least one), `note` (string or null), `quorum` (optional) | Evidence that verifies or refutes a UV, or overrides a TB. Verifying a UV that contests a TB is one addendum that does both. An agent's verification or refutation carries a `quorum` (see [Agent quorum](#agent-quorum)); no addendum with a quorum overrides. |
| `RULING` | `kind`, `opinion` (not blank), `target` | A judgment with written reasoning. A wiki stream carries strikes (`kind: "strike"`). |

Their `x-steno.links` say what they do (`verifies`, `refutes`, `overrides`, `strikes`), and they are the `cause.ref` of the TRANSITION lines that follow them.

### TRANSITION: a status changed

```json
{"schemaVersion":2,"seq":4,"id":"<cause id>:<target id>","type":"TRANSITION","ts":"…","author":"alex",
 "target":"<entry id>","status":"contested","cause":{"kind":"contest","ref":"<cause id>"},"prevHash":"…","hash":"…"}
```

| Field | |
|---|---|
| `target` | The TB or UV whose status changed. |
| `status` | Its new status. |
| `cause` | `{kind, ref}`. `kind` is `contest`, `override`, `strike`, `verify` or `refute`, or, in proposal streams, `dismiss` or `promote`. `ref` is the id of the entry that caused the change (the contesting UV, the addendum, the ruling), or `null` when that entry has no line in the stream (stenographer leaves out a pre-1.0 entry the format can't express, and reports it in the export's `skipped`). |
| `author`, `ts` | The cause's. No cause of a status change is written by `migration` or a detector, so a TRANSITION's author is never reserved. |
| `id` | Stenographer writes `<cause id>:<target id>`, or `transition:` and the SHA-256 hex of that when it would be longer than 256 characters. Readers don't derive anything from it. |

A status change is never an edit. It is an appended TRANSITION line. Stenographer writes one each time an exported entry's status changes, right after the line that caused it:

| Cause | TRANSITIONs |
|---|---|
| A UV that contests a TB | TB → `contested` |
| An addendum that overrides a TB | TB → `overridden` |
| An addendum that verifies or refutes a UV | UV → `verified` / `refuted`; a TB it contested → `active` again, unless another contest is open or it was overridden |
| A strike | entry → `struck`; a TB the struck UV contested → `active` again (cause `strike`), unless another contest is open or it was overridden |

## Status is a fold

A reader's current status for an entry is **the `status` of the highest-`seq` TRANSITION that targets it, else the entry line's own `status`**.

| Type | Known statuses | Current truth |
|---|---|---|
| TB | `active`, `contested`, `overridden`, `struck` | `active` (ground truth) and `contested` (ground truth with an asterisk) |
| UV | `open`, `verified`, `refuted`, `struck` | `open` (a heads-up) |

- **Fail closed.** A missing or unknown status means the entry is not current truth. The reader keeps the line as history and preserves it verbatim if it re-serializes.
- In a stenographer stream, `struck` never changes again, and `overridden`, `verified` and `refuted` can only become `struck` (a strike can target a resolved entry). This is the lattice below, one writer at a time.
- A UV that is open and contests a TB is attached to that TB whatever the TB's status says, so the dispute is always visible.
- Consumers SHOULD treat an active TB as ground truth, a contested TB as ground truth with a visible asterisk (cite the contesting UV), and an open UV as a heads-up, never a demand. A refuted UV and an overridden or struck TB are history: never cite them as support.
- Each file is one writer's view. A reader that merges several files folds each one on its own, then takes, per entry, the most advanced status on the lattice TB `active < contested < overridden < struck`, UV `open < verified < refuted < struck`.

Renderers that put truth into a model's context use these markers, and escape them when they appear inside untrusted text: `[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`.

## Derivation

A TB or UV may rest on other entries: the premises it was derived from. It says so with `derives` links in `x-steno.links`, one per premise, running from the entry to the premise, and an `inference`, one sentence stating the inference from the premises to its claim or assertion. The two come together: a line with `derives` links carries an `inference`, and a line with an `inference` carries `derives` links. One to 16 premises, each named once, never the entry itself. A premise is a TB or a UV (a precedent ruling, in a later version). An entry with no derivation is a root: an observation, backed by evidence that isn't a ledger entry.

**Each premise is pinned by content hash.** A `derives` link carries `contentHash`: the lowercase hex SHA-256 of the UTF-8 bytes of the JCS form of the premise's *content*, an object holding the premise line's `type`, `author` and every top-level field except the envelope (`schemaVersion`, `seq`, `id`, `ts`, `prevHash`, `hash`), `x-steno` and `status`. That is the premise's type, author and body as written, unknown fields included, and nothing that depends on its chain position or its state: the same premise hashes the same in every teammate's stream, and a contest or override changes its status, never its hash. Neither the line hash nor `ledgerHash` will do, since both depend on position. The pin says what the signer attested to: a premise whose content hashes to something else is not that premise. Readers MUST refuse a line whose `derives` link lacks a `contentHash`, or whose non-`derives` link carries one.

Signing a derived entry attests three things: that the inference from the premises to the claim is sound, that the premises are compatible as combined here, and that the premises were in good standing when it was signed, which the writer's ledger checks itself. It does not attest that the premises are true. Each premise keeps its own signer.

**Standing** is a second fold beside status, computed on read and never written to a line: status says what happened to an entry, standing says what happened underneath it.

| Standing | When | Consumers treat it as |
|---|---|---|
| `sound` | Every premise, all the way down, is current truth and none is unverified | Whatever its status says |
| `clouded` | Some premise below it is an open UV, a contested TB, or a pinned premise the reader doesn't hold | Ground truth with an asterisk: cite the weak premise |
| `unsupported` | Some premise below it is overridden, refuted or struck | History: never cited as support, never grounds for a denial |

A reader derives standing over the premises it has folded: each entry's premises are the targets of its `derives` links and the `wiki` evidence refs it cites (an unpinned premise, which propagates the same way; one that doesn't resolve is no premise at all). Walking down from an entry, the nearest failing premise on each path sets its standing and is its reason: a premise that is struck, overridden or refuted makes the entry `unsupported`; an open UV, a contested TB or a missing pinned premise makes it `clouded`; a premise that holds on its own passes its own reasons up. An entry is `sound` when nothing below it fails. Standing is reversible, which is why it is not a status: verifying the open UV or refuting the contest clears the cloud, and the status lattice only moves forward. `current` truth leaves `unsupported` entries out. `fixtures/valid/derivation.jsonl` and its expected fold pin the rules.

A reader that doesn't know `derives` fails closed on it like any unknown link type ([Unknown values](#unknown-values)): stenographer 1.0 files such a TB or UV as an `unknown-value` proposal, never as truth, which is intended. A reader that can't follow a derivation should not treat its conclusion as truth.

## Unknown values

A newer writer may add fields or values this version doesn't define. Readers MUST NOT reject a line for an unknown field, or for an unknown value of `status`, an evidence or `verifyBy` `kind`, a provenance `kind`, a link `type`, a ruling `kind`, a `cause.kind` or a proposal `signal.source`. They keep such a line, preserve it verbatim on re-serialization, never coerce a value to a known one, and fail closed: an entry whose status they don't know is not current truth. Equality and conflict detection compare JCS bytes, so key order never matters. The schema is open in the same places. The line `type` and the required fields are closed: a reader refuses a line it can't identify.

Stenographer's import is stricter about what it admits as truth (see [Importing](#importing-stenographers-rules)), and it keeps the unknown fields of the entries it takes and exports them again (rule 10).

`quorum` is a field this version defines, on v2 TB and ADDENDUM lines only: a reader refuses it anywhere else, and refuses one that breaks the [Agent quorum](#agent-quorum) rules. A member's fields other than `author`, `agentSessionId`, `ts` and `evidence`, and an ADDENDUM member's `verdict`, are unknown fields: a `verdict` on a TB member is one, whatever its value. Those rules read the evidence kinds and link types a reader knows, so a quorum line carrying an unknown one is kept like any other: a reader that admits truth fails closed on it instead.

## Evidence classes

An evidence item is `{kind, ref, detail?}`: `ref` names the evidence, and `detail` says what it shows (for example, the output a command printed). Every kind has a class. **Settling** evidence points at something a reader can check against the code or a ledger. **Question** evidence reports what someone said or wrote down: it can prompt a check, but it isn't one.

| Kind | `ref` names | Class |
|---|---|---|
| `commit` | A commit, by its hash. | settling |
| `file` | A file, usually with a line (`path:line`). | settling |
| `test` | A test, by its name or path. | settling |
| `claimed-command` | A command line someone says they ran; `detail` holds the output they say they saw. Stenographer didn't run it. | settling |
| `wiki` | The id of an entry in a truth ledger: this one or a teammate's. A team wiki page is a `doc`. | settling |
| `message` | A message in a conversation transcript, by its id. | question |
| `chat` | A chat message or thread (Slack, Teams, Discord). | question |
| `ticket` | An issue or ticket (Jira, Linear, GitHub issues). | question |
| `doc` | A document or page outside the truth ledger: a design doc, a team wiki page, a README. | question |
| `command` | Command output recorded before 1.0, which nobody re-ran. It can't appear on a new write. | question |

- **`command` stays what pre-1.0 entries mean by it.** It names output a caller submitted, so it never settles anything, and no later version gives it another meaning. A check stenographer runs itself, when a version adds one, gets a kind of its own.
- **Fail closed.** Any kind a reader doesn't know is question-class, whatever a newer writer meant by it: it never settles a claim for that reader. It is an unknown value, not a broken rule, though: the [Agent quorum](#agent-quorum) rules don't refuse a line over it (rule 3), and a reader that admits truth holds or files that line instead, as stenographer's import does ([Importing](#importing-stenographers-rules), rules 5 and 6).
- **In 1.0 the classes bind agents only:** they say which evidence an agent's settlement of a claim can rest on ([Agent quorum](#agent-quorum), rule 3). A person may still sign a TB, or resolve a UV, on evidence of any class.

## Agent quorum

**Since 1.1 agents settle nothing** ([Approvals and promotion](#approvals-and-promotion)): an agent's claim is a UV until a person approves it, and stenographer writes no quorum settlement on any live path. This section still defines the lines a 1.0 writer produced, which every reader checks; the one quorum line a 1.1 writer produces is a [nomination](#nomination), below. A reader that admits truth treats a TB agents minted by quorum as a draft, never as truth ([Importing](#importing-stenographers-rules), rule 3).

Under 1.0 agents settled claims only together: two or more agent sessions agreeing from different angles at the same time. One agent's confidence is not evidence, and an agent on its own can only attest.

**Agent.** An identity the signer registry (see [Identities](#identities)) lists with role `agent`. Without a registry: an identity whose key starts with `agent:`. Stenographer's default agent identity is `agent:<MCP client name>`. With a registry, an identity it doesn't list is not an agent, whatever its name, so it is never a quorum member.

**What agents may settle.** Resolving an open UV as `verified` or `refuted` (an ADDENDUM with a `verifies` or `refutes` link), and writing a TB an agent signs. Nothing else: overriding a TB (`overrides`), striking, dismissing and every ruling stay a person's acts, together or alone. Verifying a UV that contests a TB would override that TB, so agents can't settle it: their agreement is raised to a person instead.

**Quorum.** A settlement by agents is valid only when its line carries a `quorum`: an array of members `{author, agentSessionId, ts, evidence}`, one per agreeing agent session, each with the evidence it brought. An ADDENDUM's members also carry `verdict`, `verified` or `refuted`. A TB's members don't: on a TB member, `verdict` is a field this version doesn't define, an unknown field like any other ([Unknown values](#unknown-values)). A reader keeps it whatever its value and reads nothing from it: it never refuses the line, and a reader that admits truth takes the line as it would without it. The rules:

1. **Two or more.** At least 2 members. Every `agentSessionId` is a string that isn't empty once trimmed, and no two members share one (compared trimmed). Distinct sessions are distinct witnesses, so two sessions may share an identity such as `agent:claude-code`. Every member's `author` passes the identity rules.
2. **The writer is a member.** The line's `author` is one of the members (by key): the agent whose attestation completed the quorum. On a TB, `signedBy` is the line's `author` (by key).
3. **From different angles.** Every member cites at least one item of settling-class evidence ([Evidence classes](#evidence-classes)). No two members cite the same evidence, in any spelling: two items are the same when their `kind`s are equal and their `ref`s are, once normalized for the kind. Every `ref` is trimmed. A `commit` ref is lowercased as an identity is ([Identities](#identities): Final_Sigma included, so `abcΣ` and `abcς` are one commit), and two `commit` refs of which one starts with the other are the same commit (an abbreviated hash). A `file` ref has each `\` read as `/` and its empty and `.` path segments dropped, so `./src//retry.ts:12` is `src/retry.ts:12` (a leading `/` stays). A `test` or `claimed-command` ref has each run of White_Space read as one space. Across all members, the settling evidence spans at least two kinds. A kind the reader doesn't know may be a newer writer's settling kind, so it never breaks this rule: a member citing one isn't refused for citing no settling evidence, nor the line for spanning one settling kind (it is an unknown value, which a reader that admits truth fails closed on).
4. **At the same time.** Every member's `ts` and the line's own `ts` lie within 15 minutes of each other: the latest minus the earliest is at most 900 000 ms, each timestamp read to the millisecond (fractional digits past the third are dropped, not rounded).
5. **Agreeing.** On an ADDENDUM the members' `verdict`s agree, and each is the one every `verifies` or `refutes` link of the line applies (`verifies` → `verified`, `refutes` → `refuted`); an ADDENDUM with a quorum never carries an `overrides` link. A TB with a quorum carries the literals its members agreed on (`literals`, at least one). That the members drafted that same set of literals is the writer's obligation: readers can't see the drafts.
6. **The line shows its evidence.** The line's `evidence` is the members' evidence: it holds every member's items, and no item no member cites. Here items compare by `kind` and trimmed `ref`, without rule 3's normalization: the line lists each item as its member cited it.

*Trimmed*, in these rules, means with leading and trailing characters that have the Unicode White_Space property removed (U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000), and no others: not U+FEFF, which some languages' trim removes too.

Readers MUST refuse a line whose `quorum` is present and breaks rules 1–6 (except that the members drafted the TB's literals, which no reader can check), or that carries a `quorum` on any line but a v2 TB or ADDENDUM: a v1 line never carries one. Like the link rules, this is line-local: on an ADDENDUM, rule 5 reads the links in `x-steno.links` and nothing else, so a top-level `links` is a field this version doesn't define ([Unknown values](#unknown-values)), which neither hides a break of rule 5 nor refuses a line that keeps it, whatever it holds. A line that lists no `verifies` or `refutes` link (no `x-steno.links`, an empty list, or only link types the reader doesn't know) is checked for agreeing verdicts only. The schema checks a quorum's shape (at least two members, each `{author, agentSessionId, ts, evidence}`, with `verdict` on an ADDENDUM, and `literals` on a TB that has a quorum); the rules across members and the line are the codec's, and `fixtures/invalid/codec.jsonl` breaks each one.

A reader that only folds statuses otherwise relies on the writer for who may change a status, as it already does for people's acts. Stenographer's import checks authority ([Importing](#importing-stenographers-rules), rules 3 and 6): an agent-signed TB is truth only with a valid quorum whose members are all agents, and an agent's resolution applies only with a valid quorum whose members are all agents and each meet the contempt-of-corpus rule, and never when it verifies a UV that contests a TB, which would override that TB.

**An unknown evidence kind fails closed.** A TB an agent signed, or an ADDENDUM an agent wrote, settles nothing when the line or any member of its quorum cites an evidence kind the reader doesn't know, however well its quorum keeps rules 1–6 otherwise. The line decodes (rule 3 refuses no line over an unknown kind), and its `evidence` shows the kind, since rule 6 puts every member's items there. A reader that admits truth fails closed on it: stenographer's import files such a TB as a reconciliation proposal with reason `unknown-value` (`unknown-status` when its status is unknown as well), never as truth and never as `agent-without-quorum`, and holds such an ADDENDUM ([Importing](#importing-stenographers-rules), rules 5 and 6). A link type the reader doesn't know in the line's `x-steno.links` fails closed the same way: the line decodes, and stenographer's import files such a TB as `unknown-value` and holds such an ADDENDUM.

**How stenographer wrote one.** Under 1.0, in its agent profile, `resolve_uv` recorded the session's verdict as an attestation (operational state, never exported), and when attestations from distinct sessions agreed within 15 minutes from different angles, the one that completed the quorum wrote the ADDENDUM: its author and session, every member's evidence (in member order, each item once), and the members ordered by `ts`. Agent drafts from distinct sessions naming the same set of literals, within 15 minutes and from different angles, minted the TB together, signed by the agent whose draft completed the quorum, with a `signs` link to each draft. Since 1.1 a verified verdict is the session's approval and a refuted one waits on the docket; an opposite verdict within the window is still a dispute a person is told of. A person still acts alone.

## Approvals and promotion

An agent's claim is a UV, and a tombstone an agent proposes is a UV-class draft. No number of agent sessions mints a TB. A UV becomes a TB by **promotion**: two approvals, one of them a person's. The second may be an agent session, citing settling evidence of its own ([Evidence classes](#evidence-classes)), or the **reporter**, the stenographer process itself, which approves only by citing the passages of the indexed record that support the claim and never counts as the person. Approvers are distinct sessions, and nobody approves what they drafted: the contempt-of-corpus rule binds every approver, by identity and by agent session.

On the wire, a promotion is an ordinary verified resolution of the UV (an ADDENDUM with a `verifies` link, and an `overrides` link when the UV contests a TB) followed by a TB signed by the person, with two more top-level fields:

| Field | |
|---|---|
| `approvals` | `[{by, role, ts, agentSessionId?, cites?}]`: who approved the UV. `role` is `human`, `agent` or `reporter` (an open string: a reader keeps one it doesn't know). An agent's approval names its session; the reporter's names the message ids it cites. The person who signed the TB is among them. |
| `answerableBy` | The person who answers for the TB. |

The TB's `evidence` is the union of the approvals' evidence, it keeps the UV's `derives` links and `inference`, and it carries a `supersedes` link to the UV. A reader that doesn't know `approvals` keeps it verbatim ([Unknown values](#unknown-values)) and sees a TB a person signed, which it admits.

**Answerability** is assigned at promotion and nowhere else. A TB a person asserts directly is answered for by its signer, a notarized draft by its notary, so every TB a person signed names `answerableBy`, and "unanswered TB" is not a state. A TB agents minted under 1.0's rule names nobody, and neither does a backfilled TB. Every RULING names `answerableBy` too: its author. `answerableBy` is a name in the signer registry, exactly as `signedBy` is; key signatures are planned for 1.x.

## Nomination

Three or more agent sessions approving a UV from different angles do not promote it. They **nominate** it: the session that completes the nomination writes one ADDENDUM with a `corroborates` link to the UV, carrying the approving sessions in the existing `quorum` field, each with `verdict: "verified"`. The UV's status does not change: it stays open, and a reader that holds the nomination reads the UV as *corroborated* (a UV with a `corroborates` link into it from an ADDENDUM that isn't struck), renders it with the marker `[UV · CORROBORATED]`, and applies the consumption rule for a UV: flag, don't block. A corroborated UV is the cheapest context to hand another agent: an agent of the same kind found it, with the receipts.

A nomination keeps the [agent quorum](#agent-quorum) rules with three differences, all read off the line: rule 1 asks for three members, not two; rule 4 (the 15-minute window) doesn't bind it, since it settles nothing, so approvals days apart nominate together; and rule 5 asks that every member's `verdict` is `verified` and that the line carries no `verifies`, `refutes` or `overrides` link beside its `corroborates` link. Rules 2, 3 and 6 are unchanged: the writer is a member, every member cites settling evidence of its own with no item shared and two kinds between them, and the line's `evidence` is the members'. Readers MUST refuse a line that breaks them. A nomination travels in a wiki stream and emits no TRANSITION. A 1.0 reader doesn't know `corroborates`, fails closed on it and holds the line; the UV stays open there too, which is all a nomination does for an upgraded reader.

Agents' tombstone drafts nominate the same way, read off the open drafts of one set of literals from three sessions and different angles; no line is written, since a draft is not an entry, and the drafts go first on the person's docket.

## Identities

`author` and `signedBy` name someone who stands behind the entry, a person or an agent. An agent settles a claim only in a quorum ([Agent quorum](#agent-quorum)), whose members' `author`s pass these rules too. Readers MUST refuse a line whose identity:

- is anonymous or generic: `system`, `assistant`, `agent`, `ai`, `bot`, `anonymous`, `unknown`, `user`, `human`, `admin`, `null`, `none`, `me`, or empty;
- contains a control character (Unicode category Cc);
- is reserved where it doesn't belong: `migration` authors only an unsigned backfilled TB, and `detector:*` authors only PROPOSAL lines. A TRANSITION takes its cause's author, so it is never reserved.

Identities compare by key: Unicode NFKC, default-ignorable code points removed, trimmed, lowercased. So `Assistant` and `ａｓｓｉｓｔａｎｔ` are both refused, and `Alice` and `alice` are one person. Lines store identities as written.

*Lowercased*, here and for a `commit` ref ([Agent quorum](#agent-quorum), rule 3), means Unicode's default full lowercase mapping without language-specific rules, Final_Sigma included (Unicode Standard, section 3.13), as ECMAScript's `String.prototype.toLowerCase` does: a `Σ` (U+03A3) that follows a cased letter and isn't followed by one, case-ignorable characters aside, becomes `ς` (U+03C2), and any other becomes `σ` (U+03C3). So `agent:ΟΔΥΣΣΕΥΣ` keys to `agent:οδυσσευς`, which isn't `agent:οδυσσευσ`. A lowercasing that maps every `Σ` to `σ` gets these keys wrong.

*Unicode version.* Identity keys and `commit` refs are computed with the reader's Unicode data: stenographer and short-hand use their runtime's ICU (Node 22 is Unicode 16, Node 24 is Unicode 17), and Swift's Foundation on Linux is Unicode 15. So a character assigned or changed after Unicode 15.0 may key differently between readers. Identities SHOULD NOT use such characters. Key signatures (planned for 1.x) remove this dependence.

**The signer registry.** A reader that checks who may sign (stenographer's import, rules 3, 4 and 6) reads a JSON file, `{"signers": [...]}`, with one entry per signer:

| Field | |
|---|---|
| `id` | A handle, compared by key. One that ends in `*` is a prefix: `agent:*` lists every identity that starts with `agent:`. |
| `role` | `human`, `agent` or `detector`. Who is an agent, for the [Agent quorum](#agent-quorum), is the registry's `agent` role. |
| `aliases` | Optional. Other spellings that resolve to `id`. |
| `keys` | Optional. `[{alg, id, publicKey}]`, each a non-empty string: `alg` names the signature algorithm (such as `ed25519`), `id` names the key among the signer's keys, and `publicKey` is the key. Reserved for key signing in 1.x: a 1.0 reader accepts `keys` and ignores it. Stenographer refuses a key with any other field, so a private key can't be put there by mistake. |

The registry is an allowlist of names and roles, not authentication: it doesn't show who wrote a line.

## Links an entry may carry

A TB or UV line's `x-steno.links` speak only for that entry. Each link either starts at it with a type its type writes (TB: `supersedes`, `signs`, `derives`; UV: `contests`, `signs`, `derives`), or ends at it with a type that can target its type (TB: `overrides`, `contests`, `supersedes`, `strikes`; UV: `verifies`, `refutes`, `supersedes`, `strikes`, `corroborates`). An ADDENDUM writes `verifies`, `refutes`, `overrides` and `corroborates` (the last only on a [nomination](#nomination)); a RULING writes `strikes` and `dismisses`. A UV's `contests` link points at the TB its `contests` field names. An ADDENDUM or RULING lists only links that start at it. No link is listed twice. Readers MUST refuse a line that breaks these rules, unless the link's type is one they don't know (see above).

## Hash: a worked example

The first line of `fixtures/valid/ledger.jsonl`:

<!-- worked-example -->
```json
{"schemaVersion":2,"seq":1,"id":"01M1E6JK80P9Y3CMA9HBZEND9H","type":"TB","ts":"2026-09-01T10:00:00.000Z","author":"johnnyclem","claim":"LOG_BUDGET is 100; the old value 30 is dead.","evidence":[{"kind":"commit","ref":"9f2c1ab"},{"kind":"claimed-command","ref":"grep LOG_BUDGET config.ts","detail":"LOG_BUDGET = 100"}],"signedBy":"johnnyclem","literals":[{"dead":"30","subject":"LOG_BUDGET","current":"100"},{"dead":"legacyRateLimiter"}],"answerableBy":"johnnyclem","status":"active","x-steno":{"origin":"local","provenance":{"kind":"manual"},"agentSessionId":null,"targetRef":null,"links":[],"ledgerHash":"30229267e2a3c2cc1e25de7ee41e9ddd1f6b29c28b014d6bfebce9703311fa80"},"prevHash":null,"hash":"c8d3ade2385a4f92811b47b1783457b9c64a5d954e55d83eb24a00048228d15d"}
```

Without `hash`, in JCS form:

```
{"answerableBy":"johnnyclem","author":"johnnyclem","claim":"LOG_BUDGET is 100; the old value 30 is dead.","evidence":[{"kind":"commit","ref":"9f2c1ab"},{"detail":"LOG_BUDGET = 100","kind":"claimed-command","ref":"grep LOG_BUDGET config.ts"}],"id":"01M1E6JK80P9Y3CMA9HBZEND9H","literals":[{"current":"100","dead":"30","subject":"LOG_BUDGET"},{"dead":"legacyRateLimiter"}],"prevHash":null,"schemaVersion":2,"seq":1,"signedBy":"johnnyclem","status":"active","ts":"2026-09-01T10:00:00.000Z","type":"TB","x-steno":{"agentSessionId":null,"ledgerHash":"30229267e2a3c2cc1e25de7ee41e9ddd1f6b29c28b014d6bfebce9703311fa80","links":[],"origin":"local","provenance":{"kind":"manual"},"targetRef":null}}
```

Its SHA-256 is `c8d3ade2385a4f92811b47b1783457b9c64a5d954e55d83eb24a00048228d15d`, the line's `hash`. The hash covers every field but `hash`, including unknown ones, which is one more reason a reader never rewrites a line it didn't write.

## What travels in a wiki stream

Stenographer's wiki export carries, in ledger order: every TB and UV; every ADDENDUM or RULING that changes the status of one, and every nomination (an ADDENDUM with a `corroborates` link, which changes no status); and a TRANSITION for every status change of an exported entry. It never carries proposals. A dismissal closes a proposal, so dismissals don't travel either: declining a wiki line is a local decision. Promotion, contempt and objection rulings change no status and don't travel. Neither do the ledger's `MARKER` entries.

## Importing (stenographer's rules)

`import_wiki_entries` applies these rules. Other readers SHOULD apply the parts that fit them.

1. **One transaction per file.** Every line is validated, the chain is checked, and each line is appended through the same admission check as a live write. If any line fails, nothing is written, and the result lists every failing line (`committed: false`, `errors: [{line, id, error}]`).
2. **Lines the ledger already holds.** An entry line whose id the ledger holds, with the same type, author and body (compared as JCS), is a no-op. A different one is a conflict: it is filed as a reconciliation `PROPOSAL`, and the held entry is left as it is. An ADDENDUM or RULING whose id is held with different content is an error.
3. **A TB lands as truth only when it is signed by a person and verifiable.** Signed means `signedBy` is not null. Verifiable means a v2 line in a valid chain, and, when the importer has a signer registry, its author and signer listed there as a person or an agent. A TB an agent signs never lands as truth: with a valid `quorum` whose members are all agents ([Agent quorum](#agent-quorum); with a registry, each listed with role `agent`) it is a TB agents minted under 1.0's rule, filed as a nominated UV-class draft that waits on the docket (reason `agent-quorum`, `meta.nominated`); without one it is filed with reason `agent-without-quorum`. This is an admission rule, not a format change. Any other TB becomes a reconciliation `PROPOSAL` that a person must notarize (`requiresNotary`, author `detector:wiki-sync`, `targetRef` the line's id). It is never active truth on its own. A promoted TB's `approvals` and `answerableBy` are kept with the entry ([Approvals and promotion](#approvals-and-promotion)).
4. **A UV lands when its author passes the registry**, when there is one. Otherwise it becomes a reconciliation proposal too.
5. **Fail closed.** A TB or UV line whose `status` stenographer doesn't know, or that says `struck` (only a strike, which travels, can set that), or that has an evidence, `verifyBy`, provenance or link value stenographer doesn't know, becomes a reconciliation proposal (`unknown-status`, `unknown-value`). It never becomes truth. A terminal status on an entry line (`overridden`, `verified`, `refuted`) is kept: no later line can undo it. This rule is weighed before rules 3 and 4, whoever signed the line: an unknown status is `unknown-status`, else an unknown value is `unknown-value`. So a TB an agent signed, when the line or any member of its quorum cites an evidence kind stenographer doesn't know, is filed as `unknown-value`, however valid its quorum ([Agent quorum](#agent-quorum): rule 6 puts every member's items in the line's `evidence`).
6. **Status changes come from their causes.** Stenographer applies an ADDENDUM or RULING through its links, when its author may perform the act: an override, a strike or any ruling needs a person (with a registry: one it lists as `human`; never an agent), and a verification or refutation needs a person, or an agent with a valid `quorum` whose members are all agents ([Agent quorum](#agent-quorum); with a registry, each listed with role `agent`). A [nomination](#nomination) applies with its quorum of three or more agents, and marks the UV corroborated here. A refutation or override that applies runs the suspicion detector here: the proposals it files never travel. An agent's quorum never verifies a UV that contests a TB: that would override the TB, which a person does. A resolution also meets the contempt-of-corpus rule, for its author and for every quorum member: none can be the UV's author or drafter, or come from the UV's agent session, and refuting a contest can't come from the contested TB's author, signer or drafter. One that fails these checks, whose target the ledger doesn't hold, that lists no links (`x-steno.links` absent or empty: what it changes is unknown), or that carries a value stenographer doesn't know (an evidence kind, a link type, a provenance or ruling kind), is **held**: it is reported, nothing is written, and a later import tries it again. So an ADDENDUM an agent wrote, when the line or any member of its quorum cites an evidence kind stenographer doesn't know, is held, however valid its quorum. A change whose effect is already in place, such as an override of a TB that was overridden here first, is recorded and changes nothing.
7. **TRANSITION lines are checked, not applied.** Stenographer derives status from the causes. A TRANSITION whose `cause.ref` is neither earlier in the file nor in the ledger is an error. One with a status stenographer doesn't know is held.
8. **PROPOSAL lines don't belong in a wiki file.** They are an error there; the intake files them.
9. **Re-importing is a no-op.** A line whose reconciliation proposal exists, in any status, is not filed again, so a dismissed one isn't raised again and a signed one isn't minted twice.
10. **Unknown fields are kept.** A TB, UV, ADDENDUM or RULING line's top-level fields that this version doesn't define (any field but the line's envelope, `x-steno` and its type's own fields above) are stored with the entry, count in rule 2's comparison, and are exported again verbatim. A quorum member's unknown fields, such as a TB member's `verdict`, are kept as part of its `quorum` in the same way, whatever their values, and are no reason to refuse, file or hold the line. A TRANSITION line isn't stored (rule 7), so its unknown fields aren't kept. Neither are those of a line filed as a reconciliation proposal: the proposal's draft is what a person would sign, and the line's `hash` stays under its `meta.wiki`.
11. **Derived lines.** A TB or UV with `derives` links is admitted like any other, with its pins checked against the premises this ledger holds: a premise held here with other content (one the stream filed as a conflict when it arrived) makes the derived line a `conflict` proposal too, since what its signer attested to isn't what this ledger has. A premise not held here lands the entry clouded (`premise-missing`) until it arrives; one that died here lands it unsupported; one that rests on the entry itself is refused (a derivation is acyclic). Standing is derived here, never read from a line ([Derivation](#derivation)).

Without a signer registry, any identity that passes the identity rules is accepted where a registry would be consulted, as on stenographer's live operator paths, and an agent is an identity whose key starts with `agent:`. A valid chain then shows the lines are unchanged, not who wrote them.

## Exporting (stenographer's rules)

- The export is the ledger's stream from `seq` 1. The stream depends only on the ledger's entries in order, so it only grows at the end: line *n* is the same on every export.
- An imported entry's line carries the unknown fields it came with (Importing rule 10), as they came. `x-steno` is this ledger's own record, written afresh. TRANSITION lines are derived from the causes this ledger applied, so an imported TRANSITION's unknown fields don't reappear.
- `sinceSeq` returns the lines after that seq. The result reports `lastSeq`, which is what to pass next time. `since` (an ISO timestamp) is a deprecated alias: it returns the stream from the first line written after that time, so the lines still chain.
- Exporting into a file appends, in one write, the lines of the stream the file doesn't hold yet. The file must hold a run of this ledger's stream and nothing else. A file holding a teammate's lines, or an edited line, is refused and left untouched. Export never truncates or rewrites a line.
- MCP callers name files relative to the wiki directory (`--wiki-dir`, default `wiki/` next to the state file). Absolute paths, `..`, names that aren't `*.jsonl`, symlinks that resolve outside the directory and the state file itself are refused.

## The PROPOSAL envelope

One envelope for every proposal in the suite: short-hand's and smallchat's compactors, smallchat-swift, and agents.

```json
{"schemaVersion":2,"seq":1,"id":"…","type":"PROPOSAL","ts":"…","author":"detector:short-hand",
 "kind":"tb","draft":{"claim":"…","evidence":[…],"literals":[…]},"targetRef":"shorthand:tombstone:msg_0101",
 "signal":{"source":"compaction-candidate","detail":"…"},"agentSessionId":null,"prevHash":null,"hash":"…"}
```

- `kind` is `tb` (draft: `claim`, `evidence`, `literals?`) or `uv` (draft: `assertion`, `basis`, `verifyBy`, `contests?`).
- `signal.source` is `compaction-candidate`, `agent`, or `detector:<name>`.
- A proposals file is a hash-chained stream like a wiki file, with one writer.
- Stenographer's intake files each line as an open `PROPOSAL` that only a person can turn into truth, and keeps the envelope's `id`, `author`, `signal.source` and `hash` under `meta.intake`. A line is filed once, by its `id`: re-importing it, after it was signed or dismissed too, files nothing, and envelopes that share a `targetRef` are each filed. An `id` names one envelope: the same envelope at another `seq` is the same envelope, and a different one under an `id` already filed is refused (compared as JCS without `seq`, `prevHash` and `hash`). A `signal.source`, evidence kind or `verifyBy` kind it doesn't know is kept as written and listed under `meta.intake.unknown`.
- An envelope submitted on its own (stenographer's `POST /proposals`) MAY leave out `seq`, `prevHash` and `hash`: it is then read as a stream of one line with `seq` 1. Any of them that is present is checked as in a stream. Streams and submissions share one `id` namespace: stenographer refuses (`409`) a submission whose `id` a proposals file filed first.
- The older bare short-hand line (`{kind: "tombstone", draft, signal, targetRef?}`) and the `shorthand-compaction` source are still read, and no longer written.

## Version 1 lines and upgrading

Stenographer 0.x wrote v1 lines: no `schemaVersion`, no `seq` or hash, a `status` field holding the status at export time, and `x-steno.links` that could include other entries' links. Stenographer 1.0 still reads them:

- They are validated like a live write. Identities are canonicalized (trimmed, NFC), `command` evidence becomes `claimed-command`, and a status stenographer doesn't know fails closed.
- A terminal `status` (TB `overridden`; UV `verified` or `refuted`) is kept. Other statuses are dropped, and links decide.
- Links that aren't the entry's own are dropped, not refused.
- A v1 TB has no hash, so it is unverifiable. It is filed as a reconciliation proposal for a person to sign. A v1 UV is admitted.

v1 couldn't carry status changes, and a 0.x full export rewrote the file, which one writer per file forbids. To move a team to v2, each member upgrades and exports into a new file of their own. Stenographer won't append v2 lines to a v1 file, since the file isn't a run of its stream.

## Fixtures

| File | What a conforming reader does |
|---|---|
| `signers.json` | The signer registry the fixtures assume (see [Identities](#identities)). One entry carries `keys`, which every 1.0 reader must accept and ignore. |
| `valid/ledger.jsonl` | One ledger's stream. It covers a TB with literals and `claimed-command` evidence, an open UV, a contest, an addendum that verifies the contest and overrides the TB, the superseding TB, a strike, an agent's UV refuted by a person, a notarized agent draft whose `signs` link names a proposal that didn't travel, a UV verified by a two-session agent quorum, and a TB two agents' drafts minted by quorum under 1.0's rule (which a 1.1 importer files for the docket, never as truth), with a TRANSITION after each change. Every TB a person signed and every ruling names `answerableBy`. Every line passes the schema, every hash recomputes, and the lines chain. |
| `valid/ledger.expected.json` | The fold: `{id: {type, status, current}}` for every TB and UV. |
| `valid/derivation.jsonl`, `derivation.expected.json` | One ledger's stream with derived entries ([Derivation](#derivation)): a root TB and a root UV, a TB derived from both (pinned by content hash, with an `inference`), a UV derived from that TB, and a TB citing the root TB as `wiki` evidence (an unpinned premise); then the UV premise is verified, which clears the cloud, and the root TB is struck, which undermines everything on it. The expected file is the fold with standing: `{id: {type, status, current, standing, reasons}}`, where `reasons` name the nearest failing premise on each path (`{premise, reason, via?}`) and `current` leaves `unsupported` entries out. A reader that folds standing MUST match it. |
| `valid/review.jsonl`, `review.expected.json` | An agent's UV, nominated by three agent sessions days apart (an ADDENDUM with a `corroborates` link and a three-member `quorum`, no TRANSITION), then promoted by a person: the ADDENDUM that verifies it and the TB signed by the person, with `approvals` and `answerableBy` ([Approvals and promotion](#approvals-and-promotion), [Nomination](#nomination)). The expected file is the fold with standing plus `corroborated` on the nominated UV. |
| `valid/proposals.jsonl`, `proposals.expected.json` | A PROPOSAL envelope stream and the kind each line files as. Two envelopes share a `targetRef` (each is filed), and one carries an unknown `signal.source` and evidence kind (filed; `unknown` lists them as stenographer records them). |
| `valid/unknown.jsonl`, `unknown.expected.json` | What a newer writer may send: an unknown field, unknown statuses, an unknown evidence kind and `verifyBy` kind. `fold` is what readers compute, failing closed. `import` is what stenographer does with each line; the entry it takes keeps its unknown field, and exports it again. |
| `valid/routing.jsonl`, `routing.expected.json` | Valid lines stenographer doesn't simply take as truth, each imported on its own: `inserted` (with the resulting `status`), `proposal` (with a `reason`), or `held` (with `heldReason`, a substring of stenographer's reason, where it is the point). A line with `after` is about entries other lines hold: stenographer imports those lines first, each on its own. Among them: a TB an agent signed without a quorum (`agent-without-quorum`) and an agent's verification without one (held); an agent quorum verifying a UV that contests a TB (held, after that TB and UV); quorum ADDENDUMs with an evidence kind or link type this version doesn't know, or with no links, which decode and are held; one whose members lie 900 000.9 ms apart, which decodes (rule 4 reads timestamps to the millisecond); and two TBs an agent quorum signed that cite an evidence kind this version doesn't know, one with a member citing only that kind and one whose members keep rule 3 with two known settling kinds while a member also cites it, which decode and are filed as `unknown-value`; and a TB an agent quorum signed one of whose members carries `verdict: "bogus"`, a field only an ADDENDUM's members define, which decodes and is filed as every agent-minted TB is (`agent-quorum`), the field no reason to refuse or hold it; three quorum ADDENDUMs that keep rule 5 against their `x-steno.links` and carry a top-level `links`, a field the format doesn't define (`[{"type":"overrides"}]`; a `verifies` link beside `refuted` verdicts and an `x-steno` `refutes` link; the string `"echoes"`), which decode and are held only because their UV isn't in that ledger (imported after it, from `ledger.jsonl`, each resolves it); a TB an agent quorum signed whose `x-steno.links` carries a link type this version doesn't know (`echoes`), which decodes and is filed as `unknown-value`; and the TB two agents' drafts minted by quorum in `ledger.jsonl`, filed as a nominated draft (`agent-quorum`). Derivation: a derived TB whose premises this ledger doesn't hold, which lands clouded (`inserted`, with `standing`); the premise it pins with other content, as a stream of its own; and the same derived TB after that premise, filed as a `conflict`, since its pin names content this ledger doesn't hold. |
| `v1/legacy.jsonl`, `legacy.expected.json` | 0.x lines and their outcomes. The v2 schema refuses them; the codec reads them as version 1. |
| `invalid/schema.jsonl`, `schema.expected.json` | Lines the schema and the codec both refuse, with the `reason`. Each is otherwise valid and correctly hashed. Among them: a quorum TB without literals, a v1 line carrying a quorum, a quorum ADDENDUM member whose `verdict` is neither `verified` nor `refuted`, a derived TB with an empty `inference`, and a `derives` link whose `contentHash` is not a hash. |
| `invalid/codec.jsonl`, `codec.expected.json` | Lines the schema accepts and the codec refuses: hash, identity, link and agent quorum rules that JSON Schema can't express, one line per quorum rule a line can break, and the quorum rules at their edges: sessions equal once trimmed, one commit, file or command in two spellings, a line's own `ts` too late, 900 001 ms, and lowercasing with Final_Sigma (see [Identities](#identities)): an author `agent:ΟΔΥΣΣΕΥΣ` whose quorum names `agent:οδυσσευσ` but not the author, which breaks rule 2 only because the two keys differ, and members citing the commits `abcΣ` and `abcς`, which are one commit. Two quorum ADDENDUMs whose members say `verified` while their `x-steno.links` link `refutes` break rule 5 beside a top-level `links` of `null` or `[]`, which hides nothing. The derivation rules ([Derivation](#derivation)): a `derives` link without a `contentHash`, an entry deriving from itself, a premise named twice, `derives` links without an `inference` and an `inference` without them, a `contentHash` on a link that isn't `derives`, and seventeen premises. `error` is a regular expression for stenographer's message; other readers need only refuse the line. |
| `invalid/chain-gap.jsonl`, `chain-fork.jsonl`, `chain.expected.json` | Valid lines that aren't one stream: a missing line, and a line from another writer. |

A consumer's test SHOULD validate every valid line against the schema, parse it with its own codec, recompute every `hash`, check the chain of each valid file except `routing.jsonl` (its lines come from two ledgers and are imported one at a time, so it is not one stream), fold `ledger.jsonl` and `unknown.jsonl` and compare the results with their expected files, and refuse every invalid line.

The fixtures come from a real ledger with the clock and the random source pinned, so the same code always writes the same bytes. A change to the fixtures is a change to the format. `UPDATE_TRUTH_FORMAT_FIXTURES=1 npx vitest run test/truth-format.test.ts` regenerates them; review the diff.

## Versioning

`schemaVersion` changes when a rule changes or a field's meaning does. Readers MUST refuse a `schemaVersion` they don't know rather than guess. A new optional field or value that readers can ignore, failing closed, keeps version 2 and is listed in stenographer's CHANGELOG. A new settling evidence kind or resolution link type is such a value: an older reader keeps the quorum lines that use it, and they settle nothing for it. So are `derives` links, `contentHash` and `inference` ([Derivation](#derivation)), added in stenographer 1.1: a 1.0 reader keeps a derived line and files it as `unknown-value`, never as truth.

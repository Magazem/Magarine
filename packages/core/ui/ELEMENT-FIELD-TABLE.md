# Every element on the page, and the daemon field behind it

Batch 15, Role B, deliverable 2. Authority: `docs/strategy/batch-15-spec.md` section 3.

**Rule 8: the interface shows only what the daemon measures.** This file is the
proof, line by line. It is committed beside the page and is meant to be read
against the real API, not taken on trust.

Three kinds of row, and the distinction is the point:

| mark | meaning |
|---|---|
| **field** | a value the daemon returns. Named exactly as the API returns it. |
| **copy** | fixed text the page owns. It never varies with data and claims to measure nothing. |
| **derived** | computed by the page from named fields, by a rule stated in the row. No hidden inputs. |

Anything in pass 3 with no field behind it is **omitted and listed** in section
9, never mocked. `packages/core/ui/index.html` ships with every container
empty; there is no fixture anywhere under `packages/core/ui/`.

Routes used, and the page requests nothing else:

| route | file that builds it |
|---|---|
| `GET /projects` | `src/commands/projectList.ts` → `ProjectListEntry[]` |
| `GET /board?project=` | `src/commands/board.ts` → `BoardResult` |
| `GET /inbox?project=` | `src/commands/inbox.ts` → `InboxItem[]` |
| `GET /activity?project=` | `src/commands/activity.ts` → `EventRow[]` |
| `GET /projects/{id}/scope` | `src/daemonApi.ts` → `{ scopeText, status }`; **400** when the file exists but cannot be read (ruling 29) |
| `GET /projects/{id}/conversation` | `src/commands/conversation.ts` → `ConversationEntry[]` |
| `GET /events?since=` | Role A's stream. Events are event rows as JSON. |
| `POST /tickets/{id}/{decide,approve,reject,retry}` | existing write routes |
| `POST /projects/{id}/{set,resume,discuss}` | existing write routes |
| `GET /ui/<name>` | the static assets: this page and its five files |

---

## 1. Topbar

| element | kind | source |
|---|---|---|
| `MAGARINE` wordmark | copy | — |
| project selector options | field | `ProjectListEntry.name`, falling back to `.id` when the name is empty |
| project id under the selector | field | `ProjectListEntry.id` |
| nav links | copy | anchors to the six region ids. Not data. |
| "Needs you" count badge | derived | `InboxItem[]` length. Hidden at zero rather than showing "0". |
| document title | derived | `Magarine`, or `(N) Magarine` with the same `InboxItem[]` length as the badge when N is above zero, so a window host's taskbar entry shows it while the window is behind another. Reset to `Magarine` at the gate. Batch 17 |
| favicon | asset | `ui/favicon.svg`, linked from `index.html`: one 5x5 organism (ring family, quad symmetry, hollow middle) in the active-blue on black. Fixed colour, because a favicon has no ticket status to take one from. Batch 17 |
| spend figure | field | `BoardResult.projectSpendUsd`, formatted to 2dp |
| "at least" prefix on spend | field | shown when `BoardResult.projectSpendIsEstimate` |
| "of $X" after spend | field | `BoardResult.projectMaxSpendUsd`; absent when null |
| "fallback rate used" | field | shown when `BoardResult.projectUsedFallbackRate` |
| spend tooltip (equivalent API cost / session limits) | copy | the wording batch 12 fixed |
| `live` / `polling` word | derived | `true` only while a stream is genuinely open. See section 7. |
| OLED / Navy / Paper | copy | palette switch, `data-theme` on the root. Not data. |

## 2. Fleet

**One row per ticket in `IN_PROGRESS`.** The daemon has no agent entity, no
roster and no idle worker, so the fleet is exactly the set of running tickets.

| element | kind | source |
|---|---|---|
| worker count | derived | count of `BoardTicket.status === 'IN_PROGRESS'` |
| organism shape | derived | `ui/organism.js` seeded by the model id; see section 8 |
| organism colour | field | `BoardTicket.status` |
| name line | derived | the tier, from `organism.js`'s `tierOf(model)` — the ONE derivation |
| model line | field | `BoardTicket.model`, or `ProjectListEntry.defaultModel` when null |
| model line when both are absent | copy | "tickets.model is null and the project has no default" |
| activity line | field | `BoardTicket.latestActivity.state` and `.tool` |
| activity line when absent | copy | "no progress event recorded yet" — never a guessed state |
| empty fleet | copy | "no ticket is IN_PROGRESS" |
| legend | copy | — |

## 3. Board

Six lanes over eight statuses. **Nothing is hidden:** `CANCELLED` shares the
terminal lane with `DONE`, struck through, rather than being dropped.

| element | kind | source |
|---|---|---|
| lane names and grouping | copy | `STATUS_LANES` in `app.js`, over `types.ts`'s `TicketStatus` |
| lane count | derived | tickets whose status is in that lane |
| "N tickets · M running" | derived | `BoardResult.tickets` length; `IN_PROGRESS` count |
| Board / List toggle | copy | `data-board-view` on `#board`; both views show the same tickets |
| card short id | derived | `BoardTicket.id` up to the first `-`. The full id is in the list view, Needs you and the conversation. |
| card title | field | `BoardTicket.title` |
| card organism | derived | as section 2 |
| card cost | field | `BoardTicket.costUsd` |
| "at least … live estimate" | field | `BoardTicket.costIsEstimate` |
| card activity line | field | `BoardTicket.latestActivity` — replaces the cost line while running |
| "N/M attempts" | field | `BoardTicket.attemptCount` / `.maxAttempts`; omitted at zero |
| "blocked by …" | field | `BoardTicket.blockedBy`, shortened |
| "priced at the fallback rate" | field | `BoardTicket.usedFallbackRate` |
| artefact chip: kind | field | `BoardArtifact.kind` |
| artefact chip: value, kind `file` | field | `BoardArtifact.content`, the resolved path |
| artefact chip: value, any other kind | derived | `BoardArtifact.content.length` + " chars". **The body is never shown** — batch 13's rule. |
| CANCELLED strike-through | field | `BoardTicket.status` |
| list view columns | field | the same fields; `BoardTicket.id` in full |
| list view order | copy | `commands/board.ts`'s own `STATUS_ORDER`, so the page and CLI agree |
| legend | copy | — |

### Pause banner (inside the board region)

| element | kind | source |
|---|---|---|
| shown at all | field | `BoardResult.pauseMessage !== null` |
| heading | derived | from `BoardResult.pauseReason`; "Paused" when the reason is unrecognised |
| body | field | `BoardResult.pauseMessage`, verbatim |
| "Raise cap" form | field | offered only when `pauseReason === 'spend_cap'` — the reason is structured so the page picks the right fix without parsing the message |
| "Resume" button | copy | offered while paused, EXCEPT for a readiness cause — see below |
| readiness fix command | derived | offered only when `pauseReason` is a readiness cause (`missing_workspace_root`, `unsafe_workspace_root`, `missing_scope_path`, `unreadable_scope_file`, `project_not_ready`): the exact command with `<id>` from the selected project — `magarine project set --project <id> --dir <folder>`, except `unreadable_scope_file`, whose fix is repairing the file and then `magarine resume --project <id>`. Rulings 24 and 29 (batch 16) |
| Resume, for a readiness cause | — | DELIBERATELY ABSENT. Ruling 24 makes `project set --dir` the un-pause; resuming without a folder would fail the same check and pause again, so the button would be one that cannot work |

## 4. Needs you

Not an inbox: the moment work reaches a boundary and hands control back.

| element | kind | source |
|---|---|---|
| item set | field | `GET /inbox` — `buildInbox`'s own resolution rules decide what is still pending |
| "N · autonomous work has stopped and handed back" | derived + copy | N is the item count |
| who: tier | derived | tier of the named ticket's model |
| who: event type | field | `InboxItem.eventType`, shown raw rather than prettified |
| ticket id | field | `InboxItem.ticketId`, or `.projectId` for a project-scoped item |
| "12m ago" | derived | now − `InboxItem.createdAt` |
| **Doing** | field | `BoardTicket.latestActivity` of the named ticket; the row is absent when null |
| **Stopped** | field | `InboxItem.message`, **in full, never truncated, clamped or scrolled** |
| the command inside the reason | field | part of `InboxItem.message` — `inbox.ts` appends it |
| **Delivered** | field | the ticket's `artifacts`, same by-kind rule as the board |
| **Then** | copy | fixed text per `InboxItem.eventType` (`WHAT_NEXT` in `app.js`). It describes what the daemon will do. An event type with no entry gets **no line**. |
| action buttons | copy | fixed per `eventType` (`ACTIONS`), each posting an existing route. An event type with no entry gets **no button** — rule 7's converse. |
| empty | copy | "nothing is waiting on you" |

## 5. Scope

| element | kind | source |
|---|---|---|
| scope text | field | `GET /projects/{id}/scope` → `scopeText` |
| when empty | copy | three sentences, because the page can now tell them apart (ruling 29): `status: 'absent'` → "(this project has no scope file yet)"; present but empty → "(the scope file is empty)"; a **400** from the route → "(this project’s scope file exists but could not be read: <the daemon’s error>)". A 400 is caught on this one read only, so it neither blanks the board nor renders as emptiness; any other failure still fails the refresh. `project list` also carries `scope: { path, status }`, which the page does not need |
| "read-only here" | copy | true: the page has no scope write route |

## 6. Conversation

| element | kind | source |
|---|---|---|
| entries | field | `GET /projects/{id}/conversation` → `ConversationEntry[]`, newest last |
| entry count | derived | length |
| filter tabs | derived | the distinct `ConversationEntry.ticketId` values present, plus "All" |
| speaker | field | `ConversationEntry.kind`; "You" for `owner_message` |
| timestamp | field | `ConversationEntry.createdAt` |
| body | field | `ConversationEntry.text` |
| left rule colour | field | `ConversationEntry.kind` |
| answer box on a question | field | shown only when `kind === 'question'` and `answered !== true` |
| composer | copy | posts `POST /projects/{id}/discuss` |

## 7. Activity

| element | kind | source |
|---|---|---|
| events | field | `GET /activity?project=` → `EventRow[]`, which excludes `visibility === 'internal'` |
| time | field | `EventRow.createdAt` |
| event type | field | `EventRow.eventType`, raw |
| entity | field | `EventRow.entityId`, shortened |
| tone (bad / attention / good) | copy | a fixed map over event type in `app.js`; an unmapped type gets no tone |
| header timestamp | field | the newest event's `createdAt` |
| empty | copy | "no events recorded for this project" |
| legend: worker_progress is absent | copy | true by construction: those rows are `internal`, so `/activity` never returns them |

### The live/polling word, and the notices

| element | kind | source |
|---|---|---|
| `live` | derived | set only after bytes arrive on an open `GET /events` stream |
| `polling` | derived | the default, and the state it returns to the instant a stream ends |
| stream notice | copy | "the event stream is not connected, so this page is polling every 4 seconds and is not live", plus the failure reason |
| font notice | copy | "interface font did not load, run magarine doctor", from `document.fonts.check` |
| coverage notice | copy | "some text is outside the bundled font's coverage and is shown in a system font", from `ui/fontCoverage.js` over every string in this table marked **field** |
| daemon notice | copy | "the daemon did not answer", plus the status and route |
| token gate | copy | shown until the daemon accepts a token. No data exists before then and none is invented. |

## 8. The organism

`ui/organism.js`, the single copy (ruling 11). The daemon serves it byte-identical
and `docs/design/pass3/check-organism.js` reads that same file.

| channel | source |
|---|---|
| **shape (identity)** | `organism(seed)` where seed is `BoardTicket.model`, or `ProjectListEntry.defaultModel` when the ticket's is null. Tier = family + symmetry. |
| **colour (status)** | `BoardTicket.status`, via `[data-status]` in `tokens.css` |
| **motion (activity)** | fires ONCE on a `worker_progress` event from the stream, in the state **the daemon mapped** (`payload.state`). The tool-to-state map is the daemon's and is not duplicated on the page. |

**Density is a weight, not a signal**, and nothing here calls it one
(`docs/strategy/batch-14-addendum-3-ruling-9-amended.md` section 2).

The six activity states are all real and all sourced — reading, writing,
running, **testing**, finishing, reporting (ruling 14). The page draws all six.

## 9. OMITTED, NOT MOCKED

Pass 3 drew each of these. Nothing in the daemon produces them, so the page does
not draw them. **This list is the deliverable, not a caveat.**

| pass 3 element | why it is not here |
|---|---|
| **"Simulate event" button** | It existed only in the mock screens. The organisms tick when a real event lands or not at all. |
| **Notification bell (`bell · 16`)** | An OS notification needs the window host; no field, no route. |
| **The Manager as a standing agent (`mgr`)** | There is no agent entity. A Manager run is a ticket with `kind: 'manager'`, and it appears on the board as one. |
| **Idle agents in the fleet** | No roster exists. Only running tickets can be listed, so only they are. |
| **Per-agent names ("Haiku", "Opus" as individuals)** | The daemon has no agent name. The page shows the model tier, which is what it actually has. |
| **"idle · last assessed 08:42"** | Nothing records when an agent last did anything outside its ticket's events. |
| **`planning` and `reviewing` activity states** | Nothing emits them. Still open; still undrawn. |
| **Progress percentages** | Nothing measures completion. This is rule 8's original example. |
| **`aria-current` on a nav link** | Nothing tracks a "current" view now that every region is always present. |

## 10. Shipped font subsets

The `@font-face` blocks in `ui/tokens.css` and the ranges in
`ui/fontCoverage.js` are the same constants, and `src/ui/fonts.test.ts` fails if
they disagree.

| family | file | subset | ranges |
|---|---|---|---|
| JetBrains Mono | `ui/JetBrainsMono.woff2` | latin | 27 ranges, `U+0020-007E` through `U+FEFF` |
| Magarine Sans (IBM Plex Sans) | `ui/IBMPlexSans.woff2` | latin | the same 27 |

The ranges are the **measured intersection of the two files' own cmap tables**,
read out of the woff2 by the test — not a published subset constant.
Over-declaring a range causes exactly the silent fallback the coverage notice
exists to announce; under-declaring is safe.

Latin only, by the owner's ruling. The trigger for wide subsets, in its own
words: *ship the wide subsets when Magarine has a user who is not the owner.*
Adding one is a font file, a licence, one `@font-face` block with its range, one
entry in `fontCoverage.js` and one `doctor` asset line — not a redesign.

Licences: `packages/core/licenses/JetBrainsMono-OFL.txt` and
`IBMPlexSans-OFL.txt`, both SIL OFL 1.1.

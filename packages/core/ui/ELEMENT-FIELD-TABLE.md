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

**PROHIBITED ON THIS PAGE: a Web Notification (`new Notification`) and a
`beforeunload` handler.** Batch 17 ruling 30, amended
(`docs/strategy/batch-17-addendum-1-ruling-30-amended.md`). The window host
(`magarine app`) lives exactly as long as the browser window it spawned, and
both of these break that. Measured in the batch 17 spike: clicking a Chromium
toast cannot focus the app window (Windows launches a NEW browser on the
owner's default profile and the page's `onclick` never fires), and while a
Web Notification is live Edge ignores a graceful window close entirely — the
process stayed alive past 60 seconds. The owner's Needs You signal reaches
them from the host as an operating-system toast instead, and from this page as
the `(N)` in the window title (see the document title row). Do not reintroduce
either; `src/ui/page.test.ts` fails if a shipped page file names them.

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
| `GET /profiles` | `src/daemonApi.ts` → every non-retired `WorkerProfile` plus `status` (`working`/`idle`) and `ticketId`. Batch 19 |
| `POST /profiles` | `src/daemonApi.ts` → the created `WorkerProfile`; **400** with `{ error }` when refused. Batch 19 |
| `POST /profiles/{id}/retire` | `src/daemonApi.ts` → the retired `WorkerProfile`. Batch 19 |
| `GET /models` | `src/daemonApi.ts` → `pricing.ts`'s `knownModelIds()`, the models a profile may use. Batch 19, ruling 38 amended |
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

## 2. Fleet — the roster

**Ruling 38 (batch 19).** The region keeps its id `#fleet`; its heading reads
**Roster**. One row per non-retired profile from `GET /profiles`, in the order
the daemon returns them, then the Manager's row while a Manager turn is
running, then — under one copy line — any running ticket that has no profile.
There is **no percentage and no completion bar**: nothing measures completion.

| element | kind | source |
|---|---|---|
| heading "Roster" | copy | — |
| roster count | derived | `GET /profiles` length, "N profiles". Counts profiles, not tickets |
| slots line | field | `BoardResult.slots.used` / `.cap`, unchanged |
| profile row: organism shape | derived | `organism.js`'s `organism('mg.v1:' + WorkerProfile.id, WorkerProfile.model)`: the cell draw hashes the profile id, family and symmetry come from the model's tier. Renaming does not change it; a model in another tier does |
| profile row: organism colour | field | the running ticket's `BoardTicket.status` when the profile is `working` on a ticket in this project's board; none otherwise |
| profile row: name | field | `WorkerProfile.name` |
| profile row: model | field | `WorkerProfile.model` |
| profile row: purpose | field | `WorkerProfile.purpose` |
| profile row: "idle" | field | `status === 'idle'` |
| profile row: "working · <title>" | field | `status === 'working'`; the title is `BoardTicket.title` of the ticket `ticketId` names. When that ticket is not on this project's board, the full `ticketId` is shown instead of a title |
| profile row: activity line | field | `BoardTicket.latestActivity` of that ticket, on a working row whose ticket is on this project's board; "no progress event recorded yet" when that field is null. An idle row has no activity line, and neither does a working row whose ticket belongs to another project: this page reads only its own project's board, so it has no activity to show |
| profile row: "Retire" | copy | posts `POST /profiles/{id}/retire` after a confirm step |
| retire confirm: "Retire <name>? This cannot be undone from this page." | derived + copy | the name is `WorkerProfile.name`; offers "Keep" first, then "Retire", so focus carried from the first press lands on Keep |
| retire error | field | the daemon's own `error` sentence, verbatim |
| Manager row | field | a `BoardTicket` with `kind === 'manager'` and `status === 'IN_PROGRESS'`: "Manager" or "Manager (automatic)", its model, the batch 18 line and the activity line. Organism seeded `mg.v1:manager` with the Manager ticket's model for the tier |
| "Running, not on the roster" | copy | one line heading the running work tickets the roster does not cover: no profile, or a profile retired since the ticket started. Absent when there are none |
| not-on-roster row: name | derived | `BoardTicket.profile.name` for a retired profile; otherwise the tier, from `organism.js`'s `tierOf(model)` |
| profile-less row: model | field | `BoardTicket.model`, or `ProjectListEntry.defaultModel` when null |
| profile-less row: model when both are absent | copy | "tickets.model is null and the project has no default" |
| profile-less row: organism | derived | seeded by the model id, as before batch 19 |
| empty roster | copy | "no profiles — add one below"; shown only when `GET /profiles` is empty |
| roster read failure | field | the daemon's `error` sentence from `GET /profiles`, verbatim, in the list's place |
| roster with no project | field | `GET /profiles` is read on every pass whether or not `GET /projects` returned anything: profiles are global, not per project |

### Add a profile (inside the roster)

| element | kind | source |
|---|---|---|
| "Add a profile" heading | copy | — |
| name, purpose, policy inputs | copy | labels only; the values are what the owner types |
| model select | field | `GET /models`, in the daemon's order. No model is offered that the daemon does not know. Read whether or not a project exists: the roster is global |
| model list read failure | field | the daemon's own `error` sentence from `GET /models`, verbatim, under the empty select; asked again on the next pass |
| "Add" button | copy | posts `POST /profiles` with `name`, `model`, `purpose`, and `policy` when it is not empty |
| error line | field | the daemon's own `error` sentence from the 400, verbatim — never reworded |
| after success | — | the inputs clear and the roster re-reads `GET /profiles`; the new row is the daemon's, not an optimistic one |

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
| card organism | derived | as section 2. A ticket with a profile is seeded `mg.v1:<BoardTicket.profile.id>` with that profile's `model` from `GET /profiles`; a retired profile is not in that list, so its tickets' organisms fall back to tier "unknown" rather than a guessed model |
| card profile name | field | `BoardTicket.profile.name`, beside the organism; absent when `profile` is null. A retired profile's name still shows (the board looks it up fresh) |
| card "Why this profile: …" | field | `BoardTicket.profileReason`, verbatim; absent when null |
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
| Manager turn's tag | field | `BoardTicket.kind` is `manager`: the id line reads "Manager · <id>"; when `BoardTicket.automatic` is true it reads "Manager · automatic · <id>" and the card carries `data-automatic`. Batch 18 ruling 34 |
| **"Being verified"** (card line, and the list's status cell) | field | `BoardTicket.status === 'REVIEW'` on a work ticket. Ruling 31: a worker's done enters REVIEW while a verifier run checks it, so REVIEW is exactly that state. The owner's own `approve`/`reject` remain available from Needs you; the line claims only what the status says |
| **"Manager is checking progress on its own"** | field | `BoardTicket.kind === 'manager'`, `.status === 'IN_PROGRESS'` and `.automatic === true` (the scheduler made this turn when the board drained). Also on the fleet row |
| **"Manager is working on what you asked"** | field | `BoardTicket.kind === 'manager'`, `.status === 'IN_PROGRESS'` and `.automatic === false`. Deliberately says nothing more specific: the daemon does not record whether the turn is a plan or a reply |
| a Manager turn WAITING for a slot | — | DELIBERATELY ABSENT. Ruling 33: a Manager turn is not a worker slot, so that state cannot occur, and a line describing it would be untrue |
| **"Rejected: …"** (card, ticket not DONE and not FAILED) | derived | the newest `EventRow` of type `review_rejected` for this ticket (`entityId === BoardTicket.id`) in `GET /activity`, its `payload.reason` verbatim, unless a `review_approved` for the same ticket came after it. `reason` is the verifier's failed criteria and their evidence (ruling 31), or the owner's own words when the owner rejected. Never truncated; omitted when `payload.reason` is not a string |
| **"Stopped: …"** (card, status FAILED) | field | `BoardTicket.lastFailureReason`, verbatim. After a verifier rejection with no attempts left it carries the verdict (`rejected: <reason>`) |
| **"Scope met"** (Manager card, and one line above the board) | derived | **There is no `scopeMet` field.** On a card: `BoardTicket.automatic` is true, `.status === 'DONE'`, and the `manager_proposal_applied` `EventRow` for that ticket (`entityId === BoardTicket.id`, from `GET /activity`) has `payload.commands` an empty array. The rationale is shown after it, verbatim from `payload.rationale`. The board line appears only while the newest `manager_proposal_applied` event in the project is such a turn and no work ticket is OPEN, READY, IN_PROGRESS, REVIEW or BLOCKED — so it disappears the moment the Manager or the owner starts more work |
| board status line (scope met) | derived | see "Scope met" above. Hidden otherwise |
| empty board | copy | "No tickets yet. Open the Manager tab ..." shown only while `BoardResult.tickets` is empty |
| cost note | copy | the equivalent-API-cost sentence, once, under the board |

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
| who: profile name | field | `BoardTicket.profile.name` of the named ticket, in place of the tier, when it has a profile. Its organism is the profile's, as on the board. Batch 19 |
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
| scope collapsed strip: preview | derived | the first non-empty line of `scopeText`, leading `#` marks removed. Shown only while the scope is collapsed. |
| Show scope / Hide scope | copy | a page-local toggle. Collapsed by default; not remembered between visits (persisted layout is a later batch). |
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
| event type | field | `EventRow.eventType` through the page's copy map; a name with no entry is shown raw, and a mapped one keeps the raw name as its tooltip |
| entity | field | `EventRow.entityId`, shortened |
| tone (bad / attention / good) | copy | a fixed map over event type in `app.js`; an unmapped type gets no tone |
| header timestamp | field | the newest event's `createdAt` |
| empty | copy | "no events recorded for this project" |

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
| launch link message | copy | shown at the gate when `POST /launch-code/exchange` refuses a `#launch=<code>` load: "this launch link has expired -- run `magarine app` again, or `magarine token` and paste it here" (ruling 30 item 4). A daemon that does not answer at all says so instead. The code is consumed before the view router reads the hash and replaced with `#board`, so it never sits in the address. Batch 17 |

## 8. The organism

`ui/organism.js`, the single copy (ruling 11). The daemon serves it byte-identical
and `docs/design/pass3/check-organism.js` reads that same file.

| channel | source |
|---|---|
| **shape (identity)** | `organism(seed)` where seed is `BoardTicket.model`, or `ProjectListEntry.defaultModel` when the ticket's is null. Tier = family + symmetry. A profile is `organism('mg.v1:' + id, model)`: the id gives the cell draw, the model gives the tier (batch 16 addendum 1, ruling 38 amended). The Manager's roster row is `organism('mg.v1:manager', model)`. |
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
| **The Manager as a standing agent (`mgr`)** | The Manager is not a profile (batch 16 addendum 1). A Manager run is a ticket with `kind: 'manager'`: it appears on the board as one, and on the roster only while it is running. |
| ~~Idle agents in the fleet~~ | **Drawn since batch 19**: `GET /profiles` is a real roster with a derived `idle` status. See section 2. |
| ~~Per-agent names~~ | **Drawn since batch 19**: `WorkerProfile.name`. A ticket with no profile is still named by its tier. |
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
| JetBrains Mono | `ui/JetBrainsMono.woff2` | latin + symbols (ruling 35) | 43 ranges, `U+0020-007E` through `U+FEFF`; arrows U+2190-2199 and U+2713 included, re-subset command in `licenses/FONT-SUBSETTING.md` |
| Magarine Sans (IBM Plex Sans) | `ui/IBMPlexSans.woff2` | latin + symbols | the same 43 |

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

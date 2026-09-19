# Batch 15 - the acceptance walk

> # BATCH 15 IS CLOSED. Its own closing condition was run, not assumed.
>
> Every Role A acceptance item, ruling 18's live-stream animation, spec line 82's small real
> run, rulings 20-23 from the owner's walk, the lead's re-run of the walk from step one, and
> **the owner's own re-run** are done. The owner's words: *"the demo run was perfect."*
>
> **The ticket the batch turned on:** their `index.md`, which was delivered and failed four
> times on a raw string comparison, is `DONE` -- succeeded 2026-09-19 10:54:36 after ruling 21
> landed, with the file recorded as its artefact. Read from their database, not taken from the
> report.

Orchestrator. Started 2026-09-16. Authority: `docs/strategy/batch-15-spec.md`
line 68 (Role A acceptance) and line 82 (Role B acceptance and the closing
condition), plus `batch-15-addendum-6-organism-live-path.md` section 3.

Shape follows `docs/evidence/batch-11-walk/`, `batch-12-walk/` and
`batch-13-walk/`, which each recorded the hand-driven acceptance for their
batch. The absence of this directory until now is what revealed that batch 15's
runtime acceptance had never been run: three consecutive batches established the
pattern, so its absence was evidence rather than an oversight in recording.

---

## Item 1 - `pnpm test` green -- SATISFIED

`pnpm test`, **from `packages/core`**. Result: **683 pass, 0 fail**, ~51s.

Baseline 683/0 on a clean tree at `bcdf042`, before this session's work.
**Closing number: 704 pass, 0 fail**, run by the lead on the still tree carrying every
code change of batch 15 (at `a69f0e2`); only documentation has changed since.

**On the command.** An earlier reading of mine held that `pnpm test` was not
runnable in this repository. That was wrong, and the correction matters because
it changes whether this item was run *as written*. `pnpm run` in `packages/core`
lists `test` with body `node --test` (pnpm 10.33.0), and
`packages/core/README.md` lines 21-24 document it. So `cd packages/core && node
--test` is **the literal body of the script, not a substitute**, and the 683/0
satisfies this item as written. What is true is the narrower claim: the command
does not exist at the **repository root** -- no root `package.json`, no workspace
file, no lockfile. Every acceptance line since batch 10 has meant "from
`packages/core`". Spec line 68 now says so.

---

## Item 5 - the single write site for ticket status is still exactly one -- SATISFIED

**`stateMachine.ts:384` is the only statement that writes `status`.**

Recorded at the Strategist's request, because a grep cannot see this and the
reasoning should be an artefact rather than a chat message:

**A grep for `status` would NOT have settled this item.** `store.ts:512` issues a
prepared `UPDATE tickets SET ${sets.join(', ')} WHERE id = ?` -- dynamic SQL
whose column list is interpolated at runtime and therefore invisible to a search
for the column name. A second status write site could have lived behind it.

It does not. Reading `store.ts:470-512`: `sets` is a **closed allow-list of
hardcoded column literals** -- `title`, `description`, `acceptance_criteria_json`,
`max_budget_usd_override`, `model`, `model_reason`, `expected_artifacts_json`,
and `updated_at` -- each pushed under its own `!== undefined` check against a
typed field. **No status path exists, and no caller-supplied key ever reaches the
SET clause.**

So the invariant holds **structurally**, not merely by the convention that
`proposal.ts` refuses `status` on `update_ticket`. That is a stronger result than
the acceptance item asked for: a validator can be bypassed by a new caller, a
closed literal allow-list cannot.

---

## Item 2 - every route driven by hand, daemon running, output pasted -- SATISFIED

Driven 2026-09-16 against a real `magarine serve` (fake adapter, its own temp state dir)
by a script that aborts if the daemon's token appears in any response; it did not. The
inventory was taken from `daemonApi.ts`, not from the README -- whose route table was
found, while preparing this, to omit three of batch 15's routes (fixed at `cad05e5`).

| status | method | route | content-type | case |
|---|---|---|---|---|
| 200 | GET | `/` | text/html | page, no token |
| 200 | GET | `/health` | application/json | health |
| 401 | GET | `/health` | application/json | health, wrong token |
| 200 | GET | `/projects` | application/json | projects |
| 200 | GET | `/board?project={project}` | application/json | board |
| 200 | GET | `/inbox?project={project}` | application/json | inbox |
| 200 | GET | `/activity?project={project}` | application/json | activity |
| 200 | GET | `/projects/{project}/scope` | application/json | scope |
| 200 | GET | `/projects/{project}/conversation` | application/json | conversation |
| 404 | GET | `/projects/proj_nope/conversation` | application/json | conversation, unknown project |
| 200 | GET | `/tickets/{ticket}/progress` | application/json | progress, live ticket |
| 404 | GET | `/tickets/tkt_nope/progress` | application/json | progress, unknown ticket |
| 200 | GET | `/ui/tokens.css` | text/css | asset, no token |
| 200 | GET | `/ui/IBMPlexSans.woff2` | font/woff2 | asset, font |
| 400 | GET | `/ui/..%2Fpackage.json` | application/json | asset, encoded traversal |
| 404 | GET | `/ui/nope.txt` | application/json | asset, unknown |
| 401 | GET | `/events` | application/json | events, wrong token |
| 401 | POST | `/tick` | application/json | tick, wrong token |
| 201 | POST | `/tickets` | application/json | ticket, no expectedArtifacts |
| 201 | POST | `/tickets` | application/json | ticket, one file expected |
| 400 | POST | `/tickets` | application/json | ticket, [] refused |
| 400 | POST | `/tickets` | application/json | ticket, unknown kind refused |
| 200 | POST | `/deps` | application/json | deps |
| 200 | POST | `/tickets/{ticket}/decide` | application/json | decide |
| 200 | POST | `/tickets/{ticket}/retry` | application/json | retry |
| 400 | POST | `/tickets/{ticket}/approve` | application/json | approve, ticket not in review |
| 400 | POST | `/tickets/{ticket}/reject` | application/json | reject, ticket not in review |
| 200 | POST | `/tickets/{ticket}/cancel` | application/json | cancel, live run |
| 409 | POST | `/tickets/{ticket}/cancel` | application/json | cancel, no live run |
| 200 | POST | `/projects/{project}/set` | application/json | project set |
| 400 | POST | `/projects/{project}/resume` | application/json | project resume, not paused |
| 201 | POST | `/projects/{project}/plan` | application/json | project plan (fake adapter) |
| 200 | POST | `/tick` | application/json | tick |

The refusals, verbatim (ids replaced):

- health, wrong token: `{"error":"unauthorized"}`
- conversation, unknown project: `{"error":"no such project: proj_nope"}`
- progress, unknown ticket: `{"error":"no such ticket: tkt_nope"}`
- asset, encoded traversal: `{"error":"invalid asset name: ..%2Fpackage.json"}`
- asset, unknown: `{"error":"not found: nope.txt"}`
- events, wrong token: `{"error":"unauthorized"}`
- tick, wrong token: `{"error":"unauthorized"}`
- ticket, [] refused: `{"error":"expectedArtifacts must be omitted or non-empty"}`
- ticket, unknown kind refused: `{"error":"ticket.expected_artifacts[1].kind \"nonsense\" is not one of file, text, url, reference, manager_reply, manager_assessment"}`
- approve, ticket not in review: `{"error":"ticket {ticket} is DONE, not REVIEW; there is nothing to approve"}`
- reject, ticket not in review: `{"error":"ticket {ticket} is DONE, not REVIEW; there is nothing to reject"}`
- cancel, no live run: `{"error":"ticket {ticket} is not currently running on this daemon; nothing to cancel"}`
- project resume, not paused: `{"error":"project {project} is not paused; nothing to resume"}`

Ticket created with no `expectedArtifacts` stored `null`, not `[]`.

**Limits, stated rather than papered over:**
- **approve and reject were driven only to their refusal** *in this walk*. The refusal is
  real and legible ("is DONE, not REVIEW"). **CORRECTED 2026-09-19:** calling this a harness
  gap was wrong. `--fake-outcome review` has existed since batch 5 (`cli.ts`'s
  `FAKE_OUTCOME_KINDS.review`), and `commands.test.ts` 1139 and 1177 drive approve to DONE and
  reject to READY end to end through a real tick. Only the `--fake-script` SPELLING lacks the
  kind. The Invariants Engineer caught it when batch 16 handed them my rationale; the real
  harness gap is the progress BURST, which stands.
- **plan was driven with the fake adapter only**, so no real money was spent.
- **Small wording defect found:** an unknown kind on `POST /tickets` names the field
  `ticket.expected_artifacts[1].kind` -- the Manager's snake_case -- while this route's
  caller sent `expectedArtifacts`. From reusing the Manager's validator as ruled.
  Cosmetic; carried to batch 16.

## Item 3 - the stream delivers a fake-adapter progress event end to end, and closes when the daemon stops -- SATISFIED, one half by test on this platform

**Replay.** `GET /events?since=54` -> 200 `text/event-stream`. First frame:
`id: 55`, `event: worker_progress`, data `{sequence: 55, eventType: worker_progress,
entityType: run, state: reporting, visibility: internal}` -- the fake adapter's progress
event, delivered despite being internal, because the stream's filter admits
`worker_progress` by name. `id` equals `sequence` and `event` equals `eventType`, as the
contract fixed. Internal non-progress events (59, 61, 64) were correctly absent.

**Live.** Connected with `since` = the latest sequence at connect time (77). Then
`POST /tickets` -> 201 (+1522 ms; creating a ticket writes no event, so no frame --
correct) and `POST /tick` -> 200 (+2762 ms); frame `id: 80`, `dependencies_resolved`,
arrived in that same millisecond. The page run under ruling 18 below independently
shows a live `worker_progress` frame reaching the page 82 ms after the event.

**Daemon stops.** With the client connected, the daemon was stopped; the client saw the
connection end with `ECONNRESET` about a second later.

**The limit.** On Windows a separate process can only hard-kill `serve` -- the daemon
file reports `shutdownMode: hard-kill-only`, HARD-verified on this machine in batch 9
(`daemon.ts` 15-24) -- so a reset is what "the daemon stops" looks like from outside here.
The *graceful* path, where `serve` calls `closeAllStreams()` and every consumer's loop
returns cleanly, runs only on a real Ctrl+C in the daemon's own console. It is covered by
`daemonApi.test.ts:693`, in-process, and was not driven by this walk.

**Also found and then withdrawn, recorded because it looked like a defect:** an earlier
connection with `since=999999` received no live frames at all. That was the test, not
the daemon -- `since` is an exclusive lower bound and applies to live events too.

## Item 4 - a fake-adapter run where a ticket declares a file it does not produce reaches the retryable class with the artefact named -- SATISFIED

A ticket created **by hand**, `ticket add --expected-artifact out.md --max-attempts 1`,
run under the fake adapter's default success (which declares no `out.md`). On the board:
status `FAILED`, attempts 1, reason
`expected artefact(s) not produced: out.md -- magarine retry --ticket {ticket}, once the reason above is addressed`.
The failure is the retryable `malformed_result` class (scheduler.ts); `--max-attempts 1`
exhausts it in one attempt because only a FAILED ticket's reason reaches the board --
a retryable failure is activity-only (`policy.ts:84`). Before rulings 16 and 17 in this
batch, a hand-made ticket could not carry the expectation at all.

## Closing-condition addition from ruling 18 - one live-stream animation observed -- SATISFIED

Observed 2026-09-16 on the real page, served by a real `magarine serve` (fake adapter),
in headless Chrome driven over the DevTools protocol, with a MutationObserver installed
before any page script ran.

**Setup, so the event could only arrive while the page was watching.** A project with
one worker slot: a `hang` ticket at priority 10 holding the slot, and a `progress`
ticket at priority 0 waiting `READY` behind it. Checked on `/board` before the page
opened: `IN_PROGRESS holds the only slot`, `READY progress after the page is live`,
`latestActivity: null`.

**The run.** Page loaded, project selected, stream live (`data-live="stream"` at
-2752 ms). `POST /tickets/{hang}/cancel` -> 200, then `POST /tick` -> 200 at t=0.

| ms after the tick | what the page did |
|---|---|
| +81 | `refresh()` group (`/board`, `/inbox`, `/activity`, scope, conversation) -- a non-progress stream event |
| +82 | **a `/board` read on its own** -- `refreshBoardOnly()`, which only a `worker_progress` frame calls |
| **+89** | **the progress ticket's organism animates, `data-tick="reporting"`** -- the daemon's own mapped state |
| +93, +1222 | `data-tick` re-written on the replacement nodes -- `resumeMotion`, inside `MOTION_MS` (1600) |
| +5206 | the first 4-second poll -- nothing animates |

**From the stream, not the poll:** the animation landed 89 ms after the event; the poll
did not run until 5206 ms. **Once, not a loop:** the board's `latestActivity.sequence`
stayed 55 -- one progress event -- so `syncMotion`'s comparison cannot fire a second
pass; the later writes fall inside the resume window, and nothing was written after
it. The observer counts attribute writes and cannot by itself tell a tick from a
resume; the sequence and the window are what settle it.

**Three errors of mine, found on the way, recorded because each looked like a page
defect first:**
1. The first run showed 0 cards and a polling page: my driver re-navigated to the same
   URL, a same-document no-op, so the page never reloaded with the token.
2. Two runs then showed the page *never* animating the new ticket. It had -- **before**
   my tick: `daemon.ts:270` runs `void runOneTick()` at startup, and I had concluded
   from a grep that only matched `setInterval` that nothing runs until the interval.
   The page correctly animated the first observed event on load; there was no second
   event to see. Hence the one-slot setup above.
3. Two probe failures were escaping bugs in the injected script, one of which made
   `evaluate` return `undefined` silently -- now surfaced as an exception, since an
   observer that fails quietly is the exact failure this walk exists to refuse.

Nothing on the page was changed to get this result.

---

## Spec line 82 - one small real run, a single ticket, watched on the page -- SATISFIED

Permitted by the owner in the message that approved pass 3 (`batch-15-addendum-2` line 8,
"The small real run is permitted"; addendum 7 section 1). Run 2026-09-16 on the real
`claude` adapter (CLI 2.1.273, `doctor` all PASS), in its own state directory, project
capped at $1.00 and the ticket at $0.50.

**The ticket**, created through `POST /tickets` while the page was already live on the
stream: "Create a file named hello.md in the working directory containing exactly one
short sentence saying hello. Do nothing else." Model `claude-haiku-4-5-20251001`,
`expectedArtifacts: [{kind: file, path: hello.md}]`.

**The result:** `DONE` about 20 s after the tick. **Equivalent cost $0.0758, measured, not
an estimate.** One artefact, `hello.md`, reading `Hello, world!` (13 bytes), verified
against the declared expectation. 19 `worker_progress` events.

**On the page:** the stream stayed live throughout. The organism animated as the board's
`latestActivity.sequence` advanced -- 14 distinct advances, from 3 to 21, each producing
one pass; 9 further `data-tick` writes were all at an unchanged sequence inside the
1600 ms window, which is `resumeMotion` re-arming across re-renders, not a replay. After
the last event it **settled**: no `data-tick`, no running animation, status `DONE`.

**A finding only a real run could produce -- the state channel is almost always
`reporting`.** The daemon classified correctly: `writing` at sequences 12 and 14 (tool
`Write`), `finishing` at 20 (`StructuredOutput`). The page never showed any of them. Each
tool call is followed within milliseconds by a `tool result received` event classified
`reporting`, and `latestActivity` publishes only the newest event, so by the time a frame
causes a board read the informative state is already superseded: the board reads saw
10, 11, 13, 15, 16, 18, 19, 21 and never 12, 14 or 20. Every one of the 23 ticks animated
`reporting`. Nothing is invented, so rule 8 holds; but on a real run one of the
organism's three channels is close to silent. It is the price of ruling 18's "read the
board's marker" design, which the fake adapter -- one event per script -- could never
show. Put to the Strategist; not changed here.

## The walk re-run from step one, by the lead, after rulings 20-23 -- PASSES

Addendum 10's closing condition: the walk re-run from step one by the Orchestrator, then
by the owner. Run 2026-09-19 against the committed tree, following `README.md`'s own
steps rather than memory of them (rule 22).

One deliberate deviation, stated because it is the only departure from a literal
first-time run: a temp `--state-dir`, so nothing is added to the owner's live `~/.magarine`
while their own daemon is running. Everything else is the README verbatim.

| step | what the README says | what happened |
|---|---|---|
| 1 | make a folder and stand inside it | done; the step now also says the folder is the boundary a task's assistant may write inside |
| 2 | `project create --name ... --max-parallel 4 --brief ...` | `Created project proj_3ac878f6... (My First Project) in <the folder>` -- it names the folder it will use |
| 3 | `serve --adapter claude --max-parallel 4` | `magarine daemon listening on 127.0.0.1:52634 (pid 42428) -- page: http://127.0.0.1:52634/ -- token: run ``magarine token`` -- up to 4 workers at once (--max-parallel)` |
| 4 | `magarine token` | `token copied to the clipboard; paste it into the page at http://127.0.0.1:52634/` |
| 5 | paste it into the page | gate accepted it, hid itself, and cleared the box |

**The clipboard really carries the token**, checked without printing either value: the
clipboard held 64 characters and its SHA-256 equalled the daemon file's `token` field.
The owner's own clipboard was saved before the run and restored afterwards, byte-identical.

**The page, after settling:** `data-live="stream"`, the project listed by name with its id,
no notices, and zero cards -- correct, since the project has no tickets. Read once too
early it showed `poll` and no projects; that was the measurement, not the product, and the
settled read is the honest one.

The three false promises the owner hit are gone: `serve` now names the page and the
command; `magarine token` exists; the gate names it instead of a token `serve` never
prints.

## The owner's own re-run -- BATCH 15 CLOSES HERE

2026-09-19. The owner restarted `serve`, took the token with `magarine token`, and retried the
ticket that had failed four times. It passed: `DONE`, attempt 4, artefact recorded. Their
verdict on the demo: *"the demo run was perfect."*

**One new fault, found by them on an OLDER project and not a regression.** A Manager run failed
with *"update_scope cannot be applied: this project has no scope_path set yet"*, and a plain
retry then worked. Diagnosed rather than accepted as flaky: that project (created 13 Sept)
predates the rule that every project has a folder, so it has no scope file -- as do three of
their other nine projects. The Manager's instructions offer `update_scope` unconditionally
(`managerEnvelope.ts` 209), the validator refuses it when there is no scope path
(`proposal.ts` 470), and a proposal is accepted or rejected whole, so the run fails. The retry
succeeded only because the Manager happened not to use that command the second time -- the
same project, the same conditions, a coin toss. Put to the Strategist for batch 16, with the
two related legacy-row items already carried.

## Observations raised during the walk -- all ruled, none put to the owner

Recorded here so they reach the owner's walk rather than a chat log. None blocks the
acceptance items above; each is a choice the approved design or a ruling made, now
visible on the real page.

1. **A long Needs-you reason is scrolled out of sight in the rail.** In board and scope
   views, Needs you sits in a 355px rail that is its own scroll container (ruling 15,
   requirement 5), so a long reason is cut at the fold -- and the command that clears
   it (`magarine decide ...`) sits below that fold. It is reachable by scrolling, not
   lost; the Needs-you view shows it whole. But app.js's own comment promises the reason
   is "never truncated, clamped or scrolled away", and in two of three views the last
   part of that promise no longer holds. Seen by the lead in
   `batch-15-page/10-view-scope-light-100.png`. A ruling-15 layout choice meeting the
   page's rule about reasons.
   **Ruled (addendum 7, 2(a)): not a defect.** The brief's rule is about the reason
   *element* -- no clamp, no scroll box of its own; the rail scrolling as a column is the
   approved layout, and the Needs-you view is the approved answer to a long reason. The
   over-claiming comment in app.js is corrected (f2db5e6).
2. **The scope document is capped at `max-height: 19rem` with a fade** in scope view,
   leaving empty space above Conversation in the one view whose purpose is the scope.
   Exactly as drawn in the approved pass 3 design (`docs/design/pass3/tokens.css:502`).
   Raised by the Interface Designer.
   **Ruled (2(b)): keep the cap.** It is how the brief's "never pushes the conversation
   below the fold" holds.
3. **On the token gate, the three view links stay visible and clickable** while every
   region is hidden. Harmless -- nothing changes -- but a user may expect something to.
   Raised by the Interface Designer; same auth-not-views scoping as ruling 15's gate.
   **Ruled (2(c)): no change.** The gate stays above every region in every view, so a
   click changes nothing hidden and nothing silent.

## The finding that makes this walk load-bearing

Batch 15's page tests were green, mutation-verified, and could not see that **the
organism had never once animated from the live stream.**

`skin.test.ts:202-211`, titled *"tick() is called from exactly one place: a
progress event arriving"*, asserted that `tick(` appeared exactly twice inside a
**slice of app.js as a string**. It never executed anything. So it passed whether
or not that branch could fire -- and it could not: progress events carry
`entityType: 'run'`, `entityId: run.id` (`scheduler.ts:615-622`), while every
`data-org-for` on the page is a ticket id (`app.js:413`). The Interface Designer
found it by booting a real daemon and reading a real frame.

Mutation testing had done its job. It confirmed the test discriminates on the
property asserted. **The property asserted was the wrong one.**

The same session produced the same finding from the opposite direction: three of
the five Role A acceptance items above demand runtime evidence, none had any, and
the handover nonetheless read "ROLE A IS COMPLETE" -- true of the code, not of
the acceptance.

**Those tests prove that a file has a shape. Only a run proves that the shape
does anything.** That is the lesson batch 15 pays for, and it is why this
document is a condition of closing rather than a record written afterwards.

# Magarine — Batch 18, re-planned: the loop closes, and work is checked

Author: Strategist. Date: 2026-09-21. Triggered by the owner's walk on their own project, `docs/evidence/batch-17-walk/owner-walk.md` (`8a28aa8`). Replaces the batch 18 shape fixed in `batch-17-addendum-3-strangers-walk-ruling.md` section 4. Tree at `8a28aa8` with `ui/app.js` modified in the working tree (HARD, `git status`: the Designer's typing fix in flight).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

Batch 17 closes. Its closing items passed on the owner's own machine (Ctrl+C observed, "Manager" confirmed). Nothing below reopens it.

## 0. The owner's question, answered straight

They asked: *"the whole workflow doesn't seem correct at all but maybe it is by design because it wasn't built yet, then i would understand."* Both halves are true, and here is which is which. Every line is HARD unless marked.

**Never built. The product did what it was built to do, and that is not yet the job.**

| What they saw | What exists today |
|---|---|
| Placeholder work passed as done; nobody checked it | DONE requires only that the worker declared at least one artefact and that any declared file exists on disk (`scheduler.ts` 716-778). The worker's `checks` array is stored and never run or read. Acceptance criteria are printed into the worker's prompt (`envelope.ts` 26-31) and read by nothing else. The Manager never sees a worker's summary or artefacts; its board line is id, status, kind, title, dependencies, attempts, spend (`managerEnvelope.ts` 21-26, 192-195). The `REVIEW` state exists, but only the worker can choose to enter it and only the owner can approve (`approve.ts`). So there is no second pair of eyes anywhere. The owner's expectation, "it should have checked after itself", was correct and is unbuilt. |
| It did phase 0 and stopped | Nothing re-invokes the Manager when the board drains. `scheduler.ts` and `daemon.ts` contain no call to `planProject` or `discussProject`; the automatic trigger was parked in `route-revision-scope-document.md` section 2. The Manager proposes at most 15 tickets per turn (`proposal.ts` 140), they run, and the daemon idles until the owner types again. |
| A retried worker repeats the same mistake | SOFT, from code: the worker envelope carries brief, decisions, ticket, criteria, completed dependencies, budget and expected artefacts (`scheduler.ts` 92-150). It carries nothing about the previous attempt. Retries are blind. |
| "One worker is running PowerShell, what exactly, is it stuck" | A progress event carries the tool name and a state word only. The command text is dropped in the adapter on purpose (`claudeCli.ts` 361-367: a command line is the likeliest place for a secret). No transcript is stored anywhere (grep for transcript, log path, jsonl across adapter, scheduler, paths: nothing). There is no run drill-down route. |
| Cannot change max-parallel without restarting | The machine cap is a `serve` flag, default 1 (`cli.ts` 1099). The per-project cap is `project set --max-parallel`, CLI only. There is no `PATCH /projects` route (`daemonApi.ts` 314-431 lists every route). |
| Cannot edit the scope from the app | `update_scope` is a Manager command; the page has `GET` scope only. The owner edits the file on disk. |
| Everyone is sonnet, nobody has a role, the Manager does not feel separate | Project default model is `claude-sonnet-5` (`store.ts` 124) and the Manager runs on `manager_model ?? default_model` (`store.ts` 325), so by default the Manager is a sonnet too. The Manager may pick a model per ticket and is told when to (`managerEnvelope.ts` 239-251), and did not. Worker profiles were designed in `batch-16-addendum-1-worker-profiles-design.md` and never built. |
| One field per question | Several `request_user_decision` commands fold into one BLOCKED transition, one question text, one answer (`managerApply.ts` 174-177). The data model has no shape for N answers yet. |

**Built, and does not work well enough.**

| What they saw | What is wrong |
|---|---|
| Typing in Needs You is wiped every few seconds | Defect. `renderNeeds()` rebuilds on every 4-second poll and nothing preserves focus or drafts (Orchestrator verified; `app.js` 185, 709, 1353). Dispatched to the Designer, in flight. |
| The Manager stopped answering; two follow-ups got nothing | SOFT, the likeliest cause from code: a `discuss` creates a manager-kind ticket that enters the same READY queue as work tickets, ordered by priority then age, and is admitted against the same slot cap as workers (`scheduler.ts` 918-930). With the default cap of 1 and a worker running, the Manager's turn waits behind it and behind every older READY work ticket, and the page says nothing about the wait. A second cause that would look identical: a Manager ticket sitting BLOCKED on a question the owner has not answered, while the daemon runs the next thing. UNKNOWN which, until their data is read. Either way the Manager is built as one more ticket, and the owner needed it to be a supervisor. |
| Arrow and check mark shown in a system font | The notice worked exactly as ruled (Latin only, `batch-15-addendum-owner-answers.md` section 3). The two glyphs are not in the page's own files (grep of `ui/`: none), so they came from Manager or worker text. The ruling was too narrow: models emit arrows, ticks and dashes constantly. |
| "Can I ask the Manager to launch a research worker?" | Yes, today: type it in the Manager tab and it can `create_ticket` for research. Nobody told them. Workers do not talk to each other by design; a dependent ticket receives the dependency's summary and artefacts (`scheduler.ts` 93-118), nothing else. |
| Scope panel height | The taste question is answered: the conversation gets the height. Layout work, page only. |

The honest summary for the owner, one sentence: **Magarine today is a dispatcher with a planner in front of it; the checking, the continuing and the seeing were not built yet, and the one thing that was built for talking to the planner treats the planner as just another worker.**

## 1. What the goal demands, and the order

The owner's goal is to run their real workflow through Magarine and be more efficient than today. Their real workflow is this team's: a planner proposes, workers build, someone verifies every claim against reality, the planner is told what actually happened and re-plans, and a human is asked only when a decision is theirs. HARD from the memory rules this team runs under: "rerun every teammate claim yourself". The product has the planner and the workers and lacks the other three.

Ordered against that goal, not against the batch plan we had:

1. **Work is verified before it is called done, and a retry knows why it was rejected.** Without this every other feature decorates placeholders.
2. **The Manager is told what happened and continues on its own until the scope is met or it needs the owner.** This is "only phase 0", fixed.
3. **The Manager never queues behind a worker.** The stall, whatever its exact cause, cannot recur if a Manager turn is not a worker slot.
4. Then identity (profiles, the Manager on its own tier), then seeing (drill-down), then steering from the app (max-parallel, scope, per-question answers, project creation), then layout.

The old batch 18 (project creation in the window, developer prose, the two one-liners) is polish on a workflow that does not produce work. Project creation slides to batch 20 with the other in-app controls; the owner was told it was first, and they are told now why it moved, in their own words. The developer-prose deletion stays in this batch only because it is page work the Designer can do while the daemon half is built, and it costs one brief whenever it is sent.

**Does this plan depend on reading the owner's `~/.magarine`?** No. Items 1 to 3 are right whatever their logs say. The diagnosis of the stall does depend on it: if the data shows the daily cap, a crash, or a BLOCKED question rather than the slot queue, item 3 gains a line, not a redesign. The external review report is wanted for one thing: to see what "3 High" looked like, so the verifier's prompt is calibrated against real defects rather than my guess.

## 2. Rulings

### Ruling 31 — a work ticket is DONE when a second run says so, not when the first one does

- A worker's `done` on a work ticket no longer lands on DONE. After the existing checks (schema, at least one artefact, declared files exist, expected artefacts declared), the ticket enters **REVIEW**, the state that already exists with exactly the two transitions needed: `review_approved` (REVIEW to DONE) and `review_rejected` (REVIEW to READY, consumes one attempt, payload `{ reason }`) (HARD, `stateMachine.ts` 127-140). No new status. The single write site for status is untouched.
- On REVIEW the scheduler spawns a **verifier run** on the same ticket: a run row with `kind: 'verify'` (runs gain a kind column; work and manager runs are `'work'`, migration with an upgrade test). It runs in the ticket's own directory in DIRECTORY mode, or on the captured artefacts directory in NONE mode. Its envelope: title, description, acceptance criteria, expected artefacts, the worker's summary and declared artefact list, and nothing else. Its instructions: read, run tests and commands, do not edit any file; return a verdict per criterion with evidence that names a file and line or a command and its output; a criterion with no evidence is `fail`. Not enforced by tooling (the batch 1 spike proved `--allowedTools` is not a boundary); stated, and the verifier's own declared file artefacts are rejected as a malformed result so it cannot pass by writing.
- Its result contract, separate from the worker's, passed as `--json-schema`: `{ "verdict": "pass" | "fail", "criteria": [{ "criterion", "verdict", "evidence" }], "notes" }`. `pass` requires every criterion `pass`. A ticket with no acceptance criteria gets one implicit criterion: the description is fulfilled. Placeholder detection is a standing criterion the verifier is always given: any TODO, stub, "implement later", empty function body or fabricated data in a delivered artefact is a `fail` with the line cited.
- `pass` records `review_approved`. `fail` records `review_rejected` with `reason` = the failed criteria and their evidence, verbatim. Attempts are consumed as today; the final failure the Manager already sees (`recentFailures`) therefore carries the verdict.
- The verifier's model is `project.verifier_model ?? project.default_model` (one nullable column, `project create/set --verifier-model`). Its ceiling is the ticket's ceiling; its spend counts on the ticket. Manager-kind tickets are never verified; their output is a proposal the daemon already validates.
- The owner's `approve` and `reject` stay as the human override. A verifier result arriving for a ticket no longer in REVIEW is discarded with an internal event, never applied.
- A worker's own `review` status goes to REVIEW as today and is verified the same way.
- No switch to turn verification off in this batch. If the owner wants it per ticket after using it, that is one flag later.

**Cost, said plainly for the owner:** every work ticket now costs at least two runs. That is the price of "checked after itself", and it is theirs to accept.

### Ruling 32 — a retry is told why the last attempt was rejected

The worker envelope gains `previousAttempt?: { status, reason }` from the ticket's most recent `review_rejected` or `worker_failure` event; `buildWorkerPrompt` renders it as a section before the acceptance criteria: "Previous attempt rejected: ..." A first attempt has no section. Test on the rendered prompt.

### Ruling 33 — a Manager turn is not a worker slot

- `available` counts only work-kind tickets in IN_PROGRESS. A READY manager ticket is started every tick regardless of slots, before any work ticket, with at most one manager run in flight per project (a second READY manager ticket waits for the first; two proposals must not race against one board).
- The daily cap stays at 20 and stays enforced in `tick()`.
- The page shows a manager ticket waiting or running as the Manager, in words, not as a card among the workers (Designer, section 3 Role B). HARD, addendum 3 finding 2 already asked for manager-kind cards to be named; this is that item, kept.

### Ruling 34 — the Manager continues on its own until the scope is met or it needs the owner

- **Trigger.** On a tick where a project has no work ticket in READY, IN_PROGRESS or REVIEW, at least one work ticket has reached DONE or FAILED since the last Manager run finished, and no manager ticket is in READY, IN_PROGRESS or BLOCKED, the scheduler creates a manager ticket titled "Manager: review progress" with no owner message, marked automatic. A work ticket BLOCKED on the owner suspends the trigger; that is Needs You doing its job.
- **What it is told.** Every Manager envelope, automatic or not, gains a section "Since your last run": each work ticket that reached DONE or FAILED since, with its status, the worker's summary, its artefact list, the verifier's verdict (pass, or the failed criteria), attempts and spend. HARD: today the Manager sees none of this. The manager envelope's rule against reading worker results (`managerEnvelope.ts` 21-26) is amended to admit exactly these fields and nothing else: never a transcript, never a worker prompt.
- **What it must do.** Compare what was delivered against the scope document and either propose the next tickets, or return an empty proposal whose rationale states the scope is met, or ask the owner via `request_user_decision`. The framing paragraph says so in those words.
- **Termination, so it cannot loop.** An automatic invocation that returns an empty proposal ends the automatic loop for the project until a work ticket next finishes or the owner writes; two automatic invocations never run without a work-ticket completion between them; the daily cap still applies. The board shows "Manager: scope met" or the question, never silence.
- **Cost, said plainly for the owner:** the Manager will spend turns without them pressing Send, at most 20 a day per project, and only when a batch has actually finished.

### Ruling 35 — the font subset covers what models write

The Latin-only ruling stands for scripts. The subset gains the symbol blocks language models emit in ordinary prose: General Punctuation (U+2000-206F), Arrows (U+2190-21FF), Mathematical Operators (U+2200-22FF), Box Drawing (U+2500-257F), Geometric Shapes (U+25A0-25FF), Dingbats (U+2700-27BF). The woff2 files are re-subset from the official IBM Plex Sans and JetBrains Mono releases, `fontCoverage.js` and `tokens.css` updated together, and the existing test that keeps them in agreement stays the proof. The re-subsetting command is recorded beside the licence.

## 3. Roles for batch 18

No fable role. The trade-offs above are ruled; what remains is implementation.

### Role A — Daemon Engineer (sonnet, high)

Owns `scheduler.ts`, `stateMachine.ts`, `store.ts`, `types.ts`, `envelope.ts`, `managerEnvelope.ts`, `manager.ts`, `managerApply.ts`, `resultContract.ts`, `adapters/claudeCli.ts`, `adapters/fakeAdapter.ts`, `db/`, `cli.ts`, `daemonApi.ts`, `commands/`, and their tests. Does not touch `ui/`.

Delivers, in this order, two or three items per brief:
1. Ruling 31: run kind column and migration; the verifier envelope, prompt and result schema; REVIEW entry on worker done; the verifier spawn on REVIEW; `review_approved` / `review_rejected` from the verdict; `verifier_model` column and flags; the fake adapter gains `verify_pass` and `verify_fail` outcomes so all of it is testable without spend; the discarded-late-verdict path.
2. Ruling 32: `previousAttempt` in the envelope and prompt.
3. Ruling 33: manager tickets outside the worker cap, one in flight per project.
4. Ruling 34: the trigger, the "Since your last run" section, the termination rules, the automatic flag on the ticket and on `GET /board` rows.
5. The two one-liners from the old batch 18 item 3 (`plan` and `discuss` say where the reply lands), because they are in files this role owns and the owner hit exactly that.

Acceptance, every item run by the Orchestrator on a still tree, each with one mutation that fails exactly what it should:
- Fake-adapter end to end: work ticket done → REVIEW → verifier run spawned → `verify_pass` lands DONE; `verify_fail` lands READY with the verdict as the reason and one attempt consumed; at max attempts the final failure carries the verdict; the Manager envelope's failure list shows it.
- The retried worker's rendered prompt contains the verdict text; a first attempt's does not.
- With `--max-parallel 1` and one work ticket IN_PROGRESS, a `discuss` starts a Manager run on the next tick. Two READY manager tickets never run together.
- The board drains → one automatic manager ticket is created; no second one without a completion between; none while a work ticket is BLOCKED; an empty automatic proposal ends the loop; the daily cap still refuses at 20.
- The Manager envelope's "Since your last run" section carries summary, artefacts and verdict for exactly the tickets finished since the last run, proven by reading the rendered brief in a test.
- Ticket status still has exactly one write site. Suite green from `packages/core` with `node --test`.

### Role B — Interface Designer (sonnet, already holding the typing fix)

Owns `packages/core/ui/**`, `src/ui/**`, `ELEMENT-FIELD-TABLE.md`. Does not touch the daemon.

Delivers, after the typing fix lands:
1. Old batch 18 item 2 unchanged (addendum 3 section 4): delete the five legends; the empty-board line; manager-kind tickets named as the Manager in cards and Needs You rows; event and state names through a copy map with raw names shown when unmapped.
2. Ruling 33 and 34 on the page: a Manager turn waiting or running is shown in words ("Manager is reviewing progress", "Manager is waiting for a slot" is no longer possible and must not be written); a REVIEW ticket says "being verified"; a rejected attempt's card shows the verdict reason where a failure reason shows today; "scope met" is a visible line. Every new line has a daemon field in the table first.
3. Ruling 35: the font subsets, coverage ranges and test.
4. The layout answer: the conversation takes the height on the Manager tab; the scope becomes a collapsible panel that opens to full height when the owner wants to read it. OWNER TASTE remains on the exact proportion; ship the collapsed default.

Acceptance: DOM-harness tests for each new line keyed on a real daemon response (the daemon is the fixture, as in batch 16); the legend assertion; the font test green with the new ranges; screenshots of the Manager tab before and after; `src/ui` suite with zero skips.

### Closing condition, run, not described

The owner resumes **the same real project**, with their data, after batch 18 lands. Evidence in `docs/evidence/batch-18-walk/`:
1. At least one ticket is rejected by the verifier with a cited reason and then either passes on retry or fails finally with the verdict on the board.
2. When the batch drains, the Manager reviews progress on its own and either proposes the next phase, declares the scope met, or asks.
3. The owner writes to the Manager while a worker is running and gets a reply within one tick plus one Manager run.
4. Typing in Needs You survives the polls. No system-font notice for an arrow or a check mark.
5. The owner runs the same external review they ran before on the result. Their defect count is the measure; ours is not.

## 4. Batches 19 and 20, shaped, not specified

- **Batch 19, identity and seeing.** Worker profiles exactly as designed in `batch-16-addendum-1-worker-profiles-design.md`, with one addition: the verifier is the `Reviewer` profile by default. The Manager's default model becomes the top tier for planning unless the owner sets otherwise (see question 4). Run drill-down: the adapter writes each run's transcript to a file under the state directory, `GET /runs/{id}/transcript` serves it behind the token, the page opens it behind a click on the fleet row. The command-text rule is revisited for that file only: it is the owner's own data on the owner's own disk, shown when they ask; it still never enters an event row or the board.
- **Batch 20, steering from the app.** `PATCH /projects/{id}` for max-parallel, default model, verifier model; the machine cap adjustable through a daemon route while running; scope editing in the page with a `PUT`; one answer field per question (the fold in `managerApply.ts` becomes N questions, N answers, one event with both arrays); project creation in the window as ruled in addendum 2 section 2; the beta checkpoint from batch 16 addendum 3.
- **Parked, unchanged:** Linux, AionUi pull, worktrees, OS-level isolation, the Agent Generator, the second skin behind the owner's research.

## 5. What the owner must decide or supply

1. **Cost consent, before the closing walk, not before the build.** Verification doubles the runs per ticket, and the Manager will take turns without a click, at most 20 a day per project. Yes or no, and any lower daily number they prefer.
2. **Permission for the Orchestrator to read their `~/.magarine`, and the external review report.** Already asked. Not blocking; it sharpens the stall diagnosis and the verifier's prompt.
3. **The closing walk is their same real project, resumed.** If they would rather start it fresh, say so; the verifier and the review pass need real deliverables to bite on either way.
4. **The Manager's model.** Today `project set --manager-model claude-opus-5` exists (HARD, `cli.ts` 289-290) and costs about 2.5x sonnet per input token. Do they want the Manager on the top tier by default from batch 19, or chosen per project? Default if silent: stays sonnet, flag available.

Three things they can do today, through the Liaison, with no build:
- Start the daemon with `magarine serve --max-parallel N` for more workers at once; `magarine project set --project <id> --max-parallel N` caps one project.
- `magarine project set --project <id> --manager-model claude-opus-5` puts the Manager on a stronger model now.
- Ask for a research worker in the Manager tab in plain words; the Manager can create that ticket. Workers do not talk to each other; a ticket that depends on another receives that one's summary and artefacts.

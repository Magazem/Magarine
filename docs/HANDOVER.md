# Handover — read this first

## ⚠ 2026-09-22 — THE TEAM WAS DISSOLVED AND THE LEAD NOW HOLDS THE STRATEGIST ROLE

**If you are a fresh lead, this section overrides everything below it.**

The owner's instruction, verbatim: *"what we need right now, is to reset you, and fire everone,
i am giving you the strategist role, and you hire new assistants based on their needs and
roles, and continue batches"*.

**WHAT CHANGED:**
1. **There is no separate Strategist any more. You are the Strategist AND the lead.** You write
   the batch specs and rulings yourself, in `docs/strategy/`, in the same style as before: HARD /
   SOFT / UNKNOWN labels, every claim citing an artefact you have read, every acceptance line
   runnable. The old rule "the Orchestrator orchestrates and never decides" is RETIRED; the
   owner lifted it. What stays: **verify every teammate claim yourself before committing, and
   mutation-test everything.** Deciding does not excuse you from checking.
2. **Every previous teammate was shut down**: Strategist, Liaison, Interface Designer,
   Invariants Engineer. The Butler had already been removed. Nothing was in flight and the tree
   was clean.
3. **The owner delegated hiring:** "you hire new assistants based on their needs and roles".
   Hire for what the NEXT batch actually needs, not to rebuild the old roster. The team
   governance still says to show the lineup as a table first; the owner has pre-authorised it,
   so show it and proceed unless they object. `team_list_assistants` shows the real catalogue.
   Old roles that worked: a sonnet daemon engineer for `packages/core/src/**`, and a sonnet
   interface designer (assistant `ui-ux-pro-max`) for `packages/core/ui/**` + `src/ui/**`.
   **There is no Liaison now**; the owner talks to you directly in this chat.

**THE OWNER SETTLED HOW REVIEW WORKS, same day, in two messages, verbatim:**
*"instead you will hire reviewers tho, opus models"*, then, asked whether reviewers were in
addition to builders or instead of them: *"no, reviewer every mini phase or so i think better"*.

**AS RULED FROM THOSE WORDS:**
- **An Opus reviewer at the end of EVERY MINI-PHASE**, meaning roughly each item or small group of
  items, not once per batch. A FRESH reviewer each time, never a standing teammate who
  accumulates context. Fresh eyes are the point: the lead looked at the developer notes on the
  page all day and read them as normal, and a stranger saw them in minutes. A long-lived reviewer
  would drift the same way.
- **Builders still build.** The owner's "no" rejected the framing of the question, not the
  builders. Hire sonnet engineers for implementation as before, and put the Opus review at each
  mini-phase boundary. (The lead's reading. If the owner meant otherwise they will say so.)
- **Mechanics:** a one-shot review is cheapest as an `Agent` call with `model: "opus"`, with no team
  slot and no idle cost. Brief it with the ruling, the diff and the acceptance lines, and ask for
  defects only, labelled by severity. Spawn a team reviewer only if a review needs back-and-forth.
- **The lead still verifies on its own**: a cold suite and mutations on a still or isolated tree.
  The reviewer is an additional check, not a replacement for that. Two independent checks, one of
  them fresh every time.

**WHERE THINGS STAND:** batch 18 is CLOSED and pushed. The owner ran it on real work and said:
*"i did the run, it is fine generally, didn't find real bugs this time so i will accept it"*. Read
`docs/strategy/batch-18-closeout.md` first. `main` equals `origin/main` at `b85f842`. Suite:
934 tests, 933 pass, 0 fail, 1 honest skip.

**NEXT: batch 19. You plan it.** The carry list is in `batch-18-closeout.md`, all from the
owner's own words:
- The Manager's model: per project, with a configurable default (default half not built).
- Worker roles/profiles: designed in `batch-16-addendum-1-worker-profiles-design.md`, never built.
- Drill-down into what a worker is doing ("what is it running exactly, is it stuck").
- `max-parallel` and the scope editable from inside the app.
- One answer field per Manager question.
- Batch 20: project creation in the window.
Before planning, **ask the owner whether they want 19 now or want to use Magarine on real work
first and let the friction set the order.** That question was open when the reset happened.

**THE OWNER'S REAL PROJECT IS ON A DIFFERENT MACHINE.** This machine's `~/.magarine` holds only
old walks and demos. The owner has given permission to read it. **Their `magarine app` window
runs a Chrome whose profile is `~/.magarine\window`. It is theirs, not a stray.**

**HOW THIS TEAM WORKED, which the old roster proved and you should keep:**
- Verify page and daemon work in an ISOLATED git worktree (HEAD plus only the files under
  review) whenever another agent is mid-edit, because page tests spawn a daemon from source.
- A mutation window covers your test RUNS, not just your edits.
- Test anything that acts automatically against a COPY of real data: that is how ruling 34's
  dormant-project wake-up was caught, when no test in the suite had any history.
- Clear a teammate's context once their brief is durable; never broadcast.
- The lead commits and pushes; teammates never run git.

Written so the Orchestrator's and Strategist's contexts can be reset without losing anything.
Everything below is durable: the task board, `docs/strategy/`, `docs/design/`, `docs/evidence/`
and the commit history carry the rest.

## READ FIRST IF YOU ARE A FRESH ORCHESTRATOR

The lead's context was reset here deliberately. Everything you need is this file, the task
board, `docs/strategy/` and `docs/evidence/`. Do not ask the team to re-explain; the park
section below is the resume point.

**THE OWNER'S GOAL, in their words (2026-09-19):** *"i want to get finished with this project
so we can move our workflow to magarine and be more effecient than the current one"*. Magarine
is not a toy for them: they intend to run this team's own kind of work through it. Their
deferred design research is about "these stuff" — the efficiency of agent workflows — which is
why ruling 27 holds the second skin until they hand the research over, and why it may land as
an update rather than a rebuild. Weigh every scope call against reaching a usable beta.

**SESSION LIMITS ARE THE BINDING CONSTRAINT AND THEY ARE BEING SPENT TOO FAST.** The owner
raised it, the measures below are theirs approved, and they are rules now, not suggestions:

1. **The cost is the team talking, not the product running.** Test runs, daemons and Chrome
   cost wall-clock, not session capacity. Long briefs, long reports and many round trips do.
2. **Every message to a teammate re-feeds that teammate's whole accumulated context.** Three
   agents are premium long-context: the lead (opus 1M), the Strategist (fable 1M) and the
   Interface Designer (opus 1M). Clear a teammate's context with `team_clear_agent_context`
   whenever their brief is durable on the board — it costs nothing to do and removes the
   largest repeated charge. Done for both engineers at the park.
3. **Batch dispatches.** Role A's six items cost six briefs, six reports and six verification
   turns. Send two or three items per task unless one genuinely blocks the next.
4. **Cap reports: ten lines, one line per mutation.** The engineers' rigour is why this works;
   the prose is not what makes it work.
5. **Point at the spec, do not restate it.** A brief names the section and the two or three
   things the reader would otherwise get wrong.
6. **Only wake the Liaison when the owner must decide something.** Status is not a decision.
7. **Retire idle teammates.** The Butler ran the whole of batches 15 and 16 without a task and
   was shut down at the park.
8. **RESOLVED 2026-09-19, kept for the reasoning.** The owner approved sending Role B's last
   batch-16 item to the engineer instead of the Designer, on cost. It went to the Designer:
   `team_members` shows them on **sonnet**, not opus, so the premium-context argument did not
   apply, and they held the page. Committed at `5f54292`. **Check a teammate's actual model
   before costing a decision on it.**

## BATCH 17 IN FLIGHT — 2026-09-20, the Windows window host

**Spec** `docs/strategy/batch-17-spec.md` (`e8a4d27`); **ruling 30 AMENDED**
`batch-17-addendum-1-ruling-30-amended.md` (`51711ec`) — read the amendment, it changes the
browser order, the lifecycle and where notifications live. Spike evidence:
`docs/evidence/batch-17-walk/window-spike.md` (`15fe64c`).

**SHIPPED:** `59ec2c2` a shutdown that cancelled work says so, and says the spend is paid again
(the owner's own Ctrl+C finding) · `a16fbd4`+`d69dbd5` one-time launch codes, mint behind the
token, exchange unauthenticated and single-use, identical 404 for every refusal so a burned
code is not distinguishable from one that never existed · `07ade24` the page's favicon and the
`(N)` taskbar title count · `4b5befa` the page signs itself in from `#launch=` and the code
never survives in the address bar · `1bfd56a` the page is FORBIDDEN to raise a Web Notification
or register `beforeunload`, enforced by a test, not a paragraph · `41e5ab1` a spent code takes
you to the gate, proven in real headless Chrome · `d72cfa3` **`magarine app`**: owned mode
enters `serve()`, attach mode never does, the host waits on the child's exit and nothing else,
closing the window LEAVES THE DAEMON TICKING, Ctrl+C stops the daemon then closes the window.

**IN FLIGHT:** item 4b, the host-side Needs You toast (PowerShell, stdin not argv, no launch
action, `--no-notify`). **It is the designated drop if session limits bite** — the taskbar count
is a usable beta alone. Then item 5: `doctor`'s `window host` line and README step 3 becoming
`magarine app`. Then the closing walk (spec section 4, amended in addendum section 5).

**WHY THE PAGE MAY NOT NOTIFY, so nobody re-adds it:** a Chromium toast click opens a NEW
browser on the owner's DEFAULT profile instead of focusing the window (observed twice by the
Engineer, once by the lead), and Edge IGNORES a graceful window close while a live Web
Notification is up — which would break item 4's entire lifecycle.

**NOT OBSERVED, carried:** a real Ctrl+C anywhere on Windows from a script, so the
daemon-then-window ordering rests on `process.emit('SIGINT')` in tests; Edge never run for
real; window-bounds persistence neither built nor claimed. **The owner closed the equivalent
gap for batch 16 with one keystroke; this batch wants the same.**

**A TIMING-SENSITIVE TEST TO WATCH:** `browser.test.ts`'s "the organism keeps animating across
the re-render" failed once for the Designer and passed 2/2 for them and 3/3 for the lead
immediately after. It samples animation frames across nine seconds while a second ticket
reports every 500ms. Two live theories for the day's "load flakes": browser contention, and
concurrent mutation windows (**one such flake was provably the lead's own fault** — a cold suite
started BEFORE the mutation window was announced read a teammate's deliberately-broken file).
**The window now covers verification RUNS, not just edits.**

## BATCH 16 IS CLOSED — 2026-09-20

**Its closing condition was RUN (rule 20).** The owner walked it and reported:
*"did the steps all good, ctrl + c produced no output just closed the daemon, verefied by
runnung status again and it said no daemon running"*. Full record, including the five other
walks and what each proved: `docs/strategy/batch-16-closeout.md` and
`docs/evidence/batch-16-walk/`. Read the close-out before claiming anything about batch 16.

Suite at close: **819 pass, 0 fail, 1 skip** (the skip is an EACCES case this Windows machine
cannot produce; the test proves that before skipping).

**NEXT: batch 17, the Windows window host.** Then 18 = per-ticket discussion, tags, shortcuts,
and the owner's second skin.

**DONE SINCE THE CLOSE (`d7ad88a`):** the stranger's-walk `--help` findings. `magarine --help`
now lists all 22 commands including `discuss` and `token`, **derived from `FLAG_SPECS`** so it
cannot drift again; `<command> --help` works and reuses the unknown-flag error's own composer;
the flag error names `--state-dir` before `--db`; `ticket add` is README step 7, every command
in it run by the engineer. Suite 825/824 pass/1 skip, verified by the lead.

**RULED FOR BATCH 17 (`a5f7f79`):** a shutdown that cancels work must say so —
`docs/strategy/batch-17-item-shutdown-reports-cancelled-work.md`. From the owner's own walk.
The key fact, which the Orchestrator's own framing had missed: `run_cancelled` returns tickets
to READY with NO attempt consumed, so the next `serve` restarts them from scratch and the
partial spend is paid twice. Silence when nothing is in flight is KEPT.

**OPEN WITH THE OWNER, asked 2026-09-20, no answer yet:** start batch 17 as planned, or put a
piece of their REAL work through Magarine first and let the friction set 17's contents? Their
stated goal points at the second; batch 17 is a comfort batch and the product already works in
a browser. Do not start 17 until they answer.

**ALSO NOTED BY THE OWNER, no action taken:** `serve` prints instructions to run `magarine
token` rather than the token itself. That is deliberate — a token on the start line lands in
scrollback, redirected logs and screenshots — and it is the scar addendum 9 left. If they ask
for the token itself, that is a security-shaped default and goes to the Strategist, not the
lead.

**WITH THE STRATEGIST, undecided:** Ctrl+C prints nothing while cancelling every live run
(tickets roll back to READY). Nobody is misled, but a shutdown that cancels work says nothing
about it. Batch 17 candidate at most; a quiet exit is a real convention and declining is a
legitimate answer.

**THE OWNER'S GOAL IS UNCHANGED and is the measure of everything:** *"i want to get finished
with this project so we can move our workflow to magarine and be more effecient than the
current one"*. Batch 16 removed what would have stopped them trying. **The interview has been
seen exactly once, by the lead, on a toy word-count project** — their real work is the actual
test.

**A CORRECTION WORTH KEEPING:** the owner's daemon pid 31044, which the previous handover said
was running and untouchable, was already gone when checked on 2026-09-19. Verify a claimed
process before acting on it.

## STATE 2026-09-19 (updated after the park) — batch 16, items 5 and 6 in flight

The park below was resumed and is now history. **Committed since, each mutation re-run by the
lead on a still tree before the commit, never taken on the engineer's report:**

- `548303b` **Role A item 4, one number governs parallelism.** Migration 0014 makes
  `projects.max_parallel_workers` nullable (null = no cap of its own, the daemon's ceiling
  governs); existing rows keep their explicit value deliberately, because they were created
  under the old meaning and widening them silently would spend the owner's subscription on
  sessions they never approved. The table is rebuilt from its OWN live DDL under the runner's
  new `rebuildsReferencedTable` bracket, and refuses to rebuild if the column is not declared
  as expected. `--max-parallel` is validated on create/tick/run/serve, serve first so an
  invalid value never starts a daemon. `GET /board` carries `slots { used, cap }`.
  Cold suite on the lead's own run: **769 pass, 0 fail.** Five mutations, each failing exactly
  what it should — including the migration overwriting an explicit row with NULL (both upgrade
  tests fail) and a fifth the lead added: serve not passing `machineCap` fails ONLY the
  spawned-daemon `/board` test, which is what proves the wiring rather than the payload shape.
- `5f54292` **Role B item 3, the fleet header.** "1 of 3 slots in use machine-wide", plus
  "— full, other tickets wait" at the cap, and NO denominator when `cap` is null. `src/ui`
  **82 pass, 0 fail, 0 skipped** on the lead's own run — zero skips is the claim that Chrome
  was really present. The lead re-ran the mutation that matters (render `used` per-project):
  the machine-wide test fails, so it asserts the distinction, not the number.
  One declared deviation: a real daemon cannot send `slots.cap: null` over the wire, so
  `domHarness` gained an opt-in `rewriteJson`, off unless a test names it, changing only that
  one field on the daemon's real response. "The daemon is the fixture" still holds everywhere
  else.

**BATCH 16 ROLE B IS COMPLETE.** The Designer is idle and their context was cleared.

**IN FLIGHT, UNCOMMITTED — Role A items 5 and 6** (task `01a0ba69-b656-74f2-8e46-152753c73e41`,
the brief is on the board). Item 5 is ruling 24: one `projectReadiness(project, stateDir)` that
`cli.ts`'s ruling 22 check must also call so the two cannot drift; the scheduler runs it before
any run, manager or worker, and pauses with a structured reason naming the exact fix; `project
list` marks unready rows `needs --dir`; no healing of rows. The `pauseReason` widening is three
places TOGETHER — `store.ts`, `board.ts`'s `BoardResult`, `inbox.ts`'s `describeProjectPause` —
using Role B's names `missing_workspace_root` | `unsafe_workspace_root` | `missing_scope_path`.
Item 6 is the two small truths.

**THEN BATCH 16 CLOSES** on addendum 3's closing condition, which has NOT been run: the lead's
cold walk, the stranger's walk, the legacy-DB fixture, the two-workers-at-once observation, and
the owner's walk as an invitation. Rule 20 — a batch does not close until its closing condition
has actually been run.

**The owner's own daemon (pid 31044, their real `~/.magarine`) is running and is not ours to
stop, read or use.**

### The original park note, kept because its NOT-DONE list is how item 4 was resumed

#### PARKED 2026-09-19 — batch 16 mid-flight, exact resume point

Parked on the owner's instruction: session limits are burning fast, so we stopped at a
coherent point rather than at a finished item.

**COMMITTED AND VERIFIED** (each mutation re-run by the lead, suite green at the time):
`c2a9bab` fake-adapter burst + `review` under --fake-script; `f3ca200` ruling 19 (`reporting`
is a text line); `1d0321a` ticketId on progress events; `e2faa15` the DOM harness with NO
fixtures (a real spawned daemon is the fixture) plus Role B items 1 and 2; `871ea9f` the two
browser proofs as real tests, with Chrome resolution reporting its strategy.

**UNCOMMITTED IN THE TREE — Role A item 4, mid-edit, 23 files.** Coherent and green in scoped
runs, deliberately NOT committed because it is incomplete. Do not treat it as done.
- DONE: migration 0014 (nullable project cap) with the runner's `rebuildsReferencedTable`
  flag, its upgrade test against a real 0001-0013 legacy DB, and 0014 appended to the
  hard-coded id lists in 11 other db tests; `Project.maxParallelWorkers: number|null`;
  createProject defaults null; `computeProjectCap` treats null as unbounded; `cli.ts`'s
  `parseMaxParallelFlag` used by create/tick/run/serve with serve validating FIRST;
  `project set --max-parallel none`; the route accepting `maxParallel: number|null`.
- NOT DONE: `board.slots` (buildBoard, BoardResult, route wiring — DaemonApiDeps needs the
  machine cap from serve.ts, and its test); ALL FOUR mutations unrun, including the one that
  matters most, a migration overwriting an explicit row with NULL; the full cold suite unrun;
  README lines for `none` and null-by-default; other tests assuming a default cap of 1
  unchecked.
- `packages/core/burstprobe.probe.ts` is untracked and disowned by both engineers; it imports
  Role B's testDaemon/browserHarness. Delete it rather than commit it.

**STILL TO DO IN BATCH 16:** finish item 4; item 5 (ruling 24 readiness check, which must widen
`store.ts:84`, `commands/board.ts`'s BoardResult type and `commands/inbox.ts`'s
describeProjectPause TOGETHER, using Role B's names `missing_workspace_root` |
`unsafe_workspace_root` | `missing_scope_path`); item 6 (camelCase in the route error, `status`
with no project); Role B item 3 (`N of M slots`, blocked on `board.slots`); then the closing
condition of addendum 3 — the lead's cold walk, the stranger's walk, the legacy-DB fixture, the
two-workers-at-once observation, and the owner's walk as an invitation.

**The owner's own daemon (pid 31044, their real `~/.magarine`) is running and is not ours to
stop, read or use.**

## What Magarine is, today

A cross-platform agent-orchestration daemon. **It works end to end and has been proven with
real money:**

- Hand it a markdown scope document. It **interviews you about what it does not know** rather
  than assuming — and does *not* interview when the scope is already clear.
- It plans the work into tickets with dependencies, **chooses a model per ticket and records
  why** (mechanical work on haiku at ~$0.05, real design work on opus-5).
- A daemon runs workers in parallel under a spend cap, on a loopback HTTP API.
- A browser page shows the board, the inbox, activity, and a conversation with the Manager.
- You can talk to it in plain language and it **re-plans**.

Proven runs are in `docs/evidence/`. Batch 13's replay: four tickets, four files delivered,
$3.38 equivalent.

## Where we are

**BATCH 15 IS CLOSED.** Its closing condition was run: the lead's acceptance walk, the lead's
re-run of the owner's walk from step one, and the owner's own re-run. Their verdict: *"the demo
run was perfect."* The ticket the batch turned on -- their `index.md`, delivered and failed four
times by a raw string comparison -- is `DONE`, succeeded 2026-09-19 after ruling 21.
**The record is `docs/evidence/batch-15-walk/RESULT.md`**; read it before claiming anything about
batch 15. Authority is `batch-15-spec.md` plus addenda 1-10.

**What batch 15 delivered:** the daemon's read path, `/events`, static assets and expected
artefacts (`e9d37f8`); pass 3 as the page the daemon serves, the three views as a root
`data-view`, per-column scrolling, keyboard reach on every scrolling region, the current view
drawn, the organism animating from the board's own marker and surviving re-renders, and 23
capture files (`448b97b`, `68ca8a7`, `80231ec`, `d7070f8`, `88501b0`, `a69f0e2`); expected
artefacts on `ticket add` and `POST /tickets` (`d3e8281`, `07ebfd2`); `reasonFor` reading
`errors` (`edef94c`); and, from the owner's walk, `magarine token` (`fd0d94e`, `4416031`),
resolved-path artefact matching (`5f1e7f2`), unsafe project roots refused (`aa84325`), and
`project set --max-parallel` (`9937064`). Suite 736 pass, 0 fail.

**BATCH 16, ruled or carried. The Strategist sets its final shape; this is what is banked:**
1. **Parallelism, ruled (addendum 10, ruling 23 items 4-5):** `projects.max_parallel_workers`
   becomes nullable so ONE number governs, by migration with an upgrade test, and the fleet
   header shows "N of M slots". **This one first** -- the owner hit it, and the page could not
   tell them why nothing ran in parallel.
2. **`reporting` means a text line, ruled (addendum 8, ruling 19).** Needs the fake adapter to
   script a progress burst first (item 3), because the scheduler test needs one.
3. **The fake adapter cannot script a progress burst**, so ruling 18 requirement 4 (an
   animation survives the re-render a frame causes) is proven by a Chrome run rather than by
   test. **Corrected 2026-09-19: approve/reject are NOT in that state** -- `--fake-outcome
   review` has scripted a review since batch 5 and `commands.test.ts` 1139/1177 drive both to
   their real transitions. Only `--fake-script` lacks the `review` spelling. My error, from the
   batch 15 walk, inherited by batch 16's item 1 rationale before the Engineer caught it.
4. **LEGACY PROJECTS ARE THE COMMON THREAD OF THE REST** -- rows created before a rule existed:
   - **No scope path (found by the owner, 2026-09-19).** A Manager run on a pre-14-September
     project failed with "update_scope cannot be applied: this project has no scope_path set
     yet"; a retry passed by luck. `managerEnvelope.ts` 209 offers `update_scope`
     unconditionally, `proposal.ts` 470 refuses it without a scope path, and a proposal is
     all-or-nothing, so the run fails. Four of the owner's nine projects are in this state. The
     Manager must not be offered a command that cannot be applied to that project.
   - **Unsafe workspace roots** (ruling 22's carry): the point-of-use guard in the scheduler,
     pausing the project with a reason naming the fix.
5. **`serve`/`tick`/`run --max-parallel` are still unvalidated**: `--max-parallel 0` sets a
   machine ceiling of zero, so the daemon starts nothing and says nothing; `abc` becomes NaN.
6. **A project created while the page is open is invisible until a reload** (`app.js` 1118, 1167).
7. Worker profiles and avatar seeds, planned for 16 before any of the above.
8. `POST /tickets` names the Manager's snake_case field in its unknown-kind error; `status`
   without `--project` errors instead of reporting the daemon, port and page address.
9. Ruling 18's option B, carried on its own merits: `worker_progress` events self-describing.

**Sequence after 16:** 17 = the Windows window host. 18 = per-ticket discussion, tags, shortcuts,
and the owner's second skin.

## How this team works — the rules that were earned, not assumed

1. **Verify every claim independently before reporting or committing it.** This has caught a
   real defect eleven times, including twice in work I had already signed off and once in my own
   reported finding.
2. **Mutation testing is the standard.** Break the thing a test names; confirm exactly that test
   fails. A test that cannot fail reads as coverage and is worse than none.
3. **A test name is a claim.** The mutation must cover the whole name.
4. **A comment claiming a path is handled elsewhere must name the test that proves it.**
5. **Split, don't re-point.** When a rule changes, an inherited test's claims move to the input
   where they still hold; the new input gets its own test.
6. **Where a wrong choice by an agent produces silent failure, remove the choice.** Guidance is
   for choices that are safe either way.
7. **An event that cannot name a next command is not an inbox item.**
8. **The interface shows only what the daemon measures.** A progress bar reading 67% when
   nothing measures progress is the same lie as DONE with nothing delivered.
9. **A silent fallback on the page is not allowed** — it must say when it is not the page the
   owner approved.
10. **A mock is never a promise.** Mocks mark what ships now versus later.
11. **Never whole-file restore a shared file**; mutate in place.
12. **Durable instructions go on the task board, never in a chat message** — mail is dropped by
    session limits.
13. **Exclusivity for measurement and mutation.** A hold reaches an agent at its next turn
    boundary, so the window starts when everyone has acknowledged, not when it is sent.
14. **The Orchestrator commits; engineers never run git.**
15. **A role that needs a capability is spawned with it, verified before its first task.**
16. **Measure a foreground against the lightest surface it can land on**, not the one it usually
    sits on, and re-measure every surface when one moves. An unused token that silently fails
    contrast is a trap, not a token.
17. **A checker that cannot fail is not coverage — mutation-test it.** Break the thing each check
    names and confirm that check fails. Two checks here passed while two tiers were made
    identical and while the generator was allowed to emit a one-pixel avatar, because one
    compared bitmaps rather than traits and the other read its goalposts from the code under
    test. Assert against a constant the checker owns.
18. **Hand-picked inputs are not a sample.** Seven seeds chosen by hand all missed a branch that
    was broken for 76% of one tier. Hit every branch, or sample at scale by machine.
19. **An anchor in a durable document is a claim and gets verified like one.** A ruling cited a
    commit hash for code that commit did not contain. A hash reads as the most verifiable kind of
    reference, so a wrong one misleads harder than the stale line number it replaced.
20. **A batch does not close until its own closing condition has actually been run.** Batch 14's
    was "the owner walks the new page"; it closed with no new page in existence. Where a spec
    names implementation in a single sentence, that sentence is a batch, not a clause.
21. **Delivered means in the product, not in the repository.** A committed design is an artefact;
    until the daemon serves it, the feature does not exist for the owner.

22. **A script that opens a GUI carries its own deadline and closes what it opened.** Earned
    2026-09-20: a spike's PowerShell Forms timer outlived its parent when the environment
    restarted, threw `PipelineStoppedException`, and put an unhandled-exception dialog on the
    OWNER'S desktop while they were away, beside a stray browser window. Anything that can
    outlive its parent on someone else's machine is not acceptable however good its evidence.

23. **Two limits an agent must not cross to get a cleaner result, both held 2026-09-20.**
    The Engineer discarded a capture that showed the owner's Microsoft account email rather
    than commit it as evidence; and, asked whether a notification misbehaviour was inherent,
    they declined to settle it by raising a toast from the OWNER'S OWN default browser
    profile, and reported it SOFT instead. **A weaker claim honestly labelled beats a stronger
    one bought with someone else's privacy.** Both were unprompted.

24. **Owner-facing steps are run before they are written.** Walk instructions, recipes and any
    command handed to the owner are an artefact and get verified like one. Earned twice in one
    day: the lead told the owner to paste "the token serve printed" (serve never prints it,
    addendum 9), and wrote a demo recipe from the design's intent that ran every worker one at a
    time and used the owner's home folder as the workspace (addendum 10). Both instructions read
    correctly; neither had been run.

## How to run the tests

**`pnpm test`, from `packages/core`.** Its `test` script is `node --test`, so
`cd packages/core && node --test` is the same run, not a substitute --
worth knowing because **the command does not exist at the repository root**:
there is no root `package.json`, no workspace file and no lockfile. Every
acceptance line since batch 10 has meant "from `packages/core`". Documented in
`packages/core/README.md` lines 21-24.

The lead spent part of a session concluding `pnpm test` was unrunnable here
before the Strategist corrected it; this section exists so nobody repeats that.

## Cost

The owner is on a **Max subscription**. Dollar figures are **equivalent API cost**, useful for
comparing runs, **not money leaving an account.** The binding constraint is **session limits**,
and **the team talking is the expensive part, not the product running** — six real worker
invocations cost ~$1.00 while a day of six agents coordinating cost far more. Never broadcast;
retire finished agents.

**THE `advisor` TOOL IS OFF — the owner disabled it 2026-09-16.** Every call re-fed the ENTIRE
conversation and chat history to a second model, and that is where most of a session went in
about an hour. In the owner's words: **"the real advisor is the strategist, or you for smaller
cases."** Escalate design and scope questions to the Strategist; decide integration and
housekeeping yourself. If it ever reappears, announce before calling it.

**Three measured wastes, all the Orchestrator's, corrected 2026-09-16:** writing every brief
twice (a long board task AND a long chat message repeating it — the board is the durable copy,
the message is a pointer); twelve documentation commits in sixteen minutes where three would
have done; and essay-length messages where three lines carry the instruction. One hour produced
13 commits of which exactly one held product work. **Answer usage questions with measured
numbers, not a general account of coordination cost.**

## Team

| role | state |
|---|---|
| **Strategist** (fable) | the real manager; every ruling is a file in `docs/strategy/` |
| **Interface Designer** (ui-ux-pro-max) | pass 3 delivered; context reset after the commit |
| **Invariants Engineer** (sonnet) | batch 13 complete; context reset |
| **Liaison** (sonnet) | the only channel to the owner |
| **Butler** | creates assistants on request |

## Decided by the owner (2026-09-16)

1. **Typeface: IBM Plex Sans.** Confirmed. Aliased as "Magarine Sans" in `tokens.css`, so a
   future change stays a one-line swap.
2. **The Next.js port** in `propos/fleet-and-board/` is **a design reference only** — and the
   owner has clarified the stack *was never their choice*: the tool that generated their
   reference image happened to use it. **It carries no signal about their preferences. Do not
   mine it for intent again.**
3. **Non-Latin scripts: the owner personally will not need them, but future users might**, and
   they left the timing to us. Recommendation with the Strategist: ship the Latin subset now,
   make the page *say* when it is rendering outside the bundled subset rather than silently
   falling back (rule 9), and carry wide-script support against a stated trigger — *when
   Magarine has a user who is not the owner*. A CJK subset is megabytes against Latin's tens of
   kilobytes, paid by every user on every load, and buys nothing for the only user who exists.

## Open with the owner

Nothing open but the batch 15 walk itself.

**Corrected 2026-09-16 at close-out.** This section listed two items as open -- whether the owner
had approved pass 3 ("BLOCKING"), and permission for one small real run. **Both were answered by
the owner in a single message** and recorded at `docs/strategy/batch-15-addendum-2-second-skin.md`
section 0, line 8: *"Pass 3 is approved: 'the design is good, we will use it.' The small real run
is permitted."* Neither record here was updated at the time, and the stale copy nearly caused the
lead to re-ask the owner for a permission already given (addendum 7 section 1). When a relayed
answer settles something, update every record that asked the question.

## Carried UNKNOWNs — stated, not assumed away

- **Assistant prose already reaches the page, unfiltered.** HARD, 2026-09-16: `describeProgress`
  in `adapters/claudeCli.ts` returns `text: <first 120 characters>` of any assistant text block,
  and that string is persisted and displayed. **A model can echo anything it read — including
  file contents or a secret it encountered — into its prose and onto the page.** Existing
  behaviour, and the source of the `reporting` state; not widened by ruling 14. To be judged
  when a real run shows a case, not designed away blind.

- **Playwright is broken on this machine and is not available.** Verified 2026-09-16:
  `ms-playwright/chromium-1194/chrome-win/` holds only `chrome.dll` and a manifest — no
  `chrome.exe` anywhere under `ms-playwright`, and no playwright npm package installed.
  **Use system Chrome headless** at `C:\Program Files\Google\Chrome\Application\chrome.exe`;
  it needs an absolute `--screenshot=` path and its own `--user-data-dir` or it fails with
  access-denied. Do not spend a turn rediscovering this.

- **The owner's own design, as a second skin.** Their words: *"add an extra theme from the one I
  proposed, after we have the product working"* — and *"i don't want it lost."* Ruling 13 says it
  is a **skin, not a palette**: same six product regions, different arrangement and visual
  language. Source of truth is the owner's plain HTML and reference image under `propos/`, which
  are authoritative for this skin. (`propos/fleet-and-board/` is **not** — that is a generator's
  artefact, never evidence of preference.) Trigger: not before the window host closes at batch 17;
  a candidate for batch 18. Batch 15 builds the page so it is possible.

- **Wide font subsets.** Trigger, in the ruling's words: *"Ship the wide subsets when Magarine
  has a user who is not the owner."* Batch 15 ships Latin only. The owner will not need other
  scripts; future users might. Not "later" — that trigger.

- The **fallback-rate marker** has only ever seen synthetic data; no real run has named a model
  outside `pricing.ts`.
- **Migration 0012** has only run against a synthetic legacy database.
- **The EPERM flake** stays on the books at one-in-twenty despite forty clean runs.
- **`claude` resolution on any machine but this one** is an accepted risk with the failure made
  legible.
- **Linux is parked** with its `UNTESTED` header intact.
- **DONE with a text artefact instead of a file** is not checked anywhere and cannot be by a
  generic rule — batch 15's expected-artefacts list is the mechanical answer.

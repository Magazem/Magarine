# Magarine — Batch 16 specification: what the owner's use found, fixed as mechanisms

Author: Strategist. Date: 2026-09-19. Follows `batch-15-spec.md` and addenda 1-10; batch 15 closed at `76d97f0` on a run condition (`docs/evidence/batch-15-walk/RESULT.md`). Tree clean at `76d97f0` (HARD, `git log -1`).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The shape of this batch, and what I resequenced

Batch 15 shipped the page and the owner used it. Their use found, in one afternoon, more real defects than three batches of tests: a string comparison failing delivered work, a home directory as a workspace, parallelism unreachable, a token nowhere to be found, and a Manager offered a command its project cannot take. Every one was a rule the product had, applied to a row or a path or a default the rule had never met.

So batch 16 is the hardening batch: everything the owner's use found, fixed as a mechanism rather than an instance, plus the two testing-state gaps that let ruling 18 and ruling 19 be proven by hand instead of by test. Nothing new for the owner to learn; everything they hit, gone.

**Resequenced, stated plainly.** Worker profiles were banked "for 16 before any of the above" (handover item 7). They move to batch 17. A product feature landing on top of four legacy-row defects and two dead defaults is how batch 15 stretched. The window host becomes 18; per-ticket discussion, tags, shortcuts and the owner's second skin become 19. Linux stays parked behind the window host, with `linux-leg-design.md` unchanged; the end goal is cross-platform and the route still carries it, after Windows is the product the owner sits down to.

**Cut from 16:** nothing the owner hit. Worker profiles, as above. I will write the profiles design during this batch, since it has a real trade-off (how a profile's model relates to the per-ticket model the Manager already chooses and records) and that is fable work, not sonnet work.

## 1. Ruling 24 — legacy projects: one readiness check at the point of use, not a smarter envelope

### Evidence, HARD

- `managerEnvelope.ts` 206-210: the replan framing offers `update_scope` unconditionally. `buildManagerEnvelope` (310) receives the `Project`, so it could know; it does not look.
- `proposal.ts` 468-472: `update_scope` is refused when `board.hasScopePath` is false, a deliberate clean error. Proposals validate all-or-nothing, so the run fails `malformed_proposal`.
- `managerApply.ts` 72: `hasScopePath` is `scopePath != null` off the project row.
- The owner's row, created 13 September: `scope_path` and `workspace_root` both null. Four of nine projects are like it. Four runs failed, one passed, on whether the model happened to use the command it was invited to use.
- `cli.ts` 534-544: since batch 11, `workspace_root` and `scope_path` derive from one `--dir`, and `project set --dir` sets both. The owner's fix is one command per legacy project.

### Why not the two other shapes

- **The envelope omits the command.** Necessary for truthfulness but not sufficient: models use commands they were not offered, and the run still fails. And the same project cannot run a DIRECTORY ticket either, which no envelope wording fixes.
- **The validator degrades, dropping the command and passing the rest.** That is a silent fallback: the Manager believed it corrected the scope and nothing did. Rule 9.

### The ruling

1. **One function, `projectReadiness(project, stateDir)`**, returns the first failing rule or none: no `workspace_root`; `workspace_root` unsafe (ruling 22's three rules, moved into one shared function that `cli.ts` also calls, so the two sites cannot drift); no `scope_path`. Pure, tested per rule.
2. **The scheduler runs it before starting any run, manager or worker, for a project.** On failure the project is **paused through the existing pause mechanism** with a structured `pauseReason` naming the rule, and `reasonFor` renders it with the fix: `magarine project set --project <id> --dir <folder>`. The page's pause banner already offers the fix that matches the cause (`index.html`, pause banner comment); it gains this cause. Un-pausing: `project set --dir` on a paused-for-readiness project resumes it; no separate command.
3. **`project list` marks unready rows**, one word per row, `needs --dir`, so the owner sees the four before a Manager run finds them. `--json` carries `readiness: null | { rule, fix }`.
4. **The envelope tells the truth anyway.** With the guard, no envelope is built for a scope-less project, so the unconditional offer is true whenever it is sent. Keep the validator error as defence in depth; it is now unreachable in practice and its test says so.
5. **No healing of rows.** A row's directory is the owner's decision; the product asks, with the exact command, and waits.

Closes handover item 4 in full, both bullets.

## 2. Roles

Engineers never run git. The Orchestrator verifies every claim on a still tree and commits. Exclusivity for measurement and mutation: announce windows. Every test mutation-checked; every runtime claim backed by a run recorded in `docs/evidence/batch-16-walk/`.

### Role A: Daemon Engineer (sonnet)

Owns `packages/core/src/**` except `ui/`. Sequence is mandatory; each item is its own task and commit.

1. **Fake adapter scripts a burst, and the CLI can script a review** (handover item 3). `--fake-script` gains a per-ticket list of progress messages emitted in order with a configurable gap, and a `review` outcome kind that lands the ticket in REVIEW. Acceptance: a scheduler test drives five progress events through one run and asserts five `worker_progress` rows with ascending sequence; a CLI test drives `approve` and `reject` through a scripted review to their real transitions, not their refusals.
2. **Ruling 19, `reporting` is a text line** (addendum 8). `classifyProgressMessage(message, currentPhase)`; phase carried per run beside `ctx.progressSeq`; `tool` stays null for non-tool messages. Acceptance: the pure-function cases in addendum 8 section 4, and the scheduler test `[Write, tool result, text]` → `writing, writing, reporting` with tools `Write, null, null`, using item 1's burst.
3. **Ruling 18 option B while in the file** (handover item 9): `worker_progress` payload gains `ticketId`. Nothing on the page changes. Acceptance: the row carries it; the stream frame carries it; one test.
4. **Ruling 23 items 4-5, one number governs** (addendum 10). Migration 0014: `projects.max_parallel_workers` nullable, null meaning no cap of its own; existing rows keep their explicit value, and the migration's note says why. `computeProjectCap` treats null as unbounded on the project side. `project create` without `--max-parallel` writes null. `project set --max-parallel none` clears it. `--max-parallel` validated everywhere it is accepted (handover item 5): integer of one or more, else a usage error naming the flag; `serve` with an invalid value never starts. `GET /board` gains `slots: { used, cap }`, cap being the machine-wide ceiling. Acceptance: upgrade test on a synthetic legacy database with one explicit and one default row; a scheduler test where a null-cap project runs two workers under `--max-parallel 2`; `--max-parallel 0` and `abc` refused with the flag named.
5. **Ruling 24** as in section 1. Acceptance: `projectReadiness` tested per rule; a scheduler test where a scope-less project pauses before any run starts and the pause reason names the command; `project set --dir` resumes it; `project list` shows `needs --dir`; `cli.ts`'s ruling 22 check now calls the shared function and its tests still pass unchanged.
6. **Two small truths** (handover item 8): `POST /tickets`'s unknown-kind error names the route's own camelCase field; `status` with no `--project` reports the daemon, the port, the page address and the slots in use, or "no daemon running" with the start command. Acceptance: one test each.

### Role B: Interface Engineer (sonnet; the Designer)

Owns `packages/core/ui/**` and `src/ui/**`. Starts on item 1 and 2 at once; item 3 waits on Role A's fields.

1. **A project created while the page is open appears without a reload** (handover item 6). `/projects` is re-fetched on the same cadence as the board, and the selector is rebuilt only when the list changed, so the owner's current choice is never reset. Acceptance: a page test that a new project id in the response reaches the selector and the selected value survives.
2. **The pause banner knows the readiness cause.** Copy for the new `pauseReason`, offering the exact command with the project id filled in. Acceptance: the element-field table gains the line; a page test renders the banner from a fixture of the daemon's shape.
3. **The fleet header shows `N of M slots`** from `board.slots`, next to the worker count, and nothing when the field is absent. Acceptance: field-backed per rule 8, listed in the table; a page test.

### The Orchestrator

Verification of every acceptance on a still tree; the batch walk written to `docs/evidence/batch-16-walk/RESULT.md` before the batch is called closed; the handover corrected the same day any relayed answer settles something.

## 3. Closing condition, to be run, not described

1. Suite green, run as `pnpm test` from `packages/core`, with every new test mutation-checked and the mutations listed.
2. A legacy database fixture in the shape of the owner's four projects (null `scope_path`, null `workspace_root`): `project list` shows `needs --dir` on all four before, none after one `project set --dir` each; then one Manager run on one of them succeeds under the fake adapter. (Amended by addendum 3: the owner's own projects are fixed by them at the beta checkpoint.)
3. One project with two unblocked tickets under `serve --max-parallel 2` and no project cap: both run at once, observed on the page with `2 of 2 slots`, recorded with the run ids and start times.
4. One small real run whose recorded activity states are not all one value (ruling 19's real-run check).
5. The two walks of addendum 3 ruling 28: the lead's cold walk from the README on a fresh state directory, and a stranger's walk by a fresh agent given only the README. (Amended by addendum 3: the owner tests nothing until the beta checkpoint.)

## 4. What the owner must decide or supply

Nothing before the batch starts. During the close: one `project set --dir` per legacy project they still want, and the walk. The Orchestrator asks through the Liaison with the exact commands, after item 5 lands, not before.

## 5. During this batch, mine

The worker-profiles design for batch 17, written against `batch-14-addendum-2-owner-brief.md` rulings 103-108 and the Manager's existing per-ticket model choice, as an addendum here before batch 16 closes, so 17 starts with its design decided.

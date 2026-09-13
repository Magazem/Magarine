# Magarine — Batch 4: cost control that holds, failure semantics, review flow, state directory

Author: Strategist. Date: 2026-09-13. Follows `batch-3-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-3-closeout.md`; nine commits on top of the upload, tree clean.
- `adapters/claudeCli.ts` classifies budget overspend by a prose regex against `result` text; the close-out's probe shows the tool reports `subtype: error_max_budget_usd` with no text. The regex can never match.
- `scheduler.ts` already carries `failureClass` and `retryable` on failure events and already has `artifactsDir` in its deps, defaulting to `<cwd>/.magarine/artifacts`. `cli.ts` defaults the database to `<cwd>/.magarine/magarine.db`.
- `stateMachine.ts` decides READY versus FAILED inside `worker_retryable_failure` from attempt counts, so the persisted event type is the same for an ordinary retry and for exhaustion. The policy table keys on event type, so exhaustion cannot reach the inbox today even though the architecture document's table says "Retry limit exhausted: Inbox".
- The policy table has no rows for approval or rejection because no such transitions exist. Tickets in REVIEW now reach the inbox and stop there.

## 1. Rulings on the five close-out questions

### 1. The budget ceiling

The tool checks its ceiling between turns, so the overshoot is bounded by the cost of one turn. On a trivial ticket one turn is the floor price, which is why a tenth-of-a-cent ceiling "overshot" two hundred times: the ceiling was below the price of doing anything at all. That is not runaway spend, but the daemon still must not depend on the tool's flag, because the flag is the tool's promise and the daemon's job is to make its own.

Three layers, in order of how much they are worth:
1. **The hard control is at spawn time.** Not spawning is the only cost decision the daemon fully controls. Projects gain an optional `max_spend_usd`. Before each spawn the daemon sums recorded spend across the project's runs, adds the run's ceiling, and refuses to spawn if the total would exceed the cap. It emits one inbox event, `project_spend_cap_reached`, and pauses the project until the owner raises the cap or clears the pause.
2. **The per-run ceiling becomes the daemon's own.** The adapter keeps passing the flag, and additionally reports cumulative spend on each assistant message from the stream. The scheduler stops the run when the tally crosses the ceiling. Same granularity as the tool, but independent of it, and honestly classified. A ceiling below the floor is rejected at ticket creation with a message that says why; the floor constant starts at twenty-five cents (SOFT, from batch 2 and 3 measurements) and lives in one place.
3. **The bound is documented.** The README states that a run may exceed its ceiling by at most one turn's cost, and that the project cap is the hard limit.

### 2. Budget classification and `adapters/` ownership
Confirmed: discriminate on `subtype === 'error_max_budget_usd'`. `adapters/` is owned by Role H, who also owns the scheduler seam, so the per-ticket override finally reaches the adapter in the same hands.

### 3. The lower floor price
No change to defaults. The cause of the drop is UNKNOWN; SOFT, it is cache reads replacing cache creation on a warm day. The floor constant above is set from the higher measurement so it does not lie on a cold day.

### 4. The failure split
Split it. The scheduler asks for one transition, `worker_failure`, with `retryable` and `failureClass` in the payload. The state machine decides the destination and **persists the event under the concrete type it chose**: `worker_failed_retryable` when the ticket returns to READY, `worker_failed_final` when it lands in FAILED, whether by exhaustion or because the failure was not retryable. The policy table then routes retryable to activity and final to the inbox with `requiresUser`, matching the document's table. `worker_retryable_failure` is removed, and the replay test proves old event logs still reproduce the same statuses.

### 5. Review approval and the state directory
Both in batch 4. Both are small and both are needed to close the loop on this machine before the Linux leg.

## 2. Batch 4 roles

Shared constraints unchanged. One addition, from the Orchestrator's own batch 3 lesson: **any part 2 that joins two roles' work is driven by hand at the moment it is joined, before it is committed.**

Contracts so the roles need not talk:
- Transition names Role H creates and Role I calls: `review_approved` (REVIEW to DONE, then resolve dependents' readiness), `review_rejected` (REVIEW to READY, consumes one attempt, payload `{ reason }`, exhaustion lands in FAILED as `worker_failed_final`), `project_resume` (clears a project pause, whatever its cause).
- `SchedulerDeps.artifactsDir` already exists; Role I passes it from the resolved state directory. Role H does not change its meaning.
- Ticket spend is the sum of `total_cost_usd` over its runs; project spend is the sum over its tickets. Role H exposes one store function for each; Role I displays them.

### Role H: Cost Control and Failure Semantics Engineer — model tier: sonnet, high effort
Owns `adapters/`, `scheduler.ts`, `stateMachine.ts`, `store.ts`, `types.ts`, `policy.ts`, `envelope.ts`, `db/schema.ts` and migrations, and their tests. Does not touch `cli.ts`, `commands/`, or the README.
Deliver:
1. Budget classification on `subtype`, with the recorded probe output as the test fixture. The prose regex is deleted.
2. `startWorker` takes the ceiling from the envelope's `maxBudgetUsd`, so a ticket override reaches the tool. Test: two tickets with different overrides produce two different `--max-budget-usd` arguments to the fake executable.
3. The adapter emits a `progress` event carrying cumulative `costUsd` from each assistant message's usage in the stream. The scheduler stops the run when the tally exceeds the ceiling and records `budget_exceeded` as a non-retryable failure with the tally and the overshoot in the payload.
4. Minimum ceiling constant, enforced in the store when a ticket or project budget is set, with an error that names the floor.
5. `projects.max_spend_usd` nullable, migration with upgrade test. Spawn-time check as ruled, `project_spend_cap_reached` inbox event with `requiresUser`, project pause reusing the existing pause mechanism. Test with the fake adapter: a cap that admits one run refuses the second and emits the event exactly once.
6. The failure split as ruled, with policy rows, replay test updated to prove old logs still reproduce statuses.
7. Transitions `review_approved`, `review_rejected`, `project_resume` with policy rows. Test: approving a ticket makes its dependent READY on the next resolve; rejecting at the last attempt lands in FAILED as `worker_failed_final` and reaches the inbox.
Acceptance: every item has a fake-adapter test; `pnpm test` green run by the Orchestrator; the single write site still single; the policy completeness test still passes with the new rows.

### Role I: Review Flow and State Directory Engineer — model tier: sonnet, medium effort
Owns `cli.ts`, `commands/`, a new `paths.ts`, and the README. Does not touch anything Role H owns. Part 1 starts now; part 2 is dispatched after Role H's commit.
Part 1, deliver:
1. `paths.ts`: resolve the state directory as `--state-dir`, else `MAGARINE_HOME`, else `<home directory>/.magarine/`. Database at `<state>/magarine.db`, artefacts at `<state>/artifacts/`. `--db` remains as an explicit override. Nothing is written under the current working directory unless the user asked for it. Test with a temp home.
2. `project create --max-spend <usd>` and `project set --max-spend <usd>`; `board` shows project spend against cap at the top and ticket spend per row.
3. README: the state directory rules, the budget layers, and the one-turn overshoot bound in plain words.
Part 2, after Role H lands, driven by hand before commit:
4. `approve --ticket <id>`, `reject --ticket <id> --reason "<text>"`, `resume --project <id>` (replacing or extending the adapter-scoped resume), and `inbox` showing `worker_failed_final` and `project_spend_cap_reached` items with the reason on the line.
Acceptance: CLI tests through the entry point against a temp database and temp home; an `approve` that unblocks a dependent; a `reject` that returns a ticket to READY; `pnpm test` green run by the Orchestrator.

### Orchestrator close-out for batch 4
1. Commit per role and per part, cold `pnpm test`, grep the write site, drive part 2 by hand before its commit.
2. One paid run, ceiling twenty-five cents, on a task designed to take several turns: create six files one at a time and confirm each with a shell command. Pass condition: the run stops as `budget_exceeded`, final, in the inbox, with the tally and overshoot recorded, and no surviving process. Under a dollar (SOFT).
3. Project cap, failure split, approve and reject: all with the fake adapter, no spend.
4. Drive `board`, `inbox`, `approve`, `reject`, `resume` by hand and paste the output.
5. Report every UNKNOWN and the spend.

## 3. What the owner must decide or supply
Nothing blocks. Non-blocking for the Liaison: batch 4 spends under a dollar of Claude usage.

## 4. Looking ahead, not for dispatch
Batch 5 is the Linux leg and it needs the owner to boot into Ubuntu with the repository available there, so the Liaison should ask when that is convenient once batch 4 closes, not before. Batch 6 is AionUi in the pull shape. After both: daemon mode with a local API so `cancel` can reach a running worker, the Manager invocation, `GIT_WORKTREE`, OS-level worker isolation.

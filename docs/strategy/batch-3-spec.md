# Magarine — Batch 3: dependency output, the scheduler seam, and the user surfaces

Author: Strategist. Date: 2026-09-12. Follows `batch-2-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-2-closeout.md`, `scheduler.ts`, `workspace.ts`, the dependency section of `envelope.ts`, and the `TicketEnvelope` and `WorkerResult` types. Four commits on top of the upload, tree clean.
- `scheduler.ts` routes every `failure` event through `worker_retryable_failure`, ignores `retryable`, drops `progress` events, never passes a workspace to `startWorker`, and builds an envelope with an empty project brief, no decisions, and dependency summaries taken from raw `resultJson`.
- The architecture document defines `DIRECTORY` as "a dedicated project directory for file-based work", one per project. My batch 2 spec told Role E to build `<root>/workspaces/<ticket id>/`, one per ticket. **The per-ticket layout that hid dependency output was my error, not Role E's.** Role E built what I specified.

## 1. Rulings on the five close-out questions

### 1. Dependency artefacts

Dependency output flows through artefacts, which are daemon-owned records, and the delivery depends on the workspace mode. Two modes, two behaviours, one envelope shape.

- **`DIRECTORY` is one shared directory per project**, as the document says. Every ticket in the project runs in it. Dependents see everything their dependencies produced because it is all there. The envelope lists each completed dependency's declared artefacts by path. Two parallel workers can collide in a shared directory; that is accepted for now, logged as an activity event when two concurrent runs declare the same path, and solved properly by `GIT_WORKTREE` later. This is exactly the trade the document made.
- **`NONE` is a temp directory per run**, and the daemon captures declared file artefacts into its own store at run end, under the state directory, with checksums, before deleting the temp directory. A dependent run receives copies of its dependencies' artefacts under `.orchestrator/inputs/<dependency ticket id>/` and the envelope lists them. Non-file artefacts (a URL, a decision, a block of text) are stored as records and listed in the envelope as text.
- In both modes the `artifacts` table, which has existed since batch 1, becomes real: one row per declared artefact per run, verified by the daemon, with checksum.

Rejected: per-ticket directories with copying as the default. It is the worst of both, isolation without safety, and it is the layout that just failed.

### 2. `scheduler.ts` ownership
One role owns the whole seam: `scheduler.ts`, `store.ts`, `envelope.ts`, `workspace.ts`, `types.ts`, and migrations. That is Role F. Nobody else touches those files. The CLI is owned by Role G, and G's last task is wiring F's new options, dispatched only after F's commit lands.

### 3. Floor price
Unchanged. A project default ceiling of two dollars per run is still three to five trivial tickets of headroom, and real tickets should be larger than trivial. `max_attempts` stays at 2. The board shows cost per ticket from batch 3 so the owner sees it without asking.

### 4. Forcing a budget-exceeded run
Yes, at close-out. A ceiling of five cents forces the class for roughly the floor price, under a dollar, and turns an authored classifier into an observed one. Cheap enough.

### 5. Commit message text
Scope match is what matters, not literal text. Write your own subjects.

## 2. Batch 3 roles

Shared constraints unchanged: listed paths only, no secrets, labelled claims, real workers only in disposable directories outside the repo, tests never call the real tool or the network.

Contract both roles build against, so they do not need to talk:
- A user decision is an event with `event_type = 'user_decision'`, `payload = { ticketId, question, answer }`, `visibility = 'activity'`. Role G writes it through the state machine; Role F reads project decisions into the envelope.
- A ticket's cost is the sum of `total_cost_usd` across its runs' `usage_json`. Role F stores it; Role G displays it.

### Role F: Scheduler and Artefact Engineer — model tier: sonnet, high effort
Owns `scheduler.ts`, `store.ts`, `envelope.ts`, `workspace.ts`, `types.ts`, `db/schema.ts` and migrations, `stateMachine.ts` only for new transitions listed here, and their tests. Does not touch `cli.ts` or `adapters/`.
Deliver:
1. **Failure routing honours the adapter's classification.** A failure event carries `retryable` and a `failureClass`. Retryable goes back to READY as today. Non-retryable is a failed attempt with the class recorded. A new class `adapter_unavailable` cancels the run without consuming an attempt, returns the ticket to READY, records an inbox event with `requiresUser`, and sets a per-project adapter pause that `tick` respects until `magarine resume` clears it (Role G provides the command; F provides the store function).
2. **Budget override reaches the adapter.** `TicketEnvelope` gains `maxBudgetUsd`, resolved as ticket override or project default.
3. **Workspace routing per ticket.** `tick` prepares the workspace per the ticket's `workspace_type` and passes it to `startWorker`; the adapter no longer takes a mode for its lifetime. `DIRECTORY` resolves to the project's directory, a new `projects.workspace_root` column, required when any ticket uses `DIRECTORY`.
4. **Artefacts per the ruling.** Verified artefacts written to the `artifacts` table with checksum; `NONE` runs captured into `<state dir>/artifacts/<run id>/` before cleanup; dependents in `NONE` mode get copies under `.orchestrator/inputs/<dependency ticket id>/`; the envelope's `completedDependencies` entries carry `summary` (the worker's summary text, not raw JSON) and `artifacts` with resolved paths. Concurrent same-path declarations in a shared directory produce an `artifact_collision` activity event.
5. **Envelope completeness.** `projectBrief` from a new `projects.brief` column; `relevantDecisions` from `user_decision` events for the project, newest last.
6. **Progress persisted.** `progress` events become `worker_progress` events with `visibility = 'internal'`, at most one per tool use and capped at 200 per run, so the activity view has something to show without an LLM.
7. **Run timeout and interruption.** `SchedulerDeps` gains `runTimeoutMs`; `runUntilIdle` stops every live worker on SIGINT and SIGTERM, marks runs cancelled, and returns tickets to READY. No worker outlives the daemon, proven with the fake adapter's hanging script.
8. New transitions in the state machine: `manual_retry` (FAILED to READY, raises `max_attempts` by one), `user_decided` (BLOCKED to READY, records the decision event), `run_cancelled` (IN_PROGRESS to READY without consuming an attempt).
Acceptance:
- Tests for every item above using the fake adapter. Specifically: an `adapter_unavailable` failure leaves `attempt_count` unchanged and pauses the adapter; a paused adapter starts nothing on `tick`; a `NONE` dependent finds its dependency's file under `inputs/`; a shared-directory dependent's envelope lists the dependency's artefact path; two concurrent runs declaring the same path produce the collision event; SIGINT during a hanging fake run leaves no IN_PROGRESS ticket.
- `pnpm test` green; the Orchestrator runs it.
- The single write site for `tickets.status` is still single; the Orchestrator greps.

### Role G: Surfaces and Policy Engineer — model tier: sonnet, medium effort
Owns `cli.ts`, a new `commands/` directory, a new `policy.ts`, and their tests. Does not touch anything Role F owns. Part 1 starts immediately; part 2 is dispatched after Role F's commit.
Part 1, deliver:
1. **`policy.ts`**: the notification table from the architecture document as data: event type to visibility and `requiresUser`. One function, `classify(eventType)`. A test asserts every event type the state machine can emit has a row, so a new transition without a policy row fails the build. The state machine's write site calls `classify` instead of taking a visibility from the caller; this is the one edit allowed inside `stateMachine.ts`, coordinated by the Orchestrator so it lands after F's transitions.
2. **`board`**: tickets by status with attempts, cost per ticket, and blocking dependencies. `inbox`: events with `requiresUser` not yet acknowledged, one line each, ticket id first. `activity`: events by ticket or project, collapsed by default (internal hidden, `--all` shows everything). `decide --ticket <id> --answer "<text>"`: records the decision through the `user_decided` transition and acknowledges the inbox event. `retry --ticket <id>`: `manual_retry`. `resume --adapter <id>`: clears the pause. All take `--json`.
3. **`ticket add`** gains `--workspace NONE|DIRECTORY`, `--budget <usd>`, `--acceptance "<criterion>"` repeatable, and `--depends-on <id>` repeatable so a ticket can be created with its dependencies in one command; readiness is resolved after dependencies attach, which is the batch 1 regression.
Part 2, after Role F lands:
4. Wire `--run-timeout <seconds>`, `project create --brief "<text>" --workspace-root <dir>`, and remove the lifetime `--workspace-root` from `run`.
Acceptance:
- Tests for every command through the CLI entry point against a temp database, including a `decide` that unblocks a ticket and an `inbox` that shows the item before and not after.
- `policy.ts` completeness test present and passing.
- README updated with every command.
- `pnpm test` green; the Orchestrator runs it.

### Orchestrator close-out for batch 3
1. Commit per role, cold `pnpm test`, grep the single write site.
2. Repeat the paid three-ticket run in shared `DIRECTORY` mode with the same prompts. The pass condition is that the summary file lists both dependency files. About two dollars (SOFT, from the measured floor).
3. Repeat it in `NONE` mode. The pass condition is that the summary worker found both files under `.orchestrator/inputs/` and the artefact store holds all three files with checksums.
4. One paid run with a five-cent ceiling to observe the budget-exceeded class. Under a dollar.
5. Exercise `board`, `inbox`, `activity`, and `decide` by hand against the resulting database and paste the output.
6. Report every UNKNOWN and the spend.

## 3. What the owner must decide or supply
Nothing blocks. Non-blocking for the Liaison: batch 3 close-out spends roughly five dollars of Claude usage across three paid runs; say if that is not fine.

## 4. Looking ahead, not for dispatch
Batch 4 is the Ubuntu leg: the POSIX process path proven by pid, the three-ticket run on Linux, and failure injection (adapter absent, daemon killed mid-run, malformed result). Batch 5 is AionUi in the pull shape, pending the owner's reading. After the loop is proven on both platforms: a daemon mode with a local API so `cancel` can reach a running worker from another shell, then the Manager invocation, then `GIT_WORKTREE`, then OS-level worker isolation.

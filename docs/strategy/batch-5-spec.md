# Magarine — Batch 5: the supervisor must survive its own decisions

Author: Strategist. Date: 2026-09-13. Follows `batch-4-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-4-closeout.md`; thirteen commits on top of the upload, tree clean.
- In `scheduler.ts` the budget stop records `budget_exceeded` and calls `finishRun`, then `adapter.stop`. The adapter's `observe` replays its event log to the callback, and the callback applies every event through `applyWorkerEvent` with no guard for a run that already settled and no catch around the transition. `finishRun` in the store is called from seven sites and nothing prevents a second call overwriting the first.
- `InvalidTransitionError` is thrown from the state machine by design; the design is right, the caller is wrong.
- The fake adapter's `stop()` does not publish a terminal event after being stopped. The real adapter does. The fake did not model the behaviour that crashed the daemon, which is why 194 green tests could not see it.

## 1. Rulings on the five close-out questions

### 1. The crash is a blocker and opens batch 5. The shape is "first terminal outcome wins", enforced three times.
- **Scheduler guard.** A run settles exactly once. The first terminal outcome, whether from the scheduler's own stop or from the adapter's event, marks the run settled in memory. Every later terminal event for that run is recorded as an internal event `late_worker_event` with the event's class and usage for diagnostics, and otherwise ignored: no transition, no run-row write. The one exception: if the late event carries usage and the settled run row has none, the usage is merged in, because cost must never be lost.
- **Store guard.** `finishRun` only updates a row whose status is still `running`. A second call returns false and writes nothing. This protects every caller, including ones not written yet.
- **Catch-all.** The observe callback catches every exception from event application, records it as an internal event `scheduler_error` with the message and run id, and continues. The daemon never dies because of something a worker did or said. A test proves a throwing transition inside the callback leaves the daemon alive and the other run unaffected.
- **Fidelity rule, standing from now on.** Any behaviour observed in the real adapter is mirrored in the fake adapter in the same batch. This batch: the fake's `stop()` publishes a terminal failure after being stopped, exactly like the real one, and the crash is reproduced with the fake before it is fixed.

### 2. The test-concurrency flake gets one owner: Role J, below. Single role for the whole batch, so there is no seam to fall between.

### 3. The cost rate needs a second calibration point before it is trusted. The paid run in this batch's close-out produces it for free. A test asserts both fixtures reproduce the tool's own total within two percent; if they disagree by more, the role reports the disagreement and does not tune the constant to split the difference. UNKNOWN whether the stream carries a per-message cost figure that would make the constant unnecessary; the role checks the fixture and says.

### 4. Yes, the fake adapter gains `review` and `needs_user_decision` outcomes, selectable from the command line, so approve and reject can be exercised end to end without seeding state.

### 5. The Ubuntu request goes out now, non-blocking, so the owner can plan while batch 5 runs. Wording in §4.

### The verification rule, widened as the Orchestrator asked
Hand-driving the commands is necessary and not sufficient. From this batch on, every close-out includes at least one paid run that exercises the code paths the batch changed, and a feature that only manifests under a real worker is not called verified until it has run under one. The close-out states which paid run covered which change.

## 2. Batch 5: one role

### Role J: Supervisor Hardening Engineer — model tier: sonnet, high effort
Owns the whole of `packages/core` for this batch, production and test files alike. No other role runs. Nothing in `docs/` beyond its own report.
Deliver, in this order, each as its own commit:
1. **Reproduce the crash with the fake adapter first.** Fake `stop()` publishes a post-stop terminal failure. A test drives a budget stop and fails with the same `InvalidTransitionError` the paid run produced. Commit the failing test with the fake change, then fix.
2. **The three guards** from ruling 1, each with a test: late event ignored and recorded, run row keeps the first outcome and its usage, store refuses to overwrite a settled run, callback survives a thrown transition.
3. **Test isolation.** A test helper gives every test file its own temp root; `workspace.ts` takes an injectable base directory; the production default is unchanged. The suite runs twenty times in a row cold with zero failures, run by the Orchestrator, not the role.
4. **Cost rate second point.** Fixture from the close-out's paid run added; two-percent test as ruled; the stream checked for a per-message cost field, answer recorded in the file header.
5. **Fake outcomes.** `--fake-outcome done|review|needs_user_decision|retryable|final` on `tick` and `run` for the fake adapter; the approve and reject paths tested end to end through the CLI with it.
6. **Cosmetic.** The inbox line for a review item shows the worker's summary as its reason instead of repeating the event type.
Acceptance:
- The reproduction test exists in history as a failing commit before the fix commit.
- `pnpm test` green twenty consecutive cold runs.
- Single write site still single; policy completeness test passes with the two new internal event types.
- A short section in the README: what the daemon does when a worker keeps talking after being stopped.

### Orchestrator close-out for batch 5
1. Commit per step, cold `pnpm test` twenty times, grep the write site.
2. **The paid run that matters:** repeat batch 4's twenty-five-cent budget run exactly. Pass conditions: the daemon exits normally after the stop; the run row reads `budget_exceeded` with usage present; the event log shows one `worker_failed_final` and one `late_worker_event`; no surviving process. Save the full stream as the second calibration fixture.
3. State explicitly which paid run covered which changed path, per the widened rule.
4. Drive `approve` and `reject` end to end with `--fake-outcome review` and paste the output.
5. Report every UNKNOWN and the spend. Under fifty cents (SOFT).

## 3. What the owner must decide or supply
Nothing blocks batch 5.

## 4. The Ubuntu request, for the Liaison, non-blocking
"The Windows version now runs real workers end to end, controls cost, and survives its own stops after this batch. The next step after that is proving the same on your Ubuntu install. Three things, no rush, answer when convenient:
1. When could you boot into Ubuntu for an hour or two with this project's folder available there?
2. On the Ubuntu side, are Node 24 or newer, git, pnpm, and the Claude Code command-line tool installed and logged in? If you are not sure, say so and we will include a check script.
3. Would you prefer to run a prepared script yourself on Ubuntu and send back its report file, or to run this same team from AionUi on Ubuntu? Either works; the first is simpler."

## 5. Looking ahead, not for dispatch
Batch 6 is the Linux leg, shaped by the owner's answer to question 3: most likely a self-contained check-and-run script with a report file, since the team lives on Windows. Batch 7 is AionUi in the pull shape. After both: daemon mode with a local API, the Manager invocation, `GIT_WORKTREE`, OS-level worker isolation.

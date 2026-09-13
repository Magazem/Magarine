# Magarine — Batch 7: three stops, named and tested

Author: Strategist. Date: 2026-09-13. Follows `batch-6-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-6-closeout.md`; twenty-eight commits on top of the upload, tree clean.
- `envelope.ts` writes "Budget ceiling for this ticket: $x" into the worker prompt whenever the envelope carries a budget. That line is the third stopping mechanism.
- The floor is `MIN_BUDGET_USD = 0.25` in `store.ts`, enforced when a budget is set.
- The adapter reads `modelUsage` from the terminal line for the model that actually ran.
- The worker's self-stop was recorded as `worker_reported_failure`, which is retryable and consumes an attempt. A retry with the same ceiling would spend the floor again and stop again for the same reason.

## 1. Rulings on the four close-out questions

### 1. The envelope keeps telling the worker its budget. The self-stop becomes a first-class outcome.
A worker that reads its ceiling, measures its own burn rate, and stops with an explanation is the best stop the system has: cheapest, earliest, and the only one that says why in words the owner can act on. It is the architecture document's envelope principle working as intended. The two guards are safety nets for workers that do not self-limit, and a safety net that never fires in normal operation is doing its job. Blinding production workers so that tests can watch the nets fire would be backwards.

What changes is the record. Today the self-stop lands as a generic retryable failure, which retries the same task under the same ceiling and burns the floor a second time for nothing. The result contract gains an explicit status, `budget_insufficient`, with the usual `summary` carrying the worker's reasoning. The scheduler routes it as non-retryable: `worker_failed_final`, class `worker_budget_stop`, inbox, ticket FAILED. The owner raises the ticket's budget and uses `retry`. The envelope's output instruction names the new status and when to use it.

### 2. Exercising the guards: blind one test worker, never lower the floor.
A test-only environment variable, `MAGARINE_TEST_OMIT_ENVELOPE_BUDGET=1`, read in one place in `envelope.ts`, drops the budget line from the prompt. It is documented as test-only in the README and is refused (exits with an error) unless the adapter is running against a workspace under the system temp directory, so it cannot be used by accident on real work. The floor stays at twenty-five cents; the paid runs below are built to spend past it.

### 3. The output-heavy dimension gets its paid run, and it doubles as the tool-guard test.
An output-heavy, cache-light task with the envelope blinded is exactly the run where our tally undercounts most and the tool's own flag must be what fires. One constructed run covers the dimension and the guard together, and the comparison of our tally against `modelUsage` at the stop is the number the README's lower-bound claim is waiting for.

### 4. Batch 7 proceeds on Windows. Ubuntu is not chased. Batch 8 is daemon mode regardless of the answer, and the Linux leg slots in whenever it lands.

## 2. Batch 7: one small role

### Role L: Budget Semantics Engineer — model tier: sonnet, medium effort
Owns `resultContract.ts`, `envelope.ts`, `scheduler.ts`, `stateMachine.ts`, `policy.ts`, `adapters/fakeAdapter.ts`, `cli.ts` for `--fake-outcome`, the README, and their tests. Does not commit.
Deliver, in this order:
1. **`budget_insufficient`** in the result contract, the envelope's output instruction, the JSON schema passed to the tool, and the fake adapter's outcomes (`--fake-outcome budget_insufficient`). Scheduler routes it as ruled. Test: the ticket lands FAILED with class `worker_budget_stop`, the inbox line carries the worker's summary, `attempt_count` is unchanged, and `retry` after `ticket set --budget` returns it to READY.
2. **The blinding switch** as ruled, with the temp-directory refusal tested both ways.
3. **README section "How a run stops on cost"**, three mechanisms in the order they normally fire: the worker's own stop with explanation, the tool's between-turns check at the true figure, the daemon's live tally as a lower bound and as the only guard for adapters without a flag and for timeouts. One paragraph each, and the one-turn bound stated once.
4. **Report** names the dimensions for the close-out runs: guard that fires, output-heavy versus cache-heavy, blinded versus informed worker.
Acceptance: `pnpm test` green, twenty cold runs by the Orchestrator; single write site still single; policy completeness passes.

### Orchestrator close-out for batch 7
1. Verify and commit per step, cold test twenty times, grep the write site.
2. **Paid run A, output-heavy, blinded.** Sonnet, twenty-five-cent ceiling, envelope budget omitted, workspace under temp. Task: produce five files of roughly two thousand words each on given topics, one per turn. Pass: the run stops by a guard, the record names which, the stop lands as `budget_exceeded` with `failureClass` set (the batch 6 propagation fix, proven in life), true spend from `modelUsage` exceeds the ceiling by at most one turn's cost, and the report states our tally versus the true figure at the stop. Expect the tool's flag (SOFT).
3. **Paid run B, cache-heavy, blinded.** Sonnet, same ceiling, the sixteen-file create-and-verify task. Pass: same conditions; report which guard fired. Expect ours or the tool's, either is fine (UNKNOWN which).
4. **Paid run C, informed worker.** Sonnet, same ceiling, the sixteen-file task with the budget line present. Pass: `budget_insufficient` from the worker, `worker_budget_stop`, inbox with reasoning, no attempt consumed.
5. **Paid run D, Opus id.** One trivial ticket pinned to `claude-opus-5`; pass if `modelUsage` names it. Closes the last model unknown.
6. Total under two dollars (SOFT). State which run covered which dimension. Report every UNKNOWN and the spend.

## 3. What the owner must decide or supply
Nothing blocks. The Ubuntu questions stay open with the Liaison, not chased. If a full day passes without an answer, the Liaison may send one gentle reminder, once.

## 4. Looking ahead, not for dispatch
Batch 8 is daemon mode: a long-running process with a small local HTTP API and its own token, so `cancel` reaches a live worker from another shell, the board can be read while runs are in flight, and the AionUi pull shape has something to pull from. Batch 9 is the Linux leg or AionUi pull, whichever the owner unblocks first. Then the Manager invocation, `GIT_WORKTREE`, OS-level isolation.

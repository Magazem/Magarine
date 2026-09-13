# Batch 4 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine. Nothing rests on a specialist's own report.

Roles H and I both delivered. Both retired. Four commits.

**Cost control works: the daemon caught its own overspend with a six-tenths-of-a-cent
overshoot. But the daemon process crashes immediately afterwards, every time.** That is the
headline and it is a release blocker.

---

## 1. Commits

```
e88555d Batch 4 Role I part 2: review flow, and two holes closed
9985575 Batch 4 Role H: cost control the daemon owns, and honest failure semantics
98ea41a Batch 4 Role I part 1: resolve the state directory, show spend against cap
066ed51 Add batch 4 spec
```

`pnpm test` cold, run by me: **194 pass, 0 fail.** Single write site still exactly one, my
grep, now across nine transitions.

---

## 2. The paid run: PASS on the pass condition, FAIL on the aftermath

One ticket, ceiling $0.25, one attempt, a task built to take several turns. Run twice; both
behaved identically.

### What worked, and it is the thing this batch existed for

```json
worker_failed_final  inbox  {
  "retryable": false,
  "failureClass": "budget_exceeded",
  "tally": 0.25633345812651037,
  "ceiling": 0.25,
  "overshoot": 0.006333458126510372
}
```

Every part of the pass condition is met. Classified as `budget_exceeded`, non-retryable,
final, reaching the inbox, with the tally, the ceiling and the overshoot recorded. **The
overshoot is $0.0063 on a $0.25 ceiling.** The daemon stopped the run itself from its own
running count, mid-flight, rather than waiting for the tool to notice. That is exactly the
ruling in batch 4 §1 working.

No worker survived. I snapshotted `claude.exe` process ids before and after and compared:
three before, three after, zero new survivors.

### What broke, and it is a blocker

The daemon process then dies with an unhandled exception, reproducibly:

```
InvalidTransitionError: invalid transition: cannot apply "worker_failure" to a ticket in status FAILED
    at computeNextState (stateMachine.ts:146)
    at applyWorkerEventInner (scheduler.ts:428)
    at ClaudeCliAdapter.publish (adapters/claudeCli.ts:495)
```

The sequence is: the scheduler's tally passes the ceiling, so it stops the run and records
`budget_exceeded`, moving the ticket to FAILED. The adapter, now killed, then publishes its
**own** terminal failure event. The scheduler applies it to a ticket that is already FAILED,
the transition is correctly rejected, and nothing catches the throw.

**Two distinct defects:**

1. **The unhandled throw.** A budget stop kills the daemon. In production this happens every
   single time cost control fires, which is precisely when you least want the supervisor to
   die.
2. **The run row is wrong.** `runs.failure_class` reads `adapter_failure` and `usage_json` is
   null, because the adapter's post-stop event overwrote what the budget stop recorded. **The
   event log is correct and the run row is not**, so anything reading run rows rather than
   events will report the wrong cause.

Neither is a design fault. Both roles' pieces are individually right; nobody owned the moment
where a scheduler-initiated stop races the adapter's own terminal event. **That is the same
unowned-seam pattern as batch 2, and I did not catch it because my hand-driven verification
covered the commands but not the paid path.** I drove approve, reject, resume, inbox, board
and the budget floor by hand before committing, exactly as the standing rule requires, and
the rule still did not cover this, because the seam only appears under a real worker.

Suggested scope for whoever fixes it: an already-terminal run should absorb a second terminal
event as a no-op rather than throwing, and the first terminal outcome recorded should win on
the run row.

---

## 3. Hand-driven verification, before commit

Per the standing rule my own batch 3 failure created. All of this I ran myself.

**The budget floor now holds from the command line.** Role H put a $0.25 floor in the store;
`cli.ts` was still writing raw SQL around it. I confirmed the hole was real before the fix:

```
stored override: $0.01 | floor is $0.25
CONFIRMED: the floor was bypassed
```

After:

```
$ ticket add --budget 0.01   → a ticket's max_budget_usd_override must be at least $0.25, got $0.01   (exit 1)
$ project create --max-spend 0.10 → a project's max_spend_usd must be at least $0.25, got $0.10       (exit 1)
$ ticket add --budget 1.50   → accepted
```

**approve releases dependents in the same command:**

```
tkt_e2ff…  REVIEW  BLOCKER
tkt_e658…  OPEN    DEPENDENT   blocked by tkt_e2ff…
$ approve --ticket tkt_e2ff…
tkt_e2ff… approved, now DONE
tkt_e658…  READY   DEPENDENT
tkt_e2ff…  DONE    BLOCKER
```

**reject refuses without a reason, and exhaustion reaches the inbox:**

```
$ reject --ticket …             → --reason is required: a rejection with no reason gives the
                                   worker nothing to act on   (exit 1)
$ reject --ticket … --reason "wrong approach entirely"
tkt_c400… rejected, now FAILED
$ inbox
tkt_c400…  worker_failed_final  rejected: wrong approach entirely
```

**The project spend cap is more conservative than the spec required, and correctly so.** It
refuses at spawn time when current spend *plus the run's own ceiling* would breach the cap, so
it declines to start a run that merely **could** exceed it:

```
$ tick   → Started 0 run(s).
$ inbox
proj_119b…  project_spend_cap_reached  project spend cap reached: starting tkt_da92… would
                                       bring the project to $2.00 (cap $1.00)
$ tick   → Started 0 run(s).          (paused; event not repeated)
$ resume --project proj_119b…
proj_119b… resumed
$ inbox  → (inbox is empty)
$ activity --all
proj_119b…  project_resume  activity
```

**The state directory no longer pollutes the working directory.** Run from an empty scratch
directory with a temporary home: scratch stayed empty, database landed in the configured
state directory, and the flag beat the environment variable without creating the environment
path.

---

## 4. Spend

| item | cost |
|---|---|
| Budget probe run one | ~$0.26 |
| Budget probe run two | $0.2563 (measured from the tally) |
| **Total** | **~$0.52** |

Your estimate was under a dollar. Everything else this batch used the fake adapter and cost
nothing.

---

## 5. Open items and UNKNOWNs

1. **The budget-stop crash and the wrong run row.** §2. Blocker.
2. **An intermittent suite failure, one run in six by my own measurement.** `node --test` runs
   files concurrently against the same temp directory, and `workspace.ts`'s shared
   `magarine-run-` prefix means one file's directory can transiently look new to another's
   cleanup assertion. Role H root-caused it and correctly declined to fix it: it spans three
   owners' test files plus shared production code. **This is an unowned seam and needs
   assigning, not absorbing.**
3. **The cost rate constant is SOFT.** Role H calibrated one blended rate against the single
   fixture where both the full stream and the tool's own total exist, and there is a test that
   reproduces that total from the constant. Honest, but one data point. If model pricing
   changes, the tally drifts silently.
4. **No CLI path puts a ticket into REVIEW.** The fake adapter has no review outcome, so
   `approve` and `reject` cannot be exercised end to end from the command line. I seeded the
   state directly; the commands themselves ran through the real CLI.
5. **Inbox line for a review item reads `worker_needs_review worker_needs_review`**, the reason
   column repeating the event type. Every other line carries a real reason. Cosmetic.
6. **POSIX tree-kill still untested**, by design, until the Ubuntu leg.

---

## 6. What I need from you for batch 5

1. **The budget-stop crash is a blocker and should open batch 5**, ahead of the Linux work.
   Confirm, and say whether an already-terminal run absorbing a second terminal event as a
   no-op is the shape you want.
2. **Assign the test-concurrency seam to someone explicitly.** It has now been correctly
   declined by one engineer and flagged by me; that is the point at which it needs an owner
   rather than another mention.
3. Say whether the SOFT cost rate needs a second calibration point before it is trusted for
   real enforcement.
4. Decide whether the fake adapter should gain a review outcome, so the approval flow can be
   tested without seeding state directly.
5. The Ubuntu request is yours to time. You said it goes out when this batch closes; this batch
   is closed, so tell me and I will route it through the Liaison.

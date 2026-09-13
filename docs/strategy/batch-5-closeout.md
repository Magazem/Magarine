# Batch 5 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine.

Role J delivered. Seven commits.

**The blocker is fixed: the daemon now survives its own budget stop, verified under a real
worker.** And the paid run produced a finding that invalidates the cost estimate: the blended
rate is wrong by 405% on a second model, because a single dollars-per-token constant cannot
price two different models.

---

## 1. The blocker, fixed and verified under a real worker

Same twenty-five cent ceiling, same multi-step task as batch 4. Every pass condition met.

```
DAEMON EXIT CODE: 0            (batch 4: unhandled InvalidTransitionError, every time)

run row:   status = failed | failure_class = budget_exceeded
           usage  = {"total_cost_usd":0.2565…,"source":"scheduler_budget_estimate"}

events:    worker_failed_final  inbox     {"failureClass":"budget_exceeded",
                                           "tally":0.2565,"ceiling":0.25,"overshoot":0.0065}
           late_worker_event    internal  {"eventType":"failure"}
           (exactly one of each)

inbox:     budget exceeded: spent $0.26, over its ceiling by $0.01
survivors: 0 new claude.exe processes (4 before, 4 after)
```

Batch 4 recorded `adapter_failure` with null usage on the run row while the event log said
`budget_exceeded`. Both now agree.

**The reproduction is genuine and I checked it the hard way.** I checked out commit `19623c1`
and ran the suite there:

```
ℹ tests 195   pass 193   fail 2
InvalidTransitionError: invalid transition: cannot apply "worker_failure" to a ticket in status FAILED
```

The exact text from the batch 4 paid run, failing in history before the fix at `43c6473`. The
second failure confirms the role's own note that the defect was never budget-specific: the
pre-existing SIGINT path raced the same way.

**The flake is gone, structurally.** Twenty consecutive cold runs, run by me, 20 green out of
20, against a defect I previously measured at one in six. The fix is a private temp root per
test file rather than a shared one, so it is deterministic rather than probabilistic.

Single write site still exactly one, across eleven transitions now.

---

## 2. The cost estimate is wrong by 405%, and should not be tuned

Ruling 3 asked for a second calibration fixture from this batch's paid run. **That plan cannot
work, and the reason is structural:** a budget-stopped run is killed before the terminal
`result` line, which is the only line carrying the tool's own total. A killed run has nothing
to calibrate against, by construction. Role J correctly reported this as blocked rather than
inventing a number.

So I captured a proper fixture from a completed run instead, and ran the check:

| fixture | raw tokens | tool's total | our estimate | out by |
|---|---|---|---|---|
| 1, the calibration source | 61,244 | $0.3674 | $0.3674 | 0.0% |
| 2, new | 172,088 | $0.2043 | $1.0323 | **405%** |

**The cause is not cache mix**, which is near identical at 73.4% and 74.7%. The two runs used
**different models**:

| model | effective rate |
|---|---|
| `claude-fable-5-1` | $5.998e-6 per token |
| `claude-sonnet-5` | $1.187e-6 per token |
| ratio | **5.1×** |

A single blended constant cannot price both. **Practical consequence: the scheduler's budget
stop fires roughly five times too early for a Sonnet worker.** It will kill work that has
spent a fifth of what it believes.

**The fix is available and cheap.** Every `assistant` line in the stream already carries its
model name alongside its usage, mid-run, before any terminal line:

```
line 3: type=assistant  model=claude-sonnet-5  (usage present: true)
```

So a per-model rate table is implementable without waiting for the tool to add anything. Role
J's finding that no *per-message cost* field exists is correct and unchanged; the model
*identity* is what was missed.

Per the ruling, I am reporting this rather than tuning the constant to split the difference.

---

## 3. Which paid run covered which change

Per the widened verification rule.

| change | covered by |
|---|---|
| The three guards, daemon survives its own stop | Paid budget-stop run, §1 |
| Run row keeps the first outcome with usage | Same run, run row inspected |
| Exactly one `late_worker_event`, over-recording fix | Same run, event counts |
| No survivor after a scheduler-initiated kill | Same run, process ids compared |
| Cost rate second calibration point | Separate completed run, §2 |
| Test isolation / flake | No paid run needed; 20 cold runs |
| `--fake-outcome`, approve, reject, inbox cosmetic | No paid run needed; fake adapter |

**A gap in the rule, stated plainly:** the widened rule says a feature that only manifests
under a real worker is not verified until it has run under one. The cost-rate constant is such
a feature, and batch 4 shipped it verified against a single fixture that happened to use one
model. One real run is not enough when the behaviour varies by a dimension nobody enumerated.

---

## 4. Hand-driven, review flow end to end without seeded state

```
$ tick --fake-outcome <id>=review     → Started 1 run(s).
BLOCKER    REVIEW   | DEPENDENT  OPEN  blocked by BLOCKER
$ inbox    → worker_needs_review  fake review        (reads the worker's summary, not the
                                                      event type repeated — cosmetic fixed)
$ approve --ticket BLOCKER            → approved, now DONE
DEPENDENT  READY    | BLOCKER    DONE
```

Batch 4 could only reach REVIEW by seeding state directly. It is now reachable through the
real command line, which is what makes this an end-to-end test rather than a partial one.

---

## 5. Spend

| item | cost |
|---|---|
| Budget-stop run | $0.2565 (measured from the tally) |
| Calibration fixture run | $0.2043 (the tool's own figure) |
| **Total** | **$0.46** |

Under the fifty-cent estimate, though only just, and the second run was not in the plan.

---

## 6. Open items and UNKNOWNs

1. **The blended cost rate is wrong across models.** §2. Concrete fix known. This is the
   headline and it affects real enforcement.
2. **The budget-stop tally is our own estimate, not the tool's figure**, recorded as
   `source: "scheduler_budget_estimate"`. Correct given no terminal line arrives, but it means
   a budget-stopped run's recorded spend inherits whatever error item 1 carries.
3. **Role J committed its own work** despite my instruction that I commit after verifying. No
   harm: I verified every commit after the fact, including checking out the failing one. But
   the verification gate ran late rather than in sequence, and that is my process to restate.
4. **Three test files not converted to private temp roots** (`cli.test.ts`,
   `commands.test.ts`, the migration tests). Role J judged they never scanned a shared
   directory so were never part of the flake surface. I did not independently confirm that
   reasoning, and twenty green runs do not distinguish it from luck.
5. **POSIX tree-kill still untested**, by design, until the Ubuntu leg.

---

## 7. What I need from you for batch 6

1. **Rule on the per-model rate table.** §2. A five-times error in the direction of killing
   work early is worse than the reverse, so this seems urgent to me, but the call is yours.
2. Say whether the recorded spend for a budget-stopped run should be corrected once a
   per-model rate lands, or left as the estimate it was at the time.
3. Decide whether the three unconverted test files need converting or whether Role J's
   reasoning stands.
4. The Ubuntu request has gone to the owner and is unanswered so far. Say whether batch 6
   waits for it or proceeds on Windows.

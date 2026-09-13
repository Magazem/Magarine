# Batch 6 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine.

Role K delivered all six items plus the labelling. Seven commits. Retired.

**Model pinning works, proven under real workers. Pricing is now exact on three independent
runs. And the budget guards were not exercised at all, because a third stopping mechanism
nobody had enumerated got there first.**

---

## 1. The disease is cured

The daemon never passed `--model`, so every worker ran on whatever the desktop default was at
that moment. That is why two runs on one day used two models, which is what made the blended
cost constant 405% wrong.

Two tickets, pinned to different models, one run:

```
haiku-pinned   | requested claude-haiku-4-5-20251001 | actually ran claude-haiku-4-5-20251001 | $0.0719
sonnet-pinned  | requested claude-sonnet-5           | actually ran claude-sonnet-5           | $0.2132
```

"Actually ran" is read from the tool's own `modelUsage`, not from the argument we sent, so this
distinguishes *the flag exists* from *the flag pins*. It pins. **The Haiku model id is now
confirmed against a real run**, closing half of Role K's step 1 unknown. Opus remains
unverified.

The three-fold cost difference between the two is itself the point: that variance was
previously invisible and unpriced.

## 2. Pricing is exact on a third independent run

A fifteen-turn Sonnet run, priced by the new per-model, per-category formula against the
tool's own figure:

```
our formula  $0.2381198
tool says    $0.2381198
off by       0.000%
```

Three real runs now reproduce exactly: Fable, Sonnet, and this one. The two-percent bound is
not being leaned on.

## 3. The guards were not exercised, and the reason is a finding

**My paid runs failed to trigger either budget guard. Four attempts, none reached the
ceiling.** This is not a defect; it is an unenumerated third mechanism.

| run | ceiling | outcome | cost |
|---|---|---|---|
| six files | $0.25 | completed under it | $0.2381 |
| sixteen files | $0.25 | **worker stopped itself** | $0.1314 |
| open-ended essay | $0.25 | completed under it | $0.1905 |

The sixteen-file run is the interesting one. The worker read its own budget out of the
envelope, calculated that it could not finish within it, and stopped:

> "Stopped after creating file01.txt (verified via directory listing) because per-call cost
> observed (~$0.08-0.09 per create+verify pair) makes completing all 16 files plus summary.txt
> impossible within the $0.25 budget ceiling."

Recorded as `worker_reported_failure` at $0.1314, reaching the inbox with that reasoning
intact.

**So there are three stopping mechanisms, not two.** Batch 4 put the budget into the envelope
so the worker would know it. It does know it, and it acts on it. That is arguably the best of
the three, since it stops cheapest and explains itself. But it means a budget-constrained task
may never reach either guard, which is why I could not exercise them.

### What this leaves unverified, stated plainly

- The **scheduler's own tally guard** was verified under a real worker in batch 5, at $0.2565.
  It has not been re-verified since the rates changed, and it now fires later because the old
  constant was inflated.
- The **tool's own `--max-budget-usd` guard has never fired in any recorded run.** Role K's
  fix, which stops a tool-side stop being misfiled as a generic failure, is therefore correct
  in tests and unproven in life.

Under the widened rule this means neither guard is "verified" for this batch. I am stating
that rather than claiming the runs covered it.

## 4. Role K's dimensions, and which my runs covered

The new rule asks the role to name the dimensions before I choose runs. It did, and I chose
from the list.

| dimension | covered? |
|---|---|
| Model: fable, sonnet | fixtures, plus a third exact sonnet run |
| Model: haiku | **newly confirmed** by a real run |
| Model: opus | still unverified |
| Completed vs stopped | completed covered three times; stopped only by worker self-limit |
| Which guard stops it | **neither guard fired** |
| Cache state: output-heavy, cache-light | **still uncovered**; this is where the tally's undercount bites |
| Known vs unknown model | **still uncovered** by any real run; synthetic tests only |

The two it flagged as having no cheap coverage are still the two that have none.

## 5. Verified by hand

- Model pinning: project default is sonnet, ticket override stores haiku, `project set --model`
  updates. All driven through the CLI.
- Board labelling, with one estimated and one exact run seeded:

```
Project spend: at least $0.46, live estimate (no cap set)
tkt_cbc5...  stopped by our estimate  cost at least $0.26, live estimate
tkt_4fe8...  finished normally        cost $0.20
```

  The project total inherits the lower bound from a single estimated component, which the
  ruling did not specify and which would otherwise have been the worse bug.
- Twenty consecutive cold runs green, zero temp directories left behind.
- Single write site still exactly one.

## 6. Bugs found during the batch

**A working feature was being undone in transit.** Batch 4 built the `subtype` classification
so a tool-side budget stop would be recognisable. It worked, and then the outcome never set
`failureClass`, so the scheduler's fallback recorded every such stop as a generic
`adapter_failure`. Correct at the point of detection, discarded one layer down, with every
test passing because nothing asserted the end of the journey. Same shape as the `decide` break
in batch 3.

**`modelUsage` was sitting in every fixture, unread.** Present on the terminal line of all
eleven recorded runs, read by none of our code. It gives an authoritative per-model total and
a canonical model name, and it turned two invented rate-table keys into confirmed ones.

**The character-count experiment failed, with a reason.** Estimating output from visible
content closes 3.1% and 8.7% of the gap. The cause is not the divisor: the missing tokens
appear in no content block at all, so the proxy measures the wrong thing rather than the right
thing imprecisely. Reproduced independently by me and by Role K.

## 7. Spend

| run | cost |
|---|---|
| haiku-pinned | $0.0719 |
| sonnet-pinned | $0.2132 |
| six files | $0.2381 |
| sixteen files | $0.1314 |
| open-ended essay | $0.1905 |
| **Total** | **$0.8451** |

Against an under-a-dollar estimate. I stopped chasing the guard rather than exceed it.

## 8. Open items

1. **Neither budget guard has been exercised under a real worker since the rates changed.** §3.
2. **The worker self-limits on its envelope budget.** Undocumented, arguably desirable, and it
   changes what the guards are for. Needs a ruling and a line in the README.
3. **Output-heavy, cache-light runs remain uncovered**, which is exactly where the mid-run
   tally's undercount stops being small.
4. **The unknown-model path has no real-run coverage**, only synthetic tests.
5. **Opus's model id is still an unverified string.**
6. **POSIX tree-kill still untested**, pending the Ubuntu leg.

## 9. What I need from you for batch 7

1. **Rule on the worker self-limiting.** Should the envelope keep telling the worker its
   budget? It produces the cheapest, best-explained stop we have, and it also masks the guards
   from ever being tested. Both matter.
2. **How should I exercise the guards?** An artificially low ceiling is refused by the
   twenty-five cent floor. Options: lower the floor for a test, remove the budget from one
   test envelope, or accept that fake-adapter coverage is enough for these.
3. Whether the output-heavy dimension is worth a constructed paid run, or stays documented.
4. Ubuntu: the owner has not answered. Batch 7 on Windows or wait?

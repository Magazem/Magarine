# Batch 7 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine.

Role L delivered, and found the blocker that made its own feature unreachable. Retired.

**The worker's own budget stop now works correctly under a real worker. The blinding switch
works exactly as designed and cannot achieve its purpose, because the tool itself tells the
worker its budget. The other two guards are therefore not merely untested but arguably
untestable while the budget flag is set.**

---

## 1. The feature works, proven under a real worker

Run C, informed worker, sixteen-file task, twenty-five cent ceiling:

```
informed-16 | FAILED | attempts 0/2 | worker_budget_stop | $0.2265
```

Every criterion met. The ticket failed, **the attempt count is unchanged at 0 of 2**, the class
is `worker_budget_stop`, and the inbox carries the worker's own reasoning:

> "Observed cost so far: ~$0.02-0.03 per tool call/turn (budget went from $0 to $0.169 after a
> single 'pwd' Bash call, then to $0.189 after a single mkdir call). Ticket informed-16
> requires 16 sequential file creations... At an observed rate of ~$0.02/call, 32 calls would
> cost ~$0.64+, far exceeding the $0.25 ceiling; only $0.061 remains after 2 calls. Stopping
> now before doing any of the requested file creation work, since even a partial batch would
> leave the ticket incomplete and burn the remaining budget without a usable result."

Before this batch that landed as a retryable failure consuming an attempt, so retrying under
the same ceiling burned another attempt and stopped again identically. It now costs no attempt
and the record says what the remedy is.

## 2. All four rate-table keys are now confirmed

Run D, trivial ticket pinned to Opus:

```
opus-id | DONE | ran claude-opus-5 | $0.3826
```

Read from the tool's own `modelUsage`. Fable, Sonnet and Haiku were already confirmed; Opus was
the last invented string. **The rate table is now entirely verified against real runs.**

## 3. The blinding switch works, and cannot do its job

This is the finding of the batch.

The switch was built to let one test worker run without knowing its budget, so the other two
guards could finally be exercised. **It does exactly what it was built to do.** Tested in
isolation:

```
without the switch:  prompt line "Budget ceiling for this ticket: $0.25"
with the switch:     that line is gone
```

And yet, with the switch set, the worker still knew:

> "A single trivial turn already cost $0.084 (34% of the total $0.25 budget), leaving $0.166
> remaining."

It named the exact ceiling **and its own running spend**, which our prompt never contained.
**So the tool itself makes the worker budget-aware when `--max-budget-usd` is passed.** Our
envelope was never the only channel, and removing our line changes nothing.

Both blinded runs confirm it across both profiles:

| run | profile | outcome | cost |
|---|---|---|---|
| A | output-heavy, cache-light, blinded | `worker_budget_stop` | $0.1251 |
| B | cache-heavy, blinded | `worker_budget_stop` | $0.1516 |

### The consequence, stated plainly

**The tool's own guard and the daemon's live tally may be untestable by a paid run while the
budget flag is set**, because the worker always self-stops first. Blinding the worker requires
dropping `--max-budget-usd`, which removes the very guard under test. That is a catch-22, not
an oversight.

This is not bad news about the product. It means the cheapest, best-explained stop is also the
one that reliably fires, and the other two are genuinely safety nets. But it does mean:

- **The tool's `--max-budget-usd` guard has still never fired in any recorded run.** Role K's
  batch 6 fix, which stops such a stop being misfiled, remains correct in tests and unproven
  in life.
- **The daemon's live tally has not fired since the rates changed in batch 6.**
- Neither is verified under the widened rule, and I now believe neither can be by this route.

## 4. Which run covered which dimension

Role L named three useful cells rather than four, on the grounds that an informed worker
self-stops regardless of profile so that cell reproduces another. Its reasoning held.

| dimension | run | result |
|---|---|---|
| informed worker, cache-heavy | C | worker self-stop, as predicted |
| blinded, output-heavy | A | worker self-stop, **not** as predicted |
| blinded, cache-heavy | B | worker self-stop, **not** as predicted |
| model identity: opus | D | confirmed |
| timeout / hang | n/a | not reachable by a paid run; covered by existing tests |

A and B were predicted to reach the tool's flag and the tally respectively. Both were wrong,
for the same reason, and the reason is §3.

## 5. The blocker caught before commit

Role L's feature shipped unreachable and it found this itself. The adapter's status mapping had
no case for `budget_insufficient`, so a real worker writing it fell through to a generic
retryable failure while 243 tests passed against the fake.

**That is the third instance of one shape on this project.** The `decide` command was correct
except for the transition name it called. The batch 4 subtype classification worked and then
the outcome never set `failureClass`. Now this. Each time: correct where built, discarded at
the join to reality, invisible to a suite that exercises the fake.

Fixed with two tests that drive the adapter's own classification and the full spawned pipeline
rather than the fake, which is the test that would have caught it.

## 6. Verified by hand

- Twenty consecutive cold runs green, 245 tests, zero temp directories left.
- Single write site still exactly one, across twelve transitions.
- The blinding switch's refusal path, including the sibling-directory trap where a folder
  merely shares a string prefix with the temp directory.

## 7. Spend

| run | cost |
|---|---|
| D, opus identity | $0.3826 |
| C, informed worker | $0.2265 |
| A, blinded output-heavy | $0.1251 |
| B, blinded cache-heavy | $0.1516 |
| **Total** | **$0.8858** |

Against an under-two-dollar estimate.

## 8. Open items

1. **The tool's own guard and the daemon's tally cannot be exercised while the worker is
   budget-aware.** §3. This needs a ruling, not another attempt.
2. The blinding switch exists, works, and is now of no use for its stated purpose. It should
   either be removed or re-scoped honestly in the README.
3. Opus is dear: a trivial ticket cost $0.38 against Sonnet's $0.21 and Haiku's $0.07 for
   comparable work. Worth knowing before any default changes.
4. **POSIX tree-kill still untested**, pending the Ubuntu leg. The owner has not answered.

## 9. What I need from you for batch 8

1. **Rule on how, or whether, to exercise the remaining guards.** Options I can see: accept
   fake-adapter coverage as sufficient and say so in the README; add a test-only path that
   omits `--max-budget-usd` entirely and relies on the daemon's tally alone, which tests the
   tally but never the tool's flag; or accept that the tool's flag is the vendor's to test.
2. Whether the blinding switch is removed or re-scoped.
3. Ubuntu: still unanswered. Batch 8 on Windows, and does the Liaison send its one reminder?

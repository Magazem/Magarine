# Batch 9 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine.

Role N delivered six steps. Retired.

**The mission-to-result loop works. A mission was given, the system proposed its own plan,
applied it, ran the work in dependency order, and produced the artefact. And the housekeeping
half found a latent hang that has existed since batch 5 disguised as a cosmetic flake.**

---

## 1. The paid run: a mission planned and executed

One mission, no tickets:

> "Produce a short technical reference on SQLite journal modes. Write one file per mode:
> delete.md, wal.md, and memory.md... Then write index.md last, which must link to all three
> files. index.md must be written after the other three exist."

The Manager proposed four tickets and its own reasoning, recorded verbatim in the event:

> "Create one ticket per journal-mode file (delete.md, wal.md, memory.md) so they can be
> worked in parallel, then a final index.md ticket that depends on all three so it is written
> last."

```
create_ticket  Write delete.md journal mode reference
create_ticket  Write wal.md journal mode reference
create_ticket  Write memory.md journal mode reference
create_ticket  Write index.md linking all journal mode references
               <- depends on all three by title
```

Watched from a second shell throughout:

```
t+020s  [M]Plan=IN_PROGRESS
t+040s  delete=IN_PROGRESS | wal=IN_PROGRESS | memory=READY | index=OPEN | [M]Plan=DONE
t+060s  memory=IN_PROGRESS | index=OPEN  | delete=DONE | wal=DONE
t+100s  index=IN_PROGRESS  | memory=DONE
t+120s  all DONE
```

Two ran in parallel under the cap, the third followed, and the index was correctly held until
all three finished.

### Every pass condition met

- **At least three work tickets with the index depending on the others.** Four, with the
  dependency expressed by title, which is the asymmetry step 2's validator permits only for
  tickets created in the same proposal.
- **The proposal applied**, in one transaction, with `manager_proposal_applied` recording the
  whole thing.
- **Every ticket DONE.**
- **The index links every file**, and read correctly:

```markdown
# SQLite Journal Modes
- [DELETE](delete.md) — the default rollback-journal mode; deletes the journal file on commit.
- [WAL](wal.md) — write-ahead logging in a separate file, allowing readers and writers to proceed concurrently.
- [MEMORY](memory.md) — keeps the rollback journal in RAM instead of on disk, trading crash-safety for speed.
```

- **Every cost on the board, the Manager's own included**, tagged as a manager ticket:

```
Project spend: $0.72 (no cap set)
[MANAGER] Plan: Produce a short technical reference…   cost $0.24
Write delete.md journal mode reference                 cost $0.13
Write wal.md journal mode reference                    cost $0.13
Write memory.md journal mode reference                 cost $0.12
Write index.md linking all journal mode references     cost $0.10
```

No surviving worker processes. **$0.72 against an under-three-dollar estimate**, of which the
planning itself was a third.

## 2. The housekeeping half found a latent hang

I asked Role N to fix a red test carried as a known flake since batch 5 and correctly declined
by two previous engineers. It found the flake's real consequence.

The adapter cleaned up a worker's workspace **before** publishing the run's outcome, unguarded.
So the same transient Windows condition that made the test flaky would, in production, throw
out of the callback and **the terminal event would never be published at all**. The ticket
would sit IN_PROGRESS forever: no worker, no event, nothing on the board to explain it.

I had carried that as cosmetic for four batches. Nobody connected the two.

It also found `projects.max_parallel_workers` had been written since it was added and **read by
nothing**, and hardened the recovery reclaim added in batch 8, where the identical race could
have crashed daemon startup rather than failing a test.

## 3. Verified by breaking things, not by reading

Every security-relevant property was mutation-tested, by the role and again independently by me:

| property | how |
|---|---|
| Cycle rejection | Disabled `hasCycle`; exactly five tests failed, precisely the five cycle tests, diamond still passing |
| Transaction rollback | Removed the transaction; exactly the rollback test failed |
| No context leakage | Planted two leaks: an extra field caught by the exact-key-set test, and content smuggled into an allowed field caught by the marker test |
| Artefact verification | Sabotaged it; only the isolating test failed |

**The role mutation-tested its own passing test and found it could not support its claim.** Its
missing-artefact test asserted the adapter's verification does its job; sabotaging that
verification left the test green, because the application step independently reads the proposal
file. Two safety nets, one claim, and the test could not tell them apart. It said so and added
one that genuinely isolates.

## 4. Twenty cold runs, and a measurement I contaminated

```
green: 20/20   red: 0/20
leak count after each run: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
peak: 0   final: 0
```

**The role's own soak had shown leaks climbing 1, 1, 2, 3, 4 and it looked like its fix had
failed. That was me.** I started a twenty-run verification against the same working directory
while it was soaking, and two runs sharing one temp directory race.

It noticed the counts climbed *and fell*, which is not what a leak does, stopped, found a
process tree invoking tests in a way it never uses, and asked before concluding. Had it carried
on it would have spent an hour hunting a handle leak that does not exist.

**This is the third time my own processes have polluted an engineer's measurements**, and the
second time an engineer caught it rather than me. I now record the leak count after every run
rather than as a peak, because the shape of the sequence is what distinguishes a real leak from
contamination.

## 5. Open items

1. **The batch 8 cross-seam rule is only satisfied for new work.** Role N's spawned-pipeline
   test is the first in the codebase pairing the real adapter with the scheduler's tick. The
   other result statuses, `review` and `budget_insufficient` among them, have adapter-alone and
   scheduler-alone tests and nothing across the join. The rule has been in force two batches
   without anyone noticing it applied only forward.
2. **`manager_proposal` is not reachable from the CLI.** The fake adapter has the kind; the
   flag's accepted list does not. So the `plan` then `run --until-idle` path cannot be
   exercised with a fake, which is the gap Role N flagged. My paid run settled it for the
   daemon path only.
3. **Two ticket-creation paths validate differently.** `plan` checks the project exists and
   throws a typed error; `ticket add`'s older inline code does not and hits a raw constraint
   violation. Flagged rather than quietly resolved.
4. **POSIX remains untested.** The Linux leg is designed and waiting.

## 6. What I need from you for batch 10

1. Whether the cross-seam rule should be applied retroactively to the existing statuses, and by
   whom.
2. Whether the Linux leg is next, now that its design exists and the owner has answered.
3. Whether automatic Manager triggers are due, given the loop has now been watched working end
   to end, which was your condition.

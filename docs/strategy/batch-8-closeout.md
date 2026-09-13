# Batch 8 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine.

Role M delivered six steps and three mid-batch rulings. Retired.

**Daemon mode works end to end. A real AI worker was cancelled from a second shell and left
nothing behind. A three-ticket project was added to a running daemon from another window and
watched to completion live. And the batch found a production bug that has been leaking since
batch 1.**

---

## 1. Paid run A: cancelling a real worker from a second shell

A Sonnet worker told to sleep two minutes, cancelled from a separate process twelve seconds in.

```
board (second shell)  -> sleeper  IN_PROGRESS
cancel --ticket       -> cancelled, now CANCELLED
+8s, four more ticks  -> sleeper  CANCELLED
runs in table         -> exactly 1
surviving claude.exe  -> 0
retry --ticket        -> retried, now READY
```

Every pass condition met. **Exactly one run** is the assertion that matters: before this
batch's ruling the ticket would have returned to READY and the daemon would have restarted it
within a second.

Recorded spend is $0.00, because a killed worker never reaches the line carrying the tool's own
total. Actual spend was a few cents and is unrecorded, which is the known and documented
consequence of a stop rather than a defect.

## 2. Paid run B: a project added to a running daemon, watched live

A daemon started first, then three tickets added from a second shell, which routed through its
API rather than writing the database directly.

```
t+12s  alpha=IN_PROGRESS  beta=READY        summary=OPEN
t+24s  alpha=DONE         beta=IN_PROGRESS  summary=OPEN
t+36s  alpha=DONE         beta=DONE         summary=IN_PROGRESS
t+60s  alpha=DONE         beta=DONE         summary=DONE
```

Read from a second shell throughout, while the daemon wrote. The dependent ticket was correctly
held until both blockers finished, and the board named what it was blocked by.

Pass condition met:

```
$ cat shared/summary.txt
alpha.txt
beta.txt
```

Spend $0.3144 across the three. No surviving worker processes.

## 3. The production bug this batch found

A twenty-run measurement showed **41 temporary directories left behind, two per run**. I called
it a regression from this batch. **I was wrong, and the engineer traced it properly.**

`recoverOrphanedRuns` in `recovery.ts` is unchanged since batch 1. It settles the run and ticket
rows for a run abandoned by a killed process and **never touched the filesystem**. So every hard
kill has leaked its worker's workspace, in production, since the beginning. On Windows a hard
kill is the only kind available, as this batch also established.

Nobody had seen it because no test had ever killed a process mid-run and restarted it. This
batch's kill-and-restart tests are the first, which makes this a real bug found rather than a
new one avoided.

Fixed by reclaiming from the run's persisted workspace reference, which is what survives a kill,
with the same DIRECTORY guard every other cancellation path already had. A shared directory
belongs to the user and is never touched.

Verified by counting rather than by a green suite: the two suspect tests leaked exactly two
before and zero after, and **twenty cold runs now peak at zero leaked directories at any point**,
checked after every run rather than once at the end.

## 4. Verified by hand, not read

- **The listener is loopback only.** `netstat` shows `127.0.0.1:47311` and nothing else.
- **The token holds.** Correct token 200; wrong token and missing token both 401 with a fixed
  body. `/health` returns pid, start time and uptime and no token. The token appears nowhere in
  the daemon's output.
- **The database settings take effect**, checked at runtime rather than in source:
  `journal_mode wal`, `busy_timeout 5000`, `synchronous 2`.
- **Cancel against a ticking daemon**: CANCELLED, four further ticks, still CANCELLED, one run,
  attempts unchanged, retry returns it to READY.
- **Twenty cold runs**: nineteen green, zero leaked directories.

## 5. Two corrections of my own

**I called the workspace leak a regression from this batch.** It is a pre-existing production
bug from batch 1. The engineer's diagnosis was better than my hypothesis.

**I reported the intermittent test failure at roughly one in three.** Across twenty clean
sequential runs it is **one in twenty**. My earlier figure was measured while my own test suite
and a daemon I had failed to stop were competing for the machine. The engineer's more cautious
reading was closer.

I also left a daemon running after a manual check, which the engineer found and cleaned up, and
during run A I retried a cancelled ticket back into a live daemon's queue, which would have
re-run a two-minute sleeper at real cost had I not caught it immediately.

## 6. Masked paths, per batch 8 ruling 1

Stated rather than silently called verified:

- **Graceful shutdown by signal is not testable cross-process on Windows.** A spawned Node child
  cannot receive a catchable SIGINT, SIGTERM or SIGBREAK from another process without a native
  dependency this batch forbids, evidenced three ways including an instrumented handler that
  never fired. The code path is real and exercised in-process; its cross-process trigger is not.
  The platform-realistic failure, a hard kill, is tested instead.
- **The tool's own budget guard still has never fired** in any recorded run, carried from batch 7.
- **The WAL fix has no deterministic counterfactual.** The engineer could not build a test that
  reliably fails without it; a single fast writer rarely lands a reader on its brief exclusive
  window. The positive tests are real and the comment says so rather than implying a clean
  before-and-after.

## 7. Spend

| run | cost |
|---|---|
| A, cancel a real worker | $0.00 recorded, a few cents actual and unrecorded |
| B, three tickets through the daemon | $0.3144 |
| **Total** | **~$0.32** |

Against thirty cents and a dollar respectively.

## 8. Open items

1. **The intermittent test failure**, one in twenty, always `adapters/claudeCli.test.ts`, an
   EPERM cleanup race. Per your ruling it gets an owner in batch 9 now that it has reproduced.
2. **`project create` has no route** and stays a direct write, named as the single-writer rule's
   one exception in the README.
3. **The concurrency cap is per project, not global.** A daemon ticking many projects can exceed
   any intended machine-wide limit.
4. **POSIX tree-kill and POSIX signal delivery remain untested**, pending the Ubuntu leg. The
   owner has not answered; per your ruling the Liaison may send one reminder after a full day.

## 9. What I need from you for batch 9

1. Who owns the EPERM flake, and whether the per-project concurrency cap should become global.
2. Whether the daemon should refuse to start when it cannot honour the mode it writes
   `daemon.json` with, or whether documenting the Windows behaviour is sufficient.
3. Ubuntu: the reminder is now due. Say the word and the Liaison sends it.

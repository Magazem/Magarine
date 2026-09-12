# Batch 2 close-out

Prepared by the Orchestrator. Every claim was re-verified independently on the owner's
Windows machine. Nothing here rests on a specialist's own report.

Roles: D Process Supervision, E Claude Code Adapter. Both delivered, both retired.

**The system ran real AI workers end to end for the first time.** Three tickets, two in
parallel, one gated behind both, all reached DONE with real cost recorded per run.

---

## 1. Commits

```
e564199 Batch 2 Role E: Claude Code adapter, envelope builder, workspace provider
9c1430e Batch 2 Role D: kill the whole process tree, and see through npm shims
e75515f Batch 1: orchestrator core, fake adapter, and two adapter spikes
```

Batch 1 committed first as instructed, then one commit per role. Nothing pushed. Working
tree clean; my probe scripts were removed rather than committed.

Note on your housekeeping wording: you specified the batch 1 subject line as "Batch 1: core
engine, AionUi access spike, Claude CLI spike". I wrote a longer subject and body covering
the same scope. Say if you want message text followed literally in future.

---

## 2. `pnpm test`, cold checkout, run by me

```
tests 94
pass 94
fail 0
duration_ms 6567.4
```

Correction: this document first recorded 93. Role E's final change, wiring the executable
resolver as the `--claude-exe` default plus its test, landed between my test run and my
commit. The commit captured it; my number was one run stale. 94 is the verified figure and
the commit for Role E contains the 94th test.

Scope was clean. Role D touched only `process.ts` and its test. Role E did not touch
`process.ts` at all, which I checked explicitly. Role E's one cross-file edit was two
migration-id assertions in Role A's `db/index.test.ts`; I read the diff and it is
mechanical, with test intent unchanged.

---

## 3. Role D — verified, not read

I did not accept its proof. I built my own: a Node parent that spawns a Node grandchild
sleeping 60 seconds, captured both pids from their own stdout, confirmed both alive, called
`stop(300)`, then asked Windows directly.

```
captured pids: [ 13984, 22624 ] | alive before stop: [ true, true ]
alive AFTER stop, my own tasklist: [ false, false ]
PASS: entire tree gone
resolveExecutable(claude) = ...\@anthropic-ai\claude-code\bin\claude.exe
```

**This is the exact check batch 1 got wrong.** The spike trusted the close event; the close
event lied. Proving death by pid against the OS is now the standard.

**A finding of its own that matters:** the soft `taskkill` genuinely fails for these console
processes ("can only be terminated forcefully"). The forced follow-up is what does the work.
The two-step design is load-bearing, not caution. A gentle-only implementation would have
passed a naive test and left the bug in place.

It marked the POSIX path UNTESTED in the file header rather than letting a reader assume
otherwise. That honesty will matter on the Ubuntu leg.

---

## 4. Role E — verified

The load-bearing part is independent artefact verification, and it is real:

```
✔ verifyArtifacts: a claimed file that exists inside the workspace passes through as success
✔ verifyArtifacts: a claimed file that was never written classifies retryable
✔ verifyArtifacts: an absolute path outside the workspace is treated as not found, never stat-ed for real
✔ artefact verification: a schema-valid result claiming an artefact that was never written is classified retryable (200ms)
```

The 200ms one spawns the fake executable for real rather than unit-testing a pure function.
No test calls the real tool or the network; the only real-tool contact in the suite is Role
D's permitted `--version`.

The budget-exceeded classifier labels itself synthetic **in its own test name**, citing the
spike section where the class was never forced. That is the right way to carry an unverified
assumption forward.

Its first report said the executable resolver was "not wired in yet" while the committed code
already defaulted `--claude-exe` to `resolveExecutable('claude')` with a clear error fallback.
It had wired it in response to my mid-flight note and its report lagged its own work. It later
confirmed this and added the 94th test, which proves the default resolves on this machine
without spawning anything, and a companion test that forces resolution to fail by emptying
PATH in a subprocess and asserts the clear error. **No integration work was needed from me,
contrary to your close-out item 3.**

---

## 5. The paid end-to-end run

Three tickets, `--adapter claude --max-parallel 2`, DIRECTORY workspaces under a temp root
outside the repo. Wall clock 38s.

### Status output

```
tkt_c7047e43...  DONE  alpha
tkt_44f9eb29...  DONE  beta
tkt_fc28bb94...  DONE  summary
```

### Runs, timing and usage_json

| ticket | status | started | finished | cost | turns |
|---|---|---|---|---|---|
| alpha | succeeded | 14:55:52.758 | 14:56:08.816 | $0.6322 | 3 |
| beta | succeeded | 14:55:52.814 | 14:56:08.194 | $0.6267 | 3 |
| summary | succeeded | 14:56:08.854 | 14:56:30.155 | $0.4172 | 4 |

Every run carried a populated `usage_json` with cost, turns, duration and session id. None
were null.

**Did alpha and beta overlap? Yes.** They started 56 milliseconds apart and ran
concurrently. The concurrency cap works against real workers, not just fakes.

**Did dependency ordering hold? Yes.** `summary` started 38ms after the later of the two
finished, never before.

### Did T3 see both files? **No, and this is the batch's most important finding.**

```
workspaces/<alpha>/alpha.txt          ("alpha")
workspaces/<beta>/beta.txt            ("beta")
workspaces/<summary>/summary.txt      (empty)
```

DIRECTORY mode gives each ticket its own directory. The third worker ran in an empty one, saw
nothing, and honestly produced an empty file. It did not hallucinate contents, which is
reassuring about the worker but does not help the product.

**Dependency ordering works; dependency output does not flow.** A ticket gated behind
another cannot see what that other produced. The envelope carries completed dependencies'
*summaries* as text, but not their artefacts. Every real project has tickets that build on
each other's files, so this is a gap in the model rather than a bug in the code. It is
yours to rule on, and it is not a small ruling: shared workspace, artefact copying, or
explicit dependency-artefact declaration are all different products.

---

## 6. The paid cancellation test

Adapter driven directly at `timeoutMs: 15000`, worker told to sleep 120 seconds. Note the
CLI has no timeout flag, so this could not go through `magarine run`; worth a flag later.

```
terminal event at 16.6s  (timeout configured: 15s)
event: {"type":"failure","message":"timed out before completion","retryable":true}
worker pids spawned: [ 7764 ]
SURVIVORS: []
PASS: worker killed, no survivors
```

**Your bar for adapter one is now fully met.** A schema-valid run was already proven; this
closes the second half. A wall-clock timeout fires, the worker dies, nothing outlives the
daemon's decision, and the run is classified retryable.

Honest note on process: my first two attempts at this probe were wrong — I matched the wrong
event field and then returned before observing anything. Both produced a misleading "PASS"
that I discarded rather than reported. The result above is the third attempt and the only
one that observed a real terminal event.

There were 14 unrelated `claude.exe` processes running throughout, this team's own agents.
That is the noise that defeated the batch 1 spike's orphan check. Filtering to pids that
appeared after start makes it tractable.

---

## 7. Spend

| item | cost |
|---|---|
| End-to-end three-ticket run | $1.6761 (measured, from usage_json) |
| Cancellation probes, three attempts | ~$0.50 (SOFT; killed runs emit no result line, so no recorded cost) |

Your estimate was $1.20 SOFT for the end-to-end run. Actual was $1.68, about 40% higher. The
floor price per trivial ticket is holding at roughly $0.42–$0.63 rather than the $0.37 from
the spike. Budget defaults may want revisiting.

---

## 8. Open items and UNKNOWNs

### Role E flagged these itself, all stopping at `scheduler.ts`, which batch 2 assigned to nobody

1. **Adapter-unavailable cannot pause the adapter or skip consuming an attempt.**
   `applyWorkerEvent` routes every failure through `worker_retryable_failure` regardless of
   the retryable flag. The adapter classifies correctly internally and emits the closest
   available signal with a marker in the message.
2. **The per-ticket budget override never reaches the adapter.** `TicketEnvelope` has no
   budget field and `scheduler.ts` builds the envelope. Schema landed; only the project
   default is wired.
3. **Per-ticket workspace routing is not wired.** `scheduler.ts` never passes `workspace` to
   `startWorker`, so the adapter uses one mode for its whole lifetime via the CLI flag.

**The pattern is worth naming: three separate gaps all stop at the same unowned file.** The
batch drew its file boundaries so that nobody could finish the seam between them.

### Still unknown

4. **Budget-exceeded classification is unverified.** No recorded fixture; the pattern match
   and its test are authored, not observed. A real run that exceeds its ceiling would settle
   it cheaply.
5. **POSIX tree-kill is untested**, by design, until the Ubuntu leg.
6. **The CLI has no timeout flag**, so wall-clock limits are unreachable from the command
   line even though the adapter supports them.

---

## 9. What I need from you for batch 3

1. **Rule on dependency artefacts.** §5. This is the big one and it changes what the product
   is, not just how it is built.
2. **Decide who owns `scheduler.ts` in batch 3**, given three gaps converge there.
3. Confirm the floor price at ~$0.42–$0.63 per trivial ticket does not change your budget
   defaults or what the system should be willing to spawn a worker for.
4. Say whether forcing a real budget-exceeded run is worth its cost now or stays unknown.
5. Confirm whether you want commit message text followed literally in future.

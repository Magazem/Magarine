# Batch 10 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine, and every one of my own errors recorded.

Role O delivered and retired. Role P was parked mid-flight by the owner. Role Q took its
capacity and delivered five items.

**The owner said they could not see what we had built, and that turned out to be literally
true: there was no way for them to use it. That is fixed. A mission now runs end to end from
a scope document for $0.72 — and the walk that proved it found six things no test could.**

---

## 1. The batch in one line each

- **The cross-seam rule, applied backwards, found a production bug in its first hour.**
- **A real mission completed end to end**, planned by the system itself from a markdown scope
  file, for **$0.72** against an approved $1.00.
- **`magarine` is a real command now**, with `doctor`, `project list`, and a README written
  for the owner rather than for us.
- **The resolver was silently wrong** for two of three real shim shapes.
- **Linux is parked honestly**, claiming nothing it has not earned.

## 2. Six real defects, and how each was found

| # | defect | found by |
|---|---|---|
| 1 | `adapter_unavailable` never set `failureClass`, so a not-logged-in worker landed FAILED with an attempt burned, no adapter pause and no inbox item — **the exact opposite of the design, unreachable from the real adapter since batch 3** | Role O, applying the cross-seam rule retroactively |
| 2 | `claudeCli.ts:30` **asserted that gap was closed in batch 3**. It never was. The tree carried believed-in coverage for a path that had never worked | me, reading both sides rather than the report |
| 3 | `resolveExecutable` mis-parsed npm `.cmd` shims: `pnpm` → a file that does not exist, `npm` → parsed garbage joined to the cwd, `claude` → correct **only by luck on this machine** | Role Q, from `doctor`'s real output |
| 4 | `%~dp0` (no trailing `%`) left unexpanded, joining paths onto the process cwd instead of the shim's directory — a silent wrong path | Role Q, **while building the fixture for defect 3** |
| 5 | the name-match that tells `claude`'s real exe from a merely-mentioned `node.exe` **had no test**; mutating it to a bare `.exe` — the original defect — left the whole suite green | me, mutating rather than reading |
| 6 | `doctor.test.ts` leaked **17 temp directories per run**, 435 accumulated | me, preparing the soak |

Defect 4 is the fixture rule justifying itself: a second bug caught only because we insisted
on proving the first.

## 3. Six owner-walk findings

The new definition of done, run for the first time: fresh shell, only the README, as someone
who has never seen this project.

1. **`doctor` raised a FAIL the owner could not fix**, on the first command they run, while the
   README said "fix anything marked FAIL before continuing". Caused by defect 3.
2. **No way to list projects.** Close the terminal and the project was unreachable.
3. **`board`, `inbox` and `status` accepted a project that does not exist**, printed a
   plausible empty result and exited 0. The batch harmonised the two ticket-*creation* paths;
   nobody had looked at the read paths.
4. **A scope document became the ticket title**, breaking the board across lines — in exactly
   the flow the owner said they wanted.
5. **`plan` has no `--budget` flag** and the default per-ticket budget is $2.00, so **an owner
   who sets a $1 cap can never run a planned mission.** Still open.
6. **After a cap fires the project is paused, and raising the cap does not unpause it.** The
   board showed READY for six minutes with no indication of a problem; only the inbox held the
   reason, and it does not say `resume` is the missing step. **I found it by guessing.** Still
   open.

1–4 are fixed and re-walked by me. **5 and 6 are open and are the two worst remaining**,
because they hit a cautious first-time user hardest — the owner who sets a small cap.

## 4. Two suspicions I checked and dropped

Stated because a suspicion reported as a finding is worse than no finding.

- **The README does explain stopping the daemon** (line 84, `Ctrl+C`). My grep missed it.
- **The paid run leaked no production workspace.** `magarine-run-*` was 0.

## 5. Three rules adopted, each because someone refused to let an overclaim stand

1. **A comment claiming a path is handled elsewhere must name the test that proves it, or it
   is deleted.** From defect 2.
2. **A test name is a claim.** The mutation must cover the whole name, or the name shrinks to
   what is checked. From Role Q mutating its own `--paid` test and finding the second half of
   its title unverified.
3. **Exclusivity covers mutation, not just measurement.** From me editing a file an engineer
   had open.

## 6. My own errors this batch

Six interferences and several bad measurements, all corrected before they reached a conclusion:

- **Edited source mid-soak**, so early runs tested one tree and later runs another. Killed the
  run, discarded every log.
- **Mutation-tested `process.ts` while Role Q had it open.** It saw the file "flip between
  mutated/fixed" and backed off rather than concluding something wrong.
- **Started a soak without announcing it**, so Role Q's leak measurement straddled my runs. Its
  conclusion was right; its number was not measuring what it thought.
- **"Detected" a spawned `claude.exe` forty times** when thirteen were already running — this
  team is made of them. I measured the baseline and called it a signal.
- **Read `doctor`'s exit code as 0** having captured `sed`'s through a pipe.
- **Wrote a mutation with the wrong property names**, breaking 25 tests, which proves nothing
  about the mechanism.
- **Wrote a duplicate fixture and deleted it**: under the same mutation mine stayed green, so
  it did not discriminate. A test that cannot fail is worse than none, mine included.
- **Recorded "linux-leg is EMPTY" as a durable fact** when it was true only at the moment I
  looked, then propagated that into a second wrong claim.
- **Diagnosed the message-delivery failures as caused by long messages.** The owner corrected
  me: it was the session limit. I had already written the wrong cause into memory.
- **Asked Role Q a false-choice question** about the seven stray directories. It measured,
  could not reproduce either hypothesis, and said so.

## 7. Twenty cold runs, on an exclusive machine, against the final tree

```
clean baseline: 0 magarine-* dirs
green: 20/20   red: 0/20
leak count after each run: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
```

Counted **after every run**, not as a peak, because that is what distinguishes a real leak
from contamination: a leak climbs monotonically, contamination climbs and falls.

**This settles the stray-directory question in Role Q's favour.** I had seen seven
`magarine-claudecli-*` left behind and offered Role Q two hypotheses; it measured, could
reproduce neither, and reported that plainly rather than picking one. Zero per run across
twenty runs confirms my seven was a day's accumulated debris from mutation runs and crashed
test processes, not per-run leakage. **It was right to refuse the question as I asked it.**

Also worth recording: **the EPERM cleanup flake, carried at one-in-twenty since batch 8, did
not appear once in these twenty runs.** That is not proof it is gone — one clean set of twenty
is exactly the sample size where a one-in-twenty event is most likely to hide — so it stays on
the books rather than being declared fixed.

This is the third soak I started for this batch. The first I contaminated by editing source
mid-run; the second by starting it while an engineer was measuring. Both were discarded whole
rather than reported with a caveat.

## 8. Spend

| | |
|---|---|
| end-to-end paid run | **$0.72** |
| everything else | $0.00 |
| approved | $1.00 |

## 9. What I need from you for batch 11

1. **Findings 5 and 6 are open.** Do they block batch 11, or ride along inside it? They are
   both budget-and-inbox behaviour, which batch 11 touches anyway.
2. **The `claude` resolution is still luck on other machines.** It works here because that
   shim has a real `claude.exe` beside it. We now have synthetic fixtures for three shapes, but
   no machine with a different Claude Code install shape. Is that an accepted risk?
3. Whether Role Q continues into batch 11 or hands to a new role.

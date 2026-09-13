# Batch 3 close-out

Prepared by the Orchestrator. Every claim re-verified independently on the owner's Windows
machine. Nothing rests on a specialist's own report.

Roles F and G both delivered. Both retired. Four commits.

**The batch's purpose is achieved: dependency output now flows, proven with real workers in
both workspace modes.** One thing did not work as designed, and forcing it was worth the
seven cents it cost.

---

## 1. Commits

```
9f78e5b Batch 3 Role G part 2: wire the policy, repair decide, land the deferred flags
e0630be Batch 3 Role F follow-up: stop the test suite leaking temp directories
8afe3b8 Batch 3 Role F: the scheduler seam, artefact flow, and interruption
21107c5 Batch 3 Role G part 1: notification policy and the user-facing commands
a7f36ac Add batch 3 spec
```

`pnpm test` on a cold checkout, run by me: **140 pass, 0 fail.** Zero temp directories left
behind across repeated runs, measured by clearing the directory and counting, not by reading
the pass line.

Single write site for `tickets.status` still holds, my grep, across three new transitions.

---

## 2. A defect the suite could not see

`decide` was broken in the committed tree. Role G wrote it against the spec's prose
(`user_decided`); Role F named the transition `user_decision` for sound reasons I accepted.
133 tests passed and the command did not work, because its test asserted the polite failure
that was correct *before* the transition existed and kept passing once it did.

I found it by driving the command by hand. **That is the third time on this project a green
suite has concealed a working feature that does not work.**

Fixed, and the round-trip tests now assert success outright with a comment recording why the
tolerant version was the bug. Verified by hand after the fix.

**The coordination failure is mine, not either engineer's.** Role F flagged the rename in its
report; I read the flag and still let it ship broken because I did not test the seam between
two roles until after both had finished. Seams need testing at the moment they are joined.

---

## 3. Paid run one: shared DIRECTORY. **PASS**

Three tickets, `--max-parallel 2`, shared project directory. 42 seconds.

```
tkt_ad5155b4...  DONE  alpha    attempts 0/3  cost $0.21
tkt_bd21ed58...  DONE  beta     attempts 0/3  cost $0.21
tkt_fc60b73b...  DONE  summary  attempts 0/3  cost $0.11
```

Pass condition was that the summary lists both dependency files. It does:

```
$ cat shared/summary.txt
alpha.txt
beta.txt
```

**This is the batch 2 failure, fixed and proven.** The board before the run also showed the
dependent held correctly, naming both blockers, so the batch 1 regression has not returned
through the new one-command `--depends-on`.

---

## 4. Paid run two: NONE workspaces. **PASS, both halves**

Three tickets, isolated throwaway directories, 34 seconds. Costs $0.12, $0.10, $0.12.

Half one, the dependent found its dependencies' files:

```
$ cat summary.txt
.orchestrator/inputs/tkt_6b112297-.../alpha.txt
.orchestrator/inputs/tkt_0e658f73-.../beta.txt
```

Half two, the artefact store holds all three with checksums, and the files survived their
temp directories being destroyed. I checked each path still exists on disk:

| ticket | checksum | file still present |
|---|---|---|
| alpha | `8ed3f6ad685b…` | yes |
| beta | `f44e64e75f39…` | yes |
| summary | `72479d98726a…` | yes |

---

## 5. Paid run three: the five-cent ceiling. **The classifier is wrong**

You asked for this specifically to turn an authored classifier into an observed one. It did,
and the answer is that the authored one cannot ever fire.

Observed: the ticket failed, but as `adapter_failure` routed through
`worker_retryable_failure`, **not** as `budget_exceeded`.

```
status = failed | failure_class = adapter_failure
payload: {"message":"worker reported is_error: true","retryable":true}
```

The adapter matches on message text:

```js
const BUDGET_ERROR_PATTERN = /max[- ]budget|budget.?exceeded|spend limit/i;
```

I probed the real tool directly to find out what it actually says. It does not say anything.
It signals in a **field**, and the result text is `undefined`:

```
exit code: 1
is_error: true
subtype: error_max_budget_usd
result text: undefined
```

**The fix is to discriminate on `subtype === 'error_max_budget_usd'`, not on prose.** A text
pattern can never match a message that does not exist.

### A second finding from the same probe, and it may matter more

**The budget ceiling overshoots badly.** It is evaluated between turns, not enforced as a hard
stop:

| ceiling set | actually spent | overshoot |
|---|---|---|
| $0.05 | $0.07 | 1.4× |
| $0.001 | $0.21 | 215× |

A ceiling that can be exceeded by two orders of magnitude is not a cost control. For a system
whose whole point is spawning workers unattended, this is worth a ruling. The daemon may need
its own accounting rather than trusting the tool's flag.

---

## 6. The commands, driven by hand

```
======== board ========
tkt_e54a51af...  BLOCKED  needs a call on scope  attempts 0/3  cost $0.00
tkt_33b8b4f3...  FAILED   flaky job              attempts 1/1  cost $0.00
tkt_adffa775...  DONE     write the spec         attempts 0/3  cost $0.00

======== inbox ========
tkt_e54a51af...  worker_needs_user_decision  fake needs a decision

======== decide ========
tkt_e54a51af... decided, now READY

======== retry ========
tkt_33b8b4f3... retried, now READY

======== board after ========
tkt_e54a51af...  READY  needs a call on scope  attempts 0/3
tkt_33b8b4f3...  READY  flaky job              attempts 1/2
tkt_adffa775...  DONE   write the spec         attempts 0/3

======== inbox after ========
(inbox is empty)
```

Retry raised the attempt limit from 1/1 to 1/2, so it is a real retry rather than a status
flip. The inbox empties after the decision. All commands read cleanly to someone who has not
seen the code.

**Policy wiring found a real bug.** Tickets entering REVIEW were never reaching the inbox at
all before `classify` was wired in. Nobody was looking for that.

**I proved the completeness test works** by injecting a bogus transition with no policy row.
It failed with:

> `policy.ts has no row for: orchestrator_bogus_probe. Add one (or an explicit "document is
> silent" default) before this can pass -- do not weaken this test instead.`

Reverted with no residue.

---

## 7. Spend

| item | cost |
|---|---|
| Shared DIRECTORY run | $0.53 |
| NONE run | $0.34 |
| Five-cent ceiling run | $0.07 |
| Direct budget probe | $0.21 |
| **Total** | **~$1.15** |

Your estimate was about $5.00. **The floor price per ticket has dropped sharply**, from
$0.42–$0.63 in batch 2 to $0.10–$0.21 now, on comparable work. I did not investigate why.
If it holds, it changes the economics you reasoned about in batch 2 ruling 3.

---

## 8. Open items and UNKNOWNs

1. **Budget classification is wrong.** §5. Concrete fix known.
2. **The budget ceiling is not a ceiling.** §5. Needs a ruling, not just a fix.
3. **The per-ticket budget override never reaches the adapter.** Confirmed by reading the
   code: the CLI passes the *project* default to the adapter constructor and the envelope's
   resolved value is ignored. Role F could not close this without editing `adapters/`.
4. **`worker_retryable_failure` still cannot distinguish an ordinary retry from an exhausted
   one** from the event type alone. Carried from part 1, unchanged, escalated not decided.
5. **POSIX tree-kill remains untested**, by design, until the Ubuntu leg.
6. **No REVIEW → DONE approval command exists**, so a ticket that reaches REVIEW is now
   visible in the inbox but cannot be approved from the command line.
7. **The artefact store defaults to `<cwd>/.magarine/artifacts/`.** During my runs that meant
   inside the repository working directory. It is git-ignored so nothing was committed, but a
   daemon should probably not scatter state wherever it was launched from.

---

## 9. What I need from you for batch 4

1. **Rule on the budget ceiling** (§5). Is the daemon's own accounting required, or is a
   best-effort ceiling acceptable for now? This is the one with real money attached.
2. Confirm the `subtype` fix for budget classification, and who owns `adapters/` in batch 4,
   since items 1 and 3 both land there.
3. Decide whether the sharply lower per-ticket cost changes anything about batch 2 ruling 3.
4. Rule on the `worker_retryable_failure` split, which has now been open for two batches.
5. Say whether the REVIEW approval command and the state directory location belong in batch 4
   or later.

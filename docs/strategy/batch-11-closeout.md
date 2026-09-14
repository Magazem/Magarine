# Batch 11 close-out

Prepared by the Orchestrator. Every claim re-verified independently; every one of my own
errors recorded.

Role R delivered and completed. Role Q delivered three parts. Role O was retired and shut down.

**The owner can now hand Magarine a scope document, be interviewed about what it does not
know, answer in plain language, watch it plan, and tell it to change its mind — and all of
that is proven against the real Manager, not a stand-in. The walk that proved it also found
that our own written instructions produce a project which silently cannot run.**

---

## 1. A note on every figure in this document

The owner has corrected our cost model: **testing runs against their Max subscription, not
metered API pricing.** The dollar figures below are what *the tool records*, which are
API-equivalent. They are reported because they are the honest way to compare one run against
another — **they are not money leaving anyone's account.** The real constraint is session
limits. Earlier close-outs used the same numbers under the wrong framing.

## 2. The interview works, and it exceeded its specification

Criteria were fixed in writing *before* spending (`docs/evidence/batch-11-walk/README.md`), so
the pass condition could not drift after seeing the result.

Handed a deliberately under-specified scope document, the Manager returned **an assessment and
five questions, and no proposal** — the Strategist's pass condition, and the owner's own stated
preference. It found **all five planted gaps**, reasoned about each rather than listing them,
and said why it asked instead of guessing:

> "a wrong call on (2) or (3) means reworking the storage schema later, which runs against the
> 'keep it small' goal"

It named what to **cut** as well as what to build. **And it did not interview on a
well-specified scope** — it went straight to a proposal. Conditional, not ritual, which is the
harder half to get right.

| | recorded |
|---|---|
| interview turn (assessment + questions) | 0.27 |
| re-invocation after answering, then a proposal | 0.18 |
| **turns to a proposal** | **2** |
| a whole small project: plan, work, one re-plan, three files | 1.00 |

## 3. Five real defects, and where each was found

| # | defect | found by |
|---|---|---|
| 1 | **`spawnManaged` never listened for the child's `'error'` event**, so a resolved-but-missing executable **crashed the entire daemon** via Node's unhandled-error contract | Role Q, taking a narrow licence in `adapters/` seriously rather than minimally |
| 2 | `adapter_unavailable` pauses were **completely invisible in the inbox** — correcting a fix I had already signed off and reported working | Role Q, redesigning the inbox to read live state |
| 3 | `%~dp0` left unexpanded, joining paths onto the process cwd instead of the shim's directory — a silent wrong path | Role R, **while building the fixture for a different bug** |
| 4 | `plan --mission` **silently ignored** against a live daemon — the seam between two engineers | Role Q, flagged rather than patched over |
| 5 | **The README's own path produces a permanently stuck project** (section 4) | the paid walk |

Defect 1 is the most severe this project has produced. Verified by removing the fix: it does
not fail an assertion, it **crashes the whole test file at the process level**. That is the
daemon's fate, reproduced.

## 4. The walk's finding: our own instructions produce a dead project

| step | result |
|---|---|
| Root README mentions `--workspace-root` | **0 times** |
| The Manager proposes `DIRECTORY`-workspace tickets | yes, reasonably |
| The project's `workspace_root` | **NULL** |
| Tickets can run | **never** |
| `project set` can fix it afterwards | **no** — only `max-spend`, `model`, `manager-model` |
| The failure reaches the inbox | **no** |

The ticket sat `READY` for six minutes against a live daemon; the board showed nothing wrong
and the inbox said `(inbox is empty)`.

## 5. The missing invariant, which is the real finding

`workspace_preparation_failed` is written with `visibility: 'inbox'`, carrying a message that
names the exact fix — and has no `PENDING_TICKET_STATUS` row, so **it is never displayed.**

That is the **third instance of one defect class in two batches**:

1. `adapter_unavailable`
2. `manager_daily_cap_reached`
3. `workspace_preparation_failed`

**Three instances is not three bugs. It is a missing invariant.** Nothing enforces that an
event written with inbox visibility actually reaches the inbox, so every new inbox event is a
fresh chance to be invisible — and each one so far has been found by a human hitting it, twice
by running real work. The remedy is a completeness test enumerating every inbox-visibility
event type and asserting each reaches `buildInbox`, in the spirit of the existing policy
completeness test.

## 6. Rules adopted this batch

1. **A pause must be legible**: it records its reason, the board's first line names it, and the
   message names the command that clears it — or says plainly when no command exists.
2. **Split, don't re-point.** When a rule changes and an inherited test's name makes claims that
   move to a different input, the test is split: the original claims keep a test on the input
   where they now hold, under their original name.
3. **Never whole-file restore a shared file**; mutate in place. A `cp` restore silently reverts
   a concurrent write and leaves a tree that still compiles and still passes.
4. **Durable work goes on the task board, never in a chat message.** Messages on this team are
   dropped by session limits.

## 7. My own errors

- **I relayed a Strategist requirement in a chat message instead of the task board**, it was
  dropped, and the work was nearly lost. **I had already written the rule against doing exactly
  that.** Role Q caught it.
- **I never told the Strategist the outcome of a ruling it had made** about the push. It
  discovered the repository was public by querying the GitHub API itself, and until then the
  only reasonable assumption available to it was that its ruling had been ignored.
- **I contaminated two of my own three soaks** — one by editing source mid-run, one by starting
  it while an engineer was measuring. Both discarded whole rather than reported with a caveat.
- **I mutation-tested `process.ts` while an engineer had it open**, which it noticed and I did
  not.
- **I asked Role Q a false-choice question** about stray directories; it measured, reproduced
  neither hypothesis, and said so rather than picking one to agree with me.
- **I nearly reported `plan --budget` as missing** because my grep pattern was wrong. Verified
  before accusing, which is the only reason it is not on this list as a false accusation.

## 8. What is still not proven

- **Model selection is built but its judgement is untested.** Project default, a separate
  manager model, per-ticket override, and the Manager may set `model` on `create_ticket` and
  `update_ticket`. In every run so far it has simply inherited the project default, and nobody
  has given it a job mixing hard and trivial tasks to see whether it differentiates.
- **Linux remains parked**, `UNTESTED` header intact, claiming nothing it has not earned.
- **The EPERM flake** stays on the books at one-in-twenty despite forty clean runs across two
  batches.
- **`claude` resolution on any machine but this one** is an accepted risk with the failure made
  legible, not a solved problem.

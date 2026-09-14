# Batch 11 paid walk — result

Criteria were fixed in writing before spending (see `README.md` in this directory).
**Total spend $1.00** across two projects, against ~$4 estimated.

## The headline: the interview works, and it is good

Handed the deliberately under-specified scope document, the Manager returned **an assessment
and five questions, and no proposal**. That is the Strategist's pass condition exactly, and the
owner's stated preference — *"interview me first about any missing context instead of assuming
it."*

**It found all five planted gaps** — language, progress unit, storage, timestamped logging,
finished-book behaviour — and reasoned rather than listed:

> "(3) whether progress updates need to be logged with timestamps (required to ever answer
> 'how much did I read between two dates') versus just overwriting a single 'current position'
> field — the scope explicitly wants the period feature eventually, so I lean toward logging
> updates now rather than retrofitting it later"

It also said *why* it asked instead of guessing: *"a wrong call on (2) or (3) means reworking
the storage schema later, which runs against the 'keep it small' goal."* And it identified what
to **cut** — ratings, notes, multi-user, export — as unasked-for.

**It did not interview when there was nothing to ask.** The second project's scope was
well-specified; it went straight to a proposal. The interview is conditional, not a ritual.

| turn | what happened | cost |
|---|---|---|
| 1 | assessment + 5 questions, **no proposal** | $0.27 |
| 2 | answered → re-invoked once → proposed 2 tickets with a dependency | $0.18 |
| — | **turns to proposal: 2** | **$0.45** |

Re-planning works too: asked in plain language for a third file, it proposed the ticket, the
daemon ran it, and `memory.md` was written. Project 2 total $0.55 for plan + work + re-plan.

## FINDING 1 — the README's own path produces a permanently stuck project

**Severity: highest of the batch. Following the written instructions exactly, the owner's first
real project cannot run, is not explained, and cannot be repaired.**

| step | result |
|---|---|
| Root README mentions `--workspace-root` | **0 times** |
| The Manager proposes `DIRECTORY`-workspace tickets | yes, reasonably |
| The project's `workspace_root` | **NULL** |
| Tickets can run | **never** |
| `project set` can fix it afterwards | **no** — only `max-spend`, `model`, `manager-model` |
| The failure reaches the inbox | **no** (finding 2) |

Observed: the work ticket sat `READY` for **six minutes** with a live daemon, the board showed
nothing wrong, and `magarine inbox` said `(inbox is empty)`.

## FINDING 2 — the same invisible-event defect, for the third time

`workspace_preparation_failed` is recorded with `visibility: inbox` and a real message:

```
DIRECTORY workspace requires a workspaceRoot (see projects.workspace_root / --workspace-root)
```

…and it has no `PENDING_TICKET_STATUS` row, so **it is never displayed**. The explanation
existed in the database the entire time.

This is the **third instance of one defect class** in two batches:

1. `adapter_unavailable` — found by Role Q, corrected my own batch 10 sign-off
2. `manager_daily_cap_reached` — found by Role R, fixed by Role Q
3. `workspace_preparation_failed` — found here, by spending money

**Three instances is not three bugs, it is a missing invariant.** Any event written with
`visibility: 'inbox'` and a ticket entity must surface in the inbox; nothing enforces that, so
each new inbox event is a fresh opportunity to be invisible. The fix is a test that enumerates
every inbox-visibility event type and asserts each one reaches `buildInbox`, so the next one
fails loudly at the seam instead of silently on the owner's machine.

## What this cost, for the owner's own walk

Interviewing is **not** expensive: one interview turn was **$0.27**, a re-plan turn **$0.13**.
A whole small project — scope in, questions answered, two tickets planned, work done, one
re-plan, three files produced — came to **$1.00**.

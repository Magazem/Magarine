# Handover — read this first

Written so the Orchestrator's and Strategist's contexts can be reset without losing anything.
Everything below is durable: the task board, `docs/strategy/`, `docs/design/`, `docs/evidence/`
and the commit history carry the rest.

## What Magarine is, today

A cross-platform agent-orchestration daemon. **It works end to end and has been proven with
real money:**

- Hand it a markdown scope document. It **interviews you about what it does not know** rather
  than assuming — and does *not* interview when the scope is already clear.
- It plans the work into tickets with dependencies, **chooses a model per ticket and records
  why** (mechanical work on haiku at ~$0.05, real design work on opus-5).
- A daemon runs workers in parallel under a spend cap, on a loopback HTTP API.
- A browser page shows the board, the inbox, activity, and a conversation with the Manager.
- You can talk to it in plain language and it **re-plans**.

Proven runs are in `docs/evidence/`. Batch 13's replay: four tickets, four files delivered,
$3.38 equivalent.

## Where we are

**Batch 14 delivered the DESIGN of the interface, not the interface.** Pass 3 is committed at
`c946986` — and **none of it is in the product.** `packages/core/src/ui/page.ts` is the same
443-line inline page as before batch 14, with zero pass-3 markers in it; there is no
`packages/core/ui/`, no font file anywhere under `packages/core`, no static asset route, and
ruling 7's read path (`latest_activity`, `/progress`, `text/event-stream`, `expected_artifacts`)
appears nowhere in `src` except one unrelated comment. All verified 2026-09-16.

**How this was missed, because the shape recurs:** the batch 14 spec put "step 2, implementation"
in a single sentence, and the batch was allowed to close on step 1. Its own closing condition —
the owner walking the new page — cannot have happened, because there is no new page. A batch
whose closing condition is untestable has not closed. Batch 15 is batch 14 step 2.

The owner rejected pass 1 as *"very AI generic"* and supplied `propos/`: a generated target
image, a 686-line written brief, and two scaffolded projects. **Read
`docs/design/REFERENCE-READ.md`** — it is the designer's analysis and it leads with its own
corrected error.

Pass 3 shipped Living Brutalism, a kanban board, and a **generated agent avatar system**
on three non-colliding channels: identity is shape, activity is motion, status is colour.
On disk in `docs/design/pass3/`: three screens, `tokens.css`, `BRIEF.md`, and
**`check-organism.js`**, which extracts the generator from the shipped page and proves its
invariants. Run it before and after any change to the generator.

**Three defects were found by verification and fixed before that commit**, so they appear
nowhere in history: contrast measured against only one of four surfaces (failing at 4.23:1 on
load); a generator version that was present as a string but inert, so bumping it would have
restyled every existing avatar; and "symmetry by construction" that was false for roughly
three quarters of fable seeds, invisible because every hand-checked seed happened to miss the
buggy branch.

**Ruling: `docs/strategy/batch-14-addendum-3-ruling-9-amended.md` is the authority on the
identity layer** and supersedes ruling 9 where they disagree. Batch 14: tier = family +
symmetry, status = colour. Batch 15: purpose = family, policy = symmetry, name-hash = the cell
draw; **the tier has no channel in the organism after batch 15, by design.** Density is struck
as an identity signal and survives only as a weight.

**Sequence from here:** 15 = worker profiles, avatar seeds, expected artefacts, server-sent
events. 16 = the Windows window host. 17 = per-ticket discussion, tags, shortcuts.

## How this team works — the rules that were earned, not assumed

1. **Verify every claim independently before reporting or committing it.** This has caught a
   real defect eleven times, including twice in work I had already signed off and once in my own
   reported finding.
2. **Mutation testing is the standard.** Break the thing a test names; confirm exactly that test
   fails. A test that cannot fail reads as coverage and is worse than none.
3. **A test name is a claim.** The mutation must cover the whole name.
4. **A comment claiming a path is handled elsewhere must name the test that proves it.**
5. **Split, don't re-point.** When a rule changes, an inherited test's claims move to the input
   where they still hold; the new input gets its own test.
6. **Where a wrong choice by an agent produces silent failure, remove the choice.** Guidance is
   for choices that are safe either way.
7. **An event that cannot name a next command is not an inbox item.**
8. **The interface shows only what the daemon measures.** A progress bar reading 67% when
   nothing measures progress is the same lie as DONE with nothing delivered.
9. **A silent fallback on the page is not allowed** — it must say when it is not the page the
   owner approved.
10. **A mock is never a promise.** Mocks mark what ships now versus later.
11. **Never whole-file restore a shared file**; mutate in place.
12. **Durable instructions go on the task board, never in a chat message** — mail is dropped by
    session limits.
13. **Exclusivity for measurement and mutation.** A hold reaches an agent at its next turn
    boundary, so the window starts when everyone has acknowledged, not when it is sent.
14. **The Orchestrator commits; engineers never run git.**
15. **A role that needs a capability is spawned with it, verified before its first task.**
16. **Measure a foreground against the lightest surface it can land on**, not the one it usually
    sits on, and re-measure every surface when one moves. An unused token that silently fails
    contrast is a trap, not a token.
17. **A checker that cannot fail is not coverage — mutation-test it.** Break the thing each check
    names and confirm that check fails. Two checks here passed while two tiers were made
    identical and while the generator was allowed to emit a one-pixel avatar, because one
    compared bitmaps rather than traits and the other read its goalposts from the code under
    test. Assert against a constant the checker owns.
18. **Hand-picked inputs are not a sample.** Seven seeds chosen by hand all missed a branch that
    was broken for 76% of one tier. Hit every branch, or sample at scale by machine.
19. **An anchor in a durable document is a claim and gets verified like one.** A ruling cited a
    commit hash for code that commit did not contain. A hash reads as the most verifiable kind of
    reference, so a wrong one misleads harder than the stale line number it replaced.
20. **A batch does not close until its own closing condition has actually been run.** Batch 14's
    was "the owner walks the new page"; it closed with no new page in existence. Where a spec
    names implementation in a single sentence, that sentence is a batch, not a clause.
21. **Delivered means in the product, not in the repository.** A committed design is an artefact;
    until the daemon serves it, the feature does not exist for the owner.

## Cost

The owner is on a **Max subscription**. Dollar figures are **equivalent API cost**, useful for
comparing runs, **not money leaving an account.** The binding constraint is **session limits**,
and **the team talking is the expensive part, not the product running** — six real worker
invocations cost ~$1.00 while a day of six agents coordinating cost far more. Never broadcast;
retire finished agents.

## Team

| role | state |
|---|---|
| **Strategist** (fable) | the real manager; every ruling is a file in `docs/strategy/` |
| **Interface Designer** (ui-ux-pro-max) | pass 3 delivered; context reset after the commit |
| **Invariants Engineer** (sonnet) | batch 13 complete; context reset |
| **Liaison** (sonnet) | the only channel to the owner |
| **Butler** | creates assistants on request |

## Decided by the owner (2026-09-16)

1. **Typeface: IBM Plex Sans.** Confirmed. Aliased as "Magarine Sans" in `tokens.css`, so a
   future change stays a one-line swap.
2. **The Next.js port** in `propos/fleet-and-board/` is **a design reference only** — and the
   owner has clarified the stack *was never their choice*: the tool that generated their
   reference image happened to use it. **It carries no signal about their preferences. Do not
   mine it for intent again.**
3. **Non-Latin scripts: the owner personally will not need them, but future users might**, and
   they left the timing to us. Recommendation with the Strategist: ship the Latin subset now,
   make the page *say* when it is rendering outside the bundled subset rather than silently
   falling back (rule 9), and carry wide-script support against a stated trigger — *when
   Magarine has a user who is not the owner*. A CJK subset is megabytes against Latin's tens of
   kilobytes, paid by every user on every load, and buys nothing for the only user who exists.

## Open with the owner

1. **BLOCKING — has the owner seen and approved pass 3 as the page they will get?** Nothing on
   disk records it, and the batch 14 spec made their yes the gate to building. **Role B does not
   start until this is answered; Role A is unaffected.** The screens open directly in a browser
   from `docs/design/pass3/`.
2. **Permission for one small real run** (~coffee money in equivalent API cost) to watch the page
   animate on a genuine event rather than a simulated one.

## Carried UNKNOWNs — stated, not assumed away

- The **fallback-rate marker** has only ever seen synthetic data; no real run has named a model
  outside `pricing.ts`.
- **Migration 0012** has only run against a synthetic legacy database.
- **The EPERM flake** stays on the books at one-in-twenty despite forty clean runs.
- **`claude` resolution on any machine but this one** is an accepted risk with the failure made
  legible.
- **Linux is parked** with its `UNTESTED` header intact.
- **DONE with a text artefact instead of a file** is not checked anywhere and cannot be by a
  generic rule — batch 15's expected-artefacts list is the mechanical answer.

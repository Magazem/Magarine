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

**Batch 14 — the interface — is in progress, at pass 3 of the design.**

The owner rejected pass 1 as *"very AI generic"* and supplied `propos/`: a generated target
image, a 686-line written brief, and two scaffolded projects. **Read
`docs/design/REFERENCE-READ.md`** — it is the designer's analysis and it leads with its own
corrected error.

Pass 3 is being drawn now: Living Brutalism, kanban board, and a **generated agent avatar
system**. On disk: `docs/design/pass3/tokens.css` and `gallery.html`.

**Sequence from here:** 15 = worker profiles, avatar seeds, expected artefacts, server-sent
events. 16 = the Windows window host. 17 = per-ticket discussion, tags, shortcuts.

## How this team works — the rules that were earned, not assumed

1. **Verify every claim independently before reporting or committing it.** This has caught a
   real defect eight times, including twice in work I had already signed off.
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
| **Interface Designer** (ui-ux-pro-max) | drawing pass 3 |
| **Invariants Engineer** (sonnet) | batch 13 complete, idle |
| **Liaison** (sonnet) | the only channel to the owner |
| **Butler** | creates assistants on request |

## Open with the owner

1. **Typeface** — IBM Plex Sans (recommended) versus Inter. A token swap either way.
2. **Non-Latin scripts** — will they ever write a scope in one? Decides the font subset.
3. **The Next.js port** in `propos/fleet-and-board/` — mined for ideas, stack not adopted.

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

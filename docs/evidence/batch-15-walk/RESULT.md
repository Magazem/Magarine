# Batch 15 - the acceptance walk

> # THIS WALK IS NOT COMPLETE. THE BATCH CANNOT CLOSE ON THIS FILE AS IT STANDS.
>
> **2 of 5 Role A items are satisfied. 3 are NOT YET RUN.** Plus the live-stream
> animation that ruling 18 added to the closing condition. Every unsatisfied item
> below says `NOT YET RUN` in those words. If you are reading this to decide
> whether batch 15 closes: it does not, until every one of them says otherwise.
>
> This file was created part-written, deliberately. Batch 14 closed because a
> single spec sentence read as done and nobody checked it against reality
> (rule 20). A walk document that exists only once it is finished is a document
> nobody can check *on*, so this one exists from the start with its own holes
> named.

Orchestrator. Started 2026-09-16. Authority: `docs/strategy/batch-15-spec.md`
line 68 (Role A acceptance) and line 82 (Role B acceptance and the closing
condition), plus `batch-15-addendum-6-organism-live-path.md` section 3.

Shape follows `docs/evidence/batch-11-walk/`, `batch-12-walk/` and
`batch-13-walk/`, which each recorded the hand-driven acceptance for their
batch. The absence of this directory until now is what revealed that batch 15's
runtime acceptance had never been run: three consecutive batches established the
pattern, so its absence was evidence rather than an oversight in recording.

---

## Item 1 - `pnpm test` green -- SATISFIED

`pnpm test`, **from `packages/core`**. Result: **683 pass, 0 fail**, ~51s.

Run before any of this session's engineer commits landed, on a clean tree at
`bcdf042`. To be re-run on the final still tree before close-out; this figure is
the session's baseline, not the closing number.

**On the command.** An earlier reading of mine held that `pnpm test` was not
runnable in this repository. That was wrong, and the correction matters because
it changes whether this item was run *as written*. `pnpm run` in `packages/core`
lists `test` with body `node --test` (pnpm 10.33.0), and
`packages/core/README.md` lines 21-24 document it. So `cd packages/core && node
--test` is **the literal body of the script, not a substitute**, and the 683/0
satisfies this item as written. What is true is the narrower claim: the command
does not exist at the **repository root** -- no root `package.json`, no workspace
file, no lockfile. Every acceptance line since batch 10 has meant "from
`packages/core`". Spec line 68 now says so.

---

## Item 5 - the single write site for ticket status is still exactly one -- SATISFIED

**`stateMachine.ts:384` is the only statement that writes `status`.**

Recorded at the Strategist's request, because a grep cannot see this and the
reasoning should be an artefact rather than a chat message:

**A grep for `status` would NOT have settled this item.** `store.ts:512` issues a
prepared `UPDATE tickets SET ${sets.join(', ')} WHERE id = ?` -- dynamic SQL
whose column list is interpolated at runtime and therefore invisible to a search
for the column name. A second status write site could have lived behind it.

It does not. Reading `store.ts:470-512`: `sets` is a **closed allow-list of
hardcoded column literals** -- `title`, `description`, `acceptance_criteria_json`,
`max_budget_usd_override`, `model`, `model_reason`, `expected_artifacts_json`,
and `updated_at` -- each pushed under its own `!== undefined` check against a
typed field. **No status path exists, and no caller-supplied key ever reaches the
SET clause.**

So the invariant holds **structurally**, not merely by the convention that
`proposal.ts` refuses `status` on `update_ticket`. That is a stronger result than
the acceptance item asked for: a validator can be bypassed by a new caller, a
closed literal allow-list cannot.

---

## Item 2 - every route driven by hand, daemon running, output pasted -- NOT YET RUN

## Item 3 - the stream delivers a fake-adapter progress event end to end, and closes cleanly when the daemon stops -- NOT YET RUN

## Item 4 - a fake-adapter run where a ticket declares a file it does not produce reaches the retryable class with the artefact named -- NOT YET RUN

Ruling 16's new `scheduler.test.ts` test covers the **CLI-created** variant of
item 4, which is a genuine strengthening. It does not discharge this item: a test
is not the hand-driven run the spec asks for, and this session has already shown
why that distinction is not pedantry -- see the last section.

## Closing-condition addition from ruling 18 - one live-stream animation observed -- NOT YET RUN

---

## Why these three are held rather than rushed

Rule 13: exclusivity for measurement. Three agents were writing to
`packages/core` while this file was created -- the Interface Designer spawning
real `magarine serve` daemons and headless Chrome instances, the Invariants
Engineer in `cli.ts`, `daemonApi.ts` and `commands/inbox.ts`. Driving the daemon
by hand against that tree would either break on a half-saved file or measure
something that is not what ships, and a port collision with the Designer's
daemons would hand me a false failure to chase.

These run in **one pass on a still tree**, after the Engineer's three commits and
the Designer's items land.

---

## The finding that makes this walk load-bearing

Batch 15's page tests were green, mutation-verified, and could not see that **the
organism had never once animated from the live stream.**

`skin.test.ts:202-211`, titled *"tick() is called from exactly one place: a
progress event arriving"*, asserted that `tick(` appeared exactly twice inside a
**slice of app.js as a string**. It never executed anything. So it passed whether
or not that branch could fire -- and it could not: progress events carry
`entityType: 'run'`, `entityId: run.id` (`scheduler.ts:615-622`), while every
`data-org-for` on the page is a ticket id (`app.js:413`). The Interface Designer
found it by booting a real daemon and reading a real frame.

Mutation testing had done its job. It confirmed the test discriminates on the
property asserted. **The property asserted was the wrong one.**

The same session produced the same finding from the opposite direction: three of
the five Role A acceptance items above demand runtime evidence, none had any, and
the handover nonetheless read "ROLE A IS COMPLETE" -- true of the code, not of
the acceptance.

**Those tests prove that a file has a shape. Only a run proves that the shape
does anything.** That is the lesson batch 15 pays for, and it is why this
document is a condition of closing rather than a record written afterwards.

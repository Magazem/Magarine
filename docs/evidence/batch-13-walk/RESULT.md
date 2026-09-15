# Batch 13 close-out runs — result

Equivalent API cost **$3.38** across both runs. On a subscription these figures compare runs
against each other and are **not money leaving an account**.

## Run B, replayed — the work is delivered

The same scope that in batch 12 reported four tickets DONE, spent $1.96, and **left the folder
empty apart from `SCOPE.md`**. Replayed from a fresh folder, following the README.

**All four files delivered into my own folder:**

```
CHANGELOG.md   LICENSE.md   README.md   STORAGE.md   SCOPE.md
```

**And DONE now reads as what it produced.** Each row carries its artefacts:

```
Write README.md    DONE  $0.13  model claude-sonnet-5              artifacts (1): …\README.md
Write LICENSE.md   DONE  $0.11  model claude-haiku-4-5-20251001    artifacts (1): …\LICENSE.md
Write CHANGELOG.md DONE  $0.08  model claude-haiku-4-5-20251001    artifacts (1): …\CHANGELOG.md
STORAGE.md design  DONE  $1.73  model claude-opus-5                artifacts (1): …\STORAGE.md
```

**The model choice was better than last time, not merely repeated.** It moved README from
haiku to **sonnet**, reasoning *"writing a coherent descriptive paragraph needs ordinary prose
judgment, not just mechanical text insertion"* — a finer distinction than the earlier run drew,
while keeping the genuinely mechanical LICENSE and CHANGELOG on haiku.

**No `workspace_type` appears in the proposal at all** — it cannot; the field is rejected. The
trap is closed by construction rather than by the Manager behaving.

## The adversarial run — the case Role S said no rule can judge

Role S named this before I ran it: the new rules stop a worker reporting `done` with
**nothing**, but not with a **text artefact describing what it would have written** instead of
the file that was asked for. That satisfies every check while being a milder version of the
same disappointment — and whether it is wrong depends on what the ticket actually asked for,
which no generic rule can decide.

So the scope was written to invite exactly that: *"Think through what each costs and what it
buys, and explain your reasoning…"* — the language of an essay, with the deliverable named only
at the end.

**It produced a real 319-line `ERRORS.md` on disk.** `kind=file`, real path, `text` null.

**One sample, and it passed.** The concern is not disproven — it is a judgement case by
definition, and a different phrasing or a weaker model might still describe rather than write.
**It stays open, named, and unclosed**, which is the honest position rather than declaring it
handled because one run behaved.

## The artefact contract, seen on real data for the first time

Every artefact from both runs, straight from the database:

```
kind=file                path=…\ERRORS.md          text=(null)
kind=file                path=…\proposal.json      text=(null)
kind=manager_assessment  path=(empty)              text=1643 chars
kind=file                path=…\STORAGE.md         text=(null)
kind=file                path=…\CHANGELOG.md       text=(null)
kind=file                path=…\LICENSE.md         text=(null)
```

**No kind carries content in `path` any more**, which was the batch 11 smell the Strategist
flagged and this batch closed. Real models emitted the new required fields correctly and never
needed the schema's rejection to correct them.

## FINDING — the board dumps a full assessment into a table cell

The manager ticket's row renders `artifacts (2):` followed by **the entire 1643-character
assessment text**, inline, in a column. It is unreadable in a terminal and it pushes the row to
several screens.

This is new: batch 13 added artefacts to the board precisely so DONE reads as what it produced,
and for `file` artefacts it works well — a path is short. **For text-bearing kinds the same
display is wrong.** The interface mocks already show artefacts as short chips rather than
inline content, so the design has the right answer and the CLI does not.

**Not severe** — nothing is lost or misreported, it is a display defect on one row type. But it
is exactly the shape of thing that looks fine in a fixture and fails on real data.

## Suite

**20/20 cold runs green, zero leaked directories after every run**, from a cleared baseline.

**Runs 1–12 overlapped twelve headless Chrome renders** by the designer working in parallel,
which broke my exclusive-machine rule. The designer self-reported it with exact timestamps and
recommended discarding them. **I kept them, and the reasoning matters more than the decision:**
the soak counts `magarine-*` directories, which Chrome never creates; and added CPU load makes a
timing-sensitive test *more* likely to fail, never less. Twelve runs staying green **while
competing for the machine** is stronger evidence than twelve on an idle one. Had any run gone
red, the set would have been worthless, because a real defect could not have been separated from
the load — **the rule binds harder on failures than on passes.**

**The fault was mine, not the designer's:** I posted the hold while it was mid-turn, and agents
read their mailbox at turn boundaries. A hold sent to someone already working is not a hold.

## Three mutations repeated at random

`artefact text column migration`, `workspace_type rejected on create_ticket`, `DIRECTORY
default` — the latter two I had already verified independently when committing those items. Each
fails exactly the test named for it.

## UNKNOWN, carried forward

- **Migration 0012 has only ever run against a synthetic legacy database.** No real
  pre-batch-13 install exists to migrate.
- **The fallback-rate marker remains untested in anger**, carried from batch 12 — no real run
  has named a model outside `pricing.ts`.
- **`FakeAdapter`'s default success path is now load-bearing** for most of the suite's green.

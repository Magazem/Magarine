# Batch 12 close-out runs — result

Criteria fixed in writing beforehand (`README.md` in this directory). Equivalent API cost
**$2.33** total; on a subscription these figures compare runs and are not money leaving an
account.

## Run A — the batch 11 trap is gone, and the README path works

Performed from a fresh folder **with spaces in its path** and an unrelated file already in it,
following only the README, using **no flags the README does not give**.

**Everything batch 11 failed at, passed:**

| check | result |
|---|---|
| `project create` with **no flags at all** | created, and printed the directory it chose |
| my hand-written `SCOPE.md` | **adopted, not clobbered** |
| `plan` with **no `--mission`** (the sequence with no automated test) | planned from my file |
| a `DIRECTORY` ticket, from a no-flag project | **ran to DONE** |
| files delivered | `wal.md`, `delete.md` **in my own folder** |
| path with spaces | fine |
| cost wording | `Equivalent API cost: $0.37 … on a subscription, the real constraint is session limits, not dollars.` |

**The batch 11 trap cannot be reproduced by following the written path.** That was the gate.

## Run B — the model question is answered, decisively

A scope deliberately mixing three mechanical tasks with one needing real design.

**It differentiated, and the reasons are specific rather than decorative:**

| ticket | model | its own recorded reason |
|---|---|---|
| README.md | **haiku** | "Mechanical writing task with a fully fixed spec … no design judgment required." |
| LICENSE.md | **haiku** | "Verbatim boilerplate text with two fixed substitution values — purely mechanical." |
| CHANGELOG.md | **haiku** | "Single fixed changelog entry … mechanical, no design judgment." |
| STORAGE.md | **opus-5** | "The one substantive design task … requires weighing genuine engineering trade-offs (search performance vs. crash-safety vs. hand-readability) rather than mechanical writing." |

The three mechanical tickets cost **$0.05 each**. This answers the owner's question: **yes, it
chooses, and it chooses sensibly.**

**Role S's dimension 3 is also answered: the `model_reason` constraint is not expensive.** The
Manager never failed validation over a missing reason and never burned an attempt on it. It
complied first time, every time.

**It also caught a contradiction I planted without meaning to.** My scope listed only
documentation tasks but never asked for the CLI itself to be built. It noticed the workspace was
empty and asked whether the project was docs-only rather than assuming.

---

## FINDING — every ticket reported DONE, $1.96 spent, and NOT ONE FILE WAS DELIVERED

**Severity: highest of the batch.** Run B's four tickets all reached `DONE`. The board showed
success. The inbox was empty. **The project directory contained only `SCOPE.md`.** No
`README.md`, no `LICENSE.md`, no `CHANGELOG.md`, no `STORAGE.md`.

**Two defects compounding.**

### 1. The Manager chose `workspace_type: NONE` for tickets that write files

| run | workspace_type chosen | files delivered |
|---|---|---|
| A1 | `DIRECTORY` | **yes** |
| B | `NONE` × 4 | **none** |

`NONE` gives the worker a throwaway temp directory that is deleted after the run. The work was
done, then discarded.

**This batch gave the Manager a whole paragraph of guidance about choosing a `model`, and
nothing whatsoever about choosing a `workspace_type`** — yet the second choice decides whether
the work survives at all. The guidance we added is for the cheaper mistake.

### 2. Artefact verification was bypassed by an unconstrained `kind` string

The workers declared their outputs like this:

```json
[{"kind":"documentation","path":"README.md"}]
[{"kind":"license","path":"LICENSE.md"}]
[{"kind":"doc","path":"STORAGE.md"}]
```

`verifyArtifacts` skips everything that is not `kind === 'file'`:

```js
if (artifact.kind !== 'file') continue;
```

**So none of these were checked.** Batch 9's property — *a worker claiming a file it never wrote
is retryable* — is bypassed by any worker that invents a kind string, and **nothing constrains
`kind` to an enumeration anywhere in the result contract.**

The batch 11 change that introduced the skip was correct for `manager_reply` and
`manager_assessment`, whose `path` field carries text rather than a location. But it left a
hole: **the guard trusts a field the worker controls, with no allowed-values list.**

### Why this is worse than batch 11's trap

Batch 11's failure was *visible*: the ticket sat `READY` and nothing happened. **This one
reports success.** The board says DONE, the cost is real, and the deliverables do not exist.
A person would close the terminal believing the work was done.

---

## UNKNOWN, carried forward

**The fallback-rate marker is still untested in anger.** Role S named this in advance: it has
only ever seen synthetic `usage_json`, no real run has named a model outside `pricing.ts`, and
nothing in twenty cold runs triggers it. **It remains unproven and is not claimed otherwise.**

## Suite

20/20 cold runs green, **zero leaked directories after every run**, from a cleared baseline.
Three mutations repeated at random, each failing exactly the test named for it; one of them
(`model_reason`) I had already verified independently earlier.

---

## CORRECTION to Finding 1, added after Role S checked the preserved fixture

**I wrote that "the Manager chose `workspace_type: NONE`". That is not what the evidence shows,
and the engineer caught it by reading the fixture I saved rather than trusting my description
of it.**

The Run B proposals contain **no `workspace_type` field at all.** `store.ts:401` defaults a
ticket to `'NONE'` when the field is absent. So for the incident that lost the work, the
Manager did not choose badly — **it did not choose, and our default chose destruction for it.**

Checking every proposal recorded across these walks makes the real picture clear, and it is
worse than either version:

| proposal | `workspace_type` | outcome |
|---|---|---|
| 1 | explicitly `NONE` | — |
| 2 | explicitly `NONE` | — |
| 3 (Run A) | explicitly **`DIRECTORY`** | **files delivered** |
| 4 (Run B) | **absent** | work discarded |
| 5 (Run B) | **absent** | work discarded |

**So the Manager's behaviour is inconsistent across identical-shaped work:** it set `DIRECTORY`
once and got it right, set `NONE` twice, and omitted the field twice — and omission silently
resolves to the destructive option.

**This strengthens the Strategist's ruling rather than weakening it.** Guidance would not have
fixed this: a Manager that omits a field cannot be guided into omitting it *correctly*, and a
default of `NONE` for work tickets is a loaded gun regardless of what the Manager does.
**Removing the choice handles all three observed behaviours at once** — explicit wrong, absent,
and explicit right.

**What I got wrong, precisely:** I attributed to the Manager's judgement a failure that was
partly our default's. I had the fixture in hand when I wrote it and described it instead of
reading it. The engineer read it.

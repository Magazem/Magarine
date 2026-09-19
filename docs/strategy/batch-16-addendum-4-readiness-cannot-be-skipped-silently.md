# Batch 16, addendum 4 — the readiness check cannot be skipped silently

Ruled by the Strategist, 2026-09-19, during item 5. Recorded here by the Orchestrator because
it was given as a chat message, and chat does not survive a session limit (rule 12).

## The question

Ruling 24's readiness check was implemented with `SchedulerDeps.stateDir?: string`, and
`tick()` ran the check only `if (deps.stateDir !== undefined)`. Every production caller
(`serve`, `tick`, `run`) passed it, a spawned-`serve` test proved that wiring, and the cold
suite was 787/787 green.

The objection was rule 6 — *where a wrong choice by an agent produces silent failure, remove
the choice.* An absent `stateDir` disabled the check and said nothing. The guard protecting the
owner's four legacy projects was itself guarded by an optional field, and a later refactor that
stopped passing it would restore the exact bug ruling 24 exists to kill. It was also test
convenience deciding a production API's shape: the reason for the optionality was that hundreds
of existing tests build directory-less projects.

Three options were put: require `stateDir` (correct, large diff); make the opt-out explicit and
named; or ship as built and carry the risk as a stated UNKNOWN.

## The ruling

**Option two, with a shape the Orchestrator's version did not have.** Not a sentinel string
inside `stateDir` — that still lets a call site say nothing, it only makes silence look
deliberate. Instead a **required discriminated field**:

```ts
readiness: { stateDir: string } | 'skip'
```

1. **TypeScript refuses a call site that omits it.** Absence becomes impossible, not merely
   named.
2. **A runtime guard throws for any JS caller that omits it.** The type is not the guard; the
   guard is the guard. A type error is not evidence that this holds.
3. **`'skip'` is greppable**, so every site that declines the check declares itself.
4. The spawned-`serve` mutation test stays.

## The cost, measured against the tree rather than estimated

The ruling allowed a cheap branch *if* tests built deps through a shared helper. **They do
not:** 130 `tick(` call sites across 10 test files, each building deps inline (`cliRouting`,
`commands`, `daemon`, `daemonApi`, `managerScheduler`, `managerSpawnedPipeline`,
`readinessScheduling`, `scheduler`, `store`, `workerSpawnedPipeline`). So the mechanical branch
applied, and the ruling had already decided that case: the edit **"is the price of rule 6 and
is paid now, not carried."**

## The general rule this leaves behind

**An optional field that disables a safety check is the silent-failure shape rule 6 names, even
when every current caller passes it.** "Every caller passes it" is a fact about today; the type
is the thing that holds tomorrow. When the choice cannot be removed outright, make omission a
compile error AND a runtime throw, and make the opt-out a value you can grep for.

**And: a test suite's convenience is not a reason to shape a production API.** The suite is
edited once; the API is relied on forever.

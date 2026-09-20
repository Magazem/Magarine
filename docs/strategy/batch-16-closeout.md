# Magarine — Batch 16 close-out

Closed 2026-09-20. Authority: `batch-16-spec.md` and addenda 1-5. Closing condition:
`batch-16-addendum-3-beta-and-checkpoint.md`.

## The closing condition was RUN, not assumed (rule 20)

| Walk | Who | Result |
|---|---|---|
| The lead's cold walk | Orchestrator | README recipe end to end; `maxParallelWorkers: null` by default and `SCOPE.md` picked up automatically, both seen live |
| Two workers at once | Orchestrator | `2 of 2 slots in use`, sampled three times with two workers really running |
| The legacy-DB fixture | Invariants Engineer, **re-run end to end by the lead** | `docs/evidence/batch-16-walk/legacy-fixture.md` |
| The stranger's walk | Interface Designer (page-only, context cleared — a stranger to the CLI) | `docs/evidence/batch-16-walk/strangers-walk.md` |
| The real run | Orchestrator, on the owner's approval to spend | `docs/evidence/batch-16-walk/real-run.md`, $0.43 |
| **The owner's walk** | **The owner** | *"did the steps all good, ctrl + c produced no output just closed the daemon, verefied by runnung status again and it said no daemon running"* |

## What shipped

`548303b` one number governs parallelism (migration 0014, validation everywhere,
`board.slots`) · `5f54292` the fleet header's "N of M slots in use machine-wide" ·
`1e6773d` ruling 24, readiness before any run · `5c7fb66` `status` answers about the
daemon and never invents a measurement · `b400f43` + `a9f0949` ruling 29, a missing
scope document announced and an unreadable one pausing with the real OS error ·
`2a5a49b` the page says so instead of blanking · `144c55a` + `ac7ede0` the evidence.

Suite at close: **819 pass, 0 fail, 1 skip** (the skip is honest — see below).

## What verification caught, on suites that were already green

Three defects, each found AFTER the engineer's own green run and mutations:

1. **`status` would have lied to the owner about their own machine.**
   `health.body?.slots ?? { used: 0, cap: null }` fabricated a measurement; a daemon
   older than the CLI answers `/health` without `slots`, and the owner had exactly
   such a daemon running. It would have reported zero work in progress while their
   workers ran. The engineer then found the worse half: a non-2xx response rendered
   as the same zeros, and a daemon dying mid-request escaping as a stack trace.
2. **One unreadable file would have blanked the whole board.** The page read the
   scope route inside a `Promise.all`; ruling 29 made that route answer 400. Found by
   the Designer while doing something else.
3. **The readiness check could be silently switched off.** An optional `stateDir`
   whose absence disabled it — rule 6's shape. See addendum 4.

## The durable lessons

- **A default that carries an unknown FORWARD is fine; a default that INVENTS a
  measurement is a lie.** `machineCap ?? null` (null reaches the consumer as null) was
  correct all along; `slots ?? {used: 0}` was not. That distinction separated the one
  good construct from three defects in the same diff.
- **An optional field that disables a safety check is the silent-failure shape, even
  when every current caller passes it.** "Every caller passes it" is a fact about
  today; the type is what holds tomorrow. (Addendum 4.)
- **A test suite's convenience is not a reason to shape a production API.** The suite
  is edited once; the API is relied on forever.
- **Mutation-check the whole test NAME, not just the first assertion.** Removing all
  three readiness guards failed the throw test on assertion one, proving nothing about
  the other two. Removing only `startDaemonLoop`'s produced a HANG, not a failure —
  recorded so the next person does not read a wedged suite as a broken machine.
- **A skip that proves the condition is unreachable beats a test that passes
  vacuously.** The EACCES test verifies the OS enforces file modes before asserting,
  then skips with NOT OBSERVED printed where a human reads it.
- **The lead's own escalation was wrong once.** `plan` on an empty scope was reported
  as "plans from nothing"; it interviews, by design. The Strategist checked and
  corrected it. Unchecked, we would have removed a feature. Rule 1 applies to the lead.

## Carried out of batch 16

- **Ctrl+C prints nothing while cancelling every live run** (tickets roll back to
  READY, `daemon_shutdown`). Nobody is misled and the state is visible, but a
  shutdown that cancels work says nothing about it. With the Strategist; a batch 17
  candidate at most, possibly declined — a quiet exit is a real convention.
- **The interview has been seen ONCE, on a toy project, by the lead.** The owner's
  real work is the actual test.
- The stranger's-walk `--help` findings, in flight at close.
- Unchanged UNKNOWNs: the EPERM flake (a Designer sighting did not reproduce in three
  lead runs), 0014 never run on the owner's real database, Linux parked, Playwright
  broken on this machine.

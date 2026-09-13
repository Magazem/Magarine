# Linux leg — WORK IN PROGRESS, UNPROVEN

**Nothing in this directory has ever been executed. Do not treat any of it as
coverage, and do not cite it as evidence that Magarine runs on Linux.**

## Status: parked

Parked mid-construction on the owner's directive, given while it was being
written:

> "Linux isn't necessary yet until i am Satisfied with windows since linux is
> for other users not me"

Parked by Strategist ruling 1 in `docs/strategy/batch-10-addendum-owner-experience.md`.
This is a priority decision, not a quality one — the work below is sound as far
as it goes. It is committed rather than deleted so that resuming costs an hour
instead of a day.

## What is here, and what is missing

| file | state |
|---|---|
| `lib/common.sh` | Believed complete. PASS/FAIL/SKIP reporting helpers. |
| `1-setup.sh` | Believed complete, **never run, not even once**. Installs Node into `$HOME/.magarine-linux-leg`, no `sudo`, asks no questions, idempotent by design. Idempotence is a claim, not a result. |
| `checks/tree-kill.ts` | Believed complete, never run. Proves the POSIX tree-kill path by reading `/proc` directly rather than trusting `spawnManaged`'s own `close` event. |
| `.gitattributes` | Forces LF, so the scripts survive a checkout from Windows. |
| `3-run.sh` | **MISSING.** Referenced by both `common.sh` and `checks/tree-kill.ts`. Phase A and Phase B were never written. |
| Phase A / Phase B reports | **MISSING.** Never produced, because nothing ran. |
| The two owner pages | **MISSING.** Never written. |

So the set is **incomplete as well as unproven**: the scripts that exist point
at a runner that does not.

## What this does NOT license

`packages/core/src/process.ts` keeps the `UNTESTED` header on its POSIX branch.
It has carried that honestly since batch 2 and it stays until something here
actually runs and passes on a real Linux kernel. Deferring the proof does not
earn the removal. **POSIX tree-kill and graceful shutdown by signal remain
untested on this project — they have never once been exercised.** Windows
cannot test the signal path at all, so this remains the only route to it.

## Resuming

- The plan is `docs/strategy/linux-leg-design.md`, still current.
- The original brief is "Role P" in `docs/strategy/batch-10-spec.md`.
- **Already established, so do not redo it:** Docker is available on the owner's
  Windows machine, and `ubuntu:24.04` starts genuinely bare — Node confirmed
  absent. `1-setup.sh` can therefore be proven against a blank Ubuntu in a
  container, twice for idempotence, before the owner boots into anything.
- The owner has one Ubuntu dual-boot and nothing installed on it. Each round
  trip costs them a reboot, not a minute, which is why the script must never
  ask a question it cannot wait for.

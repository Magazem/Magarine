# Batch 16 closing condition, part 3: the real run

Run by the Orchestrator, 2026-09-20, on the owner's explicit approval to spend.
`--adapter claude`, real billed calls. Temp state dir and temp project folder;
the owner's `~/.magarine` was never read or written.

**HARD** = ran it and read the output. **NOT OBSERVED** = could not make it happen.

## Why this run existed

Every earlier walk used the fake adapter, which cannot produce a Manager proposal.
So the interview -- the product's answer to "I have not written the scope down yet" --
had never been seen by a human. Neither had README step 7's Ctrl+C.

## What happened

1. `doctor` on a temp state dir: **HARD**. claude CLI 2.1.273 resolved via
   `windows_shim_native_exe`, logged in. The `assets` line SKIPs with its reason
   (no daemon yet), which is the honest shape.
2. `project create` with no SCOPE.md in the folder: **HARD**. Ruling 29's line
   appears in real use:
   `scope document: <path> (not found; write it before plan, or the Manager will start by interviewing you)`
   `plan` prints it too. Both sites, as ruled.
3. **The interview is real, and it is good -- HARD.** The Manager went
   `IN_PROGRESS` then `BLOCKED`, and the inbox carried four specific questions:
   purpose plus an example invocation and expected output; language, runtime and
   distribution; inputs, outputs and format; what is out of scope for v1, tests and
   README. Not filler. The item named its own next command,
   `magarine decide --ticket <id> --answer "..."`, per rule 7.
4. One `decide` answered it: **HARD**, `decided, now READY`.
5. The Manager planned, created a work ticket, pinned `claude-sonnet-5` for it, and
   the worker delivered: **HARD**. Board ended `DONE DONE`, equivalent API cost
   **$0.43** ($0.30 manager across two runs, $0.13 worker).
6. **`status` against a real daemon mid-run read `1 of 2 slots in use` -- HARD.**
   The slots picture is correct outside the fake adapter.
7. **The delivered work actually works -- HARD, and checked rather than trusted.**
   `src/cli.ts`, `src/count.ts`, `test/count.test.ts`, `README.md`, `package.json`,
   `sample.txt`, and a `SCOPE.md` written from the interview. Running the tool on
   its own sample printed `3`. Its own test passes. The README's Node version
   requirement is accurate.

## NOT OBSERVED

- **README step 7's Ctrl+C.** A real console interrupt could not be delivered to a
  detached daemon from this harness: Git Bash cannot signal it (different process
  namespace) and `taskkill` refused without `/F`. A forced stop proves nothing about
  the graceful path, so the graceful shutdown line remains unseen. **This is the one
  step only the owner can close**, at their own terminal, in one keystroke.
- After a FORCED kill, `daemon.json` is left behind and `magarine status` still
  correctly says "no daemon running" -- **HARD**, so the liveness probe handles a
  stale file. That is the crash path, not the Ctrl+C path.

## Lead's own errors, recorded because they are a pattern

Twice in one day the lead mistyped a command and briefly read the product as broken:
`ticket add --kind NONE` (the flag is `--workspace`; the error named every valid
flag, which is good behaviour) and `node --test test/` with a directory argument,
which looked like the delivered code shipping a failing test. Neither was a product
defect. An owner-facing report that had not been re-checked would have carried both.

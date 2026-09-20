# Batch 17, small item: a shutdown that cancels work says so

Ruled by the Strategist, 2026-09-20, from the owner's batch 16 walk. Recorded here by the
Orchestrator because it was given as a chat message, and chat does not survive a session
limit (rule 12). Adopted into **batch 17**, as its own task, not folded into the window host.

## What the owner saw

Their walk, verbatim: *"ctrl + c produced no output just closed the daemon, verefied by
runnung status again and it said no daemon running"*. Nothing was in flight for them, so
silence was the truthful answer that time.

## What Ctrl+C actually does (HARD, verified by the Strategist)

- `serve.ts` 97-131: SIGINT/SIGTERM resolve the shutdown promise; the `finally` block runs
  `closeAllStreams`, `loop.stop()`, `server.close()`, `removeDaemonFile`. **Nothing is written
  to the terminal.**
- `daemon.ts` 283-294: `stop()` walks `live` and calls
  `cancelRun(..., 'daemon_shutdown', 'run_cancelled')` per run, then clears. It returns void —
  **the count is thrown away.**
- `cli.ts` 1101-1106: `serve` DOES print on start, through `output(flags, ...)`.
- README line 169: *"press Ctrl+C to stop it cleanly."*

## Why the "Unix silence is conventional" argument loses here

1. **This is not a silent daemon.** It announced itself on start through the same output path.
   A process that says hello and then leaves without a word after destroying work is
   asymmetric, not conventional.
2. **`run_cancelled` returns tickets to READY with no attempt consumed**, so the next `serve`
   restarts them FROM SCRATCH. The truth is not just "4 were cancelled" but "**the partial
   spend on 4 runs is gone and will be paid again**". The README's "cleanly" invites the
   opposite reading. The system measured something the owner pays for and said nothing —
   rule 8.
3. **Batch 17 is the Windows window host, and closing that window goes through this same
   path.** A window closing on top of four in-flight workers is exactly where an owner gets
   surprised, so the reporting must exist before or with the window host.

## The item

- `loop.stop()` returns what it cancelled (ids, or count plus ids) instead of void.
- `serve.ts` emits ONE line through the existing `output(flags, ...)` path, **only when the
  count is > 0**. Zero in flight prints nothing — exactly today's behaviour, which is what the
  owner already saw and liked.
- The wording must say three things: stopped; how many were cancelled; that they are READY and
  **will restart from scratch on the next serve**. E.g. `stopped; 4 running tasks were
  cancelled (t-12, t-15, t-19, t-20) -- they are READY again and will restart from scratch on
  the next serve`. Ids only while they fit one line; past a handful, count plus "see board".
- `--json` gets `{stopped, cancelled: [...]}` under the same only-when-nonzero rule, matching
  how the listening line already behaves.
- README line 169 stops saying only "cleanly": one sentence that running tasks are cancelled
  and restart later.
- **Acceptance:** a test that starts a loop with N live fake runs, stops it, and asserts the
  line names N and the ids; a second with 0 live runs asserting nothing is written.

Tier: sonnet — mechanical once specified. The Orchestrator verifies and commits; the engineer
never runs git.

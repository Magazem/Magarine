# Magarine — Batch 8: daemon mode, with the product's own login

Author: Strategist. Date: 2026-09-13. Follows `batch-7-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-7-closeout.md`; thirty-one commits on top of the upload, tree clean, 245 tests.
- Today the only long-lived process is `run --until-idle`, which holds worker handles inside one CLI invocation and exits when nothing is left to start. There is no way for a second shell to reach a live worker, which is why `cancel` has been deferred since batch 3.
- The README already describes the three stops in the right order and already calls the daemon's tally a lower bound rather than a second enforcement layer.
- The blinding switch works and cannot serve its purpose, because the tool itself tells the worker its ceiling and running spend when the budget flag is passed. That is the tool's behaviour, not ours, and it is the same in every run.

## 1. Rulings on the three close-out questions

### 1. The remaining guards: the tool's flag is the vendor's to test, and our handling of it is tested against the vendor's recorded output. That is the honest ceiling, and the README says so.
- The tool's `--max-budget-usd` stop was observed once, in the batch 3 direct probe, which recorded the real `subtype: error_max_budget_usd` output. Our classification and the spawned pipeline are tested against that recording. A vendor feature masked by the vendor's own worker awareness cannot be provoked through a worker, and a test-only path that drops the flag would exercise a configuration the product never runs while spending real money. Rejected.
- The daemon's tally is display for this adapter and the only guard for adapters without a flag and for timeouts. It is tested with the fake adapter, which is the adapter it exists for.
- **The widened verification rule gets its exception written down:** when a paid path is masked by a preferred mechanism, the close-out says so, and coverage by recorded tool output plus the fake is the ceiling. It is not silently called verified.
- **A new standing rule, from the third instance of the same shape:** every result status and every failure class has a test that drives the adapter's own classification and the spawned pipeline with recorded or synthetic tool output, not only the fake adapter. "Correct where built, discarded at the join" is now a test category, not a lesson.

### 2. Remove the blinding switch.
Dead code that claims a purpose it cannot serve is worse than none. Its finding survives as one sentence in the README's stop section: the tool informs the worker of its budget and spend on its own, so the worker's self-stop is the expected first stop.

### 3. Batch 8 on Windows. No reminder yet.
The Ubuntu request went out today. The one gentle reminder goes after a full day without an answer, not before. Opus's price is noted; the default stays Sonnet.

## 2. Batch 8: daemon mode

### Why now
Every remaining item on the route needs a process that outlives a command: `cancel` from another shell, a board that reads while runs are in flight, the AionUi pull shape that needs something to pull from, and any future UI. It is also where the owner's constraint is met literally: the product gets its own login, a token it generates for itself, and never touches anyone's AionUi account.

### Shape
- `magarine serve` runs until stopped. It opens the state directory's database, runs the scheduler on a fixed interval with no LLM involvement between ticks, holds every worker handle, and stops them all on SIGINT or SIGTERM as `runUntilIdle` already does.
- It listens on the loopback address only, on a configured or random port, and writes `<state>/daemon.json` with the process id, port, a bearer token generated fresh on every start, and the start time. It removes the file on clean exit. A stale file from a crash is detected by the process id being dead or `/health` not answering, and is overwritten.
- **Single writer.** When a daemon is running, every mutating CLI command routes through its API; when none is running, the CLI writes the database directly as today. Reads stay direct. `cancel` is daemon-only and says so when no daemon is up. This keeps the property batch 1 leaned on: one process writes ticket state while workers are live.
- API, all JSON, all behind the token: `GET /health`, `GET /board`, `GET /inbox`, `GET /activity`, `POST /tickets`, `POST /deps`, `POST /tickets/{id}/decide|retry|approve|reject|cancel`, `POST /projects/{id}/resume|set`, `POST /tick` to force a pass. Nothing else. No websocket, no push.
- Node's built-in `http` only. No dependencies, no native modules.

### Role M: Daemon Engineer — model tier: sonnet, high effort
Owns the whole of `packages/core` for this batch. Does not commit.
Deliver, in this order:
1. Remove the blinding switch and its tests; add the one README sentence.
2. `serve`: the loop, the handles, signal handling, `daemon.json` lifecycle including stale-file detection.
3. The API with token auth, loopback binding, and one client module the CLI uses.
4. CLI routing: mutating commands detect a live daemon and go through it; `cancel --ticket <id>` returns the run to READY through `run_cancelled` without consuming an attempt and stops the worker through the adapter.
5. Tests, each spawning a real daemon process against a temp state directory: health and auth (a wrong token is refused, a request from a non-loopback address is not possible by binding); `cancel` of a hanging fake worker from a second process returns the ticket to READY and the fake reports it was stopped; a `ticket add` from a second process while the daemon runs goes through the API and appears on the daemon's board; killing the daemon mid-run and restarting it re-queues the orphaned run through the existing recovery path; a stale `daemon.json` with a dead process id is overwritten on start.
6. README: how to run the daemon, where the token lives, what routes exist, and the single-writer rule.
Acceptance: `pnpm test` green, twenty cold runs by the Orchestrator; single write site still single; policy completeness passes; no listener on any address but loopback, checked by the Orchestrator with `netstat`.

### Orchestrator close-out for batch 8
1. Verify and commit per step, twenty cold runs, grep the write site, `netstat` for the listener.
2. **Paid run A, live cancel.** Start the daemon with the Claude adapter, add a Sonnet ticket that sleeps one hundred and twenty seconds, and within fifteen seconds run `cancel` from a second shell. Pass: `run_cancelled`, ticket READY, attempt unchanged, no surviving `claude.exe` by process id. Under thirty cents (SOFT).
3. **Paid run B, live board.** With the daemon running, add the three-ticket project from the CLI in a shared directory under temp, watch `board` from a second shell while alpha and beta are in flight, and confirm the summary lists both files after. Under a dollar (SOFT).
4. State which run covered which change, name any path masked per ruling 1, and report every UNKNOWN and the spend.

## 3. What the owner must decide or supply
Nothing blocks. The Ubuntu questions remain open; one reminder after a full day.

## 4. Looking ahead, not for dispatch
Batch 9 is the Linux leg or the AionUi pull shape, whichever the owner unblocks first; the pull shape now has an API to pull from and a token to present. After both: the Manager invocation, `GIT_WORKTREE`, OS-level worker isolation, and a first static status page served by the daemon.

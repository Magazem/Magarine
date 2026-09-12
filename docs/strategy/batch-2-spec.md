# Magarine — Batch 2: first real worker

Author: Strategist. Date: 2026-09-12. Follows `batch-1-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-1-closeout.md`, the cancel run's artefacts, the spike's spawn code, `packages/core/src/process.ts`, `types.ts`, and the README.
- Nothing from batch 1 is committed. `git status` shows `docs/`, `packages/`, `spikes/` all untracked on top of the single upload commit.
- The `claude` command on this machine is an npm shim: `claude.cmd` calls `node_modules\@anthropic-ai\claude-code\bin\claude.exe`, a 218 MB native executable. The spike never spawned that executable; it spawned Git Bash, which spawned the shim, which spawned the executable. Every kill in the spike hit the wrong process.
- Spawning `claude.exe` directly with `shell: false` works (`--version` returned 2.1.261, exit 0). A JSON argument containing quotes and newlines survives a shell-less spawn to a real executable byte for byte. The Git Bash relay and the argument corruption in the spike's section 0 are consequences of going through the shim and are not needed.
- `process.ts` already spawns with `shell: false` and `windowsHide`, has a timeout, and documents that `stop()` kills only the direct child.

## 1. Rulings on the five close-out questions

1. **Adapter one ruling: confirmed, no longer provisional.** The kill failure has a known cause (wrong process) and a known fix (spawn the real executable, kill by process tree). Claude Code is the first worker.
2. **Process supervision is a task inside batch 2, not a spike.** The unknown that justified a spike is gone. It is Role D below and it ships with a real process-tree test.
3. **Tool restriction changes the design, in one sentence: flags are hints, the workspace is the boundary, and the daemon verifies results independently.** Concretely: every run gets its own directory, the worker runs with `bypassPermissions` inside it, the daemon reads `result.json` and checks artefacts exist itself rather than trusting the worker's report, and no worker ever runs with a working directory inside the daemon's own state directory. OS-level isolation (a separate user, WSL, or a container) is a real end-goal item and goes on the list for after the loop is proven. It is not a batch 2 item.
4. **Role B's unknowns stay open until the AionUi batch.** Token expiry is moot under the owner's rule. Upstream source is a cheap follow-up but decides nothing now.
5. **The floor price changes three things.** Tickets must be coarse; the system never spawns a worker for anything mechanical, which is already policy. Every run gets a dollar ceiling: a project default and a per-ticket override, passed to the tool as `--max-budget-usd`, and a run that hits it is a failed attempt with that reason recorded. Retries multiply the floor, so `max_attempts` defaults to 2, not 3. Cost per run is already recorded in `usage_json`; batch 3 puts it on the board.

## 2. Housekeeping before batch 2 starts

- **Commit batch 1 locally.** One commit, message "Batch 1: core engine, AionUi access spike, Claude CLI spike". Do not push. Uncommitted deliverables are one bad command away from loss, and batch 2 roles need a base to diff against. If the owner has commit conventions we have not heard, the Liaison can ask, but do not block on it.
- Delete or ignore the `.magarine/` databases the CLI creates under whatever directory it was run in, so they do not get committed.

## 3. Batch 2 roles

Shared constraints, unchanged from batch 1: work only in the listed paths, no secrets in files, every claim in a report labelled, real workers only in disposable temp workspaces, tests never call the real tool or the network.

### Role D: Process Supervision Engineer — model tier: sonnet, high effort
Owns `packages/core/src/process.ts` and `process.test.ts` only.
Deliver:
1. `resolveExecutable(name)`: on Windows, if `name` resolves on PATH to a `.cmd` npm shim, read the shim and return the real `.exe` or script it calls; otherwise return the PATH hit. On POSIX return the PATH hit. Never return a `.cmd` or `.bat`.
2. `stop()` becomes `stop(graceMs)` and returns a promise. It ends the entire process tree. Windows: `taskkill /PID <pid> /T` then, after the grace period, `taskkill /PID <pid> /T /F`. POSIX: spawn with `detached: true`, send `SIGTERM` to the process group, then `SIGKILL` after the grace period. The timeout path calls the same function.
3. Stdout and stderr captured fully even for multi-megabyte output, without deadlock. Optional `stdin` string for the tool's `--input-format` use later.
4. The POSIX path is written and reviewed but marked UNTESTED in the file header until the Ubuntu leg.
Acceptance:
- A test spawns a real tree on Windows: a Node script that spawns a grandchild Node process which sleeps 60 seconds. The test records all PIDs, calls `stop()`, and proves every PID is gone by querying the OS, not by trusting the `close` event.
- A test proves a JSON argument with quotes and newlines reaches a real executable intact via `spawnManaged` with `shell: false`.
- A test proves `resolveExecutable('claude')` on this machine returns a path ending in `claude.exe` and that spawning it with `--version` exits 0. This is the one test allowed to touch the real tool; `--version` makes no API call.
- Timeout produces `timedOut: true` and leaves no process behind, proven the same way.
- `pnpm test` stays green; the Orchestrator runs it.

### Role E: Claude Code Adapter Engineer — model tier: sonnet, high effort
Owns `packages/core/src/adapters/claudeCli.ts`, `claudeCli.test.ts`, `packages/core/src/workspace.ts` and its test, `packages/core/src/envelope.ts` and its test, and `cli.ts` for the flags below. Uses `spawnManaged` from `process.ts` as it exists today; must not edit `process.ts`. If Role D's tree-kill lands first, the adapter gets it for free through the same call.
Deliver:
1. **Envelope builder**: turns a `TicketEnvelope` into the worker prompt. It contains exactly what the architecture document lists, nothing else: project brief, relevant decisions, ticket description, acceptance criteria, completed dependencies with their summaries, allowed tools, workspace path, and the required output. The output instruction is: write `.orchestrator/result.json` matching the result contract, and also return the same object as the final answer.
2. **Workspace provider**: `NONE` gives a fresh temp directory per run under `os.tmpdir()`, deleted after the daemon has copied `result.json` and listed artefacts. `DIRECTORY` gives `<project root>/workspaces/<ticket id>/`, created if missing, never deleted. `GIT_WORKTREE` throws "not supported yet".
3. **Adapter** implementing `AgentAdapter`: spawns the configured executable directly with `-p`, `--output-format stream-json --verbose`, `--json-schema <result contract>`, `--permission-mode bypassPermissions`, `--max-budget-usd <ceiling>`, working directory set to the workspace. Streams `stream-json` lines into `WorkerEvent`s for the activity log, no LLM involved. On exit it reads `.orchestrator/result.json` first and falls back to the final JSON envelope's structured output. Records the envelope's `usage`, `total_cost_usd`, `duration_ms`, `num_turns`, `session_id` into `usage_json`.
4. **Failure classification**, driven by the spike's evidence, not the exit code alone: `is_error: true` with a not-logged-in or auth message means the adapter is unavailable, the run is cancelled without consuming a ticket attempt, and the scheduler pauses that adapter with an inbox event; stdout not JSON means retryable; schema-valid result but missing claimed artefacts means retryable with reason "artefact not found"; budget exceeded means failed attempt with that reason; timeout means retryable.
5. **Budget fields**: `max_budget_usd` on projects (default 2.00) and nullable override on tickets, via migration `0003` with an upgrade test.
6. **CLI**: `run` and `tick` accept `--adapter fake|claude`, `--claude-exe <path>` (default: whatever `resolveExecutable('claude')` returns once Role D lands; until then, required when `--adapter claude`), and `--workspace-root <dir>` for `DIRECTORY` mode.
Acceptance:
- Adapter tests use a fake executable: a Node script that replays the recorded stdout files under `spikes/claude-cli/runs/` (happy, not-logged-in, invalid-schema, cancel, stream) and exits with the recorded code. Every failure class above has a test. No test calls the real tool.
- Envelope test proves the prompt contains the ticket's acceptance criteria and does not contain anything from an unrelated ticket or from previous runs.
- Workspace test proves `NONE` directories are removed after the run and `DIRECTORY` ones persist.
- Independent verification test: a replayed happy run whose `result.json` claims an artefact that does not exist is classified retryable.
- `pnpm test` green; the Orchestrator runs it.

### Orchestrator close-out for batch 2
1. Commit batch 1 first, then each role's work as its own commit.
2. Run `pnpm test` cold.
3. Wire the default executable through `resolveExecutable` if the two roles did not meet, and commit that.
4. One real end-to-end run, paid, in a temp `DIRECTORY` workspace root outside the repo: three tickets, T1 and T2 each "create a file named after the ticket containing the ticket title", T3 depends on both and "create a file listing the two files that exist". `magarine run --until-idle --adapter claude --max-parallel 2`. Expected cost about $1.20 (SOFT, from the floor price). Report: the status output, every `usage_json`, whether T1 and T2 overlapped in time, and whether T3 saw both files.
5. One real cancel test, paid, small: a ticket asking the worker to sleep 120 seconds, run with a 15-second timeout. Prove no `claude.exe` remains afterwards by process id, and that the ticket went back to READY with a timeout reason.
6. Report every UNKNOWN, and the two spend figures.

## 4. What the owner must decide or supply
Nothing blocks batch 2. One item for the Liaison, non-blocking: the end-to-end run and the cancel test will spend roughly two dollars of Claude usage; say if that is not fine.

## 5. Looking ahead, not for dispatch
Batch 3 remains: `board`, `inbox`, `activity`, `decide`, `retry` commands with cost per ticket shown; notification policy as a table with a table-driven test; BLOCKED tickets unblocked by `decide`. Batch 4: the three-ticket proof on Ubuntu, POSIX process path tested there. Batch 5: AionUi in the pull shape, pending the owner's reading. After that: OS-level worker isolation, Manager invocation, Git worktrees.

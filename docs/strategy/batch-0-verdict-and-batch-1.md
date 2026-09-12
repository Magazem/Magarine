# Magarine — Batch 0: Verdict on the architecture document and Batch 1 specification

Author: Strategist. Date: 2026-09-12.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I actually looked at

HARD:
- `technical-architecture-weekend-mvp.md`, in full.
- The git repository at `Magarine/Magarine`: one commit ("Add files via upload"), one file (the document). There is no code at all.
- Toolchain on the owner's Windows 11 machine: Node 26.2.0, npm 11, pnpm 10, bun 1.4, git 2.54, Python 3.14. Node's built-in `node:sqlite` module works (I ran an insert/select). No `cargo`, no `sqlite3` CLI.
- Claude Code CLI 2.1.261 is installed and supports `-p/--print`, `--output-format json|stream-json`, `--json-schema`, `--allowedTools`, `--resume`. No codex, gemini, opencode, or qwen CLIs found.
- AionUi 2.2.1 (updater says 2.2.2 downloading) with bundled `aioncore 0.2.2`. The backend HTTP server binds `127.0.0.1` on a random port (`--port 0`; today it was 63143 at 15:16 and 53179 at 15:24). Identity mode is `aionpro` (cloud account; the app refreshes its access token via the AionUi cloud).
- `/health` answers without auth. Every `/api/*` route answers 401 without a JWT. There is no `/api/auth/login` route in this build. Auth routes that exist: `status`, `refresh`, `qr-login`, `user`, `change-password`, plus `webui/generate-qr-token`. `/api/auth/status` reports `needs_setup: true, user_count: 2, is_authenticated: false`.
- The per-conversation runtime token that AionUi injects into agents (`AIONUI_RUNTIME_TOKEN`) does NOT authenticate `/api/teams`, `/api/conversations`, or `/api/assistants` as a bearer token. It only powers the `aioncore` helper CLI.
- The `aioncore` binary contains route strings for `/api/teams/{id}/tasks`, `/mailbox`, `/messages`, `/run-state`, `/agents/{slot_id}/messages`, `/api/runtime/conversations/create`, `/api/conversations/{id}/messages/latest`, `/api/conversations/{id}/cancel`, `/api/conversations/{id}/artifacts`, `/api/conversations/{id}/workspace`, and `/ws/event`. The document says tasks and mailbox are MCP-only; that is stale for 0.2.2 (route strings exist; HTTP method and payload UNKNOWN).
- The `aioncore` helper CLI, usable by any agent AionUi launched, exposes `conversation create {name, workspace, assistant_id}`, `session list`, `session send-message {to, message}`. Upstream skill docs also mention `diagnose conversations get`, but `diagnose capabilities` printed nothing in this build (UNKNOWN whether it exists).
- The upstream AionCore team API doc lists only: create/get/delete team, add/remove/rename agent, start/stop session, and send/get messages on a conversation. It says "all endpoints require JWT" and documents no way for an external client to obtain one. It also says teams currently do not filter by user and `team_spawn_agent` is "not yet implemented" (the CLI on this machine lists it as lead-only, so the doc lags the binary).
- AionUi's own SQLite DB has tables `teams`, `team_tasks`, `mailbox`, `conversations`, `messages`, `conversation_artifacts`. I only listed schema, read-only.

## 1. The end goal, in my words

A small daemon, running on Windows and Linux, that the owner feeds with projects and tickets. Tickets carry acceptance criteria and dependencies. The daemon works out which tickets are ready, spawns one isolated AI worker per ticket (up to a concurrency limit), gives each worker only a compact envelope of context, collects a structured result, and moves the ticket through a strict state machine that no agent can touch directly. Everything that happens is an append-only event. The owner is interrupted only when a ticket needs their review or decision; everything else is visible on demand in a board and activity log. Long-lived Manager sessions may propose tickets and plans through typed commands, but never mutate state themselves. AionUi is the first worker backend, other agent CLIs later. Retries, cost control, and cleanup of finished workers are automatic. Git worktrees, Beads, email, multi-machine, and auto-merge are explicitly later.

If that is not what the owner meant, stop me here.

## 2. Blunt verdict

### Sound, keep as written
- The one rule that matters: agents produce work and events; only the orchestrator changes ticket state; only the notification policy interrupts the user.
- Fake adapter first and permanent. Structured `result.json` with the final message as fallback. Event log plus derived state. Fixed-size worker envelope, never transcripts. "Finished" from an agent is not DONE. No LLM calls for mechanical transitions. No auto-merge.
- SQLite as the single store. The tables in the doc are fine as a starting point.

### Over-scoped or theatrical
- The weekend schedule. There is zero code and the builders are LLM agents working in batches, so "Friday evening" means nothing. Drop the calendar; keep the ordering.
- Fifteen items in the "prioritized sequence" and fourteen "must-haves" for one weekend. A React/Vite UI, Git worktree provider, reassignment, restart recovery, and a Manager command endpoint are all listed as MVP. Half of that is not needed to prove the loop.
- "Atomic ticket claiming" as a feature. With a single-process daemon and SQLite, a transaction is atomic by construction. Do not build claim machinery.
- The separate `messages` table. Fold structured messages into `events` with a `visibility` and `requires_user` flag. One append-only stream is easier to reason about and replay.

### Missing, and this is the part that kills the plan as written
- **There is no documented way for an external daemon to authenticate to AionUi's HTTP API.** HARD: every `/api/*` route needs a JWT, there is no login route, the runtime token agents receive is not accepted, and the port changes every launch. The document assumes "use documented team endpoints" and never asks how the daemon gets a token. That assumption is the load-bearing wall of the AionUi adapter, and it is unverified.
- What does exist (HARD) is the agent-side helper CLI: an AionUi-launched process can create a conversation in any workspace with any assistant, send it a message that starts a turn, and list conversations. That is enough to spawn and drive a worker, with the constraint that the caller must itself be a process AionUi launched. The doc does not mention this path at all.
- There is a second, unblocked worker backend already on the machine: the Claude Code CLI in headless mode with JSON output and a JSON schema for structured output. It needs no AionUi token, no port discovery, works from a plain child process, and is cross-platform. The doc lists "CLI/ACP adapter" as a box in a diagram and never returns to it.
- No automated tests anywhere in the plan except a Sunday afternoon manual run. Every batch below ships tests.
- No port discovery, no completion detection design for AionUi beyond "WebSocket where available" (the WebSocket also needs a token).
- Linux is in the title and appears nowhere in the plan. Nothing here can be verified on Linux until the owner names a Linux environment.

### What will not survive contact with reality
- "Create one isolated AionUI team per ticket" via HTTP. Blocked on auth today. Even if a token is found, upstream says teams do not filter by user and the team session must be started before messaging, which adds two round trips and cleanup per ticket for no benefit over one conversation per ticket.
- Completion detection by polling a chat. Both adapters must be driven by a result contract; for AionUi that means the worker must write `result.json` into a workspace directory the daemon can read, because reading conversation messages needs the JWT we do not have.

### What I would cut from the MVP
React/Vite UI (replace with CLI commands `board`, `inbox`, `activity`, and later one static HTML page served by the daemon), `GIT_WORKTREE` workspace mode, `REASSIGNED` state, Manager/Submanager, Beads, email/push, Tauri, multi-user, claim machinery, the `messages` table. All of these come back only after the loop is proven end to end with a real worker.

## 3. The realistic route, in batches

Each batch can run to completion without waiting on a later decision.

- **Batch 1 (now): core engine with fake adapter, plus two spikes that decide the real adapter.** Three parallel roles, no shared files. Details below.
- **Batch 2: first real adapter.** Whichever spike came back cleanest becomes adapter number one (SOFT: Claude Code headless, because it has no auth problem). Worker envelope, `result.json` validation, retry on malformed result, cancel/timeout, blocked-by-user-decision flow, restart recovery. Automated test with the fake adapter; one recorded real run.
- **Batch 3: user surfaces and policy.** CLI `board`, `inbox`, `activity`, `decide`, `retry`; notification policy enforced in code with a table-driven test; directory workspace provider; local HTTP API only if a UI needs it.
- **Batch 4: proof and portability.** The three-ticket end-to-end (T1, T2 parallel, T3 waits) with a real adapter on Windows, then the same on the Linux environment the owner names. Failure injection: malformed result, worker hang, adapter unavailable, daemon restart mid-run.
- **Batch 5: AionUi as a second adapter**, using whichever access path the Batch 1 spike proved. If no path exists, this batch becomes "ask upstream / read AionCore source" and does not block anything else.
- **Batch 6 onward, only after the loop is proven:** Manager typed-command interface, Git worktrees, static status page, then the deferred list from the doc in the doc's order.

## 4. Batch 1 specification

Shared constraints for all three roles:
- Work happens in the git repository `C:\Users\yazan\Documents\Magarine\Magarine`. Each role writes only inside its own directory listed below. No role touches another role's directory.
- No secrets in any file or report: never print `AIONUI_*` values, tokens, or key material. Report status codes and shapes only.
- Every claim in a report is labelled HARD, SOFT, or UNKNOWN, with the command that produced it.

### Role A: Core Engineer — model tier: sonnet
Deliver, under `packages/core/` (TypeScript, Node 26, built-in `node:sqlite`, no native modules, `node:test` or vitest, pnpm):
1. SQLite schema and migration runner for `projects`, `tickets`, `ticket_dependencies`, `runs`, `events` (with `idempotency_key` unique, `visibility`, `requires_user`), `artifacts`.
2. Ticket state machine as a single transition table: OPEN, READY, IN_PROGRESS, REVIEW, DONE, BLOCKED, FAILED, CANCELLED. Every state change goes through one function that writes the event and the derived row in one transaction. Nothing else writes `tickets.status`.
3. Dependency resolver: a ticket is READY when all `blocks` dependencies are DONE.
4. Scheduler: a tick function that picks READY tickets up to `max_parallel_workers`, creates a `run`, calls the adapter, and applies the result. Retry with `attempt_count` up to `max_attempts`, then FAILED.
5. `AgentAdapter` interface exactly as in the doc, and a `FakeAdapter` whose behaviour per ticket is scripted in the test (succeed, retryable failure, question, needs-user-decision, malformed result, hang until cancelled).
6. Worker result contract: a JSON schema for `result.json` and a validator; malformed result is a retryable failure.
7. Restart recovery: on boot, any run left IN_PROGRESS with no live handle is marked failed-retryable and the ticket goes back to READY.
8. A thin CLI (`magarine`) with: `project create`, `ticket add`, `dep add`, `tick`, `run --until-idle`, `status`. JSON output flag.

Acceptance criteria:
- `pnpm test` passes on the owner's Windows machine with no native build step. The Orchestrator runs it, not the role.
- Tests cover: T1 and T2 run in the same tick while T3 waits, then T3 runs after both are DONE; retry exhaustion reaches FAILED; a malformed result is retried; restart recovery re-queues an orphaned run; replaying the event log reproduces the ticket statuses; a second identical event with the same idempotency key is ignored.
- Concurrency limit is respected under the fake adapter with hanging workers.
- `grep` for `status =` writes to tickets shows exactly one site.
- Short README in `packages/core/` stating how to run tests and the CLI.

### Role B: AionUi Access Investigator — model tier: sonnet
This role runs inside AionUi as a team agent, so it has the runtime environment. It changes nothing in AionUi except creating and then deleting throwaway conversations. It does not modify AionUi's database or config.
Deliver `docs/spikes/aionui-access.md` answering, each with HARD evidence or an explicit UNKNOWN with what was tried:
1. Does `aioncore conversation create` work from a team-member conversation (the skill text says not to; is it enforced)? Does it accept an arbitrary `workspace` and `assistant_id`?
2. Does `aioncore session send-message` start a turn in that new conversation? How do you tell when the turn has finished, from the CLI only? Does `diagnose conversations get` exist in 0.2.2?
3. Can a worker conversation be told to write `.orchestrator/result.json` into its workspace, and does the file appear where a plain external process can read it?
4. Can the helper CLI be run from a plain process outside AionUi if it is given the same four runtime variables? Does the token expire, and when? (Report yes/no and timing only, never the values.)
5. Is there any way for an external process to obtain a JWT for `/api/teams` and `/api/conversations`? Check `/api/auth/refresh`, `/api/auth/qr-login` plus `webui/generate-qr-token`, and whether the Electron app exposes a token anywhere it is designed to (not by decrypting `auth.enc`). Include the upstream AionCore source if it is public.
6. How would a daemon discover the backend port? (Log line `AIONCORE_LISTENING` is one candidate; is there a better one?)
7. Dump `conversation capabilities`, `session capabilities`, and `team capabilities` with secrets removed, as appendices.
8. A one-paragraph recommendation: which of "helper CLI from an AionUi-launched process", "JWT from X", or "no viable path today" is the AionUi adapter path.

Acceptance criteria: every one of the eight items has a labelled answer; every throwaway conversation created is deleted or listed by id for the owner to delete; no secret values appear anywhere in the document; the Orchestrator can rerun at least one HARD command from the doc and get the same result.

### Role C: Claude Code Headless Adapter Spike — model tier: sonnet
Deliver `docs/spikes/claude-cli-adapter.md` plus a throwaway script under `spikes/claude-cli/` (not under `packages/`):
1. From a Node child process on Windows, run `claude -p` with `--output-format json` and with `--json-schema` for the worker result contract, `cwd` set to a temp workspace, and a prompt that asks the worker to create one small file and write `.orchestrator/result.json`. Capture stdout JSON, exit code, duration, and the usage/cost fields.
2. Show how to restrict tools (`--allowedTools`), set a turn cap (`--max-turns`), enforce a wall-clock timeout, and cancel a running worker cleanly on Windows (does killing the process leave children?).
3. Document failure modes observed or forced: not logged in, invalid schema, worker never writes the file, non-zero exit. What does stdout look like in each case?
4. Confirm whether `stream-json` gives usable progress events and what they look like, so the daemon can log activity without an LLM.
5. Estimate per-run overhead (startup seconds, minimum tokens) from three real runs.

Acceptance criteria: at least one real run produced a schema-valid `result.json` and a parsed JSON envelope, with the raw outputs committed (secrets removed); each failure mode has the observed stdout/exit code; the Orchestrator can rerun the script and get a valid result. This role spends the owner's Claude usage; keep it to a handful of tiny runs.

### Verification the Orchestrator should do when the batch closes
Run `pnpm test` in `packages/core` yourself. Rerun one HARD command from each spike. Report to me: test output, the two spike recommendations, and anything a role marked UNKNOWN.

## 5. What the owner must decide or supply before Batch 1 starts

Written for the Liaison to relay as-is. Items 1 to 3 block Batch 1. Items 4 to 6 do not block it but shape Batch 2 and Batch 4.

1. **Language and runtime.** I plan to build the daemon in TypeScript on the Node 26 already installed, using Node's built-in SQLite so nothing needs compiling on Windows or Linux. Python 3.14 is the only other option on this machine. Is TypeScript on Node acceptable? (Blocks Role A.)
2. **Permission to spend a little Claude usage on tests.** One specialist needs to run the Claude Code command-line tool a handful of times (small, single-file tasks) to prove it can act as a worker. This uses your Claude subscription. OK? (Blocks Role C.)
3. **Permission to create throwaway conversations in AionUi.** One specialist needs to create a few test conversations inside AionUi, send them messages, and delete them afterwards, to learn how a program can drive AionUi. Nothing else in AionUi will be changed. OK? (Blocks Role B.)
4. **Which worker comes first.** The document assumes AionUi is the first worker backend. Today there is no documented way for an outside program to log in to AionUi, while the Claude Code command-line tool needs no login. I recommend making the Claude Code tool the first worker and AionUi the second, unless the investigation finds a clean login path. Are you OK with that order, or must AionUi be first no matter what?
5. **Where Linux gets tested.** The goal says Windows and Linux. Do you have a Linux machine, a server, or WSL on this PC that we can run the daemon on later? If none, say so and we will plan for WSL.
6. **The weekend deadline.** I am treating it as non-binding and proposing to cut the web UI, Git worktrees, and the Manager automation from the first working version so the core loop is proven first. If any of those three must be in the first version, tell me which.

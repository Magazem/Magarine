# @magarine/core

The Magarine orchestrator daemon core: SQLite-backed ticket state machine,
dependency resolver, scheduler, worker result contract, restart recovery, a
fake agent adapter, a real Claude Code CLI adapter, and a thin `magarine`
CLI.

## Requirements

- Node >= 24 (uses the built-in `node:sqlite` module and native TypeScript
  type stripping — no build step, no transpiler, no native/compiled
  dependencies).
- pnpm.

## Running the tests

```sh
cd packages/core
pnpm install
pnpm test
```

`pnpm test` runs `node --test`, which auto-discovers every `*.test.ts` file
under `src/` and executes it directly (Node strips the TypeScript types at
load time; nothing is compiled to disk first).

## Running the CLI

The CLI is not published as a `bin`; run it directly with Node:

```sh
node src/cli.ts project create --name "My Project" --json
node src/cli.ts ticket add --project <projectId> --title "T1" --json
node src/cli.ts ticket add --project <projectId> --title "T2" --json
node src/cli.ts ticket add --project <projectId> --title "T3" --json
node src/cli.ts dep add --project <projectId> --ticket <t3Id> --depends-on <t1Id>
node src/cli.ts dep add --project <projectId> --ticket <t3Id> --depends-on <t2Id>
node src/cli.ts run --until-idle --project <projectId> --max-parallel 2 --json
node src/cli.ts status --project <projectId> --json
```

Every command accepts `--json` for machine-readable output and `--db <path>`
to point at a specific SQLite file (default: `.magarine/magarine.db` under
the current directory). `tick` runs one scheduling pass; `run --until-idle`
loops `tick` until nothing new starts.

`tick`/`run --until-idle` accept `--adapter fake|claude` (default `fake`).
`fake` uses a fresh, unscripted `FakeAdapter` per invocation, so every ticket
trivially succeeds — enough to exercise the full
project/ticket/dependency/scheduler loop without a real worker. `claude`
spawns the real Claude Code CLI (`adapters/claudeCli.ts`) directly (never
through the `claude` npm shim, which is what corrupted arguments and made
workers unkillable in the Batch 1 spike). `--claude-exe <path>` overrides
the executable; if omitted, it defaults to `resolveExecutable('claude')`
(`process.ts`). For a persistent `DIRECTORY` workspace, add
`--workspace-root <dir>`; without it, each run gets a fresh `NONE` temp
directory that is deleted afterwards.

## Layout

```
src/
  db/           schema + migration runner, transaction helper
  store.ts      plain CRUD (not the ticket-status writer)
  stateMachine.ts   the ONE function that writes tickets.status
  dependencies.ts   promotes OPEN -> READY when blocking deps are DONE
  resultContract.ts JSON schema + validator for .orchestrator/result.json
  process.ts    all process control (spawn/timeout/kill) in one file
  envelope.ts   builds the worker prompt from a TicketEnvelope
  workspace.ts  NONE/DIRECTORY/GIT_WORKTREE workspace provider
  adapters/fakeAdapter.ts  scriptable AgentAdapter test double
  adapters/claudeCli.ts    real Claude Code CLI adapter
  scheduler.ts  tick() / runUntilIdle()
  recovery.ts   restart recovery for orphaned "running" runs
  cli.ts        the `magarine` CLI
  *.test.ts     tests, colocated with the module they cover
```

## Design decisions (spec was underspecified here)

The architecture doc (`technical-architecture-weekend-mvp.md`) gives the
`AgentAdapter` interface verbatim but does not fully specify every
supporting type, nor every `WorkerResult.status` value. Where the doc was
silent, this implementation made the following calls:

- **`WorkerResult.status` enum**: the doc's example only shows
  `"ready_for_review"`. To cover the full ticket lifecycle diagram (worker
  succeeds / passes auto-checks / retryable failure / question / user
  decision required), this implementation uses:
  `'done' | 'review' | 'needs_user_decision' | 'failed'`. A result is
  delivered as a terminal `WorkerEvent` of type `result_raw`; the scheduler
  validates it and maps `status` to a ticket transition.
- **Internal questions are events, not result statuses.** "Worker asks an
  internal question" (self-loop, ticket stays `IN_PROGRESS`) is modeled as a
  non-terminal `WorkerEvent` of type `question`, separate from the terminal
  `WorkerResult`. This matches the doc's lifecycle diagram, which treats the
  two as different branches.
- **`REVIEW` and `BLOCKED` are dead ends in this batch.** There is no CLI
  command to approve a `REVIEW` ticket into `DONE` or to resolve a `BLOCKED`
  ticket, because the spec's CLI command list for this batch is exactly
  `project create`, `ticket add`, `dep add`, `tick`, `run --until-idle`,
  `status` — no `approve`/`decide`. The transition table has no outgoing
  edge from `REVIEW` or `BLOCKED` yet. Batch 3 adds `decide`/`retry` per the
  strategy doc; wiring those in is a one-line addition to the transition
  table plus a CLI command, not a redesign.
- **A non-retryable adapter failure still goes through the retry-exhaustion
  path.** `WorkerEvent.failure` carries a `retryable` boolean, but this batch
  routes every failure (retryable or not) through the same
  `worker_retryable_failure` transition (attempt_count vs max_attempts).
  Nothing in the acceptance criteria required a distinct "fail immediately,
  ignore max_attempts" path, so one was not built.
- **`process.ts` only kills the direct child.** If a real worker CLI forks
  grandchildren, `stop()` will not reap them; that requires an OS-specific
  process-tree kill (Windows: `taskkill /T`; POSIX: process groups), which
  no adapter in this batch needs, since `FakeAdapter` never spawns a real
  process. Whichever Batch 2 adapter actually shells out should extend
  `process.ts`, not add a second process-control module.
  (Superseded in Batch 2: `process.ts` now does real tree-kill on both
  platforms — see that file's own header.)
- **`ClaudeCliAdapter` has no way to signal "cancel this run without
  consuming a ticket attempt, pause the adapter, alert the user"**, which
  `docs/strategy/batch-2-spec.md`'s Role E section asks for on a
  not-logged-in/auth failure. `WorkerEvent` (this file) only has
  `progress`/`question`/`result_raw`/`failure`, and `scheduler.ts`'s
  `applyWorkerEvent` routes every `failure` through the same
  `worker_retryable_failure` transition regardless of `retryable`. Adding a
  new `WorkerEvent` variant would be dead code without a matching
  `scheduler.ts` change, which is out of the adapter role's owned files.
  `adapters/claudeCli.ts` instead classifies this case correctly
  (`classifyOutcome`, `kind: 'adapter_unavailable'`) and emits the closest
  available signal: a non-retryable `failure` with an `ADAPTER_UNAVAILABLE`
  marker in the message.
- **Per-ticket budget override is schema-landed, not plumbed.** Migration
  `0003_budget_fields` adds `tickets.max_budget_usd_override`, but
  `TicketEnvelope` (built by `scheduler.ts`'s `buildEnvelope`) carries no
  budget field, so `ClaudeCliAdapter` has no way to receive a per-ticket
  override. It is constructed with one `maxBudgetUsd` for its whole
  lifetime, read from the project's `max_budget_usd` column by `cli.ts`.
  Wiring the override through requires a `scheduler.ts`/`types.ts` change
  outside this role's owned files.
- **Workspace routing is adapter-wide, not per-ticket.** `scheduler.ts`
  never passes a `workspace` into `startWorker`, and `TicketEnvelope` has no
  `workspaceType` field, so `ClaudeCliAdapter` cannot know a given ticket's
  configured workspace type. It is constructed with one `workspaceType`
  (`NONE` unless `--workspace-root` is given) applied to every run; an
  explicit `workspace` passed by a future caller overrides it per call.

## Cost visibility

`runs.usage_json` (added in migration `0002_runs_usage_json`) holds whatever
usage blob the adapter reports for a run — token counts, cache hit/miss,
cost, etc. — as opaque JSON. The daemon does not validate or interpret it,
only stores and displays it; shape is entirely adapter-defined. `FakeAdapter`
scripts can set it via the optional `usage` field on `succeed`,
`retryable_failure`, and `needs_user_decision` scripts.

## What was not built

Batch 1: per the batch spec, nothing beyond the eight numbered deliverables
was attempted: no real adapter, no HTTP API, no UI, no Manager/Submanager,
no Git worktree provider. `packages/core/` does not depend on anything
outside itself (still true in Batch 2).

Batch 2 (Role E, Claude Code adapter): `GIT_WORKTREE` still throws "not
supported yet" (`workspace.ts`); the "cancel a run without consuming an
attempt" and per-ticket budget override gaps are described above under
"Design decisions"; the `budget exceeded` failure classification is
SOFT/UNKNOWN — no spike run ever forced it
(`docs/spikes/claude-cli-adapter.md` §2.4), so `adapters/claudeCli.ts`'s
pattern match on the error message is inferred, not observed.

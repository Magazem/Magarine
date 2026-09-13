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
node src/cli.ts project create --name "My Project" --brief "One-paragraph project brief" --json
node src/cli.ts ticket add --project <projectId> --title "T1" --json
node src/cli.ts ticket add --project <projectId> --title "T2" --json
node src/cli.ts ticket add --project <projectId> --title "T3" --json
node src/cli.ts dep add --project <projectId> --ticket <t3Id> --depends-on <t1Id>
node src/cli.ts dep add --project <projectId> --ticket <t3Id> --depends-on <t2Id>
node src/cli.ts run --until-idle --project <projectId> --max-parallel 2 --json
node src/cli.ts status --project <projectId> --json
node src/cli.ts board --project <projectId> --json
node src/cli.ts inbox --project <projectId> --json
node src/cli.ts activity --project <projectId> --json
node src/cli.ts decide --ticket <ticketId> --answer "use option A" --json
node src/cli.ts retry --ticket <ticketId> --json
node src/cli.ts approve --ticket <ticketId> --json
node src/cli.ts reject --ticket <ticketId> --reason "missing test coverage" --json
node src/cli.ts resume --project <projectId> --json
```

`ticket add` also takes `--workspace NONE|DIRECTORY` (default `NONE`), a
per-ticket `--budget <usd>` override, a repeatable `--acceptance
"<criterion>"`, and a repeatable `--depends-on <id>` so a ticket can be
created with its dependencies wired in the same command:

```sh
node src/cli.ts ticket add --project <projectId> --title "T3" \
  --acceptance "criterion one" --acceptance "criterion two" \
  --depends-on <t1Id> --depends-on <t2Id> --budget 0.50 --json
```

Readiness is resolved only after every `--depends-on` from that same command
has been attached, never before — a ticket created with dependencies is
never briefly `READY` while some of them are still missing.

`project create` also takes `--brief "<text>"` (seeds `projects.brief`, read
into every worker's `TicketEnvelope.projectBrief`) and `--workspace-root
<dir>` (seeds `projects.workspace_root`: one shared directory for the whole
project, required once any ticket in it uses `--workspace DIRECTORY`).
Both default to `null`/unset if omitted.

`project create --max-spend <usd>` and `project set --project <id> --max-spend
<usd>` set the project's spend cap (see "Budget and spend caps" below).
`project set` also refuses (clean message, no stack trace) if the project id
doesn't exist.

`project create --model <model>` sets `projects.default_model` (default
`claude-sonnet-5` if omitted); `project set --project <id> --model <model>`
changes it later. `ticket add --model <model>` overrides the project default
for one ticket alone (`null`/unset falls back to the project's). The adapter
passes whichever value resolves (ticket override, else project default) to
the tool via `--model` on every spawn — nothing about a worker's cost or
capability depends on the owner's desktop default. See "Budget and spend
caps" above for why this exists: a per-model rate table (`pricing.ts`) is
meaningless if the daemon doesn't control which model actually ran.

### State directory

Nothing is written under the current working directory unless the user asked
for it. Every subcommand resolves its state directory in this order:

1. `--state-dir <dir>`, if given.
2. Else the `MAGARINE_HOME` environment variable, if set.
3. Else `<home directory>/.magarine/`.

The database lives at `<state dir>/magarine.db`, worker artefacts at
`<state dir>/artifacts/`. `--db <path>` remains a separate, explicit
override: if given, it is used verbatim and the state directory is not
consulted for the database path at all (though `--state-dir`/`MAGARINE_HOME`
still govern the artefacts directory in that case). This logic lives in one
place, `paths.ts`, and both `cli.ts` and `scheduler.ts`'s `artifactsDir`
default go through it.

This matters beyond tidiness: a daemon defaulting to the working directory
means real worker output can land inside whatever project's repository
happened to be checked out where the daemon was launched from — exactly what
an earlier close-out on this project found had happened with the artefact
store's old `<cwd>/.magarine/artifacts` default.

### Budget and spend caps

Three layers, from the hard control down to the least reliable:

1. **Project spend cap (`project create --max-spend <usd>` /
   `project set --max-spend <usd>`).** Before spawning a run, the daemon
   sums recorded spend across the project's tickets, adds the new run's
   ceiling, and refuses to spawn if the total would exceed the cap. This is
   the only layer the daemon fully controls, because not spawning is a
   decision it never has to unwind.
2. **The tool's own `--max-budget-usd` flag, which is the real
   enforcement for this adapter.** It prices every category (input, output,
   both cache-write TTLs, cache-read) from its own authoritative
   between-turn accounting, so it is accurate where the daemon's own tally
   below is not.
3. **The daemon's own running tally (`ticket add --budget <usd>`, else the
   project default), which is a live display plus the fallback for an
   adapter with no flag of its own — not a second enforcement layer.** Batch
   6 found that mid-run token counts on the stream undercount true output
   token usage by an amount that varies with how output-heavy the run is (see
   `pricing.ts`/`claudeCli.ts`), so this tally can under-report real spend
   and must not be trusted to stop a run before the tool's own flag does.
   Numbers shown from this tally (on the board, in the inbox) are labelled
   "at least $x, live estimate"; a completed run's exact, tool-reported
   figure is shown unlabelled once it lands.

**Known limitation, stated plainly:** the tool checks spending *between*
turns, not during one, so a run can exceed its ceiling by up to the cost of
one turn. On a trivial ticket, one turn is close to the floor price, so a
very low ceiling can look "overshot" many times over without any runaway
spend actually happening — the overshoot is bounded, not unbounded. The
daemon's own tally (layer 3) has no such bound on an output-heavy,
cache-light run, which is exactly why it is not the enforcement layer.

`board` shows the project's total spend against its cap at the top of its
output, and each ticket's own spend on its row (see below).

### How a run stops on cost

Three independent mechanisms can end a run because of its budget, in the
order they normally fire in practice:

1. **The worker's own stop, with an explanation.** Every worker prompt
   (`envelope.ts`'s `buildWorkerPrompt`) states the ticket's budget ceiling in
   dollars. A worker that reads that line, tracks its own per-turn spend, and
   concludes it cannot finish reports `status: 'budget_insufficient'` in its
   result rather than continuing past the ceiling hoping it will fit — the
   cheapest possible stop, since nothing further is spent once it decides,
   and the only one of the three that explains *why* in the owner's own
   words. It is not retryable and does not consume an attempt
   (`stateMachine.ts`'s `worker_budget_stop` transition, persisted under the
   same `worker_failed_final` concrete type any other FAILED-final failure
   uses — see that transition's comment for why): retrying under the same
   ceiling would just reproduce the identical stop, so the record must say
   "raise the budget", not "try again". This was found, not designed —
   `docs/strategy/batch-6-closeout.md` section 3 — when four straight paid
   runs never reached either guard below because a worker always got there
   first.
2. **The tool's own `--max-budget-usd` flag**, checked between turns against
   its own authoritative per-category accounting (layer 2 of "Budget and
   spend caps" above). This is what stops a run whose worker never self-limits
   — one that doesn't track its own spend, or one running with the budget
   line deliberately hidden (see "Exercising the guards" below) — and it is
   accurate where the daemon's own tally is not.
3. **The daemon's own live tally** (layer 3 above), a running estimate that
   is a known *lower bound* on true spend, not a second enforcement layer.
   It rarely fires in practice — not because it is broken, but because
   layers 1 and 2 almost always get there first, and being redundant with
   a more accurate guard on every adapter that has one is the correct
   outcome, not a defect. It is the ONLY guard for an adapter that reports no
   budget flag of its own, and the only one that can stop a run that hangs
   or times out rather than erroring, which is why it stays even though a
   real budget-stopped run rarely needs it. See the known limitation
   above (one turn's worth of overshoot is possible either way).

**Exercising the guards.** A worker informed of its ceiling self-limits so
reliably (mechanism 1) that four real paid runs never reached mechanisms 2 or
3 at all (`docs/strategy/batch-6-closeout.md` section 3) — the Strategist
ruled this stays true in production, so the fix is a way to *test* the other
two guards, not to weaken mechanism 1. Lowering `store.ts`'s `MIN_BUDGET_USD`
floor to force an early stop was also refused: the floor is a real safety
property, and weakening it for test convenience is how safety properties
die. Instead, `MAGARINE_TEST_OMIT_ENVELOPE_BUDGET=1` (read in exactly one
place, `envelope.ts`'s `buildWorkerPrompt`) drops the budget line from the
prompt entirely, so a blinded worker behaves exactly like one whose envelope
never carried `maxBudgetUsd` — free to spend past the ceiling with no way to
self-limit, so mechanisms 2 and 3 are what actually stop it. **Test-only**:
`buildWorkerPrompt` refuses (throws) if this variable is set for a workspace
that is not under the OS temp directory, so it can never be used, by
accident or otherwise, to blind a real, non-throwaway run.

### Surfaces: `board`, `inbox`, `activity`, `decide`, `retry`, `approve`, `reject`, `resume`

- **`board --project <id>`**: the project's total spend against its
  `--max-spend` cap (or "no cap set" if none was given) on the first line,
  then every ticket in the project, one line each, ticket id first: id,
  status, title, attempts (`n/max`), cost (sum of `total_cost_usd` across
  the ticket's runs), and, if any, which of its blocking dependencies are
  not yet `DONE`. Ticket spend sums that ticket's own runs; project spend
  sums every ticket's spend in turn.
- **`inbox --project <id>`**: events that need the user's attention and are
  still unresolved. Ticket-scoped: a `worker_needs_user_decision` while its
  ticket is still `BLOCKED`, a `worker_needs_review` while its ticket is
  still `REVIEW`, an exhausted retry or rejection (`worker_failed_final`,
  reason on the line) while its ticket is still `FAILED`. Project-scoped:
  `project_spend_cap_reached` (the run that would have exceeded the cap,
  and by how much, on the line) while the project's pause is still in
  effect. Id first on every line either way — ticket id for a ticket-scoped
  item, project id for a project-scoped one. There is no separate
  "acknowledged" flag; an item stops appearing on its own once
  `decide`/`retry`/`approve`/`reject`/`resume` moves the ticket or project
  past the state that put it there.
- **`activity [--project <id> | --ticket <id>] [--all]`**: the event log,
  collapsed by default (internal bookkeeping events hidden); `--all` shows
  everything, including those.
- **`decide --ticket <id> --answer "<text>"`**: answers a `BLOCKED`
  ticket's pending question and moves it to `READY`. Refuses (clean
  message, no stack trace) if the ticket isn't `BLOCKED`. Records a
  `user_decision` event (`{ ticketId, question, answer }`) — this is also
  the state machine transition itself, not a separate notification; the
  question text is pulled from the ticket's most recent
  `worker_needs_user_decision` event.
- **`retry --ticket <id>`**: manually retries a `FAILED` ticket via the
  `manual_retry` transition, which moves it back to `READY` and raises its
  `maxAttempts` by one. Refuses if the ticket isn't `FAILED`.
- **`approve --ticket <id>`**: moves a `REVIEW` ticket to `DONE` via
  `review_approved`, then resolves the project's dependents' readiness —
  the same as a worker-reported `worker_done` does — so a dependent blocked
  only on this ticket becomes `READY` immediately, without a separate
  `tick`. Refuses if the ticket isn't `REVIEW`.
- **`reject --ticket <id> --reason "<text>"`**: returns a `REVIEW` ticket to
  `READY` via `review_rejected`, consuming one attempt, same as an ordinary
  worker failure. On the last attempt it exhausts to `FAILED`, persisted as
  `worker_failed_final` (the same outcome type any other exhausted failure
  reaches), reason attached, and reaches the inbox the same way. `--reason`
  is required. Refuses if the ticket isn't `REVIEW`.
- **`resume --project <id>`**: clears a project's pause, whatever caused it
  — an `adapter_unavailable` failure or a `project_spend_cap_reached`
  refusal both trip the same pause, so one command clears either. Refuses
  if the project isn't paused, or doesn't exist.

All eight accept `--json`.

### Notification policy (`policy.ts`)

`policy.ts` implements `technical-architecture-weekend-mvp.md`'s
"Notification policy" table as data: `classify(eventType)` returns
`{ visibility, requiresUser }` for every event type the state machine's
`TransitionEvent` union can emit. A completeness test
(`policy.test.ts`) parses that union directly out of `stateMachine.ts`'s
source (rather than a hand-copied list, and without editing that file — see
below) and fails the build if a transition event has no row.

`classify` is wired into `stateMachine.ts`'s write site: every transition's
`visibility`/`requires_user` is derived from `policy.ts` there, not taken
from the caller. `RecordTransitionInput.visibility`/`.requiresUser` are kept
on the type as ignored/deprecated fields (some existing call sites in
`scheduler.ts`/`dependencies.ts` still pass them; they are now dead
parameters, harmless to leave and not this role's file to clean up) rather
than removed, so nothing else needed to change to pick up the wiring.

Several event types new to this batch (`manual_retry`, `run_cancelled`,
`artifact_collision`, `user_decision`) have rows even though most are not
named in the architecture document; where the document is silent,
`policy.ts` applies its own stated default ("silent by default") rather than
inventing a tier, and says so in a comment on each row. `run_cancelled` was
flagged in part 1 as the most uncertain row (it seemed to back both an
adapter-pause cancellation that should reach the inbox, and a plain shutdown
cancellation that shouldn't); reading Role F's landed implementation
resolved this — `adapter_unavailable` is its own separate event
(`inbox`/`requiresUser`), fired alongside `run_cancelled` rather than
folded into it, so `run_cancelled` itself never needs to reach the inbox on
its own. `policy.ts` also documents (but does not wire, since neither goes
through `recordTicketTransition`) two more event types scheduler.ts emits
directly: `adapter_unavailable` and `workspace_preparation_failed`, both
`inbox`/`requiresUser`.

Every command accepts `--json` for machine-readable output, plus `--db
<path>` and `--state-dir <dir>` -- see "State directory" below for how the
database and artefact paths are actually resolved. `tick` runs one
scheduling pass; `run --until-idle` loops `tick` until nothing new starts.

`tick`/`run --until-idle` accept `--adapter fake|claude` (default `fake`).
`fake` uses a fresh, unscripted `FakeAdapter` per invocation, so every ticket
trivially succeeds — enough to exercise the full
project/ticket/dependency/scheduler loop without a real worker. `claude`
spawns the real Claude Code CLI (`adapters/claudeCli.ts`) directly (never
through the `claude` npm shim, which is what corrupted arguments and made
workers unkillable in the Batch 1 spike). `--claude-exe <path>` overrides
the executable; if omitted, it defaults to `resolveExecutable('claude')`
(`process.ts`). Workspace is resolved per ticket now (each ticket's own
`--workspace`, plus the project's `--workspace-root` from `project create`
for `DIRECTORY`'s one shared directory) rather than as a `tick`/`run` flag —
there is no lifetime `--workspace-root` on `tick`/`run` any more; giving one
is reported as an unknown flag.

`--run-timeout <seconds>` caps how long a single run is allowed to take
before the scheduler cancels it itself (`SchedulerDeps.runTimeoutMs`,
milliseconds under the hood): the run is marked `cancelled`
(`failureClass: 'run_timeout'`) and its ticket goes back to `READY` without
consuming an attempt, the same as a SIGINT/SIGTERM cancellation. Omit it for
no cap (the previous, still-default behaviour).

With `--adapter fake` (the default), `--fake-script <ticketId>=<kind>`
(repeatable) scripts the permanent `FakeAdapter` test double per ticket id —
`succeed` (default if unscripted), `retryable_failure`, `question`,
`needs_user_decision`, `malformed_result`, or `hang` — so a scenario like "this
ticket needs a user decision" can be driven through the real CLI, e.g. for
trying `decide`/`inbox` by hand:

```sh
node src/cli.ts tick --project <projectId> --fake-script <ticketId>=needs_user_decision --json
```

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
  policy.ts     notification policy table: classify(eventType) -> visibility/requiresUser
  commands/     board, inbox, activity, decide, retry, approve, reject, resume (cli.ts stays thin)
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
  `'done' | 'review' | 'needs_user_decision' | 'failed' |
  'budget_insufficient'`. A result is delivered as a terminal `WorkerEvent`
  of type `result_raw`; the scheduler validates it and maps `status` to a
  ticket transition. `budget_insufficient` (batch 7) is `'failed'`'s
  budget-specific sibling: same terminal shape, but routed to its own
  non-retryable, no-attempt-consumed transition instead of the generic
  retryable one — see "How a run stops on cost" above.
- **Internal questions are events, not result statuses.** "Worker asks an
  internal question" (self-loop, ticket stays `IN_PROGRESS`) is modeled as a
  non-terminal `WorkerEvent` of type `question`, separate from the terminal
  `WorkerResult`. This matches the doc's lifecycle diagram, which treats the
  two as different branches.
- **Superseded in Batch 3: `BLOCKED` is no longer a dead end.** `decide`
  resolves it via the `user_decision` transition. (Batch 3's scope was
  `decide`/`retry` specifically, not a `REVIEW` -> `DONE` approval flow.)
- **Superseded in Batch 4: `REVIEW` is no longer a dead end either.**
  `approve`/`reject` resolve it via `review_approved`/`review_rejected` —
  see "Surfaces" above.
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
- **Superseded in Batch 3 (Role F, the scheduler seam):** the two gaps
  originally described here are closed. Per-ticket budget override is
  plumbed: `TicketEnvelope.maxBudgetUsd` is resolved (ticket override, else
  project default) by `scheduler.ts`'s `buildEnvelope`/`resolveMaxBudgetUsd`.
  Workspace routing is per-ticket, not adapter-wide: `scheduler.ts`'s
  `tick()` prepares each ticket's own workspace and passes it into every
  `startWorker` call, which `ClaudeCliAdapter` always prefers over its
  constructor default — see `cli.ts`'s `buildAdapter`, which now constructs
  the adapter with a placeholder `workspaceType: 'NONE'` that nothing reads
  at runtime, rather than deriving one from a lifetime `--workspace-root`
  flag (removed; see the `tick`/`run --until-idle` section above).

## Cost visibility

`runs.usage_json` (added in migration `0002_runs_usage_json`) holds whatever
usage blob the adapter reports for a run — token counts, cache hit/miss,
cost, etc. — as opaque JSON. The daemon does not validate or interpret it,
only stores and displays it; shape is entirely adapter-defined. `FakeAdapter`
scripts can set it via the optional `usage` field on `succeed`,
`retryable_failure`, and `needs_user_decision` scripts.

## A worker that keeps talking after being stopped

The scheduler sometimes decides to stop a worker itself — a budget overspend,
a wall-clock timeout, `SIGINT`/`SIGTERM`, or a project's adapter pausing —
and records the run's outcome right then. The adapter's own process, having
just been killed, does not go quiet immediately: the real adapter's
underlying `wait()` promise still resolves once the OS finishes killing it,
and it still publishes its own terminal event off the back of that (see
`adapters/claudeCli.ts`'s `managed.wait().then(...)`). `FakeAdapter` and the
test suite's own `TestAdapter` mirror this on purpose — any behaviour
observed in the real adapter is mirrored in the fake in the same batch — so
every one of the scheduler's tests exercises the same race a real run does.

Without a guard, that second event lands on a ticket that has already moved
out of `IN_PROGRESS`, and `stateMachine.ts` correctly refuses the transition
by throwing `InvalidTransitionError` — which, uncaught, used to kill the
daemon at exactly the moment its own cost control had just worked
(`docs/strategy/batch-4-closeout.md` section 2). Three independent guards in
`scheduler.ts`/`store.ts` fix this:

1. **First terminal outcome wins.** Before applying any adapter event, the
   scheduler reads that run's *live* status from the store, not an in-memory
   flag — this is what makes it total across every path that can settle a
   run (the scheduler's own stop-initiated failure, and `cancelTicketRun`'s
   timeout/SIGINT/adapter-unavailable paths, none of which share the first
   path's per-run bookkeeping). A run no longer `running` means some event
   already won; the new one is recorded as an internal `late_worker_event`
   (with its class and any usage it carried, for diagnostics) and otherwise
   dropped — no transition, no run-row write. The one exception: if the
   settled run row has no usage recorded yet, a late event's usage is merged
   in, because cost must never be lost.
2. **The store never overwrites a settled run.** `finishRun`'s `UPDATE`
   carries `WHERE status = 'running'` and reports whether it actually applied.
   This protects the run row even from a caller that gets guard 1 wrong.
3. **A catch-all keeps the daemon alive regardless.** The entire body that
   applies one adapter event to one run is wrapped in a single `try`/`catch`.
   Anything guards 1 and 2 didn't anticipate is recorded as an internal
   `scheduler_error` (itself wrapped in a swallow, so recording the failure
   can never become a second unguarded throw) and the daemon keeps running —
   the other runs in flight are never affected by one run's throw.

The upshot for an operator: a run that gets stopped always resolves to
exactly one recorded outcome, chosen by whichever terminal event the
scheduler processes first, and nothing a killed worker says afterward can
change that outcome, corrupt another run, or take the daemon down. See
`scheduler.test.ts`'s batch 5 tests for the exact scenarios this covers.

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

Batch 3 (Role G, surfaces and policy): no `REVIEW` -> `DONE` approval
command (see "Design decisions" above; closed in Batch 4, see below).
`worker_retryable_failure`'s two document rows (ordinary retry vs.
retry-limit-exhausted) collapse onto one policy row, since `classify(eventType)`
has no way to tell them apart from the event type alone — this is a real,
unresolved gap escalated to the Strategist, not a decision made here (closed
in Batch 4: see `worker_failed_retryable`/`worker_failed_final` below).
`adapter_unavailable` and `workspace_preparation_failed` are documented in
`policy.ts` but not wired through `classify` (they never go through
`recordTicketTransition`, so there is no write site in this role's files to
wire them into).

Batch 4 (Role I part 2, review flow): `approve`/`reject`/`resume --project`
land the review flow this role's spec closed off in Batch 3, and the failure
split named above (`worker_failed_retryable` vs. `worker_failed_final`,
Role H) is what lets `worker_failed_final` reach the inbox with a reason on
the line regardless of whether it came from an exhausted retry or an
exhausted rejection.

Batch 5 (Role J, supervisor hardening): the second cost-rate calibration
fixture (`docs/strategy/batch-5-spec.md` section 1 ruling 3) does not exist
in this repository as of this batch — it comes from this batch's own paid
budget-stop run, which is the Orchestrator's close-out step, done after this
code lands. `adapters/claudeCli.ts`'s `BLENDED_USD_PER_RAW_TOKEN` is
therefore still calibrated against the single batch 4 fixture; confirmed
HARD, though, that the stream it's calibrated against carries no
per-message cost field that would make the constant unnecessary (see that
constant's own header comment).

Batch 6 (Role K, pricing and model control): `BLENDED_USD_PER_RAW_TOKEN` is
removed; `pricing.ts`'s `priceUsage` prices per model and per token category
instead, verified exact (0.000% off) against both fixtures at the
*completed*-run level. The *mid-run* tally cannot be made accurate the same
way: assistant-line usage undercounts true output tokens by an amount that
varies with how output-heavy the run is (16.1% and 6.1% of true on the two
fixtures this repo has), with no other signal on the stream carrying the
difference. A character-count proxy for output length was tried, per the
Strategist's ruling, and closed only 3.15%/9.37% of that gap on the two
fixtures — dropped, not shipped, because it does not close "most" of the
gap the ruling required. See "Budget and spend caps" above for the resulting
division of labour: the tool's own `--max-budget-usd` flag is the real
enforcement; the daemon's tally is a labelled lower-bound display. A real
tool-side budget stop was found to be silently mis-recorded as the generic
`adapter_failure` (never had a `failureClass` at all); fixed, and a
`stoppedBy` field now distinguishes the tool's stop from the daemon's own.
Model pinning is built: `projects.default_model`/`tickets.model`
(migration `0006_model_pinning`), `resolveModel` (ticket override, else
project default, mirroring `resolveMaxBudgetUsd`), the adapter passes
`--model` on every spawn, and `usage_json` records the model each estimate
or completed total was computed for. `--model` as the flag's exact spelling
is HARD-confirmed against this machine's installed `claude --help`, but no
fixture in this repo's `spikes/claude-cli/runs/` was ever recorded with the
flag set, so end-to-end behaviour under a real pinned worker is unverified
until the Orchestrator's close-out run. The terminal `result` line's
`modelUsage` field (found this batch, present on every real fixture's
terminal line, keyed by the exact canonical model string) is what both the
completed-run unknown-model check and `usage_json.model` prefer over the
requested model, since it's what the run actually billed under rather than
what was merely asked for. Not built: `claude-opus-5`'s rate-table key is
still unverified against any real stream line (no fixture uses it) —
`claude-haiku-4-5-20251001`'s `modelUsage` key does match `pricing.ts`'s
table today in the sense that both are the spec's literal name, but neither
has been confirmed against a live run yet; either way, an unpinned/mismatched
model falls back to the loud unknown-model rate rather than mispricing
silently, but this is a real gap, not a closed one, until a real run
confirms them.

Batch 7 (Role L, budget semantics and the blinding switch): the worker's own
budget self-stop (`budget_insufficient`/`worker_budget_stop`, see "How a run
stops on cost" above) is built and tested end to end through
`scheduler.ts`/`stateMachine.ts`/the `FakeAdapter`, with a replay test
proving the concrete `worker_failed_final` event a real database would hold
folds back to the same unchanged attempt_count the live write path produces.
**Two gaps outside this role's owned files, found while building this, are
NOT closed:**

- **`adapters/claudeCli.ts`'s `mapWorkerStatus` (not owned by this role) has
  no case for `'budget_insufficient'`.** A real worker that follows this
  batch's new prompt instruction and writes `status: 'budget_insufficient'`
  to `.orchestrator/result.json` will have that status fall through
  `mapWorkerStatus`'s `default: null`, and `classifyOutcome` will turn it
  into a generic `{ kind: 'retryable', reason: 'unrecognized result status:
  budget_insufficient' }` — the exact misclassification this role exists to
  fix, reintroduced one layer down, in the one file this batch could not
  touch. The fix is one line (`case 'budget_insufficient': return
  'budget_insufficient';` alongside `mapWorkerStatus`'s existing cases). This
  blocks the Orchestrator's paid run C (an informed worker exercising this
  exact path) until it lands.
- **There is no `ticket set --budget <usd>` CLI subcommand** — only `ticket
  add --budget` sets an override, at creation time. The acceptance criterion
  "`retry` after `ticket set --budget`" is exercised in
  `scheduler.test.ts` directly against `store.ts`'s `setTicketBudgetOverride`
  (the same layer `ticket add --budget` itself writes through) and
  `stateMachine.ts`'s `manual_retry` transition (the same one
  `commands/retry.ts`'s `retry` calls) instead of inventing a subcommand,
  since `cli.ts`'s ticket flags are not this role's file to extend beyond
  `--fake-outcome`.

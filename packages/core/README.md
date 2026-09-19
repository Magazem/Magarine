# @magarine/core

The Magarine orchestrator daemon core: SQLite-backed ticket state machine,
dependency resolver, scheduler, worker result contract, restart recovery, a
fake agent adapter, a real Claude Code CLI adapter, a daemon mode
(`magarine serve`) with its own token-authenticated HTTP API, and a thin
`magarine` CLI.

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

### The spawned-pipeline rule

Since Batch 8, every result status and failure class the daemon can produce
is expected to have a test that spawns the real fake `claude` executable
through the real `ClaudeCliAdapter` through the real `scheduler.ts`'s
`tick()`, not just one that drives `FakeAdapter` or `classifyOutcome` in
isolation — three separate defects on this project were correct where built
and silently discarded at the join between the two, invisible to a suite
that only ever exercised the stand-in (see `managerSpawnedPipeline.test.ts`'s
header comment for the fuller story). Batch 9 built the first such test, for
a `manager`-kind ticket's `done`/`manager_proposal` path only; Batch 10
(`workerSpawnedPipeline.test.ts`) applies the same rule backwards, to every
status and failure class that predated it: `done`, `review`,
`needs_user_decision`, `failed`, `budget_insufficient`, a malformed result, a
declared-but-missing artefact, a tool-side `budget_exceeded`, a timeout, and
the not-logged-in `adapter_unavailable` path — the last of which turned out
to expose a real, currently-shipped gap (see "What was not built" below).
Every test in that file is mutation-checked: the file's own comments record,
per test, the exact line changed to prove the test can fail, and what
happened when it was changed.

## Running the CLI

Batch 10 (Role Q) added a `bin` entry (`package.json`), so `npm install -g .`
or `pnpm link --global` from this directory puts `magarine` on the PATH --
see the root `README.md` for that path, written for the product's owner
rather than for this package's own contributors. From inside this directory,
`node src/cli.ts` still works exactly the same, with no install step:

```sh
node src/cli.ts project create --name "My Project" --brief "One-paragraph project brief" --json
node src/cli.ts project list --json
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
node src/cli.ts cancel --ticket <ticketId> --json
node src/cli.ts serve --state-dir <dir> --json
```

`cancel` and `serve` are Batch 8 additions — see "Daemon mode" below.

`ticket add` also takes `--workspace NONE|DIRECTORY` (default `NONE`), a
per-ticket `--budget <usd>` override, a repeatable `--acceptance
"<criterion>"`, a repeatable `--depends-on <id>` so a ticket can be created
with its dependencies wired in the same command, and a repeatable
`--expected-artifact <path>` (DONE is rejected unless every declared path is
among what the worker delivers; omit the flag and today's rule applies —
any delivered artefact satisfies DONE):

```sh
node src/cli.ts ticket add --project <projectId> --title "T3" \
  --acceptance "criterion one" --acceptance "criterion two" \
  --depends-on <t1Id> --depends-on <t2Id> --budget 0.50 \
  --expected-artifact out.md --json
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

`project create --max-parallel <n>` and `project set --project <id>
--max-parallel <n>` set the project's own worker cap (ruling 23, batch 15
addendum 10): a whole number of 1 or more, refused with the same message by
both (one validator in `store.ts`, also behind the daemon's `POST
/projects/{id}/set`). Batch 16 (ruling 23 items 4-5, migration 0014): the
default is now NULL — no cap of its own — so a project created without the flag
is governed by `serve --max-parallel` alone (see "Running it"); `project set
--max-parallel none` clears an explicit cap back to NULL. Projects that already
had a value keep it (they were created under the old meaning, "one at a time").
`--max-parallel` is validated by that same validator on `serve`, `tick` and
`run` too: `0` and non-numbers are refused with the flag named, and `serve`
refuses before it opens the database or binds a port. The effective cap under
`serve` is the smaller of an explicit project cap and `serve --max-parallel`,
which is why `serve`'s human listening line names "up to <n> workers at once".

**Readiness (Batch 16, ruling 24).** `readiness.ts`'s `projectReadiness(project,
stateDir)` is the one check of whether a project can run a worker: it has a
`workspace_root`, that directory is safe (ruling 22's three rules), and it has a
`scope_path`. The scheduler asks it before starting ANY run, manager or worker;
a failing project is paused with `pause_reason` set to the rule
(`missing_workspace_root`, `unsafe_workspace_root`, `missing_scope_path`), and the
board and inbox say so with the fix, `magarine project set --project <id> --dir
<folder>` — which also resumes the project, no separate command. `project
create`/`project set --dir`'s ruling 22 refusal calls the same function.
Nothing is healed: the product never picks a directory for a project. The
`update_scope` validator error in `proposal.ts` stays as defence in depth, now
unreachable in practice. **Scope document (Batch 16, ruling 29):** a missing
`SCOPE.md` is NOT a readiness failure — `plan` does not refuse, because the
talk-first interview is a deliberate start — but it is never silent:
`project create` and `plan` print `scope document: <path> (not found; write it
before plan, or the Manager will start by interviewing you)`, `project list`
marks the row `no scope yet` (`--json`: `scope: {path, status}`), and the
Manager's brief says the document "does not exist yet" rather than showing an
empty one. A scope document that EXISTS but cannot be read (permissions, or a
directory at that path) is a fourth readiness rule, `unreadable_scope_file`:
the project pauses with the path named, and after fixing the file the owner runs
`magarine resume --project <id>`. `readScopeText` returns `{text, status}` and
throws on any error that is not ENOENT; `projectReadiness` stays pure, taking the
filesystem as an injected `probe`. `project list` marks such rows `needs --dir`, and
`--json` carries `readiness: null | { rule, fix }`.

`project list` (Batch 10, Role Q) prints every project in this state
directory's database -- id, name, default model, spend against its cap, and
ticket counts by status -- the read path back to a project's id if it's been
lost or the terminal that created it is gone. Every command taking
`--project` (this includes `board`/`inbox`/`status`, which now also refuse
an unknown project instead of silently returning an empty result -- see
`cli.ts`'s `resolveProjectRef`/`NoSuchProjectError`) accepts either the
project's id or its exact name. `status` with NO `--project` (Batch 16) reports the daemon instead: pid, port, the page address and `N of M slots in use` (from `/health`), or `no daemon running -- start one with `magarine serve`` (`--json`: `{daemon: null | {pid, port, page, slots}}`); an ambiguous name (`projects.name` has no
uniqueness constraint) refuses and lists every matching id rather than
silently picking one.

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

**Concurrent access (Batch 8).** Before daemon mode, only one process ever
held `magarine.db` open at a time. Now the daemon holds it open continuously
while a `board`/`status`/`inbox`/`activity` read (or a mutating command
falling back to a direct write — see "Daemon mode" below) opens a second,
independent connection to the same file at any moment. `db/index.ts`'s
`openDb` sets `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`
on every connection it opens (daemon and CLI alike) for exactly this reason:
SQLite's default rollback-journal mode can block a reader on an in-flight
writer, and node:sqlite's default `busy_timeout` is `0` — a connection that
does find the file locked fails immediately (`SQLITE_BUSY`) instead of
waiting. This was found, not designed: writing this batch's own tests
surfaced a real occasional failure in a plain `status --json` read racing
the daemon's own write, under heavy concurrent load. WAL lets readers
proceed alongside an in-flight writer (only writer-vs-writer contention is
still serialized); `busy_timeout` covers that remaining case, and the brief
window around a WAL checkpoint, by waiting up to five seconds — comfortably
longer than any single transaction this codebase runs — rather than failing
instantly. `db/index.test.ts` proves each pragma's own effect against a
real second process: many rapid reads with zero failures while a real
writer commits continuously, and a blocked write that waits for a real
lock-holding process to release rather than throwing right away. HARD-verified
on Windows: `journal_mode = WAL` is silently ignored (stays `memory`, no
error) against `:memory:`, which every in-process test in this codebase
uses, so it is safe to set unconditionally with no branch on the path.

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
   — one that doesn't track its own spend — and it is accurate where the
   daemon's own tally is not.
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

The tool informs the worker of its own budget and spend on its own, so the
worker's self-stop (mechanism 1) is the expected first stop in production.

### Surfaces: `board`, `inbox`, `activity`, `decide`, `retry`, `approve`, `reject`, `resume`, `cancel`

- **`board --project <id>`**: the project's total spend against its
  `--max-spend` cap (or "no cap set" if none was given) on the first line,
  then every ticket in the project, one line each, ticket id first: id,
  status, title, attempts (`n/max`), cost (sum of `total_cost_usd` across
  the ticket's runs), and, if any, which of its blocking dependencies are
  not yet `DONE`. Ticket spend sums that ticket's own runs; project spend
  sums every ticket's spend in turn. **Batch 9**: a manager ticket's title
  is prefixed `[MANAGER]` — it sits in the same list, same status column, no
  separate section, but is never mistakable for a work ticket at a glance
  (see "Planning a project" below). `--json` carries this as `kind: 'work'
  | 'manager'` on every ticket instead.
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
- **`retry --ticket <id>`**: manually retries a `FAILED` **or (Batch 8)
  `CANCELLED`** ticket via the `manual_retry` transition, which moves it
  back to `READY` and raises its `maxAttempts` by one either way. This is
  also the one, explicit way to reopen a ticket a person cancelled —
  "cancel, then retry" is two commands, not a separate reopen command.
  Refuses if the ticket isn't `FAILED` or `CANCELLED`.
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
- **`cancel --ticket <id>`** (Batch 8): **daemon-only** — refuses with a
  clear message if no daemon is running for the current state directory (no
  fallback writes the database directly; see "Daemon mode" below). Stops the
  live worker through the adapter and moves the ticket to the terminal
  `CANCELLED` via the `cancel` transition — not back to `READY` the way a
  daemon-initiated stop (`run_cancelled`, a timeout or a shutdown) is. This
  distinction is deliberate: a person who cancels has decided the ticket is
  unwanted, so landing it in `READY` would let the daemon's own next tick
  silently restart it. No attempt is consumed. Dependents of a cancelled
  ticket stay `OPEN` — no cascade, since `CANCELLED` is simply not `DONE`,
  the same test `isReady`/`resolveReadiness` already apply to any
  non-`DONE` blocker. `activity` records the cancel; there is no inbox item,
  because the owner did it themselves. `retry` is the one way back to
  `READY`. There is no separate `cancel-run`/reopen-in-place command: a
  restart moments after a cancel is exactly the surprise this design avoids.

All nine accept `--json`.

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
`needs_user_decision`, `malformed_result`, `hang`, `review` (lands the ticket in
REVIEW, for `approve`/`reject`) or `progress` (never terminal: the ticket stays
`IN_PROGRESS`) — so a scenario like "this ticket needs a user decision" can be
driven through the real CLI, e.g. for trying `decide`/`inbox` by hand. `progress`
also scripts a BURST: `--fake-script <ticketId>=progress:<message>`, repeated,
appends one message per occurrence, emitted in that order `--fake-progress-gap
<ms>` apart (default 20; a message may contain `:` and `=`, only the first `:`
splits). Bare `<ticketId>=progress` is still the single-event form.

```sh
node src/cli.ts tick --project <projectId> --fake-script <ticketId>=needs_user_decision --json
```

## Daemon mode

Every remaining item on this project's route needs a process that outlives a
single command — `cancel` from another shell, a board that reads while runs
are in flight, an eventual AionUi pull shape needing something to pull from.
`magarine serve` is that process. It is also where the owner's constraint is
met literally: the daemon generates its own bearer token, on its own
loopback port, and never touches anyone's AionUi (or other) account.

### Running it

```sh
node src/cli.ts serve --state-dir <dir> --json
```

Prints one JSON line once listening with `--json`:
`{"pid": <n>, "port": <n>, "stateDir": "<dir>"}` — **never the token**.
Without `--json`, the human line is `magarine daemon listening on
127.0.0.1:<port> (pid <n>) -- page: http://127.0.0.1:<port>/ -- token: run
\`magarine token\``: the page address is not a secret, so ruling 20 (batch 15
addendum 9) put it on the line; the token itself still never appears here.
The token lives only in `<state dir>/daemon.json`; get it onto your
clipboard with `magarine token` (below), or read the field yourself — never
from any command's output or any log line.

### `magarine token`

Ruling 20: copies the live daemon's token to the clipboard and prints one
line naming the page — the ONE sanctioned path the token reaches the
owner's own session; it still never reaches stdout, stderr, a log, a URL, a
response body, or `--json` output.

```sh
node src/cli.ts token --state-dir <dir>
```

Reads `<state dir>/daemon.json` and runs the same `checkDaemonFile` staleness
check `doctor` uses, so a dead or unhealthy daemon's leftover token is never
handed out: no live daemon → `no live daemon for this state directory; start
\`magarine serve\`` on stderr, exit 1, and the clipboard is never touched.
Live → copies the token via the platform's own tool (Windows `clip`; macOS
`pbcopy`; Linux the first found of `wl-copy`, `xclip -selection clipboard`,
`xsel --clipboard --input`) — the value always goes on that tool's stdin,
never as a command-line argument, since arguments are visible in a process
listing — then prints `token copied to the clipboard; paste it into the page
at http://127.0.0.1:<port>/`. No tool found → prints the path of
`daemon.json` and the field name `token` (never the value), exit 1.
`--json` prints exactly `{"copied": true, "port": <n>, "stateDir": "<dir>"}`.

`serve` accepts everything `tick`/`run --until-idle` do (`--adapter
fake|claude`, `--claude-exe`, `--fake-script`, `--fake-outcome`,
`--max-parallel`, `--run-timeout`) plus:

- `--port <n>` — defaults to `0` (any free loopback port).
- `--tick-interval <seconds>` — how often the daemon ticks every project in
  its database on its own, with no LLM involvement between ticks. An
  immediate first pass happens at startup regardless of this value.

**`--max-parallel` is machine-wide as of Batch 9**, not per-project: it is
the total number of workers `serve` will ever run at once, summed across
every project in its database. A project's own effective cap for a given
tick is `min(<the project's own max_parallel_workers, from "project create
--max-parallel">, <however much of the machine-wide ceiling is not already
spent by every project's current in-flight workers>)` — see `daemon.ts`'s
`computeProjectCap`. Before Batch 9 `projects.max_parallel_workers` was
written at `project create` time but never actually consulted anywhere in
scheduling, so N projects under one daemon could together run N times
`--max-parallel` workers. As of Batch 16 a project's own cap is NULL by
default and NULL means unbounded on the project side, so a default-created
project runs as many workers as `--max-parallel` allows (NOT one); only a
project given an explicit `--max-parallel` is held below the machine ceiling.
`tick`/`run --until-idle` are unchanged — they each run one project at a
time, so there is no "other projects" for a machine-wide ceiling to mean
anything against.

Stop it with `Ctrl+C` (or `SIGTERM`) in its own terminal: it stops every live
worker (adapter `stop()` + the run/ticket forced to a settled DB state — see
"Two cancellation transitions" below), closes the listener, and removes
`daemon.json`, in that order. **Platform note, HARD-verified on Windows**:
there is no way to deliver a catchable `SIGINT`/`SIGTERM`/`SIGBREAK` to a
*separate* `serve` process without a native helper (`taskkill /PID <pid> /T`
without `/F` errors outright on a plain console process; `child.kill()` from
another Node process — with any signal name, `detached` or not — hard-terminates
unconditionally on Windows; see `commands/serve.test.ts`'s header comment for
the three experiments). Real Ctrl+C in the daemon's own attached console
works normally; a script on Windows that needs to stop a daemon it did not
launch interactively has no graceful option today short of a hard kill,
which is safe (see "Crash recovery" below) but skips the tidy shutdown.
POSIX signal delivery should work normally there (untested — no POSIX
machine available this batch, the same gap `process.ts`'s own tree-kill
carries for the same reason). **This is a real, permanent platform
limitation, not something a future batch is expected to lift** (Batch 9
ruling: "document the Windows behaviour; do not refuse to start" — a daemon
that refuses to run because of an honest limitation is worse than one that
states it); `daemon.json`'s `shutdownMode` field, below, records which of
the two a given `serve` process can actually be asked to do.

### `daemon.json`

`<state dir>/daemon.json`:

```json
{
  "pid": 12345,
  "port": 47311,
  "token": "<64 hex chars, fresh every start>",
  "startedAt": "2026-09-13T12:00:00.000Z",
  "dbPath": "/abs/path/to/magarine.db",
  "shutdownMode": "signal"
}
```

- **A fresh token every start**, generated from 32 random bytes
  (`node:crypto`'s `randomBytes`), never persisted anywhere else, never
  logged, never echoed back in an error body or a health response. A token
  that outlives its daemon is a token something else can use. `magarine
  token` copies it to your clipboard and is the one sanctioned path; it
  still never reaches stdout.
- Written with mode `0600`. **On Windows this mode is not honoured** —
  HARD-verified: a file written with `0600` reports `666` back from `stat`
  on this platform, since Windows has no POSIX permission bits. The token is
  actually protected by the parent directory's ACL (the user's own profile
  directory, for the default state dir) rather than the file's own mode on
  that platform. The mode is set regardless, because it is correct and
  effective on the POSIX systems this project is heading toward, and costs
  nothing where it's ignored.
- Removed on a clean exit; left behind (still naming the now-dead pid) after
  a hard kill or a crash.
- **`shutdownMode`** (Batch 9): `"signal"` or `"hard-kill-only"`, decided
  once at startup from `process.platform` (`daemon.ts`'s
  `detectShutdownMode`) — `"hard-kill-only"` on Windows, `"signal"`
  everywhere else, matching the platform note above about what a *separate*
  process can actually deliver to this one. Optional on read: a
  `daemon.json` written by a pre-Batch-9 build has no such field, and must
  still parse as a valid, live daemon rather than come back `undefined` (a
  live older daemon must never look "absent" to a second `serve`'s own
  staleness check, which is exactly the double-start this file exists to
  prevent).
- `dbPath` records the *exact* database file this daemon opened, not just
  its state directory — `--db` is a separate override from
  `--state-dir`/`MAGARINE_HOME` and the two can diverge. Anything deciding
  whether a live daemon.json is actually *this* invocation's daemon (the
  CLI's own routing, below) must compare `dbPath`, not just "does this state
  directory have a daemon.json".

**Stale-file detection.** Starting `serve` checks any existing `daemon.json`
two ways, either one enough to call it stale and overwrite it: the recorded
pid is dead (`process.kill(pid, 0)` throwing `ESRCH`), or a live-looking pid's
own `/health` doesn't answer for it (wrong pid in the body, or unreachable —
see `daemonClient.ts`'s `probeDaemonHealth`, which also guards against a
*different*, unrelated process having been reassigned that same port after a
crash). A second `serve` against a genuinely live daemon refuses to start,
naming the pid and port, and never printing the token.

### The HTTP API

Loopback-only (`127.0.0.1`, never `0.0.0.0`/`::`) — checked with `netstat`,
not asserted from a comment. All JSON, all behind the token
(`Authorization: Bearer <token>`, constant-time compared via
`node:crypto`'s `timingSafeEqual`): a wrong or missing token gets a fixed
`{"error": "unauthorized"}`, `401`, on every route including `/health`,
before any other work happens. Node's built-in `http`/`fetch` only — no
dependency was added for this. **Two deliberate exceptions: `GET /` and
`GET /ui/<name>`**, neither behind a token check — `GET /` serves the
browser page (`ui/page.ts`), the page the owner types the token INTO in the
first place, so it cannot be gated behind that same token; `GET /ui/<name>`
(ruling 12) serves the page's own static assets (`<script src>`,
`<link>`, `@font-face`), which the browser loads natively and never attaches
a custom `Authorization` header to, so gating them would just break the page
that requests them. Every other route, including `/events`, stays behind
`isAuthorized` exactly as before.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` | The browser page. No auth (see above). |
| `GET` | `/health` | `{pid, startedAt, uptimeMs, slots: {used, cap}}` — never the token. |
| `GET` | `/board?project=<id>` | Same shape as `board --json`, plus `slots: { used, cap }` — `used` is every IN_PROGRESS ticket across all projects, `cap` is this daemon's `--max-parallel` (the offline `board --json` reports `cap: null`, it cannot know). |
| `GET` | `/inbox?project=<id>` | Same shape as `inbox --json`. |
| `GET` | `/activity?project=<id>\|ticket=<id>&all=true` | Same shape as `activity --json`. |
| `GET` | `/projects` | Batch 11: same shape as `project list --json`. Added for the page's project selector — not in batch 8/9's original route list. |
| `GET` | `/projects/{id}/scope` | Batch 11: `{scopeText}` — the project's scope document as plain text (`manager.ts`'s `readScopeText`, called read-only). Empty string when no scope file is set, never a 404 for that case; 404 only for an unknown project id. |
| `GET` | `/projects/{id}/conversation` | Batch 11 part 2: same shape as `commands/conversation.ts`'s `buildConversation` — the conversation panel's feed (owner messages, Manager replies/assessments, pending questions, scope updates), interleaved in order. 404 for an unknown project id. |
| `GET` | `/tickets/{id}/progress` | Batch 15 ruling 7: one entry per run for that ticket — `{runId, runStatus, latest}`, where `latest` is that run's most recent `worker_progress` event (`{message, tool, state, costUsd, at, sequence}`) or `null` if none yet. 404 for an unknown ticket id. |
| `GET` | `/events?since=<sequence>` | Batch 15 ruling 7: `text/event-stream`. `since` (default `0`) is exclusive — replays every event with `sequence` greater than it, then keeps streaming new ones as they land. Each SSE frame's `id` is the event's `sequence`, `event` is its `eventType`, `data` is the full JSON event row; only `worker_progress` events and non-`internal`-visibility events are streamed. A `: heartbeat` comment line every ~15s keeps a quiet connection provably alive (not a real frame). A wrong or missing token gets the same `401 {"error":"unauthorized"}` as every other route, not a stream. Every open stream is ended when the daemon shuts down, ahead of the HTTP server itself closing. |
| `GET` | `/ui/<name>` | Batch 15 ruling 12: static assets from `packages/core/ui/` — **no token required** (see above). Serves only `.html`/`.css`/`.js`/`.woff2`/`.svg` by extension, with the matching `Content-Type`; no fallback, no sniffing. A name containing a path separator or a dot-segment (decoded first, so an encoded traversal is caught too) is refused with `400`; an unrecognized extension or a missing file answers `404`. |
| `POST` | `/tickets` | Body mirrors `ticket add`'s flags (`project`, `title`, `description`, `maxAttempts`, `priority`, `workspaceType`, `acceptanceCriteria`, `model`, `budget`, `dependsOn`, `expectedArtifacts`). Attaches every `dependsOn` before resolving readiness, never before — same ordering guarantee as the CLI. `expectedArtifacts` carries the full `{kind, path?}` entry shape (same validation as the Manager's `create_ticket`/`update_ticket`), not the CLI's path-only `--expected-artifact` shorthand; omit it for no expectations, a non-empty array to verify DONE against, never `[]` (refused with 400). |
| `POST` | `/deps` | `{project, ticket, dependsOn, type?}`. |
| `POST` | `/tickets/{id}/decide` | `{answer}`. |
| `POST` | `/tickets/{id}/retry` | No body. |
| `POST` | `/tickets/{id}/approve` | No body. |
| `POST` | `/tickets/{id}/reject` | `{reason}`. |
| `POST` | `/tickets/{id}/cancel` | No body. `409` if this daemon holds no live run for that ticket. |
| `POST` | `/projects/{id}/resume` | No body. |
| `POST` | `/projects/{id}/set` | `{maxSpend?, model?, managerModel?, dir?, maxParallel?}`. `maxParallel` must be a whole number of 1 or more, else `400`. |
| `POST` | `/projects/{id}/plan` | `{mission}` — creates a manager ticket. See "Planning a project" below. |
| `POST` | `/tick` | `{project}` — forces one scheduling pass for that project right now, outside the regular interval. |

Nothing else — no websocket. The one push channel is `GET /events` above, a
server-sent event stream added in batch 15 (ruling 7); earlier batches had
none, which is what this sentence used to say. **There is no
`POST /projects` (create)**: `project create` is not in this list, and stays
a direct write even while a daemon is running (see "The single-writer rule"
below) — a deliberate exception, not an oversight.

Every route calls the exact same functions the CLI's direct-write path
already calls (`store.ts`, `commands/*.ts`, `dependencies.ts`) — the API is
a second *surface* onto the single write path, never a second one. Nothing
in `daemonApi.ts`/`daemonClient.ts` ever writes `tickets.status` directly;
`architecture.test.ts`'s grep for `UPDATE tickets SET ... status =` still
finds exactly one file, `stateMachine.ts`.

### The browser page

`ui/page.ts` exports the whole page as one string constant (`PAGE_HTML`) --
plain HTML and a single inline `<script>`, no framework, no build step, no
bundler: it ships and runs exactly the way every other `.ts` file in this
project does, loaded straight off disk by `daemonApi.ts`'s `GET /`. The
token is entered once and kept in `sessionStorage` (never a cookie, never in
the URL); every `fetch()` the page makes attaches it as the `Authorization`
header, through one shared `api()` helper in the page's own script -- no
other code path constructs its own headers. It shows the board, inbox
(reasons in full, never truncated), and recent activity for a selected
project, refreshing every 4 seconds, with buttons for every ticket action
(`decide`/`retry`/`approve`/`reject`/`cancel`) plus `resume`/raise-cap for a
paused project.

The conversation panel is wired end to end: its message box calls
`POST /projects/{id}/discuss` (`discussProject`, `manager.ts`) and shows the
current scope document (`GET /projects/{id}/scope`) next to it, read-only.
`GET /projects/{id}/conversation` (`commands/conversation.ts`'s
`buildConversation`) feeds the panel itself -- the owner's own messages
(`discuss` events), the Manager's `manager_reply`/`manager_assessment`
artifacts, its `request_user_decision` questions (each with its own answer
box, wired to the same `decide` route the inbox panel uses), and scope
updates, all interleaved in chronological order and rendered in full, never
truncated. This is a second, UI-shaped read over the same rows
`managerEnvelope.ts`'s own (private, prompt-facing) conversation builder
reads for the Manager's own briefing -- deliberately not the same function,
since that one has no reason to know about pending questions or scope
updates and this one has no reason to know about prompt formatting.

### The single-writer rule

**When a daemon is running (matching this invocation's `--db`, per the
`dbPath` check above), every mutating CLI command routes through its API
instead of writing the database file directly — every one, *except*
`project create`, which stays a direct write always.** There is no
`POST /projects` route to send it to; the Strategist's ruling is that this
narrow, one-shot write is not worth inventing a route for, given the batch's
own instruction was "exactly the spec's list and nothing else." Reads
(`status`/`board`/`inbox`/`activity`) are never routed — they stay direct
either way, daemon or no daemon.

`run --until-idle` refuses outright against a live, matching daemon (clear
message, exit 1): there is no "wait for idle" route to poll, and running its
own scheduler loop locally while a daemon is also ticking is exactly the
two-writer situation this whole feature exists to prevent. Use `tick`
(routes through `POST /tick`) for a single forced pass instead, or
`board`/`status` to watch progress. `tick` itself, when routed, ignores (with
a stderr note, not silently) any `--adapter`/`--claude-exe`/`--fake-script`/
`--fake-outcome` flags also given — the daemon owns its adapter, fixed at
`serve` startup, not a flag on a later command.

The detection itself (`cli.ts`'s `liveDaemonFor`) always goes through
`daemon.ts`'s real `checkDaemonFile` + `daemonClient.ts`'s real
`probeDaemonHealth` — the same health probe `serve`'s own stale-file
detection uses — never a second, simpler liveness check invented beside it.

### Two cancellation transitions

`stateMachine.ts` has carried a `cancel` transition (any of
`OPEN`/`READY`/`IN_PROGRESS`/`REVIEW` → the terminal `CANCELLED`) since
Batch 1, unused by any command until this batch wired `cancel --ticket`/
`POST /tickets/{id}/cancel` to it. It is deliberately distinct from
`run_cancelled` (`IN_PROGRESS` → `READY`, no attempt consumed), which
predates this batch and backs every *daemon*-initiated stop
(`adapter_unavailable`, a per-run timeout, `SIGINT`/`SIGTERM`, or the
daemon's own shutdown):

- `run_cancelled` — the daemon's own decision. The ticket isn't at fault, so
  returning it to `READY` for another attempt is correct.
- `cancel` — a *person's* decision, via `cancel --ticket`. Landing back in
  `READY` would let the daemon's own next tick silently restart the run
  moments later — measured by hand during this batch's close-out: the
  original design (routed through `run_cancelled`) produced two runs, the
  second starting under a second after the first was cancelled. `CANCELLED`
  is terminal, so `tick()` (which only ever looks at `READY` tickets) simply
  cannot pick it back up. `retry` is the one explicit way back to `READY`
  ("cancel, then retry" — two commands, not a separate reopen); no
  `cancel-run`/reopen-in-place command exists, on purpose. `scheduler.ts`'s
  `cancelRun`/`cancelTicketRun` take an explicit `transitionEvent` parameter
  with no default — every call site must say which of the two it means,
  the same device `stateMachine.ts`'s `requireRetryableFlag` uses for the
  same reason: a silent default is how this project has shipped the wrong
  branch before.

### Crash recovery

`recoverOrphanedRuns` (`recovery.ts`) runs once at every `serve` startup,
before the first tick: any run still recorded `running` is by definition
orphaned from a previous process that crashed or was killed, and is marked
`failed`/`orphaned_on_restart`, returning its ticket to `READY` (or `FAILED`
if attempts are exhausted) to be picked back up normally. This is what makes
a hard kill — the only reliable stop on Windows, see above — safe to leave
running rather than something that silently loses work: `commands/serve.test.ts`
and `daemonApi.test.ts` both kill a real daemon mid-run and confirm a
second, freshly-started daemon re-queues the orphaned run and drives it to
completion, the second reading the recovery event back through its own
authenticated API rather than accepting a coincidental fresh success as
proof.

**This now includes the workspace, not just the run/ticket rows.** A
crashed or hard-killed NONE-mode run's disposable temp workspace is reclaimed
here too (Batch 8), and Batch 9 made that reclaim itself resilient to the
same transient Windows filesystem race the rest of this batch's housekeeping
fixed (see "Two cancellation transitions" and workspace.ts's
`removeDirectoryResilient`): a workspace that genuinely can't be removed is
logged and skipped rather than thrown, since recovery runs synchronously
before the daemon starts listening and a workspace-removal failure must
never be able to take down `serve` itself, or undo the run/ticket recovery
that already succeeded.

## Planning a project

The Manager is the last piece of `technical-architecture-weekend-mvp.md`
that this project had not built: a scope document goes in, tickets with
dependencies come out, the daemon runs them. It is deliberately built to
have almost no power of its own.

The product this section describes is "work a scope document with it, the
way this project itself was run": a document goes in, it's read cold and
judged, questions come back, work is proposed, results are reviewed, the
plan is corrected, and so on -- see `commands/plan.ts`'s `planWithMission`
for the "seed the scope, then plan" mechanics, and `manager.ts`'s
`discussProject` for the ongoing conversation.

```sh
node src/cli.ts plan --project <projectId> --mission "$(cat scope.md)"
```

`--mission` seeds the project's scope document with the given text (whole,
verbatim) and records a `scope_updated` decision event, then plans from it
-- but only when the scope is currently empty or absent. Once it has
content, the same command refuses outright (exit non-zero, one sentence)
rather than silently overwrite it; edit the scope file directly, or use
`discuss --project <projectId> --message "<text>"` to keep talking instead.
Planning with no `--mission` at all always works, seeded scope or not: it
plans (or re-plans) from whatever the scope file and the board currently
say. Either way this creates a manager ticket (`kind: 'manager'`) and
returns immediately — `plan` never ticks or spawns anything itself. If a
daemon is up for this `--db`, the mutation routes through
`POST /projects/{id}/plan`, the same single-writer rule every other
mutating command follows, and the exact same seed-or-refuse logic runs on
that path too (one function, not two); otherwise it writes directly and the
next `run --until-idle` (or a daemon's own next periodic tick) picks it up.

**On a fresh project, expect only questions back, not tickets -- that is
the intended first reply, not a stall.** The Manager would rather ask what's
missing than assume it. It proposes work only once it says it has enough,
and the owner can ask it to go ahead at any point via `discuss`.

**A Manager run is a ticket, not a special process.** It goes through the
exact same adapter as any worker (`ClaudeCliAdapter`/`FakeAdapter`), so cost
tracking, budget ceilings, model pinning, retries, and the inbox all apply
to it completely unchanged — nothing in `scheduler.ts`'s tick loop, the
concurrency cap, or the spend cap has any idea it is looking at a Manager
rather than a worker until the moment its result comes back. `board` still
shows what it cost like any ticket; a manager ticket's row is prefixed
`[MANAGER]` so it is never mistaken for one (see the `board` surface
above). Its `--workspace` is always `NONE`: it has no files of its own to
produce, only a plan.

**What it can do:** propose exactly seven things, each validated against the
current board and applied only as a whole (`packages/core/src/proposal.ts`,
`managerApply.ts`) — create a ticket, add a dependency between two existing
tickets, change a ticket's priority, ask the owner a question, update the
scope document, cancel a ticket, or update an existing ticket's fields
(title, description, acceptance, budget, model). Everything it proposes is
recorded as one `manager_proposal_applied` event carrying the full proposal,
so the applied board can always be explained after the fact.

**What it cannot do, which is the more interesting half of this design:**

- It cannot touch the database. Its only output is a file
  (`.orchestrator/proposal.json`, declared as an artefact like any other);
  the daemon reads, validates, and applies it — the Manager itself never
  runs a single write.
- It cannot propose an eighth kind of command. `create_ticket`,
  `add_dependency`, `change_priority`, `request_user_decision`,
  `update_scope`, `cancel_ticket`, `update_ticket` — exactly these seven
  shapes, no more.
- It cannot half-apply a plan. One invalid command in a proposal rejects
  the whole thing, treated the same as a malformed `result.json`: retryable,
  reaching the inbox on exhaustion with the validation errors attached. See
  `managerApply.test.ts`'s rollback tests — a synthetic failure partway
  through a proposal's application leaves the board exactly as it was
  before, proven by disabling the transaction and watching the test catch it.
- It cannot introduce a dependency cycle, anywhere in the combined graph of
  the existing board plus its own proposal — rejected whole, because a
  cyclic dependency would deadlock the board permanently.
- It cannot make a manager ticket depend on a work ticket, or the reverse,
  in either direction — enforced at `addDependency` itself (`store.ts`), not
  only in the proposal validator, so this holds for `dep add`/`POST /deps`
  too, not just for what a Manager itself proposes.
- It cannot create another manager ticket. Every `create_ticket` command
  produces an ordinary work ticket; only `plan` (or the daemon route) ever
  creates a manager ticket.
- It cannot see a worker's own prompt, another ticket's full description, or
  a completed dependency's reported summary/artifacts. Its envelope
  (`managerEnvelope.ts`) is built independently of the worker-envelope path
  and carries only: the project brief, the current scope document (read
  fresh off disk on every invocation), the conversation so far (the owner's
  `discuss` messages interleaved with its own prior replies/assessments,
  across every manager ticket this project has ever run, not just the
  current one), the board in compact form
  (id/title/status/kind/dependencies/attempts/spend — no descriptions), the
  decision log, the last five final failures with a curated one-line reason
  each, and the command schema.
- It cannot remember a previous invocation. Every Manager run rebuilds its
  envelope from the database from scratch; nothing about it is a
  long-lived session or an accumulating context — the same "an orchestrator
  that accumulates context is the expensive idle agent this project is
  designed against" ruling that shaped the daemon itself from the start.
- It is never triggered automatically. Only an explicit `plan` (CLI or API)
  starts one — no trigger on a ticket's final failure, and no trigger on a
  schedule. Both are real, named future work, deliberately not built until
  this one explicit path has been watched running for real.
- Its cap is small on purpose: at most twenty commands per proposal, at most
  fifteen of them `create_ticket` — bounding how much damage one run can do
  even if everything else about it were somehow wrong.

**Answering a Manager's question.** A `request_user_decision` command
routes the manager ticket through the exact same `worker_needs_user_decision`
→ `BLOCKED` transition an ordinary worker's own decision request uses — no
second answering mechanism exists. `decide --ticket <id> --answer "<text>"`
answers it, same as any blocked ticket, returning it to `READY`; the next
tick re-runs the Manager, which sees the answer in its own decision log
(the same one `relevantDecisions` already reads for a worker).

**Model and budget.** A manager ticket's budget resolves the same way any
ticket's does (`project set --max-spend`/`ticket add --budget`'s ceiling
machinery, unchanged). Its model defaults to the project's own
`default_model`, with an independent override: `project create
--manager-model <model>` / `project set --manager-model <model>`
(`projects.manager_model`) — a project-level setting, not a per-ticket one,
since a project can have many manager tickets over its lifetime and each
one should see the CURRENT setting, not whatever was true when an earlier
one happened to run.

## Layout

```
src/
  db/           schema + migration runner, transaction helper, WAL/busy_timeout pragmas
  store.ts      plain CRUD (not the ticket-status writer)
  stateMachine.ts   the ONE function that writes tickets.status
  dependencies.ts   promotes OPEN -> READY when blocking deps are DONE
  resultContract.ts JSON schema + validator for .orchestrator/result.json
  process.ts    all process control (spawn/timeout/kill) in one file
  envelope.ts   builds the worker prompt from a TicketEnvelope
  workspace.ts  NONE/DIRECTORY/GIT_WORKTREE workspace provider
  adapters/fakeAdapter.ts  scriptable AgentAdapter test double
  adapters/claudeCli.ts    real Claude Code CLI adapter
  scheduler.ts  tick() / runUntilIdle() / cancelRun (daemon-decision vs person-decision)
  recovery.ts   restart recovery for orphaned "running" runs
  policy.ts     notification policy table: classify(eventType) -> visibility/requiresUser
  daemon.ts     daemon.json lifecycle, stale-file detection, the tick loop (startDaemonLoop)
  daemonApi.ts  the HTTP API: token auth, routing onto the same functions the CLI calls
  daemonClient.ts  the one client module (fetch-based) the CLI and daemon.ts's own health probe use
  commands/     board, inbox, activity, decide, retry, approve, reject, resume, serve (cli.ts stays thin)
  cli.ts        the `magarine` CLI, including daemon detection/routing and `cancel`
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

Batch 7 (Role L, budget semantics): the worker's own
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

Batch 8 (Role M, daemon mode, single writer, its own token): `magarine
serve`, the HTTP API, the CLI's daemon detection/routing, and `cancel` are
all built and tested — see "Daemon mode" above for the full shape. What was
found rather than built cleanly the first time, or is out of scope on
purpose:

- **`project create` has no route and stays a direct write even when a
  daemon is running** — the spec's route list has no `POST /projects`, and
  the Strategist ruled this narrow exception rather than asking for one to
  be invented. Documented in "The single-writer rule" above, not left
  implicit.
- **No catchable cross-process `SIGINT`/`SIGTERM` delivery to a separate
  `serve` process on Windows without a native helper** — HARD-verified
  three ways (see "Running it" above and `commands/serve.test.ts`'s header
  comment). The daemon's graceful-shutdown code is real and exercised
  in-process (`daemon.test.ts`'s `DaemonLoop.stop()` tests, the same
  substitution `scheduler.test.ts`'s own `runUntilIdle` SIGINT test already
  makes); what cannot be tested on this platform is an *external* process
  triggering it. A hard kill is the safety net (see "Crash recovery"), and
  is what this batch's own kill-and-restart tests exercise instead. POSIX
  delivery is expected to work normally but is untested here — no POSIX
  machine was available this batch, the same gap `process.ts`'s own
  tree-kill has carried since Batch 2.
- ~~The daemon ticks every project in its database on a fixed interval,
  with a single `--max-parallel` concurrency cap applied independently
  *per project*~~ — **corrected in Batch 9**: `--max-parallel` is now the
  machine-wide ceiling, and `projects.max_parallel_workers` (written since
  Batch 1 but never read anywhere in scheduling until now) is a project's
  own additional cap. See "Running it" above and `daemon.ts`'s
  `computeProjectCap`. `tick`/`run --until-idle` are unchanged, since each
  runs one project at a time.
- **A real production concurrency bug, found by this batch's own tests, is
  fixed but the counterfactual isn't cleanly reproducible on demand.**
  `openDb` now sets `journal_mode = WAL` and `busy_timeout = 5000` (see
  "State directory" above) after a plain `status --json` read occasionally
  raced the daemon's own write and failed outright. Two real-process tests
  (`db/index.test.ts`) prove the fix positively (many reads, zero failures,
  against a real continuously-writing process; a blocked write that waits
  rather than fails, against a real lock-holding process). An isolated
  two-process attempt to force the *pre-fix* config to fail the same way on
  demand did not reproduce reliably — the original failure only ever showed
  up under the full test suite's system-wide concurrent load, not a single
  writer/reader pair in a dedicated harness. The fix is correct and
  independently verified either way; the clean "before" reproduction just
  isn't available to hand over.

Batch 9 (Role N, the Manager invocation, and housekeeping): the Manager
(`plan`, `POST /projects/{id}/plan`, `proposal.ts`/`managerApply.ts`) is
built and tested end to end — see "Planning a project" above for the full
shape, including what it deliberately cannot do. The EPERM cleanup flake
carried since Batch 5 is root-caused and fixed (see "Crash recovery" above
and workspace.ts's `removeDirectoryResilient`); `serve --max-parallel` is
now machine-wide (see the corrected Batch 8 bullet above). What was found
rather than built cleanly the first time, or is out of scope on purpose:

- **Automatic Manager triggers are not built.** The architecture document
  names several triggers for the Manager (mission decomposition, ambiguous
  blockers, material plan changes, explicit user request, scheduled
  reviews); this batch builds exactly one, the explicit `plan` command, per
  the ruling that the document's other triggers wait until this one has
  been watched running for real. No trigger fires on a ticket's final
  failure, and no trigger fires on a schedule.
- **`GIT_WORKTREE` for a Manager-created ticket is accepted, not validated
  away, at proposal time** — `create_ticket.workspace_type` allows all
  three `WorkspaceType` values, the same as `ticket add` always has;
  `workspace.ts` still refuses `GIT_WORKTREE` at *run* time, unchanged from
  Batch 2. The proposal validator was deliberately not made stricter than
  the CLI surface it mirrors.
- **A `request_user_decision` answering mechanism was not built new** — it
  reuses the existing `worker_needs_user_decision`/`decide` machinery
  verbatim (see "Planning a project" above). One consequence worth naming:
  answering a Manager's question re-runs the WHOLE Manager from scratch on
  the next tick (a fresh, paid invocation), not just the one open question
  — there is no partial-resume shape for "the Manager already applied most
  of its proposal and only needs one answer to finish."
- ~~This is the first test in the codebase joining the real
  `ClaudeCliAdapter` to `scheduler.ts`'s `tick()`** (`managerSpawnedPipeline.test.ts`).
  The batch 8 standing rule ("every result status and failure class needs a
  test driving the adapter's own classification and the spawned pipeline")
  has been in force since Batch 8; every OTHER result status (`review`,
  `budget_insufficient`, and the rest) still has only adapter-alone tests
  (`adapters/claudeCli.test.ts`) and scheduler-alone tests
  (`scheduler.test.ts`, driven by `FakeAdapter`), never both joined for the
  same run. Found while building this batch's own spawned-pipeline test,
  not fixed — closing that gap for the pre-existing statuses is a real
  future item, not something this batch's own scope covered.~~ —
  **closed in Batch 10**: `workerSpawnedPipeline.test.ts` adds one real
  spawned-pipeline test per pre-existing status/failure class. See "The
  spawned-pipeline rule" above and the Batch 10 entry below for what that
  found.
- **`project create`/`project set --manager-model` were added even though
  step 6's own list didn't name them explicitly** — without a way to set
  `projects.manager_model`, the column step 2 added would have been as dead
  as `max_parallel_workers` was found to be in this same batch's
  housekeeping. Surfaced rather than left as a column nothing can reach.

Batch 10 (Role O, applying the batch 8 standing rule backwards): one real
spawned-pipeline test per pre-existing result status/failure class is added
(`workerSpawnedPipeline.test.ts`) -- `done`, `review`,
`needs_user_decision`, `failed`, `budget_insufficient`, a malformed result, a
declared-but-missing artefact, a tool-side `budget_exceeded`, and a timeout,
each mutation-checked (see that file's own per-test comments for exactly
what was broken to confirm each test can fail). `manager_proposal` is added
to `cli.ts`'s `--fake-outcome` list, and `ticket add` now validates its
`--project` against a typed `TicketAddError` before creating anything, the
same way `plan`'s `PlanError` already does (see cli.test.ts's coverage for
both). What was found rather than fixed, being outside this role's owned
files (`cli.ts`, test files, `adapters/fakeAdapter.ts`'s outcome list,
`adapters/testFixtures/`):

- **A real, currently-shipped gap: the not-logged-in `adapter_unavailable`
  path is unreachable from the real `ClaudeCliAdapter`.** scheduler.ts's
  dedicated handling for this failure (pause the project's adapter so the
  daemon stops burning attempts against a dead login; return the ticket to
  READY with NO attempt consumed; a dedicated inbox event) only fires when
  an incoming `failure` event has `retryable === false && failureClass ===
  'adapter_unavailable'`. `adapters/claudeCli.ts`'s `outcomeToEvent`, for its
  own `adapter_unavailable` outcome, sets `retryable: false` but never sets
  `failureClass` at all -- only the `ADAPTER_UNAVAILABLE:` message prefix
  distinguishes the case there. So a real not-logged-in worker never matches
  scheduler.ts's guard: it falls through to the generic "non-retryable but
  not adapter_unavailable" branch instead, landing the ticket on FAILED with
  one attempt consumed, no pause, and no dedicated inbox event -- the exact
  opposite of the intended behaviour, and exactly the shape this batch's own
  standing rule exists to catch (correct where scheduler.ts's guard was
  built, silently unreachable at the join to the real adapter, invisible to
  a suite -- scheduler.test.ts -- that only ever drove FakeAdapter's own
  hand-set `failureClass`). `workerSpawnedPipeline.test.ts`'s
  `adapter_unavailable` test locks in the current (incorrect) behaviour, with
  a comment naming the one-line fix (`failureClass: 'adapter_unavailable'`
  alongside claudeCli.ts's existing `stoppedBy: 'tool_max_budget_usd'` for
  its sibling `budget_exceeded` case) and recording that applying it and
  rerunning flips every assertion in that test to the intended outcome.
  `adapters/claudeCli.ts` is not a file this role may edit; the fix belongs
  to whichever role owns it next.
- **`--fake-outcome <id>=manager_proposal` cannot carry a `proposal`
  payload** -- CLI flags are `<ticketId>=<kind>` pairs with no way to encode
  a JSON object on the command line, so the only outcome reachable this way
  is "the manager ran but never wrote proposal.json" (a malformed/retryable
  result). A scenario needing a real, appliable proposal still has to script
  `FakeAdapter` directly from a test (`managerScheduler.test.ts`,
  `managerSpawnedPipeline.test.ts`), which is not a gap batch-10-spec.md
  asked this role to close.

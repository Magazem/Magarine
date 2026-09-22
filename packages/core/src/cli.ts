#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDb, type Db } from './db/index.ts';
import { FakeAdapter, type FakeScript } from './adapters/fakeAdapter.ts';
import { ClaudeCliAdapter } from './adapters/claudeCli.ts';
import { checkDaemonFile, type DaemonFileInfo } from './daemon.ts';
import { daemonRequest, probeDaemonHealth } from './daemonClient.ts';
import { resolveCommand } from './process.ts';
import { recoverOrphanedRuns } from './recovery.ts';
import { runUntilIdle, tick } from './scheduler.ts';
import {
  addDependency,
  assertValidMaxParallelWorkers,
  countTicketsByStatus,
  createProject,
  createTicket,
  createWorkerProfile,
  getProject,
  getSetting,
  getSettings,
  getTicket,
  listProjects,
  listTickets,
  listWorkerProfiles,
  NoSuchWorkerProfileError,
  resolveWorkerProfileRefForAdmin,
  retireWorkerProfile,
  resolveMachineCap,
  setProjectDefaultModel,
  setProjectDir,
  setProjectManagerModel,
  setProjectVerifierModel,
  setProjectMaxParallelWorkers,
  setProjectMaxSpendUsd,
  setSetting,
  SETTINGS_KEYS,
  setTicketBudgetOverride,
  updateWorkerProfile,
  workerProfileStatus,
  unsetSetting,
} from './store.ts';
import { resolveReadiness } from './dependencies.ts';
import { discussProject, ManagerError } from './manager.ts';
import { approve, ApproveError } from './commands/approve.ts';
import { buildActivity, buildTicketProgress, formatActivity, formatTicketProgress } from './commands/activity.ts';
import { buildBoard, formatBoard, truncateTitleForDisplay } from './commands/board.ts';
import { buildProjectList, formatProjectList } from './commands/projectList.ts';
import { buildInbox, formatInbox } from './commands/inbox.ts';
import { decide, DecideError } from './commands/decide.ts';
import { doctorExitCode, formatDoctor, runDoctor } from './commands/doctor.ts';
import { planWithMission, PlanError } from './commands/plan.ts';
import { reject, RejectError } from './commands/reject.ts';
import { retry, RetryError } from './commands/retry.ts';
import { resume, ResumeError } from './commands/resume.ts';
import { realAppSeams, runApp } from './commands/app.ts';
import { formatShutdown, serve, ServeError } from './commands/serve.ts';
import { runToken, TokenError } from './commands/token.ts';
import {
  artifactsDir as resolveArtifactsDir,
  dbPath as resolveDbPath,
  resolveStateDir,
} from './paths.ts';
import { projectReadiness } from './readiness.ts';
import { probeScopeFile, scopeAnnouncement } from './scopeProbe.ts';
import type { AgentAdapter, WorkspaceType } from './types.ts';

// Thin CLI over the core library. Every subcommand opens the sqlite file at
// `--db` (an explicit override) or, failing that, at
// `<state dir>/magarine.db` -- see paths.ts for how the state directory
// itself is resolved (`--state-dir`, else `MAGARINE_HOME`, else
// `<home>/.magarine/`). Nothing is written under the current working
// directory unless the user asked for it with `--state-dir` or `--db`. Does
// one thing per subcommand, and prints either a human line or JSON with
// `--json`.

interface Flags {
  [key: string]: string | boolean | string[];
}

// Batch 10 owner walk (docs/strategy/batch-10-owner-walk.md, finding 3):
// `plan` always validated its `--project` against a typed PlanError before
// creating anything (commands/plan.ts); `ticket add`, `board`, `inbox`, and
// `status` did not -- `ticket add` fell through to a raw DB
// foreign-key-constraint error, and the three read paths accepted ANY id at
// all, including one that never existed, printing a calm, empty result at
// exit 0. A typo'd or stale id was therefore indistinguishable from "no
// tickets yet", and a script piping through one of them would sail past it
// silently. One shared class, not one per command, since every one of these
// wants the exact same check and message.
class NoSuchProjectError extends Error {}

// Batch 10 (Role Q), item 2: every command taking `--project` accepts
// either the project's id OR its exact name -- a name is what a person
// actually remembers, especially with `magarine project list` (below) as
// the only way back to an id once a terminal is closed. Tries the id first
// (the common case once a script or a copied id is in hand: an id can never
// collide with a name here since `createProject` generates ids as
// `proj_<uuid>`, disjoint from anything a person would type as a name), then
// an exact name match. `projects.name` has no uniqueness constraint
// (db/schema.ts), so an ambiguous name refuses explicitly by listing every
// matching id, rather than silently picking one.
function resolveProjectRef(db: Db, ref: string): string {
  if (getProject(db, ref)) return ref;
  const matches = listProjects(db).filter((p) => p.name === ref);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new NoSuchProjectError(
      `"${ref}" matches ${matches.length} projects by name -- use one of these ids instead: ${matches
        .map((p) => p.id)
        .join(', ')}`
    );
  }
  throw new NoSuchProjectError(`no such project: ${ref}`);
}

// Every project-taking command shares this exact catch shape; pulled out
// once rather than repeated at every call site.
function reportIfNoSuchProject(err: unknown): boolean {
  if (err instanceof NoSuchProjectError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

// A flag repeated on the command line (`--acceptance a --acceptance b`)
// collects into an array instead of the last one silently winning. A flag
// given once stays a plain string/boolean, so every existing single-value
// flag is unaffected.
function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      let value: string | boolean;
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
      const existing = flags[key];
      if (existing === undefined) {
        flags[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(String(value));
      } else {
        flags[key] = [String(existing), String(value)];
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

// Normalizes a possibly-repeated flag to a string array: absent -> [],
// given once -> one-element array, repeated -> every value in order.
function flagList(flags: Flags, key: string): string[] {
  const value = flags[key];
  if (value === undefined || typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

// Opus review amendment (ruling 36, batch 19 mini-phase 2B, section 3, item
// 7): `decide --answer` reads the RAW args directly rather than going
// through `flags`/`flagList` for this one flag. Reason: parseFlags turns a
// bare `--answer` (nothing after it, or the next token is itself a flag)
// into the boolean `true`; that is fine as long as `--answer` appears once
// (flagList already drops a lone boolean), but a REPEATED `--answer` merges
// via `String(value)`, so a bare occurrence inside a repeated list silently
// becomes the literal text "true" -- indistinguishable from someone typing
// `--answer true`. Scanning `rest` here preserves that distinction and
// refuses a bare occurrence in every position, not just when it is the only
// one. An explicit empty value (`--answer ""`) is not a bare occurrence --
// the shell hands parseFlags a real (empty) token for it -- and stays legal,
// same as an omitted `--answer` altogether (handled by the caller).
function collectAnswerFlags(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--answer') continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new DecideError('--answer requires a value; a bare --answer with nothing after it is refused');
    }
    values.push(next);
    i++;
  }
  return values;
}

// Batch 16 Role A item 4 (ruling 23): ONE parse and ONE validator
// (store.ts's assertValidMaxParallelWorkers) for every command that accepts
// `--max-parallel` -- `project create`, `project set`, `tick`, `run` and
// `serve`. Before this, `flags['max-parallel'] ? Number(...) : 1` let `0`
// through (the string "0" is truthy: `serve --max-parallel 0` ran a daemon
// whose machine-wide ceiling was zero and silently started nothing) and `abc`
// (NaN). A bare `--max-parallel` with no value is refused too, not ignored.
// Returns undefined when the flag is absent so each caller applies its own
// default.
function parseMaxParallelFlag(flags: Flags): number | undefined {
  if (!('max-parallel' in flags)) return undefined;
  const raw = flags['max-parallel'];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  assertValidMaxParallelWorkers(value);
  return value;
}

function stateDir(flags: Flags): string {
  return resolveStateDir({
    stateDirFlag: typeof flags['state-dir'] === 'string' ? flags['state-dir'] : undefined,
  });
}

// `openDb` does not create the directories leading up to its path -- it
// never had to before, since every existing caller pointed it at a file
// inside a directory that already existed. Once the default moved to
// `<state dir>/magarine.db`, that stopped being true: a fresh
// `~/.magarine/` (or a fresh `--state-dir`) may not exist yet, so this
// creates it up front rather than letting `DatabaseSync` fail with a raw
// "unable to open database file".
function dbPath(flags: Flags): string {
  const path = typeof flags.db === 'string' ? flags.db : resolveDbPath(stateDir(flags));
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function artifactsDir(flags: Flags): string {
  return resolveArtifactsDir(stateDir(flags));
}

// Batch 8 (Role M), step 4: the single-writer rule. When a daemon is
// running, every mutating command below routes through its API instead of
// writing the sqlite file directly; when none is, it writes exactly as it
// always has. `project create` is the one documented exception (no
// `POST /projects` route exists -- see the daemon's route list -- and the
// Orchestrator ruled it stays a direct write rather than inventing one).
// Reads (status/board/inbox/activity) are never routed, per the same
// ruling: "reads stay direct either way".
//
// A live daemon.json for this STATE DIRECTORY is only actually this
// invocation's daemon if it serves the same database file: `--db` is a
// separate override from `--state-dir`/`MAGARINE_HOME` (see paths.ts) and
// the two can diverge, e.g. a test or a script pointing `--db` at a
// specific file while a daemon happens to be running against that state
// directory's default db. Routing a mutation there would silently write
// the wrong file. Uses `checkDaemonFile`'s real `probeDaemonHealth` (the
// same one daemon.ts's own stale-file detection uses), not a second,
// simpler liveness check invented here.
async function liveDaemonFor(flags: Flags): Promise<DaemonFileInfo | undefined> {
  const check = await checkDaemonFile(stateDir(flags), probeDaemonHealth);
  if (check.status !== 'live') return undefined;
  if (check.info!.dbPath !== dbPath(flags)) return undefined;
  return check.info;
}

// Sends a mutating request to a live daemon and prints its result the same
// way the direct-write path would: `--json` gets the raw response body, a
// human line otherwise (built from that same body, so the two paths report
// identically). A non-2xx response is reported the same way every direct
// command's own typed Error already is -- the message on stderr, exit 1, no
// stack -- since daemonApi.ts's error bodies carry the exact same message
// text those Error classes throw. A transport failure this late (the daemon
// answered live a moment ago but is unreachable now) is reported the same
// way rather than silently falling back to a direct write, which risks
// double-writing if the daemon is simply mid-restart rather than gone.
async function routeMutation(
  flags: Flags,
  daemon: DaemonFileInfo,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: unknown,
  humanLine: (body: unknown) => string
): Promise<void> {
  let res;
  try {
    res = await daemonRequest(daemon, method, path, body);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (res.status >= 400) {
    const message =
      (res.body as { error?: string } | undefined)?.error ?? `daemon request failed with status ${res.status}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }
  output(flags, res.body, humanLine(res.body));
}

const COMMON_FLAGS = ['db', 'json', 'state-dir'];

// Every flag each subcommand accepts, beyond `--db`/`--json`. An unknown
// flag is silently dropped by `parseFlags` (it just never lands in `flags`)
// which used to surface as a confusing downstream error, e.g. a foreign-key
// violation from an empty `dependsOnTicketId` when someone typed
// `--blocked-by` instead of `--depends-on`. Checked up front so a typo is
// reported as a typo.
const FLAG_SPECS: Record<string, string[]> = {
  // `--brief` seeds `projects.brief` (read into every worker's
  // `TicketEnvelope.projectBrief`); `--workspace-root` seeds
  // `projects.workspace_root`, required once any ticket in the project uses
  // `--workspace DIRECTORY` (one shared directory per project, not per
  // ticket -- see workspace.ts).
  // `--max-spend` sets `projects.max_spend_usd` (batch-4-spec.md section 1
  // ruling 1's project-level spend cap, layer 1 of three: refuses to spawn a
  // run once the project's total recorded spend plus the run's ceiling
  // would exceed it). That column is Role H's to add; see `hasMaxSpendColumn`.
  // `--model` (batch 6 item 4) sets `projects.default_model` /
  // `tickets.model` -- the project-default-with-per-ticket-override shape
  // `resolveModel` reads (store.ts), same as `--max-spend`/`--budget`
  // above it for the budget columns.
  // `--manager-model` (batch 9) sets `projects.manager_model` -- the model
  // the Manager runs on for THIS project, defaulting to `--model`/
  // `default_model` when unset (store.ts's resolveManagerModel). A project
  // setting, not a per-ticket one: see types.ts's Project.managerModel for
  // why a manager ticket never gets its own `--model` override the way an
  // ordinary `ticket add` does.
  // `--dir` (batch 12 ruling 1): "a project has exactly one directory" --
  // replaces `--workspace-root` and `--scope <file>`, both retired. Defaults
  // to the current working directory; see the handler below for why that
  // default, not the state dir.
  'project create': ['name', 'description', 'max-parallel', 'brief', 'dir', 'max-spend', 'model', 'manager-model', 'verifier-model'],
  'project set': ['project', 'max-spend', 'model', 'manager-model', 'verifier-model', 'dir', 'max-parallel'],
  // Batch 10 (Role Q), item 2: no flags of its own -- lists every project in
  // this state directory's database. See commands/projectList.ts.
  'project list': [],
  // Ruling 35 (batch-19-spec.md section 3): `key`/`value` are positional
  // (`config set <key> <value>`, `config get [key]`, `config unset <key>`),
  // matching `project create --name`/positionals[1]'s own fallback shape --
  // no flag of their own to validate here.
  'config get': [],
  'config set': [],
  'config unset': [],
  'ticket add': [
    'project',
    'title',
    'description',
    'max-attempts',
    'priority',
    'workspace',
    'budget',
    'model',
    'profile',
    'acceptance',
    'depends-on',
    'expected-artifact',
  ],
  'dep add': ['project', 'ticket', 'depends-on', 'type'],
  // Batch 19 mini-phase 1A (worker-profiles-design.md section 5): the
  // owner's roster, global to the database. `list` has no flags of its own
  // (mirrors `project list`). `add` needs every field but `--policy`, which
  // defaults to empty text; `set` takes `--profile <name|id>` to say which
  // row, then any subset of the same fields to change (mirrors `project
  // set`'s shape); `retire` takes only `--profile`.
  'profile list': [],
  'profile add': ['name', 'model', 'purpose', 'policy'],
  'profile set': ['profile', 'name', 'model', 'purpose', 'policy'],
  'profile retire': ['profile'],
  // `--fake-script` is only honoured when `--adapter fake` (the default); it
  // scripts the permanent FakeAdapter test double per ticket id so a
  // scenario like "this ticket needs a user decision" or "this ticket fails
  // until it exhausts its attempts" can be driven through the real CLI
  // instead of only from a test file calling FakeAdapter directly. Format:
  // `--fake-script <ticketId>=<kind>`, repeatable; `<kind>` is one of
  // FakeAdapter's FakeScript kinds (succeed, retryable_failure, question,
  // needs_user_decision, malformed_result, hang).
  //
  // `--workspace-root`, a lifetime flag on the adapter, is gone: workspace
  // is now resolved per ticket (each ticket's own `--workspace`, and
  // `project create --workspace-root` for the project's one shared
  // DIRECTORY), not chosen once for the whole `run`/`tick` invocation. See
  // scheduler.ts's `tick()`, which now prepares and passes a `workspace`
  // per ticket rather than the adapter carrying one for its whole lifetime.
  // `--fake-outcome <ticketId>=<outcome>`, repeatable, batch 5 item 5:
  // narrower and friendlier than `--fake-script` for the outcomes the
  // daemon's own vocabulary distinguishes (done/review/needs_user_decision/
  // retryable/final -- see FakeAdapter's `review`/`final` kinds, new that
  // batch; `budget_insufficient`, the worker's own budget self-stop, new in
  // batch 7). Layered on top of `--fake-script`, not a replacement: existing
  // scripts (`succeed`, `question`, `malformed_result`, `hang`) still only
  // have a `--fake-script` spelling.
  tick: ['project', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome', 'fake-progress-gap'],
  run: ['until-idle', 'project', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome', 'fake-progress-gap'],
  // Batch 8 (Role M): `serve` has no `--project` -- it ticks every project in
  // the state directory's database (see daemon.ts's startDaemonLoop). `--port`
  // defaults to 0 (any free loopback port); `--tick-interval` is in seconds,
  // matching `--run-timeout`'s convention elsewhere in this file.
  serve: ['port', 'tick-interval', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome', 'fake-progress-gap'],
  // Batch 10 (Role Q): `--paid` opts into one real, billed `claude -p` call
  // (see commands/doctor.ts) -- absent by default, so `doctor` costs nothing
  // unless explicitly asked to spend.
  doctor: ['paid'],
  // Ruling 20: no flags of its own beyond the common `--state-dir`/`--json`
  // (COMMON_FLAGS) -- listed explicitly, empty, so an unrelated flag (e.g. a
  // stray `--project`) is still caught as unknown rather than silently
  // accepted.
  token: [],
  status: ['project'],
  board: ['project'],
  inbox: ['project'],
  // `--progress` (batch 15 ruling 7): switches this command from the
  // ordinary event log to `activity --progress --ticket <id>`'s own
  // narrower question -- the latest worker_progress event per run for ONE
  // ticket -- which `buildActivity`'s existing visibility filter can never
  // answer (worker_progress stays internal by design; see policy.ts). Only
  // meaningful with `--ticket`; see the handler below for the refusal when
  // it is omitted.
  activity: ['project', 'ticket', 'all', 'progress'],
  // Batch 9: `magarine plan --project <id> --mission "<text>"` creates the
  // manager ticket. Batch 11 part 2 (Strategist ruling, settled):
  // `--mission` now seeds the project's scope document with the text (or
  // refuses if the scope already has content) before planning from it --
  // see commands/plan.ts's planWithMission, the one function both this
  // direct-write path and the daemon route (daemonApi.ts's handlePlan)
  // call. Batch 11 rule e: `--budget` sets the manager ticket's own ceiling
  // override, same as `ticket add --budget`.
  plan: ['project', 'mission', 'budget'],
  // Batch 11 part 2, item 3: `discuss --project <id> --message "<text>"`
  // calls Role R's discussProject (manager.ts) directly, the same
  // no-daemon/live-daemon split every other mutating command here has.
  // `--budget` matches `plan`'s own meaning: this discuss ticket's own
  // ceiling override.
  discuss: ['project', 'message', 'budget'],
  decide: ['ticket', 'answer'],
  retry: ['ticket'],
  approve: ['ticket'],
  reject: ['ticket', 'reason'],
  resume: ['project'],
  // Batch 8 (Role M): daemon-only, per the spec's "cancel is daemon-only and
  // says so when no daemon is up" -- no direct-write fallback exists for
  // this one, unlike every other mutating command above.
  cancel: ['ticket'],
};

// Builds the AgentAdapter for `tick`/`run --until-idle` from `--adapter`
// (default: fake). `claude` spawns the real Claude Code CLI via
// ClaudeCliAdapter (see adapters/claudeCli.ts). `--claude-exe` overrides the
// executable; if omitted, it defaults to `resolveExecutable('claude')`
// (process.ts), which unwraps the npm .cmd shim on Windows so the adapter
// always spawns the real binary directly — spawning through the shim
// reintroduces the argument corruption and the unkillable worker the batch
// 1 spike hit (docs/spikes/claude-cli-adapter.md §0). The project's
// `max_budget_usd` (migration 0003) is read directly with a scoped query
// rather than through store.ts's `Project` type, so this file is the only
// one touched for budget wiring.
const FAKE_SCRIPT_KINDS = new Set<FakeScript['kind']>([
  'succeed',
  'retryable_failure',
  'question',
  'needs_user_decision',
  'malformed_result',
  'hang',
  // Batch 15 ruling 7: never terminates on its own (fakeAdapter.ts's own
  // doc comment on this kind), so a ticket scripted this way stays
  // IN_PROGRESS with exactly one recorded worker_progress event -- the
  // shape `latest_activity`/`GET /tickets/{id}/progress`/`activity
  // --progress` all need something to read, drivable end to end through
  // the real CLI rather than only from a test file calling FakeAdapter
  // directly.
  'progress',
  // Batch 16 Role A item 1: lands the ticket in REVIEW under `--fake-script`'s
  // own spelling too (`--fake-outcome review` has done so since batch 5).
  'review',
  // Batch 18 ruling 31: what the VERIFIER run does (fakeAdapter.ts's FakeScript
  // doc). A ticket's worker script and verifier script are independent.
  'verify_pass',
  'verify_fail',
  'verify_malformed',
  'verify_failure',
  'verify_hang',
]);

// Batch 5 item 5: the daemon's own outcome vocabulary, mapped onto
// FakeAdapter's script kinds -- `done`/`retryable` rename existing kinds to
// the names a user of `--fake-outcome` actually thinks in; `review` and
// `final` are the two kinds FakeAdapter gained this batch specifically so
// this flag could exist (see fakeAdapter.ts's FakeScript union).
const FAKE_OUTCOME_KINDS: Record<string, FakeScript['kind']> = {
  done: 'succeed',
  review: 'review',
  needs_user_decision: 'needs_user_decision',
  retryable: 'retryable_failure',
  final: 'final',
  // Batch 7 (Role L): the worker's own budget self-stop -- see
  // fakeAdapter.ts's 'budget_insufficient' FakeScript kind and
  // scheduler.ts's dedicated `worker_budget_stop` routing for this status.
  budget_insufficient: 'budget_insufficient',
  // Batch 10 (Role O): FakeAdapter has had a 'manager_proposal' script kind
  // since batch 9 (managerScheduler.test.ts drives it directly), but it was
  // never reachable from either CLI flag -- `plan` then `run --until-idle`
  // could not be exercised end to end without a real daemon. Bare
  // `--fake-outcome <ticketId>=manager_proposal` gives the "manager ran but
  // never wrote proposal.json" shape (no `proposal` payload); a scenario
  // needing a real proposal still has to script FakeAdapter directly from a
  // test, since neither flag has a way to pass one on the command line.
  manager_proposal: 'manager_proposal',
};

// `projectId` is the already-RESOLVED id (see `resolveProjectRef`), never
// `flags.project` directly -- that flag may now be a project NAME (item 2),
// and the `max_budget_usd` lookup below is a raw scoped query keyed on the
// real id, not something `resolveProjectRef`'s own name-matching applies to.
// `serve` has no single project in view (it ticks every project in the
// database), so it passes `''`, matching this function's prior behaviour
// for that command exactly.
function buildAdapter(db: Db, flags: Flags, projectId: string): AgentAdapter {
  const kind = typeof flags.adapter === 'string' ? flags.adapter : 'fake';

  if (kind === 'fake') {
    const adapter = new FakeAdapter();
    // Batch 16 Role A item 1: `--fake-progress-gap <ms>` is the gap between
    // the messages of a `progress:<message>` burst below (default
    // FAKE_PROGRESS_GAP_MS).
    let gapMs: number | undefined;
    if ('fake-progress-gap' in flags) {
      // Present at all: a bare flag (parseFlags stores `true`) is refused too,
      // not ignored. `0` is legitimate (no gap); NaN, negatives and
      // fractions are not -- never a silent NaN.
      const raw = flags['fake-progress-gap'];
      gapMs = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
      if (!Number.isInteger(gapMs) || gapMs < 0) {
        throw new Error(
          `--fake-progress-gap must be a whole number of milliseconds, 0 or more, got: ${typeof raw === 'string' ? raw : '(no value)'}`
        );
      }
    }
    const bursts = new Map<string, string[]>();
    for (const spec of flagList(flags, 'fake-script')) {
      const eq = spec.indexOf('=');
      if (eq < 0) {
        throw new Error(`--fake-script must be "<ticketId>=<kind>", got: ${spec}`);
      }
      const ticketId = spec.slice(0, eq);
      let scriptKind = spec.slice(eq + 1);
      // `<ticketId>=progress:<message>`, repeatable: each occurrence appends
      // one message to that ticket's ordered burst. Only the FIRST ':' splits
      // kind from message, so a message may itself contain ':' or '='. Bare
      // `progress` (no colon) is the unchanged single-event form.
      if (scriptKind.startsWith('progress:')) {
        const list = bursts.get(ticketId) ?? [];
        list.push(scriptKind.slice('progress:'.length));
        bursts.set(ticketId, list);
        adapter.setScript(ticketId, { kind: 'progress', messages: list, gapMs });
        continue;
      }
      if (!FAKE_SCRIPT_KINDS.has(scriptKind as FakeScript['kind'])) {
        throw new Error(
          `--fake-script has an unknown kind "${scriptKind}" for ticket ${ticketId}. Valid kinds: ${[
            ...FAKE_SCRIPT_KINDS,
          ].join(', ')}.`
        );
      }
      adapter.setScript(ticketId, { kind: scriptKind as FakeScript['kind'] });
    }
    for (const spec of flagList(flags, 'fake-outcome')) {
      const eq = spec.indexOf('=');
      if (eq < 0) {
        throw new Error(`--fake-outcome must be "<ticketId>=<outcome>", got: ${spec}`);
      }
      const ticketId = spec.slice(0, eq);
      const outcome = spec.slice(eq + 1);
      const scriptKind = FAKE_OUTCOME_KINDS[outcome];
      if (!scriptKind) {
        throw new Error(
          `--fake-outcome has an unknown outcome "${outcome}" for ticket ${ticketId}. Valid outcomes: ${Object.keys(
            FAKE_OUTCOME_KINDS
          ).join(', ')}.`
        );
      }
      adapter.setScript(ticketId, { kind: scriptKind } as FakeScript);
    }
    return adapter;
  }

  if (kind === 'claude') {
    let claudeExe = typeof flags['claude-exe'] === 'string' ? flags['claude-exe'] : undefined;
    // Batch 11 ruling 2/4: only captured for the AUTO-resolved path -- an
    // explicit --claude-exe bypasses resolveCommand entirely, so there is no
    // strategy/shim to name if that path ever fails to spawn.
    let claudeResolution: { strategy: string; shimPath?: string } | undefined;
    if (!claudeExe) {
      try {
        const resolved = resolveCommand('claude');
        claudeExe = resolved.executable;
        claudeResolution = { strategy: resolved.strategy, shimPath: resolved.shimPath };
      } catch (err) {
        throw new Error(
          `--claude-exe was not given and resolveExecutable('claude') failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    const projectRow = db.prepare('SELECT max_budget_usd FROM projects WHERE id = ?').get(projectId) as
      | { max_budget_usd: number }
      | undefined;
    // `workspaceType`/`workspaceRoot` here are ClaudeCliAdapterOptions'
    // required construction-time fallback, never actually used: scheduler.ts
    // now prepares a workspace per ticket and passes it into every
    // `startWorker` call, which the adapter always prefers over its own
    // constructor default (see claudeCli.ts's `startWorker`). 'NONE' with no
    // root is simply the least surprising placeholder for a value nothing
    // reads.
    return new ClaudeCliAdapter({
      claudeExe,
      claudeResolution,
      maxBudgetUsd: projectRow?.max_budget_usd ?? 2.0,
      workspaceType: 'NONE',
    });
  }

  throw new Error(`Unknown adapter: ${kind}`);
}

// The ONE composition of a command's valid-flag list: the unknown-flag error
// and `<command> --help` both print exactly this, so the two cannot drift.
// Both spellings for locating state are named (the README teaches
// `--state-dir`; `--db` is the other accepted way), never only one of them.
function validFlagsText(key: string): string {
  const own = FLAG_SPECS[key] ?? [];
  const list = own.length > 0 ? own.map((k) => `--${k}`).join(', ') : '(none of its own)';
  return `${list} (plus --state-dir <dir> to choose the state directory, --db <file> to name one database file, and --json)`;
}

// `app` (batch 17) takes everything `serve` does -- it runs the daemon itself
// in owned mode -- plus `--browser`. Derived, so the two cannot drift.
FLAG_SPECS.app = [...FLAG_SPECS.serve, 'browser', 'no-notify'];

// One sentence some commands carry beyond their flag list, printed by
// `<command> --help` after the flags.
const COMMAND_NOTES: Record<string, string> = {
  app: 'Opens the board in its own window (Chrome, else Edge; --browser or MAGARINE_BROWSER overrides), starting the daemon itself if none is running. Tested on Windows only. Closing the window never stops the daemon; Ctrl+C here does. Needs You also raises a Windows toast (sender: "Windows PowerShell"; clicking it does nothing) -- Windows only, off with --no-notify.',
};

function checkKnownFlags(key: string, flags: Flags): string | null {
  const known = FLAG_SPECS[key];
  if (!known) return null;
  const unknown = Object.keys(flags).filter((k) => !COMMON_FLAGS.includes(k) && !known.includes(k));
  if (unknown.length === 0) return null;
  return `Unknown flag(s) for '${key}': ${unknown.map((k) => `--${k}`).join(', ')}. Valid flags: ${validFlagsText(key)}.`;
}

// The usage line is GENERATED from FLAG_SPECS -- the same table that validates
// every command's flags -- so a command cannot exist without being listed
// (a command the product does not admit to having reads as one that does not
// exist). cli.test.ts also checks every dispatched command is in the table.
function usageText(): string {
  return `Usage: magarine <${Object.keys(FLAG_SPECS).join('|')}> [--flags] [--json]\nFor one command's flags: magarine <command> --help`;
}

// The daemon's listening line -- `serve` and `app` (owned mode) print the very
// same one. Never includes the token.
function announceListening(flags: Flags, info: { pid: number; port: number; stateDir: string }, machineCap: number): void {
  output(
    flags,
    info,
    `magarine daemon listening on 127.0.0.1:${info.port} (pid ${info.pid}) -- page: http://127.0.0.1:${info.port}/ -- token: run \`magarine token\` -- up to ${machineCap} workers at once (--max-parallel)`
  );
}

// Batch 18 one-liner: `plan` and `discuss` used to print "Created manager ticket" and
// stop, and the owner (and the stranger before them) never learned where the
// Manager's answer goes. Human output only: --json stdout stays pure JSON.
function managerReplyHint(projectId: string): string {
  return `The Manager's reply appears in the Manager tab of the window (\`magarine app\`) and on this ticket's row in \`magarine board --project ${projectId}\`, once it has run.`;
}

function output(flags: Flags, data: unknown, humanLine: string): void {
  if (flags.json) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    process.stdout.write(humanLine + '\n');
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseFlags(rest);
  const subcommand = positionals[0];
  const flagSpecKey = subcommand ? `${command} ${subcommand}` : command;

  // `--help` is a request, not a flag to validate: answered before anything
  // else (never opens a database, never starts a daemon), to stdout, exit 0.
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${usageText()}\n`);
    return;
  }
  if (flags.help) {
    if (FLAG_SPECS[flagSpecKey]) {
      const note = COMMAND_NOTES[flagSpecKey];
      process.stdout.write(`Usage: magarine ${flagSpecKey} [--flags]\nValid flags: ${validFlagsText(flagSpecKey)}\n${note ? `${note}\n` : ''}`);
    } else {
      process.stdout.write(`${usageText()}\n`);
    }
    return;
  }

  const flagError = checkKnownFlags(flagSpecKey, flags);
  if (flagError) {
    process.stderr.write(flagError + '\n');
    process.exitCode = 1;
    return;
  }

  if (command === 'project' && subcommand === 'create') {
    const db = openDb(dbPath(flags));
    // Batch 12 ruling 1: "a project has exactly one directory" -- `--dir`
    // replaces both the old `--workspace-root` and `--scope <file>`, since
    // workspace_root and scope_path now both derive from this one path
    // (store.ts's createProject call below). Defaults to the CURRENT
    // working directory, not this invocation's state dir: the owner runs
    // `project create` FROM the folder they mean, the same way `git init`
    // works, and the state dir (~/.magarine or --state-dir) is where
    // Magarine's own bookkeeping lives, not where the owner's project does
    // -- those are two different things this batch stops conflating. A
    // project can no longer be created without a directory, so the trap
    // batch 11's own README walk hit (a DIRECTORY ticket with no
    // workspace_root configured) cannot be reproduced.
    const dir = resolve(typeof flags.dir === 'string' ? flags.dir : process.cwd());
    // Batch 16 ruling 24: ruling 22's check is now the shared
    // `projectReadiness`, asked about the row this command is about to write
    // -- the same function the scheduler asks, so the two cannot drift.
    const notReady = projectReadiness({ workspaceRoot: dir, scopePath: join(dir, 'SCOPE.md') }, stateDir(flags), probeScopeFile);
    if (notReady) {
      process.stderr.write(`${notReady.message}\n`);
      process.exitCode = 1;
      return;
    }
    const project = createProject(db, {
      name: String(flags.name ?? positionals[1] ?? ''),
      description: typeof flags.description === 'string' ? flags.description : null,
      // Batch 16: absent means no cap of its own (null); the validator runs in
      // createProject and, for a bare/garbled flag, in parseMaxParallelFlag.
      maxParallelWorkers: parseMaxParallelFlag(flags),
      maxSpendUsd: typeof flags['max-spend'] === 'string' ? Number(flags['max-spend']) : null,
      defaultModel: typeof flags.model === 'string' ? flags.model : undefined,
      brief: typeof flags.brief === 'string' ? flags.brief : null,
      workspaceRoot: dir,
      managerModel: typeof flags['manager-model'] === 'string' ? flags['manager-model'] : null,
      // Batch 18 ruling 31: absent, the verifier runs on the project's default model.
      verifierModel: typeof flags['verifier-model'] === 'string' ? flags['verifier-model'] : null,
      scopePath: join(dir, 'SCOPE.md'),
    });
    // Ruling 29: never silent about a scope document that is not there yet.
    // In --json mode stdout stays pure JSON, so the line goes to stderr.
    const scopeLine = scopeAnnouncement(project.scopePath, probeScopeFile);
    output(flags, project, `Created project ${project.id} (${project.name}) in ${dir}${scopeLine && !flags.json ? `
${scopeLine}` : ''}`);
    if (scopeLine && flags.json) process.stderr.write(`${scopeLine}
`);
    return;
  }

  if (command === 'project' && subcommand === 'set') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? positionals[1] ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }

    // Ruling 22: checked once, here, ahead of the live-daemon/direct-write
    // fork below, so an unsafe `--dir` is refused identically either way --
    // a running daemon must not become the way this refusal is bypassed.
    let resolvedDir: string | undefined;
    if (typeof flags.dir === 'string') {
      resolvedDir = resolve(flags.dir);
      const notReady = projectReadiness({ workspaceRoot: resolvedDir, scopePath: join(resolvedDir, 'SCOPE.md') }, stateDir(flags), probeScopeFile);
      if (notReady) {
        process.stderr.write(`${notReady.message}\n`);
        process.exitCode = 1;
        return;
      }
    }

    // Ruling 23: validated once, here, ahead of the live-daemon/direct-write
    // fork -- store.ts's one validator, the same one `project create` runs
    // (via createProject). Checked before routing because NaN would
    // serialise to JSON `null` and reach the daemon as "not given".
    // `none` clears the project's own cap back to null (the daemon's ceiling
    // alone governs); the body then carries a real JSON null, not "not given".
    let maxParallel: number | null | undefined;
    if (flags['max-parallel'] === 'none') maxParallel = null;
    else maxParallel = parseMaxParallelFlag(flags);

    const live = await liveDaemonFor(flags);
    if (live) {
      const body: { maxSpend?: number; model?: string; managerModel?: string; verifierModel?: string; dir?: string; maxParallel?: number | null } = {};
      if (maxParallel !== undefined) body.maxParallel = maxParallel;
      if (typeof flags['max-spend'] === 'string') body.maxSpend = Number(flags['max-spend']);
      if (typeof flags.model === 'string') body.model = flags.model;
      if (typeof flags['manager-model'] === 'string') body.managerModel = flags['manager-model'];
      if (typeof flags['verifier-model'] === 'string') body.verifierModel = flags['verifier-model'];
      if (resolvedDir !== undefined) body.dir = resolvedDir;
      await routeMutation(flags, live, 'POST', `/projects/${projectId}/set`, body, () => `Updated project ${projectId}`);
      return;
    }

    if (maxParallel !== undefined) {
      setProjectMaxParallelWorkers(db, projectId, maxParallel);
    }
    if (typeof flags['max-spend'] === 'string') {
      setProjectMaxSpendUsd(db, projectId, Number(flags['max-spend']));
    }
    if (typeof flags.model === 'string') {
      setProjectDefaultModel(db, projectId, flags.model);
    }
    if (typeof flags['manager-model'] === 'string') {
      setProjectManagerModel(db, projectId, flags['manager-model']);
    }
    if (typeof flags['verifier-model'] === 'string') {
      setProjectVerifierModel(db, projectId, flags['verifier-model']);
    }
    if (resolvedDir !== undefined) {
      setProjectDir(db, projectId, resolvedDir);
    }
    output(flags, getProject(db, projectId), `Updated project ${projectId}`);
    return;
  }

  if (command === 'project' && subcommand === 'list') {
    // Batch 10 owner walk finding 2: closing the terminal after `project
    // create` made a project unreachable -- there was no way back to its
    // id. Read-only, like board/inbox/status/activity: never routed to a
    // live daemon.
    const db = openDb(dbPath(flags));
    const entries = buildProjectList(db, stateDir(flags), probeScopeFile);
    output(flags, entries, formatProjectList(entries));
    return;
  }

  // Ruling 35 (batch-19-spec.md section 3): `config get [key]`, `config set
  // <key> <value>`, `config unset <key>` -- the global defaults table. `get`
  // is read-only, like `project list`/`board`/... above: never routed to a
  // live daemon. `set`/`unset` follow the single-writer rule everything else
  // mutating does (liveDaemonFor below): PATCH /settings when a daemon owns
  // this database file, a direct write otherwise. Validation (unknown key,
  // unknown model, a bad cap) lives once in store.ts's setSetting/
  // unsetSetting -- this block only catches what they throw and reports it
  // exactly like every other command's own typed error already is.
  if (command === 'config' && subcommand === 'get') {
    const db = openDb(dbPath(flags));
    const key = positionals[1];
    if (key !== undefined) {
      if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
        process.stderr.write(`unknown setting: ${key}\n`);
        process.exitCode = 1;
        return;
      }
      const value = getSetting(db, key);
      output(flags, { [key]: value }, value === null ? `${key} is not set` : `${key} = ${value}`);
      return;
    }
    const settings = getSettings(db);
    output(
      flags,
      settings,
      Object.keys(settings).length > 0 ? Object.entries(settings).map(([k, v]) => `${k} = ${v}`).join('\n') : '(no settings set)'
    );
    return;
  }

  if (command === 'config' && subcommand === 'set') {
    const db = openDb(dbPath(flags));
    const key = String(positionals[1] ?? '');
    const value = String(positionals[2] ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'PATCH', '/settings', { [key]: value }, () => `${key} = ${value}`);
      return;
    }
    try {
      setSetting(db, key, value);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    output(flags, getSettings(db), `${key} = ${value}`);
    return;
  }

  if (command === 'config' && subcommand === 'unset') {
    const db = openDb(dbPath(flags));
    const key = String(positionals[1] ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'PATCH', '/settings', { [key]: null }, () => `${key} unset`);
      return;
    }
    try {
      unsetSetting(db, key);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    output(flags, getSettings(db), `${key} unset`);
    return;
  }

  if (command === 'doctor') {
    // No `--db`/daemon routing: doctor never touches ticket/project state,
    // only the state directory (writability) and a live daemon.json there
    // (daemon.ts/daemonClient.ts, read-only). See commands/doctor.ts's own
    // header for why each check is PASS/FAIL/SKIP rather than a boolean.
    const lines = await runDoctor({ stateDir: stateDir(flags), paid: Boolean(flags.paid) });
    if (flags.json) {
      process.stdout.write(JSON.stringify(lines) + '\n');
    } else {
      process.stdout.write(formatDoctor(lines) + '\n');
    }
    process.exitCode = doctorExitCode(lines);
    return;
  }

  if (command === 'token') {
    // Ruling 20: the one sanctioned path the token reaches the owner's
    // session -- copied to the clipboard by runToken (commands/token.ts),
    // never printed. `result` (and `--json`) never carries `.token`.
    try {
      const result = await runToken({ stateDir: stateDir(flags) });
      output(
        flags,
        result,
        `token copied to the clipboard; paste it into the page at http://127.0.0.1:${result.port}/`
      );
    } catch (err) {
      if (err instanceof TokenError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'plan') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }
    const mission = String(flags.mission ?? '');
    const budgetUsd = typeof flags.budget === 'string' ? Number(flags.budget) : undefined;
    // Ruling 29: `plan` does not refuse a missing scope document (the
    // talk-first start is deliberate) but says so BEFORE the Manager is
    // queued -- probed here, ahead of planProject's own ensureScopeFile, which
    // creates the empty file. Skipped with --mission: that seeds the file.
    if (mission.trim().length === 0) {
      const scopeLine = scopeAnnouncement(getProject(db, projectId)?.scopePath ?? null, probeScopeFile);
      if (scopeLine) (flags.json ? process.stderr : process.stdout).write(`${scopeLine}
`);
    }
    const live = await liveDaemonFor(flags);
    if (live) {
      // Batch 11 part 2, item 1 (Strategist ruling, settled): one function,
      // planWithMission (commands/plan.ts), implements "seed the scope with
      // this text, then plan" -- daemonApi.ts's handlePlan calls it too, so
      // the daemon path and this direct-write path never diverge, and a
      // refusal (scope already has content) reads identically on both.
      await routeMutation(
        flags,
        live,
        'POST',
        `/projects/${projectId}/plan`,
        { mission: mission || undefined, budgetUsd },
        (b) => {
          const t = b as { id: string; title: string };
          return `Created manager ticket ${t.id} (${t.title})\n${managerReplyHint(projectId)}`;
        }
      );
      return;
    }

    try {
      const ticket = planWithMission(db, projectId, { mission, budgetUsd });
      output(flags, ticket, `Created manager ticket ${ticket.id} (${ticket.title})\n${managerReplyHint(projectId)}`);
    } catch (err) {
      if (err instanceof PlanError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'discuss') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }
    const message = String(flags.message ?? '');
    const budgetUsd = typeof flags.budget === 'string' ? Number(flags.budget) : undefined;
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/projects/${projectId}/discuss`, { message, budgetUsd }, (b) => {
        const t = b as { id: string; title: string };
        return `Created manager ticket ${t.id} (${t.title})\n${managerReplyHint(projectId)}`;
      });
      return;
    }

    try {
      const ticketId = discussProject(db, projectId, message, { budgetUsd });
      const ticket = getTicket(db, ticketId)!;
      output(flags, ticket, `Created manager ticket ${ticket.id} (${ticket.title})\n${managerReplyHint(projectId)}`);
    } catch (err) {
      if (err instanceof ManagerError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'ticket' && subcommand === 'add') {
    const dependsOn = flagList(flags, 'depends-on');
    // Ruling 16: absent -> null (today's rule: no verification beyond "done
    // requires something delivered"), never `[]` -- store.ts persists `[]`
    // as a real, non-null list, which would wrongly turn on DONE
    // verification for every ticket created without this flag. File kind
    // only: no other kind is ever verified (types.ts, scheduler.ts), so the
    // CLI does not accept one.
    const expectedArtifactPaths = flagList(flags, 'expected-artifact');
    if (expectedArtifactPaths.some((path) => path === '')) {
      process.stderr.write('--expected-artifact requires a non-empty path\n');
      process.exitCode = 1;
      return;
    }
    const expectedArtifacts =
      expectedArtifactPaths.length > 0
        ? expectedArtifactPaths.map((path) => ({ kind: 'file' as const, path }))
        : null;
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }

    const live = await liveDaemonFor(flags);
    if (live) {
      const body = {
        project: projectId,
        title: String(flags.title ?? positionals[1] ?? ''),
        description: typeof flags.description === 'string' ? flags.description : null,
        maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : undefined,
        priority: flags.priority ? Number(flags.priority) : undefined,
        workspaceType: typeof flags.workspace === 'string' ? flags.workspace : undefined,
        acceptanceCriteria: flagList(flags, 'acceptance'),
        model: typeof flags.model === 'string' ? flags.model : null,
        profile: typeof flags.profile === 'string' ? flags.profile : null,
        budget: typeof flags.budget === 'string' ? Number(flags.budget) : undefined,
        dependsOn,
      };
      await routeMutation(flags, live, 'POST', '/tickets', body, (b) => {
        const t = b as { id: string; title: string };
        return `Created ticket ${t.id} (${t.title})`;
      });
      return;
    }

    // The project is already known to exist (resolveProjectRef above), so
    // nothing left here can throw the "no such project" shape TicketAddError
    // used to guard -- that class is gone, superseded by NoSuchProjectError.
    const ticket = createTicket(db, {
      projectId,
      title: String(flags.title ?? positionals[1] ?? ''),
      description: typeof flags.description === 'string' ? flags.description : null,
      maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : 3,
      priority: flags.priority ? Number(flags.priority) : 0,
      workspaceType: (typeof flags.workspace === 'string' ? flags.workspace : 'NONE') as WorkspaceType,
      acceptanceCriteria: flagList(flags, 'acceptance'),
      model: typeof flags.model === 'string' ? flags.model : null,
      profile: typeof flags.profile === 'string' ? flags.profile : null,
      expectedArtifacts,
    });

    // `setTicketBudgetOverride` enforces `MIN_BUDGET_USD` (store.ts) with a
    // message naming the floor -- a raw `UPDATE` here would bypass it, which
    // is exactly the hole batch 4's close-out found: `--budget 0.01` was
    // silently accepted despite the twenty-five-cent floor.
    if (typeof flags.budget === 'string') {
      setTicketBudgetOverride(db, ticket.id, Number(flags.budget));
    }

    // Dependencies are attached, and only then is readiness resolved --
    // never before all of them are attached, and never left unresolved
    // after. Resolving mid-loop (or not at all) is exactly the batch 1
    // regression this flag exists to make impossible: a ticket must not be
    // promoted to READY, even briefly, while a `--depends-on` from this
    // same command has not been wired in yet. See dependencies.ts's
    // `resolveReadiness` doc comment and cli.test.ts's ordering regression
    // test for the original bug this guards against.
    for (const dependsOnTicketId of dependsOn) {
      addDependency(db, { ticketId: ticket.id, dependsOnTicketId });
    }
    if (dependsOn.length > 0) {
      resolveReadiness(db, ticket.projectId);
    }

    const finalTicket = getTicket(db, ticket.id)!;
    output(flags, finalTicket, `Created ticket ${finalTicket.id} (${finalTicket.title})`);
    return;
  }

  if (command === 'dep' && subcommand === 'add') {
    const ticketId = String(flags.ticket ?? '');
    const dependsOnTicketId = String(flags['depends-on'] ?? '');
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }

    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(
        flags,
        live,
        'POST',
        '/deps',
        { project: projectId, ticket: ticketId, dependsOn: dependsOnTicketId },
        () => `Added dependency: ${ticketId} depends on ${dependsOnTicketId}`
      );
      return;
    }

    addDependency(db, { ticketId, dependsOnTicketId });
    resolveReadiness(db, projectId);
    output(flags, { ticketId, dependsOnTicketId }, `Added dependency: ${ticketId} depends on ${dependsOnTicketId}`);
    return;
  }

  // Batch 19 mini-phase 1A: `profile list|add|set|retire`, the owner's
  // roster (worker-profiles-design.md section 5). Global to the database, no
  // `--project` -- unlike every ticket/dependency command above. `list` is a
  // read, never routed to a live daemon, same exception `project list`
  // already documents for itself (Batch 10 owner walk finding 2).
  if (command === 'profile' && subcommand === 'list') {
    const db = openDb(dbPath(flags));
    const rows = listWorkerProfiles(db).map((p) => ({ ...p, ...workerProfileStatus(db, p.id) }));
    const lines = rows.length === 0 ? '(no worker profiles)' : rows
      .map((p) => `${p.id}\t${p.name}\t${p.model}\t${p.purpose}\t${p.status}${p.ticketId ? ` (${p.ticketId})` : ''}`)
      .join('\n');
    output(flags, rows, lines);
    return;
  }

  if (command === 'profile' && subcommand === 'add') {
    const db = openDb(dbPath(flags));
    const input = {
      name: String(flags.name ?? positionals[1] ?? ''),
      model: String(flags.model ?? ''),
      purpose: String(flags.purpose ?? ''),
      policy: typeof flags.policy === 'string' ? flags.policy : null,
    };
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', '/profiles', input, (b) => {
        const p = b as { id: string; name: string };
        return `Created worker profile ${p.id} (${p.name})`;
      });
      return;
    }
    const profile = createWorkerProfile(db, input);
    output(flags, profile, `Created worker profile ${profile.id} (${profile.name})`);
    return;
  }

  if (command === 'profile' && subcommand === 'set') {
    const db = openDb(dbPath(flags));
    let profileId: string;
    try {
      profileId = resolveWorkerProfileRefForAdmin(db, String(flags.profile ?? positionals[1] ?? ''));
    } catch (err) {
      if (err instanceof NoSuchWorkerProfileError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    const fields = {
      name: typeof flags.name === 'string' ? flags.name : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      purpose: typeof flags.purpose === 'string' ? flags.purpose : undefined,
      policy: typeof flags.policy === 'string' ? flags.policy : undefined,
    };
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'PATCH', `/profiles/${profileId}`, fields, () => `Updated worker profile ${profileId}`);
      return;
    }
    const profile = updateWorkerProfile(db, profileId, fields);
    output(flags, profile, `Updated worker profile ${profile.id}`);
    return;
  }

  if (command === 'profile' && subcommand === 'retire') {
    const db = openDb(dbPath(flags));
    let profileId: string;
    try {
      profileId = resolveWorkerProfileRefForAdmin(db, String(flags.profile ?? positionals[1] ?? ''));
    } catch (err) {
      if (err instanceof NoSuchWorkerProfileError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/profiles/${profileId}/retire`, undefined, () => `Retired worker profile ${profileId}`);
      return;
    }
    const profile = retireWorkerProfile(db, profileId);
    output(flags, profile, `Retired worker profile ${profile.id}`);
    return;
  }

  if (command === 'tick') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }

    const live = await liveDaemonFor(flags);
    if (live) {
      // The daemon owns its own adapter, set once at `serve` startup -- an
      // adapter flag given here has nothing to attach to on a remote
      // process, so it's noted (not silently dropped) rather than either
      // erroring the whole command or pretending it did something.
      const ignoredAdapterFlags = ['adapter', 'claude-exe', 'fake-script', 'fake-outcome'].filter((k) => k in flags);
      if (ignoredAdapterFlags.length > 0) {
        process.stderr.write(
          `Note: --${ignoredAdapterFlags.join(', --')} ignored: a live daemon uses the adapter it was started with, not a flag on this command.\n`
        );
      }
      await routeMutation(flags, live, 'POST', '/tick', { project: projectId }, (b) => {
        const r = b as { started: Array<{ ticketId: string }> };
        return `Started ${r.started.length} run(s).`;
      });
      return;
    }

    recoverOrphanedRuns(db);
    const adapter = buildAdapter(db, flags, projectId);
    // Review fix #4: same fallback chain the daemon's own admission uses
    // (resolveMachineCap, store.ts) -- a direct `tick` with no `--max-parallel`
    // must see `config set max_parallel_workers`, not silently fall back to 1
    // as if nothing had ever been configured.
    const result = await tick({
      db,
      adapter,
      projectId,
      maxParallelWorkers: resolveMachineCap(db, parseMaxParallelFlag(flags)),
      runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
      artifactsDir: artifactsDir(flags),
      readiness: { stateDir: stateDir(flags), scopeProbe: probeScopeFile },
    });
    output(flags, result, `Started ${result.started.length} run(s).`);
    return;
  }

  if (command === 'run' && flags['until-idle']) {
    const live = await liveDaemonFor(flags);
    if (live) {
      // No "wait until idle" route exists (docs/strategy/batch-8-spec.md's
      // API list has no such endpoint), and `run --until-idle` holding its
      // own worker handles inside this CLI invocation while a daemon is
      // also live is exactly the two-writer situation the whole daemon
      // exists to prevent. Refused outright rather than either violating
      // single-writer or inventing a polling mechanism the spec doesn't ask
      // for.
      process.stderr.write(
        "run --until-idle cannot run against a live daemon: the daemon already ticks continuously on its own, and there is no route to wait for idle. Use 'tick' for a single forced pass, or 'board'/'status' to watch progress.\n"
      );
      process.exitCode = 1;
      return;
    }

    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }
    recoverOrphanedRuns(db);
    const adapter = buildAdapter(db, flags, projectId);
    // Review fix #4: `runUntilIdle` calls `tick(deps)` in a loop, reading
    // `deps.maxParallelWorkers` fresh each pass -- a GETTER (not a number
    // computed once before the call) is what makes THIS read fresh too, so
    // `config set max_parallel_workers` while a long `run --until-idle` is
    // still churning changes admission on its very next iteration, same as
    // the daemon's own tick. No change needed in scheduler.ts itself: this
    // is a plain property access there either way.
    const untilIdleMaxParallelFlag = parseMaxParallelFlag(flags);
    await runUntilIdle({
      db,
      adapter,
      projectId,
      get maxParallelWorkers() {
        return resolveMachineCap(db, untilIdleMaxParallelFlag);
      },
      runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
      artifactsDir: artifactsDir(flags),
      readiness: { stateDir: stateDir(flags), scopeProbe: probeScopeFile },
    });
    output(flags, { idle: true }, 'Idle: no more runnable tickets.');
    return;
  }

  if (command === 'serve') {
    // Ruling 23: validated FIRST, before the database is opened or anything
    // is bound -- an invalid --max-parallel must never start a daemon.
    // Ruling 35: `undefined` (the flag was not given) is passed through, not
    // defaulted to 1 here -- daemon.ts re-reads `settings.max_parallel_workers`
    // fresh on every tick in that case (resolveMachineCap, store.ts); only
    // the ANNOUNCE line below needs one concrete number to print, computed
    // once at startup from whichever the daemon will actually use first.
    const machineCapFlag = parseMaxParallelFlag(flags);
    const resolvedDbPath = dbPath(flags);
    const db = openDb(resolvedDbPath);
    // No `--project` on `serve` -- it ticks every project in the database
    // (daemon.ts's startDaemonLoop), so there is no single id to resolve.
    const adapter = buildAdapter(db, flags, '');
    const resolvedStateDir = stateDir(flags);
    try {
      await serve({
        db,
        dbPath: resolvedDbPath,
        stateDir: resolvedStateDir,
        adapter,
        maxParallelWorkers: machineCapFlag,
        runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
        artifactsDir: artifactsDir(flags),
        tickIntervalMs: typeof flags['tick-interval'] === 'string' ? Number(flags['tick-interval']) * 1000 : undefined,
        port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
        // Batch 17: once, after the daemon is down, and only when running work
        // was cancelled -- through the same output path as the listening line.
        onStopped: ({ cancelled }) => {
          const line = formatShutdown(cancelled);
          output(flags, line.json, line.human);
        },
        // Never includes the token: only the CLI-facing shape a human or a
        // script watching stdout needs to find the daemon, not what it needs
        // to authenticate against it. Ruling 20: the human line now names
        // the page address (not a secret) and the one command that puts the
        // token on the clipboard -- `--json` is unchanged, still no token.
        onListening: (info) => announceListening(flags, info, resolveMachineCap(db, machineCapFlag)),
      });
    } catch (err) {
      if (err instanceof ServeError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'app') {
    // Same validation-first rule as `serve` (ruling 23): a bad --max-parallel
    // never starts anything. Ruling 35: `undefined` (flag absent) is passed
    // through to serveOptions() unchanged, same as `serve` above.
    const machineCapFlag = parseMaxParallelFlag(flags);
    const resolvedDbPath = dbPath(flags);
    const resolvedStateDir = stateDir(flags);
    // Opened and built LAZILY, only if this process ends up running the daemon
    // (owned mode): attaching to a live daemon needs neither a database nor an
    // adapter (which, for `claude`, must be installed).
    let ownedDb: Db | undefined;
    const getDb = (): Db => (ownedDb ??= openDb(resolvedDbPath));
    try {
      await runApp(
        {
          stateDir: resolvedStateDir,
          browserFlag: typeof flags.browser === 'string' ? flags.browser : undefined,
          notify: !('no-notify' in flags),
          serveOptions: () => {
            const db = getDb();
            return {
              db,
              dbPath: resolvedDbPath,
              stateDir: resolvedStateDir,
              adapter: buildAdapter(db, flags, ''),
              maxParallelWorkers: machineCapFlag,
              runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
              artifactsDir: artifactsDir(flags),
              tickIntervalMs: typeof flags['tick-interval'] === 'string' ? Number(flags['tick-interval']) * 1000 : undefined,
              port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
            };
          },
          // `getDb()` is already memoized by the time this fires: onListening
          // (owned mode only, see runApp's own doc comment) always runs AFTER
          // serveOptions() has called it once.
          onListening: (info) => announceListening(flags, info, resolveMachineCap(getDb(), machineCapFlag)),
          onStopped: ({ cancelled }) => {
            const line = formatShutdown(cancelled);
            output(flags, line.json, line.human);
          },
        },
        realAppSeams({
          findLiveDaemon: () => liveDaemonFor(flags),
          stateDir: resolvedStateDir,
          countInFlight: () => countTicketsByStatus(getDb(), 'IN_PROGRESS'),
          say: (human, data) => output(flags, data ?? { message: human }, human),
          sayError: (line) => {
            process.stderr.write(`${line}\n`);
          },
        })
      );
    } catch (err) {
      if (err instanceof ServeError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'status') {
    // Batch 16 item 6: no --project asks about the daemon, not a project.
    // Read-only, like the rest of status: it reads daemon.json and asks the
    // live daemon's /health for its slots; it never prints the token.
    if (flags.project === undefined) {
      const check = await checkDaemonFile(stateDir(flags), probeDaemonHealth);
      if (check.status !== 'live') {
        output(flags, { daemon: null }, 'no daemon running -- start one with `magarine serve`');
        return;
      }
      const info = check.info!;
      // What `slots` says is only ever what the daemon MEASURED and reported.
      // No default stands in for it: a daemon started from a build older than
      // this CLI answers /health without `slots`, and a fabricated
      // `{used: 0}` would tell the owner nothing is running while their
      // workers are. Absent is `null` ("not reported"), never zeros, and a
      // failed or unreachable /health is an error, not an empty answer.
      // The catch below is an EQUIVALENT MUTANT of `main().catch` at the
      // bottom of this file: removing it fails nothing, because the
      // top-level handler prints the same message and sets the same exit
      // code (proven -- statusDaemon.test.ts's hang-up case asserts exactly
      // that text and exit code, and still passes without this catch). It is
      // kept deliberately, not left by accident: this is a known failure
      // boundary -- the daemon can die between the liveness probe and this
      // request -- and handling it here keeps that answer local if the
      // top-level net is ever narrowed. Do not delete it as dead code.
      let health;
      try {
        health = await daemonRequest<{ slots?: unknown }>(info, 'GET', '/health');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
      }
      if (health.status >= 400) {
        process.stderr.write(`the daemon on 127.0.0.1:${info.port} answered /health with status ${health.status}\n`);
        process.exitCode = 1;
        return;
      }
      const reported = health.body?.slots;
      const slots =
        typeof reported === 'object' && reported !== null && typeof (reported as { used?: unknown }).used === 'number'
          ? {
              used: (reported as { used: number }).used,
              cap: typeof (reported as { cap?: unknown }).cap === 'number' ? (reported as { cap: number }).cap : null,
            }
          : null;
      const page = `http://127.0.0.1:${info.port}/`;
      const slotsClause =
        slots === null
          ? 'slots not reported (this daemon predates this CLI; restart it to see them)'
          : slots.cap === null
            ? `${slots.used} slots in use (ceiling not reported)`
            : `${slots.used} of ${slots.cap} slots in use`;
      output(
        flags,
        { daemon: { pid: info.pid, port: info.port, page, slots } },
        `daemon running: pid ${info.pid} on 127.0.0.1:${info.port} -- page: ${page} -- ${slotsClause}`
      );
      return;
    }
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }
    const tickets = listTickets(db, projectId);
    output(
      flags,
      tickets,
      // Batch 10 owner walk finding 4: display-only truncation, same as
      // board.ts's formatBoard -- the `--json` branch of `output()` above
      // still carries every ticket's full, untouched `.title`.
      tickets.map((t) => `${t.id}\t${t.status}\t${truncateTitleForDisplay(t.title)}`).join('\n')
    );
    return;
  }

  if (command === 'board') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }
    const result = buildBoard(db, projectId);
    output(flags, result, formatBoard(result));
    return;
  }

  if (command === 'inbox') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }
    const items = buildInbox(db, projectId);
    output(flags, items, formatInbox(items));
    return;
  }

  if (command === 'activity') {
    const db = openDb(dbPath(flags));

    if (flags.progress) {
      const ticketId = typeof flags.ticket === 'string' ? flags.ticket : '';
      if (!ticketId) {
        process.stderr.write('activity --progress requires --ticket <id>\n');
        process.exitCode = 1;
        return;
      }
      const progress = buildTicketProgress(db, ticketId);
      output(flags, progress, formatTicketProgress(progress));
      return;
    }

    let projectId: string | undefined;
    if (typeof flags.project === 'string') {
      try {
        projectId = resolveProjectRef(db, flags.project);
      } catch (err) {
        if (reportIfNoSuchProject(err)) return;
        throw err;
      }
    }
    const events = buildActivity(db, {
      projectId,
      ticketId: typeof flags.ticket === 'string' ? flags.ticket : undefined,
      all: Boolean(flags.all),
    });
    output(flags, events, formatActivity(events));
    return;
  }

  if (command === 'decide') {
    const ticketId = String(flags.ticket ?? '');
    // Ruling 36 (batch 19, mini-phase 2B): `--answer` given once behaves
    // exactly as before (a single `answer`); repeated `--answer` flags, in
    // order, become `answers`. Never both on the wire: this is the ONE field
    // decide() receives, chosen by how many were typed. A flag never typed
    // at all stays the pre-2B default of one legal empty answer; a bare
    // `--answer` (no value) is refused before any of that -- see
    // collectAnswerFlags's own doc comment for why it reads `rest` directly
    // instead of going through flagList.
    let answerList: string[];
    try {
      answerList = collectAnswerFlags(rest);
    } catch (err) {
      if (err instanceof DecideError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    const decideBody: { answer?: string; answers?: string[] } =
      answerList.length > 1 ? { answers: answerList } : { answer: answerList[0] ?? '' };
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(
        flags,
        live,
        'POST',
        `/tickets/${ticketId}/decide`,
        decideBody,
        (b) => `${ticketId} decided, now ${(b as { status: string }).status}`
      );
      return;
    }
    const db = openDb(dbPath(flags));
    try {
      const ticket = decide(db, { ticketId, ...decideBody });
      output(flags, ticket, `${ticket.id} decided, now ${ticket.status}`);
    } catch (err) {
      if (err instanceof DecideError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'retry') {
    const ticketId = String(flags.ticket ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/tickets/${ticketId}/retry`, undefined, (b) =>
        `${ticketId} retried, now ${(b as { status: string }).status}`
      );
      return;
    }
    const db = openDb(dbPath(flags));
    try {
      const ticket = retry(db, { ticketId });
      output(flags, ticket, `${ticket.id} retried, now ${ticket.status}`);
    } catch (err) {
      if (err instanceof RetryError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'approve') {
    const ticketId = String(flags.ticket ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/tickets/${ticketId}/approve`, undefined, (b) =>
        `${ticketId} approved, now ${(b as { status: string }).status}`
      );
      return;
    }
    const db = openDb(dbPath(flags));
    try {
      const ticket = approve(db, { ticketId });
      output(flags, ticket, `${ticket.id} approved, now ${ticket.status}`);
    } catch (err) {
      if (err instanceof ApproveError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'reject') {
    const ticketId = String(flags.ticket ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(
        flags,
        live,
        'POST',
        `/tickets/${ticketId}/reject`,
        { reason: String(flags.reason ?? '') },
        (b) => `${ticketId} rejected, now ${(b as { status: string }).status}`
      );
      return;
    }
    const db = openDb(dbPath(flags));
    try {
      const ticket = reject(db, { ticketId, reason: String(flags.reason ?? '') });
      output(flags, ticket, `${ticket.id} rejected, now ${ticket.status}`);
    } catch (err) {
      if (err instanceof RejectError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'resume') {
    const db = openDb(dbPath(flags));
    let projectId: string;
    try {
      projectId = resolveProjectRef(db, String(flags.project ?? ''));
    } catch (err) {
      if (reportIfNoSuchProject(err)) return;
      throw err;
    }

    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/projects/${projectId}/resume`, undefined, () => `${projectId} resumed`);
      return;
    }
    try {
      const project = resume(db, { projectId });
      output(flags, project, `${project.id} resumed`);
    } catch (err) {
      if (err instanceof ResumeError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'cancel') {
    const ticketId = String(flags.ticket ?? '');
    const live = await liveDaemonFor(flags);
    if (!live) {
      // No direct-write fallback exists for this command: cancelling a live
      // run requires a live worker handle, which only a running daemon
      // holds (see docs/strategy/batch-8-spec.md section 2's "cancel is
      // daemon-only and says so when no daemon is up").
      process.stderr.write(
        'cancel requires a running daemon (magarine serve) -- no live daemon was found for this state directory (matching --db, if given).\n'
      );
      process.exitCode = 1;
      return;
    }
    await routeMutation(flags, live, 'POST', `/tickets/${ticketId}/cancel`, undefined, (b) =>
      `${ticketId} cancelled, now ${(b as { status: string }).status}`
    );
    return;
  }

  process.stderr.write(`${usageText()}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

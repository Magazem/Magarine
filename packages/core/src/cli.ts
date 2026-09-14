#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, type Db } from './db/index.ts';
import { FakeAdapter, type FakeScript } from './adapters/fakeAdapter.ts';
import { ClaudeCliAdapter } from './adapters/claudeCli.ts';
import { checkDaemonFile, type DaemonFileInfo } from './daemon.ts';
import { daemonRequest, probeDaemonHealth } from './daemonClient.ts';
import { resolveExecutable } from './process.ts';
import { recoverOrphanedRuns } from './recovery.ts';
import { runUntilIdle, tick } from './scheduler.ts';
import {
  addDependency,
  createProject,
  createTicket,
  getProject,
  getTicket,
  listTickets,
  setProjectDefaultModel,
  setProjectManagerModel,
  setProjectMaxSpendUsd,
  setTicketBudgetOverride,
} from './store.ts';
import { resolveReadiness } from './dependencies.ts';
import { approve, ApproveError } from './commands/approve.ts';
import { buildActivity, formatActivity } from './commands/activity.ts';
import { buildBoard, formatBoard } from './commands/board.ts';
import { buildInbox, formatInbox } from './commands/inbox.ts';
import { decide, DecideError } from './commands/decide.ts';
import { doctorExitCode, formatDoctor, runDoctor } from './commands/doctor.ts';
import { planMission, PlanError } from './commands/plan.ts';
import { reject, RejectError } from './commands/reject.ts';
import { retry, RetryError } from './commands/retry.ts';
import { resume, ResumeError } from './commands/resume.ts';
import { serve, ServeError } from './commands/serve.ts';
import { artifactsDir as resolveArtifactsDir, dbPath as resolveDbPath, resolveStateDir } from './paths.ts';
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

// Batch 10 (Role O): `plan` has always validated its `--project` against a
// typed PlanError before creating anything (commands/plan.ts); `ticket add`
// never did the equivalent check, so `ticket add --project <nonexistent>`
// fell straight through to `createTicket`'s raw `INSERT`, which fails on the
// `tickets.project_id` foreign key with SQLite's own constraint-violation
// message -- uncaught by any typed-error branch here, so it reached the
// user as a raw database error rather than the same clean "no such project"
// line `plan` already gives. Named after the command, not a generic
// "NotFoundError", to match ApproveError/DecideError/PlanError/etc.'s
// per-command convention in this file.
class TicketAddError extends Error {}

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
  method: 'GET' | 'POST',
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
  'project create': ['name', 'description', 'max-parallel', 'brief', 'workspace-root', 'max-spend', 'model', 'manager-model'],
  'project set': ['project', 'max-spend', 'model', 'manager-model'],
  'ticket add': [
    'project',
    'title',
    'description',
    'max-attempts',
    'priority',
    'workspace',
    'budget',
    'model',
    'acceptance',
    'depends-on',
  ],
  'dep add': ['project', 'ticket', 'depends-on', 'type'],
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
  tick: ['project', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome'],
  run: ['until-idle', 'project', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome'],
  // Batch 8 (Role M): `serve` has no `--project` -- it ticks every project in
  // the state directory's database (see daemon.ts's startDaemonLoop). `--port`
  // defaults to 0 (any free loopback port); `--tick-interval` is in seconds,
  // matching `--run-timeout`'s convention elsewhere in this file.
  serve: ['port', 'tick-interval', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome'],
  // Batch 10 (Role Q): `--paid` opts into one real, billed `claude -p` call
  // (see commands/doctor.ts) -- absent by default, so `doctor` costs nothing
  // unless explicitly asked to spend.
  doctor: ['paid'],
  status: ['project'],
  board: ['project'],
  inbox: ['project'],
  activity: ['project', 'ticket', 'all'],
  // Batch 9: `magarine plan --project <id> --mission "<text>"` creates the
  // manager ticket. No `--title`: deriveManagerTitle (commands/plan.ts)
  // makes one from the mission, the same way a work ticket's title is
  // always given directly rather than derived.
  plan: ['project', 'mission'],
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

function buildAdapter(db: Db, flags: Flags): AgentAdapter {
  const kind = typeof flags.adapter === 'string' ? flags.adapter : 'fake';

  if (kind === 'fake') {
    const adapter = new FakeAdapter();
    for (const spec of flagList(flags, 'fake-script')) {
      const eq = spec.indexOf('=');
      if (eq < 0) {
        throw new Error(`--fake-script must be "<ticketId>=<kind>", got: ${spec}`);
      }
      const ticketId = spec.slice(0, eq);
      const scriptKind = spec.slice(eq + 1);
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
    if (!claudeExe) {
      try {
        claudeExe = resolveExecutable('claude');
      } catch (err) {
        throw new Error(
          `--claude-exe was not given and resolveExecutable('claude') failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    const projectRow = db
      .prepare('SELECT max_budget_usd FROM projects WHERE id = ?')
      .get(String(flags.project ?? '')) as { max_budget_usd: number } | undefined;
    // `workspaceType`/`workspaceRoot` here are ClaudeCliAdapterOptions'
    // required construction-time fallback, never actually used: scheduler.ts
    // now prepares a workspace per ticket and passes it into every
    // `startWorker` call, which the adapter always prefers over its own
    // constructor default (see claudeCli.ts's `startWorker`). 'NONE' with no
    // root is simply the least surprising placeholder for a value nothing
    // reads.
    return new ClaudeCliAdapter({
      claudeExe,
      maxBudgetUsd: projectRow?.max_budget_usd ?? 2.0,
      workspaceType: 'NONE',
    });
  }

  throw new Error(`Unknown adapter: ${kind}`);
}

function checkKnownFlags(key: string, flags: Flags): string | null {
  const known = FLAG_SPECS[key];
  if (!known) return null;
  const unknown = Object.keys(flags).filter((k) => !COMMON_FLAGS.includes(k) && !known.includes(k));
  if (unknown.length === 0) return null;
  return `Unknown flag(s) for '${key}': ${unknown.map((k) => `--${k}`).join(', ')}. Valid flags: ${known
    .map((k) => `--${k}`)
    .join(', ')} (plus --db, --json).`;
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

  const flagError = checkKnownFlags(flagSpecKey, flags);
  if (flagError) {
    process.stderr.write(flagError + '\n');
    process.exitCode = 1;
    return;
  }

  if (command === 'project' && subcommand === 'create') {
    const db = openDb(dbPath(flags));
    const project = createProject(db, {
      name: String(flags.name ?? positionals[1] ?? ''),
      description: typeof flags.description === 'string' ? flags.description : null,
      maxParallelWorkers: flags['max-parallel'] ? Number(flags['max-parallel']) : 1,
      maxSpendUsd: typeof flags['max-spend'] === 'string' ? Number(flags['max-spend']) : null,
      defaultModel: typeof flags.model === 'string' ? flags.model : undefined,
      brief: typeof flags.brief === 'string' ? flags.brief : null,
      workspaceRoot: typeof flags['workspace-root'] === 'string' ? flags['workspace-root'] : null,
      managerModel: typeof flags['manager-model'] === 'string' ? flags['manager-model'] : null,
    });
    output(flags, project, `Created project ${project.id} (${project.name})`);
    return;
  }

  if (command === 'project' && subcommand === 'set') {
    const projectId = String(flags.project ?? positionals[1] ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      const body: { maxSpend?: number; model?: string; managerModel?: string } = {};
      if (typeof flags['max-spend'] === 'string') body.maxSpend = Number(flags['max-spend']);
      if (typeof flags.model === 'string') body.model = flags.model;
      if (typeof flags['manager-model'] === 'string') body.managerModel = flags['manager-model'];
      await routeMutation(flags, live, 'POST', `/projects/${projectId}/set`, body, () => `Updated project ${projectId}`);
      return;
    }

    const db = openDb(dbPath(flags));
    const project = getProject(db, projectId);
    if (!project) {
      process.stderr.write(`No such project: ${projectId}\n`);
      process.exitCode = 1;
      return;
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
    output(flags, getProject(db, projectId), `Updated project ${projectId}`);
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

  if (command === 'plan') {
    const projectId = String(flags.project ?? '');
    const mission = String(flags.mission ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/projects/${projectId}/plan`, { mission }, (b) => {
        const t = b as { id: string; title: string };
        return `Created manager ticket ${t.id} (${t.title})`;
      });
      return;
    }

    const db = openDb(dbPath(flags));
    try {
      const ticket = planMission(db, { projectId, mission });
      output(flags, ticket, `Created manager ticket ${ticket.id} (${ticket.title})`);
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

  if (command === 'ticket' && subcommand === 'add') {
    const dependsOn = flagList(flags, 'depends-on');
    const live = await liveDaemonFor(flags);
    if (live) {
      const body = {
        project: String(flags.project ?? ''),
        title: String(flags.title ?? positionals[1] ?? ''),
        description: typeof flags.description === 'string' ? flags.description : null,
        maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : undefined,
        priority: flags.priority ? Number(flags.priority) : undefined,
        workspaceType: typeof flags.workspace === 'string' ? flags.workspace : undefined,
        acceptanceCriteria: flagList(flags, 'acceptance'),
        model: typeof flags.model === 'string' ? flags.model : null,
        budget: typeof flags.budget === 'string' ? Number(flags.budget) : undefined,
        dependsOn,
      };
      await routeMutation(flags, live, 'POST', '/tickets', body, (b) => {
        const t = b as { id: string; title: string };
        return `Created ticket ${t.id} (${t.title})`;
      });
      return;
    }

    const db = openDb(dbPath(flags));
    const projectId = String(flags.project ?? '');
    try {
      const project = getProject(db, projectId);
      if (!project) {
        throw new TicketAddError(`no such project: ${projectId}`);
      }

      const ticket = createTicket(db, {
        projectId,
        title: String(flags.title ?? positionals[1] ?? ''),
        description: typeof flags.description === 'string' ? flags.description : null,
        maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : 3,
        priority: flags.priority ? Number(flags.priority) : 0,
        workspaceType: (typeof flags.workspace === 'string' ? flags.workspace : 'NONE') as WorkspaceType,
        acceptanceCriteria: flagList(flags, 'acceptance'),
        model: typeof flags.model === 'string' ? flags.model : null,
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
    } catch (err) {
      if (err instanceof TicketAddError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'dep' && subcommand === 'add') {
    const ticketId = String(flags.ticket ?? '');
    const dependsOnTicketId = String(flags['depends-on'] ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(
        flags,
        live,
        'POST',
        '/deps',
        { project: String(flags.project ?? ''), ticket: ticketId, dependsOn: dependsOnTicketId },
        () => `Added dependency: ${ticketId} depends on ${dependsOnTicketId}`
      );
      return;
    }

    const db = openDb(dbPath(flags));
    addDependency(db, { ticketId, dependsOnTicketId });
    resolveReadiness(db, String(flags.project ?? ''));
    output(flags, { ticketId, dependsOnTicketId }, `Added dependency: ${ticketId} depends on ${dependsOnTicketId}`);
    return;
  }

  if (command === 'tick') {
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
      await routeMutation(flags, live, 'POST', '/tick', { project: String(flags.project ?? '') }, (b) => {
        const r = b as { started: Array<{ ticketId: string }> };
        return `Started ${r.started.length} run(s).`;
      });
      return;
    }

    const db = openDb(dbPath(flags));
    recoverOrphanedRuns(db);
    const adapter = buildAdapter(db, flags);
    const result = await tick({
      db,
      adapter,
      projectId: String(flags.project ?? ''),
      maxParallelWorkers: flags['max-parallel'] ? Number(flags['max-parallel']) : 1,
      runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
      artifactsDir: artifactsDir(flags),
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
    recoverOrphanedRuns(db);
    const adapter = buildAdapter(db, flags);
    await runUntilIdle({
      db,
      adapter,
      projectId: String(flags.project ?? ''),
      maxParallelWorkers: flags['max-parallel'] ? Number(flags['max-parallel']) : 1,
      runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
      artifactsDir: artifactsDir(flags),
    });
    output(flags, { idle: true }, 'Idle: no more runnable tickets.');
    return;
  }

  if (command === 'serve') {
    const resolvedDbPath = dbPath(flags);
    const db = openDb(resolvedDbPath);
    const adapter = buildAdapter(db, flags);
    const resolvedStateDir = stateDir(flags);
    try {
      await serve({
        db,
        dbPath: resolvedDbPath,
        stateDir: resolvedStateDir,
        adapter,
        maxParallelWorkers: flags['max-parallel'] ? Number(flags['max-parallel']) : 1,
        runTimeoutMs: typeof flags['run-timeout'] === 'string' ? Number(flags['run-timeout']) * 1000 : undefined,
        artifactsDir: artifactsDir(flags),
        tickIntervalMs: typeof flags['tick-interval'] === 'string' ? Number(flags['tick-interval']) * 1000 : undefined,
        port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
        // Never includes the token: only the CLI-facing shape a human or a
        // script watching stdout needs to find the daemon, not what it needs
        // to authenticate against it.
        onListening: (info) => {
          output(flags, info, `magarine daemon listening on 127.0.0.1:${info.port} (pid ${info.pid})`);
        },
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

  if (command === 'status') {
    const db = openDb(dbPath(flags));
    const tickets = listTickets(db, String(flags.project ?? ''));
    output(
      flags,
      tickets,
      tickets.map((t) => `${t.id}\t${t.status}\t${t.title}`).join('\n')
    );
    return;
  }

  if (command === 'board') {
    const db = openDb(dbPath(flags));
    const result = buildBoard(db, String(flags.project ?? ''));
    output(flags, result, formatBoard(result));
    return;
  }

  if (command === 'inbox') {
    const db = openDb(dbPath(flags));
    const items = buildInbox(db, String(flags.project ?? ''));
    output(flags, items, formatInbox(items));
    return;
  }

  if (command === 'activity') {
    const db = openDb(dbPath(flags));
    const events = buildActivity(db, {
      projectId: typeof flags.project === 'string' ? flags.project : undefined,
      ticketId: typeof flags.ticket === 'string' ? flags.ticket : undefined,
      all: Boolean(flags.all),
    });
    output(flags, events, formatActivity(events));
    return;
  }

  if (command === 'decide') {
    const ticketId = String(flags.ticket ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(
        flags,
        live,
        'POST',
        `/tickets/${ticketId}/decide`,
        { answer: String(flags.answer ?? '') },
        (b) => `${ticketId} decided, now ${(b as { status: string }).status}`
      );
      return;
    }
    const db = openDb(dbPath(flags));
    try {
      const ticket = decide(db, { ticketId, answer: String(flags.answer ?? '') });
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
    const projectId = String(flags.project ?? '');
    const live = await liveDaemonFor(flags);
    if (live) {
      await routeMutation(flags, live, 'POST', `/projects/${projectId}/resume`, undefined, () => `${projectId} resumed`);
      return;
    }
    const db = openDb(dbPath(flags));
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

  process.stderr.write(
    'Usage: magarine <doctor|project create|project set|ticket add|dep add|plan|tick|run --until-idle|serve|cancel|status|board|inbox|activity|decide|retry|approve|reject|resume> [--flags] [--json]\n'
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

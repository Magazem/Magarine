#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, type Db } from './db/index.ts';
import { FakeAdapter, type FakeScript } from './adapters/fakeAdapter.ts';
import { ClaudeCliAdapter } from './adapters/claudeCli.ts';
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
  setProjectMaxSpendUsd,
  setTicketBudgetOverride,
} from './store.ts';
import { resolveReadiness } from './dependencies.ts';
import { approve, ApproveError } from './commands/approve.ts';
import { buildActivity, formatActivity } from './commands/activity.ts';
import { buildBoard, formatBoard } from './commands/board.ts';
import { buildInbox, formatInbox } from './commands/inbox.ts';
import { decide, DecideError } from './commands/decide.ts';
import { reject, RejectError } from './commands/reject.ts';
import { retry, RetryError } from './commands/retry.ts';
import { resume, ResumeError } from './commands/resume.ts';
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
  'project create': ['name', 'description', 'max-parallel', 'brief', 'workspace-root', 'max-spend', 'model'],
  'project set': ['project', 'max-spend', 'model'],
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
  // narrower and friendlier than `--fake-script` for the five outcomes the
  // daemon's own vocabulary distinguishes (done/review/needs_user_decision/
  // retryable/final -- see FakeAdapter's `review`/`final` kinds, new this
  // batch). Layered on top of `--fake-script`, not a replacement: existing
  // scripts (`succeed`, `question`, `malformed_result`, `hang`) still only
  // have a `--fake-script` spelling.
  tick: ['project', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome'],
  run: ['until-idle', 'project', 'max-parallel', 'adapter', 'claude-exe', 'run-timeout', 'fake-script', 'fake-outcome'],
  status: ['project'],
  board: ['project'],
  inbox: ['project'],
  activity: ['project', 'ticket', 'all'],
  decide: ['ticket', 'answer'],
  retry: ['ticket'],
  approve: ['ticket'],
  reject: ['ticket', 'reason'],
  resume: ['project'],
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
    });
    output(flags, project, `Created project ${project.id} (${project.name})`);
    return;
  }

  if (command === 'project' && subcommand === 'set') {
    const db = openDb(dbPath(flags));
    const projectId = String(flags.project ?? positionals[1] ?? '');
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
    output(flags, getProject(db, projectId), `Updated project ${projectId}`);
    return;
  }

  if (command === 'ticket' && subcommand === 'add') {
    const db = openDb(dbPath(flags));
    const dependsOn = flagList(flags, 'depends-on');
    const ticket = createTicket(db, {
      projectId: String(flags.project ?? ''),
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
    return;
  }

  if (command === 'dep' && subcommand === 'add') {
    const db = openDb(dbPath(flags));
    const ticketId = String(flags.ticket ?? '');
    const dependsOnTicketId = String(flags['depends-on'] ?? '');
    addDependency(db, { ticketId, dependsOnTicketId });
    resolveReadiness(db, String(flags.project ?? ''));
    output(flags, { ticketId, dependsOnTicketId }, `Added dependency: ${ticketId} depends on ${dependsOnTicketId}`);
    return;
  }

  if (command === 'tick') {
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
    const db = openDb(dbPath(flags));
    try {
      const ticket = decide(db, { ticketId: String(flags.ticket ?? ''), answer: String(flags.answer ?? '') });
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
    const db = openDb(dbPath(flags));
    try {
      const ticket = retry(db, { ticketId: String(flags.ticket ?? '') });
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
    const db = openDb(dbPath(flags));
    try {
      const ticket = approve(db, { ticketId: String(flags.ticket ?? '') });
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
    const db = openDb(dbPath(flags));
    try {
      const ticket = reject(db, { ticketId: String(flags.ticket ?? ''), reason: String(flags.reason ?? '') });
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
    try {
      const project = resume(db, { projectId: String(flags.project ?? '') });
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

  process.stderr.write(
    'Usage: magarine <project create|project set|ticket add|dep add|tick|run --until-idle|status|board|inbox|activity|decide|retry|approve|reject|resume> [--flags] [--json]\n'
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

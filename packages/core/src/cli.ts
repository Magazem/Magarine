#!/usr/bin/env node
import { join } from 'node:path';
import { openDb, type Db } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { ClaudeCliAdapter } from './adapters/claudeCli.ts';
import { resolveExecutable } from './process.ts';
import { recoverOrphanedRuns } from './recovery.ts';
import { runUntilIdle, tick } from './scheduler.ts';
import { addDependency, createProject, createTicket, listTickets } from './store.ts';
import { resolveReadiness } from './dependencies.ts';
import type { AgentAdapter, WorkspaceType } from './types.ts';

// Thin CLI over the core library. Every subcommand opens the sqlite file at
// `--db` (default: `.magarine/magarine.db` under the current directory,
// built with node:path so it works unchanged on Windows and Linux), does
// one thing, and prints either a human line or JSON with `--json`.

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function dbPath(flags: Flags): string {
  return typeof flags.db === 'string' ? flags.db : join(process.cwd(), '.magarine', 'magarine.db');
}

const COMMON_FLAGS = ['db', 'json'];

// Every flag each subcommand accepts, beyond `--db`/`--json`. An unknown
// flag is silently dropped by `parseFlags` (it just never lands in `flags`)
// which used to surface as a confusing downstream error, e.g. a foreign-key
// violation from an empty `dependsOnTicketId` when someone typed
// `--blocked-by` instead of `--depends-on`. Checked up front so a typo is
// reported as a typo.
const FLAG_SPECS: Record<string, string[]> = {
  'project create': ['name', 'description', 'max-parallel'],
  'ticket add': ['project', 'title', 'description', 'max-attempts', 'priority', 'workspace'],
  'dep add': ['project', 'ticket', 'depends-on', 'type'],
  tick: ['project', 'max-parallel', 'adapter', 'claude-exe', 'workspace-root'],
  run: ['until-idle', 'project', 'max-parallel', 'adapter', 'claude-exe', 'workspace-root'],
  status: ['project'],
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
function buildAdapter(db: Db, flags: Flags): AgentAdapter {
  const kind = typeof flags.adapter === 'string' ? flags.adapter : 'fake';

  if (kind === 'fake') {
    return new FakeAdapter();
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
    const workspaceRoot = typeof flags['workspace-root'] === 'string' ? flags['workspace-root'] : undefined;
    return new ClaudeCliAdapter({
      claudeExe,
      maxBudgetUsd: projectRow?.max_budget_usd ?? 2.0,
      workspaceType: workspaceRoot ? 'DIRECTORY' : 'NONE',
      workspaceRoot,
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
    });
    output(flags, project, `Created project ${project.id} (${project.name})`);
    return;
  }

  if (command === 'ticket' && subcommand === 'add') {
    const db = openDb(dbPath(flags));
    const ticket = createTicket(db, {
      projectId: String(flags.project ?? ''),
      title: String(flags.title ?? positionals[1] ?? ''),
      description: typeof flags.description === 'string' ? flags.description : null,
      maxAttempts: flags['max-attempts'] ? Number(flags['max-attempts']) : 3,
      priority: flags.priority ? Number(flags.priority) : 0,
      workspaceType: (typeof flags.workspace === 'string' ? flags.workspace : 'NONE') as WorkspaceType,
    });
    // Deliberately not resolving readiness here: a freshly created ticket
    // has no dependencies "so far", but the user may still be about to
    // attach one with `dep add`. Promoting it now would be premature — see
    // dependencies.ts's `resolveReadiness` doc comment and
    // cli.test.ts's dependency-ordering regression test. Readiness is
    // reconciled by `dep add` and by every `tick`/`run --until-idle`.
    output(flags, ticket, `Created ticket ${ticket.id} (${ticket.title})`);
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

  process.stderr.write(
    'Usage: magarine <project create|ticket add|dep add|tick|run --until-idle|status> [--flags] [--json]\n'
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

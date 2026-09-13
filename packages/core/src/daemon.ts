import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db/index.ts';
import { recoverOrphanedRuns } from './recovery.ts';
import { cancelRun, tick, type StartedRun } from './scheduler.ts';
import { listProjects } from './store.ts';
import type { AgentAdapter } from './types.ts';

// `<state>/daemon.json` lifecycle: the file that lets a second process find
// a running daemon, per docs/strategy/batch-8-spec.md section 2's "Shape".
// Batch 8 Role M owns this file and everything in it; step 3 (the HTTP API)
// layers token auth on top of the same shape rather than changing it.

export interface DaemonFileInfo {
  pid: number;
  port: number;
  /** Fresh on every start, never persisted anywhere else. A token that outlives its daemon is a token something else can use -- see removeDaemonFile. */
  token: string;
  startedAt: string;
  /** The exact database path this daemon opened, not just the state directory -- a caller deciding whether to route a `--db`-scoped mutation through this daemon must compare against this field, not assume "a state dir has a daemon.json" implies "this db file is served by it" (they can differ: `--db` is a separate override from `--state-dir`/`MAGARINE_HOME`). */
  dbPath: string;
}

export function daemonFilePath(stateDir: string): string {
  return join(stateDir, 'daemon.json');
}

export function generateDaemonToken(): string {
  return randomBytes(32).toString('hex');
}

// Mode 0o600: the token inside is a bearer credential for an API that can
// start AI workers. No other local user account should be able to read it
// off disk any more than they could read an SSH private key.
export function writeDaemonFile(stateDir: string, info: DaemonFileInfo): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(daemonFilePath(stateDir), JSON.stringify(info, null, 2), { mode: 0o600 });
}

function isDaemonFileInfo(value: unknown): value is DaemonFileInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.port === 'number' &&
    typeof v.token === 'string' &&
    typeof v.startedAt === 'string' &&
    typeof v.dbPath === 'string'
  );
}

// Absent, unreadable, or malformed all come back as `undefined` -- a
// half-written or corrupted file is never trusted partially, and is treated
// exactly like "no daemon.json at all" by every caller (checkDaemonFile
// below overwrites it the same way it would an absent file).
export function readDaemonFile(stateDir: string): DaemonFileInfo | undefined {
  let raw: string;
  try {
    raw = readFileSync(daemonFilePath(stateDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return isDaemonFileInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function removeDaemonFile(stateDir: string): void {
  rmSync(daemonFilePath(stateDir), { force: true });
}

// Signal 0 is a pure existence probe -- no signal is actually delivered.
// ESRCH means the pid is gone (HARD-verified on this Windows machine: a
// made-up pid throws ESRCH, the current process's own pid succeeds).
// EPERM means the pid exists but is owned by another account; that is still
// "alive" for staleness purposes -- only ESRCH means "safe to overwrite".
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export type DaemonFileStatus = 'absent' | 'live' | 'stale';

export interface DaemonFileCheck {
  status: DaemonFileStatus;
  info?: DaemonFileInfo;
}

// Detects whether an existing daemon.json describes a still-live daemon, per
// the spec's "A stale file from a crash is detected by the process id being
// dead or `/health` not answering, and is overwritten": two independent
// signals, either one enough to call it stale.
//
// `healthCheck` is optional and deliberately not wired to anything real yet.
// This is step 2 of six (docs/strategy/batch-8-spec.md's Role M delivery
// order): no HTTP listener exists to answer `/health` until step 3 lands.
// Every step-2 caller (serve.ts) omits it, so staleness is decided on the
// pid-liveness signal alone for now -- which is also the only scenario this
// batch's own acceptance test names ("a stale daemon.json with a dead
// process id is overwritten on start"). Step 3 wires the second signal in by
// passing a real health-check function; nothing about this function's shape
// needs to change to add it.
export async function checkDaemonFile(
  stateDir: string,
  healthCheck?: (info: DaemonFileInfo) => Promise<boolean>
): Promise<DaemonFileCheck> {
  const info = readDaemonFile(stateDir);
  if (!info) return { status: 'absent' };
  if (!isPidAlive(info.pid)) return { status: 'stale', info };
  if (healthCheck && !(await healthCheck(info))) return { status: 'stale', info };
  return { status: 'live', info };
}

export interface DaemonLoopDeps {
  db: Db;
  adapter: AgentAdapter;
  /** Concurrency cap, applied independently inside tick() for EACH project -- N projects each get up to this many concurrent workers, not a single global cap across all of them. Matches the CLI's `tick`/`run --until-idle`, which have never had a cross-project cap either. */
  maxParallelWorkers: number;
  runTimeoutMs?: number;
  artifactsDir: string;
  tickIntervalMs: number;
}

export interface DaemonLoop {
  /** Every run the daemon currently believes is in flight, keyed by run id. Exposed so a cancel handler (step 3's API) can look up a ticket's live run without a second bookkeeping structure -- iterate values() and match on ticketId. */
  live: Map<string, StartedRun>;
  /** Stops the tick interval, then cancels every live run: adapter.stop() plus forcing the run/ticket back to a settled DB state (run_cancelled, no attempt consumed) -- never waits on a hung run's own `done` promise, which may never resolve on its own. Safe to call more than once. */
  stop(): Promise<void>;
}

// Runs restart recovery once (any run still 'running' in the DB is by
// definition orphaned -- this process just started and holds no live
// handles), then ticks every project on a fixed interval until stop() is
// called. Shaped like scheduler.ts's runUntilIdle (holds every worker
// handle, forces DB state on shutdown rather than waiting on a hung run's
// promise) but on a timer instead of "loop until nothing starts": a daemon
// has no natural idle exit, since a ticket can arrive from another process
// at any moment.
export function startDaemonLoop(deps: DaemonLoopDeps): DaemonLoop {
  recoverOrphanedRuns(deps.db);

  const live = new Map<string, StartedRun>();
  let stopped = false;
  let ticking = false;

  // Guards against overlapping passes: tick() itself awaits adapter calls,
  // so a slow pass and the next interval firing could otherwise both be
  // live at once and race each other's reads of the same READY tickets.
  const runOneTick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      for (const project of listProjects(deps.db)) {
        if (stopped) break;
        const { started } = await tick({
          db: deps.db,
          adapter: deps.adapter,
          projectId: project.id,
          maxParallelWorkers: deps.maxParallelWorkers,
          runTimeoutMs: deps.runTimeoutMs,
          artifactsDir: deps.artifactsDir,
        });
        for (const s of started) {
          live.set(s.runId, s);
          void s.done.then(() => live.delete(s.runId));
        }
      }
    } catch (err) {
      // The daemon must survive its own scheduling pass the same way
      // scheduler.ts's own guards keep a single run's throw from taking
      // down the others (see README's "A worker that keeps talking after
      // being stopped"). tick() does not normally throw -- run-level
      // failures are already caught inside it -- so reaching here means
      // something unanticipated (e.g. a DB-level error); logged, not
      // swallowed silently, and the next interval tick tries again.
      process.stderr.write(`daemon tick failed: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      ticking = false;
    }
  };

  void runOneTick();
  const timer = setInterval(() => void runOneTick(), deps.tickIntervalMs);

  return {
    live,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const sr of live.values()) {
        await cancelRun({ db: deps.db, adapter: deps.adapter }, sr, 'daemon_shutdown');
      }
      live.clear();
    },
  };
}

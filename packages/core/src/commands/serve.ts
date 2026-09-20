import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '../db/index.ts';
import { checkDaemonFile, detectShutdownMode, removeDaemonFile, startDaemonLoop, writeDaemonFile, generateDaemonToken } from '../daemon.ts';
import { createRequestHandler } from '../daemonApi.ts';
import { probeDaemonHealth } from '../daemonClient.ts';
import { probeScopeFile } from '../scopeProbe.ts';
import type { AgentAdapter } from '../types.ts';

// `serve`: runs the daemon until stopped (SIGINT/SIGTERM), per
// docs/strategy/batch-8-spec.md section 2's "Shape". Step 3 of six: the real
// token-checked JSON API (daemonApi.ts) now sits behind the same
// listener/lifecycle this file has held since step 2 -- the bind, the
// daemon.json write, and the shutdown sequence are unchanged. The staleness
// check below also gets its real second signal now: `probeDaemonHealth`
// actually calls `/health`, closing the gap step 2 left open (no route
// existed to check yet).

export class ServeError extends Error {}

export interface ServeOptions {
  db: Db;
  /** The exact path `db` was opened from -- recorded in daemon.json verbatim (see DaemonFileInfo.dbPath) so a future reader can tell whether this daemon actually serves a particular `--db`-scoped file, not just whether its state directory has a daemon.json. */
  dbPath: string;
  stateDir: string;
  adapter: AgentAdapter;
  maxParallelWorkers: number;
  runTimeoutMs?: number;
  artifactsDir: string;
  tickIntervalMs?: number;
  /** 0 (default) asks the OS for any free loopback port. */
  port?: number;
  /** Called once the daemon is listening and daemon.json is written. Never receives the token's own value logged anywhere by a caller of this function -- see the module header comment on step 3's auth work for why that matters. */
  onListening?: (info: { pid: number; port: number; stateDir: string }) => void;
  /** Called once, after the daemon has fully stopped, ONLY when the shutdown cancelled running work (never for a quiet shutdown with nothing in flight). `cancelled` is the ticket ids -- see `formatShutdown` for what the owner is told. */
  onStopped?: (info: { cancelled: string[] }) => void;
  /** Called first thing when shutdown begins, before anything is closed -- so a host that holds its own `/events` consumer (the `app` notifier) can let go of it before the server waits for its connections. */
  onShuttingDown?: () => void;
}

// Batch 17 item (docs/strategy/batch-17-item-shutdown-reports-cancelled-work.md):
// what a shutdown that cancelled work tells the owner. `run_cancelled` returns
// those tickets to READY with no attempt consumed, so the next `serve` restarts
// them FROM SCRATCH and the spend so far is paid again -- the line says so
// rather than leaving "stopped cleanly" to suggest the opposite. Ids are named
// while they fit one line; past a handful, or when they would not fit, it is
// the count and a pointer to the board. `json` always carries every id.
const SHUTDOWN_MAX_LISTED_IDS = 4;
const SHUTDOWN_MAX_LINE = 200;
export function formatShutdown(cancelled: string[]): { human: string; json: { stopped: true; cancelled: string[] } } {
  const n = cancelled.length;
  const what = n === 1 ? '1 running task was cancelled' : `${n} running tasks were cancelled`;
  const tail = ' -- they are READY again and will restart from scratch on the next serve';
  const withIds = `stopped; ${what} (${cancelled.join(', ')})${tail}`;
  const human = n <= SHUTDOWN_MAX_LISTED_IDS && withIds.length <= SHUTDOWN_MAX_LINE ? withIds : `stopped; ${what} (see \`magarine board\`)${tail}`;
  return { human, json: { stopped: true, cancelled } };
}

const DEFAULT_TICK_INTERVAL_MS = 2000;

export async function serve(opts: ServeOptions): Promise<void> {
  const staleCheck = await checkDaemonFile(opts.stateDir, probeDaemonHealth);
  if (staleCheck.status === 'live') {
    throw new ServeError(
      `a daemon is already running for this state directory (pid ${staleCheck.info!.pid}, port ${staleCheck.info!.port}) -- stop it first`
    );
  }
  // 'stale' (a dead pid, or a live pid whose /health does not answer for
  // it) or 'absent': nothing live to protect either way. The stale file, if
  // any, is simply overwritten by writeDaemonFile below.

  const loop = startDaemonLoop({
    db: opts.db,
    adapter: opts.adapter,
    maxParallelWorkers: opts.maxParallelWorkers,
    runTimeoutMs: opts.runTimeoutMs,
    artifactsDir: opts.artifactsDir,
    readiness: { stateDir: opts.stateDir, scopeProbe: probeScopeFile },
    tickIntervalMs: opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  });

  const pid = process.pid;
  const startedAt = new Date().toISOString();
  const token = generateDaemonToken();

  const requestHandler = createRequestHandler({ db: opts.db, adapter: opts.adapter, loop, token, pid, startedAt, machineCap: opts.maxParallelWorkers, stateDir: opts.stateDir });
  const server: Server = createServer(requestHandler.handle);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await loop.stop();
    throw new ServeError(`failed to bind a loopback port: ${err instanceof Error ? err.message : String(err)}`);
  }

  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === 'string') {
    await loop.stop();
    server.close();
    throw new ServeError('failed to bind a loopback TCP port');
  }

  writeDaemonFile(opts.stateDir, {
    pid,
    port: address.port,
    token,
    startedAt,
    dbPath: opts.dbPath,
    shutdownMode: detectShutdownMode(),
  });

  opts.onListening?.({ pid, port: address.port, stateDir: opts.stateDir });

  let shuttingDown = false;
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    resolveShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await shutdown;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    opts.onShuttingDown?.();
    // Order matters: stop every live worker and force its run/ticket to a
    // settled state BEFORE closing the listener or removing daemon.json, so
    // a client racing the shutdown never observes a daemon.json that still
    // names a port nothing is listening on, or a live-looking ticket that
    // is actually about to be cancelled out from under it. `closeAllStreams`
    // ends every open `GET /events` response first -- `server.close()`'s
    // own callback below waits for every connection to end on its own, and
    // an SSE stream nothing ever called `res.end()` on would hang it
    // forever (batch 15 ruling 7 item 2: "close cleanly when the daemon
    // stops" -- a client sees a normal end of stream, not a hang or a raw
    // socket abort).
    requestHandler.closeAllStreams();
    const { cancelled } = await loop.stop();
    // Again, AFTER the loop has stopped: a client that opened `/events` while
    // the runs were being cancelled registered after the first call above, and
    // `server.close()` waits for every open connection -- a stream nobody ended
    // would hang the shutdown forever.
    requestHandler.closeAllStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeDaemonFile(opts.stateDir);
    // After everything is down, and only when work was actually cancelled:
    // a quiet shutdown stays quiet.
    if (cancelled.length > 0) opts.onStopped?.({ cancelled });
  }
}

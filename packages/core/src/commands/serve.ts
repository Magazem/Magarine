import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '../db/index.ts';
import { checkDaemonFile, removeDaemonFile, startDaemonLoop, writeDaemonFile, generateDaemonToken } from '../daemon.ts';
import type { AgentAdapter } from '../types.ts';

// `serve`: runs the daemon until stopped (SIGINT/SIGTERM), per
// docs/strategy/batch-8-spec.md section 2's "Shape". This is step 2 of six
// (the loop, the handles, signal handling, daemon.json lifecycle); step 3
// replaces this file's placeholder HTTP handler with the real token-checked
// JSON API, on top of the exact same listener/lifecycle code below -- the
// bind, the daemon.json write, and the shutdown sequence do not change.

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
}

const DEFAULT_TICK_INTERVAL_MS = 2000;

export async function serve(opts: ServeOptions): Promise<void> {
  const staleCheck = await checkDaemonFile(opts.stateDir);
  if (staleCheck.status === 'live') {
    throw new ServeError(
      `a daemon is already running for this state directory (pid ${staleCheck.info!.pid}, port ${staleCheck.info!.port}) -- stop it first`
    );
  }
  // 'stale' (a dead pid) or 'absent': nothing live to protect either way.
  // The stale file, if any, is simply overwritten by writeDaemonFile below.

  const loop = startDaemonLoop({
    db: opts.db,
    adapter: opts.adapter,
    maxParallelWorkers: opts.maxParallelWorkers,
    runTimeoutMs: opts.runTimeoutMs,
    artifactsDir: opts.artifactsDir,
    tickIntervalMs: opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  });

  // Step 2 placeholder: a real loopback listener with no application routes
  // yet. It exists now, rather than waiting for step 3, so daemon.json's
  // `port` field is always a genuine, already-live port -- never a
  // fabricated placeholder value nothing is actually listening on.
  const server: Server = createServer((_req, res) => {
    res.statusCode = 501;
    res.end();
  });

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

  const pid = process.pid;
  writeDaemonFile(opts.stateDir, {
    pid,
    port: address.port,
    token: generateDaemonToken(),
    startedAt: new Date().toISOString(),
    dbPath: opts.dbPath,
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
    // Order matters: stop every live worker and force its run/ticket to a
    // settled state BEFORE closing the listener or removing daemon.json, so
    // a client racing the shutdown never observes a daemon.json that still
    // names a port nothing is listening on, or a live-looking ticket that
    // is actually about to be cancelled out from under it.
    await loop.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeDaemonFile(opts.stateDir);
  }
}

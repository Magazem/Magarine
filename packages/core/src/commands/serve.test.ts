import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from '../process.ts';
import { daemonFilePath, type DaemonFileInfo } from '../daemon.ts';
import { deriveTestCliCwd, testTempRoot } from '../testSupport.ts';

// Cross-process coverage for `magarine serve` itself -- everything here
// spawns the real CLI as a genuinely separate OS process, per this batch's
// testing rule: a daemon is exactly the kind of thing that can look correct
// against an in-process stand-in and be wrong at the join to a real second
// process. daemon.test.ts covers the pure scheduling-loop primitive
// (startDaemonLoop) in-process, the same way scheduler.ts's own tick()/
// runUntilIdle() are tested directly; this file covers what only exists once
// `serve` is a real process: the listener, daemon.json on real disk, and
// what a second, independent process sees.
//
// NOT covered here: graceful shutdown via an externally-delivered SIGINT/
// SIGTERM. Verified empirically on this Windows machine, three ways, that
// there is no way to deliver a catchable signal to a separate child process
// without a native helper (out of scope: this package has zero runtime
// dependencies and no native modules):
//   1. `taskkill /PID <pid> /T` (no /F) against a plain console Node
//      process errors immediately: "This process can only be terminated
//      forcefully (with /F option)" -- it never reaches the process at all.
//   2. `child.kill('SIGINT')` / `child.kill('SIGTERM')` from a separate
//      Node process unconditionally hard-terminates the child on Windows
//      (Node's own documented behaviour) -- the child's own SIGINT/SIGTERM
//      handler never runs; `child.on('close')` reports the nominal signal,
//      but the child's handler-only side effect (a console.log this
//      experiment added) never printed.
//   3. The same, tried again with `detached: true` (a new Windows process
//      group) and `SIGBREAK` (the one additional signal Node documents as
//      real on Windows): still an unconditional hard-terminate.
// The only genuine, catchable delivery path on Windows is a real Ctrl+C/
// Ctrl+Break keystroke in the daemon's own attached console, which is real
// production usage (an operator running `magarine serve` in a foreground
// terminal) but not something a spawned child in a test harness can trigger
// on itself from the outside. serve.ts's shutdown logic (loop.stop(), close
// the listener, remove daemon.json) is the same DaemonLoop.stop() already
// exercised in-process in daemon.test.ts; what this file proves instead is
// the platform-realistic failure mode -- a daemon that is killed outright,
// leaving daemon.json behind with a dead pid -- and that recovery on the
// next `serve` start puts things right, which is the actual safety property
// batch-8-spec.md's step 5 cares about most ("the one that tells us whether
// this thing is safe to leave running").

const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));
const testRoot = testTempRoot('serve');
after(testRoot.cleanup);

interface ListeningInfo {
  pid: number;
  port: number;
  stateDir: string;
}

interface ServeHandle {
  proc: ManagedProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the parsed onListening JSON line, or rejects on timeout/early exit. */
  waitForListening(): Promise<ListeningInfo>;
  /** Resolves once the process has exited (however it exited). */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Hard-kills the process (the only reliable cross-process stop on this platform -- see file header) and waits for exit. */
  kill(): Promise<void>;
}

function spawnServe(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): ServeHandle {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, 'serve', ...args], env: opts.env });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));

  return {
    proc,
    stdout: () => stdout,
    stderr: () => stderr,
    async waitForListening() {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) {
          try {
            return JSON.parse(line) as ListeningInfo;
          } catch {
            // Partial line still buffering; keep waiting.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`serve never printed a listening line within 10s. stdout=${stdout} stderr=${stderr}`);
    },
    waitForExit: () => proc.wait().then((r) => ({ code: r.code, signal: r.signal })),
    async kill() {
      await proc.stop(200);
      await proc.wait();
    },
  };
}

async function canConnect(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function firstNonInternalIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

test('serve writes a real daemon.json (matching pid/port/dbPath), binds a working loopback listener, and never prints the token', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'basic-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    assert.equal(info.pid, handle.proc.pid);
    assert.equal(info.stateDir, stateDir);
    assert.ok(info.port > 0);

    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
    assert.equal(fileInfo.pid, info.pid);
    assert.equal(fileInfo.port, info.port);
    assert.equal(fileInfo.dbPath, join(stateDir, 'magarine.db'));
    assert.ok(fileInfo.token.length >= 32, 'token should not be a trivially short value');
    assert.ok(!Number.isNaN(Date.parse(fileInfo.startedAt)));

    assert.ok(!handle.stdout().includes(fileInfo.token), 'the printed listening line must never include the token');

    assert.equal(await canConnect(info.port, '127.0.0.1'), true, 'the loopback port should accept a connection');

    const lanIp = firstNonInternalIPv4();
    if (lanIp) {
      assert.equal(
        await canConnect(info.port, lanIp, 400),
        false,
        `binding must be loopback-only: a connection to ${lanIp}:${info.port} must be refused`
      );
    }
    // If no non-internal IPv4 interface exists in this environment, this
    // corroborating check is skipped; the Orchestrator's own `netstat`
    // check (per the batch brief) is the authoritative verification once
    // step 3 lands.
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Ruling 20: serve's HUMAN listening line (no --json) gains the page
// address and how to get the token -- still never the token itself. The
// --json line is covered by the test above (unchanged shape) and is not
// re-asserted here.
test("serve's human-readable listening line names the page address and `magarine token`, never the token itself", async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'human-line-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1']);
  try {
    const deadline = Date.now() + 10_000;
    let line: string | undefined;
    while (Date.now() < deadline) {
      line = handle.stdout().split('\n').find((l) => l.includes('magarine daemon listening'));
      if (line) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(line, `serve never printed the human listening line within 10s. stdout=${handle.stdout()}`);

    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
    assert.match(line!, new RegExp(`page: http://127\\.0\\.0\\.1:${fileInfo.port}/`));
    assert.match(line!, /magarine token/);
    assert.ok(!line!.includes(fileInfo.token), 'the human listening line must never include the token');
    assert.ok(!handle.stdout().includes(fileInfo.token));
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Ruling 23: the human line also names the machine-wide cap the owner is
// running under; --json is unchanged (asserted by the json test above: no
// extra field is read from it, and none is added here).
test("serve's human-readable listening line names the machine-wide worker cap, and --json carries no such text", async () => {
  const withFlag = mkdtempSync(join(testRoot.root, 'cap-line-'));
  const withDefault = mkdtempSync(join(testRoot.root, 'cap-default-'));
  const jsonDir = mkdtempSync(join(testRoot.root, 'cap-json-'));
  const a = spawnServe(['--state-dir', withFlag, '--tick-interval', '0.1', '--max-parallel', '4']);
  const b = spawnServe(['--state-dir', withDefault, '--tick-interval', '0.1']);
  const c = spawnServe(['--state-dir', jsonDir, '--tick-interval', '0.1', '--max-parallel', '4', '--json']);
  try {
    const lineOf = async (h: ServeHandle): Promise<string> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const l = h.stdout().split('\n').find((x) => x.includes('magarine daemon listening'));
        if (l) return l;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`no listening line. stdout=${h.stdout()}`);
    };
    assert.match(await lineOf(a), /-- up to 4 workers at once \(--max-parallel\)/);
    assert.match(await lineOf(b), /-- up to 1 workers at once \(--max-parallel\)/);
    const info = await c.waitForListening();
    assert.deepEqual(Object.keys(info).sort(), ['pid', 'port', 'stateDir']);
    assert.ok(!c.stdout().includes('workers at once'));
  } finally {
    await Promise.all([a.kill(), b.kill(), c.kill()]);
    for (const d of [withFlag, withDefault, jsonDir]) rmSync(d, { recursive: true, force: true });
  }
});

test('a second `serve` refuses to start while the first is live, without printing the token, and leaves the first daemon.json untouched', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'refuse-second-'));
  const first = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const firstInfo = await first.waitForListening();
    const firstFileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

    const second = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
    const secondResult = await second.waitForExit();
    assert.notEqual(secondResult.code, 0, 'a second serve against a live state dir must exit non-zero');
    assert.match(second.stderr(), /already running/i);
    assert.match(second.stderr(), new RegExp(String(firstInfo.pid)));
    assert.ok(!second.stderr().includes(firstFileInfo.token), 'refusal message must never leak the live token');
    assert.ok(!second.stdout().includes(firstFileInfo.token));

    const stillFirstFileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
    assert.deepEqual(stillFirstFileInfo, firstFileInfo, "the second attempt must not touch the first daemon's file");
  } finally {
    await first.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a hard-killed daemon leaves a stale daemon.json (dead pid) behind; the next `serve` overwrites it and re-queues the orphaned run', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'kill-restart-'));
  try {
    // Seed a project/ticket directly via the CLI (a plain, no-daemon-running
    // write, exactly like today's CLI) before any daemon exists.
    const create = (args: string[]) =>
      new Promise<{ stdout: string; code: number | null }>((resolve) => {
        const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
        let stdout = '';
        p.onStdout((c) => (stdout += c));
        p.wait().then((r) => resolve({ stdout, code: r.code }));
      });

    const projectRes = await create(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    assert.equal(projectRes.code, 0);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await create([
      'ticket', 'add', '--project', project.id, '--title', 't', '--state-dir', stateDir, '--json',
    ]);
    assert.equal(ticketRes.code, 0);
    const ticket = JSON.parse(ticketRes.stdout);

    const status = async (): Promise<Array<{ id: string; status: string; attemptCount: number }>> => {
      // A brief retry loop: a concurrent daemon may hold a short-lived write
      // transaction on the same sqlite file at the exact moment of this
      // read (node:sqlite sets no busy_timeout) -- "reads stay direct" per
      // the spec, same as production, so this absorbs that instant rather
      // than working around it with a different read path.
      let lastErr: unknown;
      for (let i = 0; i < 20; i++) {
        try {
          const res = await create(['status', '--project', project.id, '--state-dir', stateDir, '--json']);
          return JSON.parse(res.stdout);
        } catch (err) {
          lastErr = err;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw lastErr;
    };

    // First daemon: fake-script the ticket to hang so it is caught IN_PROGRESS.
    const first = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '0.1', '--json',
      '--fake-script', `${ticket.id}=hang`,
    ]);
    const firstInfo = await first.waitForListening();

    const deadline = Date.now() + 5000;
    let inProgress = false;
    while (Date.now() < deadline) {
      const tickets = await status();
      if (tickets.find((t) => t.id === ticket.id)?.status === 'IN_PROGRESS') {
        inProgress = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(inProgress, 'the first daemon should have picked up the hanging ticket');

    // Hard-kill: the only reliable cross-process stop on this platform (see
    // file header). daemon.json is left behind, still naming the now-dead pid.
    await first.kill();
    assert.ok(isPidGone(firstInfo.pid), 'the killed daemon process should actually be gone');
    assert.ok(existsSync(daemonFilePath(stateDir)), 'a hard kill must leave daemon.json behind, not clean it up');
    const staleFileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
    assert.equal(staleFileInfo.pid, firstInfo.pid);

    // Second daemon, same state dir, no fake-script this time: it should
    // start successfully (the stale file's dead pid must not block it),
    // overwrite daemon.json with a fresh pid/token, and its own boot-time
    // recovery (recoverOrphanedRuns, called from startDaemonLoop) should
    // re-queue the orphaned run -- READY, then picked back up and driven to
    // DONE by this daemon's own (unscripted, default-succeed) FakeAdapter.
    const second = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
    try {
      const secondInfo = await second.waitForListening();
      assert.notEqual(secondInfo.pid, firstInfo.pid);
      const freshFileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      assert.equal(freshFileInfo.pid, secondInfo.pid);
      assert.notEqual(freshFileInfo.token, staleFileInfo.token);

      const doneDeadline = Date.now() + 5000;
      let recoveredTicket: { status: string; attemptCount: number } | undefined;
      while (Date.now() < doneDeadline) {
        const tickets = await status();
        const t = tickets.find((tk) => tk.id === ticket.id);
        if (t?.status === 'DONE') {
          recoveredTicket = t;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(recoveredTicket, 'the orphaned ticket should have been re-queued and driven to completion');
      // attempt_count only advances on a FAILURE transition (see
      // stateMachine.ts's static-transition table: worker_done never touches
      // it), so recovery's one worker_failed_retryable is the only increment
      // here -- the following successful retry leaves it unchanged at 1.
      assert.equal(recoveredTicket!.attemptCount, 1, 'exactly one consumed attempt, from the orphaned run');

      const activityRes = await create([
        'activity', '--ticket', ticket.id, '--all', '--state-dir', stateDir, '--json',
      ]);
      const events = JSON.parse(activityRes.stdout) as Array<{ eventType: string; payload: unknown }>;
      const recoveryEvent = events.find(
        (e) =>
          e.eventType === 'worker_failed_retryable' &&
          typeof e.payload === 'object' &&
          e.payload !== null &&
          (e.payload as Record<string, unknown>).reason === 'orphaned_on_restart'
      );
      assert.ok(recoveryEvent, 'the event log should show the recovery path fired, not a coincidental fresh success');
    } finally {
      await second.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from './process.ts';
import { daemonFilePath, type DaemonFileInfo } from './daemon.ts';
import { testTempRoot } from './testSupport.ts';

// Cross-process coverage for the daemon's HTTP API itself: everything here
// spawns the real `magarine serve` CLI command and talks to it over a real
// loopback HTTP connection with the real `fetch`, exactly the way a second
// shell (or, eventually, an AionUi caller) would. Auth in particular is the
// one thing the Orchestrator said they would check directly -- a wrong
// token refused, and the real token never surfacing in a response, a log
// line, or /health -- so it gets covered here in step 3 rather than waiting
// for step 5's fuller acceptance pass.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const testRoot = testTempRoot('daemon-api');
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
  waitForListening(): Promise<ListeningInfo>;
  kill(): Promise<void>;
}

function spawnServe(args: string[]): ServeHandle {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, 'serve', ...args] });
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
            // still buffering
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`serve never printed a listening line within 10s. stdout=${stdout} stderr=${stderr}`);
    },
    async kill() {
      await proc.stop(200);
      await proc.wait();
    },
  };
}

function runCli(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args] });
    let stdout = '';
    p.onStdout((c) => (stdout += c));
    p.wait().then((r) => resolve({ stdout, code: r.code }));
  });
}

async function api(
  port: number,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

test('auth: correct token is accepted, a wrong or missing token is refused (401), and the real token never appears in any response or in the daemon\'s own output', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'auth-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

    const ok = await api(info.port, fileInfo.token, 'GET', '/health');
    assert.equal(ok.status, 200);
    const okBody = ok.json as { pid: number; startedAt: string; uptimeMs: number };
    assert.equal(okBody.pid, info.pid);
    assert.ok(!('token' in (okBody as object)), '/health must never carry the token');
    assert.ok(!ok.text.includes(fileInfo.token));

    const wrongToken = 'a'.repeat(fileInfo.token.length);
    const wrong = await api(info.port, wrongToken, 'GET', '/health');
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { error: 'unauthorized' });
    assert.ok(!wrong.text.includes(fileInfo.token), 'a wrong-token response must not leak the real token either');

    const missing = await api(info.port, '', 'GET', '/health');
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.json, { error: 'unauthorized' });

    // A wrong token on a mutating route is refused the same way, before any
    // work happens -- not just on the read-only /health route.
    const wrongOnPost = await api(info.port, wrongToken, 'POST', '/tick', { project: 'does-not-matter' });
    assert.equal(wrongOnPost.status, 401);

    assert.ok(!handle.stdout().includes(fileInfo.token), "the daemon's own stdout must never contain the token");
    assert.ok(!handle.stderr().includes(fileInfo.token), "the daemon's own stderr must never contain the token");
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /tickets creates a ticket (with the same attach-deps-before-resolving-readiness ordering the CLI uses), POST /deps wires a dependency, and GET /board and GET /activity reflect it', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'tickets-'));
  try {
    // Batch 8's route list has no project-create endpoint (`POST /tickets`,
    // `POST /deps`, and the ticket/project action routes are the whole
    // mutating surface); project creation stays a direct CLI write even
    // with a daemon up. Flagged to the Orchestrator in the step 3 report as
    // a real question, not silently resolved here.
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    assert.equal(projectRes.code, 0);
    const project = JSON.parse(projectRes.stdout);

    // A long interval: this test asserts on status immediately after
    // creation, so nothing here should race the daemon's own periodic tick
    // promoting OPEN -> READY (or further) out from under the assertions.
    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
        api(info.port, fileInfo.token, method, path, body);

      const blockerRes = await call('POST', '/tickets', { project: project.id, title: 'blocker' });
      assert.equal(blockerRes.status, 201);
      const blocker = blockerRes.json as { id: string; status: string };
      // Matches the CLI's own `ticket add` exactly (cli.ts never calls
      // resolveReadiness for a ticket created with zero dependencies): a
      // fresh ticket is OPEN until some tick() call promotes it, whether
      // that's this daemon's own periodic pass or a forced `POST /tick` --
      // creation itself never promotes it, deps or no deps.
      assert.equal(blocker.status, 'OPEN');

      // dependsOn given in the same call: must never be observably READY
      // before the dependency is attached.
      const dependentRes = await call('POST', '/tickets', {
        project: project.id,
        title: 'dependent',
        dependsOn: [blocker.id],
      });
      assert.equal(dependentRes.status, 201);
      const dependent = dependentRes.json as { id: string; status: string };
      assert.equal(dependent.status, 'OPEN', 'must not be READY while its dependency is not yet DONE');

      // POST /deps as its own call, wiring a second, independently-created
      // ticket in after the fact.
      const thirdRes = await call('POST', '/tickets', { project: project.id, title: 'third' });
      const third = thirdRes.json as { id: string };
      const depRes = await call('POST', '/deps', { project: project.id, ticket: third.id, dependsOn: blocker.id });
      assert.equal(depRes.status, 200);
      assert.deepEqual(depRes.json, { ticketId: third.id, dependsOnTicketId: blocker.id });

      const boardRes = await call('GET', `/board?project=${project.id}`);
      assert.equal(boardRes.status, 200);
      const board = boardRes.json as { tickets: Array<{ id: string; status: string }> };
      assert.equal(board.tickets.length, 3);
      assert.equal(board.tickets.find((t) => t.id === third.id)?.status, 'OPEN');

      const activityRes = await call('GET', `/activity?project=${project.id}&all=true`);
      assert.equal(activityRes.status, 200);
      assert.ok(Array.isArray(activityRes.json));
      assert.ok((activityRes.json as unknown[]).length > 0);
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /tick forces a pass ahead of a distant scheduled interval, and POST /tickets/{id}/cancel lands a hanging run in CANCELLED (not READY) without consuming an attempt, reopenable only via retry', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'tick-cancel-'));
  try {
    // --max-parallel 2 here (batch 9 housekeeping item 1 ruling 1): a
    // project's own `max_parallel_workers` is now consulted at the daemon
    // (see daemon.ts's computeProjectCap) as the smaller-of-two alongside
    // `serve`'s machine-wide ceiling, so the project's own default of 1
    // would otherwise cap this single project at one concurrent worker
    // regardless of `serve --max-parallel` below -- exactly the two
    // concurrent tickets (hangTicket + fresh) this test needs.
    const projectRes = await runCli([
      'project', 'create', '--name', 'p', '--max-parallel', '2', '--state-dir', stateDir, '--json',
    ]);
    const project = JSON.parse(projectRes.stdout);
    // Fake-scripted BEFORE the daemon starts, since --fake-script names a
    // ticket id at daemon startup -- which means this ticket is inevitably
    // caught by the daemon's own unavoidable first automatic tick (fired the
    // instant startDaemonLoop is called, before this test can ever race it
    // with a forced call of its own). That is fine: this ticket's job here
    // is only to prove /cancel, not to prove /tick forces anything -- a
    // SEPARATE ticket, created after the daemon is already up and its one
    // automatic pass is long done, proves that instead (below).
    const hangTicketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 'hangs', '--state-dir', stateDir, '--json',
    ]);
    const hangTicket = JSON.parse(hangTicketRes.stdout);

    // 30s: far longer than this test's own runtime, so nothing here can be
    // explained by the periodic interval firing again on its own.
    // --max-parallel 2: the hanging ticket occupies one of maxParallelWorkers'
    // concurrency slots for the rest of the test, so the fresh ticket below
    // needs a second slot free to start alongside it (tick()'s own
    // concurrency cap, unrelated to what this test is trying to prove).
    const handle = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '30', '--max-parallel', '2', '--json',
      '--fake-script', `${hangTicket.id}=hang`,
    ]);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
        api(info.port, fileInfo.token, method, path, body);

      const deadline = Date.now() + 3000;
      let hangInProgress = false;
      while (Date.now() < deadline) {
        const board = (await call('GET', `/board?project=${project.id}`)).json as {
          tickets: Array<{ id: string; status: string }>;
        };
        if (board.tickets.find((t) => t.id === hangTicket.id)?.status === 'IN_PROGRESS') {
          hangInProgress = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(hangInProgress, "the daemon's own automatic first tick should have started the hanging ticket");

      // A brand new ticket, created only now: the daemon's next automatic
      // pass is ~30s away, so the only way this can start is the forced call
      // below actually doing real, otherwise-untriggered work.
      const freshRes = await call('POST', '/tickets', { project: project.id, title: 'fresh' });
      const fresh = freshRes.json as { id: string; status: string };
      assert.equal(fresh.status, 'OPEN');

      const tickRes = await call('POST', '/tick', { project: project.id });
      assert.equal(tickRes.status, 200);
      const tickResult = tickRes.json as { started: Array<{ ticketId: string; runId: string }> };
      assert.deepEqual(
        tickResult.started.map((s) => s.ticketId),
        [fresh.id],
        'the forced tick should start the fresh ticket and correctly skip the one already IN_PROGRESS'
      );

      // Cancelling a ticket this daemon holds no live run for is refused,
      // not silently ignored.
      const bogusCancel = await call('POST', '/tickets/does-not-exist/cancel');
      assert.equal(bogusCancel.status, 404);

      const cancelRes = await call('POST', `/tickets/${hangTicket.id}/cancel`);
      assert.equal(cancelRes.status, 200);
      const cancelled = cancelRes.json as { status: string; attemptCount: number };
      // Batch 8 ruling: terminal CANCELLED, not READY -- a person's cancel
      // must not let the daemon's own next tick silently restart the run
      // (the original design did exactly that; see daemon.test.ts's
      // DaemonLoop.cancelTicket test for the regression check against a
      // short, actually-firing interval).
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal(cancelled.attemptCount, 0, 'a cancel must not consume an attempt');

      // Cancelling again: the ticket is CANCELLED now, not running -- 409,
      // not a silent no-op that looks like a second successful cancel.
      const secondCancel = await call('POST', `/tickets/${hangTicket.id}/cancel`);
      assert.equal(secondCancel.status, 409);

      // retry, the one explicit way back to READY ("cancel then retry" is
      // two commands, not a separate reopen).
      const retryRes = await call('POST', `/tickets/${hangTicket.id}/retry`);
      assert.equal(retryRes.status, 200);
      assert.equal((retryRes.json as { status: string }).status, 'READY');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Batch 8 step 5's headline acceptance item: kill the daemon mid-run,
// restart it, and confirm the orphaned run is re-queued through the
// existing recovery path -- "the one that tells us whether this thing is
// safe to leave running." commands/serve.test.ts already proves this
// end-to-end using CLI reads (`status`/`activity --json`) for verification;
// this test proves the exact same property using the SECOND daemon's own
// API (GET /board, GET /activity) instead, per the Orchestrator's explicit
// ask once the API existed to verify it through. Not a duplicate: the
// underlying recovery mechanism (recoverOrphanedRuns, called from
// startDaemonLoop) is the same either way, but this is the first place that
// mechanism's result is read back over HTTP rather than via a direct file
// read.
test('kill-and-restart, verified through the API: the second daemon\'s own GET /board and GET /activity show the orphaned run recovered and driven to completion', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'kill-restart-api-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 't', '--state-dir', stateDir, '--json',
    ]);
    const ticket = JSON.parse(ticketRes.stdout);

    const first = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '0.1', '--json', '--fake-script', `${ticket.id}=hang`,
    ]);
    const firstInfo = await first.waitForListening();
    const firstFileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

    const inProgressDeadline = Date.now() + 5000;
    let inProgress = false;
    while (Date.now() < inProgressDeadline) {
      const board = (await api(firstInfo.port, firstFileInfo.token, 'GET', `/board?project=${project.id}`))
        .json as { tickets: Array<{ id: string; status: string }> };
      if (board.tickets.find((t) => t.id === ticket.id)?.status === 'IN_PROGRESS') {
        inProgress = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(inProgress, "the first daemon's own board should show the ticket IN_PROGRESS");

    // Hard-kill: the only reliable cross-process stop on this platform (see
    // commands/serve.test.ts's header comment for the three experiments
    // that established this). daemon.json is left behind, still naming the
    // now-dead pid -- the second daemon below has to overwrite it to start
    // at all.
    await first.kill();

    const second = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
    try {
      const secondInfo = await second.waitForListening();
      assert.notEqual(secondInfo.pid, firstInfo.pid);
      const secondFileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string) => api(secondInfo.port, secondFileInfo.token, method, path);

      const doneDeadline = Date.now() + 5000;
      let recoveredTicket: { status: string; attemptCount: number } | undefined;
      while (Date.now() < doneDeadline) {
        const board = (await call('GET', `/board?project=${project.id}`)).json as {
          tickets: Array<{ id: string; status: string; attemptCount: number }>;
        };
        const t = board.tickets.find((tk) => tk.id === ticket.id);
        if (t?.status === 'DONE') {
          recoveredTicket = t;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(
        recoveredTicket,
        "the second daemon's own board should show the orphaned ticket re-queued and driven to DONE"
      );
      // Only recovery's one worker_failed_retryable ever bumps attempt_count
      // here (worker_done never touches it -- see stateMachine.ts's static
      // transition table), so this is the same "exactly one consumed
      // attempt" signature commands/serve.test.ts's CLI-read version checks.
      assert.equal(recoveredTicket!.attemptCount, 1);

      const activity = (await call('GET', `/activity?ticket=${ticket.id}&all=true`)).json as Array<{
        eventType: string;
        payload: unknown;
      }>;
      const recoveryEvent = activity.find(
        (e) =>
          e.eventType === 'worker_failed_retryable' &&
          typeof e.payload === 'object' &&
          e.payload !== null &&
          (e.payload as Record<string, unknown>).reason === 'orphaned_on_restart'
      );
      assert.ok(
        recoveryEvent,
        "the second daemon's own activity log, read over the API, should show the recovery path fired -- not a coincidental fresh success"
      );
    } finally {
      await second.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Batch 9: the Manager's daemon route.
test('POST /projects/{id}/plan creates a manager ticket, and POST /projects/{id}/set accepts managerModel', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'plan-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
        api(info.port, fileInfo.token, method, path, body);

      const planRes = await call('POST', `/projects/${project.id}/plan`, { mission: 'Write three reports and an index.' });
      assert.equal(planRes.status, 201);
      const planned = planRes.json as { id: string; kind: string; description: string; workspaceType: string };
      assert.equal(planned.kind, 'manager');
      assert.equal(planned.description, 'Write three reports and an index.');
      assert.equal(planned.workspaceType, 'NONE');

      const missingMission = await call('POST', `/projects/${project.id}/plan`, {});
      assert.equal(missingMission.status, 400);

      const board = (await call('GET', `/board?project=${project.id}`)).json as { tickets: Array<{ id: string; kind: string }> };
      assert.equal(board.tickets.find((t) => t.id === planned.id)?.kind, 'manager');

      const setRes = await call('POST', `/projects/${project.id}/set`, { managerModel: 'claude-fable-5-1' });
      assert.equal(setRes.status, 200);
      assert.equal((setRes.json as { managerModel: string }).managerModel, 'claude-fable-5-1');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

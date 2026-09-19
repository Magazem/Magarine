import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from './process.ts';
import { daemonFilePath, type DaemonFileInfo, type DaemonLoop } from './daemon.ts';
import { consumeEventStream } from './daemonClient.ts';
import { createRequestHandler, isSafeAssetName } from './daemonApi.ts';
import { openDb } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { deriveTestCliCwd, testTempRoot } from './testSupport.ts';

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
    const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
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

// Ruling 16, amended: `POST /tickets` mirrors `ticket add`'s
// `--expected-artifact`, but carries the FULL create_ticket JSON shape
// (`{kind, path?}` entries), not the CLI's path-only shorthand -- and reuses
// proposal.ts's `validateExpectedArtifacts` rather than a second copy of the
// same rules.
test('POST /tickets expectedArtifacts: absent stores null (never []), a valid entry is stored, an empty array is refused, and an unknown kind is refused naming the entry\'s index, and neither refusal leaves a ticket behind', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'tickets-expected-artifacts-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    assert.equal(projectRes.code, 0);
    const project = JSON.parse(projectRes.stdout);

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
        api(info.port, fileInfo.token, method, path, body);

      const absentRes = await call('POST', '/tickets', { project: project.id, title: 'no expectations' });
      assert.equal(absentRes.status, 201, absentRes.text);
      const absent = absentRes.json as { expectedArtifacts: unknown };
      assert.equal(absent.expectedArtifacts, null, 'absent must store null, not []');
      assert.notDeepEqual(absent.expectedArtifacts, [], 'null is not the same as an empty list');

      const validRes = await call('POST', '/tickets', {
        project: project.id,
        title: 'declares one',
        expectedArtifacts: [{ kind: 'file', path: 'out.md' }],
      });
      assert.equal(validRes.status, 201, validRes.text);
      const valid = validRes.json as { expectedArtifacts: unknown };
      assert.deepEqual(valid.expectedArtifacts, [{ kind: 'file', path: 'out.md' }]);

      const boardBefore = (await call('GET', `/board?project=${project.id}`)).json as { tickets: unknown[] };
      const countBefore = boardBefore.tickets.length;

      const emptyRes = await call('POST', '/tickets', {
        project: project.id,
        title: 'declares nothing',
        expectedArtifacts: [],
      });
      assert.equal(emptyRes.status, 400);
      assert.match((emptyRes.json as { error: string }).error, /expectedArtifacts must be omitted or non-empty/);

      const boardAfterEmpty = (await call('GET', `/board?project=${project.id}`)).json as { tickets: unknown[] };
      assert.equal(
        boardAfterEmpty.tickets.length,
        countBefore,
        'a refused `[]` must leave no orphan ticket behind -- the 400 must fire before createTicket, not after'
      );

      const badKindRes = await call('POST', '/tickets', {
        project: project.id,
        title: 'bad kind',
        expectedArtifacts: [{ kind: 'file', path: 'ok.txt' }, { kind: 'not-a-real-kind' }],
      });
      assert.equal(badKindRes.status, 400);
      assert.match((badKindRes.json as { error: string }).error, /\[1\]/, 'must name the offending entry\'s index');

      const boardAfterBadKind = (await call('GET', `/board?project=${project.id}`)).json as { tickets: unknown[] };
      assert.equal(
        boardAfterBadKind.tickets.length,
        countBefore,
        'a refused unknown-kind entry must leave no orphan ticket behind -- the 400 must fire before createTicket, not after'
      );
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
// Batch 16 item 4: Role B's page needs `slots` over the wire, with the cap
// being what THIS daemon was started with, not a default.
test('GET /board carries slots { used, cap }: cap is the daemon\'s own --max-parallel, used counts a live IN_PROGRESS ticket', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'slots-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await runCli(['ticket', 'add', '--project', project.id, '--title', 'hangs', '--state-dir', stateDir, '--json']);
    const ticket = JSON.parse(ticketRes.stdout);

    const handle = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '30', '--max-parallel', '3', '--json',
      '--fake-script', `${ticket.id}=hang`,
    ]);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const deadline = Date.now() + 5000;
      let slots: { used: number; cap: number | null } | undefined;
      while (Date.now() < deadline) {
        const board = (await api(info.port, fileInfo.token, 'GET', `/board?project=${project.id}`)).json as {
          slots: { used: number; cap: number | null };
        };
        slots = board.slots;
        if (slots?.used === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.deepEqual(slots, { used: 1, cap: 3 });
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

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

// Batch 9/11: the Manager's daemon routes. Batch 11 repoints `plan` at
// manager.ts's `planProject` (scope/board-driven, no `mission` argument any
// more -- see manager.ts's own doc comment on the cross-role contract with
// Role Q) and adds `discuss`.
test('POST /projects/{id}/plan creates a manager ticket with no body required, POST /projects/{id}/discuss records the message, and POST /projects/{id}/set accepts managerModel', async () => {
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

      const planRes = await call('POST', `/projects/${project.id}/plan`, {});
      assert.equal(planRes.status, 201);
      const planned = planRes.json as { id: string; kind: string; workspaceType: string };
      assert.equal(planned.kind, 'manager');
      assert.equal(planned.workspaceType, 'NONE');

      const board = (await call('GET', `/board?project=${project.id}`)).json as { tickets: Array<{ id: string; kind: string }> };
      assert.equal(board.tickets.find((t) => t.id === planned.id)?.kind, 'manager');

      const discussRes = await call('POST', `/projects/${project.id}/discuss`, { message: 'Please drop the export feature.' });
      assert.equal(discussRes.status, 201);
      const discussed = discussRes.json as { id: string; kind: string; description: string };
      assert.equal(discussed.kind, 'manager');
      assert.equal(discussed.description, 'Please drop the export feature.');

      const missingMessage = await call('POST', `/projects/${project.id}/discuss`, {});
      assert.equal(missingMessage.status, 400);

      const activity = (await call('GET', `/activity?project=${project.id}&all=true`)).json as Array<{ eventType: string }>;
      assert.ok(
        activity.some((e) => e.eventType === 'discuss'),
        'expected the discuss event to be recorded and visible on the activity feed'
      );

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

// Batch 15 ruling 7 item 1: GET /tickets/{id}/progress and, via the board,
// latest_activity -- both read from the SAME worker_progress rows a real
// run leaves behind. `--fake-script <ticketId>=progress` never terminates
// (fakeAdapter.ts), so the ticket stays IN_PROGRESS with exactly one
// worker_progress event recorded, which is enough to prove the route and
// the board field are both wired to real data through a real spawned
// daemon, not just this role's own unit tests of buildTicketProgress.
test('GET /tickets/{id}/progress returns one entry per run, and GET /board reports the same run\'s latestActivity, for a ticket a fake-scripted worker leaves IN_PROGRESS', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'progress-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 'chatty', '--state-dir', stateDir, '--json',
    ]);
    const ticket = JSON.parse(ticketRes.stdout);

    const handle = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '0.1', '--json',
      '--fake-script', `${ticket.id}=progress:tool_use: Write`,
      '--fake-script', `${ticket.id}=progress:tool result received`,
    ]);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string) => api(info.port, fileInfo.token, method, path);

      // Ruling 19 through the real daemon: the LAST event a board read can
      // land on is a tool result (batch 16 item 1's scripted burst, in the
      // adapter's real message shapes), and it must publish `writing` --
      // the phase of the Write it answers -- not `reporting`. This is the
      // exact shape the owner's real run got wrong: every board read landed
      // on a tool result. `tool` stays null on that row (the phase is the
      // state; the tool is evidence), while the earlier row carries Write.
      const deadline = Date.now() + 10_000;
      let progress: Array<{ runId: string; runStatus: string; latest: { state: string; message?: string } | null }> = [];
      while (Date.now() < deadline) {
        const res = await call('GET', `/tickets/${ticket.id}/progress`);
        if (
          res.status === 200 &&
          (res.json as Array<{ latest: { message?: string } | null }>)[0]?.latest?.message === 'tool result received'
        ) {
          progress = res.json as typeof progress;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(progress.length, 1);
      assert.equal(progress[0].runStatus, 'running');
      assert.equal(progress[0].latest?.state, 'writing');

      const missing = await call('GET', '/tickets/tkt_ghost/progress');
      assert.equal(missing.status, 404);

      const boardRes = await call('GET', `/board?project=${project.id}`);
      const board = boardRes.json as { tickets: Array<{ id: string; status: string; latestActivity: { state: string } | null }> };
      const row = board.tickets.find((t) => t.id === ticket.id)!;
      assert.equal(row.status, 'IN_PROGRESS');
      assert.equal(row.latestActivity?.state, 'writing');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Batch 15 ruling 7 item 2: GET /events?since=<sequence>, text/event-stream.
// Same header auth as every other route (never a token in the URL); replays
// rows after `since`, then pushes new ones as they are inserted; `id` is
// the row's own `sequence`, event name is its `event_type`; and the stream
// ends cleanly (the async generator returns, not throws or hangs) when the
// daemon itself stops.
// "Closes cleanly when the daemon stops" is proven separately, below, by
// calling `closeAllStreams()` directly against a real (in-process)
// http.Server -- not by killing this cross-process daemon. Windows cannot
// deliver a catchable signal across processes (daemon.ts's own
// ShutdownMode/detectShutdownMode: 'hard-kill-only' here), so
// `handle.kill()` in this test file always hard-kills the daemon before
// its own SIGINT/SIGTERM listener (serve.ts's `onSignal`, the thing that
// actually calls `closeAllStreams()`) could ever run -- an external kill on
// this machine can only ever produce ECONNRESET, which is not evidence
// about `closeAllStreams()` either way.
// Ruling 23: the route validates `maxParallel` with the same store validator
// the CLI uses, so the message is identical whichever surface refused it.
test('POST /projects/{id}/set maxParallel: a valid value persists; 0, -1, 1.5 are a 400 carrying the same message the CLI prints, and leave the cap untouched', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'set-maxparallel-'));
  try {
    const project = JSON.parse(
      (await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json'])).stdout
    ) as { id: string };
    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (body: unknown) => api(info.port, fileInfo.token, 'POST', `/projects/${project.id}/set`, body);

      const ok = await call({ maxParallel: 3 });
      assert.equal(ok.status, 200, ok.text);
      assert.equal((ok.json as { maxParallelWorkers: number }).maxParallelWorkers, 3);

      for (const bad of [0, -1, 1.5]) {
        const refused = await call({ maxParallel: bad });
        assert.equal(refused.status, 400, `maxParallel ${bad} must be a 400`);
        const message = (refused.json as { error: string }).error;
        assert.match(message, /--max-parallel/);
        assert.match(message, /whole number of 1 or more/);
        assert.match(message, new RegExp(`got: ${bad}`));
      }
      const after = await call({});
      assert.equal((after.json as { maxParallelWorkers: number }).maxParallelWorkers, 3, 'refused values changed nothing');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /events replays existing rows after since, then pushes a live fake-adapter worker_progress event with id === sequence and event === event_type, and is refused without the token even when the query string carries no secret of its own', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'events-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 'chatty', '--state-dir', stateDir, '--json',
    ]);
    const ticket = JSON.parse(ticketRes.stdout);

    const handle = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '0.1', '--json',
      '--fake-script', `${ticket.id}=progress`,
    ]);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

      // No token at all: refused, same as every other route.
      const noAuth = await api(info.port, '', 'GET', '/events?since=0');
      assert.equal(noAuth.status, 401);

      // The wrong token, checked on the raw request URL string itself: the
      // token this test sends must never be reachable by inspecting the
      // URL alone -- consumeEventStream sends it as a header, never a query
      // parameter, so a GET with no Authorization header and a since-only
      // query string must still be refused.
      const rawUrl = `http://127.0.0.1:${info.port}/events?since=0`;
      const rawNoAuth = await fetch(rawUrl);
      assert.equal(rawNoAuth.status, 401);
      assert.doesNotMatch(rawUrl, /token/i);

      const controller = new AbortController();
      const seen: Array<{ id: number; event: string; data: { sequence: number; eventType: string } }> = [];
      const consumed = (async () => {
        for await (const event of consumeEventStream(
          { port: info.port, token: fileInfo.token },
          { since: 0, signal: controller.signal }
        )) {
          seen.push(event as typeof seen[number]);
          if (event.event === 'worker_progress') break;
        }
      })();

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for a live worker_progress event over the stream')), 10_000)
      );
      await Promise.race([consumed, timeout]);
      controller.abort();

      const progressEvent = seen.find((e) => e.event === 'worker_progress')!;
      assert.ok(progressEvent, 'expected a worker_progress event to arrive over the live stream');
      assert.equal(progressEvent.id, progressEvent.data.sequence, 'the SSE frame id must equal the event row\'s own sequence');
      assert.equal(progressEvent.event, progressEvent.data.eventType, 'the SSE event name must equal the event row\'s own event_type');
      // Batch 16 item 3 (ruling 18 option B): the frame names its own ticket, so
      // a consumer needs no second lookup from the run id to understand it.
      assert.equal(
        (progressEvent.data.payload as { ticketId?: string }).ticketId,
        ticket.id,
        'the streamed worker_progress frame must carry the ticket it belongs to'
      );
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The in-process half of "closes cleanly when the daemon stops": no CLI
// spawn, no OS signal -- a real http.Server built directly from
// createRequestHandler's own `handle`, so `closeAllStreams()` (the exact
// function serve.ts's own shutdown sequence calls, per that file's comment)
// can be called directly and its effect observed deterministically.
test('createRequestHandler().closeAllStreams() ends every open /events response cleanly -- a connected consumer\'s for-await loop returns rather than hanging or throwing', async () => {
  const db = openDb(':memory:');
  const stubLoop: DaemonLoop = {
    live: new Map(),
    stop: async () => {},
    forceTick: async () => ({ started: [] }),
    cancelTicket: async () => 'not_running',
  };
  const requestHandler = createRequestHandler({
    db,
    adapter: new FakeAdapter(),
    loop: stubLoop,
    token: 'test-token',
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const server = createServer(requestHandler.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    let sawAtLeastOneChunk = false;
    let loopEnded = false;
    const consumed = (async () => {
      for await (const _event of consumeEventStream({ port, token: 'test-token' })) {
        sawAtLeastOneChunk = true;
      }
      loopEnded = true;
    })();

    // Give the connection a moment to actually open before ending it --
    // otherwise this could trivially "pass" by racing closeAllStreams()
    // before the server ever registered the stream at all.
    await new Promise((resolve) => setTimeout(resolve, 100));
    requestHandler.closeAllStreams();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('the consumer did not see the stream end within 2s of closeAllStreams()')), 2_000)
    );
    await Promise.race([consumed, timeout]);
    assert.equal(loopEnded, true);
    assert.equal(sawAtLeastOneChunk, false, 'sanity: no real event was ever inserted, so there is nothing to have consumed but the clean end itself');
  } finally {
    // `closeAllConnections()` (not just `close()`) so that if
    // `closeAllStreams()` above were ever broken and left the SSE response
    // genuinely open, this cleanup still terminates the server rather than
    // hanging the whole suite on `close()`'s own callback, which only fires
    // once every connection has ended on its own.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Ruling 12, unit level: the slash check alone already blocks every
// MULTI-segment traversal, and a bare ".." has no recognised extension
// either way (STATIC_CONTENT_TYPES has no empty-string row), so no real
// file on this disk exercises the dot-segment guard in isolation through
// a live route. Tested directly against the function instead, so the guard
// the ruling names explicitly ("a path separator OR dot-segment") is
// provably present, not merely coincidentally redundant with the slash
// check.
test('isSafeAssetName: refuses a path separator, a dot-segment (even with no separator at all), and an encoded dot-segment; accepts an ordinary filename', () => {
  assert.equal(isSafeAssetName('organism.js'), true);
  assert.equal(isSafeAssetName('sub/organism.js'), false);
  assert.equal(isSafeAssetName('sub\\organism.js'), false);
  assert.equal(isSafeAssetName('..'), false);
  assert.equal(isSafeAssetName('../secret.js'), false);
  assert.equal(isSafeAssetName('%2e%2e'), false, 'an encoded dot-segment must be caught after decoding');
  assert.equal(isSafeAssetName(''), false);
});

// Batch 15 rulings 11/12: `GET /ui/<name>`, served from packages/core/ui/,
// resolved relative to THIS module, not the daemon's cwd. Unauthenticated,
// same reasoning as `GET /` below -- a browser's native <script src="">/
// <link>/@font-face loading never carries a custom Authorization header,
// so gating these routes behind the token would just break the page that
// requests them.
test('GET /ui/organism.js is served byte-identical to the real file on disk, with no token required', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'assets-organism-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    const res = await fetch(`http://127.0.0.1:${info.port}/ui/organism.js`);
    assert.equal(res.status, 200);
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = readFileSync(fileURLToPath(new URL('../ui/organism.js', import.meta.url)));
    assert.ok(served.equals(onDisk), 'the served bytes must be byte-identical to ui/organism.js on disk');
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /ui/<a font file> answers 200 with content-type font/woff2', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'assets-font-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    const res = await fetch(`http://127.0.0.1:${info.port}/ui/IBMPlexSans.woff2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /ui/<name> refuses a path separator or a dot-segment (traversal), and 404s an unknown asset name -- no directory listing, no fallback to any page', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'assets-traversal-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    const base = `http://127.0.0.1:${info.port}`;

    const traversalEncoded = await fetch(`${base}/ui/..%2Fpackage.json`);
    assert.notEqual(traversalEncoded.status, 200, 'an encoded dot-segment must not reach a file outside ui/');
    const traversalNested = await fetch(`${base}/ui/sub/organism.js`);
    assert.notEqual(traversalNested.status, 200, 'a path separator in the name must be refused');

    const unknown = await fetch(`${base}/ui/does-not-exist.js`);
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.text();
    assert.doesNotMatch(unknownBody, /<html/i, 'an unknown asset must not silently fall back to any page');

    const listing = await fetch(`${base}/ui/`);
    assert.notEqual(listing.status, 200, 'there is no directory listing');

    const unmappedExtension = await fetch(`${base}/ui/ELEMENT-FIELD-TABLE.md`);
    assert.notEqual(unmappedExtension.status, 200, 'an extension outside the content-type table (html/css/js/woff2/svg) is not served');
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Batch 11 item 3 (the page): GET / is the one deliberate exception to
// "auth before anything else" -- the page itself is where the owner types
// the token IN, so it cannot be gated behind that same token. GET /projects
// and GET /projects/{id}/scope are the two new read-only routes the page
// needs that batch 8/9's route list never had reason to include.
test('GET / serves the page without a token; GET /projects lists projects; GET /projects/{id}/scope reads the scope file, all behind no new write site', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'page-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

    const pageNoToken = await api(info.port, '', 'GET', '/');
    assert.equal(pageNoToken.status, 200, 'the page itself must load with no token at all -- it is where the token is typed IN');
    assert.match(pageNoToken.text, /<html/i);
    assert.match(pageNoToken.text, /Magarine/);

    const pageWrongToken = await api(info.port, 'not-the-real-token', 'GET', '/');
    assert.equal(pageWrongToken.status, 200, 'a wrong token on GET / still serves the shell -- only the routes it calls are gated');

    const projectRes = await runCli(['project', 'create', '--name', 'PageProject', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout) as { id: string; name: string };

    const noAuthProjects = await api(info.port, '', 'GET', '/projects');
    assert.equal(noAuthProjects.status, 401, 'unlike GET /, the actual data routes stay behind the token');

    const projectsRes = await api(info.port, fileInfo.token, 'GET', '/projects');
    assert.equal(projectsRes.status, 200);
    const projects = projectsRes.json as Array<{ id: string; name: string }>;
    assert.ok(
      projects.some((p) => p.id === project.id && p.name === 'PageProject'),
      'the created project must be listed'
    );

    const noScopeRes = await api(info.port, fileInfo.token, 'GET', `/projects/${project.id}/scope`);
    assert.equal(noScopeRes.status, 200);
    assert.equal(
      (noScopeRes.json as { scopeText: string }).scopeText,
      '',
      'a project with no scope_path set must read as empty text, not 404 or throw'
    );

    const missingProjectScope = await api(info.port, fileInfo.token, 'GET', '/projects/proj_ghost/scope');
    assert.equal(missingProjectScope.status, 404);
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Batch 11 part 2, item 4: the conversation panel's feed, a thin read-only
// wrapper over commands/conversation.ts's buildConversation, over real HTTP.
test('GET /projects/{id}/conversation reads the owner\'s discuss messages back in order, and 404s for a nonexistent project', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'conversation-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json']);
  try {
    const info = await handle.waitForListening();
    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

    const projectRes = await runCli(['project', 'create', '--name', 'ConversationProject', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout) as { id: string };

    const emptyRes = await api(info.port, fileInfo.token, 'GET', `/projects/${project.id}/conversation`);
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(emptyRes.json, [], 'a fresh project has no conversation yet');

    const discussRes = await runCli([
      'discuss', '--project', project.id, '--message', 'What should the first ticket be?', '--state-dir', stateDir, '--json',
    ]);
    assert.equal(discussRes.code, 0, discussRes.stdout);

    const afterRes = await api(info.port, fileInfo.token, 'GET', `/projects/${project.id}/conversation`);
    assert.equal(afterRes.status, 200);
    const entries = afterRes.json as Array<{ kind: string; text: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'owner_message');
    assert.equal(entries[0].text, 'What should the first ticket be?');

    const missingProjectConversation = await api(info.port, fileInfo.token, 'GET', '/projects/proj_ghost/conversation');
    assert.equal(missingProjectConversation.status, 404);
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

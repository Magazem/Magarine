import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from './process.ts';
import { daemonFilePath, startDaemonLoop, type DaemonFileInfo, type DaemonLoop } from './daemon.ts';
import { consumeEventStream } from './daemonClient.ts';
import { createRequestHandler, isSafeAssetName } from './daemonApi.ts';
import { openDb, type Db } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { createProject, createTicket, getRun, getSetting, getTicket, listEventsForProject, setProjectScopePath, setSetting } from './store.ts';
import { deriveTestCliCwd, testTempRoot } from './testSupport.ts';
import { knownModelIds } from './pricing.ts';

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
  // Batch 19 mini-phase 1A: 'PATCH' joins 'GET'/'POST' for `PATCH
  // /profiles/{id}` (profile set).
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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

// Ruling 35's own routes (GET/PATCH /settings, PATCH /projects/{id}, PUT
// /projects/{id}/scope) are covered IN-PROCESS, the same way the SSE
// closeAllStreams test above already does it: a real http.Server built
// directly from createRequestHandler's own `handle`, no CLI subprocess. The
// auth test above needs a real spawned daemon (it checks stdout/stderr never
// leak the token); these routes do not, so the lighter, faster path is used
// here.
const TEST_TOKEN = 'settings-test-token';

async function startTestServer(db: Db): Promise<{ port: number; close: () => Promise<void> }> {
  const stubLoop: DaemonLoop = {
    live: new Map(),
    liveRuns: new Map(),
    stop: async () => ({ cancelled: [] }),
    forceTick: async () => ({ started: [] }),
    cancelTicket: async () => 'not_running',
  };
  const requestHandler = createRequestHandler({
    db,
    adapter: new FakeAdapter(),
    loop: stubLoop,
    token: TEST_TOKEN,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    stateDir: testRoot.root,
  });
  const server = createServer(requestHandler.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async close() {
      requestHandler.closeAllStreams();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('GET /settings reports only what has been set; PATCH /settings sets (string OR number for the cap), clears (null), validates ALL fields before writing ANY, and refuses an unknown key or a bad value in one sentence', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startTestServer(db);
  try {
    // Mutating routes stay behind the token like every existing one.
    const wrongToken = await api(port, 'wrong-token', 'PATCH', '/settings', { max_parallel_workers: '2' });
    assert.equal(wrongToken.status, 401);

    const empty = await api(port, TEST_TOKEN, 'GET', '/settings');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, {});

    // Review fix #9: max_parallel_workers accepted as a JSON NUMBER, not
    // only a string -- stored as its canonical decimal string either way.
    const set = await api(port, TEST_TOKEN, 'PATCH', '/settings', { default_manager_model: 'claude-opus-5', max_parallel_workers: 3 });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.json, { default_manager_model: 'claude-opus-5', max_parallel_workers: '3' });

    const unknownKey = await api(port, TEST_TOKEN, 'PATCH', '/settings', { not_a_real_key: 'x' });
    assert.equal(unknownKey.status, 400);
    assert.equal((unknownKey.json as { error: string }).error.split('.').length <= 2, true, 'refusal must be one sentence');

    const badModel = await api(port, TEST_TOKEN, 'PATCH', '/settings', { default_verifier_model: 'not-a-real-model' });
    assert.equal(badModel.status, 400);

    const badCap = await api(port, TEST_TOKEN, 'PATCH', '/settings', { max_parallel_workers: '0' });
    assert.equal(badCap.status, 400);

    // Review fix #9: non-canonical forms Number() would happily parse.
    for (const nonCanonical of ['0x3', '1e1', ' 3']) {
      const bad = await api(port, TEST_TOKEN, 'PATCH', '/settings', { max_parallel_workers: nonCanonical });
      assert.equal(bad.status, 400, `${nonCanonical} must be refused`);
    }

    // Review fix #3: a valid field alongside an invalid one must not leave
    // the valid one written -- the whole request is validated FIRST.
    const partial = await api(port, TEST_TOKEN, 'PATCH', '/settings', {
      default_manager_model: 'claude-fable-5-1',
      max_parallel_workers: 'bogus',
    });
    assert.equal(partial.status, 400);
    assert.equal(getSetting(db, 'default_manager_model'), 'claude-opus-5', 'must be untouched by the rejected request');
    assert.equal(getSetting(db, 'max_parallel_workers'), '3', 'must be untouched by the rejected request');

    // Review fix #8: a null/non-object body is a clean 400, not a JS error.
    const nullBody = await api(port, TEST_TOKEN, 'PATCH', '/settings', null);
    assert.equal(nullBody.status, 400);
    const arrayBody = await api(port, TEST_TOKEN, 'PATCH', '/settings', [1, 2, 3]);
    assert.equal(arrayBody.status, 400);

    const clear = await api(port, TEST_TOKEN, 'PATCH', '/settings', { default_manager_model: null });
    assert.equal(clear.status, 200, clear.text);
    assert.equal(getSetting(db, 'default_manager_model'), null);
    assert.equal(getSetting(db, 'max_parallel_workers'), '3', 'clearing one key must not touch another');
  } finally {
    await close();
  }
});

test('PATCH /projects/{id} accepts maxParallel/managerModel/verifierModel/defaultModel, null clears an override, validates ALL fields before writing ANY, and refuses an unknown model, maxParallel: 0, an unknown field, or a null/non-object body with one sentence', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', defaultModel: 'claude-sonnet-5' });
  const { port, close } = await startTestServer(db);
  try {
    const wrongToken = await api(port, 'wrong-token', 'PATCH', `/projects/${project.id}`, { maxParallel: 2 });
    assert.equal(wrongToken.status, 401);

    const ok = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { maxParallel: 2, managerModel: 'claude-opus-5' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((ok.json as { maxParallelWorkers: number }).maxParallelWorkers, 2);
    assert.equal((ok.json as { managerModel: string }).managerModel, 'claude-opus-5');

    // GET /projects confirms the change is visible on the project list too.
    const list = await api(port, TEST_TOKEN, 'GET', '/projects');
    assert.equal(list.status, 200);
    const listed = (list.json as Array<{ id: string; maxParallelWorkers?: number; managerModel?: string | null }>).find(
      (p) => p.id === project.id
    );
    assert.ok(listed, 'the project must appear in GET /projects');
    assert.equal(listed!.maxParallelWorkers, 2, 'GET /projects must reflect the patched maxParallel');
    assert.equal(listed!.managerModel, 'claude-opus-5', 'GET /projects must reflect the patched managerModel');

    // Review fix #2: {maxParallel: 2, managerModel: "bogus"} -- maxParallel
    // alone is perfectly valid, but the WHOLE request must be validated
    // before anything is written, so the earlier successful maxParallel: 2
    // from above must still read back as 2, not overwritten to a NEW
    // (also valid) number here, and nothing from this rejected call lands.
    const partial = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { maxParallel: 9, managerModel: 'bogus' });
    assert.equal(partial.status, 400, partial.text);
    const afterPartial = await api(port, TEST_TOKEN, 'GET', '/projects');
    const listedAfterPartial = (afterPartial.json as Array<{ id: string; maxParallelWorkers?: number; managerModel?: string | null }>).find(
      (p) => p.id === project.id
    );
    assert.equal(listedAfterPartial!.maxParallelWorkers, 2, 'maxParallel must be UNCHANGED by the rejected request');
    assert.equal(listedAfterPartial!.managerModel, 'claude-opus-5', 'managerModel must be UNCHANGED by the rejected request');

    const clearOverride = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { managerModel: null });
    assert.equal(clearOverride.status, 200, clearOverride.text);
    assert.equal((clearOverride.json as { managerModel: string | null }).managerModel, null);

    const unknownModel = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { verifierModel: 'not-a-real-model' });
    assert.equal(unknownModel.status, 400);
    assert.equal((unknownModel.json as { error: string }).error.length > 0, true);

    const zeroCap = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { maxParallel: 0 });
    assert.equal(zeroCap.status, 400);

    const unknownField = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { nope: 'x' });
    assert.equal(unknownField.status, 400);
    assert.equal((unknownField.json as { error: string }).error.includes('nope'), true);

    const clearedDefault = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, { defaultModel: null });
    assert.equal(clearedDefault.status, 400, 'defaultModel has no override to clear');

    // Review fix #8: a null/non-object body is a clean 400, not a JS error.
    const nullBody = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, null);
    assert.equal(nullBody.status, 400);
    const stringBody = await api(port, TEST_TOKEN, 'PATCH', `/projects/${project.id}`, 'oops');
    assert.equal(stringBody.status, 400);
  } finally {
    await close();
  }
});

test('PUT /projects/{id}/scope writes atomically (temp file + rename): GET returns the same text back, records a scope_updated event marked as the owner\'s edit, is refused with no scope_path set, a null/non-object body is a clean 400, and it stays behind the token', async () => {
  const db = openDb(':memory:');
  const noScope = createProject(db, { name: 'no-scope' });
  const scopePath = join(testRoot.root, 'scope-put-test', 'SCOPE.md');
  const withScope = createProject(db, { name: 'with-scope' });
  setProjectScopePath(db, withScope.id, scopePath);
  const { port, close } = await startTestServer(db);
  try {
    const wrongToken = await api(port, 'wrong-token', 'PUT', `/projects/${withScope.id}/scope`, { scopeText: 'x' });
    assert.equal(wrongToken.status, 401);

    const refused = await api(port, TEST_TOKEN, 'PUT', `/projects/${noScope.id}/scope`, { scopeText: 'x' });
    assert.equal(refused.status, 400);

    const nullBody = await api(port, TEST_TOKEN, 'PUT', `/projects/${withScope.id}/scope`, null);
    assert.equal(nullBody.status, 400);

    const put = await api(port, TEST_TOKEN, 'PUT', `/projects/${withScope.id}/scope`, { scopeText: 'First draft.' });
    assert.equal(put.status, 200, put.text);

    const get = await api(port, TEST_TOKEN, 'GET', `/projects/${withScope.id}/scope`);
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, { scopeText: 'First draft.', status: 'present' });

    // No tmp file left lying around next to the real one after a clean write.
    assert.equal(readFileSync(scopePath, 'utf8'), 'First draft.');
    assert.throws(() => readFileSync(`${scopePath}.tmp`, 'utf8'));

    // Review fix #5: reuses managerApply.ts's own summarizeScopeChange, and
    // is marked as the OWNER's edit (not the Manager's) so the two origins
    // are distinguishable in the activity feed the Manager also reads from.
    const events = listEventsForProject(db, withScope.id).filter((e) => e.eventType === 'scope_updated');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { summary: 'scope written (1 line(s))', source: 'owner' });
  } finally {
    await close();
  }
});

// Review fix #1: without `--max-parallel` (startTestServer's requestHandler
// is built with no `machineCapFlag`, matching a real `serve` with no flag),
// GET /health and GET /board used to report `cap: null` FOREVER -- resolved
// once, wrong, at createRequestHandler() time. Both now call store.ts's
// resolveMachineCap fresh on every request; this proves it by reading twice,
// across a `config set` in between, with NO server restart -- the exact same
// "no restart" claim daemon.ts's own admission fix makes, now true for the
// REPORTED cap too, not just the enforced one.
test('GET /health and GET /board report the machine cap resolved fresh (flag ?? settings ?? 1), never null, and change without a server restart', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const { port, close } = await startTestServer(db);
  try {
    const healthBefore = (await api(port, TEST_TOKEN, 'GET', '/health')).json as { slots: { cap: number | null } };
    assert.equal(healthBefore.slots.cap, 1, 'the last-resort default, not null');

    const boardBefore = (await api(port, TEST_TOKEN, 'GET', `/board?project=${project.id}`)).json as {
      slots: { cap: number | null };
    };
    assert.equal(boardBefore.slots.cap, 1);

    setSetting(db, 'max_parallel_workers', '5');

    const healthAfter = (await api(port, TEST_TOKEN, 'GET', '/health')).json as { slots: { cap: number | null } };
    assert.equal(healthAfter.slots.cap, 5, 'the SAME running server must reflect the new setting on its very next read');

    const boardAfter = (await api(port, TEST_TOKEN, 'GET', `/board?project=${project.id}`)).json as {
      slots: { cap: number | null };
    };
    assert.equal(boardAfter.slots.cap, 5);
  } finally {
    await close();
  }
});

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

// Ruling 36 (batch 19, mini-phase 2B), acceptance 5: `POST /tickets/{id}/decide`
// accepts `{ answer }` or `{ answers }`, passed straight through to decide()
// -- both, neither, or a wrong count is a 400 carrying decide()'s own
// one-sentence message (toApiError already maps DecideError to 400).
test('POST /tickets/{id}/decide accepts answer or answers, and rejects both/neither/a wrong count with 400', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'decide-answer-answers-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await runCli(['ticket', 'add', '--project', project.id, '--title', 'T', '--state-dir', stateDir, '--json']);
    const ticket = JSON.parse(ticketRes.stdout);

    const handle = spawnServe([
      '--state-dir', stateDir,
      '--tick-interval', '30',
      '--adapter', 'fake',
      '--fake-outcome', `${ticket.id}=needs_user_decision`,
      '--json',
    ]);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST', path: string, body?: unknown) => api(info.port, fileInfo.token, method, path, body);

      const tickRes = await call('POST', '/tick', { project: project.id });
      assert.equal(tickRes.status, 200, JSON.stringify(tickRes.json));
      const boardAfterTick = (await call('GET', `/board?project=${project.id}`)).json as { tickets: Array<{ id: string; status: string }> };
      assert.equal(boardAfterTick.tickets.find((t) => t.id === ticket.id)?.status, 'BLOCKED', 'the fake-scripted needs_user_decision outcome must land the ticket BLOCKED before decide is exercised');

      const neither = await call('POST', `/tickets/${ticket.id}/decide`, {});
      assert.equal(neither.status, 400);

      const both = await call('POST', `/tickets/${ticket.id}/decide`, { answer: 'a', answers: ['a'] });
      assert.equal(both.status, 400);

      const wrongCount = await call('POST', `/tickets/${ticket.id}/decide`, { answers: ['a', 'b'] });
      assert.equal(wrongCount.status, 400);
      assert.match((wrongCount.json as { error: string }).error, /has 1 pending question/, 'the message must name the real pending-question count (1)');

      const ok = await call('POST', `/tickets/${ticket.id}/decide`, { answer: 'the real answer' });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal((ok.json as { status: string }).status, 'READY');
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
// Batch 16 item 6: the route's own field is camelCase (`expectedArtifacts`),
// so that is the name its error must use -- not the Manager's snake_case
// `expected_artifacts`, which a caller of THIS route never wrote.
test('POST /tickets: an unknown expectedArtifacts kind is refused naming the route\'s own camelCase field, never the Manager\'s snake_case one', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'kind-name-'));
  try {
    const project = JSON.parse((await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json'])).stdout);
    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const res = await api(info.port, fileInfo.token, 'POST', '/tickets', {
        project: project.id,
        title: 't',
        expectedArtifacts: [{ kind: 'file', path: 'a.md' }, { kind: 'nonsense' }],
      });
      assert.equal(res.status, 400);
      const message = (res.json as { error: string }).error;
      assert.match(message, /expectedArtifacts\[1\]\.kind "nonsense"/);
      assert.ok(!message.includes('expected_artifacts'), message);
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

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
      // Batch 19 (ruling 39, amended) widened slots with capFlag: this daemon
      // was started with --max-parallel 3, so the flag is 3 as well.
      assert.deepEqual(slots, { used: 1, cap: 3, capFlag: 3 });
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
    liveRuns: new Map(),
    stop: async () => ({ cancelled: [] }),
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
    stateDir: testRoot.root,
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

// --- Batch 19 mini-phase 1A: worker profile routes ----------------------

// Review fix (Low 10): the three new MUTATING routes refuse without a token,
// same as every other mutating route (the auth test above only covers
// /health and /tick).
// Re-review fix (Low 5): the previous version only proved 401-without-a-
// token, which the global auth gate (checked before routing, daemonApi.ts)
// gives for free on ANY path, real or not -- it never proved these three
// routes actually EXIST and are wired to real handlers. Each assertion pair
// here proves both: 401 with no token, and something other than 401 (the
// route's own real status, 400/404/201/200 depending on the body) with a
// valid one -- a typo'd path or an unwired route would fail the SECOND half
// even though the first half still passed.
test('POST /profiles, PATCH /profiles/{id} and POST /profiles/{id}/retire: 401 without a token, and a real (non-401) status with a valid one', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'profiles-auth-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
  try {
    const info = await handle.waitForListening();
    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;

    const createBody = { name: 'AuthCheck', model: 'claude-sonnet-5', purpose: 'p' };
    const noToken = await api(info.port, '', 'POST', '/profiles', createBody);
    assert.equal(noToken.status, 401);
    const withToken = await api(info.port, fileInfo.token, 'POST', '/profiles', createBody);
    assert.notEqual(withToken.status, 401, 'a valid token must reach the real route, not another 401');
    assert.equal(withToken.status, 201, withToken.text);
    const created = withToken.json as { id: string };

    const patchNoToken = await api(info.port, '', 'PATCH', `/profiles/${created.id}`, { name: 'AuthCheck2' });
    assert.equal(patchNoToken.status, 401);
    const patchWithToken = await api(info.port, fileInfo.token, 'PATCH', `/profiles/${created.id}`, { name: 'AuthCheck2' });
    assert.notEqual(patchWithToken.status, 401);
    assert.equal(patchWithToken.status, 200, patchWithToken.text);

    const retireNoToken = await api(info.port, '', 'POST', `/profiles/${created.id}/retire`);
    assert.equal(retireNoToken.status, 401);
    const retireWithToken = await api(info.port, fileInfo.token, 'POST', `/profiles/${created.id}/retire`);
    assert.notEqual(retireWithToken.status, 401);
    assert.equal(retireWithToken.status, 200, retireWithToken.text);
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Batch 19 ruling 39, amended: `slots.capFlag` says whether this daemon was
// started with --max-parallel, because the cap alone cannot: with no setting
// saved, a cap of 1 is `--max-parallel 1` OR the fallback. Both daemons below
// answer cap 1; only capFlag tells them apart.
test('GET /board and GET /health carry slots.capFlag: the serve --max-parallel value, or null without one', async () => {
  for (const [args, flag] of [[['--max-parallel', '1'], 1], [[], null]] as const) {
    const stateDir = mkdtempSync(join(testRoot.root, 'capflag-'));
    const project = JSON.parse((await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json'])).stdout) as { id: string };
    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json', ...args]);
    try {
      const info = await handle.waitForListening();
      const token = (JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo).token;
      const board = (await api(info.port, token, 'GET', `/board?project=${project.id}`)).json as { slots: { cap: number; capFlag: number | null } };
      assert.deepEqual([board.slots.cap, board.slots.capFlag], [1, flag], `serve ${args.join(' ') || '(no flag)'}`);
      const health = (await api(info.port, token, 'GET', '/health')).json as { slots: { capFlag: number | null } };
      assert.equal(health.slots.capFlag, flag);
    } finally {
      await handle.kill();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

// Batch 19 ruling 38, amended: the page's "Add a profile" select reads the
// models the daemon knows from here, so a model no profile uses yet is still
// choosable. Read-only, and behind the token like every other data route.
test('GET /models returns the known model ids from pricing.ts with a token, and 401 without one', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startTestServer(db);
  try {
    const noToken = await api(port, '', 'GET', '/models');
    assert.equal(noToken.status, 401);
    const withToken = await api(port, TEST_TOKEN, 'GET', '/models');
    assert.equal(withToken.status, 200, withToken.text);
    assert.deepEqual(withToken.json, knownModelIds());
    assert.ok((withToken.json as string[]).length >= 4, 'the model list came back nearly empty');
  } finally {
    await close();
    db.close();
  }
});

test('GET /profiles reports the six seeded profiles, idle; POST /profiles creates one; PATCH /profiles/{id} renames it without changing its id; POST /profiles/{id}/retire hides it', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'profiles-crud-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
  try {
    const info = await handle.waitForListening();
    const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
    const call = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
      api(info.port, fileInfo.token, method, path, body);

    const listRes = await call('GET', '/profiles');
    assert.equal(listRes.status, 200);
    const seeded = listRes.json as Array<{ id: string; name: string; model: string; status: string; ticketId: string | null }>;
    assert.deepEqual(
      seeded.map((p) => [p.name, p.model, p.status, p.ticketId]),
      [
        ['Architect', 'claude-opus-5', 'idle', null],
        ['Developer', 'claude-sonnet-5', 'idle', null],
        ['Reviewer', 'claude-sonnet-5', 'idle', null],
        ['Tester', 'claude-sonnet-5', 'idle', null],
        ['Researcher', 'claude-haiku-4-5-20251001', 'idle', null],
        ['Scribe', 'claude-haiku-4-5-20251001', 'idle', null],
      ]
    );

    const createRes = await call('POST', '/profiles', { name: 'Scout', model: 'claude-haiku-4-5-20251001', purpose: 'quick lookups' });
    assert.equal(createRes.status, 201, createRes.text);
    const created = createRes.json as { id: string; name: string; policy: string };
    assert.equal(created.policy, '', 'policy defaults to empty text when omitted');

    const badModelRes = await call('POST', '/profiles', { name: 'Bad', model: 'not-a-real-model', purpose: 'p' });
    assert.equal(badModelRes.status, 400);
    assert.match((badModelRes.json as { error: string }).error, /unknown model/);

    const patchRes = await call('PATCH', `/profiles/${created.id}`, { name: 'Scout2' });
    assert.equal(patchRes.status, 200, patchRes.text);
    const patched = patchRes.json as { id: string; name: string };
    assert.equal(patched.id, created.id, 'renaming must keep the same id');
    assert.equal(patched.name, 'Scout2');

    const patchMissingRes = await call('PATCH', '/profiles/prof_ghost', { name: 'X' });
    assert.equal(patchMissingRes.status, 404);

    const retireRes = await call('POST', `/profiles/${created.id}/retire`);
    assert.equal(retireRes.status, 200, retireRes.text);
    assert.ok((retireRes.json as { retiredAt: string | null }).retiredAt != null);

    const retireMissingRes = await call('POST', '/profiles/prof_ghost/retire');
    assert.equal(retireMissingRes.status, 404);

    const afterRetireRes = await call('GET', '/profiles');
    const namesAfter = (afterRetireRes.json as Array<{ name: string }>).map((p) => p.name);
    assert.ok(!namesAfter.includes('Scout2'), 'a retired profile must not appear in GET /profiles');
  } finally {
    await handle.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Acceptance line 3 and the board contract (addendum section 5: "Board
// ticket rows carry profile: { id, name } | null"), exercised over the real
// route rather than only store.ts's own unit test.
test('POST /tickets with profile is mutually exclusive with model, and GET /board carries { id, name } for an assigned profile', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'profiles-ticket-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout) as { id: string };

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      const info = await handle.waitForListening();
      const fileInfo = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
      const call = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
        api(info.port, fileInfo.token, method, path, body);

      const bothRes = await call('POST', '/tickets', { project: project.id, title: 'both', profile: 'Developer', model: 'claude-opus-5' });
      assert.equal(bothRes.status, 400);
      assert.match((bothRes.json as { error: string }).error, /choose a profile or a model, not both/);

      const profileRes = await call('POST', '/tickets', { project: project.id, title: 'profiled', profile: 'Developer' });
      assert.equal(profileRes.status, 201, profileRes.text);
      const ticket = profileRes.json as { id: string; profileId: string };
      assert.ok(ticket.profileId);

      const boardRes = await call('GET', `/board?project=${project.id}`);
      assert.equal(boardRes.status, 200);
      const board = boardRes.json as { tickets: Array<{ id: string; profile: { id: string; name: string } | null }> };
      const row = board.tickets.find((t) => t.id === ticket.id);
      assert.deepEqual(row?.profile, { id: ticket.profileId, name: 'Developer' });
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- Batch 19 mini-phase 4 (ruling 40): GET /runs/{id}/live ----------------
// In-process (createRequestHandler + a real http.Server), like the settings
// routes above -- but with a REAL startDaemonLoop, a REAL FakeAdapter, and a
// REAL sqlite FILE (never `:memory:`), not the stubLoop those tests use. The
// live map is scheduler-owned state that only a real scheduling pass ever
// writes, and acceptance line 3 requires reading the database FILE itself
// off disk, which `:memory:` has none of.
const LIVE_TEST_TOKEN = 'live-drilldown-test-token';
const liveTestRoot = testTempRoot('live-drilldown');
after(liveTestRoot.cleanup);

interface LiveTestServer {
  port: number;
  db: Db;
  dbPath: string;
  stateDir: string;
  project: { id: string };
  adapter: FakeAdapter;
  loop: DaemonLoop;
  close: () => Promise<void>;
}

async function startLiveTestServer(): Promise<LiveTestServer> {
  const stateDir = mkdtempSync(join(liveTestRoot.root, 'run-'));
  const dbDir = join(stateDir, 'db');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'magarine.db');
  const db = openDb(dbPath);
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new FakeAdapter();

  const loop = startDaemonLoop({
    readiness: 'skip',
    db,
    adapter,
    maxParallelWorkers: 1,
    artifactsDir: join(stateDir, 'artifacts'),
    tickIntervalMs: 20,
  });

  const requestHandler = createRequestHandler({
    db,
    adapter,
    loop,
    token: LIVE_TEST_TOKEN,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    stateDir,
  });
  const server = createServer(requestHandler.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    db,
    dbPath,
    stateDir,
    project,
    adapter,
    loop,
    async close() {
      requestHandler.closeAllStreams();
      await loop.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test('GET /runs/{id}/live: 401 with a wrong token, and 401 with no Authorization header at all', async () => {
  const server = await startLiveTestServer();
  try {
    const wrongRes = await api(server.port, 'wrong-token', 'GET', '/runs/whatever/live');
    assert.equal(wrongRes.status, 401);

    // Batch 19 mini-phase 4 fix round (reviewer Low, daemonApi.test.ts:1575):
    // a wrong token exercises isAuthorized's mismatch branch, not its
    // missing-header branch (`typeof header !== 'string'`) -- api('', ...)
    // sends no Authorization header at all (see api()'s own `token ? {...}
    // : {}`), which this route had never actually been tested against.
    const noHeaderRes = await api(server.port, '', 'GET', '/runs/whatever/live');
    assert.equal(noHeaderRes.status, 401);
  } finally {
    await server.close();
  }
});

test('GET /runs/{id}/live: 404 for an unknown run id', async () => {
  const server = await startLiveTestServer();
  try {
    const res = await api(server.port, LIVE_TEST_TOKEN, 'GET', '/runs/does-not-exist/live');
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

// Batch 19 mini-phase 4 fix round (reviewer Medium, daemonApi.ts:605,
// amending ruling 40): a RUNNING run that has not yet reported any tool use
// (a hung worker before its first tool call -- a stuck auth prompt, a CLI
// that never starts) must be 200 with `tool: null`, not 404 -- 404 hides the
// one measurement (`lastProgressAt`) the owner needs exactly when a worker
// looks stuck this early. 404 is reserved for an unknown run id and one that
// has already settled.
test('GET /runs/{id}/live: 200 with tool null and lastProgressAt for a RUNNING run that has not reported a tool use yet', async () => {
  const server = await startLiveTestServer();
  try {
    const ticket = createTicket(server.db, { projectId: server.project.id, title: 'hangs before its first tool call', workspaceType: 'NONE' });
    server.adapter.setScript(ticket.id, { kind: 'hang' });
    // Deliberately no setLiveToolUse call: this run must never emit a live signal.

    const tickRes = await api(server.port, LIVE_TEST_TOKEN, 'POST', '/tick', { project: server.project.id });
    const runId = (tickRes.json as { started: Array<{ runId: string }> }).started[0]!.runId;

    const deadline = Date.now() + 2000;
    let res = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    while (getTicket(server.db, ticket.id)!.status !== 'IN_PROGRESS' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    res = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);

    assert.equal(res.status, 200, 'a RUNNING run with no tool use yet must be 200, never 404');
    const body = res.json as { tool: string | null; detail: string | null; since: string | null; lastProgressAt: string };
    assert.equal(body.tool, null);
    assert.equal(body.detail, null);
    assert.equal(body.since, null);
    assert.equal(typeof body.lastProgressAt, 'string');
  } finally {
    await server.close();
  }
});

test('GET /runs/{id}/live returns {tool, detail, since, lastProgressAt} while the run is live, and 404 once it settles', async () => {
  const server = await startLiveTestServer();
  try {
    const ticket = createTicket(server.db, { projectId: server.project.id, title: 'runs a command', workspaceType: 'NONE' });
    server.adapter.setLiveToolUse(ticket.id, { tool: 'Bash', detail: 'echo live-drilldown-ok', delayMs: 0 });
    server.adapter.setScript(ticket.id, { kind: 'succeed', delayMs: 300 });

    const tickRes = await api(server.port, LIVE_TEST_TOKEN, 'POST', '/tick', { project: server.project.id });
    assert.equal(tickRes.status, 200);
    const runId = (tickRes.json as { started: Array<{ ticketId: string; runId: string }> }).started[0]!.runId;

    // Poll until the live signal has actually landed -- the FakeAdapter's
    // own timer, however short, is still asynchronous.
    const deadline1 = Date.now() + 2000;
    let liveRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    while (liveRes.status !== 200 && Date.now() < deadline1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      liveRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    }
    assert.equal(liveRes.status, 200);
    const info = liveRes.json as { tool: string; detail: string; since: string; lastProgressAt: string };
    assert.equal(info.tool, 'Bash');
    assert.equal(info.detail, 'echo live-drilldown-ok');
    assert.equal(typeof info.since, 'string');
    assert.equal(typeof info.lastProgressAt, 'string');

    // Wait for the scripted 'succeed' (delayMs: 300) to settle the run.
    const deadline2 = Date.now() + 3000;
    while (getTicket(server.db, ticket.id)!.status === 'IN_PROGRESS' && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(getTicket(server.db, ticket.id)!.status, 'IN_PROGRESS', 'sanity: the run must have settled');

    const afterRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    assert.equal(afterRes.status, 404, 'a settled run must 404, per acceptance line 2');
  } finally {
    await server.close();
  }
});

// Acceptance line 3, verbatim: after a run whose worker used Bash with a
// recognisable string, that string must appear in NO event payload, NO
// activity row, NO stream frame and no file the daemon wrote -- checked
// against the real, on-disk sqlite FILE (not the API), the real HTTP
// /activity route, and a real SSE /events connection, all against the SAME
// run this test also proves the live route DOES show the secret on, so a
// future change that accidentally routes `detail` into the persisted path is
// caught here, not just inferred from the live route working.
test('acceptance 3: a Bash command with a recognisable secret is shown live, but never appears in the events table (including the terminal event), the run row, the activity feed, the stream, or any file on disk -- checked AFTER the run settles', async () => {
  const server = await startLiveTestServer();
  try {
    const SECRET = 'MAGARINE_DRILLDOWN_SECRET_6f19a2';
    const ticket = createTicket(server.db, { projectId: server.project.id, title: 'runs a secret command', workspaceType: 'NONE' });
    server.adapter.setLiveToolUse(ticket.id, { tool: 'Bash', detail: `export TOKEN=${SECRET} && curl https://example.invalid`, delayMs: 0 });
    // Batch 19 mini-phase 4 fix round (reviewer Medium, daemonApi.test.ts:1649):
    // a 'progress' script never terminates, so the run's own terminal event
    // (worker_done_for_verification -> DONE via the auto-passing verifier)
    // and its run row never existed for a mutation to leak `detail` into --
    // this test could not have caught that class of bug. 'succeed' actually
    // settles the ticket (worker done -> REVIEW -> the fake verifier's own
    // default verify_pass -> DONE), so both are real and get scanned below.
    server.adapter.setScript(ticket.id, { kind: 'succeed', delayMs: 150 });

    const tickRes = await api(server.port, LIVE_TEST_TOKEN, 'POST', '/tick', { project: server.project.id });
    const runId = (tickRes.json as { started: Array<{ runId: string }> }).started[0]!.runId;

    // Confirm the live route really does carry the secret before proving it
    // never leaks anywhere else -- otherwise a broken live channel would
    // make this test pass for the wrong reason (nothing to leak).
    const deadline1 = Date.now() + 2000;
    let liveRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    while (liveRes.status !== 200 && Date.now() < deadline1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      liveRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    }
    assert.equal(liveRes.status, 200);
    assert.ok((liveRes.json as { detail: string }).detail.includes(SECRET), 'sanity: the live route must show the secret');

    // Now wait for the ticket to actually settle -- DONE, through the worker
    // 'succeed' script and the fake verifier's default pass.
    const deadline2 = Date.now() + 3000;
    while (getTicket(server.db, ticket.id)!.status !== 'DONE' && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(getTicket(server.db, ticket.id)!.status, 'DONE', 'sanity: the run must have actually settled');

    // The live route must 404 now (acceptance 2), which also proves nothing
    // is still holding the command in memory to leak from.
    const afterLiveRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/runs/${runId}/live`);
    assert.equal(afterLiveRes.status, 404);

    // Force the WAL to flush into the main db file -- WAL mode (db/index.ts)
    // defers writes into a sidecar `-wal` file, so a plain read of the .db
    // file alone could miss a write that landed only in the WAL and still
    // call this test a false pass.
    server.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    // 1) The events table, read straight from the store, not the API --
    // INCLUDING the terminal event (worker_done_for_verification and
    // whatever the verifier's own pass records), which only exists now that
    // the run actually settled.
    const events = listEventsForProject(server.db, server.project.id);
    assert.ok(events.length > 0, 'sanity: some events must have been recorded');
    assert.ok(
      events.some((e) => e.eventType === 'worker_done_for_verification'),
      'sanity: the terminal worker event must actually exist for this test to be checking anything'
    );
    for (const event of events) {
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes(SECRET), false, `event row leaked the secret: ${serialized}`);
    }

    // 2) The run row itself, read straight from the store -- usage_json and
    // every other column, not just the events that reference it.
    const runRow = getRun(server.db, runId)!;
    assert.equal(JSON.stringify(runRow).includes(SECRET), false, `the run row leaked the secret: ${JSON.stringify(runRow)}`);

    // 3) The raw database FILE on disk, byte for byte -- not the API, not
    // the store layer, the file itself.
    const dbBytes = readFileSync(server.dbPath, 'latin1');
    assert.equal(dbBytes.includes(SECRET), false, 'the sqlite database file itself must not contain the secret');

    // 4) The activity feed, over the real HTTP route.
    const activityRes = await api(server.port, LIVE_TEST_TOKEN, 'GET', `/activity?project=${server.project.id}&all=true`);
    assert.equal(activityRes.status, 200);
    assert.equal(activityRes.text.includes(SECRET), false, 'the activity feed must not contain the secret');

    // 5) The SSE stream.
    const controller = new AbortController();
    const streamFrames: string[] = [];
    const consumed = (async () => {
      for await (const event of consumeEventStream({ port: server.port, token: LIVE_TEST_TOKEN }, { since: 0, signal: controller.signal })) {
        streamFrames.push(JSON.stringify(event));
        if (streamFrames.length >= events.length) break;
      }
    })();
    await Promise.race([consumed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    controller.abort();
    for (const frame of streamFrames) {
      assert.equal(frame.includes(SECRET), false, `an SSE stream frame leaked the secret: ${frame}`);
    }

    // 6) Every file the daemon wrote under its own state directory
    // (database file + WAL/SHM sidecars, artifacts directory, workspace
    // temp files) -- a blanket sweep, not just the specific files named
    // above, so a future write site this test's author did not anticipate
    // is still caught.
    const allEntries = readdirSync(server.stateDir, { recursive: true }) as string[];
    for (const rel of allEntries) {
      const full = join(server.stateDir, rel);
      if (!statSync(full).isFile()) continue;
      const bytes = readFileSync(full, 'latin1');
      assert.equal(bytes.includes(SECRET), false, `file ${full} leaked the secret`);
    }
  } finally {
    await server.close();
  }
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';
import { deriveTestCliCwd, testTempRoot, pinnedFakeEnv } from './testSupport.ts';

// Batch 16 item 6 (handover item 8): `status` with no `--project` used to error
// ("no such project: "). It now answers the question a person asks first --
// is a daemon running, where, and how busy -- or says there is none and
// names the command that starts one.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const testRoot = testTempRoot('status-daemon');
after(testRoot.cleanup);

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    let stderr = '';
    p.onStdout((c) => (stdout += c));
    p.onStderr((c) => (stderr += c));
    p.wait().then((r) => resolve({ code: r.code, stdout, stderr }));
  });
}

test('status with no --project and no daemon says "no daemon running" and names the start command, exit 0', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'none-'));
  const res = await run(['status', '--state-dir', stateDir]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /no daemon running/);
  assert.match(res.stdout, /magarine serve/);
  const json = JSON.parse((await run(['status', '--state-dir', stateDir, '--json'])).stdout);
  assert.deepEqual(json, { daemon: null });
});

test('status with no --project against a live daemon reports the pid, port, page address and the slots in use of the machine ceiling', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'live-'));
  const created = await run(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
  const projectId = JSON.parse(created.stdout).id as string;
  const ticket = JSON.parse((await run(['ticket', 'add', '--project', projectId, '--title', 'hangs', '--state-dir', stateDir, '--json'])).stdout);

  const proc = spawnManaged({
    env: pinnedFakeEnv(),
    executable: process.execPath,
    args: [cliPath, 'serve', '--state-dir', stateDir, '--max-parallel', '3', '--tick-interval', '0.05', '--fake-script', `${ticket.id}=hang`, '--json'],
  });
  let stdout = '';
  proc.onStdout((c) => (stdout += c));
  try {
    const deadline = Date.now() + 10_000;
    let listening: { pid: number; port: number } | undefined;
    while (Date.now() < deadline && !listening) {
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) listening = JSON.parse(line);
      else await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(listening, 'serve never printed its listening line');

    let json: { daemon: { pid: number; port: number; page: string; slots: { used: number; cap: number | null } } | null } | undefined;
    while (Date.now() < deadline) {
      json = JSON.parse((await run(['status', '--state-dir', stateDir, '--json'])).stdout);
      if (json?.daemon?.slots.used === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(json, {
      daemon: { pid: listening.pid, port: listening.port, page: `http://127.0.0.1:${listening.port}/`, slots: { used: 1, cap: 3 } },
    });

    const text = (await run(['status', '--state-dir', stateDir])).stdout;
    assert.match(text, new RegExp(`pid ${listening.pid}`));
    assert.match(text, new RegExp(`127\.0\.0\.1:${listening.port}`));
    assert.match(text, new RegExp(`http://127\.0\.0\.1:${listening.port}/`));
    assert.match(text, /1 of 3 slots in use/);
    assert.ok(!/token/i.test(text), 'never prints the token');
  } finally {
    await proc.stop(200);
    await proc.wait();
  }
});

test('status --project still lists that project\'s tickets, and an unknown project still errors by name', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'project-'));
  const created = await run(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
  const projectId = JSON.parse(created.stdout).id as string;
  await run(['ticket', 'add', '--project', projectId, '--title', 'one', '--state-dir', stateDir, '--json']);
  const ok = await run(['status', '--project', projectId, '--state-dir', stateDir]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /one/);
  const bad = await run(['status', '--project', 'nope', '--state-dir', stateDir]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /no such project: nope/);
});

// Version skew, not hypothetical: a daemon started from a build older than
// this CLI answers /health WITHOUT `slots`. `status` must not turn that
// absence into a measurement ("0 of ? slots in use" would tell the owner no
// work is running while their workers are). A stub plays the daemon:
// `answers` is what its Nth /health call returns, the first being the
// liveness probe checkDaemonFile makes before `status` asks for anything.
async function statusAgainstStub(
  stateDir: string,
  answers: Array<{ status: number; body: unknown } | 'hang-up'>,
  extraArgs: string[] = []
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { createServer } = await import('node:http');
  const { writeDaemonFile } = await import('./daemon.ts');
  let calls = 0;
  const server = createServer((req, res) => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls++;
    if (answer === 'hang-up') {
      req.socket.destroy();
      return;
    }
    res.statusCode = answer.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  // pid: this process -- alive, and what the stub's /health reports, so the
  // liveness probe (which compares the two) accepts it as the daemon.
  writeDaemonFile(stateDir, { pid: process.pid, port, token: 'stub-token', startedAt: new Date().toISOString(), dbPath: join(stateDir, 'magarine.db') });
  try {
    return await run(['status', '--state-dir', stateDir, ...extraArgs]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('status against a daemon whose /health carries NO slots (older than this CLI) prints no numbers, says so, and --json carries slots: null', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'old-'));
  const health = { status: 200, body: { pid: process.pid, startedAt: new Date().toISOString(), uptimeMs: 1 } };
  const text = await statusAgainstStub(stateDir, [health]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /slots not reported/);
  assert.match(text.stdout, /predates this CLI/);
  assert.ok(!/slots in use/.test(text.stdout) && !/\d+ of \d+/.test(text.stdout), `no fabricated count: ${text.stdout}`);

  const json = JSON.parse((await statusAgainstStub(mkdtempSync(join(testRoot.root, 'old-json-')), [health], ['--json'])).stdout);
  assert.equal(json.daemon.slots, null, 'not reported is null, never zeros');
});

test('status: a /health that carries a count but no ceiling says the ceiling is not reported, rather than printing a placeholder', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'nocap-'));
  const health = { status: 200, body: { pid: process.pid, startedAt: new Date().toISOString(), uptimeMs: 1, slots: { used: 2, cap: null } } };
  const res = await statusAgainstStub(stateDir, [health]);
  assert.match(res.stdout, /2 slots in use \(ceiling not reported\)/);
  assert.ok(!res.stdout.includes('?'), res.stdout);
});

test('status: a non-2xx /health, or a daemon that vanishes after the liveness probe, is reported on stderr with exit 1 -- no slots clause, no stack trace', async () => {
  const probeOk = { status: 200, body: { pid: process.pid, startedAt: new Date().toISOString(), uptimeMs: 1 } };
  for (const second of [{ status: 500, body: { error: 'boom' } }, 'hang-up' as const]) {
    const stateDir = mkdtempSync(join(testRoot.root, 'fail-'));
    const res = await statusAgainstStub(stateDir, [probeOk, second]);
    assert.equal(res.code, 1, `${JSON.stringify(second)}: ${res.stdout}`);
    assert.ok(!/slots/.test(res.stdout), 'no slots clause on a failed answer');
    assert.ok(res.stderr.trim().length > 0, 'the failure is named on stderr');
    assert.ok(!/\n\s+at /.test(res.stderr), `no stack trace: ${res.stderr}`);
  }
});

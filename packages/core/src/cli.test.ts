import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';
import { testTempRoot } from './testSupport.ts';

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

// Batch 6 item 5: this file's own private root under the OS temp directory
// (testSupport.ts's testTempRoot), rather than every test creating its own
// prefixed directory directly inside the shared tmpdir() -- see that
// function's doc comment for why (batch-4-closeout.md section 5 item 2's
// flake). Every individual test below still gets its own mkdtemp'd
// subdirectory and its own try/finally cleanup; this only changes where in
// the filesystem hierarchy that subdirectory lives.
const testRoot = testTempRoot('cli');
after(testRoot.cleanup);

async function run(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], env: opts.env, cwd: opts.cwd });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  return { code: result.code, stdout, stderr };
}

test('CLI drives a project through project create, ticket add, dep add, and run --until-idle', async () => {
  const dir = mkdtempSync(join(testRoot.root,'magarine-cli-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'Demo', '--json', '--db', dbFile]);
    assert.equal(projectRes.code, 0, projectRes.stderr);
    const project = JSON.parse(projectRes.stdout);

    const t1Res = await run(['ticket', 'add', '--project', project.id, '--title', 'T1', '--json', '--db', dbFile]);
    const t1 = JSON.parse(t1Res.stdout);
    const t2Res = await run(['ticket', 'add', '--project', project.id, '--title', 'T2', '--json', '--db', dbFile]);
    const t2 = JSON.parse(t2Res.stdout);
    const t3Res = await run(['ticket', 'add', '--project', project.id, '--title', 'T3', '--json', '--db', dbFile]);
    const t3 = JSON.parse(t3Res.stdout);

    await run(['dep', 'add', '--project', project.id, '--ticket', t3.id, '--depends-on', t1.id, '--db', dbFile]);
    await run(['dep', 'add', '--project', project.id, '--ticket', t3.id, '--depends-on', t2.id, '--db', dbFile]);

    const runRes = await run([
      'run',
      '--until-idle',
      '--project',
      project.id,
      '--max-parallel',
      '2',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(runRes.code, 0, runRes.stderr);

    const statusRes = await run(['status', '--project', project.id, '--json', '--db', dbFile]);
    const tickets = JSON.parse(statusRes.stdout) as Array<{ id: string; status: string }>;
    assert.equal(tickets.length, 3);
    for (const t of tickets) {
      assert.equal(t.status, 'DONE', `${t.id} should be DONE`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a dependent ticket created before its blocker never runs ahead of it', async () => {
  // Exact repro reported against this CLI: create the dependent ticket
  // first (the order any real user is forced into, since you cannot name a
  // ticket in a dependency before it exists), then the blocker, then wire
  // the dependency. The dependent must not be runnable until the blocker
  // is DONE, regardless of creation order.
  const dir = mkdtempSync(join(testRoot.root,'magarine-cli-order-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'ordertest', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const dependentRes = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'DEPENDENT',
      '--json',
      '--db',
      dbFile,
    ]);
    const dependent = JSON.parse(dependentRes.stdout);

    const blockerRes = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'BLOCKER',
      '--json',
      '--db',
      dbFile,
    ]);
    const blocker = JSON.parse(blockerRes.stdout);

    await run([
      'dep',
      'add',
      '--project',
      project.id,
      '--ticket',
      dependent.id,
      '--depends-on',
      blocker.id,
      '--db',
      dbFile,
    ]);

    const beforeTick = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    const dependentBefore = beforeTick.find((t) => t.id === dependent.id)!;
    assert.equal(dependentBefore.status, 'OPEN', 'DEPENDENT must not be READY before BLOCKER is DONE');

    const tickRes = await run(['tick', '--project', project.id, '--json', '--db', dbFile]);
    const tickResult = JSON.parse(tickRes.stdout) as { started: Array<{ ticketId: string }> };
    assert.deepEqual(
      tickResult.started.map((s) => s.ticketId),
      [blocker.id],
      'only BLOCKER may start; DEPENDENT has not been unblocked yet'
    );

    const afterTick = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    const dependentAfter = afterTick.find((t) => t.id === dependent.id)!;
    assert.notEqual(dependentAfter.status, 'DONE', 'DEPENDENT must not have run to completion yet');

    await run(['run', '--until-idle', '--project', project.id, '--json', '--db', dbFile]);
    const final = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    for (const t of final) {
      assert.equal(t.status, 'DONE');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown flag is reported by name instead of failing deep inside a DB constraint', async () => {
  const dir = mkdtempSync(join(testRoot.root,'magarine-cli-flag-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);
    const t1 = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'A', '--json', '--db', dbFile])).stdout
    );
    const t2 = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'B', '--json', '--db', dbFile])).stdout
    );

    const res = await run([
      'dep',
      'add',
      '--project',
      project.id,
      '--ticket',
      t1.id,
      '--blocked-by', // typo for --depends-on
      t2.id,
      '--db',
      dbFile,
    ]);

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Unknown flag/);
    assert.match(res.stderr, /--blocked-by/);
    assert.match(res.stderr, /--depends-on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// State directory resolution (paths.ts), driven through the real CLI
// entry point rather than by calling resolveStateDir() directly, per
// batch-4-spec.md section 1 ruling 5: nothing is written under the current
// working directory unless the user asked for it.

test('--state-dir places the database under <state-dir>/magarine.db, not the current working directory', async () => {
  const stateDir = mkdtempSync(join(testRoot.root,'magarine-statedir-'));
  try {
    const res = await run(['project', 'create', '--name', 'P', '--state-dir', stateDir, '--json']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(stateDir, 'magarine.db')), 'db file must be created under --state-dir');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('MAGARINE_HOME places the database under <MAGARINE_HOME>/magarine.db when --state-dir and --db are both absent', async () => {
  const home = mkdtempSync(join(testRoot.root,'magarine-magarinehome-'));
  try {
    const res = await run(['project', 'create', '--name', 'P', '--json'], {
      env: { ...process.env, MAGARINE_HOME: home },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(home, 'magarine.db')), 'db file must be created under MAGARINE_HOME');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--db still overrides --state-dir as an explicit path', async () => {
  const stateDir = mkdtempSync(join(testRoot.root,'magarine-statedir-override-'));
  const dbFile = join(stateDir, 'custom.db');
  try {
    const res = await run(['project', 'create', '--name', 'P', '--state-dir', stateDir, '--db', dbFile, '--json']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(dbFile), '--db path must be used verbatim');
    assert.ok(
      !existsSync(join(stateDir, 'magarine.db')),
      '--db must not also produce a state-dir-relative magarine.db'
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('with no --state-dir, no MAGARINE_HOME, and no --db, the daemon falls back to <home>/.magarine and never writes under the process cwd', async () => {
  const fakeHome = mkdtempSync(join(testRoot.root,'magarine-fakehome-'));
  const scratchCwd = mkdtempSync(join(testRoot.root,'magarine-scratchcwd-'));
  try {
    const res = await run(['project', 'create', '--name', 'P', '--json'], {
      cwd: scratchCwd,
      // node:os.homedir() reads USERPROFILE on Windows, HOME on POSIX;
      // overriding both makes the fallback path deterministic regardless
      // of the host machine actually running this test. MAGARINE_HOME is
      // explicitly cleared so a value set on the host doesn't leak in.
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, MAGARINE_HOME: '' },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(
      existsSync(join(fakeHome, '.magarine', 'magarine.db')),
      'db file must land under <home>/.magarine/magarine.db'
    );
    assert.ok(
      !existsSync(join(scratchCwd, '.magarine')),
      'nothing may be written under the current working directory unless the user asked for it'
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});

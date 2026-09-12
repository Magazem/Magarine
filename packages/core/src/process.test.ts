import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolveExecutable, spawnManaged } from './process.ts';

// All process control (spawn, tree kill, timeout, shim resolution) lives in
// this one module so a future Linux port only has to touch this file. Every
// spawn here uses `process.execPath` (the Node binary running the test) as
// the executable, so these tests are portable without depending on any
// OS-specific command, except the tree-kill and shim tests below, which are
// Windows-only by nature of what they verify (see process.ts file header:
// the POSIX tree-kill path is written but UNTESTED until the Ubuntu leg).

const isWindows = process.platform === 'win32';

// Independent of anything spawnManaged/process.ts believes about its own
// children: asks the OS directly via `tasklist`. This is deliberately not
// the same mechanism process.ts uses internally, so a bug in process.ts
// can't also hide from the test that's supposed to catch it.
function isPidAliveWindows(pid: number): boolean {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
  return result.stdout.includes(String(pid));
}

async function waitForPidGoneWindows(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (isPidAliveWindows(pid)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pid ${pid} is still running according to tasklist after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('spawns with shell:false and an explicit executable, and reports a clean exit', async () => {
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  const result = await proc.wait();
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
});

test('reports a non-zero exit code', async () => {
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', 'process.exit(7)'],
  });
  const result = await proc.wait();
  assert.equal(result.code, 7);
});

test('passes cwd and env through to the child', async () => {
  const marker = 'MAGARINE_TEST_MARKER';
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', `process.stdout.write(process.env.${marker} || '')`],
    env: { ...process.env, [marker]: 'hello' },
  });
  const result = await proc.wait();
  assert.equal(result.stdout, 'hello');
});

test('an optional stdin string reaches the child intact', async () => {
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', 'process.stdin.on("data", (c) => process.stdout.write(c))'],
    stdin: 'hello from stdin',
  });
  const result = await proc.wait();
  assert.equal(result.stdout, 'hello from stdin');
});

test('captures multi-megabyte stdout in full without deadlocking', async () => {
  const size = 5 * 1024 * 1024;
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', `process.stdout.write('a'.repeat(${size}))`],
  });
  const result = await proc.wait();
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, size);
});

test('a JSON argument with quotes and newlines reaches a real executable intact via shell:false', async () => {
  const payload = JSON.stringify({ a: 'quote"here', b: 'line\nbreak', c: '  spaced  ' });
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1])', payload],
  });
  const result = await proc.wait();
  assert.equal(result.code, 0);
  assert.equal(result.stdout, payload);
});

test('a wall-clock timeout kills a hanging process, reports timedOut, and leaves no process behind', async () => {
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
    timeoutMs: 200,
  });
  const start = Date.now();
  const result = await proc.wait();
  const elapsed = Date.now() - start;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 10_000, `expected the timeout to fire quickly, took ${elapsed}ms`);

  if (isWindows && proc.pid !== undefined) {
    await waitForPidGoneWindows(proc.pid);
  }
});

test(
  'stop() kills an entire process tree, proven against the OS by pid rather than the close event',
  { skip: !isWindows },
  async () => {
    // A parent that spawns a grandchild and records both pids, then hangs
    // itself so the whole tree is still alive when stop() is called.
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      'process.stdout.write(JSON.stringify({ parentPid: process.pid, childPid: gc.pid }) + String.fromCharCode(10));',
      'setTimeout(() => {}, 60000);',
    ].join('\n');

    const proc = spawnManaged({ executable: process.execPath, args: ['-e', parentScript] });

    const pids = await new Promise<{ parentPid: number; childPid: number }>((resolve) => {
      let buf = '';
      proc.onStdout((chunk) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)));
      });
    });

    assert.ok(isPidAliveWindows(pids.parentPid), 'parent should be alive before stop()');
    assert.ok(isPidAliveWindows(pids.childPid), 'grandchild should be alive before stop()');

    await proc.stop(300);

    // The close event is exactly what this role exists to distrust: prove
    // it against the OS instead.
    await waitForPidGoneWindows(pids.parentPid);
    await waitForPidGoneWindows(pids.childPid);
  }
);

test(
  "resolveExecutable('claude') unwraps the npm .cmd shim to the real claude.exe, which runs",
  { skip: !isWindows },
  async () => {
    const exe = resolveExecutable('claude');
    assert.match(exe, /claude\.exe$/i);
    assert.doesNotMatch(exe, /\.(cmd|bat)$/i);

    // The one test allowed to touch the real tool. --version makes no API
    // call and costs nothing.
    const proc = spawnManaged({ executable: exe, args: ['--version'] });
    const result = await proc.wait();
    assert.equal(result.code, 0);
  }
);

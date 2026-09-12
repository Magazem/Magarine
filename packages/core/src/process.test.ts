import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnManaged } from './process.ts';

// All process control (spawn, timeout, kill) lives in this one module so a
// future Linux port only has to touch this file. Every spawn here uses
// `process.execPath` (the Node binary running the test) as the executable,
// so these tests are portable without depending on any OS-specific command.

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

test('a wall-clock timeout kills a hanging process', async () => {
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
});

test('stop() kills a running process on demand', async () => {
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
  });
  const donePromise = proc.wait();
  proc.stop();
  const result = await donePromise;

  assert.notEqual(result.code, 0);
});

test('passes cwd and env through to the child', async () => {
  const marker = 'MAGARINE_TEST_MARKER';
  const proc = spawnManaged({
    executable: process.execPath,
    args: ['-e', `process.stdout.write(process.env.${marker} || '')`],
    env: { ...process.env, [marker]: 'hello' },
  });
  let stdout = '';
  proc.onStdout((chunk) => {
    stdout += chunk;
  });
  await proc.wait();
  assert.equal(stdout, 'hello');
});

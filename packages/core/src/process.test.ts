import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveCommand, resolveExecutable, spawnManaged } from './process.ts';

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

// Batch 10 (Role Q), docs/strategy/batch-10-owner-walk.md finding 1:
// `resolveExecutable`/`resolveCommand` used to pick the FIRST quoted path
// in a shim that merely looked like a real executable, which is exactly
// how it mis-resolved `pnpm` (to a `node.exe` that does not exist on this
// machine) and `npm` (to unrelated text). Every test above this point that
// exercises shim resolution only ever ran against whatever `claude` happens
// to look like on this machine -- a claim without coverage for the other
// two real shim shapes. These build synthetic fixtures of all three shapes
// in a temp directory and put ONLY that directory on PATH, so the assertions
// hold regardless of what is or isn't installed on whoever runs this suite.
// The machine's real `pnpm`/`npm` are exercised too, further below, as an
// EXTRA check -- never the only one.

function withFixtureOnPath<T>(fixtureDir: string, fn: () => T): T {
  const originalPath = process.env.PATH;
  const originalPathCap = process.env.Path;
  process.env.PATH = `${fixtureDir}${delimiter}${originalPath ?? ''}`;
  process.env.Path = process.env.PATH;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    process.env.Path = originalPathCap;
  }
}

test(
  'resolveCommand: a native-exe shim (the claude shape) resolves to the sibling .exe by name, with no prefix args',
  { skip: !isWindows },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magarine-shim-native-'));
    try {
      // The .exe is deliberately NESTED, not beside the .cmd in the same
      // PATH-searched directory -- exactly claude's real layout
      // (claude.cmd at the npm global root, claude.exe several directories
      // down under node_modules/.../bin/). Putting it directly beside the
      // .cmd would let `findOnPath`'s own PATHEXT order (.EXE before .CMD)
      // resolve it without ever reaching the shim parser this test exists
      // to exercise. A real, runnable stand-in -- a copy of the Node binary
      // itself -- so the test can also prove the resolved command actually
      // runs, not just that a path string looks right.
      const nested = join(dir, 'nested');
      mkdirSync(nested, { recursive: true });
      copyFileSync(process.execPath, join(nested, 'mytool.exe'));
      writeFileSync(
        join(dir, 'mytool.cmd'),
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          '',
          '"%dp0%\\nested\\mytool.exe"   %*',
          '',
        ].join('\r\n')
      );

      const resolved = withFixtureOnPath(dir, () => resolveCommand('mytool'));
      assert.match(resolved.executable, /mytool\.exe$/i);
      assert.deepEqual(resolved.prefixArgs, []);

      const proc = spawnManaged({ executable: resolved.executable, args: [...resolved.prefixArgs, '--version'] });
      const result = await proc.wait();
      assert.equal(result.code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'resolveCommand: an "IF EXIST node.exe" shim (the pnpm shape) with no real node.exe beside it resolves to its script, run through process.execPath',
  { skip: !isWindows },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magarine-shim-ifexist-'));
    try {
      // Deliberately NO node.exe written here -- this is the exact
      // condition that made the old resolver return a non-existent
      // "...\node.exe" for pnpm on the Orchestrator's machine.
      writeFileSync(join(dir, 'mytool2-cli.cjs'), "process.stdout.write('mytool2 ok');\n");
      writeFileSync(
        join(dir, 'mytool2.cmd'),
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          '',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ')',
          '',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\mytool2-cli.cjs" %*',
          '',
        ].join('\r\n')
      );

      const resolved = withFixtureOnPath(dir, () => resolveCommand('mytool2'));
      assert.equal(resolved.executable, process.execPath);
      assert.equal(resolved.prefixArgs.length, 1);
      assert.match(resolved.prefixArgs[0], /mytool2-cli\.cjs$/i);

      const proc = spawnManaged({ executable: resolved.executable, args: [...resolved.prefixArgs] });
      const result = await proc.wait();
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'mytool2 ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'resolveCommand: an "IF EXIST node.exe" shim with a REAL node.exe beside it still resolves to the script, not to node.exe',
  { skip: !isWindows },
  async () => {
    // The gap the previous fixture could not see (found on verification,
    // not by this role): that one deliberately writes no node.exe, so
    // findSiblingNativeExecutable's own `existsSync` check fails before its
    // name match is ever exercised -- mutating the name match away there
    // stays green. An ordinary npm/pnpm install on a machine that DOES have
    // a local node.exe (the ordinary layout, not the Orchestrator's gap) is
    // exactly the case the name match exists for: without it, a `.exe`
    // candidate ending in plain "node.exe" would be accepted as if it were
    // the tool itself, and `resolveCommand('mytool2')` would hand back
    // node.exe -- runnable, silently wrong, indistinguishable from success
    // until whatever spawned it got node's own output instead of the
    // tool's. This is the fixture that makes the name match provable.
    const dir = mkdtempSync(join(tmpdir(), 'magarine-shim-ifexist-realnode-'));
    try {
      copyFileSync(process.execPath, join(dir, 'node.exe'));
      writeFileSync(join(dir, 'mytool2-cli.cjs'), "process.stdout.write('mytool2 ok');\n");
      writeFileSync(
        join(dir, 'mytool2.cmd'),
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          '',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ')',
          '',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\mytool2-cli.cjs" %*',
          '',
        ].join('\r\n')
      );

      const resolved = withFixtureOnPath(dir, () => resolveCommand('mytool2'));
      // The point of the test: NOT node.exe with no prefix args (what a bare
      // ".exe exists" check would return), but the script through this
      // process's own node.
      assert.equal(resolved.executable, process.execPath);
      assert.equal(resolved.prefixArgs.length, 1);
      assert.match(resolved.prefixArgs[0], /mytool2-cli\.cjs$/i);
      assert.doesNotMatch(resolved.prefixArgs[0], /(?<!-cli)\.exe$/i);

      const proc = spawnManaged({ executable: resolved.executable, args: [...resolved.prefixArgs] });
      const result = await proc.wait();
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'mytool2 ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'resolveCommand: the Program Files npm.cmd shape (bare %VARNAME% tokens on the final line, no literal path) resolves via the default SET assignment',
  { skip: !isWindows },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'magarine-shim-npmshape-'));
    try {
      writeFileSync(join(dir, 'mytool3-cli.js'), "process.stdout.write('mytool3 ok');\n");
      writeFileSync(join(dir, 'mytool3-prefix.js'), "process.stdout.write(process.cwd());\n");
      // Modelled directly on this machine's real `npm.cmd` (read off
      // C:\Program Files\nodejs\npm.cmd) -- see the module comment on
      // findShimScriptPath for why its final line has no literal path at
      // all, unlike pnpm's.
      writeFileSync(
        join(dir, 'mytool3.cmd'),
        [
          ":: Created by mytool3, please don't edit manually.",
          '@ECHO OFF',
          '',
          'SETLOCAL',
          '',
          'SET "NODE_EXE=%~dp0\\node.exe"',
          'IF NOT EXIST "%NODE_EXE%" (',
          '  SET "NODE_EXE=node"',
          ')',
          '',
          'SET "MYTOOL3_PREFIX_JS=%~dp0\\mytool3-prefix.js"',
          'SET "MYTOOL3_CLI_JS=%~dp0\\mytool3-cli.js"',
          'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%MYTOOL3_PREFIX_JS%"\') DO (',
          '  SET "MYTOOL3_PREFIX_CLI_JS=%%F\\mytool3-cli.js"',
          ')',
          'IF EXIST "%MYTOOL3_PREFIX_CLI_JS%" (',
          '  SET "MYTOOL3_CLI_JS=%MYTOOL3_PREFIX_CLI_JS%"',
          ')',
          '',
          '"%NODE_EXE%" "%MYTOOL3_CLI_JS%" %*',
          '',
        ].join('\r\n')
      );

      const resolved = withFixtureOnPath(dir, () => resolveCommand('mytool3'));
      assert.equal(resolved.executable, process.execPath);
      assert.equal(resolved.prefixArgs.length, 1);
      assert.match(resolved.prefixArgs[0], /mytool3-cli\.js$/i);
      assert.doesNotMatch(resolved.prefixArgs[0], /node\.exe/i);

      const proc = spawnManaged({ executable: resolved.executable, args: [...resolved.prefixArgs] });
      const result = await proc.wait();
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'mytool3 ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'resolveCommand: no matching shape throws naming the shim, rather than falling back to a shell',
  { skip: !isWindows },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'magarine-shim-nomatch-'));
    try {
      writeFileSync(join(dir, 'mytool4.cmd'), ['@ECHO off', 'echo hello', ''].join('\r\n'));
      assert.throws(
        () => withFixtureOnPath(dir, () => resolveCommand('mytool4')),
        /could not find a real executable or script inside shim/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'resolveCommand: the real pnpm on this machine now resolves and runs -- the exact regression from the owner walk',
  { skip: !isWindows },
  async () => {
    const resolved = resolveCommand('pnpm');
    const proc = spawnManaged({ executable: resolved.executable, args: [...resolved.prefixArgs, '--version'] });
    const result = await proc.wait();
    assert.equal(result.code, 0, `pnpm --version via resolveCommand failed: ${result.stderr}`);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
);

test(
  'resolveCommand: the real npm on this machine now resolves and runs -- the exact regression from the owner walk',
  { skip: !isWindows },
  async () => {
    const resolved = resolveCommand('npm');
    const proc = spawnManaged({ executable: resolved.executable, args: [...resolved.prefixArgs, '--version'] });
    const result = await proc.wait();
    assert.equal(result.code, 0, `npm --version via resolveCommand failed: ${result.stderr}`);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
);

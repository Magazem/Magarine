import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace } from './workspace.ts';

test('NONE gives a fresh temp directory that is removed after cleanup()', async () => {
  const ws = prepareWorkspace('NONE', 'tkt_none_1');
  assert.ok(existsSync(ws.path), 'workspace directory should exist immediately after prepare');
  writeFileSync(join(ws.path, 'marker.txt'), 'hi');

  await ws.cleanup();

  assert.equal(existsSync(ws.path), false, 'NONE workspace must be removed after the run');
});

test('NONE gives a distinct directory per call', async () => {
  const a = prepareWorkspace('NONE', 'tkt_none_2');
  const b = prepareWorkspace('NONE', 'tkt_none_2');
  try {
    assert.notEqual(a.path, b.path);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('NONE respects an injected baseDir instead of the OS temp directory, with the production default unchanged (batch 5 item 3)', async () => {
  const customBase = mkdtempSync(join(tmpdir(), 'magarine-custom-base-'));
  try {
    const ws = prepareWorkspace('NONE', 'tkt_none_3', { baseDir: customBase });
    try {
      assert.ok(ws.path.startsWith(customBase), `expected ${ws.path} to be created under ${customBase}`);
    } finally {
      await ws.cleanup();
    }

    const wsDefault = prepareWorkspace('NONE', 'tkt_none_4');
    try {
      assert.ok(!wsDefault.path.startsWith(customBase), 'omitting baseDir must still fall back to the OS temp directory');
    } finally {
      await wsDefault.cleanup();
    }
  } finally {
    rmSync(customBase, { recursive: true, force: true });
  }
});

test('DIRECTORY gives the project workspaceRoot itself (one shared directory), and it persists after cleanup()', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magarine-wsroot-'));
  try {
    const ws = prepareWorkspace('DIRECTORY', 'tkt_dir_1', { workspaceRoot: root });
    assert.equal(ws.path, root, 'DIRECTORY must resolve to the project workspaceRoot itself, not a per-ticket subdirectory');
    assert.ok(existsSync(ws.path));
    writeFileSync(join(ws.path, 'artifact.txt'), 'keep me');

    await ws.cleanup();

    assert.ok(existsSync(ws.path), 'DIRECTORY workspace must persist after cleanup()');
    assert.ok(existsSync(join(ws.path, 'artifact.txt')), 'DIRECTORY contents must persist after cleanup()');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DIRECTORY gives every ticket in the project the same directory, so a second ticket sees the first ticket\'s file', () => {
  const root = mkdtempSync(join(tmpdir(), 'magarine-wsroot-shared-'));
  try {
    const wsA = prepareWorkspace('DIRECTORY', 'tkt_dir_a', { workspaceRoot: root });
    writeFileSync(join(wsA.path, 'from-a.txt'), 'a');

    const wsB = prepareWorkspace('DIRECTORY', 'tkt_dir_b', { workspaceRoot: root });
    assert.equal(wsB.path, wsA.path, 'DIRECTORY must not key the path by ticket id');
    assert.ok(existsSync(join(wsB.path, 'from-a.txt')), 'ticket B must see the file ticket A wrote');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DIRECTORY without a workspaceRoot throws instead of silently falling back to cwd', () => {
  assert.throws(() => prepareWorkspace('DIRECTORY', 'tkt_dir_2'), /workspaceRoot/);
});

// Batch 9 housekeeping item 1: on Windows, a just-exited child process's cwd
// can hold its directory handle open a few milliseconds past the child's own
// `close` event (the same class of native-handle release delay
// db/testSupport.ts's rmSyncResilient already works around for node:sqlite,
// HARD-verified there) -- an immediate, un-retried `rmSync` of a NONE
// workspace can observe a transient EPERM/EBUSY from this. `removeFn` is a
// test-only seam (mirrors WorkspaceOptions.baseDir) so this is proven with a
// deterministic injected failure instead of racing the real OS.
test('NONE cleanup retries past a transient failure from the underlying remove and still succeeds', async () => {
  let calls = 0;
  const ws = prepareWorkspace('NONE', 'tkt_none_retry_1', {
    removeFn: (path) => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('EPERM: operation not permitted, rmdir') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      rmSync(path, { recursive: true, force: true });
    },
    retryDelayMs: 1,
  });
  assert.ok(existsSync(ws.path));

  await ws.cleanup();

  assert.equal(calls, 3, 'expected two failed attempts before the third succeeded');
  assert.equal(existsSync(ws.path), false, 'workspace must be removed once the retry succeeds');
});

test('NONE cleanup gives up and rejects once the underlying remove exhausts every retry, rather than retrying forever', async () => {
  let calls = 0;
  const ws = prepareWorkspace('NONE', 'tkt_none_retry_2', {
    removeFn: () => {
      calls += 1;
      const err = new Error('EPERM: operation not permitted, rmdir') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    },
    retryAttempts: 3,
    retryDelayMs: 1,
  });

  await assert.rejects(() => ws.cleanup(), /EPERM/);
  assert.equal(calls, 3, 'expected exactly retryAttempts calls, not an unbounded retry loop');

  rmSync(ws.path, { recursive: true, force: true });
});

test('GIT_WORKTREE is refused, not silently degraded', () => {
  assert.throws(() => prepareWorkspace('GIT_WORKTREE', 'tkt_gw_1'), /not supported yet/);
});

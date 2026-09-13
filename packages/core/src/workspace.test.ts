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

test('NONE gives a distinct directory per call', () => {
  const a = prepareWorkspace('NONE', 'tkt_none_2');
  const b = prepareWorkspace('NONE', 'tkt_none_2');
  assert.notEqual(a.path, b.path);
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

test('GIT_WORKTREE is refused, not silently degraded', () => {
  assert.throws(() => prepareWorkspace('GIT_WORKTREE', 'tkt_gw_1'), /not supported yet/);
});

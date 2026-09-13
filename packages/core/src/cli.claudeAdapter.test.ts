import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';

// Flag-level coverage for --adapter/--claude-exe/--run-timeout. No real
// `claude` tool or network is touched: every case here either errors before
// any process is spawned, or (the "accepted flags" tests) runs against a
// project with zero tickets, so buildAdapter() runs but startWorker() is
// never called. A full spawn-based, no-network run of ClaudeCliAdapter
// itself is covered in adapters/claudeCli.test.ts, driven through the class
// directly rather than through this CLI, because pointing `--claude-exe` (a
// single path) at a fake executable requires the same node-wrapper seam
// ClaudeCliAdapter exposes only on its constructor, not through the CLI's
// plain string flag.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

async function run(
  args: string[],
  envOverrides?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged({
    executable: process.execPath,
    args: [cliPath, ...args],
    env: envOverrides ? { ...process.env, ...envOverrides } : undefined,
  });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  return { code: result.code, stdout, stderr };
}

test('run --until-idle --adapter claude without --claude-exe fails clearly (not silently on the fake adapter) when the executable cannot be resolved on PATH either', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-cli-claude-flag-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);
    await run(['ticket', 'add', '--project', project.id, '--title', 'T1', '--json', '--db', dbFile]);

    // Empty PATH: resolveExecutable('claude') has nothing to find, so the
    // default-wiring fallback must fail clearly rather than crash deeper in
    // (e.g. by trying to spawn the literal string "claude").
    const res = await run(
      ['run', '--until-idle', '--adapter', 'claude', '--project', project.id, '--db', dbFile],
      { PATH: '', Path: '' }
    );

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /resolveExecutable\('claude'\) failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--adapter claude without --claude-exe defaults to resolveExecutable(\'claude\') when it is resolvable on PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-cli-claude-flag-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    // Deliberately no tickets: this proves buildAdapter() resolves an
    // executable and does not throw, without ever spawning the real tool.
    const projectRes = await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const res = await run(['tick', '--adapter', 'claude', '--project', project.id, '--json', '--db', dbFile]);

    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /--claude-exe/);
    assert.deepEqual(JSON.parse(res.stdout).started, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown --adapter value is reported by name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-cli-claude-flag-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);
    await run(['ticket', 'add', '--project', project.id, '--title', 'T1', '--json', '--db', dbFile]);

    const res = await run(['tick', '--adapter', 'nonsense', '--project', project.id, '--db', dbFile]);

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Unknown adapter: nonsense/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--adapter, --claude-exe and --run-timeout are accepted flags for tick (no "Unknown flag" rejection)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-cli-claude-flag-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    // Deliberately no tickets: buildAdapter() must succeed and tick() must
    // complete with nothing started, so this proves the flags are accepted
    // and wired without ever spawning a process (avoids depending on
    // --claude-exe pointing at a real, spawnable binary).
    const projectRes = await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const res = await run([
      'tick',
      '--adapter',
      'claude',
      '--claude-exe',
      'irrelevant-no-ticket-will-spawn-it',
      '--run-timeout',
      '60',
      '--project',
      project.id,
      '--json',
      '--db',
      dbFile,
    ]);

    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /Unknown flag/);
    assert.deepEqual(JSON.parse(res.stdout).started, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--workspace-root is no longer an accepted flag on tick/run: workspace is routed per ticket now', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-cli-workspace-root-removed-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const res = await run(['tick', '--workspace-root', dir, '--project', project.id, '--db', dbFile]);

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Unknown flag/);
    assert.match(res.stderr, /--workspace-root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

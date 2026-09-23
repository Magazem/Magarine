import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';
import { testTempRoot, pinnedFakeEnv } from './testSupport.ts';

// Batch 16 (the stranger's walk): `--help` tells the truth. The usage line is
// GENERATED from the flag table that validates every command, per-command
// `--help` prints the same valid-flag composition the unknown-flag error
// does, and the error names both ways to locate state.

const cliUrl = new URL('./cli.ts', import.meta.url);
const cliPath = fileURLToPath(cliUrl);
const testRoot = testTempRoot('cli-help');
after(testRoot.cleanup);

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // cwd is the temp root, and every call passes an explicit --state-dir
    // (never the owner's ~/.magarine, never an unset MAGARINE_HOME).
    const p = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, ...args], cwd: testRoot.root });
    let stdout = '';
    let stderr = '';
    p.onStdout((c) => (stdout += c));
    p.onStderr((c) => (stderr += c));
    p.wait().then((r) => resolve({ code: r.code, stdout, stderr }));
  });
}

// Every command cli.ts actually DISPATCHES, read from its source: a command
// added to `main()` without being reachable from the usage line fails here,
// naming it.
function dispatchedCommands(): string[] {
  const source = readFileSync(cliUrl, 'utf8');
  const found = new Set<string>();
  for (const m of source.matchAll(/command === '([a-z-]+)'(?: && subcommand === '([a-z-]+)')?/g)) {
    if (m[1] === '--help' || m[1] === '-h' || m[1] === 'help') continue;
    found.add(m[2] ? `${m[1]} ${m[2]}` : m[1]!);
  }
  return [...found].sort();
}

test('`magarine --help` lists EVERY dispatched command (discuss and token included), to stdout with exit 0', async () => {
  const res = await run(['--help']);
  assert.equal(res.code, 0, res.stderr);
  const usage = res.stdout.split('\n')[0]!;
  const commands = dispatchedCommands();
  assert.ok(commands.length >= 20, `sanity: found ${commands.length} dispatched commands`);
  // Exact membership in the `<a|b|c>` list -- not a substring match, which
  // 'plan' inside another word could satisfy by accident.
  const listed = new Set((/<(.*)>/.exec(usage)?.[1] ?? '').split('|'));
  for (const command of commands) {
    assert.ok(listed.has(command), `the usage line does not list '${command}': ${usage}`);
  }
  assert.ok(usage.includes('discuss') && usage.includes('token'));
});

test('a bare `magarine` with no command prints the same generated usage to stderr and fails', async () => {
  const res = await run([]);
  assert.notEqual(res.code, 0);
  assert.ok(res.stderr.includes('discuss') && res.stderr.includes('token'), res.stderr);
});

test('`<command> --help` prints the SAME valid-flag list the unknown-flag error prints for that command, exit 0, touching nothing', async () => {
  const stateDir = join(testRoot.root, 'never-created');
  for (const command of [['serve'], ['ticket', 'add'], ['project', 'create'], ['discuss'], ['token']]) {
    const help = await run([...command, '--help', '--state-dir', stateDir]);
    assert.equal(help.code, 0, `${command.join(' ')} --help must succeed, not be rejected as an unknown flag: ${help.stderr}`);
    const helpFlags = /^Valid flags: (.*)$/m.exec(help.stdout.trim())?.[1];
    assert.ok(helpFlags, `no valid-flag list in: ${help.stdout}`);

    const bad = await run([...command, '--definitely-not-a-flag', '--state-dir', stateDir]);
    assert.notEqual(bad.code, 0);
    const errorFlags = /Valid flags: (.*)\.\n?$/.exec(bad.stderr.trim())?.[1];
    assert.equal(helpFlags, errorFlags, `${command.join(' ')}: help and the error must compose the list identically`);
  }
  assert.equal(existsSync(stateDir), false, '--help must not create or open any state');
});

test('serve --help returns promptly and does not start a daemon', async () => {
  const stateDir = join(testRoot.root, 'serve-help-state');
  const started = Date.now();
  const res = await run(['serve', '--help', '--state-dir', stateDir]);
  assert.equal(res.code, 0);
  assert.ok(Date.now() - started < 8000);
  assert.equal(existsSync(join(stateDir, 'daemon.json')), false);
});

test('the unknown-flag error names BOTH ways to locate state -- --state-dir (the one the README teaches) and --db', async () => {
  const res = await run(['board', '--nope', '--state-dir', mkdtempSync(join(testRoot.root, 's-'))]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--state-dir/);
  assert.match(res.stderr, /--db/);
  assert.match(res.stderr, /--json/);
});

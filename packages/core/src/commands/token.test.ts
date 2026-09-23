import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from '../process.ts';
import { testTempRoot, deriveTestCliCwd, pinnedFakeEnv } from '../testSupport.ts';
import { copyToClipboard, runToken, TokenError, type RunClipboardTool } from './token.ts';

// Every clipboard-touching path here is exercised through the INJECTED
// seams (`copyFn`/`runTool`), never the real platform tool. This is
// deliberate, not an oversight: a real `serve` daemon for the owner's own
// walk is running on THIS machine's real state directory right now (see the
// dispatch's own constraint), and the real clipboard is the owner's real,
// live clipboard -- a CLI-level test that reached the real `clip`/`pbcopy`
// tool would overwrite whatever they have on it mid-walk. The in-process
// seams below cover every branch the ruling's mutation list names; the one
// CLI-level test in this file (no live daemon) never reaches the clipboard
// step at all, so it is safe to spawn for real.

test('runToken: a live daemon and a successful copier returns exactly {copied, port, stateDir}, and the copier receives exactly the token', async () => {
  const token = 'a'.repeat(64);
  let received: string | undefined;
  const result = await runToken({
    stateDir: '/fake/state-dir',
    checkDaemonFileFn: async () => ({
      status: 'live',
      info: { pid: 1, port: 4242, token, startedAt: 'x', dbPath: 'y' },
    }),
    copyFn: (value) => {
      received = value;
      return true;
    },
  });
  assert.deepEqual(result, { copied: true, port: 4242, stateDir: '/fake/state-dir' });
  assert.equal(received, token);
});

test('runToken: an absent daemon file refuses, exit-worthy, and never calls the copier', async () => {
  let called = false;
  await assert.rejects(
    runToken({
      stateDir: '/fake',
      checkDaemonFileFn: async () => ({ status: 'absent' }),
      copyFn: () => {
        called = true;
        return true;
      },
    }),
    (err: unknown) =>
      err instanceof TokenError &&
      /no live daemon for this state directory/.test(err.message) &&
      /magarine serve/.test(err.message)
  );
  assert.equal(called, false, 'the copier must never run for a non-live daemon');
});

test('runToken: a stale daemon file (dead pid or failed health check) refuses and never calls the copier', async () => {
  let called = false;
  await assert.rejects(
    runToken({
      stateDir: '/fake',
      checkDaemonFileFn: async () => ({
        status: 'stale',
        info: { pid: 1, port: 1, token: 'b'.repeat(64), startedAt: 'y', dbPath: 'z' },
      }),
      copyFn: () => {
        called = true;
        return true;
      },
    }),
    TokenError
  );
  assert.equal(called, false, 'the copier must never run for a stale daemon');
});

test('runToken: no clipboard tool found refuses, naming the daemon.json path and the field -- never the token value', async () => {
  const token = 'c'.repeat(64);
  await assert.rejects(
    runToken({
      stateDir: '/fake/dir',
      checkDaemonFileFn: async () => ({
        status: 'live',
        info: { pid: 1, port: 1, token, startedAt: 'y', dbPath: 'z' },
      }),
      copyFn: () => false,
    }),
    (err: unknown) => {
      assert.ok(err instanceof TokenError);
      assert.match(err.message, /daemon\.json/);
      assert.match(err.message, /token/);
      assert.doesNotMatch(err.message, new RegExp(token));
      return true;
    }
  );
});

test('copyToClipboard passes the value on stdin, never as a command-line argument', () => {
  const value = 'd'.repeat(64);
  const calls: Array<{ exe: string; args: string[]; input: string }> = [];
  const runTool: RunClipboardTool = (exe, args, input) => {
    calls.push({ exe, args, input });
    return { ok: true };
  };
  const ok = copyToClipboard(value, runTool, 'win32');
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'clip');
  assert.deepEqual(calls[0].args, [], 'clip takes no flags -- the value must not be smuggled in here');
  assert.equal(calls[0].input, value, 'the value must arrive as input (stdin), not as an argument');
  for (const call of calls) {
    assert.ok(
      !call.args.some((a) => a.includes(value)),
      'the token must never appear anywhere in the argument list'
    );
  }
});

test('copyToClipboard on Linux tries wl-copy, then xclip, then xsel, in that order, first success wins', () => {
  const value = 'e'.repeat(64);
  const tried: string[] = [];
  const runTool: RunClipboardTool = (exe, args, input) => {
    tried.push(exe);
    assert.ok(!args.includes(value), 'the value must never be passed as an argument, on any candidate');
    assert.equal(input, value);
    return { ok: exe === 'xsel' };
  };
  const ok = copyToClipboard(value, runTool, 'linux');
  assert.equal(ok, true);
  assert.deepEqual(tried, ['wl-copy', 'xclip', 'xsel']);
});

test('copyToClipboard returns false when no candidate tool succeeds', () => {
  const ok = copyToClipboard('f'.repeat(64), () => ({ ok: false }), 'linux');
  assert.equal(ok, false);
});

// --- CLI-level: the one path safe to spawn for real (never reaches the clipboard) ---

const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));
const testRoot = testTempRoot('token-cli');
after(testRoot.cleanup);

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    let stderr = '';
    p.onStdout((c) => (stdout += c));
    p.onStderr((c) => (stderr += c));
    p.wait().then((r) => resolve({ stdout, stderr, code: r.code }));
  });
}

test('magarine token against a state dir with no daemon refuses cleanly, exit 1, naming `magarine serve`', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'no-daemon-'));
  try {
    const res = await runCli(['token', '--state-dir', stateDir]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no live daemon for this state directory; start `magarine serve`/);
    assert.equal(res.stdout, '');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

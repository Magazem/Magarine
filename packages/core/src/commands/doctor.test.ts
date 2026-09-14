import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorExitCode, formatDoctor, runDoctor } from './doctor.ts';

// Batch 10 (Role Q): `magarine doctor` is the owner's first stop when
// something is wrong, so every branch below is driven through injected
// seams (resolveExecutableFn/runProbeFn/checkDaemonFileFn) rather than the
// real `claude`/`pnpm` on whoever's machine runs this suite -- the same
// test-only-seam pattern workspace.ts already uses (baseDir/removeFn), so
// this suite is deterministic regardless of what is or isn't installed
// where it runs, and never shells out to a real binary.

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'magarine-doctor-test-'));
}

const notLive = async () => ({ status: 'absent' as const });

test('Node version below 24 fails with a plain upgrade sentence, not a stack trace', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '20.11.0',
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const nodeLine = lines.find((l) => l.name === 'Node.js version')!;
  assert.equal(nodeLine.status, 'fail');
  assert.match(nodeLine.detail, /too old/i);
  assert.match(nodeLine.detail, /nodejs\.org/);
  assert.doesNotMatch(nodeLine.detail, /at\s+\//); // no stack trace frame leaking into the sentence
});

test('Node version 24+ passes', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '24.1.0',
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.equal(lines.find((l) => l.name === 'Node.js version')!.status, 'pass');
});

test('pnpm not found on PATH fails with an install hint', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: (name) => {
      if (name === 'pnpm') throw new Error('executable not found on PATH: pnpm');
      return '/usr/bin/claude';
    },
    runProbeFn: () => ({ ok: true, output: 'claude 2.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const pnpmLine = lines.find((l) => l.name === 'pnpm')!;
  assert.equal(pnpmLine.status, 'fail');
  assert.match(pnpmLine.detail, /not found on PATH/);
  assert.match(pnpmLine.detail, /pnpm\.io/);
});

test('pnpm resolved but its probe failing to run is SKIP, not FAIL (owner walk finding 1)', async () => {
  // Batch 10 owner walk: `resolveExecutable` can resolve `pnpm` to a path
  // that does not actually run (a real defect in process.ts, not owned by
  // this role, now routed to the Strategist) even though `pnpm --version`
  // works fine typed directly. Reporting this as FAIL told a real owner to
  // "fix" a tool that was never broken -- it must be SKIP so `doctorExitCode`
  // doesn't also halt a script over it.
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: (name) => (name === 'pnpm' ? 'C:\\fake\\pnpm.cmd' : '/usr/bin/claude'),
    runProbeFn: (exe) => (exe === 'C:\\fake\\pnpm.cmd' ? { ok: false, output: 'spawnSync ...\\node.exe ENOENT' } : { ok: true, output: 'claude 2.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const pnpmLine = lines.find((l) => l.name === 'pnpm')!;
  assert.equal(pnpmLine.status, 'skip');
  assert.match(pnpmLine.detail, /pnpm --version/);
  assert.equal(doctorExitCode(lines), 0, 'a pnpm SKIP alone must not fail the whole command');
});

test('claude not found on PATH fails, and the login line is skipped rather than run against nothing', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: (name) => {
      if (name === 'claude') throw new Error('executable not found on PATH: claude');
      return '/usr/bin/pnpm';
    },
    runProbeFn: () => ({ ok: true, output: 'pnpm 10.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const claudeLine = lines.find((l) => l.name === 'claude CLI')!;
  const loginLine = lines.find((l) => l.name === 'claude login')!;
  assert.equal(claudeLine.status, 'fail');
  assert.match(claudeLine.detail, /not found on PATH/);
  assert.equal(loginLine.status, 'skip');
  assert.match(loginLine.detail, /skipped/);
});

test('claude found but not logged in fails with the exact recovery step, and makes no billed call', async () => {
  const calls: string[][] = [];
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/claude',
    runProbeFn: (exe, args) => {
      calls.push(args);
      if (args[0] === 'auth') return { ok: true, output: JSON.stringify({ loggedIn: false }) };
      return { ok: true, output: 'claude 2.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const loginLine = lines.find((l) => l.name === 'claude login')!;
  assert.equal(loginLine.status, 'fail');
  assert.match(loginLine.detail, /not logged in\. Run: claude/);
  // The mutation this proves: without `--paid`, `-p` must never be invoked.
  assert.ok(!calls.some((args) => args.includes('-p')), 'a non-paid doctor run must never call claude -p');
});

test('claude logged in passes, and never reads or reports the email/org fields the real command also returns', async () => {
  // `claude auth status --json` returns email/orgId/orgName/subscriptionType
  // etc. alongside `loggedIn` (confirmed against a real login). This fixture
  // uses an obviously fake address specifically to prove doctor's detail
  // string never carries it through -- reading `loggedIn` and nothing else
  // is the point of this test, not just an implementation detail.
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/claude',
    runProbeFn: (_exe, args) => {
      if (args[0] === 'auth') {
        return {
          ok: true,
          output: JSON.stringify({
            loggedIn: true,
            email: 'not-a-real-address@example.invalid',
            orgId: 'org_fake',
            orgName: 'Fake Org',
            subscriptionType: 'fake-tier',
          }),
        };
      }
      return { ok: true, output: 'claude 2.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const loginLine = lines.find((l) => l.name === 'claude login')!;
  assert.equal(loginLine.status, 'pass');
  assert.equal(loginLine.detail, 'logged in');
  assert.doesNotMatch(loginLine.detail, /example\.invalid|org_fake|Fake Org|fake-tier/);
});

test('claude auth status --json failing to run is SKIP, not FAIL and not PASS', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/claude',
    runProbeFn: (_exe, args) => {
      if (args[0] === 'auth') return { ok: false, output: 'error: unknown command auth' };
      return { ok: true, output: 'claude 1.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const loginLine = lines.find((l) => l.name === 'claude login')!;
  assert.equal(loginLine.status, 'skip');
  assert.match(loginLine.detail, /older claude build/);
  // A SKIP must never fail the overall command -- "unknown" is not "broken".
  assert.equal(doctorExitCode(lines), 0);
});

test('claude auth status --json returning an unrecognised shape is SKIP, not a crash and not PASS', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/claude',
    runProbeFn: (_exe, args) => {
      if (args[0] === 'auth') return { ok: true, output: JSON.stringify({ someOtherField: true }) };
      return { ok: true, output: 'claude 3.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const loginLine = lines.find((l) => l.name === 'claude login')!;
  assert.equal(loginLine.status, 'skip');
  assert.match(loginLine.detail, /shape this check doesn't recognise/);
});

test('claude auth status --json returning unparseable output is SKIP, not a thrown exception', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/claude',
    runProbeFn: (_exe, args) => {
      if (args[0] === 'auth') return { ok: true, output: 'not json at all' };
      return { ok: true, output: 'claude 3.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const loginLine = lines.find((l) => l.name === 'claude login')!;
  assert.equal(loginLine.status, 'skip');
});

// Mutation-checked: removing this file's `options.paid &&` guard entirely
// (calling `-p` unconditionally) does NOT turn this test red, because it
// already passes `paid: true` -- the "only when passed" half of the
// original claim is what the "makes no billed call" test above actually
// proves. Renamed to say only what this test itself verifies, rather than
// implying coverage the other test carries.
test('--paid calls claude -p exactly once when passed', async () => {
  const calls: string[][] = [];
  await runDoctor({
    stateDir: tempStateDir(),
    paid: true,
    resolveExecutableFn: () => '/usr/bin/claude',
    runProbeFn: (_exe, args) => {
      calls.push(args);
      if (args[0] === 'auth') return { ok: true, output: JSON.stringify({ loggedIn: true }) };
      if (args[0] === '-p') return { ok: true, output: '{"result":"ok"}' };
      return { ok: true, output: 'claude 2.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const paidCalls = calls.filter((args) => args[0] === '-p');
  assert.equal(paidCalls.length, 1);
});

test('an unwritable state directory fails with a permissions hint, not a raw stack trace', async () => {
  // A path that is actually a FILE, not a directory, makes mkdirSync's
  // recursive create fail portably (Windows and POSIX alike) without
  // needing platform-specific permission bits.
  const parent = tempStateDir();
  const blockingFile = join(parent, 'blocked');
  writeFileSync(blockingFile, 'x');
  const stateDir = join(blockingFile, 'nested');

  const lines = await runDoctor({
    stateDir,
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const line = lines.find((l) => l.name === 'state directory')!;
  assert.equal(line.status, 'fail');
  assert.match(line.detail, /cannot write to/);
  assert.match(line.detail, /--state-dir/);
  rmSync(parent, { recursive: true, force: true });
});

test('a live daemon is reported with its port, and is not treated as a failure', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: async () => ({
      status: 'live',
      info: { pid: 4242, port: 55123, token: 'x', startedAt: '2026-01-01T00:00:00.000Z', dbPath: '/x/magarine.db' },
    }),
  });
  const daemonLine = lines.find((l) => l.name === 'daemon')!;
  assert.equal(daemonLine.status, 'pass');
  assert.match(daemonLine.detail, /55123/);
  assert.match(daemonLine.detail, /4242/);
});

test('no daemon running is reported as informational, not a failure', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const daemonLine = lines.find((l) => l.name === 'daemon')!;
  assert.equal(daemonLine.status, 'pass');
  assert.match(daemonLine.detail, /not running/);
});

test('doctorExitCode is 0 only when every line passes, and SKIP does not count as failing', async () => {
  const allPass = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '24.1.0',
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: (_exe, args) => (args[0] === 'auth' ? { ok: true, output: JSON.stringify({ loggedIn: true }) } : { ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.equal(doctorExitCode(allPass), 0);

  const oneFail = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '18.0.0',
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: (_exe, args) => (args[0] === 'auth' ? { ok: true, output: JSON.stringify({ loggedIn: true }) } : { ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.equal(doctorExitCode(oneFail), 1);

  const oneSkipOnly = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '24.1.0',
    resolveExecutableFn: () => '/usr/bin/fake',
    runProbeFn: (_exe, args) => (args[0] === 'auth' ? { ok: false, output: 'unknown command' } : { ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.ok(oneSkipOnly.some((l) => l.status === 'skip'));
  assert.equal(doctorExitCode(oneSkipOnly), 0);
});

test('formatDoctor prints one PASS/FAIL/SKIP line per check with the exact detail sentence', async () => {
  const lines: Awaited<ReturnType<typeof runDoctor>> = [
    { name: 'Node.js version', status: 'pass', detail: '24.1.0 (>= 24 required)' },
    { name: 'claude login', status: 'fail', detail: 'not logged in. Run: claude   (then complete the browser login), and try again.' },
    { name: 'claude login shape', status: 'skip', detail: 'unknown -- see above.' },
  ];
  const text = formatDoctor(lines);
  const rows = text.split('\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[0], `PASS  ${'Node.js version'.padEnd(20)} 24.1.0 (>= 24 required)`);
  assert.equal(
    rows[1],
    `FAIL  ${'claude login'.padEnd(20)} not logged in. Run: claude   (then complete the browser login), and try again.`
  );
  assert.equal(rows[2], `SKIP  ${'claude login shape'.padEnd(20)} unknown -- see above.`);
});

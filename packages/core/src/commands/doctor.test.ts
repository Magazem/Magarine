import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot } from '../testSupport.ts';
import type { ResolvedCommand } from '../process.ts';
import { doctorExitCode, formatDoctor, runDoctor } from './doctor.ts';

// Batch 10 (Role Q): `magarine doctor` is the owner's first stop when
// something is wrong, so every branch below is driven through injected
// seams (resolveCommandFn/runProbeFn/checkDaemonFileFn) rather than the
// real `claude`/`pnpm` on whoever's machine runs this suite -- the same
// test-only-seam pattern workspace.ts already uses (baseDir/removeFn), so
// this suite is deterministic regardless of what is or isn't installed
// where it runs, and never shells out to a real binary.

// Found during the Orchestrator's soak prep: every call used to create a
// bare `mkdtempSync` directory under the shared OS tmpdir with nothing ever
// removing it (only the one `parent` in the "unwritable state directory"
// test below got its own explicit cleanup) -- 17 leaked per run of this
// file alone, which would have made every one of the soak's 20 runs read as
// a growing leak. `testTempRoot`, cli.test.ts's own established pattern, is
// what's used everywhere else in this codebase for exactly this reason.
const testRoot = testTempRoot('doctor');
after(testRoot.cleanup);

function tempStateDir(): string {
  return mkdtempSync(join(testRoot.root, 'magarine-doctor-test-'));
}

const notLive = async () => ({ status: 'absent' as const });

// A resolveCommandFn stub that hands back the plain-native-executable shape
// (no prefix args, strategy 'direct') for whatever name is asked, unless
// overridden per test.
function fakeResolve(
  byName: Record<string, { executable: string; prefixArgs?: string[]; strategy?: ResolvedCommand['strategy'] } | 'throw'>
) {
  return (name: string): ResolvedCommand => {
    const entry = byName[name];
    if (entry === 'throw' || entry === undefined) {
      throw new Error(`executable not found on PATH: ${name}`);
    }
    return { executable: entry.executable, prefixArgs: entry.prefixArgs ?? [], strategy: entry.strategy ?? 'direct' };
  };
}

test('Node version below 24 fails with a plain upgrade sentence, not a stack trace', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '20.11.0',
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
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
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.equal(lines.find((l) => l.name === 'Node.js version')!.status, 'pass');
});

test('pnpm not found on PATH fails with an install hint', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({ pnpm: 'throw', claude: { executable: '/usr/bin/claude' } }),
    runProbeFn: () => ({ ok: true, output: 'claude 2.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const pnpmLine = lines.find((l) => l.name === 'pnpm')!;
  assert.equal(pnpmLine.status, 'fail');
  assert.match(pnpmLine.detail, /not found on PATH/);
  assert.match(pnpmLine.detail, /pnpm\.io/);
});

test('pnpm resolved to a real path but the probe genuinely fails to run is FAIL, not SKIP', async () => {
  // Batch 10 owner walk finding 1 was fixed at the source (process.ts's
  // resolveCommand), not papered over here -- see process.test.ts's
  // synthetic shim fixtures and the two real-pnpm/real-npm regression
  // tests there. With the resolver correct, a probe that still fails to
  // run pnpm is a genuine problem again, so this must be FAIL, not the
  // interim SKIP this line briefly carried.
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({ pnpm: { executable: 'C:\\fake\\node.exe', prefixArgs: [] }, claude: { executable: '/usr/bin/claude' } }),
    runProbeFn: (exe) => (exe === 'C:\\fake\\node.exe' ? { ok: false, output: 'spawnSync C:\\fake\\node.exe ENOENT' } : { ok: true, output: 'claude 2.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const pnpmLine = lines.find((l) => l.name === 'pnpm')!;
  assert.equal(pnpmLine.status, 'fail');
  assert.match(pnpmLine.detail, /Reinstall it/);
});

test('pnpm resolved to a script (prefixArgs shape) runs through them, and reports its real version', async () => {
  // Proves doctor.ts actually spreads `resolveCommand`'s `prefixArgs` into
  // the probe call -- the exact wiring that makes the pnpm.cmd/npm.cmd
  // shapes work end to end, not just that resolveCommand itself is correct.
  const calls: Array<{ exe: string; args: string[] }> = [];
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({
      pnpm: { executable: 'C:\\node.exe', prefixArgs: ['C:\\npm-global\\node_modules\\pnpm\\bin\\pnpm.cjs'] },
      claude: { executable: '/usr/bin/claude' },
    }),
    runProbeFn: (exe, args) => {
      calls.push({ exe, args });
      if (exe === 'C:\\node.exe') return { ok: true, output: '10.33.0' };
      return { ok: true, output: 'claude 2.0.0' };
    },
    checkDaemonFileFn: notLive,
  });
  const pnpmLine = lines.find((l) => l.name === 'pnpm')!;
  assert.equal(pnpmLine.status, 'pass');
  assert.equal(pnpmLine.detail, '10.33.0');
  const pnpmCall = calls.find((c) => c.exe === 'C:\\node.exe')!;
  assert.deepEqual(pnpmCall.args, ['C:\\npm-global\\node_modules\\pnpm\\bin\\pnpm.cjs', '--version']);
});

test('claude not found on PATH fails, and the login line is skipped rather than run against nothing', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({ claude: 'throw', pnpm: { executable: '/usr/bin/pnpm' } }),
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

// Batch 11 ruling 2: a worker's spawn failure is diagnosed by comparing what
// it saw against this line, so the line must say not just PASS/FAIL but HOW
// claude was resolved -- both the path and which of resolveCommand's three
// strategies found it.
test('claude CLI line names both the resolved path and the resolution strategy, on PASS and on found-but-did-not-run', async () => {
  const passLines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({
      claude: { executable: 'C:\\nested\\claude.exe', strategy: 'windows_shim_native_exe' },
      pnpm: { executable: '/usr/bin/pnpm' },
    }),
    runProbeFn: () => ({ ok: true, output: 'claude 2.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const passClaudeLine = passLines.find((l) => l.name === 'claude CLI')!;
  assert.equal(passClaudeLine.status, 'pass');
  assert.match(passClaudeLine.detail, /C:\\nested\\claude\.exe/);
  assert.match(passClaudeLine.detail, /windows_shim_native_exe/);

  const failLines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({
      claude: { executable: 'C:\\nested\\claude.exe', strategy: 'windows_shim_native_exe' },
      pnpm: { executable: '/usr/bin/pnpm' },
    }),
    runProbeFn: () => ({ ok: false, output: 'ENOENT' }),
    checkDaemonFileFn: notLive,
  });
  const failClaudeLine = failLines.find((l) => l.name === 'claude CLI')!;
  assert.equal(failClaudeLine.status, 'fail');
  assert.match(
    failClaudeLine.detail,
    /C:\\nested\\claude\.exe/,
    'a found-but-did-not-run failure must still name the resolved path -- this is exactly the branch a worker spawn failure needs diagnosed'
  );
  assert.match(failClaudeLine.detail, /windows_shim_native_exe/);
});

// Before this fix, resolveCommandFn throwing ANY error (genuinely absent,
// or a shim that exists but couldn't be parsed) was collapsed into the same
// generic "not found on PATH" message -- losing the shim's own path, which
// is exactly the detail ruling 2 exists to surface. resolveCommand
// (process.ts) throws `could not find a real executable or script inside
// shim: <path>` for the latter case; this proves that real message reaches
// the doctor line now, not a generic fallback.
test('claude CLI line surfaces the real resolution failure message (naming the shim), not a generic "not found" fallback', async () => {
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: (name: string) => {
      if (name === 'claude') {
        throw new Error('could not find a real executable or script inside shim: C:\\npm\\claude.cmd');
      }
      return { executable: '/usr/bin/pnpm', prefixArgs: [], strategy: 'direct' };
    },
    runProbeFn: () => ({ ok: true, output: 'pnpm 10.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const claudeLine = lines.find((l) => l.name === 'claude CLI')!;
  assert.equal(claudeLine.status, 'fail');
  assert.match(
    claudeLine.detail,
    /could not find a real executable or script inside shim: C:\\npm\\claude\.cmd/,
    'the real resolution failure (naming the shim) must reach the line, not be swallowed into a generic message'
  );
});

test('claude found but not logged in fails with the exact recovery step, and makes no billed call', async () => {
  const calls: string[][] = [];
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({ claude: { executable: '/usr/bin/claude' }, pnpm: { executable: '/usr/bin/pnpm' } }),
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
    resolveCommandFn: fakeResolve({ claude: { executable: '/usr/bin/claude' }, pnpm: { executable: '/usr/bin/pnpm' } }),
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
    resolveCommandFn: fakeResolve({ claude: { executable: '/usr/bin/claude' }, pnpm: { executable: '/usr/bin/pnpm' } }),
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
    resolveCommandFn: fakeResolve({ claude: { executable: '/usr/bin/claude' }, pnpm: { executable: '/usr/bin/pnpm' } }),
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
    resolveCommandFn: fakeResolve({ claude: { executable: '/usr/bin/claude' }, pnpm: { executable: '/usr/bin/pnpm' } }),
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
    resolveCommandFn: fakeResolve({ claude: { executable: '/usr/bin/claude' }, pnpm: { executable: '/usr/bin/pnpm' } }),
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
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
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
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
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
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  const daemonLine = lines.find((l) => l.name === 'daemon')!;
  assert.equal(daemonLine.status, 'pass');
  assert.match(daemonLine.detail, /not running/);
});

// Batch 15 rulings 11/12, step 3's own acceptance line: "doctor fetches
// every asset route on a real install and prints PASS or FAIL per asset."
// Only meaningful against a LIVE daemon (nothing to fetch from otherwise) --
// see the SKIP test right after this one for that case.

test('a live daemon: doctor fetches every listed asset name against it and prints one PASS/FAIL line per asset', async () => {
  const fetched: Array<{ port: number; name: string }> = [];
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: async () => ({
      status: 'live',
      info: { pid: 4242, port: 55123, token: 'x', startedAt: '2026-01-01T00:00:00.000Z', dbPath: '/x/magarine.db' },
    }),
    listAssetNamesFn: () => ['organism.js', 'tokens.css', 'IBMPlexSans.woff2'],
    fetchAssetFn: async (port, name) => {
      fetched.push({ port, name });
      return name === 'IBMPlexSans.woff2'
        ? { ok: false, detail: 'status 404' }
        : { ok: true, detail: '200 (text/javascript; charset=utf-8)' };
    },
  });

  assert.deepEqual(
    fetched.map((f) => f.name),
    ['organism.js', 'tokens.css', 'IBMPlexSans.woff2']
  );
  assert.ok(fetched.every((f) => f.port === 55123), 'every asset must be fetched against the live daemon\'s own port');

  const organismLine = lines.find((l) => l.name === 'asset organism.js')!;
  assert.equal(organismLine.status, 'pass');
  const fontLine = lines.find((l) => l.name === 'asset IBMPlexSans.woff2')!;
  assert.equal(fontLine.status, 'fail');
  assert.match(fontLine.detail, /404/);
});

test('no daemon running: asset routes are reported SKIP (nothing to fetch from), not silently omitted and not FAIL', async () => {
  let fetchCalled = false;
  const lines = await runDoctor({
    stateDir: tempStateDir(),
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
    listAssetNamesFn: () => ['organism.js'],
    fetchAssetFn: async () => {
      fetchCalled = true;
      return { ok: true, detail: '200' };
    },
  });
  const assetLine = lines.find((l) => l.name === 'assets')!;
  assert.equal(assetLine.status, 'skip');
  assert.match(assetLine.detail, /magarine serve/);
  assert.equal(fetchCalled, false, 'nothing should be fetched when there is no live daemon to fetch from');
});

test('doctorExitCode is 0 only when every line passes, and SKIP does not count as failing', async () => {
  const allPass = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '24.1.0',
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: (_exe, args) => (args[0] === 'auth' ? { ok: true, output: JSON.stringify({ loggedIn: true }) } : { ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.equal(doctorExitCode(allPass), 0);

  const oneFail = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '18.0.0',
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: (_exe, args) => (args[0] === 'auth' ? { ok: true, output: JSON.stringify({ loggedIn: true }) } : { ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
  });
  assert.equal(doctorExitCode(oneFail), 1);

  const oneSkipOnly = await runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '24.1.0',
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
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

// Batch 17 item 5: doctor names the window host -- which browser `magarine app`
// would open -- using the resolver `app` itself uses. Nothing found is a SKIP,
// never a FAIL: no window is degraded, not broken.
async function doctorWithHost(host: ReturnType<NonNullable<Parameters<typeof runDoctor>[0]['resolveWindowHostFn']>>) {
  return runDoctor({
    stateDir: tempStateDir(),
    nodeVersion: '24.1.0',
    resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
    runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
    checkDaemonFileFn: notLive,
    resolveWindowHostFn: () => host,
  });
}

test('doctor names the window host: Chrome by name and path, Edge with the sign-in and sync note', async () => {
  const chrome = (await doctorWithHost({ found: { executable: 'C:\\Chrome\\chrome.exe', kind: 'chrome', strategy: 'chrome' } })).find((l) => l.name === 'window host')!;
  assert.equal(chrome.status, 'pass');
  assert.match(chrome.detail, /chrome/);
  assert.ok(chrome.detail.includes('C:\\Chrome\\chrome.exe'));

  const edge = (await doctorWithHost({ found: { executable: 'C:\\Edge\\msedge.exe', kind: 'edge', strategy: 'edge, with sign-in and sync disabled' } })).find((l) => l.name === 'window host')!;
  assert.equal(edge.status, 'pass');
  assert.ok(edge.detail.startsWith('edge, with sign-in and sync disabled'), edge.detail);
});

test('no window host is a SKIP with the page-still-opens sentence -- never a FAIL, and it does not change doctor\'s exit code', async () => {
  const lines = await doctorWithHost({ none: true, looked: ['C:\\PF\\Google\\Chrome\\Application\\chrome.exe', 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe'] });
  const line = lines.find((l) => l.name === 'window host')!;
  assert.equal(line.status, 'skip');
  assert.ok(line.detail.includes('none found -- the page still opens in any browser at the address serve prints'), line.detail);
  assert.match(line.detail, /looked for: .*chrome\.exe.*msedge\.exe/);
  assert.equal(doctorExitCode(lines), 0, 'a missing nicety must not fail doctor');
});

// Ruling 41: doctor says which adapter a daemon started now would use, and
// where that came from -- flag, environment or default.
test('doctor prints the adapter a daemon started now would use and where that came from', async () => {
  const run = async (adapterChoice: { kind: string; source: 'flag' | 'env' | 'default' }) => {
    const lines = await runDoctor({
      stateDir: tempStateDir(),
      nodeVersion: '24.1.0',
      resolveCommandFn: fakeResolve({ pnpm: { executable: '/usr/bin/fake' }, claude: { executable: '/usr/bin/fake' } }),
      runProbeFn: () => ({ ok: true, output: 'fake 1.0.0' }),
      checkDaemonFileFn: notLive,
      adapterChoice,
    });
    return lines.find((l) => l.name === 'adapter')!;
  };
  const byDefault = await run({ kind: 'claude', source: 'default' });
  assert.equal(byDefault.status, 'pass');
  assert.match(byDefault.detail, /real claude adapter \(from the default\)/);
  const byEnv = await run({ kind: 'fake', source: 'env' });
  assert.match(byEnv.detail, /FAKE adapter \(from the MAGARINE_ADAPTER environment variable\)/);
  const byFlag = await run({ kind: 'fake', source: 'flag' });
  assert.match(byFlag.detail, /FAKE adapter \(from --adapter\)/);
  const bogus = await run({ kind: 'bogus', source: 'env' });
  assert.equal(bogus.status, 'fail');
  assert.match(bogus.detail, /unknown adapter "bogus"/);
});

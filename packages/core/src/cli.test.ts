import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';
import { deriveTestCliCwd, testTempRoot } from './testSupport.ts';

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

// Batch 6 item 5: this file's own private root under the OS temp directory
// (testSupport.ts's testTempRoot), rather than every test creating its own
// prefixed directory directly inside the shared tmpdir() -- see that
// function's doc comment for why (batch-4-closeout.md section 5 item 2's
// flake). Every individual test below still gets its own mkdtemp'd
// subdirectory and its own try/finally cleanup; this only changes where in
// the filesystem hierarchy that subdirectory lives.
const testRoot = testTempRoot('cli');
after(testRoot.cleanup);

async function run(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged({
    executable: process.execPath,
    args: [cliPath, ...args],
    env: opts.env,
    cwd: opts.cwd ?? deriveTestCliCwd(args),
  });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  return { code: result.code, stdout, stderr };
}

test('CLI drives a project through project create, ticket add, dep add, and run --until-idle', async () => {
  const dir = mkdtempSync(join(testRoot.root,'magarine-cli-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'Demo', '--json', '--db', dbFile]);
    assert.equal(projectRes.code, 0, projectRes.stderr);
    const project = JSON.parse(projectRes.stdout);

    const t1Res = await run(['ticket', 'add', '--project', project.id, '--title', 'T1', '--json', '--db', dbFile]);
    const t1 = JSON.parse(t1Res.stdout);
    const t2Res = await run(['ticket', 'add', '--project', project.id, '--title', 'T2', '--json', '--db', dbFile]);
    const t2 = JSON.parse(t2Res.stdout);
    const t3Res = await run(['ticket', 'add', '--project', project.id, '--title', 'T3', '--json', '--db', dbFile]);
    const t3 = JSON.parse(t3Res.stdout);

    await run(['dep', 'add', '--project', project.id, '--ticket', t3.id, '--depends-on', t1.id, '--db', dbFile]);
    await run(['dep', 'add', '--project', project.id, '--ticket', t3.id, '--depends-on', t2.id, '--db', dbFile]);

    const runRes = await run([
      'run',
      '--until-idle',
      '--project',
      project.id,
      '--max-parallel',
      '2',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(runRes.code, 0, runRes.stderr);

    const statusRes = await run(['status', '--project', project.id, '--json', '--db', dbFile]);
    const tickets = JSON.parse(statusRes.stdout) as Array<{ id: string; status: string }>;
    assert.equal(tickets.length, 3);
    for (const t of tickets) {
      assert.equal(t.status, 'DONE', `${t.id} should be DONE`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a dependent ticket created before its blocker never runs ahead of it', async () => {
  // Exact repro reported against this CLI: create the dependent ticket
  // first (the order any real user is forced into, since you cannot name a
  // ticket in a dependency before it exists), then the blocker, then wire
  // the dependency. The dependent must not be runnable until the blocker
  // is DONE, regardless of creation order.
  const dir = mkdtempSync(join(testRoot.root,'magarine-cli-order-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'ordertest', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const dependentRes = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'DEPENDENT',
      '--json',
      '--db',
      dbFile,
    ]);
    const dependent = JSON.parse(dependentRes.stdout);

    const blockerRes = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'BLOCKER',
      '--json',
      '--db',
      dbFile,
    ]);
    const blocker = JSON.parse(blockerRes.stdout);

    await run([
      'dep',
      'add',
      '--project',
      project.id,
      '--ticket',
      dependent.id,
      '--depends-on',
      blocker.id,
      '--db',
      dbFile,
    ]);

    const beforeTick = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    const dependentBefore = beforeTick.find((t) => t.id === dependent.id)!;
    assert.equal(dependentBefore.status, 'OPEN', 'DEPENDENT must not be READY before BLOCKER is DONE');

    const tickRes = await run(['tick', '--project', project.id, '--json', '--db', dbFile]);
    const tickResult = JSON.parse(tickRes.stdout) as { started: Array<{ ticketId: string }> };
    assert.deepEqual(
      tickResult.started.map((s) => s.ticketId),
      [blocker.id],
      'only BLOCKER may start; DEPENDENT has not been unblocked yet'
    );

    const afterTick = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    const dependentAfter = afterTick.find((t) => t.id === dependent.id)!;
    assert.notEqual(dependentAfter.status, 'DONE', 'DEPENDENT must not have run to completion yet');

    await run(['run', '--until-idle', '--project', project.id, '--json', '--db', dbFile]);
    const final = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    for (const t of final) {
      assert.equal(t.status, 'DONE');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown flag is reported by name instead of failing deep inside a DB constraint', async () => {
  const dir = mkdtempSync(join(testRoot.root,'magarine-cli-flag-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);
    const t1 = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'A', '--json', '--db', dbFile])).stdout
    );
    const t2 = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'B', '--json', '--db', dbFile])).stdout
    );

    const res = await run([
      'dep',
      'add',
      '--project',
      project.id,
      '--ticket',
      t1.id,
      '--blocked-by', // typo for --depends-on
      t2.id,
      '--db',
      dbFile,
    ]);

    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Unknown flag/);
    assert.match(res.stderr, /--blocked-by/);
    assert.match(res.stderr, /--depends-on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticket add against a nonexistent project fails with a typed "no such project" message, not a raw DB constraint error', async () => {
  // Batch 10 (Role O): `plan --project <bogus>` has always failed cleanly
  // via commands/plan.ts's PlanError; `ticket add --project <bogus>` used to
  // fall straight through to createTicket's raw INSERT and surface SQLite's
  // own foreign-key-constraint wording instead. Driven through the real CLI
  // entry point, not by calling createTicket/getProject directly, so this
  // proves the actual command-line behaviour a user would see.
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-ticketadd-badproject-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['ticket', 'add', '--project', 'tkt_does_not_exist', '--title', 'T', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such project: tkt_does_not_exist/);
    assert.doesNotMatch(res.stderr, /FOREIGN KEY|CONSTRAINT/i, 'must not leak a raw SQLite constraint message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan then run --until-idle exercises manager_proposal through the fake adapter via --fake-outcome, with no daemon running', async () => {
  // Batch 10 (Role O): manager_proposal has been a FakeAdapter script kind
  // since batch 9 (managerScheduler.test.ts drives it directly against the
  // adapter), but neither --fake-script nor --fake-outcome accepted it, so
  // this path was reachable only from a test file, never from the command
  // line -- exactly the gap this test now closes. No `proposal` payload can
  // be passed through a bare CLI flag, so this exercises the "manager ran
  // but never wrote proposal.json" shape: a malformed/retryable result,
  // proven here by the ticket landing back on READY rather than DONE.
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-manager-proposal-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'ManagerProposalDemo', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const planRes = await run(['plan', '--project', project.id, '--mission', 'ship the thing', '--json', '--db', dbFile]);
    assert.equal(planRes.code, 0, planRes.stderr);
    const managerTicket = JSON.parse(planRes.stdout) as { id: string };

    const runRes = await run([
      'run',
      '--until-idle',
      '--project',
      project.id,
      '--fake-outcome',
      `${managerTicket.id}=manager_proposal`,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(runRes.code, 0, runRes.stderr);

    const statusRes = await run(['status', '--project', project.id, '--json', '--db', dbFile]);
    const tickets = JSON.parse(statusRes.stdout) as Array<{ id: string; status: string }>;
    // A manager_proposal script with no proposal payload never writes
    // proposal.json, so every attempt is rejected as malformed (retryable);
    // `run --until-idle` keeps retrying the same scripted outcome until
    // max_attempts is exhausted, landing FAILED -- never DONE, and never any
    // new ticket created, since no proposal was ever actually applied.
    assert.equal(tickets.length, 1, 'no proposal was ever applied, so no new tickets should exist');
    const after = tickets.find((t) => t.id === managerTicket.id)!;
    assert.equal(after.status, 'FAILED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// State directory resolution (paths.ts), driven through the real CLI
// entry point rather than by calling resolveStateDir() directly, per
// batch-4-spec.md section 1 ruling 5: nothing is written under the current
// working directory unless the user asked for it.

test('--state-dir places the database under <state-dir>/magarine.db, not the current working directory', async () => {
  const stateDir = mkdtempSync(join(testRoot.root,'magarine-statedir-'));
  try {
    const res = await run(['project', 'create', '--name', 'P', '--state-dir', stateDir, '--json']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(stateDir, 'magarine.db')), 'db file must be created under --state-dir');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('MAGARINE_HOME places the database under <MAGARINE_HOME>/magarine.db when --state-dir and --db are both absent', async () => {
  const home = mkdtempSync(join(testRoot.root,'magarine-magarinehome-'));
  try {
    const res = await run(['project', 'create', '--name', 'P', '--json'], {
      env: { ...process.env, MAGARINE_HOME: home },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(home, 'magarine.db')), 'db file must be created under MAGARINE_HOME');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--db still overrides --state-dir as an explicit path', async () => {
  const stateDir = mkdtempSync(join(testRoot.root,'magarine-statedir-override-'));
  const dbFile = join(stateDir, 'custom.db');
  try {
    const res = await run(['project', 'create', '--name', 'P', '--state-dir', stateDir, '--db', dbFile, '--json']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(dbFile), '--db path must be used verbatim');
    assert.ok(
      !existsSync(join(stateDir, 'magarine.db')),
      '--db must not also produce a state-dir-relative magarine.db'
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('with no --state-dir, no MAGARINE_HOME, and no --db, the daemon falls back to <home>/.magarine and never writes under the process cwd', async () => {
  const fakeHome = mkdtempSync(join(testRoot.root,'magarine-fakehome-'));
  const scratchCwd = mkdtempSync(join(testRoot.root,'magarine-scratchcwd-'));
  try {
    const res = await run(['project', 'create', '--name', 'P', '--json'], {
      cwd: scratchCwd,
      // node:os.homedir() reads USERPROFILE on Windows, HOME on POSIX;
      // overriding both makes the fallback path deterministic regardless
      // of the host machine actually running this test. MAGARINE_HOME is
      // explicitly cleared so a value set on the host doesn't leak in.
      env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, MAGARINE_HOME: '' },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(
      existsSync(join(fakeHome, '.magarine', 'magarine.db')),
      'db file must land under <home>/.magarine/magarine.db'
    );
    assert.ok(
      !existsSync(join(scratchCwd, '.magarine')),
      'nothing may be written under the current working directory unless the user asked for it'
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});

// Batch 10 (Role Q): the five likeliest owner mistakes, each driven through
// the real CLI entry point (spawning cli.ts, not calling the functions
// underneath) -- the whole point is what the owner actually sees on their
// screen, not what the function they never call returns. Four of the five
// already had friendly, typed-error handling in this file before this role
// touched it (ticket add's TicketAddError, decide/retry's DecideError/
// RetryError, cancel's daemon-only message, and the budget floor's own
// message from store.ts); what was missing was a test proving each one
// through the CLI itself rather than only against the command function.

test('cancel without a running daemon fails with a plain sentence naming the fix, not a raw error', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-cancel-nodaemon-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['cancel', '--ticket', 'tkt_whatever', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /cancel requires a running daemon/i);
    assert.match(res.stderr, /magarine serve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decide against a ticket id that does not exist fails with a plain "no such ticket" message', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-decide-badticket-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['decide', '--ticket', 'tkt_does_not_exist', '--answer', 'x', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such ticket: tkt_does_not_exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retry against a ticket id that does not exist fails with a plain "no such ticket" message', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-retry-badticket-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['retry', '--ticket', 'tkt_does_not_exist', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such ticket: tkt_does_not_exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticket add --budget below the floor fails with a plain sentence naming the floor, not a stack trace', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-budgetfloor-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);
    const res = await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--budget', '0.01', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /at least \$0\.25/);
    assert.doesNotMatch(res.stderr, /at\s+(file:|Object\.|async)/, 'must not leak a raw stack trace to the owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor runs through the real CLI entry point and prints one PASS/FAIL/SKIP line per check', async () => {
  // Real machine, real claude/pnpm/node -- this proves the WIRING (cli.ts
  // actually calls runDoctor and prints its output in both formats), not
  // any specific PASS/FAIL/SKIP content. The content of each line,
  // including the "claude not logged in" branch, is covered deterministically
  // with injected fakes in commands/doctor.test.ts -- faking a real
  // logged-out `claude` binary at the subprocess/PATH level for this test
  // too would need a fragile cross-platform executable shim for little
  // additional proof, so it was not built; noted here rather than silently
  // left out.
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-doctor-'));
  try {
    const res = await run(['doctor', '--state-dir', dir]);
    for (const name of ['Node.js version', 'pnpm', 'claude CLI', 'claude login', 'state directory', 'daemon']) {
      assert.match(
        res.stdout,
        new RegExp(`^(PASS|FAIL|SKIP) {2}${name.replace('.', '\\.')}`, 'm'),
        `missing a line for "${name}" in:\n${res.stdout}`
      );
    }
    assert.ok(res.code === 0 || res.code === 1, `exit code should be 0 or 1, got ${res.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor --json prints one machine-readable line per check through the real CLI entry point', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-doctor-json-'));
  try {
    const res = await run(['doctor', '--state-dir', dir, '--json']);
    const lines = JSON.parse(res.stdout) as Array<{ name: string; status: string; detail: string }>;
    assert.ok(Array.isArray(lines) && lines.length >= 6);
    assert.ok(lines.every((l) => ['pass', 'fail', 'skip'].includes(l.status)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor --paid is accepted as a known flag, without actually calling out to a real claude', async () => {
  // Does not assert doctor's own outcome -- only that `--paid` reaches
  // FLAG_SPECS/runDoctor rather than being reported as an unknown flag, per
  // this file's own "an unknown flag is reported by name" test above for
  // every other command. PATH is overridden to a directory with nothing in
  // it so `resolveExecutable('claude')` fails and `claudeExe` stays
  // undefined -- `runDoctor`'s `--paid` branch is gated on `claudeExe` being
  // set, so this is what keeps a real, billed `claude -p` call from ever
  // firing here, on this machine or the Orchestrator's twenty cold runs.
  // Spend stays at zero for this whole role; this test proves the flag is
  // wired, not that a real paid call succeeds.
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-doctor-paid-flag-'));
  try {
    const res = await run(['doctor', '--state-dir', dir, '--paid'], {
      env: { ...process.env, PATH: dir, Path: dir },
    });
    assert.doesNotMatch(res.stderr, /Unknown flag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Batch 10 owner walk finding 3 (docs/strategy/batch-10-owner-walk.md):
// `board`/`inbox`/`status` used to accept ANY project id, including one
// that never existed, and print a calm, empty result at exit 0 --
// indistinguishable from "no tickets yet" to an owner who typoed or pasted
// a stale id. `plan`/`ticket add` already refused this at creation time;
// these three read paths never got the same check. Each below is driven
// through the real CLI entry point, matching the message `plan`/`ticket
// add` already use.

test('board against a project id that does not exist fails with "no such project", not a calm empty board', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-board-badproject-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['board', '--project', 'proj_does_not_exist', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such project: proj_does_not_exist/);
    assert.doesNotMatch(res.stdout, /no tickets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox against a project id that does not exist fails with "no such project", not a calm empty inbox', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-inbox-badproject-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['inbox', '--project', 'proj_does_not_exist', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such project: proj_does_not_exist/);
    assert.doesNotMatch(res.stdout, /inbox is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status against a project id that does not exist fails with "no such project", not silence', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-status-badproject-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['status', '--project', 'proj_does_not_exist', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such project: proj_does_not_exist/);
    assert.equal(res.stdout, '', 'status used to print nothing at all on a bad id -- now it must fail loudly instead, not just stay quiet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board/inbox/status all still work normally against a project that DOES exist', async () => {
  // The three tests above prove the refusal; this proves the fix didn't
  // also break the ordinary path for all three in the same stroke.
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-goodproject-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const boardRes = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.equal(boardRes.code, 0, boardRes.stderr);
    assert.match(boardRes.stdout, /no tickets/);

    const inboxRes = await run(['inbox', '--project', project.id, '--db', dbFile]);
    assert.equal(inboxRes.code, 0, inboxRes.stderr);

    const statusRes = await run(['status', '--project', project.id, '--json', '--db', dbFile]);
    assert.equal(statusRes.code, 0, statusRes.stderr);
    assert.deepEqual(JSON.parse(statusRes.stdout), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Batch 10 owner walk finding 4: following the root README's own
// `--mission "$(cat scope.md)"` line produced a board row broken across
// several lines with raw markdown embedded in it. Originally fixed
// display-only, since batch 9's deriveManagerTitle (removed in batch 11
// part 2 along with planMission) stored the raw multi-line mission as the
// title verbatim. Batch 11 part 2's planWithMission (commands/plan.ts) now
// fixes the STORED title too -- first non-empty line, capped at 80
// characters, via the same truncateTitleForDisplay (board.ts) this test
// still also exercises for rendering -- so this proves both layers agree,
// not just the display one.

test('a multi-line mission title is shown as a single truncated line on board and status, not broken across rows', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-multiline-title-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const mission = '\n\n# Scope: a tiny reference on SQLite journal modes\n\nWrite three files and an index that links them.';
    const planRes = await run(['plan', '--project', project.id, '--mission', mission, '--json', '--db', dbFile]);
    assert.equal(planRes.code, 0, planRes.stderr);

    const boardRes = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.equal(boardRes.code, 0, boardRes.stderr);
    const boardLines = boardRes.stdout.trimEnd().split('\n');
    // One header line plus exactly one ticket row -- if the title's
    // newlines had leaked through, this row alone would span several lines.
    assert.equal(boardLines.length, 2, `expected exactly 2 lines, got:\n${boardRes.stdout}`);
    assert.doesNotMatch(boardRes.stdout.trimEnd(), /\n\n/);
    assert.match(boardLines[1], /# Scope: a tiny reference on SQLite journal modes/);

    const statusRes = await run(['status', '--project', project.id, '--db', dbFile]);
    assert.equal(statusRes.code, 0, statusRes.stderr);
    assert.equal(statusRes.stdout.trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Batch 10 owner walk finding 2, and item 2 of the follow-up brief:
// `project list` (so closing the terminal after `project create` no longer
// makes a project unreachable) and `--project` accepting a name as well as
// an id on every project-taking command, since a name is what a person
// actually remembers.

test('project list is empty for a fresh database, and shows created projects afterward', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-projectlist-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const emptyRes = await run(['project', 'list', '--db', dbFile]);
    assert.equal(emptyRes.code, 0, emptyRes.stderr);
    assert.match(emptyRes.stdout, /no projects yet/);

    const projectRes = await run(['project', 'create', '--name', 'Alpha', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const listRes = await run(['project', 'list', '--db', dbFile]);
    assert.equal(listRes.code, 0, listRes.stderr);
    assert.match(listRes.stdout, new RegExp(`^${project.id}\\tAlpha\\t`));

    const jsonRes = await run(['project', 'list', '--json', '--db', dbFile]);
    const entries = JSON.parse(jsonRes.stdout);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, project.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--project accepts the project\'s exact name, not just its id, on board/ticket add/plan', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-projectname-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const projectRes = await run(['project', 'create', '--name', 'My Named Project', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);

    const boardRes = await run(['board', '--project', 'My Named Project', '--db', dbFile]);
    assert.equal(boardRes.code, 0, boardRes.stderr);
    assert.match(boardRes.stdout, /no tickets/);

    const ticketRes = await run(['ticket', 'add', '--project', 'My Named Project', '--title', 'T1', '--json', '--db', dbFile]);
    assert.equal(ticketRes.code, 0, ticketRes.stderr);
    const ticket = JSON.parse(ticketRes.stdout);
    assert.equal(ticket.projectId, project.id, 'the ticket must be attached to the real id, not the literal name');

    const planRes = await run(['plan', '--project', 'My Named Project', '--mission', 'do the thing', '--json', '--db', dbFile]);
    assert.equal(planRes.code, 0, planRes.stderr);
    assert.equal(JSON.parse(planRes.stdout).projectId, project.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--project with a name matching no project fails with "no such project", naming what was typed', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-projectname-notfound-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['board', '--project', 'Totally Made Up Name', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such project: Totally Made Up Name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--project with a name matching two projects refuses ambiguously, listing both ids, rather than silently picking one', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-projectname-ambiguous-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const first = JSON.parse((await run(['project', 'create', '--name', 'Dup', '--json', '--db', dbFile])).stdout);
    const second = JSON.parse((await run(['project', 'create', '--name', 'Dup', '--json', '--db', dbFile])).stdout);

    const res = await run(['board', '--project', 'Dup', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /matches 2 projects by name/);
    assert.match(res.stderr, new RegExp(first.id));
    assert.match(res.stderr, new RegExp(second.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Batch 15 ruling 7 item 1: `activity --progress --ticket <id>`.

test('activity --progress without --ticket refuses rather than guessing which ticket', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-progress-no-ticket-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['activity', '--progress', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /--progress requires --ticket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity --progress --ticket <id> reports (no runs yet) for a ticket that has never run, as JSON and as text', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-progress-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const project = JSON.parse((await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile])).stdout);
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 't', '--json', '--db', dbFile])).stdout
    );

    const jsonRes = await run(['activity', '--progress', '--ticket', ticket.id, '--json', '--db', dbFile]);
    assert.equal(jsonRes.code, 0, jsonRes.stderr);
    assert.deepEqual(JSON.parse(jsonRes.stdout), []);

    const textRes = await run(['activity', '--progress', '--ticket', ticket.id, '--db', dbFile]);
    assert.equal(textRes.code, 0, textRes.stderr);
    assert.match(textRes.stdout, /no runs yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Batch 19 mini-phase 1A: worker profiles ----------------------------

test('profile list prints exactly six seeded rows on a fresh database', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-profile-list-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['profile', 'list', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const profiles = JSON.parse(res.stdout) as Array<{ name: string; model: string; status: string }>;
    assert.deepEqual(
      profiles.map((p) => [p.name, p.model, p.status]),
      [
        ['Architect', 'claude-opus-5', 'idle'],
        ['Developer', 'claude-sonnet-5', 'idle'],
        ['Reviewer', 'claude-sonnet-5', 'idle'],
        ['Tester', 'claude-sonnet-5', 'idle'],
        ['Researcher', 'claude-haiku-4-5-20251001', 'idle'],
        ['Scribe', 'claude-haiku-4-5-20251001', 'idle'],
      ]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile add creates a row, profile set renames it without changing its id, and profile retire hides it from profile list', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-profile-crud-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const addRes = await run([
      'profile', 'add', '--name', 'Scout', '--model', 'claude-haiku-4-5-20251001', '--purpose', 'quick lookups', '--json', '--db', dbFile,
    ]);
    assert.equal(addRes.code, 0, addRes.stderr);
    const created = JSON.parse(addRes.stdout);
    assert.equal(created.name, 'Scout');

    const setRes = await run(['profile', 'set', '--profile', 'Scout', '--name', 'Scout2', '--json', '--db', dbFile]);
    assert.equal(setRes.code, 0, setRes.stderr);
    const renamed = JSON.parse(setRes.stdout);
    assert.equal(renamed.id, created.id, 'renaming must keep the same id');
    assert.equal(renamed.name, 'Scout2');

    const retireRes = await run(['profile', 'retire', '--profile', renamed.id, '--json', '--db', dbFile]);
    assert.equal(retireRes.code, 0, retireRes.stderr);

    const listRes = await run(['profile', 'list', '--json', '--db', dbFile]);
    const names = (JSON.parse(listRes.stdout) as Array<{ name: string }>).map((p) => p.name);
    assert.ok(!names.includes('Scout2'), 'a retired profile must not appear in profile list');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile add rejects an unknown model with a plain sentence, not a stack trace', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-profile-badmodel-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const res = await run(['profile', 'add', '--name', 'Bad', '--model', 'not-a-real-model', '--purpose', 'p', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /unknown model/);
    assert.doesNotMatch(res.stderr, /at\s+(file:|Object\.|async)/, 'must not leak a raw stack trace to the owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance line 3: `ticket add --profile Developer --model claude-opus-5`
// fails with the one sentence; each alone succeeds.
test('ticket add --profile and --model together fail with the one sentence; each alone succeeds', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-ticket-profile-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const project = JSON.parse((await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile])).stdout);

    const bothRes = await run([
      'ticket', 'add', '--project', project.id, '--title', 'T', '--profile', 'Developer', '--model', 'claude-opus-5', '--db', dbFile,
    ]);
    assert.notEqual(bothRes.code, 0);
    assert.match(bothRes.stderr, /choose a profile or a model, not both/);

    const profileOnlyRes = await run([
      'ticket', 'add', '--project', project.id, '--title', 'T1', '--profile', 'Developer', '--json', '--db', dbFile,
    ]);
    assert.equal(profileOnlyRes.code, 0, profileOnlyRes.stderr);
    const t1 = JSON.parse(profileOnlyRes.stdout);
    assert.equal(t1.model, null);
    assert.ok(t1.profileId, 'a profile-only ticket must record a profileId');

    const modelOnlyRes = await run([
      'ticket', 'add', '--project', project.id, '--title', 'T2', '--model', 'claude-opus-5', '--json', '--db', dbFile,
    ]);
    assert.equal(modelOnlyRes.code, 0, modelOnlyRes.stderr);
    const t2 = JSON.parse(modelOnlyRes.stdout);
    assert.equal(t2.model, 'claude-opus-5');
    assert.equal(t2.profileId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticket add --profile against a retired profile fails with a plain sentence', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-cli-ticket-retired-profile-'));
  const dbFile = join(dir, 'magarine.db');
  try {
    const project = JSON.parse((await run(['project', 'create', '--name', 'p', '--json', '--db', dbFile])).stdout);
    const profiles = JSON.parse((await run(['profile', 'list', '--json', '--db', dbFile])).stdout) as Array<{ id: string; name: string }>;
    const developerId = profiles.find((p) => p.name === 'Developer')!.id;
    await run(['profile', 'retire', '--profile', 'Developer', '--db', dbFile]);
    // Review fix (Low 7): a retired name is reusable and no longer resolves
    // by name (getWorkerProfileByName only matches the active row), so the
    // retired profile is referenced by its id here -- the id keeps working
    // regardless of retirement (store.ts's getWorkerProfile).
    const res = await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--profile', developerId, '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /retired and cannot be assigned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

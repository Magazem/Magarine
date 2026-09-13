import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  checkDaemonFile,
  daemonFilePath,
  generateDaemonToken,
  isPidAlive,
  readDaemonFile,
  removeDaemonFile,
  startDaemonLoop,
  writeDaemonFile,
  type DaemonFileInfo,
} from './daemon.ts';
import { openDb } from './db/index.ts';
import { createProject, createRun, createTicket, getRun, getTicket, listTicketsByStatus } from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { testTempRoot } from './testSupport.ts';

// Unit-level coverage for the plain file/pid bookkeeping daemon.ts owns --
// no process spawning needed here (that's serve.test.ts, which exercises
// the actual daemon process per this batch's testing rule). These are pure
// filesystem and OS-signal functions, the same class of thing store.ts's own
// direct unit tests already cover for plain data access.

const testRoot = testTempRoot('daemon-file');
after(testRoot.cleanup);

function sampleInfo(overrides: Partial<DaemonFileInfo> = {}): DaemonFileInfo {
  return {
    pid: process.pid,
    port: 12345,
    token: generateDaemonToken(),
    startedAt: new Date().toISOString(),
    dbPath: '/tmp/does-not-matter/magarine.db',
    ...overrides,
  };
}

test('generateDaemonToken produces distinct, non-trivial tokens', () => {
  const a = generateDaemonToken();
  const b = generateDaemonToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, 'token should not be a trivially short/guessable value');
});

test('writeDaemonFile then readDaemonFile round-trips exactly, and the file is owner-only (mode 0o600)', () => {
  const dir = mkdtempSync(join(testRoot.root, 'roundtrip-'));
  const info = sampleInfo();
  writeDaemonFile(dir, info);

  const readBack = readDaemonFile(dir);
  assert.deepEqual(readBack, info);

  if (process.platform !== 'win32') {
    const mode = statSync(daemonFilePath(dir)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('readDaemonFile returns undefined when no file exists', () => {
  const dir = mkdtempSync(join(testRoot.root, 'absent-'));
  assert.equal(readDaemonFile(dir), undefined);
});

test('readDaemonFile returns undefined (not a throw) for a corrupted file', () => {
  const dir = mkdtempSync(join(testRoot.root, 'corrupt-'));
  writeDaemonFile(dir, sampleInfo());
  // Corrupt it in place: not valid JSON at all.
  writeFileSync(daemonFilePath(dir), '{not valid json');
  assert.equal(readDaemonFile(dir), undefined);
});

test('readDaemonFile returns undefined for well-formed JSON missing a required field', () => {
  const dir = mkdtempSync(join(testRoot.root, 'partial-'));
  writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: 1, port: 2 }));
  assert.equal(readDaemonFile(dir), undefined);
});

test('removeDaemonFile deletes the file and is a no-op if it never existed', () => {
  const dir = mkdtempSync(join(testRoot.root, 'remove-'));
  writeDaemonFile(dir, sampleInfo());
  assert.ok(existsSync(daemonFilePath(dir)));
  removeDaemonFile(dir);
  assert.ok(!existsSync(daemonFilePath(dir)));
  assert.doesNotThrow(() => removeDaemonFile(dir));
});

test('isPidAlive is true for this process, false for a made-up pid', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999), false);
});

test('checkDaemonFile: absent file', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'check-absent-'));
  const result = await checkDaemonFile(dir);
  assert.equal(result.status, 'absent');
});

test('checkDaemonFile: live pid with no healthCheck given is reported live', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'check-live-'));
  writeDaemonFile(dir, sampleInfo({ pid: process.pid }));
  const result = await checkDaemonFile(dir);
  assert.equal(result.status, 'live');
  assert.equal(result.info?.pid, process.pid);
});

test('checkDaemonFile: a dead pid is reported stale and overwritten on the next write', async () => {
  // Spawn a trivial child, wait for it to exit, and reuse its now-dead pid --
  // guaranteed dead rather than a made-up number that happens not to collide.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid: number = await new Promise((resolve) => {
    const pid = child.pid!;
    child.on('exit', () => resolve(pid));
  });

  const dir = mkdtempSync(join(testRoot.root, 'check-stale-'));
  const staleToken = generateDaemonToken();
  writeDaemonFile(dir, sampleInfo({ pid: deadPid, token: staleToken }));

  const result = await checkDaemonFile(dir);
  assert.equal(result.status, 'stale');

  // Overwriting it (what serve() does on a 'stale'/'absent' result) produces
  // a file with a different token -- the stale credential does not survive.
  writeDaemonFile(dir, sampleInfo({ pid: process.pid }));
  const fresh = readDaemonFile(dir);
  assert.notEqual(fresh?.token, staleToken);
  assert.equal(fresh?.pid, process.pid);
});

test('checkDaemonFile: a live pid but a healthCheck that reports unhealthy is still stale', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'check-unhealthy-'));
  writeDaemonFile(dir, sampleInfo({ pid: process.pid }));
  const result = await checkDaemonFile(dir, async () => false);
  assert.equal(result.status, 'stale');
});

test('checkDaemonFile: a live pid and a healthCheck that reports healthy is live', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'check-healthy-'));
  writeDaemonFile(dir, sampleInfo({ pid: process.pid }));
  const result = await checkDaemonFile(dir, async () => true);
  assert.equal(result.status, 'live');
});

// startDaemonLoop tests below are in-process against a real sqlite db and
// the real (unscripted-by-default) FakeAdapter, the same way scheduler.ts's
// own tick()/runUntilIdle() get tested directly rather than only through a
// spawned CLI process (see scheduler.test.ts). This is the core scheduling
// primitive layer, not the cross-process daemon behaviour itself: nothing
// here fakes what a second, real OS process would see (that is
// commands/serve.test.ts's job, which spawns the real `magarine serve` CLI
// command and talks to it as a genuinely separate process). The signal
// handling itself (registering SIGINT/SIGTERM and calling DaemonLoop.stop())
// lives in commands/serve.ts, not here; see serve.test.ts's header comment
// for why *that* cross-process trigger cannot be exercised on Windows
// without a native dependency, and why calling stop() directly here is the
// same substitution scheduler.test.ts's own SIGINT test already makes
// (`process.emit('SIGINT')` in-process, not an external kill).

test('startDaemonLoop ticks every project in the database, not just one', async () => {
  const db = openDb(':memory:');
  const adapter = new FakeAdapter();
  const projectA = createProject(db, { name: 'a', maxParallelWorkers: 1 });
  const projectB = createProject(db, { name: 'b', maxParallelWorkers: 1 });
  const ticketA = createTicket(db, { projectId: projectA.id, title: 'ta' });
  const ticketB = createTicket(db, { projectId: projectB.id, title: 'tb' });
  // Both tickets are OPEN with no dependencies; startDaemonLoop's first tick
  // calls scheduler.ts's tick() per project, and tick() itself resolves
  // readiness before picking up READY tickets -- no separate promotion step
  // needed here, matching how the CLI's own `tick`/`run --until-idle` work.

  const loop = startDaemonLoop({
    db,
    adapter,
    maxParallelWorkers: 1,
    artifactsDir: join(testRoot.root, 'artifacts'),
    tickIntervalMs: 20,
  });
  try {
    // FakeAdapter's default (unscripted) script is 'succeed' with no delay,
    // so both tickets should reach DONE almost immediately once the first
    // tick fires and their terminal events are applied.
    const deadline = Date.now() + 2000;
    while (
      (getTicket(db, ticketA.id)!.status !== 'DONE' || getTicket(db, ticketB.id)!.status !== 'DONE') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(getTicket(db, ticketA.id)!.status, 'DONE', 'project A ticket should have been ticked');
    assert.equal(getTicket(db, ticketB.id)!.status, 'DONE', 'project B ticket should have been ticked');
  } finally {
    await loop.stop();
  }
});

test('startDaemonLoop recovers an orphaned "running" run at startup, before its first tick', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts: 3 });
  // Simulate a crash: a run left 'running' in the DB with no live handle,
  // the same fixture recovery.test.ts uses for recoverOrphanedRuns directly.
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `run_started:${run.id}` });

  const adapter = new FakeAdapter();
  const loop = startDaemonLoop({
    db,
    adapter,
    maxParallelWorkers: 1,
    artifactsDir: join(testRoot.root, 'artifacts-2'),
    tickIntervalMs: 20,
  });
  try {
    // Recovery runs synchronously inside startDaemonLoop, fully complete
    // before the function even returns -- true immediately, no polling
    // needed. Checked against the ORIGINAL run row (settled unconditionally
    // by recoverOrphanedRuns, a separate call that finishes before the first
    // tick is even fired), not overall ticket status: the ticket itself can
    // legitimately race past READY and back to IN_PROGRESS by the time this
    // line runs, because `void runOneTick()`'s own synchronous prefix (up
    // through scheduler.ts's tick() -> recordTicketTransition('run_started'))
    // executes eagerly, inside the very same call to startDaemonLoop, before
    // control ever returns here -- this test's own FakeAdapter has no
    // scripted delay, so that race is not a flake, it is the normal case.
    const originalRun = getRun(db, run.id)!;
    assert.equal(originalRun.status, 'failed');
    assert.equal(originalRun.failureClass, 'orphaned_on_restart');
    assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);
  } finally {
    await loop.stop();
  }
});

test('DaemonLoop.stop() cancels a hanging worker back to READY without consuming an attempt, and clears the live map', async (t) => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const ticket = createTicket(db, { projectId: project.id, title: 'hangs forever' });
  const adapter = new FakeAdapter();
  adapter.setScript(ticket.id, { kind: 'hang' });

  const loop = startDaemonLoop({
    db,
    adapter,
    maxParallelWorkers: 1,
    artifactsDir: join(testRoot.root, 'artifacts-3'),
    tickIntervalMs: 20,
  });
  // t.after, not try/finally: guarantees the interval is cleared even if an
  // assertion below throws, so one failing assertion can never leave a
  // dangling setInterval that keeps the whole `node --test` process from
  // exiting (the actual failure mode this once produced while writing this
  // test file).
  t.after(() => loop.stop());

  // Poll on `loop.live` itself, not ticket status: the ticket's status flips
  // to IN_PROGRESS inside scheduler.ts's tick() strictly before tick()
  // returns and this loop's `live.set()` runs (see the previous test's
  // comment for the same eager-execution ordering) -- a real, provable gap,
  // not a flake, between "status says IN_PROGRESS" and "live map has the
  // entry". Waiting on live.size instead makes the two assertions consistent
  // by construction rather than racing them against each other.
  const deadline = Date.now() + 2000;
  while (loop.live.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loop.live.size, 1);
  assert.equal(getTicket(db, ticket.id)!.status, 'IN_PROGRESS');

  await loop.stop();

  // Proven by DB state, not by trusting stop() resolving -- same lesson
  // scheduler.test.ts's own SIGINT test is built around.
  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'READY');
  assert.equal(after.attemptCount, 0, 'a daemon-initiated cancel must not consume an attempt');
  assert.equal(listTicketsByStatus(db, project.id, 'IN_PROGRESS').length, 0);
  assert.equal(loop.live.size, 0);

  // Calling stop() again must be a safe no-op, not a double-cancel.
  await assert.doesNotReject(() => loop.stop());
});

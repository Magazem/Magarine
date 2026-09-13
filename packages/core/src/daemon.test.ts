import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  checkDaemonFile,
  daemonFilePath,
  detectShutdownMode,
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

// Batch 9 housekeeping item 1 ruling 2.
test('detectShutdownMode: hard-kill-only on win32, signal everywhere else', () => {
  assert.equal(detectShutdownMode('win32'), 'hard-kill-only');
  assert.equal(detectShutdownMode('linux'), 'signal');
  assert.equal(detectShutdownMode('darwin'), 'signal');
});

test('writeDaemonFile then readDaemonFile round-trips shutdownMode', () => {
  const dir = mkdtempSync(join(testRoot.root, 'shutdown-mode-'));
  const info = sampleInfo({ shutdownMode: 'hard-kill-only' });
  writeDaemonFile(dir, info);
  assert.deepEqual(readDaemonFile(dir), info);
});

// A daemon.json written by a pre-batch-9 build never had this field. Without
// tolerating its absence, this file would fail isDaemonFileInfo and come
// back `undefined` -- every caller treats that identically to "no
// daemon.json at all" (checkDaemonFile reports 'absent'), which would make a
// genuinely live older daemon invisible to a second `serve`'s staleness
// check and risk two daemons racing the same database.
test('readDaemonFile still parses a daemon.json with no shutdownMode field at all (pre-batch-9 file)', () => {
  const dir = mkdtempSync(join(testRoot.root, 'legacy-'));
  const legacy = sampleInfo();
  delete (legacy as { shutdownMode?: unknown }).shutdownMode;
  writeFileSync(daemonFilePath(dir), JSON.stringify(legacy));
  const readBack = readDaemonFile(dir);
  assert.ok(readBack, 'a legacy file missing shutdownMode must still be recognized as a valid daemon.json');
  assert.equal(readBack!.pid, legacy.pid);
});

test('readDaemonFile rejects a shutdownMode value that is neither known literal', () => {
  const dir = mkdtempSync(join(testRoot.root, 'bad-mode-'));
  writeFileSync(daemonFilePath(dir), JSON.stringify({ ...sampleInfo(), shutdownMode: 'nonsense' }));
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

// forceTick/cancelTicket (step 3, backing the API's POST /tick and
// POST /tickets/{id}/cancel) get the same in-process treatment as the rest
// of this file: pure scheduling-primitive logic against a real DB and the
// real FakeAdapter. daemonApi.test.ts covers the cross-process, real-HTTP
// version of the same behaviour.

test('DaemonLoop.forceTick ticks only the named project, registers the started run into the shared live map, and skips a project already at its concurrency cap', async (t) => {
  const db = openDb(':memory:');
  const projectA = createProject(db, { name: 'a', maxParallelWorkers: 1 });
  const projectB = createProject(db, { name: 'b', maxParallelWorkers: 1 });
  const ticketA = createTicket(db, { projectId: projectA.id, title: 'ta' });
  const ticketB = createTicket(db, { projectId: projectB.id, title: 'tb' });
  const adapter = new FakeAdapter();
  adapter.setScript(ticketA.id, { kind: 'hang' });
  adapter.setScript(ticketB.id, { kind: 'hang' });

  // A very long interval: nothing in this test should be explained by the
  // periodic pass firing on its own -- every state change here comes from
  // an explicit forceTick call.
  //
  // maxParallelWorkers: 2 here is the MACHINE-WIDE ceiling (batch 9
  // housekeeping item 1 ruling 1), deliberately looser than either
  // project's own cap of 1 set above -- this test's whole point is proving
  // forceTick respects a project's OWN concurrency cap, not the
  // machine-wide one. A machine-wide cap of 1 would let only one of the two
  // projects' hang-scripted tickets start at all, which would make it
  // impossible to tell "blocked by its own cap" apart from "blocked by the
  // machine-wide ceiling" below.
  const loop = startDaemonLoop({
    db,
    adapter,
    maxParallelWorkers: 2,
    artifactsDir: join(testRoot.root, 'artifacts-4'),
    tickIntervalMs: 60_000,
  });
  t.after(() => loop.stop());

  // The loop's own automatic first tick already fires once at startup
  // (before this line runs) and would have started BOTH projects' tickets
  // on its own, which would make forceTick's own contribution unobservable.
  // Wait for that one pass to fully land, then reason from there.
  const deadline = Date.now() + 2000;
  while (
    (getTicket(db, ticketA.id)!.status !== 'IN_PROGRESS' || getTicket(db, ticketB.id)!.status !== 'IN_PROGRESS') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(getTicket(db, ticketA.id)!.status, 'IN_PROGRESS');
  assert.equal(getTicket(db, ticketB.id)!.status, 'IN_PROGRESS');

  // Both projects are now at their (maxParallelWorkers: 1) cap. A forced
  // tick on either one must find nothing to start -- proving forceTick
  // respects the same concurrency cap tick() always has, not a second,
  // uncapped spawn path.
  const resultA = await loop.forceTick(projectA.id);
  assert.deepEqual(resultA.started, []);
  const resultB = await loop.forceTick(projectB.id);
  assert.deepEqual(resultB.started, []);

  // Cancel A's run to free its slot -- batch 8: this lands ticketA in the
  // terminal CANCELLED, not READY (a person's cancel, distinct from the
  // daemon's own run_cancelled), so a fresh ticket is what proves the slot
  // is actually free. forceTick project A again: the fresh ticket should
  // start, and forceTick must not have touched project B at all (it only
  // ever tick()s the one project it was asked for).
  await loop.cancelTicket(ticketA.id);
  assert.equal(getTicket(db, ticketA.id)!.status, 'CANCELLED');
  const ticketA2 = createTicket(db, { projectId: projectA.id, title: 'ta2' });
  const resultA2 = await loop.forceTick(projectA.id);
  assert.deepEqual(
    resultA2.started.map((s) => s.ticketId),
    [ticketA2.id]
  );
  assert.ok(
    [...loop.live.values()].some((s) => s.ticketId === ticketA2.id),
    'the run forceTick started must be registered in the shared live map'
  );
  assert.equal(getTicket(db, ticketB.id)!.status, 'IN_PROGRESS', "project B must be untouched by project A's forceTick");
});

// Batch 9 housekeeping item 1 ruling 1: `serve --max-parallel` is now the
// MACHINE-WIDE ceiling, summed across every project the daemon ticks -- see
// daemon.ts's `computeProjectCap`. Each project here has its own cap (5)
// generous enough that, before this batch, the two of them together could
// run up to 10 workers at once; this test's whole point is proving the
// daemon never actually lets that happen.
test('the daemon never runs more workers than its machine-wide --max-parallel, even across multiple projects each with room to spare', async (t) => {
  const db = openDb(':memory:');
  const projectA = createProject(db, { name: 'a', maxParallelWorkers: 5 });
  const projectB = createProject(db, { name: 'b', maxParallelWorkers: 5 });
  const ticketsA = [
    createTicket(db, { projectId: projectA.id, title: 'a1' }),
    createTicket(db, { projectId: projectA.id, title: 'a2' }),
    createTicket(db, { projectId: projectA.id, title: 'a3' }),
  ];
  const ticketsB = [
    createTicket(db, { projectId: projectB.id, title: 'b1' }),
    createTicket(db, { projectId: projectB.id, title: 'b2' }),
    createTicket(db, { projectId: projectB.id, title: 'b3' }),
  ];
  const adapter = new FakeAdapter();
  for (const t of [...ticketsA, ...ticketsB]) adapter.setScript(t.id, { kind: 'hang' });

  const loop = startDaemonLoop({
    db,
    adapter,
    maxParallelWorkers: 2,
    artifactsDir: join(testRoot.root, 'artifacts-machine-cap'),
    tickIntervalMs: 20,
  });
  t.after(() => loop.stop());

  const totalInProgress = (): number =>
    listTicketsByStatus(db, projectA.id, 'IN_PROGRESS').length + listTicketsByStatus(db, projectB.id, 'IN_PROGRESS').length;

  // Several ticks' worth of time: with six hang-scripted, otherwise-eligible
  // tickets across two projects each capped at 5, the OLD per-project-only
  // enforcement would have let this settle at 2 (one per project, since
  // each tick() call only ever starts up to its own remaining slots and
  // both projects are ticked every pass) -- the real discriminator is the
  // next block, cancelling one of the two running tickets and confirming a
  // THIRD one is allowed to start only up to the machine-wide ceiling, from
  // either project, not held back by a stale per-project-only view.
  const deadline1 = Date.now() + 2000;
  while (loop.live.size < 2 && Date.now() < deadline1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loop.live.size, 2, 'exactly two workers should be running, the machine-wide ceiling');
  assert.equal(totalInProgress(), 2);

  // Give it several more ticks with nothing cancelled: the ceiling must
  // hold steady, not creep upward as later passes reconsider the same
  // still-eligible READY tickets.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(loop.live.size, 2, 'the machine-wide ceiling must not creep upward on later ticks');
  assert.equal(totalInProgress(), 2);

  // Free one slot. A third ticket (from either project -- whichever tick()
  // reaches first) must start, and the total must still never exceed 2.
  const [someLiveRun] = loop.live.values();
  await loop.cancelTicket(someLiveRun.ticketId);

  const deadline2 = Date.now() + 2000;
  while (loop.live.size < 2 && Date.now() < deadline2) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loop.live.size, 2, 'a freed machine-wide slot must be reused, not left idle');
  assert.equal(totalInProgress(), 2, 'the total across both projects must never exceed the machine-wide ceiling');
});

test('DaemonLoop.cancelTicket cancels a live run for the given ticket, and reports \'not_running\' for one it holds no live run for', async (t) => {
  const db = openDb(':memory:');
  // maxParallelWorkers: 1 -- hangTicket occupies the only slot, so
  // idleTicket is promoted OPEN -> READY by the loop's own automatic tick
  // (resolveReadiness has no concurrency cap of its own) but never actually
  // gets a run started for it. That is exactly the case this test wants:
  // "never started a run" without also needing a dependency graph to hold
  // it back.
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const hangTicket = createTicket(db, { projectId: project.id, title: 'hangs' });
  const idleTicket = createTicket(db, { projectId: project.id, title: 'never started' });
  const adapter = new FakeAdapter();
  adapter.setScript(hangTicket.id, { kind: 'hang' });

  const loop = startDaemonLoop({
    db,
    adapter,
    maxParallelWorkers: 1,
    artifactsDir: join(testRoot.root, 'artifacts-5'),
    tickIntervalMs: 20,
  });
  t.after(() => loop.stop());

  const deadline = Date.now() + 2000;
  while (loop.live.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loop.live.size, 1);

  // A ticket this daemon never started a run for: nothing to cancel,
  // reported distinctly from a real cancellation rather than a silent no-op.
  const notRunning = await loop.cancelTicket(idleTicket.id);
  assert.equal(notRunning, 'not_running');
  assert.equal(getTicket(db, idleTicket.id)!.status, 'READY', 'promoted, but never started -- untouched by cancel');

  const cancelled = await loop.cancelTicket(hangTicket.id);
  assert.equal(cancelled, 'cancelled');
  // Batch 8 ruling: a person's cancel lands the ticket in the terminal
  // CANCELLED, not READY -- landing in READY was the original design this
  // ruling replaced, because the daemon's own next tick would silently
  // restart it moments later (found by hand: two runs, the second starting
  // 0.8 seconds after the first was cancelled).
  assert.equal(getTicket(db, hangTicket.id)!.status, 'CANCELLED');
  assert.equal(getTicket(db, hangTicket.id)!.attemptCount, 0);
  assert.equal(loop.live.size, 0);

  // The assertion that would have caught the original behaviour: with a
  // live 20ms tick interval still running, give the loop several more
  // passes to prove it does NOT silently restart the cancelled ticket --
  // CANCELLED is simply invisible to tick() (which only ever looks at
  // READY tickets), so this holds by construction, but the whole point of
  // this ruling was that the previous design looked correct until this
  // exact check was made.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(getTicket(db, hangTicket.id)!.status, 'CANCELLED', 'no second run may start on its own');
  assert.equal(loop.live.size, 0);

  // Cancelling the same ticket again once it is no longer live: 'not_running',
  // not a repeat 'cancelled'.
  const again = await loop.cancelTicket(hangTicket.id);
  assert.equal(again, 'not_running');
});

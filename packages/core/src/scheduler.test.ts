import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import {
  addDependency,
  createProject,
  createTicket,
  getRun,
  getTicket,
  isProjectAdapterPaused,
  listArtifactsForTicket,
  listEventsForEntity,
  listTicketsByStatus,
} from './store.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { tick, runUntilIdle } from './scheduler.ts';
import type { AgentAdapter, AgentAdapterCapabilities, TicketEnvelope, WorkerEvent, WorkerHandle, Workspace } from './types.ts';

function setupProject(maxParallelWorkers = 2) {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers });
  const adapter = new FakeAdapter();
  return { db, project, adapter };
}

// adapters/fakeAdapter.ts (outside this role's file ownership: scheduler.ts,
// store.ts, envelope.ts, workspace.ts, types.ts, db/schema.ts+migrations,
// and stateMachine.ts's three new transitions only) has no scripted way to
// produce a non-retryable/adapter_unavailable failure, a `done` result with
// caller-chosen artifacts, or a handle whose envelope can be inspected after
// the fact — its FakeScript union only covers batch 1/2's scenarios. This
// minimal test-only double fills that gap without touching adapters/: it is
// driven by explicit `emit()` calls instead of timers, so tests control
// exactly what the adapter reports and when.
class TestAdapter implements AgentAdapter {
  readonly id = 'test-adapter';
  private readonly listeners = new Map<string, Array<(event: WorkerEvent) => void>>();
  private readonly stopped = new Set<string>();
  readonly startedWith = new Map<string, { ticket: TicketEnvelope; workspace?: Workspace }>();

  async capabilities(): Promise<AgentAdapterCapabilities> {
    return { supportsFiles: true, supportsShell: false, supportsStreaming: true, supportsResume: false };
  }

  async startWorker(input: { ticket: TicketEnvelope; workspace?: Workspace; systemPolicy: string }): Promise<WorkerHandle> {
    const handle: WorkerHandle = {
      id: `testworker_${randomUUID()}`,
      ticketId: input.ticket.ticketId,
      runId: `testrun_${randomUUID()}`,
    };
    this.listeners.set(handle.id, []);
    this.startedWith.set(handle.id, { ticket: input.ticket, workspace: input.workspace });
    return handle;
  }

  async send(): Promise<void> {}

  async observe(handle: WorkerHandle, onEvent: (event: WorkerEvent) => void): Promise<() => void> {
    const list = this.listeners.get(handle.id);
    if (!list) throw new Error(`unknown handle: ${handle.id}`);
    list.push(onEvent);
    return () => {
      const idx = list.indexOf(onEvent);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async stop(handle: WorkerHandle): Promise<void> {
    this.stopped.add(handle.id);
  }

  async destroy(handle: WorkerHandle): Promise<void> {
    await this.stop(handle);
    this.listeners.delete(handle.id);
  }

  emit(handleId: string, event: WorkerEvent): void {
    if (this.stopped.has(handleId)) return;
    for (const listener of this.listeners.get(handleId) ?? []) listener(event);
  }

  isStopped(handleId: string): boolean {
    return this.stopped.has(handleId);
  }
}

test('T1 and T2 run in the same tick while T3 waits, then T3 runs once both are DONE', async () => {
  const { db, project, adapter } = setupProject(2);
  const t1 = createTicket(db, { projectId: project.id, title: 'T1' });
  const t2 = createTicket(db, { projectId: project.id, title: 'T2' });
  const t3 = createTicket(db, { projectId: project.id, title: 'T3' });
  addDependency(db, { ticketId: t3.id, dependsOnTicketId: t1.id });
  addDependency(db, { ticketId: t3.id, dependsOnTicketId: t2.id });

  adapter.setScript(t1.id, { kind: 'succeed' });
  adapter.setScript(t2.id, { kind: 'succeed' });
  adapter.setScript(t3.id, { kind: 'succeed' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };

  const firstTick = await tick(deps);
  assert.deepEqual(
    firstTick.started.map((s) => s.ticketId).sort(),
    [t1.id, t2.id].sort(),
    'T1 and T2 start in the same tick; T3 is still OPEN'
  );
  assert.equal(getTicket(db, t3.id)!.status, 'OPEN');

  await Promise.all(firstTick.started.map((s) => s.done));
  assert.equal(getTicket(db, t1.id)!.status, 'DONE');
  assert.equal(getTicket(db, t2.id)!.status, 'DONE');

  const secondTick = await tick(deps);
  assert.deepEqual(secondTick.started.map((s) => s.ticketId), [t3.id]);

  await Promise.all(secondTick.started.map((s) => s.done));
  assert.equal(getTicket(db, t3.id)!.status, 'DONE');
});

test('tick() refuses to start a ticket that is READY in the row but not actually ready, and demotes it', async () => {
  // Regression for a real bug: resolveReadiness() already reconciles this
  // at the top of tick(), so this test forces the inconsistent row
  // directly (bypassing the state machine, simulating "some other bug put
  // a wrong status in the table") to prove the scheduler itself refuses to
  // run work off a status it hasn't re-verified, independent of whether
  // resolveReadiness ran correctly.
  const { db, project, adapter } = setupProject(1);
  const blocker = createTicket(db, { projectId: project.id, title: 'BLOCKER' });
  const dependent = createTicket(db, { projectId: project.id, title: 'DEPENDENT' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });
  db.prepare("UPDATE tickets SET status = 'READY' WHERE id = ?").run(dependent.id);

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };
  const result = await tick(deps);

  assert.deepEqual(
    result.started.map((s) => s.ticketId),
    [blocker.id],
    'DEPENDENT must not be started even though its row said READY'
  );
  assert.equal(getTicket(db, dependent.id)!.status, 'OPEN', 'demoted back to OPEN instead of being run');
});

test('the concurrency cap holds even when workers hang', async () => {
  const { db, project, adapter } = setupProject(2);
  const t1 = createTicket(db, { projectId: project.id, title: 'T1' });
  const t2 = createTicket(db, { projectId: project.id, title: 'T2' });
  const t3 = createTicket(db, { projectId: project.id, title: 'T3' });
  adapter.setScript(t1.id, { kind: 'hang' });
  adapter.setScript(t2.id, { kind: 'hang' });
  adapter.setScript(t3.id, { kind: 'succeed' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };

  const firstTick = await tick(deps);
  assert.equal(firstTick.started.length, 2, 'cap is 2, both hanging tickets start');

  const secondTick = await tick(deps);
  assert.equal(secondTick.started.length, 0, 'no room left; T3 stays READY, not started');
  assert.equal(getTicket(db, t3.id)!.status, 'READY');

  // T1 and T2 are deliberately left hanging (that is the point of this
  // test) and are never cancelled through the scheduler, so their NONE
  // workspaces are never reclaimed by product code either — a genuinely
  // hung run's temp directory is meant to persist until the daemon decides
  // to cancel it. Removed directly here purely as test hygiene, not as a
  // stand-in for exercising cancellation (see the SIGINT and runTimeoutMs
  // tests below for that).
  for (const started of firstTick.started) {
    const run = getRun(db, started.runId)!;
    if (run.workspaceRef) rmSync(run.workspaceRef, { recursive: true, force: true });
  }
});

test('retry exhaustion reaches FAILED after max_attempts retryable failures', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'flaky', maxAttempts: 2 });
  adapter.setScript(ticket.id, { kind: 'retryable_failure' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };

  const first = await tick(deps);
  await Promise.all(first.started.map((s) => s.done));
  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);

  const second = await tick(deps);
  await Promise.all(second.started.map((s) => s.done));
  assert.equal(getTicket(db, ticket.id)!.status, 'FAILED');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 2);
});

test('a malformed result is treated as a retryable failure, not a crash', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'bad json', maxAttempts: 3 });
  adapter.setScript(ticket.id, { kind: 'malformed_result' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);
});

test('a worker question keeps the ticket IN_PROGRESS and the run continues to a final result', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'asks a question' });
  adapter.setScript(ticket.id, { kind: 'question' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

test('needs_user_decision moves the ticket to BLOCKED', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'needs a human' });
  adapter.setScript(ticket.id, { kind: 'needs_user_decision' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'BLOCKED');
});

test('run usage reported by the adapter is persisted on the run row', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'reports usage' });
  const usage = { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 100 };
  adapter.setScript(ticket.id, { kind: 'succeed', usage });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  const run = getRun(db, result.started[0].runId)!;
  assert.deepEqual(run.usageJson ? JSON.parse(run.usageJson) : null, usage);
});

test('runUntilIdle drives a full dependency chain to completion without manual ticks', async () => {
  const { db, project, adapter } = setupProject(2);
  const t1 = createTicket(db, { projectId: project.id, title: 'T1' });
  const t2 = createTicket(db, { projectId: project.id, title: 'T2' });
  const t3 = createTicket(db, { projectId: project.id, title: 'T3' });
  addDependency(db, { ticketId: t3.id, dependsOnTicketId: t1.id });
  addDependency(db, { ticketId: t3.id, dependsOnTicketId: t2.id });
  adapter.setScript(t1.id, { kind: 'succeed' });
  adapter.setScript(t2.id, { kind: 'succeed' });
  adapter.setScript(t3.id, { kind: 'succeed' });

  await runUntilIdle({ db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id });

  assert.equal(getTicket(db, t1.id)!.status, 'DONE');
  assert.equal(getTicket(db, t2.id)!.status, 'DONE');
  assert.equal(getTicket(db, t3.id)!.status, 'DONE');
  assert.equal(listTicketsByStatus(db, project.id, 'IN_PROGRESS').length, 0);
});

// --- Batch 3: failure routing, workspace routing, artifacts, progress, timeout/interruption ---

test('an adapter_unavailable failure leaves attempt_count unchanged, records an inbox event, and pauses the project adapter; a paused adapter starts nothing on tick', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'needs auth' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id };
  const result = await tick(deps);
  assert.equal(result.started.length, 1);
  const started = result.started[0];

  adapter.emit(started.handle.id, {
    type: 'failure',
    message: 'ADAPTER_UNAVAILABLE: not logged in',
    retryable: false,
    failureClass: 'adapter_unavailable',
  });
  await started.done;

  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'READY');
  assert.equal(after.attemptCount, 0, 'adapter_unavailable must not consume an attempt');

  const run = getRun(db, started.runId)!;
  assert.equal(run.status, 'cancelled');
  assert.equal(run.failureClass, 'adapter_unavailable');

  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const inbox = events.find((e) => e.eventType === 'adapter_unavailable');
  assert.ok(inbox, 'an adapter_unavailable inbox event must be recorded');
  assert.equal(inbox!.visibility, 'inbox');
  assert.equal(inbox!.requiresUser, true);

  assert.equal(isProjectAdapterPaused(db, project.id), true);

  const secondTick = await tick(deps);
  assert.equal(secondTick.started.length, 0, 'a paused adapter must start nothing on tick');
  assert.equal(getTicket(db, ticket.id)!.status, 'READY', 'still READY, just not started while paused');
});

test("a NONE dependent finds its dependency's file under .orchestrator/inputs/<dependency ticket id>/", async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 2 });
  const adapter = new TestAdapter();
  const dep = createTicket(db, { projectId: project.id, title: 'producer', workspaceType: 'NONE' });
  const dependent = createTicket(db, { projectId: project.id, title: 'consumer', workspaceType: 'NONE' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: dep.id });

  const artifactsDir = mkdtempSync(join(tmpdir(), 'magarine-artifacts-'));
  try {
    const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id, artifactsDir };

    const firstTick = await tick(deps);
    assert.deepEqual(firstTick.started.map((s) => s.ticketId), [dep.id]);
    const depStarted = firstTick.started[0];
    const depRun = getRun(db, depStarted.runId)!;
    writeFileSync(join(depRun.workspaceRef!, 'out.txt'), 'hello from dep');

    adapter.emit(depStarted.handle.id, {
      type: 'result_raw',
      raw: {
        status: 'done',
        summary: 'produced a file',
        artifacts: [{ kind: 'file', path: 'out.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      },
    });
    await depStarted.done;
    assert.equal(getTicket(db, dep.id)!.status, 'DONE');

    const secondTick = await tick(deps);
    assert.deepEqual(secondTick.started.map((s) => s.ticketId), [dependent.id]);
    const dependentStarted = secondTick.started[0];
    const dependentRun = getRun(db, dependentStarted.runId)!;

    const expectedInputPath = join(dependentRun.workspaceRef!, '.orchestrator', 'inputs', dep.id, 'out.txt');
    assert.ok(existsSync(expectedInputPath), 'the dependency file must be copied into inputs/ before the worker starts');
    assert.equal(readFileSync(expectedInputPath, 'utf8'), 'hello from dep');

    const envelope = adapter.startedWith.get(dependentStarted.handle.id)!.ticket;
    assert.equal(envelope.completedDependencies.length, 1);
    assert.equal(
      envelope.completedDependencies[0].artifacts[0].path,
      join('.orchestrator', 'inputs', dep.id, 'out.txt')
    );

    adapter.emit(dependentStarted.handle.id, {
      type: 'result_raw',
      raw: { status: 'done', summary: 'consumed it', artifacts: [], checks: [], blockers: [], questions: [] },
    });
    await dependentStarted.done;
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test("a shared-directory (DIRECTORY) dependent's envelope lists the dependency's artefact path", async () => {
  const db = openDb(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-directory-'));
  try {
    const project = createProject(db, { name: 'p', maxParallelWorkers: 2, workspaceRoot });
    const adapter = new TestAdapter();
    const dep = createTicket(db, { projectId: project.id, title: 'producer', workspaceType: 'DIRECTORY' });
    const dependent = createTicket(db, { projectId: project.id, title: 'consumer', workspaceType: 'DIRECTORY' });
    addDependency(db, { ticketId: dependent.id, dependsOnTicketId: dep.id });

    const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id };

    const firstTick = await tick(deps);
    const depStarted = firstTick.started[0];
    writeFileSync(join(workspaceRoot, 'alpha.txt'), 'alpha contents');
    adapter.emit(depStarted.handle.id, {
      type: 'result_raw',
      raw: {
        status: 'done',
        summary: 'wrote alpha',
        artifacts: [{ kind: 'file', path: 'alpha.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      },
    });
    await depStarted.done;

    const secondTick = await tick(deps);
    const dependentStarted = secondTick.started[0];
    const envelope = adapter.startedWith.get(dependentStarted.handle.id)!.ticket;

    assert.equal(envelope.completedDependencies.length, 1);
    assert.equal(envelope.completedDependencies[0].artifacts.length, 1);
    assert.equal(envelope.completedDependencies[0].artifacts[0].path, join(workspaceRoot, 'alpha.txt'));
    assert.equal(envelope.completedDependencies[0].summary, 'wrote alpha');

    adapter.emit(dependentStarted.handle.id, {
      type: 'result_raw',
      raw: { status: 'done', summary: 'done', artifacts: [], checks: [], blockers: [], questions: [] },
    });
    await dependentStarted.done;
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('two concurrent runs declaring the same path in a shared DIRECTORY workspace produce an artifact_collision event, and both artifact rows are kept', async () => {
  const db = openDb(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-collision-'));
  try {
    const project = createProject(db, { name: 'p', maxParallelWorkers: 2, workspaceRoot });
    const adapter = new TestAdapter();
    const t1 = createTicket(db, { projectId: project.id, title: 'writer 1', workspaceType: 'DIRECTORY' });
    const t2 = createTicket(db, { projectId: project.id, title: 'writer 2', workspaceType: 'DIRECTORY' });

    const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id };
    const { started } = await tick(deps);
    assert.equal(started.length, 2, 'both writers start in the same tick, proving they are genuinely concurrent');

    writeFileSync(join(workspaceRoot, 'shared.txt'), 'first writer');
    const s1 = started.find((s) => s.ticketId === t1.id)!;
    const s2 = started.find((s) => s.ticketId === t2.id)!;

    adapter.emit(s1.handle.id, {
      type: 'result_raw',
      raw: {
        status: 'done',
        summary: 'wrote shared',
        artifacts: [{ kind: 'file', path: 'shared.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      },
    });
    await s1.done;

    adapter.emit(s2.handle.id, {
      type: 'result_raw',
      raw: {
        status: 'done',
        summary: 'also wrote shared',
        artifacts: [{ kind: 'file', path: 'shared.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      },
    });
    await s2.done;

    const events = listEventsForEntity(db, 'ticket', t2.id);
    const collision = events.find((e) => e.eventType === 'artifact_collision');
    assert.ok(collision, 'the second declaration of the same path must raise an artifact_collision event');
    assert.equal((collision!.payload as { conflictingTicketId: string }).conflictingTicketId, t1.id);

    assert.equal(listArtifactsForTicket(db, t1.id).length, 1, 'the collision is logged, not prevented');
    assert.equal(listArtifactsForTicket(db, t2.id).length, 1);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('SIGINT during a hanging fake run stops the worker, cancels the run without consuming an attempt, and leaves no ticket stuck IN_PROGRESS', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'hangs forever' });
  adapter.setScript(ticket.id, { kind: 'hang' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id };

  const runPromise = runUntilIdle(deps);
  // Give tick() a beat to start the hanging run before interrupting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getTicket(db, ticket.id)!.status, 'IN_PROGRESS');

  process.emit('SIGINT');
  await runPromise;

  // Proven by state in the database, not by trusting the resolved promise
  // or any close event — the earned lesson from batch 1's spike.
  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'READY');
  assert.equal(after.attemptCount, 0, 'an interrupt must not consume an attempt');
  assert.equal(listTicketsByStatus(db, project.id, 'IN_PROGRESS').length, 0);
});

test('SchedulerDeps.runTimeoutMs cancels a hanging run without consuming an attempt, independent of SIGINT', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'hangs' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, runTimeoutMs: 30 };
  const { started } = await tick(deps);
  assert.equal(getTicket(db, ticket.id)!.status, 'IN_PROGRESS');

  // Never emit anything for this handle: the scheduler's own timeout must fire.
  await started[0].done;

  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'READY');
  assert.equal(after.attemptCount, 0, 'a scheduler-level timeout must not consume an attempt');
  assert.equal(getRun(db, started[0].runId)!.status, 'cancelled');
  assert.equal(getRun(db, started[0].runId)!.failureClass, 'run_timeout');
  assert.ok(adapter.isStopped(started[0].handle.id), 'the adapter must be asked to stop the hung worker');
});

test('the envelope carries the ticket budget override when set, else the project default', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 2, maxBudgetUsd: 2 });
  const adapter = new TestAdapter();
  const defaultTicket = createTicket(db, { projectId: project.id, title: 'default budget' });
  const overriddenTicket = createTicket(db, {
    projectId: project.id,
    title: 'override budget',
    maxBudgetUsdOverride: 9.5,
  });

  const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id };
  const { started } = await tick(deps);

  const defaultStarted = started.find((s) => s.ticketId === defaultTicket.id)!;
  const overriddenStarted = started.find((s) => s.ticketId === overriddenTicket.id)!;

  assert.equal(adapter.startedWith.get(defaultStarted.handle.id)!.ticket.maxBudgetUsd, 2);
  assert.equal(adapter.startedWith.get(overriddenStarted.handle.id)!.ticket.maxBudgetUsd, 9.5);

  for (const s of started) {
    adapter.emit(s.handle.id, {
      type: 'result_raw',
      raw: { status: 'done', summary: 'ok', artifacts: [], checks: [], blockers: [], questions: [] },
    });
    await s.done;
  }
});

test('progress events are persisted as worker_progress internal events on the run, capped at 200 per run', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'chatty' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id };
  const { started } = await tick(deps);
  const s = started[0];

  for (let i = 0; i < 205; i++) {
    adapter.emit(s.handle.id, { type: 'progress', message: `step ${i}` });
  }
  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'ok', artifacts: [], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  const events = listEventsForEntity(db, 'run', s.runId);
  const progressEvents = events.filter((e) => e.eventType === 'worker_progress');
  assert.equal(progressEvents.length, 200, 'capped at 200 per run even though 205 were emitted');
  assert.equal(progressEvents[0].visibility, 'internal');
});

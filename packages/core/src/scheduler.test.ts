import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.ts';
import { rmSyncResilient } from './db/testSupport.ts';
import {
  addDependency,
  createProject,
  createTicket,
  getProject,
  getRun,
  getTicket,
  isProjectAdapterPaused,
  listArtifactsForTicket,
  listEventsForEntity,
  listEventsForProject,
  listTicketsByStatus,
  setTicketBudgetOverride,
} from './store.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { tick, runUntilIdle } from './scheduler.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { buildInbox } from './commands/inbox.ts';
import { spawnManaged } from './process.ts';
import { testTempRoot } from './testSupport.ts';
import type { AgentAdapter, AgentAdapterCapabilities, TicketEnvelope, WorkerEvent, WorkerHandle, Workspace } from './types.ts';

// Batch 5 item 3: this file's own private root for every NONE-mode
// workspace `tick()`/`runUntilIdle()` create below, instead of sharing the
// OS temp directory with every other concurrently-running test file (see
// workspace.ts's WorkspaceOptions.baseDir and testSupport.ts).
const workspaceBaseDir = testTempRoot('scheduler').root;
after(() => rmSync(workspaceBaseDir, { recursive: true, force: true }));

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
  private readonly postStopTimers = new Map<string, NodeJS.Timeout>();
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
    if (this.stopped.has(handle.id)) return;
    this.stopped.add(handle.id);
    // Standing fidelity rule (batch-5-spec.md section 1 ruling 1): this is
    // also a test double standing in for a real adapter, so it mirrors the
    // same behaviour fakeAdapter.ts's stop() does -- a killed process's
    // wait() promise still resolves and publishes its own terminal outcome,
    // independent of why it was stopped. Deferred to a later macrotask, not
    // published inline, for the same ordering reason as fakeAdapter.ts.
    const timer = setTimeout(() => {
      this.postStopTimers.delete(handle.id);
      for (const listener of this.listeners.get(handle.id) ?? []) {
        listener({ type: 'failure', message: 'worker process was stopped after being killed', retryable: true });
      }
    }, 0);
    this.postStopTimers.set(handle.id, timer);
  }

  async destroy(handle: WorkerHandle): Promise<void> {
    const timer = this.postStopTimers.get(handle.id);
    if (timer) {
      clearTimeout(timer);
      this.postStopTimers.delete(handle.id);
    }
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
  const t1 = createTicket(db, { projectId: project.id, title: 'T1', workspaceType: 'NONE' });
  const t2 = createTicket(db, { projectId: project.id, title: 'T2', workspaceType: 'NONE' });
  const t3 = createTicket(db, { projectId: project.id, title: 'T3', workspaceType: 'NONE' });
  addDependency(db, { ticketId: t3.id, dependsOnTicketId: t1.id });
  addDependency(db, { ticketId: t3.id, dependsOnTicketId: t2.id });

  adapter.setScript(t1.id, { kind: 'succeed' });
  adapter.setScript(t2.id, { kind: 'succeed' });
  adapter.setScript(t3.id, { kind: 'succeed' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };

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
  const blocker = createTicket(db, { projectId: project.id, title: 'BLOCKER', workspaceType: 'NONE' });
  const dependent = createTicket(db, { projectId: project.id, title: 'DEPENDENT', workspaceType: 'NONE' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });
  db.prepare("UPDATE tickets SET status = 'READY' WHERE id = ?").run(dependent.id);

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
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
  const t1 = createTicket(db, { projectId: project.id, title: 'T1', workspaceType: 'NONE' });
  const t2 = createTicket(db, { projectId: project.id, title: 'T2', workspaceType: 'NONE' });
  const t3 = createTicket(db, { projectId: project.id, title: 'T3', workspaceType: 'NONE' });
  adapter.setScript(t1.id, { kind: 'hang' });
  adapter.setScript(t2.id, { kind: 'hang' });
  adapter.setScript(t3.id, { kind: 'succeed' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };

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
  const ticket = createTicket(db, { projectId: project.id, title: 'flaky', maxAttempts: 2, workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'retryable_failure' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };

  const first = await tick(deps);
  await Promise.all(first.started.map((s) => s.done));
  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);

  const second = await tick(deps);
  await Promise.all(second.started.map((s) => s.done));
  assert.equal(getTicket(db, ticket.id)!.status, 'FAILED');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 2);
});

// Batch 7 (Role L, docs/strategy/batch-7-spec.md section 1 ruling 1): the
// whole loop this role's acceptance test names -- the worker's own budget
// self-stop must land FAILED without consuming an attempt, reach the inbox
// with its own reasoning intact, and return to READY via a plain retry once
// the owner has raised the ticket's budget.
test('budget_insufficient (the worker\'s own budget self-stop): FAILED, attempt_count unchanged, inbox carries the worker\'s reasoning, retry after raising the budget returns to READY', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'sixteen files', maxAttempts: 2, workspaceType: 'NONE' });
  const reasoning =
    'Stopped after creating file01.txt (verified) because per-call cost (~$0.08-0.09/pair) makes ' +
    'completing all 16 files impossible within the $0.25 budget ceiling.';
  adapter.setScript(ticket.id, { kind: 'budget_insufficient', summary: reasoning });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'FAILED', 'a budget stop is final, not a retry');
  assert.equal(after.attemptCount, 0, 'no attempt is consumed by the worker explaining a budget stop');
  assert.equal(after.maxAttempts, 2, 'max_attempts is untouched until a manual retry raises it');

  const run = getRun(db, result.started[0].runId)!;
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'worker_budget_stop');

  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const finalEvent = events.find((e) => e.eventType === 'worker_failed_final')!;
  assert.ok(finalEvent, 'must persist under the concrete worker_failed_final type');
  assert.equal(finalEvent.visibility, 'inbox');
  assert.equal(finalEvent.requiresUser, true);

  const item = buildInbox(db, project.id).find((i) => i.ticketId === ticket.id);
  assert.ok(item, 'must reach the inbox');
  // Batch 11: reasonFor now appends the exact next command after the
  // worker's own reasoning (every inbox line must name the next command) --
  // the underlying proof here (the WORKER's reasoning reaches the line, not
  // a generic failureClass fallback) is what this assertion checks, so it
  // now matches the reasoning as a PREFIX rather than the whole line.
  assert.match(
    item!.message,
    new RegExp(`^${reasoning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    "the worker's own reasoning, not a generic failureClass line"
  );
  assert.match(item!.message, new RegExp(`magarine retry --ticket ${ticket.id}`));

  // The owner's actual remedy per the ruling: raise the ticket's budget,
  // then retry. `cli.ts` has no `ticket set --budget` subcommand (only
  // `ticket add --budget` at creation time; see this role's report) so the
  // override is raised directly at the store layer that subcommand would
  // write through, and `retry` is exercised through stateMachine.ts's own
  // `manual_retry` transition (the same one `commands/retry.ts` calls).
  setTicketBudgetOverride(db, ticket.id, 5);
  const retried = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'manual_retry',
    idempotencyKey: 'manual-retry-after-budget-raise',
  });
  assert.equal(retried.ticket.status, 'READY');
  assert.equal(retried.ticket.attemptCount, 0, 'attempt_count carried over unchanged from the budget stop');
  assert.equal(retried.ticket.maxAttempts, 3);
});

test('a malformed result is treated as a retryable failure, not a crash', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'bad json', maxAttempts: 3, workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'malformed_result' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);
});

// Batch 13 ruling 1c: "DONE requires something delivered" -- the exact
// shape of the batch-12 finding (four tickets reported DONE, the board
// said success, zero files existed). A work ticket's done result with an
// empty artifacts array is now malformed and retryable, same treatment as
// a schema-invalid result, naming the reason.
test('a work ticket\'s done result declaring zero artifacts is malformed and retryable, naming "done with nothing delivered"', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'reports done but writes nothing', maxAttempts: 3, workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'succeed', artifacts: [] });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'READY', 'done with nothing delivered is retryable, not accepted');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);
  const failureEvent = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'worker_failed_retryable');
  assert.ok(failureEvent, 'expected a retryable worker_failure transition');
  const payload = failureEvent!.payload as { errors?: string[] };
  assert.ok(payload.errors?.some((e) => e.includes('done with nothing delivered')));
});

// The other half of the same ruling: a MANAGER ticket's done is a proposal
// to apply, not a deliverable -- applyManagerTicketDone (scheduler.ts)
// reads proposal.json straight off disk by its own fixed path, entirely
// independent of whatever the result's own `artifacts` array declares, so
// a manager ticket can validly report done with a genuinely EMPTY
// artifacts array (not even a `file` artifact naming proposal.json) as
// long as the file exists. Uses TestAdapter (full manual control) rather
// than FakeAdapter's own `manager_proposal` script, which always declares
// the proposal file as an artifact when given one -- this test needs to
// rule that out to prove kind-scoping, not artifact count, is what exempts
// manager tickets.
test('a manager ticket\'s done result declaring zero artifacts (not even the proposal file itself) is unaffected by the delivery rule -- only work tickets are checked', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    kind: 'manager',
    workspaceType: 'NONE',
  });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];
  const workspacePath = adapter.startedWith.get(s.handle.id)!.workspace!.path!;
  mkdirSync(join(workspacePath, '.orchestrator'), { recursive: true });
  writeFileSync(
    join(workspacePath, '.orchestrator', 'proposal.json'),
    JSON.stringify({ rationale: 'nothing to propose yet', commands: [] })
  );

  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'nothing to propose', artifacts: [], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE', 'a manager ticket needs no artefact to land DONE');
});

test('a worker question keeps the ticket IN_PROGRESS and the run continues to a final result', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'asks a question', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'question' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

test('needs_user_decision moves the ticket to BLOCKED', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'needs a human', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'needs_user_decision' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'BLOCKED');
});

test('run usage reported by the adapter is persisted on the run row', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'reports usage', workspaceType: 'NONE' });
  const usage = { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 100 };
  adapter.setScript(ticket.id, { kind: 'succeed', usage });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  const run = getRun(db, result.started[0].runId)!;
  assert.deepEqual(run.usageJson ? JSON.parse(run.usageJson) : null, usage);
});

test('runUntilIdle drives a full dependency chain to completion without manual ticks', async () => {
  const { db, project, adapter } = setupProject(2);
  const t1 = createTicket(db, { projectId: project.id, title: 'T1', workspaceType: 'NONE' });
  const t2 = createTicket(db, { projectId: project.id, title: 'T2', workspaceType: 'NONE' });
  const t3 = createTicket(db, { projectId: project.id, title: 'T3', workspaceType: 'NONE' });
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
  const ticket = createTicket(db, { projectId: project.id, title: 'needs auth', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
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
    const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id, artifactsDir, workspaceBaseDir };

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
      envelope.completedDependencies[0].artifacts[0].content,
      join('.orchestrator', 'inputs', dep.id, 'out.txt')
    );

    adapter.emit(dependentStarted.handle.id, {
      type: 'result_raw',
      raw: { status: 'done', summary: 'consumed it', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
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

    const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir };

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
    assert.equal(envelope.completedDependencies[0].artifacts[0].content, join(workspaceRoot, 'alpha.txt'));
    assert.equal(envelope.completedDependencies[0].summary, 'wrote alpha');

    adapter.emit(dependentStarted.handle.id, {
      type: 'result_raw',
      raw: { status: 'done', summary: 'done', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
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

    const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir };
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

// Batch 13 item 1: a DIRECTORY-mode ticket declaring a non-'file' artifact
// (its content carried in "text", per resultContract.ts's per-kind field
// map) must be captured with that content stored in the artifact row's own
// `text` column, not lost or mis-routed into `pathOrUri` -- the exact
// column split this batch introduced to close the batch-11 "content in a
// field called path" smell. Also has DONE deliver a real file, per batch
// 13's own "done requires delivery" rule -- proving the two rules compose,
// not just each in isolation.
test('a DIRECTORY-mode ticket declaring a non-file artefact captures its content in the artifact row\'s text column, not pathOrUri', async () => {
  const db = openDb(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-directory-textkind-'));
  try {
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const adapter = new TestAdapter();
    const t1 = createTicket(db, { projectId: project.id, title: 'writer', workspaceType: 'DIRECTORY' });

    const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
    const { started } = await tick(deps);
    writeFileSync(join(workspaceRoot, 'out.txt'), 'real file');

    adapter.emit(started[0].handle.id, {
      type: 'result_raw',
      raw: {
        status: 'done',
        summary: 'wrote a file and left a reference note',
        artifacts: [
          { kind: 'file', path: 'out.txt' },
          { kind: 'reference', text: 'see the design doc from the prior ticket' },
        ],
        checks: [],
        blockers: [],
        questions: [],
      },
    });
    await started[0].done;

    const artifacts = listArtifactsForTicket(db, t1.id);
    const reference = artifacts.find((a) => a.kind === 'reference')!;
    assert.equal(reference.text, 'see the design doc from the prior ticket');
    assert.equal(reference.pathOrUri, '', 'a non-file kind must not leave real content in pathOrUri');

    const file = artifacts.find((a) => a.kind === 'file')!;
    assert.equal(file.pathOrUri, join(workspaceRoot, 'out.txt'));
    assert.equal(file.text, null);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('SIGINT during a hanging fake run stops the worker, cancels the run without consuming an attempt, and leaves no ticket stuck IN_PROGRESS', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'hangs forever', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'hang' });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };

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
  const ticket = createTicket(db, { projectId: project.id, title: 'hangs', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, runTimeoutMs: 30, workspaceBaseDir };
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
  const defaultTicket = createTicket(db, { projectId: project.id, title: 'default budget', workspaceType: 'NONE' });
  const overriddenTicket = createTicket(db, {
    projectId: project.id,
    title: 'override budget',
    maxBudgetUsdOverride: 9.5,
    workspaceType: 'NONE',
  });

  const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);

  const defaultStarted = started.find((s) => s.ticketId === defaultTicket.id)!;
  const overriddenStarted = started.find((s) => s.ticketId === overriddenTicket.id)!;

  assert.equal(adapter.startedWith.get(defaultStarted.handle.id)!.ticket.maxBudgetUsd, 2);
  assert.equal(adapter.startedWith.get(overriddenStarted.handle.id)!.ticket.maxBudgetUsd, 9.5);

  for (const s of started) {
    adapter.emit(s.handle.id, {
      type: 'result_raw',
      raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
    });
    await s.done;
  }
});

test('progress events are persisted as worker_progress internal events on the run, capped at 200 per run', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'chatty', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  for (let i = 0; i < 205; i++) {
    adapter.emit(s.handle.id, { type: 'progress', message: `step ${i}` });
  }
  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  const events = listEventsForEntity(db, 'run', s.runId);
  const progressEvents = events.filter((e) => e.eventType === 'worker_progress');
  assert.equal(progressEvents.length, 200, 'capped at 200 per run even though 205 were emitted');
  assert.equal(progressEvents[0].visibility, 'internal');
});

// --- Batch 15 item 4: DONE verified against expected_artifacts, when the ticket declares one ---

test('a ticket that declares expected_artifacts but whose worker never produces the declared file reaches the retryable class, naming the missing artefact', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, {
    projectId: project.id,
    title: 'declares a file it does not produce',
    maxAttempts: 3,
    workspaceType: 'NONE',
    expectedArtifacts: [{ kind: 'file', path: 'out.txt' }],
  });
  // The worker reports done, and delivers SOMETHING (satisfying batch 13's
  // "done requires something delivered") -- just never the file this
  // ticket specifically declared it expects.
  adapter.setScript(ticket.id, { kind: 'succeed', artifacts: [{ kind: 'file', path: 'wrong.txt' }] });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'READY', 'a missing declared artefact is retryable, not accepted');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);
  const failureEvent = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'worker_failed_retryable');
  assert.ok(failureEvent, 'expected a retryable worker_failure transition');
  const payload = failureEvent!.payload as { errors?: string[]; message?: string; failureClass?: string };
  assert.equal(payload.failureClass, 'malformed_result', 'reuses the EXISTING retryable class, not a new one');
  assert.match(payload.message ?? '', /out\.txt/, 'the reason must name the missing artefact');
});

test('a ticket that declares expected_artifacts and whose worker produces exactly that file reaches DONE normally', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, {
    projectId: project.id,
    title: 'declares a file and produces it',
    maxAttempts: 3,
    workspaceType: 'NONE',
    expectedArtifacts: [{ kind: 'file', path: 'out.txt' }],
  });
  adapter.setScript(ticket.id, { kind: 'succeed', artifacts: [{ kind: 'file', path: 'out.txt' }] });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

test('a ticket with no expected_artifacts list at all keeps today\'s rule -- any delivered artefact satisfies DONE, whatever its path', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, {
    projectId: project.id,
    title: 'no expectations declared',
    maxAttempts: 3,
    workspaceType: 'NONE',
  });
  adapter.setScript(ticket.id, { kind: 'succeed', artifacts: [{ kind: 'file', path: 'whatever.txt' }] });

  const deps = { db, adapter, maxParallelWorkers: project.maxParallelWorkers, projectId: project.id, workspaceBaseDir };
  const result = await tick(deps);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

// --- Batch 15 addendum 10, ruling 21: expected artefacts compared by
// resolved path, both sides. The owner's real run declared `index.md`
// (the ticket's expectation) as an absolute path -- a legitimate, adapter-
// accepted declaration (claudeCli.ts's verifyArtifacts already resolves and
// accepts absolute paths) -- and the old raw-string check rejected genuinely
// delivered work. Both sides are now resolved against the run's own
// workspace (workspace.ts's resolveArtifactPath, the same rule
// verifyArtifacts uses) before comparison; the failure message still names
// the expectation as declared on the ticket (`index.md`), never a resolved
// path.

test("ruling 21: an expected artefact declared as an ABSOLUTE path inside the run's own workspace matches, reaching DONE -- the owner's index.md case", async () => {
  const db = openDb(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-ruling21-abs-match-'));
  try {
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const adapter = new FakeAdapter();
    const ticket = createTicket(db, {
      projectId: project.id,
      title: 'Write index.md',
      workspaceType: 'DIRECTORY',
      expectedArtifacts: [{ kind: 'file', path: 'index.md' }],
    });
    adapter.setScript(ticket.id, {
      kind: 'succeed',
      artifacts: [{ kind: 'file', path: join(workspaceRoot, 'index.md') }],
    });

    const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
    const result = await tick(deps);
    await Promise.all(result.started.map((s) => s.done));

    assert.equal(getTicket(db, ticket.id)!.status, 'DONE', 'an absolute declaration of the same file must satisfy the expectation');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('ruling 21: an expected artefact declared as an absolute path under a DIFFERENT directory still fails malformed_result, naming the expectation as typed', async () => {
  const db = openDb(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-ruling21-abs-mismatch-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'magarine-ruling21-elsewhere-'));
  try {
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const adapter = new FakeAdapter();
    const ticket = createTicket(db, {
      projectId: project.id,
      title: 'Write index.md',
      maxAttempts: 3,
      workspaceType: 'DIRECTORY',
      expectedArtifacts: [{ kind: 'file', path: 'index.md' }],
    });
    // A real file elsewhere, not inside this run's own workspace -- resolving
    // it must not accidentally match just because both are absolute.
    adapter.setScript(ticket.id, {
      kind: 'succeed',
      artifacts: [{ kind: 'file', path: join(elsewhere, 'index.md') }],
    });

    const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
    const result = await tick(deps);
    await Promise.all(result.started.map((s) => s.done));

    assert.equal(getTicket(db, ticket.id)!.status, 'READY', 'a declaration outside this workspace must not satisfy the expectation');
    const failureEvent = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'worker_failed_retryable');
    assert.ok(failureEvent);
    const payload = failureEvent!.payload as { failureClass?: string; message?: string };
    assert.equal(payload.failureClass, 'malformed_result');
    assert.match(payload.message ?? '', /index\.md/, 'the reason must name the expectation as typed, not a resolved path');
    assert.doesNotMatch(payload.message ?? '', new RegExp(elsewhere.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('ruling 21: an expected artefact declared RELATIVE still matches, exactly as before this ruling', async () => {
  const db = openDb(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-ruling21-relative-'));
  try {
    const project = createProject(db, { name: 'p', maxParallelWorkers: 1, workspaceRoot });
    const adapter = new FakeAdapter();
    const ticket = createTicket(db, {
      projectId: project.id,
      title: 'Write index.md',
      workspaceType: 'DIRECTORY',
      expectedArtifacts: [{ kind: 'file', path: 'index.md' }],
    });
    adapter.setScript(ticket.id, { kind: 'succeed', artifacts: [{ kind: 'file', path: 'index.md' }] });

    const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
    const result = await tick(deps);
    await Promise.all(result.started.map((s) => s.done));

    assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

// Ruling 16: the enforcement above was only ever proven for a Manager-made
// ticket (`createTicket` called directly). A ticket created THROUGH THE CLI
// PATH (`ticket add --expected-artifact`) must reach the exact same branch --
// the CLI-made ticket is the one every hand-written test scenario and every
// owner-typed ticket actually is. Driven entirely through the real `magarine`
// CLI (project create, ticket add, tick, board) rather than reopening the
// sqlite file in-process afterward -- node:sqlite's Windows file-handle
// release after a subprocess has written to it is not reliably fast enough
// for a same-process reopen to be a safe test dependency.
test('a ticket created through the CLI with --expected-artifact reaches the same malformed_result enforcement as a Manager-made one, naming the missing file on the board', async () => {
  const dir = mkdtempSync(join(workspaceBaseDir, 'cli-expected-artifact-'));
  try {
    const dbFile = join(dir, 'magarine.db');
    const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const runCli = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
        const proc = spawnManaged({ executable: process.execPath, args: [cliPath, ...args] });
        let stdout = '';
        let stderr = '';
        proc.onStdout((c) => (stdout += c));
        proc.onStderr((c) => (stderr += c));
        proc.wait().then((r) => resolveRun({ code: r.code, stdout, stderr }));
      });

    const projectRes = await runCli(['project', 'create', '--name', 'p', '--json', '--db', dbFile]);
    const project = JSON.parse(projectRes.stdout);
    // `--max-attempts 1`: the board only ever shows a `lastFailureReason` for
    // a ticket currently sitting in FAILED (board.ts's computeLastFailureReason)
    // -- a ticket merely returned to READY for a future retry is not
    // "currently failing" by that function's own rule, so this must exhaust
    // to FAILED in one attempt to reach the board line at all.
    const ticketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 'cli-made', '--max-attempts', '1',
      '--workspace', 'NONE', '--expected-artifact', 'out.md', '--json', '--db', dbFile,
    ]);
    assert.equal(ticketRes.code, 0, ticketRes.stderr);
    const ticket = JSON.parse(ticketRes.stdout);
    assert.deepEqual(ticket.expectedArtifacts, [{ kind: 'file', path: 'out.md' }]);

    // No --fake-script: the default fake adapter's own "succeed" behaviour
    // (adapters/fakeAdapter.ts's defaultSuccessArtifacts) already declares a
    // file it actually writes into the NONE workspace -- just never the one
    // named 'out.md' this ticket declared, which is exactly the missing-
    // declared-artefact branch this test targets.
    const tickRes = await runCli(['tick', '--project', project.id, '--json', '--db', dbFile]);
    assert.equal(tickRes.code, 0, tickRes.stderr);

    const statusRes = await runCli(['status', '--project', project.id, '--json', '--db', dbFile]);
    const tickets = JSON.parse(statusRes.stdout) as Array<{ id: string; status: string; attemptCount: number }>;
    const afterTick = tickets.find((t) => t.id === ticket.id)!;
    assert.equal(afterTick.status, 'FAILED', 'exhausted after its one attempt on a missing declared artefact');
    assert.equal(afterTick.attemptCount, 1);

    const boardRes = await runCli(['board', '--project', project.id, '--json', '--db', dbFile]);
    const board = JSON.parse(boardRes.stdout) as { tickets: Array<{ id: string; lastFailureReason: string | null }> };
    const row = board.tickets.find((t) => t.id === ticket.id);
    assert.ok(row, 'must reach the board');
    assert.match(row!.lastFailureReason ?? '', /out\.md/, 'the board reason must name the missing artefact');
  } finally {
    await rmSyncResilient(dir);
  }
});

// --- Batch 15 ruling 7: worker_progress carries the derived tool/state, not just the raw message ---

test('a worker_progress event\'s payload carries the tool name and activity state derived from the message, ruling 7\'s pure function applied once at write time', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'reads then writes', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, { type: 'progress', message: 'tool_use: Read' });
  adapter.emit(s.handle.id, { type: 'progress', message: 'tool_use: Edit' });
  adapter.emit(s.handle.id, { type: 'progress', message: 'text: still working on it' });
  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  const progressEvents = listEventsForEntity(db, 'run', s.runId).filter((e) => e.eventType === 'worker_progress');
  const payloads = progressEvents.map((e) => e.payload as { message: string; tool: string | null; state: string });
  assert.deepEqual(
    payloads.map((p) => [p.tool, p.state]),
    [
      ['Read', 'reading'],
      ['Edit', 'writing'],
      [null, 'reporting'],
    ]
  );
});

// --- Batch 4: the daemon's own cost tally stops a run independent of the tool's own ceiling check ---

test('a progress event whose cumulative costUsd crosses the ceiling stops the worker and records a non-retryable budget_exceeded failure with the tally and overshoot', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'chatty and expensive', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, { type: 'progress', message: 'turn 1', costUsd: 0.4 });
  assert.equal(getTicket(db, ticket.id)!.status, 'IN_PROGRESS', 'under the ceiling: no stop yet');
  assert.equal(adapter.isStopped(s.handle.id), false);

  adapter.emit(s.handle.id, { type: 'progress', message: 'turn 2', costUsd: 1.5 });
  await s.done;

  assert.ok(adapter.isStopped(s.handle.id), 'the scheduler must ask the adapter to stop the worker itself');
  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'FAILED', 'non-retryable: final regardless of attempts remaining');
  assert.equal(after.attemptCount, 1);

  const run = getRun(db, s.runId)!;
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'budget_exceeded');

  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const finalEvent = events.find((e) => e.eventType === 'worker_failed_final')!;
  assert.ok(finalEvent, 'must persist under the concrete worker_failed_final type, not worker_failure');
  assert.equal(finalEvent.visibility, 'inbox');
  assert.equal(finalEvent.requiresUser, true);
  assert.deepEqual(finalEvent.payload, {
    retryable: false,
    failureClass: 'budget_exceeded',
    stoppedBy: 'scheduler_estimate',
    tally: 1.5,
    ceiling: 1,
    overshoot: 0.5,
  });
});

test("the tool's own budget stop (claudeCli.ts's classifyOutcome, surfaced as a failure event with failureClass 'budget_exceeded') records budget_exceeded on the run, not the generic adapter_failure default, and is distinguishable from the scheduler's own stop via stoppedBy", async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'tool reports its own budget stop', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, {
    type: 'failure',
    message: 'budget exceeded: subtype: error_max_budget_usd',
    retryable: false,
    failureClass: 'budget_exceeded',
    stoppedBy: 'tool_max_budget_usd',
  });
  await s.done;

  const run = getRun(db, s.runId)!;
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'budget_exceeded', 'must not fall through to the generic adapter_failure default');

  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const finalEvent = events.find((e) => e.eventType === 'worker_failed_final')!;
  assert.ok(finalEvent);
  assert.deepEqual(finalEvent.payload, {
    message: 'budget exceeded: subtype: error_max_budget_usd',
    retryable: false,
    failureClass: 'budget_exceeded',
    stoppedBy: 'tool_max_budget_usd',
  });
});

// --- Batch 6 item 3: an unrecognized model prices loud, not silent ---

test('a progress event flagging unknownModel raises exactly one unknown_model_rate event per run, even across repeated flags', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 5 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'runs an unrecognized model', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, { type: 'progress', message: 'turn 1', costUsd: 0.01, unknownModel: 'claude-mystery-9' });
  adapter.emit(s.handle.id, { type: 'progress', message: 'turn 2', costUsd: 0.02, unknownModel: 'claude-mystery-9' });
  adapter.emit(s.handle.id, { type: 'result_raw', raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] } });
  await s.done;

  const events = listEventsForEntity(db, 'run', s.runId);
  const unknownModelEvents = events.filter((e) => e.eventType === 'unknown_model_rate');
  assert.equal(unknownModelEvents.length, 1, 'exactly one row per run, despite two flagged progress events');
  // Batch 12 ruling: activity, not inbox -- see policy.ts's comment on this
  // row. Still visible (activity --project, and the board/page's own
  // fallback-rate marker, board.ts), just not asked to resolve a condition
  // that can never observably become false.
  assert.equal(unknownModelEvents[0].visibility, 'activity');
  assert.equal(unknownModelEvents[0].requiresUser, false);
  assert.deepEqual(unknownModelEvents[0].payload, { model: 'claude-mystery-9' });
});

test('a progress event with no unknownModel flag never raises unknown_model_rate', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 5 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'runs a recognized model', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, { type: 'progress', message: 'turn 1', costUsd: 0.01 });
  adapter.emit(s.handle.id, { type: 'result_raw', raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] } });
  await s.done;

  const events = listEventsForEntity(db, 'run', s.runId);
  assert.equal(events.filter((e) => e.eventType === 'unknown_model_rate').length, 0);
});

test("batch 6 item 4: a completed run's terminal result_raw event flagging unknownModel (no mid-run progress flag at all) still raises unknown_model_rate -- an unpinned/unrecognized model must not go silent just because the run finished cleanly", async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 5 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'completes on an unrecognized model', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
    unknownModel: 'claude-mystery-9',
  });
  await s.done;

  const events = listEventsForEntity(db, 'run', s.runId);
  const unknownModelEvents = events.filter((e) => e.eventType === 'unknown_model_rate');
  assert.equal(unknownModelEvents.length, 1);
  assert.equal(unknownModelEvents[0].visibility, 'activity');
  assert.deepEqual(unknownModelEvents[0].payload, { model: 'claude-mystery-9' });
});

// Batch 11 ruling 1 rule e replaces the old refuse-outright behaviour with
// shrink-to-fit: a ticket's own ceiling is capped to whatever the project's
// remaining spend allows, and only refused (pausing the project, one
// project_spend_cap_reached event) when that shrunk amount would fall below
// MIN_BUDGET_USD. This is finding 5's actual fix -- a $1 cap with a $2
// default used to refuse forever, silently, because 0.6+0.6 > 1.0 was
// treated the same as "there's nothing left at all".
test('a project spend cap shrinks a ticket\'s ceiling to what remains, rather than refusing, as long as the shrunk amount is still above the floor -- proven by driving the shrunk ceiling through the real spawned pipeline with the fake adapter', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 0.6, maxSpendUsd: 1.0 });
  const adapter = new FakeAdapter();
  const first = createTicket(db, { projectId: project.id, title: 'first', workspaceType: 'NONE' });
  const second = createTicket(db, { projectId: project.id, title: 'second', workspaceType: 'NONE' });
  adapter.setScript(first.id, { kind: 'succeed', usage: { total_cost_usd: 0.6 } });
  // 0.5 sits BELOW the ticket's own 0.6 ceiling but ABOVE the 0.4 the cap
  // has left (1.0 - 0.6). If the shrunk ceiling actually reached the
  // envelope (and so ctx.ceilingUsd), the scheduler's own live-estimate
  // stop fires on this progress report; if the shrink were a no-op (the
  // bug this replaces), 0.5 would pass unnoticed under the un-shrunk 0.6
  // and the ticket would sit IN_PROGRESS forever.
  adapter.setScript(second.id, { kind: 'progress', costUsd: 0.5 });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };

  const firstTick = await tick(deps);
  assert.deepEqual(firstTick.started.map((s) => s.ticketId), [first.id]);
  await Promise.all(firstTick.started.map((s) => s.done));
  assert.equal(getTicket(db, first.id)!.status, 'DONE');
  assert.equal(
    listEventsForProject(db, project.id).filter((e) => e.eventType === 'spend_cap_ceiling_shrunk').length,
    0,
    'the first run\'s own 0.6 ceiling fit entirely under the 1.0 cap with nothing spent yet -- no shrink happened, so no event'
  );

  const secondTick = await tick(deps);
  assert.equal(secondTick.started.length, 1, '0.4 remains under the cap, still above the $0.25 floor -- must spawn, not refuse');
  assert.equal(isProjectAdapterPaused(db, project.id), false, 'shrinking is not a refusal; the project stays unpaused');
  await Promise.all(secondTick.started.map((s) => s.done));

  const shrinkEvents = listEventsForProject(db, project.id).filter((e) => e.eventType === 'spend_cap_ceiling_shrunk');
  assert.equal(shrinkEvents.length, 1, 'exactly one shrink event, for the second ticket\'s run only');
  assert.equal(shrinkEvents[0].entityType, 'run');
  assert.equal(shrinkEvents[0].entityId, secondTick.started[0].runId, 'the event is recorded on the RUN, not the ticket or the project');
  assert.equal(shrinkEvents[0].visibility, 'activity', 'quiet, not an inbox item -- the healthy path must not nag the owner');
  assert.equal(shrinkEvents[0].requiresUser, false);
  assert.deepEqual(shrinkEvents[0].payload, {
    ticketId: second.id,
    ownCeilingUsd: 0.6,
    capAllowedUsd: 0.4,
    appliedCeilingUsd: 0.4,
  });

  const after = getTicket(db, second.id)!;
  assert.equal(after.status, 'FAILED', 'the scheduler must have stopped the run itself once the shrunk 0.4 ceiling was crossed');
  const run = getRun(db, secondTick.started[0].runId)!;
  assert.equal(run.failureClass, 'budget_exceeded');
  const finalEvent = listEventsForEntity(db, 'ticket', second.id).find((e) => e.eventType === 'worker_failed_final')!;
  assert.equal(
    (finalEvent.payload as { ceiling: number }).ceiling,
    0.4,
    'the enforced ceiling must be the shrunk 0.4, not the ticket\'s own 0.6 -- proves envelope.maxBudgetUsd carried the override'
  );

  assert.equal(
    listEventsForProject(db, project.id).filter((e) => e.eventType === 'project_spend_cap_reached').length,
    0,
    'a shrink is not a cap-reached refusal'
  );
});

test('a project spend cap refuses to spawn, pausing the project with reason spend_cap and emitting project_spend_cap_reached exactly once, when what the cap allows would shrink the ceiling below the floor', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 0.6, maxSpendUsd: 1.0 });
  const adapter = new FakeAdapter();
  const first = createTicket(db, { projectId: project.id, title: 'first', workspaceType: 'NONE' });
  const second = createTicket(db, { projectId: project.id, title: 'second', workspaceType: 'NONE' });
  adapter.setScript(first.id, { kind: 'succeed', usage: { total_cost_usd: 0.8 } });
  adapter.setScript(second.id, { kind: 'succeed', usage: { total_cost_usd: 0.6 } });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };

  // First run: 0.8 recorded, leaving 0.2 -- below the $0.25 floor.
  const firstTick = await tick(deps);
  await Promise.all(firstTick.started.map((s) => s.done));
  assert.equal(getTicket(db, first.id)!.status, 'DONE');

  const secondTick = await tick(deps);
  assert.equal(secondTick.started.length, 0, 'a shrunk ceiling below the floor must refuse, not spawn a sub-floor run');
  assert.equal(getTicket(db, second.id)!.status, 'READY', 'left READY, not started, not failed');
  assert.equal(isProjectAdapterPaused(db, project.id), true);
  assert.equal(getProject(db, project.id)!.pauseReason, 'spend_cap');

  const events = listEventsForProject(db, project.id);
  const capEvents = events.filter((e) => e.eventType === 'project_spend_cap_reached');
  assert.equal(capEvents.length, 1, 'exactly one project_spend_cap_reached event');
  assert.equal(capEvents[0].entityType, 'project');
  assert.equal(capEvents[0].visibility, 'inbox');
  assert.equal(capEvents[0].requiresUser, true);
  assert.equal(
    events.filter((e) => e.eventType === 'spend_cap_ceiling_shrunk').length,
    0,
    'a refusal never spawns a run at all -- there is nothing to record a shrink event on'
  );

  // A paused project starts nothing further, and does not emit the event again.
  const thirdTick = await tick(deps);
  assert.equal(thirdTick.started.length, 0);
  assert.equal(
    listEventsForProject(db, project.id).filter((e) => e.eventType === 'project_spend_cap_reached').length,
    1,
    'still exactly one -- a paused project short-circuits before the cap check runs again'
  );
});

test('a project with no max_spend_usd set never refuses a spawn on spend-cap grounds', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 't', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'succeed' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);

  assert.equal(started.length, 1);
  await Promise.all(started.map((s) => s.done));
  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
  assert.equal(
    listEventsForEntity(db, 'run', started[0].runId).filter((e) => e.eventType === 'spend_cap_ceiling_shrunk').length,
    0,
    'no max_spend_usd at all means no cap to shrink against -- an uncapped project must never see this event'
  );
});

// --- Batch 5: the supervisor must survive its own decisions ---
//
// Reproduction of batch-4-closeout.md section 2's crash. The real
// sequence: the scheduler's own budget stop calls adapter.stop() and
// records `budget_exceeded` (moving the ticket to FAILED); the killed real
// adapter's process then resolves its own wait() promise and publishes its
// own terminal failure, which the scheduler applies to an already-FAILED
// ticket -- `InvalidTransitionError`, uncaught, kills the daemon. 194 green
// tests never saw this because FakeAdapter's stop() used to just go silent.
// Now that it mirrors the real adapter (see fakeAdapter.ts's stop()), this
// test drives the same crash through the real scheduler.
//
// This test is written to describe the FIXED behaviour (no crash, the
// first outcome wins, the late event is recorded, not lost) so that
// batch 5's guards (settle-once via a live run-status check, finishRun's
// WHERE status='running' guard, and the observe callback's catch-all) make
// it pass unmodified once they land -- see docs/strategy/batch-5-spec.md
// section 1 ruling 1. Before those guards exist, it fails on the very
// first assertion, and the captured error message is
// batch-4-closeout.md section 2's exact `InvalidTransitionError` text.
test('a post-stop terminal event from a budget stop must not crash the daemon (batch 5 reproduction)', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'over budget', workspaceType: 'NONE' });
  // project.maxBudgetUsd defaults to 2.0 (createProject's default); this
  // reports a cumulative cost far past it, so scheduler.ts's own budget
  // guard (applyWorkerEventInner's 'progress' case) fires and calls
  // adapter.stop() itself, before the worker would ever finish on its own.
  adapter.setScript(ticket.id, { kind: 'progress', costUsd: 999 });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };

  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  const { started } = await tick(deps);
  try {
    await started[0].done;
    // fakeAdapter.ts's post-stop event is deferred to a later macrotask;
    // give it a turn to fire (and, pre-fix, its rejection to surface)
    // before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', onRejection);
  }

  assert.equal(
    rejections.length,
    0,
    `the daemon must survive a post-stop terminal event, but got an unhandled rejection: ${
      rejections[0] instanceof Error ? rejections[0].stack : String(rejections[0])
    }`
  );

  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'FAILED', 'the scheduler-recorded budget_exceeded outcome must still win');

  const run = getRun(db, started[0].runId)!;
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'budget_exceeded', 'the first outcome is never overwritten by the late event');

  assert.ok(run.usageJson, 'a budget stop must record usage on the run row, not leave it null');
  assert.equal(
    (JSON.parse(run.usageJson!) as { total_cost_usd: number }).total_cost_usd,
    999,
    "the scheduler's own tally is recorded since the killed adapter's own event carries no usage to merge"
  );

  const runEvents = listEventsForEntity(db, 'run', started[0].runId);
  const lateEvents = runEvents.filter((e) => e.eventType === 'late_worker_event');
  assert.equal(lateEvents.length, 1, 'the post-stop event must be recorded, not silently dropped');
});

test('a late non-terminal event after settlement is dropped without minting a late_worker_event row (batch 5 guard 1)', async () => {
  // Ruling 1 records "any later TERMINAL event" as late_worker_event. A
  // real killed process's stdout can keep draining progress lines during
  // killTree's grace period well after the scheduler's own budget-stop
  // branch already settled the run (process.ts's DEFAULT_GRACE_MS); each of
  // those must be silently absorbed, not turn one late event into several.
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'settles once, then keeps chattering', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  adapter.emit(s.handle.id, { type: 'progress', message: 'still going, apparently' });
  adapter.emit(s.handle.id, { type: 'progress', message: 'still going, again' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE', 'unaffected by the late chatter');
  const lateEvents = listEventsForEntity(db, 'run', s.runId).filter((e) => e.eventType === 'late_worker_event');
  assert.equal(lateEvents.length, 0, 'a late non-terminal event must not mint a late_worker_event row');
});

test('a late terminal event after settlement merges its usage into the run row only if the row has none (batch 5 guard 1)', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'settles once, no usage yet', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'first and only real outcome', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
  assert.equal(getRun(db, s.runId)!.usageJson, null, 'no usage recorded yet');

  const lateUsage = { total_cost_usd: 0.42 };
  adapter.emit(s.handle.id, {
    type: 'failure',
    message: 'late failure from a killed process',
    retryable: true,
    failureClass: 'adapter_failure',
    usage: lateUsage,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE', 'the settled outcome is never overwritten by a late event');
  const run = getRun(db, s.runId)!;
  assert.equal(run.status, 'succeeded', 'the run row keeps its first recorded status');
  assert.deepEqual(JSON.parse(run.usageJson!), lateUsage, 'usage is merged in because the settled row had none');

  const lateEvents = listEventsForEntity(db, 'run', s.runId).filter((e) => e.eventType === 'late_worker_event');
  assert.equal(lateEvents.length, 1);
  assert.equal((lateEvents[0].payload as { failureClass?: string }).failureClass, 'adapter_failure');
});

test('a late terminal event never overwrites usage the settled run already recorded (batch 5 guard 1)', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'settles once, with usage', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'ok', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
    usage: { total_cost_usd: 1 },
  });
  await s.done;
  assert.deepEqual(JSON.parse(getRun(db, s.runId)!.usageJson!), { total_cost_usd: 1 });

  adapter.emit(s.handle.id, {
    type: 'failure',
    message: 'late',
    retryable: true,
    usage: { total_cost_usd: 99 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    JSON.parse(getRun(db, s.runId)!.usageJson!),
    { total_cost_usd: 1 },
    'the first-recorded usage must never be replaced by a later event\'s usage'
  );
});

test('a throwing transition inside the observe callback is caught, recorded, and does not affect other runs (batch 5 guard 3)', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 2 });
  const adapter = new TestAdapter();
  const bad = createTicket(db, { projectId: project.id, title: 'malformed event', workspaceType: 'NONE' });
  const good = createTicket(db, { projectId: project.id, title: 'well-behaved', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const badStarted = started.find((s) => s.ticketId === bad.id)!;
  const goodStarted = started.find((s) => s.ticketId === good.id)!;

  // A malformed 'failure' event -- missing the required boolean `retryable`
  // flag -- throws deep inside recordTicketTransition (see
  // stateMachine.ts's requireRetryableFlag), independent of guards 1/2:
  // this is the ticket's FIRST event, so nothing has settled yet. Cast
  // through `unknown` to bypass the type system the way a genuinely
  // malformed adapter would at runtime.
  adapter.emit(badStarted.handle.id, {
    type: 'failure',
    message: 'oops',
  } as unknown as WorkerEvent);

  adapter.emit(goodStarted.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'fine', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
  });
  await goodStarted.done;

  // Give the bad run's caught-and-recorded rejection a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(getTicket(db, good.id)!.status, 'DONE', 'the well-behaved run is unaffected by the other run throwing');
  assert.equal(
    getTicket(db, bad.id)!.status,
    'IN_PROGRESS',
    'the malformed transition never applied; the ticket is simply stuck, not corrupted'
  );

  const events = listEventsForEntity(db, 'run', badStarted.runId);
  const schedulerError = events.find((e) => e.eventType === 'scheduler_error');
  assert.ok(schedulerError, 'the throw must be recorded as an internal scheduler_error event');
  assert.match((schedulerError!.payload as { message: string }).message, /requires an explicit boolean "retryable"/);
});

test('a progress event at or under the ceiling never stops the worker', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1, maxBudgetUsd: 1 });
  const adapter = new TestAdapter();
  const ticket = createTicket(db, { projectId: project.id, title: 'exactly on budget', workspaceType: 'NONE' });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const s = started[0];

  adapter.emit(s.handle.id, { type: 'progress', message: 'turn 1', costUsd: 1 });
  assert.equal(adapter.isStopped(s.handle.id), false, 'exactly at the ceiling is not over it');

  adapter.emit(s.handle.id, {
    type: 'result_raw',
    raw: { status: 'done', summary: 'finished on budget', artifacts: [{ kind: 'text', text: 'ok' }], checks: [], blockers: [], questions: [] },
  });
  await s.done;

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

// --- Batch 16 Role A item 1: the fake adapter scripts a progress BURST ------
// One `progress` script used to emit exactly one event, so nothing could
// exercise "several progress events through one run" without a hand-built
// TestAdapter (and ruling 18 requirement 4 was proven by a Chrome run). A
// script now carries an ordered list with a configurable gap.
test('a fake `progress` script with a message list drives FIVE progress events through ONE run: five worker_progress rows, ascending sequence, in the scripted order', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'bursts', workspaceType: 'NONE' });
  const messages = ['one', 'two', 'three', 'four', 'five'];
  adapter.setScript(ticket.id, { kind: 'progress', messages, gapMs: 5 });

  const deps = { db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir };
  const { started } = await tick(deps);
  const runId = started[0].runId;
  try {
    const rows = () => listEventsForEntity(db, 'run', runId).filter((e) => e.eventType === 'worker_progress');
    const deadline = Date.now() + 3000;
    while (rows().length < 5 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    const got = rows();
    assert.equal(got.length, 5, 'exactly five worker_progress rows for the one run');
    const sequences = got.map((e) => e.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, 'sequences ascend');
    assert.equal(new Set(sequences).size, 5, 'and are all distinct');
    assert.deepEqual(
      got.map((e) => (e.payload as { message: string }).message),
      messages,
      'emitted in the scripted order'
    );
    assert.equal(getTicket(db, ticket.id)!.status, 'IN_PROGRESS', 'a progress script never terminates on its own');
  } finally {
    await adapter.stop(started[0].handle);
  }
});

test('the gap between the messages of a scripted burst is the configured gapMs, not zero: first-to-last spans at least the summed gaps', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'spaced', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'progress', messages: ['a', 'b', 'c'], gapMs: 60 });

  const { started } = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  try {
    const rows = () => listEventsForEntity(db, 'run', started[0].runId).filter((e) => e.eventType === 'worker_progress');
    const deadline = Date.now() + 3000;
    while (rows().length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const got = rows();
    assert.equal(got.length, 3);
    const span = Date.parse(got[2].createdAt) - Date.parse(got[0].createdAt);
    assert.ok(span >= 100, `two 60ms gaps must span at least ~100ms first-to-last (timers never fire early), got ${span}ms`);
  } finally {
    await adapter.stop(started[0].handle);
  }
});

// --- Batch 16 Role A item 2, ruling 19 (batch 15 addendum 8) ---------------
// The real run showed `reporting` for every animation because a "tool result
// received" event follows each tool use within milliseconds and used to be
// classified `reporting`. The phase is now carried per run: the result keeps
// the phase of the tool it answers, only a `text:` line reports, and `tool`
// stays null for every non-tool message (the phase is the state, the tool is
// the evidence). Driven with item 1's burst, in the adapter's real message
// shapes.
test('a scripted [tool_use: Write, tool result received, text: ...] burst persists states writing, writing, reporting, with tools Write, null, null', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'phases', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, {
    kind: 'progress',
    messages: ['tool_use: Write', 'tool result received', 'text: all written'],
    gapMs: 5,
  });

  const { started } = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  try {
    const rows = () => listEventsForEntity(db, 'run', started[0].runId).filter((e) => e.eventType === 'worker_progress');
    const deadline = Date.now() + 3000;
    while (rows().length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const payloads = rows().map((e) => e.payload as { state: string; tool: string | null });
    assert.deepEqual(payloads.map((p) => p.state), ['writing', 'writing', 'reporting']);
    assert.deepEqual(payloads.map((p) => p.tool), ['Write', null, null]);
  } finally {
    await adapter.stop(started[0].handle);
  }
});

test('the phase is per run and starts at running: a tool result and a thinking line BEFORE any tool use are running, and the phase of one run never leaks into another', async () => {
  const { db, project, adapter } = setupProject(2);
  const a = createTicket(db, { projectId: project.id, title: 'a', workspaceType: 'NONE' });
  const b = createTicket(db, { projectId: project.id, title: 'b', workspaceType: 'NONE' });
  adapter.setScript(a.id, { kind: 'progress', messages: ['tool result received', 'tool_use: Read', 'thinking (~5 tokens)'], gapMs: 5 });
  adapter.setScript(b.id, { kind: 'progress', messages: ['session initialized', 'tool result received'], gapMs: 5 });

  const { started } = await tick({ db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir });
  try {
    const states = (runId: string) =>
      listEventsForEntity(db, 'run', runId)
        .filter((e) => e.eventType === 'worker_progress')
        .map((e) => (e.payload as { state: string }).state);
    const runOf = (ticketId: string) => started.find((s) => s.ticketId === ticketId)!.runId;
    const deadline = Date.now() + 3000;
    while ((states(runOf(a.id)).length < 3 || states(runOf(b.id)).length < 2) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(states(runOf(a.id)), ['running', 'reading', 'reading']);
    assert.deepEqual(states(runOf(b.id)), ['running', 'running'], "run A's reading phase must not leak into run B");
  } finally {
    for (const s of started) await adapter.stop(s.handle);
  }
});

test('a fake `progress` script with NO message list still emits exactly one event, as before', async () => {
  const { db, project, adapter } = setupProject(1);
  const ticket = createTicket(db, { projectId: project.id, title: 'single', workspaceType: 'NONE' });
  adapter.setScript(ticket.id, { kind: 'progress', message: 'only one' });

  const { started } = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rows = listEventsForEntity(db, 'run', started[0].runId).filter((e) => e.eventType === 'worker_progress');
    assert.equal(rows.length, 1);
    assert.equal((rows[0].payload as { message: string }).message, 'only one');
  } finally {
    await adapter.stop(started[0].handle);
  }
});


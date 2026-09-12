import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { addDependency, createProject, createTicket, getRun, getTicket, listTicketsByStatus } from './store.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { tick, runUntilIdle } from './scheduler.ts';

function setupProject(maxParallelWorkers = 2) {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers });
  const adapter = new FakeAdapter();
  return { db, project, adapter };
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

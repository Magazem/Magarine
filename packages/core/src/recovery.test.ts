import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { createProject, createRun, createTicket, finishRun, getRun, getTicket } from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { recoverOrphanedRuns } from './recovery.ts';

function makeOrphanedRun(db: ReturnType<typeof openDb>, maxAttempts = 3) {
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `run_started:${run.id}` });
  // Simulate a process crash: no in-memory handle survives, but the DB still
  // says this run is "running" and the ticket is IN_PROGRESS.
  return { project, ticket, run };
}

test('a run left running with no live handle is marked failed and its ticket returns to READY', () => {
  const db = openDb(':memory:');
  const { ticket, run } = makeOrphanedRun(db);

  const result = recoverOrphanedRuns(db);

  assert.deepEqual(result.recovered, [run.id]);
  assert.equal(getRun(db, run.id)!.status, 'failed');
  assert.equal(getRun(db, run.id)!.failureClass, 'orphaned_on_restart');
  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1);
});

test('a ticket whose attempts are already exhausted goes to FAILED on recovery', () => {
  const db = openDb(':memory:');
  const { ticket } = makeOrphanedRun(db, 1);

  recoverOrphanedRuns(db);

  assert.equal(getTicket(db, ticket.id)!.status, 'FAILED');
});

test('running recovery twice is safe: the second pass finds nothing to recover', () => {
  const db = openDb(':memory:');
  const { ticket } = makeOrphanedRun(db);

  const first = recoverOrphanedRuns(db);
  const second = recoverOrphanedRuns(db);

  assert.equal(first.recovered.length, 1);
  assert.equal(second.recovered.length, 0);
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1, 'not double-counted');
});

test('a run that already finished normally is left alone', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `run_started:${run.id}` });
  finishRun(db, run.id, { status: 'succeeded' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_done', idempotencyKey: `worker_done:${run.id}` });

  const result = recoverOrphanedRuns(db);

  assert.equal(result.recovered.length, 0);
  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

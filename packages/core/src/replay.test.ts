import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { createProject, createTicket, getTicket, listEventsForEntity } from './store.ts';
import { computeStatusFromEvents, recordTicketTransition } from './stateMachine.ts';

test('replaying the event log reproduces the derived ticket status and attempt count', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts: 2 });

  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: '1' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: '2' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_failure', idempotencyKey: '3', payload: { retryable: true } });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: '4' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_review', idempotencyKey: '5' });

  const persisted = getTicket(db, ticket.id)!;
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const replayed = computeStatusFromEvents(events, persisted.maxAttempts);

  assert.equal(persisted.status, 'REVIEW');
  assert.equal(persisted.attemptCount, 1);
  // The event actually persisted at idempotencyKey '3' is the concrete
  // outcome type, worker_failed_retryable, not the 'worker_failure' verb
  // that was passed in -- proves computeStatusFromEvents is folding over
  // what a real event log actually contains.
  assert.equal(events[2].eventType, 'worker_failed_retryable');
  assert.deepEqual(replayed, { status: persisted.status, attemptCount: persisted.attemptCount });
});

test('replaying a database\'s event log written before batch 4 (containing the retired worker_retryable_failure literal) still reproduces the same statuses', () => {
  // Simulates rows already sitting in `events` from before this batch, which
  // recordTicketTransition can no longer produce (the transition is
  // retired) but computeStatusFromEvents must still be able to fold over.
  // Mirrors stateMachine.test.ts's exhaustion scenario: two failures with
  // maxAttempts 2 lands in FAILED with attempt_count 2.
  const legacyLog = [
    { eventType: 'dependencies_resolved', payload: {} },
    { eventType: 'run_started', payload: {} },
    { eventType: 'worker_retryable_failure', payload: { message: 'flaky', retryable: true } },
    { eventType: 'run_started', payload: {} },
    { eventType: 'worker_retryable_failure', payload: { message: 'flaky again', retryable: true } },
  ];

  const replayed = computeStatusFromEvents(legacyLog, 2);

  assert.deepEqual(replayed, { status: 'FAILED', attemptCount: 2 });
});

test('replaying a database\'s event log written before batch 4, with attempts remaining, still reproduces READY', () => {
  const legacyLog = [
    { eventType: 'dependencies_resolved', payload: {} },
    { eventType: 'run_started', payload: {} },
    { eventType: 'worker_retryable_failure', payload: { message: 'flaky', retryable: true } },
  ];

  const replayed = computeStatusFromEvents(legacyLog, 2);

  assert.deepEqual(replayed, { status: 'READY', attemptCount: 1 });
});

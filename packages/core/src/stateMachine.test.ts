import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { createProject, createTicket, listEventsForEntity, getTicket } from './store.ts';
import { recordTicketTransition, InvalidTransitionError } from './stateMachine.ts';

function setup() {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts: 2 });
  return { db, project, ticket };
}

test('valid transition writes exactly one event and updates the derived ticket row', () => {
  const { db, ticket } = setup();

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'dependencies_resolved',
    idempotencyKey: 'k1',
  });

  assert.equal(result.applied, true);
  assert.equal(result.ticket.status, 'READY');

  const events = listEventsForEntity(db, 'ticket', ticket.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'dependencies_resolved');

  const persisted = getTicket(db, ticket.id)!;
  assert.equal(persisted.status, 'READY');
});

test('invalid transition throws and changes nothing', () => {
  const { db, ticket } = setup();

  assert.throws(() => {
    recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'worker_done', // OPEN -> worker_done is not a valid transition
      idempotencyKey: 'k1',
    });
  }, InvalidTransitionError);

  const persisted = getTicket(db, ticket.id)!;
  assert.equal(persisted.status, 'OPEN');
  assert.equal(listEventsForEntity(db, 'ticket', ticket.id).length, 0);
});

test('a second event with the same idempotency key is ignored', () => {
  const { db, ticket } = setup();

  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'same' });
  const second = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'dependencies_resolved',
    idempotencyKey: 'same',
  });

  assert.equal(second.applied, false);
  assert.equal(listEventsForEntity(db, 'ticket', ticket.id).length, 1);
  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
});

test('worker_retryable_failure returns ticket to READY and increments attempt_count while attempts remain', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_retryable_failure',
    idempotencyKey: 'c',
  });

  assert.equal(result.ticket.status, 'READY');
  assert.equal(result.ticket.attemptCount, 1);
});

test('worker_retryable_failure moves to FAILED once max_attempts is reached', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_retryable_failure', idempotencyKey: 'c' });
  // Back to READY with attempt_count 1; simulate second run picked up.
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'd' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_retryable_failure',
    idempotencyKey: 'e',
  });

  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(result.ticket.attemptCount, 2);
});

test('worker_question is a self-loop on IN_PROGRESS and is recorded as an event', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_question',
    idempotencyKey: 'c',
    payload: { message: 'which file?' },
  });

  assert.equal(result.ticket.status, 'IN_PROGRESS');
  assert.equal(listEventsForEntity(db, 'ticket', ticket.id).length, 3);
});

test('worker_needs_user_decision moves ticket to BLOCKED', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_needs_user_decision',
    idempotencyKey: 'c',
  });

  assert.equal(result.ticket.status, 'BLOCKED');
});

test('worker_done moves IN_PROGRESS straight to DONE', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_done', idempotencyKey: 'c' });

  assert.equal(result.ticket.status, 'DONE');
});

test('worker_needs_review moves IN_PROGRESS to REVIEW', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_needs_review',
    idempotencyKey: 'c',
  });

  assert.equal(result.ticket.status, 'REVIEW');
});

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

test('manual_retry moves FAILED to READY and raises max_attempts by one', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_retryable_failure', idempotencyKey: 'c' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'd' });
  const exhausted = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_retryable_failure',
    idempotencyKey: 'e',
  });
  assert.equal(exhausted.ticket.status, 'FAILED');
  assert.equal(exhausted.ticket.maxAttempts, 2);

  const retried = recordTicketTransition(db, { ticketId: ticket.id, event: 'manual_retry', idempotencyKey: 'f' });

  assert.equal(retried.ticket.status, 'READY');
  assert.equal(retried.ticket.attemptCount, 2, 'manual_retry does not reset attempt_count');
  assert.equal(retried.ticket.maxAttempts, 3, 'manual_retry raises max_attempts by one');
});

test('manual_retry refuses a ticket that is not FAILED', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'manual_retry', idempotencyKey: 'a' });
  }, InvalidTransitionError);
});

test("user_decision moves BLOCKED to READY and its event_type is literally 'user_decision', per the cross-role contract", () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_user_decision', idempotencyKey: 'c' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'user_decision',
    idempotencyKey: 'd',
    payload: { ticketId: ticket.id, question: 'Which file?', answer: 'widget.ts' },
    visibility: 'activity',
  });

  assert.equal(result.ticket.status, 'READY');
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const decision = events.find((e) => e.eventType === 'user_decision');
  assert.ok(decision, 'the persisted event_type must be exactly "user_decision"');
  assert.deepEqual(decision!.payload, { ticketId: ticket.id, question: 'Which file?', answer: 'widget.ts' });
});

test('user_decision refuses a ticket that is not BLOCKED', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'user_decision', idempotencyKey: 'a' });
  }, InvalidTransitionError);
});

test('run_cancelled moves IN_PROGRESS to READY without consuming an attempt', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, { ticketId: ticket.id, event: 'run_cancelled', idempotencyKey: 'c' });

  assert.equal(result.ticket.status, 'READY');
  assert.equal(result.ticket.attemptCount, 0, 'run_cancelled must not consume an attempt');
});

test('run_cancelled refuses a ticket that is not IN_PROGRESS', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'run_cancelled', idempotencyKey: 'a' });
  }, InvalidTransitionError);
});

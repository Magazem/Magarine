import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { addDependency, createProject, createTicket, listEventsForEntity, getTicket } from './store.ts';
import { recordTicketTransition, InvalidTransitionError } from './stateMachine.ts';
import { resolveReadiness } from './dependencies.ts';

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

test('worker_failure (retryable) returns ticket to READY, increments attempt_count, and persists as worker_failed_retryable', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: 'c',
    payload: { retryable: true },
  });

  assert.equal(result.ticket.status, 'READY');
  assert.equal(result.ticket.attemptCount, 1);
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  assert.equal(events.at(-1)!.eventType, 'worker_failed_retryable', 'must persist under the concrete outcome type, not the verb');
  assert.equal(events.at(-1)!.visibility, 'activity');
});

test('worker_failure (retryable) moves to FAILED once max_attempts is reached, and persists as worker_failed_final', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_failure', idempotencyKey: 'c', payload: { retryable: true } });
  // Back to READY with attempt_count 1; simulate second run picked up.
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'd' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: 'e',
    payload: { retryable: true },
  });

  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(result.ticket.attemptCount, 2);
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  assert.equal(events.at(-1)!.eventType, 'worker_failed_final');
  assert.equal(events.at(-1)!.visibility, 'inbox');
  assert.equal(events.at(-1)!.requiresUser, true);
});

test('worker_failure (not retryable) goes straight to FAILED on the first attempt, even with attempts remaining, and persists as worker_failed_final', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: 'c',
    payload: { retryable: false, failureClass: 'budget_exceeded', tally: 1.5, overshoot: 0.5 },
  });

  assert.equal(result.ticket.status, 'FAILED', 'a non-retryable failure is final regardless of attempts remaining');
  assert.equal(result.ticket.attemptCount, 1);
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const finalEvent = events.at(-1)!;
  assert.equal(finalEvent.eventType, 'worker_failed_final');
  assert.equal(finalEvent.visibility, 'inbox');
  assert.equal(finalEvent.requiresUser, true);
  assert.deepEqual(finalEvent.payload, { retryable: false, failureClass: 'budget_exceeded', tally: 1.5, overshoot: 0.5 });
});

test('worker_failure without an explicit boolean retryable in its payload throws rather than defaulting', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_failure', idempotencyKey: 'c', payload: {} });
  }, /explicit boolean "retryable"/);
});

test('worker_failure refuses a ticket that is not IN_PROGRESS', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_failure', idempotencyKey: 'a', payload: { retryable: true } });
  }, InvalidTransitionError);
});

// --- Batch 7 (Role L): the worker's own budget self-stop ---

test('worker_budget_stop lands the ticket in FAILED, persisted as worker_failed_final, without consuming an attempt', () => {
  const { db, ticket } = setup(); // maxAttempts: 2, attemptCount starts at 0
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_budget_stop',
    idempotencyKey: 'c',
    payload: {
      status: 'budget_insufficient',
      summary: 'Stopped after file01.txt: cost per pair makes the rest impossible within the ceiling.',
      retryable: false,
      failureClass: 'worker_budget_stop',
    },
  });

  assert.equal(result.ticket.status, 'FAILED', 'a budget stop is final regardless of attempts remaining');
  assert.equal(result.ticket.attemptCount, 0, 'no attempt is consumed by the worker explaining a budget stop');
  assert.equal(result.ticket.maxAttempts, 2);

  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const finalEvent = events.at(-1)!;
  assert.equal(finalEvent.eventType, 'worker_failed_final', 'must persist under the same concrete outcome type as any other FAILED-final failure');
  assert.equal(finalEvent.visibility, 'inbox');
  assert.equal(finalEvent.requiresUser, true);
  assert.deepEqual(finalEvent.payload, {
    status: 'budget_insufficient',
    summary: 'Stopped after file01.txt: cost per pair makes the rest impossible within the ceiling.',
    retryable: false,
    failureClass: 'worker_budget_stop',
  });
});

test('worker_budget_stop refuses a ticket that is not IN_PROGRESS', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'worker_budget_stop',
      idempotencyKey: 'a',
      payload: { failureClass: 'worker_budget_stop' },
    });
  }, InvalidTransitionError);
});

test('worker_budget_stop, unlike worker_failure, needs no explicit retryable flag in its payload -- it is never retryable by definition', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });

  assert.doesNotThrow(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_budget_stop', idempotencyKey: 'c', payload: {} });
  });
});

test('manual_retry after a worker_budget_stop moves the ticket back to READY, raising max_attempts, with attempt_count untouched', () => {
  const { db, ticket } = setup(); // maxAttempts: 2, attemptCount starts at 0
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  const stopped = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_budget_stop',
    idempotencyKey: 'c',
    payload: { failureClass: 'worker_budget_stop' },
  });
  assert.equal(stopped.ticket.status, 'FAILED');
  assert.equal(stopped.ticket.attemptCount, 0);

  const retried = recordTicketTransition(db, { ticketId: ticket.id, event: 'manual_retry', idempotencyKey: 'd' });

  assert.equal(retried.ticket.status, 'READY');
  assert.equal(retried.ticket.attemptCount, 0, 'attempt_count is exactly what it was before the budget stop');
  assert.equal(retried.ticket.maxAttempts, 3, 'manual_retry still raises max_attempts by one, same as any other retry');
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
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_failure', idempotencyKey: 'c', payload: { retryable: true } });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'd' });
  const exhausted = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: 'e',
    payload: { retryable: true },
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

test('a replayed worker_failure (same idempotency key, ticket already advanced) is a silent no-op, not an InvalidTransitionError', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  const first = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: 'dup',
    payload: { retryable: true },
  });
  assert.equal(first.applied, true);
  assert.equal(getTicket(db, ticket.id)!.status, 'READY');

  // The ticket is now READY, not IN_PROGRESS -- computeNextState's
  // 'worker_failure' branch would throw InvalidTransitionError if evaluated
  // against this status. The idempotency check must short-circuit before
  // that ever happens.
  const replay = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: 'dup',
    payload: { retryable: true },
  });
  assert.equal(replay.applied, false);
  assert.equal(getTicket(db, ticket.id)!.status, 'READY', 'unchanged by the replay');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 1, 'not double-counted');
});

test('review_approved moves REVIEW to DONE', () => {
  const { db, ticket } = setup();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_review', idempotencyKey: 'c' });

  const result = recordTicketTransition(db, { ticketId: ticket.id, event: 'review_approved', idempotencyKey: 'd' });

  assert.equal(result.ticket.status, 'DONE');
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  assert.equal(events.at(-1)!.eventType, 'review_approved');
  assert.equal(events.at(-1)!.visibility, 'activity');
});

test('review_approved refuses a ticket that is not in REVIEW', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'review_approved', idempotencyKey: 'a' });
  }, InvalidTransitionError);
});

test('review_rejected returns a ticket to READY, consumes one attempt, and persists as review_rejected while attempts remain', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_review', idempotencyKey: 'c' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'review_rejected',
    idempotencyKey: 'd',
    payload: { reason: 'not quite right' },
  });

  assert.equal(result.ticket.status, 'READY');
  assert.equal(result.ticket.attemptCount, 1);
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  assert.equal(events.at(-1)!.eventType, 'review_rejected');
  assert.equal(events.at(-1)!.visibility, 'activity');
  assert.deepEqual(events.at(-1)!.payload, { reason: 'not quite right' });
});

test('review_rejected at the last attempt lands in FAILED, persisted as worker_failed_final, and reaches the inbox', () => {
  const { db, ticket } = setup(); // maxAttempts: 2
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_review', idempotencyKey: 'c' });
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'review_rejected',
    idempotencyKey: 'd',
    payload: { reason: 'first rejection' },
  });
  // Back to READY with attempt_count 1; simulate a second attempt reaching review again.
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'e' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_review', idempotencyKey: 'f' });

  const result = recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'review_rejected',
    idempotencyKey: 'g',
    payload: { reason: 'second rejection' },
  });

  assert.equal(result.ticket.status, 'FAILED');
  assert.equal(result.ticket.attemptCount, 2);
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const finalEvent = events.at(-1)!;
  assert.equal(finalEvent.eventType, 'worker_failed_final', 'exhaustion reuses the same concrete type as an exhausted worker_failure');
  assert.equal(finalEvent.visibility, 'inbox');
  assert.equal(finalEvent.requiresUser, true);
  assert.deepEqual(finalEvent.payload, { reason: 'second rejection' });
});

test('approving a ticket makes its dependent READY on the next resolve (batch-4-spec.md Role H item 7 acceptance)', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const blocker = createTicket(db, { projectId: project.id, title: 'blocker' });
  const dependent = createTicket(db, { projectId: project.id, title: 'dependent' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });
  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, blocker.id)!.status, 'READY');
  assert.equal(getTicket(db, dependent.id)!.status, 'OPEN', 'still blocked on the blocker');

  recordTicketTransition(db, { ticketId: blocker.id, event: 'run_started', idempotencyKey: 'b1' });
  recordTicketTransition(db, { ticketId: blocker.id, event: 'worker_needs_review', idempotencyKey: 'b2' });
  const approved = recordTicketTransition(db, { ticketId: blocker.id, event: 'review_approved', idempotencyKey: 'b3' });
  assert.equal(approved.ticket.status, 'DONE');

  const { promoted } = resolveReadiness(db, project.id);

  assert.deepEqual(promoted.map((t) => t.id), [dependent.id]);
  assert.equal(getTicket(db, dependent.id)!.status, 'READY');
});

test('review_rejected refuses a ticket that is not in REVIEW', () => {
  const { db, ticket } = setup();
  assert.throws(() => {
    recordTicketTransition(db, { ticketId: ticket.id, event: 'review_rejected', idempotencyKey: 'a', payload: { reason: 'x' } });
  }, InvalidTransitionError);
});

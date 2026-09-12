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
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_retryable_failure', idempotencyKey: '3' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: '4' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_needs_review', idempotencyKey: '5' });

  const persisted = getTicket(db, ticket.id)!;
  const events = listEventsForEntity(db, 'ticket', ticket.id);
  const replayed = computeStatusFromEvents(events, persisted.maxAttempts);

  assert.equal(persisted.status, 'REVIEW');
  assert.equal(persisted.attemptCount, 1);
  assert.deepEqual(replayed, { status: persisted.status, attemptCount: persisted.attemptCount });
});

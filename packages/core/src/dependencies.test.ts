import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { addDependency, createProject, createTicket, getTicket } from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { isReady, resolveReadiness } from './dependencies.ts';

test('a ticket with no dependencies is ready immediately', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const a = createTicket(db, { projectId: project.id, title: 'A' });

  assert.equal(isReady(db, a.id), true);

  const { promoted } = resolveReadiness(db, project.id);
  assert.deepEqual(promoted.map((t) => t.id), [a.id]);
  assert.equal(getTicket(db, a.id)!.status, 'READY');
});

test('a ticket promoted to READY before a dependency is attached is demoted back to OPEN', () => {
  // This is the CLI's natural order: a ticket cannot be named in a
  // dependency until it exists, so `ticket add` (dependent) then
  // `ticket add` (blocker) then `dep add` is how a real user types it —
  // not "wire deps first, resolve readiness second" like the other tests
  // in this file. See the regression this guards against in cli.test.ts.
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const dependent = createTicket(db, { projectId: project.id, title: 'DEPENDENT' });
  resolveReadiness(db, project.id); // Promotes `dependent`: it has no deps yet.
  assert.equal(getTicket(db, dependent.id)!.status, 'READY');

  const blocker = createTicket(db, { projectId: project.id, title: 'BLOCKER' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });

  const { demoted } = resolveReadiness(db, project.id);

  assert.deepEqual(demoted.map((t) => t.id), [dependent.id]);
  assert.equal(getTicket(db, dependent.id)!.status, 'OPEN', 'no longer ready: it now depends on an unfinished BLOCKER');
  assert.equal(getTicket(db, blocker.id)!.status, 'READY', 'BLOCKER itself has no deps');
});

test('a demoted ticket is promoted again once its newly-attached dependency finishes', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const dependent = createTicket(db, { projectId: project.id, title: 'DEPENDENT' });
  resolveReadiness(db, project.id);
  const blocker = createTicket(db, { projectId: project.id, title: 'BLOCKER' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });
  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, dependent.id)!.status, 'OPEN');

  recordTicketTransition(db, { ticketId: blocker.id, event: 'run_started', idempotencyKey: 'b1' });
  recordTicketTransition(db, { ticketId: blocker.id, event: 'worker_done', idempotencyKey: 'b2' });

  const { promoted } = resolveReadiness(db, project.id);
  assert.deepEqual(promoted.map((t) => t.id), [dependent.id]);
  assert.equal(getTicket(db, dependent.id)!.status, 'READY');
});

test('a ticket stays OPEN until all of its blocking dependencies are DONE', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const a = createTicket(db, { projectId: project.id, title: 'A' });
  const b = createTicket(db, { projectId: project.id, title: 'B' });
  const c = createTicket(db, { projectId: project.id, title: 'C' });
  addDependency(db, { ticketId: c.id, dependsOnTicketId: a.id });
  addDependency(db, { ticketId: c.id, dependsOnTicketId: b.id });

  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, c.id)!.status, 'OPEN', 'still waiting on both deps');

  // A and B have no dependencies of their own, so the resolveReadiness call
  // above already promoted both of them to READY. Finish A only.
  recordTicketTransition(db, { ticketId: a.id, event: 'run_started', idempotencyKey: 'a2' });
  recordTicketTransition(db, { ticketId: a.id, event: 'worker_done', idempotencyKey: 'a3' });

  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, c.id)!.status, 'OPEN', 'still waiting on B');

  // Finish B.
  recordTicketTransition(db, { ticketId: b.id, event: 'run_started', idempotencyKey: 'b2' });
  recordTicketTransition(db, { ticketId: b.id, event: 'worker_done', idempotencyKey: 'b3' });

  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, c.id)!.status, 'READY', 'both deps DONE, C is ready');
});

test('calling resolveReadiness twice does not create duplicate events', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const a = createTicket(db, { projectId: project.id, title: 'A' });

  resolveReadiness(db, project.id);
  const second = resolveReadiness(db, project.id);

  assert.deepEqual(second, { promoted: [], demoted: [] });
  assert.equal(getTicket(db, a.id)!.status, 'READY');
});

// Batch 8's ruling on `cancel --ticket`: "dependents of a cancelled ticket
// stay OPEN and never become READY. No cascade." CANCELLED is simply not
// DONE, so `isReady`'s existing check ("every blocking dependency is DONE")
// already produces this by construction -- this is a regression test for
// that property, not new dependencies.ts logic.
test('a dependent of a CANCELLED ticket stays OPEN forever: no cascade, and no way back short of retrying the blocker', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const blocker = createTicket(db, { projectId: project.id, title: 'BLOCKER' });
  const dependent = createTicket(db, { projectId: project.id, title: 'DEPENDENT' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });
  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, blocker.id)!.status, 'READY');
  assert.equal(getTicket(db, dependent.id)!.status, 'OPEN');

  recordTicketTransition(db, { ticketId: blocker.id, event: 'cancel', idempotencyKey: 'c1' });
  assert.equal(getTicket(db, blocker.id)!.status, 'CANCELLED');
  assert.equal(isReady(db, dependent.id), false);

  const { promoted } = resolveReadiness(db, project.id);
  assert.deepEqual(promoted, [], 'a cancelled blocker must never promote its dependent');
  assert.equal(getTicket(db, dependent.id)!.status, 'OPEN');

  // The blocker's own retry (batch 8: manual_retry also accepts CANCELLED)
  // is the only way back -- once it reaches DONE, the dependent is
  // promoted normally, same as any other completed blocker.
  recordTicketTransition(db, { ticketId: blocker.id, event: 'manual_retry', idempotencyKey: 'c2' });
  assert.equal(getTicket(db, blocker.id)!.status, 'READY');
  recordTicketTransition(db, { ticketId: blocker.id, event: 'run_started', idempotencyKey: 'c3' });
  recordTicketTransition(db, { ticketId: blocker.id, event: 'worker_done', idempotencyKey: 'c4' });

  resolveReadiness(db, project.id);
  assert.equal(getTicket(db, dependent.id)!.status, 'READY');
});

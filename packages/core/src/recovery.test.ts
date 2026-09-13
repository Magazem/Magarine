import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import { createProject, createRun, createTicket, finishRun, getRun, getTicket } from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { recoverOrphanedRuns } from './recovery.ts';
import { prepareWorkspace } from './workspace.ts';
import { testTempRoot } from './testSupport.ts';

// Batch 8 item 3 (this file's own private root, per batch 5's original
// convention -- see testSupport.ts's doc comment): scopes the one test
// below that creates a real NONE-mode temp directory, so its
// existsSync/gone assertion can't transiently collide with another
// concurrently-running test file's own `magarine-run-*` entries.
const recoveryTestRoot = testTempRoot('recovery');
const workspaceBaseDir = recoveryTestRoot.root;
after(recoveryTestRoot.cleanup);

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

// Batch 8: a real, pre-existing production leak, found by measuring
// `magarine-run-*` directory counts before/after twenty cold runs (the same
// discipline Batch 5 used for a different leak in a different code path),
// not by trusting a green suite. recoverOrphanedRuns settled the run/ticket
// rows since Batch 1 but never reclaimed a crashed NONE-mode run's
// disposable temp workspace -- a real directory, created the same way
// scheduler.ts's own tick() does, checked against the real filesystem
// (existsSync), not the return value.
test('a crashed NONE-mode run\'s disposable temp workspace is removed from the real filesystem on recovery', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', workspaceType: 'NONE' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });

  const ws = prepareWorkspace('NONE', ticket.id, { baseDir: workspaceBaseDir });
  assert.ok(existsSync(ws.path), 'sanity: the real temp directory must exist before recovery runs');

  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake', workspaceRef: ws.path });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `run_started:${run.id}` });

  recoverOrphanedRuns(db);

  assert.ok(!existsSync(ws.path), 'the orphaned run\'s NONE workspace must be reclaimed, not left behind');
});

// The DIRECTORY-mode counterpart: a shared project directory is real,
// user-owned storage, not disposable -- recovery must never delete it, the
// same guard cancelTicketRun (scheduler.ts) already applies for every other
// cancellation path.
test('a crashed DIRECTORY-mode run\'s shared workspace is never touched by recovery', () => {
  const db = openDb(':memory:');
  const sharedRoot = mkdtempSync(join(workspaceBaseDir, 'shared-'));
  const project = createProject(db, { name: 'p', workspaceRoot: sharedRoot });
  const ticket = createTicket(db, { projectId: project.id, title: 't', workspaceType: 'DIRECTORY' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake', workspaceRef: sharedRoot });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `run_started:${run.id}` });

  recoverOrphanedRuns(db);

  assert.ok(existsSync(sharedRoot), 'a DIRECTORY-mode shared workspace must survive recovery');
});

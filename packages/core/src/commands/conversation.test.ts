import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { createArtifact, createProject, createTicket, insertEvent } from '../store.ts';
import { buildConversation } from './conversation.ts';

// Mirrors stateMachine.test.ts's own setup for reaching BLOCKED: OPEN ->
// READY -> IN_PROGRESS -> BLOCKED, the only path worker_needs_user_decision
// is valid from.
function blockOnQuestion(db: import('../db/index.ts').Db, ticketId: string, summary: string) {
  recordTicketTransition(db, { ticketId, event: 'dependencies_resolved', idempotencyKey: `dr_${Math.random()}` });
  recordTicketTransition(db, { ticketId, event: 'run_started', idempotencyKey: `rs_${Math.random()}` });
  recordTicketTransition(db, {
    ticketId,
    event: 'worker_needs_user_decision',
    idempotencyKey: `wnud_${Math.random()}`,
    payload: { status: 'needs_user_decision', summary, blockers: [] },
  });
}

test('buildConversation interleaves owner discuss messages and manager_reply/manager_assessment artifacts in chronological order', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, kind: 'manager', title: 'Manager: plan', workspaceType: 'NONE' });

  insertEvent(db, {
    projectId: project.id,
    eventType: 'discuss',
    entityType: 'project',
    entityId: project.id,
    payload: { message: 'What should we build first?' },
    idempotencyKey: 'evt_1',
  });
  createArtifact(db, {
    ticketId: ticket.id,
    runId: 'run_fake',
    projectId: project.id,
    kind: 'manager_assessment',
    pathOrUri: 'The scope is thin -- I need more detail on the target platform.',
  });

  const entries = buildConversation(db, project.id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'owner_message');
  assert.equal(entries[0].text, 'What should we build first?');
  assert.equal(entries[1].kind, 'manager_assessment');
  assert.equal(entries[1].text, 'The scope is thin -- I need more detail on the target platform.');
});

test('buildConversation renders a manager_reply artifact for its own kind, distinct from manager_assessment', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, kind: 'manager', title: 'Manager: plan', workspaceType: 'NONE' });
  createArtifact(db, {
    ticketId: ticket.id,
    runId: 'run_fake',
    projectId: project.id,
    kind: 'manager_reply',
    pathOrUri: 'Done -- removed the export feature, see the updated scope.',
  });

  const entries = buildConversation(db, project.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'manager_reply');
  assert.equal(entries[0].text, 'Done -- removed the export feature, see the updated scope.');
});

test('buildConversation ignores artifacts of any other kind on a manager ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, kind: 'manager', title: 'Manager: plan', workspaceType: 'NONE' });
  createArtifact(db, { ticketId: ticket.id, runId: 'run_fake', projectId: project.id, kind: 'file', pathOrUri: '/tmp/report.md' });

  assert.deepEqual(buildConversation(db, project.id), []);
});

test('buildConversation surfaces a worker_needs_user_decision on a manager ticket as an unanswered question while BLOCKED', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, kind: 'manager', title: 'Manager: plan', workspaceType: 'NONE' });
  blockOnQuestion(db, ticket.id, 'Which platform should this target?');

  const entries = buildConversation(db, project.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'question');
  assert.equal(entries[0].text, 'Which platform should this target?');
  assert.equal(entries[0].ticketId, ticket.id);
  assert.equal(entries[0].answered, false);
});

test('buildConversation marks a question answered once its ticket leaves BLOCKED, and does not resurrect it after a later question on the same ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, kind: 'manager', title: 'Manager: plan', workspaceType: 'NONE' });
  blockOnQuestion(db, ticket.id, 'Which platform should this target?');
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'user_decision',
    idempotencyKey: 'evt_decision',
    payload: { ticketId: ticket.id, question: 'Which platform should this target?', answer: 'iOS only' },
  });
  // The ticket is READY again now (user_decision's own BLOCKED -> READY), so
  // the second round only re-runs (run_started), it does not re-resolve
  // dependencies -- dependencies_resolved is only valid from OPEN.
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'rs_2' });
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_needs_user_decision',
    idempotencyKey: 'wnud_2',
    payload: { status: 'needs_user_decision', summary: 'Should offline mode be in scope?', blockers: [] },
  });

  const entries = buildConversation(db, project.id);
  const questions = entries.filter((e) => e.kind === 'question');
  assert.equal(questions.length, 2);
  assert.equal(questions[0].text, 'Which platform should this target?');
  assert.equal(questions[0].answered, true, 'superseded by a later question on the same ticket, so no longer live');
  assert.equal(questions[1].text, 'Should offline mode be in scope?');
  assert.equal(questions[1].answered, false, 'the ticket is BLOCKED on this one right now');
});

test('buildConversation surfaces a scope_updated event with its summary', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  insertEvent(db, {
    projectId: project.id,
    eventType: 'scope_updated',
    entityType: 'project',
    entityId: project.id,
    payload: { summary: 'seeded from --mission' },
    idempotencyKey: 'evt_scope',
  });

  const entries = buildConversation(db, project.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'scope_updated');
  assert.equal(entries[0].text, 'seeded from --mission');
});

test('buildConversation sorts entries from different source tables (events and artifacts) by createdAt, not by which table they came from', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, kind: 'manager', title: 'Manager: plan', workspaceType: 'NONE' });

  // An events-table entry recorded first, then an artifacts-table entry --
  // if the function grouped by source table instead of merging by
  // createdAt, an artifact could wrongly sort before an earlier event.
  insertEvent(db, {
    projectId: project.id,
    eventType: 'scope_updated',
    entityType: 'project',
    entityId: project.id,
    payload: { summary: 'first' },
    idempotencyKey: 'evt_scope_1',
  });
  createArtifact(db, { ticketId: ticket.id, runId: 'run_fake', projectId: project.id, kind: 'manager_reply', pathOrUri: 'reply text' });

  const entries = buildConversation(db, project.id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'scope_updated');
  assert.equal(entries[1].kind, 'manager_reply');
});

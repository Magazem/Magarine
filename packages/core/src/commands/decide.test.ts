import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { applyManagerProposal } from '../managerApply.ts';
import { decide, DecideError, extractQuestionText, pendingQuestions } from './decide.ts';
import { createProject, createTicket, getProject, getTicket, listEventsForEntity } from '../store.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { testTempRoot } from '../testSupport.ts';
import type { Ticket } from '../types.ts';

// Ruling 36 (batch 19, mini-phase 2B), amended after the Opus review
// 2026-09-22 (section 3): one answer field per Manager question. See
// docs/strategy/batch-19-item-2b-one-answer-per-question.md.

const testRoot = testTempRoot('decide');
after(testRoot.cleanup);

function makeManagerTicket(db: ReturnType<typeof openDb>, projectId: string): Ticket {
  const ticket = createTicket(db, {
    projectId,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr:${ticket.id}` });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `rs:${ticket.id}` });
  return getTicket(db, ticket.id)!;
}

// Blocks a manager ticket on N request_user_decision commands, in order.
function blockOnQuestions(db: ReturnType<typeof openDb>, projectId: string, managerTicket: Ticket, questions: string[]): void {
  const proposal = {
    rationale: 'need to ask before proceeding',
    commands: questions.map((q) => ({ type: 'request_user_decision', question: q, context: 'ctx' })),
  };
  const result = applyManagerProposal(db, managerTicket, getProject(db, projectId)!, 'run_1', proposal);
  assert.equal(result.outcome, 'applied');
}

// Blocks a ticket the way an ORDINARY WORKER would -- a single-question,
// old-shape (`questions: []`) worker_needs_user_decision payload, never
// touched by managerApply.ts. Used to prove a worker-BLOCKED ticket is a
// one-question ticket without any managerApply involvement.
function blockAsWorker(db: ReturnType<typeof openDb>, ticket: Ticket, blockerText: string): void {
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_needs_user_decision',
    idempotencyKey: `wnud:${ticket.id}`,
    payload: { status: 'needs_user_decision', summary: blockerText, artifacts: [], checks: [], blockers: [blockerText], questions: [] },
  });
}

function makeWorkTicket(db: ReturnType<typeof openDb>, projectId: string, title: string): Ticket {
  const ticket = createTicket(db, { projectId, title, description: 'd' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr:${ticket.id}` });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `rs:${ticket.id}` });
  return ticket;
}

test('acceptance 1: three request_user_decision commands yield exactly those three pending questions, in order', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);

  blockOnQuestions(db, project.id, managerTicket, ['Which library?', 'Which host?', 'Which region?']);

  const event = listEventsForEntity(db, 'ticket', managerTicket.id)
    .filter((e) => e.eventType === 'worker_needs_user_decision')
    .at(-1)!;
  const questions = pendingQuestions(event.payload, 'manager');
  assert.equal(questions.length, 3);
  assert.match(questions[0], /^Which library\? /);
  assert.match(questions[1], /^Which host\? /);
  assert.match(questions[2], /^Which region\? /);
});

test('acceptance 2: decide with 2 answers on a 3-question ticket fails naming 3; with 3 it unblocks and pairs each question with its own answer', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  blockOnQuestions(db, project.id, managerTicket, ['Which library?', 'Which host?', 'Which region?']);

  assert.throws(
    () => decide(db, { ticketId: managerTicket.id, answers: ['a', 'b'] }),
    (err: unknown) => err instanceof DecideError && (err as Error).message.includes('has 3 pending question')
  );
  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED', 'a rejected decide() must not touch the ticket');

  const decided = decide(db, { ticketId: managerTicket.id, answers: ['Library X', 'Host Y', 'Region Z'] });
  assert.equal(decided.status, 'READY');

  const decisionEvent = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'user_decision')!;
  const payload = decisionEvent.payload as { decisions?: Array<{ question: string; answer: string }> };
  assert.equal(payload.decisions?.length, 3);
  assert.match(payload.decisions![0].question, /^Which library\?/);
  assert.equal(payload.decisions![0].answer, 'Library X');
  assert.match(payload.decisions![1].question, /^Which host\?/);
  assert.equal(payload.decisions![1].answer, 'Host Y');
  assert.match(payload.decisions![2].question, /^Which region\?/);
  assert.equal(payload.decisions![2].answer, 'Region Z');
});

test('acceptance 4: a worker-BLOCKED ticket has exactly one pending question, and decide --answer works as before', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = makeWorkTicket(db, project.id, 'Worker ticket');
  blockAsWorker(db, ticket, 'Should this use SQLite?');

  const event = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'worker_needs_user_decision')!;
  assert.deepEqual(pendingQuestions(event.payload, 'work'), [extractQuestionText(event.payload)]);
  assert.equal(pendingQuestions(event.payload, 'work').length, 1);

  const decided = decide(db, { ticketId: ticket.id, answer: 'Yes, use SQLite.' });
  assert.equal(decided.status, 'READY');
});

// Opus review item 1 (High): a WORK ticket's `questions` field is never
// consulted, even when a real worker filled it (the result contract lets
// it) -- only a MANAGER ticket's does. A work ticket is always one pending
// question, and decide --answer must still work normally against it.
test('Opus review item 1: a work ticket whose payload has questions [a, b] and blockers [x] has ONE pending question, and decide --answer works', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = makeWorkTicket(db, project.id, 'Worker ticket with a spoofed questions array');
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_needs_user_decision',
    idempotencyKey: `wnud:${ticket.id}`,
    payload: { status: 'needs_user_decision', summary: 'x', artifacts: [], checks: [], blockers: ['x'], questions: ['a', 'b'] },
  });

  const event = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'worker_needs_user_decision')!;
  const questions = pendingQuestions(event.payload, 'work');
  assert.deepEqual(questions, ['x'], 'a work ticket must fall back to blockers/summary, never trust its own questions array');

  const decided = decide(db, { ticketId: ticket.id, answer: 'the one real answer' });
  assert.equal(decided.status, 'READY');
});

// Opus review item 1: the SAME payload shape on a MANAGER ticket does trust
// `questions` -- this is the positive control proving the ticket-kind gate,
// not just "work tickets never see it".
test('Opus review item 1: the identical questions array is honoured on a manager ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  recordTicketTransition(db, {
    ticketId: managerTicket.id,
    event: 'worker_needs_user_decision',
    idempotencyKey: `wnud:${managerTicket.id}`,
    payload: { status: 'needs_user_decision', summary: 'x', artifacts: [], checks: [], blockers: ['x'], questions: ['a', 'b'] },
  });

  const event = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'worker_needs_user_decision')!;
  assert.deepEqual(pendingQuestions(event.payload, 'manager'), ['a', 'b']);
});

// Opus review item 2 (High): a single `answer` on an N > 1 ticket is
// ACCEPTED -- one combined answer to every pending question, recorded as
// ONE `decisions` entry whose question is the joined text. This is the
// shape the page sends until mini-phase 3B.
test('Opus review item 2: a single answer on a 3-question ticket is accepted as one combined decision', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  blockOnQuestions(db, project.id, managerTicket, ['Which library?', 'Which host?', 'Which region?']);

  const decided = decide(db, { ticketId: managerTicket.id, answer: 'Library X, Host Y, Region Z, all at once.' });
  assert.equal(decided.status, 'READY');

  const decisionEvent = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'user_decision')!;
  const payload = decisionEvent.payload as { decisions?: Array<{ question: string; answer: string }>; question?: string; answer?: string };
  assert.equal(payload.decisions?.length, 1, 'one combined answer is ONE decisions entry, not one per question');
  assert.match(payload.decisions![0].question, /Which library\?.*Which host\?.*Which region\?/);
  assert.equal(payload.decisions![0].answer, 'Library X, Host Y, Region Z, all at once.');
  assert.equal(payload.question, payload.decisions![0].question, 'the joined question/answer fields must match the single decisions entry');
  assert.equal(payload.answer, 'Library X, Host Y, Region Z, all at once.');
});

test('mutation: omitting answer/answers entirely is rejected (not silently treated as one empty answer)', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = makeWorkTicket(db, project.id, 't');
  blockAsWorker(db, ticket, 'Q?');

  assert.throws(() => decide(db, { ticketId: ticket.id }), DecideError);
});

test('mutation: answer AND answers together is rejected', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = makeWorkTicket(db, project.id, 't');
  blockAsWorker(db, ticket, 'Q?');

  assert.throws(() => decide(db, { ticketId: ticket.id, answer: 'a', answers: ['a'] }), DecideError);
});

test('mutation: "answers" with the wrong count on a 2-question ticket is rejected, naming the exact count', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  blockOnQuestions(db, project.id, managerTicket, ['Q1?', 'Q2?']);

  assert.throws(
    () => decide(db, { ticketId: managerTicket.id, answers: ['only one'] }),
    (err: unknown) => err instanceof DecideError && (err as Error).message.includes('has 2 pending question')
  );
});

test('mutation: an empty entry inside "answers" is rejected, not persisted as a blank answer', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  blockOnQuestions(db, project.id, managerTicket, ['Q1?', 'Q2?']);

  assert.throws(() => decide(db, { ticketId: managerTicket.id, answers: ['ok', '  '] }), DecideError);
  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED');
});

// Opus review item 6 (Low): wrong types get the one-sentence DecideError,
// not a TypeError -- this is the shape a malformed daemon-route JSON body
// can actually produce (a number, an object, an array of numbers...), never
// reachable from the CLI or a well-typed caller.
test('Opus review item 6: a non-string "answer" is refused with DecideError, not a TypeError', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = makeWorkTicket(db, project.id, 't');
  blockAsWorker(db, ticket, 'Q?');

  assert.throws(() => decide(db, { ticketId: ticket.id, answer: 42 as unknown as string }), DecideError);
});

test('Opus review item 6: an "answers" that is not an array of strings is refused with DecideError, not a TypeError', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  blockOnQuestions(db, project.id, managerTicket, ['Q1?', 'Q2?']);

  assert.throws(() => decide(db, { ticketId: managerTicket.id, answers: 'not an array' as unknown as string[] }), DecideError);
  assert.throws(() => decide(db, { ticketId: managerTicket.id, answers: [1, 2] as unknown as string[] }), DecideError);
  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED', 'neither malformed call may touch the ticket');
});

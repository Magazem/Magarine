import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { createProject, createRun, createTicket, insertEvent } from '../store.ts';
import { buildTicketProgress, classifyProgressMessage, classifyToolActivity, formatTicketProgress } from './activity.ts';

// Ruling 7's tool-to-state mapping (batch-15-spec.md section 3, Role A item
// 1): one pure function, one test per branch. `classifyToolActivity` is the
// pure core (tool name + optional Bash command in, ActivityState out);
// `classifyProgressMessage` is the thin adapter over the free-text
// `message` string both AgentAdapter implementations already produce
// (claudeCli.ts's `describeProgress`: `tool_use: <name>`, and, per batch 15
// addendum 3 ruling 14, `tool_use: Bash (test runner)` sourced at the
// adapter itself -- see claudeCli.ts's isTestRunnerCommand, that file's own
// role to own).

test('classifyToolActivity: Read is reading', () => {
  assert.equal(classifyToolActivity('Read'), 'reading');
});

test('classifyToolActivity: Grep is reading', () => {
  assert.equal(classifyToolActivity('Grep'), 'reading');
});

test('classifyToolActivity: Glob is reading', () => {
  assert.equal(classifyToolActivity('Glob'), 'reading');
});

test('classifyToolActivity: Edit is writing', () => {
  assert.equal(classifyToolActivity('Edit'), 'writing');
});

test('classifyToolActivity: Write is writing', () => {
  assert.equal(classifyToolActivity('Write'), 'writing');
});

test('classifyToolActivity: Bash with an ordinary command is running', () => {
  assert.equal(classifyToolActivity('Bash', 'ls -la'), 'running');
});

test('classifyToolActivity: Bash with no command given at all is running (never assumed testing)', () => {
  assert.equal(classifyToolActivity('Bash'), 'running');
});

test('classifyToolActivity: Bash naming a test runner is testing', () => {
  assert.equal(classifyToolActivity('Bash', 'pnpm test'), 'testing');
  assert.equal(classifyToolActivity('Bash', 'pnpm run test --filter=core'), 'testing');
  assert.equal(classifyToolActivity('Bash', 'npm test'), 'testing');
  assert.equal(classifyToolActivity('Bash', 'pytest -q'), 'testing');
  assert.equal(classifyToolActivity('Bash', 'go test ./...'), 'testing');
  assert.equal(classifyToolActivity('Bash', 'cargo test'), 'testing');
  assert.equal(classifyToolActivity('Bash', 'cd packages/core && vitest run'), 'testing');
});

test('classifyToolActivity: Bash naming something that merely contains "test" as a substring is not testing', () => {
  // "attestation.sh" contains the letters "test" but names no real test
  // runner -- word-boundary matching, not a bare substring check.
  assert.equal(classifyToolActivity('Bash', './attestation.sh'), 'running');
});

test('classifyToolActivity: StructuredOutput is finishing', () => {
  assert.equal(classifyToolActivity('StructuredOutput'), 'finishing');
});

test('classifyToolActivity: no tool name (a text line) is reporting', () => {
  assert.equal(classifyToolActivity(undefined), 'reporting');
});

test('classifyToolActivity: an unrecognized tool name defaults to running rather than throwing', () => {
  assert.equal(classifyToolActivity('SomeFutureTool'), 'running');
});

test('classifyProgressMessage: parses "tool_use: <name>" the way claudeCli.ts\'s describeProgress produces it', () => {
  assert.equal(classifyProgressMessage('tool_use: Read'), 'reading');
  assert.equal(classifyProgressMessage('tool_use: Write'), 'writing');
  assert.equal(classifyProgressMessage('tool_use: StructuredOutput'), 'finishing');
});

// Batch 15 addendum 3 (ruling 14): testing is live -- claudeCli.ts's
// describeProgress now sources the "(test runner)" marker at the adapter,
// from isTestRunnerCommand, and never forwards the raw command text (see
// claudeCli.test.ts's own secret-leak test). This function reads exactly
// that marker back off the message.
test('classifyProgressMessage: "tool_use: Bash" (no marker) is running; "tool_use: Bash (test runner)" is testing', () => {
  assert.equal(classifyProgressMessage('tool_use: Bash'), 'running');
  assert.equal(classifyProgressMessage('tool_use: Bash (test runner)'), 'testing');
});

test('classifyProgressMessage: any non-tool_use message (text, assistant message, session init, ...) is reporting', () => {
  assert.equal(classifyProgressMessage('text: hello there'), 'reporting');
  assert.equal(classifyProgressMessage('assistant message'), 'reporting');
  assert.equal(classifyProgressMessage('session initialized'), 'reporting');
  assert.equal(classifyProgressMessage('tool result received'), 'reporting');
});

// Ruling 7 item 1: `GET /tickets/{id}/progress` / `activity --progress
// --ticket <id>` answer "the latest progress events per run" -- one entry
// per run the ticket has ever had, each carrying that run's own most recent
// worker_progress event (or null if it never reported one), not just the
// single most recent run's.

test('buildTicketProgress returns one entry per run, each with its own latest progress event', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });

  const run1 = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: run1.id,
    payload: { message: 'tool_use: Read', costUsd: 0.01, tool: 'Read', state: 'reading' },
    idempotencyKey: 'run1-p1',
  });
  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: run1.id,
    payload: { message: 'tool_use: Write', costUsd: 0.02, tool: 'Write', state: 'writing' },
    idempotencyKey: 'run1-p2',
  });

  const run2 = createRun(db, { ticketId: ticket.id, attempt: 2, adapter: 'fake' });
  // run2 never reported any progress at all.

  const progress = buildTicketProgress(db, ticket.id);
  assert.equal(progress.length, 2);

  assert.equal(progress[0].runId, run1.id);
  assert.equal(progress[0].latest?.state, 'writing');
  assert.equal(progress[0].latest?.tool, 'Write');
  assert.equal(progress[0].latest?.message, 'tool_use: Write');
  assert.equal(progress[0].latest?.costUsd, 0.02);

  assert.equal(progress[1].runId, run2.id);
  assert.equal(progress[1].latest, null);
});

test('buildTicketProgress returns an empty array for a ticket that has never run', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  assert.deepEqual(buildTicketProgress(db, ticket.id), []);
});

test('formatTicketProgress renders one line per run, and says so plainly when a run has no progress event yet', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });

  assert.match(formatTicketProgress(buildTicketProgress(db, ticket.id)), new RegExp(`${run.id}.*no progress reported yet`));

  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: run.id,
    payload: { message: 'tool_use: Bash', costUsd: 0, tool: 'Bash', state: 'running' },
    idempotencyKey: 'p1',
  });
  assert.match(formatTicketProgress(buildTicketProgress(db, ticket.id)), new RegExp(`${run.id}.*running.*Bash`));
});

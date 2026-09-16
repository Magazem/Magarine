import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { createArtifact, createProject, createRun, createTicket, insertEvent, pauseProjectAdapter, updateTicketFields } from '../store.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { buildBoard, formatBoard, truncateTitleForDisplay } from './board.ts';

// Moves a freshly-created ticket to IN_PROGRESS the same way tick() would
// (dependencies_resolved -> READY, run_started -> IN_PROGRESS), without
// going through the scheduler itself -- this file tests buildBoard in
// isolation from any adapter.
function moveToInProgress(db: ReturnType<typeof openDb>, ticketId: string): void {
  recordTicketTransition(db, { ticketId, event: 'dependencies_resolved', idempotencyKey: `dr:${ticketId}` });
  recordTicketTransition(db, { ticketId, event: 'run_started', idempotencyKey: `rs:${ticketId}` });
}

// Batch 9: a manager ticket must be distinguishable from a work ticket on
// the board at a glance -- the moment planning is used in anger, a board
// mixing the two indistinguishably becomes hard to read (per the
// Orchestrator's own framing for this step).

// Batch 12 item 4 (batch-12-spec.md section 1, "On the owner's cost
// correction"): the figure is labelled "equivalent API cost", not "spend",
// and carries the one sentence saying that on a subscription the real
// constraint is session limits, not dollars -- see
// docs/strategy/batch-11-closeout.md section 1 for the owner's own
// correction this wording is answering.
test('formatBoard labels the header "Equivalent API cost" and names the subscription/session-limits caveat', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const text = formatBoard(buildBoard(db, project.id));
  assert.match(text, /^Equivalent API cost: /);
  assert.match(text, /session limits/);
});

test('buildBoard carries kind for both a work ticket and a manager ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const work = createTicket(db, { projectId: project.id, title: 'Work ticket' });
  const manager = createTicket(db, { projectId: project.id, title: 'Plan: mission', kind: 'manager' });

  const board = buildBoard(db, project.id);

  assert.equal(board.tickets.find((t) => t.id === work.id)?.kind, 'work');
  assert.equal(board.tickets.find((t) => t.id === manager.id)?.kind, 'manager');
});

// Batch 12 item 3: "recorded on the ticket and shown on the board"
// (batch-12-spec.md section 1 ruling 3) -- a ticket whose model was never
// explicitly set shows no model column at all (it is silently the project
// default, nothing to explain), one that was carries the model and, when
// present, its reason right next to it.
// Batch 13 ruling 1c: "the board and the page show each ticket's artefacts
// next to its status, count and paths, so a DONE row is legible as what it
// produced." A ticket with no artefacts shows no artifacts segment at all
// (nothing to legibly show); one with artefacts shows the count and every
// artefact's own content (a resolved path for 'file', free text otherwise).
test('buildBoard/formatBoard carry each ticket\'s artefacts (count and content), and show nothing for a ticket with none', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const delivered = createTicket(db, { projectId: project.id, title: 'Delivered work' });
  const run = createRun(db, { ticketId: delivered.id, attempt: 1, adapter: 'test' });
  createArtifact(db, { ticketId: delivered.id, runId: run.id, projectId: project.id, kind: 'file', pathOrUri: '/tmp/proj/out.txt' });
  createArtifact(db, { ticketId: delivered.id, runId: run.id, projectId: project.id, kind: 'text', text: 'a note' });
  const empty = createTicket(db, { projectId: project.id, title: 'No artefacts yet' });

  const board = buildBoard(db, project.id);
  const deliveredEntry = board.tickets.find((t) => t.id === delivered.id)!;
  assert.deepEqual(deliveredEntry.artifacts, [
    { kind: 'file', content: '/tmp/proj/out.txt' },
    { kind: 'text', content: 'a note' },
  ]);
  const emptyEntry = board.tickets.find((t) => t.id === empty.id)!;
  assert.deepEqual(emptyEntry.artifacts, []);

  const text = formatBoard(board);
  const deliveredLine = text.split('\n').find((line) => line.includes(delivered.id))!;
  assert.match(deliveredLine, /artifacts \(2\): \/tmp\/proj\/out\.txt, a note/);
  const emptyLine = text.split('\n').find((line) => line.includes(empty.id))!;
  assert.doesNotMatch(emptyLine, /artifacts \(/, 'a ticket with no artefacts must show no artifacts segment');
});

test('buildBoard/formatBoard carry model and modelReason for a ticket whose model was explicitly set, and show neither for one that was not', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const withModel = createTicket(db, { projectId: project.id, title: 'Deep design work' });
  updateTicketFields(db, withModel.id, { model: 'claude-opus-5', modelReason: 'needs real design trade-offs' });
  const withoutModel = createTicket(db, { projectId: project.id, title: 'Falls back to project default' });

  const board = buildBoard(db, project.id);
  const withModelEntry = board.tickets.find((t) => t.id === withModel.id)!;
  assert.equal(withModelEntry.model, 'claude-opus-5');
  assert.equal(withModelEntry.modelReason, 'needs real design trade-offs');
  const withoutModelEntry = board.tickets.find((t) => t.id === withoutModel.id)!;
  assert.equal(withoutModelEntry.model, null);
  assert.equal(withoutModelEntry.modelReason, null);

  const text = formatBoard(board);
  const withModelLine = text.split('\n').find((line) => line.includes(withModel.id))!;
  assert.match(withModelLine, /model claude-opus-5 \(needs real design trade-offs\)/);
  const withoutModelLine = text.split('\n').find((line) => line.includes(withoutModel.id))!;
  assert.doesNotMatch(withoutModelLine, /model /, 'a ticket with no explicit model must show no model column');
});

test('formatBoard tags a manager ticket\'s row with [MANAGER], and leaves a work ticket\'s row unmarked', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  createTicket(db, { projectId: project.id, title: 'Ordinary work' });
  createTicket(db, { projectId: project.id, title: 'Plan: mission', kind: 'manager' });

  const text = formatBoard(buildBoard(db, project.id));

  assert.match(text, /\[MANAGER\]\s+Plan: mission/);
  assert.doesNotMatch(text, /\[MANAGER\]\s+Ordinary work/);
  // The bare title (no stray "[MANAGER]") must still appear for the work ticket.
  const workLine = text.split('\n').find((line) => line.includes('Ordinary work'))!;
  assert.ok(!workLine.includes('[MANAGER]'));
});

// Batch 11 rule a: a pause must be the FIRST thing a reader sees, before the
// spend header -- a ticket still reading READY while paused is not actually
// about to run, and burying the pause below the spend line (or the ticket
// rows) would let a reader miss it.
test('formatBoard leads with PAUSED: <reason> when the project is paused, naming the command that clears it, and shows nothing of the kind when it is not', () => {
  const db = openDb(':memory:');
  const paused = createProject(db, { name: 'paused-p' });
  createTicket(db, { projectId: paused.id, title: 'sits READY while paused' });
  pauseProjectAdapter(db, paused.id, 'spend_cap');

  const pausedText = formatBoard(buildBoard(db, paused.id));
  const lines = pausedText.split('\n');
  assert.match(lines[0], /^PAUSED: /, 'the pause must be the board\'s first line, not buried below spend or tickets');
  assert.match(lines[0], /magarine project set --project/, 'the pause line must name the command that clears it');
  assert.match(lines[1], /^Equivalent API cost:/, 'the spend header still follows, just not first');

  const notPaused = createProject(db, { name: 'not-paused-p' });
  const unpausedText = formatBoard(buildBoard(db, notPaused.id));
  assert.doesNotMatch(unpausedText, /^PAUSED:/m, 'an unpaused project must show no PAUSED line at all');
});

// Batch 11 item 3 (the page): a caller needs the STRUCTURED cause, not just
// the rendered sentence, to decide which fix to offer (a max-spend form vs a
// plain resume button) without parsing pauseMessage's text.
test('buildBoard exposes a structured pauseReason alongside pauseMessage, null exactly when not paused', () => {
  const db = openDb(':memory:');
  const capPaused = createProject(db, { name: 'cap-paused-p' });
  pauseProjectAdapter(db, capPaused.id, 'spend_cap');
  assert.equal(buildBoard(db, capPaused.id).pauseReason, 'spend_cap');

  const adapterPaused = createProject(db, { name: 'adapter-paused-p' });
  pauseProjectAdapter(db, adapterPaused.id, 'adapter_unavailable');
  assert.equal(buildBoard(db, adapterPaused.id).pauseReason, 'adapter_unavailable');

  const notPaused = createProject(db, { name: 'not-paused-p2' });
  assert.equal(buildBoard(db, notPaused.id).pauseReason, null);
});

// Batch 15 ruling 7: `latest_activity` on every board row for a RUNNING
// ticket, null otherwise -- read from the current run's most recent
// worker_progress event, itself carrying the tool/state scheduler.ts already
// derived once at write time (see scheduler.test.ts).
test('buildBoard reports latestActivity for an IN_PROGRESS ticket from its run\'s most recent worker_progress event', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 'reading then writing' });
  moveToInProgress(db, ticket.id);
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });

  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: run.id,
    payload: { message: 'tool_use: Read', costUsd: 0, tool: 'Read', state: 'reading' },
    idempotencyKey: 'p1',
  });
  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: run.id,
    payload: { message: 'tool_use: Write', costUsd: 0, tool: 'Write', state: 'writing' },
    idempotencyKey: 'p2',
  });

  const row = buildBoard(db, project.id).tickets.find((t) => t.id === ticket.id)!;
  assert.equal(row.latestActivity?.state, 'writing');
  assert.equal(row.latestActivity?.tool, 'Write');
  assert.equal(typeof row.latestActivity?.sequence, 'number');
  assert.equal(typeof row.latestActivity?.at, 'string');
});

test('buildBoard reports latestActivity null for an IN_PROGRESS ticket whose run has not reported any progress yet', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 'just started' });
  moveToInProgress(db, ticket.id);
  createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });

  const row = buildBoard(db, project.id).tickets.find((t) => t.id === ticket.id)!;
  assert.equal(row.latestActivity, null);
});

test('buildBoard reports latestActivity null for a ticket that is not IN_PROGRESS, even one with a past run\'s progress history', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 'open, never run' });

  const row = buildBoard(db, project.id).tickets.find((t) => t.id === ticket.id)!;
  assert.equal(row.latestActivity, null);
});

// A ticket can have a run still recorded as 'running' while its OWN status
// is not IN_PROGRESS -- e.g. right after `POST /tickets/{id}/cancel`, which
// settles the run to 'cancelled' but only synchronously; the same gap this
// test exploits deliberately (a run left 'running' by hand, on a ticket
// this suite never promotes past OPEN) proves the gate is doing real work:
// without it, a stray running-status run row on a settled/never-started
// ticket would leak an activity marker for work that, from the ticket's own
// point of view, either never started or is already over.
test('buildBoard reports latestActivity null for a ticket that has a running run but whose own status is not IN_PROGRESS', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 'status says otherwise' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: run.id,
    payload: { message: 'tool_use: Read', costUsd: 0, tool: 'Read', state: 'reading' },
    idempotencyKey: 'p1',
  });

  const row = buildBoard(db, project.id).tickets.find((t) => t.id === ticket.id)!;
  assert.equal(ticket.status, 'OPEN', 'this test is only meaningful if the ticket is genuinely not IN_PROGRESS');
  assert.equal(run.status, 'running', 'and only meaningful if a running run genuinely exists for it');
  assert.equal(row.latestActivity, null);
});

// Batch 10 owner walk finding 4: a real scope document handed in as a
// mission became a ticket title verbatim, newlines and all, breaking one
// board row across several lines. These test truncateTitleForDisplay in
// isolation, at every edge its own doc comment names.

test('truncateTitleForDisplay leaves a short single-line title completely unchanged', () => {
  assert.equal(truncateTitleForDisplay('Fix the login bug'), 'Fix the login bug');
});

test('truncateTitleForDisplay skips leading blank lines and uses the first NON-empty one', () => {
  const title = '\n\n# Scope: a tiny reference on SQLite journal modes\n\nWrite three files.';
  assert.equal(truncateTitleForDisplay(title), '# Scope: a tiny reference on SQLite journal modes…');
});

test('truncateTitleForDisplay truncates a single long line to 80 chars with an ellipsis', () => {
  const longLine = 'x'.repeat(120);
  const result = truncateTitleForDisplay(longLine);
  assert.equal(result, `${'x'.repeat(80)}…`);
});

test('truncateTitleForDisplay on a multi-line title never contains a raw newline', () => {
  const title = 'Line one\nLine two\nLine three';
  const result = truncateTitleForDisplay(title);
  assert.doesNotMatch(result, /\n/);
  assert.equal(result, 'Line one…');
});

test('truncateTitleForDisplay on an all-blank-lines title returns just the ellipsis, not a crash', () => {
  assert.equal(truncateTitleForDisplay('\n\n   \n'), '…');
});

test('formatBoard renders a multi-line manager title as one single-line row, prefixed [MANAGER]', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  createTicket(db, {
    projectId: project.id,
    title: '\n\n# Scope: a tiny reference on SQLite journal modes\n\nWrite three files and an index.',
    kind: 'manager',
  });

  const text = formatBoard(buildBoard(db, project.id));
  const rows = text.split('\n');

  assert.equal(rows.length, 2, `expected exactly one header line and one ticket row, got:\n${text}`);
  assert.match(rows[1], /^\S+\t\S+\t\[MANAGER\] # Scope: a tiny reference on SQLite journal modes…/);
});

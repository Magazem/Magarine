import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { createProject, createTicket, pauseProjectAdapter } from '../store.ts';
import { buildBoard, formatBoard, truncateTitleForDisplay } from './board.ts';

// Batch 9: a manager ticket must be distinguishable from a work ticket on
// the board at a glance -- the moment planning is used in anger, a board
// mixing the two indistinguishably becomes hard to read (per the
// Orchestrator's own framing for this step).

test('buildBoard carries kind for both a work ticket and a manager ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const work = createTicket(db, { projectId: project.id, title: 'Work ticket' });
  const manager = createTicket(db, { projectId: project.id, title: 'Plan: mission', kind: 'manager' });

  const board = buildBoard(db, project.id);

  assert.equal(board.tickets.find((t) => t.id === work.id)?.kind, 'work');
  assert.equal(board.tickets.find((t) => t.id === manager.id)?.kind, 'manager');
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
  assert.match(lines[1], /^Project spend:/, 'the spend header still follows, just not first');

  const notPaused = createProject(db, { name: 'not-paused-p' });
  const unpausedText = formatBoard(buildBoard(db, notPaused.id));
  assert.doesNotMatch(unpausedText, /^PAUSED:/m, 'an unpaused project must show no PAUSED line at all');
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

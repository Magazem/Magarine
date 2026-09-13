import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { createProject, createTicket } from '../store.ts';
import { buildBoard, formatBoard } from './board.ts';

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

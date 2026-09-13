import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { createProject } from '../store.ts';
import { deriveManagerTitle, PlanError, planMission } from './plan.ts';

test('planMission creates a manager ticket with the mission as its description, workspace NONE', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  const ticket = planMission(db, { projectId: project.id, mission: 'Write three reports and an index.' });

  assert.equal(ticket.kind, 'manager');
  assert.equal(ticket.description, 'Write three reports and an index.');
  assert.equal(ticket.workspaceType, 'NONE');
  assert.equal(ticket.status, 'OPEN');
});

test('planMission refuses a nonexistent project, and an empty/whitespace-only mission', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  assert.throws(() => planMission(db, { projectId: 'proj_ghost', mission: 'do it' }), PlanError);
  assert.throws(() => planMission(db, { projectId: project.id, mission: '   ' }), PlanError);
});

test('deriveManagerTitle keeps a short mission verbatim and truncates a long one on a word boundary', () => {
  assert.equal(deriveManagerTitle('Ship the thing.'), 'Plan: Ship the thing.');

  const longMission =
    'Write a short report on the differences between SQLite journal modes: one file per journal mode, each under three hundred words.';
  const title = deriveManagerTitle(longMission);
  assert.ok(title.startsWith('Plan: '));
  assert.ok(title.length <= 'Plan: '.length + 61, `title too long: ${title}`);
  assert.ok(!title.slice('Plan: '.length, -1).endsWith(' '), 'must not end with a trailing space before the ellipsis');
});

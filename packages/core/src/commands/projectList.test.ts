import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/index.ts';
import { createProject, createRun, createTicket, setRunUsage } from '../store.ts';
import { buildProjectList, formatProjectList } from './projectList.ts';

// Batch 10 owner walk finding 2: `project create` printed an id with no way
// back to it. `project list` is the fix; these test its two pieces
// (buildProjectList's data, formatProjectList's rendering) directly against
// a real in-memory db, the same pattern board.test.ts already uses.

test('buildProjectList returns one entry per project, with id/name/model carried through untouched', () => {
  const db = openDb(':memory:');
  createProject(db, { name: 'Alpha', defaultModel: 'claude-opus-5' });
  createProject(db, { name: 'Beta' });

  const entries = buildProjectList(db);

  assert.equal(entries.length, 2);
  const alpha = entries.find((e) => e.name === 'Alpha')!;
  assert.equal(alpha.defaultModel, 'claude-opus-5');
  assert.match(alpha.id, /^proj_/);
});

test('buildProjectList returns an empty array for a database with no projects, not an error', () => {
  const db = openDb(':memory:');
  assert.deepEqual(buildProjectList(db), []);
});

test('buildProjectList groups ticket counts by status, counting only statuses that actually occur', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'P' });
  createTicket(db, { projectId: project.id, title: 'T1' }); // OPEN by default
  createTicket(db, { projectId: project.id, title: 'T2' });

  const entries = buildProjectList(db);
  const entry = entries[0];

  assert.equal(entry.totalTickets, 2);
  assert.equal(entry.ticketCountsByStatus.OPEN, 2);
  assert.equal(entry.ticketCountsByStatus.DONE, undefined, 'a status with zero tickets must not appear at all');
});

test('buildProjectList reports project spend and its cap the same way board.ts does', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'P', maxSpendUsd: 10 });
  const ticket = createTicket(db, { projectId: project.id, title: 'T1' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  setRunUsage(db, run.id, { total_cost_usd: 1.5 });

  const entries = buildProjectList(db);
  const entry = entries[0];

  assert.equal(entry.spendUsd, 1.5);
  assert.equal(entry.spendIsEstimate, false);
  assert.equal(entry.maxSpendUsd, 10);
});

test('formatProjectList prints "(no projects yet ...)" for an empty list, not a blank line', () => {
  assert.match(formatProjectList([]), /no projects yet/);
});

test('formatProjectList prints one tab-separated line per project with id, name, model, spend/cap, and ticket counts', () => {
  const lines = formatProjectList([
    {
      id: 'proj_abc',
      name: 'Alpha',
      defaultModel: 'claude-sonnet-5',
      spendUsd: 1.5,
      spendIsEstimate: false,
      maxSpendUsd: 10,
      ticketCountsByStatus: { OPEN: 2, DONE: 1 },
      totalTickets: 3,
    },
  ]);
  assert.equal(lines, 'proj_abc\tAlpha\tmodel claude-sonnet-5\t$1.50 (cap $10.00)\tOPEN 2, DONE 1');
});

test('formatProjectList shows "no cap set" and "no tickets" for a fresh project', () => {
  const lines = formatProjectList([
    {
      id: 'proj_xyz',
      name: 'Fresh',
      defaultModel: 'claude-sonnet-5',
      spendUsd: 0,
      spendIsEstimate: false,
      maxSpendUsd: null,
      ticketCountsByStatus: {},
      totalTickets: 0,
    },
  ]);
  assert.equal(lines, 'proj_xyz\tFresh\tmodel claude-sonnet-5\t$0.00 (no cap set)\tno tickets');
});

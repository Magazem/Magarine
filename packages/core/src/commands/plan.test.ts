import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from '../db/index.ts';
import { createProject, getTicket, listEventsForProject } from '../store.ts';
import { testTempRoot } from '../testSupport.ts';
import { truncateTitleForDisplay } from './board.ts';
import { PlanError, planWithMission } from './plan.ts';

const testRoot = testTempRoot('plan-with-mission');
after(testRoot.cleanup);

test('planWithMission with no mission plans from the current scope/board unchanged (planProject, title untouched)', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'no-mission', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });

  const ticket = planWithMission(db, project.id, {});

  assert.equal(ticket.kind, 'manager');
  assert.equal(ticket.workspaceType, 'NONE');
  assert.equal(ticket.status, 'OPEN');
  assert.equal(ticket.title, 'Manager: plan', 'no mission was seeded, so planProject\'s own title stands');
});

test('planWithMission refuses a nonexistent project regardless of mission', () => {
  const db = openDb(':memory:');
  assert.throws(() => planWithMission(db, 'proj_ghost', { mission: 'do it' }), PlanError);
  assert.throws(() => planWithMission(db, 'proj_ghost', {}), PlanError);
});

test('planWithMission seeds an empty scope file whole from --mission, records scope_updated, plans, and titles the ticket from the scope\'s first line', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'seed-empty', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  assert.equal(existsSync(scopePath), false, 'sanity: nothing written yet');

  const mission = 'Ship the reporting dashboard.';
  const ticket = planWithMission(db, project.id, { mission });

  assert.equal(readFileSync(scopePath, 'utf8'), mission, 'the scope file must hold the mission text whole, verbatim');
  assert.equal(ticket.kind, 'manager');
  assert.equal(ticket.title, truncateTitleForDisplay(mission));

  const events = listEventsForProject(db, project.id).filter((e) => e.eventType === 'scope_updated');
  assert.equal(events.length, 1, 'exactly one scope_updated event must be recorded for the seed');
  assert.deepEqual(events[0].payload, { summary: 'seeded from --mission' });
});

test('planWithMission seeds a scope file whose file exists but is blank (whitespace-only), same as fully absent', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'seed-blank', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  // Pre-create the file but leave it blank -- ensureScopeFile (manager.ts)
  // does exactly this on a fresh project the moment anything invokes the
  // Manager, so a real "empty file already exists" case must seed too, not
  // just a fully absent one.
  mkdirSync(dirname(scopePath), { recursive: true });
  writeFileSync(scopePath, '   \n', 'utf8');

  const mission = 'Ship it.';
  planWithMission(db, project.id, { mission });

  assert.equal(readFileSync(scopePath, 'utf8'), mission);
});

test('planWithMission refuses a mission against a project whose scope already has content, and creates no ticket', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'refuse', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  planWithMission(db, project.id, { mission: 'First version of the scope.' });

  assert.throws(
    () => planWithMission(db, project.id, { mission: 'A completely different mission.' }),
    PlanError
  );
  assert.throws(
    () => planWithMission(db, project.id, { mission: 'A completely different mission.' }),
    /already has a scope/i
  );
  assert.throws(
    () => planWithMission(db, project.id, { mission: 'A completely different mission.' }),
    /discuss/i
  );

  assert.equal(
    readFileSync(scopePath, 'utf8'),
    'First version of the scope.',
    'a refused seed must never touch the existing scope text'
  );
});

test('planWithMission refuses a mission against a project with no scope_path configured at all', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.equal(project.scopePath, null);

  assert.throws(() => planWithMission(db, project.id, { mission: 'Ship it.' }), PlanError);
  assert.throws(() => planWithMission(db, project.id, { mission: 'Ship it.' }), /no scope file configured/i);
});

test('planWithMission with a mission but no live event of its own still lets a following no-mission plan re-plan from the seeded scope', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'seed-then-replan', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });

  const first = planWithMission(db, project.id, { mission: 'Ship the reporting dashboard.' });
  const second = planWithMission(db, project.id, {});

  assert.notEqual(first.id, second.id);
  assert.equal(getTicket(db, second.id)?.title, 'Manager: plan');
});

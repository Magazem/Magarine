import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import {
  discussProject,
  ensureScopeFile,
  isManagerDailyCapReached,
  ManagerError,
  planProject,
  readScopeText,
  writeScopeText,
} from './manager.ts';
import { createProject, createTicket, createRun, getProject, getTicket, listEventsForProject, setProjectScopePath } from './store.ts';
import { testTempRoot } from './testSupport.ts';

const testRoot = testTempRoot('manager');
after(testRoot.cleanup);

test('readScopeText returns empty text for a project with no scope_path set, without touching the filesystem', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.equal(readScopeText(project).text, '');
});

test('readScopeText returns empty text when scope_path is set but the file does not exist yet, rather than throwing', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', scopePath: join(testRoot.root, 'never-written', 'SCOPE.md') });
  assert.equal(readScopeText(project).text, '');
});

test('writeScopeText writes the whole file, creating its parent directory, and readScopeText reads it straight back', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'write-test', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });

  writeScopeText(project, 'First draft of the scope.');
  assert.equal(readFileSync(scopePath, 'utf8'), 'First draft of the scope.');
  assert.equal(readScopeText(project).text, 'First draft of the scope.');

  // Whole-file replacement, not an append/patch.
  writeScopeText(project, 'Replaced entirely.');
  assert.equal(readScopeText(project).text, 'Replaced entirely.');
});

test('writeScopeText refuses to write when the project has no scope_path set', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.throws(() => writeScopeText(project, 'x'), ManagerError);
});

test('ensureScopeFile creates an empty file when scope_path is set but absent, and is a no-op once it exists', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'ensure-test', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });

  assert.equal(existsSync(scopePath), false);
  ensureScopeFile(project);
  assert.equal(existsSync(scopePath), true);
  assert.equal(readFileSync(scopePath, 'utf8'), '');

  writeScopeText(project, 'owner wrote something');
  ensureScopeFile(project); // must not clobber existing content
  assert.equal(readScopeText(project).text, 'owner wrote something');
});

test('ensureScopeFile is a no-op when the project has no scope_path set', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.doesNotThrow(() => ensureScopeFile(project));
});

test('planProject creates a manager ticket, on a fresh, empty scope file if scope_path is set', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'plan-test', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });

  const ticketId = planProject(db, project.id);
  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.kind, 'manager');
  assert.equal(ticket.workspaceType, 'NONE');
  assert.equal(ticket.status, 'OPEN');
  assert.equal(existsSync(scopePath), true, 'planProject must ensure the scope file exists');
});

test('planProject throws ManagerError for a project that does not exist', () => {
  const db = openDb(':memory:');
  assert.throws(() => planProject(db, 'proj_does_not_exist'), ManagerError);
});

test('planProject applies budgetUsd as the created ticket\'s max_budget_usd_override', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticketId = planProject(db, project.id, { budgetUsd: 1.5 });
  assert.equal(getTicket(db, ticketId)!.maxBudgetUsdOverride, 1.5);
});

test('discussProject records a discuss event carrying the owner\'s message, then creates a manager ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  const ticketId = discussProject(db, project.id, 'Please drop the export feature.');

  const events = listEventsForProject(db, project.id).filter((e) => e.eventType === 'discuss');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { message: 'Please drop the export feature.' });
  assert.equal(events[0].entityType, 'project');
  assert.equal(events[0].entityId, project.id);

  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.kind, 'manager');
  assert.equal(ticket.description, 'Please drop the export feature.');
});

test('discussProject rejects an empty or whitespace-only message without recording anything', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  assert.throws(() => discussProject(db, project.id, '   '), ManagerError);
  assert.equal(listEventsForProject(db, project.id).length, 0);
});

test('discussProject throws ManagerError for a project that does not exist', () => {
  const db = openDb(':memory:');
  assert.throws(() => discussProject(db, 'proj_does_not_exist', 'hello'), ManagerError);
});

// --- isManagerDailyCapReached ---

function makeManagerRun(db: ReturnType<typeof openDb>, projectId: string, startedAt: string): void {
  const ticket = createTicket(db, { projectId, title: 'Manager: plan', kind: 'manager', workspaceType: 'NONE' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(startedAt, run.id);
}

test('isManagerDailyCapReached is false below the cap and true at/over it, counting only runs within the last 24 hours', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const now = new Date('2026-09-14T12:00:00.000Z');

  for (let i = 0; i < 3; i++) {
    makeManagerRun(db, project.id, new Date(now.getTime() - 60_000).toISOString());
  }
  // Outside the 24h window -- must not count.
  makeManagerRun(db, project.id, new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString());

  assert.equal(isManagerDailyCapReached(db, project.id, now, 3), true, 'exactly at the cap must count as reached');
  assert.equal(isManagerDailyCapReached(db, project.id, now, 4), false, 'below the cap must not be reached');
});

test('isManagerDailyCapReached scopes the count to the given project only', () => {
  const db = openDb(':memory:');
  const projectA = createProject(db, { name: 'a' });
  const projectB = createProject(db, { name: 'b' });
  const now = new Date();

  for (let i = 0; i < 5; i++) makeManagerRun(db, projectA.id, now.toISOString());

  assert.equal(isManagerDailyCapReached(db, projectB.id, now, 1), false, 'another project\'s invocations must not count');
});

// Ruling 29 (batch 16 addendum 5): readScopeText tells a document that is
// absent from one that is present-and-empty, and NEVER turns an error into an
// empty string -- an unreadable scope used to read as empty and the Manager
// interviewed the owner about a document they had already written.
test('readScopeText reports status: absent for no scope_path and for ENOENT, present for a real file (even an empty one)', () => {
  const db = openDb(':memory:');
  assert.deepEqual(readScopeText(createProject(db, { name: 'no-path' })), { text: '', status: 'absent' });
  const missing = createProject(db, { name: 'missing', scopePath: join(testRoot.root, 'ruling29', 'nope', 'SCOPE.md') });
  assert.deepEqual(readScopeText(missing), { text: '', status: 'absent' });
  mkdirSync(join(testRoot.root, 'ruling29'), { recursive: true });
  const emptyPath = join(testRoot.root, 'ruling29', 'EMPTY.md');
  writeFileSync(emptyPath, '');
  assert.deepEqual(readScopeText(createProject(db, { name: 'empty', scopePath: emptyPath })), { text: '', status: 'present' });
});

test('readScopeText THROWS on any error that is not ENOENT (a directory at the scope path), never returning an empty string', () => {
  const db = openDb(':memory:');
  const dirAtPath = join(testRoot.root, 'ruling29-dir', 'SCOPE.md');
  mkdirSync(dirAtPath, { recursive: true });
  const project = createProject(db, { name: 'dir-at-path', scopePath: dirAtPath });
  assert.throws(() => readScopeText(project), (err: NodeJS.ErrnoException) => err.code === 'EISDIR');
});

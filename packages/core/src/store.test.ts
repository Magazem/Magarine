import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import {
  createArtifact,
  createProject,
  createTicket,
  findConflictingArtifact,
  getProject,
  isProjectAdapterPaused,
  listArtifactsForTicket,
  pauseProjectAdapter,
  resolveMaxBudgetUsd,
  resumeProjectAdapter,
} from './store.ts';

test('createProject defaults maxBudgetUsd, brief and workspaceRoot, and accepts overrides', () => {
  const db = openDb(':memory:');
  const withDefaults = createProject(db, { name: 'p1' });
  assert.equal(withDefaults.maxBudgetUsd, 2.0);
  assert.equal(withDefaults.brief, null);
  assert.equal(withDefaults.workspaceRoot, null);
  assert.equal(withDefaults.adapterPausedAt, null);

  const withOverrides = createProject(db, {
    name: 'p2',
    maxBudgetUsd: 5,
    brief: 'Build the thing.',
    workspaceRoot: '/tmp/proj-root',
  });
  assert.equal(withOverrides.maxBudgetUsd, 5);
  assert.equal(withOverrides.brief, 'Build the thing.');
  assert.equal(withOverrides.workspaceRoot, '/tmp/proj-root');
});

test('createTicket defaults maxBudgetUsdOverride to null and accepts an override', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(ticket.maxBudgetUsdOverride, null);

  const overridden = createTicket(db, { projectId: project.id, title: 't2', maxBudgetUsdOverride: 7.5 });
  assert.equal(overridden.maxBudgetUsdOverride, 7.5);
});

test('resolveMaxBudgetUsd falls back to the project default when no ticket override is set', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxBudgetUsd: 3 });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(resolveMaxBudgetUsd(project, ticket), 3);
});

test('resolveMaxBudgetUsd prefers the ticket override over the project default', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxBudgetUsd: 3 });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxBudgetUsdOverride: 9 });
  assert.equal(resolveMaxBudgetUsd(project, ticket), 9);
});

test('a project adapter starts unpaused, can be paused, and can be resumed', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.equal(isProjectAdapterPaused(db, project.id), false);

  pauseProjectAdapter(db, project.id);
  assert.equal(isProjectAdapterPaused(db, project.id), true);
  assert.notEqual(getProject(db, project.id)!.adapterPausedAt, null);

  resumeProjectAdapter(db, project.id);
  assert.equal(isProjectAdapterPaused(db, project.id), false);
  assert.equal(getProject(db, project.id)!.adapterPausedAt, null);
});

test('createArtifact persists kind, path, checksum and the declaring run/ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });

  const artifact = createArtifact(db, {
    ticketId: ticket.id,
    runId: 'run_1',
    projectId: project.id,
    kind: 'file',
    pathOrUri: '/tmp/proj-root/out.txt',
    checksum: 'deadbeef',
  });

  assert.equal(artifact.ticketId, ticket.id);
  assert.equal(artifact.runId, 'run_1');
  assert.equal(artifact.kind, 'file');
  assert.equal(artifact.pathOrUri, '/tmp/proj-root/out.txt');
  assert.equal(artifact.checksum, 'deadbeef');

  const listed = listArtifactsForTicket(db, ticket.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, artifact.id);
});

test('findConflictingArtifact finds another ticket declaring the same path in the same project, and ignores the declaring ticket itself', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticketA = createTicket(db, { projectId: project.id, title: 'A' });
  const ticketB = createTicket(db, { projectId: project.id, title: 'B' });

  createArtifact(db, {
    ticketId: ticketA.id,
    runId: 'run_a',
    projectId: project.id,
    kind: 'file',
    pathOrUri: '/tmp/proj-root/shared.txt',
  });

  const noConflictYet = findConflictingArtifact(db, project.id, '/tmp/proj-root/shared.txt', ticketA.id);
  assert.equal(noConflictYet, undefined, 'ticket A declaring its own path again is not a conflict with itself');

  const conflict = findConflictingArtifact(db, project.id, '/tmp/proj-root/shared.txt', ticketB.id);
  assert.ok(conflict, 'ticket B declaring the same path ticket A already declared is a conflict');
  assert.equal(conflict!.ticketId, ticketA.id);
});

test('findConflictingArtifact returns undefined for a path nobody has declared', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(findConflictingArtifact(db, project.id, '/tmp/nope.txt', ticket.id), undefined);
});

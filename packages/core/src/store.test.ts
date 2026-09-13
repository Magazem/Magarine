import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import {
  addDependency,
  createArtifact,
  createProject,
  createRun,
  createTicket,
  findConflictingArtifact,
  finishRun,
  getProject,
  getRun,
  getTicket,
  isProjectAdapterPaused,
  listArtifactsForTicket,
  MIN_BUDGET_USD,
  listEventsForProject,
  pauseProjectAdapter,
  projectSpendUsd,
  resolveManagerModel,
  resolveMaxBudgetUsd,
  resumeProject,
  resumeProjectAdapter,
  setProjectManagerModel,
  setProjectMaxBudgetUsd,
  setProjectMaxSpendUsd,
  setRunUsage,
  setTicketBudgetOverride,
  ticketSpendUsd,
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

// Batch 9: 'work' is the default -- every ticket before this batch was one,
// so a bare createTicket() (no kind given) must not silently start
// producing manager tickets.
test('createTicket defaults kind to \'work\' and accepts \'manager\'', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const workTicket = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(workTicket.kind, 'work');

  const managerTicket = createTicket(db, { projectId: project.id, title: 'plan: do the thing', kind: 'manager' });
  assert.equal(managerTicket.kind, 'manager');
});

test('createProject defaults managerModel to null and accepts an override', () => {
  const db = openDb(':memory:');
  const withDefault = createProject(db, { name: 'p1' });
  assert.equal(withDefault.managerModel, null);

  const withOverride = createProject(db, { name: 'p2', managerModel: 'claude-fable-5-1' });
  assert.equal(withOverride.managerModel, 'claude-fable-5-1');
});

test('resolveManagerModel falls back to the project\'s defaultModel when no managerModel override is set', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', defaultModel: 'claude-sonnet-5' });
  assert.equal(resolveManagerModel(project), 'claude-sonnet-5');
});

test('resolveManagerModel prefers managerModel over defaultModel when set', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', defaultModel: 'claude-sonnet-5', managerModel: 'claude-fable-5-1' });
  assert.equal(resolveManagerModel(project), 'claude-fable-5-1');
});

test('addDependency refuses a "blocks" edge between a manager ticket and a work ticket, in both directions, but allows work-to-work and manager-to-manager', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const work = createTicket(db, { projectId: project.id, title: 'work' });
  const manager = createTicket(db, { projectId: project.id, title: 'mgr', kind: 'manager' });

  assert.throws(() => addDependency(db, { ticketId: work.id, dependsOnTicketId: manager.id }), /manager ticket and a work ticket/);
  assert.throws(() => addDependency(db, { ticketId: manager.id, dependsOnTicketId: work.id }), /manager ticket and a work ticket/);

  const work2 = createTicket(db, { projectId: project.id, title: 'work2' });
  assert.doesNotThrow(() => addDependency(db, { ticketId: work2.id, dependsOnTicketId: work.id }));

  const manager2 = createTicket(db, { projectId: project.id, title: 'mgr2', kind: 'manager' });
  assert.doesNotThrow(() => addDependency(db, { ticketId: manager2.id, dependsOnTicketId: manager.id }));
});

test('setProjectManagerModel sets and clears (null) the override', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  setProjectManagerModel(db, project.id, 'claude-fable-5-1');
  assert.equal(getProject(db, project.id)!.managerModel, 'claude-fable-5-1');

  setProjectManagerModel(db, project.id, null);
  assert.equal(getProject(db, project.id)!.managerModel, null);
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

// --- Batch 4: the minimum ceiling floor ---

test('createProject rejects a max_budget_usd below the floor, naming the floor', () => {
  const db = openDb(':memory:');
  assert.throws(() => {
    createProject(db, { name: 'p', maxBudgetUsd: 0.1 });
  }, new RegExp(`\\$${MIN_BUDGET_USD.toFixed(2)}`));
});

test('createProject rejects a max_spend_usd below the floor', () => {
  const db = openDb(':memory:');
  assert.throws(() => {
    createProject(db, { name: 'p', maxSpendUsd: 0.01 });
  }, new RegExp(`\\$${MIN_BUDGET_USD.toFixed(2)}`));
});

test('createProject accepts a max_budget_usd exactly at the floor', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxBudgetUsd: MIN_BUDGET_USD });
  assert.equal(project.maxBudgetUsd, MIN_BUDGET_USD);
});

test('createTicket rejects a maxBudgetUsdOverride below the floor', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.throws(() => {
    createTicket(db, { projectId: project.id, title: 't', maxBudgetUsdOverride: 0.1 });
  }, new RegExp(`\\$${MIN_BUDGET_USD.toFixed(2)}`));
});

test('setProjectMaxBudgetUsd persists a value above the floor and rejects one below it', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  setProjectMaxBudgetUsd(db, project.id, 5);
  assert.equal(getProject(db, project.id)!.maxBudgetUsd, 5);

  assert.throws(() => setProjectMaxBudgetUsd(db, project.id, 0.1), new RegExp(`\\$${MIN_BUDGET_USD.toFixed(2)}`));
});

test('setProjectMaxSpendUsd sets, clears (null), and enforces the floor when non-null', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.equal(getProject(db, project.id)!.maxSpendUsd, null);

  setProjectMaxSpendUsd(db, project.id, 10);
  assert.equal(getProject(db, project.id)!.maxSpendUsd, 10);

  setProjectMaxSpendUsd(db, project.id, null);
  assert.equal(getProject(db, project.id)!.maxSpendUsd, null);

  assert.throws(() => setProjectMaxSpendUsd(db, project.id, 0.01), new RegExp(`\\$${MIN_BUDGET_USD.toFixed(2)}`));
});

test('setTicketBudgetOverride sets, clears (null), and enforces the floor when non-null', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });

  setTicketBudgetOverride(db, ticket.id, 3);
  assert.equal(getTicket(db, ticket.id)!.maxBudgetUsdOverride, 3);

  setTicketBudgetOverride(db, ticket.id, null);
  assert.equal(getTicket(db, ticket.id)!.maxBudgetUsdOverride, null);

  assert.throws(() => setTicketBudgetOverride(db, ticket.id, 0.1), new RegExp(`\\$${MIN_BUDGET_USD.toFixed(2)}`));
});

test('resumeProject clears the pause (whatever its cause) and records a project_resume event', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  pauseProjectAdapter(db, project.id);
  assert.equal(isProjectAdapterPaused(db, project.id), true);

  resumeProject(db, project.id);

  assert.equal(isProjectAdapterPaused(db, project.id), false);
  const events = listEventsForProject(db, project.id);
  const resumeEvent = events.find((e) => e.eventType === 'project_resume');
  assert.ok(resumeEvent, 'must record a project_resume event');
  assert.equal(resumeEvent!.entityType, 'project');
});

// --- Batch 4: ticket/project spend sums ---

test('ticketSpendUsd sums total_cost_usd across a ticket\'s runs, ignoring runs with no or malformed usage', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });

  const run1 = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  setRunUsage(db, run1.id, { total_cost_usd: 0.3 });
  finishRun(db, run1.id, { status: 'failed' });

  const run2 = createRun(db, { ticketId: ticket.id, attempt: 2, adapter: 'fake' });
  setRunUsage(db, run2.id, { total_cost_usd: 0.2 });
  finishRun(db, run2.id, { status: 'succeeded' });

  const run3 = createRun(db, { ticketId: ticket.id, attempt: 3, adapter: 'fake' });
  // No usage recorded at all -- contributes nothing.

  assert.equal(ticketSpendUsd(db, ticket.id), 0.5);
  assert.ok(run3.id, 'run3 exists purely to prove it contributes nothing');
});

test('projectSpendUsd sums ticketSpendUsd across every ticket in the project', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const a = createTicket(db, { projectId: project.id, title: 'a' });
  const b = createTicket(db, { projectId: project.id, title: 'b' });

  const runA = createRun(db, { ticketId: a.id, attempt: 1, adapter: 'fake' });
  setRunUsage(db, runA.id, { total_cost_usd: 0.4 });
  const runB = createRun(db, { ticketId: b.id, attempt: 1, adapter: 'fake' });
  setRunUsage(db, runB.id, { total_cost_usd: 0.15 });

  assert.equal(projectSpendUsd(db, project.id), 0.55);
});

// --- Batch 5: the store guard from section 1 ruling 1 ---

test('finishRun only updates a run that is still "running", and reports whether it applied', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });

  assert.equal(finishRun(db, run.id, { status: 'succeeded' }), true, 'the first call, against a running row, applies');
  assert.equal(getRun(db, run.id)!.status, 'succeeded');

  const secondApplied = finishRun(db, run.id, { status: 'failed', failureClass: 'late' });
  assert.equal(secondApplied, false, 'a second call, against a no-longer-running row, must be a no-op');

  const after = getRun(db, run.id)!;
  assert.equal(after.status, 'succeeded', 'the first outcome is never overwritten');
  assert.equal(after.failureClass, null);
});

test('finishRun refuses to touch a run that was never "running" in the first place', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake' });
  finishRun(db, run.id, { status: 'cancelled', failureClass: 'run_timeout' });

  assert.equal(finishRun(db, run.id, { status: 'failed', failureClass: 'adapter_failure' }), false);
  assert.equal(getRun(db, run.id)!.status, 'cancelled');
  assert.equal(getRun(db, run.id)!.failureClass, 'run_timeout');
});

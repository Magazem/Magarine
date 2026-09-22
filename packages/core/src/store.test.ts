import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import {
  addDependency,
  assertAssignableProfile,
  createArtifact,
  createProject,
  createRun,
  createTicket,
  createWorkerProfile,
  findConflictingArtifact,
  finishRun,
  getProject,
  getRun,
  getSetting,
  getSettings,
  getTicket,
  getWorkerProfile,
  getWorkerProfileByName,
  isProjectAdapterPaused,
  listArtifactsForTicket,
  listWorkerProfiles,
  MIN_BUDGET_USD,
  insertEvent,
  listEventsForProject,
  listEventsSince,
  listRunsForTicket,
  NoSuchWorkerProfileError,
  pauseProjectAdapter,
  projectSpendUsd,
  resolveManagerModel,
  resolveMachineCap,
  resolveMaxBudgetUsd,
  resolveModel,
  resolveWorkerProfileRef,
  resolveWorkerProfileRefForAdmin,
  retireWorkerProfile,
  resolveVerifierModel,
  resumeProject,
  resumeProjectAdapter,
  setProjectDir,
  setProjectManagerModel,
  setProjectMaxBudgetUsd,
  setProjectMaxParallelWorkers,
  setProjectMaxSpendUsd,
  setProjectScopePath,
  setProjectVerifierModel,
  setRunUsage,
  setSetting,
  setTicketBudgetOverride,
  ticketSpendUsd,
  unsetSetting,
  updateTicketFields,
  updateWorkerProfile,
  workerProfileStatus,
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
// Batch 13 ruling 1a: "agents do not decide where work lives" -- a ticket
// with no explicit workspaceType now defaults to DIRECTORY, the project's
// one shared folder, not NONE's throwaway temp directory (the choice that
// let Run B's four file-writing tickets silently discard their work). NONE
// is still reachable, just never by omission.
test('createTicket defaults workspaceType to DIRECTORY, and NONE remains available when explicitly requested', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const defaulted = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(defaulted.workspaceType, 'DIRECTORY');

  const explicitNone = createTicket(db, { projectId: project.id, title: 't2', workspaceType: 'NONE' });
  assert.equal(explicitNone.workspaceType, 'NONE');
});

test('createTicket defaults kind to \'work\' and accepts \'manager\'', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const workTicket = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(workTicket.kind, 'work');

  const managerTicket = createTicket(db, { projectId: project.id, title: 'plan: do the thing', kind: 'manager' });
  assert.equal(managerTicket.kind, 'manager');
});

// --- Batch 15 item 4: expected_artifacts, set at create_ticket/update_ticket time ---

test('createTicket defaults expectedArtifacts to null and accepts a real list, round-tripped through getTicket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  const noList = createTicket(db, { projectId: project.id, title: 'no list' });
  assert.equal(noList.expectedArtifacts, null);

  const list = [{ kind: 'file', path: 'out.txt' }, { kind: 'text' }];
  const withList = createTicket(db, { projectId: project.id, title: 'with list', expectedArtifacts: list });
  assert.deepEqual(withList.expectedArtifacts, list);
  assert.deepEqual(getTicket(db, withList.id)!.expectedArtifacts, list);
});

test('updateTicketFields sets expectedArtifacts on an existing ticket that had none, and clears it back to null', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  assert.equal(ticket.expectedArtifacts, null);

  const list = [{ kind: 'file', path: 'result.json' }];
  updateTicketFields(db, ticket.id, { expectedArtifacts: list });
  assert.deepEqual(getTicket(db, ticket.id)!.expectedArtifacts, list);

  updateTicketFields(db, ticket.id, { expectedArtifacts: null });
  assert.equal(getTicket(db, ticket.id)!.expectedArtifacts, null);
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
  assert.equal(resolveManagerModel(db, project), 'claude-sonnet-5');
});

test('resolveManagerModel prefers managerModel over defaultModel when set', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', defaultModel: 'claude-sonnet-5', managerModel: 'claude-fable-5-1' });
  assert.equal(resolveManagerModel(db, project), 'claude-fable-5-1');
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

test('createProject defaults scopePath to null and accepts an explicit path', () => {
  const db = openDb(':memory:');
  const withDefault = createProject(db, { name: 'p' });
  assert.equal(withDefault.scopePath, null);

  const withScope = createProject(db, { name: 'p2', scopePath: '/tmp/p2/SCOPE.md' });
  assert.equal(withScope.scopePath, '/tmp/p2/SCOPE.md');
});

test('setProjectScopePath sets and clears (null) the path', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  setProjectScopePath(db, project.id, '/tmp/p/SCOPE.md');
  assert.equal(getProject(db, project.id)!.scopePath, '/tmp/p/SCOPE.md');

  setProjectScopePath(db, project.id, null);
  assert.equal(getProject(db, project.id)!.scopePath, null);
});

// Batch 12 section 1 ruling 1: `setProjectDir` is the single site that moves
// a project's one directory, so workspace_root and scope_path can never
// disagree the way batch 12 was opened to fix -- it must set both columns,
// derived from the same value, in one call.
test('setProjectDir sets workspace_root and scope_path together from one directory, and moving it again replaces both atomically', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', workspaceRoot: '/tmp/original', scopePath: '/tmp/original/SCOPE.md' });

  setProjectDir(db, project.id, '/tmp/moved');
  const moved = getProject(db, project.id)!;
  assert.equal(moved.workspaceRoot, '/tmp/moved');
  assert.equal(moved.scopePath, join('/tmp/moved', 'SCOPE.md'));

  setProjectDir(db, project.id, '/tmp/moved-again');
  const movedAgain = getProject(db, project.id)!;
  assert.equal(movedAgain.workspaceRoot, '/tmp/moved-again');
  assert.equal(movedAgain.scopePath, join('/tmp/moved-again', 'SCOPE.md'));
});

test('updateTicketFields updates only the fields provided, and never touches status', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, {
    projectId: project.id,
    title: 'Original title',
    description: 'Original description',
    acceptanceCriteria: ['original criterion'],
  });

  updateTicketFields(db, ticket.id, { title: 'New title' });
  const afterTitle = getTicket(db, ticket.id)!;
  assert.equal(afterTitle.title, 'New title');
  assert.equal(afterTitle.description, 'Original description', 'untouched fields must not change');
  assert.equal(afterTitle.status, 'OPEN', 'update_ticket must never touch status');

  updateTicketFields(db, ticket.id, {
    description: 'New description',
    acceptanceCriteria: ['a', 'b'],
    maxBudgetUsdOverride: 1.0,
    model: 'claude-fable-5-1',
  });
  const after = getTicket(db, ticket.id)!;
  assert.equal(after.title, 'New title', 'a later partial update must not revert an earlier field');
  assert.equal(after.description, 'New description');
  assert.deepEqual(after.acceptanceCriteria, ['a', 'b']);
  assert.equal(after.maxBudgetUsdOverride, 1.0);
  assert.equal(after.model, 'claude-fable-5-1');
  assert.equal(after.status, 'OPEN');
});

test('updateTicketFields rejects a maxBudgetUsdOverride below the floor', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 'T' });
  assert.throws(() => updateTicketFields(db, ticket.id, { maxBudgetUsdOverride: 0.01 }), /at least/);
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
  assert.equal(getProject(db, project.id)!.pauseReason, null);

  pauseProjectAdapter(db, project.id, 'adapter_unavailable');
  assert.equal(isProjectAdapterPaused(db, project.id), true);
  assert.notEqual(getProject(db, project.id)!.adapterPausedAt, null);
  assert.equal(getProject(db, project.id)!.pauseReason, 'adapter_unavailable');

  resumeProjectAdapter(db, project.id);
  assert.equal(isProjectAdapterPaused(db, project.id), false);
  assert.equal(getProject(db, project.id)!.adapterPausedAt, null);
  assert.equal(getProject(db, project.id)!.pauseReason, null);
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

test('setProjectMaxSpendUsd raising the cap clears a spend_cap pause by itself and reports it, but leaves an adapter_unavailable pause alone', () => {
  const db = openDb(':memory:');
  const capped = createProject(db, { name: 'capped' });
  pauseProjectAdapter(db, capped.id, 'spend_cap');
  assert.equal(setProjectMaxSpendUsd(db, capped.id, 5).unpaused, true, 'raising the cap must clear a spend_cap pause');
  assert.equal(isProjectAdapterPaused(db, capped.id), false);
  assert.equal(getProject(db, capped.id)!.pauseReason, null);

  const loggedOut = createProject(db, { name: 'logged-out' });
  pauseProjectAdapter(db, loggedOut.id, 'adapter_unavailable');
  assert.equal(setProjectMaxSpendUsd(db, loggedOut.id, 5).unpaused, false, 'an adapter pause needs a login, not a bigger cap');
  assert.equal(isProjectAdapterPaused(db, loggedOut.id), true);
  assert.equal(getProject(db, loggedOut.id)!.pauseReason, 'adapter_unavailable');

  const notPaused = createProject(db, { name: 'not-paused' });
  assert.equal(setProjectMaxSpendUsd(db, notPaused.id, 5).unpaused, false);
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
  pauseProjectAdapter(db, project.id, 'spend_cap');
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

// --- Batch 15, ruling 7: the read path needs every run of a ticket, not
// just the ones a status-scoped query already covers, to find "the latest
// progress event per run".

test('listRunsForTicket returns every run for a ticket, oldest attempt first, and none for an unrelated ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const a = createTicket(db, { projectId: project.id, title: 'a' });
  const b = createTicket(db, { projectId: project.id, title: 'b' });

  const run1 = createRun(db, { ticketId: a.id, attempt: 1, adapter: 'fake' });
  finishRun(db, run1.id, { status: 'failed' });
  const run2 = createRun(db, { ticketId: a.id, attempt: 2, adapter: 'fake' });
  createRun(db, { ticketId: b.id, attempt: 1, adapter: 'fake' });

  const runs = listRunsForTicket(db, a.id);
  assert.deepEqual(runs.map((r) => r.id), [run1.id, run2.id]);
  assert.equal(listRunsForTicket(db, 'tkt_nonexistent').length, 0);
});

// --- Batch 15 ruling 7 item 2: the streamed event route reads forward from
// a sequence cursor, across every project (the events table's own sequence
// is a single global autoincrement, not scoped per project).

test('listEventsSince returns every event with sequence strictly greater than the given cursor, ascending, across every project', () => {
  const db = openDb(':memory:');
  const p1 = createProject(db, { name: 'p1' });
  const p2 = createProject(db, { name: 'p2' });

  const e1 = insertEvent(db, { projectId: p1.id, eventType: 'a', entityType: 'ticket', entityId: 't1', idempotencyKey: 'k1' });
  const e2 = insertEvent(db, { projectId: p2.id, eventType: 'b', entityType: 'ticket', entityId: 't2', idempotencyKey: 'k2' });
  const e3 = insertEvent(db, { projectId: p1.id, eventType: 'c', entityType: 'ticket', entityId: 't1', idempotencyKey: 'k3' });

  assert.deepEqual(listEventsSince(db, 0).map((e) => e.sequence), [e1.sequence, e2.sequence, e3.sequence]);
  assert.deepEqual(listEventsSince(db, e1.sequence!).map((e) => e.sequence), [e2.sequence, e3.sequence]);
  assert.deepEqual(listEventsSince(db, e3.sequence!), []);
});

// Ruling 23 (batch 15 addendum 10): one validator, shared by createProject
// and setProjectMaxParallelWorkers, so `project create` and `project set`
// (and the daemon's POST /projects/{id}/set) refuse a bad cap with the SAME
// message. Before this ruling nothing validated it at all.
test('setProjectMaxParallelWorkers persists the cap, and a project created with one keeps it', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.equal(project.maxParallelWorkers, null, 'batch 16: a project created without a cap has none of its own');
  setProjectMaxParallelWorkers(db, project.id, 4);
  assert.equal(getProject(db, project.id)!.maxParallelWorkers, 4);
  assert.equal(createProject(db, { name: 'q', maxParallelWorkers: 3 }).maxParallelWorkers, 3);
  setProjectMaxParallelWorkers(db, project.id, null);
  assert.equal(getProject(db, project.id)!.maxParallelWorkers, null, 'null clears the cap back to: the daemon ceiling alone governs');
  assert.equal(createProject(db, { name: 'r', maxParallelWorkers: null }).maxParallelWorkers, null);
});

test('a max-parallel cap that is not a whole number of 1 or more is refused by BOTH createProject and setProjectMaxParallelWorkers, with the same message', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    let createMessage = '';
    let setMessage = '';
    try {
      createProject(db, { name: 'bad', maxParallelWorkers: bad });
    } catch (err) {
      createMessage = (err as Error).message;
    }
    try {
      setProjectMaxParallelWorkers(db, project.id, bad);
    } catch (err) {
      setMessage = (err as Error).message;
    }
    assert.match(createMessage, /--max-parallel.*whole number of 1 or more/, `createProject must refuse ${bad}`);
    assert.equal(setMessage, createMessage, `set and create must say the same thing for ${bad}`);
  }
  assert.equal(getProject(db, project.id)!.maxParallelWorkers, null, 'a refused set must leave the cap untouched');
});

// --- Batch 19 mini-phase 1A: worker profiles --------------------------

// Acceptance line 1: a fresh DB has exactly six seeded rows, the names and
// models batch-19-spec.md section 2 names.
test('a fresh database seeds exactly six worker profiles, the names and models named by the spec', () => {
  const db = openDb(':memory:');
  const profiles = listWorkerProfiles(db);
  assert.deepEqual(
    profiles.map((p) => [p.name, p.model]),
    [
      ['Architect', 'claude-opus-5'],
      ['Developer', 'claude-sonnet-5'],
      ['Reviewer', 'claude-sonnet-5'],
      ['Tester', 'claude-sonnet-5'],
      ['Researcher', 'claude-haiku-4-5-20251001'],
      ['Scribe', 'claude-haiku-4-5-20251001'],
    ]
  );
  for (const p of profiles) assert.equal(p.retiredAt, null);
});

test('createWorkerProfile rejects an unknown model and a duplicate name', () => {
  const db = openDb(':memory:');
  assert.throws(() => createWorkerProfile(db, { name: 'X', purpose: 'p', model: 'not-a-real-model' }), /unknown model/);
  createWorkerProfile(db, { name: 'X', purpose: 'p', model: 'claude-sonnet-5' });
  assert.throws(() => createWorkerProfile(db, { name: 'X', purpose: 'q', model: 'claude-opus-5' }), /already exists/);
});

test('createWorkerProfile defaults policy to empty text and accepts an explicit one', () => {
  const db = openDb(':memory:');
  const bare = createWorkerProfile(db, { name: 'Bare', purpose: 'p', model: 'claude-sonnet-5' });
  assert.equal(bare.policy, '');
  const withPolicy = createWorkerProfile(db, { name: 'WithPolicy', purpose: 'p', model: 'claude-sonnet-5', policy: 'Be terse.' });
  assert.equal(withPolicy.policy, 'Be terse.');
});

test('updateWorkerProfile renames a profile without changing its id, and validates model/name the same way createWorkerProfile does', () => {
  const db = openDb(':memory:');
  const profile = createWorkerProfile(db, { name: 'Original', purpose: 'p', model: 'claude-sonnet-5' });
  const renamed = updateWorkerProfile(db, profile.id, { name: 'Renamed' });
  assert.equal(renamed.id, profile.id, 'renaming must keep the same id');
  assert.equal(renamed.name, 'Renamed');
  assert.equal(getWorkerProfileByName(db, 'Original'), undefined);
  assert.equal(getWorkerProfileByName(db, 'Renamed')!.id, profile.id);

  assert.throws(() => updateWorkerProfile(db, profile.id, { model: 'not-a-real-model' }), /unknown model/);
  const other = createWorkerProfile(db, { name: 'Other', purpose: 'p', model: 'claude-sonnet-5' });
  assert.throws(() => updateWorkerProfile(db, profile.id, { name: 'Other' }), /already exists/);
  assert.throws(() => updateWorkerProfile(db, 'prof_does_not_exist', { name: 'Z' }), NoSuchWorkerProfileError);
  void other;
});

// Acceptance line 6: renaming keeps the id; retiring hides without deleting.
test('retireWorkerProfile hides a profile from listWorkerProfiles but never deletes the row, and is idempotent', () => {
  const db = openDb(':memory:');
  const profile = createWorkerProfile(db, { name: 'Temp', purpose: 'p', model: 'claude-sonnet-5' });
  assert.ok(listWorkerProfiles(db).some((p) => p.id === profile.id));

  const retired = retireWorkerProfile(db, profile.id);
  assert.ok(retired.retiredAt != null);
  assert.ok(!listWorkerProfiles(db).some((p) => p.id === profile.id), 'a retired profile must not be listed');
  assert.ok(getWorkerProfile(db, profile.id), 'the row itself must still exist, never deleted');

  const retiredAgain = retireWorkerProfile(db, profile.id);
  assert.equal(retiredAgain.retiredAt, retired.retiredAt, 'retiring twice must not move the timestamp');
});

test('resolveWorkerProfileRef finds a profile by id or by exact name, and refuses an unknown ref', () => {
  const db = openDb(':memory:');
  const profile = createWorkerProfile(db, { name: 'Named', purpose: 'p', model: 'claude-sonnet-5' });
  assert.equal(resolveWorkerProfileRef(db, profile.id), profile.id);
  assert.equal(resolveWorkerProfileRef(db, 'Named'), profile.id);
  assert.throws(() => resolveWorkerProfileRef(db, 'nope'), NoSuchWorkerProfileError);
});

test('assertAssignableProfile refuses a missing profile and a retired one, and returns the profile otherwise', () => {
  const db = openDb(':memory:');
  const profile = createWorkerProfile(db, { name: 'Assignable', purpose: 'p', model: 'claude-sonnet-5' });
  assert.equal(assertAssignableProfile(profile, 'Assignable'), profile);
  assert.throws(() => assertAssignableProfile(undefined, 'ghost'), NoSuchWorkerProfileError);
  const retired = retireWorkerProfile(db, profile.id);
  assert.throws(() => assertAssignableProfile(retired, 'Assignable'), /retired and cannot be assigned/);
});

// Acceptance line 3: `ticket add --profile X --model Y` fails with the one
// sentence; each alone succeeds.
test('createTicket rejects a command that sets both profile and model, with the one sentence, and accepts either alone', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const profile = createWorkerProfile(db, { name: 'Solo', purpose: 'p', model: 'claude-sonnet-5' });

  assert.throws(
    () => createTicket(db, { projectId: project.id, title: 'both', model: 'claude-opus-5', profile: profile.id }),
    /choose a profile or a model, not both/
  );

  const withModel = createTicket(db, { projectId: project.id, title: 'model only', model: 'claude-opus-5' });
  assert.equal(withModel.model, 'claude-opus-5');
  assert.equal(withModel.profileId, null);

  const withProfile = createTicket(db, { projectId: project.id, title: 'profile only', profile: profile.id });
  assert.equal(withProfile.profileId, profile.id);
  assert.equal(withProfile.model, null);

  const withProfileByName = createTicket(db, { projectId: project.id, title: 'by name', profile: 'Solo' });
  assert.equal(withProfileByName.profileId, profile.id);
});

test('createTicket refuses an unknown profile ref and a retired profile', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  assert.throws(() => createTicket(db, { projectId: project.id, title: 't', profile: 'nope' }), NoSuchWorkerProfileError);

  const profile = createWorkerProfile(db, { name: 'GoingAway', purpose: 'p', model: 'claude-sonnet-5' });
  retireWorkerProfile(db, profile.id);
  assert.throws(
    () => createTicket(db, { projectId: project.id, title: 't', profile: profile.id }),
    /retired and cannot be assigned/
  );
});

// Acceptance line 4: resolveModel covers all three sources and the retired
// case -- a profile retired AFTER a ticket was assigned to it still resolves
// (retirement blocks future assignment, not an existing one).
test('resolveModel: ticket.model wins, then profile.model, then project.defaultModel, and a since-retired profile still resolves', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', defaultModel: 'claude-haiku-4-5-20251001' });
  const profile = createWorkerProfile(db, { name: 'R', purpose: 'p', model: 'claude-opus-5' });

  const bare = createTicket(db, { projectId: project.id, title: 'bare' });
  assert.equal(resolveModel(project, bare, undefined), 'claude-haiku-4-5-20251001', 'no override at all falls back to the project default');

  const withProfile = createTicket(db, { projectId: project.id, title: 'profiled', profile: profile.id });
  assert.equal(resolveModel(project, withProfile, profile), 'claude-opus-5', 'a profile, no ticket model, resolves to the profile\'s model');

  const withModel = createTicket(db, { projectId: project.id, title: 'modeled', model: 'claude-sonnet-5' });
  assert.equal(resolveModel(project, withModel, null), 'claude-sonnet-5', 'a ticket model wins over the project default');

  const retiredProfile = retireWorkerProfile(db, profile.id);
  assert.equal(
    resolveModel(project, withProfile, retiredProfile),
    'claude-opus-5',
    'a profile retired AFTER assignment still resolves to its model -- retirement blocks future assignment, not an existing one'
  );
});

// Acceptance line 5: GET /profiles-style derived status -- working with the
// ticket id while a run under that profile is 'running', idle otherwise.
test('workerProfileStatus reports idle by default, working with the ticket id while a run is running, and idle again once it finishes', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const profile = createWorkerProfile(db, { name: 'Busy', purpose: 'p', model: 'claude-sonnet-5' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', profile: profile.id });

  assert.deepEqual(workerProfileStatus(db, profile.id), { status: 'idle', ticketId: null });

  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake', profileId: profile.id });
  assert.deepEqual(workerProfileStatus(db, profile.id), { status: 'working', ticketId: ticket.id });

  finishRun(db, run.id, { status: 'succeeded' });
  assert.deepEqual(workerProfileStatus(db, profile.id), { status: 'idle', ticketId: null });
});

// --- Batch 19 mini-phase 1A review fixes -------------------------------

// Medium 5.
test('createWorkerProfile refuses an empty (or all-whitespace) name or purpose', () => {
  const db = openDb(':memory:');
  assert.throws(() => createWorkerProfile(db, { name: '', purpose: 'p', model: 'claude-sonnet-5' }), /must not be empty/);
  assert.throws(() => createWorkerProfile(db, { name: '   ', purpose: 'p', model: 'claude-sonnet-5' }), /must not be empty/);
  assert.throws(() => createWorkerProfile(db, { name: 'X', purpose: '', model: 'claude-sonnet-5' }), /must not be empty/);
});

// Low 8.
test('createWorkerProfile and updateWorkerProfile refuse a name that starts with "prof_", in one sentence', () => {
  const db = openDb(':memory:');
  assert.throws(() => createWorkerProfile(db, { name: 'prof_fake', purpose: 'p', model: 'claude-sonnet-5' }), /may not start with "prof_"/);
  const real = createWorkerProfile(db, { name: 'Real', purpose: 'p', model: 'claude-sonnet-5' });
  assert.throws(() => updateWorkerProfile(db, real.id, { name: 'prof_impersonator' }), /may not start with "prof_"/);
});

// Medium 6: uniqueness and lookup are both case-insensitive.
test('worker profile names are unique and looked up case-insensitively', () => {
  const db = openDb(':memory:');
  const dev = getWorkerProfileByName(db, 'developer');
  assert.equal(dev!.name, 'Developer', 'lookup must be case-insensitive');
  assert.throws(() => createWorkerProfile(db, { name: 'DEVELOPER', purpose: 'p', model: 'claude-sonnet-5' }), /already exists/);

  const other = createWorkerProfile(db, { name: 'Unique', purpose: 'p', model: 'claude-sonnet-5' });
  assert.throws(() => updateWorkerProfile(db, other.id, { name: 'developer' }), /already exists/);
  // Renaming to a same-name-different-case spelling of ITS OWN name is a no-op rename, not a clash.
  const renamedSameCase = updateWorkerProfile(db, other.id, { name: 'UNIQUE' });
  assert.equal(renamedSameCase.name, 'UNIQUE');
});

// Low 7: a retired name may be reused by a new (or renamed) profile; the
// retired row itself is untouched.
test('a retired profile\'s name can be reused by a new profile, and the retired row is untouched', () => {
  const db = openDb(':memory:');
  const original = createWorkerProfile(db, { name: 'Scout', purpose: 'first', model: 'claude-sonnet-5' });
  retireWorkerProfile(db, original.id);

  const reused = createWorkerProfile(db, { name: 'Scout', purpose: 'second', model: 'claude-opus-5' });
  assert.notEqual(reused.id, original.id);
  assert.equal(getWorkerProfile(db, original.id)!.name, 'Scout', 'the retired row keeps its own name, never deleted');
  assert.equal(getWorkerProfile(db, original.id)!.retiredAt != null, true);
  assert.equal(getWorkerProfileByName(db, 'Scout')!.id, reused.id, 'the active row is the one a name lookup now finds');

  // Renaming a different profile to the retired name must also succeed.
  const third = createWorkerProfile(db, { name: 'Third', purpose: 'p', model: 'claude-sonnet-5' });
  retireWorkerProfile(db, reused.id);
  const renamed = updateWorkerProfile(db, third.id, { name: 'Scout' });
  assert.equal(renamed.name, 'Scout');
});

// Low 9: stable order, tiebroken so the six seeds always list in the
// design's order even though migration 0017 seeds them all with the same
// created_at timestamp.
test('listWorkerProfiles has a stable order: the six seeds list in the design\'s order, and a later profile lists after them', () => {
  const db = openDb(':memory:');
  const before = listWorkerProfiles(db).map((p) => p.name);
  assert.deepEqual(before, ['Architect', 'Developer', 'Reviewer', 'Tester', 'Researcher', 'Scribe']);
  createWorkerProfile(db, { name: 'Newcomer', purpose: 'p', model: 'claude-sonnet-5' });
  const after = listWorkerProfiles(db).map((p) => p.name);
  assert.deepEqual(after, ['Architect', 'Developer', 'Reviewer', 'Tester', 'Researcher', 'Scribe', 'Newcomer']);
});

// High 3, through updateTicketFields (managerApply's update_ticket path in
// 2A calls this directly) -- setting model on a profile ticket, or profile
// on a model ticket, is refused with the same sentence createTicket uses.
test('updateTicketFields refuses to give a profile ticket a model, or a model ticket a profile, with the one sentence', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const profile = createWorkerProfile(db, { name: 'Setter', purpose: 'p', model: 'claude-sonnet-5' });

  const profiled = createTicket(db, { projectId: project.id, title: 'profiled', profile: profile.id });
  assert.throws(
    () => updateTicketFields(db, profiled.id, { model: 'claude-opus-5' }),
    /choose a profile or a model, not both/
  );
  assert.equal(getTicket(db, profiled.id)!.model, null, 'a refused update must leave the ticket untouched');

  const modeled = createTicket(db, { projectId: project.id, title: 'modeled', model: 'claude-opus-5' });
  assert.throws(
    () => updateTicketFields(db, modeled.id, { profile: profile.id }),
    /choose a profile or a model, not both/
  );
  assert.equal(getTicket(db, modeled.id)!.profileId, null, 'a refused update must leave the ticket untouched');

  // Clearing the profile first, THEN setting a model in the same call, is fine.
  updateTicketFields(db, profiled.id, { profile: null, model: 'claude-opus-5' });
  const cleared = getTicket(db, profiled.id)!;
  assert.equal(cleared.profileId, null);
  assert.equal(cleared.model, 'claude-opus-5');
});

// --- Batch 19 mini-phase 1A re-review fixes ----------------------------

// Medium 1: BOTH directions of moving a ticket between "bare model" and
// "profile" in ONE updateTicketFields call, now that `model` has the same
// null-clearing semantics `profile` already had.
test('updateTicketFields moves a ticket from a bare model to a profile, and from a profile to a bare model, each in one call', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const profile = createWorkerProfile(db, { name: 'Mover', purpose: 'p', model: 'claude-opus-5' });

  // Direction 1: model ticket -> profile.
  const modelTicket = createTicket(db, { projectId: project.id, title: 'modeled', model: 'claude-haiku-4-5-20251001' });
  updateTicketFields(db, modelTicket.id, { model: null, profile: profile.id });
  const afterToProfile = getTicket(db, modelTicket.id)!;
  assert.equal(afterToProfile.model, null);
  assert.equal(afterToProfile.profileId, profile.id);

  // Direction 2: profile ticket -> model.
  const profileTicket = createTicket(db, { projectId: project.id, title: 'profiled', profile: profile.id });
  updateTicketFields(db, profileTicket.id, { profile: null, model: 'claude-sonnet-5' });
  const afterToModel = getTicket(db, profileTicket.id)!;
  assert.equal(afterToModel.profileId, null);
  assert.equal(afterToModel.model, 'claude-sonnet-5');
});

// Low 2: SQLite NOCASE is ASCII-only; a non-ASCII case pair must still
// collide, in both createWorkerProfile and updateWorkerProfile.
test('worker profile name uniqueness catches a non-ASCII case pair NOCASE alone would miss', () => {
  const db = openDb(':memory:');
  createWorkerProfile(db, { name: 'École', purpose: 'p', model: 'claude-sonnet-5' });
  assert.throws(
    () => createWorkerProfile(db, { name: 'école', purpose: 'q', model: 'claude-opus-5' }),
    /already exists/,
    'a non-ASCII case variant must still be caught as a duplicate on create'
  );

  const other = createWorkerProfile(db, { name: 'Autre', purpose: 'p', model: 'claude-sonnet-5' });
  assert.throws(
    () => updateWorkerProfile(db, other.id, { name: 'ÉCOLE' }),
    /already exists/,
    'a non-ASCII case variant must still be caught as a duplicate on rename'
  );
});

// Low 3: a non-string name/purpose/model gives the one-sentence error, not a
// raw "value.trim is not a function" crash.
test('createWorkerProfile refuses a non-string name, purpose or model with the plain sentence, not a crash', () => {
  const db = openDb(':memory:');
  assert.throws(() => createWorkerProfile(db, { name: 42 as unknown as string, purpose: 'p', model: 'claude-sonnet-5' }), /must not be empty/);
  assert.throws(() => createWorkerProfile(db, { name: 'X', purpose: {} as unknown as string, model: 'claude-sonnet-5' }), /must not be empty/);
  assert.throws(() => createWorkerProfile(db, { name: 'Y', purpose: 'p', model: null as unknown as string }), /unknown model/);
});

// Low 4: `profile set`/`profile retire`'s admin resolver reaches a RETIRED
// profile by name; the assignment resolver (createTicket's path) still
// cannot.
test('resolveWorkerProfileRefForAdmin finds a retired profile by name; resolveWorkerProfileRef (assignment) still refuses', () => {
  const db = openDb(':memory:');
  const profile = createWorkerProfile(db, { name: 'AdminFind', purpose: 'p', model: 'claude-sonnet-5' });
  retireWorkerProfile(db, profile.id);

  assert.equal(resolveWorkerProfileRefForAdmin(db, 'AdminFind'), profile.id);
  assert.equal(resolveWorkerProfileRefForAdmin(db, 'adminfind'), profile.id, 'admin lookup is also case-insensitive');
  assert.throws(() => resolveWorkerProfileRef(db, 'AdminFind'), NoSuchWorkerProfileError);

  // updateWorkerProfile (row maintenance) must still work by id on a retired row.
  const renamed = updateWorkerProfile(db, profile.id, { purpose: 'still maintainable' });
  assert.equal(renamed.purpose, 'still maintainable');
});

// Reviewer-suggested guard: a manager-kind ticket's run may never carry a
// profile_id, whatever a future caller (2A's adapter wiring) passes.
test('createRun refuses a profileId for a manager-kind ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const profile = createWorkerProfile(db, { name: 'Guarded', purpose: 'p', model: 'claude-sonnet-5' });
  const managerTicket = createTicket(db, { projectId: project.id, title: 'Manager: plan', kind: 'manager', workspaceType: 'NONE' });

  assert.throws(
    () => createRun(db, { ticketId: managerTicket.id, attempt: 1, adapter: 'fake', profileId: profile.id }),
    /manager ticket may never spawn a run under a worker profile/
  );
  // A profile-less run on the same manager ticket is unaffected.
  const run = createRun(db, { ticketId: managerTicket.id, attempt: 1, adapter: 'fake' });
  assert.equal(run.profileId, null);
});

// --- Batch 19 ruling 35: settings (global defaults) ---

test('getSetting/getSettings: absent by default, direct reads see exactly what setSetting wrote', () => {
  const db = openDb(':memory:');
  assert.equal(getSetting(db, 'default_manager_model'), null);
  assert.deepEqual(getSettings(db), {});

  setSetting(db, 'default_manager_model', 'claude-opus-5');
  assert.equal(getSetting(db, 'default_manager_model'), 'claude-opus-5');
  assert.deepEqual(getSettings(db), { default_manager_model: 'claude-opus-5' });

  // Setting the same key again overwrites, not duplicates.
  setSetting(db, 'default_manager_model', 'claude-fable-5-1');
  assert.equal(getSetting(db, 'default_manager_model'), 'claude-fable-5-1');
  assert.deepEqual(getSettings(db), { default_manager_model: 'claude-fable-5-1' });
});

test('setSetting refuses an unknown key, an unknown model, and an invalid max_parallel_workers, each in one sentence, and writes nothing', () => {
  const db = openDb(':memory:');
  assert.throws(() => setSetting(db, 'not_a_real_key', 'x'), /unknown setting: not_a_real_key/);
  assert.throws(() => setSetting(db, 'default_manager_model', 'not-a-real-model'), /unknown model/);
  assert.throws(() => setSetting(db, 'default_verifier_model', 'not-a-real-model'), /unknown model/);
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    assert.throws(() => setSetting(db, 'max_parallel_workers', bad), /whole number of 1 or more/, `must refuse ${bad}`);
  }
  assert.deepEqual(getSettings(db), {}, 'every refused call must have written nothing');
});

// Review fix #9: Number() happily parses "0x3" (hex), "1e1" (exponential)
// and " 3" (leading space) -- the OLD `assertValidMaxParallelWorkers(Number(value))`
// check silently accepted every one of those. The cap is now stored as its
// canonical decimal-integer string ONLY; a non-canonical form is refused
// (the chosen fix, per the review, is refuse -- not normalize-and-store).
// The refusal message names the SETTING ("max_parallel_workers (the
// machine's worker cap)"), not the CLI flag -- nobody typed `--max-parallel`
// on this path.
test('setSetting refuses a non-canonical max_parallel_workers value ("0x3", "1e1", " 3", "3.0", "+3") even though Number() would parse every one of them', () => {
  const db = openDb(':memory:');
  for (const nonCanonical of ['0x3', '1e1', ' 3', '3 ', '3.0', '+3', '03']) {
    assert.throws(
      () => setSetting(db, 'max_parallel_workers', nonCanonical),
      /max_parallel_workers \(the machine's worker cap\)/,
      `must refuse non-canonical form ${JSON.stringify(nonCanonical)}`
    );
  }
  assert.equal(getSetting(db, 'max_parallel_workers'), null, 'nothing must have been written');
  // The canonical form of the same value is still accepted.
  setSetting(db, 'max_parallel_workers', '3');
  assert.equal(getSetting(db, 'max_parallel_workers'), '3');
});

test('unsetSetting clears a key back to absent, and itself refuses an unknown key', () => {
  const db = openDb(':memory:');
  setSetting(db, 'max_parallel_workers', '4');
  assert.equal(getSetting(db, 'max_parallel_workers'), '4');
  unsetSetting(db, 'max_parallel_workers');
  assert.equal(getSetting(db, 'max_parallel_workers'), null);
  assert.throws(() => unsetSetting(db, 'not_a_real_key'), /unknown setting: not_a_real_key/);
});

test('resolveManagerModel/resolveVerifierModel: project override wins, else the global setting, else the project defaultModel', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', defaultModel: 'claude-sonnet-5' });

  // Neither override nor setting: falls all the way back to defaultModel.
  assert.equal(resolveManagerModel(db, project), 'claude-sonnet-5');
  assert.equal(resolveVerifierModel(db, project), 'claude-sonnet-5');

  // The global setting slots in between the override and defaultModel.
  setSetting(db, 'default_manager_model', 'claude-opus-5');
  setSetting(db, 'default_verifier_model', 'claude-haiku-4-5-20251001');
  assert.equal(resolveManagerModel(db, project), 'claude-opus-5');
  assert.equal(resolveVerifierModel(db, project), 'claude-haiku-4-5-20251001');

  // A project's own override still wins over the global setting.
  setProjectManagerModel(db, project.id, 'claude-fable-5-1');
  setProjectVerifierModel(db, project.id, 'claude-fable-5-1');
  const withOverrides = getProject(db, project.id)!;
  assert.equal(resolveManagerModel(db, withOverrides), 'claude-fable-5-1');
  assert.equal(resolveVerifierModel(db, withOverrides), 'claude-fable-5-1');
});

test('resolveMachineCap: the flag wins outright when given; without it, the setting is read fresh, falling back to 1 when nothing is set', () => {
  const db = openDb(':memory:');
  assert.equal(resolveMachineCap(db, undefined), 1, 'last resort: neither flag nor setting');

  setSetting(db, 'max_parallel_workers', '5');
  assert.equal(resolveMachineCap(db, undefined), 5, 'the setting, read fresh, with no flag');

  assert.equal(resolveMachineCap(db, 2), 2, 'the flag wins outright, even though the setting says 5');

  // No restart needed to see a changed setting: a later call sees the change immediately.
  setSetting(db, 'max_parallel_workers', '7');
  assert.equal(resolveMachineCap(db, undefined), 7);
});

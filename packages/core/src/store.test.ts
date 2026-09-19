import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
  insertEvent,
  listEventsForProject,
  listEventsSince,
  listRunsForTicket,
  pauseProjectAdapter,
  projectSpendUsd,
  resolveManagerModel,
  resolveMaxBudgetUsd,
  resumeProject,
  resumeProjectAdapter,
  setProjectDir,
  setProjectManagerModel,
  setProjectMaxBudgetUsd,
  setProjectMaxParallelWorkers,
  setProjectMaxSpendUsd,
  setProjectScopePath,
  setRunUsage,
  setTicketBudgetOverride,
  ticketSpendUsd,
  updateTicketFields,
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
  assert.equal(project.maxParallelWorkers, 1, 'default is unchanged in batch 15');
  setProjectMaxParallelWorkers(db, project.id, 4);
  assert.equal(getProject(db, project.id)!.maxParallelWorkers, 4);
  assert.equal(createProject(db, { name: 'q', maxParallelWorkers: 3 }).maxParallelWorkers, 3);
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
  assert.equal(getProject(db, project.id)!.maxParallelWorkers, 1, 'a refused set must leave the cap untouched');
});

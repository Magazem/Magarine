import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb } from './db/index.ts';
import { createProject, createTicket, getTicket, listEventsForEntity, listTickets } from './store.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { tick } from './scheduler.ts';
import { buildInbox } from './commands/inbox.ts';
import { testTempRoot } from './testSupport.ts';

// Batch 9 step 4's own acceptance list: "Fake-adapter tests for a valid
// proposal creating a small dependency graph, an invalid one rejected
// whole, a `request_user_decision` reaching the inbox, and replay
// reproducing the applied board." managerApply.test.ts already proves the
// application logic itself in isolation (including the rollback guarantee,
// which needs a deterministic injected failure managerApply.ts's own
// test-only seam provides); this file proves the SAME logic is actually
// reachable end to end through `tick()` -- a real manager ticket, a real
// NONE-mode workspace, a real file written into it by FakeAdapter's
// `manager_proposal` script, and read back by scheduler.ts's
// applyManagerTicketDone.

const workspaceBaseDir = testTempRoot('manager-scheduler').root;
after(() => rmSync(workspaceBaseDir, { recursive: true, force: true }));

function setupProject() {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const adapter = new FakeAdapter();
  return { db, project, adapter };
}

function makeManagerTicket(db: ReturnType<typeof openDb>, projectId: string) {
  return createTicket(db, { projectId, title: 'Plan: mission', description: 'mission text', kind: 'manager', workspaceType: 'NONE' });
}

test('a valid proposal, driven through a real tick(), creates a small dependency graph and lands the manager ticket DONE', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'split the mission',
      commands: [
        { type: 'create_ticket', title: 'Intro', description: 'd', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'Detail', description: 'd', acceptance_criteria: [], depends_on: ['Intro'] },
      ],
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  assert.equal(result.started.length, 1);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');
  const titles = listTickets(db, project.id).map((t) => t.title).sort();
  assert.deepEqual(titles, ['Detail', 'Intro', 'Plan: mission'].sort());

  const applied = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'manager_proposal_applied');
  assert.ok(applied, 'expected a manager_proposal_applied event on the manager ticket');
});

test('an invalid proposal, driven through a real tick(), is rejected whole (retryable), and creates nothing', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [], depends_on: ['B'] },
        { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['A'] },
      ],
    },
  });
  const ticketsBefore = listTickets(db, project.id).length;

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'READY', 'a malformed proposal is retryable, same as any other malformed result');
  assert.equal(getTicket(db, managerTicket.id)!.attemptCount, 1);
  assert.equal(listTickets(db, project.id).length, ticketsBefore, 'a rejected proposal must create nothing');
});

test('an invalid proposal that exhausts its attempts lands FAILED and reaches the inbox with the validation errors', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
    maxAttempts: 1,
  });
  adapter.setScript(managerTicket.id, { kind: 'manager_proposal', proposal: { rationale: 'r', commands: [{ type: 'not_a_real_command' }] } });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'FAILED');
  const inbox = buildInbox(db, project.id);
  const item = inbox.find((i) => i.ticketId === managerTicket.id);
  assert.ok(item, 'expected the exhausted malformed proposal to reach the inbox');
  assert.match(item!.message, /type must be one of/);
});

test('a request_user_decision proposal, driven through a real tick(), lands the manager ticket BLOCKED and reaches the inbox', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: { rationale: 'r', commands: [{ type: 'request_user_decision', question: 'Which library?', context: 'two look equivalent' }] },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED');
  const inbox = buildInbox(db, project.id);
  const item = inbox.find((i) => i.ticketId === managerTicket.id);
  assert.ok(item, 'expected the manager\'s decision request to reach the inbox, the same as any worker\'s own needs_user_decision');
  assert.match(item!.message, /Which library\?/);
});

test('replay: after a real tick() applies a proposal, the recorded event alone reconstructs the created tickets and their dependency', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'X', description: 'd', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'Y', description: 'd', acceptance_criteria: [], depends_on: ['X'] },
      ],
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const applied = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'manager_proposal_applied')!;
  const payload = applied.payload as { created: Array<{ title: string; ticketId: string }>; commands: Array<Record<string, unknown>> };

  const titleToId = new Map(payload.created.map((c) => [c.title, c.ticketId]));
  const xId = titleToId.get('X')!;
  const yId = titleToId.get('Y')!;
  assert.ok(xId && yId);
  assert.equal(getTicket(db, yId)!.title, 'Y');

  const yCommand = payload.commands.find((c) => c.title === 'Y') as { depends_on: string[] };
  const reconstructedDependsOn = (yCommand.depends_on ?? []).map((ref) => titleToId.get(ref) ?? ref);
  assert.deepEqual(reconstructedDependsOn, [xId]);
});

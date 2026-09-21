import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { discussProject } from './manager.ts';
import { tick } from './scheduler.ts';
import { buildBoard } from './commands/board.ts';
import { countWorkTicketsInProgress, createProject, createTicket, getTicket, listTicketsByStatus } from './store.ts';
import { testTempRoot } from './testSupport.ts';

// Batch 18 ruling 33: a Manager turn is not a worker slot. The owner's "it just
// stopped": with the default cap of 1 and a worker running, their message to the
// Manager queued behind the worker and nothing said so.

const root = testTempRoot('managerslot');
after(root.cleanup);

function setUp(cap = 1) {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: cap });
  const adapter = new FakeAdapter();
  const deps = { readiness: 'skip' as const, db, adapter, maxParallelWorkers: cap, projectId: project.id, workspaceBaseDir: root.root, artifactsDir: root.root };
  return { db, project, adapter, deps };
}

test('with --max-parallel 1 and a work ticket IN_PROGRESS, a discuss starts a Manager run on the NEXT tick', async () => {
  const { db, project, adapter, deps } = setUp();
  const work = createTicket(db, { projectId: project.id, title: 'long job', workspaceType: 'NONE' });
  adapter.setScript(work.id, { kind: 'hang' });

  const first = await tick(deps);
  assert.deepEqual(first.started.map((s) => s.ticketId), [work.id]);
  assert.equal(getTicket(db, work.id)!.status, 'IN_PROGRESS');

  const managerId = discussProject(db, project.id, 'how is it going?');
  adapter.setScript(managerId, { kind: 'hang' });
  const second = await tick(deps);

  assert.deepEqual(second.started.map((s) => s.ticketId), [managerId], 'the Manager must start although the only worker slot is taken');
  assert.equal(getTicket(db, managerId)!.status, 'IN_PROGRESS');
  assert.equal(getTicket(db, work.id)!.status, 'IN_PROGRESS');
});

test('two READY manager tickets never run together, even with free slots: the second waits until the first is no longer in flight', async () => {
  const { db, project, adapter, deps } = setUp(3);
  const a = discussProject(db, project.id, 'first question');
  const b = discussProject(db, project.id, 'second question');
  adapter.setScript(a, { kind: 'hang' });
  adapter.setScript(b, { kind: 'hang' });

  const first = await tick(deps);
  assert.equal(first.started.length, 1, 'exactly one Manager run per project');
  const running = listTicketsByStatus(db, project.id, 'IN_PROGRESS').filter((t) => t.kind === 'manager');
  assert.equal(running.length, 1);

  const again = await tick(deps);
  assert.equal(again.started.length, 0, 'a second READY manager ticket keeps waiting while one is in flight');
  assert.equal(listTicketsByStatus(db, project.id, 'IN_PROGRESS').filter((t) => t.kind === 'manager').length, 1);
  assert.equal(listTicketsByStatus(db, project.id, 'READY').filter((t) => t.kind === 'manager').length, 1);
});

test('a running Manager does not take a worker slot: work tickets still start up to the cap', async () => {
  const { db, project, adapter, deps } = setUp();
  const managerId = discussProject(db, project.id, 'plan something');
  adapter.setScript(managerId, { kind: 'hang' });
  const work = createTicket(db, { projectId: project.id, title: 'job', workspaceType: 'NONE' });
  adapter.setScript(work.id, { kind: 'hang' });

  const result = await tick(deps);
  assert.deepEqual(new Set(result.started.map((s) => s.ticketId)), new Set([managerId, work.id]));
  assert.equal(result.started[0]!.ticketId, managerId, 'the Manager is started before any work ticket');
});

test('slot counts (the daemon ceiling, the board) count WORK tickets in progress only', async () => {
  const { db, project, adapter, deps } = setUp(3);
  const managerId = discussProject(db, project.id, 'hello');
  adapter.setScript(managerId, { kind: 'hang' });
  const work = createTicket(db, { projectId: project.id, title: 'job', workspaceType: 'NONE' });
  adapter.setScript(work.id, { kind: 'hang' });
  await tick(deps);
  assert.equal(countWorkTicketsInProgress(db), 1);
  assert.equal(countWorkTicketsInProgress(db, project.id), 1);
  assert.equal(buildBoard(db, project.id, 3).slots.used, 1, 'the board must not show a Manager turn as a spent worker slot');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { runUntilIdle, tick } from './scheduler.ts';
import { startDaemonLoop } from './daemon.ts';
import { createProject, createTicket, getProject, listRunsForTicket, setProjectDir } from './store.ts';
import { buildBoard } from './commands/board.ts';
import { buildInbox } from './commands/inbox.ts';

// Batch 16 ruling 24 (docs/strategy/batch-16-spec.md section 1): readiness is
// checked at the point of use -- the scheduler, before ANY run starts, manager
// or worker -- and a failing project is paused through the existing pause
// mechanism with the rule as its structured reason, the fix named, and
// `project set --dir` resuming it. The owner's four legacy projects have
// neither a workspace_root nor a scope_path.

const stateDir = mkdtempSync(join(tmpdir(), 'magarine-readiness-state-'));
const realDir = join(mkdtempSync(join(tmpdir(), 'magarine-readiness-proj-')), 'app');
mkdirSync(realDir);
test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(join(realDir, '..'), { recursive: true, force: true });
});

function deps(db: ReturnType<typeof openDb>, projectId: string, adapter: FakeAdapter) {
  return { db, adapter, maxParallelWorkers: 2, projectId, readiness: { stateDir, scopeProbe: () => 'present' as const }, artifactsDir: join(stateDir, 'artifacts') };
}

test('a scope-less legacy project pauses BEFORE any run starts -- manager or worker -- with a pause reason naming the command', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'legacy' }); // workspace_root and scope_path both null, like the owner's row
  const manager = createTicket(db, { projectId: project.id, title: 'Plan', kind: 'manager', workspaceType: 'NONE' });
  const work = createTicket(db, { projectId: project.id, title: 'Work', workspaceType: 'NONE' });
  const adapter = new FakeAdapter();

  const result = await tick(deps(db, project.id, adapter));

  assert.deepEqual(result.started, [], 'nothing may start');
  assert.deepEqual(listRunsForTicket(db, manager.id), [], 'no run row for the manager ticket');
  assert.deepEqual(listRunsForTicket(db, work.id), [], 'no run row for the work ticket');
  const paused = getProject(db, project.id)!;
  assert.notEqual(paused.adapterPausedAt, null);
  assert.equal(paused.pauseReason, 'missing_workspace_root');

  const board = buildBoard(db, project.id);
  assert.equal(board.pauseReason, 'missing_workspace_root');
  assert.match(board.pauseMessage!, new RegExp(`magarine project set --project ${project.id} --dir <folder>`));
  const inbox = buildInbox(db, project.id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0]!.message, new RegExp(`magarine project set --project ${project.id} --dir <folder>`));
});

test('a project with a directory but no scope_path pauses as missing_scope_path; an unsafe directory pauses as unsafe_workspace_root', async () => {
  const db = openDb(':memory:');
  const noScope = createProject(db, { name: 'no-scope', workspaceRoot: realDir });
  createTicket(db, { projectId: noScope.id, title: 't', workspaceType: 'NONE' });
  await tick(deps(db, noScope.id, new FakeAdapter()));
  assert.equal(getProject(db, noScope.id)!.pauseReason, 'missing_scope_path');

  const unsafe = createProject(db, { name: 'unsafe', workspaceRoot: stateDir, scopePath: join(stateDir, 'SCOPE.md') });
  createTicket(db, { projectId: unsafe.id, title: 't', workspaceType: 'NONE' });
  await tick(deps(db, unsafe.id, new FakeAdapter()));
  assert.equal(getProject(db, unsafe.id)!.pauseReason, 'unsafe_workspace_root');
});

test('`project set --dir` (setProjectDir) resumes a project paused for readiness with no separate command, and the next tick runs it', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'legacy' });
  const work = createTicket(db, { projectId: project.id, title: 'Work', workspaceType: 'NONE' });
  const adapter = new FakeAdapter();
  await tick(deps(db, project.id, adapter));
  assert.equal(getProject(db, project.id)!.pauseReason, 'missing_workspace_root');

  const { unpaused } = setProjectDir(db, project.id, realDir);
  assert.equal(unpaused, true);
  assert.equal(getProject(db, project.id)!.adapterPausedAt, null);

  const result = await tick(deps(db, project.id, adapter));
  await Promise.all(result.started.map((s) => s.done));
  assert.deepEqual(result.started.map((s) => s.ticketId), [work.id]);
});

test('`project set --dir` does NOT resume a project paused for another cause (spend cap, adapter)', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', workspaceRoot: realDir, scopePath: join(realDir, 'SCOPE.md') });
  db.prepare("UPDATE projects SET adapter_paused_at = ?, pause_reason = 'adapter_unavailable' WHERE id = ?").run(new Date().toISOString(), project.id);
  const { unpaused } = setProjectDir(db, project.id, realDir);
  assert.equal(unpaused, false);
  assert.equal(getProject(db, project.id)!.pauseReason, 'adapter_unavailable');
});

test('a ready project is not paused by the check and runs normally', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'ok', workspaceRoot: realDir, scopePath: join(realDir, 'SCOPE.md') });
  const work = createTicket(db, { projectId: project.id, title: 'Work', workspaceType: 'NONE' });
  const result = await tick(deps(db, project.id, new FakeAdapter()));
  await Promise.all(result.started.map((s) => s.done));
  assert.deepEqual(result.started.map((s) => s.ticketId), [work.id]);
  assert.equal(getProject(db, project.id)!.adapterPausedAt, null);
});

// Strategist's ruling on this item: the check must not be switchable off by
// forgetting a field. `readiness` is REQUIRED -- the type refuses an omitting
// call site, and this runtime guard refuses a JS caller (the type alone is
// not the guard).
test('tick, runUntilIdle and startDaemonLoop THROW when `readiness` is omitted (a JS caller), rather than silently skipping the check', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'legacy' });
  const { readiness: _omitted, ...withoutReadiness } = deps(db, project.id, new FakeAdapter());
  await assert.rejects(() => tick(withoutReadiness as never), /readiness.*required/);
  await assert.rejects(() => runUntilIdle(withoutReadiness as never), /readiness.*required/);
  assert.throws(() => startDaemonLoop({ ...withoutReadiness, tickIntervalMs: 60_000 } as never), /readiness.*required/);
  // A malformed value is refused the same way: `{}` has no stateDir, `true` is neither shape.
  await assert.rejects(() => tick({ ...withoutReadiness, readiness: {} } as never), /readiness.*required/);
  await assert.rejects(() => tick({ ...withoutReadiness, readiness: true } as never), /readiness.*required/);
});

test("'skip' declares the caller is not asking: a legacy project is NOT paused and its ticket runs", async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'legacy' }); // would pause under { stateDir }
  const work = createTicket(db, { projectId: project.id, title: 'Work', workspaceType: 'NONE' });
  const result = await tick({ ...deps(db, project.id, new FakeAdapter()), readiness: 'skip' });
  await Promise.all(result.started.map((s) => s.done));
  assert.deepEqual(result.started.map((s) => s.ticketId), [work.id]);
  assert.equal(getProject(db, project.id)!.adapterPausedAt, null);
});

// Ruling 29 (batch 16 addendum 5): a scope document that is ABSENT does not
// pause a project (the talk-first start is deliberate); one that is
// UNREADABLE does, at the same point of use, naming the path and the fix.
function withProbe(base: ReturnType<typeof deps>, scopeProbe: () => 'present' | 'absent' | 'unreadable') {
  return { ...base, readiness: { stateDir, scopeProbe } };
}

test('an UNREADABLE scope file pauses the project BEFORE any run, with a reason naming the path and the resume command', async () => {
  const db = openDb(':memory:');
  const scopePath = join(realDir, 'SCOPE.md');
  const project = createProject(db, { name: 'unreadable', workspaceRoot: realDir, scopePath });
  const manager = createTicket(db, { projectId: project.id, title: 'Plan', kind: 'manager', workspaceType: 'NONE' });
  const work = createTicket(db, { projectId: project.id, title: 'Work', workspaceType: 'NONE' });

  const result = await tick(withProbe(deps(db, project.id, new FakeAdapter()), () => 'unreadable'));

  assert.deepEqual(result.started, [], 'nothing may start');
  assert.deepEqual(listRunsForTicket(db, manager.id), []);
  assert.deepEqual(listRunsForTicket(db, work.id), []);
  assert.equal(getProject(db, project.id)!.pauseReason, 'unreadable_scope_file');
  const board = buildBoard(db, project.id);
  assert.equal(board.pauseReason, 'unreadable_scope_file');
  assert.ok(board.pauseMessage!.includes(scopePath), `names the path: ${board.pauseMessage}`);
  assert.ok(board.pauseMessage!.includes(`magarine resume --project ${project.id}`), board.pauseMessage!);
  assert.match(buildInbox(db, project.id)[0]!.message, /cannot be read/);
});

test('an ABSENT scope file does NOT pause the project: its ticket runs (plan does not refuse a talk-first start)', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'absent', workspaceRoot: realDir, scopePath: join(realDir, 'SCOPE.md') });
  const work = createTicket(db, { projectId: project.id, title: 'Work', workspaceType: 'NONE' });
  const result = await tick(withProbe(deps(db, project.id, new FakeAdapter()), () => 'absent'));
  await Promise.all(result.started.map((s) => s.done));
  assert.deepEqual(result.started.map((s) => s.ticketId), [work.id]);
  assert.equal(getProject(db, project.id)!.adapterPausedAt, null);
});

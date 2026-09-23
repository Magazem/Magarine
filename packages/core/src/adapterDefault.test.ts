import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.ts';
import { resolveAdapterChoice } from './adapterChoice.ts';
import { FakeAdapter, FAKE_MANAGER_REFUSAL } from './adapters/fakeAdapter.ts';
import { spawnManaged } from './process.ts';
import { createProject, createTicket, getTicket } from './store.ts';
import { buildInbox } from './commands/inbox.ts';
import { tick } from './scheduler.ts';
import { deriveTestCliCwd, pinnedFakeEnv, testTempRoot } from './testSupport.ts';

// Ruling 41: the real adapter is the default; the fake is asked for by name.
// NOTHING here starts a run against a real adapter: the default is proven by
// resolving the KIND only (a pure function), and the CLI spawns below all
// stop at an argument refusal or --help before any adapter is built.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const testRoot = testTempRoot('adapter-default');
after(testRoot.cleanup);

test('with no flag and no environment variable the adapter resolves to claude, from the default', () => {
  assert.deepEqual(resolveAdapterChoice(undefined, {}), { kind: 'claude', source: 'default' });
  assert.deepEqual(resolveAdapterChoice(undefined, { MAGARINE_ADAPTER: '' }), { kind: 'claude', source: 'default' });
  assert.deepEqual(resolveAdapterChoice(true, {}), { kind: 'claude', source: 'default' }, 'a bare --adapter names nothing');
});

test('MAGARINE_ADAPTER=fake resolves fake from the environment; --adapter wins over it', () => {
  assert.deepEqual(resolveAdapterChoice(undefined, { MAGARINE_ADAPTER: 'fake' }), { kind: 'fake', source: 'env' });
  assert.deepEqual(resolveAdapterChoice('claude', { MAGARINE_ADAPTER: 'fake' }), { kind: 'claude', source: 'flag' });
  assert.deepEqual(resolveAdapterChoice('fake', { MAGARINE_ADAPTER: 'claude' }), { kind: 'fake', source: 'flag' });
});

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged({ env: pinnedFakeEnv(env), executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  return proc.wait().then((r) => ({ code: r.code, stdout, stderr }));
}

test('--fake-script without the fake adapter is refused in one sentence naming --adapter fake', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'refuse-'));
  // MAGARINE_ADAPTER=claude on purpose: the refusal must come BEFORE any
  // adapter is built, so no claude process can start.
  const env = { MAGARINE_ADAPTER: 'claude' };
  const created = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json'], env);
  const projectId = JSON.parse(created.stdout).id as string;
  for (const flag of [['--fake-script', 't=hang'], ['--fake-outcome', 't=done'], ['--fake-progress-gap', '5']]) {
    const res = await runCli(['tick', '--project', projectId, '--state-dir', stateDir, ...flag], env);
    assert.notEqual(res.code, 0, `${flag[0]} without the fake adapter must be refused`);
    assert.match(res.stderr, /--adapter fake/);
    assert.equal(res.stderr.trim().split(/\n/).length, 1, 'one sentence, one line');
  }
  // ...and with the fake named, the same flag is accepted.
  const ok = await runCli(['tick', '--project', projectId, '--state-dir', stateDir, '--adapter', 'fake', '--fake-script', 't=hang'], env);
  assert.equal(ok.code, 0, ok.stderr);
});

test('--help for serve, tick, run and app documents MAGARINE_ADAPTER and says the fake is a test double', async () => {
  for (const command of ['serve', 'tick', 'run', 'app']) {
    const res = await runCli([command, '--help'], {});
    assert.equal(res.code, 0);
    assert.match(res.stdout, /MAGARINE_ADAPTER/);
    assert.match(res.stdout, /test double/);
  }
});

test('a Manager ticket on the fake adapter with no script fails ONCE, non-retryably, and says which adapter it is and how to start the real one -- never "JSON"', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const manager = createTicket(db, { projectId: project.id, title: 'Plan: hello', description: 'hello', kind: 'manager', workspaceType: 'NONE' });
  const result = await tick({ readiness: 'skip', db, adapter: new FakeAdapter(), maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir: testRoot.root });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, manager.id)!;
  assert.equal(ticket.status, 'FAILED');
  assert.equal(ticket.attemptCount, 1, 'one attempt: nothing about this failure improves on a retry');
  const item = buildInbox(db, project.id).find((i) => i.ticketId === manager.id);
  assert.ok(item, 'the failure reaches the inbox');
  assert.ok(item!.message.includes(FAKE_MANAGER_REFUSAL), item!.message);
  assert.match(item!.message, /fake adapter/);
  assert.match(item!.message, /--adapter claude/);
  assert.doesNotMatch(item!.message, /json/i);
  assert.doesNotMatch(FAKE_MANAGER_REFUSAL, /json/i);
});

test('a scripted Manager ticket on the fake adapter still behaves exactly as before (the refusal is only the no-script default)', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const manager = createTicket(db, { projectId: project.id, title: 'Plan: hello', description: 'hello', kind: 'manager', workspaceType: 'NONE' });
  const adapter = new FakeAdapter();
  adapter.setScript(manager.id, { kind: 'manager_proposal', proposal: { rationale: 'r', commands: [] } });
  const result = await tick({ readiness: 'skip', db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir: testRoot.root });
  await Promise.all(result.started.map((s) => s.done));
  assert.equal(getTicket(db, manager.id)!.status, 'DONE');
});

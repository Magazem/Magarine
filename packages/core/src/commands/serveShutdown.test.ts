import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/index.ts';
import { FakeAdapter } from '../adapters/fakeAdapter.ts';
import { createProject, createTicket, getTicket, listTickets } from '../store.ts';
import { formatShutdown, serve } from './serve.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 17 item: a shutdown that cancels work says so, and says the spend
// will be paid again. `serve()` is run in-process and stopped with
// `process.emit('SIGINT')` -- the same substitution scheduler.test.ts's own
// SIGINT test makes, since a separate process cannot deliver a catchable
// signal to a Windows `serve` it did not launch interactively.

const testRoot = testTempRoot('serve-shutdown');
after(testRoot.cleanup);

async function runServeWith(liveCount: number): Promise<{ reports: Array<{ cancelled: string[] }>; ticketIds: string[]; statuses: string[] }> {
  const stateDir = join(testRoot.root, `state-${liveCount}-${Math.random().toString(36).slice(2, 8)}`);
  const projectDir = join(stateDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', workspaceRoot: projectDir, scopePath: join(projectDir, 'SCOPE.md') });
  const adapter = new FakeAdapter();
  const ticketIds: string[] = [];
  for (let i = 0; i < liveCount; i++) {
    const tk = createTicket(db, { projectId: project.id, title: `hangs ${i}`, workspaceType: 'NONE' });
    adapter.setScript(tk.id, { kind: 'hang' });
    ticketIds.push(tk.id);
  }
  const reports: Array<{ cancelled: string[] }> = [];
  let listening!: () => void;
  const isListening = new Promise<void>((resolve) => (listening = resolve));
  const done = serve({
    db,
    dbPath: ':memory:',
    stateDir,
    adapter,
    maxParallelWorkers: Math.max(1, liveCount),
    artifactsDir: join(stateDir, 'artifacts'),
    tickIntervalMs: 20,
    onListening: () => listening(),
    onStopped: (info) => reports.push(info),
  });
  await isListening;
  const deadline = Date.now() + 3000;
  while (listTickets(db, project.id).filter((t) => t.status === 'IN_PROGRESS').length < liveCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.emit('SIGINT');
  await done;
  return { reports, ticketIds, statuses: ticketIds.map((id) => getTicket(db, id)!.status) };
}

test('serve reports what a shutdown cancelled: the N in-flight ticket ids, once, after they are back to READY', async () => {
  const { reports, ticketIds, statuses } = await runServeWith(2);
  assert.equal(reports.length, 1, 'exactly one report');
  assert.deepEqual([...reports[0]!.cancelled].sort(), [...ticketIds].sort());
  assert.deepEqual(statuses, ['READY', 'READY']);
});

test('serve reports NOTHING when nothing was in flight (today\'s quiet shutdown is unchanged)', async () => {
  const { reports } = await runServeWith(0);
  assert.deepEqual(reports, []);
});

test('the wording says stopped, how many, the ids while they fit, and that they restart from scratch on the next serve', () => {
  const line = formatShutdown(['t-12', 't-15', 't-19', 't-20']);
  assert.equal(
    line.human,
    'stopped; 4 running tasks were cancelled (t-12, t-15, t-19, t-20) -- they are READY again and will restart from scratch on the next serve'
  );
  assert.deepEqual(line.json, { stopped: true, cancelled: ['t-12', 't-15', 't-19', 't-20'] });
  assert.match(formatShutdown(['t-1']).human, /^stopped; 1 running task was cancelled \(t-1\) -- /, 'singular for one');
});

test('past a handful (or when the ids would not fit one line) it says the count and points at the board, still saying restart from scratch', () => {
  const many = Array.from({ length: 9 }, (_, i) => `t-${i}`);
  const human = formatShutdown(many).human;
  assert.match(human, /^stopped; 9 running tasks were cancelled \(see `magarine board`\) -- /);
  assert.match(human, /restart from scratch on the next serve/);
  assert.ok(!human.includes('t-3'), 'no id list past a handful');
  const long = ['tkt_' + 'a'.repeat(36), 'tkt_' + 'b'.repeat(36), 'tkt_' + 'c'.repeat(36)];
  assert.match(formatShutdown(long).human, /see `magarine board`/, 'ids that do not fit one line fall back to the count');
  assert.deepEqual(formatShutdown(many).json.cancelled, many, '--json always carries every id');
});

// The shutdown must not hang on an /events stream that connects WHILE the runs
// are being cancelled (after the first closeAllStreams, before server.close):
// `server.close()` waits for every open connection. The `app` notifier holds
// exactly such a stream, and a slow-stopping worker widens the window.
test('a client that opens /events during shutdown (while a slow run is being cancelled) does not hang serve()', async () => {
  class SlowStopAdapter extends FakeAdapter {
    override async stop(handle: Parameters<FakeAdapter['stop']>[0]): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return super.stop(handle);
    }
  }
  const stateDir = join(testRoot.root, `state-late-stream-${Math.random().toString(36).slice(2, 8)}`);
  const projectDir = join(stateDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', workspaceRoot: projectDir, scopePath: join(projectDir, 'SCOPE.md') });
  const adapter = new SlowStopAdapter();
  const tk = createTicket(db, { projectId: project.id, title: 'hangs', workspaceType: 'NONE' });
  adapter.setScript(tk.id, { kind: 'hang' });
  let port = 0;
  let token = '';
  const done = serve({
    db, dbPath: ':memory:', stateDir, adapter, maxParallelWorkers: 1, artifactsDir: join(stateDir, 'artifacts'), tickIntervalMs: 20,
    onListening: (info) => (port = info.port),
  });
  const deadline = Date.now() + 5000;
  while ((!port || getTicket(db, tk.id)!.status !== 'IN_PROGRESS') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(port);
  token = (JSON.parse((await import('node:fs')).readFileSync(join(stateDir, 'daemon.json'), 'utf8')) as { token: string }).token;

  process.emit('SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 250)); // inside the slow stop: first closeAllStreams is behind us
  const late = await fetch(`http://127.0.0.1:${port}/events`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(late.status, 200, 'the stream opened during shutdown');

  const outcome = await Promise.race([done.then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('HUNG'), 6000))]);
  assert.equal(outcome, 'stopped', 'serve() must finish, not wait forever on the late stream');
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from './process.ts';
import { openDb } from './db/index.ts';
import { daemonFilePath, type DaemonFileInfo } from './daemon.ts';
import { deriveTestCliCwd, testTempRoot } from './testSupport.ts';

// Batch 16 ruling 24, end to end through the real CLI and the real `serve`
// process: the owner's legacy project (neither workspace_root nor scope_path)
// pauses with a named fix before any run starts, `project list` marks it,
// and `project set --dir` resumes it with no separate command.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const testRoot = testTempRoot('readiness-cli');
after(testRoot.cleanup);

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    let stderr = '';
    p.onStdout((c) => (stdout += c));
    p.onStderr((c) => (stderr += c));
    p.wait().then((r) => resolve({ code: r.code, stdout, stderr }));
  });
}

// `project create` always writes a directory now, so a legacy row is made
// the way the owner's was: a project whose two directory columns are null.
async function makeLegacyProject(stateDir: string): Promise<string> {
  const created = await run(['project', 'create', '--name', 'legacy', '--state-dir', stateDir, '--json']);
  const id = JSON.parse(created.stdout).id as string;
  const db = openDb(join(stateDir, 'magarine.db'));
  db.prepare('UPDATE projects SET workspace_root = NULL, scope_path = NULL WHERE id = ?').run(id);
  db.close();
  return id;
}

test('project list marks a legacy project "needs --dir" and --json carries readiness { rule, fix }; a ready project shows readiness null', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'list-'));
  const legacyId = await makeLegacyProject(stateDir);
  const readyRes = await run(['project', 'create', '--name', 'ready', '--state-dir', stateDir, '--json']);
  const readyId = JSON.parse(readyRes.stdout).id as string;

  const json = JSON.parse((await run(['project', 'list', '--state-dir', stateDir, '--json'])).stdout) as Array<{
    id: string;
    readiness: { rule: string; fix: string } | null;
  }>;
  assert.deepEqual(json.find((p) => p.id === legacyId)!.readiness, {
    rule: 'missing_workspace_root',
    fix: `magarine project set --project ${legacyId} --dir <folder>`,
  });
  assert.equal(json.find((p) => p.id === readyId)!.readiness, null);

  const text = (await run(['project', 'list', '--state-dir', stateDir])).stdout.split('\n');
  assert.ok(text.find((l) => l.includes(legacyId))!.includes('needs --dir'));
  assert.ok(!text.find((l) => l.includes(readyId))!.includes('needs --dir'));
});

test('tick on a legacy project pauses it (board names the fix); `project set --dir` then resumes it with no separate command', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'tick-'));
  const id = await makeLegacyProject(stateDir);
  await run(['ticket', 'add', '--project', id, '--title', 't', '--state-dir', stateDir, '--json']);

  await run(['tick', '--project', id, '--adapter', 'fake', '--state-dir', stateDir]);
  const paused = JSON.parse((await run(['board', '--project', id, '--state-dir', stateDir, '--json'])).stdout);
  assert.equal(paused.pauseReason, 'missing_workspace_root');
  assert.match(paused.pauseMessage, new RegExp(`magarine project set --project ${id} --dir <folder>`));
  assert.equal(paused.tickets[0].status, 'READY', 'no run started');

  const dir = join(stateDir, 'my-project');
  mkdirSync(dir);
  const set = await run(['project', 'set', '--project', id, '--dir', dir, '--state-dir', stateDir]);
  assert.equal(set.code, 0, set.stderr);
  const resumed = JSON.parse((await run(['board', '--project', id, '--state-dir', stateDir, '--json'])).stdout);
  assert.equal(resumed.pauseReason, null);
  assert.equal(resumed.pauseMessage, null);
});

// The wiring, not the payload: a real `serve` process must pass its state
// directory into the scheduler, or the check is silently skipped in
// production while every in-process test still passes.
test('a real `serve` pauses a legacy project before any run starts, and GET /projects carries its readiness', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'serve-'));
  const id = await makeLegacyProject(stateDir);
  const ticketRes = await run(['ticket', 'add', '--project', id, '--title', 't', '--state-dir', stateDir, '--json']);
  const ticketId = JSON.parse(ticketRes.stdout).id as string;

  const proc = spawnManaged({
    executable: process.execPath,
    args: [cliPath, 'serve', '--state-dir', stateDir, '--adapter', 'fake', '--tick-interval', '0.05', '--json'],
  });
  let stdout = '';
  proc.onStdout((c) => (stdout += c));
  try {
    const deadline = Date.now() + 10_000;
    let port = 0;
    while (Date.now() < deadline && !port) {
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) port = (JSON.parse(line) as { port: number }).port;
      else await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(port, 'serve never printed its listening line');
    const token = (JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo).token;
    const get = async (path: string) =>
      (await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

    let board: any;
    while (Date.now() < deadline) {
      board = await get(`/board?project=${id}`);
      if (board.pauseReason) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(board.pauseReason, 'missing_workspace_root');
    assert.equal(board.tickets.find((t: any) => t.id === ticketId).status, 'READY', 'no run started');

    const projects = (await get('/projects')) as Array<{ id: string; readiness: { rule: string } | null }>;
    assert.equal(projects.find((p) => p.id === id)!.readiness?.rule, 'missing_workspace_root');
  } finally {
    await proc.stop(200);
    await proc.wait();
  }
});

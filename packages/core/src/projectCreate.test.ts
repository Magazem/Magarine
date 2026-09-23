import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import type { DaemonLoop } from './daemon.ts';
import { createRequestHandler } from './daemonApi.ts';
import { createProjectInDir, normaliseDir } from './commands/projectCreate.ts';
import { createProject, listProjects } from './store.ts';
import { spawnManaged } from './process.ts';
import { fileURLToPath } from 'node:url';
import { deriveTestCliCwd, pinnedFakeEnv, testTempRoot } from './testSupport.ts';

// Batch 20A (ruling 42): POST /projects, and the one creation function the CLI
// shares with it (the CLI's own behaviour is proven by commands.test.ts etc.,
// unchanged). Everything here goes through the real request handler over a
// real loopback connection.

const TOKEN = 'project-create-test-token';
const testRoot = testTempRoot('project-create');
after(testRoot.cleanup);
const stateDir = join(testRoot.root, 'state');
mkdirSync(stateDir);

async function startServer(db: Db): Promise<{ port: number; close: () => Promise<void> }> {
  const stubLoop: DaemonLoop = {
    live: new Map(),
    liveRuns: new Map(),
    stop: async () => ({ cancelled: [] }),
    forceTick: async () => ({ started: [] }),
    cancelTicket: async () => 'not_running',
  };
  const handler = createRequestHandler({ db, adapter: new FakeAdapter(), loop: stubLoop, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString(), stateDir });
  const server = createServer(handler.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async close() {
      handler.closeAllStreams();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function call(port: number, method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : undefined };
}

function freshDir(label: string): string {
  return mkdtempSync(join(testRoot.root, `${label}-`));
}

test('POST /projects with an existing absolute directory creates the project, visible in GET /projects', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('ok');
    const res = await call(port, 'POST', '/projects', { name: 'Blog', dir, description: 'd', defaultModel: 'claude-sonnet-5', maxParallel: 2 });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.workspaceRoot, dir);
    assert.equal(res.json.scopePath, join(dir, 'SCOPE.md'));
    assert.match(res.json.scopeNote, /not found/, 'an absent SCOPE.md is announced, as the CLI announces it');
    const list = (await call(port, 'GET', '/projects')).json as Array<{ id: string; name: string }>;
    assert.ok(list.some((p) => p.id === res.json.id && p.name === 'Blog'));
  } finally {
    await close();
  }
});

test('without a token it is 401 and nothing is created', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const res = await call(port, 'POST', '/projects', { name: 'x', dir: freshDir('noauth') }, null);
    assert.equal(res.status, 401);
    assert.equal(listProjects(db).length, 0);
  } finally {
    await close();
  }
});

test('each refusal is ONE sentence, and nothing is written -- no row, no SCOPE.md', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('refuse');
    const aFile = join(dir, 'a-file.txt');
    writeFileSync(aFile, 'x');
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['missing directory', { name: 'p', dir: join(dir, 'nope'), scopeText: 'S' }, /does not exist.*create the folder first/],
      ['a file, not a directory', { name: 'p', dir: aFile }, /not a directory/],
      ['relative path', { name: 'p', dir: 'relative/thing' }, /absolute path/],
      ['home directory', { name: 'p', dir: homedir(), scopeText: 'S' }, /home directory/],
      ['state directory', { name: 'p', dir: stateDir, scopeText: 'S' }, /state directory/],
      ['unknown default model', { name: 'p', dir, defaultModel: 'gpt-nope' }, /unknown model for defaultModel/],
      ['unknown manager model', { name: 'p', dir, managerModel: 'gpt-nope' }, /unknown model for managerModel/],
      ['unknown verifier model', { name: 'p', dir, verifierModel: 'gpt-nope' }, /unknown model for verifierModel/],
      ['cap of zero', { name: 'p', dir, maxParallel: 0 }, /whole number of 1 or more/],
      ['fractional cap', { name: 'p', dir, maxParallel: 1.5 }, /whole number of 1 or more/],
      ['cap as a string', { name: 'p', dir, maxParallel: '2' }, /maxParallel must be a number/],
      ['empty name', { name: '  ', dir }, /"name" is required/],
      ['unknown field', { name: 'p', dir, colour: 'red' }, /unknown field\(s\).*colour/],
    ];
    for (const [label, body, sentence] of cases) {
      const res = await call(port, 'POST', '/projects', body);
      assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.json)}`);
      assert.match(res.json.error, sentence, label);
      assert.ok(!res.json.error.includes('\n'), `${label}: one sentence`);
    }
    assert.equal(listProjects(db).length, 0, 'nothing was created by any refusal');
    assert.deepEqual(readdirSync(dir), ['a-file.txt'], 'no SCOPE.md or temp file was written');
  } finally {
    await close();
  }
});

test('all fields are validated BEFORE anything is written: a good scopeText with a bad model writes no file and no row', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('allbefore');
    const res = await call(port, 'POST', '/projects', { name: 'p', dir, scopeText: '# Mission', managerModel: 'gpt-nope' });
    assert.equal(res.status, 400);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(listProjects(db).length, 0);
  } finally {
    await close();
  }
});

test('scopeText with no SCOPE.md writes the file atomically (content exact, no temp file left) and creates the project', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('scope');
    const res = await call(port, 'POST', '/projects', { name: 'p', dir, scopeText: '# Mission\nBuild it.\n' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(readFileSync(join(dir, 'SCOPE.md'), 'utf8'), '# Mission\nBuild it.\n');
    assert.deepEqual(readdirSync(dir), ['SCOPE.md']);
    assert.equal(res.json.scopeNote, null, 'the scope exists, so nothing is announced as missing');
  } finally {
    await close();
  }
});

test('scopeText with an EXISTING SCOPE.md is refused, the file is byte-for-byte unchanged, and no project is created', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('existing');
    const original = Buffer.from([0x23, 0x20, 0x6d, 0x69, 0x6e, 0x65, 0x0d, 0x0a, 0xc3, 0xa9, 0x00, 0xff]);
    writeFileSync(join(dir, 'SCOPE.md'), original);
    const res = await call(port, 'POST', '/projects', { name: 'p', dir, scopeText: 'overwrite me' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /already exists.*never overwrites/);
    assert.ok(readFileSync(join(dir, 'SCOPE.md')).equals(original), 'the existing file must be byte-for-byte unchanged');
    assert.deepEqual(readdirSync(dir), ['SCOPE.md']);
    assert.equal(listProjects(db).length, 0, 'not even the project row');
    // ...and without scopeText the same directory is fine: the existing document simply becomes the project's.
    const ok = await call(port, 'POST', '/projects', { name: 'p', dir });
    assert.equal(ok.status, 201);
    assert.ok(readFileSync(join(dir, 'SCOPE.md')).equals(original));
  } finally {
    await close();
  }
});

test('a scope write that fails rolls the project row back and leaves no file behind (row and file are made together or not at all)', () => {
  const db = openDb(':memory:');
  const dir = freshDir('rollback');
  assert.throws(
    () =>
      createProjectInDir(db, { name: 'p', dir, scopeText: 'S' }, stateDir, {
        linkSync: () => {
          throw new Error('disk on fire');
        },
      }),
    /disk on fire/
  );
  assert.equal(listProjects(db).length, 0, 'the row was rolled back');
  assert.deepEqual(readdirSync(dir), [], 'the temp file was removed and no SCOPE.md exists');
});

// The order matters in the OTHER direction too: when the row cannot be written
// (a spend cap under the floor, refused by createProject itself), no SCOPE.md
// may have been dropped into the owner's folder first.
test('a failed row write leaves no SCOPE.md in the owner\'s folder (row first, file second)', () => {
  const db = openDb(':memory:');
  const dir = freshDir('rowfails');
  assert.throws(() => createProjectInDir(db, { name: 'p', dir, scopeText: 'S', maxSpendUsd: 0.001 }, stateDir));
  assert.equal(listProjects(db).length, 0);
  assert.deepEqual(readdirSync(dir), [], 'no file was stranded');
});

// ---- 20A follow-up: the SCOPE.md race, and one project per directory ----

test('a SCOPE.md that appears AFTER the pre-check is never overwritten: the create is refused, the row rolled back, the file byte-for-byte unchanged', () => {
  const db = openDb(':memory:');
  const dir = freshDir('race');
  const theirs = Buffer.from('# written by the owner in the race window\r\n\xff', 'latin1');
  assert.throws(
    () =>
      createProjectInDir(db, { name: 'p', dir, scopeText: 'the form\'s text' }, stateDir, {
        // Runs after the pre-check has seen "absent" and after our temp file is written, before the link.
        beforeLink: () => writeFileSync(join(dir, 'SCOPE.md'), theirs),
      }),
    /already exists.*never overwrites/
  );
  assert.ok(readFileSync(join(dir, 'SCOPE.md')).equals(theirs), 'the owner\'s file must survive the race untouched');
  assert.deepEqual(readdirSync(dir), ['SCOPE.md'], 'our temp file was removed');
  assert.equal(listProjects(db).length, 0, 'the row was rolled back');
});

test('a second project on a directory that already holds one is refused, naming the existing project by name and id -- through the route', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('dup');
    const first = await call(port, 'POST', '/projects', { name: 'First', dir });
    assert.equal(first.status, 201);
    const second = await call(port, 'POST', '/projects', { name: 'Second', dir, scopeText: 'S' });
    assert.equal(second.status, 400);
    assert.match(second.json.error, /already the directory of project "First"/);
    assert.ok(second.json.error.includes(first.json.id));
    assert.ok(!second.json.error.includes('\n'));
    assert.equal(listProjects(db).length, 1);
    assert.deepEqual(readdirSync(dir), [], 'the refused create wrote no SCOPE.md');
  } finally {
    await close();
  }
});

test('the same directory spelled differently is the same directory: trailing separator always, and case on Windows', async () => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('spell');
    assert.equal((await call(port, 'POST', '/projects', { name: 'A', dir })).status, 201);
    const trailing = await call(port, 'POST', '/projects', { name: 'B', dir: dir + '/' });
    assert.equal(trailing.status, 400, JSON.stringify(trailing.json));
    if (process.platform === 'win32') {
      const swapped = await call(port, 'POST', '/projects', { name: 'C', dir: dir.toUpperCase() });
      assert.equal(swapped.status, 400, 'the same folder in another case is one folder on Windows');
    }
    assert.equal(listProjects(db).length, 1);
  } finally {
    await close();
  }
});

test('normaliseDir folds case only where the filesystem does, and never leaves a trailing separator', () => {
  const sep = process.platform === 'win32' ? String.fromCharCode(92) : '/';
  const base = process.platform === 'win32' ? 'C:' + sep + 'Foo' : '/tmp/Foo';
  assert.equal(normaliseDir(base + sep, process.platform), normaliseDir(base, process.platform), 'trailing separator');
  assert.equal(normaliseDir(base.toLowerCase(), 'win32'), normaliseDir(base, 'win32'), 'win32 folds case');
  assert.notEqual(normaliseDir(base.toLowerCase(), 'linux'), normaliseDir(base, 'linux'), 'other platforms do not');
});

test('databases that already hold duplicates keep them: the new rule only stops a new one, and touches no existing row', () => {
  const db = openDb(':memory:');
  const dir = freshDir('legacy');
  const a = createProject(db, { name: 'old-a', workspaceRoot: dir, scopePath: join(dir, 'SCOPE.md') });
  const b = createProject(db, { name: 'old-b', workspaceRoot: dir, scopePath: join(dir, 'SCOPE.md') });
  assert.throws(() => createProjectInDir(db, { name: 'new', dir }, stateDir), /already the directory of project "old-a"/);
  const after = listProjects(db);
  assert.deepEqual(after.map((p) => p.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(after.map((p) => p.updatedAt).sort(), [a.updatedAt, b.updatedAt].sort());
});

test('the CLI refuses a second project on one directory too (one shared creation function)', async () => {
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const run = (args: string[]) => {
    const proc = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    let stderr = '';
    proc.onStdout((c) => (stdout += c));
    proc.onStderr((c) => (stderr += c));
    return proc.wait().then((r) => ({ code: r.code, stdout, stderr }));
  };
  const dir = freshDir('cli-dup');
  const state = freshDir('cli-dup-state');
  const first = await run(['project', 'create', '--name', 'One', '--dir', dir, '--state-dir', state, '--json']);
  assert.equal(first.code, 0, first.stderr);
  const second = await run(['project', 'create', '--name', 'Two', '--dir', dir, '--state-dir', state, '--json']);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already the directory of project "One"/);
  assert.equal(second.stderr.trim().split('\n').length, 1);
});

// ---- 20A review fixes ----

import { symlinkSync } from 'node:fs';

function junctionTo(target: string, label: string): string | null {
  const link = join(freshDir(label), 'link');
  try {
    symlinkSync(target, link, 'junction');
    return link;
  } catch {
    return null;
  }
}

test('POST /projects refuses a junction to the home directory or to the state directory, and case/8.3-style respellings of the home directory -- nothing written', async (t) => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const toHome = junctionTo(homedir(), 'jhome');
    const toState = junctionTo(stateDir, 'jstate');
    if (!toHome || !toState) return t.skip('COULD NOT create a junction on this machine -- the junction spelling is UNTESTED here');
    const home = await call(port, 'POST', '/projects', { name: 'p', dir: toHome, scopeText: 'S' });
    assert.equal(home.status, 400, JSON.stringify(home.json));
    assert.match(home.json.error, /home directory/);
    const state = await call(port, 'POST', '/projects', { name: 'p', dir: toState, scopeText: 'S' });
    assert.equal(state.status, 400, JSON.stringify(state.json));
    assert.match(state.json.error, /state directory/);
    if (process.platform === 'win32') {
      const recased = await call(port, 'POST', '/projects', { name: 'p', dir: homedir().toLowerCase() });
      assert.equal(recased.status, 400);
      assert.match(recased.json.error, /home directory/);
    }
    const inside = join(stateDir, 'inner');
    mkdirSync(inside);
    const insideRes = await call(port, 'POST', '/projects', { name: 'p', dir: inside });
    assert.equal(insideRes.status, 400);
    assert.match(insideRes.json.error, /inside Magarine's own state directory/);
    assert.equal(listProjects(db).length, 0);
  } finally {
    await close();
  }
});

test('a junction to another project\'s folder is that project\'s folder: the second project is refused, naming the first', async (t) => {
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const dir = freshDir('jdup');
    const link = junctionTo(dir, 'jdup-link');
    if (!link) return t.skip('COULD NOT create a junction on this machine -- the junction spelling is UNTESTED here');
    assert.equal((await call(port, 'POST', '/projects', { name: 'Real', dir })).status, 201);
    const second = await call(port, 'POST', '/projects', { name: 'Linked', dir: link });
    assert.equal(second.status, 400, JSON.stringify(second.json));
    assert.match(second.json.error, /already the directory of project "Real"/);
    assert.equal(listProjects(db).length, 1);
  } finally {
    await close();
  }
});

test('the wx fallback (no hard links): creates the file when absent, refuses and leaves an existing file untouched, and removes the half-written file it made when the write fails', () => {
  const noLinks = () => {
    throw Object.assign(new Error('no hard links here'), { code: 'EPERM' });
  };
  // fresh
  const db1 = openDb(':memory:');
  const fresh = freshDir('wx-fresh');
  createProjectInDir(db1, { name: 'p', dir: fresh, scopeText: 'via wx' }, stateDir, { linkSync: noLinks });
  assert.equal(readFileSync(join(fresh, 'SCOPE.md'), 'utf8'), 'via wx');
  assert.deepEqual(readdirSync(fresh), ['SCOPE.md'], 'no temp file left');
  // existing (appears in the race window)
  const db2 = openDb(':memory:');
  const raced = freshDir('wx-raced');
  assert.throws(
    () =>
      createProjectInDir(db2, { name: 'p', dir: raced, scopeText: 'x' }, stateDir, {
        linkSync: noLinks,
        beforeLink: () => writeFileSync(join(raced, 'SCOPE.md'), 'theirs'),
      }),
    /already exists.*never overwrites/
  );
  assert.equal(readFileSync(join(raced, 'SCOPE.md'), 'utf8'), 'theirs');
  assert.equal(listProjects(db2).length, 0);
  // the write fails after the exclusive open: the file is OURS, so it goes
  const db3 = openDb(':memory:');
  const failing = freshDir('wx-fail');
  assert.throws(
    () =>
      createProjectInDir(db3, { name: 'p', dir: failing, scopeText: 'x' }, stateDir, {
        linkSync: noLinks,
        writeFd: (fd) => {
          writeFileSync(fd, 'half'); // a partial write reaches the disk...
          throw new Error('disk full'); // ...and then it fails
        },
      }),
    /disk full/
  );
  assert.deepEqual(readdirSync(failing), [], 'the partial SCOPE.md is removed, not left to block every later create');
  assert.equal(listProjects(db3).length, 0);
  // ...and a later create in the same folder now works.
  createProjectInDir(db3, { name: 'p', dir: failing, scopeText: 'ok' }, stateDir, { linkSync: noLinks });
  assert.equal(readFileSync(join(failing, 'SCOPE.md'), 'utf8'), 'ok');
});

test('on Windows a rooted path with no drive is refused in one sentence asking for a drive letter or a UNC share', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const db = openDb(':memory:');
  const { port, close } = await startServer(db);
  try {
    const res = await call(port, 'POST', '/projects', { name: 'p', dir: String.fromCharCode(92) + 'foo' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /drive letter.*UNC share/);
    assert.ok(!res.json.error.includes('\n'));
  } finally {
    await close();
  }
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from '../process.ts';
import { openDb } from '../db/index.ts';
import { FakeAdapter } from '../adapters/fakeAdapter.ts';
import { checkDaemonFile, daemonFilePath, type DaemonFileInfo } from '../daemon.ts';
import { probeDaemonHealth } from '../daemonClient.ts';
import { createProject, createTicket, getTicket } from '../store.ts';
import { buildInbox } from './inbox.ts';
import { testTempRoot, pinnedFakeEnv } from '../testSupport.ts';
import {
  closeWindowGracefully,
  realAppSeams,
  resolveWindowBrowser,
  runApp,
  windowClosedLine,
  windowSpec,
  type AppOptions,
  type AppSeams,
  type WindowChild,
  type WindowSpec,
} from './app.ts';

// Batch 17 Role A item 4: `magarine app`. Everything that reaches the outside
// world goes through `AppSeams`, so these tests prove the lifecycle and the
// security line without a browser: the token is in NO spawn argument, no
// stdout, no stderr; the window closing never stops the daemon; Ctrl+C stops
// the daemon FIRST and only then closes the window; attach mode never enters
// serve().

const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));
const testRoot = testTempRoot('app');
after(testRoot.cleanup);

const WIN_ENV = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LocalAppData: 'C:\\LA' };

// ---- browser resolution --------------------------------------------------------

test('browser order: --browser, then MAGARINE_BROWSER, then Chrome, then Edge -- and the strategy says which', () => {
  const everything = { exists: () => true, env: { ...WIN_ENV, MAGARINE_BROWSER: 'C:\\mine\\env.exe' }, platform: 'win32' as const };
  const flag = resolveWindowBrowser({ browserFlag: 'C:\\mine\\flag.exe' }, everything);
  assert.ok('found' in flag && flag.found.executable === 'C:\\mine\\flag.exe' && flag.found.strategy === '--browser');
  const env = resolveWindowBrowser({}, everything);
  assert.ok('found' in env && env.found.executable === 'C:\\mine\\env.exe' && env.found.strategy === 'MAGARINE_BROWSER');
  const chrome = resolveWindowBrowser({}, { ...everything, env: WIN_ENV });
  assert.ok('found' in chrome && chrome.found.kind === 'chrome' && /chrome\.exe$/i.test(chrome.found.executable));
  const edgeOnly = resolveWindowBrowser({}, { exists: (p) => /msedge/i.test(p), env: WIN_ENV, platform: 'win32' });
  assert.ok('found' in edgeOnly && edgeOnly.found.kind === 'edge');
  assert.equal(edgeOnly.found.strategy, 'edge, with sign-in and sync disabled');
});

test('with no browser found it reports every place it looked; a missing --browser path is not silently replaced', () => {
  const none = resolveWindowBrowser({}, { exists: () => false, env: WIN_ENV, platform: 'win32' });
  assert.ok('none' in none);
  assert.ok(none.looked.length >= 4 && none.looked.some((p) => /chrome\.exe/i.test(p)) && none.looked.some((p) => /msedge\.exe/i.test(p)));
  const badFlag = resolveWindowBrowser({ browserFlag: 'C:\\nope.exe' }, { exists: () => false, env: WIN_ENV, platform: 'win32' });
  assert.ok('none' in badFlag && badFlag.looked.length === 1, 'an explicit override that does not exist is reported, not quietly swapped for Chrome');
});

test('the window command line: the launch code in the fragment, a profile under the state dir, the fixed flags -- and Edge ALWAYS carries the two sign-in/sync flags', () => {
  const code = 'c'.repeat(64);
  const chrome = windowSpec({ executable: 'chrome.exe', kind: 'chrome', strategy: 'chrome' }, 'S:\\state', 4321, code);
  assert.deepEqual(chrome.args, [
    `--app=http://127.0.0.1:4321/#launch=${code}`,
    `--user-data-dir=${join('S:\\state', 'window')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--hide-crash-restore-bubble',
    '--window-size=1400,900',
  ]);
  const edge = windowSpec({ executable: 'msedge.exe', kind: 'edge', strategy: 'edge' }, 'S:\\state', 4321, code);
  assert.ok(edge.args.includes('--disable-sync') && edge.args.includes('--disable-features=msImplicitSignin'));
  assert.ok(!chrome.args.includes('--disable-sync'));
});

// ---- graceful close -----------------------------------------------------------------

function fakeChild(pid = 4242): WindowChild & { exit(code?: number): void; killed: boolean } {
  let resolve!: (r: { code: number | null }) => void;
  const exited = new Promise<{ code: number | null }>((r) => (resolve = r));
  const child = { pid, exited, killed: false, kill() { child.killed = true; resolve({ code: null }); }, exit(code = 0) { resolve({ code }); } };
  return child;
}

test('a graceful close asks first, waits, and kills only when the window did not go', async () => {
  const polite = fakeChild();
  const askedPolite: number[] = [];
  const outcome = await closeWindowGracefully(polite, { askWindowClose: async (pid) => { askedPolite.push(pid); polite.exit(); } }, 50);
  assert.equal(outcome, 'closed');
  assert.deepEqual(askedPolite, [4242]);
  assert.equal(polite.killed, false, 'a window that closed when asked is never killed');

  const stubborn = fakeChild(7);
  const started = Date.now();
  const askedStubborn: number[] = [];
  const outcome2 = await closeWindowGracefully(stubborn, { askWindowClose: async (pid) => { askedStubborn.push(pid); } }, 60);
  assert.equal(outcome2, 'killed');
  assert.deepEqual(askedStubborn, [7], 'it asked first');
  assert.equal(stubborn.killed, true);
  assert.ok(Date.now() - started >= 55, 'and waited the full patience before killing');
});

// ---- owned mode --------------------------------------------------------------------------

interface Rig {
  stateDir: string;
  db: ReturnType<typeof openDb>;
  events: string[];
  said: string[];
  errors: string[];
  spawned: WindowSpec[];
  child: ReturnType<typeof fakeChild>;
  seams: AppSeams;
  opts: AppOptions;
  done: Promise<void>;
  settled(): boolean;
  daemon(): DaemonFileInfo;
  listening(): { port: number };
  toasts: Array<{ title: string; body: string }>;
}

async function ownedRig(configure: { seams?: Partial<AppSeams>; inFlight?: number; adapter?: FakeAdapter; notify?: boolean } = {}): Promise<Rig> {
  const stateDir = mkdtempSync(join(testRoot.root, 'owned-'));
  const db = openDb(':memory:');
  const events: string[] = [];
  const said: string[] = [];
  const errors: string[] = [];
  const spawned: WindowSpec[] = [];
  const child = fakeChild();
  const toasts: Array<{ title: string; body: string }> = [];
  let listening: { port: number } | undefined;
  const base = realAppSeams({
    raiseToast: async (t) => (toasts.push(t), true),
    findLiveDaemon: async () => undefined,
    stateDir,
    countInFlight: () => configure.inFlight ?? 0,
    say: (human) => said.push(human),
    sayError: (line) => errors.push(line),
  });
  const seams: AppSeams = {
    ...base,
    serve: async (o) => {
      await base.serve(o);
      events.push('daemon-down');
    },
    spawnWindow: (spec) => {
      spawned.push(spec);
      events.push('spawned');
      return child;
    },
    askWindowClose: async () => {
      events.push('close-asked');
      child.exit();
    },
    exists: () => true,
    env: WIN_ENV,
    platform: 'win32',
    ...configure.seams,
  };
  const opts: AppOptions = {
    stateDir,
    serveOptions: () => ({
      db,
      dbPath: ':memory:',
      stateDir,
      adapter: configure.adapter ?? new FakeAdapter(),
      maxParallelWorkers: 2,
      artifactsDir: join(stateDir, 'artifacts'),
      tickIntervalMs: 20,
    }),
    onListening: (info) => {
      listening = info;
      events.push('listening');
    },
    onStopped: () => {},
    closeTimeoutMs: 300,
    notify: configure.notify,
  };
  let isSettled = false;
  const done = runApp(opts, seams).finally(() => (isSettled = true));
  const deadline = Date.now() + 5000;
  while (!listening && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(listening, 'the daemon never started listening');
  return {
    stateDir, db, events, said, errors, spawned, child, seams, opts, done,
    settled: () => isSettled,
    daemon: () => JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo,
    listening: () => listening!,
    toasts,
  };
}

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), `timed out waiting for ${what}`);
}

async function stopOwned(r: Rig): Promise<void> {
  process.emit('SIGINT');
  await r.done;
  rmSync(r.stateDir, { recursive: true, force: true });
}

test('owned mode with no live daemon: serve is entered, the listening line is printed, and the window is spawned at the launch URL with a profile under the state dir', async () => {
  const r = await ownedRig();
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    assert.deepEqual(r.events.slice(0, 2), ['listening', 'spawned'], 'the daemon is up BEFORE the window opens');
    const [spec] = r.spawned;
    assert.match(spec!.args[0]!, new RegExp(`^--app=http://127\\.0\\.0\\.1:${r.listening().port}/#launch=[0-9a-f]{64}$`));
    assert.ok(spec!.args.includes(`--user-data-dir=${join(r.stateDir, 'window')}`));
    assert.match(spec!.executable, /chrome\.exe$/i, 'Chrome first');
    assert.ok(r.said.some((l) => l.startsWith('window: chrome')), 'the strategy is reported');
  } finally {
    await stopOwned(r);
  }
});

test('THE SECURITY LINE: the real token (read from daemon.json) is in no spawn argument, no stdout, no stderr -- and the code in the URL is a live one-time code that is NOT the token', async () => {
  const r = await ownedRig();
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    const token = r.daemon().token;
    assert.match(token, /^[0-9a-f]{64}$/, 'a real token, not a placeholder');
    const argv = JSON.stringify(r.spawned);
    assert.ok(!argv.includes(token), 'the token must not appear in any spawn argument');
    assert.ok(!r.said.join('\n').includes(token) && !r.errors.join('\n').includes(token), 'nor in anything the host says');

    // The code in the URL is real: it exchanges for the token exactly once.
    const code = /#launch=([0-9a-f]{64})/.exec(r.spawned[0]!.args[0]!)![1]!;
    assert.notEqual(code, token);
    const exchange = () =>
      fetch(`http://127.0.0.1:${r.listening().port}/launch-code/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const first = await exchange();
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { token: string }).token, token);
    assert.equal((await exchange()).status, 404);
  } finally {
    await stopOwned(r);
  }
});

test('closing the WINDOW never stops the daemon: the line is printed, the daemon keeps ticking, and a fake run goes all the way to DONE AFTER the child exits', async () => {
  const r = await ownedRig();
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    r.child.exit(); // the person closes the window
    await waitFor(() => r.said.some((l) => l.startsWith('window closed')), 'the window-closed line');
    assert.equal(r.said.filter((l) => l.startsWith('window closed'))[0], windowClosedLine(0));
    assert.equal(windowClosedLine(0), 'window closed; the daemon is still running -- `magarine app` reopens the window, Ctrl+C here stops the daemon');
    assert.equal(r.settled(), false, 'the host is still running: its lifetime is the daemon\'s');

    // Prove the daemon is still doing work with the window gone.
    const dir = join(r.stateDir, 'project');
    mkdirSync(dir, { recursive: true });
    const project = createProject(r.db, { name: 'p', workspaceRoot: dir, scopePath: join(dir, 'SCOPE.md') });
    const ticket = createTicket(r.db, { projectId: project.id, title: 'after the window closed', workspaceType: 'NONE' });
    await waitFor(() => getTicket(r.db, ticket.id)!.status === 'DONE', 'a run to finish after the window closed', 8000);
    assert.equal(r.settled(), false);
  } finally {
    await stopOwned(r);
  }
});

test('the window-closed line counts what is in flight, and drops the parenthesis when nothing is', async () => {
  assert.equal(windowClosedLine(2), 'window closed; the daemon is still running (2 tasks in flight) -- `magarine app` reopens the window, Ctrl+C here stops the daemon');
  assert.match(windowClosedLine(1), /\(1 task in flight\)/);
  const r = await ownedRig({ inFlight: 3 });
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    r.child.exit();
    await waitFor(() => r.said.some((l) => l.startsWith('window closed')), 'the line');
    assert.match(r.said.find((l) => l.startsWith('window closed'))!, /\(3 tasks in flight\)/);
  } finally {
    await stopOwned(r);
  }
});

test('Ctrl+C in owned mode stops the daemon FIRST, then closes the window -- and says nothing about a "window closed" that the host itself caused', async () => {
  const r = await ownedRig();
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    process.emit('SIGINT');
    await r.done;
    assert.deepEqual(r.events.filter((e) => e === 'daemon-down' || e === 'close-asked'), ['daemon-down', 'close-asked'], 'daemon down, THEN the window asked to close');
    assert.equal(r.child.killed, false, 'the window closed when asked, so it was not killed');
    assert.ok(!r.said.some((l) => l.startsWith('window closed')), 'the host closing its own window is not announced as the person closing it');
  } finally {
    rmSync(r.stateDir, { recursive: true, force: true });
  }
});

test('with no browser found: the address, `magarine token` and where it looked are printed, nothing is spawned, and the daemon is UP', async () => {
  const r = await ownedRig({ seams: { exists: () => false } });
  try {
    await waitFor(() => r.said.some((l) => l.startsWith('no browser found')), 'the no-browser line');
    const line = r.said.find((l) => l.startsWith('no browser found'))!;
    assert.ok(line.includes(`http://127.0.0.1:${r.listening().port}/`), 'the address');
    assert.ok(line.includes('magarine token'));
    assert.match(line, /looked for: .*chrome\.exe.*msedge\.exe/i);
    assert.deepEqual(r.spawned, []);
    const health = await fetch(`http://127.0.0.1:${r.listening().port}/health`, { headers: { Authorization: `Bearer ${r.daemon().token}` } });
    assert.equal(health.status, 200, 'the daemon is up and usable in any browser');
    assert.ok(!r.said.join('\n').includes(r.daemon().token));
  } finally {
    await stopOwned(r);
  }
});

test('a window that cannot be started is said out loud and leaves the daemon running', async () => {
  const dead: WindowChild = { pid: 0, exited: Promise.resolve({ code: null, error: 'spawn chrome.exe ENOENT' }), kill() {} };
  const r = await ownedRig({ seams: { spawnWindow: () => dead } });
  try {
    await waitFor(() => r.errors.length > 0, 'the error line');
    assert.match(r.errors[0]!, /could not open the window: spawn chrome\.exe ENOENT/);
    assert.equal(r.settled(), false);
  } finally {
    await stopOwned(r);
  }
});

// ---- attach mode ---------------------------------------------------------------------------

async function elsewhereDaemon(): Promise<{ stateDir: string; info: DaemonFileInfo; stop(): Promise<void> }> {
  const stateDir = mkdtempSync(join(testRoot.root, 'elsewhere-'));
  const proc = spawnManaged({ env: pinnedFakeEnv(), executable: process.execPath, args: [cliPath, 'serve', '--state-dir', stateDir, '--tick-interval', '0.5', '--json'] });
  let stdout = '';
  proc.onStdout((c) => (stdout += c));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !stdout.includes('{')) await new Promise((resolve) => setTimeout(resolve, 20));
  const info = JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo;
  return {
    stateDir,
    info,
    async stop() {
      await proc.stop(200);
      await proc.wait();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function attachSeams(stateDir: string, extra: Partial<AppSeams>, log: { said: string[]; errors: string[]; spawned: WindowSpec[]; events: string[] }, child: ReturnType<typeof fakeChild>): AppSeams {
  const base = realAppSeams({
    raiseToast: async () => true,
    findLiveDaemon: async () => {
      const check = await checkDaemonFile(stateDir, probeDaemonHealth);
      return check.status === 'live' ? check.info : undefined;
    },
    stateDir,
    countInFlight: () => 0,
    say: (h) => log.said.push(h),
    sayError: (l) => log.errors.push(l),
  });
  return {
    ...base,
    serve: async () => {
      log.events.push('SERVE-ENTERED');
      throw new Error('attach mode must never enter serve()');
    },
    spawnWindow: (spec) => {
      log.spawned.push(spec);
      return child;
    },
    askWindowClose: async () => {
      log.events.push('close-asked');
      child.exit();
    },
    exists: () => true,
    env: WIN_ENV,
    platform: 'win32',
    ...extra,
  };
}

function attachOpts(stateDir: string): AppOptions {
  return {
    stateDir,
    serveOptions: () => {
      throw new Error('attach mode must not even build serve options');
    },
    onListening: () => {},
    onStopped: () => {},
    closeTimeoutMs: 300,
  };
}

test('attach mode: a live daemon is never re-served or touched -- a code is minted, the window spawned, and the host exits with NO output when the window closes', async () => {
  const d = await elsewhereDaemon();
  try {
    const log = { said: [] as string[], errors: [] as string[], spawned: [] as WindowSpec[], events: [] as string[] };
    const child = fakeChild();
    const done = runApp(attachOpts(d.stateDir), attachSeams(d.stateDir, {}, log, child));
    await waitFor(() => log.spawned.length === 1, 'the window spawn');
    assert.deepEqual(log.events, [], 'serve() was never entered');
    assert.match(log.spawned[0]!.args[0]!, new RegExp(`^--app=http://127\\.0\\.0\\.1:${d.info.port}/#launch=[0-9a-f]{64}$`));
    assert.ok(!JSON.stringify(log.spawned).includes(d.info.token), 'the token is in no spawn argument');
    child.exit();
    await done;
    const said = log.said.filter((l) => !l.startsWith('window:'));
    assert.deepEqual(said, [], 'closing the window in attach mode prints nothing');
    const health = await fetch(`http://127.0.0.1:${d.info.port}/health`, { headers: { Authorization: `Bearer ${d.info.token}` } });
    assert.equal(health.status, 200, 'the daemon it attached to is untouched');
  } finally {
    await d.stop();
  }
});

test('attach mode, Ctrl+C: the window is closed, the line says the daemon (with its pid) started elsewhere keeps running, and the daemon is untouched', async () => {
  const d = await elsewhereDaemon();
  try {
    const log = { said: [] as string[], errors: [] as string[], spawned: [] as WindowSpec[], events: [] as string[] };
    const child = fakeChild();
    let interrupt!: () => void;
    const done = runApp(attachOpts(d.stateDir), attachSeams(d.stateDir, { onInterrupt: (h) => { interrupt = h; return () => {}; } }, log, child));
    await waitFor(() => log.spawned.length === 1, 'the window spawn');
    interrupt();
    await done;
    assert.deepEqual(log.events, ['close-asked']);
    assert.ok(log.said.includes(`window closed; the daemon (pid ${d.info.pid}) started elsewhere keeps running`), log.said.join(' | '));
    const health = await fetch(`http://127.0.0.1:${d.info.port}/health`, { headers: { Authorization: `Bearer ${d.info.token}` } });
    assert.equal(health.status, 200);
  } finally {
    await d.stop();
  }
});

test('attach mode with no browser: prints the address, `magarine token` and where it looked, spawns nothing, and leaves the daemon alone', async () => {
  const d = await elsewhereDaemon();
  try {
    const log = { said: [] as string[], errors: [] as string[], spawned: [] as WindowSpec[], events: [] as string[] };
    await runApp(attachOpts(d.stateDir), attachSeams(d.stateDir, { exists: () => false }, log, fakeChild()));
    assert.deepEqual(log.spawned, []);
    assert.match(log.said[0]!, new RegExp(`no browser found .*http://127\\.0\\.0\\.1:${d.info.port}/.*magarine token`));
    assert.deepEqual(log.events, [], 'serve() was not entered');
  } finally {
    await d.stop();
  }
});

// ---- item 4b: the host raises the Needs You toast ---------------------------------------

async function needsYouTicket(r: Rig, title: string): Promise<string> {
  const dir = join(r.stateDir, 'project');
  mkdirSync(dir, { recursive: true });
  const project = createProject(r.db, { name: 'p', workspaceRoot: dir, scopePath: join(dir, 'SCOPE.md') });
  return createTicket(r.db, { projectId: project.id, title, workspaceType: 'NONE' }).id;
}

test('owned mode raises ONE toast, off the real /events stream, when a run needs the owner -- with the ticket title, and none for a run that just succeeds', async () => {
  const adapter = new FakeAdapter();
  const r = await ownedRig({ adapter });
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    const okTicket = await needsYouTicket(r, 'a task that just succeeds');
    adapter.setScript(okTicket, { kind: 'succeed' });
    const blocked = createTicket(r.db, { projectId: getTicket(r.db, okTicket)!.projectId, title: 'Pick the platform', workspaceType: 'NONE' });
    adapter.setScript(blocked.id, { kind: 'needs_user_decision', blockers: ['ios or android?'] });
    await waitFor(() => r.toasts.length >= 1, 'a toast', 8000);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let any wrongly-raised second toast land
    assert.equal(r.toasts.length, 1, 'one qualifying event, one toast; the successful run raised none');
    assert.equal(r.toasts[0]!.title, 'Magarine needs you');
    assert.ok(r.toasts[0]!.body.startsWith('Pick the platform\n'), r.toasts[0]!.body);
    // The toast says exactly what the inbox says about the same request.
    const inboxLine = buildInbox(r.db, getTicket(r.db, blocked.id)!.projectId).find((i) => i.ticketId === blocked.id)!.message;
    assert.equal(r.toasts[0]!.body, `Pick the platform
${inboxLine}`);
    assert.ok(!JSON.stringify(r.toasts).includes(r.daemon().token), 'the token is never in a toast');
  } finally {
    await stopOwned(r);
  }
});

test('--no-notify: the same needs-you run raises no toast, and the notifier is never started', async () => {
  let started = 0;
  const adapter = new FakeAdapter();
  const r = await ownedRig({ adapter, notify: false, seams: { startNotifications: async () => void started++ } });
  try {
    await waitFor(() => r.spawned.length === 1, 'the window spawn');
    const id = await needsYouTicket(r, 'Pick the platform');
    adapter.setScript(id, { kind: 'needs_user_decision', blockers: ['x'] });
    await waitFor(() => getTicket(r.db, id)!.status === 'BLOCKED', 'the run to block', 8000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(started, 0);
    assert.deepEqual(r.toasts, []);
  } finally {
    await stopOwned(r);
  }
});

test('by default the notifier starts in BOTH modes (one code path), and stops with the host', async () => {
  const r = await ownedRig();
  let ownedSignal: AbortSignal | undefined;
  const owned = await ownedRig({ seams: { startNotifications: async (signal) => void (ownedSignal = signal) } });
  try {
    await waitFor(() => ownedSignal !== undefined, 'the owned-mode notifier start');
    assert.equal(ownedSignal!.aborted, false);
  } finally {
    await stopOwned(owned);
    await stopOwned(r);
  }
  assert.equal(ownedSignal!.aborted, true, 'the notifier is stopped when the daemon stops');

  const d = await elsewhereDaemon();
  try {
    const log = { said: [] as string[], errors: [] as string[], spawned: [] as WindowSpec[], events: [] as string[] };
    const child = fakeChild();
    let attachSignal: AbortSignal | undefined;
    const done = runApp(attachOpts(d.stateDir), attachSeams(d.stateDir, { startNotifications: async (signal) => void (attachSignal = signal) }, log, child));
    await waitFor(() => attachSignal !== undefined, 'the attach-mode notifier start');
    child.exit();
    await done;
    assert.equal(attachSignal!.aborted, true, 'attach mode stops the notifier when the window closes');

    const off = attachOpts(d.stateDir);
    off.notify = false;
    let startedAgain = 0;
    const child2 = fakeChild();
    const done2 = runApp(off, attachSeams(d.stateDir, { startNotifications: async () => void startedAgain++ }, log, child2));
    await waitFor(() => log.spawned.length === 2, 'the second window spawn');
    child2.exit();
    await done2;
    assert.equal(startedAgain, 0, '--no-notify in attach mode starts nothing');
  } finally {
    await d.stop();
  }
});

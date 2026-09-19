// Batch 16 closing condition, part 1: watch a legacy project pause and be fixed.
// Usage: node walk.mjs <repoCoreDir>   (temp dirs only; never reads ~/.magarine)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const core = process.argv[2];
const cli = join(core, 'src', 'cli.ts');
const { MIGRATIONS } = await import(pathToFileURL(join(core, 'src', 'db', 'schema.ts')).href);

const T = mkdtempSync(join(tmpdir(), 'magarine-legacywalk-'));
const state = join(T, 'state');
mkdirSync(state);
const dirA = join(T, 'proj-a');
const dirB = join(T, 'proj-b');
mkdirSync(dirA);
mkdirSync(dirB);
const dbFile = join(state, 'magarine.db');
const log = (s = '') => console.log(s);
const h = (s) => log(`\n### ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (s) => s.replaceAll(T, '<T>').replaceAll(T.replaceAll('\\', '/'), '<T>').replaceAll(T.replaceAll('\\', '\\\\'), '<T>');

// --- 1. the synthetic legacy database: the REAL migrations 0001-0013 only ---
{
  const raw = new DatabaseSync(dbFile);
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
  for (const m of MIGRATIONS.slice(0, 13)) {
    raw.exec('BEGIN');
    if (m.sql) raw.exec(m.sql);
    if (m.run) m.run(raw);
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, '2026-09-13T00:00:00.000Z');
    raw.exec('COMMIT');
  }
  // A: like the owner's row -- created 13 Sep, workspace_root AND scope_path both NULL, explicit cap 3.
  // B: a directory but no scope_path (the rule after the first), explicit cap 2.
  raw.exec(`
    INSERT INTO projects (id, name, max_parallel_workers, workspace_root, scope_path, created_at, updated_at)
      VALUES ('proj_legacy_a', 'legacy-a', 3, NULL, NULL, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
    INSERT INTO projects (id, name, max_parallel_workers, workspace_root, scope_path, created_at, updated_at)
      VALUES ('proj_legacy_b', 'legacy-b', 2, '${dirB.replaceAll('\\', '/')}', NULL, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
    INSERT INTO tickets (id, project_id, title, status, kind, workspace_type, created_at, updated_at)
      VALUES ('tkt_a_manager', 'proj_legacy_a', 'Plan: legacy-a', 'OPEN', 'manager', 'NONE', '2026-09-13T00:00:01.000Z', '2026-09-13T00:00:01.000Z');
    INSERT INTO tickets (id, project_id, title, status, kind, workspace_type, created_at, updated_at)
      VALUES ('tkt_a_work', 'proj_legacy_a', 'work in a', 'OPEN', 'work', 'NONE', '2026-09-13T00:00:02.000Z', '2026-09-13T00:00:02.000Z');
    INSERT INTO tickets (id, project_id, title, status, kind, workspace_type, created_at, updated_at)
      VALUES ('tkt_b_work', 'proj_legacy_b', 'work in b', 'OPEN', 'work', 'NONE', '2026-09-13T00:00:03.000Z', '2026-09-13T00:00:03.000Z');
  `);
  raw.close();
}
const readRaw = (sql) => {
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return raw.prepare(sql).all();
  } finally {
    raw.close();
  }
};
h('0. The legacy database, BEFORE any Magarine process opens it');
log('applied migrations: ' + readRaw('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id.slice(0, 4)).join(' '));
log('projects: ' + scrub(JSON.stringify(readRaw('SELECT id, max_parallel_workers, workspace_root, scope_path FROM projects ORDER BY id'))));
log('runs before: ' + JSON.stringify(readRaw('SELECT COUNT(*) AS n FROM runs')));

// --- helpers ---
function runCli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args, '--state-dir', state], { cwd: T });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
async function show(label, args) {
  const r = await runCli(args);
  log(`$ magarine ${args.join(' ')}    # ${label}`);
  if (r.out) log(scrub(r.out).replace(/pid \d+/, 'pid <pid>'));
  if (r.err) log('[stderr] ' + scrub(r.err));
  log(`[exit ${r.code}]`);
  return r;
}
let token = '';
let port = 0;
async function api(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}
async function slotsBoth(label) {
  const st = JSON.parse((await runCli(['status', '--json'])).out);
  const board = await api('/board?project=proj_legacy_a');
  log(`slots @ ${label}: status --json => ${JSON.stringify(st.daemon.slots)}   GET /board => ${JSON.stringify(board.slots)}`);
}

// --- 2. start a REAL serve (fake adapter), machine ceiling 2 ---
h('1. Start a real `serve` (fake adapter, --max-parallel 2) on the legacy database');
const serve = spawn(
  process.execPath,
  [cli, 'serve', '--state-dir', state, '--adapter', 'fake', '--max-parallel', '2', '--tick-interval', '0.2', '--json',
   '--fake-script', 'tkt_a_manager=hang', '--fake-script', 'tkt_a_work=hang', '--fake-script', 'tkt_b_work=succeed'],
  { cwd: T }
);
let serveOut = '';
let serveErr = '';
serve.stdout.on('data', (c) => (serveOut += c));
serve.stderr.on('data', (c) => (serveErr += c));
try {
  for (let i = 0; i < 300 && !port; i++) {
    const line = serveOut.split('\n').find((l) => l.trim().startsWith('{'));
    if (line) port = JSON.parse(line).port;
    else await sleep(50);
  }
  if (!port) throw new Error('serve never listened: ' + serveErr);
  token = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8')).token; // never printed
  log('serve listening line (--json): ' + scrub(serveOut.split('\n').find((l) => l.trim().startsWith('{'))).replace(/"pid":\d+/, '"pid":<pid>').replace(/"port":\d+/, '"port":<port>'));

  await sleep(1500); // several 200ms ticks
  h('2. After ticks: did anything run? (raw db) and what state is each project in');
  log('runs: ' + JSON.stringify(readRaw('SELECT COUNT(*) AS n FROM runs')));
  log('tickets: ' + JSON.stringify(readRaw('SELECT id, status FROM tickets ORDER BY id')));
  log('projects: ' + JSON.stringify(readRaw('SELECT id, max_parallel_workers, adapter_paused_at IS NOT NULL AS paused, pause_reason FROM projects ORDER BY id')));
  log('applied migrations now: ' + readRaw('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id.slice(0, 4)).join(' '));

  h('3. The pause a human sees: board, inbox');
  for (const p of ['proj_legacy_a', 'proj_legacy_b']) {
    const b = await api(`/board?project=${p}`);
    log(`GET /board?project=${p} => pauseReason=${JSON.stringify(b.pauseReason)}`);
    log(`   pauseMessage: ${b.pauseMessage}`);
    log(`   tickets: ${JSON.stringify(b.tickets.map((t) => [t.id, t.status]))}`);
  }
  await show('inbox for legacy-a', ['inbox', '--project', 'proj_legacy_a']);
  await show('inbox for legacy-b', ['inbox', '--project', 'proj_legacy_b']);
  await show('human board for legacy-b', ['board', '--project', 'proj_legacy_b']);

  h('4. project list (text and --json readiness)');
  await show('text', ['project', 'list']);
  const pl = JSON.parse((await runCli(['project', 'list', '--json'])).out);
  log('$ magarine project list --json    # readiness only');
  log(JSON.stringify(pl.map((p) => ({ id: p.id, readiness: p.readiness })), null, 1));

  h('5. status and GET /board slots while everything is paused');
  await show('status', ['status']);
  await slotsBoth('paused');

  h('6. Fix legacy-b: `project set --dir` (no separate resume command); its worker then runs');
  await show('fix b', ['project', 'set', '--project', 'proj_legacy_b', '--dir', dirB]);
  for (let i = 0; i < 100; i++) {
    const b = await api('/board?project=proj_legacy_b');
    if (b.tickets.every((t) => t.status === 'DONE')) break;
    await sleep(100);
  }
  const bAfter = await api('/board?project=proj_legacy_b');
  log(`legacy-b after fix: pauseReason=${JSON.stringify(bAfter.pauseReason)} tickets=${JSON.stringify(bAfter.tickets.map((t) => [t.id, t.status]))}`);
  log('projects: ' + scrub(JSON.stringify(readRaw('SELECT id, adapter_paused_at IS NOT NULL AS paused, pause_reason, workspace_root, scope_path FROM projects ORDER BY id'))));
  await slotsBoth('after b fixed and finished');

  h('7. Fix legacy-a (both directory fields were NULL): manager + worker start, slots fill the ceiling');
  await show('fix a', ['project', 'set', '--project', 'proj_legacy_a', '--dir', dirA]);
  for (let i = 0; i < 100; i++) {
    const s = await api('/board?project=proj_legacy_a');
    if (s.slots.used === 2) break;
    await sleep(100);
  }
  const aAfter = await api('/board?project=proj_legacy_a');
  log(`legacy-a after fix: pauseReason=${JSON.stringify(aAfter.pauseReason)} tickets=${JSON.stringify(aAfter.tickets.map((t) => [t.id, t.status]))}`);
  await show('status', ['status']);
  await slotsBoth('two workers running');
  log('runs: ' + JSON.stringify(readRaw('SELECT ticket_id, status FROM runs ORDER BY ticket_id')));

  h('8. The data-loss check: max_parallel_workers across the 0013 -> 0014 upgrade');
  log('projects: ' + JSON.stringify(readRaw('SELECT id, max_parallel_workers FROM projects ORDER BY id')));
  log('column notnull now: ' + JSON.stringify(readRaw("SELECT name, \"notnull\" AS nn FROM pragma_table_info('projects') WHERE name = 'max_parallel_workers'")));
} finally {
  serve.kill(); // the process THIS script started, and only that one
  await sleep(500);
}
log('\n(temp dir was under the OS temp directory)');

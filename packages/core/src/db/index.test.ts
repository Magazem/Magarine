import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, runMigrations } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';
import { spawnManaged } from '../process.ts';

// Batch 6 item 5: this file's own private root under the OS temp directory
// (testSupport.ts's testTempRoot), rather than creating a prefixed directory
// directly inside the shared tmpdir() -- see that function's doc comment.
const testRoot = testTempRoot('dbindex');
after(testRoot.cleanup);

test('runMigrations is idempotent: applying twice does not error or duplicate rows', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  runMigrations(db);
  const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(
    (r) => r.id
  );
  db.close();
  assert.deepEqual(applied, [
    '0001_init',
    '0002_runs_usage_json',
    '0003_budget_fields',
    '0004_batch3_scheduler_seam',
    '0005_project_spend_cap',
    '0006_model_pinning',
    '0007_manager_kind',
    '0008_project_scope_path',
    '0009_pause_reason',
    '0010_backfill_workspace_root_from_scope_path',
    '0011_ticket_model_reason',
  ]);
});

interface Snapshot {
  appliedMigrationIds: string[];
  usageJsonInputTokens: number;
}

// See batch3Migration.test.ts's exerciseMigration0004 doc comment: all
// statement work happens here and returns plain values, with db.close()
// called before this function returns.
function exerciseMigration0002(file: string): Snapshot {
  // Simulate a DB created before usage_json existed: apply only 0001 by
  // hand, bypassing the migration runner.
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
  `);
  raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('0001_init', new Date().toISOString());
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  // usage_json now exists and is writable.
  db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','p','now','now')");
  db.prepare(
    "INSERT INTO runs (id, ticket_id, attempt, adapter, status, started_at, usage_json) VALUES ('r1','t1',1,'fake','running','now',?)"
  ).run(JSON.stringify({ inputTokens: 1 }));
  const row = db.prepare('SELECT usage_json FROM runs WHERE id = ?').get('r1') as { usage_json: string };
  const usageJsonInputTokens = JSON.parse(row.usage_json).inputTokens;

  db.close();

  return { appliedMigrationIds, usageJsonInputTokens };
}

test('a database migrated only to 0001 picks up 0002 (usage_json) on next open, without re-running 0001', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0002(file);
  } finally {
    await rmSyncResilient(dir);
  }

  assert.deepEqual(snapshot.appliedMigrationIds, [
    '0001_init',
    '0002_runs_usage_json',
    '0003_budget_fields',
    '0004_batch3_scheduler_seam',
    '0005_project_spend_cap',
    '0006_model_pinning',
    '0007_manager_kind',
    '0008_project_scope_path',
    '0009_pause_reason',
    '0010_backfill_workspace_root_from_scope_path',
    '0011_ticket_model_reason',
  ]);
  assert.equal(snapshot.usageJsonInputTokens, 1);
});

// Batch 8: before daemon mode there was only ever one process holding this
// file open. Now the daemon holds it open continuously while the CLI's own
// direct reads (board/status/inbox/activity -- reads stay direct even while
// a daemon is running) open a second, independent connection to the same
// file at any moment. This is exactly the shape that produced a real
// concurrency bug found while writing this batch's own tests (cliRouting.
// test.ts's polling loops occasionally got an empty/errored `status --json`
// read under the full suite's heavier concurrent load) -- openDb now sets
// `journal_mode = WAL` and a non-zero `busy_timeout` (see that function's
// own header comment for the full reasoning); these two tests prove each
// pragma does real, separately-attributable work, against a REAL second
// process, not a mocked one.

test('openDb sets WAL journal mode and a non-zero busy_timeout on every connection', () => {
  const dir = mkdtempSync(join(testRoot.root, 'pragmas-'));
  const file = join(dir, 'db.sqlite');
  const db = openDb(file);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
  db.close();
});

test('many rapid reads succeed with zero failures while a real second process continuously commits writes to the same file (WAL)', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'wal-reads-'));
  const file = join(dir, 'db.sqlite');
  try {
    // Seed the schema before the writer and reader both open it.
    openDb(file).close();

    const fixturePath = fileURLToPath(new URL('./writeHammerFixture.ts', import.meta.url));
    const writer = spawnManaged({ executable: process.execPath, args: [fixturePath, file, '500'] });
    let writerDone = false;
    void writer.wait().then(() => {
      writerDone = true;
    });

    const reader = openDb(file);
    let reads = 0;
    let failures = 0;
    let lastFailure: unknown;
    while (!writerDone) {
      for (let i = 0; i < 20 && !writerDone; i++) {
        try {
          reader.prepare('SELECT COUNT(*) AS c FROM tickets').get();
          reads++;
        } catch (err) {
          failures++;
          lastFailure = err;
        }
      }
      // Yield to the event loop so the writer's own exit event (and this
      // loop's own writerDone flip) can actually be delivered -- a tight
      // synchronous loop with no yield point starves libuv and the child's
      // 'exit' event never arrives.
      await new Promise((resolve) => setImmediate(resolve));
    }
    reader.close();

    assert.ok(reads > 50, `sanity: the read loop should have attempted many reads (got ${reads})`);
    assert.equal(
      failures,
      0,
      `expected zero failures with WAL + busy_timeout while a real writer process committed continuously, got ${failures} (last: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)})`
    );
  } finally {
    await rmSyncResilient(dir);
  }
});

test('busy_timeout makes a blocked write WAIT for a real second process to release the lock, rather than failing immediately', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'busy-timeout-'));
  const file = join(dir, 'db.sqlite');
  try {
    openDb(file).close();

    const holdMs = 800;
    const fixturePath = fileURLToPath(new URL('./lockHolderFixture.ts', import.meta.url));
    const holder = spawnManaged({ executable: process.execPath, args: [fixturePath, file, String(holdMs)] });

    let stdout = '';
    holder.onStdout((c) => (stdout += c));
    const deadline = Date.now() + 5000;
    while (!stdout.includes('LOCK_HELD') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(stdout.includes('LOCK_HELD'), 'the holder process should have signalled it took the write lock');

    // This connection's own write attempt below must contend with the
    // holder's -- writer-vs-writer contention, which WAL does NOT resolve
    // on its own (only busy_timeout does). It should block for roughly
    // `holdMs`, then succeed once the holder commits, rather than throwing
    // SQLITE_BUSY immediately.
    const contender = openDb(file);
    const before = Date.now();
    assert.doesNotThrow(() => {
      contender.exec('BEGIN IMMEDIATE');
    });
    const elapsedMs = Date.now() - before;
    contender.exec('COMMIT');
    contender.close();

    assert.ok(
      elapsedMs >= holdMs - 200,
      `expected the contending write to wait for roughly the holder's ${holdMs}ms, only waited ${elapsedMs}ms -- ` +
        'with busy_timeout=0 (the pre-batch-8 default) this would have thrown SQLITE_BUSY almost instantly instead'
    );

    await holder.wait();
  } finally {
    await rmSyncResilient(dir);
  }
});

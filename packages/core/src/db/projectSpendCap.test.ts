import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 6 item 5: this file's own private root under the OS temp directory
// (testSupport.ts's testTempRoot), rather than creating a prefixed directory
// directly inside the shared tmpdir() -- see that function's doc comment.
const testRoot = testTempRoot('projectspendcapmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  maxSpendUsdBeforeUpdate: number | null;
  maxSpendUsdAfterUpdate: number;
}

// See batch3Migration.test.ts's exerciseMigration0004 doc comment: all
// statement work happens here and returns plain values, with db.close()
// called before this function returns -- never leaving a `.get()` row alive
// across an `assert.*` call while the db is still open (the Windows
// file-lock EPERM this avoids).
function exerciseMigration0005(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT, usage_json TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT, project_id TEXT, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
  `);
  for (const id of ['0001_init', '0002_runs_usage_json', '0003_budget_fields', '0004_batch3_scheduler_seam']) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0005', 'pre-existing', 'now', 'now')")
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const beforeRow = db.prepare('SELECT max_spend_usd FROM projects WHERE id = ?').get('p_pre_0005') as {
    max_spend_usd: number | null;
  };
  const maxSpendUsdBeforeUpdate = beforeRow.max_spend_usd;

  db.prepare('UPDATE projects SET max_spend_usd = ? WHERE id = ?').run(10, 'p_pre_0005');
  const afterRow = db.prepare('SELECT max_spend_usd FROM projects WHERE id = ?').get('p_pre_0005') as {
    max_spend_usd: number;
  };
  const maxSpendUsdAfterUpdate = afterRow.max_spend_usd;

  db.close();

  return { appliedMigrationIds, maxSpendUsdBeforeUpdate, maxSpendUsdAfterUpdate };
}

// Upgrade test for migration 0005_project_spend_cap: a database migrated
// only up to 0004 (pre-spend-cap state) picks up 0005 on next open, and
// existing project rows get NULL (no cap), not a surprising default -- see
// db/schema.ts's migration comment for why NULL, unlike max_budget_usd, is
// the only sensible default here.
test('a database migrated only to 0001-0004 picks up 0005 (project spend cap) on next open, with existing rows defaulting to NULL (no cap)', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0005-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0005(file);
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
    // Batch 11: this snapshot re-opens a fresh :memory: db and runs every
    // migration up to whatever HEAD currently is, so it must list the two
    // that landed after 0007 too -- 0008_project_scope_path was already
    // missing here before this batch touched this file (found, not caused,
    // while fixing this test for 0009_pause_reason).
    '0008_project_scope_path',
    '0009_pause_reason',
    '0010_backfill_workspace_root_from_scope_path', '0011_ticket_model_reason', '0012_artifact_text_column', '0013_ticket_expected_artifacts',
 '0014_max_parallel_workers_nullable',
 '0015_verifier_run_kind',
  ]);
  assert.equal(snapshot.maxSpendUsdBeforeUpdate, null, 'existing project rows must get NULL (no cap), not a numeric default');
  assert.equal(snapshot.maxSpendUsdAfterUpdate, 10);
});

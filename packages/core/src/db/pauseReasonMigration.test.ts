import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 11 ruling 1: a database migrated only through 0008 (pre-pause-reason
// state) picks up 0009_pause_reason on next open, and every existing project
// row gets NULL (not paused for any reason this column tracks) -- see this
// migration's comment in db/schema.ts for why NULL, not an invented reason,
// is the only sensible default for a row this migration has never touched.

const testRoot = testTempRoot('pausereasonmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  pauseReasonBeforeSet: string | null;
  pauseReasonAfterSet: string | null;
}

function exerciseMigration0009(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5', manager_model TEXT, scope_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, model TEXT, kind TEXT NOT NULL DEFAULT 'work', result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT, usage_json TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT, project_id TEXT, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
  `);
  for (const id of [
    '0001_init',
    '0002_runs_usage_json',
    '0003_budget_fields',
    '0004_batch3_scheduler_seam',
    '0005_project_spend_cap',
    '0006_model_pinning',
    '0007_manager_kind',
    '0008_project_scope_path',
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0009', 'pre-existing', 'now', 'now')")
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const beforeRow = db.prepare('SELECT pause_reason FROM projects WHERE id = ?').get('p_pre_0009') as {
    pause_reason: string | null;
  };
  const pauseReasonBeforeSet = beforeRow.pause_reason;

  db.prepare('UPDATE projects SET pause_reason = ? WHERE id = ?').run('spend_cap', 'p_pre_0009');
  const afterRow = db.prepare('SELECT pause_reason FROM projects WHERE id = ?').get('p_pre_0009') as {
    pause_reason: string | null;
  };
  const pauseReasonAfterSet = afterRow.pause_reason;

  db.close();

  return { appliedMigrationIds, pauseReasonBeforeSet, pauseReasonAfterSet };
}

test('a database migrated only to 0001-0008 picks up 0009 (pause reason) on next open, with existing projects defaulting to NULL pause_reason', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0009-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0009(file);
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
    '0010_backfill_workspace_root_from_scope_path', '0011_ticket_model_reason', '0012_artifact_text_column', '0013_ticket_expected_artifacts',
 '0014_max_parallel_workers_nullable',
 '0015_verifier_run_kind', '0016_ticket_automatic', '0018_settings',
  ]);
  assert.equal(
    snapshot.pauseReasonBeforeSet,
    null,
    'existing project rows must get NULL pause_reason, not an invented reason'
  );
  assert.equal(snapshot.pauseReasonAfterSet, 'spend_cap');
});

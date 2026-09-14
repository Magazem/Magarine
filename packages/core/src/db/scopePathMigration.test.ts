import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 11 (Role R item 1): a database migrated only through 0007 (pre-scope
// state) picks up 0008_project_scope_path on next open, and every existing
// project row gets NULL (no scope file), not an invented default path -- see
// this migration's comment in db/schema.ts for why no default location is
// computed here.

const testRoot = testTempRoot('scopepathmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  scopePathBeforeSet: string | null;
  scopePathAfterSet: string | null;
}

function exerciseMigration0008(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5', manager_model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0008', 'pre-existing', 'now', 'now')")
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const beforeRow = db.prepare('SELECT scope_path FROM projects WHERE id = ?').get('p_pre_0008') as {
    scope_path: string | null;
  };
  const scopePathBeforeSet = beforeRow.scope_path;

  db.prepare('UPDATE projects SET scope_path = ? WHERE id = ?').run('/tmp/some/SCOPE.md', 'p_pre_0008');
  const afterRow = db.prepare('SELECT scope_path FROM projects WHERE id = ?').get('p_pre_0008') as {
    scope_path: string | null;
  };
  const scopePathAfterSet = afterRow.scope_path;

  db.close();

  return { appliedMigrationIds, scopePathBeforeSet, scopePathAfterSet };
}

test('a database migrated only to 0001-0007 picks up 0008 (project scope path) on next open, with existing projects defaulting to NULL scope_path', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0008-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0008(file);
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
    // Batch 11 (Role Q): 0009_pause_reason lands after this file's own
    // migration, so a fresh open picks it up too -- this snapshot re-opens
    // at whatever HEAD currently is, not frozen at 0008. Same for batch 12's
    // 0010.
    '0009_pause_reason',
    '0010_backfill_workspace_root_from_scope_path', '0011_ticket_model_reason',
  ]);
  assert.equal(
    snapshot.scopePathBeforeSet,
    null,
    'existing project rows must get NULL scope_path, not an invented default location'
  );
  assert.equal(snapshot.scopePathAfterSet, '/tmp/some/SCOPE.md');
});

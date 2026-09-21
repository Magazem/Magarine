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
const testRoot = testTempRoot('budgetmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  projectMaxBudgetUsd: number;
  ticketOverrideAfterUpdate: number;
  secondTicketOverrideDefault: number | null;
}

// See batch3Migration.test.ts's exerciseMigration0004 doc comment: all
// statement work happens here and returns plain values, with db.close()
// called before this function returns — never leaving a `.get()` row alive
// across an `assert.*` call while the db is still open, which reproduced a
// Windows file-lock EPERM on cleanup.
function exerciseMigration0003(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT, usage_json TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
  `);
  raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('0001_init', new Date().toISOString());
  raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
    '0002_runs_usage_json',
    new Date().toISOString()
  );
  // A project row created before budget fields existed.
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0003', 'pre-existing', 'now', 'now')")
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const projectRow = db.prepare('SELECT max_budget_usd FROM projects WHERE id = ?').get('p_pre_0003') as {
    max_budget_usd: number;
  };
  const projectMaxBudgetUsd = projectRow.max_budget_usd;

  db.exec(
    "INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('t1','p_pre_0003','T1','OPEN','now','now')"
  );
  db.prepare('UPDATE tickets SET max_budget_usd_override = ? WHERE id = ?').run(5.5, 't1');
  const ticketRow = db.prepare('SELECT max_budget_usd_override FROM tickets WHERE id = ?').get('t1') as {
    max_budget_usd_override: number;
  };
  const ticketOverrideAfterUpdate = ticketRow.max_budget_usd_override;

  const t2Row = db
    .prepare(
      "INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('t2','p_pre_0003','T2','OPEN','now','now') RETURNING max_budget_usd_override"
    )
    .get() as { max_budget_usd_override: number | null };
  const secondTicketOverrideDefault = t2Row.max_budget_usd_override;

  db.close();

  return { appliedMigrationIds, projectMaxBudgetUsd, ticketOverrideAfterUpdate, secondTicketOverrideDefault };
}

// Upgrade test for migration 0003_budget_fields: a database that already has
// 0001 and 0002 applied (pre-budget-fields state) picks up 0003 on next
// open, without re-running the earlier migrations, and existing project
// rows get the default max_budget_usd rather than NULL or an error.
test('a database migrated only to 0001+0002 picks up 0003 (budget fields) on next open, with the default applied to existing rows', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0003-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0003(file);
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
 '0015_verifier_run_kind',
  ]);
  assert.equal(
    snapshot.projectMaxBudgetUsd,
    2.0,
    'pre-existing project rows must get the default budget, not NULL'
  );
  assert.equal(snapshot.ticketOverrideAfterUpdate, 5.5);
  assert.equal(
    snapshot.secondTicketOverrideDefault,
    null,
    'ticket override defaults to NULL (falls back to project default)'
  );
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 6 item 5 convention: this file's own private root under the OS temp
// directory, not a prefixed directory directly inside the shared tmpdir().
const testRoot = testTempRoot('managerkindmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  ticketKindBeforeUpdate: string;
  ticketKindAfterUpdate: string;
  managerModelBeforeUpdate: string | null;
  managerModelAfterUpdate: string | null;
}

// See batch3Migration.test.ts's exerciseMigration0004 doc comment: all
// statement work happens here and returns plain values, with db.close()
// called before this function returns -- never leaving a `.get()` row alive
// across an `assert.*` call while the db is still open (the Windows
// file-lock EPERM this avoids).
function exerciseMigration0007(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, model TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0007', 'pre-existing', 'now', 'now')")
    .run();
  raw
    .prepare(
      "INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('t_pre_0007', 'p_pre_0007', 'T', 'OPEN', 'now', 'now')"
    )
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const beforeTicketRow = db.prepare('SELECT kind FROM tickets WHERE id = ?').get('t_pre_0007') as { kind: string };
  const ticketKindBeforeUpdate = beforeTicketRow.kind;

  const beforeProjectRow = db.prepare('SELECT manager_model FROM projects WHERE id = ?').get('p_pre_0007') as {
    manager_model: string | null;
  };
  const managerModelBeforeUpdate = beforeProjectRow.manager_model;

  db.prepare('UPDATE tickets SET kind = ? WHERE id = ?').run('manager', 't_pre_0007');
  const afterTicketRow = db.prepare('SELECT kind FROM tickets WHERE id = ?').get('t_pre_0007') as { kind: string };
  const ticketKindAfterUpdate = afterTicketRow.kind;

  db.prepare('UPDATE projects SET manager_model = ? WHERE id = ?').run('claude-fable-5-1', 'p_pre_0007');
  const afterProjectRow = db.prepare('SELECT manager_model FROM projects WHERE id = ?').get('p_pre_0007') as {
    manager_model: string | null;
  };
  const managerModelAfterUpdate = afterProjectRow.manager_model;

  db.close();

  return { appliedMigrationIds, ticketKindBeforeUpdate, ticketKindAfterUpdate, managerModelBeforeUpdate, managerModelAfterUpdate };
}

// Upgrade test for migration 0007_manager_kind: a database migrated only up
// to 0006 (pre-Manager state) picks up 0007 on next open. Existing ticket
// rows get 'work' (a non-null default -- every ticket before this batch WAS
// a work ticket, so this is the only value that preserves their meaning),
// and existing project rows get NULL manager_model (falls back to the
// project's own default_model -- same NULL-means-"use the project default"
// shape 0006_model_pinning's ticket.model override already uses).
test("a database migrated only to 0001-0006 picks up 0007 (manager kind) on next open, with existing tickets defaulting to 'work' and existing projects defaulting to NULL manager_model", async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0007-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0007(file);
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
    '0010_backfill_workspace_root_from_scope_path', '0011_ticket_model_reason', '0012_artifact_text_column',
  ]);
  assert.equal(
    snapshot.ticketKindBeforeUpdate,
    'work',
    "existing ticket rows must get 'work', not NULL -- every ticket before this batch was an ordinary work ticket"
  );
  assert.equal(snapshot.ticketKindAfterUpdate, 'manager');
  assert.equal(
    snapshot.managerModelBeforeUpdate,
    null,
    'existing project rows must get NULL manager_model (falls back to default_model), not a copied value'
  );
  assert.equal(snapshot.managerModelAfterUpdate, 'claude-fable-5-1');
});

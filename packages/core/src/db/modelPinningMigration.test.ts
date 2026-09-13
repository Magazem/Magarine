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
const testRoot = testTempRoot('modelpinningmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  defaultModelBeforeUpdate: string;
  defaultModelAfterUpdate: string;
  ticketModelBeforeUpdate: string | null;
  ticketModelAfterUpdate: string | null;
}

// See batch3Migration.test.ts's exerciseMigration0004 doc comment: all
// statement work happens here and returns plain values, with db.close()
// called before this function returns -- never leaving a `.get()` row alive
// across an `assert.*` call while the db is still open (the Windows
// file-lock EPERM this avoids).
function exerciseMigration0006(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0006', 'pre-existing', 'now', 'now')")
    .run();
  raw
    .prepare(
      "INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('t_pre_0006', 'p_pre_0006', 'T', 'OPEN', 'now', 'now')"
    )
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const beforeProjectRow = db.prepare('SELECT default_model FROM projects WHERE id = ?').get('p_pre_0006') as {
    default_model: string;
  };
  const defaultModelBeforeUpdate = beforeProjectRow.default_model;

  const beforeTicketRow = db.prepare('SELECT model FROM tickets WHERE id = ?').get('t_pre_0006') as {
    model: string | null;
  };
  const ticketModelBeforeUpdate = beforeTicketRow.model;

  db.prepare('UPDATE projects SET default_model = ? WHERE id = ?').run('claude-opus-5', 'p_pre_0006');
  const afterProjectRow = db.prepare('SELECT default_model FROM projects WHERE id = ?').get('p_pre_0006') as {
    default_model: string;
  };
  const defaultModelAfterUpdate = afterProjectRow.default_model;

  db.prepare('UPDATE tickets SET model = ? WHERE id = ?').run('claude-haiku-4-5-20251001', 't_pre_0006');
  const afterTicketRow = db.prepare('SELECT model FROM tickets WHERE id = ?').get('t_pre_0006') as {
    model: string | null;
  };
  const ticketModelAfterUpdate = afterTicketRow.model;

  db.close();

  return { appliedMigrationIds, defaultModelBeforeUpdate, defaultModelAfterUpdate, ticketModelBeforeUpdate, ticketModelAfterUpdate };
}

// Upgrade test for migration 0006_model_pinning: a database migrated only up
// to 0005 (pre-model-pinning state) picks up 0006 on next open. Existing
// project rows get 'claude-sonnet-5' (a non-null default, like
// max_budget_usd in 0003 -- every run needs SOME model to pin to), and
// existing ticket rows get NULL (no override, unlike the project default --
// same NULL-means-"use the project's" shape as max_budget_usd_override).
test("a database migrated only to 0001-0005 picks up 0006 (model pinning) on next open, with existing projects defaulting to 'claude-sonnet-5' and existing tickets defaulting to NULL (no override)", async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0006-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0006(file);
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
  ]);
  assert.equal(
    snapshot.defaultModelBeforeUpdate,
    'claude-sonnet-5',
    "existing project rows must get 'claude-sonnet-5', not NULL -- every run needs a model to pin to"
  );
  assert.equal(snapshot.defaultModelAfterUpdate, 'claude-opus-5');
  assert.equal(snapshot.ticketModelBeforeUpdate, null, 'existing ticket rows must get NULL (use the project default), not a copied default');
  assert.equal(snapshot.ticketModelAfterUpdate, 'claude-haiku-4-5-20251001');
});

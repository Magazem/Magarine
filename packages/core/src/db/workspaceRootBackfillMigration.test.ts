import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 12 ruling 1: "a project has exactly one directory" -- workspace_root
// and scope_path both derive from it from now on. A database migrated only
// through 0009 (pre-batch-12 state) can have rows where scope_path was set
// (batch 11's own default, or an explicit `--scope`) but workspace_root
// never was (no `--workspace-root` given at creation). 0010 backfills
// workspace_root from dirname(scope_path) for exactly those rows, and
// leaves a row with NEITHER set alone -- there is nothing on disk to derive
// a directory from, and `project set --dir` is that row's own fix (see
// commands/inbox.ts's reasonFor for the workspace_preparation_failed line
// that names it).

const testRoot = testTempRoot('workspacerootbackfillmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  withScopeWorkspaceRoot: string | null;
  bareProjectWorkspaceRoot: string | null;
  alreadySetWorkspaceRootUntouched: string | null;
}

function exerciseMigration0010(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5', manager_model TEXT, scope_path TEXT, pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    '0009_pause_reason',
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }

  // A row with a scope_path but no workspace_root -- the exact shape
  // batch 11's own default-scope-path CLI logic produced.
  raw
    .prepare(
      "INSERT INTO projects (id, name, scope_path, created_at, updated_at) VALUES ('p_with_scope', 'with-scope', 'C:\\magarine-state\\projects\\p_with_scope\\SCOPE.md', 'now', 'now')"
    )
    .run();
  // A truly bare legacy row: neither ever set.
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_bare', 'bare', 'now', 'now')")
    .run();
  // A row that ALREADY has a workspace_root from an explicit
  // --workspace-root -- the migration must leave it exactly alone, not
  // overwrite it from scope_path's directory even if the two disagree.
  raw
    .prepare(
      "INSERT INTO projects (id, name, workspace_root, scope_path, created_at, updated_at) VALUES ('p_already_set', 'already-set', 'C:\\explicit\\root', 'C:\\somewhere\\else\\SCOPE.md', 'now', 'now')"
    )
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const row = (id: string) =>
    (db.prepare('SELECT workspace_root FROM projects WHERE id = ?').get(id) as { workspace_root: string | null })
      .workspace_root;

  const snapshot: Snapshot = {
    appliedMigrationIds,
    withScopeWorkspaceRoot: row('p_with_scope'),
    bareProjectWorkspaceRoot: row('p_bare'),
    alreadySetWorkspaceRootUntouched: row('p_already_set'),
  };
  db.close();
  return snapshot;
}

test('0010 backfills workspace_root from dirname(scope_path) for a legacy row that has a scope but no root, leaves a bare row null, and never overwrites an already-set root', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0010-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0010(file);
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
    '0010_backfill_workspace_root_from_scope_path', '0011_ticket_model_reason',
  ]);

  assert.equal(
    snapshot.withScopeWorkspaceRoot,
    'C:\\magarine-state\\projects\\p_with_scope',
    'workspace_root must be backfilled to the scope file\'s own directory'
  );
  assert.equal(snapshot.bareProjectWorkspaceRoot, null, 'a project with neither set has nothing to derive a directory from');
  assert.equal(
    snapshot.alreadySetWorkspaceRootUntouched,
    'C:\\explicit\\root',
    'an already-set workspace_root must never be overwritten, even if scope_path points elsewhere'
  );
});

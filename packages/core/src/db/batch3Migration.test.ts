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
const testRoot = testTempRoot('batch3migration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  projectBeforeUpdate: { brief: string | null; workspace_root: string | null; adapter_paused_at: string | null };
  workspaceRootAfterUpdate: string;
  artifact: { run_id: string; project_id: string };
}

// All db/statement work happens in this helper, which extracts plain values
// and closes the db BEFORE returning — never leaving a row object from
// `.get()` alive across an `assert.*` call while the db is still open.
// That combination reproduced a real, HARD-verified Windows failure: node
// :sqlite's `.get()` rows are null-prototype objects, and running
// `assert.deepEqual` (which node:assert/strict remaps to
// `deepStrictEqual`) against one while the underlying statement/db handle
// is still open left the temp db file locked long enough that even 5+
// seconds of retried `rmSync` could not delete it afterwards. Moving
// `db.close()` before any assertion that touches a `.get()` result removed
// the lock every time; asserting first reproduced it every time.
function exerciseMigration0004(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT, usage_json TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
  `);
  for (const id of ['0001_init', '0002_runs_usage_json', '0003_budget_fields']) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p_pre_0004', 'pre-existing', 'now', 'now')")
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const projectRow = db
    .prepare('SELECT brief, workspace_root, adapter_paused_at FROM projects WHERE id = ?')
    .get('p_pre_0004') as { brief: string | null; workspace_root: string | null; adapter_paused_at: string | null };
  const projectBeforeUpdate = { ...projectRow };

  db.prepare('UPDATE projects SET workspace_root = ? WHERE id = ?').run('/tmp/proj-root', 'p_pre_0004');
  const updatedRow = db.prepare('SELECT workspace_root FROM projects WHERE id = ?').get('p_pre_0004') as {
    workspace_root: string;
  };
  const workspaceRootAfterUpdate = updatedRow.workspace_root;

  db.exec(
    "INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('t1','p_pre_0004','T1','OPEN','now','now')"
  );
  db.prepare(
    'INSERT INTO artifacts (id, ticket_id, run_id, project_id, kind, path_or_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('art1', 't1', 'run1', 'p_pre_0004', 'file', '/tmp/proj-root/out.txt', 'now');
  const artifactRow = db.prepare('SELECT run_id, project_id FROM artifacts WHERE id = ?').get('art1') as {
    run_id: string;
    project_id: string;
  };
  const artifact = { ...artifactRow };

  db.close();

  return { appliedMigrationIds, projectBeforeUpdate, workspaceRootAfterUpdate, artifact };
}

test('a database migrated only to 0001+0002+0003 picks up 0004 (batch 3 fields) on next open', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0004-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0004(file);
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
  assert.deepEqual(snapshot.projectBeforeUpdate, {
    brief: null,
    workspace_root: null,
    adapter_paused_at: null,
  });
  assert.equal(snapshot.workspaceRootAfterUpdate, '/tmp/proj-root');
  assert.deepEqual(snapshot.artifact, { run_id: 'run1', project_id: 'p_pre_0004' });
});

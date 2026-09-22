import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 13 ruling 1b: a non-file artefact kind no longer carries its
// content in `path_or_uri` -- closing the batch-11 smell of
// manager_reply/manager_assessment doing exactly that. A database migrated
// only through 0011 (pre-batch-13 state) can have manager_reply/
// manager_assessment rows with their real reply/assessment TEXT sitting in
// `path_or_uri` (the only content column that existed at the time). 0012
// adds a `text` column and moves that content over, leaving `path_or_uri`
// an empty string (not overwriting it with a table rebuild, since it stays
// NOT NULL) for exactly those rows -- a `file` row is left completely
// untouched, since its content genuinely is a path.

const testRoot = testTempRoot('artifacttextcolumnmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  managerReplyPathOrUri: string;
  managerReplyText: string | null;
  managerAssessmentPathOrUri: string;
  managerAssessmentText: string | null;
  fileArtifactPathOrUri: string;
  fileArtifactText: string | null;
}

function exerciseMigration0012(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5', manager_model TEXT, scope_path TEXT, pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, model TEXT, model_reason TEXT, kind TEXT NOT NULL DEFAULT 'work', result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT, usage_json TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT, project_id TEXT, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
    CREATE TABLE tickets_dummy_unused (x TEXT);
    INSERT INTO projects (id, name, workspace_root, scope_path, created_at, updated_at) VALUES ('p1', 'p1', 'C:\\proj', 'C:\\proj\\SCOPE.md', 'now', 'now');
    INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('tkt_1', 'p1', 'Manager: plan', 'DONE', 'now', 'now');
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
    '0010_backfill_workspace_root_from_scope_path',
    '0011_ticket_model_reason',
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }

  // A legacy manager_reply row: its real reply text sitting in path_or_uri,
  // the only content column that existed pre-batch-13.
  raw
    .prepare(
      "INSERT INTO artifacts (id, ticket_id, run_id, project_id, kind, path_or_uri, created_at) VALUES ('art_reply', 'tkt_1', 'run_1', 'p1', 'manager_reply', 'Done -- removed the export feature.', 'now')"
    )
    .run();
  // Likewise for manager_assessment.
  raw
    .prepare(
      "INSERT INTO artifacts (id, ticket_id, run_id, project_id, kind, path_or_uri, created_at) VALUES ('art_assessment', 'tkt_1', 'run_1', 'p1', 'manager_assessment', 'The scope is thin.', 'now')"
    )
    .run();
  // A genuine file artifact -- must be left completely untouched.
  raw
    .prepare(
      "INSERT INTO artifacts (id, ticket_id, run_id, project_id, kind, path_or_uri, created_at) VALUES ('art_file', 'tkt_1', 'run_1', 'p1', 'file', 'C:\\proj\\out.txt', 'now')"
    )
    .run();
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const row = (id: string) => db.prepare('SELECT path_or_uri, text FROM artifacts WHERE id = ?').get(id) as {
    path_or_uri: string;
    text: string | null;
  };

  const reply = row('art_reply');
  const assessment = row('art_assessment');
  const fileRow = row('art_file');

  const snapshot: Snapshot = {
    appliedMigrationIds,
    managerReplyPathOrUri: reply.path_or_uri,
    managerReplyText: reply.text,
    managerAssessmentPathOrUri: assessment.path_or_uri,
    managerAssessmentText: assessment.text,
    fileArtifactPathOrUri: fileRow.path_or_uri,
    fileArtifactText: fileRow.text,
  };
  db.close();
  return snapshot;
}

test('0012 moves manager_reply/manager_assessment content from path_or_uri into the new text column, emptying path_or_uri, and leaves a file row completely untouched', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0012-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0012(file);
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
    '0012_artifact_text_column',
    '0013_ticket_expected_artifacts',
    '0014_max_parallel_workers_nullable',
    '0015_verifier_run_kind', '0016_ticket_automatic', '0017_worker_profiles',
  ]);

  assert.equal(snapshot.managerReplyText, 'Done -- removed the export feature.', 'the reply text must move to the new column');
  assert.equal(snapshot.managerReplyPathOrUri, '', 'path_or_uri must no longer carry real content for this kind');

  assert.equal(snapshot.managerAssessmentText, 'The scope is thin.');
  assert.equal(snapshot.managerAssessmentPathOrUri, '');

  assert.equal(snapshot.fileArtifactPathOrUri, 'C:\\proj\\out.txt', 'a genuine file artifact must be left completely untouched');
  assert.equal(snapshot.fileArtifactText, null, 'a file artifact must not gain a spurious text value');
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 15 item 4: `tickets.expected_artifacts_json` -- NULL for every
// existing row (a database migrated only through 0012, pre-batch-15 state,
// has no way to have ever declared one), which is exactly what store.ts's
// rowToTicket reads as "no such list, keep today's rule" -- see
// types.ts's Ticket.expectedArtifacts doc comment.

const testRoot = testTempRoot('expectedartifactsmigration');
after(testRoot.cleanup);

interface Snapshot {
  appliedMigrationIds: string[];
  expectedArtifactsJsonForExistingRow: string | null;
  expectedArtifactsJsonAfterSet: string | null;
}

function exerciseMigration0013(file: string): Snapshot {
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, max_budget_usd REAL NOT NULL DEFAULT 2.00, brief TEXT, workspace_root TEXT, adapter_paused_at TEXT, max_spend_usd REAL, default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5', manager_model TEXT, scope_path TEXT, pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, max_budget_usd_override REAL, model TEXT, model_reason TEXT, kind TEXT NOT NULL DEFAULT 'work', result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT, usage_json TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT, project_id TEXT, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, text TEXT, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'p1', 'now', 'now');
    INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('tkt_pre_0013', 'p1', 'pre-existing ticket', 'OPEN', 'now', 'now');
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
    '0012_artifact_text_column',
  ]) {
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  const beforeRow = db.prepare('SELECT expected_artifacts_json FROM tickets WHERE id = ?').get('tkt_pre_0013') as {
    expected_artifacts_json: string | null;
  };
  const expectedArtifactsJsonForExistingRow = beforeRow.expected_artifacts_json;

  db.prepare('UPDATE tickets SET expected_artifacts_json = ? WHERE id = ?').run(
    JSON.stringify([{ kind: 'file', path: 'out.txt' }]),
    'tkt_pre_0013'
  );
  const afterRow = db.prepare('SELECT expected_artifacts_json FROM tickets WHERE id = ?').get('tkt_pre_0013') as {
    expected_artifacts_json: string | null;
  };
  const expectedArtifactsJsonAfterSet = afterRow.expected_artifacts_json;

  db.close();
  return { appliedMigrationIds, expectedArtifactsJsonForExistingRow, expectedArtifactsJsonAfterSet };
}

test('0013 adds tickets.expected_artifacts_json, NULL for every pre-existing row, writable afterward', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0013-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0013(file);
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
  ]);

  assert.equal(
    snapshot.expectedArtifactsJsonForExistingRow,
    null,
    'a ticket that predates this migration must read as NULL -- "no such list, keep today\'s rule," not an invented empty array'
  );
  assert.equal(snapshot.expectedArtifactsJsonAfterSet, JSON.stringify([{ kind: 'file', path: 'out.txt' }]));
});

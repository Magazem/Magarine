import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, runMigrations } from './index.ts';
import { rmSyncResilient } from './testSupport.ts';

test('runMigrations is idempotent: applying twice does not error or duplicate rows', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  runMigrations(db);
  const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(
    (r) => r.id
  );
  db.close();
  assert.deepEqual(applied, [
    '0001_init',
    '0002_runs_usage_json',
    '0003_budget_fields',
    '0004_batch3_scheduler_seam',
    '0005_project_spend_cap',
  ]);
});

interface Snapshot {
  appliedMigrationIds: string[];
  usageJsonInputTokens: number;
}

// See batch3Migration.test.ts's exerciseMigration0004 doc comment: all
// statement work happens here and returns plain values, with db.close()
// called before this function returns.
function exerciseMigration0002(file: string): Snapshot {
  // Simulate a DB created before usage_json existed: apply only 0001 by
  // hand, bypassing the migration runner.
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_adapter TEXT, max_parallel_workers INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, workspace_type TEXT NOT NULL DEFAULT 'NONE', workspace_ref TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (ticket_id TEXT NOT NULL, depends_on_ticket_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, attempt INTEGER NOT NULL, adapter TEXT NOT NULL, worker_session_ref TEXT, workspace_ref TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_class TEXT);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'internal', requires_user INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, path_or_uri TEXT NOT NULL, description TEXT, checksum TEXT, created_at TEXT NOT NULL);
  `);
  raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('0001_init', new Date().toISOString());
  raw.close();

  const db = openDb(file);

  const appliedMigrationIds = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id);

  // usage_json now exists and is writable.
  db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','p','now','now')");
  db.prepare(
    "INSERT INTO runs (id, ticket_id, attempt, adapter, status, started_at, usage_json) VALUES ('r1','t1',1,'fake','running','now',?)"
  ).run(JSON.stringify({ inputTokens: 1 }));
  const row = db.prepare('SELECT usage_json FROM runs WHERE id = ?').get('r1') as { usage_json: string };
  const usageJsonInputTokens = JSON.parse(row.usage_json).inputTokens;

  db.close();

  return { appliedMigrationIds, usageJsonInputTokens };
}

test('a database migrated only to 0001 picks up 0002 (usage_json) on next open, without re-running 0001', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-migrate-'));
  const file = join(dir, 'db.sqlite');
  let snapshot: Snapshot;
  try {
    snapshot = exerciseMigration0002(file);
  } finally {
    await rmSyncResilient(dir);
  }

  assert.deepEqual(snapshot.appliedMigrationIds, [
    '0001_init',
    '0002_runs_usage_json',
    '0003_budget_fields',
    '0004_batch3_scheduler_seam',
    '0005_project_spend_cap',
  ]);
  assert.equal(snapshot.usageJsonInputTokens, 1);
});

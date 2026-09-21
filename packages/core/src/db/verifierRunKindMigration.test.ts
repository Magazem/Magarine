import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { MIGRATIONS } from './schema.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 18 ruling 31: 0015 adds `runs.kind` (every existing run is a worker
// run) and `projects.verifier_model` (null: fall back to the default model).
// Exercised against a LEGACY database built by running the REAL migrations
// 0001-0014 with a run already in it, not a hand-written schema.

const testRoot = testTempRoot('verifierkindmigration');
after(testRoot.cleanup);

function buildLegacyDatabase(file: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
    for (const migration of MIGRATIONS.slice(0, 14)) {
      raw.exec('BEGIN');
      if (migration.sql) raw.exec(migration.sql);
      if (migration.run) migration.run(raw);
      raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, 'then');
      raw.exec('COMMIT');
    }
    raw.exec(`
      INSERT INTO projects (id, name, default_model, created_at, updated_at) VALUES ('proj_a', 'a', 'claude-sonnet-5', 't0', 't0');
      INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('tkt_a', 'proj_a', 'a', 'DONE', 't0', 't0');
      INSERT INTO runs (id, ticket_id, attempt, adapter, status, started_at) VALUES ('run_old', 'tkt_a', 1, 'fake', 'succeeded', 't0');
    `);
  } finally {
    raw.close();
  }
}

test('0015 gives every existing run kind "work" and every existing project a null verifier_model, losing nothing', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0015-'));
  const file = join(dir, 'db.sqlite');
  try {
    assert.equal(MIGRATIONS[14]!.id, '0015_verifier_run_kind');
    buildLegacyDatabase(file);
    const db = openDb(file);
    try {
      const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      assert.ok(applied.includes('0015_verifier_run_kind'));
      const run = db.prepare(`SELECT status, kind FROM runs WHERE id = 'run_old'`).get() as { status: string; kind: string };
      assert.deepEqual({ ...run }, { status: 'succeeded', kind: 'work' });
      const project = db.prepare(`SELECT default_model, verifier_model FROM projects WHERE id = 'proj_a'`).get() as {
        default_model: string;
        verifier_model: string | null;
      };
      assert.equal(project.default_model, 'claude-sonnet-5');
      assert.equal(project.verifier_model, null);
      // A verify run can be written on the upgraded database.
      db.prepare(
        `INSERT INTO runs (id, ticket_id, attempt, adapter, status, started_at, kind) VALUES ('run_v', 'tkt_a', 1, 'fake', 'running', 't1', 'verify')`
      ).run();
      assert.equal((db.prepare(`SELECT kind FROM runs WHERE id = 'run_v'`).get() as { kind: string }).kind, 'verify');
    } finally {
      db.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

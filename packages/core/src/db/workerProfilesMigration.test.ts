import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { MIGRATIONS } from './schema.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 19 mini-phase 1A (docs/strategy/batch-19-spec.md section 2, acceptance
// line 2): upgrade test for migration 0017_worker_profiles. Exercised against
// a LEGACY database built by running the REAL migrations 0001-0016 with a
// project, ticket and run already in it -- same shape automaticMigration.
// test.ts uses for 0016 -- not a hand-written schema.

const testRoot = testTempRoot('workerprofilesmigration');
after(testRoot.cleanup);

function buildLegacyDatabase(file: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
    for (const migration of MIGRATIONS.slice(0, 16)) {
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

test('0017 seeds the six default worker profiles and gives every existing ticket and run a NULL profile_id, losing nothing', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0017-'));
  const file = join(dir, 'db.sqlite');
  try {
    assert.equal(MIGRATIONS[16]!.id, '0017_worker_profiles');
    buildLegacyDatabase(file);
    const db = openDb(file);
    try {
      const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      assert.ok(applied.includes('0017_worker_profiles'));

      // Acceptance line 1: exactly six seeded rows, the names and models
      // named in batch-19-spec.md section 2.
      const rows = db
        .prepare('SELECT name, model, purpose, policy, retired_at FROM worker_profiles ORDER BY created_at ASC')
        .all() as Array<{ name: string; model: string; purpose: string; policy: string; retired_at: string | null }>;
      assert.deepEqual(
        rows.map((r) => [r.name, r.model]),
        [
          ['Architect', 'claude-opus-5'],
          ['Developer', 'claude-sonnet-5'],
          ['Reviewer', 'claude-sonnet-5'],
          ['Tester', 'claude-sonnet-5'],
          ['Researcher', 'claude-haiku-4-5-20251001'],
          ['Scribe', 'claude-haiku-4-5-20251001'],
        ]
      );
      for (const r of rows) {
        assert.equal(r.retired_at, null, `${r.name} must not be retired on a fresh seed`);
        assert.equal(r.policy, r.purpose, `${r.name}'s policy must be the purpose sentence, per addendum section 2`);
      }

      // Acceptance line 2: existing rows get NULL profile_id, never an
      // invented default.
      const t = db.prepare(`SELECT profile_id FROM tickets WHERE id = 'tkt_a'`).get() as { profile_id: string | null };
      assert.equal(t.profile_id, null);
      const r = db.prepare(`SELECT profile_id FROM runs WHERE id = 'run_old'`).get() as { profile_id: string | null };
      assert.equal(r.profile_id, null);

      // A fresh ticket/run can now be written WITH a real profile_id.
      const profId = (db.prepare('SELECT id FROM worker_profiles WHERE name = ?').get('Developer') as { id: string }).id;
      db
        .prepare(
          `INSERT INTO tickets (id, project_id, title, status, profile_id, created_at, updated_at) VALUES ('tkt_new', 'proj_a', 'new', 'OPEN', ?, 't1', 't1')`
        )
        .run(profId);
      assert.equal(
        (db.prepare(`SELECT profile_id FROM tickets WHERE id = 'tkt_new'`).get() as { profile_id: string | null }).profile_id,
        profId
      );
    } finally {
      db.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

test('0017 is applied exactly once: reopening the upgraded database does not re-seed the six profiles', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0017-idempotent-'));
  const file = join(dir, 'db.sqlite');
  try {
    buildLegacyDatabase(file);
    const first = openDb(file);
    first.close();
    const second = openDb(file);
    try {
      const count = (second.prepare('SELECT COUNT(*) AS n FROM worker_profiles').get() as { n: number }).n;
      assert.equal(count, 6);
    } finally {
      second.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

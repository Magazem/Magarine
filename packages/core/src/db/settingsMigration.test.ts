import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { MIGRATIONS } from './schema.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';
import { getSetting, getSettings, setSetting } from '../store.ts';

// Batch 19 ruling 35 (batch-19-spec.md section 3): 0018 adds the `settings`
// table, appended straight after 0016 in THIS tree (the parallel worktree
// building mini-phase 1A owns 0017_worker_profiles; it has not landed here
// yet -- see schema.ts's own comment on 0018). Exercised against a LEGACY
// database built by running every REAL migration up to (not including)
// 0018 itself, not a hand-written schema. `MIGRATIONS.length - 1` no longer
// names 0018 now that batch 19 mini-phase 2A appended 0019 after it, so this
// looks 0018 up by id instead -- correct regardless of how many migrations
// land after it in the future.

const testRoot = testTempRoot('settingsmigration');
after(testRoot.cleanup);

const SETTINGS_MIGRATION_INDEX = MIGRATIONS.findIndex((m) => m.id === '0018_settings');

function buildLegacyDatabase(file: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
    for (const migration of MIGRATIONS.slice(0, SETTINGS_MIGRATION_INDEX)) {
      raw.exec('BEGIN');
      if (migration.sql) raw.exec(migration.sql);
      if (migration.run) migration.run(raw);
      raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, 'then');
      raw.exec('COMMIT');
    }
    raw.exec(`
      INSERT INTO projects (id, name, default_model, created_at, updated_at) VALUES ('proj_a', 'a', 'claude-sonnet-5', 't0', 't0');
    `);
  } finally {
    raw.close();
  }
}

test('0018 adds the settings table on top of a legacy database, empty until something is set', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0018-'));
  const file = join(dir, 'db.sqlite');
  try {
    assert.equal(MIGRATIONS[SETTINGS_MIGRATION_INDEX]!.id, '0018_settings');
    buildLegacyDatabase(file);
    const db = openDb(file);
    try {
      const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      assert.ok(applied.includes('0018_settings'));

      // A fresh settings table is empty -- nothing was ever set on the
      // legacy database, and 0018 does not seed a default row.
      assert.deepEqual(getSettings(db), {});
      assert.equal(getSetting(db, 'max_parallel_workers'), null);

      // The table is usable straight after upgrade, same as any fresh DB.
      setSetting(db, 'max_parallel_workers', '3');
      assert.equal(getSetting(db, 'max_parallel_workers'), '3');

      // The pre-existing project row is untouched.
      const project = db.prepare(`SELECT name, default_model FROM projects WHERE id = 'proj_a'`).get() as {
        name: string;
        default_model: string;
      };
      assert.deepEqual({ ...project }, { name: 'a', default_model: 'claude-sonnet-5' });
    } finally {
      db.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

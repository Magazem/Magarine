import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { MIGRATIONS } from './schema.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 19 mini-phase 2A (docs/strategy/batch-19-item-2a-profiles-in-the-loop.md
// section 2, acceptance line 5): upgrade test for migration
// 0019_ticket_profile_reason. Exercised against a LEGACY database built by
// running the REAL migrations 0001-0018 with a ticket already in it -- same
// shape workerProfilesMigration.test.ts uses for 0017 -- not a hand-written
// schema.

const testRoot = testTempRoot('ticketprofilereasonmigration');
after(testRoot.cleanup);

function buildLegacyDatabase(file: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
    for (const migration of MIGRATIONS.slice(0, 18)) {
      raw.exec('BEGIN');
      if (migration.sql) raw.exec(migration.sql);
      if (migration.run) migration.run(raw);
      raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, 'then');
      raw.exec('COMMIT');
    }
    raw.exec(`
      INSERT INTO projects (id, name, default_model, created_at, updated_at) VALUES ('proj_a', 'a', 'claude-sonnet-5', 't0', 't0');
      INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('tkt_a', 'proj_a', 'a', 'DONE', 't0', 't0');
    `);
  } finally {
    raw.close();
  }
}

test('0019 adds a nullable profile_reason column, losing nothing from an existing ticket', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0019-'));
  const file = join(dir, 'db.sqlite');
  try {
    assert.equal(MIGRATIONS[18]!.id, '0019_ticket_profile_reason');
    buildLegacyDatabase(file);
    const db = openDb(file);
    try {
      const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      assert.ok(applied.includes('0019_ticket_profile_reason'));

      // Acceptance line 5: existing tickets get a NULL profile_reason, never
      // an invented default.
      const existing = db.prepare(`SELECT profile_reason FROM tickets WHERE id = 'tkt_a'`).get() as { profile_reason: string | null };
      assert.equal(existing.profile_reason, null);

      // A fresh ticket can now be written WITH a real profile_reason.
      db
        .prepare(
          `INSERT INTO tickets (id, project_id, title, status, profile_reason, created_at, updated_at) VALUES ('tkt_new', 'proj_a', 'new', 'OPEN', 'because the ticket needs deep design', 't1', 't1')`
        )
        .run();
      const created = db.prepare(`SELECT profile_reason FROM tickets WHERE id = 'tkt_new'`).get() as { profile_reason: string | null };
      assert.equal(created.profile_reason, 'because the ticket needs deep design');
    } finally {
      db.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

test('0019 is applied exactly once: reopening the upgraded database does not throw or re-add the column', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0019-idempotent-'));
  const file = join(dir, 'db.sqlite');
  try {
    buildLegacyDatabase(file);
    const first = openDb(file);
    first.close();
    const second = openDb(file);
    try {
      const cols = (second.prepare('PRAGMA table_info(tickets)').all() as Array<{ name: string }>).filter((c) => c.name === 'profile_reason');
      assert.equal(cols.length, 1);
    } finally {
      second.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

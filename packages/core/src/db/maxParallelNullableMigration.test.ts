import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { MIGRATIONS } from './schema.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';

// Batch 16 Role A item 4 (ruling 23 items 4-5): `projects.max_parallel_workers`
// becomes NULLABLE -- null means "no cap of its own, the daemon's ceiling
// governs". SQLite cannot drop a NOT NULL constraint in place, so 0014
// REBUILDS the projects table; that is the risky part (a table rebuild under
// foreign keys, on the owner's real database), so it is exercised here
// against a LEGACY database built by running the REAL migrations 0001-0013
// (not a hand-written schema that could drift from what shipped), with
// foreign keys on, a ticket referencing each project, and one explicit and
// one defaulted row. Existing rows must KEEP their value: they were created
// under the old meaning ("this project runs at most N"), and the migration's
// note says so.

const testRoot = testTempRoot('maxparallelmigration');
after(testRoot.cleanup);

const LEGACY_IDS = MIGRATIONS.slice(0, 13).map((m) => m.id);

function buildLegacyDatabase(file: string): void {
  const raw = new DatabaseSync(file);
  try {
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
  for (const migration of MIGRATIONS.slice(0, 13)) {
    raw.exec('BEGIN');
    if (migration.sql) raw.exec(migration.sql);
    if (migration.run) migration.run(raw);
    raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, 'then');
    raw.exec('COMMIT');
  }
  // One row created with an explicit cap of 4, one created before the flag
  // existed (the column default, 1), each with real data in the other columns
  // and a ticket pointing at it through the foreign key.
  raw.exec(`
    INSERT INTO projects (id, name, max_parallel_workers, workspace_root, scope_path, max_spend_usd, default_model, manager_model, created_at, updated_at)
      VALUES ('proj_explicit', 'explicit', 4, 'C:/work/explicit', 'C:/work/explicit/SCOPE.md', 12.5, 'claude-sonnet-5', 'claude-opus-5', 't0', 't0');
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_default', 'default', 't0', 't0');
    INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('tkt_a', 'proj_explicit', 'a', 'OPEN', 't0', 't0');
    INSERT INTO tickets (id, project_id, title, status, created_at, updated_at) VALUES ('tkt_b', 'proj_default', 'b', 'OPEN', 't0', 't0');
  `);
  } finally {
    raw.close();
  }
}

interface Upgraded {
  appliedIds: string[];
  rows: Array<Record<string, unknown>>;
  notNull: number;
  fkViolations: unknown[];
  ticketProjects: Array<{ id: string; project_id: string }>;
  foreignKeysStillOn: number;
  afterInsertCap: unknown;
}

function upgrade(file: string): Upgraded {
  const db = openDb(file);
  try {
  const appliedIds = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
  const rows = db.prepare('SELECT * FROM projects ORDER BY id').all() as Array<Record<string, unknown>>;
  const col = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string; notnull: number }>).find(
    (c) => c.name === 'max_parallel_workers'
  )!;
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  const ticketProjects = db.prepare('SELECT id, project_id FROM tickets ORDER BY id').all() as Array<{ id: string; project_id: string }>;
  const foreignKeysStillOn = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  // A project with NO cap of its own can now be written.
  db.prepare(
    `INSERT INTO projects (id, name, max_parallel_workers, created_at, updated_at) VALUES ('proj_none', 'none', NULL, 't1', 't1')`
  ).run();
  const afterInsertCap = (db.prepare(`SELECT max_parallel_workers AS c FROM projects WHERE id = 'proj_none'`).get() as { c: unknown }).c;
  return { appliedIds, rows, notNull: col.notnull, fkViolations, ticketProjects, foreignKeysStillOn, afterInsertCap };
  } finally {
    db.close();
  }
}

test('0014 makes max_parallel_workers nullable while every existing row KEEPS its value, its other columns, and its tickets', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0014-'));
  const file = join(dir, 'db.sqlite');
  let u: Upgraded;
  try {
    buildLegacyDatabase(file);
    u = upgrade(file);
  } finally {
    await rmSyncResilient(dir);
  }

  assert.deepEqual(u.appliedIds, [...LEGACY_IDS, '0014_max_parallel_workers_nullable'].sort());
  assert.equal(u.notNull, 0, 'the column must no longer be NOT NULL');
  assert.equal(u.afterInsertCap, null, 'a project with no cap of its own must be writable');

  const explicit = u.rows.find((r) => r.id === 'proj_explicit')!;
  const defaulted = u.rows.find((r) => r.id === 'proj_default')!;
  assert.equal(explicit.max_parallel_workers, 4, 'an explicit cap must survive the rebuild -- overwriting it is data loss');
  assert.equal(defaulted.max_parallel_workers, 1, 'a row created under the old default keeps its 1: it was created under the old meaning');
  assert.equal(explicit.workspace_root, 'C:/work/explicit');
  assert.equal(explicit.scope_path, 'C:/work/explicit/SCOPE.md');
  assert.equal(explicit.max_spend_usd, 12.5);
  assert.equal(explicit.manager_model, 'claude-opus-5');
  assert.equal(explicit.created_at, 't0');
  assert.equal(u.rows.filter((r) => r.id === 'proj_none').length, 0, 'sanity: the row read before the insert has only the two legacy rows');
  assert.equal(u.rows.length, 2);

  assert.deepEqual(u.ticketProjects.map((t) => ({ ...t })), [
    { id: 'tkt_a', project_id: 'proj_explicit' },
    { id: 'tkt_b', project_id: 'proj_default' },
  ]);
  assert.deepEqual(u.fkViolations, [], 'the rebuild must leave every foreign key resolving');
  assert.equal(u.foreignKeysStillOn, 1, 'foreign key enforcement must be back on after the migration');
});

test('0014 is applied exactly once: reopening an upgraded database leaves the rows and the schema alone', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0014-twice-'));
  const file = join(dir, 'db.sqlite');
  try {
    buildLegacyDatabase(file);
    upgrade(file);
    const db = openDb(file);
    const cap = (db.prepare(`SELECT max_parallel_workers AS c FROM projects WHERE id = 'proj_explicit'`).get() as { c: number }).c;
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE id LIKE '0014%'`).get() as { n: number }).n;
    db.close();
    assert.equal(cap, 4);
    assert.equal(count, 1);
  } finally {
    await rmSyncResilient(dir);
  }
});

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

export function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => (row as { id: string }).id)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// Runs `fn` inside a transaction, rolling back on throw. node:sqlite's
// DatabaseSync has no built-in transaction helper, so this is the one place
// that wraps BEGIN/COMMIT/ROLLBACK (via SAVEPOINT) by hand. Reentrant: a
// nested call uses a SAVEPOINT instead of a second BEGIN, because the
// dependency resolver recurses into the same transition-writing function
// that started the outer transaction.
const txDepth = new WeakMap<Db, number>();
let savepointCounter = 0;

export function withTransaction<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `sp_${++savepointCounter}`;

  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE');
  } else {
    db.exec(`SAVEPOINT ${savepoint}`);
  }
  txDepth.set(db, depth + 1);

  try {
    const result = fn();
    if (depth === 0) {
      db.exec('COMMIT');
    } else {
      db.exec(`RELEASE ${savepoint}`);
    }
    return result;
  } catch (err) {
    if (depth === 0) {
      db.exec('ROLLBACK');
    } else {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

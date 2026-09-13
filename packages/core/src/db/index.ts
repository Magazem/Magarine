import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

// Batch 8: before daemon mode there was only ever one process holding this
// file open at a time. Now the daemon holds it open continuously while the
// CLI's own direct reads (`board`/`status`/`inbox`/`activity` -- reads stay
// direct even while a daemon is running, per the single-writer rule) open a
// second, independent connection to the same file at any moment. Neither
// pragma below was ever needed before this batch:
//
// - `journal_mode = WAL`: the default rollback-journal mode serializes
//   ALL access -- a reader can be blocked by a writer's in-flight
//   transaction. WAL lets readers proceed concurrently with a writer
//   (only writer-vs-writer contention is still serialized), which is the
//   real fix for a `board`/`status` read racing the daemon's own write.
// - `busy_timeout`: without it, node:sqlite's default is 0 -- a connection
//   that DOES find the file locked (writer-vs-writer, or the brief moment
//   around a WAL checkpoint) fails immediately (SQLITE_BUSY) instead of
//   waiting. 5000ms comfortably outlasts any single transaction this
//   codebase runs, which are all synchronous, in-process DB operations
//   (low milliseconds at most) -- long enough to ride out real contention,
//   short enough to fail loudly if something is actually stuck.
//
// HARD-verified on this Windows machine: `PRAGMA journal_mode = WAL`
// succeeds and reports 'wal' back against a real file; against `:memory:`
// (which every in-process test in this codebase uses) it is silently
// ignored and journal_mode stays 'memory' -- no error either way, so this
// is safe to set unconditionally on every connection, daemon and CLI alike.
// `synchronous` is deliberately left at SQLite's default (FULL) -- WAL mode
// is commonly paired with `synchronous = NORMAL` for less fsync overhead,
// but that trades some durability on an OS crash for performance this
// codebase was never asked to trade, so it is not bundled in here.
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
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

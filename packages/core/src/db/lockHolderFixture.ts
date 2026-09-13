// Test-only fixture: opens the given db file (via the real openDb), takes
// the write lock with BEGIN IMMEDIATE, prints a signal once it actually
// holds it, waits `holdMs`, then commits and exits. Used by db/index.test.ts
// to prove `busy_timeout` makes a second connection's own write attempt
// WAIT for the lock to free up rather than fail immediately -- writer-vs-
// writer contention, which WAL does not fix on its own (only busy_timeout
// does). Never imported by product code.
import { openDb } from './index.ts';

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 800);

const db = openDb(dbPath);
db.exec('BEGIN IMMEDIATE');
process.stdout.write('LOCK_HELD\n');

setTimeout(() => {
  db.exec('COMMIT');
  process.stdout.write('LOCK_RELEASED\n');
}, holdMs);

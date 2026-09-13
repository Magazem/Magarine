// Test-only fixture: a real, separate OS process that opens the given db
// file (via the real openDb, so it gets the exact same WAL/busy_timeout
// pragmas production code does) and commits a real write transaction as
// fast as possible, many times in a row, via the real store.ts functions
// (not raw SQL) -- so a concurrent reader in the test process is racing the
// exact same kind of write scheduler.ts's own tick() would produce, not a
// synthetic stand-in. Never imported by product code; only ever spawned by
// db/index.test.ts.
import { openDb } from './index.ts';
import { createProject, createTicket } from '../store.ts';

const dbPath = process.argv[2];
const iterations = Number(process.argv[3] ?? 500);

const db = openDb(dbPath);
const project = createProject(db, { name: 'writer' });
for (let i = 0; i < iterations; i++) {
  createTicket(db, { projectId: project.id, title: `t${i}` });
}
process.stdout.write('WRITER_DONE\n');

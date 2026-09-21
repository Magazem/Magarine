import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './index.ts';
import { MIGRATIONS } from './schema.ts';
import { rmSyncResilient } from './testSupport.ts';
import { testTempRoot } from '../testSupport.ts';
import { maybeCreateAutomaticManagerTurn } from '../autoManager.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { createTicket, getTicket } from '../store.ts';

// Batch 18 ruling 34: 0016 adds `tickets.automatic` (0 for every existing
// ticket). Exercised against a LEGACY database built by running the REAL
// migrations 0001-0015 with a ticket already in it, not a hand-written schema.

const testRoot = testTempRoot('automaticmigration');
after(testRoot.cleanup);

function buildLegacyDatabase(file: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
    for (const migration of MIGRATIONS.slice(0, 15)) {
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

test('0016 gives every existing ticket automatic = 0, losing nothing', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0016-'));
  const file = join(dir, 'db.sqlite');
  try {
    assert.equal(MIGRATIONS[15]!.id, '0016_ticket_automatic');
    buildLegacyDatabase(file);
    const db = openDb(file);
    try {
      const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      assert.ok(applied.includes('0016_ticket_automatic'));
      const t = db.prepare(`SELECT status, automatic FROM tickets WHERE id = 'tkt_a'`).get() as { status: string; automatic: number };
      assert.deepEqual({ ...t }, { status: 'DONE', automatic: 0 });
      db.prepare(`INSERT INTO tickets (id, project_id, title, status, automatic, created_at, updated_at) VALUES ('tkt_auto', 'proj_a', 'auto', 'OPEN', 1, 't1', 't1')`).run();
      assert.equal((db.prepare(`SELECT automatic FROM tickets WHERE id = 'tkt_auto'`).get() as { automatic: number }).automatic, 1);
    } finally {
      db.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

// The acceptance test for the high-water mark (found by running ruling 34 against
// a COPY of the owner's real database: 6 of 10 dormant projects -- a Manager
// ticket, work DONE after it, nothing pending -- would have been woken on
// upgrade, each able to spend up to 20 Manager turns a day). A finished project
// must get NO automatic turn after upgrading; only new work finishing on it may
// earn one.
test('a finished legacy project with a Manager ticket and completed work gets NO automatic turn after upgrade; new work finishing on it does', async () => {
  const dir = mkdtempSync(join(testRoot.root, 'magarine-migrate-0016-mark-'));
  const file = join(dir, 'db.sqlite');
  try {
    buildLegacyDatabase(file);
    const raw = new DatabaseSync(file);
    try {
      raw.exec(`
        INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_old', 'old walk', 't0', 't0');
        INSERT INTO tickets (id, project_id, title, status, kind, created_at, updated_at) VALUES ('tkt_mgr', 'proj_old', 'Manager: plan', 'DONE', 'manager', 't0', 't0');
        INSERT INTO tickets (id, project_id, title, status, kind, created_at, updated_at) VALUES ('tkt_w1', 'proj_old', 'built it', 'DONE', 'work', 't0', 't0');
        INSERT INTO events (project_id, event_type, entity_type, entity_id, idempotency_key, created_at) VALUES ('proj_old', 'worker_done', 'ticket', 'tkt_mgr', 'k1', 't0');
        INSERT INTO events (project_id, event_type, entity_type, entity_id, idempotency_key, created_at) VALUES ('proj_old', 'review_approved', 'ticket', 'tkt_w1', 'k2', 't1');
      `);
    } finally {
      raw.close();
    }

    const db = openDb(file);
    try {
      assert.equal(maybeCreateAutomaticManagerTurn(db, 'proj_old'), undefined, 'a project finished BEFORE the upgrade must not be woken');
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE project_id = 'proj_old' AND automatic = 1`).get() as { n: number }).n,
        0
      );

      // The owner touches it: new work is added and finishes.
      const w2 = createTicket(db, { projectId: 'proj_old', title: 'new work', workspaceType: 'NONE' });
      for (const [i, event] of (['dependencies_resolved', 'run_started', 'worker_done_for_verification', 'review_approved'] as const).entries()) {
        recordTicketTransition(db, { ticketId: w2.id, event, idempotencyKey: `new:${i}`, payload: { summary: 's' } });
      }
      assert.equal(getTicket(db, w2.id)!.status, 'DONE');

      const auto = maybeCreateAutomaticManagerTurn(db, 'proj_old');
      assert.ok(auto, 'only now, after new work finished on it, is it eligible');
      assert.equal(auto!.automatic, true);
    } finally {
      db.close();
    }
  } finally {
    await rmSyncResilient(dir);
  }
});

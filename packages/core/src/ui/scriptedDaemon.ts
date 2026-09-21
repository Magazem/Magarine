// A REAL DAEMON YOU CAN STEP, FOR THE PAGE'S TESTS ABOUT WHAT THE DAEMON DOES BY
// ITSELF (batch 18: verification, the automatic Manager turn).
//
// testDaemon.ts spawns `magarine serve`, whose CLI cannot script a ticket that
// does not exist yet -- and an automatic Manager turn is created by the
// scheduler mid-run, so its fake script can only be the adapter's DEFAULT one.
// So this starts the same two real parts `serve` starts -- the daemon loop and
// the HTTP request handler -- in this process, over a real sqlite file, with the
// fake adapter. Nothing is stubbed: the page still reads real `GET /board` and
// `GET /activity` responses over a real loopback connection. The tick interval
// is effectively never, so the test decides exactly when the daemon takes a step.

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter } from '../adapters/fakeAdapter.ts';
import { startDaemonLoop, type DaemonLoop } from '../daemon.ts';
import { createRequestHandler } from '../daemonApi.ts';
import { openDb, type Db } from '../db/index.ts';
import { createProject, createTicket, getTicket } from '../store.ts';
import type { testTempRoot } from '../testSupport.ts';
import type { Ticket, TicketStatus } from '../types.ts';

const TOKEN = 'scripted-daemon-token';

export interface ScriptedDaemon {
  db: Db;
  adapter: FakeAdapter;
  loop: DaemonLoop;
  projectId: string;
  baseUrl: string;
  token: string;
  /** One scheduling pass, then waits until every run it started has finished. Do not use with a script that never ends. */
  step(): Promise<void>;
  /** One scheduling pass, and returns at once: for a run that is meant to stay running. */
  tickOnly(): Promise<void>;
  addWorkTicket(input: { title: string; criteria?: string[]; maxAttempts?: number }): Ticket;
  /** Waits until the ticket's status is one of `statuses`, or fails. */
  waitForStatus(ticketId: string, statuses: TicketStatus[], message: string): Promise<void>;
  tickets(): Ticket[];
}

async function until(check: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!check()) throw new Error(`the daemon never reached: ${message}`);
}

export async function withScriptedDaemon(
  root: ReturnType<typeof testTempRoot>,
  body: (d: ScriptedDaemon) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(root.root, 'scripted-'));
  const artifactsDir = join(dir, 'artifacts');
  const workRoot = join(dir, 'work');
  mkdirSync(artifactsDir);
  mkdirSync(workRoot);
  const db = openDb(join(dir, 'magarine.db'));
  const adapter = new FakeAdapter();
  const project = createProject(db, { name: 'Scripted', maxParallelWorkers: 2, workspaceRoot: workRoot });
  const loop = startDaemonLoop({ db, adapter, maxParallelWorkers: 2, artifactsDir, readiness: 'skip', tickIntervalMs: 1_000_000 });
  const handler = createRequestHandler({
    db, adapter, loop, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString(), machineCap: 2, stateDir: dir,
  });
  const server: Server = createServer(handler.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const d: ScriptedDaemon = {
    db, adapter, loop, projectId: project.id, baseUrl: `http://127.0.0.1:${port}`, token: TOKEN,
    async tickOnly() { await loop.forceTick(project.id); },
    async step() {
      await loop.forceTick(project.id);
      await until(() => loop.live.size === 0, 'every started run to finish');
    },
    addWorkTicket(input) {
      return createTicket(db, {
        projectId: project.id,
        title: input.title,
        description: 'do the thing',
        acceptanceCriteria: input.criteria ?? ['it works'],
        maxAttempts: input.maxAttempts,
        workspaceType: 'NONE',
      });
    },
    waitForStatus(ticketId, statuses, message) {
      return until(() => statuses.includes(getTicket(db, ticketId)!.status), message);
    },
    tickets() { return db.prepare('SELECT id FROM tickets WHERE project_id = ?').all(project.id).map((r) => getTicket(db, (r as { id: string }).id)!); },
  };
  try {
    await body(d);
  } finally {
    handler.closeAllStreams();
    await loop.stop();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
  }
}

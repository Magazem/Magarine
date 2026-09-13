import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from './process.ts';
import { testTempRoot } from './testSupport.ts';

// Step 4: CLI routing. The daemon's own API and its business logic are
// already covered end to end (daemonApi.test.ts, against a real spawned
// daemon over real HTTP). What's new and untested here is cli.ts's own
// DECISION: does this invocation talk to a live daemon or write the sqlite
// file directly. Most routed commands produce an IDENTICAL end state either
// way (the API calls the exact same functions the direct path does), so
// there is no observable difference to test for most of them beyond "the
// request body was built and the response was printed correctly" -- already
// implicitly covered by one happy-path test below. The genuinely
// error-prone, worth-testing-directly part is the DECISION itself:
//   - a live daemon whose recorded dbPath does NOT match --db must be
//     treated as not-this-invocation's-daemon (a mutation must still land
//     in the file --db actually names, not silently vanish into the wrong
//     database);
//   - `cancel` has no direct-write fallback at all, so its success is only
//     possible if the whole detect-and-route pipeline actually worked;
//   - `run --until-idle` must refuse outright against a live, matching
//     daemon (there is no route to poll for idle, and running its own
//     scheduler loop locally would be the exact two-writer situation this
//     batch exists to prevent) -- proving the SAME detection logic every
//     other routed command shares.

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const testRoot = testTempRoot('cli-routing');
after(testRoot.cleanup);

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args] });
    let stdout = '';
    let stderr = '';
    p.onStdout((c) => (stdout += c));
    p.onStderr((c) => (stderr += c));
    p.wait().then((r) => resolve({ stdout, stderr, code: r.code }));
  });
}

interface ListeningInfo {
  pid: number;
  port: number;
  stateDir: string;
}

interface ServeHandle {
  proc: ManagedProcess;
  waitForListening(): Promise<ListeningInfo>;
  kill(): Promise<void>;
}

function spawnServe(args: string[]): ServeHandle {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, 'serve', ...args] });
  let stdout = '';
  proc.onStdout((c) => (stdout += c));
  return {
    proc,
    async waitForListening() {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) {
          try {
            return JSON.parse(line) as ListeningInfo;
          } catch {
            // still buffering
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`serve never printed a listening line within 10s. stdout=${stdout}`);
    },
    async kill() {
      await proc.stop(200);
      await proc.wait();
    },
  };
}

test('a live daemon whose recorded dbPath does not match --db is not routed to: the mutation still writes directly, to the file --db actually names', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'mismatch-'));
  try {
    // The daemon serves <stateDir>/magarine.db (the state-dir default).
    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      await handle.waitForListening();

      // This invocation names a DIFFERENT db file under the same state
      // directory. It must be treated as not-this-daemon's-database and
      // write directly there instead of silently routing into the
      // daemon's own db.
      const otherDbPath = join(stateDir, 'other.db');
      const projectRes = await runCli([
        'project', 'create', '--name', 'p', '--state-dir', stateDir, '--db', otherDbPath, '--json',
      ]);
      assert.equal(projectRes.code, 0, projectRes.stderr);
      const project = JSON.parse(projectRes.stdout);

      // Read it back from the SAME explicit --db: present there.
      const statusFromOther = await runCli([
        'status', '--project', project.id, '--state-dir', stateDir, '--db', otherDbPath, '--json',
      ]);
      assert.equal(JSON.parse(statusFromOther.stdout).length, 0, 'no tickets yet, but the project itself must exist');

      // Read it back from the DAEMON's own (default) db, under the same
      // state directory: must NOT be there -- proof the write went to the
      // file --db actually named, not to the live daemon's database.
      const daemonDbStatus = await runCli(['board', '--project', project.id, '--state-dir', stateDir, '--json']);
      const board = JSON.parse(daemonDbStatus.stdout) as { tickets: unknown[] };
      // buildBoard on an unknown project id returns an empty board rather
      // than throwing (see commands/board.ts) -- this project id simply
      // does not exist in the daemon's own db.
      assert.deepEqual(board.tickets, []);
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cancel: refuses with no daemon running, refuses against a daemon for a different --db, and succeeds end to end against a live matching daemon', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'cancel-'));
  try {
    // No daemon at all yet.
    const noDaemon = await runCli(['cancel', '--ticket', 'tkt_whatever', '--state-dir', stateDir]);
    assert.notEqual(noDaemon.code, 0);
    assert.match(noDaemon.stderr, /requires a running daemon/i);

    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const ticketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 'hangs', '--state-dir', stateDir, '--json',
    ]);
    const ticket = JSON.parse(ticketRes.stdout);

    const handle = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '30', '--json', '--fake-script', `${ticket.id}=hang`,
    ]);
    try {
      await handle.waitForListening();

      // A live daemon exists for this state dir, but this invocation names
      // a different --db -- cancel must refuse exactly as if no daemon
      // were running at all, not silently succeed against the wrong file.
      const wrongDb = await runCli([
        'cancel', '--ticket', ticket.id, '--state-dir', stateDir, '--db', join(stateDir, 'other.db'),
      ]);
      assert.notEqual(wrongDb.code, 0);
      assert.match(wrongDb.stderr, /requires a running daemon/i);

      const deadline = Date.now() + 3000;
      let inProgress = false;
      while (Date.now() < deadline) {
        const statusRes = await runCli(['status', '--project', project.id, '--state-dir', stateDir, '--json']);
        const tickets = JSON.parse(statusRes.stdout) as Array<{ id: string; status: string }>;
        if (tickets.find((t) => t.id === ticket.id)?.status === 'IN_PROGRESS') {
          inProgress = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(inProgress, "the daemon's own automatic first tick should have started the hanging ticket");

      const cancelRes = await runCli(['cancel', '--ticket', ticket.id, '--state-dir', stateDir, '--json']);
      assert.equal(cancelRes.code, 0, cancelRes.stderr);
      const cancelled = JSON.parse(cancelRes.stdout) as { status: string; attemptCount: number };
      assert.equal(cancelled.status, 'READY');
      assert.equal(cancelled.attemptCount, 0, 'a cancel must not consume an attempt');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("run --until-idle refuses against a live, matching daemon, but proceeds normally against one for a different --db", async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'until-idle-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      await handle.waitForListening();

      const refused = await runCli([
        'run', '--until-idle', '--project', project.id, '--state-dir', stateDir, '--json',
      ]);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /cannot run against a live daemon/i);

      // Same state dir, but a DIFFERENT --db: this is not the live daemon's
      // database, so `run --until-idle` proceeds locally exactly as it
      // always has -- the guard must not over-fire just because *some*
      // daemon happens to be running for the state directory.
      const otherDbPath = join(stateDir, 'other.db');
      const otherProjectRes = await runCli([
        'project', 'create', '--name', 'p2', '--state-dir', stateDir, '--db', otherDbPath, '--json',
      ]);
      const otherProject = JSON.parse(otherProjectRes.stdout);
      await runCli([
        'ticket', 'add', '--project', otherProject.id, '--title', 't', '--state-dir', stateDir, '--db', otherDbPath, '--json',
      ]);
      const proceeded = await runCli([
        'run', '--until-idle', '--project', otherProject.id, '--state-dir', stateDir, '--db', otherDbPath, '--json',
      ]);
      assert.equal(proceeded.code, 0, proceeded.stderr);
      const finalStatus = await runCli([
        'status', '--project', otherProject.id, '--state-dir', stateDir, '--db', otherDbPath, '--json',
      ]);
      const tickets = JSON.parse(finalStatus.stdout) as Array<{ status: string }>;
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0].status, 'DONE');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ticket add and decide route through a live matching daemon end to end (request body mapping and response formatting)', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'happy-path-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const blockedTicketRes = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 'needs a decision', '--state-dir', stateDir, '--json',
    ]);
    const blockedTicket = JSON.parse(blockedTicketRes.stdout);

    const handle = spawnServe([
      '--state-dir', stateDir, '--tick-interval', '0.1', '--json',
      '--fake-script', `${blockedTicket.id}=needs_user_decision`,
    ]);
    try {
      await handle.waitForListening();

      // ticket add, routed: request body mapping (acceptance criteria,
      // budget) must survive the trip.
      const createRes = await runCli([
        'ticket', 'add', '--project', project.id, '--title', 'routed ticket',
        '--acceptance', 'criterion one', '--acceptance', 'criterion two', '--budget', '0.5',
        '--state-dir', stateDir, '--json',
      ]);
      assert.equal(createRes.code, 0, createRes.stderr);
      const created = JSON.parse(createRes.stdout) as {
        title: string;
        acceptanceCriteria: string[];
        maxBudgetUsdOverride: number;
        status: string;
      };
      assert.equal(created.title, 'routed ticket');
      assert.deepEqual(created.acceptanceCriteria, ['criterion one', 'criterion two']);
      assert.equal(created.maxBudgetUsdOverride, 0.5);
      assert.equal(created.status, 'OPEN');

      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        const statusRes = await runCli(['status', '--project', project.id, '--state-dir', stateDir, '--json']);
        const tickets = JSON.parse(statusRes.stdout) as Array<{ id: string; status: string }>;
        if (tickets.find((t) => t.id === blockedTicket.id)?.status === 'BLOCKED') {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(blocked, "the daemon should have driven the fake-scripted ticket to BLOCKED");

      const decideRes = await runCli([
        'decide', '--ticket', blockedTicket.id, '--answer', 'use option A', '--state-dir', stateDir, '--json',
      ]);
      assert.equal(decideRes.code, 0, decideRes.stderr);
      const decided = JSON.parse(decideRes.stdout) as { status: string };
      assert.equal(decided.status, 'READY');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

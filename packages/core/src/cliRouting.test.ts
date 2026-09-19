import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from './process.ts';
import { deriveTestCliCwd, testTempRoot } from './testSupport.ts';

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
    const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    let stderr = '';
    p.onStdout((c) => (stdout += c));
    p.onStderr((c) => (stderr += c));
    p.wait().then((r) => resolve({ stdout, stderr, code: r.code }));
  });
}

// `status --json` is a plain, direct sqlite read (reads stay direct even
// while a daemon is running -- see cli.ts's liveDaemonFor comment), and
// node:sqlite sets no busy_timeout: under heavy concurrent load (the full
// suite running many test files at once), this CLI invocation can race the
// daemon's own in-flight write and come back with an empty/errored stdout
// rather than a parseable JSON array. Retried rather than parsed once, the
// same defensive pattern commands/serve.test.ts's own status() helper
// already uses for exactly this reason.
async function pollStatusOrEmpty(projectId: string, stateDir: string): Promise<Array<{ id: string; status: string }>> {
  try {
    const res = await runCli(['status', '--project', projectId, '--state-dir', stateDir, '--json']);
    return JSON.parse(res.stdout) as Array<{ id: string; status: string }>;
  } catch {
    return [];
  }
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
      // Batch 10 owner walk finding 3: `board` now refuses an unknown
      // project (cli.ts's `requireProject`) instead of silently returning
      // an empty board -- exactly what this project id is here, since it
      // was created in `otherDbPath`, not the daemon's own default db. This
      // is the corrected behaviour, not a regression: it is the whole proof
      // that the write went to the right file, just surfaced as a clean
      // "no such project" refusal now rather than a quietly empty board.
      assert.equal(daemonDbStatus.code, 1);
      assert.match(daemonDbStatus.stderr, new RegExp(`no such project: ${project.id}`));
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cancel: refuses with no daemon running, refuses against a daemon for a different --db, lands a live matching run in CANCELLED (not READY), and retry reopens it', async () => {
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
        const tickets = await pollStatusOrEmpty(project.id, stateDir);
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
      // Batch 8 ruling: terminal CANCELLED, not READY -- a person's cancel
      // must not let the daemon's own next tick silently restart the run.
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal(cancelled.attemptCount, 0, 'a cancel must not consume an attempt');

      // No second run starts on its own: give the daemon a beat, then
      // confirm the ticket is still exactly where cancel left it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterWait = await pollStatusOrEmpty(project.id, stateDir);
      assert.equal(afterWait.find((t) => t.id === ticket.id)?.status, 'CANCELLED');

      // retry is the one explicit way back to READY.
      const retryRes = await runCli(['retry', '--ticket', ticket.id, '--state-dir', stateDir, '--json']);
      assert.equal(retryRes.code, 0, retryRes.stderr);
      assert.equal(JSON.parse(retryRes.stdout).status, 'READY');
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

// Strategist ruling: daemonApi.ts's handlePlan (Role R) calls planProject
// against the project's scope document, never reading a `mission` string --
// against a live daemon used to silently drop the mission text and plan
// from whatever the scope/board already said. Landed first as a clean
// refusal for EVERY mission string ("so no commit in history carries a
// silent path"); batch 11 part 2 replaced that blanket refusal with
// planWithMission's real rule (commands/plan.ts): seed an empty scope, or
// refuse only once the scope already has content. This test used to claim
// "any --mission against a live daemon refuses" -- that claim moved to a
// different input (a project whose scope is NOT empty), so per the
// project's "a test is split, not re-pointed" rule this test is CONVERTED
// to cover exactly that branch, seeding the scope itself first so the
// refusal it asserts is the real one. The companion "seeds an empty scope"
// branch gets its own new test below.
test('plan --mission against a live daemon refuses cleanly once the scope already has content, but plan with no --mission still routes through', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'plan-mission-refusal-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      await handle.waitForListening();

      // Seed the scope for real, through the same route, before the branch
      // under test even runs -- this is exactly how a second `--mission`
      // would be reached in real use.
      const seeded = await runCli([
        'plan', '--project', project.id, '--mission', 'first version of the scope', '--state-dir', stateDir, '--json',
      ]);
      assert.equal(seeded.code, 0, seeded.stderr);

      const refused = await runCli([
        'plan', '--project', project.id, '--mission', 'ship the thing', '--state-dir', stateDir, '--json',
      ]);
      assert.notEqual(
        refused.code,
        0,
        'a mission string against a project whose scope already has content must refuse, not silently re-seed it'
      );
      assert.match(refused.stderr, /already has a scope/i);
      assert.match(refused.stderr, /discuss/i);

      const statusAfterRefusal = await runCli(['status', '--project', project.id, '--state-dir', stateDir, '--json']);
      const ticketsAfterRefusal = JSON.parse(statusAfterRefusal.stdout) as Array<{ id: string }>;
      assert.equal(ticketsAfterRefusal.length, 1, 'a refused plan must create no additional manager ticket');

      // No --mission at all: this is the supported shape (interview/re-plan
      // against the current scope+board), and must still route through to
      // the daemon exactly as before this refusal was added.
      const planned = await runCli(['plan', '--project', project.id, '--state-dir', stateDir, '--json']);
      assert.equal(planned.code, 0, planned.stderr);
      const managerTicket = JSON.parse(planned.stdout) as { id: string; kind: string };
      assert.equal(managerTicket.kind, 'manager');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('plan --mission against a live daemon seeds an empty scope file whole, then plans from it', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'plan-mission-seed-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout) as { id: string; scopePath: string };
    assert.ok(project.scopePath, 'project create must assign every project a scope path by default');

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      await handle.waitForListening();

      const mission = 'Build the quarterly reporting dashboard.';
      const planned = await runCli(['plan', '--project', project.id, '--mission', mission, '--state-dir', stateDir, '--json']);
      assert.equal(planned.code, 0, planned.stderr);
      const managerTicket = JSON.parse(planned.stdout) as { id: string; kind: string; title: string };
      assert.equal(managerTicket.kind, 'manager');
      assert.equal(managerTicket.title, mission, 'a short single-line mission is the ticket title verbatim');

      assert.equal(readFileSync(project.scopePath, 'utf8'), mission, 'the scope file must hold the mission whole');

      const activityRes = await runCli(['activity', '--project', project.id, '--state-dir', stateDir, '--json']);
      const events = JSON.parse(activityRes.stdout) as Array<{ eventType: string; payload: unknown }>;
      const scopeUpdated = events.filter((e) => e.eventType === 'scope_updated');
      assert.equal(scopeUpdated.length, 1);
      assert.deepEqual(scopeUpdated[0].payload, { summary: 'seeded from --mission' });
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('discuss --project --message routes through a live matching daemon to POST /projects/{id}/discuss', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'discuss-routing-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);

    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      await handle.waitForListening();

      const res = await runCli([
        'discuss', '--project', project.id, '--message', 'What next?', '--state-dir', stateDir, '--json',
      ]);
      assert.equal(res.code, 0, res.stderr);
      const ticket = JSON.parse(res.stdout) as { id: string; kind: string };
      assert.equal(ticket.kind, 'manager');

      const activityRes = await runCli(['activity', '--project', project.id, '--state-dir', stateDir, '--json']);
      const events = JSON.parse(activityRes.stdout) as Array<{ eventType: string; payload: { message?: string } }>;
      const discussEvents = events.filter((e) => e.eventType === 'discuss');
      assert.equal(discussEvents.length, 1);
      assert.equal(discussEvents[0].payload.message, 'What next?');
    } finally {
      await handle.kill();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Ruling 16: `--expected-artifact` is a new entry in `ticket add`'s allowed
// flag list (cli.ts FLAG_SPECS). This is the direct-write path (no live
// daemon), which is enough to prove the flag is not rejected by
// checkKnownFlags -- that check runs before the daemon-routing decision, so
// it applies identically either way.
test('ticket add --expected-artifact is on the allowed flag list', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'expected-artifact-flag-'));
  try {
    const projectRes = await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json']);
    const project = JSON.parse(projectRes.stdout);
    const res = await runCli([
      'ticket', 'add', '--project', project.id, '--title', 't',
      '--expected-artifact', 'out.md', '--state-dir', stateDir, '--json',
    ]);
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /Unknown flag/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Ruling 20: `token` is a known command whose allowed flags beyond the
// common `--state-dir`/`--json` are exactly empty (cli.ts's FLAG_SPECS). No
// daemon is spawned here -- an unknown-flag refusal happens in
// checkKnownFlags, before the command handler (and so before any daemon
// lookup or clipboard step) ever runs.
test('token: an unrelated flag is refused as unknown, and --state-dir/--json alone are not', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'token-flags-'));
  try {
    const withUnknownFlag = await runCli(['token', '--project', 'p1', '--state-dir', stateDir]);
    assert.notEqual(withUnknownFlag.code, 0);
    assert.match(withUnknownFlag.stderr, /Unknown flag/);
    assert.match(withUnknownFlag.stderr, /--project/);

    const withOnlyCommonFlags = await runCli(['token', '--state-dir', stateDir, '--json']);
    assert.doesNotMatch(withOnlyCommonFlags.stderr, /Unknown flag/);
    // No daemon running for this state dir -- refused for that reason
    // instead, proving the flag check passed and the real handler ran.
    assert.notEqual(withOnlyCommonFlags.code, 0);
    assert.match(withOnlyCommonFlags.stderr, /no live daemon/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Ruling 23: `--max-parallel` is a known `project set` flag, and against a
// live matching daemon it routes the same way `--max-spend` does
// (POST /projects/{id}/set), where the SAME store validator refuses a bad
// value -- checked here for a non-number too, since NaN would otherwise
// serialise to JSON null and arrive at the daemon as "not given".
test('project set --max-parallel is a known flag and routes through a live daemon like --max-spend, refusing bad values before any request', async () => {
  const stateDir = mkdtempSync(join(testRoot.root, 'set-maxparallel-'));
  try {
    const project = JSON.parse(
      (await runCli(['project', 'create', '--name', 'p', '--state-dir', stateDir, '--json'])).stdout
    ) as { id: string };
    const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '30', '--json']);
    try {
      await handle.waitForListening();

      const ok = await runCli(['project', 'set', '--project', project.id, '--max-parallel', '3', '--state-dir', stateDir, '--json']);
      assert.equal(ok.code, 0, ok.stderr);
      assert.doesNotMatch(ok.stderr, /Unknown flag/);
      assert.equal((JSON.parse(ok.stdout) as { maxParallelWorkers: number }).maxParallelWorkers, 3);

      for (const bad of ['0', 'abc']) {
        const refused = await runCli(['project', 'set', '--project', project.id, '--max-parallel', bad, '--state-dir', stateDir]);
        assert.notEqual(refused.code, 0, `--max-parallel ${bad} must be refused, live daemon or not`);
        assert.match(refused.stderr, /whole number of 1 or more/);
      }
      // A no-op set that echoes the row back: the refused values changed nothing.
      const echoed = await runCli(['project', 'set', '--project', project.id, '--max-spend', '5', '--state-dir', stateDir, '--json']);
      assert.equal((JSON.parse(echoed.stdout) as { maxParallelWorkers: number }).maxParallelWorkers, 3);
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
        const tickets = await pollStatusOrEmpty(project.id, stateDir);
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

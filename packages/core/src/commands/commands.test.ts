import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from '../process.ts';

// Every test here drives the real `magarine` CLI entry point against a
// temporary sqlite file, per this role's working method: a command that
// only works when called as a function has not been tested.

const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, ...args] });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  return { code: result.code, stdout, stderr };
}

function withTempDb<T>(prefix: string, fn: (dbFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbFile = join(dir, 'magarine.db');
  return fn(dbFile).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('ticket add accepts --budget, repeatable --acceptance, and repeatable --depends-on in one command', async () => {
  await withTempDb('magarine-ticketflags-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );

    const blockerA = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'A', '--json', '--db', dbFile])).stdout
    );
    const blockerB = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'B', '--json', '--db', dbFile])).stdout
    );

    const res = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'C',
      '--workspace',
      'DIRECTORY',
      '--budget',
      '1.50',
      '--acceptance',
      'criterion one',
      '--acceptance',
      'criterion two',
      '--depends-on',
      blockerA.id,
      '--depends-on',
      blockerB.id,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const ticket = JSON.parse(res.stdout);

    assert.deepEqual(ticket.acceptanceCriteria, ['criterion one', 'criterion two']);
    assert.equal(ticket.workspaceType, 'DIRECTORY');
    // Neither blocker is DONE yet, so the ticket must not have been
    // promoted to READY -- readiness is resolved only after both
    // --depends-on ids are attached, never before.
    assert.equal(ticket.status, 'OPEN', 'a ticket with unfinished dependencies must not be READY');

    const board = JSON.parse((await run(['board', '--project', project.id, '--json', '--db', dbFile])).stdout) as {
      tickets: Array<{ id: string; blockedBy: string[] }>;
    };
    const cRow = board.tickets.find((t: { id: string }) => t.id === ticket.id)!;
    assert.deepEqual(cRow.blockedBy.sort(), [blockerA.id, blockerB.id].sort());
  });
});

test('ticket add: a lone --depends-on (no dependency actually finished) still leaves the ticket unready, matching dep add', async () => {
  await withTempDb('magarine-ticketflags2-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P2', '--json', '--db', dbFile])).stdout
    );
    const blocker = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'BLOCKER', '--json', '--db', dbFile])).stdout
    );
    const dependentRes = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'DEPENDENT',
      '--depends-on',
      blocker.id,
      '--json',
      '--db',
      dbFile,
    ]);
    const dependent = JSON.parse(dependentRes.stdout);
    assert.equal(dependent.status, 'OPEN');

    const runRes = await run(['run', '--until-idle', '--project', project.id, '--json', '--db', dbFile]);
    assert.equal(runRes.code, 0, runRes.stderr);
    const finalStatus = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    for (const t of finalStatus) assert.equal(t.status, 'DONE');
  });
});

test('board shows attempts, cost, and blocking dependencies through the real CLI', async () => {
  await withTempDb('magarine-board-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'BoardP', '--json', '--db', dbFile])).stdout
    );
    const t1 = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T1', '--json', '--db', dbFile])).stdout
    );

    const res = await run(['run', '--until-idle', '--project', project.id, '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);

    const humanRes = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.equal(humanRes.code, 0, humanRes.stderr);
    assert.match(humanRes.stdout, new RegExp(`^${t1.id}\\t`, 'm'), 'ticket id must be first on its board line');
    assert.match(humanRes.stdout, /DONE/);
    assert.match(humanRes.stdout, /attempts \d+\/\d+/);
    assert.match(humanRes.stdout, /cost \$/);
  });
});

test('inbox shows a needs-user-decision item before decide, and not after', async () => {
  await withTempDb('magarine-inbox-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'InboxP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'NEEDS-DECISION', '--json', '--db', dbFile]))
        .stdout
    );

    const tickRes = await run([
      'tick',
      '--project',
      project.id,
      '--adapter',
      'fake',
      '--fake-script',
      `${ticket.id}=needs_user_decision`,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(tickRes.code, 0, tickRes.stderr);
    // Give the fake adapter's zero-delay scheduled event a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const statusBefore = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(statusBefore.find((t) => t.id === ticket.id)!.status, 'BLOCKED');

    const inboxBefore = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ ticketId: string }>;
    assert.ok(
      inboxBefore.some((i) => i.ticketId === ticket.id),
      'the BLOCKED ticket must show up in the inbox before it is decided'
    );

    const decideRes = await run([
      'decide',
      '--ticket',
      ticket.id,
      '--answer',
      'go ahead with option A',
      '--json',
      '--db',
      dbFile,
    ]);

    // No escape hatch: Role F's `user_decision` transition is landed and
    // committed (`8afe3b8`), so this must complete the whole round trip, not
    // merely fail in a way that looks like progress. (A prior version of
    // this test tolerated a clean `InvalidTransitionError` here as "expected
    // until it lands" -- that assertion was correct when it was written, but
    // it was still passing, unchanged, in the committed tree where `decide`
    // called the wrong event name and could never actually decide anything.
    // A green suite hid a dead command. Asserting `code === 0` here is what
    // would have caught that immediately.)
    assert.equal(decideRes.code, 0, decideRes.stderr);
    const decided = JSON.parse(decideRes.stdout) as { id: string; status: string };
    assert.equal(decided.status, 'READY', 'a decided ticket must be READY, not still BLOCKED');

    const inboxAfter = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ ticketId: string }>;
    assert.ok(
      !inboxAfter.some((i) => i.ticketId === ticket.id),
      'the ticket must no longer be in the inbox after it is decided'
    );

    const statusAfter = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(statusAfter.find((t) => t.id === ticket.id)!.status, 'READY');

    // The decision itself must be a persisted, readable record, not just a
    // side effect of the status change -- this is the contract
    // scheduler.ts's buildEnvelope reads `relevantDecisions` back out of.
    const activityAll = JSON.parse(
      (await run(['activity', '--ticket', ticket.id, '--all', '--json', '--db', dbFile])).stdout
    ) as Array<{ eventType: string; payload: { ticketId?: string; question?: string; answer?: string } }>;
    const decisionEvent = activityAll.find((e) => e.eventType === 'user_decision');
    assert.ok(decisionEvent, 'a user_decision event must be recorded on the ticket');
    assert.equal(decisionEvent!.payload.ticketId, ticket.id);
    assert.equal(decisionEvent!.payload.answer, 'go ahead with option A');
    assert.equal(
      typeof decisionEvent!.payload.question,
      'string',
      'the persisted decision must carry the question it answered'
    );
  });
});

test('decide refuses a ticket that is not BLOCKED, with a clean message instead of a stack trace', async () => {
  await withTempDb('magarine-decide-refuse-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'RefuseP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );

    const res = await run(['decide', '--ticket', ticket.id, '--answer', 'x', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not BLOCKED/);
    assert.doesNotMatch(res.stderr, /at .*\.ts:\d+/, 'must not print a stack trace');
  });
});

test('retry refuses a ticket that is not FAILED, with a clean message instead of a stack trace', async () => {
  await withTempDb('magarine-retry-refuse-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'RetryRefuseP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );

    const res = await run(['retry', '--ticket', ticket.id, '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not FAILED/);
    assert.doesNotMatch(res.stderr, /at .*\.ts:\d+/, 'must not print a stack trace');
  });
});

test('retry: a ticket that exhausts its attempts reaches FAILED and can be retried', async () => {
  await withTempDb('magarine-retry-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'RetryP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (
        await run([
          'ticket',
          'add',
          '--project',
          project.id,
          '--title',
          'FLAKY',
          '--max-attempts',
          '1',
          '--json',
          '--db',
          dbFile,
        ])
      ).stdout
    );

    const runRes = await run([
      'run',
      '--until-idle',
      '--project',
      project.id,
      '--adapter',
      'fake',
      '--fake-script',
      `${ticket.id}=retryable_failure`,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(runRes.code, 0, runRes.stderr);

    const statusBefore = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(statusBefore.find((t) => t.id === ticket.id)!.status, 'FAILED');

    // No escape hatch: Role F's `manual_retry` transition is landed and
    // committed. Also confirm the transition's documented side effect
    // (max_attempts raised by one), not just the status change, so a
    // ticket that was already at its cap can actually run again.
    const retryRes = await run(['retry', '--ticket', ticket.id, '--json', '--db', dbFile]);
    assert.equal(retryRes.code, 0, retryRes.stderr);
    const retried = JSON.parse(retryRes.stdout) as { status: string; maxAttempts: number };
    assert.equal(retried.status, 'READY');
    assert.equal(retried.maxAttempts, 2, 'manual_retry must raise max_attempts by one (was 1)');

    const runAgain = await run(['run', '--until-idle', '--project', project.id, '--json', '--db', dbFile]);
    assert.equal(runAgain.code, 0, runAgain.stderr);
    const finalStatus = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(
      finalStatus.find((t) => t.id === ticket.id)!.status,
      'DONE',
      'after retry, an unscripted fake run must succeed and reach DONE'
    );
  });
});

test('activity hides internal events by default and shows them with --all', async () => {
  await withTempDb('magarine-activity-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'ActivityP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );
    await run(['run', '--until-idle', '--project', project.id, '--json', '--db', dbFile]);

    const collapsed = JSON.parse(
      (await run(['activity', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ visibility: string }>;
    assert.ok(collapsed.length > 0, 'expected at least one activity-visible event (e.g. worker_done)');
    assert.ok(collapsed.every((e) => e.visibility !== 'internal'), 'internal events must be hidden by default');

    const all = JSON.parse(
      (await run(['activity', '--project', project.id, '--all', '--json', '--db', dbFile])).stdout
    ) as Array<{ visibility: string }>;
    assert.ok(all.length >= collapsed.length);
    assert.ok(all.some((e) => e.visibility === 'internal'), '--all must surface internal events too (e.g. run_started)');

    const byTicket = JSON.parse(
      (await run(['activity', '--ticket', ticket.id, '--all', '--json', '--db', dbFile])).stdout
    ) as Array<{ entityId: string }>;
    assert.ok(byTicket.length > 0);
    assert.ok(byTicket.every((e) => e.entityId === ticket.id));
  });
});

test('resume clears a project adapter pause', async () => {
  const { openDb } = await import('../db/index.ts');
  const { pauseProjectAdapter, isProjectAdapterPaused } = await import('../store.ts');

  await withTempDb('magarine-resume-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'ResumeP', '--json', '--db', dbFile])).stdout
    );

    // There is no CLI path to pause a project yet (that happens when
    // scheduler.ts observes an `adapter_unavailable` failure, which is
    // Role F's work, still in progress) so the precondition is seeded
    // directly against the store, the same way this project already seeds
    // fake-adapter behaviour outside the CLI's normal command surface. Only
    // the seeding is direct; `resume` itself is exercised through the real
    // CLI below.
    const seedDb = openDb(dbFile);
    pauseProjectAdapter(seedDb, project.id);
    assert.ok(isProjectAdapterPaused(seedDb, project.id));
    seedDb.close();

    const res = await run(['resume', '--adapter', project.id, '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const resumed = JSON.parse(res.stdout);
    assert.equal(resumed.id, project.id);
    assert.equal(resumed.adapterPausedAt, null);
  });
});

test('resume refuses a project that is not paused, and an unknown project id, with clean messages', async () => {
  await withTempDb('magarine-resume-refuse-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'ResumeP2', '--json', '--db', dbFile])).stdout
    );

    const notPaused = await run(['resume', '--adapter', project.id, '--db', dbFile]);
    assert.notEqual(notPaused.code, 0);
    assert.match(notPaused.stderr, /not paused/);
    assert.doesNotMatch(notPaused.stderr, /at .*\.ts:\d+/, 'must not print a stack trace');

    const unknown = await run(['resume', '--adapter', 'proj_does_not_exist', '--db', dbFile]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /no such project/);
  });
});

test('project create accepts --brief and --workspace-root, persisted on the project', async () => {
  await withTempDb('magarine-project-brief-', async (dbFile) => {
    const res = await run([
      'project',
      'create',
      '--name',
      'BriefP',
      '--brief',
      'Build the weekend MVP.',
      '--workspace-root',
      dbFile + '.workroot',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const project = JSON.parse(res.stdout) as { brief: string; workspaceRoot: string };
    assert.equal(project.brief, 'Build the weekend MVP.');
    assert.equal(project.workspaceRoot, dbFile + '.workroot');
  });
});

test('project create without --brief/--workspace-root leaves them null, unchanged from before this flag existed', async () => {
  await withTempDb('magarine-project-nobrief-', async (dbFile) => {
    const res = await run(['project', 'create', '--name', 'NoBriefP', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const project = JSON.parse(res.stdout) as { brief: string | null; workspaceRoot: string | null };
    assert.equal(project.brief, null);
    assert.equal(project.workspaceRoot, null);
  });
});

test('--run-timeout cancels a hung fake run: ticket returns to READY without consuming an attempt', async () => {
  await withTempDb('magarine-run-timeout-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'TimeoutP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'HANGS', '--json', '--db', dbFile])).stdout
    );

    // The scheduler's own timeout is a pending timer inside this `tick`
    // process, so Node keeps the process alive and this `run()` call does
    // not return until the timer has fired and the cancellation has been
    // applied -- no extra sleep needed after it.
    const tickRes = await run([
      'tick',
      '--project',
      project.id,
      '--fake-script',
      `${ticket.id}=hang`,
      '--run-timeout',
      '1',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(tickRes.code, 0, tickRes.stderr);

    const status = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string; attemptCount: number }>;
    const timedOut = status.find((t) => t.id === ticket.id)!;
    assert.equal(timedOut.status, 'READY', 'a timed-out run must return its ticket to READY');
    assert.equal(timedOut.attemptCount, 0, 'a daemon-initiated cancellation must not consume an attempt');

    const activity = JSON.parse(
      (await run(['activity', '--ticket', ticket.id, '--all', '--json', '--db', dbFile])).stdout
    ) as Array<{ eventType: string }>;
    assert.ok(
      activity.some((e) => e.eventType === 'run_cancelled'),
      'a run_cancelled event must be recorded'
    );
  });
});

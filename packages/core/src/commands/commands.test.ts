import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSyncResilient } from '../db/testSupport.ts';
import { spawnManaged } from '../process.ts';
import { testTempRoot } from '../testSupport.ts';

// Every test here drives the real `magarine` CLI entry point against a
// temporary sqlite file, per this role's working method: a command that
// only works when called as a function has not been tested.

const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));

// Batch 6 item 5: this file's own private root under the OS temp directory
// (testSupport.ts's testTempRoot), rather than every `withTempDb` call
// creating its own prefixed directory directly inside the shared tmpdir() --
// see that function's doc comment. Each call still gets its own mkdtemp'd
// subdirectory and its own cleanup; this only changes where in the
// filesystem hierarchy that subdirectory lives.
const testRoot = testTempRoot('commands');
after(testRoot.cleanup);

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
  const dir = mkdtempSync(join(testRoot.root, prefix));
  const dbFile = join(dir, 'magarine.db');
  return fn(dbFile).finally(() => rmSyncResilient(dir));
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

test('board shows project spend against its cap at the top, above the ticket rows', async () => {
  await withTempDb('magarine-board-spend-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'NoCap', '--json', '--db', dbFile])).stdout
    );
    const res = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.split('\n');
    assert.match(lines[0], /^Project spend: \$\d+\.\d{2} \(/, 'the spend line must be the first line of the board');
    assert.match(lines[0], /no cap set/, 'a project with no --max-spend has no cap, not a fabricated one');

    const jsonRes = JSON.parse((await run(['board', '--project', project.id, '--json', '--db', dbFile])).stdout) as {
      projectSpendUsd: number;
      projectMaxSpendUsd: number | null;
    };
    assert.equal(jsonRes.projectSpendUsd, 0);
    assert.equal(jsonRes.projectMaxSpendUsd, null);
  });
});

// Batch 6, per the Strategist's ruling: a number sourced from the daemon's
// own live tally (usage_json.source === 'scheduler_budget_estimate') must
// read "at least $x, live estimate" on the board, not look as exact as a
// completed run's tool-reported figure. There is no CLI path to make
// FakeAdapter report a scheduler-estimate-sourced run (--fake-script has no
// 'progress' kind), so the run row is seeded directly against the store --
// same pattern as `seedTicketInReview` above -- and `board` itself is
// exercised through the real CLI.
test("board labels a ticket's cost 'at least $x, live estimate' when its usage came from the daemon's own tally, and shows a plain figure when it came from the tool", async () => {
  const { openDb } = await import('../db/index.ts');
  const { createRun, setRunUsage } = await import('../store.ts');

  await withTempDb('magarine-board-estimate-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);
    const estimated = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'estimated', '--json', '--db', dbFile])).stdout
    );
    const exact = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'exact', '--json', '--db', dbFile])).stdout
    );

    const db = openDb(dbFile);
    const estimatedRun = createRun(db, { ticketId: estimated.id, attempt: 1, adapter: 'test' });
    setRunUsage(db, estimatedRun.id, { total_cost_usd: 0.42, source: 'scheduler_budget_estimate' });
    const exactRun = createRun(db, { ticketId: exact.id, attempt: 1, adapter: 'test' });
    setRunUsage(db, exactRun.id, { total_cost_usd: 0.5 });
    db.close();

    const boardRes = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.equal(boardRes.code, 0, boardRes.stderr);
    assert.match(
      boardRes.stdout,
      new RegExp(`^${estimated.id}\\t.*cost at least \\$0\\.42, live estimate`, 'm'),
      'an estimate-sourced run must be labelled, not shown as a plain figure'
    );
    assert.match(
      boardRes.stdout,
      new RegExp(`^${exact.id}\\t.*cost \\$0\\.50(?!,)`, 'm'),
      "a tool-sourced run must show a plain figure, not labelled 'live estimate'"
    );
    assert.match(boardRes.stdout.split('\n')[0], /^Project spend: at least \$0\.92, live estimate/,
      'one estimated ticket makes the whole project total a lower bound too');

    const jsonRes = JSON.parse((await run(['board', '--project', project.id, '--json', '--db', dbFile])).stdout) as {
      projectSpendIsEstimate: boolean;
      tickets: Array<{ id: string; costIsEstimate: boolean }>;
    };
    assert.equal(jsonRes.projectSpendIsEstimate, true);
    assert.equal(jsonRes.tickets.find((t) => t.id === estimated.id)!.costIsEstimate, true);
    assert.equal(jsonRes.tickets.find((t) => t.id === exact.id)!.costIsEstimate, false);
  });
});

test("inbox labels a scheduler budget-stop's spend 'live estimate' since tally/overshoot never appear on the tool's own stop", async () => {
  const { openDb } = await import('../db/index.ts');
  const { getTicket } = await import('../store.ts');
  const { resolveReadiness } = await import('../dependencies.ts');
  const { recordTicketTransition } = await import('../stateMachine.ts');
  const { newId } = await import('../id.ts');

  await withTempDb('magarine-inbox-budgetstop-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'went over', '--json', '--db', dbFile])).stdout
    );

    const db = openDb(dbFile);
    resolveReadiness(db, project.id);
    recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: newId('evt'), payload: {} });
    recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'worker_failure',
      idempotencyKey: newId('evt'),
      payload: { retryable: false, failureClass: 'budget_exceeded', stoppedBy: 'scheduler_estimate', tally: 0.42, ceiling: 0.4, overshoot: 0.02 },
    });
    assert.equal(getTicket(db, ticket.id)!.status, 'FAILED');
    db.close();

    const inboxJson = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ ticketId?: string; eventType: string; message: string }>;
    const item = inboxJson.find((i) => i.eventType === 'worker_failed_final');
    assert.ok(item, 'the exhausted budget-stop failure must reach the inbox');
    assert.match(item!.message, /spent at least \$0\.42 \(live estimate\)/);
    assert.match(item!.message, /over its ceiling by at least \$0\.02/);
  });
});

test('project create --max-spend and project set --max-spend both take effect end-to-end, visible on the board', async () => {
  await withTempDb('magarine-maxspend-', async (dbFile) => {
    const createRes = await run(['project', 'create', '--name', 'Capped', '--max-spend', '5', '--json', '--db', dbFile]);
    assert.equal(createRes.code, 0, createRes.stderr);
    const project = JSON.parse(createRes.stdout);
    const boardRes = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.match(boardRes.stdout, /cap \$5\.00/, 'board header must reflect the cap set at creation');

    const setRes = await run(['project', 'set', '--project', project.id, '--max-spend', '9', '--db', dbFile]);
    assert.equal(setRes.code, 0, setRes.stderr);
    const boardRes2 = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.match(boardRes2.stdout, /cap \$9\.00/, 'project set --max-spend must update the cap the board shows');
  });
});

test('batch 6 item 4: project create --model defaults every ticket to that model, project set --model changes the default, and ticket add --model overrides one ticket', async () => {
  await withTempDb('magarine-model-pinning-', async (dbFile) => {
    const createRes = await run([
      'project',
      'create',
      '--name',
      'Pinned',
      '--model',
      'claude-opus-5',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(createRes.code, 0, createRes.stderr);
    const project = JSON.parse(createRes.stdout);
    assert.equal(project.defaultModel, 'claude-opus-5');

    const noOverrideTicket = JSON.parse(
      (
        await run(['ticket', 'add', '--project', project.id, '--title', 'uses project default', '--json', '--db', dbFile])
      ).stdout
    );
    assert.equal(noOverrideTicket.model, null, "a ticket with no --model must store NULL, not a copy of the project's default");

    const overrideTicket = JSON.parse(
      (
        await run([
          'ticket',
          'add',
          '--project',
          project.id,
          '--title',
          'overrides the project default',
          '--model',
          'claude-haiku-4-5-20251001',
          '--json',
          '--db',
          dbFile,
        ])
      ).stdout
    );
    assert.equal(overrideTicket.model, 'claude-haiku-4-5-20251001');

    const setRes = await run(['project', 'set', '--project', project.id, '--model', 'claude-sonnet-5', '--json', '--db', dbFile]);
    assert.equal(setRes.code, 0, setRes.stderr);
    assert.equal(JSON.parse(setRes.stdout).defaultModel, 'claude-sonnet-5');
  });
});

test("a project created without --model defaults defaultModel to 'claude-sonnet-5'", async () => {
  await withTempDb('magarine-model-default-', async (dbFile) => {
    const res = await run(['project', 'create', '--name', 'Unpinned', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).defaultModel, 'claude-sonnet-5');
  });
});

test('project create --max-spend below the floor is refused with a message naming the floor, not silently accepted', async () => {
  await withTempDb('magarine-maxspend-floor-', async (dbFile) => {
    const res = await run(['project', 'create', '--name', 'TooCheap', '--max-spend', '0.01', '--json', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /\$0\.25/, 'the refusal must name the floor');
    assert.doesNotMatch(res.stderr, /\.ts:\d+/, 'must not leak a raw stack trace to the user');
  });
});

test('ticket add --budget below the floor is refused with a message naming the floor, not silently accepted', async () => {
  await withTempDb('magarine-budget-floor-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const res = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'cheap',
      '--budget',
      '0.01',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.notEqual(res.code, 0, 'a below-floor --budget must be refused, not silently stored');
    assert.match(res.stderr, /\$0\.25/, 'the refusal must name the floor');
    assert.doesNotMatch(res.stderr, /\.ts:\d+/, 'must not leak a raw stack trace to the user');
  });
});

test('project set on an unknown project id fails by name, not with a silent no-op or a DB error', async () => {
  await withTempDb('magarine-projectset-unknown-', async (dbFile) => {
    await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    const res = await run(['project', 'set', '--project', 'proj_doesnotexist', '--max-spend', '5', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    // Batch 10 (Role Q), item 2: `project set` now shares cli.ts's single
    // resolveProjectRef/NoSuchProjectError path (also what makes `--project`
    // accept a name, not just an id) instead of its own separately-worded
    // "No such project" check, so the message matches every other
    // project-taking command exactly.
    assert.match(res.stderr, /no such project: proj_doesnotexist/);
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
    ) as Array<{ ticketId: string; message: string }>;
    const blockedItem = inboxBefore.find((i) => i.ticketId === ticket.id);
    assert.ok(blockedItem, 'the BLOCKED ticket must show up in the inbox before it is decided');
    // Every inbox line must name the next command: a decide item names the
    // exact `decide` invocation, not just the reason it is blocked.
    assert.match(blockedItem!.message, new RegExp(`magarine decide --ticket ${ticket.id} --answer`));

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
    pauseProjectAdapter(seedDb, project.id, 'adapter_unavailable');
    assert.ok(isProjectAdapterPaused(seedDb, project.id));
    seedDb.close();

    const res = await run(['resume', '--project', project.id, '--json', '--db', dbFile]);
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

    const notPaused = await run(['resume', '--project', project.id, '--db', dbFile]);
    assert.notEqual(notPaused.code, 0);
    assert.match(notPaused.stderr, /not paused/);
    assert.doesNotMatch(notPaused.stderr, /at .*\.ts:\d+/, 'must not print a stack trace');

    const unknown = await run(['resume', '--project', 'proj_does_not_exist', '--db', dbFile]);
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

// There is no CLI path to get a ticket into REVIEW yet: FakeAdapter's
// FakeScript union (adapters/fakeAdapter.ts, not this role's file) has no
// `review` kind, only 'done' | 'needs_user_decision' | ... via `succeed` /
// `needs_user_decision` / etc. So REVIEW is seeded directly against the
// state machine here, the same pattern this file already uses for an
// adapter pause precondition above ("There is no CLI path to pause a
// project yet..."): only the seeding is direct, `approve`/`reject`
// themselves are exercised through the real CLI below.
async function seedTicketInReview(dbFile: string, ticketId: string): Promise<void> {
  const { openDb } = await import('../db/index.ts');
  const { getTicket } = await import('../store.ts');
  const { resolveReadiness } = await import('../dependencies.ts');
  const { recordTicketTransition } = await import('../stateMachine.ts');
  const { newId } = await import('../id.ts');
  const db = openDb(dbFile);
  try {
    // A freshly created ticket with no dependencies is OPEN, not READY, until
    // something resolves readiness for its project (see dependencies.ts) --
    // `run_started` requires READY. Closed in `finally` regardless: an
    // uncaught throw here previously left the handle open for the rest of
    // this test process, which is what caused the temp directory's cleanup
    // to fail with a persistent EPERM further down.
    const ticket = getTicket(db, ticketId)!;
    resolveReadiness(db, ticket.projectId);
    recordTicketTransition(db, { ticketId, event: 'run_started', idempotencyKey: newId('evt'), payload: {} });
    recordTicketTransition(db, { ticketId, event: 'worker_needs_review', idempotencyKey: newId('evt'), payload: {} });
  } finally {
    db.close();
  }
}

test('approve moves a REVIEW ticket to DONE and unblocks its dependent', async () => {
  await withTempDb('magarine-approve-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'ApproveP', '--json', '--db', dbFile])).stdout
    );
    const blocker = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'BLOCKER', '--json', '--db', dbFile])).stdout
    );
    const dependent = JSON.parse(
      (
        await run([
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
        ])
      ).stdout
    );
    assert.equal(dependent.status, 'OPEN', 'must not be READY while its blocker is unresolved');

    await seedTicketInReview(dbFile, blocker.id);

    const res = await run(['approve', '--ticket', blocker.id, '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const approved = JSON.parse(res.stdout);
    assert.equal(approved.status, 'DONE');

    const statusAfter = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(
      statusAfter.find((t) => t.id === dependent.id)!.status,
      'READY',
      'approving the blocker must resolve its dependent to READY without a separate tick'
    );
  });
});

test('approve refuses a ticket that is not in REVIEW, with a clean message', async () => {
  await withTempDb('magarine-approve-refuse-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );
    const res = await run(['approve', '--ticket', ticket.id, '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not REVIEW/);
    assert.doesNotMatch(res.stderr, /\.ts:\d+/, 'must not leak a stack trace');
  });
});

test('reject returns a REVIEW ticket to READY and consumes an attempt', async () => {
  await withTempDb('magarine-reject-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'RejectP', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );
    assert.equal(ticket.attemptCount, 0);

    await seedTicketInReview(dbFile, ticket.id);

    const res = await run([
      'reject',
      '--ticket',
      ticket.id,
      '--reason',
      'missing test coverage',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const rejected = JSON.parse(res.stdout);
    assert.equal(rejected.status, 'READY');
    assert.equal(rejected.attemptCount, 1, 'a rejection consumes an attempt, same as a worker failure');
  });
});

test('reject without --reason is refused, not silently accepted with an empty reason', async () => {
  await withTempDb('magarine-reject-noreason-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );
    await seedTicketInReview(dbFile, ticket.id);

    const res = await run(['reject', '--ticket', ticket.id, '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /--reason/);
  });
});

test('reject on the last attempt exhausts to FAILED as worker_failed_final and reaches the inbox with the reason on the line', async () => {
  await withTempDb('magarine-reject-exhaust-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (
        await run([
          'ticket',
          'add',
          '--project',
          project.id,
          '--title',
          'T',
          '--max-attempts',
          '1',
          '--json',
          '--db',
          dbFile,
        ])
      ).stdout
    );
    await seedTicketInReview(dbFile, ticket.id);

    const res = await run([
      'reject',
      '--ticket',
      ticket.id,
      '--reason',
      'fundamentally the wrong approach',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const rejected = JSON.parse(res.stdout);
    assert.equal(rejected.status, 'FAILED', 'exhausted on the last attempt, same as any other exhausted failure');

    const inbox = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ ticketId?: string; eventType: string; message: string }>;
    const item = inbox.find((i) => i.ticketId === ticket.id);
    assert.ok(item, 'an exhausted rejection must reach the inbox');
    assert.equal(item!.eventType, 'worker_failed_final');
    assert.match(item!.message, /fundamentally the wrong approach/, 'the reason must be on the line, not just the event type');
    // Every inbox line must name the next command: a failed-final item names
    // the exact `retry` invocation, not just its reason for failing.
    assert.match(item!.message, new RegExp(`magarine retry --ticket ${ticket.id}`));
  });
});

// --- Batch 5 item 5: --fake-outcome, and approve/reject end to end without seeding state ---

test('--fake-outcome review lands a ticket in REVIEW through a real tick, and approve moves it to DONE end to end', async () => {
  await withTempDb('magarine-fake-outcome-review-approve-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );

    const tickRes = await run([
      'tick',
      '--project',
      project.id,
      '--adapter',
      'fake',
      '--fake-outcome',
      `${ticket.id}=review`,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(tickRes.code, 0, tickRes.stderr);

    const statusAfterTick = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(
      statusAfterTick.find((t) => t.id === ticket.id)!.status,
      'REVIEW',
      'a real tick with --fake-outcome review must land the ticket in REVIEW without seeding the state machine directly'
    );

    const approveRes = await run(['approve', '--ticket', ticket.id, '--json', '--db', dbFile]);
    assert.equal(approveRes.code, 0, approveRes.stderr);
    assert.equal(JSON.parse(approveRes.stdout).status, 'DONE');
  });
});

test('--fake-outcome review lands a ticket in REVIEW through a real tick, and reject returns it to READY end to end', async () => {
  await withTempDb('magarine-fake-outcome-review-reject-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );

    const tickRes = await run([
      'tick',
      '--project',
      project.id,
      '--adapter',
      'fake',
      '--fake-outcome',
      `${ticket.id}=review`,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(tickRes.code, 0, tickRes.stderr);
    assert.equal(
      (
        JSON.parse((await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout) as Array<{
          id: string;
          status: string;
        }>
      ).find((t) => t.id === ticket.id)!.status,
      'REVIEW'
    );

    const rejectRes = await run([
      'reject',
      '--ticket',
      ticket.id,
      '--reason',
      'needs another pass',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(rejectRes.code, 0, rejectRes.stderr);
    const rejected = JSON.parse(rejectRes.stdout);
    assert.equal(rejected.status, 'READY');
    assert.equal(rejected.attemptCount, 1);
  });
});

test('batch 5 item 6: the inbox line for a review item shows the worker\'s summary as its reason, not the event type', async () => {
  await withTempDb('magarine-inbox-review-reason-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );

    const tickRes = await run([
      'tick',
      '--project',
      project.id,
      '--adapter',
      'fake',
      '--fake-outcome',
      `${ticket.id}=review`,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(tickRes.code, 0, tickRes.stderr);

    const inbox = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ ticketId?: string; eventType: string; message: string }>;
    const item = inbox.find((i) => i.ticketId === ticket.id);
    assert.ok(item, 'a review item must reach the inbox');
    assert.equal(item!.eventType, 'worker_needs_review');
    // Batch 11: reasonFor now appends the exact next command after the
    // worker's own summary (every inbox line must name the next command,
    // checked by reading every composer in inbox.ts) -- this test's
    // assertion is updated to match that addition, same reasoning as batch
    // 10's cliRouting.test.ts fix: the underlying proof (the SUMMARY reaches
    // the line, not a repeat of the event type) is unchanged, just no longer
    // the WHOLE line.
    assert.match(item!.message, /^fake review/, "must start with FakeAdapter's review summary, not a repeat of the event type");
    assert.match(item!.message, new RegExp(`magarine approve --ticket ${ticket.id}`));
    assert.match(item!.message, new RegExp(`magarine reject --ticket ${ticket.id} --reason`));
  });
});

test('--fake-outcome rejects an unknown outcome name by listing the valid ones', async () => {
  await withTempDb('magarine-fake-outcome-unknown-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const ticket = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'T', '--json', '--db', dbFile])).stdout
    );
    const res = await run([
      'tick',
      '--project',
      project.id,
      '--adapter',
      'fake',
      '--fake-outcome',
      `${ticket.id}=bogus`,
      '--db',
      dbFile,
    ]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /unknown outcome "bogus"/);
    assert.match(res.stderr, /review/, 'must list the valid outcome names');
  });
});

// Hole flagged by Role H, confirmed by the Orchestrator: `inbox.ts` used to
// filter to `entityType === 'ticket'` only, so `project_spend_cap_reached`
// (entityType 'project') was recorded, required the user, and never
// appeared anywhere. There is no CLI path yet to actually trip the cap with
// FakeAdapter (`--fake-script` has no way to set a cost on a scripted
// `succeed`), so the event and the pause are seeded directly against the
// store -- same pattern as the REVIEW seeding above -- and `inbox`/`resume`
// themselves are exercised through the real CLI.
test('inbox shows a project-scoped project_spend_cap_reached item with the reason on the line, and resume clears it', async () => {
  const { openDb } = await import('../db/index.ts');
  const { insertEvent, pauseProjectAdapter } = await import('../store.ts');

  await withTempDb('magarine-inbox-projectcap-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'CapP', '--max-spend', '1', '--json', '--db', dbFile])).stdout
    );

    const db = openDb(dbFile);
    insertEvent(db, {
      projectId: project.id,
      eventType: 'project_spend_cap_reached',
      entityType: 'project',
      entityId: project.id,
      payload: { ticketId: 'tkt_would_have_run', projectedSpend: 1.2, maxSpendUsd: 1.0 },
      visibility: 'inbox',
      requiresUser: true,
      idempotencyKey: 'test-cap-event-1',
    });
    pauseProjectAdapter(db, project.id, 'spend_cap');
    db.close();

    const inboxBefore = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ projectId?: string; ticketId?: string; eventType: string; message: string }>;
    const item = inboxBefore.find((i) => i.eventType === 'project_spend_cap_reached');
    assert.ok(item, 'a project-scoped requires-user event must appear in the inbox');
    assert.equal(item!.projectId, project.id);
    assert.match(item!.message, /\$1\.20/, 'the reason must state the spend the cap refused');
    assert.match(item!.message, /\$1\.00/, 'the reason must state the cap itself');
    assert.match(
      item!.message,
      new RegExp(`magarine project set --project ${project.id} --max-spend <usd>`),
      'batch 11 rule c: the line must name the exact fix command, not just the numbers'
    );

    const humanInbox = await run(['inbox', '--project', project.id, '--db', dbFile]);
    assert.match(humanInbox.stdout, new RegExp(`^${project.id}\\t`, 'm'), 'project id must be first on its inbox line');

    const resumeRes = await run(['resume', '--project', project.id, '--db', dbFile]);
    assert.equal(resumeRes.code, 0, resumeRes.stderr);

    const inboxAfter = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ eventType: string }>;
    assert.ok(
      !inboxAfter.some((i) => i.eventType === 'project_spend_cap_reached'),
      'resume must clear the cap item from the inbox, the same way decide/retry clear a ticket item'
    );
  });
});

// Batch 11 ruling 1 rules a/d: before this fix, an adapter_unavailable
// pause's triggering event was entityType 'ticket' with no
// PENDING_TICKET_STATUS row, so it was filtered out of the inbox entirely --
// a project could sit paused, invisible, forever. buildInbox now derives the
// item from the project's own current pauseReason instead of the raw event.
test('inbox surfaces an adapter_unavailable pause (previously invisible), naming the login-then-resume fix, and resume clears it', async () => {
  const { openDb } = await import('../db/index.ts');
  const { pauseProjectAdapter } = await import('../store.ts');

  await withTempDb('magarine-inbox-adapterpause-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'AdapterPauseP', '--json', '--db', dbFile])).stdout
    );

    const db = openDb(dbFile);
    pauseProjectAdapter(db, project.id, 'adapter_unavailable');
    db.close();

    const inboxBefore = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ projectId?: string; eventType: string; message: string }>;
    const item = inboxBefore.find((i) => i.projectId === project.id);
    assert.ok(item, 'an adapter_unavailable pause must appear in the inbox, not be silently dropped');
    assert.match(item!.message, /`claude`/, 'rule d: must say to log in with claude');
    assert.match(
      item!.message,
      new RegExp(`magarine resume --project ${project.id}`),
      'rule d: must name the exact resume command'
    );

    const resumeRes = await run(['resume', '--project', project.id, '--db', dbFile]);
    assert.equal(resumeRes.code, 0, resumeRes.stderr);

    const inboxAfter = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ projectId?: string }>;
    assert.ok(
      !inboxAfter.some((i) => i.projectId === project.id),
      'resume must clear the adapter-pause item from the inbox'
    );
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

// Batch 9: the Manager's CLI surfaces.
test('plan creates a manager ticket that shows up tagged on the board, and project create/set --manager-model round-trips', async () => {
  await withTempDb('magarine-plan-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--manager-model', 'claude-fable-5-1', '--json', '--db', dbFile])).stdout
    );
    assert.equal(project.managerModel, 'claude-fable-5-1');

    const planRes = await run([
      'plan',
      '--project',
      project.id,
      '--mission',
      'Write three reports and an index.',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(planRes.code, 0, planRes.stderr);
    const planned = JSON.parse(planRes.stdout);
    assert.equal(planned.kind, 'manager');
    assert.equal(planned.description, 'Write three reports and an index.');
    assert.equal(planned.workspaceType, 'NONE');

    const boardText = (await run(['board', '--project', project.id, '--db', dbFile])).stdout;
    assert.match(boardText, /\[MANAGER\]/);

    const updated = JSON.parse(
      (await run(['project', 'set', '--project', project.id, '--manager-model', 'claude-opus-5', '--json', '--db', dbFile])).stdout
    );
    assert.equal(updated.managerModel, 'claude-opus-5');
  });
});

// Batch 11 ruling 1 rule e: `plan --budget` sets the manager ticket's own
// ceiling override, the same mechanism `ticket add --budget` already uses,
// so a mission that needs a tighter (or looser) per-run ceiling than the
// project default doesn't have to wait for a separate `ticket set` surface
// that doesn't exist.
test('plan --budget sets the manager ticket\'s maxBudgetUsdOverride, and enforces the floor the same way ticket add --budget does', async () => {
  await withTempDb('magarine-plan-budget-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);

    const planRes = await run([
      'plan',
      '--project',
      project.id,
      '--mission',
      'a mission with its own tighter ceiling',
      '--budget',
      '0.5',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(planRes.code, 0, planRes.stderr);
    const planned = JSON.parse(planRes.stdout);
    assert.equal(planned.maxBudgetUsdOverride, 0.5);

    const belowFloor = await run([
      'plan',
      '--project',
      project.id,
      '--mission',
      'another mission',
      '--budget',
      '0.01',
      '--db',
      dbFile,
    ]);
    assert.notEqual(belowFloor.code, 0);
    assert.match(belowFloor.stderr, /\$0\.25/);
  });
});

test('plan against a nonexistent project fails with a clean message, not a stack trace', async () => {
  await withTempDb('magarine-plan-missing-project-', async (dbFile) => {
    const res = await run(['plan', '--project', 'proj_ghost', '--mission', 'do it', '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no such project/);
  });
});

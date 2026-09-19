import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSyncResilient } from '../db/testSupport.ts';
import { spawnManaged } from '../process.ts';
import { deriveTestCliCwd, testTempRoot } from '../testSupport.ts';

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
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  return { code: result.code, stdout, stderr };
}

// Ruling 22: the ONLY test here that overrides the spawned subprocess's own
// environment -- used exactly once, to prove the home-directory refusal
// against a FAKE home without ever touching the real one. `os.homedir()` on
// this Windows machine reads `USERPROFILE` (HARD-verified directly); `HOME`
// is set alongside it for a POSIX runner, never read on this platform but
// harmless to set.
async function runWithEnv(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args), env });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  const result = await proc.wait();
  return { code: result.code, stdout, stderr };
}

function withTempDb<T>(prefix: string, fn: (dbFile: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(testRoot.root, prefix));
  const dbFile = join(dir, 'magarine.db');
  return fn(dbFile, dir).finally(() => rmSyncResilient(dir));
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
    assert.match(lines[0], /^Equivalent API cost: \$\d+\.\d{2} \(/, 'the spend line must be the first line of the board');
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
    assert.match(boardRes.stdout.split('\n')[0], /^Equivalent API cost: at least \$0\.92, live estimate/,
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

// Batch 12: unknown_model_rate itself is activity-only now (it names no
// owner decision -- see policy.ts's comment on that row), but the fact a
// run was priced at pricing.ts's conservative fallback rate still needs to
// reach the owner where they are actually looking, so it shows as a marker
// next to the run's own cost. Read from usage_json.model, not from the
// event -- there is no unknown_model_rate event recorded here at all, only
// a run whose usage names a model pricing.ts doesn't recognize.
test("board marks a ticket's cost 'estimated at fallback rate' when its usage names a model pricing.ts doesn't recognize, and leaves a recognized model's cost plain", async () => {
  const { openDb } = await import('../db/index.ts');
  const { createRun, setRunUsage } = await import('../store.ts');

  await withTempDb('magarine-board-fallbackrate-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);
    const unrecognized = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'unrecognized', '--json', '--db', dbFile]))
        .stdout
    );
    const known = JSON.parse(
      (await run(['ticket', 'add', '--project', project.id, '--title', 'known', '--json', '--db', dbFile])).stdout
    );

    const db = openDb(dbFile);
    const unrecognizedRun = createRun(db, { ticketId: unrecognized.id, attempt: 1, adapter: 'test' });
    setRunUsage(db, unrecognizedRun.id, { total_cost_usd: 0.3, model: 'claude-mystery-9' });
    const knownRun = createRun(db, { ticketId: known.id, attempt: 1, adapter: 'test' });
    setRunUsage(db, knownRun.id, { total_cost_usd: 0.2, model: 'claude-sonnet-5' });
    db.close();

    const boardRes = await run(['board', '--project', project.id, '--db', dbFile]);
    assert.equal(boardRes.code, 0, boardRes.stderr);
    assert.match(
      boardRes.stdout,
      new RegExp(`^${unrecognized.id}\\t.*cost \\$0\\.30 \\(estimated at fallback rate\\)`, 'm'),
      'a run priced at the fallback rate must carry the marker'
    );
    assert.match(
      boardRes.stdout,
      new RegExp(`^${known.id}\\t.*cost \\$0\\.20(?! \\(estimated)`, 'm'),
      'a run on a recognized model must not carry the marker'
    );

    const jsonRes = JSON.parse((await run(['board', '--project', project.id, '--json', '--db', dbFile])).stdout) as {
      projectUsedFallbackRate: boolean;
      tickets: Array<{ id: string; usedFallbackRate: boolean }>;
    };
    assert.equal(jsonRes.projectUsedFallbackRate, true);
    assert.equal(jsonRes.tickets.find((t) => t.id === unrecognized.id)!.usedFallbackRate, true);
    assert.equal(jsonRes.tickets.find((t) => t.id === known.id)!.usedFallbackRate, false);
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

// Ruling 16: `ticket add --expected-artifact <path>`, repeatable, file kind
// only (the only kind the scheduler ever verifies -- types.ts, scheduler.ts).

test('ticket add --expected-artifact, repeated, stores each path as a file-kind entry', async () => {
  await withTempDb('magarine-expected-artifact-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const res = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'C',
      '--expected-artifact',
      'out.md',
      '--expected-artifact',
      'report.json',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const ticket = JSON.parse(res.stdout);
    assert.deepEqual(ticket.expectedArtifacts, [
      { kind: 'file', path: 'out.md' },
      { kind: 'file', path: 'report.json' },
    ]);
  });
});

test('ticket add with no --expected-artifact stores expectedArtifacts as null, never []: null and [] mean different things (types.ts)', async () => {
  await withTempDb('magarine-expected-artifact-absent-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const res = await run(['ticket', 'add', '--project', project.id, '--title', 'C', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const ticket = JSON.parse(res.stdout);
    assert.equal(ticket.expectedArtifacts, null, 'absent flag must store null, not []');
    assert.notDeepEqual(ticket.expectedArtifacts, [], 'null is not the same as an empty list');
  });
});

test('ticket add --expected-artifact with an empty path is refused, naming the flag, not silently stored', async () => {
  await withTempDb('magarine-expected-artifact-empty-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    );
    const res = await run([
      'ticket',
      'add',
      '--project',
      project.id,
      '--title',
      'C',
      '--expected-artifact',
      '',
      '--json',
      '--db',
      dbFile,
    ]);
    assert.notEqual(res.code, 0, 'an empty --expected-artifact path must be refused, not silently stored');
    assert.match(res.stderr, /--expected-artifact/, 'the refusal must name the flag');
    assert.doesNotMatch(res.stderr, /\.ts:\d+/, 'must not leak a raw stack trace to the user');
  });
});

test('project set --dir moves the project to a new directory, deriving both workspaceRoot and scopePath from it', async () => {
  await withTempDb('magarine-projectset-dir-', async (dbFile, dir) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    ) as { id: string; workspaceRoot: string | null };
    // testSupport.ts's deriveTestCliCwd gives the spawned CLI a `workspace`
    // child of `dir`, not `dir` itself (ruling 22: `dir` alone would be
    // equal to the state dir for a `--state-dir`-only invocation elsewhere
    // in this file -- this test's own `--db`-only invocation isn't that
    // shape, but the helper applies the same rule to both branches so no
    // test call site has to know which one it's using).
    assert.equal(project.workspaceRoot, join(dir, 'workspace'), 'sanity: created with the default directory first');

    const newDir = join(dir, 'moved-here');
    const res = await run(['project', 'set', '--project', project.id, '--dir', newDir, '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const updated = JSON.parse(res.stdout) as { workspaceRoot: string | null; scopePath: string | null };
    assert.equal(updated.workspaceRoot, newDir);
    assert.equal(updated.scopePath, join(newDir, 'SCOPE.md'));
  });
});

// Ruling 22 (batch 15 addendum 10): `project create`/`project set --dir`
// refuse an unsafe workspace root. The pure rule itself is unit-tested
// directly against fake values in paths.test.ts (including the
// home-directory rule, safely); these prove the real CLI wiring actually
// calls it. TEST SAFETY: every one of these passes an explicit
// `--state-dir` under this file's own temp root -- never the real
// `~/.magarine` -- and the home-directory case below overrides `USERPROFILE`
// for the spawned subprocess only (HARD-verified: `os.homedir()` on Windows
// reads `USERPROFILE`), so it proves the real `homedir()` call site without
// ever resolving to the real home directory.

test('project create refuses a filesystem root as --dir, naming the fix, and touches nothing on disk', async () => {
  await withTempDb('magarine-unsafe-root-', async (dbFile, dir) => {
    const stateDir = join(dir, 'state');
    const driveRoot = parse(dir).root;
    const res = await run(['project', 'create', '--name', 'P', '--dir', driveRoot, '--state-dir', stateDir, '--db', dbFile]);
    assert.notEqual(res.code, 0, 'a filesystem root must be refused');
    assert.match(res.stderr, /filesystem root/);
    assert.match(res.stderr, /make a folder for the project and run this from inside it/);
  });
});

test('project create refuses a --dir that IS the state directory, naming --state-dir as the fix', async () => {
  await withTempDb('magarine-unsafe-statedir-', async (dbFile, dir) => {
    const stateDir = join(dir, 'state');
    const res = await run(['project', 'create', '--name', 'P', '--dir', stateDir, '--state-dir', stateDir, '--db', dbFile]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /state directory/);
    assert.match(res.stderr, /--state-dir/);
  });
});

test('project set --dir refuses a directory that CONTAINS the state directory, the same check project create applies', async () => {
  await withTempDb('magarine-unsafe-set-statedir-', async (dbFile, dir) => {
    const stateDir = join(dir, 'ancestor', 'state');
    const ancestor = join(dir, 'ancestor');
    // The initial create must land somewhere unrelated to `ancestor`/`stateDir`
    // -- otherwise this setup call itself (cwd defaults to `--dir`) trips the
    // very rule this test means to exercise on the LATER `project set --dir`.
    const project = JSON.parse(
      (
        await run([
          'project', 'create', '--name', 'P', '--dir', join(dir, 'initial-project'),
          '--state-dir', join(dir, 'other-state'), '--json', '--db', dbFile,
        ])
      ).stdout
    ) as { id: string };
    const res = await run([
      'project', 'set', '--project', project.id, '--dir', ancestor, '--state-dir', stateDir, '--db', dbFile,
    ]);
    assert.notEqual(res.code, 0, 'a --dir that contains the state directory must be refused');
    assert.match(res.stderr, /state directory/);
    assert.match(res.stderr, /--state-dir/);
  });
});

test('project create refuses the home directory as --dir, without touching the real one -- USERPROFILE is overridden for the subprocess only', async () => {
  await withTempDb('magarine-unsafe-home-', async (dbFile, dir) => {
    const fakeHome = join(dir, 'fake-home');
    const stateDir = join(dir, 'state');
    const res = await runWithEnv(
      ['project', 'create', '--name', 'P', '--dir', fakeHome, '--state-dir', stateDir, '--db', dbFile],
      { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome }
    );
    assert.notEqual(res.code, 0, 'the (fake, overridden) home directory must be refused');
    assert.match(res.stderr, /home directory/);
    assert.match(res.stderr, /make a folder for the project and run this from inside it/);
  });
});

test('project create with a plain project subdirectory (none of the three unsafe shapes) is accepted', async () => {
  await withTempDb('magarine-safe-dir-', async (dbFile, dir) => {
    const stateDir = join(dir, 'state');
    const projectDir = join(dir, 'my-project');
    const res = await run(['project', 'create', '--name', 'P', '--dir', projectDir, '--state-dir', stateDir, '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).workspaceRoot, projectDir);
  });
});

// Ruling 23 (batch 15 addendum 10): an existing project's worker cap can now
// be raised after creation, and `project create`/`project set` refuse a bad
// one with the same message (one validator, store.ts).
test('project set --max-parallel persists the cap, visible on the project row', async () => {
  await withTempDb('magarine-projectset-maxparallel-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    ) as { id: string; maxParallelWorkers: number };
    assert.equal(project.maxParallelWorkers, 1, 'the default is unchanged');

    const res = await run(['project', 'set', '--project', project.id, '--max-parallel', '4', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal((JSON.parse(res.stdout) as { maxParallelWorkers: number }).maxParallelWorkers, 4);

    const listed = JSON.parse((await run(['project', 'list', '--json', '--db', dbFile])).stdout) as Array<{ id: string }>;
    assert.ok(listed.some((p) => p.id === project.id));
  });
});

test('project set --max-parallel and project create --max-parallel refuse 0, -1, 1.5 and a non-number, with the same message', async () => {
  await withTempDb('magarine-maxparallel-invalid-', async (dbFile) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout
    ) as { id: string };
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      const set = await run(['project', 'set', '--project', project.id, '--max-parallel', bad, '--db', dbFile]);
      assert.notEqual(set.code, 0, `set --max-parallel ${bad} must be refused`);
      assert.match(set.stderr, /--max-parallel/);
      assert.match(set.stderr, /whole number of 1 or more/);
      const create = await run(['project', 'create', '--name', 'Q', '--max-parallel', bad, '--db', dbFile]);
      assert.notEqual(create.code, 0, `create --max-parallel ${bad} must be refused`);
      assert.equal(create.stderr, set.stderr, `same message for ${bad}`);
    }
    const after = JSON.parse(
      (await run(['project', 'set', '--project', project.id, '--max-spend', '5', '--json', '--db', dbFile])).stdout
    ) as { maxParallelWorkers: number };
    assert.equal(after.maxParallelWorkers, 1, 'refused sets must leave the cap untouched');
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

test('project create accepts --brief and --dir, both persisted on the project', async () => {
  await withTempDb('magarine-project-brief-', async (dbFile, dir) => {
    const workDir = join(dir, 'workroot');
    const res = await run([
      'project',
      'create',
      '--name',
      'BriefP',
      '--brief',
      'Build the weekend MVP.',
      '--dir',
      workDir,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const project = JSON.parse(res.stdout) as { brief: string; workspaceRoot: string; scopePath: string };
    assert.equal(project.brief, 'Build the weekend MVP.');
    assert.equal(project.workspaceRoot, workDir);
    assert.equal(project.scopePath, join(workDir, 'SCOPE.md'));
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
// pause's triggering event was entityType 'ticket' with no ticket-scoped
// resolution rule recorded for it anywhere, so it was filtered out of the
// inbox entirely -- a project could sit paused, invisible, forever.
// buildInbox now derives the item from the project's own current
// pauseReason instead of the raw event.
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

test('project create without --brief/--dir leaves brief null, but workspaceRoot defaults to the invocation\'s own directory (batch 12: a project can no longer be created without a directory)', async () => {
  await withTempDb('magarine-project-nobrief-', async (dbFile, dir) => {
    const res = await run(['project', 'create', '--name', 'NoBriefP', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const project = JSON.parse(res.stdout) as { brief: string | null; workspaceRoot: string | null };
    assert.equal(project.brief, null);
    // See the `workspace` child comment on the "project set --dir" test
    // above -- the invocation's own directory, per testSupport.ts's
    // deriveTestCliCwd, not `dir` itself.
    assert.equal(project.workspaceRoot, join(dir, 'workspace'));
  });
});

// Batch 12 section 1 ruling 1: `workspace_root` and `scope_path` both derive
// from the one `--dir`, which defaults to the invocation's own directory --
// there is no longer a project-id-keyed default location, since a project's
// scope file lives in the one directory the project itself owns.
test('project create with no --dir still gets a scope path, inside the directory it defaulted to', async () => {
  await withTempDb('magarine-project-defaultscope-', async (dbFile, dir) => {
    const res = await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const project = JSON.parse(res.stdout) as { id: string; workspaceRoot: string | null; scopePath: string | null };
    // See the `workspace` child comment above.
    const expectedWorkspaceRoot = join(dir, 'workspace');
    assert.equal(project.workspaceRoot, expectedWorkspaceRoot);
    assert.equal(project.scopePath, join(expectedWorkspaceRoot, 'SCOPE.md'));
  });
});

test('project create --dir <path> uses exactly that directory, not the invocation\'s own', async () => {
  await withTempDb('magarine-project-explicitscope-', async (dbFile, dir) => {
    const explicitDir = join(dir, 'elsewhere');
    const res = await run(['project', 'create', '--name', 'P', '--dir', explicitDir, '--json', '--db', dbFile]);
    assert.equal(res.code, 0, res.stderr);
    const project = JSON.parse(res.stdout) as { workspaceRoot: string | null; scopePath: string | null };
    assert.equal(project.workspaceRoot, explicitDir);
    assert.equal(project.scopePath, join(explicitDir, 'SCOPE.md'));
  });
});

// Batch 12 item 2's required regression test, inverted from batch 11's own
// failure: the paid owner walk followed the README's quickstart path (no
// `--dir`/`--workspace-root` flag at all) and got a DIRECTORY ticket that
// could never run, because no directory had ever been configured. Now that
// `project create` can no longer be created without one -- it defaults to
// the invocation's own directory -- the same no-flags path must actually
// carry a DIRECTORY ticket all the way to DONE.
test('project create with no directory flag at all still carries a DIRECTORY ticket to DONE (batch 11\'s README trap, inverted)', async () => {
  await withTempDb('magarine-nodir-directory-done-', async (dbFile, dir) => {
    const project = JSON.parse(
      (await run(['project', 'create', '--name', 'NoDirP', '--json', '--db', dbFile])).stdout
    ) as { id: string; workspaceRoot: string | null };
    // The mechanism this test is actually proving: no --dir was given, and
    // workspaceRoot is not null (batch 11's trap was exactly a null root).
    // See the `workspace` child comment above for why it's `join(dir,
    // 'workspace')`, not `dir` itself.
    assert.equal(project.workspaceRoot, join(dir, 'workspace'));

    const ticket = JSON.parse(
      (
        await run([
          'ticket',
          'add',
          '--project',
          project.id,
          '--title',
          'write a file',
          '--workspace',
          'DIRECTORY',
          '--json',
          '--db',
          dbFile,
        ])
      ).stdout
    );
    assert.equal(ticket.workspaceType, 'DIRECTORY');

    const runRes = await run([
      'run',
      '--until-idle',
      '--project',
      project.id,
      '--json',
      '--db',
      dbFile,
    ]);
    assert.equal(runRes.code, 0, runRes.stderr);

    const status = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(status.find((t) => t.id === ticket.id)!.status, 'DONE');
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
    // Batch 11 part 2: a mission seeds the scope document now (see
    // cliRouting.test.ts's seed test), not the ticket's own description --
    // that's what commands/plan.ts's planWithMission replaced planMission
    // with. The title claim below is this test's replacement coverage for
    // what used to be the description assertion.
    assert.equal(planned.title, 'Write three reports and an index.');
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

    // No --mission here: the first call above already seeded this
    // project's scope, and a second --mission against a non-empty scope now
    // refuses on its own terms (see cliRouting.test.ts) -- that refusal
    // would otherwise mask the budget-floor failure this assertion is
    // actually after. The floor check lives in createTicket regardless of
    // mission, so plain re-planning still exercises it.
    const belowFloor = await run(['plan', '--project', project.id, '--budget', '0.01', '--db', dbFile]);
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

// Batch 11 part 2, item 3: `discuss --project <id> --message "<text>"` --
// the direct-write counterpart of daemonApi.ts's already-landed handleDiscuss
// route, calling the exact same discussProject (manager.ts).
test('discuss --project --message creates a manager ticket and records the message as a discuss event', async () => {
  await withTempDb('magarine-discuss-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);

    const res = await run([
      'discuss', '--project', project.id, '--message', 'What should the first ticket be?', '--json', '--db', dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const ticket = JSON.parse(res.stdout);
    assert.equal(ticket.kind, 'manager');
    assert.equal(ticket.workspaceType, 'NONE');

    const activity = JSON.parse(
      (await run(['activity', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ eventType: string; payload: { message?: string } }>;
    const discussEvents = activity.filter((e) => e.eventType === 'discuss');
    assert.equal(discussEvents.length, 1);
    assert.equal(discussEvents[0].payload.message, 'What should the first ticket be?');
  });
});

test('discuss --budget sets the manager ticket\'s maxBudgetUsdOverride, enforcing the same floor plan --budget does', async () => {
  await withTempDb('magarine-discuss-budget-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);

    const res = await run([
      'discuss', '--project', project.id, '--message', 'hello', '--budget', '0.5', '--json', '--db', dbFile,
    ]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).maxBudgetUsdOverride, 0.5);

    const belowFloor = await run([
      'discuss', '--project', project.id, '--message', 'hi again', '--budget', '0.01', '--db', dbFile,
    ]);
    assert.notEqual(belowFloor.code, 0);
    assert.match(belowFloor.stderr, /\$0\.25/);
  });
});

test('discuss with an empty message and discuss against a nonexistent project both fail cleanly, not with a stack trace', async () => {
  await withTempDb('magarine-discuss-errors-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'P', '--json', '--db', dbFile])).stdout);

    const emptyMessage = await run(['discuss', '--project', project.id, '--db', dbFile]);
    assert.notEqual(emptyMessage.code, 0);
    assert.match(emptyMessage.stderr, /message is required/i);

    const ghostProject = await run(['discuss', '--project', 'proj_ghost', '--message', 'hi', '--db', dbFile]);
    assert.notEqual(ghostProject.code, 0);
    assert.match(ghostProject.stderr, /no such project/i);
  });
});

// Before this fix, manager_daily_cap_reached had inbox policy (policy.ts)
// and was actually inserted (scheduler.ts, Role R), but commands/inbox.ts
// had no resolution rule recorded for it anywhere -- same class of bug as
// the pre-batch-11 adapter_unavailable gap this batch already fixed once:
// an event recorded with requiresUser:true that the inbox never displays.
test('a manager ticket sitting at the daily Manager-invocation cap reaches the inbox, saying no action is needed', async () => {
  const { openDb } = await import('../db/index.ts');
  const { createRun, createTicket, finishRun } = await import('../store.ts');
  const { MANAGER_DAILY_CAP_DEFAULT } = await import('../manager.ts');

  await withTempDb('magarine-daily-cap-inbox-', async (dbFile) => {
    const project = JSON.parse((await run(['project', 'create', '--name', 'CapP', '--json', '--db', dbFile])).stdout);

    const db = openDb(dbFile);
    for (let i = 0; i < MANAGER_DAILY_CAP_DEFAULT; i++) {
      const filler = createTicket(db, { projectId: project.id, title: `Filler ${i}`, kind: 'manager', workspaceType: 'NONE' });
      const fillerRun = createRun(db, { ticketId: filler.id, attempt: 1, adapter: 'fake' });
      // Finished, not left 'running': the real CLI `tick` command also calls
      // recoverOrphanedRuns first, which would otherwise treat these seeded
      // filler runs as orphaned and try to fail a ticket this test has
      // already forced to DONE, tripping an InvalidTransitionError that has
      // nothing to do with what this test is actually proving.
      finishRun(db, fillerRun.id, { status: 'succeeded' });
      db.prepare("UPDATE tickets SET status = 'DONE' WHERE id = ?").run(filler.id);
    }
    const cappedTicket = createTicket(db, { projectId: project.id, title: 'Plan: capped', kind: 'manager', workspaceType: 'NONE' });
    db.close();

    const tickRes = await run(['tick', '--project', project.id, '--adapter', 'fake', '--json', '--db', dbFile]);
    assert.equal(tickRes.code, 0, tickRes.stderr);

    const statusAfter = JSON.parse(
      (await run(['status', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ id: string; status: string }>;
    assert.equal(statusAfter.find((t) => t.id === cappedTicket.id)!.status, 'READY', 'a capped manager ticket stays READY, not stuck or failed');

    const inbox = JSON.parse(
      (await run(['inbox', '--project', project.id, '--json', '--db', dbFile])).stdout
    ) as Array<{ ticketId?: string; eventType: string; message: string }>;
    const item = inbox.find((i) => i.ticketId === cappedTicket.id);
    assert.ok(item, 'the daily-cap event must reach the inbox, not just be recorded silently');
    assert.equal(item!.eventType, 'manager_daily_cap_reached');
    assert.match(item!.message, /no action needed/, 'unlike a spend cap or an adapter pause, there is no command to run -- the line must say so');
    assert.match(item!.message, new RegExp(String(MANAGER_DAILY_CAP_DEFAULT)));
  });
});

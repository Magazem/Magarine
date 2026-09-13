import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter, type ClaudeCliAdapterOptions } from './adapters/claudeCli.ts';
import { openDb } from './db/index.ts';
import { createProject, createTicket, getRun, getTicket, isProjectAdapterPaused, listEventsForEntity } from './store.ts';
import { tick } from './scheduler.ts';
import { testTempRoot } from './testSupport.ts';

// The batch 8 standing rule ("every result status and failure class needs a
// test driving the adapter's own classification and the scheduler's tick,
// not just the fake") was, per batch 10's brief, applied only forward:
// managerSpawnedPipeline.test.ts (batch 9) is the only file joining the real
// ClaudeCliAdapter to scheduler.ts's tick(), and it only ever drives a
// `manager`-kind ticket through the `manager_proposal`/`done` path. Every
// OTHER status and failure class -- predating the rule as much as postdating
// it -- has an adapter-alone test (adapters/claudeCli.ts and
// adapters/claudeCli.classify.test.ts) and a scheduler-alone test
// (scheduler.test.ts, driven by FakeAdapter) but nothing joining the two for
// an ordinary `work`-kind ticket. This file closes that gap: one test per
// status/failure class named in docs/strategy/batch-10-spec.md ruling 1,
// each spawning the real fake `claude` executable (testFixtures/
// fakeClaudeExe.ts) through the REAL ClaudeCliAdapter, through the REAL
// scheduler.ts tick() -> DB, using either a recorded stream (this repo's
// batch-1 spike capture) or synthetic tool output built from the recorded
// shapes and explicitly labelled SYNTHETIC where used.

const fakeExePath = fileURLToPath(new URL('./adapters/testFixtures/fakeClaudeExe.ts', import.meta.url));
const runsDir = fileURLToPath(new URL('../../../spikes/claude-cli/runs/', import.meta.url));
const recordedStreamStdout = join(runsDir, '2026-09-12T14-15-13-624Z-stream', 'stdout.txt');
const notLoggedInStdout = join(runsDir, 'manual-not-logged-in', 'stdout.txt');

const spawnedPipelineTestRoot = testTempRoot('worker-spawned-pipeline');
const workspaceBaseDir = spawnedPipelineTestRoot.root;
after(spawnedPipelineTestRoot.cleanup);

function buildAdapter(spec: Record<string, unknown>, opts: Partial<ClaudeCliAdapterOptions> = {}): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    claudeExe: process.execPath,
    argsPrefix: [fakeExePath],
    maxBudgetUsd: 2,
    workspaceType: 'NONE',
    env: { MAGARINE_FAKE_SPEC: JSON.stringify(spec) },
    ...opts,
  });
}

function setUp(): { db: ReturnType<typeof openDb>; projectId: string; ticketId: string } {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, {
    projectId: project.id,
    title: 'Do the thing',
    description: 'do the thing',
    kind: 'work',
    acceptanceCriteria: ['hello.txt exists'],
  });
  return { db, projectId: project.id, ticketId: ticket.id };
}

test('done: a real spawned process reporting status done lands the work ticket on DONE via worker_done', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      'hello.txt': 'hello',
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'done for real',
        artifacts: [{ kind: 'file', path: 'hello.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  assert.equal(result.started.length, 1);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticketId)!.status, 'DONE');
  const run = getRun(db, result.started[0].runId)!;
  assert.equal(run.status, 'succeeded');
  const doneEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_done');
  assert.ok(doneEvent, 'expected a worker_done transition from the real spawned pipeline');

  // MUTATION CHECK: in scheduler.ts's applyWorkerEventInner, the `case
  // 'done':` branch (non-manager path) reads `finishRun(db, run.id, {
  // status: 'succeeded' })` -- changing that literal to 'failed' makes this
  // test's `run.status === 'succeeded'` assertion fail while the ticket
  // status assertion above still passes, proving this specific assertion is
  // load-bearing rather than redundant with the ticket-status check.
});

test('review: a real spawned process reporting status review lands the ticket on REVIEW, not DONE', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'review',
        summary: 'ready for a human to look at',
        artifacts: [],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticketId)!.status, 'REVIEW');
  const run = getRun(db, result.started[0].runId)!;
  assert.equal(run.status, 'review');
  const reviewEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_needs_review');
  assert.ok(reviewEvent, 'expected a worker_needs_review transition');

  // MUTATION CHECK: claudeCli.ts's mapWorkerStatus has a `case 'review':
  // return 'review';` (the daemon-vocabulary identity mapping, distinct from
  // the legacy `ready_for_review` case). Commenting it out makes
  // classifyOutcome fall through to `default: null` -> "unrecognized result
  // status: review", turning this into a retryable `failure` event instead
  // of `result_raw`. Confirmed: with that case removed, this test's
  // `status === 'REVIEW'` assertion fails (actual: 'READY').
});

test('needs_user_decision: a real spawned process reporting status needs_user_decision blocks the ticket and puts it in the inbox', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'needs_user_decision',
        summary: 'need to know which approach to take',
        artifacts: [],
        checks: [],
        blockers: ['which library should this use?'],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, ticketId)!.status, 'BLOCKED');
  const run = getRun(db, result.started[0].runId)!;
  assert.equal(run.status, 'blocked');
  const event = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_needs_user_decision');
  assert.ok(event, 'expected a worker_needs_user_decision transition');
  assert.equal(event!.requiresUser, true, 'a blocked ticket must reach the inbox');

  // MUTATION CHECK: `recordTicketTransition`'s own `visibility`/`requiresUser`
  // parameters are deprecated/ignored (stateMachine.ts's RecordTransitionInput
  // doc comment) -- the real source of truth is policy.ts's `classify(event)`
  // table. Changing policy.ts's `worker_needs_user_decision` row from
  // `requiresUser: true` to `requiresUser: false` makes this test's
  // `event.requiresUser === true` assertion fail (actual: false) while the
  // ticket-status assertion above still passes -- proving the inbox-arrival
  // assertion is not redundant with the status assertion, and confirming the
  // requiresUser value really does flow from policy.ts, not from scheduler.ts's
  // (dead) literal.
});

test('failed: a real spawned process reporting status failed is a retryable attempt, landing the ticket back on READY with one attempt consumed', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'failed',
        summary: 'could not complete the acceptance criteria',
        artifacts: [],
        checks: [{ name: 'hello.txt exists', status: 'failed' }],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.status, 'READY', 'one failed attempt with 2 remaining (default max_attempts 3) must retry');
  assert.equal(ticket.attemptCount, 1);
  const run = getRun(db, result.started[0].runId)!;
  assert.equal(run.failureClass, 'worker_reported_failure');

  // MUTATION CHECK: scheduler.ts's `case 'failed':` branch hard-codes
  // `failureClass: 'worker_reported_failure'` on both the finishRun call and
  // the worker_failure transition payload. Changing the finishRun literal to
  // 'adapter_failure' makes this test's `run.failureClass ===
  // 'worker_reported_failure'` assertion fail while the ticket-status/
  // attemptCount assertions above still pass unchanged.
});

test('budget_insufficient: a real spawned process reporting its own budget self-stop fails the ticket WITHOUT consuming an attempt', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'budget_insufficient',
        summary: 'per-call cost makes finishing this ticket impossible within the ceiling',
        artifacts: [],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.status, 'FAILED', 'a worker budget self-stop is never retryable');
  assert.equal(ticket.attemptCount, 0, 'no attempt is consumed by a worker_budget_stop transition');
  const run = getRun(db, result.started[0].runId)!;
  assert.equal(run.failureClass, 'worker_budget_stop');

  // MUTATION CHECK: scheduler.ts's `case 'budget_insufficient':` branch calls
  // `recordTicketTransition` with `event: 'worker_budget_stop'` specifically
  // (not `worker_failure`), which is the one transition stateMachine.ts
  // never increments attempt_count for. Changing that event literal to
  // 'worker_failure' makes this test's `attemptCount === 0` assertion fail
  // (actual: 1) while the FAILED status assertion above still passes --
  // proving the no-attempt-consumed behaviour is a real, separately-tested
  // property, not an accident of the status also being FAILED.
});

test('malformed result: a schema-valid-looking result.json missing a required field is classified retryable by the adapter itself, before the scheduler ever sees a result_raw event', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      // status maps successfully (mapWorkerStatus('done') -> 'done'), but the
      // 'checks' field required by WORKER_RESULT_JSON_SCHEMA is missing, so
      // classifyOutcome's own validateWorkerResult call rejects it -- this
      // exercises claudeCli.ts's malformed-result branch specifically,
      // distinct from an unrecognized status string.
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'forgot to report checks',
        artifacts: [],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.status, 'READY', 'a malformed result is a retryable attempt');
  assert.equal(ticket.attemptCount, 1);
  const failureEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_failed_retryable');
  assert.ok(failureEvent, 'expected a retryable worker_failure transition');
  const payload = failureEvent!.payload as { message?: string };
  assert.match(payload.message ?? '', /malformed result/);

  // MUTATION CHECK: claudeCli.ts's classifyOutcome calls `validateWorkerResult(candidate)`
  // and, on failure, returns `{ kind: 'retryable', reason: \`malformed result: ...\` }`.
  // Short-circuiting that call to always report `{ valid: true, data: candidate }`
  // (i.e. skipping validation) makes this test's message-match assertion fail:
  // the run instead succeeds outright (ticket status DONE, no worker_failed_retryable
  // event at all), because a "done"-mapped status with no further validation
  // is otherwise accepted.
});

test('artefact not found: a result declaring an artefact that was never written is classified retryable by verifyArtifacts', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      // hello.txt deliberately never created.
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'claims to have written hello.txt',
        artifacts: [{ kind: 'file', path: 'hello.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.status, 'READY');
  assert.equal(ticket.attemptCount, 1);
  const failureEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_failed_retryable');
  const payload = failureEvent!.payload as { message?: string };
  assert.match(payload.message ?? '', /artefact not found/);

  // MUTATION CHECK: claudeCli.ts's verifyArtifacts is only called when
  // classifyOutcome itself returned 'success' (`if (outcome.kind ===
  // 'success') { outcome = verifyArtifacts(outcome.result, ws.path); }` in
  // startWorker's wait().then callback). Deleting that `if` block (always
  // skipping verifyArtifacts) makes this test's message-match assertion
  // fail: the run instead succeeds (ticket status DONE), since nothing else
  // in the real pipeline checks a declared file artifact actually exists on
  // disk.
});

test('budget_exceeded (recorded subtype): a real tool-side budget stop is a non-retryable failure with failureClass budget_exceeded and stoppedBy tool_max_budget_usd', async () => {
  const { db, projectId, ticketId } = setUp();
  // SYNTHETIC, not a recorded fixture: this is the exact shape
  // docs/strategy/batch-4-spec.md section 0 recorded from probing the real
  // tool directly (subtype: error_max_budget_usd, no result text) -- see
  // adapters/claudeCli.test.ts's own budget-exceeded test, which uses the
  // identical shape at the adapter-alone layer. No fixture under
  // spikes/claude-cli/runs/ carries this subtype.
  const syntheticDir = mkdtempSync(join(tmpdir(), 'magarine-worker-pipeline-synth-budget-'));
  const stdoutFile = join(syntheticDir, 'stdout.json');
  writeFileSync(stdoutFile, JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_budget_usd' }) + '\n');

  try {
    const adapter = buildAdapter({ stdoutFile, exitCode: 0 });
    const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
    await Promise.all(result.started.map((s) => s.done));

    const ticket = getTicket(db, ticketId)!;
    assert.equal(ticket.status, 'FAILED', 'a tool-side budget stop is never retryable');
    assert.equal(ticket.attemptCount, 1);
    const run = getRun(db, result.started[0].runId)!;
    assert.equal(run.failureClass, 'budget_exceeded');
    const failureEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_failed_final');
    const payload = failureEvent!.payload as { stoppedBy?: string };
    assert.equal(payload.stoppedBy, 'tool_max_budget_usd');
  } finally {
    rmSync(syntheticDir, { recursive: true, force: true });
  }

  // MUTATION CHECK: claudeCli.ts's outcomeToEvent's `case 'budget_exceeded':`
  // branch sets `stoppedBy: 'tool_max_budget_usd'` specifically, to
  // distinguish a real tool-side stop from the scheduler's own
  // estimate-driven stop (`stoppedBy: 'scheduler_estimate'`). Deleting that
  // field from the returned event makes this test's `payload.stoppedBy ===
  // 'tool_max_budget_usd'` assertion fail (actual: undefined) while the
  // FAILED/failureClass assertions above still pass -- proving stoppedBy is
  // independently exercised, not implied by failureClass alone.
});

test('timeout: a real spawned process that hangs past the wall-clock timeout is killed and classified retryable', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({ sleepMs: 5000 }, { timeoutMs: 300 });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, ticketId)!;
  assert.equal(ticket.status, 'READY');
  assert.equal(ticket.attemptCount, 1);
  const failureEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_failed_retryable');
  const payload = failureEvent!.payload as { message?: string };
  assert.match(payload.message ?? '', /timed out/);

  // MUTATION CHECK: claudeCli.ts's classifyOutcome's very first check is
  // `if (input.timedOut) return { kind: 'retryable', reason: 'timed out
  // before completion' };`. Commenting that branch out makes the function
  // fall through to the "no parseable result on stdout" branch instead
  // (still retryable, in this exact scenario, since the killed process wrote
  // nothing) -- this test's specific `/timed out/` message-match assertion
  // then fails (actual message starts with "no parseable result on stdout"),
  // even though the ticket still lands on READY either way. Confirms the
  // message content, not just the retry outcome, is real.
});

// BUG FOUND while writing this test, NOT FIXED HERE: adapters/claudeCli.ts
// is not a file Role O owns (batch-10-spec.md's file list), and the fix
// belongs there. Recorded plainly, the same way batch 7's close-out recorded
// mapWorkerStatus's missing 'budget_insufficient' case as a found-not-fixed
// gap outside that role's files (see README's "What was not built").
//
// scheduler.ts's `case 'failure':` only takes the dedicated
// pause-adapter/no-attempt-consumed/inbox path when `event.retryable ===
// false && event.failureClass === 'adapter_unavailable'`. But claudeCli.ts's
// outcomeToEvent, for its own `{ kind: 'adapter_unavailable' }` outcome,
// returns `{ type: 'failure', message: \`ADAPTER_UNAVAILABLE: ${reason}\`,
// retryable: false, usage, unknownModel }` -- it never sets `failureClass`
// at all (only the message PREFIX distinguishes this case; see claudeCli.ts
// lines ~302-309). So scheduler.ts's guard never matches a real
// ClaudeCliAdapter's not-logged-in event: it falls through to the generic
// "non-retryable but not adapter_unavailable" branch instead, which treats
// this exactly like any other final failure. The dedicated handling
// (project-adapter pause so the daemon stops burning attempts against a
// dead login, ticket returned to READY with NO attempt consumed, a
// dedicated `adapter_unavailable` inbox event) is reachable ONLY from
// FakeAdapter/scheduler.test.ts, which sets `failureClass:
// 'adapter_unavailable'` on its scripted event by hand -- it has never been
// reachable from a real `claude` CLI not-logged-in run. This is precisely
// the shape the batch 8 standing rule exists to catch: correct where it was
// built (scheduler.ts's guard), silently unreachable at the join to the
// real adapter, invisible to a suite that only ever drove the fake.
//
// This test locks in the CURRENT (incorrect) real-pipeline behavior so the
// suite stays green and the regression is visible in one place; it must be
// rewritten to assert the intended behavior (READY, attemptCount 0, paused,
// inbox event) once claudeCli.ts's outcomeToEvent sets `failureClass:
// 'adapter_unavailable'` on this outcome, the same way it already sets
// `failureClass: 'budget_exceeded'` on its sibling case just above it.
test('adapter_unavailable: KNOWN BUG -- a real not-logged-in worker does NOT reach the dedicated pause/no-attempt-consumed path, because claudeCli.ts never sets failureClass on this outcome', async () => {
  const { db, projectId, ticketId } = setUp();
  const adapter = buildAdapter({ stdoutFile: notLoggedInStdout, exitCode: 0 });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const ticket = getTicket(db, ticketId)!;
  // Intended (per scheduler.ts's own adapter_unavailable branch): READY,
  // attemptCount 0, paused, dedicated inbox event. Actual, locked in here:
  assert.equal(ticket.status, 'FAILED', 'BUG: should be READY (run_cancelled) -- see comment above');
  assert.equal(ticket.attemptCount, 1, 'BUG: should be 0 (no attempt consumed) -- see comment above');
  assert.equal(isProjectAdapterPaused(db, projectId), false, 'BUG: should be true -- see comment above');
  const inboxEvent = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'adapter_unavailable');
  assert.equal(inboxEvent, undefined, 'BUG: should find a dedicated adapter_unavailable inbox event -- see comment above');
  const failedFinal = listEventsForEntity(db, 'ticket', ticketId).find((e) => e.eventType === 'worker_failed_final');
  assert.ok(failedFinal, 'falls through to the generic worker_failed_final path instead');

  // MUTATION CHECK: this test's whole point is that scheduler.ts's guard
  // does not match the real event. To confirm it is real (not a mistake in
  // my own test setup), I temporarily added `failureClass:
  // 'adapter_unavailable'` to claudeCli.ts's outcomeToEvent 'adapter_unavailable'
  // case (the fix this bug needs) and reran: the ticket landed READY with
  // attemptCount 0, isProjectAdapterPaused true, and a real inbox event --
  // i.e. every assertion above flipped, proving this test is actually
  // sensitive to the guard/emission mismatch and not vacuously true. Reverted
  // immediately after (claudeCli.ts is not a file this role may edit).
});

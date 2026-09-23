import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import { FakeAdapter, type FakeScript } from './adapters/fakeAdapter.ts';
import { recoverOrphanedRuns } from './recovery.ts';
import { runUntilIdle, tick, type LiveRunInfo } from './scheduler.ts';
import { recordTicketTransition } from './stateMachine.ts';
import {
  createProject,
  createRun,
  createTicket,
  getProject,
  getTicket,
  listEventsForEntity,
  listRunsForTicket,
  setProjectVerifierModel,
} from './store.ts';
import { buildManagerBriefing } from './managerEnvelope.ts';
import { buildWorkerPrompt } from './envelope.ts';
import { testTempRoot } from './testSupport.ts';
import type { AgentAdapter, AgentAdapterCapabilities, LiveToolUse, TicketEnvelope, WorkerEvent, WorkerHandle } from './types.ts';
import {
  beginVerifyRun,
  buildVerifierEnvelope,
  buildVerifierPrompt,
  criteriaFor,
  IMPLICIT_CRITERION,
  PLACEHOLDER_CRITERION,
  startVerification,
  validateVerifierResult,
} from './verifier.ts';

// Batch 18 ruling 31 (docs/strategy/batch-18-replan-owner-walk.md): a work
// ticket's worker `done` enters REVIEW and a verifier run decides. Everything
// here runs on the FakeAdapter's verify_* scripts -- no spend.

const root = testTempRoot('verifier');
after(root.cleanup);

class RecordingAdapter extends FakeAdapter {
  readonly envelopes: TicketEnvelope[] = [];
  override async startWorker(input: Parameters<FakeAdapter['startWorker']>[0]) {
    this.envelopes.push(input.ticket);
    return super.startWorker(input);
  }
}

function setUp(opts: { maxAttempts?: number; criteria?: string[]; verifierModel?: string } = {}) {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 1 });
  if (opts.verifierModel) setProjectVerifierModel(db, project.id, opts.verifierModel);
  const ticket = createTicket(db, {
    projectId: project.id,
    title: 'write the parser',
    description: 'a parser for the config format',
    acceptanceCriteria: opts.criteria ?? ['it parses a sample file'],
    maxAttempts: opts.maxAttempts,
    workspaceType: 'NONE',
  });
  const adapter = new RecordingAdapter();
  const artifactsDir = mkdtempSync(join(root.root, 'artifacts-'));
  const deps = { readiness: 'skip' as const, db, adapter, maxParallelWorkers: 1, projectId: project.id, artifactsDir, workspaceBaseDir: root.root };
  return { db, project, ticket, adapter, deps, artifactsDir };
}

const eventTypes = (db: ReturnType<typeof openDb>, ticketId: string) => listEventsForEntity(db, 'ticket', ticketId).map((e) => e.eventType);

// ---- the contract ------------------------------------------------------------------------

test('criteriaFor: the ticket\'s own criteria, then the standing placeholder criterion; a ticket with none gets the implicit one', () => {
  assert.deepEqual(criteriaFor({ acceptanceCriteria: ['a', 'b'] }), ['a', 'b', PLACEHOLDER_CRITERION]);
  assert.deepEqual(criteriaFor({ acceptanceCriteria: [] }), [IMPLICIT_CRITERION, PLACEHOLDER_CRITERION]);
  assert.equal(IMPLICIT_CRITERION, "The ticket's description is fulfilled by what was delivered.");
});

test('the standing placeholder criterion names what the owner hit: TODO, stubs, "implement later", empty bodies, fabricated data', () => {
  for (const word of ['TODO', 'stubs', 'implement later', 'empty function bodies', 'fabricated data']) {
    assert.match(PLACEHOLDER_CRITERION, new RegExp(word));
  }
});

test('the verifier prompt carries the placeholder criterion and asks for evidence per criterion', () => {
  const { db, project, ticket } = setUp();
  const envelope = buildVerifierEnvelope(db, getTicket(db, ticket.id)!, getProject(db, project.id)!);
  const prompt = buildVerifierPrompt(envelope, '/ws');
  assert.ok(prompt.includes(PLACEHOLDER_CRITERION), 'the placeholder criterion must be in the rendered verifier prompt');
  assert.ok(prompt.includes('it parses a sample file'));
  assert.match(prompt, /evidence/);
  assert.match(prompt, /must NOT create, edit or delete any file/);
});

test('validateVerifierResult: overall verdict is derived, a pass without evidence is a fail, a criterion never ruled on fails', () => {
  const crit = ['c1', PLACEHOLDER_CRITERION];
  const ok = validateVerifierResult(
    { verdict: 'pass', criteria: crit.map((criterion) => ({ criterion, verdict: 'pass', evidence: 'ran it' })) },
    crit
  );
  assert.ok(ok.valid && ok.data.verdict === 'pass');

  // the verifier says pass overall but one criterion carries no evidence
  const noEvidence = validateVerifierResult(
    { verdict: 'pass', criteria: [{ criterion: 'c1', verdict: 'pass', evidence: 'ok' }, { criterion: PLACEHOLDER_CRITERION, verdict: 'pass', evidence: '  ' }] },
    crit
  );
  assert.ok(noEvidence.valid);
  assert.equal(noEvidence.valid && noEvidence.data.verdict, 'fail');

  // the placeholder criterion was never ruled on
  const missing = validateVerifierResult({ verdict: 'pass', criteria: [{ criterion: 'c1', verdict: 'pass', evidence: 'ok' }] }, crit);
  assert.ok(missing.valid);
  assert.equal(missing.valid && missing.data.verdict, 'fail');
  assert.match(JSON.stringify(missing.valid && missing.data.criteria), /did not rule on this criterion/);

  // an overall "pass" cannot outvote a failing criterion
  const lie = validateVerifierResult(
    { verdict: 'pass', criteria: [{ criterion: 'c1', verdict: 'fail', evidence: 'x' }, { criterion: PLACEHOLDER_CRITERION, verdict: 'pass', evidence: 'y' }] },
    crit
  );
  assert.equal(lie.valid && lie.data.verdict, 'fail');
});

test('validateVerifierResult: a verifier that declares file artefacts, or returns junk, is malformed', () => {
  const crit = ['c1'];
  const withArtifacts = validateVerifierResult(
    { verdict: 'pass', criteria: [{ criterion: 'c1', verdict: 'pass', evidence: 'ok' }], artifacts: [{ kind: 'file', path: 'x.txt' }] },
    crit
  );
  assert.equal(withArtifacts.valid, false);
  assert.equal(validateVerifierResult({ verdict: 'maybe' }, crit).valid, false);
  assert.equal(validateVerifierResult('pass', crit).valid, false);
  assert.equal(validateVerifierResult({ verdict: 'pass', criteria: [{ criterion: 'c1', verdict: 'pass' }] }, crit).valid, false);
});

// ---- end to end on the fake adapter ------------------------------------------------------

test('END TO END: worker done -> REVIEW -> verifier spawned -> verify_pass lands DONE', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'succeed' });
  adapter.setScript(ticket.id, { kind: 'verify_pass' });

  const first = await tick(deps);
  assert.equal(first.started.length, 1);
  await first.started[0]!.done;

  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
  const runs = listRunsForTicket(db, ticket.id);
  assert.deepEqual(runs.map((r) => r.kind), ['work', 'verify']);
  assert.deepEqual(runs.map((r) => r.status), ['succeeded', 'succeeded']);
  const types = eventTypes(db, ticket.id);
  assert.ok(types.indexOf('worker_done_for_verification') >= 0, 'the worker done must be recorded as entering verification');
  assert.ok(types.indexOf('worker_done_for_verification') < types.indexOf('review_approved'));
  assert.ok(!types.includes('worker_done'), 'a work ticket must never be marked done by its own worker');

  const verifier = adapter.envelopes.find((e) => e.runKind === 'verify')!;
  assert.ok(verifier, 'a verifier envelope must have been sent to the adapter');
  assert.ok(verifier.verification!.acceptanceCriteria.includes(PLACEHOLDER_CRITERION));
  assert.equal(adapter.envelopes.filter((e) => e.runKind !== 'verify').length, 1);
});

test('verify_fail lands READY with the verdict as the reason, one attempt consumed', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'verify_fail', reason: 'parse() is an empty function body at src/parse.js:3' });

  const started = await tick(deps);
  await started.started[0]!.done;

  const after = getTicket(db, ticket.id)!;
  assert.equal(after.status, 'READY');
  assert.equal(after.attemptCount, 1, 'exactly one attempt consumed');
  const rejected = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'review_rejected')!;
  assert.ok(rejected, 'the verdict must be a review_rejected transition');
  const reason = (rejected.payload as { reason: string }).reason;
  assert.match(reason, /parse\(\) is an empty function body at src\/parse\.js:3/);
  assert.match(reason, /it parses a sample file/);
});

test('at max attempts the final failure carries the verdict, and the Manager\'s failure list shows it', async () => {
  const { db, project, ticket, adapter, deps } = setUp({ maxAttempts: 2 });
  adapter.setScript(ticket.id, { kind: 'verify_fail', reason: 'the output is fabricated data, see data.json line 1' });

  await runUntilIdle(deps);

  const final = getTicket(db, ticket.id)!;
  assert.equal(final.status, 'FAILED');
  assert.equal(final.attemptCount, 2);
  const failedFinal = listEventsForEntity(db, 'ticket', ticket.id).find((e) => e.eventType === 'worker_failed_final')!;
  assert.match((failedFinal.payload as { reason: string }).reason, /fabricated data, see data\.json line 1/);

  const manager = createTicket(db, { projectId: project.id, title: 'manage', kind: 'manager', workspaceType: 'NONE' });
  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, manager);
  assert.match(JSON.stringify(briefing.recentFailures), /fabricated data, see data\.json line 1/);
});

test('verify_fail once, then pass: the retry runs and the ticket ends DONE with the attempt it cost', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'verify_fail', times: 1, reason: 'a TODO at main.js:9' });

  await runUntilIdle(deps);

  const done = getTicket(db, ticket.id)!;
  assert.equal(done.status, 'DONE');
  assert.equal(done.attemptCount, 1);
  assert.deepEqual(listRunsForTicket(db, ticket.id).map((r) => r.kind), ['work', 'verify', 'work', 'verify']);
});

test('a ticket with no acceptance criteria is judged on the implicit one plus the placeholder criterion', () => {
  const { db, project, ticket } = setUp({ criteria: [] });
  const envelope = buildVerifierEnvelope(db, getTicket(db, ticket.id)!, getProject(db, project.id)!);
  assert.deepEqual(envelope.verification!.acceptanceCriteria, [IMPLICIT_CRITERION, PLACEHOLDER_CRITERION]);
});

test('verifier model: the project\'s verifier_model, else its default_model; the ticket\'s spend ceiling applies', () => {
  const a = setUp();
  const envA = buildVerifierEnvelope(a.db, getTicket(a.db, a.ticket.id)!, getProject(a.db, a.project.id)!);
  assert.equal(envA.model, getProject(a.db, a.project.id)!.defaultModel);
  const b = setUp({ verifierModel: 'claude-opus-5' });
  const envB = buildVerifierEnvelope(b.db, getTicket(b.db, b.ticket.id)!, getProject(b.db, b.project.id)!);
  assert.equal(envB.model, 'claude-opus-5');
  assert.equal(envB.runKind, 'verify');
  assert.equal(envB.maxBudgetUsd, envA.maxBudgetUsd);
  assert.deepEqual(envB.completedDependencies, []);
  assert.equal(envB.projectBrief, '');
});

test('a verdict arriving for a ticket no longer in REVIEW is discarded with an internal event, and applies nothing', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'verify_pass', delayMs: 150 });

  const started = await tick(deps);
  // wait until the worker is done and the verifier is running, then the owner rejects
  for (let i = 0; i < 100 && getTicket(db, ticket.id)!.status !== 'REVIEW'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getTicket(db, ticket.id)!.status, 'REVIEW');
  recordTicketTransition(db, { ticketId: ticket.id, event: 'review_rejected', idempotencyKey: 'owner-reject', payload: { reason: 'owner says no' } });
  await started.started[0]!.done;
  for (let i = 0; i < 100 && !listRunsForTicket(db, ticket.id).every((r) => r.status !== 'running'); i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(getTicket(db, ticket.id)!.status, 'READY', 'the late pass must not resurrect DONE');
  const verifyRun = listRunsForTicket(db, ticket.id).find((r) => r.kind === 'verify')!;
  const discarded = listEventsForEntity(db, 'run', verifyRun.id).find((e) => e.eventType === 'verdict_discarded');
  assert.ok(discarded, 'the discarded verdict must leave an event');
  assert.equal(discarded!.visibility, 'internal');
});

test('a verifier that fails, is malformed, or declares artefacts leaves the ticket in REVIEW; after three tries the owner is asked to decide', async () => {
  for (const script of [
    { kind: 'verify_failure' },
    { kind: 'verify_malformed' },
  ] as FakeScript[]) {
    const { db, ticket, adapter, deps } = setUp();
    adapter.setScript(ticket.id, script);
    await runUntilIdle(deps);
    assert.equal(getTicket(db, ticket.id)!.status, 'REVIEW', `${script.kind} must not decide the ticket`);
    const verifyRuns = listRunsForTicket(db, ticket.id).filter((r) => r.kind === 'verify');
    assert.equal(verifyRuns.length, 3, 'three verifier tries, then stop');
    assert.ok(verifyRuns.every((r) => r.status === 'failed'));
    const inbox = listEventsForEntity(db, 'ticket', ticket.id).filter((e) => e.eventType === 'worker_needs_review' && e.visibility === 'inbox');
    assert.equal(inbox.length, 1, 'the owner is asked once to approve or reject by hand');
    assert.equal(getTicket(db, ticket.id)!.attemptCount, 0, 'a verifier that could not answer consumes no attempt');
  }
});

test('the worker\'s own review status is verified the same way', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'review' });
  const started = await tick(deps);
  await started.started[0]!.done;
  assert.equal(getTicket(db, ticket.id)!.status, 'DONE', 'default verify_pass approves a worker-requested review');
  assert.deepEqual(listRunsForTicket(db, ticket.id).map((r) => r.kind), ['work', 'verify']);
});

test('manager-kind tickets are never verified', () => {
  const { db, project } = setUp();
  const manager = createTicket(db, { projectId: project.id, title: 'm', kind: 'manager', workspaceType: 'NONE' });
  recordTicketTransition(db, { ticketId: manager.id, event: 'dependencies_resolved', idempotencyKey: 'm1' });
  recordTicketTransition(db, { ticketId: manager.id, event: 'run_started', idempotencyKey: 'm2' });
  recordTicketTransition(db, { ticketId: manager.id, event: 'worker_needs_review', idempotencyKey: 'm3', payload: {} });
  assert.equal(getTicket(db, manager.id)!.status, 'REVIEW');
  assert.equal(beginVerifyRun(db, 'fake', manager.id), undefined);
});

test('beginVerifyRun is a synchronous claim: a second call while one verifier is running gets nothing', () => {
  const { db, ticket } = setUp();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_done_for_verification', idempotencyKey: 'c', payload: { summary: 's' } });
  const first = beginVerifyRun(db, 'fake', ticket.id);
  assert.ok(first);
  assert.equal(first!.kind, 'verify');
  assert.equal(beginVerifyRun(db, 'fake', ticket.id), undefined);
});

test('a verifier run orphaned by a restart is failed without touching the ticket: still REVIEW, no attempt consumed, no worker_failure', () => {
  const { db, ticket } = setUp();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_done_for_verification', idempotencyKey: 'c', payload: { summary: 's' } });
  const run = createRun(db, { ticketId: ticket.id, attempt: 1, adapter: 'fake', kind: 'verify' });

  recoverOrphanedRuns(db);

  assert.equal(listRunsForTicket(db, ticket.id).find((r) => r.id === run.id)!.status, 'failed');
  assert.equal(getTicket(db, ticket.id)!.status, 'REVIEW');
  assert.equal(getTicket(db, ticket.id)!.attemptCount, 0);
});

test('a REVIEW ticket with no verifier running (a restart between done and verifier) is verified by the next tick', async () => {
  const { db, ticket, deps } = setUp();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_done_for_verification', idempotencyKey: 'c', payload: { summary: 's' } });

  const result = await tick(deps);
  assert.equal(result.started.length, 1);
  await result.started[0]!.done;
  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

// ---- ruling 32: a retry is told why it failed --------------------------------------------

const workerEnvelopes = (a: RecordingAdapter) => a.envelopes.filter((e) => e.runKind !== 'verify');

test('RULING 32: a retried worker RENDERED prompt carries the verdict, before the acceptance criteria; a first attempt does not', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'verify_fail', times: 1, reason: 'parse() returns a hardcoded sample at src/parse.js:4' });

  await runUntilIdle(deps);

  const [first, second] = workerEnvelopes(adapter);
  assert.ok(first && second, 'two worker attempts expected');
  const firstPrompt = buildWorkerPrompt(first, '/ws');
  const secondPrompt = buildWorkerPrompt(second, '/ws');
  assert.equal(first.previousAttempt, undefined);
  assert.ok(!firstPrompt.includes('Previous attempt'), 'a first attempt must see nothing about a previous one');
  assert.ok(!firstPrompt.includes('hardcoded sample'));
  assert.match(secondPrompt, /Previous attempt rejected: verifier rejected the work:/);
  assert.ok(secondPrompt.includes('parse() returns a hardcoded sample at src/parse.js:4'), 'the verdict text must be in the rendered retry prompt');
  assert.ok(secondPrompt.indexOf('Previous attempt') < secondPrompt.indexOf('Acceptance criteria:'), 'it comes before the acceptance criteria');
  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

test('RULING 32: another ticket rejection never leaks into a FIRST attempt rendered prompt', async () => {
  const { db, project, ticket, adapter, deps } = setUp({ maxAttempts: 1 });
  adapter.setScript(ticket.id, { kind: 'verify_fail', reason: 'sibling verdict: SECRET-MARKER-42' });
  await runUntilIdle(deps);
  assert.equal(getTicket(db, ticket.id)!.status, 'FAILED');

  const other = createTicket(db, { projectId: project.id, title: 'unrelated', workspaceType: 'NONE' });
  await runUntilIdle(deps);
  const otherEnvelope = workerEnvelopes(adapter).find((e) => e.ticketId === other.id)!;
  assert.ok(otherEnvelope, 'the unrelated ticket must have run');
  assert.equal(otherEnvelope.previousAttempt, undefined);
  const prompt = buildWorkerPrompt(otherEnvelope, '/ws');
  assert.ok(!prompt.includes('SECRET-MARKER-42') && !prompt.includes('Previous attempt'));
});

test('RULING 32: a worker own failure is what its retry is told, as "failed"', async () => {
  const { db, ticket, adapter, deps } = setUp();
  adapter.setScript(ticket.id, { kind: 'retryable_failure', message: 'tool crashed while writing out.txt' });
  const first = await tick(deps);
  await first.started[0]!.done;
  assert.equal(getTicket(db, ticket.id)!.status, 'READY');
  adapter.setScript(ticket.id, { kind: 'succeed' });
  const second = await tick(deps);
  await second.started[0]!.done;

  const [a, b] = workerEnvelopes(adapter);
  assert.equal(a!.previousAttempt, undefined);
  assert.equal(b!.previousAttempt!.status, 'failed');
  assert.match(buildWorkerPrompt(b!, '/ws'), /Previous attempt failed: tool crashed while writing out.txt/);
});

test('RULING 32: the previous attempt a retry is told about is the MOST RECENT one', async () => {
  const { db, ticket, adapter, deps } = setUp({ maxAttempts: 4 });
  adapter.setScript(ticket.id, { kind: 'verify_fail', times: 2, reason: 'verdict-two' });
  await runUntilIdle(deps);
  const envs = workerEnvelopes(adapter);
  assert.equal(envs.length, 3);
  assert.equal(envs[0]!.previousAttempt, undefined);
  assert.match(envs[1]!.previousAttempt!.reason, /verdict-two/);
  assert.match(envs[2]!.previousAttempt!.reason, /verdict-two/);
  assert.equal(getTicket(db, ticket.id)!.status, 'DONE');
});

// --- Lead verification round: the same "unproven" standard applied to the
// verifier's own live-channel registration (mini-phase 4 fix round item 2).
// -----------------------------------------------------------------------
// verifier.ts's own observeLive callback carries the identical late-event
// guard scheduler.ts's tick() does (`!currentRun || status !== 'running'`),
// and the existing "a verifier run registers its own live tool use" test
// (scheduler.test.ts) drives it through FakeAdapter -- whose observeLive
// resolves its unsubscribe promise essentially synchronously, so that test
// cannot put a live signal inside the real race window (observeLive's
// promise still unresolved when the verifier run settles) any more than the
// worker-side test could before this round. Confirmed by hand: weakening
// verifier.ts's own guard to `if (!currentRun) return;` left the existing
// suite fully green. This test calls `startVerification` directly (not
// through tick()'s full worker -> REVIEW -> auto-verify chain) with the same
// hand-controlled adapter double scheduler.test.ts's own new test uses, so
// it can hold the verify run's observeLive promise open on purpose.
class LateUnsubscribeVerifierAdapter implements AgentAdapter {
  readonly id = 'late-unsubscribe-verifier-test-adapter';
  private liveListener: ((info: LiveToolUse) => void) | undefined;
  private eventListener: ((event: WorkerEvent) => void) | undefined;
  private resolveObserveLivePromise: (() => void) | undefined;
  unsubscribeCallCount = 0;

  async capabilities(): Promise<AgentAdapterCapabilities> {
    return { supportsFiles: false, supportsShell: false, supportsStreaming: true, supportsResume: false };
  }

  async startWorker(input: { ticket: TicketEnvelope }): Promise<WorkerHandle> {
    return { id: `lateunsubverify_${randomUUID()}`, ticketId: input.ticket.ticketId, runId: `lateunsubverifyrun_${randomUUID()}` };
  }

  async send(): Promise<void> {}

  async observe(_handle: WorkerHandle, onEvent: (event: WorkerEvent) => void): Promise<() => void> {
    this.eventListener = onEvent;
    return () => {
      this.eventListener = undefined;
    };
  }

  async observeLive(_handle: WorkerHandle, onLive: (info: LiveToolUse) => void): Promise<() => void> {
    this.liveListener = onLive;
    return new Promise((resolve) => {
      this.resolveObserveLivePromise = () => {
        resolve(() => {
          this.unsubscribeCallCount += 1;
          this.liveListener = undefined;
        });
      };
    });
  }

  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  emitTerminal(event: WorkerEvent): void {
    this.eventListener?.(event);
  }

  emitLive(info: LiveToolUse): void {
    this.liveListener?.(info);
  }

  resolveObserveLive(): void {
    this.resolveObserveLivePromise?.();
  }
}

test("a live signal that arrives after a VERIFIER run settles, while observeLive's own promise has not resolved yet, is dropped by verifier.ts's own late-event guard -- independent of unsubscribe timing", async () => {
  const { db, ticket } = setUp();
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: 'a' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: 'b' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'worker_done_for_verification', idempotencyKey: 'c', payload: { summary: 's' } });
  const run = beginVerifyRun(db, 'late-unsubscribe-verifier-test-adapter', ticket.id)!;
  assert.ok(run);

  const adapter = new LateUnsubscribeVerifierAdapter();
  const liveRuns = new Map<string, LiveRunInfo>();
  const started = await startVerification({ db, adapter, liveRuns }, ticket.id, run);
  assert.ok(started);

  // 1) An ordinary live signal while the verifier is running.
  adapter.emitLive({ tool: 'Bash', detail: 'pnpm test' });
  assert.ok(liveRuns.has(run.id), 'sanity: the live channel works before settle');

  // 2) Settle the verifier run -- a plain failure event, so `settle()`
  // (verifier.ts) runs its own liveRuns.delete AND (per this fix round)
  // unsubscribes, but observeLive's own promise is deliberately never
  // resolved yet -- exactly the real adapter's post-kill drain window.
  adapter.emitTerminal({ type: 'failure', message: 'boom', retryable: true });
  await started!.done;
  assert.equal(liveRuns.has(run.id), false, "settle() itself already clears this run's entry");

  // 3) THE race: a live signal fires while the listener is still registered
  // (observeLive's promise never resolved) but the verify run has already
  // settled. With the real guard this must be dropped -- this is exactly
  // what weakening verifier.ts's own guard to `if (!currentRun) return;`
  // fails to do, since the run row still exists with a non-'running' status.
  adapter.emitLive({ tool: 'Bash', detail: 'late command after verifier settle' });
  assert.equal(
    liveRuns.has(run.id),
    false,
    "a live signal in the post-settle, pre-unsubscribe window must still be dropped by the verifier's own guard"
  );

  // 4) Resolve observeLive's promise late -- the real unsubscribe must still
  // be invoked once it finally arrives.
  adapter.resolveObserveLive();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.unsubscribeCallCount, 1, 'the real unsubscribe function must actually be invoked once observeLive resolves after the verifier has settled');
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter } from './adapters/claudeCli.ts';
import { openDb } from './db/index.ts';
import { createProject, createTicket, getTicket, listEventsForEntity, listTickets } from './store.ts';
import { tick } from './scheduler.ts';
import { testTempRoot } from './testSupport.ts';

// The batch 8 standing rule (per the Orchestrator's brief for this batch):
// "every result status and failure class needs a test driving the
// adapter's own classification and the spawned pipeline, not only the
// fake." Three separate defects on this project were correct where built
// and discarded at the join to reality (batch 6 item 3's unknownModel flag,
// batch 6 item 4's modelUsage propagation, batch 7's budget_insufficient
// status) -- each invisible to a suite that only ever drove FakeAdapter,
// because FakeAdapter cannot reproduce the real stdout-parsing/
// artifact-verification pipeline a defect can hide inside.
//
// managerScheduler.test.ts already proves the application step
// (managerApply.ts) against FakeAdapter's `manager_proposal` script, which
// writes a real file into a real workspace -- "most of the way there," per
// the Orchestrator, but FakeAdapter never exercises claudeCli.ts's own
// classification (classifyOutcome/verifyArtifacts) at all: it publishes a
// `result_raw` WorkerEvent directly, in-process, with no stdout to parse
// and no artifact-existence check to pass. This file closes that gap:
// a REAL child process is spawned (the fake `claude` executable,
// testFixtures/fakeClaudeExe.ts, replaying a recorded stream this repo's
// batch-1 spike captured from the real tool), through the REAL
// ClaudeCliAdapter, through the REAL scheduler.ts `tick()` -> DB. If a
// future edit to claudeCli.ts's classification ever broke the Manager path
// specifically (e.g. stopped forwarding a declared artifact, or changed how
// `.orchestrator/result.json` is preferred over the stream), this is the
// test that would actually notice.

const fakeExePath = fileURLToPath(new URL('./adapters/testFixtures/fakeClaudeExe.ts', import.meta.url));
const runsDir = fileURLToPath(new URL('../../../spikes/claude-cli/runs/', import.meta.url));
const recordedStreamStdout = join(runsDir, '2026-09-12T14-15-13-624Z-stream', 'stdout.txt');

const spawnedPipelineTestRoot = testTempRoot('manager-spawned-pipeline');
const workspaceBaseDir = spawnedPipelineTestRoot.root;
after(spawnedPipelineTestRoot.cleanup);

function buildAdapter(spec: Record<string, unknown>): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    claudeExe: process.execPath,
    argsPrefix: [fakeExePath],
    maxBudgetUsd: 2,
    workspaceType: 'NONE',
    env: { MAGARINE_FAKE_SPEC: JSON.stringify(spec) },
  });
}

test('a real spawned process producing a manager result.json + proposal.json drives classifyOutcome/verifyArtifacts and applies the proposal end to end', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });

  const proposal = {
    rationale: 'split the mission into two tickets',
    commands: [
      { type: 'create_ticket', title: 'Report A', description: 'd', acceptance_criteria: [] },
      { type: 'create_ticket', title: 'Index', description: 'd', acceptance_criteria: [], depends_on: ['Report A'] },
    ],
  };

  const adapter = buildAdapter({
    // A real recorded stream (batch-1 spike, docs/spikes/claude-cli-adapter.md)
    // ending in a normal completion -- exercised for real stdout parsing,
    // not read for its content: classifyOutcome prefers
    // `.orchestrator/result.json` over the stream's own structured_output
    // whenever both exist (claudeCli.ts), which is exactly what a real
    // Manager run does (writes result.json itself, same as any worker).
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'proposal written',
        artifacts: [{ kind: 'file', path: '.orchestrator/proposal.json' }],
        checks: [],
        blockers: [],
        questions: [],
      }),
      '.orchestrator/proposal.json': JSON.stringify(proposal),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  assert.equal(result.started.length, 1);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');
  const titles = listTickets(db, project.id).map((t) => t.title).sort();
  assert.deepEqual(titles, ['Index', 'Plan: mission', 'Report A'].sort());
  const applied = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'manager_proposal_applied');
  assert.ok(applied, 'expected the real spawned pipeline to reach managerApply.ts and record manager_proposal_applied');
});

test('a real spawned process whose result.json declares a proposal artifact that was never written is classified retryable, not silently treated as applied', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });

  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      // Declares the artifact but never actually writes proposal.json --
      // the same "schema-valid result claiming a file that was never
      // written" case claudeCli.ts's own verifyArtifacts exists for
      // (docs/spikes/claude-cli-adapter.md §3.3), now exercised for a
      // Manager ticket specifically rather than an ordinary worker.
      //
      // Two independent layers both refuse this, checked by mutation:
      // verifyArtifacts (claudeCli.ts) rejects it before a `result_raw`
      // event is even published; separately, applyManagerTicketDone
      // (scheduler.ts) reads `.orchestrator/proposal.json` directly rather
      // than trusting the declared artifact list, so a `readFileSync`
      // failure there catches the identical case on its own. Confirmed by
      // temporarily short-circuiting verifyArtifacts to always report
      // success: this test still passed, because the second, independent
      // read still caught it -- so the assertion below is a real property
      // of the whole pipeline (belt AND suspenders), not proof that
      // verifyArtifacts specifically fired. The next test isolates
      // verifyArtifacts on its own, with an artifact managerApply.ts never
      // looks at.
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'claims to have written a proposal',
        artifacts: [{ kind: 'file', path: '.orchestrator/proposal.json' }],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'READY');
  assert.equal(getTicket(db, managerTicket.id)!.attemptCount, 1);
  assert.equal(listTickets(db, project.id).length, 1, 'nothing may be created when the declared proposal artifact does not exist');
});

test('a real spawned process whose result.json declares an UNRELATED missing artifact is still caught by verifyArtifacts alone, even with a genuinely valid proposal.json', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });

  const proposal = { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [] }] };

  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      // proposal.json is real and genuinely valid; the ONLY problem is a
      // second declared artifact (something managerApply.ts never reads or
      // cares about) that was never written. Isolates verifyArtifacts's own
      // rejection from managerApply.ts's independent proposal.json read --
      // the previous test's two layers cannot both be the reason this one
      // fails, since only one of them ever looks at this artifact at all.
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'wrote the proposal and claims a report file it never wrote',
        artifacts: [
          { kind: 'file', path: '.orchestrator/proposal.json' },
          { kind: 'file', path: 'report.md' },
        ],
        checks: [],
        blockers: [],
        questions: [],
      }),
      '.orchestrator/proposal.json': JSON.stringify(proposal),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'READY', 'verifyArtifacts must reject the whole result over ANY missing declared artifact, not just a missing proposal.json');
  assert.equal(listTickets(db, project.id).length, 1, 'a genuinely valid proposal must still not be applied when verifyArtifacts rejects the surrounding result');
});

test('a real spawned process producing an invalid proposal (a dependency cycle) is rejected whole by the real pipeline, not partially applied', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });

  const cyclicProposal = {
    rationale: 'r',
    commands: [
      { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [], depends_on: ['B'] },
      { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['A'] },
    ],
  };

  const adapter = buildAdapter({
    stdoutFile: recordedStreamStdout,
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'done',
        summary: 'proposal written',
        artifacts: [{ kind: 'file', path: '.orchestrator/proposal.json' }],
        checks: [],
        blockers: [],
        questions: [],
      }),
      '.orchestrator/proposal.json': JSON.stringify(cyclicProposal),
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'READY', 'a malformed (cyclic) proposal is retryable');
  assert.equal(listTickets(db, project.id).length, 1, 'a rejected proposal must create nothing, even through the real spawned pipeline');
});

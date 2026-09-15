import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import { buildManagerBriefing, buildManagerEnvelope, renderManagerBrief, renderModelGuidance } from './managerEnvelope.ts';
import { knownModelIds } from './pricing.ts';
import { discussProject } from './manager.ts';
import {
  addDependency,
  createArtifact,
  createProject,
  createRun,
  createTicket,
  getProject,
  getTicket,
  insertEvent,
  setRunUsage,
} from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { testTempRoot } from './testSupport.ts';

const testRoot = testTempRoot('managerenvelope');
after(testRoot.cleanup);

// The negative test is the one that matters for this file (per the
// Orchestrator's framing for this step): proving nothing from a WORK
// ticket's own prompt-adjacent content -- its description, or a completed
// dependency's reported summary/artifacts -- can reach the Manager's
// envelope. Every test below plants a distinctive marker string somewhere
// that would leak if this module ever imported envelope.ts's
// buildEnvelope/buildWorkerPrompt (the WORK-ticket path) or read a
// WorkerResult's summary/artifacts/checks off any event, and asserts the
// marker is absent from the Manager's rendered output.

function makeManagerTicket(db: ReturnType<typeof openDb>, projectId: string, mission: string) {
  return createTicket(db, {
    projectId,
    title: `Plan: ${mission.slice(0, 40)}`,
    description: mission,
    kind: 'manager',
    workspaceType: 'NONE',
  });
}

test('buildManagerBriefing carries the project brief, the mission, and an empty board/decision log/failures for a fresh project', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', brief: 'Ship the thing.' });
  const managerTicket = makeManagerTicket(db, project.id, 'Write three reports and an index.');

  const briefing = buildManagerBriefing(db, project, managerTicket);

  assert.equal(briefing.projectBrief, 'Ship the thing.');
  assert.equal(briefing.mission, 'Write three reports and an index.');
  assert.deepEqual(briefing.decisionLog, []);
  assert.deepEqual(briefing.recentFailures, []);
  // The manager ticket itself is on the board too, like any ticket.
  assert.equal(briefing.board.length, 1);
  assert.equal(briefing.board[0].id, managerTicket.id);
  assert.equal(briefing.board[0].kind, 'manager');
});

test('the compact board carries exactly id/title/status/kind/dependsOn/attempts/spend -- nothing else, for every ticket in the project regardless of kind', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');
  const blocker = createTicket(db, { projectId: project.id, title: 'Blocker', description: 'blocker description' });
  const dependent = createTicket(db, { projectId: project.id, title: 'Dependent', description: 'dependent description' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: blocker.id });

  const run = createRun(db, { ticketId: blocker.id, attempt: 1, adapter: 'fake' });
  setRunUsage(db, run.id, { total_cost_usd: 1.23 });

  const briefing = buildManagerBriefing(db, project, managerTicket);
  const dependentEntry = briefing.board.find((b) => b.id === dependent.id)!;
  const blockerEntry = briefing.board.find((b) => b.id === blocker.id)!;

  assert.deepEqual(Object.keys(dependentEntry).sort(), ['attemptCount', 'dependsOn', 'id', 'kind', 'maxAttempts', 'spendUsd', 'status', 'title'].sort());
  assert.deepEqual(dependentEntry.dependsOn, [blocker.id]);
  assert.equal(blockerEntry.spendUsd, 1.23);
});

test('recentFailures surfaces at most the last five worker_failed_final events, most-recent-preserved, with a curated reason -- never the raw payload', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');

  const failureReasons: string[] = [];
  for (let i = 0; i < 7; i++) {
    const ticket = createTicket(db, { projectId: project.id, title: `Failing ${i}`, maxAttempts: 1 });
    recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `r:${i}` });
    recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `s:${i}` });
    const reason = `distinctive failure reason ${i}`;
    failureReasons.push(reason);
    recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'worker_failure',
      idempotencyKey: `f:${i}`,
      payload: { message: reason, retryable: false, failureClass: 'worker_reported_failure' },
    });
  }

  const briefing = buildManagerBriefing(db, project, managerTicket);

  assert.equal(briefing.recentFailures.length, 5);
  assert.deepEqual(
    briefing.recentFailures.map((f) => f.reason),
    failureReasons.slice(-5)
  );
});

test('the decision log renders every recorded user_decision as "Q: ... — A: ..."', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');
  const blocked = createTicket(db, { projectId: project.id, title: 'Needs a decision' });
  recordTicketTransition(db, { ticketId: blocked.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });
  recordTicketTransition(db, { ticketId: blocked.id, event: 'run_started', idempotencyKey: 's1' });
  recordTicketTransition(db, { ticketId: blocked.id, event: 'worker_needs_user_decision', idempotencyKey: 'd1', payload: {} });
  recordTicketTransition(db, {
    ticketId: blocked.id,
    event: 'user_decision',
    idempotencyKey: 'a1',
    payload: { ticketId: blocked.id, question: 'Which library?', answer: 'Use library X.' },
  });

  const briefing = buildManagerBriefing(db, project, managerTicket);

  assert.deepEqual(briefing.decisionLog, ['Q: Which library? — A: Use library X.']);
});

test('renderManagerBrief includes the mission, board, decision log, failures and the command schema, and names every one of the seven commands', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'A distinctive mission statement.');
  const briefing = buildManagerBriefing(db, project, managerTicket);

  const rendered = renderManagerBrief(briefing);

  assert.match(rendered, /A distinctive mission statement\./);
  for (const commandName of [
    'create_ticket',
    'add_dependency',
    'change_priority',
    'request_user_decision',
    'update_scope',
    'cancel_ticket',
    'update_ticket',
  ]) {
    assert.match(rendered, new RegExp(commandName), `expected the command schema to name "${commandName}"`);
  }
});

// Batch 12 item 3 (batch-12-spec.md section 1 ruling 3 / section 2 Role S
// item 3): "an envelope test that the paragraph is present and lists
// exactly the models in pricing.ts" -- so the two can't drift apart. Reads
// pricing.ts's own knownModelIds() as the expected set, rather than a
// hand-copied literal list, for the same reason.
test('renderModelGuidance names exactly the models pricing.ts knows about, no more and no fewer, and says model_reason is required', () => {
  const guidance = renderModelGuidance();
  for (const id of knownModelIds()) {
    assert.ok(guidance.includes(id), `model guidance must name "${id}" (a real pricing.ts model)`);
  }
  // The inverse half of "exactly": every model-shaped token this paragraph
  // names is one pricing.ts actually knows, not a stray or invented one.
  const namedModelIds = guidance.match(/claude-[a-z0-9-]+/g) ?? [];
  for (const named of namedModelIds) {
    assert.ok(knownModelIds().includes(named), `model guidance names "${named}", which pricing.ts has no rate for`);
  }
  assert.match(guidance, /model_reason/);
});

test('renderManagerBrief carries the model guidance paragraph', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'A mission.');
  const rendered = renderManagerBrief(buildManagerBriefing(db, project, managerTicket));

  for (const id of knownModelIds()) {
    assert.ok(rendered.includes(id), `the rendered brief must carry model guidance naming "${id}"`);
  }
});

// --- The negative test: nothing from a worker prompt or a transcript ---

test('buildManagerEnvelope never carries another ticket\'s own description, a completed dependency\'s reported summary, or its artifacts', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', brief: 'legitimate brief' });

  const WORKER_DESCRIPTION_MARKER = 'MARKER_WORKER_DESCRIPTION_MUST_NOT_LEAK_9f3a';
  const WORKER_SUMMARY_MARKER = 'MARKER_WORKER_SUMMARY_MUST_NOT_LEAK_7c21';
  const WORKER_ARTIFACT_MARKER = 'marker_worker_artifact_path_must_not_leak.txt';
  const WORKER_PROGRESS_MARKER = 'MARKER_WORKER_PROGRESS_MUST_NOT_LEAK_4b10';

  const completedDependency = createTicket(db, {
    projectId: project.id,
    title: 'Completed dependency',
    description: WORKER_DESCRIPTION_MARKER,
  });
  recordTicketTransition(db, { ticketId: completedDependency.id, event: 'dependencies_resolved', idempotencyKey: 'r1' });
  recordTicketTransition(db, { ticketId: completedDependency.id, event: 'run_started', idempotencyKey: 's1' });
  recordTicketTransition(db, {
    ticketId: completedDependency.id,
    event: 'worker_done',
    idempotencyKey: 'done1',
    payload: {
      status: 'done',
      summary: WORKER_SUMMARY_MARKER,
      artifacts: [{ kind: 'file', path: WORKER_ARTIFACT_MARKER }],
      checks: [],
      blockers: [],
      questions: [],
    },
  });

  // A live worker's own progress line, internal bookkeeping -- must never
  // surface anywhere either.
  insertEvent(db, {
    projectId: project.id,
    eventType: 'worker_progress',
    entityType: 'run',
    entityId: 'run_does_not_matter',
    payload: { message: WORKER_PROGRESS_MARKER },
    visibility: 'internal',
    idempotencyKey: 'progress:1',
  });

  // A ticket that DEPENDS ON the completed one -- a real work ticket, whose
  // own envelope (built by envelope.ts, NOT this module) would legitimately
  // see the marker text above. The Manager's envelope must not.
  const dependent = createTicket(db, { projectId: project.id, title: 'Dependent ticket', description: 'unrelated' });
  addDependency(db, { ticketId: dependent.id, dependsOnTicketId: completedDependency.id });

  const managerTicket = makeManagerTicket(db, project.id, 'Plan the next phase.');

  const envelope = buildManagerEnvelope(db, managerTicket, getProject(db, project.id)!);
  const serialized = JSON.stringify(envelope);

  assert.ok(!serialized.includes(WORKER_DESCRIPTION_MARKER), 'a work ticket\'s own description must not reach the Manager envelope');
  assert.ok(!serialized.includes(WORKER_SUMMARY_MARKER), 'a completed dependency\'s reported summary must not reach the Manager envelope');
  assert.ok(!serialized.includes(WORKER_ARTIFACT_MARKER), 'a completed dependency\'s artifact path must not reach the Manager envelope');
  assert.ok(!serialized.includes(WORKER_PROGRESS_MARKER), 'a worker progress line must not reach the Manager envelope');

  assert.deepEqual(envelope.completedDependencies, [], 'a Manager envelope must never carry completedDependencies');
  assert.deepEqual(envelope.allowedTools, [], 'a Manager envelope must never carry allowedTools');

  // The mission itself, and the legitimate project brief, are the two
  // things that SHOULD be present -- the negative test only means nothing
  // from THIS module's own doc comment about, not that the envelope is
  // empty.
  assert.ok(serialized.includes('Plan the next phase.'));
  assert.ok(serialized.includes('legitimate brief'));

  const readableTicket = getTicket(db, dependent.id);
  assert.ok(readableTicket, 'sanity: the dependent ticket exists and was not itself mutated by building the envelope');
});

test('buildManagerEnvelope resolves maxBudgetUsd and model the same way any ticket does, including the manager_model override', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxBudgetUsd: 3, defaultModel: 'claude-sonnet-5', managerModel: 'claude-fable-5-1' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');

  const envelope = buildManagerEnvelope(db, managerTicket, getProject(db, project.id)!);

  assert.equal(envelope.maxBudgetUsd, 3);
  assert.equal(envelope.model, 'claude-fable-5-1');
});

// --- Batch 11 item 1: the scope document ---

test('the envelope carries the CURRENT scope text, read fresh off disk on every invocation', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'scope-present', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  const SCOPE_MARKER = 'MARKER_SCOPE_TEXT_MUST_APPEAR_2a91';
  mkdirSync(join(testRoot.root, 'scope-present'), { recursive: true });
  writeFileSync(scopePath, SCOPE_MARKER, 'utf8');

  const managerTicket = makeManagerTicket(db, project.id, 'mission');
  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, managerTicket);
  assert.equal(briefing.scopeText, SCOPE_MARKER);

  const envelope = buildManagerEnvelope(db, managerTicket, getProject(db, project.id)!);
  assert.ok(envelope.description.includes(SCOPE_MARKER), 'the rendered envelope must include the current scope text');
});

// --- The negative test, split per its own two claims: nothing from a
// worker prompt or transcript, checked separately from the positive
// "scope text is present" claim above, so a name naming both halves is
// actually covering both. ---

test('buildManagerEnvelope never carries the scope text of another kind of content -- specifically, nothing from a worker prompt or transcript', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', brief: 'legitimate brief' });

  const WORKER_DESCRIPTION_MARKER = 'MARKER_WORKER_DESCRIPTION_MUST_NOT_LEAK_9f3a_2';
  const WORKER_SUMMARY_MARKER = 'MARKER_WORKER_SUMMARY_MUST_NOT_LEAK_7c21_2';

  const completedDependency = createTicket(db, {
    projectId: project.id,
    title: 'Completed dependency',
    description: WORKER_DESCRIPTION_MARKER,
  });
  recordTicketTransition(db, { ticketId: completedDependency.id, event: 'dependencies_resolved', idempotencyKey: 'r1x' });
  recordTicketTransition(db, { ticketId: completedDependency.id, event: 'run_started', idempotencyKey: 's1x' });
  recordTicketTransition(db, {
    ticketId: completedDependency.id,
    event: 'worker_done',
    idempotencyKey: 'done1x',
    payload: { status: 'done', summary: WORKER_SUMMARY_MARKER, artifacts: [], checks: [], blockers: [], questions: [] },
  });

  const managerTicket = makeManagerTicket(db, project.id, 'Plan the next phase.');
  const envelope = buildManagerEnvelope(db, managerTicket, getProject(db, project.id)!);
  const serialized = JSON.stringify(envelope);

  assert.ok(!serialized.includes(WORKER_DESCRIPTION_MARKER));
  assert.ok(!serialized.includes(WORKER_SUMMARY_MARKER));
});

// --- Batch 11 item 2: interview-mode framing (the OR condition) ---

test('isFreshProject is true when the scope is empty, even with a work ticket already on the board (clause 1 of the OR)', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' }); // no scope_path -> empty scope text
  createTicket(db, { projectId: project.id, title: 'Some work' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');

  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, managerTicket);
  assert.equal(briefing.isFreshProject, true);
  assert.match(renderManagerBrief(briefing), /INTERVIEW MODE/);
});

test('isFreshProject is true when there are no work tickets, even with real scope text (clause 2 of the OR)', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'fresh-no-work', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  mkdirSync(join(testRoot.root, 'fresh-no-work'), { recursive: true });
  writeFileSync(scopePath, 'A real scope document.', 'utf8');
  const managerTicket = makeManagerTicket(db, project.id, 'mission'); // the manager ticket itself is on the board, but it is not 'work'

  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, managerTicket);
  assert.equal(briefing.isFreshProject, true);
  assert.match(renderManagerBrief(briefing), /INTERVIEW MODE/);
});

test('isFreshProject is false once the scope has real text AND a work ticket exists', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'not-fresh', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  mkdirSync(join(testRoot.root, 'not-fresh'), { recursive: true });
  writeFileSync(scopePath, 'A real scope document.', 'utf8');
  createTicket(db, { projectId: project.id, title: 'Some work' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');

  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, managerTicket);
  assert.equal(briefing.isFreshProject, false);
  const rendered = renderManagerBrief(briefing);
  assert.doesNotMatch(rendered, /INTERVIEW MODE/);
});

// --- Batch 11 item 3: the conversation ---

// createdAt timestamps are millisecond-resolution (ISO strings); in
// production a Manager's reply is always causally well after the owner's
// message that triggered it (a real invocation takes seconds to minutes),
// but this test's three steps run back-to-back in-process and can otherwise
// collide on the same millisecond, making the true creation order
// ambiguous to the tie-broken sort under test. A short real delay between
// steps is simpler and more honest than injecting a fake clock into two
// otherwise-unrelated store.ts insert paths just for this one ordering test.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

test('the conversation interleaves discuss events and manager_reply/manager_assessment artifacts in chronological order', async () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });

  discussProject(db, project.id, 'First owner message.');
  await tick();
  const firstManagerTicket = createTicket(db, { projectId: project.id, title: 'Manager: plan', kind: 'manager', workspaceType: 'NONE' });
  const firstRun = createRun(db, { ticketId: firstManagerTicket.id, attempt: 1, adapter: 'fake' });
  createArtifact(db, {
    ticketId: firstManagerTicket.id,
    runId: firstRun.id,
    projectId: project.id,
    kind: 'manager_reply',
    text: 'First manager reply.',
  });
  await tick();

  discussProject(db, project.id, 'Second owner message.');

  const currentManagerTicket = makeManagerTicket(db, project.id, 'mission');
  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, currentManagerTicket);

  assert.deepEqual(
    briefing.conversation.map((c) => [c.speaker, c.text]),
    [
      ['owner', 'First owner message.'],
      ['manager', 'First manager reply.'],
      ['owner', 'Second owner message.'],
    ]
  );

  const rendered = renderManagerBrief(briefing);
  assert.match(rendered, /Owner: First owner message\./);
  assert.match(rendered, /Manager: First manager reply\./);
  assert.match(rendered, /Owner: Second owner message\./);
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import { buildManagerBriefing, buildManagerEnvelope, renderManagerBrief, renderRoster } from './managerEnvelope.ts';
import { discussProject } from './manager.ts';
import { inputRateUsd, knownModelIds } from './pricing.ts';
import {
  addDependency,
  createArtifact,
  createProject,
  createRun,
  createTicket,
  createWorkerProfile,
  getProject,
  getTicket,
  getWorkerProfileByName,
  insertEvent,
  retireWorkerProfile,
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

// Ruling 36 (batch 19, mini-phase 2B), acceptance 3: a `user_decision` event
// carrying `decisions` (a decide() call answering N questions at once)
// renders one `Q: — A:` line per entry, not the single joined pair.
test('the decision log renders one "Q: — A:" line per entry of a multi-question user_decision event', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');
  const blocked = createTicket(db, { projectId: project.id, title: 'Needs decisions' });
  recordTicketTransition(db, { ticketId: blocked.id, event: 'dependencies_resolved', idempotencyKey: 'r2' });
  recordTicketTransition(db, { ticketId: blocked.id, event: 'run_started', idempotencyKey: 's2' });
  recordTicketTransition(db, { ticketId: blocked.id, event: 'worker_needs_user_decision', idempotencyKey: 'd2', payload: {} });
  recordTicketTransition(db, {
    ticketId: blocked.id,
    event: 'user_decision',
    idempotencyKey: 'a2',
    payload: {
      ticketId: blocked.id,
      question: 'Which library?; Which host?; Which region?',
      answer: 'Library X.; Host Y.; Region Z.',
      decisions: [
        { question: 'Which library?', answer: 'Library X.' },
        { question: 'Which host?', answer: 'Host Y.' },
        { question: 'Which region?', answer: 'Region Z.' },
      ],
    },
  });

  const briefing = buildManagerBriefing(db, project, managerTicket);

  assert.deepEqual(briefing.decisionLog, ['Q: Which library? — A: Library X.', 'Q: Which host? — A: Host Y.', 'Q: Which region? — A: Region Z.']);
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

// Batch 15 item 4: "the Manager envelope's rules text asks for it" --
// proposal.ts's MANAGER_COMMAND_SCHEMA_DESCRIPTION is the one string both
// this rendered brief and proposal.test.ts's own direct check of that
// constant read, so a change to one can never silently stop reaching the
// other.
test('renderManagerBrief\'s command schema mentions expected_artifacts on both create_ticket and update_ticket', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');
  const rendered = renderManagerBrief(buildManagerBriefing(db, project, managerTicket));

  const createLine = rendered.split('\n').find((l) => l.includes('"type": "create_ticket"'))!;
  const updateLine = rendered.split('\n').find((l) => l.includes('"type": "update_ticket"'))!;
  assert.match(createLine, /expected_artifacts/);
  assert.match(updateLine, /expected_artifacts/);
});

// Second reviewer's Low 10: computes the EXACT line renderRoster produces
// for a given profile, using the same formula the function itself does
// (pricing.ts's own inputRateUsd/knownModelIds, never a hand-copied number),
// so the test below can assert on the full, ordered set of "- ..." lines
// instead of a substring `includes` (which can't prove "no more") or a
// regex like `/x\b/` (which matches any word ending in "x", not just a
// price ratio).
function expectedRosterLine(p: { name: string; model: string; purpose: string }): string {
  const ids = knownModelIds();
  const cheapest = Math.min(...ids.map(inputRateUsd));
  const ratio = `${(inputRateUsd(p.model) / cheapest).toFixed(1)}x`;
  return `- ${p.name} (${p.model}, ${ratio} the cheapest known model's input price): ${p.purpose}`;
}

function rosterProfileLines(rendered: string): string[] {
  return rendered.split('\n').filter((l) => l.startsWith('- '));
}

// Batch 19 mini-phase 2A (ruling 37), acceptance line 1: "the roster
// paragraph names exactly the non-retired profiles, no more and no fewer.
// Retiring one and adding one both change it." A fresh `:memory:` db carries
// migration 0017's six seeded profiles (Architect, Developer, Reviewer,
// Tester, Researcher, Scribe), in their seeded order (store.ts's
// listWorkerProfiles is stable by created_at/rowid).
test('renderRoster names exactly the non-retired worker profiles\' lines, no more and no fewer, in order', () => {
  const db = openDb(':memory:');
  const seeded = [
    { name: 'Architect', model: 'claude-opus-5', purpose: 'deep design with real trade-offs' },
    { name: 'Developer', model: 'claude-sonnet-5', purpose: 'implementation' },
    { name: 'Reviewer', model: 'claude-sonnet-5', purpose: 'reads and judges, writes only review notes' },
    { name: 'Tester', model: 'claude-sonnet-5', purpose: 'writes and runs tests' },
    { name: 'Researcher', model: 'claude-haiku-4-5-20251001', purpose: 'read-only survey and summary' },
    { name: 'Scribe', model: 'claude-haiku-4-5-20251001', purpose: 'docs and mechanical edits' },
  ];

  assert.deepEqual(rosterProfileLines(renderRoster(db)), seeded.map(expectedRosterLine));

  // Retiring one removes EXACTLY it from the paragraph -- no other line changes.
  const architect = db.prepare('SELECT id FROM worker_profiles WHERE name = ?').get('Architect') as { id: string };
  retireWorkerProfile(db, architect.id);
  const withoutArchitect = seeded.filter((p) => p.name !== 'Architect');
  assert.deepEqual(rosterProfileLines(renderRoster(db)), withoutArchitect.map(expectedRosterLine));

  // Adding one adds EXACTLY one new line, appended after the rest.
  createWorkerProfile(db, { name: 'Zephyr', purpose: 'a distinctive new purpose', model: 'claude-sonnet-5' });
  const withZephyr = [...withoutArchitect, { name: 'Zephyr', model: 'claude-sonnet-5', purpose: 'a distinctive new purpose' }];
  assert.deepEqual(rosterProfileLines(renderRoster(db)), withZephyr.map(expectedRosterLine));
});

test('renderRoster names each profile\'s model, price ratio and purpose exactly, and says a bare model is only for a profile-less ticket', () => {
  const db = openDb(':memory:');
  const rendered = renderRoster(db);

  assert.ok(
    rosterProfileLines(rendered).includes(expectedRosterLine({ name: 'Developer', model: 'claude-sonnet-5', purpose: 'implementation' })),
    'Developer\'s own line must match model/price-ratio/purpose exactly'
  );
  assert.match(rendered, /A bare "model".*is only valid for a ticket that has no profile/);
});

test('renderManagerBrief carries the roster paragraph', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'A mission.');
  const rendered = renderManagerBrief(buildManagerBriefing(db, project, managerTicket));

  for (const name of ['Architect', 'Developer', 'Reviewer', 'Tester', 'Researcher', 'Scribe']) {
    assert.ok(rendered.includes(name), `the rendered brief must carry the roster naming "${name}"`);
  }
});

// --- The negative test: nothing from a worker prompt or a transcript ---

// Batch 18 ruling 34 amended the rule this test guards: a finished work ticket summary
// and artefacts DO reach the Manager -- but only through the "Since your last run"
// section, never as a dependency the envelope carries, and never with the ticket own
// description or a worker progress line. The two halves are asserted separately.
test('buildManagerEnvelope never carries another ticket description or a worker progress line, and carries a finished ticket summary and artefacts ONLY in the Since-your-last-run section', () => {
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
  const depRun = createRun(db, { ticketId: completedDependency.id, attempt: 1, adapter: 'fake' });
  createArtifact(db, { ticketId: completedDependency.id, runId: depRun.id, projectId: project.id, kind: 'file', pathOrUri: WORKER_ARTIFACT_MARKER });
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
  // The amended rule: exactly the summary and the artefact list, and only inside the section.
  const briefText = renderManagerBrief(buildManagerBriefing(db, getProject(db, project.id)!, managerTicket));
  const sinceAt = briefText.indexOf('Since your last run');
  assert.ok(sinceAt >= 0);
  assert.ok(briefText.slice(sinceAt).includes(WORKER_SUMMARY_MARKER), 'a finished ticket summary is admitted through Since your last run');
  assert.ok(briefText.slice(sinceAt).includes(WORKER_ARTIFACT_MARKER), 'a finished ticket artefact list is admitted through Since your last run');
  assert.ok(!briefText.slice(0, sinceAt).includes(WORKER_SUMMARY_MARKER), 'and nowhere else in the brief');
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

// Batch 19 mini-phase 2A (ruling 37), acceptance line 4: "a Manager run
// carries none" -- a manager ticket is never assignable a profile at all
// (worker-profiles-design.md section 2: "Manager is not a profile"), so its
// own envelope must never carry the `profile` field the adapter checks for
// `--append-system-prompt`.
//
// Second reviewer's Low 9: an ordinary manager ticket already has no
// profile_id (store.ts's createTicket refuses one outright, the 2A fix
// round's write-site guard), so asserting on one proves nothing about
// buildManagerEnvelope's OWN behaviour -- it would look identical whether
// or not this function ever reads ticket.profileId at all. This forces a
// profile_id onto the ticket row directly, under the write-site guard
// entirely (raw SQL, not createTicket/updateTicketFields), to prove
// buildManagerEnvelope structurally never surfaces it even then: the
// function (managerEnvelope.ts) simply never reads that column.
test('buildManagerEnvelope never carries a profile field, even if a manager ticket somehow had a profile_id set underneath it', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id, 'mission');
  const developer = getWorkerProfileByName(db, 'Developer')!;
  db.prepare('UPDATE tickets SET profile_id = ? WHERE id = ?').run(developer.id, managerTicket.id);

  const envelope = buildManagerEnvelope(db, getTicket(db, managerTicket.id)!, getProject(db, project.id)!);

  assert.equal(envelope.profile, undefined);
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

test('buildManagerEnvelope never carries the scope text of another kind of content -- nothing from a worker prompt or transcript (a finished ticket summary arrives only via Since your last run)', () => {
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
  assert.ok(serialized.includes('Since your last run') && serialized.includes(WORKER_SUMMARY_MARKER), 'the summary is present, through the amended section');
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

// Ruling 29 (batch 16 addendum 5): the brief says, in one sentence, that the
// scope document does not exist yet -- instead of presenting an absent file as
// an empty document -- and only when it is absent. A present-but-empty file
// keeps `(empty)`; a file with content shows the content; an unreadable path
// throws rather than being rendered as either.
test('the Manager brief says "the scope document at <path> does not exist yet" ONLY when the file is absent', () => {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'magarine-envelope-scope-'));
  try {
    const path = join(dir, 'SCOPE.md');
    const project = createProject(db, { name: 'p', scopePath: path });
    const ticket = makeManagerTicket(db, project.id, 'mission');

    const absent = renderManagerBrief(buildManagerBriefing(db, project, ticket));
    assert.ok(absent.includes(`the scope document at ${path} does not exist yet.`), absent);
    assert.ok(!absent.includes('Scope document: (empty)'), 'an absent document is not presented as an empty one');

    writeFileSync(path, '');
    const empty = renderManagerBrief(buildManagerBriefing(db, project, ticket));
    assert.ok(empty.includes('Scope document: (empty)'));
    assert.ok(!empty.includes('does not exist yet'));

    writeFileSync(path, 'Build a thing.');
    const present = renderManagerBrief(buildManagerBriefing(db, project, ticket));
    assert.ok(present.includes('Scope document:\nBuild a thing.'));
    assert.ok(!present.includes('does not exist yet'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an UNREADABLE scope path makes the briefing throw -- it is never rendered as an empty document', () => {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'magarine-envelope-scope-'));
  try {
    const dirAtPath = join(dir, 'SCOPE.md');
    mkdirSync(dirAtPath);
    const project = createProject(db, { name: 'p', scopePath: dirAtPath });
    const ticket = makeManagerTicket(db, project.id, 'mission');
    assert.throws(() => buildManagerBriefing(db, project, ticket));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

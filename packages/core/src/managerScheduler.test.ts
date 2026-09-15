import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.ts';
import { MANAGER_DAILY_CAP_DEFAULT } from './manager.ts';
import { buildManagerBriefing } from './managerEnvelope.ts';
import { createProject, createRun, createTicket, getProject, getTicket, listEventsForEntity, listTickets } from './store.ts';
import { decide } from './commands/decide.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { tick } from './scheduler.ts';
import { buildInbox } from './commands/inbox.ts';
import { testTempRoot } from './testSupport.ts';

// Batch 9 step 4's own acceptance list: "Fake-adapter tests for a valid
// proposal creating a small dependency graph, an invalid one rejected
// whole, a `request_user_decision` reaching the inbox, and replay
// reproducing the applied board." managerApply.test.ts already proves the
// application logic itself in isolation (including the rollback guarantee,
// which needs a deterministic injected failure managerApply.ts's own
// test-only seam provides); this file proves the SAME logic is actually
// reachable end to end through `tick()` -- a real manager ticket, a real
// NONE-mode workspace, a real file written into it by FakeAdapter's
// `manager_proposal` script, and read back by scheduler.ts's
// applyManagerTicketDone.

const workspaceBaseDir = testTempRoot('manager-scheduler').root;
after(() => rmSync(workspaceBaseDir, { recursive: true, force: true }));

function setupProject() {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const adapter = new FakeAdapter();
  return { db, project, adapter };
}

function makeManagerTicket(db: ReturnType<typeof openDb>, projectId: string) {
  return createTicket(db, { projectId, title: 'Plan: mission', description: 'mission text', kind: 'manager', workspaceType: 'NONE' });
}

test('a valid proposal, driven through a real tick(), creates a small dependency graph and lands the manager ticket DONE', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'split the mission',
      commands: [
        { type: 'create_ticket', title: 'Intro', description: 'd', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'Detail', description: 'd', acceptance_criteria: [], depends_on: ['Intro'] },
      ],
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  assert.equal(result.started.length, 1);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');
  const titles = listTickets(db, project.id).map((t) => t.title).sort();
  assert.deepEqual(titles, ['Detail', 'Intro', 'Plan: mission'].sort());

  const applied = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'manager_proposal_applied');
  assert.ok(applied, 'expected a manager_proposal_applied event on the manager ticket');
});

// Batch 12 item 3's required test: "Fake-adapter test that a proposal
// setting models with reasons round-trips" (batch-12-spec.md section 2,
// Role S item 3) -- a full trip through the real applied path (tick(), the
// fake worker's manager_proposal script, scheduler.ts's
// applyManagerTicketDone, managerApply.ts, store.ts), not just
// proposal.ts's own validator (see proposal.test.ts for that half) or
// managerApply.test.ts's direct, adapter-free calls (see that file's own
// update_ticket test for the equivalent narrower coverage).
test('a proposal setting model and model_reason on both create_ticket and update_ticket round-trips through a real tick() onto the created/updated tickets', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  const existing = createTicket(db, { projectId: project.id, title: 'Existing work' });

  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'differentiate by task',
      commands: [
        {
          type: 'create_ticket',
          title: 'Deep design work',
          description: 'd',
          acceptance_criteria: [],
          model: 'claude-opus-5',
          model_reason: 'needs real design trade-offs, not mechanical execution',
        },
        {
          type: 'update_ticket',
          ticket_id: existing.id,
          model: 'claude-haiku-4-5-20251001',
          model_reason: 'purely mechanical, read-only work',
        },
      ],
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  assert.equal(result.started.length, 1);
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');

  const created = listTickets(db, project.id).find((t) => t.title === 'Deep design work')!;
  assert.equal(created.model, 'claude-opus-5');
  assert.equal(created.modelReason, 'needs real design trade-offs, not mechanical execution');

  const updated = getTicket(db, existing.id)!;
  assert.equal(updated.model, 'claude-haiku-4-5-20251001');
  assert.equal(updated.modelReason, 'purely mechanical, read-only work');
});

// Batch 13 item 4: the ACTUAL Run B proposal, preserved by the Orchestrator
// before the temp state was lost
// (docs/evidence/batch-12-walk/fixtures/proposal-workspace-none.json) --
// not a hand-invented shape. IMPORTANT, and flagged to the Orchestrator
// before this test was written: the real fixture has NO `workspace_type`
// field anywhere on any of its four create_ticket commands -- Run B's
// tickets landed on NONE by OMISSION-AND-DEFAULT (the pre-batch-13 default
// for a work ticket with no explicit workspace_type), not by an explicit
// choice. So this fixture cannot exercise "a proposal that sets
// workspace_type is rejected" (proposal.test.ts's synthetic tests cover
// that ruling instead, since it has to hold regardless of what Run B
// happened to emit) -- what THIS fixture actually proves is the root-cause
// fix: replayed unmodified through the real applied path, every ticket it
// creates now defaults to DIRECTORY, so Run B's incident cannot recur.
const runBProposalFixturePath = fileURLToPath(
  new URL('../../../docs/evidence/batch-12-walk/fixtures/proposal-workspace-none.json', import.meta.url)
);
const runBProposalFixture = (
  JSON.parse(readFileSync(runBProposalFixturePath, 'utf8')) as Array<{ rationale: string; commands: unknown[] }>
)[0];

test('Run B fixture: the actual four-ticket proposal that landed on NONE by default now creates all four tickets as DIRECTORY', async () => {
  assert.equal(runBProposalFixture.commands.length, 4, 'sanity: the real fixture must still have its four create_ticket commands');
  assert.ok(
    runBProposalFixture.commands.every((c) => !('workspace_type' in (c as Record<string, unknown>))),
    'sanity: confirming (again, at test time) the real fixture never set workspace_type explicitly'
  );

  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, { kind: 'manager_proposal', proposal: runBProposalFixture });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');
  const workTickets = listTickets(db, project.id).filter((t) => t.kind === 'work');
  assert.equal(workTickets.length, 4, 'all four tickets from the real proposal must have been created');
  for (const t of workTickets) {
    assert.equal(t.workspaceType, 'DIRECTORY', `"${t.title}" must default to DIRECTORY now, not the NONE Run B actually got`);
  }
});

test('an invalid proposal, driven through a real tick(), is rejected whole (retryable), and creates nothing', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [], depends_on: ['B'] },
        { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['A'] },
      ],
    },
  });
  const ticketsBefore = listTickets(db, project.id).length;

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'READY', 'a malformed proposal is retryable, same as any other malformed result');
  assert.equal(getTicket(db, managerTicket.id)!.attemptCount, 1);
  assert.equal(listTickets(db, project.id).length, ticketsBefore, 'a rejected proposal must create nothing');
});

test('an invalid proposal that exhausts its attempts lands FAILED and reaches the inbox with the validation errors', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = createTicket(db, {
    projectId: project.id,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
    maxAttempts: 1,
  });
  adapter.setScript(managerTicket.id, { kind: 'manager_proposal', proposal: { rationale: 'r', commands: [{ type: 'not_a_real_command' }] } });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'FAILED');
  const inbox = buildInbox(db, project.id);
  const item = inbox.find((i) => i.ticketId === managerTicket.id);
  assert.ok(item, 'expected the exhausted malformed proposal to reach the inbox');
  assert.match(item!.message, /type must be one of/);
});

test('a request_user_decision proposal, driven through a real tick(), lands the manager ticket BLOCKED and reaches the inbox', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: { rationale: 'r', commands: [{ type: 'request_user_decision', question: 'Which library?', context: 'two look equivalent' }] },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED');
  const inbox = buildInbox(db, project.id);
  const item = inbox.find((i) => i.ticketId === managerTicket.id);
  assert.ok(item, 'expected the manager\'s decision request to reach the inbox, the same as any worker\'s own needs_user_decision');
  assert.match(item!.message, /Which library\?/);
});

test('replay: after a real tick() applies a proposal, the recorded event alone reconstructs the created tickets and their dependency', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'X', description: 'd', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'Y', description: 'd', acceptance_criteria: [], depends_on: ['X'] },
      ],
    },
  });

  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  const applied = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'manager_proposal_applied')!;
  const payload = applied.payload as { created: Array<{ title: string; ticketId: string }>; commands: Array<Record<string, unknown>> };

  const titleToId = new Map(payload.created.map((c) => [c.title, c.ticketId]));
  const xId = titleToId.get('X')!;
  const yId = titleToId.get('Y')!;
  assert.ok(xId && yId);
  assert.equal(getTicket(db, yId)!.title, 'Y');

  const yCommand = payload.commands.find((c) => c.title === 'Y') as { depends_on: string[] };
  const reconstructedDependsOn = (yCommand.depends_on ?? []).map((ref) => titleToId.get(ref) ?? ref);
  assert.deepEqual(reconstructedDependsOn, [xId]);
});

// --- Batch 11 item 3: the daily Manager-invocation cap ---

test('a manager ticket at the daily cap is skipped (continue), not spawned, but an ordinary work ticket later in the SAME tick still spawns and completes -- mutating the gate\'s continue to a break makes this go red', async () => {
  const { db, project, adapter } = setupProject();

  // Fill the cap with MANAGER_DAILY_CAP_DEFAULT manager-ticket runs already
  // recorded as started "now" (within the 24h window). Marked DONE directly
  // (fixture setup, not a transition under test) so tick()'s own
  // resolveReadiness call does not also promote these to READY and crowd
  // out the two tickets this test actually cares about, which would
  // otherwise be selected first by created_at ASC ordering.
  for (let i = 0; i < MANAGER_DAILY_CAP_DEFAULT; i++) {
    const filler = createTicket(db, { projectId: project.id, title: `Filler ${i}`, kind: 'manager', workspaceType: 'NONE' });
    createRun(db, { ticketId: filler.id, attempt: 1, adapter: 'fake' });
    db.prepare("UPDATE tickets SET status = 'DONE' WHERE id = ?").run(filler.id);
  }

  const cappedManagerTicket = makeManagerTicket(db, project.id);
  const workTicket = createTicket(db, { projectId: project.id, title: 'Ordinary work', workspaceType: 'NONE' });
  adapter.setScript(workTicket.id, { kind: 'succeed' });

  // maxParallelWorkers=2 so BOTH tickets are considered in the SAME tick's
  // readyTickets batch (created_at ASC ordering would otherwise mean a
  // cap of 1 only ever looks at the manager ticket).
  const result = await tick({ db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(
    result.started.some((s) => s.ticketId === cappedManagerTicket.id),
    false,
    'a capped manager ticket must not spawn this tick'
  );
  assert.equal(getTicket(db, cappedManagerTicket.id)!.status, 'READY', 'it stays READY, eligible again once the 24h window rolls forward');

  assert.equal(
    result.started.some((s) => s.ticketId === workTicket.id),
    true,
    'an ordinary work ticket later in the same readyTickets batch must still spawn -- the cap gate must skip, not stop the whole tick'
  );
  assert.equal(getTicket(db, workTicket.id)!.status, 'DONE');

  const capEvents = listEventsForEntity(db, 'ticket', cappedManagerTicket.id).filter((e) => e.eventType === 'manager_daily_cap_reached');
  assert.equal(capEvents.length, 1, 'exactly one cap-reached event, not one per tick');
});

test('a manager ticket below the cap spawns normally, and the same project is unaffected by another project\'s cap usage', async () => {
  const { db, project, adapter } = setupProject();
  const otherProject = createProject(db, { name: 'other' });
  for (let i = 0; i < MANAGER_DAILY_CAP_DEFAULT; i++) {
    const filler = createTicket(db, { projectId: otherProject.id, title: `Filler ${i}`, kind: 'manager', workspaceType: 'NONE' });
    createRun(db, { ticketId: filler.id, attempt: 1, adapter: 'fake' });
  }

  const managerTicket = makeManagerTicket(db, project.id);
  const result = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(result.started.map((s) => s.done));

  assert.equal(result.started.some((s) => s.ticketId === managerTicket.id), true, 'another project\'s cap usage must not affect this one');
});

// --- Batch 11 item 3: `decide` during the interview re-invokes once ---

test('decide on a manager ticket BLOCKED by request_user_decision re-invokes the Manager exactly once on the next tick, with the answer now in its decision log', async () => {
  const { db, project, adapter } = setupProject();
  const managerTicket = makeManagerTicket(db, project.id);
  adapter.setScript(managerTicket.id, {
    kind: 'manager_proposal',
    proposal: { rationale: 'r', commands: [{ type: 'request_user_decision', question: 'Which library?', context: 'c' }] },
  });

  const firstTick = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(firstTick.started.map((s) => s.done));
  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED');

  decide(db, { ticketId: managerTicket.id, answer: 'Use library X.' });
  assert.equal(getTicket(db, managerTicket.id)!.status, 'READY');

  adapter.setScript(managerTicket.id, { kind: 'manager_proposal', proposal: { rationale: 'done deciding', commands: [] } });
  const secondTick = await tick({ db, adapter, maxParallelWorkers: 1, projectId: project.id, workspaceBaseDir });
  await Promise.all(secondTick.started.map((s) => s.done));

  assert.equal(secondTick.started.length, 1, 'exactly one new run must start for the re-invoked manager ticket');
  assert.equal(secondTick.started[0].ticketId, managerTicket.id);
  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');

  const runs = db.prepare('SELECT id FROM runs WHERE ticket_id = ?').all(managerTicket.id) as Array<{ id: string }>;
  assert.equal(runs.length, 2, 'exactly one re-invocation total -- the original BLOCKED run plus one, not more');

  const briefing = buildManagerBriefing(db, getProject(db, project.id)!, getTicket(db, managerTicket.id)!);
  // decide.ts reads `blockers` before `summary` when composing the question
  // it records (see managerApply.ts's own doc comment on why both fields
  // must carry the real question) -- managerApply.ts's request_user_decision
  // handling puts "question (context)" into `blockers`, so that is what
  // ends up in the decision log, not the bare question text.
  assert.deepEqual(briefing.decisionLog, ['Q: Which library? (c) — A: Use library X.']);
});

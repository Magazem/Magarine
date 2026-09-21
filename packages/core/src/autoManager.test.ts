import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/index.ts';
import { FakeAdapter } from './adapters/fakeAdapter.ts';
import { AUTOMATIC_MANAGER_TITLE } from './autoManager.ts';
import { buildBoard } from './commands/board.ts';
import { buildManagerBriefing, renderManagerBrief } from './managerEnvelope.ts';
import { discussProject } from './manager.ts';
import { tick } from './scheduler.ts';
import { createProject, createRun, createTicket, getProject, getTicket, listEventsForEntity, listTickets } from './store.ts';
import { testTempRoot } from './testSupport.ts';
import type { TicketEnvelope } from './types.ts';

// Batch 18 ruling 34 (docs/strategy/batch-18-replan-owner-walk.md): when the
// board drains, the scheduler creates ONE automatic Manager turn, told what was
// delivered ("Since your last run"). The owner's "it only did phase 0". Every
// test below runs on the fake adapter -- no spend.

const root = testTempRoot('automanager');
after(root.cleanup);

class RecordingAdapter extends FakeAdapter {
  readonly envelopes: TicketEnvelope[] = [];
  override async startWorker(input: Parameters<FakeAdapter['startWorker']>[0]) {
    this.envelopes.push(input.ticket);
    return super.startWorker(input);
  }
}

const EMPTY_PROPOSAL = { kind: 'manager_proposal', proposal: { rationale: 'the scope is met', commands: [] } } as const;

function setUp() {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p', maxParallelWorkers: 2, workspaceRoot: root.root });
  const adapter = new RecordingAdapter();
  adapter.setDefaultScript(EMPTY_PROPOSAL); // every automatic turn: an empty proposal, unless a test says otherwise
  const deps = { readiness: 'skip' as const, db, adapter, maxParallelWorkers: 2, projectId: project.id, workspaceBaseDir: root.root, artifactsDir: root.root };
  return { db, project, adapter, deps };
}

async function tickAndWait(deps: Parameters<typeof tick>[0]): Promise<number> {
  const r = await tick(deps);
  await Promise.all(r.started.map((s) => s.done));
  return r.started.length;
}

async function settle(deps: Parameters<typeof tick>[0], max = 12): Promise<void> {
  for (let i = 0; i < max; i++) if ((await tickAndWait(deps)) === 0) return;
}

const automaticTickets = (db: ReturnType<typeof openDb>, projectId: string) => listTickets(db, projectId).filter((t) => t.automatic);

/** A project where the owner has engaged the Manager (one owner turn ran) and one work ticket has finished since. */
async function engagedAndDrained(opts: { workSummary?: boolean } = {}) {
  const s = setUp();
  const owner = discussProject(s.db, s.project.id, 'please build the thing');
  s.adapter.setScript(owner, EMPTY_PROPOSAL);
  await settle(s.deps); // the owner's turn runs, and finishes with nothing to propose
  const work = createTicket(s.db, { projectId: s.project.id, title: 'build the thing', description: 'desc', acceptanceCriteria: ['it builds'], workspaceType: 'NONE' });
  s.adapter.setScript(work.id, { kind: 'succeed' });
  return { ...s, owner, work, opts };
}

test('the board drains -> exactly one automatic manager ticket, flagged, titled, and it runs', async () => {
  const { db, project, deps, work } = await engagedAndDrained();
  await settle(deps);

  assert.equal(getTicket(db, work.id)!.status, 'DONE');
  const auto = automaticTickets(db, project.id);
  assert.equal(auto.length, 1, 'one automatic turn, not one per tick');
  assert.equal(auto[0]!.kind, 'manager');
  assert.equal(auto[0]!.title, AUTOMATIC_MANAGER_TITLE);
  assert.equal(auto[0]!.description, null, 'no owner message');
  assert.equal(auto[0]!.status, 'DONE', 'and it ran');
  const boardRow = buildBoard(db, project.id).tickets.find((t) => t.id === auto[0]!.id)!;
  assert.equal(boardRow.automatic, true, 'GET /board rows carry the flag');
  assert.equal(buildBoard(db, project.id).tickets.find((t) => t.id === work.id)!.automatic, false);
});

test('RUNAWAY GUARD: no second automatic turn without a work-ticket completion in between -- an empty proposal ends the loop', async () => {
  const { db, project, deps } = await engagedAndDrained();
  await settle(deps);
  assert.equal(automaticTickets(db, project.id).length, 1);

  for (let i = 0; i < 6; i++) await tickAndWait(deps);

  assert.equal(automaticTickets(db, project.id).length, 1, 'six more ticks with nothing finishing must not mint another automatic turn');
});

test('an automatic turn that PROPOSES work continues the loop only once that work finishes', async () => {
  const { db, project, adapter, deps } = await engagedAndDrained();
  adapter.setDefaultScript({
    kind: 'manager_proposal',
    proposal: { rationale: 'next', commands: [{ type: 'create_ticket', title: 'Follow-up', description: 'd', acceptance_criteria: ['it works'] }] },
  });
  await tickAndWait(deps); // work ticket
  await tickAndWait(deps); // verifier (already chained) / drain -> automatic turn #1 proposes Follow-up
  adapter.setDefaultScript(EMPTY_PROPOSAL);
  await settle(deps);

  const followUp = listTickets(db, project.id).find((t) => t.title === 'Follow-up');
  assert.ok(followUp, 'the automatic turn created the follow-up ticket');
  assert.equal(followUp!.status, 'DONE');
  assert.equal(automaticTickets(db, project.id).length, 2, 'the follow-up finishing is the completion that earns the second turn');
});

test('none while a work ticket is BLOCKED on the owner', async () => {
  const { db, project, adapter, deps } = await engagedAndDrained();
  const blocked = createTicket(db, { projectId: project.id, title: 'needs the owner', workspaceType: 'NONE' });
  adapter.setScript(blocked.id, { kind: 'needs_user_decision' });
  await settle(deps);

  assert.equal(getTicket(db, blocked.id)!.status, 'BLOCKED');
  assert.equal(automaticTickets(db, project.id).length, 0, 'Needs You is doing its job; the Manager must not pile on');
});

test('none for a project that never engaged a Manager', async () => {
  const s = setUp();
  const work = createTicket(s.db, { projectId: s.project.id, title: 'by hand', workspaceType: 'NONE' });
  await settle(s.deps);
  assert.equal(getTicket(s.db, work.id)!.status, 'DONE');
  assert.equal(automaticTickets(s.db, s.project.id).length, 0);
});

test('the daily cap still refuses: at 20 manager runs in a day the automatic ticket is created but does not run', async () => {
  const { db, project, owner, adapter, deps } = await engagedAndDrained();
  for (let i = 0; i < 19; i++) createRun(db, { ticketId: owner, attempt: 1, adapter: 'fake' }); // 1 real + 19 = 20 in the window
  await settle(deps);

  const auto = automaticTickets(db, project.id);
  assert.equal(auto.length, 1);
  assert.equal(auto[0]!.status, 'READY', 'refused, not run');
  assert.ok(!adapter.envelopes.some((e) => e.ticketId === auto[0]!.id), 'no run was started');
  const refusals = listEventsForEntity(db, 'ticket', auto[0]!.id).filter((e) => e.eventType === 'manager_daily_cap_reached');
  assert.equal(refusals.length, 1, 'and said so once');
});

// ---- what the Manager is told ------------------------------------------------------------

test('"Since your last run" carries summary, artefacts and verdict for exactly the tickets finished since, in the RENDERED brief', async () => {
  const { db, project, adapter, deps, work } = await engagedAndDrained();
  // A ticket that finished BEFORE the owner's turn ran must not be listed: finish one, then a Manager run, then another.
  await settle(deps);
  const auto1 = automaticTickets(db, project.id)[0]!;
  const brief1 = adapter.envelopes.find((e) => e.ticketId === auto1.id)!.description;

  assert.match(brief1, /AUTOMATIC turn/);
  assert.match(brief1, /Since your last run \(1 work ticket\(s\) finished\)/);
  assert.ok(brief1.includes(`${work.id} "build the thing" DONE`));
  assert.ok(brief1.includes('Summary: fake success'), 'the worker summary');
  assert.match(brief1, /Artefacts: \(file\) .*fake-success\.txt/, 'the artefact list');
  assert.ok(brief1.includes('Verdict: pass (the verifier approved it)'), 'the verifier verdict');

  // a failed ticket after that run shows the final failure reason; the earlier ticket is gone from the list
  const failing = createTicket(db, { projectId: project.id, title: 'doomed', workspaceType: 'NONE', maxAttempts: 1 });
  adapter.setScript(failing.id, { kind: 'verify_fail', reason: 'output.txt is fabricated data' });
  await settle(deps);
  const auto2 = automaticTickets(db, project.id).find((t) => t.id !== auto1.id)!;
  assert.ok(auto2, 'the failure is a completion: a second automatic turn');
  const brief2 = adapter.envelopes.find((e) => e.ticketId === auto2.id)!.description;
  assert.match(brief2, /Since your last run \(1 work ticket\(s\) finished\)/);
  assert.ok(brief2.includes(`${failing.id} "doomed" FAILED`));
  assert.ok(brief2.includes('output.txt is fabricated data'), 'a failure carries the verifier verdict');
  assert.ok(!brief2.includes(`${work.id}`.concat(' "build the thing"')), 'a ticket finished before the last run is not listed again');
});

test('the brief says so when nothing has finished, and never carries a worker description', async () => {
  const s = setUp();
  const managerTicket = createTicket(s.db, { projectId: s.project.id, title: 'Manager: plan', kind: 'manager', workspaceType: 'NONE' });
  createTicket(s.db, { projectId: s.project.id, title: 'pending', description: 'MARKER_DESCRIPTION_NOT_FOR_MANAGER', workspaceType: 'NONE' });
  const text = renderManagerBrief(buildManagerBriefing(s.db, getProject(s.db, s.project.id)!, managerTicket));
  assert.match(text, /Since your last run: \(no work ticket has finished\)/);
  assert.ok(!text.includes('MARKER_DESCRIPTION_NOT_FOR_MANAGER'));
});

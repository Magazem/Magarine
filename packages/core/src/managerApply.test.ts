import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import { applyManagerProposal, type ManagerProposalAppliedPayload } from './managerApply.ts';
import { decide } from './commands/decide.ts';
import { readScopeText } from './manager.ts';
import {
  createProject,
  createTicket,
  getDependencies,
  getProject,
  getTicket,
  listEventsForEntity,
  listEventsForProject,
  listTickets,
} from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { testTempRoot } from './testSupport.ts';
import type { Ticket } from './types.ts';

const testRoot = testTempRoot('managerapply');
after(testRoot.cleanup);

function makeManagerTicket(db: ReturnType<typeof openDb>, projectId: string): Ticket {
  const ticket = createTicket(db, {
    projectId,
    title: 'Plan: mission',
    description: 'mission text',
    kind: 'manager',
    workspaceType: 'NONE',
  });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr:${ticket.id}` });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `rs:${ticket.id}` });
  return getTicket(db, ticket.id)!;
}

test('a valid proposal creating a small dependency graph is applied whole: tickets exist, dependencies wired, the manager ticket lands DONE', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);

  const proposal = {
    rationale: 'split the mission into three tickets',
    commands: [
      { type: 'create_ticket', title: 'Intro', description: 'd', acceptance_criteria: [] },
      { type: 'create_ticket', title: 'Detail', description: 'd', acceptance_criteria: [], depends_on: ['Intro'] },
      { type: 'create_ticket', title: 'Index', description: 'd', acceptance_criteria: [], depends_on: ['Intro', 'Detail'] },
    ],
  };

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal);

  assert.equal(result.outcome, 'applied');
  if (result.outcome !== 'applied') return;
  assert.equal(result.ticketStatus, 'DONE');
  assert.equal(result.created.length, 3);

  const titles = new Map(listTickets(db, project.id).map((t) => [t.title, t]));
  const intro = titles.get('Intro')!;
  const detail = titles.get('Detail')!;
  const index = titles.get('Index')!;
  assert.ok(intro && detail && index);

  assert.deepEqual(
    getDependencies(db, detail.id).map((d) => d.dependsOnTicketId),
    [intro.id]
  );
  assert.deepEqual(
    getDependencies(db, index.id).map((d) => d.dependsOnTicketId).sort(),
    [intro.id, detail.id].sort()
  );

  // No blockers at all: Intro must already be READY (promoted by
  // resolveReadiness inside the same transaction).
  assert.equal(getTicket(db, intro.id)!.status, 'READY');
  assert.equal(getTicket(db, detail.id)!.status, 'OPEN', 'blocked on Intro, not yet READY');

  assert.equal(getTicket(db, managerTicket.id)!.status, 'DONE');
});

test('an invalid proposal (a dependency cycle) is rejected whole: no tickets created, the manager ticket is untouched', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const before = listTickets(db, project.id).length;

  const proposal = {
    rationale: 'r',
    commands: [
      { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [], depends_on: ['B'] },
      { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['A'] },
    ],
  };

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal);

  assert.equal(result.outcome, 'malformed');
  if (result.outcome !== 'malformed') return;
  assert.match(result.errors.join(' '), /dependency cycle/);

  assert.equal(listTickets(db, project.id).length, before, 'no ticket may be created from a rejected proposal');
  assert.equal(getTicket(db, managerTicket.id)!.status, 'IN_PROGRESS', 'the manager ticket itself must not be transitioned on a malformed proposal');
  assert.deepEqual(listEventsForEntity(db, 'ticket', managerTicket.id).filter((e) => e.eventType === 'manager_proposal_applied'), []);
});

test('a proposal missing entirely (undefined raw input) is rejected the same way, not crashed', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', undefined);

  assert.equal(result.outcome, 'malformed');
});

test('a request_user_decision command blocks the manager ticket, reaches the inbox shape, and decide() answers it normally', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);

  const proposal = {
    rationale: 'need to ask before proceeding',
    commands: [
      { type: 'create_ticket', title: 'Prep work', description: 'd', acceptance_criteria: [] },
      { type: 'request_user_decision', question: 'Which library?', context: 'both look equivalent' },
    ],
  };

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal);

  assert.equal(result.outcome, 'applied');
  if (result.outcome !== 'applied') return;
  assert.equal(result.ticketStatus, 'BLOCKED');
  // The other commands in the SAME proposal still applied -- a decision
  // request does not roll back the rest of an otherwise-valid proposal.
  assert.equal(result.created.length, 1);
  assert.equal(getTicket(db, result.created[0].ticketId)!.title, 'Prep work');

  assert.equal(getTicket(db, managerTicket.id)!.status, 'BLOCKED');
  const decisionEvent = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'worker_needs_user_decision');
  assert.ok(decisionEvent, 'expected a worker_needs_user_decision event, the same shape any worker\'s own decision request uses');
  assert.equal(decisionEvent!.visibility, 'inbox');
  assert.equal(decisionEvent!.requiresUser, true);

  // The existing decide() command, unmodified, answers it: no new
  // answering mechanism was built for the Manager's own question.
  const decided = decide(db, { ticketId: managerTicket.id, answer: 'Use library X.' });
  assert.equal(decided.status, 'READY', 'answering unblocks the manager ticket, so the next tick can re-run the Manager');
});

test('rollback: an application failure partway through leaves the board exactly as it was before, and records no event', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const ticketsBefore = listTickets(db, project.id).map((t) => t.id).sort();

  const proposal = {
    rationale: 'r',
    commands: [
      { type: 'create_ticket', title: 'First', description: 'd', acceptance_criteria: [] },
      { type: 'create_ticket', title: 'Second', description: 'd', acceptance_criteria: [] },
      { type: 'create_ticket', title: 'Third', description: 'd', acceptance_criteria: [] },
    ],
  };

  // Two of the three create_ticket commands are allowed to apply before a
  // synthetic failure fires on the third -- proving the WHOLE transaction
  // rolls back, not just the one command that happened to throw.
  assert.throws(() =>
    applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal, { failAfterCommand: 2 })
  );

  const ticketsAfter = listTickets(db, project.id).map((t) => t.id).sort();
  assert.deepEqual(ticketsAfter, ticketsBefore, 'not one of the three tickets may survive a rolled-back transaction, including the two applied before the failure');
  assert.equal(getTicket(db, managerTicket.id)!.status, 'IN_PROGRESS', 'the manager ticket must not be transitioned either');
  assert.deepEqual(listEventsForEntity(db, 'ticket', managerTicket.id).filter((e) => e.eventType === 'manager_proposal_applied'), []);
});

test('rollback: a failure on the FIRST command still leaves zero partial state', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const ticketsBefore = listTickets(db, project.id).map((t) => t.id).sort();

  const proposal = {
    rationale: 'r',
    commands: [{ type: 'create_ticket', title: 'Only one', description: 'd', acceptance_criteria: [] }],
  };

  assert.throws(() => applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal, { failAfterCommand: 0 }));

  assert.deepEqual(
    listTickets(db, project.id).map((t) => t.id).sort(),
    ticketsBefore
  );
});

test('replay: the manager_proposal_applied event payload carries enough to reconstruct the applied board on its own, without re-querying ticket_dependencies', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const existingTicket = createTicket(db, { projectId: project.id, title: 'Existing' });
  const managerTicket = makeManagerTicket(db, project.id);

  const proposal = {
    rationale: 'r',
    commands: [
      { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [] },
      { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['A', existingTicket.id] },
      { type: 'change_priority', ticket_id: existingTicket.id, priority: 9 },
    ],
  };

  applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal);

  const event = listEventsForEntity(db, 'ticket', managerTicket.id).find((e) => e.eventType === 'manager_proposal_applied')!;
  const payload = event.payload as ManagerProposalAppliedPayload;

  // Ticket ROWS are not event-sourced in this codebase (only tickets.status
  // is, via stateMachine.ts) -- "replay reproduces the applied board" is
  // read here as "the event carries enough to reconstruct what was
  // applied," not "a fresh database folding only over events produces an
  // identical ticket table." This test proves the weaker, correct claim: a
  // pure, DB-independent walk of payload.commands + payload.created
  // reconstructs the exact same title->id map and dependency edges the
  // real database ended up with.
  const titleToId = new Map<string, string>(payload.created.map((c) => [c.title, c.ticketId]));
  const existingIds = new Set(listTickets(db, project.id).map((t) => t.id));
  existingIds.delete(titleToId.get('A')!);
  existingIds.delete(titleToId.get('B')!);

  const reconstructedEdges: Array<{ from: string; to: string }> = [];
  for (const c of payload.commands) {
    if (c.type === 'create_ticket') {
      const fromId = titleToId.get(c.title)!;
      for (const ref of c.depends_on ?? []) {
        const toId = titleToId.get(ref) ?? ref; // ref is either a new title or an existing id
        reconstructedEdges.push({ from: fromId, to: toId });
      }
    }
  }

  const aId = titleToId.get('A')!;
  const bId = titleToId.get('B')!;
  assert.deepEqual(
    reconstructedEdges.sort((x, y) => (x.to > y.to ? 1 : -1)),
    [
      { from: bId, to: aId },
      { from: bId, to: existingTicket.id },
    ].sort((x, y) => (x.to > y.to ? 1 : -1))
  );

  // Cross-check against the real database: the reconstruction above must
  // match reality exactly, not merely be internally consistent.
  const realEdgesForB = getDependencies(db, bId).map((d) => d.dependsOnTicketId).sort();
  assert.deepEqual(realEdgesForB, [aId, existingTicket.id].sort());
  assert.equal(getTicket(db, existingTicket.id)!.priority, 9);
});

// --- Batch 11 item 1: update_scope ---

test('update_scope writes the scope file whole and records a scope_updated event with a one-line summary', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'update-scope', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  const managerTicket = makeManagerTicket(db, project.id);

  const proposal = { rationale: 'wrote down the assessment', commands: [{ type: 'update_scope', content: 'Line one.\nLine two.' }] };
  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal);

  assert.equal(result.outcome, 'applied');
  assert.equal(readScopeText(getProject(db, project.id)!), 'Line one.\nLine two.');

  const scopeEvent = listEventsForProject(db, project.id).find((e) => e.eventType === 'scope_updated');
  assert.ok(scopeEvent, 'expected a scope_updated event');
  const payload = scopeEvent!.payload as { summary: string };
  assert.match(payload.summary, /written|updated/);
});

test('update_scope replaces the WHOLE file, not an append -- a second update_scope in a later proposal overwrites the first', () => {
  const db = openDb(':memory:');
  const scopePath = join(testRoot.root, 'update-scope-replace', 'SCOPE.md');
  const project = createProject(db, { name: 'p', scopePath });
  const firstTicket = makeManagerTicket(db, project.id);

  applyManagerProposal(db, firstTicket, getProject(db, project.id)!, 'run_1', {
    rationale: 'r',
    commands: [{ type: 'update_scope', content: 'First version.' }],
  });

  const secondTicket = makeManagerTicket(db, project.id);
  applyManagerProposal(db, secondTicket, getProject(db, project.id)!, 'run_2', {
    rationale: 'r',
    commands: [{ type: 'update_scope', content: 'Second version.' }],
  });

  assert.equal(readScopeText(getProject(db, project.id)!), 'Second version.', 'the file must be fully replaced, not appended to');
});

// --- Batch 11 item 4: cancel_ticket / update_ticket ---

test('cancel_ticket cancels an existing work ticket through the single write site, under the same transaction as the rest of the proposal', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const toCancel = createTicket(db, { projectId: project.id, title: 'Cancel me' });

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', {
    rationale: 'no longer needed',
    commands: [{ type: 'cancel_ticket', ticket_id: toCancel.id }],
  });

  assert.equal(result.outcome, 'applied');
  assert.equal(getTicket(db, toCancel.id)!.status, 'CANCELLED');
});

test('update_ticket updates the named fields on an existing work ticket and never touches its status', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const target = createTicket(db, { projectId: project.id, title: 'Old title', description: 'Old description' });

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', {
    rationale: 'refine the ticket',
    commands: [
      {
        type: 'update_ticket',
        ticket_id: target.id,
        title: 'New title',
        description: 'New description',
        acceptance_criteria: ['a'],
        max_budget_usd: 1.0,
        model: 'claude-fable-5-1',
        model_reason: 'deep design trade-offs on this one',
      },
    ],
  });

  assert.equal(result.outcome, 'applied');
  const updated = getTicket(db, target.id)!;
  assert.equal(updated.title, 'New title');
  assert.equal(updated.description, 'New description');
  assert.deepEqual(updated.acceptanceCriteria, ['a']);
  assert.equal(updated.maxBudgetUsdOverride, 1.0);
  assert.equal(updated.model, 'claude-fable-5-1');
  assert.equal(updated.modelReason, 'deep design trade-offs on this one');
  // READY, not OPEN: applyManagerProposal's own resolveReadiness call
  // promotes a dependency-free ticket the same as it always does -- that is
  // ordinary readiness resolution, not update_ticket itself touching
  // status. The claim this test makes is narrower: update_ticket's own
  // field list has no `status` key at all (see UpdateTicketCommand), so
  // nothing about THIS command could have set it to some other value, e.g.
  // DONE.
  assert.equal(updated.status, 'READY');
});

// --- Batch 15 item 4: expected_artifacts flows through create_ticket/update_ticket ---

test('create_ticket with expected_artifacts persists the list on the new ticket; without it, the ticket has none', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', {
    rationale: 'r',
    commands: [
      { type: 'create_ticket', title: 'With list', description: 'd', acceptance_criteria: [], expected_artifacts: [{ kind: 'file', path: 'out.txt' }] },
      { type: 'create_ticket', title: 'Without list', description: 'd', acceptance_criteria: [] },
    ],
  });

  assert.equal(result.outcome, 'applied');
  const withList = getTicket(db, (result as { created: Array<{ title: string; ticketId: string }> }).created.find((c) => c.title === 'With list')!.ticketId)!;
  assert.deepEqual(withList.expectedArtifacts, [{ kind: 'file', path: 'out.txt' }]);
  const withoutList = getTicket(db, (result as { created: Array<{ title: string; ticketId: string }> }).created.find((c) => c.title === 'Without list')!.ticketId)!;
  assert.equal(withoutList.expectedArtifacts, null);
});

test('update_ticket with expected_artifacts sets the list on an existing ticket that had none', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const target = createTicket(db, { projectId: project.id, title: 'Target' });
  assert.equal(target.expectedArtifacts, null);

  const result = applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', {
    rationale: 'r',
    commands: [{ type: 'update_ticket', ticket_id: target.id, expected_artifacts: [{ kind: 'file', path: 'result.json' }] }],
  });

  assert.equal(result.outcome, 'applied');
  assert.deepEqual(getTicket(db, target.id)!.expectedArtifacts, [{ kind: 'file', path: 'result.json' }]);
});

test('rollback: cancel_ticket and update_ticket both roll back with the rest of the transaction on a later synthetic failure', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const managerTicket = makeManagerTicket(db, project.id);
  const toCancel = createTicket(db, { projectId: project.id, title: 'Cancel me' });
  const toUpdate = createTicket(db, { projectId: project.id, title: 'Update me' });

  const proposal = {
    rationale: 'r',
    commands: [
      { type: 'cancel_ticket', ticket_id: toCancel.id },
      { type: 'update_ticket', ticket_id: toUpdate.id, title: 'Should not stick' },
      { type: 'create_ticket', title: 'Never created', description: 'd', acceptance_criteria: [] },
    ],
  };

  assert.throws(() =>
    applyManagerProposal(db, managerTicket, getProject(db, project.id)!, 'run_1', proposal, { failAfterCommand: 2 })
  );

  assert.equal(getTicket(db, toCancel.id)!.status, 'OPEN', 'cancel_ticket must roll back along with the rest of the transaction');
  assert.equal(getTicket(db, toUpdate.id)!.title, 'Update me', 'update_ticket must roll back along with the rest of the transaction');
});

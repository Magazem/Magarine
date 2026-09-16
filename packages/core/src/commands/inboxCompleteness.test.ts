import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../db/index.ts';
import { inboxEventTypes } from '../policy.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { createProject, createTicket, insertEvent, pauseProjectAdapter } from '../store.ts';
import { buildInbox } from './inbox.ts';

// Batch 12 (Role S): the completeness net on top of policy.ts's own
// load-time check. That check catches an inbox row with NO resolvesWhen at
// all; this one catches the next failure mode -- a resolvesWhen that
// typechecks but is wrong, or a buildInbox composer that silently stops
// firing for one event type. Each scenario below drives ONE inbox-visibility
// event type through the same primitives the real code paths use
// (recordTicketTransition / insertEvent / pauseProjectAdapter -- never
// buildInbox or policy.ts's own internals), then asserts the event is
// actually surfaced. `policy.ts`'s `inboxEventTypes()` enumerates the rows
// to check, not a hand-copied list here: a new inbox row added later with no
// matching scenario fails this test by name, rather than silently having
// nothing to prove it.

interface Scenario {
  db: Db;
  projectId: string;
}

function claim(db: Db, ticketId: string, tag: string): void {
  recordTicketTransition(db, { ticketId, event: 'dependencies_resolved', idempotencyKey: `dr_${tag}` });
  recordTicketTransition(db, { ticketId, event: 'run_started', idempotencyKey: `rs_${tag}` });
}

// The exact next-command substring each scenario's inbox line must contain
// -- this is the "names the next command" half of the completeness check,
// not just "the item exists". Batch 12 binding corollary (the
// unknown_model_rate finding, see policy.ts's own comment on that row): an
// event that cannot name a next command is not an inbox item, by
// definition -- so `nextCommand` is required, not optional, for every row
// that claims inbox visibility here. `unknown_model_rate` itself is no
// longer in this table at all: it is `visibility: 'activity'` now, so
// `inboxEventTypes()` no longer lists it and this table must not either
// (see the set-equality test below).
const SCENARIOS: Record<string, { build: () => Scenario; nextCommand: string; persistedAs?: string }> = {
  worker_needs_user_decision: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't' });
      claim(db, ticket.id, ticket.id);
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_needs_user_decision',
        idempotencyKey: `wnud_${ticket.id}`,
        payload: { status: 'needs_user_decision', summary: 'Which library?' },
      });
      return { db, projectId: project.id };
    },
    nextCommand: 'magarine decide --ticket',
  },
  worker_needs_review: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't' });
      claim(db, ticket.id, ticket.id);
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_needs_review',
        idempotencyKey: `wnr_${ticket.id}`,
        payload: { status: 'review', summary: 'please check the approach' },
      });
      return { db, projectId: project.id };
    },
    nextCommand: 'magarine approve --ticket',
  },
  worker_failed_final: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts: 1 });
      claim(db, ticket.id, ticket.id);
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_failure',
        idempotencyKey: `wf_${ticket.id}`,
        payload: { retryable: false, failureClass: 'adapter_failure', message: 'gave up' },
      });
      return { db, projectId: project.id };
    },
    nextCommand: 'magarine retry --ticket',
  },
  worker_budget_stop: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't' });
      claim(db, ticket.id, ticket.id);
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_budget_stop',
        idempotencyKey: `wbs_${ticket.id}`,
        payload: { retryable: false, failureClass: 'worker_budget_stop' },
      });
      return { db, projectId: project.id };
    },
    // `worker_budget_stop` is a policy row for a verb, not a persisted
    // event type -- it exists only so policy.test.ts's SEPARATE
    // TransitionEvent completeness check has a row to find (see policy.ts's
    // own comment on this row). stateMachine.ts always persists its outcome
    // as `worker_failed_final` (never `worker_budget_stop` itself), so
    // that's what buildInbox actually sees and what this scenario must look
    // for -- searching for "worker_budget_stop" here would always find
    // nothing, for a reason that has nothing to do with buildInbox.
    nextCommand: 'magarine retry --ticket',
    persistedAs: 'worker_failed_final',
  },
  workspace_preparation_failed: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't' });
      recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr_${ticket.id}` });
      insertEvent(db, {
        projectId: project.id,
        eventType: 'workspace_preparation_failed',
        entityType: 'ticket',
        entityId: ticket.id,
        payload: { message: 'DIRECTORY workspace requires a workspaceRoot', projectId: project.id },
        visibility: 'inbox',
        requiresUser: true,
        idempotencyKey: `wpf_${ticket.id}`,
      });
      return { db, projectId: project.id };
    },
    nextCommand: 'project set --project',
  },
  manager_daily_cap_reached: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't', kind: 'manager', workspaceType: 'NONE' });
      recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr_${ticket.id}` });
      insertEvent(db, {
        projectId: project.id,
        eventType: 'manager_daily_cap_reached',
        entityType: 'ticket',
        entityId: ticket.id,
        payload: { cap: 20 },
        visibility: 'inbox',
        requiresUser: true,
        idempotencyKey: `mdcr_${ticket.id}`,
      });
      return { db, projectId: project.id };
    },
    nextCommand: 'no action needed',
  },
  adapter_unavailable: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p' });
      const ticket = createTicket(db, { projectId: project.id, title: 't' });
      insertEvent(db, {
        projectId: project.id,
        eventType: 'adapter_unavailable',
        entityType: 'ticket',
        entityId: ticket.id,
        payload: { message: 'not logged in' },
        visibility: 'inbox',
        requiresUser: true,
        idempotencyKey: `au_${ticket.id}`,
      });
      pauseProjectAdapter(db, project.id, 'adapter_unavailable');
      return { db, projectId: project.id };
    },
    nextCommand: 'magarine resume --project',
    // describeProjectPause (commands/inbox.ts) synthesizes ONE collapsed
    // pause item from the project's own current state rather than echoing
    // the raw triggering event back -- its eventType is the composed
    // 'adapter_unavailable_pause', not the raw 'adapter_unavailable' this
    // scenario recorded.
    persistedAs: 'adapter_unavailable_pause',
  },
  project_spend_cap_reached: {
    build: () => {
      const db = openDb(':memory:');
      const project = createProject(db, { name: 'p', maxSpendUsd: 1 });
      insertEvent(db, {
        projectId: project.id,
        eventType: 'project_spend_cap_reached',
        entityType: 'project',
        entityId: project.id,
        payload: { ticketId: 'tkt_x', projectedSpend: 1.2, maxSpendUsd: 1.0 },
        visibility: 'inbox',
        requiresUser: true,
        idempotencyKey: `pscr_${project.id}`,
      });
      pauseProjectAdapter(db, project.id, 'spend_cap');
      return { db, projectId: project.id };
    },
    nextCommand: 'magarine project set --project',
  },
};

test('every inbox-visibility policy row has a completeness scenario, and every scenario is a real policy row', () => {
  const policyRows = new Set(inboxEventTypes());
  const scenarioRows = new Set(Object.keys(SCENARIOS));
  assert.deepEqual([...policyRows].sort(), [...scenarioRows].sort());
});

test('a ticket that fails, is retried, and fails again shows exactly one inbox item, for the SECOND failure, not both', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  claim(db, ticket.id, `${ticket.id}-1`);
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: `wf_${ticket.id}_1`,
    payload: { retryable: false, failureClass: 'adapter_failure', message: 'first failure' },
  });

  recordTicketTransition(db, { ticketId: ticket.id, event: 'manual_retry', idempotencyKey: `mr_${ticket.id}` });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'run_started', idempotencyKey: `rs2_${ticket.id}` });
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: `wf_${ticket.id}_2`,
    payload: { retryable: false, failureClass: 'adapter_failure', message: 'second failure' },
  });

  const items = buildInbox(db, project.id).filter((i) => i.ticketId === ticket.id);
  assert.equal(items.length, 1, 'the earlier, superseded worker_failed_final must not also still show');
  assert.match(items[0].message, /second failure/);
  assert.doesNotMatch(items[0].message, /first failure/);
});

test('two DIFFERENT inbox event types both pending READY on the same ticket both show -- the dedup key is (entityId, eventType), not entityId alone', () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't' });
  recordTicketTransition(db, { ticketId: ticket.id, event: 'dependencies_resolved', idempotencyKey: `dr_${ticket.id}` });

  // Two unrelated inbox-visibility event types, both resolvesWhen ticketLeaves
  // READY, both currently true for this one ticket. A dedup key of entityId
  // alone would let the second inserted overwrite the first in the lookup
  // map, silently dropping a real, independently-true fact.
  insertEvent(db, {
    projectId: project.id,
    eventType: 'manager_daily_cap_reached',
    entityType: 'ticket',
    entityId: ticket.id,
    payload: { cap: 20 },
    visibility: 'inbox',
    requiresUser: true,
    idempotencyKey: `mdcr_${ticket.id}`,
  });
  insertEvent(db, {
    projectId: project.id,
    eventType: 'workspace_preparation_failed',
    entityType: 'ticket',
    entityId: ticket.id,
    payload: { message: 'DIRECTORY workspace requires a workspaceRoot' },
    visibility: 'inbox',
    requiresUser: true,
    idempotencyKey: `wpf_${ticket.id}`,
  });

  const items = buildInbox(db, project.id).filter((i) => i.ticketId === ticket.id);
  const types = items.map((i) => i.eventType).sort();
  assert.deepEqual(types, ['manager_daily_cap_reached', 'workspace_preparation_failed']);
});

// Ruling 17: `reasonFor`'s fallback chain learns `errors` (an array, joined
// with '; ', mirroring `blockers`). Two real sites (scheduler.ts 706 and 684)
// emit `errors` with no `message` at all, and before this ruling both
// collapsed silently to the generic `failed: malformed_result` line -- the
// worker's own reported reason never reached the owner. Each test below uses
// the EXACT payload shape one of those two sites emits, not a simplified
// stand-in, so a chain that only handles a hand-made payload would not pass
// here.

test("reasonFor renders scheduler.ts:706's errors-only payload (a work ticket's done result declaring zero artifacts), not the bare failureClass", () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts: 1 });
  claim(db, ticket.id, ticket.id);
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: `wf_${ticket.id}`,
    payload: { errors: ['done with nothing delivered'], retryable: true, failureClass: 'malformed_result' },
  });

  const item = buildInbox(db, project.id).find((i) => i.ticketId === ticket.id);
  assert.ok(item, 'must reach the inbox once the one attempt is exhausted');
  assert.match(item!.message, /^done with nothing delivered/);
  assert.doesNotMatch(item!.message, /failed: malformed_result/);
});

test("reasonFor renders scheduler.ts:684's errors-only payload (the result-contract validator's own errors), joined with '; ', not the bare failureClass", () => {
  const db = openDb(':memory:');
  const project = createProject(db, { name: 'p' });
  const ticket = createTicket(db, { projectId: project.id, title: 't', maxAttempts: 1 });
  claim(db, ticket.id, ticket.id);
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'worker_failure',
    idempotencyKey: `wf_${ticket.id}`,
    payload: {
      errors: ['status must be one of done/review/needs_user_decision', 'summary is required'],
      retryable: true,
      failureClass: 'malformed_result',
    },
  });

  const item = buildInbox(db, project.id).find((i) => i.ticketId === ticket.id);
  assert.ok(item, 'must reach the inbox once the one attempt is exhausted');
  assert.match(item!.message, /^status must be one of done\/review\/needs_user_decision; summary is required/);
  assert.doesNotMatch(item!.message, /failed: malformed_result/);
});

test('every inbox-visibility event type, recorded through the real path, reaches buildInbox with a line naming the next command', () => {
  for (const eventType of inboxEventTypes()) {
    const scenario = SCENARIOS[eventType];
    assert.ok(scenario, `no completeness scenario for inbox event type "${eventType}"`);
    const { db, projectId } = scenario.build();
    const items = buildInbox(db, projectId);
    const lookFor = scenario.persistedAs ?? eventType;
    const item = items.find((i) => i.eventType === lookFor);
    assert.ok(item, `"${eventType}" was recorded with inbox visibility but never reached buildInbox`);
    // Batch 12 binding corollary: an event that cannot name a next command
    // is not an inbox item, by definition -- so this is not conditional.
    assert.ok(
      item!.message.includes(scenario.nextCommand),
      `"${eventType}"'s inbox line must name its next command ("${scenario.nextCommand}"), got: ${item!.message}`
    );
  }
});

import type { Db } from './db/index.ts';
import { newId } from './id.ts';
import { getDependencies, getTicket, listTicketsByStatus } from './store.ts';
import { recordTicketTransition } from './stateMachine.ts';
import type { Ticket } from './types.ts';

export function isReady(db: Db, ticketId: string): boolean {
  const blockingDeps = getDependencies(db, ticketId).filter((d) => d.dependencyType === 'blocks');
  return blockingDeps.every((d) => getTicket(db, d.dependsOnTicketId)?.status === 'DONE');
}

export interface ResolveReadinessResult {
  promoted: Ticket[];
  demoted: Ticket[];
}

// Reconciles ticket status with the dependency graph in both directions:
//
// - OPEN tickets whose blocking dependencies are all DONE are promoted to
//   READY.
// - READY tickets that are no longer ready are demoted back to OPEN.
//
// The second direction exists because a ticket can be created (and, with no
// dependencies yet, immediately promoted to READY) before a dependency is
// attached to it: `ticket add` cannot know a later `dep add` is coming.
// Without this, `tick()` could pick up and run a ticket whose blocker
// hasn't finished. Call this after every mutation that can change the
// dependency graph (`dep add`) and at the start of every scheduling pass
// (`tick`), so a wrong status in the table is never enough on its own to
// let work run — the scheduler re-derives readiness rather than trusting
// the stored status blindly.
//
// Idempotency keys are randomized per applied transition (rather than
// derived solely from the ticket id) because, with demotion, a ticket can
// now cycle OPEN -> READY -> OPEN -> READY over its lifetime; a
// once-per-ticket key would silently swallow every promotion after the
// first. Safe to call repeatedly: a call that changes nothing (because the
// ticket already left the status it would have been queried for) never
// attempts a transition in the first place.
export function resolveReadiness(db: Db, projectId: string): ResolveReadinessResult {
  const promoted: Ticket[] = [];
  for (const ticket of listTicketsByStatus(db, projectId, 'OPEN')) {
    if (!isReady(db, ticket.id)) continue;
    const result = recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'dependencies_resolved',
      idempotencyKey: newId('evt'),
      visibility: 'internal',
    });
    if (result.applied) promoted.push(result.ticket);
  }

  const demoted: Ticket[] = [];
  for (const ticket of listTicketsByStatus(db, projectId, 'READY')) {
    if (isReady(db, ticket.id)) continue;
    const result = recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'dependency_not_satisfied',
      idempotencyKey: newId('evt'),
      visibility: 'internal',
    });
    if (result.applied) demoted.push(result.ticket);
  }

  return { promoted, demoted };
}

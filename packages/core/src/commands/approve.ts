import { resolveReadiness } from '../dependencies.ts';
import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket } from '../store.ts';
import type { Ticket } from '../types.ts';

// `approve --ticket <id>`: the REVIEW -> DONE half of batch 4's review flow
// (batch-4-spec.md section 2's cross-role contract, spec item 4). Calls
// Role H's `review_approved` transition, then resolves the project's
// dependents' readiness afterward -- same as scheduler.ts already does
// after a worker-reported `worker_done`, since approving a ticket can make
// a blocked dependent ready exactly the same way finishing one does.

export class ApproveError extends Error {}

export function approve(db: Db, input: { ticketId: string }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new ApproveError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'REVIEW') {
    throw new ApproveError(`ticket ${ticket.id} is ${ticket.status}, not REVIEW; there is nothing to approve`);
  }

  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'review_approved',
    idempotencyKey: newId('evt'),
    payload: {},
  });

  resolveReadiness(db, ticket.projectId);

  return getTicket(db, ticket.id)!;
}

import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket } from '../store.ts';
import type { Ticket } from '../types.ts';

// `retry --ticket <id>`: manually retries a FAILED or (batch 8) CANCELLED
// ticket. Raising `max_attempts` and moving to READY both happen inside the
// `manual_retry` transition (stateMachine.ts). Visibility/requiresUser are
// no longer passed explicitly -- stateMachine.ts's write site now derives
// them from `policy.ts`'s `classify(event)` itself.
//
// Batch 8: this is also the one, explicit way back to READY for a ticket a
// person cancelled (`cancel --ticket`) -- the Strategist's ruling was "cancel
// then retry" in two steps, not a separate reopen command, so this file's
// only change for that ruling is accepting CANCELLED here too.

export class RetryError extends Error {}

export function retry(db: Db, input: { ticketId: string }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new RetryError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'FAILED' && ticket.status !== 'CANCELLED') {
    throw new RetryError(
      `ticket ${ticket.id} is ${ticket.status}, not FAILED or CANCELLED; there is nothing to retry`
    );
  }

  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'manual_retry',
    idempotencyKey: newId('evt'),
    payload: {},
  });

  return getTicket(db, ticket.id)!;
}

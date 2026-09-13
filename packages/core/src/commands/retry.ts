import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket } from '../store.ts';
import type { Ticket } from '../types.ts';

// `retry --ticket <id>`: manually retries a FAILED ticket. Raising
// `max_attempts` and moving FAILED -> READY both happen inside the
// `manual_retry` transition (stateMachine.ts). Visibility/requiresUser are
// no longer passed explicitly -- stateMachine.ts's write site now derives
// them from `policy.ts`'s `classify(event)` itself.

export class RetryError extends Error {}

export function retry(db: Db, input: { ticketId: string }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new RetryError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'FAILED') {
    throw new RetryError(`ticket ${ticket.id} is ${ticket.status}, not FAILED; there is nothing to retry`);
  }

  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'manual_retry',
    idempotencyKey: newId('evt'),
    payload: {},
  });

  return getTicket(db, ticket.id)!;
}

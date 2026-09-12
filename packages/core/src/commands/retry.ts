import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { classify } from '../policy.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket } from '../store.ts';
import type { Ticket } from '../types.ts';

// `retry --ticket <id>`: manually retries a FAILED ticket. Raising
// `max_attempts` and moving FAILED -> READY both happen inside the
// `manual_retry` transition, which is Role F's addition to
// stateMachine.ts's transition table (in progress in parallel; not present
// on a checkout that hasn't picked up that commit yet, in which case this
// throws `InvalidTransitionError`, which is expected, not a bug here).

export class RetryError extends Error {}

export function retry(db: Db, input: { ticketId: string }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new RetryError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'FAILED') {
    throw new RetryError(`ticket ${ticket.id} is ${ticket.status}, not FAILED; there is nothing to retry`);
  }

  const policy = classify('manual_retry');
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'manual_retry',
    idempotencyKey: newId('evt'),
    payload: {},
    visibility: policy.visibility,
    requiresUser: policy.requiresUser,
  });

  return getTicket(db, ticket.id)!;
}

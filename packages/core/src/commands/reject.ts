import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket } from '../store.ts';
import type { Ticket } from '../types.ts';

// `reject --ticket <id> --reason "<text>"`: the REVIEW -> READY half of
// batch 4's review flow (batch-4-spec.md section 2's cross-role contract,
// spec item 4). Calls Role H's `review_rejected` transition with payload
// `{ reason }`, per that contract; `review_rejected` consumes one attempt
// and, on exhaustion, `stateMachine.ts` persists it as `worker_failed_final`
// (REVIEW -> FAILED) instead -- the same "exhausted" outcome an ordinary
// worker failure reaches, so it surfaces in the inbox the same way.

export class RejectError extends Error {}

export function reject(db: Db, input: { ticketId: string; reason: string }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new RejectError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'REVIEW') {
    throw new RejectError(`ticket ${ticket.id} is ${ticket.status}, not REVIEW; there is nothing to reject`);
  }
  if (!input.reason) {
    throw new RejectError('--reason is required: a rejection with no reason gives the worker nothing to act on');
  }

  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'review_rejected',
    idempotencyKey: newId('evt'),
    payload: { reason: input.reason },
  });

  return getTicket(db, ticket.id)!;
}

import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket, listEventsForEntity } from '../store.ts';
import type { Ticket } from '../types.ts';

// `decide --ticket <id> --answer "<text>"`: answers a BLOCKED ticket's
// pending question and unblocks it.
//
// The persisted event_type for this is literally `user_decision` (BLOCKED
// -> READY), per the cross-role contract batch-3-spec.md §2 fixes so Role
// F's envelope work and this command don't need to coordinate: payload
// `{ ticketId, question, answer }`, which is also how scheduler.ts's
// buildEnvelope reads decisions back out for `relevantDecisions`. This is
// the *transition* event, not a separate notification alongside it -- an
// earlier version of this file wrote two events (a `user_decision` record
// plus a `user_decided` transition) because part 1 was written before
// stateMachine.ts had landed the real transition name; `user_decided` was
// never a real event type, and calling it produced a clean
// `InvalidTransitionError` rather than actually deciding anything. Fixed
// here to call the one real transition, `user_decision`.
//
// Visibility/requiresUser are no longer passed explicitly -- stateMachine.ts's
// write site now derives them from `policy.ts`'s `classify(event)` itself.

export class DecideError extends Error {}

// Pulled out so commands/conversation.ts (batch 11 part 2 item 4: the
// page's conversation panel) can show the SAME question text this function
// answers, rather than re-deriving the blockers/summary precedence a second
// time and risking the two disagreeing about what "the question" was.
export function extractQuestionText(payload: unknown): string {
  const p = payload as { blockers?: string[]; summary?: string } | undefined;
  return (p?.blockers && p.blockers.length > 0 ? p.blockers.join('; ') : '') || p?.summary || '';
}

export function decide(db: Db, input: { ticketId: string; answer: string }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new DecideError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'BLOCKED') {
    throw new DecideError(`ticket ${ticket.id} is ${ticket.status}, not BLOCKED; there is nothing to decide`);
  }

  const latestDecisionRequest = listEventsForEntity(db, 'ticket', ticket.id)
    .filter((e) => e.eventType === 'worker_needs_user_decision')
    .sort((a, b) => b.sequence - a.sequence)[0];
  const question = extractQuestionText(latestDecisionRequest?.payload);

  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'user_decision',
    idempotencyKey: newId('evt'),
    payload: { ticketId: ticket.id, question, answer: input.answer },
  });

  return getTicket(db, ticket.id)!;
}

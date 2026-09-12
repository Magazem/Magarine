import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { classify } from '../policy.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket, insertEvent, listEventsForEntity } from '../store.ts';
import type { Ticket } from '../types.ts';

// `decide --ticket <id> --answer "<text>"`: answers a BLOCKED ticket's
// pending question and unblocks it.
//
// Two events are written. First a `user_decision` event carrying the
// question/answer pair (the contract batch-3-spec.md §2 fixes so Role F's
// envelope work and this command don't need to coordinate: payload
// `{ ticketId, question, answer }`). Then the actual state change, the
// `user_decided` transition (BLOCKED -> READY), which is a separate role in
// batch 3 is adding to stateMachine.ts in parallel and is not present yet on
// a cold checkout that hasn't picked up that role's commit -- calling it
// here throws `InvalidTransitionError` until it lands, which is expected and
// not a bug in this file.

export class DecideError extends Error {}

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
  const requestPayload = latestDecisionRequest?.payload as { blockers?: string[]; summary?: string } | undefined;
  const question =
    (requestPayload?.blockers && requestPayload.blockers.length > 0 ? requestPayload.blockers.join('; ') : '') ||
    requestPayload?.summary ||
    '';

  const decisionPolicy = classify('user_decision');
  insertEvent(db, {
    projectId: ticket.projectId,
    eventType: 'user_decision',
    entityType: 'ticket',
    entityId: ticket.id,
    payload: { ticketId: ticket.id, question, answer: input.answer },
    visibility: decisionPolicy.visibility,
    requiresUser: decisionPolicy.requiresUser,
    idempotencyKey: newId('evt'),
  });

  const transitionPolicy = classify('user_decided');
  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'user_decided',
    idempotencyKey: newId('evt'),
    payload: { answer: input.answer },
    visibility: transitionPolicy.visibility,
    requiresUser: transitionPolicy.requiresUser,
  });

  return getTicket(db, ticket.id)!;
}

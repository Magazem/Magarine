import type { Db } from '../db/index.ts';
import { getTicket, isProjectAdapterPaused, listEventsForProject } from '../store.ts';
import type { EventRow, TicketStatus } from '../types.ts';

// `inbox`: events that require the user's attention and have not yet been
// resolved. There is no separate "acknowledged" column on `events` (the
// architecture document sketches one on a `messages` table this
// implementation does not build a second copy of), so "still pending" is
// derived from current state instead of a stored flag.
//
// Two entity scopes, two different "still pending" checks:
// - ticket-scoped (`worker_needs_user_decision`, `worker_needs_review`,
//   `worker_failed_final`): pending while the ticket is still sitting in
//   the *specific* status that event put it into -- not just "some pending
//   status" (a shared set, checked only against the ticket's current
//   status, wrongly resurrects a stale `worker_needs_review` once a
//   `reject`ed-to-exhaustion ticket lands in FAILED: FAILED is pending for
//   `worker_failed_final`, but the ticket is no longer sitting in REVIEW,
//   so the older `worker_needs_review` item must not still count).
// - project-scoped (`project_spend_cap_reached`): pending while the pause
//   it caused is still in effect. `resume --project` is the project-scoped
//   analogue of `decide`/`retry` -- once it clears the pause, the item
//   disappears the same way.
const PENDING_TICKET_STATUS: Record<string, TicketStatus> = {
  worker_needs_user_decision: 'BLOCKED',
  worker_needs_review: 'REVIEW',
  worker_failed_final: 'FAILED',
};

export interface InboxItem {
  /** Set for ticket-scoped events. */
  ticketId?: string;
  /** Set for project-scoped events. */
  projectId?: string;
  eventType: string;
  message: string;
  createdAt: string;
}

// The plain-language reason a line is in the inbox. Falls back through
// increasingly generic payload shapes so a new event type doesn't have to
// change this function to show *something* readable, but the two event
// types this role's brief calls out by name (`worker_failed_final`,
// `project_spend_cap_reached`) get a reason composed from their actual
// payload fields rather than falling all the way back to the bare event
// type, which was the bug: `worker_failed_final`'s `budget_exceeded`
// payload carries `failureClass`/`tally`/`overshoot`, no `summary` or
// `message`, so it used to print only "worker_failed_final".
function reasonFor(eventType: string, payload: unknown): string {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  if (eventType === 'project_spend_cap_reached') {
    const ticketId = typeof p.ticketId === 'string' ? p.ticketId : 'a run';
    const projected = typeof p.projectedSpend === 'number' ? `$${p.projectedSpend.toFixed(2)}` : 'its spend';
    const cap = typeof p.maxSpendUsd === 'number' ? `$${p.maxSpendUsd.toFixed(2)}` : 'the project cap';
    return `project spend cap reached: starting ${ticketId} would bring the project to ${projected} (cap ${cap})`;
  }

  if (typeof p.summary === 'string' && p.summary.length > 0) return p.summary;
  if (Array.isArray(p.blockers) && p.blockers.length > 0) return (p.blockers as unknown[]).join('; ');
  if (typeof p.message === 'string' && p.message.length > 0) return p.message;
  // An exhausted `reject --reason` lands here persisted as
  // `worker_failed_final` but still carries `review_rejected`'s original
  // `{ reason }` payload verbatim (stateMachine.ts inserts the caller's
  // payload as-is regardless of which concrete type it decides to persist
  // under).
  if (typeof p.reason === 'string' && p.reason.length > 0) return `rejected: ${p.reason}`;

  if (typeof p.failureClass === 'string') {
    if (p.failureClass === 'budget_exceeded' && typeof p.tally === 'number' && typeof p.overshoot === 'number') {
      return `budget exceeded: spent $${p.tally.toFixed(2)}, over its ceiling by $${p.overshoot.toFixed(2)}`;
    }
    return `failed: ${p.failureClass}`;
  }

  return eventType;
}

export function buildInbox(db: Db, projectId: string): InboxItem[] {
  const events: EventRow[] = listEventsForProject(db, projectId).filter((e) => e.requiresUser);

  const items: InboxItem[] = [];
  for (const event of events) {
    if (event.entityType === 'ticket') {
      const ticket = getTicket(db, event.entityId);
      const pendingStatus = PENDING_TICKET_STATUS[event.eventType];
      if (!ticket || !pendingStatus || ticket.status !== pendingStatus) continue;
      items.push({
        ticketId: event.entityId,
        eventType: event.eventType,
        message: reasonFor(event.eventType, event.payload),
        createdAt: event.createdAt,
      });
    } else if (event.entityType === 'project') {
      if (!isProjectAdapterPaused(db, event.entityId)) continue;
      items.push({
        projectId: event.entityId,
        eventType: event.eventType,
        message: reasonFor(event.eventType, event.payload),
        createdAt: event.createdAt,
      });
    }
  }
  return items;
}

// Id first on every line -- ticket id for a ticket-scoped item, project id
// for a project-scoped one -- since it's the next thing a person copies.
export function formatInbox(items: InboxItem[]): string {
  if (items.length === 0) return '(inbox is empty)';
  return items.map((i) => `${i.ticketId ?? i.projectId}\t${i.eventType}\t${i.message}`).join('\n');
}

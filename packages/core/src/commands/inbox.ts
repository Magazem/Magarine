import type { Db } from '../db/index.ts';
import { getTicket, listEventsForProject } from '../store.ts';
import type { EventRow } from '../types.ts';

// `inbox`: events that require the user's attention and have not yet been
// resolved. There is no separate "acknowledged" column on `events` (the
// architecture document sketches one on a `messages` table this
// implementation does not build a second copy of), so "still pending" is
// derived from the ticket's current status instead of a stored flag: a
// `requires_user` event is only shown while its ticket is still sitting in
// the status that event put it into. Once `decide`/`retry` move the ticket
// on, the item disappears on its own, with nothing to reconcile.
const PENDING_STATUSES = new Set(['BLOCKED', 'FAILED']);

export interface InboxItem {
  ticketId: string;
  eventType: string;
  message: string;
  createdAt: string;
}

function summarize(payload: unknown, eventType: string): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.summary === 'string' && p.summary.length > 0) return p.summary;
    if (Array.isArray(p.blockers) && p.blockers.length > 0) return p.blockers.join('; ');
    if (typeof p.message === 'string' && p.message.length > 0) return p.message;
  }
  return eventType;
}

export function buildInbox(db: Db, projectId: string): InboxItem[] {
  const events: EventRow[] = listEventsForProject(db, projectId).filter(
    (e) => e.requiresUser && e.entityType === 'ticket'
  );

  const items: InboxItem[] = [];
  for (const event of events) {
    const ticket = getTicket(db, event.entityId);
    if (!ticket || !PENDING_STATUSES.has(ticket.status)) continue;
    items.push({
      ticketId: event.entityId,
      eventType: event.eventType,
      message: summarize(event.payload, event.eventType),
      createdAt: event.createdAt,
    });
  }
  return items;
}

// Ticket id first on every line.
export function formatInbox(items: InboxItem[]): string {
  if (items.length === 0) return '(inbox is empty)';
  return items.map((i) => `${i.ticketId}\t${i.eventType}\t${i.message}`).join('\n');
}

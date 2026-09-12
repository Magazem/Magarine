import type { Db } from '../db/index.ts';
import { listEventsForEntity, listEventsForProject } from '../store.ts';
import type { EventRow } from '../types.ts';

// `activity`: the event log for a ticket or a whole project, collapsed by
// default (internal events hidden) with `--all` to see everything,
// including the internal events the daemon uses to keep itself honest but
// that nobody asked to watch.

export function buildActivity(
  db: Db,
  opts: { projectId?: string; ticketId?: string; all: boolean }
): EventRow[] {
  const events = opts.ticketId
    ? listEventsForEntity(db, 'ticket', opts.ticketId)
    : listEventsForProject(db, opts.projectId ?? '');
  return opts.all ? events : events.filter((e) => e.visibility !== 'internal');
}

// Ticket id (the entity id) first on every line.
export function formatActivity(events: EventRow[]): string {
  if (events.length === 0) return '(no activity)';
  return events.map((e) => `${e.entityId}\t${e.eventType}\t${e.visibility}\t${e.createdAt}`).join('\n');
}

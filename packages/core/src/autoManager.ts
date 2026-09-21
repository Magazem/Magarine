import type { Db } from './db/index.ts';
import { createTicket, lastEventSequenceForTicket, listTickets } from './store.ts';
import type { Ticket } from './types.ts';

// Batch 18 ruling 34 (docs/strategy/batch-18-replan-owner-walk.md): the
// Manager continues on its own until the scope is met or it needs the owner.
// The owner's "it only did phase 0": nothing re-invoked the Manager when the
// board drained, so the daemon idled after the first plan's tickets finished
// until someone typed.
//
// Everything here is decided from the database alone, by EVENT SEQUENCE (the
// one global autoincrement on `events`), never by timestamps: two things that
// happen in the same millisecond are still strictly ordered, which the
// runaway guard below depends on.

export const AUTOMATIC_MANAGER_TITLE = 'Manager: review progress';

const WORK_PENDING = new Set(['READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED']);
const MANAGER_PENDING = new Set(['OPEN', 'READY', 'IN_PROGRESS', 'BLOCKED']);

/** The high-water mark migration 0016 recorded: completions at or below it predate this feature and never trigger an automatic turn. */
export function automaticTurnMark(db: Db): number {
  const row = db.prepare('SELECT since_sequence AS s FROM automatic_manager_mark WHERE id = 1').get() as { s: number } | undefined;
  return row?.s ?? 0;
}

/**
 * The event sequence at which the project's Manager last did anything -- the
 * highest sequence of any event on a manager ticket (its run, its proposal
 * being applied, its terminal transition). 0 when no manager ticket has
 * acted. `excludeTicketId` leaves out the manager ticket being briefed right
 * now, whose own events are the present, not "the last run".
 */
export function lastManagerActivitySeq(db: Db, projectId: string, excludeTicketId?: string): number {
  let seq = 0;
  for (const t of listTickets(db, projectId)) {
    if (t.kind !== 'manager' || t.id === excludeTicketId) continue;
    seq = Math.max(seq, lastEventSequenceForTicket(db, t.id));
  }
  return seq;
}

/** Work tickets that are DONE or FAILED and reached that state after `seq`, oldest first. */
export function workTicketsFinishedSince(db: Db, projectId: string, seq: number): Ticket[] {
  return listTickets(db, projectId)
    .filter((t) => t.kind !== 'manager' && (t.status === 'DONE' || t.status === 'FAILED'))
    .map((t) => ({ t, at: lastEventSequenceForTicket(db, t.id) }))
    .filter((x) => x.at > seq)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.t);
}

/**
 * Called by tick(). Creates ONE manager ticket ("Manager: review progress",
 * no owner message, `automatic`) when, and only when:
 *  - the project has engaged a Manager at all (a manager ticket exists) --
 *    a project driven purely by hand-added tickets never gets an unasked-for
 *    Manager turn;
 *  - no work ticket is READY, IN_PROGRESS or REVIEW (the board has drained)
 *    and none is BLOCKED on the owner (that is Needs You doing its job);
 *  - no manager ticket is waiting, running or blocked;
 *  - at least one work ticket reached DONE or FAILED AFTER the Manager last
 *    acted AND after the migration-0016 high-water mark (a project that was
 *    already finished when this feature arrived stays quiet until new work
 *    finishes on it). This is the runaway guard: an automatic turn's own activity moves
 *    the baseline, so a second automatic turn cannot exist until a work ticket
 *    finishes again -- and an automatic turn that proposes nothing therefore
 *    ends the loop, because nothing finishes after it, until a work ticket
 *    next finishes or the owner writes (which is a manager run, moving the
 *    baseline the same way).
 * The daily cap (manager.ts) is enforced where every manager ticket starts,
 * in tick(), and still refuses these.
 */
export function maybeCreateAutomaticManagerTurn(db: Db, projectId: string): Ticket | undefined {
  const tickets = listTickets(db, projectId);
  const managers = tickets.filter((t) => t.kind === 'manager');
  if (managers.length === 0) return undefined;
  if (tickets.some((t) => t.kind !== 'manager' && WORK_PENDING.has(t.status))) return undefined;
  if (managers.some((t) => MANAGER_PENDING.has(t.status))) return undefined;
  if (workTicketsFinishedSince(db, projectId, Math.max(lastManagerActivitySeq(db, projectId), automaticTurnMark(db))).length === 0) return undefined;

  return createTicket(db, {
    projectId,
    title: AUTOMATIC_MANAGER_TITLE,
    description: null,
    kind: 'manager',
    workspaceType: 'NONE',
    automatic: true,
  });
}

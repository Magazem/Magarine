import type { Db } from '../db/index.ts';
import { getProject, getTicket, listEventsForProject } from '../store.ts';
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

// Batch 11: the exact command that clears each ticket-scoped pending item,
// appended to its message when a ticketId is available (buildInbox always
// has one; managerEnvelope.ts's call below deliberately does not pass one --
// a CLI command belongs in a line a person reads, not in the Manager's own
// prompt, which has no CLI to run). Keyed by the PENDING_TICKET_STATUS event
// types above, not the generic fallback branches below, since the fix is a
// property of what the ticket is waiting for, not of which payload shape
// happened to compose its message text.
const NEXT_COMMAND: Record<string, (ticketId: string) => string> = {
  worker_needs_user_decision: (id) => `magarine decide --ticket ${id} --answer "..."`,
  worker_needs_review: (id) => `magarine approve --ticket ${id}, or magarine reject --ticket ${id} --reason "..."`,
  worker_failed_final: (id) => `magarine retry --ticket ${id}, once the reason above is addressed`,
};

// The plain-language reason a line is in the inbox. Falls back through
// increasingly generic payload shapes so a new event type doesn't have to
// change this function to show *something* readable, but the two event
// types this role's brief calls out by name (`worker_failed_final`,
// `project_spend_cap_reached`) get a reason composed from their actual
// payload fields rather than falling all the way back to the bare event
// type, which was the bug: `worker_failed_final`'s `budget_exceeded`
// payload carries `failureClass`/`tally`/`overshoot`, no `summary` or
// `message`, so it used to print only "worker_failed_final".
// Exported for managerEnvelope.ts's "last five final failures with their
// reasons" (batch-9-spec.md section 2): the same short, human-readable line
// this file already extracts for the inbox is the right level of detail for
// the Manager too -- a curated one-line reason, not the raw event payload
// (which, for some failure shapes, carries the full WorkerResult: summary,
// checks, artifacts). "no transcripts, no worker prompts" in the spec means
// no full prompts/results/artifact listings reaching the envelope; a failed
// ticket's own reported reason for failing is exactly the "reasons" the
// spec asks the Manager's envelope to carry.
export function reasonFor(eventType: string, payload: unknown, ticketId?: string): string {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  if (eventType === 'project_spend_cap_reached') {
    const ticketRef = typeof p.ticketId === 'string' ? p.ticketId : 'a run';
    const projected = typeof p.projectedSpend === 'number' ? `$${p.projectedSpend.toFixed(2)}` : 'its spend';
    const cap = typeof p.maxSpendUsd === 'number' ? `$${p.maxSpendUsd.toFixed(2)}` : 'the project cap';
    // Batch 11 ruling 1 rule c: the line must NAME the fix, not just state
    // the number -- a reader should never have to already know the CLI to
    // clear their own pause. projectId is threaded through by buildPauseItem
    // below, which is the only caller that reaches this branch now.
    const projectId = typeof p.projectId === 'string' ? p.projectId : '<id>';
    return `project spend cap reached: starting ${ticketRef} would bring the project to ${projected} (cap ${cap}) -- raise it with \`magarine project set --project ${projectId} --max-spend <usd>\``;
  }

  if (eventType === 'adapter_unavailable_pause') {
    // Batch 11 ruling 1 rule d: unlike a cap, this pause cannot be cleared
    // by a bigger number -- it needs a real login -- so the fix is a fixed
    // two-step line rather than one composed from payload numbers.
    const projectId = typeof p.projectId === 'string' ? p.projectId : '<id>';
    return `the adapter is unavailable (worker could not start) -- log in with \`claude\`, then run \`magarine resume --project ${projectId}\``;
  }

  const base = ((): string => {
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
      // `tally`/`overshoot` only ever appear on the scheduler's own
      // estimate-driven stop (scheduler.ts's progress-event ceiling branch,
      // `stoppedBy: 'scheduler_estimate'`) -- the tool's own stop
      // (`stoppedBy: 'tool_max_budget_usd'`) never sets these fields, so it
      // falls through to the generic `failureClass` line below unchanged.
      // Batch 6, per the Strategist's ruling: this number is the daemon's
      // own live tally, a known lower bound (see claudeCli.ts's
      // messageModel/priceUsage header), not the tool's exact figure -- say
      // so rather than showing a number that looks as precise as one.
      if (p.failureClass === 'budget_exceeded' && typeof p.tally === 'number' && typeof p.overshoot === 'number') {
        return `budget exceeded: spent at least $${p.tally.toFixed(2)} (live estimate), over its ceiling by at least $${p.overshoot.toFixed(2)}`;
      }
      return `failed: ${p.failureClass}`;
    }

    return eventType;
  })();

  const nextCommand = ticketId ? NEXT_COMMAND[eventType]?.(ticketId) : undefined;
  return nextCommand ? `${base} -- ${nextCommand}` : base;
}

// Batch 11 ruling 1: a pause is now read from the project's OWN current
// state (adapterPausedAt/pauseReason), not filtered out of the stored event
// log, for two reasons found in the same sitting. First, an
// `adapter_unavailable` pause's triggering event is entityType 'ticket' and
// was never in PENDING_TICKET_STATUS, so it was silently invisible in the
// inbox -- a real gap, not a display choice. Second, this makes "is the
// project still paused" the single source of truth for whether the item
// shows at all, exactly the same "still pending" contract every ticket-scoped
// item already gets, rather than the previous project-scoped branch's
// bespoke isProjectAdapterPaused check bolted onto raw event iteration.
// The most recent project_spend_cap_reached event (if any survives -- there
// always is one when the current pause reason is 'spend_cap', since nothing
// else sets that reason) supplies the real projectedSpend/maxSpendUsd
// numbers for reasonFor's message; its own payload gets projectId merged in
// so reasonFor can name the fix command without changing its signature.
function mostRecent(events: EventRow[], eventType: string): EventRow | undefined {
  // listEventsForProject orders ascending by sequence; the pause in effect
  // right now was caused by the LAST matching event, not the first (an
  // earlier pause-then-resume cycle can leave older events of the same type
  // behind).
  return events.filter((e) => e.eventType === eventType).pop();
}

// Exported so board.ts's "PAUSED: <reason>" header (batch 11 rule a) shows
// the exact same wording as this file's own inbox line for the same pause --
// one composer, not two independently-worded copies that could drift.
export function describeProjectPause(
  db: Db,
  project: { id: string; updatedAt: string },
  pauseReason: 'spend_cap' | 'adapter_unavailable' | null
): { eventType: string; message: string; createdAt: string } {
  const pausedEvents = listEventsForProject(db, project.id);
  if (pauseReason === 'adapter_unavailable') {
    const triggering = mostRecent(pausedEvents, 'adapter_unavailable');
    return {
      eventType: 'adapter_unavailable_pause',
      message: reasonFor('adapter_unavailable_pause', { projectId: project.id }),
      createdAt: triggering?.createdAt ?? project.updatedAt,
    };
  }
  if (pauseReason === 'spend_cap') {
    const triggering = mostRecent(pausedEvents, 'project_spend_cap_reached');
    const payload = triggering && typeof triggering.payload === 'object' && triggering.payload !== null ? triggering.payload : {};
    return {
      eventType: 'project_spend_cap_reached',
      message: reasonFor('project_spend_cap_reached', { ...payload, projectId: project.id }),
      createdAt: triggering?.createdAt ?? project.updatedAt,
    };
  }
  // pauseReason === null: a pause recorded before the 0009_pause_reason
  // migration, or by a cause this file doesn't yet know. Still surfaced,
  // generically, rather than silently dropped -- "READY under a pause is a
  // lie" per the board's own header, whatever caused it.
  return {
    eventType: 'adapter_paused',
    message: `project is paused for an unrecorded reason -- run \`magarine resume --project ${project.id}\` once you've addressed it`,
    createdAt: project.updatedAt,
  };
}

export function buildInbox(db: Db, projectId: string): InboxItem[] {
  const events: EventRow[] = listEventsForProject(db, projectId).filter((e) => e.requiresUser);

  const items: InboxItem[] = [];
  for (const event of events) {
    if (event.entityType !== 'ticket') continue;
    const ticket = getTicket(db, event.entityId);
    const pendingStatus = PENDING_TICKET_STATUS[event.eventType];
    if (!ticket || !pendingStatus || ticket.status !== pendingStatus) continue;
    items.push({
      ticketId: event.entityId,
      eventType: event.eventType,
      message: reasonFor(event.eventType, event.payload, event.entityId),
      createdAt: event.createdAt,
    });
  }

  const project = getProject(db, projectId);
  if (project && project.adapterPausedAt != null) {
    const pause = describeProjectPause(db, project, project.pauseReason);
    items.push({ projectId: project.id, ...pause });
  }

  return items;
}

// Id first on every line -- ticket id for a ticket-scoped item, project id
// for a project-scoped one -- since it's the next thing a person copies.
export function formatInbox(items: InboxItem[]): string {
  if (items.length === 0) return '(inbox is empty)';
  return items.map((i) => `${i.ticketId ?? i.projectId}\t${i.eventType}\t${i.message}`).join('\n');
}

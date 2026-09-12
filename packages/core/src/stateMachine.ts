import type { Db } from './db/index.ts';
import { withTransaction } from './db/index.ts';
import { getTicket, insertEvent } from './store.ts';
import type { EventVisibility, Ticket, TicketStatus } from './types.ts';

// The ticket state machine. `recordTicketTransition` is the ONLY function in
// this codebase that writes `tickets.status`. Every other module that needs
// to move a ticket calls this function; none of them touch the column
// directly. This is enforced by `architecture.test.ts`, which greps the
// source tree for `SET status` against the tickets table.

export type TransitionEvent =
  | 'dependencies_resolved'
  | 'dependency_not_satisfied'
  | 'run_started'
  | 'worker_done'
  | 'worker_needs_review'
  | 'worker_retryable_failure'
  | 'worker_question'
  | 'worker_needs_user_decision'
  | 'cancel';

export class InvalidTransitionError extends Error {
  constructor(from: TicketStatus, event: TransitionEvent) {
    super(`invalid transition: cannot apply "${event}" to a ticket in status ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

// Static targets for events whose destination does not depend on ticket
// data. `worker_retryable_failure` is handled separately below because its
// destination (READY vs FAILED) depends on attempt_count vs max_attempts.
const TRANSITIONS: Record<TicketStatus, Partial<Record<Exclude<TransitionEvent, 'worker_retryable_failure'>, TicketStatus>>> = {
  OPEN: {
    dependencies_resolved: 'READY',
    cancel: 'CANCELLED',
  },
  READY: {
    run_started: 'IN_PROGRESS',
    // Defends against a ticket being (or having been) promoted to READY
    // before all of its dependencies were known — e.g. a dependency added
    // via `dep add` after the ticket was already created. See
    // dependencies.ts's `resolveReadiness`, which is the only caller.
    dependency_not_satisfied: 'OPEN',
    cancel: 'CANCELLED',
  },
  IN_PROGRESS: {
    worker_done: 'DONE',
    worker_needs_review: 'REVIEW',
    worker_question: 'IN_PROGRESS',
    worker_needs_user_decision: 'BLOCKED',
    cancel: 'CANCELLED',
  },
  REVIEW: {
    cancel: 'CANCELLED',
  },
  BLOCKED: {},
  DONE: {},
  FAILED: {},
  CANCELLED: {},
};

interface NextState {
  toStatus: TicketStatus;
  attemptCount: number;
}

function computeNextState(ticket: Ticket, event: TransitionEvent): NextState {
  if (event === 'worker_retryable_failure') {
    if (ticket.status !== 'IN_PROGRESS') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    const attemptCount = ticket.attemptCount + 1;
    const toStatus: TicketStatus = attemptCount >= ticket.maxAttempts ? 'FAILED' : 'READY';
    return { toStatus, attemptCount };
  }

  const toStatus = TRANSITIONS[ticket.status][event];
  if (!toStatus) {
    throw new InvalidTransitionError(ticket.status, event);
  }
  return { toStatus, attemptCount: ticket.attemptCount };
}

export interface RecordTransitionInput {
  ticketId: string;
  event: TransitionEvent;
  idempotencyKey: string;
  payload?: unknown;
  visibility?: EventVisibility;
  requiresUser?: boolean;
}

export interface RecordTransitionResult {
  applied: boolean;
  ticket: Ticket;
  sequence: number | null;
}

export function recordTicketTransition(db: Db, input: RecordTransitionInput): RecordTransitionResult {
  return withTransaction(db, () => {
    const ticket = getTicket(db, input.ticketId);
    if (!ticket) {
      throw new Error(`ticket not found: ${input.ticketId}`);
    }

    // Check idempotency before validating the transition: a replayed event
    // for a transition that has already happened would otherwise look like
    // an invalid transition from the ticket's *current* (already-advanced)
    // status, when it should just be a silent no-op.
    const { inserted, sequence } = insertEvent(db, {
      projectId: ticket.projectId,
      eventType: input.event,
      entityType: 'ticket',
      entityId: ticket.id,
      payload: input.payload,
      visibility: input.visibility,
      requiresUser: input.requiresUser,
      idempotencyKey: input.idempotencyKey,
    });

    if (!inserted) {
      return { applied: false, ticket, sequence: null };
    }

    const { toStatus, attemptCount } = computeNextState(ticket, input.event);

    const now = new Date().toISOString();
    db.prepare('UPDATE tickets SET status = ?, attempt_count = ?, updated_at = ? WHERE id = ?').run(
      toStatus,
      attemptCount,
      now,
      ticket.id
    );

    return { applied: true, ticket: getTicket(db, ticket.id)!, sequence };
  });
}

// Pure reducer used by the replay test to prove the derived `tickets.status`
// row can be reconstructed from nothing but the event log. Mirrors
// `computeNextState` but starts from OPEN/attempt 0 and folds over history.
export function computeStatusFromEvents(
  events: Array<{ eventType: string; payload: unknown }>,
  maxAttempts: number
): { status: TicketStatus; attemptCount: number } {
  let status: TicketStatus = 'OPEN';
  let attemptCount = 0;

  for (const event of events) {
    const fakeTicket: Ticket = {
      id: '',
      projectId: '',
      title: '',
      description: null,
      acceptanceCriteria: [],
      status,
      priority: 0,
      assignee: null,
      attemptCount,
      maxAttempts,
      workspaceType: 'NONE',
      workspaceRef: null,
      resultJson: null,
      createdAt: '',
      updatedAt: '',
    };
    const next = computeNextState(fakeTicket, event.eventType as TransitionEvent);
    status = next.toStatus;
    attemptCount = next.attemptCount;
  }

  return { status, attemptCount };
}

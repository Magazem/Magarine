import type { Db } from './db/index.ts';
import { withTransaction } from './db/index.ts';
import { classify } from './policy.ts';
import { getTicket, hasEvent, insertEvent } from './store.ts';
import type { Ticket, TicketStatus } from './types.ts';

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
  // Batch 4, per docs/strategy/batch-4-spec.md section 1 ruling 4: replaces
  // `worker_retryable_failure`, which could not tell an ordinary retry from
  // an exhausted one from the event type alone (the same event type was
  // persisted either way; only the ticket's resulting status differed).
  // `worker_failure` is the verb the scheduler asks for; this module decides
  // the destination from `payload.retryable` and the ticket's attempt count,
  // then PERSISTS the event under the concrete type it chose --
  // `worker_failed_retryable` (back to READY) or `worker_failed_final`
  // (FAILED, whether by exhaustion or because the failure was not
  // retryable) -- so the policy table (and the inbox) can key on the
  // outcome, not just the verb. See `computeNextState`'s 'worker_failure'
  // case for the actual branching, and policy.ts for why this event type
  // still needs its own (unused-at-insert-time) row: it remains a member of
  // this union so the scheduler can ask for it, and the completeness test
  // (policy.test.ts) parses this union verbatim.
  | 'worker_failure'
  // Batch 7 (Role L, docs/strategy/batch-7-spec.md section 1 ruling 1): the
  // verb the scheduler asks for when a worker's own result carries
  // `status: 'budget_insufficient'` -- it read its ceiling out of the
  // envelope, measured its burn rate, and stopped rather than continue.
  // Unlike `worker_failure`, this is never retryable and never consumes an
  // attempt: retrying under the same ceiling would just reproduce the same
  // stop, so the record must say "raise the budget", not "try again".
  // Always persists as `worker_failed_final` (the concrete FAILED outcome
  // type the inbox already keys on -- see policy.ts's `resolvesWhen` row for
  // it), with `payload.failureClass: 'worker_budget_stop'` distinguishing it
  // from an ordinary exhausted/non-retryable `worker_failure`. See
  // `computeNextState`'s 'worker_budget_stop' case for the live transition
  // and its 'worker_failed_final' case for how replay tells the two apart
  // from the persisted payload alone (there is no second concrete event type
  // for this -- see that branch's comment for why one is not needed).
  | 'worker_budget_stop'
  | 'worker_question'
  | 'worker_needs_user_decision'
  // Batch 8: a PERSON's decision (the daemon's `cancel --ticket`/
  // `POST /tickets/{id}/cancel`), landing the ticket in the terminal
  // CANCELLED, per the Strategist's ruling -- distinct from `run_cancelled`
  // below, which is the DAEMON's own decision (a timeout or a shutdown) and
  // returns to READY instead. Unused by any command from batch 1 through
  // batch 7; see scheduler.ts's cancelTicketRun doc comment for the full
  // reasoning behind the split.
  | 'cancel'
  // Batch 3, per docs/strategy/batch-3-spec.md Role F item 8. Batch 8: also
  // reachable from CANCELLED, not only FAILED -- "cancel, then retry" is the
  // one explicit way back to READY, not a second reopen command.
  | 'manual_retry' // FAILED|CANCELLED -> READY, raises max_attempts by one
  // Persisted event_type is literally 'user_decision', per the cross-role
  // contract in batch-3-spec.md section 2 ("A user decision is an event
  // with event_type = 'user_decision'"), so this transition's name IS the
  // wire event type rather than a separate verb — recordTicketTransition
  // inserts eventType: input.event verbatim, and Role G reads project
  // decisions back out by that exact string.
  | 'user_decision' // BLOCKED -> READY, records { ticketId, question, answer }
  | 'run_cancelled' // IN_PROGRESS -> READY, does not consume an attempt
  // Batch 4, per docs/strategy/batch-4-spec.md section 2's cross-role
  // contract: Role H creates these, Role I's approve/reject commands call
  // them. `review_approved` is a plain static transition (REVIEW -> DONE);
  // the caller is responsible for resolving dependents' readiness
  // afterward, same as scheduler.ts already does after `worker_done`.
  | 'review_approved'
  // REVIEW -> READY, consumes one attempt (payload `{ reason }`);
  // exhaustion lands in FAILED and, like `worker_failure`, is persisted
  // under `worker_failed_final` rather than under this event's own name, so
  // it reaches the inbox the same way any other exhausted failure does
  // without needing a second policy row for "exhausted rejection".
  | 'review_rejected';

// Accepted by `computeNextState` in addition to `TransitionEvent`, for two
// call sites that are never live input: `computeStatusFromEvents` replays
// stored rows, which for a `worker_failure`/`review_rejected` outcome are
// the CONCRETE type this module chose to persist, not the verb the caller
// asked for; and a database's event log written before this batch may still
// contain the retired `worker_retryable_failure` literal, which replay must
// still be able to fold over (see replay.test.ts's legacy-log test).
type ReplayableEvent = TransitionEvent | 'worker_failed_retryable' | 'worker_failed_final' | 'worker_retryable_failure';

export class InvalidTransitionError extends Error {
  constructor(from: TicketStatus, event: TransitionEvent) {
    super(`invalid transition: cannot apply "${event}" to a ticket in status ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

// Static targets for events whose destination does not depend on ticket
// data. `worker_failure`, `review_rejected` and `manual_retry` are handled
// separately below: the first two's destination depends on `payload` and
// attempt_count vs max_attempts, the last also mutates max_attempts itself.
type StaticTransitionEvent = Exclude<
  TransitionEvent,
  'worker_failure' | 'review_rejected' | 'manual_retry' | 'worker_budget_stop'
>;

const TRANSITIONS: Record<TicketStatus, Partial<Record<StaticTransitionEvent, TicketStatus>>> = {
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
    // A daemon-initiated cancellation (adapter_unavailable, a run timeout, or
    // SIGINT/SIGTERM during runUntilIdle): the ticket is not at fault, so
    // unlike worker_failure this never consumes an attempt.
    run_cancelled: 'READY',
    // A PERSON's cancellation (batch 8's `cancel --ticket`): terminal, not
    // READY -- see the TransitionEvent union's own comment on `cancel` for
    // why the two must not share a destination.
    cancel: 'CANCELLED',
  },
  REVIEW: {
    review_approved: 'DONE',
    cancel: 'CANCELLED',
  },
  BLOCKED: {
    user_decision: 'READY',
  },
  DONE: {},
  FAILED: {},
  CANCELLED: {},
};

interface NextState {
  toStatus: TicketStatus;
  attemptCount: number;
  maxAttempts: number;
  /** The event_type actually persisted -- equal to `event` for every static
   * transition, but a concrete, outcome-specific type for `worker_failure`
   * and (on exhaustion) `review_rejected`. See the module header comment. */
  persistedEventType: string;
}

// `payload.retryable` must be an explicit boolean: no default. A missing
// flag defaulting to "retryable" would silently turn a non-retryable
// failure (e.g. a budget overspend) into an ordinary retry -- exactly the
// misclassification batch 3's close-out found and batch 4 exists to fix.
// Every real call site (scheduler.ts, recovery.ts) is required to pass it.
function requireRetryableFlag(payload: unknown, event: string): boolean {
  const retryable = (payload as { retryable?: unknown } | undefined)?.retryable;
  if (typeof retryable !== 'boolean') {
    throw new Error(`${event} requires an explicit boolean "retryable" in its payload, got: ${String(retryable)}`);
  }
  return retryable;
}

// True when `payload` is the shape `worker_budget_stop`/its replayed
// `worker_failed_final` row carries: `{ failureClass: 'worker_budget_stop',
// ... }`. The only place either live branch below needs to tell a budget
// stop apart from an ordinary failure.
function isBudgetStopPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { failureClass?: unknown }).failureClass === 'worker_budget_stop'
  );
}

function computeNextState(ticket: Ticket, event: ReplayableEvent, payload: unknown): NextState {
  if (event === 'worker_budget_stop') {
    if (ticket.status !== 'IN_PROGRESS') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    // No attempt consumed (docs/strategy/batch-7-spec.md section 1 ruling 1):
    // this is the worker explaining that the ceiling, not its own work, is
    // what stopped it, so retrying under the same ceiling would just
    // reproduce the same stop and burn an attempt for nothing. The owner's
    // remedy is `ticket set --budget` (raise the ceiling) then `retry`, not
    // another automatic attempt. Persisted as `worker_failed_final` -- the
    // same concrete outcome type any other FAILED-final failure uses, so the
    // inbox (via policy.ts's `resolvesWhen` row for it, not this file)
    // already knows how to surface it without a second event type or a
    // second policy row keyed on this string alone.
    return {
      toStatus: 'FAILED',
      attemptCount: ticket.attemptCount,
      maxAttempts: ticket.maxAttempts,
      persistedEventType: 'worker_failed_final',
    };
  }

  if (event === 'worker_failure') {
    if (ticket.status !== 'IN_PROGRESS') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    const retryable = requireRetryableFlag(payload, event);
    const attemptCount = ticket.attemptCount + 1;
    const exhausted = attemptCount >= ticket.maxAttempts;
    if (!retryable || exhausted) {
      return { toStatus: 'FAILED', attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: 'worker_failed_final' };
    }
    return { toStatus: 'READY', attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: 'worker_failed_retryable' };
  }

  // Replay-only: a stored row already carries the concrete outcome type, so
  // there is nothing left to decide -- just the same bookkeeping the live
  // 'worker_failure' branch above would have done to reach it.
  if (event === 'worker_failed_retryable') {
    if (ticket.status !== 'IN_PROGRESS') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    return { toStatus: 'READY', attemptCount: ticket.attemptCount + 1, maxAttempts: ticket.maxAttempts, persistedEventType: event };
  }
  if (event === 'worker_failed_final') {
    // Reachable from IN_PROGRESS (a 'worker_failure' or 'worker_budget_stop'
    // outcome) or REVIEW (an exhausted 'review_rejected' outcome) -- all
    // persist under this one concrete name (see the module header comment
    // and 'worker_budget_stop' above for why a second event type is not
    // used). This is replay's only way to see which of those it was: the
    // live 'worker_budget_stop' branch above already knows not to consume an
    // attempt because it computes its own NextState directly, but a stored
    // row replayed by `computeStatusFromEvents` arrives here under the
    // persisted type, not the verb, so this branch must re-derive the same
    // answer from `payload.failureClass` alone -- otherwise the derived
    // ticket row and a fold over its own event log would disagree on
    // attempt_count for every budget-stopped ticket, which is exactly the
    // invariant `replay.test.ts` exists to guard.
    if (ticket.status !== 'IN_PROGRESS' && ticket.status !== 'REVIEW') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    const attemptCount = isBudgetStopPayload(payload) ? ticket.attemptCount : ticket.attemptCount + 1;
    return { toStatus: 'FAILED', attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: event };
  }

  // Legacy: a database's event log written before this batch may still
  // contain this literal event type. Replay must still fold over it the way
  // it always did (destination decided from attempt_count vs max_attempts,
  // since the pre-batch-4 schema never recorded a `retryable` flag on it).
  if (event === 'worker_retryable_failure') {
    if (ticket.status !== 'IN_PROGRESS') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    const attemptCount = ticket.attemptCount + 1;
    const toStatus: TicketStatus = attemptCount >= ticket.maxAttempts ? 'FAILED' : 'READY';
    return { toStatus, attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: event };
  }

  if (event === 'review_rejected') {
    if (ticket.status !== 'REVIEW') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    const attemptCount = ticket.attemptCount + 1;
    if (attemptCount >= ticket.maxAttempts) {
      return { toStatus: 'FAILED', attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: 'worker_failed_final' };
    }
    return { toStatus: 'READY', attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: event };
  }

  if (event === 'manual_retry') {
    // Batch 8's ruling: a cancelled ticket goes back to READY through this
    // same one command, not a separate "reopen" -- see cli.ts's `retry`
    // wiring and commands/retry.ts. maxAttempts is still raised by one
    // unconditionally, same as the FAILED case: harmless when the ticket
    // was cancelled with attempts still remaining, and correct when it
    // wasn't -- one rule, not two, for "one command."
    if (ticket.status !== 'FAILED' && ticket.status !== 'CANCELLED') {
      throw new InvalidTransitionError(ticket.status, event);
    }
    return {
      toStatus: 'READY',
      attemptCount: ticket.attemptCount,
      maxAttempts: ticket.maxAttempts + 1,
      persistedEventType: event,
    };
  }

  const toStatus = TRANSITIONS[ticket.status][event as StaticTransitionEvent];
  if (!toStatus) {
    throw new InvalidTransitionError(ticket.status, event as TransitionEvent);
  }
  return { toStatus, attemptCount: ticket.attemptCount, maxAttempts: ticket.maxAttempts, persistedEventType: event };
}

export interface RecordTransitionInput {
  ticketId: string;
  event: TransitionEvent;
  idempotencyKey: string;
  payload?: unknown;
  /**
   * @deprecated ignored. Visibility and requiresUser are now derived from
   * `policy.ts`'s `classify(event)`, not taken from the caller — see
   * docs/strategy/batch-3-spec.md's Role G part 2. Left on the type only so
   * existing call sites that still pass these (dependencies.ts,
   * scheduler.ts) do not need to change to keep compiling; they are dead
   * parameters now, worth deleting next time those files are touched, but
   * that is not this role's file to edit.
   */
  visibility?: unknown;
  /** @deprecated ignored, see `visibility` above. */
  requiresUser?: unknown;
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

    // Check idempotency BEFORE computing anything: a replayed event for a
    // transition that already happened would otherwise be evaluated against
    // the ticket's *current* (already-advanced) status. That used to just
    // make `computeNextState` look up the wrong (also-invalid) static
    // transition; since batch 4, `worker_failure`/`review_rejected` also
    // *validate* the ticket's current status themselves (see
    // `computeNextState`), so evaluating them a second time on an
    // already-transitioned ticket would throw InvalidTransitionError instead
    // of the silent no-op replay requires. Hence this check must happen
    // strictly before `computeNextState` is ever called, not after.
    if (hasEvent(db, input.idempotencyKey)) {
      return { applied: false, ticket, sequence: null };
    }

    // Decide the destination -- and, for `worker_failure`/`review_rejected`,
    // which concrete event type to persist -- from the ticket's real current
    // status, now that we know this is not a replay.
    const { toStatus, attemptCount, maxAttempts, persistedEventType } = computeNextState(
      ticket,
      input.event,
      input.payload
    );

    // Every event this function writes goes through the notification policy
    // table (policy.ts), not whatever the caller happened to pass — this is
    // the wiring batch-3-spec.md's Role G part 2 asks for, so a transition's
    // visibility/requiresUser is a property of the event type itself,
    // decided in one place, rather than something every call site has to
    // get right on its own. Classified on the PERSISTED type, since that is
    // the type the policy table (and the inbox) actually keys on.
    const policy = classify(persistedEventType);

    const { inserted, sequence } = insertEvent(db, {
      projectId: ticket.projectId,
      eventType: persistedEventType,
      entityType: 'ticket',
      entityId: ticket.id,
      payload: input.payload,
      visibility: policy.visibility,
      requiresUser: policy.requiresUser,
      idempotencyKey: input.idempotencyKey,
    });

    if (!inserted) {
      // A concurrent writer inserted the same idempotency key between the
      // check above and this insert. The daemon is single-writer in
      // practice, but this keeps the guarantee exact rather than assumed.
      return { applied: false, ticket, sequence: null };
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE tickets SET status = ?, attempt_count = ?, max_attempts = ?, updated_at = ? WHERE id = ?').run(
      toStatus,
      attemptCount,
      maxAttempts,
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
  let currentMaxAttempts = maxAttempts;

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
      maxAttempts: currentMaxAttempts,
      workspaceType: 'NONE',
      workspaceRef: null,
      maxBudgetUsdOverride: null,
      model: null,
      kind: 'work',
      resultJson: null,
      createdAt: '',
      updatedAt: '',
    };
    const next = computeNextState(fakeTicket, event.eventType as ReplayableEvent, event.payload);
    status = next.toStatus;
    attemptCount = next.attemptCount;
    currentMaxAttempts = next.maxAttempts;
  }

  return { status, attemptCount };
}

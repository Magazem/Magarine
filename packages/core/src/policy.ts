import type { EventVisibility } from './types.ts';

// The notification policy: which events reach the user, and how loudly.
// Data, not conditionals, per technical-architecture-weekend-mvp.md's
// "Notification policy" table (the doc's four columns collapse onto this
// implementation's two: `visibility` and `requiresUser`).
//
//   Internal only            -> visibility: 'internal'
//   Activity (incl. collapsed) -> visibility: 'activity'
//   Inbox                    -> visibility: 'inbox', requiresUser: true
//   Push/email               -> not implemented in this batch; the doc marks
//                                every push/email row "Optional", so no row
//                                below turns it on.
//
// `classify` never throws for an unknown event type: an event type with no
// row here is a policy gap, and `policyCompletenessCheck` is what turns that
// gap into a build failure. `classify` itself stays total so a caller never
// crashes on an unexpected string; it falls back to the safe default
// (internal, no user interruption) and callers that care about gaps use the
// completeness check instead.

export interface EventPolicy {
  visibility: EventVisibility;
  requiresUser: boolean;
}

const DEFAULT_POLICY: EventPolicy = { visibility: 'internal', requiresUser: false };

// Doc-backed rows: each cites the architecture document's table row it
// implements. Where this implementation's event type doesn't literally
// appear in the doc but maps cleanly onto one of its rows, the mapping is
// noted.
const POLICY: Record<string, EventPolicy> = {
  // "Worker started" (Internal: Yes, Activity: Optional, Inbox: No, Push:
  // No). Activity is only Optional, so the silent-by-default reading keeps
  // it internal.
  run_started: { visibility: 'internal', requiresUser: false },

  // "Worker progress" (Internal: Yes, Activity: Collapsed, Inbox: No).
  worker_progress: { visibility: 'internal', requiresUser: false },

  // "Internal worker question" (Internal: Yes, Activity: Yes, Inbox: No).
  worker_question: { visibility: 'activity', requiresUser: false },

  // "Worker retry" (Internal: Yes, Activity: Yes, Inbox: No). NOTE: the doc
  // also has a separate "Retry limit exhausted" row (Inbox: Yes) but this
  // codebase's scheduler emits the *same* event type,
  // `worker_retryable_failure`, whether the ticket is retried or exhausted
  // to FAILED (the outcome is only visible in the ticket's resulting
  // status, not in the event type). `classify(eventType)` takes no other
  // context, so it cannot distinguish the two cases; this row picks the
  // more common case (an ordinary retry). See the completeness test's
  // comment and this module's file header in the delivery report for the
  // same caveat spelled out for the Orchestrator/Strategist.
  worker_retryable_failure: { visibility: 'activity', requiresUser: false },

  // "Worker completed", the no-review-needed half (Internal: No, Activity:
  // Yes, Inbox: No, since review was not needed).
  worker_done: { visibility: 'activity', requiresUser: false },

  // "Worker completed", the review-needed half (Internal: No, Activity:
  // Yes, Inbox: Yes).
  worker_needs_review: { visibility: 'inbox', requiresUser: true },

  // "User decision required" (Internal: No, Activity: Yes, Inbox: Yes).
  worker_needs_user_decision: { visibility: 'inbox', requiresUser: true },

  // "Dependency completed" (Internal: No, Activity: Yes, Inbox: No). This is
  // the event fired on the dependent ticket when its blockers are
  // satisfied, which is what the doc's row describes from the dependent's
  // point of view.
  dependencies_resolved: { visibility: 'activity', requiresUser: false },

  // Not in the doc: a ticket demoted back to OPEN because a dependency was
  // attached after the ticket had already been promoted (see
  // dependencies.ts). Purely internal bookkeeping to correct a status that
  // should never have been observed as READY; nothing for a user to act on.
  dependency_not_satisfied: { visibility: 'internal', requiresUser: false },

  // Not in the doc. Currently unused by any command (reserved for a future
  // explicit cancel). Silent by default.
  cancel: { visibility: 'internal', requiresUser: false },

  // --- Rows required ahead of Role F's stateMachine.ts landing ---
  // The architecture document does not name any of the six event types
  // below; they are new to batch 3. Per instruction, this file does not
  // invent a policy for them where the document is silent — each row below
  // either applies the document's own stated default ("The orchestrator
  // should be silent by default") or follows an explicit ruling given
  // outside the document (cited per row). All six are flagged again in the
  // delivery report for the Strategist to confirm or override.

  // Doc-silent. Default applied (internal, no user interruption). A manual
  // retry is user-initiated, so the user already knows it happened.
  manual_retry: { visibility: 'internal', requiresUser: false },

  // Doc-silent. Default applied. The user just answered the question that
  // caused `worker_needs_user_decision`'s inbox item; no second
  // notification is needed for the resolution itself.
  user_decided: { visibility: 'internal', requiresUser: false },

  // Doc-silent, and the more uncertain of the six: batch-3-spec.md §2 Role F
  // item 1 describes this same transition backing two different scenarios
  // -- an `adapter_unavailable` failure (which that spec explicitly wants
  // routed to an inbox event, since a human has to fix the adapter and run
  // `magarine resume`) and a plain SIGINT/shutdown cancellation (which
  // needs no user action at all). `classify(eventType)` cannot tell those
  // two apart from the event type alone. This row picks the middle ground
  // -- visible on `activity` so a cancellation is never silently dropped,
  // but not `inbox`/`requiresUser`, so an ordinary shutdown does not spam
  // the inbox. If the adapter-pause case needs to reach the inbox
  // specifically, it needs its own event type (e.g. `adapter_paused`)
  // rather than overloading `run_cancelled` -- flagged for the Strategist.
  run_cancelled: { visibility: 'activity', requiresUser: false },

  // Doc-silent. Default applied. Two workers colliding on the same declared
  // path in a shared DIRECTORY workspace is a real hazard, but the document
  // gives no basis for promoting it above internal visibility on its own;
  // flagged for the Strategist rather than invented.
  artifact_collision: { visibility: 'internal', requiresUser: false },

  // Not doc-silent: batch-3-spec.md §2's contract is explicit --
  // "A user decision is an event with event_type = 'user_decision', ...
  // visibility = 'activity'." Applied verbatim.
  user_decision: { visibility: 'activity', requiresUser: false },
};

export function classify(eventType: string): EventPolicy {
  return POLICY[eventType] ?? DEFAULT_POLICY;
}

// Exported so the completeness test (and any future caller) can see exactly
// which event types have an authored row, as opposed to falling through to
// `DEFAULT_POLICY`.
export function hasPolicyRow(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(POLICY, eventType);
}

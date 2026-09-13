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

  // Batch 4 (docs/strategy/batch-4-spec.md section 1 ruling 4) replaces the
  // old single `worker_retryable_failure` event (which could not tell an
  // ordinary retry from an exhausted one) with a verb the scheduler asks
  // for, `worker_failure`, and two concrete outcome types that
  // stateMachine.ts actually persists and classifies:
  //
  // "Worker retry" (Internal: Yes, Activity: Yes, Inbox: No) -- the ticket
  // returned to READY with attempts remaining.
  worker_failed_retryable: { visibility: 'activity', requiresUser: false },
  // "Retry limit exhausted" (Inbox: Yes) -- the ticket landed in FAILED,
  // whether by exhaustion or because the failure was not retryable at all
  // (e.g. `budget_exceeded`). Now a real, distinct event type, so this row
  // is no longer a compromise between two cases the way its predecessor was.
  worker_failed_final: { visibility: 'inbox', requiresUser: true },
  // `worker_failure` itself is never the event_type actually persisted --
  // stateMachine.ts's `recordTicketTransition` always classifies the
  // concrete outcome type above instead (see its comment). This row exists
  // purely because `worker_failure` remains a member of stateMachine.ts's
  // `TransitionEvent` union (it is the verb scheduler.ts asks for), and
  // policy.test.ts's completeness check parses that union verbatim and
  // demands a row for every member. Picks the more common case (an ordinary
  // retry), same convention its predecessor used for the same reason.
  worker_failure: { visibility: 'activity', requiresUser: false },

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

  // --- Rows added ahead of Role F's stateMachine.ts landing, part 1 ---
  // The architecture document does not name any of these event types; they
  // are new to batch 3. Per instruction, this file does not invent a policy
  // for them where the document is silent — each row below either applies
  // the document's own stated default ("The orchestrator should be silent
  // by default") or follows an explicit ruling given outside the document
  // (cited per row).

  // Doc-silent. Default applied (internal, no user interruption). A manual
  // retry is user-initiated, so the user already knows it happened.
  manual_retry: { visibility: 'internal', requiresUser: false },

  // RESOLVED in part 2, having now read Role F's landed implementation
  // (scheduler.ts's `applyWorkerEventInner`/`cancelTicketRun`): this was
  // flagged in part 1 as the most uncertain row, because the spec text
  // described `run_cancelled` as backing both an adapter-pause cancellation
  // (which needs to reach the inbox) and a plain SIGINT/shutdown
  // cancellation (which doesn't), and `classify(eventType)` can't tell
  // those apart from the event type alone. The concern doesn't apply: Role
  // F implemented the adapter-pause case as its own, separate event type,
  // `adapter_unavailable` (inbox/requiresUser, inserted directly, not a
  // ticket-status transition — see below), fired *alongside*
  // `run_cancelled` rather than instead of it. `run_cancelled` itself is
  // now purely "this run stopped, not the ticket's fault" bookkeeping in
  // every case it fires (adapter pause, a run timeout, or SIGINT/SIGTERM),
  // with no case that needs it to reach the inbox on its own. Doc-silent,
  // but kept on `activity` (not downgraded to internal) to match what
  // scheduler.ts already does today and because "a run was cancelled and
  // why" is meaningful history for the activity log, not pure bookkeeping
  // noise.
  run_cancelled: { visibility: 'activity', requiresUser: false },

  // Doc-silent. Default applied. Two workers colliding on the same declared
  // path in a shared DIRECTORY workspace is a real hazard, but the document
  // gives no basis for promoting it above internal visibility on its own;
  // flagged for the Strategist rather than invented.
  artifact_collision: { visibility: 'internal', requiresUser: false },

  // Not doc-silent: batch-3-spec.md §2's contract is explicit --
  // "A user decision is an event with event_type = 'user_decision', ...
  // visibility = 'activity'." Applied verbatim. Note this is also the
  // *transition* event (BLOCKED -> READY): Role F named the transition
  // itself `user_decision` rather than a separate `user_decided` verb, so
  // there is only one event type here, not two (an earlier draft of this
  // file had a now-removed `user_decided` row for an event type that was
  // never real).
  user_decision: { visibility: 'activity', requiresUser: false },

  // --- Documentation-only rows: not TransitionEvent members ---
  // These two are new to batch 3 and are real event types the daemon
  // emits, but neither goes through `recordTicketTransition` (neither one
  // changes `tickets.status`), so neither is in `stateMachine.ts`'s
  // `TransitionEvent` union and neither is exercised by the completeness
  // test below, or by the `classify` wiring in stateMachine.ts's write
  // site. scheduler.ts (Role F's file, not this role's to edit) currently
  // hardcodes these same values directly at its own `insertEvent` call
  // sites rather than calling `classify`. Recorded here anyway so the
  // notification policy has one authoritative table instead of two, and so
  // a future move of these call sites onto `classify` has something to
  // match against.
  //
  // "Permission/credential required" (Internal: No, Activity: Yes, Inbox:
  // Yes). Fired when a worker reports it can't authenticate; pauses the
  // project's adapter until `magarine resume`.
  adapter_unavailable: { visibility: 'inbox', requiresUser: true },
  // Not in the doc. A ticket's workspace couldn't be prepared (e.g.
  // DIRECTORY with no project workspace root configured) — a
  // misconfiguration only the user can fix, so it needs to reach them the
  // same way `adapter_unavailable` does, not silently stall the ticket.
  workspace_preparation_failed: { visibility: 'inbox', requiresUser: true },

  // --- Batch 4: review flow and project spend cap ---
  // docs/strategy/batch-4-spec.md section 2's cross-role contract. Not in
  // the architecture document (review approval didn't exist yet); doc-silent
  // default judgement, matching the treatment `worker_done`/
  // `worker_failed_retryable` get: the ticket moved on, nothing needs a
  // user's attention beyond what's already visible on the board.
  review_approved: { visibility: 'activity', requiresUser: false },
  // The non-exhausted case only -- exhaustion is persisted as
  // `worker_failed_final` instead (see stateMachine.ts) and already has its
  // own inbox row above.
  review_rejected: { visibility: 'activity', requiresUser: false },
  // `project_resume` clears a project's pause (whatever its cause) and is
  // never a ticket-status transition, so it is not a `TransitionEvent`
  // member and this row is not exercised by the completeness test -- same
  // shape as `adapter_unavailable`/`workspace_preparation_failed` above.
  // Real and used: store.ts's `resumeProject` classifies through this row.
  // User-initiated, so silent by default (activity, not inbox), matching
  // `manual_retry`'s reasoning.
  project_resume: { visibility: 'activity', requiresUser: false },
  // Documentation-only, same shape as `adapter_unavailable`: fired by
  // scheduler.ts directly (entityType 'project', not 'ticket') when a
  // project's spend cap would be exceeded by the next spawn. The daemon
  // refused to spawn and paused the project, so this needs the owner's
  // attention the same way an adapter pause does.
  project_spend_cap_reached: { visibility: 'inbox', requiresUser: true },

  // --- Batch 5: the supervisor must survive its own decisions ---
  // docs/strategy/batch-5-spec.md section 1 ruling 1's three guards. Neither
  // goes through recordTicketTransition (neither changes tickets.status),
  // so neither is a TransitionEvent member and neither is exercised by the
  // completeness test below -- same shape as adapter_unavailable /
  // workspace_preparation_failed above. Pure internal diagnostics: a worker
  // or an adapter produced a second terminal event, or a transition threw,
  // and the daemon recorded it and kept going rather than dying. Nothing
  // here is actionable by a user.
  late_worker_event: { visibility: 'internal', requiresUser: false },
  scheduler_error: { visibility: 'internal', requiresUser: false },

  // --- Batch 6: per-model pricing ---
  // docs/strategy/batch-6-spec.md section 1 ruling 1: an unrecognized model
  // prices at the most-expensive-known rate rather than crashing or
  // guessing low, because over-estimating stops work early and visibly
  // while under-estimating lets real spend past the ceiling silently. That
  // pricing choice needs to reach the user, same reasoning as
  // `adapter_unavailable` -- fired by scheduler.ts (entityType 'run') from
  // the adapter's progress events, one row per run. Not a TransitionEvent
  // member (it never changes tickets.status), so not exercised by the
  // completeness test below.
  unknown_model_rate: { visibility: 'inbox', requiresUser: true },
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

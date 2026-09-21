import type { RunStatus, TicketStatus } from './types.ts';

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

// Batch 12 (Role S): three instances of the same bug in two batches --
// adapter_unavailable, manager_daily_cap_reached, workspace_preparation_failed --
// were each an event recorded with `visibility: 'inbox'` that
// commands/inbox.ts's `buildInbox` had no rule to ever display. Adding a
// fourth row and a fourth test each time was fixing instances, not the
// class. The fix: an inbox row's RESOLUTION -- what has to become true for
// the item to stop showing -- is now part of its policy, not a separate
// hand-maintained table (commands/inbox.ts used to keep its own such table,
// now deleted). `buildInbox` reads `resolvesWhen` directly, so an inbox row
// authored without one is a gap `buildInbox` itself cannot silently paper
// over.
//
// `ticketLeaves`: pending while the ticket named by the event's own
// entityId sits in exactly this status; resolved the moment it's anything
// else. `runLeaves`: same idea, keyed to a run's own status, for an event
// scoped to entityType 'run' rather than 'ticket'. `projectResumed`:
// pending while the project the event belongs to is still paused (either
// cause) -- see commands/inbox.ts's `describeProjectPause`, which collapses
// every pause-causing event into the ONE currently-active pause rather than
// showing one item per historical firing.
export type ResolvesWhen = { ticketLeaves: TicketStatus } | { runLeaves: RunStatus } | { projectResumed: true };

// A discriminated union, not one shape with an optional field: an
// `inbox`-visibility row that omits `resolvesWhen` fails to typecheck at
// the row's own definition site. That alone has no teeth in this repo --
// there is no `tsc` step in `pnpm test`, only `node`'s own type-stripping,
// which checks nothing -- so the loop below, right after POLICY, re-asserts
// the same rule at runtime, at module load, the moment this file is
// imported by anything. Every test file imports it transitively, so an
// inbox row missing its resolution rule fails the entire suite immediately,
// not on whatever test happens to exercise that one event type.
export type EventPolicy =
  | { visibility: 'inbox'; requiresUser: true; resolvesWhen: ResolvesWhen }
  | { visibility: 'activity'; requiresUser: false }
  | { visibility: 'internal'; requiresUser: false };

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
  worker_failed_final: { visibility: 'inbox', requiresUser: true, resolvesWhen: { ticketLeaves: 'FAILED' } },
  // `worker_failure` itself is never the event_type actually persisted --
  // stateMachine.ts's `recordTicketTransition` always classifies the
  // concrete outcome type above instead (see its comment). This row exists
  // purely because `worker_failure` remains a member of stateMachine.ts's
  // `TransitionEvent` union (it is the verb scheduler.ts asks for), and
  // policy.test.ts's completeness check parses that union verbatim and
  // demands a row for every member. Picks the more common case (an ordinary
  // retry), same convention its predecessor used for the same reason.
  worker_failure: { visibility: 'activity', requiresUser: false },

  // Batch 7 (Role L): same shape as `worker_failure` above -- the verb
  // stateMachine.ts's `TransitionEvent` union carries so the completeness
  // check demands a row, but the concrete type actually persisted is always
  // `worker_failed_final` (see stateMachine.ts's 'worker_budget_stop' case).
  // Unlike `worker_failure`, this verb has only one possible destination
  // (a worker's own budget self-stop is never retryable), so this row is not
  // a "pick the more common case" compromise -- it is the exact answer.
  worker_budget_stop: { visibility: 'inbox', requiresUser: true, resolvesWhen: { ticketLeaves: 'FAILED' } },

  // "Worker completed", the no-review-needed half (Internal: No, Activity:
  // Yes, Inbox: No, since review was not needed).
  worker_done: { visibility: 'activity', requiresUser: false },

  // "Worker completed", the review-needed half (Internal: No, Activity:
  // Yes, Inbox: Yes).
  worker_needs_review: { visibility: 'inbox', requiresUser: true, resolvesWhen: { ticketLeaves: 'REVIEW' } },
  // Batch 18 ruling 31: a worker's `done` on a work ticket, on its way to the
  // verifier. Activity only -- the owner is asked nothing while a second run is
  // checking the work; the verdict (review_approved / review_rejected) follows.
  worker_done_for_verification: { visibility: 'activity', requiresUser: false },

  // "User decision required" (Internal: No, Activity: Yes, Inbox: Yes).
  worker_needs_user_decision: { visibility: 'inbox', requiresUser: true, resolvesWhen: { ticketLeaves: 'BLOCKED' } },

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

  // Not in the doc. Batch 8: this row was "reserved for a future explicit
  // cancel" through batch 7; that future is `cancel --ticket` /
  // `POST /tickets/{id}/cancel`. The Strategist's ruling is explicit: "the
  // activity log records the cancel; no inbox item, because the owner did
  // it themselves" -- activity, not internal (a person acting on their own
  // command already knows it happened, so it's not silent bookkeeping the
  // way `manual_retry` below is), and not inbox (nothing for them to be
  // notified about).
  cancel: { visibility: 'activity', requiresUser: false },

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
  adapter_unavailable: { visibility: 'inbox', requiresUser: true, resolvesWhen: { projectResumed: true } },
  // Not in the doc. A ticket's workspace couldn't be prepared (e.g.
  // DIRECTORY with no project workspace root configured) — a
  // misconfiguration only the user can fix, so it needs to reach them the
  // same way `adapter_unavailable` does, not silently stall the ticket.
  workspace_preparation_failed: { visibility: 'inbox', requiresUser: true, resolvesWhen: { ticketLeaves: 'READY' } },

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
  project_spend_cap_reached: { visibility: 'inbox', requiresUser: true, resolvesWhen: { projectResumed: true } },
  // Batch 16 (rulings 24 and 29): the scheduler paused a project because it is
  // not ready to run a worker (no directory, unsafe directory, no scope path,
  // unreadable scope file). Same shape as project_spend_cap_reached: the pause
  // itself is what the inbox shows (describeProjectPause), and this event
  // carries the payload -- for an unreadable scope file, the real error --
  // that the pause line names. Resolved by resuming the project.
  project_not_ready: { visibility: 'inbox', requiresUser: true, resolvesWhen: { projectResumed: true } },

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
  //
  // Batch 12 finding, ruled by the Orchestrator/Strategist: this was the
  // FOURTH instance of the invisible-inbox class, and the worst one --
  // unlike the other three, it was never reachable by anyone, because
  // `commands/inbox.ts`'s old `buildInbox` only ever looked at entityType
  // 'ticket'. Worse, no `resolvesWhen` for it could ever have worked:
  // scheduler.ts calls `raiseUnknownModelRateIfFlagged` before the run/ticket
  // goes terminal in the SAME function, on all three call sites, so a
  // status-based resolution condition is already false by the time anyone
  // could poll the inbox for it. It also names no next command and asks for
  // no owner decision -- a heads-up that a run priced at the conservative
  // fallback rate, nothing to decide. Ruling: `visibility: 'activity'`. It
  // was already fully visible via `activity --project <id>` (that filter
  // only drops `internal`), so nothing becomes less visible; it stops being
  // an inbox row that can never resolve. Binding corollary from this
  // finding: an event that cannot name a next command is not an inbox item,
  // by definition -- see inboxCompleteness.test.ts, which now enforces that
  // for every row, not just this one. The fact still needs to reach the
  // owner where they are actually looking: a run priced at this fallback
  // rate shows a marker next to its cost on the board and the page,
  // sourced from the run's own `usage_json.model` via `pricing.ts`'s
  // `isKnownModel` (see commands/board.ts / commands/page.ts), deliberately
  // uncoupled from this event.
  unknown_model_rate: { visibility: 'activity', requiresUser: false },

  // --- Batch 9: the Manager invocation ---
  // Fired by managerApply.ts once a valid proposal has been applied,
  // carrying the full proposal and the created-ticket id mapping (entityType
  // 'ticket', entityId the manager ticket -- see that file's doc comment on
  // why replay needs the ids, not just the titles). Not a TransitionEvent
  // member (it never changes tickets.status on its own -- the manager
  // ticket's own worker_done/worker_needs_user_decision transition is a
  // separate event in the same transaction), so not exercised by the
  // completeness test below, same shape as project_resume/adapter_unavailable
  // above. Activity, not inbox: the board itself now shows every ticket this
  // created, same reasoning as worker_done/review_approved -- nothing here
  // needs a person's attention beyond what is already visible.
  manager_proposal_applied: { visibility: 'activity', requiresUser: false },

  // --- Batch 11: the Manager learns to be interviewed ---
  // Not a TransitionEvent member (entityType 'project', never changes
  // tickets.status), so not exercised by the completeness test below --
  // same shape as project_resume/discuss's own sibling rows above. The
  // owner's own message, recorded by manager.ts's discussProject --
  // user-initiated, so silent by default, same reasoning as
  // manual_retry/user_decision/cancel: the owner already knows they said it.
  discuss: { visibility: 'activity', requiresUser: false },
  // The Manager's own `update_scope` command, applied by managerApply.ts.
  // Not user-initiated in the same direct sense as `discuss`, but it is the
  // OWNER'S plan taking effect (a proposal they asked for or are reviewing),
  // and the board/page already show the resulting file -- same "nothing
  // here needs a person's attention beyond what's already visible" reasoning
  // as manager_proposal_applied/worker_done above, not an inbox item.
  scope_updated: { visibility: 'activity', requiresUser: false },
  // Batch 11 item 3: the per-project daily Manager-invocation cap
  // (manager.ts's isManagerDailyCapReached), raised by scheduler.ts's
  // tick() spawn-time gate for a READY manager ticket it will not start
  // this cycle. Inbox per the spec ("with an inbox item when reached"),
  // matching project_spend_cap_reached's own treatment. Ticket-scoped, and
  // was ONE OF THE THREE original instances of the invisible-inbox class
  // (see this file's header comment): recorded with inbox visibility here,
  // but with no resolution rule anywhere for commands/inbox.ts's buildInbox
  // to surface it by. Fixed now by the `resolvesWhen` row itself.
  manager_daily_cap_reached: { visibility: 'inbox', requiresUser: true, resolvesWhen: { ticketLeaves: 'READY' } },
};

// The runtime half of "adding an inbox event without its resolution rule
// is a type error at the definition site" -- the TS discriminated union
// above IS that type error for an editor or a `tsc` run, but this repo's
// `pnpm test` never runs one (`node`'s native TS support strips types, it
// does not check them), so nothing would actually stop a row like
// `{ visibility: 'inbox', requiresUser: true }` with no `resolvesWhen` from
// running. This runs at module load -- every test file imports policy.ts
// transitively -- so that exact gap crashes the whole suite immediately,
// on import, rather than surfacing as a silently-invisible inbox item
// discovered later by a person hitting it (the bug this batch exists to
// close structurally). See policy.test.ts's mutation check: removing an
// inbox row's `resolvesWhen` must fail here, not pass quietly.
for (const [eventType, policy] of Object.entries(POLICY)) {
  if (policy.visibility === 'inbox' && !('resolvesWhen' in policy)) {
    throw new Error(`policy.ts: inbox row "${eventType}" has no resolvesWhen -- every inbox event must say how it resolves`);
  }
}

export function classify(eventType: string): EventPolicy {
  return POLICY[eventType] ?? DEFAULT_POLICY;
}

// Exported so the completeness test (and any future caller) can see exactly
// which event types have an authored row, as opposed to falling through to
// `DEFAULT_POLICY`.
export function hasPolicyRow(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(POLICY, eventType);
}

// Batch 12: drives commands/inboxCompleteness.test.ts's own completeness
// check -- every event type this returns must have a scenario in that
// file's scenario map, so a new inbox row added later without one fails
// that test immediately, the same way a missing `resolvesWhen` fails at
// import time above. Reads POLICY directly rather than a hand-copied list,
// for the same reason policy.test.ts parses TransitionEvent from source
// instead of hand-copying it: a list a person has to remember to update in
// two places is the exact failure mode this batch exists to close.
export function inboxEventTypes(): string[] {
  return Object.entries(POLICY)
    .filter(([, policy]) => policy.visibility === 'inbox')
    .map(([eventType]) => eventType);
}

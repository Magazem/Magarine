import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Db } from './db/index.ts';
import { isReady, resolveReadiness } from './dependencies.ts';
import { maybeCreateAutomaticManagerTurn } from './autoManager.ts';
import { beginVerifyRun, startVerification } from './verifier.ts';
import { isManagerDailyCapReached, MANAGER_DAILY_CAP_DEFAULT } from './manager.ts';
import { classifyProgressMessage, parseProgressTool, type ActivityState } from './commands/activity.ts';
import { applyManagerProposal } from './managerApply.ts';
import { buildManagerEnvelope } from './managerEnvelope.ts';
import { classify } from './policy.ts';
import { artifactContent, validateWorkerResult } from './resultContract.ts';
import { recordTicketTransition } from './stateMachine.ts';
// Aliased: this file already has its own private `resolveArtifactPath`
// (below, `join`-only, used by capture -- a different, pre-existing
// concern this ruling does not touch). This import is the shared rule
// ruling 21 requires for the expected-artefact comparison, matching
// claudeCli.ts's `verifyArtifacts` exactly (`resolve`, not `join` --
// normalises `.`/`..` segments too).
import { prepareWorkspace, resolveDeclaredArtifactPath } from './workspace.ts';
import {
  createArtifact,
  createRun,
  finishRun,
  findConflictingArtifact,
  getDependencies,
  getProject,
  getRun,
  getTicket,
  insertEvent,
  isProjectAdapterPaused,
  listArtifactsForTicket,
  listEventsForEntity,
  listEventsForProject,
  listTicketsByStatus,
  MIN_BUDGET_USD,
  pauseProjectAdapter,
  projectSpendUsd,
  resolveMaxBudgetUsd,
  resolveModel,
  setRunUsage,
  setRunWorkerSessionRef,
} from './store.ts';
import { assertReadinessMode, projectReadiness, type ReadinessMode } from './readiness.ts';
import type {
  AgentAdapter,
  Project,
  Run,
  Ticket,
  TicketEnvelope,
  TicketEnvelopeArtifact,
  WorkerEvent,
  WorkerHandle,
  WorkerResultArtifact,
  WorkspaceType,
} from './types.ts';

export interface SchedulerDeps {
  db: Db;
  adapter: AgentAdapter;
  maxParallelWorkers: number;
  projectId: string;
  /** Wall-clock cap per run, enforced by the scheduler itself (adapter-agnostic, unlike an adapter's own process timeout). Undefined means no cap. */
  runTimeoutMs?: number;
  /** Where NONE-mode runs' verified artifacts are captured before their temp workspace is deleted. Defaults to `<cwd>/.magarine/artifacts`. */
  artifactsDir?: string;
  /** REQUIRED (batch 16 ruling 24, Strategist's ruling): `{ stateDir }` runs the readiness check before any run starts; `'skip'` is the explicit opt-out for a caller that is not asking the question. `tick` throws if it is absent. See readiness.ts's `ReadinessMode`. */
  readiness: ReadinessMode;
  /** Passed straight through to `prepareWorkspace`'s `baseDir` for NONE-mode runs. Test-only; production default (the OS temp directory) is unchanged. See workspace.ts's WorkspaceOptions.baseDir. */
  workspaceBaseDir?: string;
}

export interface StartedRun {
  ticketId: string;
  runId: string;
  handle: WorkerHandle;
  done: Promise<void>;
}

/**
 * Batch 18 ruling 31: starts the verifier for a REVIEW work ticket, unless one
 * is already running for it (beginVerifyRun's synchronous claim is the dedupe
 * between the worker's inline chaining and tick's scan). The returned
 * StartedRun's `done` settles when the verdict has been applied or discarded.
 */
async function verifyReviewTicket(deps: SchedulerDeps, ticketId: string): Promise<StartedRun | undefined> {
  const run = beginVerifyRun(deps.db, deps.adapter.id, ticketId);
  if (!run) return undefined;
  const started = await startVerification(
    { db: deps.db, adapter: deps.adapter, runTimeoutMs: deps.runTimeoutMs, workspaceBaseDir: deps.workspaceBaseDir },
    ticketId,
    run
  );
  return started ? { ticketId, runId: run.id, handle: started.handle, done: started.done } : undefined;
}

export interface TickResult {
  started: StartedRun[];
}

// Where a dependency's file artifact appears inside a NONE-mode dependent's
// own workspace. Used both when building the envelope text (so the prompt
// describes a real path) and when actually copying the file there before
// the worker starts — the two must agree, since the worker mode has no
// visibility into anything but its own workspace.
function dependencyInputRelativePath(dependsOnTicketId: string, sourcePathOrUri: string): string {
  return join('.orchestrator', 'inputs', dependsOnTicketId, basename(sourcePathOrUri));
}

// Batch 18 ruling 32: the ticket's most recent `review_rejected` or worker
// failure, as what a retried worker is told. Only a ticket that has consumed an
// attempt has one -- a first attempt must see nothing of a previous one.
function previousAttemptFor(db: Db, ticket: Ticket): TicketEnvelope['previousAttempt'] {
  if (ticket.attemptCount === 0) return undefined;
  const last = listEventsForEntity(db, 'ticket', ticket.id)
    .filter((e) => e.eventType === 'review_rejected' || e.eventType === 'worker_failed_retryable' || e.eventType === 'worker_failed_final')
    .at(-1);
  if (!last) return undefined;
  const p = (last.payload && typeof last.payload === 'object' ? last.payload : {}) as Record<string, unknown>;
  const errors = Array.isArray(p.errors) ? p.errors.filter((x): x is string => typeof x === 'string').join('; ') : '';
  const reason =
    typeof p.reason === 'string' && p.reason.length > 0 ? p.reason : typeof p.message === 'string' && p.message.length > 0 ? p.message : errors;
  if (reason.length === 0) return undefined;
  return { status: last.eventType === 'review_rejected' ? 'rejected' : 'failed', reason };
}

function buildEnvelope(db: Db, ticket: Ticket, project: Project): TicketEnvelope {
  const completedDependencies = getDependencies(db, ticket.id)
    .filter((d) => d.dependencyType === 'blocks')
    .map((d) => {
      const dep = getTicket(db, d.dependsOnTicketId);

      const doneEvents = listEventsForEntity(db, 'ticket', d.dependsOnTicketId).filter(
        (e) => e.eventType === 'worker_done' || e.eventType === 'worker_done_for_verification'
      );
      const lastDone = doneEvents[doneEvents.length - 1];
      const summary =
        lastDone && typeof lastDone.payload === 'object' && lastDone.payload !== null
          ? ((lastDone.payload as Record<string, unknown>).summary as string | undefined)
          : undefined;

      const artifacts: TicketEnvelopeArtifact[] = listArtifactsForTicket(db, d.dependsOnTicketId).map((a) => ({
        kind: a.kind,
        content:
          a.kind === 'file' && ticket.workspaceType === 'NONE'
            ? dependencyInputRelativePath(d.dependsOnTicketId, a.pathOrUri)
            : a.kind === 'file'
              ? a.pathOrUri
              : (a.text ?? ''),
      }));

      return { ticketId: d.dependsOnTicketId, title: dep?.title ?? '', summary, artifacts };
    });

  const relevantDecisions = listEventsForProject(db, ticket.projectId)
    .filter((e) => e.eventType === 'user_decision')
    .map((e) => {
      const p = e.payload as { question?: string; answer?: string };
      return `Q: ${p.question ?? ''} — A: ${p.answer ?? ''}`;
    });

  return {
    ticketId: ticket.id,
    projectBrief: project.brief ?? '',
    relevantDecisions,
    title: ticket.title,
    description: ticket.description ?? '',
    acceptanceCriteria: ticket.acceptanceCriteria,
    completedDependencies,
    allowedTools: [],
    expectedOutputFormat: 'Write .orchestrator/result.json matching the WorkerResult schema.',
    maxBudgetUsd: resolveMaxBudgetUsd(project, ticket),
    model: resolveModel(project, ticket),
    // Batch 15 item 4: absent (not an empty array) when the ticket carries
    // no such list at all -- see envelope.ts's buildWorkerPrompt for why
    // that distinction, not just "empty vs non-empty," is what decides
    // whether a section is rendered.
    ...(ticket.expectedArtifacts != null ? { expectedArtifacts: ticket.expectedArtifacts } : {}),
    ...(previousAttemptFor(db, ticket) ? { previousAttempt: previousAttemptFor(db, ticket) } : {}),
  };
}

// Before starting a NONE-mode ticket, copy each completed dependency's
// declared file artifacts into this run's own workspace, since a NONE
// workspace is a private temp directory the dependency never wrote into.
// DIRECTORY-mode tickets need no copy: every ticket in the project already
// shares the same directory (see workspace.ts's corrected ruling).
function copyNoneDependencyInputs(db: Db, ticket: Ticket, workspacePath: string): void {
  const deps = getDependencies(db, ticket.id).filter((d) => d.dependencyType === 'blocks');
  for (const dep of deps) {
    const fileArtifacts = listArtifactsForTicket(db, dep.dependsOnTicketId).filter((a) => a.kind === 'file');
    for (const artifact of fileArtifacts) {
      const dest = join(workspacePath, dependencyInputRelativePath(dep.dependsOnTicketId, artifact.pathOrUri));
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(artifact.pathOrUri, dest);
      } catch {
        // The daemon's own captured copy no longer exists on disk; nothing
        // to hand the dependent. Not fatal — the worker will simply not
        // find the file, same as if the dependency never produced one.
      }
    }
  }
}

function resolveArtifactPath(pathOrUri: string, workspacePath: string): string {
  return isAbsolute(pathOrUri) ? pathOrUri : join(workspacePath, pathOrUri);
}

function checksumFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

// DIRECTORY mode: artifacts already live in the project's one shared
// directory, so nothing is copied — just verified (best-effort checksum)
// and recorded. Two concurrent runs that declare the same path raise an
// `artifact_collision` activity event (accepted, not prevented, per
// batch-3-spec.md section 1's ruling).
function captureDirectoryArtifacts(
  db: Db,
  ticket: Ticket,
  run: Run,
  workspacePath: string,
  declared: WorkerResultArtifact[]
): void {
  for (const artifact of declared) {
    if (artifact.kind !== 'file') {
      createArtifact(db, {
        ticketId: ticket.id,
        runId: run.id,
        projectId: ticket.projectId,
        kind: artifact.kind,
        text: artifactContent(artifact),
      });
      continue;
    }

    const resolved = resolveArtifactPath(artifact.path, workspacePath);
    const conflict = findConflictingArtifact(db, ticket.projectId, resolved, ticket.id);
    if (conflict) {
      insertEvent(db, {
        projectId: ticket.projectId,
        eventType: 'artifact_collision',
        entityType: 'ticket',
        entityId: ticket.id,
        payload: { path: resolved, conflictingTicketId: conflict.ticketId, conflictingRunId: conflict.runId },
        visibility: 'activity',
        idempotencyKey: `artifact_collision:${run.id}:${resolved}`,
      });
    }

    createArtifact(db, {
      ticketId: ticket.id,
      runId: run.id,
      projectId: ticket.projectId,
      kind: 'file',
      pathOrUri: resolved,
      checksum: checksumFile(resolved),
    });
  }
}

// NONE mode: the workspace is a temp directory about to be deleted, so a
// file artifact is copied into `<artifactsDir>/<runId>/...` — a location
// the daemon owns for as long as the row in `artifacts` exists — before
// that happens.
function captureNoneModeArtifacts(
  db: Db,
  ticket: Ticket,
  run: Run,
  workspacePath: string,
  artifactsDir: string,
  declared: WorkerResultArtifact[]
): void {
  for (const artifact of declared) {
    if (artifact.kind !== 'file') {
      createArtifact(db, {
        ticketId: ticket.id,
        runId: run.id,
        projectId: ticket.projectId,
        kind: artifact.kind,
        text: artifactContent(artifact),
      });
      continue;
    }

    const source = resolveArtifactPath(artifact.path, workspacePath);
    const dest = join(artifactsDir, run.id, artifact.path);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    } catch {
      continue; // Declared but never actually written; nothing durable to keep.
    }

    createArtifact(db, {
      ticketId: ticket.id,
      runId: run.id,
      projectId: ticket.projectId,
      kind: 'file',
      pathOrUri: dest,
      checksum: checksumFile(dest),
    });
  }
}

function captureArtifacts(
  db: Db,
  ticket: Ticket,
  run: Run,
  workspaceType: WorkspaceType,
  workspacePath: string,
  artifactsDir: string,
  declared: WorkerResultArtifact[]
): void {
  if (declared.length === 0) return;
  if (workspaceType === 'DIRECTORY') {
    captureDirectoryArtifacts(db, ticket, run, workspacePath, declared);
  } else if (workspaceType === 'NONE') {
    captureNoneModeArtifacts(db, ticket, run, workspacePath, artifactsDir, declared);
  }
  // GIT_WORKTREE: not built this batch (workspace.ts refuses the mode
  // outright), so there is nothing to capture for it here.
}

// Cancels one run/ticket pair: finishes the run as 'cancelled' (only if it
// is still recorded as running, so a run that already reached a real
// terminal state is never overwritten) and applies the given ticket
// transition (only if the ticket is still IN_PROGRESS, so a ticket that
// already moved on is left alone). Two transitions share this function
// because they share every mechanical step (stop the worker, settle the
// run, reclaim a NONE workspace) but encode different intents, per the
// Strategist's batch 8 ruling:
//
// - `run_cancelled` (IN_PROGRESS -> READY, no attempt consumed) is for the
//   DAEMON's own decisions -- adapter_unavailable, a per-run timeout, or a
//   shutdown (SIGINT/SIGTERM, or the daemon's own stop()) -- where the
//   daemon has not decided the ticket is unwanted, so returning it to READY
//   for another attempt is correct.
// - `cancel` (IN_PROGRESS -> CANCELLED, also no attempt consumed) is for a
//   PERSON's decision, via the daemon's `POST /tickets/{id}/cancel`. A
//   person who cancels has decided the ticket is unwanted; landing it back
//   in READY would let the daemon's own next tick silently restart it
//   moments later -- exactly the surprise the Strategist's close-out ruling
//   exists to prevent. CANCELLED is terminal (see stateMachine.ts's
//   TRANSITIONS table): tick() only ever looks at READY tickets, so a
//   cancelled ticket simply cannot restart on its own. `retry` (its
//   `manual_retry` transition, also updated for this ruling) is the
//   explicit, one-command way back to READY.
//
// A NONE workspace is disposable temp storage, so it is reclaimed here too
// (looked up from the run's own persisted workspace_ref, not from a
// closure — cancelRun's callers never went through tick()'s per-run
// closures in the first place).
function cancelTicketRun(
  db: Db,
  ticketId: string,
  runId: string,
  failureClass: string,
  transitionEvent: 'run_cancelled' | 'cancel'
): void {
  const run = getRun(db, runId);
  if (run && run.status === 'running') {
    finishRun(db, runId, { status: 'cancelled', failureClass });
  }
  const ticket = getTicket(db, ticketId);
  if (ticket && ticket.status === 'IN_PROGRESS') {
    recordTicketTransition(db, {
      ticketId,
      event: transitionEvent,
      idempotencyKey: `${transitionEvent}:${runId}`,
      visibility: 'activity',
    });
  }
  if (ticket?.workspaceType === 'NONE' && run?.workspaceRef) {
    rmSync(run.workspaceRef, { recursive: true, force: true });
  }
}

// Exported for daemon.ts (batch 8): shutting down the daemon, and cancelling
// a ticket on a person's explicit request, both need to do exactly this --
// stop the adapter's live handle and force the run/ticket back to a settled
// DB state -- for the one worker each of those situations targets. Typed on
// the two fields it actually reads rather than the full SchedulerDeps, so a
// caller with no projectId/maxParallelWorkers of its own (the daemon ticks
// many projects, not one) doesn't have to fabricate placeholder values to
// call it. `transitionEvent` has no default: every call site must say
// explicitly which of the two intents above it means, the same way
// `requireRetryableFlag` (stateMachine.ts) refuses to default a
// retryable/non-retryable choice that would otherwise be easy to get wrong
// silently.
export async function cancelRun(
  deps: Pick<SchedulerDeps, 'db' | 'adapter'>,
  sr: { ticketId: string; runId: string; handle: WorkerHandle },
  failureClass: string,
  transitionEvent: 'run_cancelled' | 'cancel'
): Promise<void> {
  await deps.adapter.stop(sr.handle);
  cancelTicketRun(deps.db, sr.ticketId, sr.runId, failureClass, transitionEvent);
}

interface ApplyEventContext {
  questionSeq: { n: number };
  progressSeq: { n: number };
  /** Ruling 19: the activity state of this run's previous progress event, passed to classifyProgressMessage so a message that is not a phase change (a tool result, thinking, ...) keeps it. Starts at `running`: "working, no tool yet". */
  activityPhase: { state: ActivityState };
  /** Batch 5 section 1 ruling 1: counts late_worker_event rows for this run, for a deterministic idempotency key (the house pattern, per questionSeq/progressSeq -- not randomUUID, so the count is exact and inspectable). */
  lateEventSeq: { n: number };
  workspacePath: string;
  workspaceType: WorkspaceType;
  artifactsDir: string;
  workspaceCleanup: () => Promise<void>;
  /** This run's resolved ceiling (ticket override, else project default). Batch 4 item 3. */
  ceilingUsd: number;
  /** This run's resolved model (ticket override, else project default). Batch 6 item 4 ruling 2: an already-recorded estimate stays as it was, but from this batch every estimate must carry the model it was computed for. */
  model: string;
  /** Asks the adapter to stop the worker. Kept as a closure so this module never needs the adapter/handle types directly. */
  stopWorker: () => Promise<void>;
}

// Batch 5 section 1 ruling 1: "first terminal outcome wins." A run's live
// status in the store (not an in-memory flag) is the single source of
// truth for whether it already settled -- every path that settles a run
// (this module's own applyWorkerEventInner terminal branches, and
// cancelTicketRun's finishRun call for adapter_unavailable/run_timeout/
// SIGINT) writes through `finishRun`, which only succeeds while the row is
// still 'running'. Reading it fresh here, rather than threading a settled
// flag through every one of those call sites (some of which, like the
// runTimeoutMs/SIGINT paths, never see this run's `ctx` at all), is what
// makes the check total regardless of which path settled the run first.
function extractLateEventDetails(event: WorkerEvent): { failureClass?: string; usage?: unknown } {
  if (event.type === 'failure') return { failureClass: event.failureClass, usage: event.usage };
  if (event.type === 'result_raw') return { usage: event.usage };
  return {};
}

// Ruling 1 records "any later TERMINAL event" as late_worker_event -- a
// late `progress`/`question` is dropped by the settle check in
// applyWorkerEvent (below) exactly the same as a late terminal event is
// (no transition, no run-row write either way), but it never MINTS a
// late_worker_event row. This matters for real, not just for wording: the
// real adapter's killTree grace period (process.ts's DEFAULT_GRACE_MS,
// 3000ms) leaves stdout draining well after the scheduler's own
// budget-stop branch has already committed its finishRun, so a real
// budget-stopped run can see several late `progress` events before the
// killed process's own terminal event finally arrives. Recording a row for
// every one of those would turn the Orchestrator's own pass condition ("one
// late_worker_event") into "several," for no diagnostic value -- a late
// progress message carries nothing (no usage field exists on that event
// type) worth losing by not recording it.
function isLateEventWorthRecording(event: WorkerEvent): boolean {
  return event.type === 'failure' || event.type === 'result_raw';
}

function recordLateWorkerEvent(db: Db, ticket: Ticket, run: Run, event: WorkerEvent, ctx: ApplyEventContext): void {
  if (!isLateEventWorthRecording(event)) return;

  const { failureClass, usage } = extractLateEventDetails(event);
  ctx.lateEventSeq.n += 1;
  const policy = classify('late_worker_event');
  insertEvent(db, {
    projectId: ticket.projectId,
    eventType: 'late_worker_event',
    entityType: 'run',
    entityId: run.id,
    payload: { eventType: event.type, failureClass, usage },
    visibility: policy.visibility,
    requiresUser: policy.requiresUser,
    idempotencyKey: `late_worker_event:${run.id}:${ctx.lateEventSeq.n}`,
  });

  // "Cost must never be lost": the settled run row keeps its own first
  // outcome, but if it recorded no usage at all, a late event's usage is
  // merged in rather than discarded.
  if (usage !== undefined) {
    const current = getRun(db, run.id);
    if (current && current.usageJson == null) {
      setRunUsage(db, run.id, usage);
    }
  }
}

// Applies one WorkerEvent for a single run and, if it was terminal, cleans
// up a NONE-mode workspace exactly once regardless of which branch below
// produced the terminal result — a disposable temp workspace must not
// survive a failure or a malformed result any more than it survives a
// success. (An earlier version of this function called workspaceCleanup()
// only at the end of the 'done' path, which silently leaked a temp
// directory per malformed result or per ordinary retryable/non-retryable
// failure; caught by scanning the OS temp dir for magarine-run-* leftovers
// after a full scheduler.test.ts run, not by any single test's own
// assertions.) Returns true when the event was terminal (result_raw or
// failure), which is the caller's cue to resolve the run's `done` promise —
// progress/question return false and the run continues.
async function applyWorkerEvent(db: Db, ticket: Ticket, run: Run, event: WorkerEvent, ctx: ApplyEventContext): Promise<boolean> {
  // Batch 5 guard 1: read this run's live status before doing anything
  // else. If it is no longer 'running', some path already settled it (the
  // scheduler's own stop-initiated failure, a cancellation, or an earlier
  // call to this very function for the same run) and this event arrived
  // after the fact -- e.g. the real (or, per the fidelity rule, fake)
  // adapter's own post-stop publish racing the scheduler's own accounting.
  // Recorded, never applied: no transition, no run-row write.
  const currentRun = getRun(db, run.id);
  if (!currentRun || currentRun.status !== 'running') {
    recordLateWorkerEvent(db, ticket, run, event, ctx);
    return false;
  }

  const terminal = await applyWorkerEventInner(db, ticket, run, event, ctx);
  if (terminal && ctx.workspaceType === 'NONE') {
    await ctx.workspaceCleanup();
  }
  return terminal;
}

// Batch 6 item 4: shared by every WorkerEvent variant that can carry
// `unknownModel` -- `progress` (mid-run, per pricing.ts's per-message
// fallback) and `result_raw`/`failure` (a completed run whose terminal
// `result` line's `modelUsage` names an unrecognized model, so an
// unpinned/unrecognized model doesn't go silent just because the run
// finished instead of getting stopped mid-flight). One row per run: the
// idempotency key has no counter, so a run flagged from both a mid-run
// progress event AND its own terminal event still inserts exactly once.
function raiseUnknownModelRateIfFlagged(db: Db, ticket: Ticket, run: Run, unknownModel: string | undefined): void {
  if (!unknownModel) return;
  const policy = classify('unknown_model_rate');
  insertEvent(db, {
    projectId: ticket.projectId,
    eventType: 'unknown_model_rate',
    entityType: 'run',
    entityId: run.id,
    payload: { model: unknownModel },
    visibility: policy.visibility,
    requiresUser: policy.requiresUser,
    idempotencyKey: `unknown_model_rate:${run.id}`,
  });
}

// Batch 9: the post-success step for a manager ticket reporting "done" --
// read its proposal.json (still on disk: this runs before this run's
// workspace is cleaned up, see applyWorkerEvent), validate and apply it in
// one transaction (managerApply.ts), and settle the run/ticket from the
// outcome. A read failure (missing file, invalid JSON) becomes `undefined`,
// which `validateProposal` (called inside applyManagerProposal) rejects the
// same way it rejects any other malformed shape -- one code path for "the
// file was never written" and "the file was written but is garbage", not
// two.
function applyManagerTicketDone(db: Db, ticket: Ticket, run: Run, ctx: ApplyEventContext): void {
  const project = getProject(db, ticket.projectId)!;
  let proposalRaw: unknown;
  try {
    proposalRaw = JSON.parse(readFileSync(join(ctx.workspacePath, '.orchestrator', 'proposal.json'), 'utf8'));
  } catch {
    proposalRaw = undefined;
  }

  const result = applyManagerProposal(db, ticket, project, run.id, proposalRaw);

  if (result.outcome === 'malformed') {
    // Same shape as an ordinary malformed WorkerResult (this function's own
    // caller, a few lines up): retryable, reaching the inbox on exhaustion
    // with the validation errors attached (batch-9-spec.md section 2: "one
    // invalid command rejects the entire proposal as a malformed result,
    // which is retryable and reaches the inbox on exhaustion with the
    // validation errors"). `message` (not just the structured `errors`
    // array) is what commands/inbox.ts's `reasonFor` actually reads to
    // build the inbox line -- without it, an exhausted proposal reaches the
    // inbox as the uninformative "failed: malformed_proposal", the errors
    // present in the payload but never surfaced to the one place a person
    // would see them.
    finishRun(db, run.id, { status: 'failed', failureClass: 'malformed_proposal' });
    recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'worker_failure',
      idempotencyKey: `worker_failure:${run.id}`,
      payload: { message: result.errors.join('; '), errors: result.errors, retryable: true, failureClass: 'malformed_proposal' },
    });
    return;
  }

  finishRun(db, run.id, { status: result.ticketStatus === 'BLOCKED' ? 'blocked' : 'succeeded' });
  // No resolveReadiness call here, unlike the ordinary 'done' branch:
  // managerApply.ts already ran it once, inside the SAME transaction that
  // created the new tickets and dependency edges, before deciding DONE vs
  // BLOCKED -- a second call out here would be redundant (idempotent, but
  // pointless) rather than newly correct.
}

// This is the only place that turns an adapter event into a ticket
// transition; it always goes through `recordTicketTransition`, never writes
// status itself. Non-transition bookkeeping events (worker_progress,
// artifact_collision, adapter_unavailable's inbox notice) go through
// `insertEvent` directly, since they never change `tickets.status`.
async function applyWorkerEventInner(
  db: Db,
  ticket: Ticket,
  run: Run,
  event: WorkerEvent,
  ctx: ApplyEventContext
): Promise<boolean> {
  switch (event.type) {
    case 'progress': {
      // Batch 6 item 3: pricing.ts prices an unrecognized model at the
      // most-expensive-known rate rather than crashing or guessing low
      // (docs/strategy/batch-6-spec.md section 1 ruling 1 -- over-estimating
      // stops work early and visibly, which is the point). That pricing
      // choice is silent on its own, so the adapter flags it (on this event
      // or, item 4, on a completed run's terminal event) and this raises the
      // visible record of it.
      raiseUnknownModelRateIfFlagged(db, ticket, run, event.unknownModel);

      // Batch 4 item 3 (docs/strategy/batch-4-spec.md section 1 ruling 1,
      // layer 2): the daemon keeps its own running account of spend rather
      // than trusting only the tool's own between-turn ceiling check. The
      // adapter reports its cumulative estimate on every progress event that
      // carries one; once it crosses this run's ceiling, the scheduler stops
      // the worker itself and records a non-retryable `budget_exceeded`
      // failure with the tally and the overshoot, independent of whether the
      // tool ever reports `error_max_budget_usd` on its own.
      if (typeof event.costUsd === 'number' && event.costUsd > ctx.ceilingUsd) {
        await ctx.stopWorker();
        const tally = event.costUsd;
        const overshoot = tally - ctx.ceilingUsd;
        finishRun(db, run.id, { status: 'failed', failureClass: 'budget_exceeded' });
        // Batch 5: without this, usage_json stays null on a budget-stopped
        // run -- the `progress` event that triggered the stop carries no
        // `usage` field (see types.ts), and the killed adapter's own
        // post-stop event (guard 1 above) is now recorded as a
        // late_worker_event rather than applied, so it can no longer
        // overwrite the run row (batch-4-closeout.md section 2 defect 2),
        // but it also never gets the chance to *supply* usage either. The
        // daemon's own running cost estimate is the only figure available
        // at the moment of the stop, so it is recorded here, explicitly
        // labelled as an estimate rather than the tool's own authoritative
        // total (see claudeCli.ts's messageModel/priceUsage header, which also
        // records this estimate's known undercount on output tokens).
        setRunUsage(db, run.id, { total_cost_usd: tally, source: 'scheduler_budget_estimate', model: ctx.model });
        recordTicketTransition(db, {
          ticketId: ticket.id,
          event: 'worker_failure',
          idempotencyKey: `worker_failure:${run.id}:budget_exceeded`,
          payload: { retryable: false, failureClass: 'budget_exceeded', stoppedBy: 'scheduler_estimate', tally, ceiling: ctx.ceilingUsd, overshoot },
        });
        return true;
      }

      if (ctx.progressSeq.n >= 200) return false;
      ctx.progressSeq.n += 1;
      // Ruling 7: derived once, here, at write time -- every reader
      // (latest_activity on a board row, GET /tickets/{id}/progress,
      // `activity --progress`) reads `tool`/`state` straight off the stored
      // payload rather than re-parsing `message` at each read site. `tool`
      // is `null`, not `undefined`, so a JSON round trip through the
      // events table's payload_json preserves "no tool, a text line" as a
      // real value rather than an absent key a reader might mistake for
      // "not yet computed".
      const tool = parseProgressTool(event.message) ?? null;
      const state = classifyProgressMessage(event.message, ctx.activityPhase.state);
      ctx.activityPhase.state = state;
      insertEvent(db, {
        projectId: ticket.projectId,
        eventType: 'worker_progress',
        entityType: 'run',
        entityId: run.id,
        // Batch 16 item 3 (ruling 18 option B): the entity is a RUN, so
        // without this a consumer needs a second lookup to know which ticket
        // a row is about -- which is why the page could never resolve one.
        payload: { ticketId: ticket.id, message: event.message, costUsd: event.costUsd, tool, state },
        visibility: 'internal',
        idempotencyKey: `worker_progress:${run.id}:${ctx.progressSeq.n}`,
      });
      return false;
    }

    case 'question': {
      ctx.questionSeq.n += 1;
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_question',
        idempotencyKey: `worker_question:${run.id}:${ctx.questionSeq.n}`,
        payload: { message: event.message },
        visibility: 'activity',
      });
      return false;
    }

    case 'failure': {
      raiseUnknownModelRateIfFlagged(db, ticket, run, event.unknownModel);
      if (event.usage !== undefined) setRunUsage(db, run.id, event.usage);

      if (event.retryable === false && event.failureClass === 'adapter_unavailable') {
        cancelTicketRun(db, ticket.id, run.id, 'adapter_unavailable', 'run_cancelled');
        insertEvent(db, {
          projectId: ticket.projectId,
          eventType: 'adapter_unavailable',
          entityType: 'ticket',
          entityId: ticket.id,
          payload: { message: event.message },
          visibility: 'inbox',
          requiresUser: true,
          idempotencyKey: `adapter_unavailable:${run.id}`,
        });
        pauseProjectAdapter(db, ticket.projectId, 'adapter_unavailable');
        return true;
      }

      // Retryable, or non-retryable but not adapter_unavailable: both are a
      // failed attempt (attempt_count increments; the state machine decides
      // READY vs FAILED from `retryable` and the attempt count, per
      // docs/strategy/batch-4-spec.md section 1 ruling 4). The real
      // failureClass is recorded on the run either way.
      finishRun(db, run.id, { status: 'failed', failureClass: event.failureClass ?? 'adapter_failure' });
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_failure',
        idempotencyKey: `worker_failure:${run.id}`,
        payload: { message: event.message, retryable: event.retryable, failureClass: event.failureClass, stoppedBy: event.stoppedBy },
      });
      return true;
    }

    case 'result_raw': {
      raiseUnknownModelRateIfFlagged(db, ticket, run, event.unknownModel);
      if (event.usage !== undefined) setRunUsage(db, run.id, event.usage);
      const validated = validateWorkerResult(event.raw);
      if (!validated.valid) {
        finishRun(db, run.id, { status: 'failed', failureClass: 'malformed_result' });
        recordTicketTransition(db, {
          ticketId: ticket.id,
          event: 'worker_failure',
          idempotencyKey: `worker_failure:${run.id}`,
          payload: { errors: validated.errors, retryable: true, failureClass: 'malformed_result' },
        });
        return true;
      }

      const result = validated.data;

      // Batch 13 ruling 1c: "DONE requires something delivered." A work
      // ticket's `done` with zero artifacts is the exact shape of the
      // batch-12 finding (the board said success, four tickets, zero files)
      // -- treated identically to a schema-invalid result: retryable,
      // malformed, naming the reason. Checked BEFORE captureArtifacts
      // (which would no-op on an empty array regardless) and scoped to
      // `kind === 'work'` only -- a manager ticket's "done" is a proposal
      // to apply, not a deliverable, and an empty commands array with just
      // a rationale is an explicitly valid manager outcome (proposal.ts).
      if (result.status === 'done' && ticket.kind === 'work' && result.artifacts.length === 0) {
        finishRun(db, run.id, { status: 'failed', failureClass: 'malformed_result' });
        recordTicketTransition(db, {
          ticketId: ticket.id,
          event: 'worker_failure',
          idempotencyKey: `worker_failure:${run.id}`,
          payload: { errors: ['done with nothing delivered'], retryable: true, failureClass: 'malformed_result' },
        });
        return true;
      }

      // Batch 15 item 4: "DONE is verified against expected_artifacts when
      // present." Null (no such list at all) keeps today's rule -- the
      // check above is the only one that applies. When a list IS present,
      // every entry of kind 'file' must appear among what the worker just
      // declared -- not what is actually on disk; that filesystem check
      // already happened one layer down, in claudeCli.ts's own
      // verifyArtifacts, before this event could ever reach here as a
      // 'success' outcome. This is a DIFFERENT failure mode: the ticket
      // expected a file the worker never even declared trying to produce.
      // Reuses the EXISTING retryable class (malformed_result), per the
      // brief, rather than inventing a new one.
      //
      // Ruling 21 (batch 15 addendum 10): BOTH sides are resolved against
      // this run's own workspace (`ctx.workspacePath`) with
      // `workspace.ts`'s `resolveDeclaredArtifactPath` -- named distinctly
      // because this file has its own private `resolveArtifactPath`, with the
      // arguments the other way round and used only by capture -- the same
      // rule verifyArtifacts already uses (absolute
      // kept, relative joined to the workspace) -- before comparison, not
      // compared as raw strings. A real worker legitimately declares an
      // absolute path (the adapter already accepts one), and the owner's
      // own delivered `index.md` was rejected four times by the old
      // raw-string check for exactly that reason
      // (docs/strategy/batch-15-addendum-10-owner-walk-findings.md). The
      // failure message below still names the expectation AS THE OWNER
      // TYPED IT (`e.path`, never a resolved path) -- see scheduler.test.ts's
      // "ruling 21" tests, which fail without the resolution (the
      // absolute-match case) and would fail differently if the message
      // named a resolved path instead (the different-directory case).
      if (result.status === 'done' && ticket.kind === 'work' && ticket.expectedArtifacts != null) {
        const declaredResolvedPaths = new Set(
          result.artifacts
            .filter((a): a is { kind: 'file'; path: string } => a.kind === 'file')
            .map((a) => resolveDeclaredArtifactPath(ctx.workspacePath, a.path))
        );
        const missing = ticket.expectedArtifacts
          .filter((e) => e.kind === 'file' && e.path !== undefined)
          .filter((e) => !declaredResolvedPaths.has(resolveDeclaredArtifactPath(ctx.workspacePath, e.path!)))
          .map((e) => e.path!);
        if (missing.length > 0) {
          const message = `expected artefact(s) not produced: ${missing.join(', ')}`;
          finishRun(db, run.id, { status: 'failed', failureClass: 'malformed_result' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_failure',
            idempotencyKey: `worker_failure:${run.id}`,
            payload: { errors: [message], message, retryable: true, failureClass: 'malformed_result' },
          });
          return true;
        }
      }

      // Captured once here, ahead of the per-status branching below, since
      // a worker can declare artifacts regardless of which terminal status
      // it reports — capturing only on 'done' would lose them for a run
      // that ends in review or needs a decision, right before its NONE
      // workspace is deleted below.
      captureArtifacts(db, ticket, run, ctx.workspaceType, ctx.workspacePath, ctx.artifactsDir, result.artifacts);

      switch (result.status) {
        case 'done':
          // Batch 9: a manager ticket's "done" does not mean "land on
          // DONE and move on" the way a work ticket's does -- its artefact
          // is a proposal, not a finished deliverable, and the daemon must
          // validate and apply that proposal (in one transaction, per
          // batch-9-spec.md section 2) before this run can be called
          // settled at all. See managerApply.ts's doc comment for why this
          // is a completely separate function rather than another branch
          // inline here: the transaction boundary, the malformed-proposal
          // path, and the request_user_decision->BLOCKED routing are all
          // its own concern, not this dispatcher's.
          if (ticket.kind === 'manager') {
            applyManagerTicketDone(db, ticket, run, ctx);
            break;
          }
          // Batch 18 ruling 31: a work ticket's worker `done` is a claim, not
          // a verdict. The ticket enters REVIEW and a verifier run decides
          // (verifier.ts); DONE is reached only through `review_approved`.
          finishRun(db, run.id, { status: 'succeeded' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_done_for_verification',
            idempotencyKey: `worker_done:${run.id}`,
            payload: result,
            visibility: 'activity',
          });
          break;

        case 'review':
          finishRun(db, run.id, { status: 'review' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_needs_review',
            idempotencyKey: `worker_needs_review:${run.id}`,
            payload: result,
            visibility: 'activity',
          });
          break;

        case 'needs_user_decision':
          finishRun(db, run.id, { status: 'blocked' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_needs_user_decision',
            idempotencyKey: `worker_needs_user_decision:${run.id}`,
            payload: result,
            visibility: 'inbox',
            requiresUser: true,
          });
          break;

        case 'failed':
          finishRun(db, run.id, { status: 'failed', failureClass: 'worker_reported_failure' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_failure',
            idempotencyKey: `worker_failure:${run.id}`,
            payload: { ...result, retryable: true, failureClass: 'worker_reported_failure' },
          });
          break;

        // Batch 7 (Role L, docs/strategy/batch-7-spec.md section 1 ruling
        // 1): the worker read its own budget out of the envelope, measured
        // its burn rate, and stopped -- the cheapest, best-explained stop
        // the system has (batch-6-closeout.md section 3). Previously this
        // status did not exist and such a worker had no way to report
        // itself other than the generic 'failed' above, which the owner's
        // remedy (raise the budget) can't act on because a retry just
        // reproduces the same stop under the same ceiling. Routed through
        // the dedicated `worker_budget_stop` transition (stateMachine.ts),
        // not `worker_failure`, so no attempt is consumed and the ticket
        // lands FAILED unconditionally rather than READY-with-attempts-left.
        case 'budget_insufficient':
          finishRun(db, run.id, { status: 'failed', failureClass: 'worker_budget_stop' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_budget_stop',
            idempotencyKey: `worker_budget_stop:${run.id}`,
            payload: { ...result, retryable: false, failureClass: 'worker_budget_stop' },
          });
          break;
      }

      return true;
    }
  }
}

// Picks up READY tickets up to `maxParallelWorkers` and starts a run for
// each via the adapter. Does not wait for runs to finish: each started run
// carries a `done` promise that settles when its terminal event arrives,
// which is how a caller can await completion without blocking the tick
// itself (needed so the concurrency cap can be observed while a worker
// hangs).
export async function tick(deps: SchedulerDeps): Promise<TickResult> {
  assertReadinessMode(deps.readiness, 'tick');
  resolveReadiness(deps.db, deps.projectId);

  if (isProjectAdapterPaused(deps.db, deps.projectId)) {
    return { started: [] };
  }

  // Batch 16 ruling 24: readiness at the point of use. Before ANY run starts
  // -- manager or worker -- the project must have a directory, a safe one,
  // and a scope path; otherwise it is paused through the existing pause
  // mechanism with the failing rule as the structured reason (the board and
  // inbox render it with the exact fix). Nothing is healed: the owner picks
  // the directory. `deps.readiness` is REQUIRED -- absence is impossible, not
  // merely named (guard at the top of this function): `{ stateDir }` asks the
  // question, `'skip'` is the one greppable declaration that a caller does not.
  if (deps.readiness !== 'skip') {
    const projectRow = getProject(deps.db, deps.projectId);
    const readiness = projectRow ? projectReadiness(projectRow, deps.readiness.stateDir, deps.readiness.scopeProbe) : null;
    if (readiness) {
      pauseProjectAdapter(deps.db, deps.projectId, readiness.rule);
      // Ruling 29: record WHY, so the pause line can name the actual error
      // (the causes of an unreadable scope file need different fixes) instead
      // of guessing between them. describeProjectPause reads this back.
      const notReadyPolicy = classify('project_not_ready');
      insertEvent(deps.db, {
        projectId: deps.projectId,
        eventType: 'project_not_ready',
        entityType: 'project',
        entityId: deps.projectId,
        payload: { rule: readiness.rule, ...(readiness.detail !== undefined ? { error: readiness.detail } : {}) },
        visibility: notReadyPolicy.visibility,
        requiresUser: notReadyPolicy.requiresUser,
        idempotencyKey: `project_not_ready:${randomUUID()}`,
      });
      return { started: [] };
    }
  }

  // Batch 18 ruling 31: a ticket sitting in REVIEW with no verifier running
  // (the worker's own `review` status, or a daemon restart between a worker's
  // done and its verifier) is verified here. Verifier runs do not count
  // against maxParallelWorkers: they are the tail of a slot already spent.
  const verifying: StartedRun[] = [];
  for (const t of listTicketsByStatus(deps.db, deps.projectId, 'REVIEW')) {
    const v = await verifyReviewTicket(deps, t.id);
    if (v) verifying.push(v);
  }

  // Batch 18 ruling 34: the board has drained -> one automatic Manager turn
  // (autoManager.ts holds every condition). Created here, before the READY list
  // is read, so it starts on this same tick; resolveReadiness moves it OPEN ->
  // READY. The daily cap below still refuses it like any Manager ticket.
  if (maybeCreateAutomaticManagerTurn(deps.db, deps.projectId)) {
    resolveReadiness(deps.db, deps.projectId);
  }

  const project = getProject(deps.db, deps.projectId);
  if (!project) {
    return { started: verifying };
  }

  // Batch 18 ruling 33: a Manager turn is not a worker slot. `available`
  // counts only WORK tickets in IN_PROGRESS; a READY manager ticket starts on
  // this tick whatever the slots hold, ahead of any work ticket, but at most
  // one Manager run is in flight per project (two proposals must not race
  // against one board). This was the owner's "it just stopped": one READY list
  // and one cap for everything meant their message to the Manager queued
  // behind a running worker, and nothing said so.
  const inProgress = listTicketsByStatus(deps.db, deps.projectId, 'IN_PROGRESS');
  const workInProgressCount = inProgress.filter((t) => t.kind !== 'manager').length;
  const managerInFlight = inProgress.some((t) => t.kind === 'manager');
  const available = Math.max(0, deps.maxParallelWorkers - workInProgressCount);
  const allReady = listTicketsByStatus(deps.db, deps.projectId, 'READY');
  const readyManager = managerInFlight ? [] : allReady.filter((t) => t.kind === 'manager').slice(0, 1);
  const readyWork = allReady.filter((t) => t.kind !== 'manager').slice(0, available);
  const readyTickets = [...readyManager, ...readyWork];

  const artifactsDir = deps.artifactsDir ?? join(process.cwd(), '.magarine', 'artifacts');
  const started: StartedRun[] = [...verifying];
  // Batch 11 item 3: one fixed instant for the whole tick, so every
  // manager-kind ticket considered in this pass is measured against the
  // exact same daily-cap window.
  const now = new Date();

  // Batch 4 section 1 ruling 1, layer 1: the hard control is at spawn time,
  // because declining to start a worker is the only cost decision the
  // daemon fully controls. Tracked as a running local tally (recorded spend
  // plus each ticket's ceiling as it is admitted this tick) rather than
  // re-querying `projectSpendUsd` per ticket, so a burst of several READY
  // tickets in one high-concurrency tick cannot each individually pass the
  // check against the same stale baseline and collectively overcommit.
  let projectedSpend = project.maxSpendUsd != null ? projectSpendUsd(deps.db, deps.projectId) : 0;

  for (const ticket of readyTickets) {
    // Defense in depth: re-verify readiness right before starting work,
    // rather than trusting the READY status read a moment ago. A wrong row
    // in `tickets.status` must not be sufficient on its own to run a
    // ticket whose dependencies aren't actually DONE. In the normal case
    // this is a no-op, since `resolveReadiness` above already reconciled
    // the whole project.
    if (!isReady(deps.db, ticket.id)) {
      recordTicketTransition(deps.db, {
        ticketId: ticket.id,
        event: 'dependency_not_satisfied',
        idempotencyKey: `dependency_not_satisfied:${ticket.id}:${ticket.updatedAt}`,
        visibility: 'internal',
      });
      continue;
    }

    // Batch 11 ruling 1 rule e: the old behaviour refused outright the
    // moment a ticket's own ceiling wouldn't fit under the remaining cap,
    // which meant a $1 cap with a $2 default refused forever, silently, on
    // every tick (finding 5). The fix shrinks the ceiling to whatever the
    // cap still allows and only refuses -- pausing, with one inbox item --
    // when that shrunk amount would fall below MIN_BUDGET_USD, since a run
    // below the floor isn't a real run. `ceilingOverrideUsd` stays
    // `undefined` when the ticket's own ceiling already fits, so an
    // uncapped or generously-capped project never has its envelope touched.
    let ceilingOverrideUsd: number | undefined;
    // Strategist's addition to rule e (part 3): shrinking must stay quiet on
    // the healthy path -- no inbox item -- but must not be INVISIBLE: a run
    // that stops early under a shrunk ceiling is otherwise inexplicable from
    // the board alone. `shrinkDetails` carries the numbers for the
    // activity-only event inserted below, once `run` exists; stays
    // `undefined` in the same cases `ceilingOverrideUsd` does (an uncapped
    // or generously-capped project), so that project sees no event at all.
    let shrinkDetails: { ownCeilingUsd: number; capAllowedUsd: number; appliedCeilingUsd: number } | undefined;
    if (project.maxSpendUsd != null) {
      const ownCeiling = resolveMaxBudgetUsd(project, ticket);
      const remainingCap = project.maxSpendUsd - projectedSpend;
      const effectiveCeiling = Math.min(ownCeiling, remainingCap);
      if (effectiveCeiling < MIN_BUDGET_USD) {
        insertEvent(deps.db, {
          projectId: project.id,
          eventType: 'project_spend_cap_reached',
          entityType: 'project',
          entityId: project.id,
          payload: { ticketId: ticket.id, projectedSpend: projectedSpend + ownCeiling, maxSpendUsd: project.maxSpendUsd },
          visibility: 'inbox',
          requiresUser: true,
          idempotencyKey: `project_spend_cap_reached:${randomUUID()}`,
        });
        pauseProjectAdapter(deps.db, project.id, 'spend_cap');
        // Stop considering further READY tickets this tick: the project is
        // now paused, and `isProjectAdapterPaused` at the top of the next
        // tick() call is what actually prevents any further spawn -- this
        // break just avoids evaluating (and possibly emitting duplicate
        // cap-reached events for) the rest of this tick's own batch.
        break;
      }
      projectedSpend += effectiveCeiling;
      if (effectiveCeiling < ownCeiling) {
        ceilingOverrideUsd = effectiveCeiling;
        shrinkDetails = { ownCeilingUsd: ownCeiling, capAllowedUsd: remainingCap, appliedCeilingUsd: effectiveCeiling };
      }
    }

    // Batch 11 item 3: the per-project daily Manager-invocation cap
    // (manager.ts's isManagerDailyCapReached/MANAGER_DAILY_CAP_DEFAULT).
    // This is the ONLY enforcement point -- not manager.ts's own
    // planProject/discussProject -- because tick() is where every path that
    // can produce a READY manager ticket converges: a fresh plan/discuss
    // call, and a `decide` that unblocked an existing manager ticket sitting
    // BLOCKED from its own request_user_decision (managerApply.ts's
    // comment: answering it returns the ticket to READY for "the next tick"
    // to re-run -- manager.ts's two entry points never see that second
    // path). Skips (`continue`) rather than pausing/`break`ing the whole
    // project: a Manager invocation cap is not a spend cap, and must not
    // stop ordinary WORK tickets later in this same readyTickets batch from
    // spawning. Idempotency key is per ticket per UTC day, so a
    // project sitting at the cap for hours does not mint a new inbox event
    // on every tick.
    if (ticket.kind === 'manager' && isManagerDailyCapReached(deps.db, project.id, now)) {
      const policy = classify('manager_daily_cap_reached');
      insertEvent(deps.db, {
        projectId: project.id,
        eventType: 'manager_daily_cap_reached',
        entityType: 'ticket',
        entityId: ticket.id,
        payload: { cap: MANAGER_DAILY_CAP_DEFAULT },
        visibility: policy.visibility,
        requiresUser: policy.requiresUser,
        idempotencyKey: `manager_daily_cap_reached:${ticket.id}:${now.toISOString().slice(0, 10)}`,
      });
      continue;
    }

    let ws;
    try {
      ws = prepareWorkspace(ticket.workspaceType, ticket.id, {
        workspaceRoot: project.workspaceRoot ?? undefined,
        baseDir: deps.workspaceBaseDir,
      });
    } catch (err) {
      // Leave the ticket READY (nothing changed its status) and surface
      // the misconfiguration (e.g. DIRECTORY with no project.workspace_root)
      // rather than crashing the whole tick and losing every other ready
      // ticket in it.
      insertEvent(deps.db, {
        projectId: ticket.projectId,
        eventType: 'workspace_preparation_failed',
        entityType: 'ticket',
        entityId: ticket.id,
        // projectId carried in the payload too (not just the event row's own
        // top-level field), matching project_spend_cap_reached/
        // adapter_unavailable_pause's own convention -- reasonFor
        // (commands/inbox.ts) reads it from here to compose `project set
        // --dir` with the real id, the same way those two compose their own
        // fix commands.
        payload: { message: err instanceof Error ? err.message : String(err), projectId: ticket.projectId },
        visibility: 'inbox',
        requiresUser: true,
        idempotencyKey: `workspace_preparation_failed:${ticket.id}:${ticket.updatedAt}`,
      });
      continue;
    }

    if (ticket.workspaceType === 'NONE') {
      copyNoneDependencyInputs(deps.db, ticket, ws.path);
    }

    const attempt = ticket.attemptCount + 1;
    const run = createRun(deps.db, {
      ticketId: ticket.id,
      attempt,
      adapter: deps.adapter.id,
      workspaceRef: ws.path,
    });

    recordTicketTransition(deps.db, {
      ticketId: ticket.id,
      event: 'run_started',
      idempotencyKey: `run_started:${run.id}`,
    });

    // Part 3: activity-only, never inbox -- hardcoded here rather than
    // routed through classify() the way most other event types are, the
    // same choice already made a few lines above for
    // project_spend_cap_reached; this event type has no policy.ts row
    // (policy.ts is out of this role's files) and none is needed for a
    // visibility that never varies.
    if (shrinkDetails) {
      insertEvent(deps.db, {
        projectId: project.id,
        eventType: 'spend_cap_ceiling_shrunk',
        entityType: 'run',
        entityId: run.id,
        payload: { ticketId: ticket.id, ...shrinkDetails },
        visibility: 'activity',
        requiresUser: false,
        idempotencyKey: `spend_cap_ceiling_shrunk:${run.id}`,
      });
    }

    // Batch 9: a manager ticket gets the Manager's own envelope (mission,
    // compact board, decision log, recent failures, command schema -- see
    // managerEnvelope.ts), never buildEnvelope's worker envelope. Same
    // adapter call either way; startWorker has no idea which kind of ticket
    // it just received.
    const envelope = ticket.kind === 'manager' ? buildManagerEnvelope(deps.db, ticket, project) : buildEnvelope(deps.db, ticket, project);
    // Batch 11 rule e: a cap-shrunk ceiling must reach both consumers that
    // read envelope.maxBudgetUsd -- the adapter's own --max-budget-usd (via
    // startWorker below) and this tick's own live-estimate stop-check
    // (ctx.ceilingUsd, assigned from this same envelope a few lines down) --
    // so it is applied once, here, before either reads it.
    if (ceilingOverrideUsd !== undefined) envelope.maxBudgetUsd = ceilingOverrideUsd;
    const handle = await deps.adapter.startWorker({
      ticket: envelope,
      workspace: { type: ticket.workspaceType, path: ws.path },
      systemPolicy: 'default',
    });
    setRunWorkerSessionRef(deps.db, run.id, handle.id);

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const ctx: ApplyEventContext = {
      questionSeq: { n: 0 },
      progressSeq: { n: 0 },
      activityPhase: { state: 'running' },
      lateEventSeq: { n: 0 },
      workspacePath: ws.path,
      workspaceType: ticket.workspaceType,
      artifactsDir,
      workspaceCleanup: ws.cleanup,
      ceilingUsd: envelope.maxBudgetUsd,
      model: envelope.model,
      stopWorker: () => deps.adapter.stop(handle),
    };

    let timeoutTimer: NodeJS.Timeout | undefined;
    const finishNormally = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolveDone();
    };
    if (deps.runTimeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        void cancelRun(deps, { ticketId: ticket.id, runId: run.id, handle }, 'run_timeout', 'run_cancelled').then(
          resolveDone
        );
      }, deps.runTimeoutMs);
    }

    const schedulerErrorSeq = { n: 0 };
    // Fire-and-forget: the callback applies transitions as events arrive.
    // Batch 5 guard 3: the whole body is one try/catch, not just the
    // applyWorkerEvent call -- `ticket` (this loop's own stable snapshot,
    // not `current`, which might not exist if the throw happens before or
    // during the lookup) supplies projectId for the recorded event. This is
    // the last line of defense: guard 1 (live run-status check) and guard 2
    // (finishRun's WHERE status='running') are expected to prevent a
    // throwing transition in the first place, but the daemon must survive
    // even a throw neither of them anticipated -- the whole reason
    // batch-4-closeout.md section 2 happened is that nothing here caught
    // anything at all.
    void deps.adapter.observe(handle, (event) => {
      void (async () => {
        try {
          const current = getTicket(deps.db, ticket.id)!;
          const terminal = await applyWorkerEvent(deps.db, current, run, event, ctx);
          if (terminal) {
            // Batch 18 ruling 31: a worker that landed the ticket in REVIEW
            // (its `done` on a work ticket, or its own `review`) is checked
            // by a verifier before this run's `done` settles.
            if (timeoutTimer) clearTimeout(timeoutTimer);
            try {
              await (await verifyReviewTicket(deps, ticket.id))?.done;
            } finally {
              finishNormally();
            }
          }
        } catch (err) {
          try {
            schedulerErrorSeq.n += 1;
            const policy = classify('scheduler_error');
            insertEvent(deps.db, {
              projectId: ticket.projectId,
              eventType: 'scheduler_error',
              entityType: 'run',
              entityId: run.id,
              payload: { message: err instanceof Error ? err.message : String(err) },
              visibility: policy.visibility,
              requiresUser: policy.requiresUser,
              idempotencyKey: `scheduler_error:${run.id}:${schedulerErrorSeq.n}`,
            });
          } catch {
            // Recording the failure must never itself become a second,
            // unguarded throw -- the daemon staying alive does not depend
            // on this insertEvent call succeeding.
          }
        }
      })();
    });

    started.push({ ticketId: ticket.id, runId: run.id, handle, done });
  }

  return { started };
}

// Repeatedly ticks until a tick starts nothing new. Each iteration waits for
// everything it started before ticking again, so dependents that just
// became READY are picked up on the next pass. Will not return while a
// worker is hung and no signal has arrived (by design: that mirrors a real
// daemon, which keeps waiting until the hung run is cancelled).
//
// SIGINT/SIGTERM: stops every live worker via the adapter, marks their runs
// cancelled and their tickets back to READY (never consuming an attempt —
// this is the daemon's own decision, not the ticket's fault), then returns.
// A run's `done` promise may never resolve on its own here (a genuinely
// hung fake/real worker emits nothing once stopped), so cancellation must
// not wait on it — it forces the DB state directly instead.
export async function runUntilIdle(deps: SchedulerDeps): Promise<void> {
  assertReadinessMode(deps.readiness, 'runUntilIdle');
  const live = new Map<string, StartedRun>();
  let signalled = false;
  let interruptResolve!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    interruptResolve = resolve;
  });

  const onSignal = () => {
    if (signalled) return;
    signalled = true;
    interruptResolve();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (;;) {
      if (signalled) break;

      const { started } = await tick(deps);
      if (started.length === 0) break;

      for (const s of started) {
        live.set(s.runId, s);
        void s.done.then(() => live.delete(s.runId));
      }

      const outcome = await Promise.race([
        Promise.all(started.map((s) => s.done)).then((): 'done' => 'done'),
        interrupted.then((): 'interrupted' => 'interrupted'),
      ]);
      if (outcome === 'interrupted') break;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (signalled) {
    for (const sr of live.values()) {
      if (getRun(deps.db, sr.runId)?.kind === 'verify') {
        // A verifier is not the ticket's worker: stopping it leaves the ticket
        // in REVIEW (the next tick verifies it again) and touches no attempt.
        await deps.adapter.stop(sr.handle);
        finishRun(deps.db, sr.runId, { status: 'cancelled', failureClass: 'interrupted' });
        continue;
      }
      await cancelRun(deps, sr, 'interrupted', 'run_cancelled');
    }
  }
}

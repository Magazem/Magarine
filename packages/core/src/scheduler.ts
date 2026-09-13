import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Db } from './db/index.ts';
import { isReady, resolveReadiness } from './dependencies.ts';
import { classify } from './policy.ts';
import { validateWorkerResult } from './resultContract.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { prepareWorkspace } from './workspace.ts';
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
  pauseProjectAdapter,
  projectSpendUsd,
  resolveMaxBudgetUsd,
  setRunUsage,
  setRunWorkerSessionRef,
} from './store.ts';
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
  /** Passed straight through to `prepareWorkspace`'s `baseDir` for NONE-mode runs. Test-only; production default (the OS temp directory) is unchanged. See workspace.ts's WorkspaceOptions.baseDir. */
  workspaceBaseDir?: string;
}

export interface StartedRun {
  ticketId: string;
  runId: string;
  handle: WorkerHandle;
  done: Promise<void>;
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

function buildEnvelope(db: Db, ticket: Ticket, project: Project): TicketEnvelope {
  const completedDependencies = getDependencies(db, ticket.id)
    .filter((d) => d.dependencyType === 'blocks')
    .map((d) => {
      const dep = getTicket(db, d.dependsOnTicketId);

      const doneEvents = listEventsForEntity(db, 'ticket', d.dependsOnTicketId).filter(
        (e) => e.eventType === 'worker_done'
      );
      const lastDone = doneEvents[doneEvents.length - 1];
      const summary =
        lastDone && typeof lastDone.payload === 'object' && lastDone.payload !== null
          ? ((lastDone.payload as Record<string, unknown>).summary as string | undefined)
          : undefined;

      const artifacts: TicketEnvelopeArtifact[] = listArtifactsForTicket(db, d.dependsOnTicketId).map((a) => ({
        kind: a.kind,
        path:
          a.kind === 'file' && ticket.workspaceType === 'NONE'
            ? dependencyInputRelativePath(d.dependsOnTicketId, a.pathOrUri)
            : a.pathOrUri,
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
        pathOrUri: artifact.path,
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
        pathOrUri: artifact.path,
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

// Cancels one run/ticket pair without consuming an attempt: finishes the
// run as 'cancelled' (only if it is still recorded as running, so a run
// that already reached a real terminal state is never overwritten) and
// applies `run_cancelled` (only if the ticket is still IN_PROGRESS, so a
// ticket that already moved on is left alone). Shared by the
// adapter_unavailable failure path, the per-run timeout, and
// SIGINT/SIGTERM handling in runUntilIdle — the only three ways a run gets
// cancelled by the daemon rather than by the worker's own result. A NONE
// workspace is disposable temp storage, so it is reclaimed here too
// (looked up from the run's own persisted workspace_ref, not from a
// closure — cancelRun's callers, timeout and SIGINT, never went through
// tick()'s per-run closures in the first place).
function cancelTicketRun(db: Db, ticketId: string, runId: string, failureClass: string): void {
  const run = getRun(db, runId);
  if (run && run.status === 'running') {
    finishRun(db, runId, { status: 'cancelled', failureClass });
  }
  const ticket = getTicket(db, ticketId);
  if (ticket && ticket.status === 'IN_PROGRESS') {
    recordTicketTransition(db, {
      ticketId,
      event: 'run_cancelled',
      idempotencyKey: `run_cancelled:${runId}`,
      visibility: 'activity',
    });
  }
  if (ticket?.workspaceType === 'NONE' && run?.workspaceRef) {
    rmSync(run.workspaceRef, { recursive: true, force: true });
  }
}

async function cancelRun(
  deps: SchedulerDeps,
  sr: { ticketId: string; runId: string; handle: WorkerHandle },
  failureClass: string
): Promise<void> {
  await deps.adapter.stop(sr.handle);
  cancelTicketRun(deps.db, sr.ticketId, sr.runId, failureClass);
}

interface ApplyEventContext {
  questionSeq: { n: number };
  progressSeq: { n: number };
  /** Batch 5 section 1 ruling 1: counts late_worker_event rows for this run, for a deterministic idempotency key (the house pattern, per questionSeq/progressSeq -- not randomUUID, so the count is exact and inspectable). */
  lateEventSeq: { n: number };
  workspacePath: string;
  workspaceType: WorkspaceType;
  artifactsDir: string;
  workspaceCleanup: () => Promise<void>;
  /** This run's resolved ceiling (ticket override, else project default). Batch 4 item 3. */
  ceilingUsd: number;
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
        setRunUsage(db, run.id, { total_cost_usd: tally, source: 'scheduler_budget_estimate' });
        recordTicketTransition(db, {
          ticketId: ticket.id,
          event: 'worker_failure',
          idempotencyKey: `worker_failure:${run.id}:budget_exceeded`,
          payload: { retryable: false, failureClass: 'budget_exceeded', tally, ceiling: ctx.ceilingUsd, overshoot },
        });
        return true;
      }

      if (ctx.progressSeq.n >= 200) return false;
      ctx.progressSeq.n += 1;
      insertEvent(db, {
        projectId: ticket.projectId,
        eventType: 'worker_progress',
        entityType: 'run',
        entityId: run.id,
        payload: { message: event.message, costUsd: event.costUsd },
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
      if (event.usage !== undefined) setRunUsage(db, run.id, event.usage);

      if (event.retryable === false && event.failureClass === 'adapter_unavailable') {
        cancelTicketRun(db, ticket.id, run.id, 'adapter_unavailable');
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
        pauseProjectAdapter(db, ticket.projectId);
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
        payload: { message: event.message, retryable: event.retryable, failureClass: event.failureClass },
      });
      return true;
    }

    case 'result_raw': {
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
      // Captured once here, ahead of the per-status branching below, since
      // a worker can declare artifacts regardless of which terminal status
      // it reports — capturing only on 'done' would lose them for a run
      // that ends in review or needs a decision, right before its NONE
      // workspace is deleted below.
      captureArtifacts(db, ticket, run, ctx.workspaceType, ctx.workspacePath, ctx.artifactsDir, result.artifacts);

      switch (result.status) {
        case 'done':
          finishRun(db, run.id, { status: 'succeeded' });
          recordTicketTransition(db, {
            ticketId: ticket.id,
            event: 'worker_done',
            idempotencyKey: `worker_done:${run.id}`,
            payload: result,
            visibility: 'activity',
          });
          resolveReadiness(db, ticket.projectId);
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
  resolveReadiness(deps.db, deps.projectId);

  if (isProjectAdapterPaused(deps.db, deps.projectId)) {
    return { started: [] };
  }

  const inProgressCount = listTicketsByStatus(deps.db, deps.projectId, 'IN_PROGRESS').length;
  const available = Math.max(0, deps.maxParallelWorkers - inProgressCount);
  if (available === 0) {
    return { started: [] };
  }

  const project = getProject(deps.db, deps.projectId);
  if (!project) {
    return { started: [] };
  }

  const artifactsDir = deps.artifactsDir ?? join(process.cwd(), '.magarine', 'artifacts');
  const readyTickets = listTicketsByStatus(deps.db, deps.projectId, 'READY').slice(0, available);
  const started: StartedRun[] = [];

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

    if (project.maxSpendUsd != null) {
      const ceiling = resolveMaxBudgetUsd(project, ticket);
      if (projectedSpend + ceiling > project.maxSpendUsd) {
        insertEvent(deps.db, {
          projectId: project.id,
          eventType: 'project_spend_cap_reached',
          entityType: 'project',
          entityId: project.id,
          payload: { ticketId: ticket.id, projectedSpend: projectedSpend + ceiling, maxSpendUsd: project.maxSpendUsd },
          visibility: 'inbox',
          requiresUser: true,
          idempotencyKey: `project_spend_cap_reached:${randomUUID()}`,
        });
        pauseProjectAdapter(deps.db, project.id);
        // Stop considering further READY tickets this tick: the project is
        // now paused, and `isProjectAdapterPaused` at the top of the next
        // tick() call is what actually prevents any further spawn -- this
        // break just avoids evaluating (and possibly emitting duplicate
        // cap-reached events for) the rest of this tick's own batch.
        break;
      }
      projectedSpend += ceiling;
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
        payload: { message: err instanceof Error ? err.message : String(err) },
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

    const envelope = buildEnvelope(deps.db, ticket, project);
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
      lateEventSeq: { n: 0 },
      workspacePath: ws.path,
      workspaceType: ticket.workspaceType,
      artifactsDir,
      workspaceCleanup: ws.cleanup,
      ceilingUsd: envelope.maxBudgetUsd,
      stopWorker: () => deps.adapter.stop(handle),
    };

    let timeoutTimer: NodeJS.Timeout | undefined;
    const finishNormally = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolveDone();
    };
    if (deps.runTimeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        void cancelRun(deps, { ticketId: ticket.id, runId: run.id, handle }, 'run_timeout').then(resolveDone);
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
          if (terminal) finishNormally();
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
      await cancelRun(deps, sr, 'interrupted');
    }
  }
}

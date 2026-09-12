import type { Db } from './db/index.ts';
import { isReady, resolveReadiness } from './dependencies.ts';
import { validateWorkerResult } from './resultContract.ts';
import { recordTicketTransition } from './stateMachine.ts';
import {
  createRun,
  finishRun,
  getDependencies,
  getTicket,
  listTicketsByStatus,
  setRunUsage,
  setRunWorkerSessionRef,
} from './store.ts';
import type { AgentAdapter, Run, Ticket, TicketEnvelope, WorkerEvent } from './types.ts';

export interface SchedulerDeps {
  db: Db;
  adapter: AgentAdapter;
  maxParallelWorkers: number;
  projectId: string;
}

export interface StartedRun {
  ticketId: string;
  runId: string;
  done: Promise<void>;
}

export interface TickResult {
  started: StartedRun[];
}

function buildEnvelope(db: Db, ticket: Ticket): TicketEnvelope {
  const completedDependencies = getDependencies(db, ticket.id)
    .filter((d) => d.dependencyType === 'blocks')
    .map((d) => {
      const dep = getTicket(db, d.dependsOnTicketId);
      return { ticketId: d.dependsOnTicketId, title: dep?.title ?? '', summary: dep?.resultJson ?? undefined };
    });

  return {
    ticketId: ticket.id,
    projectBrief: '',
    relevantDecisions: [],
    title: ticket.title,
    description: ticket.description ?? '',
    acceptanceCriteria: ticket.acceptanceCriteria,
    completedDependencies,
    allowedTools: [],
    expectedOutputFormat: 'Write .orchestrator/result.json matching the WorkerResult schema.',
  };
}

// Applies one terminal or non-terminal WorkerEvent for a single run. This is
// the only place that turns an adapter event into a ticket transition; it
// always goes through `recordTicketTransition`, never writes status itself.
function applyWorkerEvent(
  db: Db,
  ticket: Ticket,
  run: Run,
  event: WorkerEvent,
  questionSeq: { n: number },
  resolveDone: () => void
): void {
  switch (event.type) {
    case 'progress':
      return; // Not persisted in this batch; real adapters may log via events later.

    case 'question': {
      questionSeq.n += 1;
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_question',
        idempotencyKey: `worker_question:${run.id}:${questionSeq.n}`,
        payload: { message: event.message },
        visibility: 'activity',
      });
      return; // Run continues; not terminal.
    }

    case 'failure': {
      finishRun(db, run.id, { status: 'failed', failureClass: 'adapter_failure' });
      if (event.usage !== undefined) setRunUsage(db, run.id, event.usage);
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_retryable_failure',
        idempotencyKey: `worker_retryable_failure:${run.id}`,
        payload: { message: event.message },
        visibility: 'activity',
      });
      resolveDone();
      return;
    }

    case 'result_raw': {
      if (event.usage !== undefined) setRunUsage(db, run.id, event.usage);
      const validated = validateWorkerResult(event.raw);
      if (!validated.valid) {
        finishRun(db, run.id, { status: 'failed', failureClass: 'malformed_result' });
        recordTicketTransition(db, {
          ticketId: ticket.id,
          event: 'worker_retryable_failure',
          idempotencyKey: `worker_retryable_failure:${run.id}`,
          payload: { errors: validated.errors },
          visibility: 'activity',
        });
        resolveDone();
        return;
      }

      const result = validated.data;
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
            event: 'worker_retryable_failure',
            idempotencyKey: `worker_retryable_failure:${run.id}`,
            payload: result,
            visibility: 'activity',
          });
          break;
      }
      resolveDone();
      return;
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

  const inProgressCount = listTicketsByStatus(deps.db, deps.projectId, 'IN_PROGRESS').length;
  const available = Math.max(0, deps.maxParallelWorkers - inProgressCount);
  if (available === 0) {
    return { started: [] };
  }

  const readyTickets = listTicketsByStatus(deps.db, deps.projectId, 'READY').slice(0, available);
  const started: StartedRun[] = [];

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

    const attempt = ticket.attemptCount + 1;
    const run = createRun(deps.db, { ticketId: ticket.id, attempt, adapter: deps.adapter.id });

    recordTicketTransition(deps.db, {
      ticketId: ticket.id,
      event: 'run_started',
      idempotencyKey: `run_started:${run.id}`,
    });

    const envelope = buildEnvelope(deps.db, ticket);
    const handle = await deps.adapter.startWorker({ ticket: envelope, systemPolicy: 'default' });
    setRunWorkerSessionRef(deps.db, run.id, handle.id);

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const questionSeq = { n: 0 };

    // Fire-and-forget: the callback applies transitions as events arrive.
    void deps.adapter.observe(handle, (event) => {
      const current = getTicket(deps.db, ticket.id)!;
      applyWorkerEvent(deps.db, current, run, event, questionSeq, resolveDone);
    });

    started.push({ ticketId: ticket.id, runId: run.id, done });
  }

  return { started };
}

// Repeatedly ticks until a tick starts nothing new. Each iteration waits for
// everything it started before ticking again, so dependents that just
// became READY are picked up on the next pass. Will not return while a
// worker is hung (by design: that mirrors a real daemon, which keeps
// waiting until the hung run is cancelled).
export async function runUntilIdle(deps: SchedulerDeps): Promise<void> {
  for (;;) {
    const { started } = await tick(deps);
    if (started.length === 0) {
      return;
    }
    await Promise.all(started.map((s) => s.done));
  }
}

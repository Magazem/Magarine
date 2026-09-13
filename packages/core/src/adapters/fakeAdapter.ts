import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  TicketEnvelope,
  Workspace,
  WorkerEvent,
  WorkerHandle,
} from '../types.ts';

// A permanent test double for AgentAdapter, per
// technical-architecture-weekend-mvp.md ("Fake adapter first and
// permanent"). Behaviour is scripted per ticket id by the test.

export type FakeScript =
  | { kind: 'succeed'; delayMs?: number; usage?: unknown }
  | { kind: 'retryable_failure'; delayMs?: number; message?: string; usage?: unknown }
  | { kind: 'question'; delayMs?: number; message?: string; usage?: unknown }
  | { kind: 'needs_user_decision'; delayMs?: number; blockers?: string[]; usage?: unknown }
  | { kind: 'malformed_result'; delayMs?: number }
  // Never emits a terminal event on its own -- models a worker still
  // mid-flight (e.g. reporting a cumulative cost estimate), the way a real
  // run looks right up until the scheduler decides to stop it (see
  // scheduler.ts's budget-stop branch in applyWorkerEventInner's 'progress'
  // case).
  | { kind: 'progress'; costUsd?: number; message?: string; delayMs?: number }
  | { kind: 'hang' };

interface HandleState {
  timers: NodeJS.Timeout[];
  stopped: boolean;
  listeners: Array<(event: WorkerEvent) => void>;
  /** The deferred post-stop terminal event scheduled by stop() (see its comment). Tracked separately from `timers` -- which stop() itself clears -- so destroy() can cancel it even on a handle that was already stopped once. */
  postStopTimer?: NodeJS.Timeout;
}

export class FakeAdapter implements AgentAdapter {
  readonly id = 'fake';

  private readonly scripts = new Map<string, FakeScript>();
  private readonly handles = new Map<string, HandleState>();

  setScript(ticketId: string, script: FakeScript): void {
    this.scripts.set(ticketId, script);
  }

  async capabilities(): Promise<AgentAdapterCapabilities> {
    return { supportsFiles: false, supportsShell: false, supportsStreaming: true, supportsResume: false };
  }

  async startWorker(input: { ticket: TicketEnvelope; workspace?: Workspace; systemPolicy: string }): Promise<WorkerHandle> {
    const handle: WorkerHandle = {
      id: `fakeworker_${randomUUID()}`,
      ticketId: input.ticket.ticketId,
      runId: `fakerun_${randomUUID()}`,
    };
    this.handles.set(handle.id, { timers: [], stopped: false, listeners: [] });
    return handle;
  }

  async send(): Promise<void> {
    // The fake adapter does not model answering an in-flight question.
  }

  async observe(handle: WorkerHandle, onEvent: (event: WorkerEvent) => void): Promise<() => void> {
    const state = this.handles.get(handle.id);
    if (!state) throw new Error(`unknown handle: ${handle.id}`);
    state.listeners.push(onEvent);

    // A ticket with no scripted behaviour trivially succeeds. This keeps
    // the CLI's `tick`/`run --until-idle` usable for manual smoke-testing
    // without a real adapter; tests that want other behaviour always set an
    // explicit script.
    const script = this.scripts.get(handle.ticketId) ?? { kind: 'succeed' };
    const schedule = (event: WorkerEvent, delayMs: number) => {
      const timer = setTimeout(() => {
        if (!state.stopped) this.publish(state, event);
      }, delayMs);
      state.timers.push(timer);
    };

    switch (script.kind) {
      case 'succeed':
        schedule(
          {
            type: 'result_raw',
            raw: {
              status: 'done',
              summary: 'fake success',
              artifacts: [],
              checks: [],
              blockers: [],
              questions: [],
            },
            usage: script.usage,
          },
          script.delayMs ?? 0
        );
        break;

      case 'retryable_failure':
        schedule(
          { type: 'failure', message: script.message ?? 'fake retryable failure', retryable: true, usage: script.usage },
          script.delayMs ?? 0
        );
        break;

      case 'question': {
        const delay = script.delayMs ?? 0;
        schedule({ type: 'question', message: script.message ?? 'fake question' }, delay);
        schedule(
          {
            type: 'result_raw',
            raw: {
              status: 'done',
              summary: 'fake success after question',
              artifacts: [],
              checks: [],
              blockers: [],
              questions: [],
            },
          },
          delay + 1
        );
        break;
      }

      case 'needs_user_decision':
        schedule(
          {
            type: 'result_raw',
            raw: {
              status: 'needs_user_decision',
              summary: 'fake needs a decision',
              artifacts: [],
              checks: [],
              blockers: script.blockers ?? ['fake blocker'],
              questions: [],
            },
            usage: script.usage,
          },
          script.delayMs ?? 0
        );
        break;

      case 'malformed_result':
        // Deliberately missing required fields so validateWorkerResult rejects it.
        schedule({ type: 'result_raw', raw: { summary: 'oops, no status field' } }, script.delayMs ?? 0);
        break;

      case 'progress':
        schedule({ type: 'progress', message: script.message ?? 'fake progress', costUsd: script.costUsd }, script.delayMs ?? 0);
        break;

      case 'hang':
        // Never emit anything; the run only ends when stop()/destroy() is called.
        break;
    }

    return () => {
      state.listeners = state.listeners.filter((l) => l !== onEvent);
      for (const timer of state.timers) clearTimeout(timer);
      state.timers = [];
    };
  }

  async stop(handle: WorkerHandle): Promise<void> {
    const state = this.handles.get(handle.id);
    if (!state) return;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers = [];
    if (state.stopped) return;
    state.stopped = true;

    // Fidelity rule (batch-5-spec.md section 1 ruling 1): the real adapter's
    // killed process still resolves its own `wait()` promise and publishes
    // its own terminal outcome, independent of why it was stopped (see
    // claudeCli.ts's `managed.wait().then(...)`, which always runs, and
    // `stop()`'s own multi-second killTree grace period, which is why the
    // real event lands well after stop()'s caller has moved on). Deferred to
    // a later macrotask, not published inline, so that a caller's own
    // synchronous follow-up (e.g. scheduler.ts's budget-stop branch
    // recording `budget_exceeded` right after `await stop()`) always
    // commits first -- exactly the ordering that produced
    // batch-4-closeout.md section 2's crash, which this fake never
    // reproduced before because it just went silent on stop().
    state.postStopTimer = setTimeout(() => {
      state.postStopTimer = undefined;
      this.publish(state, { type: 'failure', message: 'worker process was stopped after being killed', retryable: true });
    }, 0);
  }

  async destroy(handle: WorkerHandle): Promise<void> {
    const state = this.handles.get(handle.id);
    if (state?.postStopTimer) {
      clearTimeout(state.postStopTimer);
      state.postStopTimer = undefined;
    }
    await this.stop(handle);
    this.handles.delete(handle.id);
  }

  private publish(state: HandleState, event: WorkerEvent): void {
    for (const listener of state.listeners) listener(event);
  }
}

import type { Db } from '../db/index.ts';
import { listEventsForEntity, listEventsForProject, listRunsForTicket } from '../store.ts';
import type { EventRow, RunStatus } from '../types.ts';

// `activity`: the event log for a ticket or a whole project, collapsed by
// default (internal events hidden) with `--all` to see everything,
// including the internal events the daemon uses to keep itself honest but
// that nobody asked to watch.

// Ruling 7 (batch-15-spec.md section 3, Role A item 1): the pure function
// mapping a tool name (plus, for Bash, its command text) to the activity
// state a person watching the board should see. Total and side-effect
// free -- every branch has a defined answer, including a tool name this
// table has never heard of, so a caller never has to guard a throw.
export type ActivityState = 'reading' | 'writing' | 'running' | 'testing' | 'finishing' | 'reporting';

// Word-boundary matching, not a bare substring check -- a script named
// `attestation.sh` contains the letters "test" but names no real test
// runner. Covers the common JS/Python/Go/Rust/.NET runners this project's
// own `pnpm test` convention and its likely neighbours would name.
const TEST_RUNNER_COMMAND_PATTERN =
  /(^|[\s;&|])((pnpm|npm|yarn)\s+(run\s+)?test|pytest|jest|vitest|mocha|rspec|go\s+test|cargo\s+test|dotnet\s+test)(\s|$)/i;

export function classifyToolActivity(tool: string | undefined, command?: string): ActivityState {
  if (!tool) return 'reporting';
  switch (tool) {
    case 'Read':
    case 'Grep':
    case 'Glob':
      return 'reading';
    case 'Edit':
    case 'Write':
      return 'writing';
    case 'Bash':
      return command !== undefined && TEST_RUNNER_COMMAND_PATTERN.test(command) ? 'testing' : 'running';
    case 'StructuredOutput':
      return 'finishing';
    default:
      return 'running';
  }
}

// Adapts `classifyToolActivity` to the one signal actually available today:
// the adapter's own free-text `message` field on a `progress` WorkerEvent.
// Neither `adapters/claudeCli.ts` nor `adapters/fakeAdapter.ts` is one of
// this role's files, and `WorkerEvent`'s `progress` variant (types.ts) is
// deliberately NOT extended with a structured `tool`/`command` field here --
// an optional field no adapter populates is inert machinery that reads as a
// feature it isn't (the same defect class as batch 14's generator-version
// field, present as a string but inert). Parsing `describeProgress`'s own
// documented convention (`tool_use: <name>`) works with both adapters
// completely unmodified, today.
//
// Batch 15 addendum 3 (ruling 14): testing IS live. The raw command never
// reaches this layer, by design -- a Bash command line is the likeliest
// place in this system for a secret to appear, and this message is
// persisted, replayed over the stream, and rendered in a browser,
// permanently. Instead, claudeCli.ts's `describeProgress` sources the
// test-runner question itself, from its own `isTestRunnerCommand`, and
// emits the fixed marker `tool_use: Bash (test runner)` -- this function
// reads that marker back, never a command.
const TOOL_USE_MESSAGE_PATTERN = /^tool_use: (\S+)/;
const BASH_TEST_RUNNER_MESSAGE = 'tool_use: Bash (test runner)';

// Exported separately from classifyProgressMessage below (rather than kept
// as that function's own private step) so scheduler.ts can persist the raw
// tool name on the `worker_progress` event alongside the derived state --
// two different readers (a person watching the board, and something that
// wants to know exactly which tool ran) get two different fields instead of
// one having to re-derive the other from a state enum that has already
// thrown the tool name away. Deliberately returns 'Bash' for the marker
// variant too -- the marker only ever refines Bash's own state, not the
// tool identity.
export function parseProgressTool(message: string): string | undefined {
  return TOOL_USE_MESSAGE_PATTERN.exec(message)?.[1];
}

export function classifyProgressMessage(message: string): ActivityState {
  if (message === BASH_TEST_RUNNER_MESSAGE) return 'testing';
  return classifyToolActivity(parseProgressTool(message));
}

export function buildActivity(
  db: Db,
  opts: { projectId?: string; ticketId?: string; all: boolean }
): EventRow[] {
  const events = opts.ticketId
    ? listEventsForEntity(db, 'ticket', opts.ticketId)
    : listEventsForProject(db, opts.projectId ?? '');
  return opts.all ? events : events.filter((e) => e.visibility !== 'internal');
}

// Ticket id (the entity id) first on every line.
export function formatActivity(events: EventRow[]): string {
  if (events.length === 0) return '(no activity)';
  return events.map((e) => `${e.entityId}\t${e.eventType}\t${e.visibility}\t${e.createdAt}`).join('\n');
}

export interface RunProgressEvent {
  message: string;
  tool: string | null;
  state: ActivityState;
  costUsd?: number;
  at: string;
  sequence: number;
}

export interface RunProgress {
  runId: string;
  runStatus: RunStatus;
  /** The run's own most recent worker_progress event, or null if it has never reported one. */
  latest: RunProgressEvent | null;
}

// Ruling 7 item 1: "GET /tickets/{id}/progress returning the latest
// progress events per run" -- one entry per run this ticket has EVER had
// (listRunsForTicket, oldest first), each independently reduced to its own
// most recent worker_progress event. Deliberately not just "the latest
// progress event across the whole ticket": an exhausted, retried ticket's
// earlier runs each have their own history, and collapsing them into one
// global latest would silently lose which attempt a given tool call
// belonged to.
export function buildTicketProgress(db: Db, ticketId: string): RunProgress[] {
  return listRunsForTicket(db, ticketId).map((run) => {
    const events = listEventsForEntity(db, 'run', run.id).filter((e) => e.eventType === 'worker_progress');
    const last = events.at(-1);
    let latest: RunProgressEvent | null = null;
    if (last) {
      const payload = last.payload as { message?: string; tool?: string | null; state?: ActivityState; costUsd?: number };
      latest = {
        message: payload.message ?? '',
        tool: payload.tool ?? null,
        state: payload.state ?? 'reporting',
        costUsd: payload.costUsd,
        at: last.createdAt,
        sequence: last.sequence,
      };
    }
    return { runId: run.id, runStatus: run.status, latest };
  });
}

export function formatTicketProgress(progress: RunProgress[]): string {
  if (progress.length === 0) return '(no runs yet)';
  return progress
    .map((p) => {
      if (!p.latest) return `${p.runId}\t${p.runStatus}\tno progress reported yet`;
      const tool = p.latest.tool ? ` (${p.latest.tool})` : '';
      return `${p.runId}\t${p.runStatus}\t${p.latest.state}${tool}\t${p.latest.message}\t${p.latest.at}`;
    })
    .join('\n');
}

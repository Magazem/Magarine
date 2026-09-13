import { MANAGER_COMMAND_SCHEMA_DESCRIPTION } from './proposal.ts';
import { reasonFor } from './commands/inbox.ts';
import type { Db } from './db/index.ts';
import { getDependencies, listEventsForProject, listTickets, resolveManagerModel, resolveMaxBudgetUsd, ticketSpendUsd } from './store.ts';
import type { Project, Ticket, TicketEnvelope, TicketKind, TicketStatus } from './types.ts';

// The Manager's envelope, per docs/strategy/batch-9-spec.md section 2:
// "the project brief, the mission text, the current board in compact form
// (every ticket with id, title, status, kind, dependencies, attempts,
// spend), the decision log, the last five final failures with their
// reasons, and the command schema. Nothing else: no transcripts, no worker
// prompts." This module never imports envelope.ts (the WORK-ticket prompt
// builder) or reads a `WorkerResult`'s `summary`/`artifacts`/`checks` off
// any event -- see managerEnvelope.test.ts's negative tests for what that
// buys: a distinctive string planted in another ticket's own description,
// or in a completed dependency's summary, can be proven absent from the
// Manager's rendered prompt by construction, not by convention.
//
// "An orchestrator that accumulates context is the expensive idle agent
// this project has designed against from the start" -- the Manager rebuilds
// this from the database on every invocation (batch 0's cost ruling), so
// nothing here is ever cached or carried forward from a previous Manager
// run either.

export interface ManagerBoardEntry {
  id: string;
  title: string;
  status: TicketStatus;
  kind: TicketKind;
  dependsOn: string[];
  attemptCount: number;
  maxAttempts: number;
  spendUsd: number;
}

export interface ManagerFailureEntry {
  ticketId: string;
  title: string;
  reason: string;
}

export interface ManagerBriefing {
  projectBrief: string;
  mission: string;
  board: ManagerBoardEntry[];
  decisionLog: string[];
  recentFailures: ManagerFailureEntry[];
}

const RECENT_FAILURES_LIMIT = 5;

// The project's decision log, in the same "Q: ... — A: ..." shape
// envelope.ts's buildEnvelope produces for a work ticket's
// `relevantDecisions` -- a project-level fact (what the owner has already
// decided), not worker output, so the same rendering is appropriate for
// both. Written independently here (not imported from envelope.ts) so the
// Manager's envelope path shares no code, and therefore no future drift,
// with the worker-prompt path it must never reach into.
function buildDecisionLog(db: Db, projectId: string): string[] {
  return listEventsForProject(db, projectId)
    .filter((e) => e.eventType === 'user_decision')
    .map((e) => {
      const p = e.payload as { question?: string; answer?: string };
      return `Q: ${p.question ?? ''} — A: ${p.answer ?? ''}`;
    });
}

// The last five `worker_failed_final` events project-wide (across every
// ticket, work or manager), each reduced to {ticketId, title, reason} --
// `reasonFor` (commands/inbox.ts) is the same curated one-line extraction
// the inbox already shows a person, never the raw payload (see that
// function's doc comment for why that is the right boundary, not "no
// worker-originated text at all").
function buildRecentFailures(db: Db, projectId: string): ManagerFailureEntry[] {
  const tickets = new Map(listTickets(db, projectId).map((t) => [t.id, t]));
  return listEventsForProject(db, projectId)
    .filter((e) => e.eventType === 'worker_failed_final')
    .slice(-RECENT_FAILURES_LIMIT)
    .map((e) => ({
      ticketId: e.entityId,
      title: tickets.get(e.entityId)?.title ?? e.entityId,
      reason: reasonFor(e.eventType, e.payload),
    }));
}

function buildBoard(db: Db, projectId: string): ManagerBoardEntry[] {
  return listTickets(db, projectId).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    kind: t.kind,
    dependsOn: getDependencies(db, t.id)
      .filter((d) => d.dependencyType === 'blocks')
      .map((d) => d.dependsOnTicketId),
    attemptCount: t.attemptCount,
    maxAttempts: t.maxAttempts,
    spendUsd: ticketSpendUsd(db, t.id),
  }));
}

// The structured content, independent of how it is eventually rendered to
// text -- kept separate from `buildManagerEnvelope` below so a test can
// assert on exactly these fields without parsing prose.
export function buildManagerBriefing(db: Db, project: Project, ticket: Ticket): ManagerBriefing {
  return {
    projectBrief: project.brief ?? '',
    // The mission is the ticket's own description -- set once, at `plan`
    // time (see commands/plan.ts), and never rewritten; a Manager rebuilt
    // for the SAME ticket (e.g. a retry) sees the identical mission text
    // every time, which is the point of rebuilding from the database
    // instead of carrying a session forward.
    mission: ticket.description ?? '',
    board: buildBoard(db, project.id),
    decisionLog: buildDecisionLog(db, project.id),
    recentFailures: buildRecentFailures(db, project.id),
  };
}

function renderBoardLine(entry: ManagerBoardEntry): string {
  const deps = entry.dependsOn.length > 0 ? entry.dependsOn.join(', ') : '(none)';
  return `- ${entry.id}\t${entry.status}\t${entry.kind}\t"${entry.title}"\tdepends on: ${deps}\tattempts ${entry.attemptCount}/${entry.maxAttempts}\tspend $${entry.spendUsd.toFixed(2)}`;
}

// Turns the structured briefing into the text handed to the worker prompt
// builder as this ticket's `description` (TicketEnvelope has no dedicated
// field for "board"/"failures"/"schema" -- see buildManagerEnvelope). Pure
// function, same discipline as envelope.ts's buildWorkerPrompt: nothing
// beyond what `briefing` already carries.
export function renderManagerBrief(briefing: ManagerBriefing): string {
  const sections: string[] = [];

  sections.push(`Mission:\n${briefing.mission || '(none provided)'}`);

  sections.push(
    briefing.board.length > 0
      ? `Current board (${briefing.board.length} ticket(s)):\n${briefing.board.map(renderBoardLine).join('\n')}`
      : 'Current board: (no tickets yet)'
  );

  sections.push(
    briefing.decisionLog.length > 0
      ? `Decision log:\n${briefing.decisionLog.map((d) => `- ${d}`).join('\n')}`
      : 'Decision log: (none)'
  );

  sections.push(
    briefing.recentFailures.length > 0
      ? `Last ${briefing.recentFailures.length} final failure(s):\n${briefing.recentFailures
          .map((f) => `- ${f.ticketId} "${f.title}": ${f.reason}`)
          .join('\n')}`
      : 'Recent final failures: (none)'
  );

  sections.push(`Command schema:\n${MANAGER_COMMAND_SCHEMA_DESCRIPTION}`);

  return sections.join('\n\n');
}

const MANAGER_EXPECTED_OUTPUT_FORMAT =
  'Write .orchestrator/result.json matching the worker result contract (status/summary/artifacts/checks/blockers/questions), the same as any worker. ' +
  'Separately, write .orchestrator/proposal.json containing your proposal (the command schema above), and declare it as an artifact in result.json: ' +
  '{ "kind": "file", "path": ".orchestrator/proposal.json" }. Report status "done" once proposal.json is written and reflects your actual plan -- ' +
  'the daemon validates and applies it independently; a proposal that fails validation is treated as a malformed result, retryable.';

// Builds the manager ticket's TicketEnvelope -- deliberately the SAME type
// every work ticket uses, so the SAME adapter (claudeCli.ts) and prompt
// builder (envelope.ts's buildWorkerPrompt) run it unmodified: "A Manager
// run is a ticket... runs through the same adapter as any worker... It has
// no special powers" (batch-9-spec.md section 2). Everything Manager-
// specific (mission, board, decision log, failures, command schema) is
// folded into `description`/`expectedOutputFormat`, the two free-text
// fields buildWorkerPrompt already renders generically; `completedDependencies`
// and `allowedTools` are always empty, since a Manager ticket has neither.
export function buildManagerEnvelope(db: Db, ticket: Ticket, project: Project): TicketEnvelope {
  const briefing = buildManagerBriefing(db, project, ticket);
  return {
    ticketId: ticket.id,
    projectBrief: briefing.projectBrief,
    relevantDecisions: briefing.decisionLog,
    title: ticket.title,
    description: renderManagerBrief(briefing),
    acceptanceCriteria: [],
    completedDependencies: [],
    allowedTools: [],
    expectedOutputFormat: MANAGER_EXPECTED_OUTPUT_FORMAT,
    maxBudgetUsd: resolveMaxBudgetUsd(project, ticket),
    model: resolveManagerModel(project),
  };
}

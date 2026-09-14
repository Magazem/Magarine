import { MANAGER_COMMAND_SCHEMA_DESCRIPTION } from './proposal.ts';
import { reasonFor } from './commands/inbox.ts';
import type { Db } from './db/index.ts';
import { readScopeText } from './manager.ts';
import { inputRateUsd, knownModelIds } from './pricing.ts';
import {
  getDependencies,
  listArtifactsForTicket,
  listEventsForProject,
  listTickets,
  resolveManagerModel,
  resolveMaxBudgetUsd,
  ticketSpendUsd,
} from './store.ts';
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

// Batch 11 item 3: one entry per owner `discuss` message or Manager
// `manager_reply`/`manager_assessment` artifact, across every manager
// ticket this project has ever run -- not just the current one -- sorted
// chronologically so a re-invocation sees the whole conversation, the same
// "rebuild from the database every time" discipline as the rest of this
// briefing. `text` for a `manager` entry is the artifact's own `path` field,
// which by this project's established convention (see captureArtifacts in
// scheduler.ts: only `kind === 'file'` is ever treated as a real filesystem
// path) carries the reply/assessment TEXT itself for these two kinds, not a
// location on disk.
export interface ManagerConversationEntry {
  speaker: 'owner' | 'manager';
  text: string;
  createdAt: string;
}

export interface ManagerBriefing {
  projectBrief: string;
  mission: string;
  board: ManagerBoardEntry[];
  decisionLog: string[];
  recentFailures: ManagerFailureEntry[];
  /** Batch 11 item 1: the CURRENT scope document, read fresh off disk on every invocation (manager.ts's readScopeText) -- empty string for a project with no scope_path set, or whose file is genuinely empty. */
  scopeText: string;
  /** Batch 11 item 3. */
  conversation: ManagerConversationEntry[];
  /** Batch 11 item 2: true when the scope is empty OR the board has no work tickets yet (the manager ticket about to run is always on the board itself by this point -- see buildBoard's own doc comment -- so this filters to `kind === 'work'`). Drives renderManagerBrief's interview-mode framing; not itself a hard gate on what the Manager may do (it may still return questions only or propose, per its own judgement) -- the prompt frames the two outcomes, it does not enforce one. */
  isFreshProject: boolean;
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

// Batch 11 item 3: interleaves the owner's own `discuss` events (recorded by
// manager.ts's discussProject) with the Manager's own `manager_reply`/
// `manager_assessment` artifacts (declared by a completed manager ticket's
// own result.json, captured by scheduler.ts's ordinary artifact pipeline),
// in chronological order, across the project's entire history -- not scoped
// to the current manager ticket, since a conversation spans many of them.
function buildConversation(db: Db, projectId: string): ManagerConversationEntry[] {
  const entries: ManagerConversationEntry[] = [];

  for (const e of listEventsForProject(db, projectId)) {
    if (e.eventType !== 'discuss') continue;
    const p = e.payload as { message?: string };
    entries.push({ speaker: 'owner', text: p.message ?? '', createdAt: e.createdAt });
  }

  for (const ticket of listTickets(db, projectId)) {
    if (ticket.kind !== 'manager') continue;
    for (const artifact of listArtifactsForTicket(db, ticket.id)) {
      if (artifact.kind !== 'manager_reply' && artifact.kind !== 'manager_assessment') continue;
      entries.push({ speaker: 'manager', text: artifact.pathOrUri, createdAt: artifact.createdAt });
    }
  }

  return entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
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
  const board = buildBoard(db, project.id);
  const scopeText = readScopeText(project);
  return {
    projectBrief: project.brief ?? '',
    // The mission is the ticket's own description -- set once, at `plan`
    // time (see commands/plan.ts), and never rewritten; a Manager rebuilt
    // for the SAME ticket (e.g. a retry) sees the identical mission text
    // every time, which is the point of rebuilding from the database
    // instead of carrying a session forward.
    mission: ticket.description ?? '',
    board,
    decisionLog: buildDecisionLog(db, project.id),
    recentFailures: buildRecentFailures(db, project.id),
    scopeText,
    conversation: buildConversation(db, project.id),
    isFreshProject: scopeText.trim().length === 0 || board.filter((b) => b.kind === 'work').length === 0,
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
// Batch 11 item 2: the two framing paragraphs -- interview mode (fresh
// scope/board) versus the ordinary discuss/re-plan mode. Prose only: this
// does not gate what the Manager may actually do (validateProposal enforces
// the real rules), it tells the model which of the two intended outcomes
// applies right now, per route-revision-scope-document.md section 4 item 1:
// "the Manager's first invocation may return only questions and no
// proposal; that is the intended outcome, not a stall."
const INTERVIEW_MODE_FRAMING =
  'This project is in INTERVIEW MODE: its scope document is empty, or it has no work tickets on the board yet. ' +
  'Assess first, as a manager_assessment artifact (see below): what you understood from the scope document and the conversation so far, ' +
  'what you would cut, and the questions you still need answered. Returning ONLY questions (via request_user_decision commands, with no ' +
  'create_ticket commands) is a valid, EXPECTED outcome here -- it is a success, not a stall or a failure. Propose tickets only once you ' +
  'state you have enough information, or the owner\'s latest message explicitly asks you to propose now.';

const REPLAN_MODE_FRAMING =
  'This project already has a scope document and/or tickets on the board. If the owner sent a message, reply to it as a manager_reply ' +
  'artifact (see below). You may propose changes to the existing board -- create_ticket, cancel_ticket, update_ticket, add_dependency, ' +
  'change_priority -- correct the scope document via update_scope if it needs it, or ask a further question via request_user_decision. ' +
  'A proposal with an empty commands array is valid when you have nothing to change right now.';

// Batch 12 item 3 (batch-12-spec.md section 1 ruling 3): "The envelope
// gains one short paragraph: the available models, what each is for in the
// architecture document's terms ... and their relative price as a ratio."
// Names every model by its exact id (rather than "the cheap one") so
// `create_ticket`/`update_ticket`'s own `model` field can be copied
// verbatim from this paragraph. The role assignment (mechanical/read-only,
// implementation/normal debugging, deep design) is the ruling's own
// wording, fixed at three tiers regardless of how many models
// `knownModelIds()` returns; the price-ratio line is generated FROM that
// list, so a model pricing.ts adds or removes is never missing from, or
// stale in, this paragraph -- see managerEnvelope.test.ts's own check that
// the paragraph names exactly pricing.ts's list, nothing more or less.
export function renderModelGuidance(): string {
  const ids = knownModelIds();
  const cheapest = Math.min(...ids.map(inputRateUsd));
  const ratioLine = ids
    .slice()
    .sort((a, b) => inputRateUsd(a) - inputRateUsd(b))
    .map((id) => `${id} ${(inputRateUsd(id) / cheapest).toFixed(1)}x`)
    .join(' : ');
  return (
    'Model guidance: you may set "model" on create_ticket/update_ticket to any of these models -- ' +
    `${ids.join(', ')}. Choose deliberately, not by default. claude-haiku-4-5-20251001 is for mechanical, ` +
    'read-only work; claude-sonnet-5 is for ordinary implementation and normal debugging; claude-opus-5 and ' +
    'claude-fable-5-1, the top-priced tier, are for deep design with real trade-offs to weigh. Relative price ' +
    `(input tokens, cheapest = 1x): ${ratioLine}. Whenever you set "model", "model_reason" is required -- a ` +
    'one-line justification for the choice, recorded on the ticket and shown on the board.'
  );
}

export function renderManagerBrief(briefing: ManagerBriefing): string {
  const sections: string[] = [];

  sections.push(briefing.isFreshProject ? INTERVIEW_MODE_FRAMING : REPLAN_MODE_FRAMING);

  sections.push(`Mission:\n${briefing.mission || '(none provided)'}`);

  sections.push(
    briefing.scopeText.trim().length > 0
      ? `Scope document:\n${briefing.scopeText}`
      : 'Scope document: (empty)'
  );

  sections.push(
    briefing.conversation.length > 0
      ? `Conversation so far:\n${briefing.conversation
          .map((c) => `- ${c.speaker === 'owner' ? 'Owner' : 'Manager'}: ${c.text}`)
          .join('\n')}`
      : 'Conversation so far: (none yet)'
  );

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

  sections.push(renderModelGuidance());

  return sections.join('\n\n');
}

const MANAGER_EXPECTED_OUTPUT_FORMAT =
  'Write .orchestrator/result.json matching the worker result contract (status/summary/artifacts/checks/blockers/questions), the same as any worker. ' +
  'If you are replying to the owner\'s latest message, declare an artifact { "kind": "manager_reply", "path": "<your reply text, verbatim>" } -- ' +
  'the "path" field carries the reply TEXT itself, not a filesystem path (this project\'s convention for non-"file" artifact kinds). ' +
  'If you are assessing a fresh project (interview mode), declare { "kind": "manager_assessment", "path": "<your assessment text, verbatim>" } instead, or as well. ' +
  'Separately, write .orchestrator/proposal.json containing your proposal (the command schema above -- an empty commands array with just a ' +
  'rationale is a valid proposal when you have nothing to propose yet), and declare it as an artifact in result.json: ' +
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

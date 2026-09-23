import { MANAGER_COMMAND_SCHEMA_DESCRIPTION } from './proposal.ts';
import { reasonFor } from './commands/inbox.ts';
import type { Db } from './db/index.ts';
import { lastManagerActivitySeq, workTicketsFinishedSince } from './autoManager.ts';
import { readScopeText } from './manager.ts';
import { inputRateUsd, isKnownModel, knownModelIds } from './pricing.ts';
import {
  getDependencies,
  listArtifactsForTicket,
  listEventsForEntity,
  listEventsForProject,
  listTickets,
  listWorkerProfiles,
  resolveManagerModel,
  resolveMaxBudgetUsd,
  ticketSpendUsd,
} from './store.ts';
import type { Project, Ticket, TicketEnvelope, TicketKind, TicketStatus } from './types.ts';
import { buildBoard as buildFullBoard, type BoardArtifact } from './commands/board.ts';

// The Manager's envelope, per docs/strategy/batch-9-spec.md section 2:
// "the project brief, the mission text, the current board in compact form
// (every ticket with id, title, status, kind, dependencies, attempts,
// spend), the decision log, the last five final failures with their
// reasons, and the command schema. Nothing else: no transcripts, no worker
// prompts." This module never imports envelope.ts (the WORK-ticket prompt
// builder) and never reads a worker's transcript or prompt.
//
// Batch 18 ruling 34 AMENDS that rule by exactly one section: "Since your last
// run" -- for each work ticket that reached DONE or FAILED since the Manager
// last acted, its status, the worker's own summary, its artefact list, the
// verifier's verdict (pass, or the failed criteria), attempts and spend. Those
// fields and nothing else: a Manager that cannot see what was delivered cannot
// judge whether the scope is met (the owner's "it only did phase 0"). Another
// ticket's description, a worker's prompt or transcript, a `checks` list still
// never reach it -- see managerEnvelope.test.ts's negative tests.
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

/** Batch 18 ruling 34: one work ticket that reached DONE or FAILED since the Manager last acted. */
export interface SinceLastRunEntry {
  ticketId: string;
  title: string;
  status: 'DONE' | 'FAILED';
  /** The worker's own summary of what it did; null when it gave none (a failure often has none). */
  summary: string | null;
  artifacts: BoardArtifact[];
  /** "pass" (the verifier approved it), "approved by the owner", or the failed criteria / final failure reason. */
  verdict: string;
  attempts: string;
  spendUsd: number;
}

export interface ManagerBriefing {
  /** Batch 18 ruling 34: this turn was created by the scheduler because the board drained, not by the owner. */
  automatic: boolean;
  /** Batch 18 ruling 34: "Since your last run". */
  sinceLastRun: SinceLastRunEntry[];
  projectBrief: string;
  mission: string;
  board: ManagerBoardEntry[];
  decisionLog: string[];
  recentFailures: ManagerFailureEntry[];
  /** Batch 11 item 1: the CURRENT scope document, read fresh off disk on every invocation (manager.ts's readScopeText) -- empty string for a project with no scope_path set, or whose file is genuinely empty. */
  scopeText: string;
  /** Ruling 29 (batch 16 addendum 5): whether that document EXISTS -- `absent` is not the same as present-and-empty, and the brief says so in one sentence instead of presenting an empty document. */
  scopeStatus: 'present' | 'absent';
  /** The scope document's path, for that sentence; null when the project has none. */
  scopePath: string | null;
  /** Batch 11 item 3. */
  conversation: ManagerConversationEntry[];
  /** Batch 19 mini-phase 2A (ruling 37): the roster paragraph -- REPLACES the old model-guidance paragraph. See renderRoster. */
  roster: string;
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
    .flatMap((e) => {
      // Ruling 36 (batch 19, mini-phase 2B): one `Q: — A:` line per entry of
      // `decisions` when present -- a `decide` call answering N pending
      // questions at once. An old-shape event (recorded before this ruling,
      // no `decisions` field, or an empty one) falls back to the single
      // `question`/`answer` pair exactly as it rendered before, unchanged.
      const p = e.payload as { question?: string; answer?: string; decisions?: Array<{ question: string; answer: string }> };
      if (p.decisions && p.decisions.length > 0) {
        return p.decisions.map((d) => `Q: ${d.question} — A: ${d.answer}`);
      }
      return [`Q: ${p.question ?? ''} — A: ${p.answer ?? ''}`];
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
      entries.push({ speaker: 'manager', text: artifact.text ?? '', createdAt: artifact.createdAt });
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

// Batch 18 ruling 34. The verdict is read off the ticket's own terminal event:
// a `review_approved` carrying a verifier run id is the verifier's pass; one
// without is the owner's approve; a FAILED ticket's is the board's own failure
// reason (which, for a verifier rejection, is the failed criteria verbatim).
function buildSinceLastRun(db: Db, project: Project, ticket: Ticket): SinceLastRunEntry[] {
  // The full board (artefacts, failure reasons, spend), not the compact one the brief prints.
  const fullBoard = buildFullBoard(db, project.id);
  const finished = workTicketsFinishedSince(db, project.id, lastManagerActivitySeq(db, project.id, ticket.id));
  return finished.map((t) => {
    const row = fullBoard.tickets.find((b) => b.id === t.id);
    const events = listEventsForEntity(db, 'ticket', t.id);
    const summaryEvent = events
      .filter((e) => e.eventType === 'worker_done_for_verification' || e.eventType === 'worker_needs_review' || e.eventType === 'worker_done')
      .at(-1);
    const summary =
      summaryEvent && typeof summaryEvent.payload === 'object' && summaryEvent.payload !== null
        ? ((summaryEvent.payload as { summary?: unknown }).summary as string | undefined)
        : undefined;
    const approved = events.filter((e) => e.eventType === 'review_approved').at(-1);
    const verdict =
      t.status === 'FAILED'
        ? (row?.lastFailureReason ?? 'failed')
        : approved
          ? (approved.payload as { verifierRunId?: unknown } | null)?.verifierRunId !== undefined
            ? 'pass (the verifier approved it)'
            : 'approved by the owner'
          : 'done (not verified)';
    return {
      ticketId: t.id,
      title: t.title,
      status: t.status as 'DONE' | 'FAILED',
      summary: typeof summary === 'string' && summary.length > 0 ? summary : null,
      artifacts: row?.artifacts ?? [],
      verdict,
      attempts: `${t.attemptCount}/${t.maxAttempts}`,
      spendUsd: row?.costUsd ?? 0,
    };
  });
}

// The structured content, independent of how it is eventually rendered to
// text -- kept separate from `buildManagerEnvelope` below so a test can
// assert on exactly these fields without parsing prose.
export function buildManagerBriefing(db: Db, project: Project, ticket: Ticket): ManagerBriefing {
  const board = buildBoard(db, project.id);
  // Throws on an unreadable file (ruling 29): the scheduler's readiness check
  // pauses such a project before any Manager run is built, so this is defence
  // in depth -- an error must never become an empty document.
  const scope = readScopeText(project);
  const scopeText = scope.text;
  return {
    automatic: ticket.automatic,
    sinceLastRun: buildSinceLastRun(db, project, ticket),
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
    scopeStatus: scope.status,
    scopePath: project.scopePath,
    conversation: buildConversation(db, project.id),
    isFreshProject: scopeText.trim().length === 0 || board.filter((b) => b.kind === 'work').length === 0,
    roster: renderRoster(db),
  };
}

function renderSinceLastRunEntry(e: SinceLastRunEntry): string {
  const artifacts = e.artifacts.length > 0 ? e.artifacts.map((a) => `(${a.kind}) ${a.content}`).join('; ') : '(none)';
  return [
    `- ${e.ticketId} "${e.title}" ${e.status} (attempts ${e.attempts}, spend $${e.spendUsd.toFixed(2)})`,
    `  Summary: ${e.summary ?? '(none given)'}`,
    `  Artefacts: ${artifacts}`,
    `  Verdict: ${e.verdict}`,
  ].join('\n');
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

// Batch 18 ruling 34: no owner message is waiting on this turn; the board
// drained and the daemon asked the Manager to look at what was delivered.
const AUTOMATIC_TURN_FRAMING =
  'This is an AUTOMATIC turn: the board has drained and no owner message is waiting. ' +
  'Compare what was delivered (see "Since your last run" below) against the scope document, then do exactly one of: ' +
  'propose the next tickets; return an empty proposal whose rationale states that the scope is met; or ask the owner via request_user_decision. ' +
  'Do not invent work to seem busy: an empty proposal is the right answer when the scope is met.';

const REPLAN_MODE_FRAMING =
  'This project already has a scope document and/or tickets on the board. If the owner sent a message, reply to it as a manager_reply ' +
  'artifact (see below). You may propose changes to the existing board -- create_ticket, cancel_ticket, update_ticket, add_dependency, ' +
  'change_priority -- correct the scope document via update_scope if it needs it, or ask a further question via request_user_decision. ' +
  'A proposal with an empty commands array is valid when you have nothing to change right now.';

// Batch 19 mini-phase 2A (ruling 37, batch-16 addendum 1 section 3): REPLACES
// renderModelGuidance -- "the envelope's model guidance paragraph the Manager
// reads today ... is already a description of roles by tier. A profile makes
// that paragraph into rows the owner can see and rename." One line per
// NON-RETIRED profile (store.ts's listWorkerProfiles already excludes
// retired rows), naming its model and the same price-ratio-vs-cheapest-known
// figure the old paragraph computed, plus its purpose -- so
// `create_ticket`/`update_ticket`'s own `profile` field can be copied
// verbatim from a line here. Model guidance survives only as the closing
// sentence: a bare "model" is legal only for a ticket with no profile.
// managerEnvelope.test.ts's own exact-names check: adding or retiring a
// profile changes this paragraph, and it names exactly the non-retired ones.
export function renderRoster(db: Db): string {
  const profiles = listWorkerProfiles(db);
  const ids = knownModelIds();
  const cheapest = Math.min(...ids.map(inputRateUsd));
  const ratio = (model: string): string => (isKnownModel(model) ? `${(inputRateUsd(model) / cheapest).toFixed(1)}x` : 'unknown price');
  const rosterLines =
    profiles.length > 0
      ? profiles.map((p) => `- ${p.name} (${p.model}, ${ratio(p.model)} the cheapest known model's input price): ${p.purpose}`).join('\n')
      : '(no worker profiles exist yet)';
  return (
    `Roster: assign "profile" on create_ticket/update_ticket to one of these worker profiles by name (case-insensitive), with a one-line "profile_reason" -- the Manager's own justification, recorded on the ticket and shown on the board:\n${rosterLines}\n\n` +
    'A bare "model" (with "model_reason") on create_ticket/update_ticket is only valid for a ticket that has no profile -- once a ticket has a profile, its model comes from the profile.'
  );
}

export function renderManagerBrief(briefing: ManagerBriefing): string {
  const sections: string[] = [];

  if (briefing.automatic) sections.push(AUTOMATIC_TURN_FRAMING);
  sections.push(briefing.isFreshProject ? INTERVIEW_MODE_FRAMING : REPLAN_MODE_FRAMING);

  sections.push(`Mission:\n${briefing.mission || '(none provided)'}`);

  sections.push(
    briefing.scopeText.trim().length > 0
      ? `Scope document:\n${briefing.scopeText}`
      : briefing.scopeStatus === 'absent' && briefing.scopePath
        ? `Scope document: the scope document at ${briefing.scopePath} does not exist yet.`
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
    briefing.sinceLastRun.length > 0
      ? `Since your last run (${briefing.sinceLastRun.length} work ticket(s) finished):\n${briefing.sinceLastRun.map(renderSinceLastRunEntry).join('\n')}`
      : 'Since your last run: (no work ticket has finished)'
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

  sections.push(briefing.roster);

  return sections.join('\n\n');
}

const MANAGER_EXPECTED_OUTPUT_FORMAT =
  'Write .orchestrator/result.json matching the worker result contract (status/summary/artifacts/checks/blockers/questions), the same as any worker. ' +
  'If you are replying to the owner\'s latest message, declare an artifact { "kind": "manager_reply", "text": "<your reply text, verbatim>" } -- ' +
  '"manager_reply" (like "manager_assessment", "text" and "reference") carries its content in a "text" field, never "path"; "path" is reserved for ' +
  'kind "file", a real location on disk. ' +
  'If you are assessing a fresh project (interview mode), declare { "kind": "manager_assessment", "text": "<your assessment text, verbatim>" } instead, or as well. ' +
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
    model: resolveManagerModel(db, project),
    // Ruling 41: lets an adapter know this is a Manager run (the fake adapter
    // refuses one it has no script for, rather than pretending to succeed).
    runKind: 'manager',
  };
}

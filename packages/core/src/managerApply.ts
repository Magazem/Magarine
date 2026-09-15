import { withTransaction, type Db } from './db/index.ts';
import { resolveReadiness } from './dependencies.ts';
import { readScopeText, writeScopeText } from './manager.ts';
import { classify } from './policy.ts';
import { validateProposal, type ManagerCommand, type ProposalBoard } from './proposal.ts';
import { recordTicketTransition } from './stateMachine.ts';
import {
  addDependency,
  createTicket,
  getDependencies,
  getProject,
  insertEvent,
  listTickets,
  setTicketPriority,
  updateTicketFields,
} from './store.ts';
import type { Project, Ticket } from './types.ts';

// The post-success step for manager tickets, per docs/strategy/batch-9-spec.md
// section 2: "Validation and application, in one transaction... Everything
// applied is recorded as one `manager_proposal_applied` activity event
// carrying the full proposal, so replay reproduces it." scheduler.ts's
// `result_raw`/`done` branch calls this instead of the ordinary
// worker_done path when `ticket.kind === 'manager'`.

export interface CreatedTicketRecord {
  title: string;
  ticketId: string;
}

// The exact shape recorded on the `manager_proposal_applied` event and
// replayed by managerApply.test.ts's replay test -- `created` is what makes
// replay possible at all: `createTicket` generates a random id
// (`newId('tkt')`), so a payload carrying only the proposal's own titles
// could never tell which resulting ticket is which. Ticket ROWS themselves
// are not event-sourced in this codebase (only `tickets.status` is, via
// stateMachine.ts); this payload is what lets a reader reconstruct what a
// Manager run DID despite that, the same way any other event payload here
// records the past rather than being replayed to reconstruct live state.
export interface ManagerProposalAppliedPayload {
  rationale: string;
  commands: ManagerCommand[];
  created: CreatedTicketRecord[];
}

export type ApplyManagerProposalOutcome =
  | { outcome: 'applied'; ticketStatus: 'DONE' | 'BLOCKED'; created: CreatedTicketRecord[] }
  | { outcome: 'malformed'; errors: string[] };

export interface ApplyManagerProposalTestHooks {
  /**
   * Test-only: throws a synthetic error once this many of the proposal's
   * OWN commands (create_ticket, add_dependency, change_priority,
   * update_project_brief, request_user_decision -- not the internal
   * new-ticket-dependency wiring pass) have been applied, to prove the
   * whole transaction rolls back rather than leaving a partial board. See
   * managerApply.test.ts's "rollback" tests.
   */
  failAfterCommand?: number;
}

function buildProposalBoard(db: Db, projectId: string): ProposalBoard {
  const tickets = listTickets(db, projectId);
  const dependencies = tickets.flatMap((t) =>
    getDependencies(db, t.id)
      .filter((d) => d.dependencyType === 'blocks')
      .map((d) => ({ ticketId: t.id, dependsOnTicketId: d.dependsOnTicketId }))
  );
  return {
    tickets: tickets.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status })),
    dependencies,
    hasScopePath: getProject(db, projectId)!.scopePath != null,
  };
}

// A one-line, honest summary of a scope rewrite -- a line count before and
// after, not a fabricated diff (this file has no diff library and inventing
// a line-by-line comparison for a decision-log entry is more machinery than
// the spec asks for: "a one-line summary of what changed"). Recorded on the
// `scope_updated` event so the decision log (and, eventually, Role Q's page)
// shows that the scope changed and roughly how much, without duplicating the
// document's full text a second time in the event payload.
function summarizeScopeChange(before: string, after: string): string {
  const countLines = (text: string) => text.split('\n').filter((l) => l.trim().length > 0).length;
  const beforeLines = countLines(before);
  const afterLines = countLines(after);
  if (before.trim().length === 0) return `scope written (${afterLines} line(s))`;
  if (after.trim().length === 0) return `scope cleared (was ${beforeLines} line(s))`;
  return `scope updated (${beforeLines} → ${afterLines} line(s))`;
}

// Re-resolves a create_ticket.depends_on reference to a real ticket id,
// using the pre-existing board plus the title->id map this application has
// built up so far -- the identical resolution rule validateProposal already
// checked, walked again now that new ids actually exist to resolve titles
// to. Never expected to fail: every reference reaching this point already
// passed validateProposal against the SAME board (read once, at the top of
// applyManagerProposal, before this transaction starts). Throwing here
// rather than silently skipping the edge is deliberate -- an unresolvable
// reference at this point means validation and application have drifted out
// of sync with each other, a defect in this file, not in the proposal, and
// the transaction wrapping this call rolls back on any throw regardless.
function resolveDependsOnRef(ref: string, existingIds: Set<string>, createdByTitle: Map<string, string>): string {
  if (existingIds.has(ref)) return ref;
  const created = createdByTitle.get(ref);
  if (created) return created;
  throw new Error(`internal error: depends_on reference "${ref}" did not resolve during application despite passing validation`);
}

export function applyManagerProposal(
  db: Db,
  ticket: Ticket,
  project: Project,
  runId: string,
  rawProposal: unknown,
  testHooks: ApplyManagerProposalTestHooks = {}
): ApplyManagerProposalOutcome {
  const board = buildProposalBoard(db, project.id);
  const validated = validateProposal(rawProposal, board);
  if (!validated.valid) {
    return { outcome: 'malformed', errors: validated.errors };
  }

  const { commands, rationale } = validated.data;
  const existingIds = new Set(board.tickets.map((t) => t.id));

  return withTransaction(db, () => {
    let commandsApplied = 0;
    const guard = (): void => {
      commandsApplied += 1;
      if (testHooks.failAfterCommand !== undefined && commandsApplied > testHooks.failAfterCommand) {
        throw new Error(`test-injected failure after ${testHooks.failAfterCommand} command(s) applied`);
      }
    };

    const createdByTitle = new Map<string, string>();
    const created: CreatedTicketRecord[] = [];

    // Pass 1: create every new ticket, with no dependency edges yet -- a
    // create_ticket may depend on ANOTHER create_ticket appearing later in
    // `commands`, so every new ticket needs a real id before any depends_on
    // edge (pass 2) can be added.
    for (const c of commands) {
      if (c.type !== 'create_ticket') continue;
      guard();
      // Batch 13 ruling 1a: no workspaceType passed here at all -- the
      // command no longer carries the field (see proposal.ts), so
      // createTicket's own default (DIRECTORY, store.ts) applies.
      const newTicket = createTicket(db, {
        projectId: project.id,
        title: c.title,
        description: c.description,
        acceptanceCriteria: c.acceptance_criteria,
        model: c.model,
        modelReason: c.model_reason,
        maxBudgetUsdOverride: c.max_budget_usd,
      });
      createdByTitle.set(c.title, newTicket.id);
      created.push({ title: c.title, ticketId: newTicket.id });
    }

    // Pass 2: create_ticket.depends_on edges, now that every new ticket has
    // a real id to be the target of one.
    for (const c of commands) {
      if (c.type !== 'create_ticket' || !c.depends_on) continue;
      const fromId = createdByTitle.get(c.title)!;
      for (const ref of c.depends_on) {
        addDependency(db, { ticketId: fromId, dependsOnTicketId: resolveDependsOnRef(ref, existingIds, createdByTitle) });
      }
    }

    // Pass 3: every other command, in the proposal's own order. Multiple
    // request_user_decision commands fold into one BLOCKED transition below
    // (a ticket has exactly one status; there is no shape for "blocked
    // twice"), each contributing one line.
    const decisionRequests: Array<{ question: string; context: string }> = [];
    for (const c of commands) {
      switch (c.type) {
        case 'create_ticket':
          break; // applied above
        case 'add_dependency':
          guard();
          addDependency(db, { ticketId: c.ticket_id, dependsOnTicketId: c.depends_on_ticket_id });
          break;
        case 'change_priority':
          guard();
          setTicketPriority(db, c.ticket_id, c.priority);
          break;
        case 'update_scope': {
          guard();
          const before = readScopeText(project);
          writeScopeText(project, c.content);
          const scopePolicy = classify('scope_updated');
          insertEvent(db, {
            projectId: project.id,
            eventType: 'scope_updated',
            entityType: 'project',
            entityId: project.id,
            payload: { summary: summarizeScopeChange(before, c.content) },
            visibility: scopePolicy.visibility,
            requiresUser: scopePolicy.requiresUser,
            idempotencyKey: `scope_updated:${runId}`,
          });
          break;
        }
        case 'cancel_ticket':
          guard();
          // The same PERSON-initiated `cancel` transition batch 8's
          // `POST /tickets/{id}/cancel` uses (stateMachine.ts) -- here
          // proposed by the Manager instead of typed by the owner directly,
          // but it is still the owner's own plan taking effect, not the
          // daemon's; single write site (stateMachine.ts) unchanged.
          // validateProposal already confirmed the target is neither a
          // manager ticket nor already in a terminal/non-cancellable
          // status, so this call is not expected to throw.
          recordTicketTransition(db, {
            ticketId: c.ticket_id,
            event: 'cancel',
            idempotencyKey: `cancel:${runId}:${c.ticket_id}`,
          });
          break;
        case 'update_ticket':
          guard();
          updateTicketFields(db, c.ticket_id, {
            title: c.title,
            description: c.description,
            acceptanceCriteria: c.acceptance_criteria,
            maxBudgetUsdOverride: c.max_budget_usd,
            model: c.model,
            modelReason: c.model_reason,
          });
          break;
        case 'request_user_decision':
          guard();
          decisionRequests.push({ question: c.question, context: c.context });
          break;
      }
    }

    resolveReadiness(db, project.id);

    const payload: ManagerProposalAppliedPayload = { rationale, commands, created };
    const policy = classify('manager_proposal_applied');
    insertEvent(db, {
      projectId: project.id,
      eventType: 'manager_proposal_applied',
      entityType: 'ticket',
      entityId: ticket.id,
      payload,
      visibility: policy.visibility,
      requiresUser: policy.requiresUser,
      idempotencyKey: `manager_proposal_applied:${runId}`,
    });

    // The manager ticket's own outcome: BLOCKED if the proposal asked the
    // owner a question (per batch-9-spec.md section 2: "`request_user_decision`
    // becomes an inbox item on the manager ticket itself"), DONE otherwise --
    // reusing the SAME worker_needs_user_decision/worker_done transitions
    // and payload shape (status/summary/artifacts/checks/blockers/questions)
    // any ordinary worker's result already produces, so the existing
    // `decide`/inbox machinery answers it with no new mechanism: `decide`
    // reads `blockers`/`summary` off the latest worker_needs_user_decision
    // payload (commands/decide.ts), and answering it returns the manager
    // ticket to READY, where the next tick re-runs the Manager -- a fresh
    // invocation that rebuilds its brief from the database (including the
    // now-recorded answer in the decision log), per batch 0's cost ruling.
    if (decisionRequests.length > 0) {
      // `summary` carries the actual question(s), not the proposal's
      // rationale: commands/inbox.ts's `reasonFor` reads `summary` before
      // `blockers` when building the inbox line, while commands/decide.ts
      // reads `blockers` before `summary` when building the question it
      // shows -- the two existing consumers disagree on which field wins,
      // so both must carry the real question for either one to work, not
      // just the one this code happened to be tested against.
      const questionSummary = decisionRequests.map((d) => d.question).join('; ');
      recordTicketTransition(db, {
        ticketId: ticket.id,
        event: 'worker_needs_user_decision',
        idempotencyKey: `worker_needs_user_decision:${runId}`,
        payload: {
          status: 'needs_user_decision',
          summary: questionSummary,
          artifacts: [],
          checks: [],
          blockers: decisionRequests.map((d) => `${d.question} (${d.context})`),
          questions: [],
        },
      });
      return { outcome: 'applied', ticketStatus: 'BLOCKED', created };
    }

    recordTicketTransition(db, {
      ticketId: ticket.id,
      event: 'worker_done',
      idempotencyKey: `worker_done:${runId}`,
      payload: { status: 'done', summary: rationale, artifacts: [], checks: [], blockers: [], questions: [] },
    });
    return { outcome: 'applied', ticketStatus: 'DONE', created };
  });
}

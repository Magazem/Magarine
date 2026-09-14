import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { classify } from '../policy.ts';
import { planProject, readScopeText, writeScopeText } from '../manager.ts';
import { getProject, getTicket, insertEvent, updateTicketFields } from '../store.ts';
import type { Ticket } from '../types.ts';
import { truncateTitleForDisplay } from './board.ts';

// `plan --project <id> --mission "<text>"`: batch 11 part 2, Strategist
// ruling (settled) -- `--mission` no longer stores the text as a ticket
// description (batch 9's original design, since removed along with
// `deriveManagerTitle`). It now MEANS "seed the scope with this text, then
// plan": the Manager (manager.ts, Role R's file) always plans from the
// project's scope document, so a mission has nowhere else to go.
//
// This is the one function both the direct-write path (cli.ts, no live
// daemon) and the daemon-routed path (daemonApi.ts's handlePlan) call --
// there is exactly one seeding implementation, matching this codebase's rule
// that a mutating behaviour lives in one place, not one copy per path.
export class PlanError extends Error {}

export function planWithMission(db: Db, projectId: string, input: { mission?: string; budgetUsd?: number }): Ticket {
  const project = getProject(db, projectId);
  if (!project) {
    throw new PlanError(`no such project: ${projectId}`);
  }

  const mission = (input.mission ?? '').trim();
  if (mission.length > 0) {
    const existingScope = readScopeText(project).trim();
    if (existingScope.length > 0) {
      throw new PlanError(
        'this project already has a scope: edit SCOPE.md directly, or use `discuss --message` to add to the conversation instead of re-seeding it with --mission.'
      );
    }
    if (!project.scopePath) {
      throw new PlanError(
        `project ${projectId} has no scope file configured -- recreate it with \`project create --scope <file>\` (a fresh project gets a default one automatically) before using --mission.`
      );
    }

    // Whole text, verbatim -- no truncation, no derived summary. The scope
    // document IS the mission from here on.
    writeScopeText(project, mission);
    const scopePolicy = classify('scope_updated');
    insertEvent(db, {
      projectId,
      eventType: 'scope_updated',
      entityType: 'project',
      entityId: projectId,
      payload: { summary: 'seeded from --mission' },
      visibility: scopePolicy.visibility,
      requiresUser: scopePolicy.requiresUser,
      idempotencyKey: newId('evt'),
    });
  }

  const ticketId = planProject(db, projectId, { budgetUsd: input.budgetUsd });

  // planProject (manager.ts) always titles its ticket 'Manager: plan' --
  // reasonable when it re-plans from an existing board, but not when this
  // call just seeded the scope from scratch: the ruling is that the ticket
  // title stays the first line of the scope, trimmed to 80 chars, the same
  // truncation the board already applies for display (board.ts's
  // truncateTitleForDisplay). Only the seeding branch gets this fix-up; an
  // ordinary `plan` with no --mission keeps planProject's own title
  // untouched, since nothing here asked for that case to change.
  if (mission.length > 0) {
    updateTicketFields(db, ticketId, { title: truncateTitleForDisplay(mission) });
  }

  return getTicket(db, ticketId)!;
}

import type { Db } from '../db/index.ts';
import { createTicket, getProject } from '../store.ts';
import type { Ticket } from '../types.ts';

// `plan --project <id> --mission "<text>"`: creates a manager ticket, per
// docs/strategy/batch-9-spec.md section 2 -- "creates the manager ticket
// and, if a daemon is up, it runs on the next tick; otherwise `run
// --until-idle` picks it up." This function only ever creates the ticket;
// it never ticks or spawns anything itself, matching every other
// direct-write command in this codebase (`ticket add`, `dep add`).
//
// The mission text becomes the ticket's own `description` -- the same
// field managerEnvelope.ts's `buildManagerBriefing` reads back out as the
// Manager's mission, so there is exactly one place a mission is stored, not
// a copy in the envelope path and a second one here.

export class PlanError extends Error {}

const MAX_TITLE_MISSION_CHARS = 60;

// A short, readable title derived from the mission, since a manager ticket
// needs one for the board/inbox the same as any ticket -- but the mission
// itself can be arbitrarily long free text, unsuited to a board column.
// Truncates on a word boundary where possible so the title doesn't end
// mid-word.
export function deriveManagerTitle(mission: string): string {
  const trimmed = mission.trim();
  if (trimmed.length <= MAX_TITLE_MISSION_CHARS) {
    return `Plan: ${trimmed}`;
  }
  const cut = trimmed.slice(0, MAX_TITLE_MISSION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const truncated = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `Plan: ${truncated}…`;
}

export function planMission(db: Db, input: { projectId: string; mission: string }): Ticket {
  const project = getProject(db, input.projectId);
  if (!project) {
    throw new PlanError(`no such project: ${input.projectId}`);
  }
  if (!input.mission.trim()) {
    throw new PlanError('a mission is required');
  }

  // Workspace NONE, per batch-9-spec.md section 2: "A manager ticket is a
  // ticket... Its workspace is NONE." Model/budget are resolved later, at
  // envelope-build time (store.ts's resolveManagerModel/resolveMaxBudgetUsd
  // read the project's CURRENT settings, not a value frozen at `plan` time)
  // -- so a later `project set --manager-model` change is honoured even by
  // a manager ticket that was already sitting OPEN/READY before that change.
  return createTicket(db, {
    projectId: input.projectId,
    title: deriveManagerTitle(input.mission),
    description: input.mission,
    kind: 'manager',
    workspaceType: 'NONE',
  });
}

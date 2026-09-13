import type { Db } from '../db/index.ts';
import { getProject, isProjectAdapterPaused, resumeProject } from '../store.ts';
import type { Project } from '../types.ts';

// `resume --project <id>`: clears a project's pause, whatever caused it --
// an `adapter_unavailable` failure (Role F, batch-3-spec.md item 1) or a
// `project_spend_cap_reached` refusal (Role H, batch-4-spec.md section 1
// ruling 1). Both trip the same `adapter_paused_at` column, so one command
// clears either. Calls store.ts's `resumeProject` (not the older
// `resumeProjectAdapter` this command used through batch 3), which records
// a `project_resume` event so the clear shows up in `activity` -- the
// pause-clearing behaviour itself is identical either way.

export class ResumeError extends Error {}

export function resume(db: Db, input: { projectId: string }): Project {
  const project = getProject(db, input.projectId);
  if (!project) {
    throw new ResumeError(`no such project: ${input.projectId}`);
  }
  if (!isProjectAdapterPaused(db, project.id)) {
    throw new ResumeError(`project ${project.id} is not paused; nothing to resume`);
  }
  resumeProject(db, project.id);
  return getProject(db, project.id)!;
}

import type { Db } from '../db/index.ts';
import { getProject, isProjectAdapterPaused, resumeProjectAdapter } from '../store.ts';
import type { Project } from '../types.ts';

// `resume --adapter <id>`: clears a project's adapter pause (set when an
// `adapter_unavailable` failure trips it; see Role F's batch-3-spec.md
// item 1). The pause is per-project, so the id this command takes is a
// project id -- the flag is named `--adapter` per this role's brief, read
// as "the adapter for this project."

export class ResumeError extends Error {}

export function resume(db: Db, input: { projectId: string }): Project {
  const project = getProject(db, input.projectId);
  if (!project) {
    throw new ResumeError(`no such project: ${input.projectId}`);
  }
  if (!isProjectAdapterPaused(db, project.id)) {
    throw new ResumeError(`project ${project.id}'s adapter is not paused; nothing to resume`);
  }
  resumeProjectAdapter(db, project.id);
  return getProject(db, project.id)!;
}

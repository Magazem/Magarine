import { join } from 'node:path';
import { canonicalPath } from '../paths.ts';
import { withTransaction, type Db } from '../db/index.ts';
import { createScopeTextExclusive, type ScopeCreateTestHooks } from '../manager.ts';
import { projectReadiness } from '../readiness.ts';
import { probeScopeFile, scopeAnnouncement } from '../scopeProbe.ts';
import { createProject, listProjects } from '../store.ts';
import type { Project } from '../types.ts';

// Batch 20A (ruling 42): the ONE way a project comes into being. `magarine
// project create` and `POST /projects` both call this, so the terminal and
// the window cannot drift. `projectReadiness` stays the gate and
// `createProject` stays the write; this only sequences them.

export class ProjectCreateError extends Error {}

export interface ProjectCreateInput {
  name: string;
  /** Already resolved (absolute) by the caller. Whether it must exist is the CALLER's rule: the CLI has never required it, the API does. */
  dir: string;
  description?: string | null;
  maxParallelWorkers?: number | null;
  maxSpendUsd?: number | null;
  defaultModel?: string;
  brief?: string | null;
  managerModel?: string | null;
  verifierModel?: string | null;
  /** Written to `dir/SCOPE.md` only when none exists there; never set by the CLI. */
  scopeText?: string;
}

// Two spellings of one folder must compare equal: paths.ts's canonicalPath
// (absolute, symlinks/junctions/8.3 names resolved to the real path, case-folded
// on Windows). The SAME normaliser the home/state-directory rule uses.
export function normaliseDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  return canonicalPath(dir, platform);
}

const existsSentence = (scopePath: string): string =>
  `${scopePath} already exists, and a create form never overwrites a scope document -- edit that file, or create the project without a starting scope.`;

export interface ProjectCreateResult {
  project: Project;
  /** Ruling 29's announcement of an absent scope document, or null. */
  scopeLine: string | null;
}

// Order, chosen so a failure halfway leaves nothing behind:
//   1. every refusal that can be known up front (readiness, an existing
//      SCOPE.md) -- nothing written;
//   2. inside ONE transaction: the row, then the scope file, then COMMIT.
// If the file write fails, the transaction rolls the row back and the atomic
// write removed its own temp file: no row without its file, no file without
// its row. (The reverse order -- file first -- would strand a SCOPE.md on the
// owner's disk whenever the insert failed, and the daemon must not litter it.)
export function createProjectInDir(
  db: Db,
  input: ProjectCreateInput,
  stateDir: string,
  /** Test-only seam: forwarded to createScopeTextExclusive: fail the link to prove the row rolls back, or create the file inside the race window. */
  testHooks: ScopeCreateTestHooks = {}
): ProjectCreateResult {
  const scopePath = join(input.dir, 'SCOPE.md');
  const notReady = projectReadiness({ workspaceRoot: input.dir, scopePath }, stateDir, probeScopeFile);
  if (notReady) throw new ProjectCreateError(notReady.message);
  if (input.scopeText !== undefined && probeScopeFile(scopePath) !== 'absent') {
    throw new ProjectCreateError(existsSentence(scopePath));
  }
  const project = withTransaction(db, () => {
    // Ruling 42 (amended): one directory, one project. Inside the write
    // transaction (BEGIN IMMEDIATE) so a second process cannot slip a project
    // in between the check and the insert. Existing duplicate rows are never
    // touched; this only stops a new one.
    const wanted = normaliseDir(input.dir);
    const taken = listProjects(db).find((p) => p.workspaceRoot != null && p.workspaceRoot !== '' && normaliseDir(p.workspaceRoot) === wanted);
    if (taken) {
      throw new ProjectCreateError(`${input.dir} is already the directory of project "${taken.name}" (${taken.id}) -- a directory holds one project; choose another folder.`);
    }
    const created = createProject(db, {
      name: input.name,
      description: input.description ?? null,
      maxParallelWorkers: input.maxParallelWorkers ?? null,
      maxSpendUsd: input.maxSpendUsd ?? null,
      defaultModel: input.defaultModel,
      brief: input.brief ?? null,
      workspaceRoot: input.dir,
      managerModel: input.managerModel ?? null,
      verifierModel: input.verifierModel ?? null,
      scopePath,
    });
    // Exclusive: a SCOPE.md that appeared since the pre-check above is never replaced. Throwing rolls the row back.
    if (input.scopeText !== undefined && !createScopeTextExclusive(created, input.scopeText, testHooks)) {
      throw new ProjectCreateError(existsSentence(scopePath));
    }
    return created;
  });
  return { project, scopeLine: scopeAnnouncement(project.scopePath, probeScopeFile) };
}

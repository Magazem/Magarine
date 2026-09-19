import { homedir } from 'node:os';
import type { Project } from './types.ts';
import { validateWorkspaceRoot } from './paths.ts';

// Batch 16 ruling 24: one readiness check at the point of use. A project is
// ready to run a worker (manager or work) only if it has a directory, that
// directory is a safe boundary, and its scope document has a path. The rules
// are ordered; the first failing one is reported.
//
// ONE function, called from every site that asks the question -- the
// scheduler before it starts any run, `cli.ts`'s `project create`/`project
// set --dir` refusal (ruling 22's three rules now live behind
// `unsafe_workspace_root`), and `project list` -- so the sites cannot drift.
// The names are also the values `projects.pause_reason` takes when the
// scheduler pauses a project for one of them (see store.ts).
export type ReadinessRule = 'missing_workspace_root' | 'unsafe_workspace_root' | 'missing_scope_path';

export const READINESS_RULES: readonly ReadinessRule[] = ['missing_workspace_root', 'unsafe_workspace_root', 'missing_scope_path'];

export function isReadinessRule(value: unknown): value is ReadinessRule {
  return typeof value === 'string' && (READINESS_RULES as readonly string[]).includes(value);
}

export interface Readiness {
  rule: ReadinessRule;
  /** For `unsafe_workspace_root` this is ruling 22's own message, verbatim (it names the specific directory and why). */
  message: string;
  /** The exact command that fixes it, with the project id filled in when there is one. */
  fix: string;
}

// The one command that fixes every rule: a row's directory is the owner's
// decision (ruling 24 point 5), so the product names the command and waits.
export function readinessFix(projectId: string | undefined): string {
  return `magarine project set --project ${projectId ?? '<projectId>'} --dir <folder>`;
}

// What a pause for `rule` says, for the board's PAUSED line and the inbox.
export function describeReadinessRule(rule: ReadinessRule, projectId: string, workspaceRoot: string | null): string {
  const fix = readinessFix(projectId);
  switch (rule) {
    case 'missing_workspace_root':
      return `this project has no directory, so no worker can start -- run \`${fix}\``;
    case 'unsafe_workspace_root':
      return `this project's directory (${workspaceRoot ?? 'unknown'}) is not a safe place for workers (your home directory, a filesystem root, or a folder containing Magarine's own state directory) -- run \`${fix}\``;
    case 'missing_scope_path':
      return `this project has no scope document path, so no worker can start -- run \`${fix}\``;
  }
}

/**
 * The first failing readiness rule for `project`, or null when it is ready.
 * Pure: reads nothing but its arguments. `project` may be a stored row or the
 * row a `project create`/`project set --dir` is ABOUT to write (only the two
 * directory fields matter, `id` is optional for that case). `homeDir` is a
 * parameter so a test can prove the home-directory rule without resolving to
 * the real home directory.
 */
export function projectReadiness(
  project: Pick<Project, 'workspaceRoot' | 'scopePath'> & { id?: string },
  stateDir: string,
  homeDir: string = homedir()
): Readiness | null {
  const fix = readinessFix(project.id);
  if (project.workspaceRoot == null || project.workspaceRoot === '') {
    return { rule: 'missing_workspace_root', message: describeReadinessRule('missing_workspace_root', project.id ?? '<projectId>', null), fix };
  }
  const unsafe = validateWorkspaceRoot(project.workspaceRoot, homeDir, stateDir);
  if (unsafe) return { rule: 'unsafe_workspace_root', message: unsafe, fix };
  if (project.scopePath == null || project.scopePath === '') {
    return { rule: 'missing_scope_path', message: describeReadinessRule('missing_scope_path', project.id ?? '<projectId>', project.workspaceRoot), fix };
  }
  return null;
}

/**
 * Whether a scheduling entry point (`tick`, `runUntilIdle`, `startDaemonLoop`)
 * asks the readiness question. REQUIRED on every deps object, never defaulted
 * (Strategist's ruling on batch 16 item 5): a check guarding the projects the
 * owner already has must not be switched off by forgetting a field.
 * `{ stateDir }` runs the check; `'skip'` is the one explicit, greppable
 * opt-out, used only by callers that are not asking the question (unit tests
 * of unrelated scheduling behaviour).
 */
export type ReadinessMode = { stateDir: string } | 'skip';

/** The type refuses a call site that omits `readiness`; this refuses a JS caller (or an `as any`) that does. */
export function assertReadinessMode(value: unknown, where: string): asserts value is ReadinessMode {
  if (value === 'skip') return;
  if (typeof value === 'object' && value !== null && typeof (value as { stateDir?: unknown }).stateDir === 'string') return;
  throw new Error(`${where}: \`readiness\` is required -- pass { stateDir } to check project readiness, or 'skip' to declare that this caller is not asking`);
}

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
//
// Ruling 29 (batch 16 addendum 5) adds a fourth: `unreadable_scope_file`. A
// scope document that does NOT EXIST is not a readiness failure (the
// talk-first start is deliberate; it is announced by `project create`/`plan`
// and marked by `project list`); one that exists but cannot be read is.
export type ReadinessRule = 'missing_workspace_root' | 'unsafe_workspace_root' | 'missing_scope_path' | 'unreadable_scope_file';

export const READINESS_RULES: readonly ReadinessRule[] = [
  'missing_workspace_root',
  'unsafe_workspace_root',
  'missing_scope_path',
  'unreadable_scope_file',
];

export function isReadinessRule(value: unknown): value is ReadinessRule {
  return typeof value === 'string' && (READINESS_RULES as readonly string[]).includes(value);
}

/**
 * Ruling 29: how the scope document at a path stands. Injected into
 * `projectReadiness` so the function stays pure -- production passes the
 * fs-backed `probeScopeFile` (scopeProbe.ts), tests pass a stub. 'absent' (no
 * such file) is NOT a readiness failure; 'unreadable' is.
 */
export type ScopeProbe = (path: string) => 'present' | 'absent' | 'unreadable';

export interface Readiness {
  rule: ReadinessRule;
  /** For `unsafe_workspace_root` this is ruling 22's own message, verbatim (it names the specific directory and why). */
  message: string;
  /** The exact command that fixes it, with the project id filled in when there is one. */
  fix: string;
}

// The one command that fixes the directory rules: a row's directory is the
// owner's decision (ruling 24 point 5), so the product names the command and
// waits. An unreadable scope file is fixed by repairing the file and then
// resuming -- the pause does not clear itself.
export function readinessFix(projectId: string | undefined, rule?: ReadinessRule): string {
  const id = projectId ?? '<projectId>';
  return rule === 'unreadable_scope_file' ? `magarine resume --project ${id}` : `magarine project set --project ${id} --dir <folder>`;
}

// What a pause for `rule` says, for the board's PAUSED line and the inbox.
export function describeReadinessRule(
  rule: ReadinessRule,
  projectId: string,
  workspaceRoot: string | null,
  scopePath?: string | null
): string {
  const fix = readinessFix(projectId, rule);
  switch (rule) {
    case 'missing_workspace_root':
      return `this project has no directory, so no worker can start -- run \`${fix}\``;
    case 'unsafe_workspace_root':
      return `this project's directory (${workspaceRoot ?? 'unknown'}) is not a safe place for workers (your home directory, a filesystem root, or a folder containing Magarine's own state directory) -- run \`${fix}\``;
    case 'missing_scope_path':
      return `this project has no scope document path, so no worker can start -- run \`${fix}\``;
    case 'unreadable_scope_file':
      return `the scope document at ${scopePath ?? '(unknown path)'} exists but cannot be read (a permissions problem, or a directory at that path) -- fix the file, or point the project elsewhere with \`magarine project set --project ${projectId} --dir <folder>\`, then run \`${fix}\``;
  }
}

/**
 * The first failing readiness rule for `project`, or null when it is ready.
 * Pure: reads nothing but its arguments. `project` may be a stored row or the
 * row a `project create`/`project set --dir` is ABOUT to write (only the two
 * directory fields matter, `id` is optional for that case). `homeDir` is a
 * parameter so a test can prove the home-directory rule without resolving to
 * the real home directory, and `probe` (ruling 29) is how the scope
 * document's state enters without this function touching disk -- the
 * fs-backed one in production, a stub in tests.
 */
export function projectReadiness(
  project: Pick<Project, 'workspaceRoot' | 'scopePath'> & { id?: string },
  stateDir: string,
  probe: ScopeProbe,
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
  // Ruling 29: 'absent' passes (announced elsewhere, never a failure);
  // 'unreadable' fails -- reading it as empty would have the Manager
  // interview the owner about a document they already wrote.
  if (probe(project.scopePath) === 'unreadable') {
    const id = project.id ?? '<projectId>';
    return {
      rule: 'unreadable_scope_file',
      message: describeReadinessRule('unreadable_scope_file', id, project.workspaceRoot, project.scopePath),
      fix: readinessFix(project.id, 'unreadable_scope_file'),
    };
  }
  return null;
}

/**
 * Whether a scheduling entry point (`tick`, `runUntilIdle`, `startDaemonLoop`)
 * asks the readiness question. REQUIRED on every deps object, never defaulted
 * (Strategist's ruling on batch 16 item 5): a check guarding the projects the
 * owner already has must not be switched off by forgetting a field.
 * `{ stateDir, scopeProbe }` runs the check; `'skip'` is the one explicit,
 * greppable opt-out, used only by callers that are not asking the question
 * (unit tests of unrelated scheduling behaviour).
 */
export type ReadinessMode = { stateDir: string; scopeProbe: ScopeProbe } | 'skip';

/** The type refuses a call site that omits `readiness`; this refuses a JS caller (or an `as any`) that does. */
export function assertReadinessMode(value: unknown, where: string): asserts value is ReadinessMode {
  if (value === 'skip') return;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { stateDir?: unknown }).stateDir === 'string' &&
    typeof (value as { scopeProbe?: unknown }).scopeProbe === 'function'
  ) {
    return;
  }
  throw new Error(
    `${where}: \`readiness\` is required -- pass { stateDir, scopeProbe } to check project readiness, or 'skip' to declare that this caller is not asking`
  );
}

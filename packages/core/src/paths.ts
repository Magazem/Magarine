import { homedir } from 'node:os';
import { join } from 'node:path';

// The one place the daemon's state directory is resolved. Precedence:
// `--state-dir` flag, else `MAGARINE_HOME`, else `<home>/.magarine/`.
// Nothing is written under the current working directory unless the user
// asked for it (an explicit `--state-dir`) -- see batch-4-spec.md section 1
// ruling 5. `--db` remains a separate, explicit override handled by callers;
// it does not flow through this function.

export interface ResolveStateDirOptions {
  stateDirFlag?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

export function resolveStateDir(options: ResolveStateDirOptions = {}): string {
  if (options.stateDirFlag) return options.stateDirFlag;
  const env = options.env ?? process.env;
  if (env.MAGARINE_HOME) return env.MAGARINE_HOME;
  const home = options.homedir ?? homedir();
  return join(home, '.magarine');
}

export function dbPath(stateDir: string): string {
  return join(stateDir, 'magarine.db');
}

export function artifactsDir(stateDir: string): string {
  return join(stateDir, 'artifacts');
}

// Batch 11 part 2, item 2: the spec says a project's default SCOPE.md lives
// "under the project directory", but this codebase has no notion of a
// project's own directory independent of the optional DIRECTORY workspace
// root (itself unset for most projects -- see types.ts's Project.workspaceRoot).
// Decision: give every project a directory under the state dir it lives in,
// keyed by its own id, so a default scope path exists unconditionally,
// regardless of workspace type. `project create --scope <file>` overrides
// this; nothing below is consulted when that flag is given.
export function projectDir(stateDir: string, projectId: string): string {
  return join(stateDir, 'projects', projectId);
}

export function defaultScopePath(stateDir: string, projectId: string): string {
  return join(projectDir(stateDir, projectId), 'SCOPE.md');
}

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

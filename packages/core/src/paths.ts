import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse as parsePath, resolve, sep } from 'node:path';

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

// Batch 15 addendum 10, ruling 22: a project's directory is the boundary a
// worker may write inside (batch 2's premise). The owner's own walk ran
// `project create` from their home directory (`--dir` defaults to cwd, "the
// same way `git init` works") and every worker treated the whole home
// folder as fair game -- four files landed loose in `C:\Users\<owner>`.
// Refuses (never warns -- a warning in a terminal the owner is reading a
// recipe from is not read) three shapes of unsafe boundary: the home
// directory itself, a filesystem root, and a directory that IS or CONTAINS
// the state directory (a worker there could edit Magarine's own database).
//
// Lives here, not in cli.ts, on purpose: cli.ts has no `import.meta.main`
// guard -- `main()` runs unconditionally at module load (`main().catch(...)`
// at the bottom of the file) -- so importing anything from cli.ts directly
// (rather than spawning it as every existing cli.ts test already does)
// would execute the whole CLI against the IMPORTING PROCESS's own argv as a
// side effect. `paths.ts` is already the one place state-dir resolution
// lives and is already safely imported by both cli.ts and its tests, so
// this joins it rather than adding a second safe-to-import module.
//
// `homeDir`/`resolvedStateDir` are parameters, never read from
// `os.homedir()`/`resolveStateDir()` INSIDE this function, so a test can
// prove every rule -- including the home-directory one -- without a real
// invocation ever resolving to the real home directory. See
// cliRouting.test.ts's/commands.test.ts's "ruling 22" tests.
//
// Batch 20A review: the comparisons are on REAL paths (`canonicalPath`), not
// strings. Before, `c:\users\yazan` (home in another case), the state
// directory lower-cased, and a junction pointing at either all sailed
// through -- and `POST /projects` made that a web input.
export function validateWorkspaceRoot(dir: string, homeDir: string, resolvedStateDir: string): string | null {
  const real = canonicalPath(dir);
  if (real === canonicalPath(homeDir)) {
    return `${dir} is your home directory -- make a folder for the project and run this from inside it.`;
  }
  if (parsePath(real).root === real) {
    return `${dir} is a filesystem root -- make a folder for the project and run this from inside it.`;
  }
  const state = canonicalPath(resolvedStateDir);
  // Is, contains, or is INSIDE the state directory: a worker in a folder
  // under it can still reach Magarine's database's neighbours.
  if (real === state || state.startsWith(real + sep) || real.startsWith(state + sep)) {
    return `${dir} is, contains or is inside Magarine's own state directory (${resolvedStateDir}) -- a worker here could edit Magarine's own database. Move the state directory with --state-dir, or choose a different project folder.`;
  }
  return null;
}

// The one way two spellings of a folder are made comparable: absolute, every
// symlink/junction/8.3 name resolved to the real path, case-folded where the
// filesystem is case-insensitive. A path that does not exist yet cannot be
// realpath'd, so its nearest EXISTING ancestor is, and the missing rest is
// re-appended as typed.
export function canonicalPath(p: string, platform: NodeJS.Platform = process.platform): string {
  let current = resolve(p);
  const tail: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpathSync.native(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        real = current;
        break;
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
  const full = tail.length > 0 ? join(real, ...tail) : real;
  return platform === 'win32' ? full.toLowerCase() : full;
}

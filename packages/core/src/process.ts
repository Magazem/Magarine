import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';

// The one module that touches node:child_process. Every future adapter
// (Claude CLI, AionUi helper CLI, ...) spawns and controls its worker
// process through this module, so porting to Linux only ever means editing
// this one file. Processes are always spawned with `shell: false` and an
// explicit executable path/name — nothing here depends on cmd.exe or
// PowerShell being available.
//
// Tree kill status:
// - Windows (`killTreeWindows`, via `taskkill /T`): HARD verified — a real
//   parent/grandchild Node process tree was spawned, `stop()` was called,
//   and every recorded pid was independently confirmed gone by querying the
//   OS with `tasklist`, not by trusting the child's `close` event.
// - POSIX (`killTreePosix`, via process-group signals): written and
//   reviewed but UNTESTED. It has not run on any POSIX machine. Treat it as
//   unverified until the Ubuntu leg exercises it for real.

const DEFAULT_GRACE_MS = 3000;
// Grace period used when a wall-clock timeout triggers the kill itself.
// Kept short so a hung process under test doesn't make the timeout path slow.
const TIMEOUT_KILL_GRACE_MS = 1000;

export interface SpawnManagedOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
}

export interface WaitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /**
   * Batch 11 ruling 2/4: set when the child never actually started (the
   * resolved executable does not exist, or could not be executed, at spawn
   * time) -- Node's own error message (e.g. "spawn ...claude.exe ENOENT"),
   * not this module's own text. Undefined for every other outcome,
   * including a normal non-zero exit. Before this, `spawn()`'s own 'error'
   * event had no listener at all: Node throws an unhandled 'error' event as
   * an uncaught exception in that case, which crashes the WHOLE DAEMON, not
   * just the one run -- found while wiring the adapter's spawn-failure
   * message to name the resolved path (there is no path to name if the
   * process that would report it has already died).
   */
  spawnError?: string;
}

export interface ManagedProcess {
  pid: number | undefined;
  wait(): Promise<WaitResult>;
  stop(graceMs?: number): Promise<void>;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
}

export function spawnManaged(options: SpawnManagedOptions): ManagedProcess {
  const child = spawn(options.executable, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    // On POSIX this makes the child a session/process-group leader so
    // `stop()` can signal the whole tree via the negative pid. On Windows
    // `detached` has no equivalent effect; tree kill there goes through
    // `taskkill /T`, which walks the OS's own parent/child bookkeeping.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Always drain stdin. Nothing here reads from it unless `stdin` is given,
  // and leaving it open would make a child that waits for EOF hang forever.
  child.stdin?.end(options.stdin);

  // Buffers and forwards data from the moment the child spawns, regardless
  // of whether/when a caller attaches an onStdout/onStderr listener. This is
  // what keeps multi-megabyte output from deadlocking: the OS pipe is never
  // left unread and backed up, because something is always consuming it.
  let stdoutText = '';
  let stderrText = '';
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdoutText += text;
    for (const listener of stdoutListeners) listener(text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrText += text;
    for (const listener of stderrListeners) listener(text);
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const stop = (graceMs = DEFAULT_GRACE_MS): Promise<void> => killTree(child.pid, graceMs);

  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      // The timeout path reuses the exact same tree-kill function stop()
      // calls; it does not duplicate the kill logic.
      void stop(TIMEOUT_KILL_GRACE_MS);
    }, options.timeoutMs);
  }

  const donePromise = new Promise<WaitResult>((resolve) => {
    // Settle at most once: a spawn that never started fires 'error' and
    // never 'close' (Node's own contract -- 'exit'/'close' only follow a
    // process that actually ran), but this guard costs nothing and removes
    // any doubt if that ever changes across Node versions/platforms.
    let settled = false;
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: stdoutText, stderr: stderrText });
    });
    // Without this listener, Node treats an unhandled 'error' event on an
    // EventEmitter as an uncaught exception -- a resolved-but-nonexistent
    // executable (deleted after `doctor` last checked, a shim whose target
    // vanished) would crash the entire daemon process instead of failing
    // the one run that tried to spawn it.
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stdout: stdoutText, stderr: stderrText, spawnError: err.message });
    });
  });

  return {
    pid: child.pid,
    wait: () => donePromise,
    stop,
    onStdout: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderr: (listener) => {
      stderrListeners.push(listener);
    },
  };
}

async function killTree(pid: number | undefined, graceMs: number): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await killTreeWindows(pid, graceMs);
  } else {
    await killTreePosix(pid, graceMs);
  }
}

function runTaskkill(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const tk = spawn('taskkill', args, { shell: false, windowsHide: true });
    // taskkill exits non-zero when the pid is already gone; that is a
    // success outcome for us (there is nothing left to kill), so this
    // never rejects.
    tk.on('close', () => resolve());
    tk.on('error', () => resolve());
  });
}

async function killTreeWindows(pid: number, graceMs: number): Promise<void> {
  await runTaskkill(['/PID', String(pid), '/T']);
  await delay(graceMs);
  await runTaskkill(['/PID', String(pid), '/T', '/F']);
}

// UNTESTED (see file header): reviewed but never run on a POSIX machine.
async function killTreePosix(pid: number, graceMs: number): Promise<void> {
  sendSignalToGroup(pid, 'SIGTERM');
  await delay(graceMs);
  sendSignalToGroup(pid, 'SIGKILL');
}

function sendSignalToGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole process group created by `detached`.
    process.kill(-pid, signal);
  } catch {
    // Group already gone; nothing to signal.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResolvedCommand {
  executable: string;
  /**
   * Batch 10 (Role Q): non-empty only when `executable` is `process.execPath`
   * and the real tool is a script it must run first (see
   * `resolveWindowsShimCommand`) -- empty for a direct native executable.
   * Must be spread BEFORE the caller's own args: `spawn(executable,
   * [...prefixArgs, ...callerArgs])`.
   */
  prefixArgs: string[];
  /**
   * Batch 11 ruling 2: which of the three real shapes this codebase knows
   * (see `resolveWindowsShimCommand`'s doc comment) actually produced
   * `executable`, so a caller like `doctor.ts` can tell the owner not just
   * a path but HOW it was found -- the difference matters because the two
   * shim strategies are exactly where batch 10's owner-walk findings lived.
   * 'direct': found on PATH with no `.cmd`/`.bat` shim to unwrap (every
   * POSIX binary, and a Windows tool installed as a bare `.exe`).
   */
  strategy: 'direct' | 'windows_shim_native_exe' | 'windows_shim_script';
  /**
   * Batch 11 ruling 2/4: the `.cmd`/`.bat` file itself, when `strategy` is
   * one of the two shim shapes -- undefined for 'direct'. `executable` (and,
   * for a script, `prefixArgs[0]`) is what actually runs, but the SHIM is
   * what the owner has on disk and would go looking for; naming both in a
   * spawn-failure message is the point of carrying this through at all.
   */
  shimPath?: string;
}

// Resolves `name` to something directly spawnable with `shell: false`,
// unwrapping npm's Windows .cmd shims rather than spawning through one -- a
// shim's child keeps running even if the shim itself is killed, the exact
// bug that motivated this module (batch-2-spec.md section 0).
//
// Batch 10 (Role Q): redesigned from a single-string return, because a
// shim's real target is sometimes a SCRIPT, not a binary -- `resolveExecutable`
// used to pick the first quoted path that merely looked like a real
// executable, which is exactly how it mis-resolved `pnpm` and `npm` (see
// `resolveWindowsShimCommand`'s own comment). `{ executable: process.execPath,
// prefixArgs: [scriptPath] }` runs that script through the CURRENT node —
// the same node this process already is — instead of a second, possibly
// absent one the shim would otherwise look for.
export function resolveCommand(name: string): ResolvedCommand {
  const hit = findOnPath(name);
  if (!hit) {
    throw new Error(`executable not found on PATH: ${name}`);
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(hit)) {
    return resolveWindowsShimCommand(hit, name);
  }
  return { executable: hit, prefixArgs: [], strategy: 'direct' };
}

// Kept for every existing caller that only ever needs one spawnable path --
// true of every shim actually in use by this codebase's own adapter today
// (`claude`'s shim is the native-executable shape, `prefixArgs` always
// empty). A caller resolving a name whose shim might be the script shape
// (`doctor.ts`'s `pnpm` check is the one that needs this) must call
// `resolveCommand` directly and use its `prefixArgs`.
export function resolveExecutable(name: string): string {
  return resolveCommand(name).executable;
}

function findOnPath(name: string): string | undefined {
  const pathDirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const hasExt = /\.[^\\/]+$/.test(name);

  if (process.platform === 'win32') {
    const exts = hasExt ? [''] : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }

  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// A `.cmd`/`.bat` shim's real target is one of two shapes. Parsing batch
// files as a language is the wrong strategy -- these shim shapes are few
// and known (see process.test.ts's synthetic fixtures for all three) -- so
// this recognizes shapes by what's actually on disk, not by interpreting
// the file's control flow:
//
// 1. A SIBLING NATIVE EXECUTABLE, named after `name` itself -- `claude.cmd`
//    unconditionally invokes `...\claude-code\bin\claude.exe`, and its
//    basename ending in `<name>.exe` is what identifies it, not merely
//    being "a quoted path ending in .exe". A shim like pnpm's or npm's ALSO
//    quotes a `.exe` path (`node.exe`, guarded by `IF EXIST` because it is
//    often absent) -- that file existing or not is irrelevant, because it
//    is the INTERPRETER the shim would use, never the tool itself. Matching
//    by name is what tells the two apart; this is the defect that made
//    `resolveExecutable('pnpm')` resolve to a `node.exe` that does not
//    exist, and `resolveExecutable('npm')` resolve to unrelated text
//    entirely (see docs/strategy/batch-10-owner-walk.md finding 1).
// 2. Otherwise, THE SCRIPT the shim ultimately hands to node -- read off
//    its own final invocation line (the last non-blank, non-label,
//    non-comment line), either as a literal quoted path there (pnpm's
//    `.cjs`) or, if that line only names a bare `%VARNAME%`, resolved back
//    to that variable's own first (default, unconditional) `SET`
//    assignment elsewhere in the file (npm's `.js`, whose only OTHER
//    assignment sits inside an `IF EXIST` this function does not try to
//    evaluate -- the common case, a plain global install with no
//    project-local override, is what the default assignment gives). Run
//    through the CURRENT node (`process.execPath`) -- never a second,
//    possibly absent node.exe the shim itself would have looked for; this
//    is exactly what the shim does when no such node.exe exists beside it.
//
// Never returns cmd.exe or another shim (batch-2 ruling, unchanged): if
// neither shape resolves to a real file, this throws naming the shim rather
// than falling back to a shell.
function resolveWindowsShimCommand(shimPath: string, name: string): ResolvedCommand {
  const text = readFileSync(shimPath, 'utf8');
  const shimDir = dirname(shimPath);
  // Two distinct batch tokens, both meaning "this shim's own directory":
  // `%dp0%` is a REGULAR variable (claude.cmd/pnpm.cmd's `SET dp0=%~dp0`
  // two-step form, closed with a trailing `%` like any other variable), but
  // `%~dp0` is batch's special drive+path-of-argument-0 expansion, used
  // directly with NO trailing `%` (npm.cmd's shape) -- matching only the
  // closed form silently left `%~dp0` untouched in the npm shape, which
  // `resolvePath` then joined onto this PROCESS's cwd instead of the
  // shim's directory, so a real file's expansion never once matched.
  const expand = (raw: string): string => resolvePath(raw.replace(/%~dp0|%dp0%/gi, `${shimDir}\\`));

  const nativeExe = findSiblingNativeExecutable(text, name, expand);
  if (nativeExe) {
    return { executable: nativeExe, prefixArgs: [], strategy: 'windows_shim_native_exe', shimPath };
  }

  const scriptPath = findShimScriptPath(text, expand);
  if (scriptPath) {
    return { executable: process.execPath, prefixArgs: [scriptPath], strategy: 'windows_shim_script', shimPath };
  }

  throw new Error(`could not find a real executable or script inside shim: ${shimPath}`);
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function findSiblingNativeExecutable(text: string, name: string, expand: (raw: string) => string): string | undefined {
  const targetSuffix = `${name.toLowerCase()}.exe`;
  for (const raw of quotedStrings(text)) {
    if (raw.includes('%*')) continue;
    if (!raw.toLowerCase().endsWith(targetSuffix)) continue;
    const expanded = expand(raw);
    if (existsSync(expanded)) return expanded;
  }
  return undefined;
}

function findShimScriptPath(text: string, expand: (raw: string) => string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('::') && !line.startsWith('@') && !line.startsWith(':'));
  const finalLine = lines[lines.length - 1];
  if (!finalLine) return undefined;

  const isBareVarToken = (raw: string): boolean => /^%[A-Za-z0-9_]+%$/.test(raw);

  for (const raw of quotedStrings(finalLine)) {
    if (raw === '%*' || isBareVarToken(raw)) continue;
    const expanded = expand(raw);
    if (/\.(js|mjs|cjs)$/i.test(expanded) && existsSync(expanded)) return expanded;
  }

  // The final line named no literal script path -- only bare %VARNAME%
  // tokens (npm.cmd's shape: `"%NODE_EXE%" "%NPM_CLI_JS%" %*`). Resolve
  // each back to that variable's own first SET assignment in the file.
  const varTokens = finalLine.match(/%[A-Za-z0-9_]+%/g) ?? [];
  for (const token of varTokens) {
    const varName = token.slice(1, -1);
    const assignment = text.match(new RegExp(`SET\\s+"${varName}=([^"]+)"`, 'i'));
    if (!assignment) continue;
    const expanded = expand(assignment[1]);
    if (/\.(js|mjs|cjs)$/i.test(expanded) && existsSync(expanded)) return expanded;
  }
  return undefined;
}

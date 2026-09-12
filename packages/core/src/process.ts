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
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: stdoutText, stderr: stderrText });
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

// Resolves `name` to a real, directly-executable path, unwrapping npm's
// Windows .cmd shims so callers never spawn through one. A shim's child
// keeps running even if the shim itself is killed, which is the exact bug
// that motivated this module (see docs/strategy/batch-2-spec.md, section 0).
export function resolveExecutable(name: string): string {
  const hit = findOnPath(name);
  if (!hit) {
    throw new Error(`executable not found on PATH: ${name}`);
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(hit)) {
    return resolveWindowsShim(hit);
  }
  return hit;
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

// npm's generated .cmd shims quote the real target path and invoke it with
// the incoming args forwarded as %*. This pulls that quoted path out and
// expands the %dp0%/%~dp0% token the shim sets to its own directory, which
// is how a shim finds its sibling `node_modules` regardless of install
// location. It deliberately never returns another .cmd/.bat, even if one
// were nested inside another shim.
function resolveWindowsShim(shimPath: string): string {
  const text = readFileSync(shimPath, 'utf8');
  const shimDir = dirname(shimPath);
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  for (const raw of quoted) {
    if (raw.includes('%*')) continue;
    const expanded = raw.replace(/%~?dp0%/gi, `${shimDir}\\`);
    if (/\.(cmd|bat)$/i.test(expanded)) continue;
    if (/\.(exe|js|mjs|cjs)$/i.test(expanded)) {
      return resolvePath(expanded);
    }
  }

  throw new Error(`could not find a real executable inside shim: ${shimPath}`);
}

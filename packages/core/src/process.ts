import { spawn } from 'node:child_process';

// The one module that touches node:child_process. Every future adapter
// (Claude CLI, AionUi helper CLI, ...) spawns and controls its worker
// process through this module, so porting to Linux only ever means editing
// this one file. Processes are always spawned with `shell: false` and an
// explicit executable path/name — nothing here depends on cmd.exe or
// PowerShell being available.
//
// Known gap: `stop()` kills the direct child only. If a spawned executable
// itself forks grandchildren, those may be left orphaned; killing a full
// process tree is OS-specific (process groups on POSIX, `taskkill /T` on
// Windows) and is left to whichever Batch 2 adapter actually needs it, since
// no real worker process is spawned by this batch's FakeAdapter.

export interface SpawnManagedOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface WaitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface ManagedProcess {
  pid: number | undefined;
  wait(): Promise<WaitResult>;
  stop(): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
}

export function spawnManaged(options: SpawnManagedOptions): ManagedProcess {
  const child = spawn(options.executable, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
  }

  const donePromise = new Promise<WaitResult>((resolve) => {
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });

  return {
    pid: child.pid,
    wait: () => donePromise,
    stop: () => {
      child.kill();
    },
    onStdout: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    onStderr: (listener) => {
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
  };
}

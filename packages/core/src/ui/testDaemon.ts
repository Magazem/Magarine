// A REAL DAEMON, FOR THE PAGE'S TESTS. Ruling 26 condition 3.
//
// The page's tests used to answer their own fetches from hand-written
// fixtures. That is the failure that cost eleven screenshots in batch 15: the
// `.shots` stub was authored FROM the page, so it sent `latest_activity`
// because the page read `latest_activity`, and agreed with the bug. A fixture
// written to suit the page cannot contradict it.
//
// So there are no fixtures. These helpers spawn the real `magarine serve` with
// the fake adapter, exactly as `daemonApi.test.ts` does, and the page talks to
// it over a real loopback connection with Node's own `fetch`. The daemon IS
// the fixture.

import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged, type ManagedProcess } from '../process.ts';
import { daemonFilePath, type DaemonFileInfo } from '../daemon.ts';
import { deriveTestCliCwd, testTempRoot } from '../testSupport.ts';

const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));

export interface ServeHandle {
  proc: ManagedProcess;
  waitForListening(): Promise<{ port: number }>;
  kill(): Promise<void>;
}

export function spawnServe(args: string[]): ServeHandle {
  const proc = spawnManaged({ executable: process.execPath, args: [cliPath, 'serve', ...args] });
  let stdout = '';
  let stderr = '';
  proc.onStdout((c) => (stdout += c));
  proc.onStderr((c) => (stderr += c));
  return {
    proc,
    async waitForListening() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) {
          try { return JSON.parse(line) as { port: number }; } catch { /* still buffering */ }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`serve never listened within 15s. stdout=${stdout} stderr=${stderr}`);
    },
    async kill() {
      await proc.stop(200);
      await proc.wait();
    },
  };
}

export function runCli(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawnManaged({ executable: process.execPath, args: [cliPath, ...args], cwd: deriveTestCliCwd(args) });
    let stdout = '';
    p.onStdout((c) => (stdout += c));
    p.wait().then((r) => resolve({ stdout, code: r.code }));
  });
}

export interface LiveDaemon {
  port: number;
  token: string;
  stateDir: string;
  /** What a browser would treat as this page's origin. */
  baseUrl: string;
  dbPath: string;
  /** Creates a project the way the owner does: the real CLI, against the same state directory. */
  createProject(name: string, extra?: string[]): Promise<{ id: string; name: string }>;
}

/**
 * Spawns a real daemon on a temp state directory, runs `body` against it, and
 * always kills it. NEVER touches the owner's own state directory: `testTempRoot`
 * is under the OS temp directory and is removed by the caller's `after` hook.
 */
export async function withDaemon(
  root: ReturnType<typeof testTempRoot>,
  body: (d: LiveDaemon) => Promise<void>,
  serveArgs: string[] = [],
): Promise<void> {
  const stateDir = mkdtempSync(join(root.root, 'page-'));
  const handle = spawnServe(['--state-dir', stateDir, '--tick-interval', '0.1', '--json', ...serveArgs]);
  try {
    const { port } = await handle.waitForListening();
    const token = (JSON.parse(readFileSync(daemonFilePath(stateDir), 'utf8')) as DaemonFileInfo).token;
    await body({
      port,
      token,
      stateDir,
      baseUrl: `http://127.0.0.1:${port}`,
      dbPath: join(stateDir, 'magarine.db'),
      async createProject(name, extra = []) {
        const res = await runCli(['project', 'create', '--name', name, '--state-dir', stateDir, '--json', ...extra]);
        const project = JSON.parse(res.stdout) as { id: string; name: string };
        return project;
      },
    });
  } finally {
    await handle.kill();
  }
}

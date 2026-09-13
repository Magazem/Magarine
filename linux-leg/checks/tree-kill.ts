// Standalone proof for process.ts's POSIX tree-kill path (killTreePosix /
// sendSignalToGroup), run only by 3-run.sh's Phase A -- never by `pnpm
// test`. Test files under packages/core/src are another engineer's this
// batch; this script exercises the exact same spawnManaged()/stop() exported
// functions from outside the suite, against a real Linux kernel, which is
// the thing that has never happened before this batch (see process.ts's
// file header). Mirrors process.test.ts's Windows-only
// "stop() kills an entire process tree" test as closely as the platform
// allows: a parent spawns a grandchild and records both pids, then hangs;
// stop() is called; both pids are independently confirmed gone by reading
// /proc, not by trusting spawnManaged's own `close` event.
//
// Run with: node linux-leg/checks/tree-kill.ts   (from the repo root)
import { existsSync, readFileSync } from 'node:fs';
import { spawnManaged } from '../../packages/core/src/process.ts';

function isPidAlivePosix(pid: number): boolean {
  const statPath = `/proc/${pid}/stat`;
  if (!existsSync(statPath)) return false;
  try {
    const stat = readFileSync(statPath, 'utf8');
    // The command name field is "(comm)" and may itself contain spaces or
    // parens, so the state letter is found relative to the LAST ")", not by
    // splitting on spaces from the front.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const state = afterComm[0];
    // 'Z' (zombie): the kernel has already reclaimed everything but the exit
    // status; a grandchild reparented to PID 1 inside a container with no
    // real init can sit here indefinitely. Still "gone" for this proof --
    // run 3-run.sh's container with `docker run --init` so this case is rare
    // in practice, but treat it as gone either way rather than reporting a
    // false failure for a process that is not actually doing anything.
    return state !== 'Z';
  } catch {
    return false;
  }
}

async function waitForGone(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (isPidAlivePosix(pid)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pid ${pid} is still running (non-zombie) after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    'process.stdout.write(JSON.stringify({ parentPid: process.pid, childPid: gc.pid }) + String.fromCharCode(10));',
    'setTimeout(() => {}, 60000);',
  ].join('\n');

  const proc = spawnManaged({ executable: process.execPath, args: ['-e', parentScript] });

  const pids = await new Promise<{ parentPid: number; childPid: number }>((resolve) => {
    let buf = '';
    proc.onStdout((chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)));
    });
  });

  if (!isPidAlivePosix(pids.parentPid)) throw new Error(`parent pid ${pids.parentPid} not alive before stop()`);
  if (!isPidAlivePosix(pids.childPid)) throw new Error(`grandchild pid ${pids.childPid} not alive before stop()`);

  await proc.stop(300);

  await waitForGone(pids.parentPid, 5000);
  await waitForGone(pids.childPid, 5000);

  console.log(
    `OK: parent pid ${pids.parentPid} and grandchild pid ${pids.childPid} both confirmed gone via /proc after stop() -- process-group SIGTERM then SIGKILL.`
  );
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

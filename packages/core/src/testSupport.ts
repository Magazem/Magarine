import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rmSyncResilient } from './db/testSupport.ts';

export interface TestTempRoot {
  root: string;
  cleanup: () => Promise<void>;
}

// Batch 5 item 3: gives one test file its own private directory under the
// OS temp directory, instead of that file creating prefixed directories
// directly inside the shared tmpdir(). Pass `root` as `workspace.ts`'s
// `baseDir` (directly, or via SchedulerDeps.workspaceBaseDir /
// ClaudeCliAdapterOptions.baseDir) wherever that test file exercises real
// NONE-mode workspace creation, and use it as the parent for any other
// ad-hoc temp directories the file creates.
//
// This is what makes a leak-detection assertion that scans a directory for
// `magarine-run-*` entries deterministic under `node --test`'s concurrent
// file execution: without it, one file's legitimate (not yet cleaned up)
// directory can transiently look new to another file's scan of the shared
// tmpdir() -- measured at one run in six, see batch-4-closeout.md section 5
// item 2.
export function testTempRoot(label: string): TestTempRoot {
  const root = mkdtempSync(join(tmpdir(), `magarine-test-${label}-`));
  return {
    root,
    // Batch 9 housekeeping: a bare, un-retried `rmSync` here hit the exact
    // same transient Windows EPERM/EBUSY this batch root-caused for
    // workspace.ts's own NONE-mode cleanup (a just-exited child process's
    // cwd handle is not always released the instant the OS reports it
    // gone) -- found by counting `magarine-*` leftovers across repeated
    // full-suite runs, the same discipline that originally found it (see
    // db/testSupport.ts's `rmSyncResilient`, already proven for this exact
    // class of race and reused here rather than a second implementation).
    // `after(testRoot.cleanup)`, this file's own established call
    // convention everywhere it's used, already awaits a Promise-returning
    // hook, so this is not a breaking change to any existing caller.
    cleanup: () => rmSyncResilient(root),
  };
}

// Batch 12 section 1 ruling 1: `project create` with no `--dir` now
// defaults to the spawned process's own cwd, not a state-dir-relative path.
// Every test here already isolates its own database via an explicit --db
// or --state-dir, so this derives that SAME already-unique directory as
// the child process's cwd -- rather than leaving cwd unset (which lands
// `project create` in this file's real location on disk; found the hard
// way when a test's SCOPE.md write landed inside packages/core itself)
// or inventing a second, parallel isolation mechanism.
export function deriveTestCliCwd(args: readonly string[]): string | undefined {
  const dbIndex = args.indexOf('--db');
  if (dbIndex !== -1 && args[dbIndex + 1]) return dirname(args[dbIndex + 1]);
  const stateDirIndex = args.indexOf('--state-dir');
  if (stateDirIndex !== -1 && args[stateDirIndex + 1]) return args[stateDirIndex + 1];
  return undefined;
}

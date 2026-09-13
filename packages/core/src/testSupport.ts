import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

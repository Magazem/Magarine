import { mkdirSync, mkdtempSync } from 'node:fs';
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
// or --state-dir, so this derives an already-unique directory as the child
// process's cwd -- rather than leaving cwd unset (which lands `project
// create` in this file's real location on disk; found the hard way when a
// test's SCOPE.md write landed inside packages/core itself) or inventing a
// second, parallel isolation mechanism.
//
// Batch 15 addendum 10, ruling 22: BOTH branches used to return the derived
// directory UNCHANGED -- `dirname(dbFile)` for `--db`, the bare value for
// `--state-dir`. `project create --state-dir X` (no `--dir`, the ordinary
// convenience shape) resolved its project directory to `X` itself; a test
// proving `--db`/`--state-dir` disambiguation legitimately places its db
// file directly inside the state dir (e.g. `join(stateDir, 'other.db')`),
// which reaches the exact same `dirname === stateDir` shape by the OTHER
// branch. Either way: "equal to the state directory," one of the three
// shapes ruling 22 now refuses (a worker with the project directory as its
// boundary must never also have the state directory, and Magarine's own
// database, inside that boundary). That refusal broke 26 tests across the
// suite in total. Fixed HERE, once, on BOTH branches, rather than at any
// call site -- a call-site patch (or fixing only one branch) would leave
// the trap live for every next test anyone writes the natural way, through
// either flag, in any role's file.
//
// Both branches now return a `workspace` subdirectory of whichever
// directory they derived, not that directory itself. A child is neither
// equal to nor an ancestor of the state dir, so ruling 22 permits it; a
// child is also removed by every test's own cleanup of that same directory
// (nothing new leaks into the shared OS temp directory), which a sibling
// directory would not be. `mkdirSync` here is a deliberate, test-only side
// effect in an otherwise-pure "deriver" -- `spawn()` requires an existing
// cwd, and the derived directory may not exist yet at this point (the CLI,
// not this helper, is what would normally create it). A NEW test should
// keep routing through this helper rather than pointing `cwd` at `--db`'s
// directory or `--state-dir` directly -- that is precisely the shape this
// fix removes, on both flags.
export function deriveTestCliCwd(args: readonly string[]): string | undefined {
  const dbIndex = args.indexOf('--db');
  if (dbIndex !== -1 && args[dbIndex + 1]) {
    const cwd = join(dirname(args[dbIndex + 1]), 'workspace');
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }
  const stateDirIndex = args.indexOf('--state-dir');
  if (stateDirIndex !== -1 && args[stateDirIndex + 1]) {
    const cwd = join(args[stateDirIndex + 1], 'workspace');
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }
  return undefined;
}

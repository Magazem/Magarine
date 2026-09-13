import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceType } from './types.ts';

export interface PreparedWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceOptions {
  /** Required for DIRECTORY mode: the project's shared workspace root (projects.workspace_root). */
  workspaceRoot?: string;
  /**
   * Base directory NONE-mode temp directories are created under. Defaults
   * to the OS temp directory (node:os `tmpdir()`), which is the production
   * behaviour and is unchanged by this option's existence. Batch 5 item 3:
   * a test-only injection point so a test file can give itself a private
   * root instead of sharing the OS temp directory with every other
   * concurrently-running test file -- see testSupport.ts's `testTempRoot`.
   * This is what makes a leak-detection assertion that scans a directory
   * for `magarine-run-*` entries deterministic: without it, `node --test`
   * running files concurrently means one file's directory can transiently
   * look new to another file's scan (measured at one run in six -- see
   * batch-4-closeout.md section 5 item 2).
   */
  baseDir?: string;
  /**
   * Test-only seam: replaces the underlying directory removal NONE-mode
   * cleanup retries on failure. Defaults to `rmSync`, which is the
   * production behaviour. Lets a test inject a deterministic failure
   * instead of racing the real, timing-dependent OS condition below.
   */
  removeFn?: (path: string) => void;
  /** Test-only seam: overrides the default retry count for NONE-mode cleanup (see `removeFn`). */
  retryAttempts?: number;
  /** Test-only seam: overrides the default retry backoff, in ms, for NONE-mode cleanup (see `removeFn`). */
  retryDelayMs?: number;
}

// Batch 9 housekeeping item 1 (docs/strategy/batch-9-spec.md section 1
// ruling 1): root cause of the `adapters/claudeCli.test.ts` EPERM flake
// (measured at about one run in twenty). ClaudeCliAdapter calls this
// cleanup() the instant the spawned worker's `close` event fires (see
// claudeCli.ts's comment on why cleanup runs before publish). On Windows, a
// process's current working directory is held open by the OS for the
// process's lifetime, and the handle is not always guaranteed released the
// same instant the `close` event observes the process gone -- the identical
// class of native-handle release delay db/testSupport.ts's rmSyncResilient
// already works around for node:sqlite (HARD-verified there: "a short retry
// loop clears it every time"). An un-retried `rmSync` right after that event
// can observe a transient EPERM/EBUSY from the OS still finishing that
// release. This is production code (NONE-mode cleanup runs on every real
// worker run, not only in tests), so the fix is a bounded retry with linear
// backoff, not a swallowed error -- a persistent failure still surfaces
// (see the "gives up" test in workspace.test.ts), it just is not mistaken
// for one on its first transient EPERM.
async function removeDirectoryResilient(path: string, options: WorkspaceOptions): Promise<void> {
  const removeFn = options.removeFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const attempts = options.retryAttempts ?? 10;
  const delayMs = options.retryDelayMs ?? 100;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      removeFn(path);
      // Deliberately observable, not silent: this line firing at all is the
      // actual evidence the transient-EPERM diagnosis is real (a first
      // attempt failed and a later one didn't touch the same path
      // differently) -- see workspace.test.ts and the Orchestrator's
      // 20-cold-run acceptance check for how this is counted.
      if (attempt > 1) {
        process.stderr.write(`workspace cleanup: removed ${path} after ${attempt} attempt(s)\n`);
      }
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

// NONE: a fresh, disposable temp directory per run, never shared with any
// other ticket. DIRECTORY: one shared directory for the whole project (per
// batch-3-spec.md section 1's ruling — every ticket in the project runs in
// the SAME directory, so a dependent can see what its dependencies wrote).
// This corrects batch 2's `<workspaceRoot>/workspaces/<ticketId>/` layout,
// which gave each ticket its own private directory and was the reason the
// first real end-to-end run's third worker saw an empty workspace: ordering
// worked, output did not flow. `ticketId` is unused for DIRECTORY now but
// kept as a parameter for call-site compatibility with NONE and with
// adapters/claudeCli.ts, which this role does not own and cannot edit.
// GIT_WORKTREE is a real end-goal item, not built in this batch.
export function prepareWorkspace(type: WorkspaceType, ticketId: string, options: WorkspaceOptions = {}): PreparedWorkspace {
  void ticketId;

  if (type === 'NONE') {
    const path = mkdtempSync(join(options.baseDir ?? tmpdir(), 'magarine-run-'));
    return {
      path,
      cleanup: () => removeDirectoryResilient(path, options),
    };
  }

  if (type === 'DIRECTORY') {
    if (!options.workspaceRoot) {
      throw new Error('DIRECTORY workspace requires a workspaceRoot (see projects.workspace_root / --workspace-root).');
    }
    const path = options.workspaceRoot;
    mkdirSync(path, { recursive: true });
    return {
      path,
      // DIRECTORY workspaces persist across runs by design; nothing to clean up.
      cleanup: async () => {},
    };
  }

  throw new Error('GIT_WORKTREE workspace type is not supported yet');
}

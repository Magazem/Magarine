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
    const path = mkdtempSync(join(tmpdir(), 'magarine-run-'));
    return {
      path,
      cleanup: async () => {
        rmSync(path, { recursive: true, force: true });
      },
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

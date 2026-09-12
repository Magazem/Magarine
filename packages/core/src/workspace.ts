import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceType } from './types.ts';

export interface PreparedWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceOptions {
  /** Required for DIRECTORY mode: workspaces live at `<workspaceRoot>/workspaces/<ticketId>/`. */
  workspaceRoot?: string;
}

// NONE: a fresh, disposable temp directory per run. DIRECTORY: a stable,
// never-deleted directory keyed by ticket id under the given workspace root.
// GIT_WORKTREE is a real end-goal item, not built in this batch.
export function prepareWorkspace(type: WorkspaceType, ticketId: string, options: WorkspaceOptions = {}): PreparedWorkspace {
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
      throw new Error('DIRECTORY workspace requires a workspaceRoot (see --workspace-root).');
    }
    const path = join(options.workspaceRoot, 'workspaces', ticketId);
    mkdirSync(path, { recursive: true });
    return {
      path,
      // DIRECTORY workspaces persist across runs by design; nothing to clean up.
      cleanup: async () => {},
    };
  }

  throw new Error('GIT_WORKTREE workspace type is not supported yet');
}

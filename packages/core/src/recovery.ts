import { rmSync } from 'node:fs';
import type { Db } from './db/index.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { finishRun, getTicket, listRunsByStatus } from './store.ts';

export interface RecoveryResult {
  recovered: string[];
}

// Called once at daemon boot, before the scheduler starts ticking. This
// process just started, so it holds no live worker handles; any run still
// marked 'running' in the DB is by definition orphaned from a previous
// process that crashed or was killed mid-run.
//
// Batch 8: also reclaims a NONE-mode orphaned run's disposable temp
// workspace, the same way scheduler.ts's cancelTicketRun already does for
// every other way a run gets cancelled -- by the run's own persisted
// `workspace_ref` column, not an in-memory handle (this process holds none;
// that is the whole premise of "orphaned"). This was a real, pre-existing
// gap: recoverOrphanedRuns has settled the run/ticket rows since Batch 1,
// but never touched the filesystem, so a NONE workspace abandoned by a
// crash or a hard kill was never cleaned up on the next restart -- found by
// measuring `magarine-run-*` directory counts before/after twenty cold runs
// (the same discipline Batch 5 used for the same leak in a different code
// path), not by trusting a green suite. DIRECTORY mode is a real,
// user-owned shared directory and is never touched here, matching every
// other cleanup path in this codebase.
// `removeWorkspace` is a test-only seam (defaults to the real, retrying
// `rmSync` below) so a test can force the removal to fail deterministically
// and prove recovery still settles the run/ticket rows rather than throwing.
export function recoverOrphanedRuns(
  db: Db,
  removeWorkspace: (path: string) => void = (path) =>
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
): RecoveryResult {
  const orphaned = listRunsByStatus(db, 'running');
  const recovered: string[] = [];

  for (const run of orphaned) {
    const ticket = getTicket(db, run.ticketId);
    finishRun(db, run.id, { status: 'failed', failureClass: 'orphaned_on_restart' });
    // Batch 18 ruling 31: an orphaned VERIFIER run is not the ticket's worker
    // dying. The ticket is still in REVIEW (nothing was decided); tick's REVIEW
    // scan verifies it again. No worker_failure, no attempt consumed.
    if (run.kind === 'verify') continue;
    const result = recordTicketTransition(db, {
      ticketId: run.ticketId,
      event: 'worker_failure',
      idempotencyKey: `recovery:${run.id}`,
      payload: { reason: 'orphaned_on_restart', retryable: true, failureClass: 'orphaned_on_restart' },
    });
    if (result.applied) {
      recovered.push(run.id);
    }
    if (ticket?.workspaceType === 'NONE' && run.workspaceRef) {
      try {
        // Batch 9 housekeeping item 1: this runs synchronously at every
        // `serve` startup, before the daemon starts listening. On Windows,
        // a crashed or hard-killed process's cwd handle is not always
        // guaranteed released the instant the OS reports it gone (the same
        // class of native-handle release delay db/testSupport.ts's
        // rmSyncResilient already works around for node:sqlite, and
        // workspace.ts's removeDirectoryResilient now works around for a
        // run's OWN cleanup path) -- the default `removeWorkspace` above
        // uses `rmSync`'s own built-in synchronous backoff for exactly this,
        // chosen over a manual async retry loop here because recovery must
        // stay synchronous (every caller, including `daemon.ts`'s
        // startDaemonLoop, calls it unawaited before the first tick). A
        // persistent failure is caught, not swallowed: recovering the
        // run/ticket rows above must never be undone by a workspace this
        // process can't remove, so it's logged and recovery proceeds --
        // exactly the "crash recovery now handles [a hard kill] including
        // the workspace" ruling, which would otherwise mean "handles it,
        // unless the OS is still cleaning up," i.e. not actually handling
        // it.
        removeWorkspace(run.workspaceRef);
      } catch (err) {
        process.stderr.write(
          `recovery: failed to remove orphaned workspace ${run.workspaceRef}: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  return { recovered };
}

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
export function recoverOrphanedRuns(db: Db): RecoveryResult {
  const orphaned = listRunsByStatus(db, 'running');
  const recovered: string[] = [];

  for (const run of orphaned) {
    const ticket = getTicket(db, run.ticketId);
    finishRun(db, run.id, { status: 'failed', failureClass: 'orphaned_on_restart' });
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
      rmSync(run.workspaceRef, { recursive: true, force: true });
    }
  }

  return { recovered };
}

import type { Db } from './db/index.ts';
import { recordTicketTransition } from './stateMachine.ts';
import { finishRun, listRunsByStatus } from './store.ts';

export interface RecoveryResult {
  recovered: string[];
}

// Called once at daemon boot, before the scheduler starts ticking. This
// process just started, so it holds no live worker handles; any run still
// marked 'running' in the DB is by definition orphaned from a previous
// process that crashed or was killed mid-run.
export function recoverOrphanedRuns(db: Db): RecoveryResult {
  const orphaned = listRunsByStatus(db, 'running');
  const recovered: string[] = [];

  for (const run of orphaned) {
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
  }

  return { recovered };
}

import type { Db } from '../db/index.ts';
import { projectReadiness, type Readiness, type ScopeProbe } from '../readiness.ts';
import { listProjects, listTickets } from '../store.ts';
import type { TicketStatus } from '../types.ts';
import { formatSpend, projectSpendUsd } from './board.ts';

// Batch 10 owner walk finding 2: `project create` printed an id and gave no
// way back to it. Closing the terminal, or simply forgetting the id, made
// the project unreachable -- there was no `project list`. Read-only, like
// board/inbox/status/activity: never routed to a live daemon (see cli.ts's
// "single-writer rule" comment -- reads stay direct either way).

export interface ProjectListEntry {
  id: string;
  name: string;
  defaultModel: string;
  spendUsd: number;
  spendIsEstimate: boolean;
  maxSpendUsd: number | null;
  /** Only statuses with at least one ticket are present -- an empty project has an empty object here, not every status zeroed out. */
  ticketCountsByStatus: Partial<Record<TicketStatus, number>>;
  totalTickets: number;
  /** Batch 16 ruling 24: the first failing readiness rule and its fix, or null when the project is ready to run. `project list` marks a non-null row `needs --dir` so the owner sees a legacy project before a Manager run finds it. */
  readiness: { rule: Readiness['rule']; fix: string } | null;
  /** Ruling 29: where the scope document is and how it stands -- `absent` also covers a project with no scope path at all (path null). `project list` marks a ready row whose document is absent `no scope yet`. */
  scope: { path: string | null; status: 'present' | 'absent' | 'unreadable'; /** The real error, only when `status` is `unreadable`. */ error?: string };
}

export function buildProjectList(db: Db, stateDir: string, probe: ScopeProbe): ProjectListEntry[] {
  return listProjects(db).map((project) => {
    const tickets = listTickets(db, project.id);
    const spend = projectSpendUsd(db, tickets);
    const readiness = projectReadiness(project, stateDir, probe);
    const probed = project.scopePath ? probe(project.scopePath) : ('absent' as const);
    const scope: ProjectListEntry['scope'] =
      typeof probed === 'object'
        ? { path: project.scopePath, status: 'unreadable', error: probed.unreadable }
        : { path: project.scopePath, status: probed };
    const ticketCountsByStatus: Partial<Record<TicketStatus, number>> = {};
    for (const ticket of tickets) {
      ticketCountsByStatus[ticket.status] = (ticketCountsByStatus[ticket.status] ?? 0) + 1;
    }
    return {
      id: project.id,
      name: project.name,
      defaultModel: project.defaultModel,
      spendUsd: spend.costUsd,
      spendIsEstimate: spend.isEstimate,
      maxSpendUsd: project.maxSpendUsd,
      ticketCountsByStatus,
      totalTickets: tickets.length,
      readiness: readiness ? { rule: readiness.rule, fix: readiness.fix } : null,
      scope,
    };
  });
}

export function formatProjectList(entries: ProjectListEntry[]): string {
  if (entries.length === 0) {
    return '(no projects yet -- create one with `magarine project create --name "..."`)';
  }
  return entries
    .map((entry) => {
      const spend = formatSpend(entry.spendUsd, entry.spendIsEstimate);
      const cap = entry.maxSpendUsd === null ? 'no cap set' : `cap $${entry.maxSpendUsd.toFixed(2)}`;
      const counts =
        entry.totalTickets === 0
          ? 'no tickets'
          : Object.entries(entry.ticketCountsByStatus)
              .map(([status, count]) => `${status} ${count}`)
              .join(', ');
      const columns = [entry.id, entry.name, `model ${entry.defaultModel}`, `${spend} (${cap})`, counts];
      // One word per unready row (ruling 24 point 3); the fix itself is named by `--json`'s readiness.fix and by the pause line.
      if (entry.readiness) columns.push(entry.readiness.rule === 'unreadable_scope_file' ? 'scope unreadable' : 'needs --dir');
      else if (entry.scope.status === 'absent') columns.push('no scope yet');
      return columns.join('\t');
    })
    .join('\n');
}

import type { Db } from '../db/index.ts';
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
}

export function buildProjectList(db: Db): ProjectListEntry[] {
  return listProjects(db).map((project) => {
    const tickets = listTickets(db, project.id);
    const spend = projectSpendUsd(db, tickets);
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
      return [entry.id, entry.name, `model ${entry.defaultModel}`, `${spend} (${cap})`, counts].join('\t');
    })
    .join('\n');
}

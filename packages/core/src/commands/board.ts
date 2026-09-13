import type { Db } from '../db/index.ts';
import { getDependencies, getTicket, listTickets } from '../store.ts';
import type { Ticket, TicketStatus } from '../types.ts';

// `board`: every ticket in a project, its attempts, its cost, and what is
// still blocking it. Read-only; touches no other role's files.

export interface BoardTicket {
  id: string;
  title: string;
  status: TicketStatus;
  attemptCount: number;
  maxAttempts: number;
  costUsd: number;
  blockedBy: string[];
}

export interface BoardResult {
  /** Sum of `costUsd` over every ticket in the project. */
  projectSpendUsd: number;
  /** `projects.max_spend_usd`, or null when no cap is set (or the column does not exist yet). */
  projectMaxSpendUsd: number | null;
  tickets: BoardTicket[];
}

// Read order for the human view: what a person is most likely to want to
// look at first (things that need attention or are moving) before the
// quiet/terminal statuses.
const STATUS_ORDER: TicketStatus[] = [
  'BLOCKED',
  'FAILED',
  'IN_PROGRESS',
  'REVIEW',
  'READY',
  'OPEN',
  'DONE',
  'CANCELLED',
];

// Ticket cost is the sum of `total_cost_usd` across the ticket's runs'
// `usage_json` (contract fixed by batch-3-spec.md so Role F and this role
// don't need to coordinate on it). `usage_json` is an opaque, adapter-defined
// blob that this codebase never validates (see store.ts's `setRunUsage`);
// a run with no usage recorded, or a shape without `total_cost_usd`,
// contributes nothing rather than throwing.
function ticketCostUsd(db: Db, ticketId: string): number {
  const rows = db.prepare('SELECT usage_json FROM runs WHERE ticket_id = ?').all(ticketId) as Array<{
    usage_json: string | null;
  }>;
  let total = 0;
  for (const row of rows) {
    if (!row.usage_json) continue;
    try {
      const usage = JSON.parse(row.usage_json) as { total_cost_usd?: unknown };
      if (typeof usage.total_cost_usd === 'number') total += usage.total_cost_usd;
    } catch {
      // Malformed adapter-defined JSON contributes nothing rather than
      // crashing the board.
    }
  }
  return total;
}

function blockingDependencies(db: Db, ticket: Ticket): string[] {
  return getDependencies(db, ticket.id)
    .filter((d) => d.dependencyType === 'blocks')
    .map((d) => d.dependsOnTicketId)
    .filter((depId) => getTicket(db, depId)?.status !== 'DONE');
}

// Project spend is the sum of ticket spend over every ticket in the
// project (batch-4-spec.md section 2's "Contracts" note), computed here
// from the tickets `buildBoard` already loaded rather than re-querying.
function projectSpendUsd(db: Db, tickets: Ticket[]): number {
  return tickets.reduce((total, t) => total + ticketCostUsd(db, t.id), 0);
}

// `projects.max_spend_usd` (the project-level spend cap, ruling 1 layer 1)
// is Role H's column to add and may not exist in a given database yet. A
// missing column, or no cap set, both read as "no cap" here rather than
// throwing -- the board must never crash because an optional feature's
// column has not landed.
function projectMaxSpendUsd(db: Db, projectId: string): number | null {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'max_spend_usd')) return null;
  const row = db.prepare('SELECT max_spend_usd FROM projects WHERE id = ?').get(projectId) as
    | { max_spend_usd: number | null }
    | undefined;
  return row?.max_spend_usd ?? null;
}

export function buildBoard(db: Db, projectId: string): BoardResult {
  const tickets = listTickets(db, projectId)
    .slice()
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  return {
    projectSpendUsd: projectSpendUsd(db, tickets),
    projectMaxSpendUsd: projectMaxSpendUsd(db, projectId),
    tickets: tickets.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      attemptCount: t.attemptCount,
      maxAttempts: t.maxAttempts,
      costUsd: ticketCostUsd(db, t.id),
      blockedBy: blockingDependencies(db, t),
    })),
  };
}

// Project spend against its cap comes first, since it is the one number
// that tells a reader whether anything here needs their attention before
// they read a single ticket row. Ticket id first on every ticket line, per
// this role's brief: it's the next thing a person copies.
export function formatBoard(result: BoardResult): string {
  const spend = `$${result.projectSpendUsd.toFixed(2)}`;
  const cap = result.projectMaxSpendUsd === null ? 'no cap set' : `cap $${result.projectMaxSpendUsd.toFixed(2)}`;
  const header = `Project spend: ${spend} (${cap})`;

  if (result.tickets.length === 0) return `${header}\n(no tickets)`;

  const rows = result.tickets
    .map((t) => {
      const attempts = `attempts ${t.attemptCount}/${t.maxAttempts}`;
      const cost = `cost $${t.costUsd.toFixed(2)}`;
      const blocked = t.blockedBy.length > 0 ? `blocked by ${t.blockedBy.join(', ')}` : '';
      const parts = [t.id, t.status, t.title, attempts, cost, blocked].filter((p) => p.length > 0);
      return parts.join('\t');
    })
    .join('\n');

  return `${header}\n${rows}`;
}

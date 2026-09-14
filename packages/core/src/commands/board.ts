import type { Db } from '../db/index.ts';
import { getDependencies, getProject, getTicket, listTickets } from '../store.ts';
import type { Ticket, TicketKind, TicketStatus } from '../types.ts';
import { describeProjectPause } from './inbox.ts';

// `board`: every ticket in a project, its attempts, its cost, and what is
// still blocking it. Read-only; touches no other role's files.

export interface BoardTicket {
  id: string;
  title: string;
  status: TicketStatus;
  /** Batch 9: 'work' (the default; every ticket before this batch) or 'manager'. formatBoard tags 'manager' rows distinctly -- see its own comment for why that matters once planning is used in anger. */
  kind: TicketKind;
  attemptCount: number;
  maxAttempts: number;
  costUsd: number;
  /** Batch 6: true if any run contributing to costUsd carries `usage_json.source === 'scheduler_budget_estimate'` -- the daemon's own live tally (pricing.ts/claudeCli.ts), a known lower bound, not the tool's exact figure. The Strategist's ruling: label it "at least $x, live estimate" rather than showing a number that looks as exact as a completed run's. */
  costIsEstimate: boolean;
  blockedBy: string[];
}

export interface BoardResult {
  /** Sum of `costUsd` over every ticket in the project. */
  projectSpendUsd: number;
  /** True if any ticket's costIsEstimate is true -- see BoardTicket.costIsEstimate. A sum with even one estimated component is itself only a lower bound. */
  projectSpendIsEstimate: boolean;
  /** `projects.max_spend_usd`, or null when no cap is set. */
  projectMaxSpendUsd: number | null;
  /** Batch 11 rule a: null when not paused. Same wording commands/inbox.ts uses for this pause's inbox line -- see describeProjectPause, this field's one composer -- so the board and the inbox never say two different things about the same pause. */
  pauseMessage: string | null;
  /** Batch 11 item 3 (the page): the same cause as `pauseMessage`, but structured, so a caller (the page) can decide WHICH fix to offer (a max-spend form vs a plain resume button) without parsing the message text. Null whenever pauseMessage is null. */
  pauseReason: 'spend_cap' | 'adapter_unavailable' | null;
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
//
// Batch 6: a run stopped by the daemon's own estimate (scheduler.ts's
// budget-stop branch) stores `source: 'scheduler_budget_estimate'` on that
// same usage_json -- the one marker that distinguishes "the tool's own
// authoritative total" from "our known-low mid-run tally, frozen at the
// moment we stopped the worker" (see claudeCli.ts's messageModel/priceUsage
// header for why it's known-low). One estimated run in the sum makes the
// whole sum a lower bound, so `isEstimate` is true if ANY contributing run
// is estimate-sourced, not just the most recent one.
export function ticketCostUsd(db: Db, ticketId: string): { costUsd: number; isEstimate: boolean } {
  const rows = db.prepare('SELECT usage_json FROM runs WHERE ticket_id = ?').all(ticketId) as Array<{
    usage_json: string | null;
  }>;
  let total = 0;
  let isEstimate = false;
  for (const row of rows) {
    if (!row.usage_json) continue;
    try {
      const usage = JSON.parse(row.usage_json) as { total_cost_usd?: unknown; source?: unknown };
      if (typeof usage.total_cost_usd === 'number') {
        total += usage.total_cost_usd;
        if (usage.source === 'scheduler_budget_estimate') isEstimate = true;
      }
    } catch {
      // Malformed adapter-defined JSON contributes nothing rather than
      // crashing the board.
    }
  }
  return { costUsd: total, isEstimate };
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
export function projectSpendUsd(db: Db, tickets: Ticket[]): { costUsd: number; isEstimate: boolean } {
  let total = 0;
  let isEstimate = false;
  for (const t of tickets) {
    const c = ticketCostUsd(db, t.id);
    total += c.costUsd;
    if (c.isEstimate) isEstimate = true;
  }
  return { costUsd: total, isEstimate };
}

export function buildBoard(db: Db, projectId: string): BoardResult {
  const tickets = listTickets(db, projectId)
    .slice()
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  const projectSpend = projectSpendUsd(db, tickets);
  const project = getProject(db, projectId);
  const isPaused = project !== undefined && project.adapterPausedAt != null;
  const pauseMessage = isPaused ? describeProjectPause(db, project, project.pauseReason).message : null;

  return {
    projectSpendUsd: projectSpend.costUsd,
    projectSpendIsEstimate: projectSpend.isEstimate,
    projectMaxSpendUsd: project?.maxSpendUsd ?? null,
    pauseMessage,
    pauseReason: isPaused ? project.pauseReason : null,
    tickets: tickets.map((t) => {
      const c = ticketCostUsd(db, t.id);
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        kind: t.kind,
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        costUsd: c.costUsd,
        costIsEstimate: c.isEstimate,
        blockedBy: blockingDependencies(db, t),
      };
    }),
  };
}

// Batch 6, per the Strategist's ruling: a number sourced from the daemon's
// own live tally reads "at least $x, live estimate" rather than looking as
// exact as a completed run's tool-reported figure. Shared by the project
// header and every ticket row so the two can never drift into different
// phrasings.
export function formatSpend(costUsd: number, isEstimate: boolean): string {
  return isEstimate ? `at least $${costUsd.toFixed(2)}, live estimate` : `$${costUsd.toFixed(2)}`;
}

// Batch 10 owner walk, finding 4: a mission handed in as a real markdown
// scope document (per the root README's `--mission "$(cat scope.md)"`)
// becomes its manager ticket's title verbatim -- newlines and all, since
// nothing between the CLI flag and `tickets.title` ever reshapes it -- so
// one board row broke across several lines and became unreadable with a
// real document (a scope document often opens with a blank line or two
// before its actual heading, which is why this is the FIRST NON-EMPTY line,
// not simply the first line -- a leading blank line would otherwise
// truncate to nothing). Display-only, and used only here and by `status`'s
// human line (cli.ts): nothing stored changes, `--json` output still
// carries the full, untouched title, and so does everywhere else that
// already read it. `--scope <file>` as its own real flag is batch 11's
// problem, not this one's -- this is strictly a rendering fix.
const MAX_DISPLAY_TITLE_LENGTH = 80;

export function truncateTitleForDisplay(title: string): string {
  const lines = title.split(/\r?\n/);
  const firstNonEmpty = lines.find((line) => line.trim().length > 0) ?? '';
  if (firstNonEmpty === title && firstNonEmpty.length <= MAX_DISPLAY_TITLE_LENGTH) return title;
  return `${firstNonEmpty.slice(0, MAX_DISPLAY_TITLE_LENGTH)}…`;
}

// Batch 11 rule a: a paused project's board must say so before anything
// else. A ticket still reading READY while paused is not about to run --
// nothing starts again until the reason is addressed -- so burying that fact
// below the ticket rows would let a reader mistake READY for "queued to go."
// Same wording as this pause's inbox line (describeProjectPause, board.ts's
// buildBoard), so the two surfaces never disagree about the same pause.
function pausedLine(pauseMessage: string): string {
  return `PAUSED: ${pauseMessage}`;
}

// Project spend against its cap comes first, since it is the one number
// that tells a reader whether anything here needs their attention before
// they read a single ticket row. Ticket id first on every ticket line, per
// this role's brief: it's the next thing a person copies.
export function formatBoard(result: BoardResult): string {
  const spend = formatSpend(result.projectSpendUsd, result.projectSpendIsEstimate);
  const cap = result.projectMaxSpendUsd === null ? 'no cap set' : `cap $${result.projectMaxSpendUsd.toFixed(2)}`;
  const spendHeader = `Project spend: ${spend} (${cap})`;
  const header = result.pauseMessage !== null ? `${pausedLine(result.pauseMessage)}\n${spendHeader}` : spendHeader;

  if (result.tickets.length === 0) return `${header}\n(no tickets)`;

  const rows = result.tickets
    .map((t) => {
      // Batch 9: a manager ticket sitting in the same list as work tickets,
      // indistinguishable, would make the board harder to read the moment
      // planning is actually used -- proposing tickets, not doing work
      // itself, is the entire point of the design, and a reader needs to
      // see that at a glance, not infer it from the title happening to
      // start with "Plan:".
      const title = t.kind === 'manager' ? `[MANAGER] ${truncateTitleForDisplay(t.title)}` : truncateTitleForDisplay(t.title);
      const attempts = `attempts ${t.attemptCount}/${t.maxAttempts}`;
      const cost = `cost ${formatSpend(t.costUsd, t.costIsEstimate)}`;
      const blocked = t.blockedBy.length > 0 ? `blocked by ${t.blockedBy.join(', ')}` : '';
      const parts = [t.id, t.status, title, attempts, cost, blocked].filter((p) => p.length > 0);
      return parts.join('\t');
    })
    .join('\n');

  return `${header}\n${rows}`;
}

import type { Db } from '../db/index.ts';
import { isKnownModel } from '../pricing.ts';
import { countWorkTicketsInProgress, getDependencies, getProject, getTicket, getWorkerProfile, listArtifactsForTicket, listEventsForEntity, listRunsForTicket, listTickets } from '../store.ts';
import type { PauseReason, Ticket, TicketKind, TicketStatus } from '../types.ts';
import type { ActivityState } from './activity.ts';
import { describeProjectPause, reasonFor } from './inbox.ts';

// Batch 15 item 4: "the run's failure reason says so on the board." Only
// meaningful while the ticket is actually sitting in FAILED -- a ticket
// that failed once and was since retried back to READY (or beyond) is not
// currently failing, so its stale last reason would mislead a reader into
// thinking a live problem still exists. Reuses reasonFor (commands/
// inbox.ts) rather than a second, board-specific rendering of the same
// event, so the board and the inbox can never say two different things
// about the same failure.
function computeLastFailureReason(db: Db, ticket: Ticket): string | null {
  if (ticket.status !== 'FAILED') return null;
  const events = listEventsForEntity(db, 'ticket', ticket.id).filter((e) => e.eventType === 'worker_failed_final');
  const last = events.at(-1);
  if (!last) return null;
  return reasonFor(last.eventType, last.payload, ticket.id);
}

// Ruling 7 (batch-15-spec.md section 3, Role A item 1): the shape of a
// board row's own activity marker, contract-fixed with Role B: `state` is
// one of ActivityState's six values, `tool` is the raw tool name (null for
// a text line), `at` is the underlying event's createdAt, `sequence` is its
// events.sequence -- the same identifier the streamed route (daemonApi.ts)
// uses as an SSE frame's `id`, so the two surfaces can be cross-referenced.
export interface LatestActivity {
  state: ActivityState;
  tool: string | null;
  at: string;
  sequence: number;
}

// "RUNNING" in the brief has no literal TicketStatus of that name -- the
// one status that means a worker is actually attached to this ticket right
// now is IN_PROGRESS (see types.ts's TicketStatus and stateMachine.ts's
// TRANSITIONS table: every other status is either not-yet-started or
// settled). Read as a plain English gloss for IN_PROGRESS, not a status
// this codebase is missing.
//
// Gated on status BEFORE touching the DB again: buildBoard already does one
// query per ticket for cost and artefacts (see ticketCostUsd/
// listArtifactsForTicket below), and most boards are mostly DONE/CANCELLED
// rows for which this would otherwise be a wasted run+event lookup.
function computeLatestActivity(db: Db, ticket: Ticket): LatestActivity | null {
  if (ticket.status !== 'IN_PROGRESS') return null;
  const runs = listRunsForTicket(db, ticket.id);
  const currentRun = runs.filter((r) => r.status === 'running').at(-1);
  if (!currentRun) return null;

  const progressEvents = listEventsForEntity(db, 'run', currentRun.id).filter((e) => e.eventType === 'worker_progress');
  const last = progressEvents.at(-1);
  if (!last) return null;

  const payload = last.payload as { tool?: string | null; state?: ActivityState };
  if (!payload.state) return null;
  return { state: payload.state, tool: payload.tool ?? null, at: last.createdAt, sequence: last.sequence };
}

// `board`: every ticket in a project, its attempts, its cost, and what is
// still blocking it. Read-only; touches no other role's files.

// Batch 13 ruling 1c: "the board and the page show each ticket's artefacts
// next to its status, count and paths, so a DONE row is legible as what it
// produced." One field regardless of kind (a resolved path for 'file', the
// worker's own text/URL otherwise), same display-only shape as
// TicketEnvelopeArtifact (types.ts) and for the same reason: this is
// rendering, not a validation boundary, so it does not need to be
// exhaustive about every kind separately.
export interface BoardArtifact {
  kind: string;
  content: string;
}

export interface BoardTicket {
  id: string;
  title: string;
  status: TicketStatus;
  /** Batch 9: 'work' (the default; every ticket before this batch) or 'manager'. formatBoard tags 'manager' rows distinctly -- see its own comment for why that matters once planning is used in anger. */
  kind: TicketKind;
  /** Batch 18 ruling 34: true on a manager ticket the scheduler created itself when the board drained (title "Manager: review progress"); false on every other ticket. */
  automatic: boolean;
  attemptCount: number;
  maxAttempts: number;
  costUsd: number;
  /** Batch 6: true if any run contributing to costUsd carries `usage_json.source === 'scheduler_budget_estimate'` -- the daemon's own live tally (pricing.ts/claudeCli.ts), a known lower bound, not the tool's exact figure. The Strategist's ruling: label it "at least $x, live estimate" rather than showing a number that looks as exact as a completed run's. */
  costIsEstimate: boolean;
  /** Batch 12: true if any run contributing to costUsd carries a `usage_json.model` unrecognized by pricing.ts (see `unknown_model_rate`'s policy.ts comment) -- priced at the conservative fallback rate, not that model's real one. Read from usage_json, not from the `unknown_model_rate` event, by design: the event is activity-only (it names no owner decision), but the caveat still belongs beside the number the owner is already reading. */
  usedFallbackRate: boolean;
  /** Batch 12 item 3: `tickets.model`'s own override, null when the ticket falls back to the project default. Shown alongside modelReason so a Manager's choice (and, per the close-out's model-choice run, whether it differentiated at all) is visible without opening the ticket. */
  model: string | null;
  /** Batch 12 item 3: the Manager's one-line justification, required by proposal.ts whenever a create_ticket/update_ticket command sets model. Null for a ticket whose model was never explicitly set (including one set directly via `ticket add --model`, which carries no reason -- see proposal.ts's own comment on why the requirement is scoped to the Manager's two commands). */
  modelReason: string | null;
  /** Batch 19 mini-phase 1A (worker-profiles-design.md section 5): the assigned profile's id and name, or null for a profile-less ticket -- mutually exclusive with `model` (store.ts's createTicket). Looked up fresh on every board build rather than denormalized onto the ticket row, since a retired profile's name must still show here (retirement only hides it from `GET /profiles`/`profile list`, never from a ticket that already carries it). */
  profile: { id: string; name: string } | null;
  /** Batch 19 mini-phase 2A (ruling 37): the Manager's own one-line justification for `profile`, shown alongside it the same way `modelReason` is shown alongside `model`. Null for a profile-less ticket, or one whose profile was set directly rather than through a Manager command. */
  profileReason: string | null;
  /** Batch 13 ruling 1c: every artefact this ticket has declared, across every run -- so a DONE row is legible as what it actually produced, not just that it succeeded. */
  artifacts: BoardArtifact[];
  /** Batch 15 ruling 7: the current run's most recent worker_progress event, mapped to an activity state -- null for any ticket not currently IN_PROGRESS, or one that is but has not reported progress yet. See LatestActivity/computeLatestActivity above. */
  latestActivity: LatestActivity | null;
  /** Batch 15 item 4: the reason for a ticket's own current FAILED status, the same rendering the inbox uses for the same event -- null for any ticket not currently FAILED. See computeLastFailureReason above. */
  lastFailureReason: string | null;
  blockedBy: string[];
}

export interface BoardResult {
  /** Sum of `costUsd` over every ticket in the project. */
  projectSpendUsd: number;
  /** True if any ticket's costIsEstimate is true -- see BoardTicket.costIsEstimate. A sum with even one estimated component is itself only a lower bound. */
  projectSpendIsEstimate: boolean;
  /** True if any ticket's usedFallbackRate is true -- see BoardTicket.usedFallbackRate. */
  projectUsedFallbackRate: boolean;
  /** `projects.max_spend_usd`, or null when no cap is set. */
  projectMaxSpendUsd: number | null;
  /** Batch 11 rule a: null when not paused. Same wording commands/inbox.ts uses for this pause's inbox line -- see describeProjectPause, this field's one composer -- so the board and the inbox never say two different things about the same pause. */
  pauseMessage: string | null;
  /** Batch 11 item 3 (the page): the same cause as `pauseMessage`, but structured, so a caller (the page) can decide WHICH fix to offer (a max-spend form vs a plain resume button) without parsing the message text. Null whenever pauseMessage is null. */
  pauseReason: PauseReason | null;
  /** Batch 16 item 4 (ruling 23): the machine-wide picture of parallelism. `used` is every IN_PROGRESS ticket across ALL projects (the ceiling is machine-wide, so only a machine-wide count is comparable with it); `cap` is the daemon's `--max-parallel`, or null when the caller has no daemon to ask (the offline `board` command reads the database alone and cannot know it). */
  slots: Slots;
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
export function ticketCostUsd(db: Db, ticketId: string): { costUsd: number; isEstimate: boolean; usedFallbackRate: boolean } {
  const rows = db.prepare('SELECT usage_json FROM runs WHERE ticket_id = ?').all(ticketId) as Array<{
    usage_json: string | null;
  }>;
  let total = 0;
  let isEstimate = false;
  let usedFallbackRate = false;
  for (const row of rows) {
    if (!row.usage_json) continue;
    try {
      const usage = JSON.parse(row.usage_json) as { total_cost_usd?: unknown; source?: unknown; model?: unknown };
      if (typeof usage.total_cost_usd === 'number') {
        total += usage.total_cost_usd;
        if (usage.source === 'scheduler_budget_estimate') isEstimate = true;
      }
      if (typeof usage.model === 'string' && !isKnownModel(usage.model)) usedFallbackRate = true;
    } catch {
      // Malformed adapter-defined JSON contributes nothing rather than
      // crashing the board.
    }
  }
  return { costUsd: total, isEstimate, usedFallbackRate };
}

// Batch 19 mini-phase 1A: `BoardTicket.profile`'s one composer -- null for a
// profile-less ticket; a fresh lookup (never denormalized onto the ticket
// row) so a retired profile's name still shows on a ticket that already
// carries its id (retirement hides a profile from GET /profiles/`profile
// list`, never from a ticket that already references it).
function boardTicketProfile(db: Db, profileId: string | null): { id: string; name: string } | null {
  if (profileId == null) return null;
  const p = getWorkerProfile(db, profileId);
  return p ? { id: p.id, name: p.name } : null;
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
export function projectSpendUsd(db: Db, tickets: Ticket[]): { costUsd: number; isEstimate: boolean; usedFallbackRate: boolean } {
  let total = 0;
  let isEstimate = false;
  let usedFallbackRate = false;
  for (const t of tickets) {
    const c = ticketCostUsd(db, t.id);
    total += c.costUsd;
    if (c.isEstimate) isEstimate = true;
    if (c.usedFallbackRate) usedFallbackRate = true;
  }
  return { costUsd: total, isEstimate, usedFallbackRate };
}

/** `BoardResult.slots`. Batch 19 ruling 39, amended: `capFlag` is the daemon's own `serve --max-parallel` value, or null when it was started without one -- the one thing that decides whether a saved `max_parallel_workers` setting is in force (store.ts's resolveMachineCap returns the flag before it reads the setting). Given as a field because the page cannot infer it: with no setting saved, a cap of 1 is either `--max-parallel 1` or the fallback. Null too for the offline `board` command, which has no daemon. */
export interface Slots { used: number; cap: number | null; capFlag: number | null }

// One place for the machine-wide slots picture, shared by `GET /board` and
// `GET /health` (which `status` reads) so the two can never disagree.
export function buildSlots(db: Db, machineCap: number | null, capFlag: number | null = null): Slots {
  return { used: countWorkTicketsInProgress(db), cap: machineCap, capFlag };
}

export function buildBoard(db: Db, projectId: string, machineCap: number | null = null, capFlag: number | null = null): BoardResult {
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
    projectUsedFallbackRate: projectSpend.usedFallbackRate,
    projectMaxSpendUsd: project?.maxSpendUsd ?? null,
    pauseMessage,
    pauseReason: isPaused ? project.pauseReason : null,
    slots: buildSlots(db, machineCap, capFlag),
    tickets: tickets.map((t) => {
      const c = ticketCostUsd(db, t.id);
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        kind: t.kind,
        automatic: t.automatic,
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        costUsd: c.costUsd,
        costIsEstimate: c.isEstimate,
        usedFallbackRate: c.usedFallbackRate,
        model: t.model,
        modelReason: t.modelReason,
        profile: boardTicketProfile(db, t.profileId),
        profileReason: t.profileReason,
        artifacts: listArtifactsForTicket(db, t.id).map((a) => ({
          kind: a.kind,
          content: a.kind === 'file' ? a.pathOrUri : (a.text ?? ''),
        })),
        latestActivity: computeLatestActivity(db, t),
        lastFailureReason: computeLastFailureReason(db, t),
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
// Batch 12: `usedFallbackRate` defaults to false so every pre-existing
// caller (this file's own formatBoard included, before the edit below) and
// every existing test keeps working unedited; only a caller that actually
// has the flag needs to pass it.
export function formatSpend(costUsd: number, isEstimate: boolean, usedFallbackRate: boolean = false): string {
  const amount = isEstimate ? `at least $${costUsd.toFixed(2)}, live estimate` : `$${costUsd.toFixed(2)}`;
  return usedFallbackRate ? `${amount} (estimated at fallback rate)` : amount;
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
  const spend = formatSpend(result.projectSpendUsd, result.projectSpendIsEstimate, result.projectUsedFallbackRate);
  const cap = result.projectMaxSpendUsd === null ? 'no cap set' : `cap $${result.projectMaxSpendUsd.toFixed(2)}`;
  // Batch 12 item 4: "equivalent API cost", not "spend" -- the owner tests
  // on a subscription, so nothing here is money actually leaving their
  // account (batch-11-closeout.md section 1); the figure is reported only
  // because it is the one comparable unit across models and runs, and the
  // real constraint on a subscription is session limits, not dollars.
  const spendHeader = `Equivalent API cost: ${spend} (${cap}) -- on a subscription, the real constraint is session limits, not dollars.`;
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
      const cost = `cost ${formatSpend(t.costUsd, t.costIsEstimate, t.usedFallbackRate)}`;
      const model = t.model ? `model ${t.model}${t.modelReason ? ` (${t.modelReason})` : ''}` : '';
      // Batch 19 mini-phase 2A fix round (second reviewer's Medium): shown
      // the same way `model`/`modelReason` are above -- before this fix the
      // rendered text board named neither the profile nor its reason at all.
      const profile = t.profile ? `profile ${t.profile.name}${t.profileReason ? ` (${t.profileReason})` : ''}` : '';
      // Batch 13 ruling 1c: a DONE row must be legible as what it actually
      // produced, not just that it succeeded -- count and content, so
      // "reported done" and "delivered nothing" can never look the same on
      // this board again.
      const artifacts =
        t.artifacts.length > 0
          ? `artifacts (${t.artifacts.length}): ${t.artifacts.map((a) => a.content).join(', ')}`
          : '';
      const blocked = t.blockedBy.length > 0 ? `blocked by ${t.blockedBy.join(', ')}` : '';
      const failureReason = t.lastFailureReason ? `reason: ${t.lastFailureReason}` : '';
      const parts = [t.id, t.status, title, attempts, cost, model, profile, artifacts, blocked, failureReason].filter((p) => p.length > 0);
      return parts.join('\t');
    })
    .join('\n');

  return `${header}\n${rows}`;
}

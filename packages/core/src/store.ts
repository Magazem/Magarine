import { join } from 'node:path';
import type { Db } from './db/index.ts';
import { newId } from './id.ts';
import { classify } from './policy.ts';
import type {
  Artifact,
  DependencyType,
  EventRow,
  EventVisibility,
  Project,
  Run,
  RunStatus,
  Ticket,
  TicketDependency,
  TicketKind,
  TicketStatus,
  WorkspaceType,
} from './types.ts';

// Plain data access: reads and inserts that are not the ticket-status
// transition itself. `stateMachine.ts` is the only module allowed to write
// `tickets.status`.

// Batch 4 section 1 ruling 1, layer 2: no ceiling (project max_budget_usd or
// ticket max_budget_usd_override) may be set below this floor. SOFT --
// derived from batch 2/3's measured per-ticket cost ($0.10-0.63), set from
// the higher end of that range so it doesn't lie on a cheaper day. Lives in
// exactly one place; every setter below enforces it.
export const MIN_BUDGET_USD = 0.25;

function assertAboveFloor(value: number, label: string): void {
  if (value < MIN_BUDGET_USD) {
    throw new Error(`${label} must be at least $${MIN_BUDGET_USD.toFixed(2)}, got $${value.toFixed(2)}`);
  }
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  default_adapter: string | null;
  max_parallel_workers: number;
  max_budget_usd: number;
  max_spend_usd: number | null;
  default_model: string;
  brief: string | null;
  workspace_root: string | null;
  adapter_paused_at: string | null;
  manager_model: string | null;
  scope_path: string | null;
  pause_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultAdapter: row.default_adapter,
    maxParallelWorkers: row.max_parallel_workers,
    maxBudgetUsd: row.max_budget_usd,
    maxSpendUsd: row.max_spend_usd,
    defaultModel: row.default_model,
    brief: row.brief,
    workspaceRoot: row.workspace_root,
    adapterPausedAt: row.adapter_paused_at,
    managerModel: row.manager_model,
    scopePath: row.scope_path,
    pauseReason: row.pause_reason === 'spend_cap' || row.pause_reason === 'adapter_unavailable' ? row.pause_reason : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProject(
  db: Db,
  input: {
    name: string;
    description?: string | null;
    defaultAdapter?: string | null;
    maxParallelWorkers?: number;
    maxBudgetUsd?: number;
    maxSpendUsd?: number | null;
    defaultModel?: string;
    brief?: string | null;
    workspaceRoot?: string | null;
    managerModel?: string | null;
    scopePath?: string | null;
  }
): Project {
  const maxBudgetUsd = input.maxBudgetUsd ?? 2.0;
  assertAboveFloor(maxBudgetUsd, 'a project\'s max_budget_usd');
  if (input.maxSpendUsd != null) {
    assertAboveFloor(input.maxSpendUsd, 'a project\'s max_spend_usd');
  }
  // Same default as db/schema.ts's 0006_model_pinning migration default for
  // existing rows -- kept explicit here (rather than relying on the column
  // DEFAULT and omitting it from the INSERT) so a caller reading `Project`
  // back never has to guess which value a bare `createProject` produced,
  // matching how maxBudgetUsd's `?? 2.0` above is explicit despite 0003 also
  // giving that column its own SQL-level default.
  const defaultModel = input.defaultModel ?? 'claude-sonnet-5';

  const now = new Date().toISOString();
  const id = newId('proj');
  db.prepare(
    `INSERT INTO projects (id, name, description, default_adapter, max_parallel_workers, max_budget_usd, max_spend_usd, default_model, brief, workspace_root, manager_model, scope_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.description ?? null,
    input.defaultAdapter ?? null,
    input.maxParallelWorkers ?? 1,
    maxBudgetUsd,
    input.maxSpendUsd ?? null,
    defaultModel,
    input.brief ?? null,
    input.workspaceRoot ?? null,
    input.managerModel ?? null,
    input.scopePath ?? null,
    now,
    now
  );
  return getProject(db, id)!;
}

// Batch 11's low-level setter, superseded as a CLI surface in batch 12 by
// `setProjectDir` below (`project create --dir`/`project set --dir` now own
// where a project's scope document lives, since a project has exactly one
// directory and scope_path is one of the two things that derive from it --
// see that function's doc comment). Still used internally wherever a scope
// path needs setting on its own, e.g. `writeScopeText`'s own callers.
// `null` clears it (falls back to "no scope file", per readScopeText's own
// doc comment).
export function setProjectScopePath(db: Db, projectId: string, scopePath: string | null): void {
  db.prepare('UPDATE projects SET scope_path = ?, updated_at = ? WHERE id = ?').run(
    scopePath,
    new Date().toISOString(),
    projectId
  );
}

// Batch 12 ruling 1: "a project has exactly one directory." `dir` becomes
// BOTH workspace_root (the shared DIRECTORY workspace, unchanged meaning)
// and scope_path's parent (`<dir>/SCOPE.md`, the fixed filename -- there is
// no `--scope <file>` any more to name a different one). One function, one
// write site for both columns together, so the two can never independently
// drift the way workspace_root/scope_path could before this batch (see
// db/schema.ts's 0010 migration for how an existing drifted pair is healed).
// `project create --dir` and `project set --dir` (cli.ts) are the only
// callers; `dir` is never null here -- `project create` always resolves one
// (defaulting to the current working directory), so a project can no longer
// exist without a directory at all.
export function setProjectDir(db: Db, projectId: string, dir: string): void {
  db.prepare('UPDATE projects SET workspace_root = ?, scope_path = ?, updated_at = ? WHERE id = ?').run(
    dir,
    join(dir, 'SCOPE.md'),
    new Date().toISOString(),
    projectId
  );
}

// Setter for a future `project set --manager-model` to call, matching
// setProjectDefaultModel's shape exactly. `null` clears the override (falls
// back to the project's own default_model -- see resolveManagerModel).
export function setProjectManagerModel(db: Db, projectId: string, managerModel: string | null): void {
  db.prepare('UPDATE projects SET manager_model = ?, updated_at = ? WHERE id = ?').run(
    managerModel,
    new Date().toISOString(),
    projectId
  );
}

// Setter for `ticket add --budget`/a future `project set --max-budget` to
// call instead of writing the column directly, so the floor is enforced no
// matter which surface sets it.
export function setProjectMaxBudgetUsd(db: Db, projectId: string, maxBudgetUsd: number): void {
  assertAboveFloor(maxBudgetUsd, 'a project\'s max_budget_usd');
  db.prepare('UPDATE projects SET max_budget_usd = ?, updated_at = ? WHERE id = ?').run(
    maxBudgetUsd,
    new Date().toISOString(),
    projectId
  );
}

// Setter for `project set --max-spend`/`project create --max-spend` to call.
// `null` clears the cap.
//
// Batch 11 ruling 1 rule b: raising the cap on a project paused for
// `spend_cap` must clear that pause BY ITSELF, not merely permit a future
// tick to succeed. Living here (rather than in cli.ts or daemonApi.ts) means
// both call sites -- the direct-write CLI path and the daemon-routed path --
// get the fix for free from the one place that already owns "the cap
// changed". An `adapter_unavailable` pause is untouched: it needs a login,
// not a bigger number, so it is never auto-cleared by this setter.
export function setProjectMaxSpendUsd(
  db: Db,
  projectId: string,
  maxSpendUsd: number | null
): { unpaused: boolean } {
  if (maxSpendUsd != null) {
    assertAboveFloor(maxSpendUsd, 'a project\'s max_spend_usd');
  }
  db.prepare('UPDATE projects SET max_spend_usd = ?, updated_at = ? WHERE id = ?').run(
    maxSpendUsd,
    new Date().toISOString(),
    projectId
  );
  const project = getProject(db, projectId);
  if (project && project.adapterPausedAt != null && project.pauseReason === 'spend_cap') {
    resumeProject(db, projectId);
    return { unpaused: true };
  }
  return { unpaused: false };
}

export function pauseProjectAdapter(db: Db, projectId: string, reason: 'spend_cap' | 'adapter_unavailable'): void {
  db.prepare('UPDATE projects SET adapter_paused_at = ?, pause_reason = ? WHERE id = ?').run(
    new Date().toISOString(),
    reason,
    projectId
  );
}

export function resumeProjectAdapter(db: Db, projectId: string): void {
  db.prepare('UPDATE projects SET adapter_paused_at = NULL, pause_reason = NULL WHERE id = ?').run(projectId);
}

// The `project_resume` transition named in docs/strategy/batch-4-spec.md
// section 2's cross-role contract: "clears a project pause, whatever its
// cause" -- there is exactly one pause column regardless of what tripped it
// (an adapter_unavailable failure or a project_spend_cap_reached refusal),
// so clearing it is the same operation either way. Unlike
// `resumeProjectAdapter` (which only flips the column, silently, and
// remains for existing call sites), this also records the event so the
// action shows up in the project's activity log. Intended for Role I's
// `resume --project` command to call instead of `resumeProjectAdapter`.
export function resumeProject(db: Db, projectId: string): void {
  resumeProjectAdapter(db, projectId);
  const policy = classify('project_resume');
  insertEvent(db, {
    projectId,
    eventType: 'project_resume',
    entityType: 'project',
    entityId: projectId,
    visibility: policy.visibility,
    requiresUser: policy.requiresUser,
    idempotencyKey: newId('evt'),
  });
}

export function isProjectAdapterPaused(db: Db, projectId: string): boolean {
  const row = db.prepare('SELECT adapter_paused_at FROM projects WHERE id = ?').get(projectId) as
    | { adapter_paused_at: string | null }
    | undefined;
  return row?.adapter_paused_at != null;
}

// Ticket override if set, else the project default. Shared by envelope
// building (scheduler.ts) and anything else that needs the resolved figure.
export function resolveMaxBudgetUsd(project: Project, ticket: Ticket): number {
  return ticket.maxBudgetUsdOverride ?? project.maxBudgetUsd;
}

// Same shape as resolveMaxBudgetUsd above, for the model to pin this run to.
export function resolveModel(project: Project, ticket: Ticket): string {
  return ticket.model ?? project.defaultModel;
}

// Batch 9: the model a Manager ticket runs on -- the project's own
// `manager_model` override if set, else its `default_model` (batch-9-spec.md
// section 2: "a project-level `manager_model` override defaulting to the
// project's default model"). Deliberately reads the PROJECT's setting, not
// `ticket.model`: unlike an ordinary work ticket, a Manager ticket's model
// choice is not something an individual ticket should freeze -- see
// types.ts's Project.managerModel doc comment.
export function resolveManagerModel(project: Project): string {
  return project.managerModel ?? project.defaultModel;
}

// Setter for a future `project set --model` to call instead of writing the
// column directly, matching setProjectMaxBudgetUsd's shape. No floor to
// enforce (any non-empty string is a project's own business; pricing.ts's
// unknown-model fallback is what protects the daemon from a typo'd or
// unrecognized value, not a check here).
export function setProjectDefaultModel(db: Db, projectId: string, defaultModel: string): void {
  db.prepare('UPDATE projects SET default_model = ?, updated_at = ? WHERE id = ?').run(
    defaultModel,
    new Date().toISOString(),
    projectId
  );
}

// Batch 9: the write site for `update_project_brief` (managerApply.ts) and
// any future `project set --brief`. Same shape as setProjectDefaultModel --
// no floor or format to enforce, a project's brief is free text.
export function setProjectBrief(db: Db, projectId: string, brief: string): void {
  db.prepare('UPDATE projects SET brief = ?, updated_at = ? WHERE id = ?').run(brief, new Date().toISOString(), projectId);
}

export function getProject(db: Db, id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

// Batch 8 (Role M): the daemon has no `--project` flag -- it ticks every
// project in the state directory's one database on each pass, not a single
// one named at invocation time the way the CLI's `tick`/`run --until-idle`
// do. Plain read, same as every other list function in this file.
export function listProjects(db: Db): Project[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  return rows.map(rowToProject);
}

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  acceptance_criteria_json: string;
  status: string;
  priority: number;
  assignee: string | null;
  attempt_count: number;
  max_attempts: number;
  workspace_type: string;
  workspace_ref: string | null;
  max_budget_usd_override: number | null;
  model: string | null;
  model_reason: string | null;
  kind: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json),
    status: row.status as TicketStatus,
    priority: row.priority,
    assignee: row.assignee,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    workspaceType: row.workspace_type as WorkspaceType,
    workspaceRef: row.workspace_ref,
    maxBudgetUsdOverride: row.max_budget_usd_override,
    model: row.model,
    modelReason: row.model_reason,
    kind: row.kind as TicketKind,
    resultJson: row.result_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTicket(
  db: Db,
  input: {
    projectId: string;
    title: string;
    description?: string | null;
    acceptanceCriteria?: string[];
    priority?: number;
    maxAttempts?: number;
    workspaceType?: WorkspaceType;
    workspaceRef?: string | null;
    maxBudgetUsdOverride?: number | null;
    model?: string | null;
    kind?: TicketKind;
  }
): Ticket {
  if (input.maxBudgetUsdOverride != null) {
    assertAboveFloor(input.maxBudgetUsdOverride, 'a ticket\'s max_budget_usd_override');
  }

  const now = new Date().toISOString();
  const id = newId('tkt');
  db.prepare(
    `INSERT INTO tickets (
       id, project_id, title, description, acceptance_criteria_json, status,
       priority, assignee, attempt_count, max_attempts, workspace_type,
       workspace_ref, max_budget_usd_override, model, kind, result_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, NULL, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    id,
    input.projectId,
    input.title,
    input.description ?? null,
    JSON.stringify(input.acceptanceCriteria ?? []),
    input.priority ?? 0,
    input.maxAttempts ?? 3,
    input.workspaceType ?? 'NONE',
    input.workspaceRef ?? null,
    input.maxBudgetUsdOverride ?? null,
    input.model ?? null,
    input.kind ?? 'work',
    now,
    now
  );
  return getTicket(db, id)!;
}

// Setter for `ticket add --budget` (and any future override-setting command)
// to call instead of writing the column directly, so the floor is enforced
// no matter which surface sets it. `null` clears the override (falls back
// to the project default).
export function setTicketBudgetOverride(db: Db, ticketId: string, maxBudgetUsdOverride: number | null): void {
  if (maxBudgetUsdOverride != null) {
    assertAboveFloor(maxBudgetUsdOverride, 'a ticket\'s max_budget_usd_override');
  }
  db.prepare('UPDATE tickets SET max_budget_usd_override = ?, updated_at = ? WHERE id = ?').run(
    maxBudgetUsdOverride,
    new Date().toISOString(),
    ticketId
  );
}

// Batch 9: the write site for `change_priority` (managerApply.ts). No CLI
// surface sets this directly yet (priority is otherwise fixed at `ticket
// add --priority` time) -- this is the first setter for it, needed because
// a Manager proposal must be able to reprioritize an EXISTING ticket.
export function setTicketPriority(db: Db, ticketId: string, priority: number): void {
  db.prepare('UPDATE tickets SET priority = ?, updated_at = ? WHERE id = ?').run(priority, new Date().toISOString(), ticketId);
}

// Batch 11: the write site for `update_ticket` (managerApply.ts). Every
// field is optional -- only the ones present are written -- and there is no
// `status` parameter at all: a Manager proposal may never touch it, and
// status has exactly one write site regardless (stateMachine.ts). Mirrors
// setTicketBudgetOverride's floor enforcement for the one field that has a
// floor.
export function updateTicketFields(
  db: Db,
  ticketId: string,
  fields: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string[];
    maxBudgetUsdOverride?: number;
    model?: string;
  }
): void {
  if (fields.maxBudgetUsdOverride != null) {
    assertAboveFloor(fields.maxBudgetUsdOverride, 'a ticket\'s max_budget_usd_override');
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push('title = ?');
    values.push(fields.title);
  }
  if (fields.description !== undefined) {
    sets.push('description = ?');
    values.push(fields.description);
  }
  if (fields.acceptanceCriteria !== undefined) {
    sets.push('acceptance_criteria_json = ?');
    values.push(JSON.stringify(fields.acceptanceCriteria));
  }
  if (fields.maxBudgetUsdOverride !== undefined) {
    sets.push('max_budget_usd_override = ?');
    values.push(fields.maxBudgetUsdOverride);
  }
  if (fields.model !== undefined) {
    sets.push('model = ?');
    values.push(fields.model);
  }
  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(ticketId);
  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...(values as []));
}

export function getTicket(db: Db, id: string): Ticket | undefined {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
  return row ? rowToTicket(row) : undefined;
}

export function listTickets(db: Db, projectId: string): Ticket[] {
  const rows = db
    .prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as TicketRow[];
  return rows.map(rowToTicket);
}

export function listTicketsByStatus(db: Db, projectId: string, status: TicketStatus): Ticket[] {
  const rows = db
    .prepare('SELECT * FROM tickets WHERE project_id = ? AND status = ? ORDER BY priority DESC, created_at ASC')
    .all(projectId, status) as TicketRow[];
  return rows.map(rowToTicket);
}

// Batch 9 housekeeping item 1 ruling 2: DB-wide (no project scoping), unlike
// every other ticket query in this file -- daemon.ts's `serve --max-parallel`
// machine-wide cap needs to know how many workers are in flight across EVERY
// project, not one, before deciding how much of a project's own
// max_parallel_workers cap it can actually use this tick.
export function countTicketsByStatus(db: Db, status: TicketStatus): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE status = ?').get(status) as { n: number };
  return row.n;
}

// Batch 9 (docs/strategy/batch-9-spec.md section 2): "Manager tickets never
// block work tickets and work tickets never depend on them; the dependency
// resolver refuses such edges." Enforced here, the one function that writes
// `ticket_dependencies`, so EVERY caller is covered -- the CLI's `dep add`,
// the API's `POST /deps`, and managerApply.ts's own calls alike -- not just
// proposal.ts's validator, which only ever sees a Manager's own proposed
// edges and cannot see a `dep add` invoked directly. Scoped to `dependencyType
// === 'blocks'` (the default, and the only type the Manager's command schema
// can ever produce): 'related'/'parent' create no scheduling coupling and
// carry no deadlock risk, so the "never" in the ruling is read as about the
// blocking relationship specifically, not every kind of link between two
// tickets.
export function addDependency(
  db: Db,
  input: { ticketId: string; dependsOnTicketId: string; dependencyType?: DependencyType }
): void {
  const dependencyType = input.dependencyType ?? 'blocks';
  if (dependencyType === 'blocks') {
    const ticket = getTicket(db, input.ticketId);
    const dependsOn = getTicket(db, input.dependsOnTicketId);
    if (ticket && dependsOn && ticket.kind !== dependsOn.kind) {
      throw new Error(
        `refused: a manager ticket and a work ticket may never depend on each other (${input.ticketId} is ${ticket.kind}, ${input.dependsOnTicketId} is ${dependsOn.kind})`
      );
    }
  }
  db.prepare(
    `INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type)
     VALUES (?, ?, ?)`
  ).run(input.ticketId, input.dependsOnTicketId, dependencyType);
}

export function getDependencies(db: Db, ticketId: string): TicketDependency[] {
  const rows = db
    .prepare('SELECT * FROM ticket_dependencies WHERE ticket_id = ?')
    .all(ticketId) as Array<{ ticket_id: string; depends_on_ticket_id: string; dependency_type: string }>;
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    dependsOnTicketId: r.depends_on_ticket_id,
    dependencyType: r.dependency_type as DependencyType,
  }));
}

// Tickets that list `ticketId` as one of their dependencies. Used to find
// which tickets might become READY when `ticketId` reaches DONE.
export function getDependents(db: Db, dependsOnTicketId: string): string[] {
  const rows = db
    .prepare('SELECT ticket_id FROM ticket_dependencies WHERE depends_on_ticket_id = ?')
    .all(dependsOnTicketId) as Array<{ ticket_id: string }>;
  return rows.map((r) => r.ticket_id);
}

interface RunRow {
  id: string;
  ticket_id: string;
  attempt: number;
  adapter: string;
  worker_session_ref: string | null;
  workspace_ref: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  failure_class: string | null;
  usage_json: string | null;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    attempt: row.attempt,
    adapter: row.adapter,
    workerSessionRef: row.worker_session_ref,
    workspaceRef: row.workspace_ref,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureClass: row.failure_class,
    usageJson: row.usage_json,
  };
}

export function createRun(
  db: Db,
  input: { ticketId: string; attempt: number; adapter: string; workspaceRef?: string | null }
): Run {
  const now = new Date().toISOString();
  const id = newId('run');
  db.prepare(
    `INSERT INTO runs (id, ticket_id, attempt, adapter, worker_session_ref, workspace_ref, status, started_at, finished_at, failure_class)
     VALUES (?, ?, ?, ?, NULL, ?, 'running', ?, NULL, NULL)`
  ).run(id, input.ticketId, input.attempt, input.adapter, input.workspaceRef ?? null, now);
  return getRun(db, id)!;
}

export function getRun(db: Db, id: string): Run | undefined {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function listRunsByStatus(db: Db, status: RunStatus): Run[] {
  const rows = db.prepare('SELECT * FROM runs WHERE status = ?').all(status) as RunRow[];
  return rows.map(rowToRun);
}

// Batch 11 item 3: counts every run started on a manager-kind ticket in this
// project since `sinceIso`, regardless of that run's outcome -- each such
// run IS a Manager invocation (a spawn, a cost), whether it landed DONE,
// BLOCKED or FAILED, and whether the ticket that ran was newly created by
// `planProject`/`discussProject` or an existing one re-run after `decide`
// unblocked it (manager.ts's own callers never see that second case --
// scheduler.ts's spawn-time cap gate is what makes counting RUNS rather than
// ticket creations necessary; see manager.ts's doc comment for the full
// reasoning).
export function countManagerRunsSince(db: Db, projectId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs r
       JOIN tickets t ON t.id = r.ticket_id
       WHERE t.project_id = ? AND t.kind = 'manager' AND r.started_at >= ?`
    )
    .get(projectId, sinceIso) as { n: number };
  return row.n;
}

// Batch 4 section 2's cross-role contract: "Ticket spend is the sum of
// total_cost_usd over its runs; project spend is the sum over its tickets."
// `usage_json` is an opaque, adapter-defined blob this codebase never
// validates (see setRunUsage) -- a run with no usage recorded, or a shape
// without `total_cost_usd`, contributes nothing rather than throwing. Used
// by scheduler.ts's spawn-time project cap check; commands/board.ts (Role
// I's file) computes the same figure today with its own inline copy of this
// logic and can switch to calling this instead.
export function ticketSpendUsd(db: Db, ticketId: string): number {
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
      // Malformed adapter-defined JSON contributes nothing rather than crashing.
    }
  }
  return total;
}

export function projectSpendUsd(db: Db, projectId: string): number {
  return listTickets(db, projectId).reduce((sum, ticket) => sum + ticketSpendUsd(db, ticket.id), 0);
}

export function setRunWorkerSessionRef(db: Db, runId: string, workerSessionRef: string): void {
  db.prepare('UPDATE runs SET worker_session_ref = ? WHERE id = ?').run(workerSessionRef, runId);
}

// Raw, adapter-defined usage blob (tokens, cache hit/miss, cost, ...) for
// one run. Not validated or interpreted here — stored as-is for the board
// to display.
export function setRunUsage(db: Db, runId: string, usage: unknown): void {
  db.prepare('UPDATE runs SET usage_json = ? WHERE id = ?').run(JSON.stringify(usage), runId);
}

// Batch 5 section 1 ruling 1's store guard: only a run still recorded as
// 'running' can be finished. A run that already settled (whether via this
// function or was never 'running' to begin with) is left untouched, and the
// caller is told nothing happened via the return value -- this is what
// protects the run row from a late/duplicate terminal event overwriting the
// first real outcome, independent of whatever guard scheduler.ts itself has
// (or lacks) at the call site. See batch-4-closeout.md section 2: the run
// row used to read the wrong failure_class because a second finishRun call
// silently won.
export function finishRun(db: Db, runId: string, input: { status: RunStatus; failureClass?: string | null }): boolean {
  const info = db
    .prepare("UPDATE runs SET status = ?, finished_at = ?, failure_class = ? WHERE id = ? AND status = 'running'")
    .run(input.status, new Date().toISOString(), input.failureClass ?? null, runId);
  return info.changes > 0;
}

export function insertEvent(
  db: Db,
  input: {
    projectId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    payload?: unknown;
    visibility?: EventVisibility;
    requiresUser?: boolean;
    idempotencyKey: string;
  }
): { inserted: boolean; sequence: number | null } {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO events (project_id, event_type, entity_type, entity_id, payload_json, visibility, requires_user, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.projectId,
      input.eventType,
      input.entityType,
      input.entityId,
      JSON.stringify(input.payload ?? {}),
      input.visibility ?? 'internal',
      input.requiresUser ? 1 : 0,
      input.idempotencyKey,
      now
    );

  if (info.changes === 0) {
    return { inserted: false, sequence: null };
  }
  return { inserted: true, sequence: Number(info.lastInsertRowid) };
}

interface EventDbRow {
  sequence: number;
  project_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  visibility: string;
  requires_user: number;
  idempotency_key: string;
  created_at: string;
}

function rowToEvent(row: EventDbRow): EventRow {
  return {
    sequence: row.sequence,
    projectId: row.project_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: JSON.parse(row.payload_json),
    visibility: row.visibility as EventVisibility,
    requiresUser: row.requires_user === 1,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

// Cheap existence check by idempotency key, used by stateMachine.ts to tell
// a replayed event apart from a genuinely new one BEFORE evaluating the
// transition against the ticket's current (possibly already-advanced)
// status. See recordTicketTransition's comment for why the ordering matters.
export function hasEvent(db: Db, idempotencyKey: string): boolean {
  const row = db.prepare('SELECT 1 FROM events WHERE idempotency_key = ?').get(idempotencyKey);
  return row !== undefined;
}

export function listEventsForEntity(db: Db, entityType: string, entityId: string): EventRow[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY sequence ASC')
    .all(entityType, entityId) as EventDbRow[];
  return rows.map(rowToEvent);
}

export function listEventsForProject(db: Db, projectId: string): EventRow[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY sequence ASC')
    .all(projectId) as EventDbRow[];
  return rows.map(rowToEvent);
}

interface ArtifactRow {
  id: string;
  ticket_id: string;
  run_id: string | null;
  kind: string;
  path_or_uri: string;
  description: string | null;
  checksum: string | null;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    runId: row.run_id ?? '',
    kind: row.kind,
    pathOrUri: row.path_or_uri,
    description: row.description,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

export function createArtifact(
  db: Db,
  input: {
    ticketId: string;
    runId: string;
    projectId: string;
    kind: string;
    pathOrUri: string;
    description?: string | null;
    checksum?: string | null;
  }
): Artifact {
  const now = new Date().toISOString();
  const id = newId('art');
  db.prepare(
    `INSERT INTO artifacts (id, ticket_id, run_id, project_id, kind, path_or_uri, description, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.ticketId,
    input.runId,
    input.projectId,
    input.kind,
    input.pathOrUri,
    input.description ?? null,
    input.checksum ?? null,
    now
  );
  return {
    id,
    ticketId: input.ticketId,
    runId: input.runId,
    kind: input.kind,
    pathOrUri: input.pathOrUri,
    description: input.description ?? null,
    checksum: input.checksum ?? null,
    createdAt: now,
  };
}

export function listArtifactsForTicket(db: Db, ticketId: string): Artifact[] {
  const rows = db
    .prepare('SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY created_at ASC')
    .all(ticketId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

// The other artifact, if any, already declaring this exact path in this
// project under a different ticket. Used to raise `artifact_collision` when
// two runs write into the same shared DIRECTORY workspace.
export function findConflictingArtifact(
  db: Db,
  projectId: string,
  pathOrUri: string,
  excludeTicketId: string
): Artifact | undefined {
  const row = db
    .prepare(
      'SELECT * FROM artifacts WHERE project_id = ? AND path_or_uri = ? AND ticket_id != ? ORDER BY created_at ASC LIMIT 1'
    )
    .get(projectId, pathOrUri, excludeTicketId) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : undefined;
}

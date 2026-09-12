import type { Db } from './db/index.ts';
import { newId } from './id.ts';
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
  TicketStatus,
  WorkspaceType,
} from './types.ts';

// Plain data access: reads and inserts that are not the ticket-status
// transition itself. `stateMachine.ts` is the only module allowed to write
// `tickets.status`.

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  default_adapter: string | null;
  max_parallel_workers: number;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProject(
  db: Db,
  input: { name: string; description?: string | null; defaultAdapter?: string | null; maxParallelWorkers?: number }
): Project {
  const now = new Date().toISOString();
  const id = newId('proj');
  db.prepare(
    `INSERT INTO projects (id, name, description, default_adapter, max_parallel_workers, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.description ?? null,
    input.defaultAdapter ?? null,
    input.maxParallelWorkers ?? 1,
    now,
    now
  );
  return getProject(db, id)!;
}

export function getProject(db: Db, id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
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
  }
): Ticket {
  const now = new Date().toISOString();
  const id = newId('tkt');
  db.prepare(
    `INSERT INTO tickets (
       id, project_id, title, description, acceptance_criteria_json, status,
       priority, assignee, attempt_count, max_attempts, workspace_type,
       workspace_ref, result_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, NULL, 0, ?, ?, ?, NULL, ?, ?)`
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
    now,
    now
  );
  return getTicket(db, id)!;
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

export function addDependency(
  db: Db,
  input: { ticketId: string; dependsOnTicketId: string; dependencyType?: DependencyType }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type)
     VALUES (?, ?, ?)`
  ).run(input.ticketId, input.dependsOnTicketId, input.dependencyType ?? 'blocks');
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

export function setRunWorkerSessionRef(db: Db, runId: string, workerSessionRef: string): void {
  db.prepare('UPDATE runs SET worker_session_ref = ? WHERE id = ?').run(workerSessionRef, runId);
}

// Raw, adapter-defined usage blob (tokens, cache hit/miss, cost, ...) for
// one run. Not validated or interpreted here — stored as-is for the board
// to display.
export function setRunUsage(db: Db, runId: string, usage: unknown): void {
  db.prepare('UPDATE runs SET usage_json = ? WHERE id = ?').run(JSON.stringify(usage), runId);
}

export function finishRun(
  db: Db,
  runId: string,
  input: { status: RunStatus; failureClass?: string | null }
): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, failure_class = ? WHERE id = ?').run(
    input.status,
    new Date().toISOString(),
    input.failureClass ?? null,
    runId
  );
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

export function createArtifact(
  db: Db,
  input: { ticketId: string; kind: string; pathOrUri: string; description?: string | null; checksum?: string | null }
): Artifact {
  const now = new Date().toISOString();
  const id = newId('art');
  db.prepare(
    `INSERT INTO artifacts (id, ticket_id, kind, path_or_uri, description, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.ticketId, input.kind, input.pathOrUri, input.description ?? null, input.checksum ?? null, now);
  return {
    id,
    ticketId: input.ticketId,
    kind: input.kind,
    pathOrUri: input.pathOrUri,
    description: input.description ?? null,
    checksum: input.checksum ?? null,
    createdAt: now,
  };
}

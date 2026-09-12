// Schema migrations. Each migration is applied at most once, tracked in
// `schema_migrations`. Add new migrations by appending to this array —
// never edit a migration that has already shipped.

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_adapter TEXT,
        max_parallel_workers INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        assignee TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        workspace_type TEXT NOT NULL DEFAULT 'NONE',
        workspace_ref TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ticket_dependencies (
        ticket_id TEXT NOT NULL REFERENCES tickets(id),
        depends_on_ticket_id TEXT NOT NULL REFERENCES tickets(id),
        dependency_type TEXT NOT NULL DEFAULT 'blocks',
        PRIMARY KEY (ticket_id, depends_on_ticket_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id),
        attempt INTEGER NOT NULL,
        adapter TEXT NOT NULL,
        worker_session_ref TEXT,
        workspace_ref TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        failure_class TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        visibility TEXT NOT NULL DEFAULT 'internal',
        requires_user INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id),
        kind TEXT NOT NULL,
        path_or_uri TEXT NOT NULL,
        description TEXT,
        checksum TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_deps_ticket ON ticket_dependencies(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON ticket_dependencies(depends_on_ticket_id);
      CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
      CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
    `,
  },
  {
    id: '0002_runs_usage_json',
    sql: `
      ALTER TABLE runs ADD COLUMN usage_json TEXT;
    `,
  },
  {
    // Per-project spend ceiling (default $2.00, per batch-2-spec.md's floor
    // price ruling) and an optional per-ticket override. SQLite's ALTER
    // TABLE ADD COLUMN ... DEFAULT applies the default to existing rows too,
    // so projects created before this migration get max_budget_usd = 2.0
    // rather than NULL.
    id: '0003_budget_fields',
    sql: `
      ALTER TABLE projects ADD COLUMN max_budget_usd REAL NOT NULL DEFAULT 2.00;
      ALTER TABLE tickets ADD COLUMN max_budget_usd_override REAL;
    `,
  },
];

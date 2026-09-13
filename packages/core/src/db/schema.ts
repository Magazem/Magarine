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
    // `projects.max_budget_usd`: the ceiling for ONE RUN (default $2.00,
    // per batch-2-spec.md's floor price ruling), and
    // `tickets.max_budget_usd_override`: an optional override of that same
    // per-run ceiling for one ticket. SQLite's ALTER TABLE ADD COLUMN ...
    // DEFAULT applies the default to existing rows too, so projects created
    // before this migration get max_budget_usd = 2.0 rather than NULL.
    //
    // DELIBERATELY NOT THE SAME THING as `projects.max_spend_usd` added in
    // 0005_project_spend_cap below, despite the one-word difference in the
    // name: max_budget_usd bounds what a single run may cost; max_spend_usd
    // bounds the CUMULATIVE total across every run the project will ever
    // spend. A project can have max_budget_usd = 2.00 (no single run may
    // exceed $2) and max_spend_usd = 50.00 (the project stops spawning once
    // its running total would exceed $50) at the same time -- they answer
    // different questions and neither implies the other.
    id: '0003_budget_fields',
    sql: `
      ALTER TABLE projects ADD COLUMN max_budget_usd REAL NOT NULL DEFAULT 2.00;
      ALTER TABLE tickets ADD COLUMN max_budget_usd_override REAL;
    `,
  },
  {
    // Batch 3: the project's brief and its DIRECTORY workspace root (one
    // shared directory per project, per batch-3-spec.md section 1), a
    // per-project adapter pause (set on an adapter_unavailable failure,
    // cleared by `magarine resume`), and `artifacts` gains the run that
    // declared each artifact plus a denormalized project_id so a shared
    // directory's same-path collisions can be queried without a join.
    id: '0004_batch3_scheduler_seam',
    sql: `
      ALTER TABLE projects ADD COLUMN brief TEXT;
      ALTER TABLE projects ADD COLUMN workspace_root TEXT;
      ALTER TABLE projects ADD COLUMN adapter_paused_at TEXT;
      ALTER TABLE artifacts ADD COLUMN run_id TEXT;
      ALTER TABLE artifacts ADD COLUMN project_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_artifacts_project_path ON artifacts(project_id, path_or_uri);
    `,
  },
  {
    // `projects.max_spend_usd`: an optional CUMULATIVE cap across every run
    // the project will ever spend -- checked at spawn time (scheduler.ts's
    // `tick()`) against the sum of all recorded run costs plus the ceiling
    // of the run about to start. NULL means "no cap".
    //
    // DELIBERATELY NOT THE SAME THING as `projects.max_budget_usd` /
    // `tickets.max_budget_usd_override` added in 0003_budget_fields above,
    // despite the one-word difference in the name -- see that migration's
    // comment for the distinction spelled out both ways. Unlike the per-run
    // ceiling, most projects will never set a spend cap, so there is no
    // sensible non-null default to apply to existing rows the way
    // 0003_budget_fields's max_budget_usd default was.
    id: '0005_project_spend_cap',
    sql: `
      ALTER TABLE projects ADD COLUMN max_spend_usd REAL;
    `,
  },
  {
    // Batch 6 (docs/strategy/batch-6-spec.md section 2 Role K item 4): the
    // daemon never passed `--model` to the tool at all before this, so every
    // worker ran on whatever the owner's desktop default happened to be at
    // spawn time -- the root cause behind batch 5's 405%-wrong cost estimate
    // (two runs, two different models, one blended rate). Pinning closes
    // that: `projects.default_model` (non-null, defaults existing rows to
    // 'claude-sonnet-5' per the architecture doc's tier logic -- sonnet for
    // implementation/normal work) and a nullable `tickets.model` override,
    // mirroring `max_budget_usd`/`max_budget_usd_override`'s existing
    // project-default-with-per-ticket-override shape from 0003_budget_fields
    // exactly. See store.ts's resolveModel.
    id: '0006_model_pinning',
    sql: `
      ALTER TABLE projects ADD COLUMN default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5';
      ALTER TABLE tickets ADD COLUMN model TEXT;
    `,
  },
];

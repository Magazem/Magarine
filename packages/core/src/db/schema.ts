import { dirname } from 'node:path';
import type { Db } from './index.ts';

// Schema migrations. Each migration is applied at most once, tracked in
// `schema_migrations`. Add new migrations by appending to this array —
// never edit a migration that has already shipped.
//
// Batch 12: `run` is for a migration that needs real logic, not just DDL --
// this repo has no `dirname()` available in pure SQL, and doing Windows/
// POSIX path splitting by hand in a SQL string is exactly the kind of thing
// that looks like it works until a path with the "wrong" separator shows up
// (see 0010's own comment). `runMigrations` (db/index.ts) runs `sql` (if
// given) then `run` (if given), inside the same one transaction per
// migration id either way.
export interface Migration {
  id: string;
  sql?: string;
  run?: (db: Db) => void;
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
  {
    // Batch 9: the Manager invocation (docs/strategy/batch-9-spec.md section
    // 2). `tickets.kind` distinguishes a Manager run from an ordinary work
    // ticket -- 'work' (the only kind before this batch, hence the default
    // for existing rows) or 'manager'. Deliberately NOT a foreign key or an
    // enum-like CHECK constraint: every other status-like column in this
    // schema (workspace_type, runs.status, etc.) is a plain TEXT column
    // validated in application code (proposal.ts / types.ts), not by
    // sqlite -- consistent with that, not a new convention.
    //
    // `projects.manager_model` mirrors `default_model`/`model`'s existing
    // project-default-with-per-ticket-override SHAPE, but is its own,
    // separate override rather than reusing `tickets.model`: the Manager's
    // model choice is a property of the PROJECT (batch-9-spec.md section 2:
    // "a project-level `manager_model` override defaulting to the project's
    // default model"), not of any one manager ticket, and a project can
    // have many manager tickets over its lifetime, each of which should pick
    // up a LATER change to this setting rather than freezing whatever
    // `tickets.model` a long-gone earlier manager ticket happened to record.
    // NULL (every existing project's value after this migration) means "use
    // this project's own default_model", the same NULL-means-"fall back"
    // shape `max_budget_usd_override`/`tickets.model` already use.
    id: '0007_manager_kind',
    sql: `
      ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
      ALTER TABLE projects ADD COLUMN manager_model TEXT;
    `,
  },
  {
    // Batch 11 (docs/strategy/batch-11-spec.md section 2, Role R item 1):
    // the scope document the Manager reads on every invocation and the
    // owner can hand-edit between turns. NULL (every existing project's
    // value after this migration, and any project created without an
    // explicit path) means "no scope file yet" -- store.ts's
    // readScopeText/writeScopeText below treat that as empty text rather
    // than resolving a default location. This project has no existing
    // notion of "a project's own directory" independent of the DIRECTORY
    // workspace type's project.workspace_root (which is itself optional,
    // required only for DIRECTORY-mode tickets) -- see this migration's
    // sibling comment in store.ts for why no default path is invented here.
    id: '0008_project_scope_path',
    sql: `
      ALTER TABLE projects ADD COLUMN scope_path TEXT;
    `,
  },
  {
    // Batch 11 (docs/strategy/batch-11-spec.md section 1, ruling 1): a pause
    // was one nullable timestamp column with no record of what caused it, so
    // the board and inbox had to guess or stay silent. NULL (every existing
    // project's value after this migration) means "not paused for a reason
    // this column tracks" -- store.ts's isProjectAdapterPaused still reads
    // adapter_paused_at as the source of truth for "is it paused at all";
    // this column only disambiguates why, for the two causes that currently
    // exist (`spend_cap`, `adapter_unavailable`).
    id: '0009_pause_reason',
    sql: `
      ALTER TABLE projects ADD COLUMN pause_reason TEXT;
    `,
  },
  {
    // Batch 12 ruling 1: "a project has exactly one directory" -- workspace_root
    // and scope_path both derive from it from now on (`project create --dir`,
    // `project set --dir`, cli.ts). Existing rows predate that: workspace_root
    // is null unless `--workspace-root` was given at creation, independent of
    // whatever scope_path holds. This backfills workspace_root from
    // dirname(scope_path) for exactly the rows that have a scope_path but no
    // root, so a project that already had a scope document gets its
    // directory for free rather than needing `project set --dir` by hand.
    // Rows with neither (a truly bare legacy project) are left null --
    // nothing on disk to derive a directory FROM -- and workspace_preparation_failed's
    // own inbox line (commands/inbox.ts's reasonFor) names `project set --dir`
    // as the fix for exactly this case.
    //
    // Real Node `dirname()`, not hand-rolled SQL string slicing: this
    // repository runs on Windows, where a path can use `\` as its
    // separator, and a SQL `substr`/`instr` splitting on `/` alone would
    // silently mis-split every real path in this database. `Migration.run`
    // exists for exactly this -- see this file's own doc comment on it.
    id: '0010_backfill_workspace_root_from_scope_path',
    run: (db) => {
      const rows = db
        .prepare(`SELECT id, scope_path FROM projects WHERE workspace_root IS NULL AND scope_path IS NOT NULL`)
        .all() as Array<{ id: string; scope_path: string }>;
      for (const row of rows) {
        db.prepare('UPDATE projects SET workspace_root = ? WHERE id = ?').run(dirname(row.scope_path), row.id);
      }
    },
  },
  {
    // Batch 12 item 3: the Manager's own one-line justification for setting
    // a `model` -- carried alongside `tickets.model` (0006_model_pinning),
    // never without it (see proposal.ts's validateCommandShape: a command
    // that sets `model` without `model_reason` is rejected before it ever
    // reaches here). Nullable: a ticket whose model was never explicitly
    // set (falls back to the project default) has no reason to record.
    id: '0011_ticket_model_reason',
    sql: `ALTER TABLE tickets ADD COLUMN model_reason TEXT;`,
  },
  {
    // Batch 13 ruling 1b: a non-file artefact kind (manager_reply,
    // manager_assessment) no longer carries its content in `path_or_uri` --
    // that column stays NOT NULL (an empty string for these rows going
    // forward, to avoid a SQLite table rebuild for a column most rows still
    // use for its real purpose), and the actual text moves to this new
    // column. Existing rows of the two kinds that have ever been produced
    // in this codebase (manager_reply/manager_assessment; 'text' and
    // 'reference' are new this batch and have no legacy rows) have their
    // real content sitting in path_or_uri today -- this migration moves it.
    id: '0012_artifact_text_column',
    sql: `ALTER TABLE artifacts ADD COLUMN text TEXT;`,
    run: (db) => {
      db.prepare(
        `UPDATE artifacts SET text = path_or_uri, path_or_uri = '' WHERE kind IN ('manager_reply', 'manager_assessment')`
      ).run();
    },
  },
  {
    // Batch 15 item 4: a ticket's own declared expectation of what DONE
    // must have produced (types.ts's ExpectedArtifact), set via
    // create_ticket/update_ticket. NULL for every existing row -- "no such
    // list at all," which store.ts's rowToTicket reads as keeping today's
    // rule (batch 13 ruling 1c's "done requires something delivered," and
    // nothing more specific than that), not an invented empty list. See
    // scheduler.ts for the DONE-time verification this column drives.
    id: '0013_ticket_expected_artifacts',
    sql: `ALTER TABLE tickets ADD COLUMN expected_artifacts_json TEXT;`,
  },
];

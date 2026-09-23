// Core domain types shared across the state machine, scheduler and adapters.

import type { ReadinessRule } from './readiness.ts';

/** Every cause that can set `projects.pause_reason`. The three readiness rules (batch 16 ruling 24) join the two batch-11 causes; store.ts's row mapper, board.ts's `BoardResult.pauseReason` and inbox.ts's `describeProjectPause` all take this one type, so the widening cannot be done in one place and forgotten in another. */
export type PauseReason = 'spend_cap' | 'adapter_unavailable' | ReadinessRule;

export type TicketStatus =
  | 'OPEN'
  | 'READY'
  | 'IN_PROGRESS'
  | 'REVIEW'
  | 'DONE'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED';

export type EventVisibility = 'internal' | 'activity' | 'inbox' | 'urgent';

// Batch 9: 'work' is every ticket kind that existed before this batch (the
// default for existing rows, db/schema.ts's 0007_manager_kind migration).
// 'manager' is a Manager run -- a ticket like any other (same adapter, same
// budget/model/retry/inbox machinery), except its post-success handling
// applies a proposal instead of just landing DONE (see scheduler.ts).
export type TicketKind = 'work' | 'manager';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  defaultAdapter: string | null;
  /** Batch 16: this project's OWN worker cap, or null = none of its own, so the daemon's machine-wide `serve --max-parallel` ceiling alone governs (migration 0014). A number was created under the old meaning and stays the owner's decision. */
  maxParallelWorkers: number | null;
  /** The ceiling for ONE RUN (the tool's --max-budget-usd flag). Deliberately distinct from `maxSpendUsd` below despite the one-word name difference -- see db/schema.ts's 0003/0005 migration comments. */
  maxBudgetUsd: number;
  /** Optional CUMULATIVE cap across every run the project will ever spend (batch 4). Null means no cap. Enforced at spawn time -- see scheduler.ts's `tick()`. NOT the same thing as `maxBudgetUsd` above. */
  maxSpendUsd: number | null;
  /** Batch 6: the model the adapter passes via `--model` for every ticket in this project, unless a ticket overrides it (see Ticket.model below). Non-null -- every run needs a model to pin to. Same project-default-with-per-ticket-override shape as `maxBudgetUsd`/`Ticket.maxBudgetUsdOverride`. See store.ts's resolveModel. */
  defaultModel: string;
  /** Project brief handed to every worker via TicketEnvelope.projectBrief. */
  brief: string | null;
  /** Required when any ticket in the project uses the DIRECTORY workspace type: one shared directory for the whole project. */
  workspaceRoot: string | null;
  /** Set when an `adapter_unavailable` failure pauses this project's adapter; cleared by `resumeProjectAdapter`. Null means not paused. */
  adapterPausedAt: string | null;
  /** Batch 11: which of the two pause causes set `adapterPausedAt`, so the board/inbox can name the fix instead of guessing. Null whenever `adapterPausedAt` is null; also null for pauses recorded before this column existed. See store.ts's `pauseProjectAdapter`. */
  pauseReason: PauseReason | null;
  /** Batch 9: overrides `defaultModel` for this project's Manager tickets specifically; null falls back to `defaultModel` (same shape as `Ticket.model`/`defaultModel`, but this is a project-level setting because a project can have many Manager tickets over its lifetime, each of which should see a later change here -- not something a single ticket's own `model` column would give). See store.ts's resolveManagerModel. */
  managerModel: string | null;
  /** Batch 11: the scope document's filesystem path, read fresh into the Manager's envelope on every invocation and hand-editable by the owner between turns. Null means no scope file has been set yet -- see manager.ts's readScopeText, which treats that as empty text rather than inventing a default location. */
  scopePath: string | null;
  /** Batch 18 ruling 31: the model the verifier runs on; null falls back to `defaultModel` (see store.ts's resolveVerifierModel). */
  verifierModel: string | null;
  createdAt: string;
  updatedAt: string;
}

// Batch 15 item 4: a ticket's own declared expectation of what DONE must
// have produced -- structurally the same "kind, and for kind file a path"
// shape resultContract.ts's ARTIFACT_KINDS/ARTIFACT_KIND_FIELD already
// enumerate for what a WORKER reports, but this is the opposite direction:
// what the TICKET expects, set at create_ticket/update_ticket time, before
// any run exists to report anything at all. `path` is meaningful only for
// kind 'file' (the only kind this batch can actually verify against a real
// filesystem or a worker's own declared artifact list -- see scheduler.ts's
// DONE-verification check); present but unused for every other kind.
export interface ExpectedArtifact {
  kind: string;
  path?: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string[];
  status: TicketStatus;
  priority: number;
  assignee: string | null;
  attemptCount: number;
  maxAttempts: number;
  workspaceType: WorkspaceType;
  workspaceRef: string | null;
  /** Overrides the project's max_budget_usd for this ticket alone; null falls back to the project default. */
  maxBudgetUsdOverride: number | null;
  /** Batch 6: overrides the project's default_model for this ticket alone; null falls back to the project default. See store.ts's resolveModel. */
  model: string | null;
  /** Batch 12 item 3: the Manager's own one-line justification for setting `model` -- required by proposal.ts's validateCommandShape whenever a create_ticket/update_ticket command sets `model`, shown on the board next to it. Null when `model` has never been explicitly set on this ticket. */
  modelReason: string | null;
  /** Batch 9: 'work' (default) or 'manager' -- see TicketKind. */
  kind: TicketKind;
  /** Batch 18 ruling 34: true on a manager ticket the scheduler created itself because the board drained -- not one the owner asked for with plan/discuss. The page and `GET /board` rows name it. */
  automatic: boolean;
  /** Batch 15 item 4: set on create_ticket/update_ticket; null means the ticket carries no such list at all and keeps today's rule (no verification beyond "done requires something delivered," batch 13 ruling 1c). Non-null means DONE is verified against it -- see scheduler.ts. */
  expectedArtifacts: ExpectedArtifact[] | null;
  /** Batch 19 mini-phase 1A (worker-profiles-design.md ruling 25): a non-retired `worker_profiles` row this ticket was assigned, or null for a ticket with no profile (every ticket before this batch, and any hand-made ticket that keeps using a bare `model`). Mutually exclusive with `model` -- see store.ts's createTicket, which rejects a command that sets both with "choose a profile or a model, not both". See store.ts's resolveModel for the one resolution function this participates in. */
  profileId: string | null;
  /** Batch 19 mini-phase 2A (ruling 37): the Manager's own one-line justification for `profile`, required by proposal.ts's validateCommandShape whenever a create_ticket/update_ticket command sets `profile`, shown on the board next to it -- same shape as `modelReason` above. Null for a ticket whose profile was never explicitly set through a Manager command. */
  profileReason: string | null;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
}

// Batch 19 mini-phase 1A: a named worker identity -- `batch-16-addendum-1-
// worker-profiles-design.md` sections 1-2 (ruling 25). Global to the
// database, not per project ("my agents" is how the owner spoke of them).
// No allowed-tools field (the batch 1 spike proved `--allowedTools` is not a
// containment boundary -- a field the product cannot enforce is inert
// machinery, the addendum's own words). No memory, no state: status is
// derived at read time from whether a run under this profile is in flight
// (see store.ts's workerProfileStatus), never stored.
export interface WorkerProfile {
  id: string;
  /** Unique, the display name -- `profile set --name` renames it without changing `id` (or the organism the id seeds, per the addendum's ruling: "renaming does not change the organism"). */
  name: string;
  /** One sentence, shown on the fleet row and appended (with `policy`) to the worker's system prompt as the profile's `--append-system-prompt` line (batch 19 mini-phase 2A). */
  purpose: string;
  /** Must be a model `pricing.ts` has a rate for -- store.ts's createWorkerProfile/updateWorkerProfile validate against `isKnownModel`. Changing it changes the seeded organism; renaming does not (addendum section 2). */
  model: string;
  /** Text appended to the worker's system prompt; may be empty. Seeded to the same sentence as `purpose` by migration 0017, until the owner writes a longer one. */
  policy: string;
  createdAt: string;
  updatedAt: string;
  /** Null: assignable and shown. Non-null: retired -- hidden from `GET /profiles`/`profile list` and not assignable to a new ticket, but never deleted, so history (existing tickets/runs that already carry this id) stays readable. */
  retiredAt: string | null;
}

/** `GET /profiles`' derived status for one profile: `working` with the ticket id of the run currently in flight under it, or `idle`. Never stored -- see store.ts's workerProfileStatus. */
export type WorkerProfileStatus =
  | { status: 'working'; ticketId: string }
  | { status: 'idle'; ticketId: null };

export type DependencyType = 'blocks' | 'related' | 'parent';

export interface TicketDependency {
  ticketId: string;
  dependsOnTicketId: string;
  dependencyType: DependencyType;
}

export type RunStatus = 'running' | 'succeeded' | 'review' | 'blocked' | 'failed' | 'cancelled';

export type RunKind = 'work' | 'verify';

export interface Run {
  id: string;
  ticketId: string;
  attempt: number;
  adapter: string;
  workerSessionRef: string | null;
  workspaceRef: string | null;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  failureClass: string | null;
  /** Batch 18 ruling 31: 'work' (a worker or a Manager) or 'verify' (the second run that decides whether a worker's `done` is DONE). */
  kind: RunKind;
  /** Batch 19 mini-phase 1A: the worker profile this run spawned under, or null for a profile-less ticket. Recorded on the run (not just the ticket) so cost and outcome per profile are derivable without a join through tickets, per the addendum's own ruling (section 4). Written at spawn time -- batch 19 mini-phase 2A's adapter wiring; this column exists from 1A on so 2A has somewhere to write it. */
  profileId: string | null;
  // Raw JSON reported by the adapter for this run: token counts, cache
  // hit/miss, cost, etc. Shape is adapter-defined; the daemon does not
  // validate it, only stores and displays it.
  usageJson: string | null;
}

export interface EventRow {
  sequence: number;
  projectId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  visibility: EventVisibility;
  requiresUser: boolean;
  idempotencyKey: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  ticketId: string;
  runId: string;
  kind: string;
  /** Meaningful only for kind 'file' (a resolved filesystem path, checked on disk); an empty string for every other kind -- see `text` below. Stays NOT NULL at the db layer (`path_or_uri`) rather than nullable, to avoid a SQLite table rebuild for a column most rows still use. */
  pathOrUri: string;
  /** Batch 13: the artefact's own content for every kind other than 'file' -- 'url', 'text', 'reference', 'manager_reply', 'manager_assessment' all store here regardless of which field name the worker's JSON used (see resultContract.ts's `artifactContent`); null for 'file'. Closes the batch-11 smell of this content having previously been stored in `pathOrUri` (see db/schema.ts's 0012 migration). */
  text: string | null;
  description: string | null;
  checksum: string | null;
  createdAt: string;
}

// --- Worker envelope and adapter abstraction, per technical-architecture-weekend-mvp.md ---

export type WorkspaceType = 'NONE' | 'DIRECTORY' | 'GIT_WORKTREE';

export interface Workspace {
  type: WorkspaceType;
  path?: string;
}

export interface TicketEnvelopeArtifact {
  kind: string;
  /** Batch 13: the artefact's own content -- a resolved filesystem path for kind 'file', a URL for kind 'url', or free-form text for every other kind (renamed from "path", which is what let a non-file kind's real text collide with a field name that means "a location on disk" -- see resultContract.ts's per-kind field enumeration, which this display shape does not need to duplicate exhaustively since it is prompt rendering, not a validation boundary). */
  content: string;
}

export interface TicketEnvelope {
  ticketId: string;
  projectBrief: string;
  relevantDecisions: string[];
  title: string;
  description: string;
  acceptanceCriteria: string[];
  completedDependencies: Array<{
    ticketId: string;
    title: string;
    /** The worker's own summary text (WorkerResult.summary), never a raw JSON blob. */
    summary?: string;
    artifacts: TicketEnvelopeArtifact[];
  }>;
  allowedTools: string[];
  expectedOutputFormat: string;
  /** Ticket override if set, else the project default (see store.ts resolveMaxBudgetUsd). */
  maxBudgetUsd: number;
  /** Batch 6: ticket override if set, else the project default (see store.ts's resolveModel). The adapter passes this via `--model` and records it in usage_json -- nothing about a worker's cost or capability may depend on the owner's desktop default. */
  model: string;
  /** Batch 19 mini-phase 2A (ruling 37): the ticket's assigned worker profile, absent for a profile-less ticket -- and always absent on a verifier envelope (buildVerifierEnvelope) or a Manager envelope (buildManagerEnvelope), neither of which ever sets this field. The adapter (claudeCli.ts) renders it as `--append-system-prompt "You are <name>, <purpose>. <policy>"` (the trailing policy omitted when empty); envelope.ts's buildWorkerPrompt names it in the prompt's first line. */
  profile?: { id: string; name: string; purpose: string; policy: string };
  /** Batch 15 item 4: the ticket's own declared expectation, carried through so the worker sees what it is expected to produce. Absent (not an empty array) when the ticket has no such list -- see envelope.ts's buildWorkerPrompt for the rendering rule this distinction drives. */
  expectedArtifacts?: ExpectedArtifact[];
  /** Batch 18 ruling 31: absent or 'work' is an ordinary worker; 'verify' asks the adapter for a VERIFIER run -- a different prompt (verifier.ts) and a different result schema (a verdict per acceptance criterion, never artefacts). */
  runKind?: RunKind;
  /** Only on a verifier envelope: what it is judging. */
  verification?: VerificationSubject;
  /** Batch 18 ruling 32: why the ticket's previous attempt did not stand -- the verifier's (or owner's) rejection, or the worker's own failure. Absent on a first attempt, always. */
  previousAttempt?: { status: 'rejected' | 'failed'; reason: string };
}

/** Ruling 31: everything a verifier is shown about the work it judges, and nothing else. */
export interface VerificationSubject {
  /** The worker's own `summary` (its claim). */
  workerSummary: string;
  /** What the worker declared it delivered: files by path, other kinds by their text. */
  artifacts: TicketEnvelopeArtifact[];
  /** The ticket's acceptance criteria as written -- the standing placeholder criterion is added by the prompt builder, never stored on the ticket. */
  acceptanceCriteria: string[];
}

export interface WorkerHandle {
  id: string;
  ticketId: string;
  runId: string;
}

// WorkerResult is the parsed shape of `.orchestrator/result.json`, per the
// doc's "Worker result contract" section. The doc's example only shows the
// "ready_for_review" case; the additional status values below are this
// implementation's extension to cover the full ticket lifecycle diagram
// (worker succeeds / passes auto-checks / retryable failure / question /
// user decision required). See packages/core/README.md "Design decisions".
// Batch 7 (Role L, docs/strategy/batch-7-spec.md section 1 ruling 1):
// `budget_insufficient` is a worker's own report that it read its budget
// ceiling out of the envelope, measured its burn rate, and stopped rather
// than continue past it -- distinct from `failed` (which the scheduler
// treats as retryable) because retrying under the same ceiling would just
// reproduce the same stop. See resultContract.ts and stateMachine.ts's
// `worker_budget_stop` transition.
export type WorkerResultStatus = 'done' | 'review' | 'needs_user_decision' | 'failed' | 'budget_insufficient';

export interface WorkerResultCheck {
  name: string;
  status: 'passed' | 'failed';
}

// Batch 13 ruling 1b: a discriminated union, one required content field per
// kind -- `file` keeps `path` (resolved and checked on disk, see
// claudeCli.ts's verifyArtifacts), everything else carries `text` or `url`
// instead, so a non-file kind's real content can never again collide with a
// field name that means "a location on disk" (see resultContract.ts's
// header comment on the batch-11 smell this closes). `resultContract.ts`'s
// `ARTIFACT_KINDS`/`ARTIFACT_KIND_FIELD` are the single source this union's
// shape and the runtime validator both answer to.
export type WorkerResultArtifact =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'text' | 'reference' | 'manager_reply' | 'manager_assessment'; text: string };

export interface WorkerResult {
  status: WorkerResultStatus;
  summary: string;
  artifacts: WorkerResultArtifact[];
  checks: WorkerResultCheck[];
  blockers: string[];
  questions: string[];
}

// Events an adapter reports back to the scheduler while a worker runs.
// A terminal event (`result_raw` or `failure`) ends the run; `progress` and
// `question` do not.
export type WorkerEvent =
  | {
      type: 'progress';
      message: string;
      /** Cumulative spend for the run so far, if the adapter can report it (batch 4 item 3). Absent means the adapter has no running estimate. */
      costUsd?: number;
      /** Batch 6 item 3: set to the model string (or a placeholder if the stream never named one) the moment the adapter has to price a message at pricing.ts's unknown-model fallback rate, so the scheduler can raise `unknown_model_rate` instead of pricing silently. Absent means every message tallied so far used a recognized rate. */
      unknownModel?: string;
    }
  | { type: 'question'; message: string }
  | {
      type: 'result_raw';
      raw: unknown;
      usage?: unknown;
      /** Batch 6 item 4: set on a completed run whose terminal `result` line's `modelUsage` names a model outside pricing.ts's rate table -- the same "tell someone" signal as the mid-run `progress` field above, so an unpinned/unrecognized model doesn't go silent just because the run finished cleanly. */
      unknownModel?: string;
    }
  | {
      type: 'failure';
      message: string;
      retryable: boolean;
      /** Adapter-defined classification, e.g. 'adapter_unavailable' | 'budget_exceeded' | 'worker_reported_failure'. Absent means the adapter did not classify beyond retryable/non-retryable. */
      failureClass?: string;
      /** Batch 6: for a `budget_exceeded` failureClass specifically, which guard actually stopped the run -- 'tool_max_budget_usd' (the tool's own `--max-budget-usd` flag, accurate, checked between turns) or 'scheduler_estimate' (the daemon's live tally, a known lower bound -- see pricing.ts/claudeCli.ts). Absent for every other failureClass. */
      stoppedBy?: string;
      usage?: unknown;
      /** Batch 6 item 4: same signal as result_raw's field above, for a terminal failure that still landed a `result` line with `modelUsage` (e.g. a malformed-output retry) naming an unrecognized model. */
      unknownModel?: string;
    };

export interface AgentAdapterCapabilities {
  supportsFiles: boolean;
  supportsShell: boolean;
  supportsStreaming: boolean;
  supportsResume: boolean;
}

// Batch 19 mini-phase 4 (ruling 40): the adapter's current tool use -- `tool`
// is the tool's own name, `detail` its raw input (the command text for
// Bash). Delivered on `AgentAdapter.observeLive`, a channel the scheduler
// NEVER inserts an event for -- it only updates an in-memory live map, keyed
// by run id, that dies with the run (scheduler.ts's own doc comment on that
// map has the full reasoning). This is the same ruling claudeCli.ts's
// `describeProgress` already states for `WorkerEvent`'s `progress.message`
// (never the command itself, batch 15 addendum 3 / ruling 14) extended to a
// second, still-never-persisted surface for the drill-down the owner asked
// for -- ruling 14's predicate-only `message` field is untouched by this.
export interface LiveToolUse {
  tool: string;
  detail: string;
}

// Batch 19 mini-phase 4 (ruling 40): what the scheduler's live map
// (SchedulerDeps.liveRuns, scheduler.ts) and the verifier's own live
// registration (VerifierDeps.liveRuns, verifier.ts) both store per running
// run id, and what `GET /runs/{id}/live` (daemonApi.ts) returns verbatim.
// Lives in types.ts, not scheduler.ts, so verifier.ts can use the same shape
// without importing from scheduler.ts (which already imports FROM
// verifier.ts -- a cycle). `since` is reset to the moment THIS tool/detail
// pair was reported -- i.e. when the CURRENT tool use began, not when the
// run itself started (that is `Run.startedAt`, already available
// elsewhere). `lastProgressAt` is the daemon's own already-timestamped
// record of the last progress WorkerEvent of ANY kind for this run (not
// just a tool-use one) -- "is it stuck" is this minus `since`/now, a
// measurement, never a verdict this daemon computes and states (ruling 40
// section 2).
//
// Ruling 40 section 6 (amended 2026-09-23): the entry is created by the
// FIRST progress event as well as by a tool use, so `tool`, `detail` and
// `since` are null until a tool is actually used. `lastProgressAt` is null
// until a real progress event arrives -- the run's start is NEVER substituted
// for it, because that overstated the silence of a worker that had reported
// progress but not yet used a tool. `startedAt` is `Run.startedAt`, always
// present, so a reader can say "no progress yet, running for X" truthfully.
export interface LiveRunInfo {
  tool: string | null;
  detail: string | null;
  since: string | null;
  lastProgressAt: string | null;
  startedAt: string;
}

// Reproduced exactly from technical-architecture-weekend-mvp.md ("Agent
// adapter abstraction"), with the supporting types above filled in.
export interface AgentAdapter {
  id: string;

  capabilities(): Promise<AgentAdapterCapabilities>;

  startWorker(input: {
    ticket: TicketEnvelope;
    workspace?: Workspace;
    systemPolicy: string;
  }): Promise<WorkerHandle>;

  send(handle: WorkerHandle, message: string): Promise<void>;

  observe(handle: WorkerHandle, onEvent: (event: WorkerEvent) => void): Promise<() => void>;

  // Batch 19 mini-phase 4 (ruling 40): a second, NON-persisted channel,
  // delivered the same way `observe` delivers progress -- but nothing an
  // adapter reports through this ever reaches an event, the database, or a
  // file (see LiveToolUse's own doc comment). Every implementation must
  // provide this (ClaudeCliAdapter reads it off the same tool_use block
  // describeProgress already parses; FakeAdapter's is scripted via
  // `setLiveToolUse`).
  observeLive(handle: WorkerHandle, onLive: (info: LiveToolUse) => void): Promise<() => void>;

  stop(handle: WorkerHandle): Promise<void>;

  destroy(handle: WorkerHandle): Promise<void>;
}

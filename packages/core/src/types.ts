// Core domain types shared across the state machine, scheduler and adapters.

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

export interface Project {
  id: string;
  name: string;
  description: string | null;
  defaultAdapter: string | null;
  maxParallelWorkers: number;
  /** The ceiling for ONE RUN (the tool's --max-budget-usd flag). Deliberately distinct from `maxSpendUsd` below despite the one-word name difference -- see db/schema.ts's 0003/0005 migration comments. */
  maxBudgetUsd: number;
  /** Optional CUMULATIVE cap across every run the project will ever spend (batch 4). Null means no cap. Enforced at spawn time -- see scheduler.ts's `tick()`. NOT the same thing as `maxBudgetUsd` above. */
  maxSpendUsd: number | null;
  /** Project brief handed to every worker via TicketEnvelope.projectBrief. */
  brief: string | null;
  /** Required when any ticket in the project uses the DIRECTORY workspace type: one shared directory for the whole project. */
  workspaceRoot: string | null;
  /** Set when an `adapter_unavailable` failure pauses this project's adapter; cleared by `resumeProjectAdapter`. Null means not paused. */
  adapterPausedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DependencyType = 'blocks' | 'related' | 'parent';

export interface TicketDependency {
  ticketId: string;
  dependsOnTicketId: string;
  dependencyType: DependencyType;
}

export type RunStatus = 'running' | 'succeeded' | 'review' | 'blocked' | 'failed' | 'cancelled';

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
  pathOrUri: string;
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
  /** A resolved filesystem path for kind 'file'; free-form text/URI for any other kind. */
  path: string;
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
export type WorkerResultStatus = 'done' | 'review' | 'needs_user_decision' | 'failed';

export interface WorkerResultCheck {
  name: string;
  status: 'passed' | 'failed';
}

export interface WorkerResultArtifact {
  kind: string;
  path: string;
}

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
  | { type: 'result_raw'; raw: unknown; usage?: unknown }
  | {
      type: 'failure';
      message: string;
      retryable: boolean;
      /** Adapter-defined classification, e.g. 'adapter_unavailable' | 'budget_exceeded' | 'worker_reported_failure'. Absent means the adapter did not classify beyond retryable/non-retryable. */
      failureClass?: string;
      /** Batch 6: for a `budget_exceeded` failureClass specifically, which guard actually stopped the run -- 'tool_max_budget_usd' (the tool's own `--max-budget-usd` flag, accurate, checked between turns) or 'scheduler_estimate' (the daemon's live tally, a known lower bound -- see pricing.ts/claudeCli.ts). Absent for every other failureClass. */
      stoppedBy?: string;
      usage?: unknown;
    };

export interface AgentAdapterCapabilities {
  supportsFiles: boolean;
  supportsShell: boolean;
  supportsStreaming: boolean;
  supportsResume: boolean;
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

  stop(handle: WorkerHandle): Promise<void>;

  destroy(handle: WorkerHandle): Promise<void>;
}

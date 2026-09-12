import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { spawnManaged, type ManagedProcess } from '../process.ts';
import { WORKER_RESULT_JSON_SCHEMA, validateWorkerResult } from '../resultContract.ts';
import { buildWorkerPrompt } from '../envelope.ts';
import { prepareWorkspace } from '../workspace.ts';
import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  TicketEnvelope,
  Workspace,
  WorkspaceType,
  WorkerEvent,
  WorkerHandle,
  WorkerResult,
  WorkerResultStatus,
} from '../types.ts';

// Adapter for the Claude Code CLI, per docs/strategy/batch-2-spec.md "Role
// E" and the evidence in docs/spikes/claude-cli-adapter.md. Spawns the
// executable directly (no shell, no Git-Bash relay — the spike's relay was
// only needed to work around npm-shim indirection on Windows, which does not
// apply once you spawn the real .exe; see batch-2-spec.md section 0).
//
// KNOWN GAP, not built: the spec asks for a not-logged-in/auth failure to
// "cancel the run without consuming a ticket attempt" and "pause the
// adapter with an inbox event". Neither is expressible with the WorkerEvent
// union or scheduler.ts as they exist after batch 1 (every WorkerEvent
// either isn't terminal, or is `result_raw`/`failure`; scheduler.ts's
// applyWorkerEvent() routes every `failure` through the same
// worker_retryable_failure ticket transition regardless of `retryable`).
// Adding a new WorkerEvent variant would be dead code, since scheduler.ts's
// switch does not handle it and scheduler.ts belongs to a different,
// already-completed role. This adapter instead classifies the case
// correctly (see `classifyOutcome`, kind: 'adapter_unavailable') and reports
// it as a non-retryable `failure` WorkerEvent with an ADAPTER_UNAVAILABLE
// marker in the message, which is the closest available signal. True
// "don't consume an attempt / pause the adapter" behaviour needs a
// scheduler-level change that is out of this role's owned files.
export interface ClaudeCliAdapterOptions {
  /** Path to the `claude` executable (or, in production, whatever `resolveExecutable('claude')` returns once Role D lands). */
  claudeExe: string;
  maxBudgetUsd: number;
  workspaceType: WorkspaceType;
  workspaceRoot?: string;
  permissionMode?: string;
  timeoutMs?: number;
  /** Extra env vars merged over process.env for the spawned process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam only, always empty in production. Args spawned before the
   * real `claude` CLI flags, so a test can set `claudeExe: process.execPath`
   * and run `node <fakeExeScript> <realClaudeArgsItIgnores>` instead of a
   * real single-binary `claude` (which Windows can't spawn directly without
   * shell indirection — see resultContract-adjacent note in
   * testFixtures/fakeClaudeExe.ts).
   */
  argsPrefix?: string[];
}

// The daemon's own status vocabulary (done/review/needs_user_decision/failed,
// see resultContract.ts) is what real workers are asked for via
// --json-schema below. The spike's recorded fixtures
// (spikes/claude-cli/runs/) predate that decision and use the CLI-facing
// convention from spikes/claude-cli/result-schema.json
// (ready_for_review/blocked/failed) — see docs/spikes/claude-cli-adapter.md.
// Map both vocabularies so replays of those fixtures and real runs both
// classify correctly.
function mapWorkerStatus(status: unknown): WorkerResultStatus | null {
  switch (status) {
    case 'ready_for_review':
      return 'review';
    case 'blocked':
      return 'needs_user_decision';
    case 'done':
      return 'done';
    case 'review':
      return 'review';
    case 'needs_user_decision':
      return 'needs_user_decision';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

export type ClaudeCliOutcome =
  | { kind: 'success'; result: WorkerResult }
  | { kind: 'retryable'; reason: string }
  | { kind: 'budget_exceeded'; reason: string }
  | { kind: 'adapter_unavailable'; reason: string };

// Not logged in exits 0 with is_error:true and this text in `result`
// (docs/spikes/claude-cli-adapter.md §3.1, HARD). Budget-exceeded has no
// recorded fixture (§2.4) — this pattern is inferred, not observed; see
// claudeCli.test.ts's budget-exceeded test for the SOFT/UNKNOWN label.
const AUTH_ERROR_PATTERN = /not logged in|please run \/login|login required/i;
const BUDGET_ERROR_PATTERN = /max[- ]budget|budget.?exceeded|spend limit/i;

interface ResultLine {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
}

function extractResultText(line: ResultLine | undefined): string {
  if (!line) return '';
  return typeof line.result === 'string' ? line.result : '';
}

function extractStructured(line: ResultLine | undefined): unknown {
  if (!line) return undefined;
  if (line.structured_output !== undefined) return line.structured_output;
  if (typeof line.result === 'string') {
    try {
      return JSON.parse(line.result);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Pure classification, driven by the evidence in the parsed terminal
// `type: "result"` stream line and/or `.orchestrator/result.json`'s
// contents — never by exit code alone (docs/spikes/claude-cli-adapter.md
// §3.4: exit code 0 is used both for success and for is_error:true).
export function classifyOutcome(input: {
  resultLine: ResultLine | undefined;
  fileResult: unknown | undefined;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
}): ClaudeCliOutcome {
  if (input.timedOut) {
    return { kind: 'retryable', reason: 'timed out before completion' };
  }

  if (input.resultLine?.is_error === true) {
    const text = extractResultText(input.resultLine);
    if (AUTH_ERROR_PATTERN.test(text)) {
      return { kind: 'adapter_unavailable', reason: text || 'worker reported an authentication error' };
    }
    if (BUDGET_ERROR_PATTERN.test(text)) {
      return { kind: 'budget_exceeded', reason: text };
    }
    return { kind: 'retryable', reason: text || 'worker reported is_error: true' };
  }

  // Independent verification: the daemon reads the worker's own result
  // file first, per the architecture doc, but never trusts it blindly (see
  // verifyArtifacts below) and falls back to the stream envelope's
  // structured_output only if the file was never written.
  const raw = input.fileResult ?? extractStructured(input.resultLine);
  if (raw === undefined) {
    const stderrSnippet = input.stderr.trim().slice(0, 500);
    return {
      kind: 'retryable',
      reason: `no parseable result on stdout (exit ${input.exitCode ?? 'null'})${
        stderrSnippet ? `: ${stderrSnippet}` : ''
      }`,
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'retryable', reason: 'result is not a JSON object' };
  }

  const rawRecord = raw as Record<string, unknown>;
  const mapped = mapWorkerStatus(rawRecord.status);
  if (mapped === null) {
    return { kind: 'retryable', reason: `unrecognized result status: ${String(rawRecord.status)}` };
  }

  const candidate = { ...rawRecord, status: mapped };
  const validated = validateWorkerResult(candidate);
  if (!validated.valid) {
    return { kind: 'retryable', reason: `malformed result: ${validated.errors.join('; ')}` };
  }

  return { kind: 'success', result: validated.data };
}

// A spike run demonstrated a schema-valid result claiming a file that was
// never written (docs/spikes/claude-cli-adapter.md §3.3: tool restriction is
// not a reliable boundary, so the daemon must verify independently). Every
// artifact path is resolved against the workspace; a path that resolves
// outside the workspace is treated as not found rather than stat'd on the
// real filesystem, since the workspace directory is the actual boundary.
export function verifyArtifacts(result: WorkerResult, workspacePath: string): ClaudeCliOutcome {
  const resolvedWorkspace = resolvePath(workspacePath);
  for (const artifact of result.artifacts) {
    const resolved = isAbsolute(artifact.path) ? resolvePath(artifact.path) : resolvePath(resolvedWorkspace, artifact.path);
    const withinWorkspace = resolved === resolvedWorkspace || resolved.startsWith(resolvedWorkspace + sep);
    if (!withinWorkspace || !existsSync(resolved)) {
      return { kind: 'retryable', reason: `artefact not found: ${artifact.path}` };
    }
  }
  return { kind: 'success', result };
}

function extractUsage(line: ResultLine | undefined): unknown {
  if (!line) return undefined;
  const l = line as Record<string, unknown>;
  return {
    usage: l.usage,
    total_cost_usd: l.total_cost_usd,
    duration_ms: l.duration_ms,
    num_turns: l.num_turns,
    session_id: l.session_id,
  };
}

function outcomeToEvent(outcome: ClaudeCliOutcome, usage: unknown): WorkerEvent {
  switch (outcome.kind) {
    case 'success':
      return { type: 'result_raw', raw: outcome.result, usage };
    case 'retryable':
      return { type: 'failure', message: outcome.reason, retryable: true, usage };
    case 'budget_exceeded':
      return { type: 'failure', message: `budget exceeded: ${outcome.reason}`, retryable: false, usage };
    case 'adapter_unavailable':
      return {
        type: 'failure',
        message: `ADAPTER_UNAVAILABLE: ${outcome.reason}`,
        retryable: false,
        usage,
      };
  }
}

function describeProgress(line: Record<string, unknown>): string | null {
  if (line.type === 'assistant') {
    const content = (line.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_use') return `tool_use: ${String(block.name)}`;
        if (block?.type === 'text' && typeof block.text === 'string') {
          return `text: ${(block.text as string).slice(0, 120)}`;
        }
      }
    }
    return 'assistant message';
  }
  if (line.type === 'user') return 'tool result received';
  if (line.type === 'system' && line.subtype === 'thinking_tokens') {
    return `thinking (~${String(line.estimated_tokens)} tokens)`;
  }
  if (line.type === 'system' && line.subtype === 'init') return 'session initialized';
  if (line.type === 'rate_limit_event') return 'rate limit status update';
  return null;
}

interface HandleState {
  ticketId: string;
  runId: string;
  managed: ManagedProcess;
  workspacePath: string;
  workspaceCleanup: () => Promise<void>;
  workspaceType: WorkspaceType;
  eventLog: WorkerEvent[];
  listeners: Array<(event: WorkerEvent) => void>;
}

export class ClaudeCliAdapter implements AgentAdapter {
  readonly id = 'claude';

  private readonly handles = new Map<string, HandleState>();
  private readonly options: ClaudeCliAdapterOptions;

  constructor(options: ClaudeCliAdapterOptions) {
    this.options = options;
  }

  async capabilities(): Promise<AgentAdapterCapabilities> {
    return { supportsFiles: true, supportsShell: true, supportsStreaming: true, supportsResume: false };
  }

  async startWorker(input: { ticket: TicketEnvelope; workspace?: Workspace; systemPolicy: string }): Promise<WorkerHandle> {
    const workspaceType = input.workspace?.type ?? this.options.workspaceType;
    const ws = input.workspace?.path
      ? { path: input.workspace.path, cleanup: async () => {} }
      : prepareWorkspace(workspaceType, input.ticket.ticketId, { workspaceRoot: this.options.workspaceRoot });

    const prompt = buildWorkerPrompt(input.ticket, ws.path);

    const args = [
      ...(this.options.argsPrefix ?? []),
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(WORKER_RESULT_JSON_SCHEMA),
      '--permission-mode',
      this.options.permissionMode ?? 'bypassPermissions',
      '--max-budget-usd',
      String(this.options.maxBudgetUsd),
    ];

    const managed = spawnManaged({
      executable: this.options.claudeExe,
      args,
      cwd: ws.path,
      timeoutMs: this.options.timeoutMs,
      env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
    });

    const runId = `claudecli_run_${randomUUID()}`;
    const handleId = `claudecli_worker_${randomUUID()}`;
    const state: HandleState = {
      ticketId: input.ticket.ticketId,
      runId,
      managed,
      workspacePath: ws.path,
      workspaceCleanup: ws.cleanup,
      workspaceType,
      eventLog: [],
      listeners: [],
    };
    this.handles.set(handleId, state);

    let resultLine: ResultLine | undefined;
    let stdoutTail = '';
    managed.onStdout((chunk) => {
      stdoutTail += chunk;
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === 'result') {
          resultLine = obj as ResultLine;
        } else {
          const message = describeProgress(obj);
          if (message) this.publish(state, { type: 'progress', message });
        }
      }
    });

    let stderrBuf = '';
    managed.onStderr((chunk) => {
      stderrBuf += chunk;
    });

    void managed.wait().then(async (waitResult) => {
      if (stdoutTail.trim()) {
        try {
          const obj = JSON.parse(stdoutTail);
          if (obj && obj.type === 'result') resultLine = obj as ResultLine;
        } catch {
          // Trailing partial line that never completed; nothing to recover.
        }
      }

      let fileResult: unknown;
      try {
        fileResult = JSON.parse(readFileSync(join(ws.path, '.orchestrator', 'result.json'), 'utf8'));
      } catch {
        fileResult = undefined;
      }

      let outcome = classifyOutcome({
        resultLine,
        fileResult,
        exitCode: waitResult.code,
        stderr: stderrBuf,
        timedOut: waitResult.timedOut,
      });

      if (outcome.kind === 'success') {
        outcome = verifyArtifacts(outcome.result, ws.path);
      }

      const usage = extractUsage(resultLine);
      this.publish(state, outcomeToEvent(outcome, usage));

      if (workspaceType === 'NONE') {
        await ws.cleanup();
      }
    });

    return { id: handleId, ticketId: input.ticket.ticketId, runId };
  }

  async send(): Promise<void> {
    // A `claude -p` run is a single one-shot invocation with no persistent
    // session to send a follow-up message into. Not supported by this
    // adapter.
  }

  async observe(handle: WorkerHandle, onEvent: (event: WorkerEvent) => void): Promise<() => void> {
    const state = this.handles.get(handle.id);
    if (!state) throw new Error(`unknown handle: ${handle.id}`);

    // Replay whatever already happened (the process may have finished
    // before observe() was even called) before registering for live events,
    // so no event is ever lost to the startWorker/observe timing gap.
    for (const event of state.eventLog) onEvent(event);
    state.listeners.push(onEvent);

    return () => {
      state.listeners = state.listeners.filter((l) => l !== onEvent);
    };
  }

  async stop(handle: WorkerHandle): Promise<void> {
    const state = this.handles.get(handle.id);
    if (!state) return;
    await state.managed.stop();
  }

  async destroy(handle: WorkerHandle): Promise<void> {
    await this.stop(handle);
    this.handles.delete(handle.id);
  }

  private publish(state: HandleState, event: WorkerEvent): void {
    state.eventLog.push(event);
    for (const listener of state.listeners) listener(event);
  }
}

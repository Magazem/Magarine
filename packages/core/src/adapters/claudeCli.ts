import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { spawnManaged, type ManagedProcess } from '../process.ts';
import { WORKER_RESULT_JSON_SCHEMA, validateWorkerResult } from '../resultContract.ts';
import { buildWorkerPrompt } from '../envelope.ts';
import { buildVerifierPrompt, VERIFIER_RESULT_JSON_SCHEMA } from '../verifier.ts';
import { prepareWorkspace, resolveDeclaredArtifactPath } from '../workspace.ts';
import { isKnownModel, priceUsage, type Usage } from '../pricing.ts';
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
// The not-logged-in/auth gap this comment used to describe (batch 2: no way
// to cancel without consuming an attempt or pause the adapter) is closed as
// of batch 10, and is proven by workerSpawnedPipeline.test.ts's
// 'adapter_unavailable' test -- the recorded not-logged-in fixture driven
// through this real adapter and a real scheduler tick.
//
// An earlier version of this comment claimed the gap was closed in batch 3
// and named no test. It was not closed. `outcomeToEvent` never set
// `failureClass`, so scheduler.ts's guard never matched and the intended
// path was unreachable from the real adapter for seven batches, while this
// comment asserted otherwise. Hence the rule that now applies project-wide:
// a comment claiming a path is handled elsewhere must name the test that
// proves it, or it is deleted. Batch 4 closes the
// related gap for every OTHER failure: the scheduler now asks for one
// `worker_failure` transition carrying `retryable`, and stateMachine.ts
// decides READY vs FAILED from that flag rather than treating every failure
// the same way (see stateMachine.ts's module header comment).
export interface ClaudeCliAdapterOptions {
  /** Path to the `claude` executable (or, in production, whatever `resolveExecutable('claude')` returns once Role D lands). */
  claudeExe: string;
  /**
   * Batch 11 ruling 2/4 (the Strategist's narrow licence into this file:
   * ONLY the composition of the spawn-failure error uses this field, nothing
   * else in this adapter reads it). Mirrors process.ts's `ResolvedCommand`
   * (minus `executable`, already `claudeExe` above) -- how `claudeExe` was
   * found, so a spawn failure can say more than a bare path. Undefined in
   * every test that doesn't set it (the existing `claudeExe: process.execPath`
   * seam), which is fine: the spawn-failure message falls back to the path
   * alone when this is absent, same as before this field existed.
   */
  claudeResolution?: { strategy: string; shimPath?: string };
  /**
   * Fallback only, used if a call to `startWorker` is ever given an envelope
   * with no `maxBudgetUsd` (defensive; TicketEnvelope's field is not
   * optional in practice). The real per-run ceiling is
   * `input.ticket.maxBudgetUsd` -- see `startWorker`.
   */
  maxBudgetUsd: number;
  workspaceType: WorkspaceType;
  workspaceRoot?: string;
  permissionMode?: string;
  timeoutMs?: number;
  /** Extra env vars merged over process.env for the spawned process. */
  env?: NodeJS.ProcessEnv;
  /** Passed straight through to `prepareWorkspace`'s `baseDir` for NONE-mode runs. Test-only; production default (the OS temp directory) is unchanged. See workspace.ts's WorkspaceOptions.baseDir. */
  baseDir?: string;
  /** Test-only seam, forwarded to `prepareWorkspace`'s WorkspaceOptions.removeFn -- lets a test force a NONE-mode cleanup failure deterministically. See "cleanup failure must not swallow the terminal event" in claudeCli.test.ts. */
  workspaceRemoveFn?: (path: string) => void;
  /** Test-only seam, forwarded to `prepareWorkspace`'s WorkspaceOptions.retryAttempts. */
  workspaceRetryAttempts?: number;
  /** Test-only seam, forwarded to `prepareWorkspace`'s WorkspaceOptions.retryDelayMs. */
  workspaceRetryDelayMs?: number;
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
    // Batch 7 (Role L, docs/strategy/batch-7-spec.md section 1 ruling 1):
    // without this case, a real worker's own budget self-stop
    // (`status: 'budget_insufficient'`, which envelope.ts's prompt now tells
    // every worker to report) falls through to `default: null` below and
    // `classifyOutcome` reports it as a generic retryable failure -- the
    // exact misclassification this status exists to fix, reproduced one
    // layer down from where it was fixed. Found by the Orchestrator during
    // batch 7 close-out verification, same shape as batch 4's `failureClass`
    // propagation gap (batch-6-closeout.md section 3's citation of it):
    // correct at the point of detection, discarded one layer down, invisible
    // to a test suite that only ever drives the fake adapter through this
    // path.
    case 'budget_insufficient':
      return 'budget_insufficient';
    default:
      return null;
  }
}

export type ClaudeCliOutcome =
  | { kind: 'success'; result: WorkerResult }
  // Batch 18 ruling 31: a VERIFIER run's raw structured answer. Not validated
  // here -- verifier.ts validates it against the criteria the run was given.
  | { kind: 'verifier_raw'; raw: unknown }
  | { kind: 'retryable'; reason: string }
  | { kind: 'budget_exceeded'; reason: string }
  | { kind: 'adapter_unavailable'; reason: string };

// Not logged in exits 0 with is_error:true and this text in `result`
// (docs/spikes/claude-cli-adapter.md §3.1, HARD).
const AUTH_ERROR_PATTERN = /not logged in|please run \/login|login required/i;

// Batch 4 (docs/strategy/batch-4-spec.md section 0, HARD): the Orchestrator
// probed the real tool directly and found budget overspend signalled in a
// FIELD, not prose -- `subtype: 'error_max_budget_usd'` with `result:
// undefined`. The previous version of this file matched a regex against
// `result` text, which can never fire against a message that doesn't exist
// (batch-3-closeout.md §5). Discriminate on the field; no prose pattern.
const BUDGET_EXCEEDED_SUBTYPE = 'error_max_budget_usd';

interface ResultLine {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  subtype?: string;
  // Batch 6 item 4, HARD (read directly off every real recorded fixture
  // this repo has a terminal result line for -- both calibration fixtures
  // and every "happy"/"restrict-write"/"disallow-write" spike run):
  // per-model, per-run totals keyed by the exact canonical model string
  // (verified identical to the `message.model` assistant lines print, and
  // to pricing.ts's rate-table keys, on both calibration fixtures). This is
  // the authoritative "which model(s) actually ran" signal for a completed
  // run -- more reliable than trusting the `--model` flag was honoured,
  // since it's what actually billed.
  modelUsage?: Record<string, unknown>;
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
  /** Batch 18 ruling 31: this run is a verifier; its answer is a verdict object, not a WorkerResult. */
  verify?: boolean;
}): ClaudeCliOutcome {
  if (input.timedOut) {
    return { kind: 'retryable', reason: 'timed out before completion' };
  }

  if (input.resultLine?.is_error === true) {
    if (input.resultLine.subtype === BUDGET_EXCEEDED_SUBTYPE) {
      return { kind: 'budget_exceeded', reason: `subtype: ${BUDGET_EXCEEDED_SUBTYPE}` };
    }
    const text = extractResultText(input.resultLine);
    if (AUTH_ERROR_PATTERN.test(text)) {
      return { kind: 'adapter_unavailable', reason: text || 'worker reported an authentication error' };
    }
    return { kind: 'retryable', reason: text || 'worker reported is_error: true' };
  }

  // Independent verification: the daemon reads the worker's own result
  // file first, per the architecture doc, but never trusts it blindly (see
  // verifyArtifacts below) and falls back to the stream envelope's
  // structured_output only if the file was never written.
  // A verifier never writes files, so a result.json in its workspace (the
  // worker's, in a shared directory) is not its answer: only the structured
  // output of its own run counts.
  const raw = input.verify ? extractStructured(input.resultLine) : (input.fileResult ?? extractStructured(input.resultLine));
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

  if (input.verify) return { kind: 'verifier_raw', raw };

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
// FILE artifact path is resolved against the workspace; a path that resolves
// outside the workspace is treated as not found rather than stat'd on the
// real filesystem, since the workspace directory is the actual boundary.
//
// Batch 11: only `kind === 'file'` is checked for existence -- consistent
// with how this codebase already treats every other artifact kind
// (scheduler.ts's captureDirectoryArtifacts/captureNoneModeArtifacts store a
// non-'file' artifact's `path` field verbatim, as opaque text/URI, with no
// filesystem resolution at all). Before this batch every real artifact kind
// ever declared was 'file' (a proposal.json, a worker's own output file), so
// this distinction was latent and untested; `manager_reply`/
// `manager_assessment` (managerEnvelope.ts's MANAGER_EXPECTED_OUTPUT_FORMAT)
// are the first non-'file' kinds a real Manager run declares, and their
// `path` field carries the reply/assessment TEXT itself, not a location on
// disk -- resolving that text as a filesystem path and demanding it exist
// would reject every real discuss/interview turn. Caught by
// managerSpawnedPipeline.test.ts's synthetic spawned-pipeline tests for
// these two kinds, which fail without this change.
export function verifyArtifacts(result: WorkerResult, workspacePath: string): ClaudeCliOutcome {
  const resolvedWorkspace = resolvePath(workspacePath);
  for (const artifact of result.artifacts) {
    if (artifact.kind !== 'file') continue;
    const resolved = resolveDeclaredArtifactPath(resolvedWorkspace, artifact.path);
    const withinWorkspace = resolved === resolvedWorkspace || resolved.startsWith(resolvedWorkspace + sep);
    if (!withinWorkspace || !existsSync(resolved)) {
      return { kind: 'retryable', reason: `artefact not found: ${artifact.path}` };
    }
  }
  return { kind: 'success', result };
}

// Batch 6 item 4: `resolvedModel` is what the envelope asked `--model` for;
// `line.modelUsage`'s key(s), when present, are what the run actually
// billed under (see ResultLine's field comment) and are preferred when
// there is exactly one -- the more-than-one case has zero evidence behind
// it in any fixture this repo has, so it falls back to the requested model
// rather than inventing a multi-model shape for usage_json.
function extractUsage(line: ResultLine | undefined, resolvedModel: string): unknown {
  if (!line) return undefined;
  const l = line as Record<string, unknown>;
  const observedModels = line.modelUsage ? Object.keys(line.modelUsage) : [];
  const model = observedModels.length === 1 ? observedModels[0] : resolvedModel;
  return {
    usage: l.usage,
    total_cost_usd: l.total_cost_usd,
    duration_ms: l.duration_ms,
    num_turns: l.num_turns,
    session_id: l.session_id,
    model,
  };
}

// Batch 6 item 4: `resultLine.modelUsage`'s keys are the authoritative
// model(s) this run actually billed under (see ResultLine's field comment),
// available only once a terminal `result` line arrives -- so a run this
// daemon killed itself (budget-stopped mid-flight) never has one to check,
// same limitation the mid-run per-message check exists to cover instead.
// Returns the first unrecognized model name found, or undefined if every
// model named is in pricing.ts's rate table (including the case where no
// result line, or no modelUsage on it, ever arrived).
function unknownModelFromResultLine(resultLine: ResultLine | undefined): string | undefined {
  const modelUsage = resultLine?.modelUsage;
  if (!modelUsage) return undefined;
  return Object.keys(modelUsage).find((model) => !isKnownModel(model));
}

function outcomeToEvent(outcome: ClaudeCliOutcome, usage: unknown, unknownModel: string | undefined): WorkerEvent {
  switch (outcome.kind) {
    case 'success':
      return { type: 'result_raw', raw: outcome.result, usage, unknownModel };
    case 'verifier_raw':
      return { type: 'result_raw', raw: outcome.raw, usage, unknownModel };
    case 'retryable':
      return { type: 'failure', message: outcome.reason, retryable: true, usage, unknownModel };
    case 'budget_exceeded':
      // Batch 6: this outcome previously carried no failureClass at all, so
      // scheduler.ts's `event.failureClass ?? 'adapter_failure'` fallback
      // silently mis-recorded a real tool-side budget stop as a generic
      // adapter failure -- found while adding `stoppedBy`, not something
      // that was ever asserted correct by a test. `stoppedBy:
      // 'tool_max_budget_usd'` distinguishes this from the scheduler's own
      // estimate-driven stop (scheduler.ts's progress-event ceiling check),
      // which sets `stoppedBy: 'scheduler_estimate'` on its own transition.
      return {
        type: 'failure',
        message: `budget exceeded: ${outcome.reason}`,
        retryable: false,
        failureClass: 'budget_exceeded',
        stoppedBy: 'tool_max_budget_usd',
        usage,
        unknownModel,
      };
    case 'adapter_unavailable':
      return {
        type: 'failure',
        message: `ADAPTER_UNAVAILABLE: ${outcome.reason}`,
        retryable: false,
        // Load-bearing, not decorative. scheduler.ts's failure branch matches
        // on `retryable === false && failureClass === 'adapter_unavailable'`
        // before it will cancel the run without consuming an attempt, pause
        // the project's adapter and file the inbox notice. Omit this field
        // and a genuinely not-logged-in worker silently takes the generic
        // path instead: FAILED, an attempt burned, no pause, no inbox item.
        // That is what happened from batch 3 until batch 10, because only
        // FakeAdapter ever reached this path and the fake sets the field by
        // hand. Proven by workerSpawnedPipeline.test.ts's 'adapter_unavailable'
        // test, which drives the recorded not-logged-in fixture through the
        // real adapter and a real scheduler tick.
        failureClass: 'adapter_unavailable',
        usage,
        unknownModel,
      };
  }
}

// Batch 15 addendum 3 (ruling 14): sources the "testing" activity state at
// THIS adapter, from the tool-use block's own `input.command`, rather than
// persisting the command text downstream for something else to classify --
// a Bash command line is the likeliest place in this system for a secret to
// appear, and the daemon's event log is replayed over the stream and
// rendered in a browser, permanently (see this file's own doc comment on
// the strategist ruling this addendum records). `describeProgress` below
// reads this predicate's answer only -- never the command itself -- into
// the message it emits.
//
// Token match, not substring: split on the shell's own chaining operators
// first (so `export SECRET=x && pnpm test` is still recognised), then each
// resulting piece on whitespace, then match the FIRST token (its basename,
// so a full path like `./node_modules/.bin/vitest` still matches) against
// the runner names this ruling lists by name -- never a bare `.includes('test')`
// against the whole string, which is exactly what would make `cat test.md`
// a false positive.
const BARE_TEST_RUNNER_NAMES = new Set(['vitest', 'jest', 'mocha', 'pytest']);

function commandBasename(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1];
}

function subcommandIsTestRunner(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const head = commandBasename(tokens[0]);
  if (BARE_TEST_RUNNER_NAMES.has(head)) return true;
  if (head === 'pnpm' || head === 'npm' || head === 'yarn') {
    return tokens[1] === 'test' || (tokens[1] === 'run' && tokens[2] === 'test');
  }
  if (head === 'node') return tokens.slice(1).includes('--test');
  if (head === 'cargo' || head === 'go' || head === 'dotnet') return tokens[1] === 'test';
  return false;
}

export function isTestRunnerCommand(command: string): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some((sub) => subcommandIsTestRunner(sub.trim().split(/\s+/).filter(Boolean)));
}

function describeProgress(line: Record<string, unknown>): string | null {
  if (line.type === 'assistant') {
    const content = (line.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_use') {
          const name = String(block.name);
          if (name === 'Bash') {
            const input = block.input as Record<string, unknown> | undefined;
            const command = typeof input?.command === 'string' ? input.command : undefined;
            return command !== undefined && isTestRunnerCommand(command) ? 'tool_use: Bash (test runner)' : 'tool_use: Bash';
          }
          return `tool_use: ${name}`;
        }
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

// Batch 4 item 3: the daemon needs its own running cost estimate, not just
// the tool's terminal `total_cost_usd` (which only arrives once, at the very
// end -- too late for the scheduler to stop an overspending run mid-flight).
//
// Batch 6 item 2 replaces the single BLENDED_USD_PER_RAW_TOKEN constant
// (removed) with per-model, per-category pricing via `priceUsage`
// (pricing.ts), reading `message.model` straight off the same assistant
// line the usage comes from. This fixes the model-blindness batch 5 found
// (405% off on a second model, docs/strategy/batch-5-closeout.md section 2)
// for the categories it can fix.
//
// HARD, and this is a real limitation, not a rounding error: deduping by
// message id and summing input_tokens/cache_creation_input_tokens/
// cache_read_input_tokens across `assistant` lines reproduces the terminal
// `result` line's authoritative totals for those three categories EXACTLY,
// on both fixtures this repository has an authoritative total for. Doing
// the same for output_tokens does not -- the deduped sum is 104 against an
// authoritative 644 on one fixture (16.1% of true) and 30 against 489 on
// the other (6.1% of true). No stable multiplier bridges this: the
// undercount factor differs 2.6x between the two points, and the
// `system`/`thinking_tokens` progress lines that might look like the
// missing signal are themselves estimates that overshoot the terminal
// line's own `output_tokens_details.thinking_tokens` (202 estimated vs. 81
// final on one fixture) while the true output gap is far larger than the
// thinking count either way -- thinking is not the missing piece, and
// nothing else on the stream reports it. There is no available signal,
// short of the terminal line itself, for the extra output tokens; a
// mid-run tally is structurally unable to see them. See claudeCli.test.ts's
// "running cost tally... undercounts" test for the full numbers on both
// fixtures.
//
// Practical consequence, worth restating because nobody has flagged it yet:
// BLENDED_USD_PER_RAW_TOKEN was curve-fit to fixture 1's true dollar total,
// so it was inflated well above real per-category rates to compensate for
// exactly this output undercount -- which is incidentally why the batch 5
// budget-stop run tripped at $0.2565 against a $0.25 ceiling. Pricing each
// category at its real rate removes that inflation, so the running tally
// this function now produces is LOWER than before on every run, and the
// scheduler's budget stop will fire LATER, not at the same point. This is
// the correct behaviour for a rate table that no longer over-charges
// input/cache tokens to paper over the output gap, but it directly affects
// how close to a ceiling a close-out run should expect to land.
//
// Given the ceiling is enforced from this tally, an unfixable output
// undercount means the ceiling can be beaten by real spend on an
// output-heavy, cache-light run -- silently, since the daemon has no
// signal telling it its own estimate is low. This is reported, not
// papered over, per docs/strategy/batch-6-spec.md's instruction to state
// the disagreement rather than loosen a bound.
function messageModel(msg: Record<string, unknown> | undefined): string | undefined {
  return typeof msg?.model === 'string' ? msg.model : undefined;
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
  /** Assistant message ids already tallied, so a repeated stream emission of the same turn (observed in real fixtures) is not double-counted. */
  talliedMessageIds: Set<string>;
  costTallyUsd: number;
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
      : prepareWorkspace(workspaceType, input.ticket.ticketId, {
          workspaceRoot: this.options.workspaceRoot,
          baseDir: this.options.baseDir,
          removeFn: this.options.workspaceRemoveFn,
          retryAttempts: this.options.workspaceRetryAttempts,
          retryDelayMs: this.options.workspaceRetryDelayMs,
        });

    const isVerifier = input.ticket.runKind === 'verify';
    const prompt = isVerifier ? buildVerifierPrompt(input.ticket, ws.path) : buildWorkerPrompt(input.ticket, ws.path);

    const args = [
      ...(this.options.argsPrefix ?? []),
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(isVerifier ? VERIFIER_RESULT_JSON_SCHEMA : WORKER_RESULT_JSON_SCHEMA),
      '--permission-mode',
      this.options.permissionMode ?? 'bypassPermissions',
      '--max-budget-usd',
      // Batch 4 item 2: the ceiling comes from the envelope (the ticket's
      // own override, or the project default if unset -- see
      // store.ts's resolveMaxBudgetUsd), not the adapter's constructor
      // option. Before this, every ticket got the same flag value
      // regardless of its own override (batch-3-closeout.md §8 item 3): the
      // constructor value was always used, so the CLI's `ticket add
      // --budget` had no effect on what the tool itself enforced.
      String(input.ticket.maxBudgetUsd ?? this.options.maxBudgetUsd),
      // Batch 6 item 4: the daemon never passed this flag at all before now
      // (docs/strategy/batch-6-spec.md section 0), so every worker ran on
      // whatever the owner's desktop default happened to be -- the root
      // cause behind batch 5's 405%-wrong cost estimate (two runs, two
      // different models). `input.ticket.model` is the envelope's resolved
      // model (ticket override, else project default -- store.ts's
      // resolveModel); nothing about a worker's cost or capability may
      // depend on the owner's desktop settings from here on. SOFT: `--model`
      // as the flag name is confirmed HARD against this machine's installed
      // `claude --help` (accepts either a short alias or a model's full
      // name), but no fixture in this repo's spikes/claude-cli/runs/ was
      // ever recorded with this flag set, so end-to-end behaviour under a
      // real pinned run is unverified until the Orchestrator's close-out.
      '--model',
      input.ticket.model,
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
      talliedMessageIds: new Set(),
      costTallyUsd: 0,
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
          // Batch 6 item 3: set whenever THIS line's model isn't in
          // pricing.ts's rate table (including a line that omits `model`
          // altogether), so a progress event can carry it forward for the
          // scheduler to raise `unknown_model_rate` on -- pricing already
          // falls back to the most-expensive-known rate either way
          // (pricing.ts's UNKNOWN_MODEL_RATES), so this is purely the
          // "tell someone" half of that ruling, not a pricing change.
          let unknownModel: string | undefined;
          if (obj.type === 'assistant') {
            const msg = obj.message as Record<string, unknown> | undefined;
            const usage = msg?.usage as Usage | undefined;
            const messageId = typeof msg?.id === 'string' ? msg.id : undefined;
            const model = messageModel(msg);
            if (usage && messageId && !state.talliedMessageIds.has(messageId)) {
              state.talliedMessageIds.add(messageId);
              state.costTallyUsd += priceUsage(model ?? '', usage);
            }
            if (!isKnownModel(model ?? '')) {
              unknownModel = model ?? '(assistant line carried no model field)';
            }
          }
          const message = describeProgress(obj);
          if (message) this.publish(state, { type: 'progress', message, costUsd: state.costTallyUsd, unknownModel });
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

      // Batch 11 ruling 2/4: process.ts's spawnManaged now resolves (rather
      // than crashing or hanging -- see that fix's own comment) with
      // `spawnError` set when the resolved executable never actually
      // started -- deleted, permission denied, or a shim whose target
      // vanished between `doctor` last checking it and this real attempt.
      // Without this check, that case fell through to classifyOutcome's
      // generic "no parseable result on stdout" -- RETRYABLE, so the
      // scheduler would burn every attempt re-spawning the identical broken
      // path -- instead of adapter_unavailable, which pauses without
      // consuming one and puts a clear reason in front of the owner. The
      // reason names the resolved path, the shim it came from (if any), and
      // the strategy that chose it, so the owner (or whoever is helping
      // them) can tell a stale resolution apart from a real login problem.
      let outcome: ClaudeCliOutcome;
      if (waitResult.spawnError) {
        const resolution = this.options.claudeResolution;
        const shimNote = resolution?.shimPath ? `, from shim ${resolution.shimPath}` : '';
        const strategyNote = resolution ? ` (resolved via ${resolution.strategy}${shimNote})` : '';
        outcome = {
          kind: 'adapter_unavailable',
          reason: `could not start ${this.options.claudeExe}${strategyNote}: ${waitResult.spawnError}`,
        };
      } else {
        outcome = classifyOutcome({
          resultLine,
          fileResult,
          exitCode: waitResult.code,
          stderr: stderrBuf,
          timedOut: waitResult.timedOut,
          verify: isVerifier,
        });
      }

      if (outcome.kind === 'success') {
        outcome = verifyArtifacts(outcome.result, ws.path);
      }

      const usage = extractUsage(resultLine, input.ticket.model);
      const unknownModel = unknownModelFromResultLine(resultLine);

      // Cleanup before publish, not after: publish() calls every observer
      // synchronously, and a test (or a real caller) awaiting the terminal
      // event and then immediately checking the filesystem must not race an
      // async cleanup that is still in flight. (Pre-existing ordering bug,
      // not introduced by batch 4 -- caught here because it occasionally
      // flaked the full suite under load: "NONE workspace directories are
      // removed after the run completes" in claudeCli.test.ts.)
      //
      // Batch 9 housekeeping item 1: cleanup failing must never cost the
      // caller the run's own terminal event. Before this try/catch, an
      // exhausted retry (see workspace.ts's removeDirectoryResilient) threw
      // out of this `.then()` callback -- an unhandled rejection that never
      // reached `this.publish` below, so a real run's actual result (done,
      // failed, whatever it was) was silently lost and the ticket stayed
      // IN_PROGRESS forever. A leftover temp directory is cosmetic; losing
      // the terminal event is not -- cleanup is best-effort bookkeeping, not
      // a precondition for reporting what the worker actually did.
      if (workspaceType === 'NONE') {
        try {
          await ws.cleanup();
        } catch (err) {
          process.stderr.write(
            `claude-cli adapter: failed to remove workspace ${ws.path}: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }

      this.publish(state, outcomeToEvent(outcome, usage, unknownModel));
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

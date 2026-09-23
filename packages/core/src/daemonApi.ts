import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, type Db } from './db/index.ts';
import { newId } from './id.ts';
import { buildActivity, buildTicketProgress } from './commands/activity.ts';
import { approve, ApproveError } from './commands/approve.ts';
import { buildBoard, buildSlots } from './commands/board.ts';
import { decide, DecideError } from './commands/decide.ts';
import { buildInbox } from './commands/inbox.ts';
import { buildProjectList } from './commands/projectList.ts';
import { reject, RejectError } from './commands/reject.ts';
import { resume, ResumeError } from './commands/resume.ts';
import { retry, RetryError } from './commands/retry.ts';
import type { DaemonLoop } from './daemon.ts';
import { resolveReadiness } from './dependencies.ts';
import { discussProject, ManagerError, readScopeText, writeScopeTextAtomic } from './manager.ts';
import { summarizeScopeChange } from './managerApply.ts';
import { buildConversation } from './commands/conversation.ts';
import { classify } from './policy.ts';
import { planWithMission } from './commands/plan.ts';
import { isKnownModel, knownModelIds } from './pricing.ts';
import { validateExpectedArtifacts } from './proposal.ts';
import { probeScopeFile } from './scopeProbe.ts';
import {
  addDependency,
  assertValidMaxParallelWorkers,
  assertValidSettingValue,
  createTicket,
  createWorkerProfile,
  getProject,
  getSettings,
  getTicket,
  getWorkerProfile,
  insertEvent,
  listEventsSince,
  listWorkerProfiles,
  NoSuchWorkerProfileError,
  retireWorkerProfile,
  resolveMachineCap,
  setProjectDefaultModel,
  setProjectDir,
  setProjectManagerModel,
  setProjectVerifierModel,
  setProjectMaxParallelWorkers,
  setProjectMaxSpendUsd,
  setSetting,
  SETTINGS_KEYS,
  setTicketBudgetOverride,
  updateWorkerProfile,
  workerProfileStatus,
  unsetSetting,
} from './store.ts';
import type { AgentAdapter, DependencyType, EventRow, ExpectedArtifact, WorkspaceType } from './types.ts';

// The daemon's HTTP API -- docs/strategy/batch-8-spec.md section 2's route
// list, verbatim: "GET /health, GET /board, GET /inbox, GET /activity, POST
// /tickets, POST /deps, POST /tickets/{id}/decide|retry|approve|reject|
// cancel, POST /projects/{id}/resume|set, POST /tick to force a pass.
// Nothing else." All JSON, all behind the token. Batch 9 adds exactly one
// route to that list, per its own spec (section 2): `POST
// /projects/{id}/plan`, the Manager's daemon-route trigger. Batch 15 (Role
// A, ruling 7 and its own item 2) adds `GET /tickets/{id}/progress`, `GET
// /events?since=<sequence>` (answering `text/event-stream`, see
// handleEventsStream below -- the one non-JSON route this file serves) and
// the `GET /ui/<name>` static asset route (ruling 12). Batch 19 ruling 35
// adds `GET`/`PATCH /settings`, `PATCH /projects/{id}` (a stricter sibling
// of the existing `POST /projects/{id}/set`, see handlePatchProject's own
// comment) and `PUT /projects/{id}/scope` (the scope editor's write side,
// alongside the existing `GET`).
//
// Every mutation here goes through the exact same functions the CLI already
// calls (store.ts, commands/*.ts, dependencies.ts) -- this file adds no
// second way to reach `tickets.status`; stateMachine.ts's
// recordTicketTransition remains the only writer (see architecture.test.ts).
// The API is a second SURFACE onto the same single-writer logic, not a
// second write path.

export interface DaemonApiDeps {
  db: Db;
  adapter: AgentAdapter;
  loop: DaemonLoop;
  token: string;
  pid: number;
  startedAt: string;
  // Review fix (1B): this used to be a single fixed number (or undefined),
  // frozen at createRequestHandler() time -- so a daemon started WITHOUT
  // `--max-parallel` reported `slots.cap: null` on every `/health`/`/board`
  // forever, never picking up a `config set max_parallel_workers` the way
  // admission itself already does (daemon.ts's tickProject). Renamed to make
  // that explicit: this is the FLAG's value only (undefined when not given);
  // `/health` and `/board` below call store.ts's resolveMachineCap(deps.db,
  // deps.machineCapFlag) FRESH on every request, same function and same
  // fallback (`?? settings.max_parallel_workers ?? 1`) daemon.ts uses per
  // tick -- so the reported cap is never null and never stale.
  /** `serve --max-parallel`'s own value; undefined when the flag was not given. Never read directly -- see resolveMachineCap's call sites in /health and /board below. */
  machineCapFlag?: number;
  /** Magarine's state directory: `GET /projects` needs it for the readiness rules (batch 16 ruling 24). */
  stateDir: string;
  /** The clock launch codes expire against (epoch milliseconds). Injectable so a test proves the sixty seconds without sleeping; `Date.now` in production. */
  now?: () => number;
}

// Batch 17 Role A item 3 (ruling 30 item 4): launch codes. `magarine app` opens
// the window already signed in WITHOUT the token ever being a command-line
// argument, a URL, a log line or terminal output (ruling 20), by minting a
// one-time code the page trades for the token. Held in the request handler's
// memory only -- a daemon restart forgets them, which is the right failure.
const LAUNCH_CODE_TTL_MS = 60_000;
const LAUNCH_CODE_CAP = 16;
const LAUNCH_CODE_REFUSED = 'launch code expired or already used';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(text);
}

// Constant-time comparison so a wrong guess cannot be distinguished from a
// right one by response latency. Length is compared first (timingSafeEqual
// requires equal-length buffers and throws otherwise) -- comparing lengths
// leaks only the token's length, not any of its content, and the token is
// a fixed-size (32-byte) random value anyway, so no real length secrecy is
// lost by this early return.
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ApiError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requireQueryParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ApiError(400, `missing required query parameter: ${name}`);
  return value;
}

// Known "this input/state was wrong" errors from the existing command layer
// become 400s -- the same uniform treatment cli.ts's own top-level
// `main().catch` already gives every one of these today (print the message,
// exit non-zero; no stack, no distinction between "caller's fault" and
// "unexpected"). A truly unanticipated throw is rare enough here (every
// command function's own failure modes are already the ones listed) that
// the same flattening this project already accepts at the CLI layer is a
// reasonable one for the API layer too, rather than inventing a second,
// finer-grained error taxonomy this batch was not asked for.
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (
    err instanceof DecideError ||
    err instanceof RetryError ||
    err instanceof ApproveError ||
    err instanceof RejectError ||
    err instanceof ResumeError ||
    err instanceof ManagerError ||
    err instanceof NoSuchWorkerProfileError ||
    err instanceof Error
  ) {
    return new ApiError(400, err.message);
  }
  return new ApiError(500, 'internal error');
}

interface RouteResult {
  status: number;
  body: unknown;
}

async function handleCreateTicket(db: Db, body: unknown): Promise<RouteResult> {
  const b = body as {
    project?: string;
    title?: string;
    description?: string | null;
    maxAttempts?: number;
    priority?: number;
    workspaceType?: string;
    acceptanceCriteria?: string[];
    model?: string | null;
    /** Batch 19 mini-phase 1A: a worker profile's id or name, mutually exclusive with `model` -- resolved and validated inside `createTicket` (store.ts), the same place `ticket add --profile` (cli.ts) resolves it. */
    profile?: string | null;
    budget?: number;
    dependsOn?: string[];
    expectedArtifacts?: ExpectedArtifact[];
  };
  if (!b.project || !b.title) throw new ApiError(400, '"project" and "title" are required');

  // Ruling 16, amended: the same null/[] discipline as the CLI's
  // `ticket add --expected-artifact` (`flagList` there, this check here) --
  // `createTicket` (store.ts) persists `[]` as a real, non-null list, so
  // absent and empty must both be refused from ever reaching it as `[]`.
  // Full JSON shape here (not the CLI's path-only shorthand), validated by
  // the same function the Manager's create_ticket/update_ticket use.
  let expectedArtifacts: ExpectedArtifact[] | null = null;
  if (b.expectedArtifacts !== undefined) {
    if (Array.isArray(b.expectedArtifacts) && b.expectedArtifacts.length === 0) {
      throw new ApiError(400, 'expectedArtifacts must be omitted or non-empty');
    }
    const errors = validateExpectedArtifacts(b.expectedArtifacts, 'ticket', 'expectedArtifacts');
    if (errors.length > 0) throw new ApiError(400, errors.join('; '));
    expectedArtifacts = b.expectedArtifacts;
  }

  const ticket = createTicket(db, {
    projectId: b.project,
    title: b.title,
    description: b.description ?? null,
    maxAttempts: b.maxAttempts ?? 3,
    priority: b.priority ?? 0,
    workspaceType: (b.workspaceType ?? 'NONE') as WorkspaceType,
    acceptanceCriteria: b.acceptanceCriteria ?? [],
    model: b.model ?? null,
    profile: b.profile ?? null,
    expectedArtifacts,
  });

  // MIN_BUDGET_USD floor is enforced inside setTicketBudgetOverride itself
  // (store.ts); a below-floor value throws, caught by the outer handler and
  // reported as a 400 naming the floor, same as the CLI's `ticket add --budget`.
  if (typeof b.budget === 'number') {
    setTicketBudgetOverride(db, ticket.id, b.budget);
  }

  // Same ordering the CLI's `ticket add` enforces (cli.ts): every dependency
  // is attached before readiness is resolved, never before -- see
  // dependencies.ts's resolveReadiness doc comment for why a ticket must
  // never be briefly READY while a dependsOn from this same call hasn't
  // landed yet.
  const dependsOn = b.dependsOn ?? [];
  for (const dependsOnTicketId of dependsOn) {
    addDependency(db, { ticketId: ticket.id, dependsOnTicketId });
  }
  if (dependsOn.length > 0) {
    resolveReadiness(db, ticket.projectId);
  }

  return { status: 201, body: getTicket(db, ticket.id)! };
}

function handleAddDependency(db: Db, body: unknown): RouteResult {
  const b = body as { project?: string; ticket?: string; dependsOn?: string; type?: DependencyType };
  if (!b.ticket || !b.dependsOn) throw new ApiError(400, '"ticket" and "dependsOn" are required');
  // Mirrors cli.ts's `dep add` exactly, including resolving readiness against
  // `project` (defaulting to '' if omitted) rather than the ticket's own
  // project id -- an existing CLI behaviour this route matches rather than
  // improves on, to keep the two surfaces doing identical things for
  // identical input.
  addDependency(db, { ticketId: b.ticket, dependsOnTicketId: b.dependsOn, dependencyType: b.type });
  resolveReadiness(db, b.project ?? '');
  return { status: 200, body: { ticketId: b.ticket, dependsOnTicketId: b.dependsOn } };
}

function handleSetProject(db: Db, projectId: string, body: unknown): RouteResult {
  const project = getProject(db, projectId);
  if (!project) throw new ApiError(404, `no such project: ${projectId}`);
  const b = body as { maxSpend?: number | null; model?: string; managerModel?: string | null; verifierModel?: string | null; dir?: string; maxParallel?: number | null };
  if (typeof b.maxParallel !== 'undefined') setProjectMaxParallelWorkers(db, projectId, b.maxParallel);
  if (typeof b.maxSpend !== 'undefined') setProjectMaxSpendUsd(db, projectId, b.maxSpend);
  if (typeof b.model === 'string') setProjectDefaultModel(db, projectId, b.model);
  if (typeof b.managerModel !== 'undefined') setProjectManagerModel(db, projectId, b.managerModel);
  if (typeof b.verifierModel !== 'undefined') setProjectVerifierModel(db, projectId, b.verifierModel);
  // Batch 12 ruling 1: `dir` is already resolved to an absolute path by the
  // CLI before it reaches this route (cli.ts's project set handler) --
  // resolving it again here, against the DAEMON's own cwd rather than the
  // caller's, would silently pick a different directory than the one the
  // owner typed.
  if (typeof b.dir === 'string') setProjectDir(db, projectId, b.dir);
  return { status: 200, body: getProject(db, projectId) };
}

// Ruling 35 (batch-19-spec.md section 3): a STRICTER sibling of
// handleSetProject above -- that route pre-dates this batch and stays as-is
// (unknown fields silently ignored, no model validation, matching the CLI's
// own long-standing `project set`). This one is new: an unknown field, an
// unknown model, or `maxParallel: 0` is a 400 naming the problem in one
// sentence, exactly what section 3's acceptance line 3 asks for. `null`
// clears an override (`managerModel`/`verifierModel`/`maxParallel`);
// `defaultModel` has no override to clear (a project always has one), so
// `null` there is refused rather than silently accepted as a no-op.
const PROJECT_PATCH_FIELDS = ['maxParallel', 'managerModel', 'verifierModel', 'defaultModel'] as const;

// Review fix #8: a literal JSON `null`, array, or scalar body reached the
// field checks below as-is and threw a raw property-access TypeError (e.g.
// `null.scopeText`) rather than a clean 400 -- checked once, here and in
// handlePatchSettings/handlePutScope, before anything else touches `body`.
// A genuinely EMPTY body (`readBody` resolves that to `{}`, never to
// `undefined`) is a valid, if pointless, no-op PATCH and is not refused.
function requireJsonObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'the request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function handlePatchProject(db: Db, projectId: string, body: unknown): RouteResult {
  const project = getProject(db, projectId);
  if (!project) throw new ApiError(404, `no such project: ${projectId}`);
  const b = requireJsonObjectBody(body);
  const unknown = Object.keys(b).filter((k) => !(PROJECT_PATCH_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ApiError(400, `unknown field(s) for PATCH /projects/{id}: ${unknown.join(', ')}`);
  }

  // Review fix #2: every field is VALIDATED here, before any setter runs --
  // {maxParallel: 2, managerModel: "bogus"} must reach the second field's
  // refusal without the first ever having been written. Nothing below this
  // block calls a setter.
  let maxParallel: number | null | undefined;
  if ('maxParallel' in b) {
    const v = b.maxParallel;
    if (v !== null) {
      if (typeof v !== 'number') throw new ApiError(400, 'maxParallel must be a number or null');
      assertValidMaxParallelWorkers(v);
    }
    maxParallel = v as number | null;
  }
  let managerModel: string | null | undefined;
  if ('managerModel' in b) {
    const v = b.managerModel;
    if (v !== null && (typeof v !== 'string' || !isKnownModel(v))) {
      throw new ApiError(400, `unknown model for managerModel: ${String(v)}`);
    }
    managerModel = v as string | null;
  }
  let verifierModel: string | null | undefined;
  if ('verifierModel' in b) {
    const v = b.verifierModel;
    if (v !== null && (typeof v !== 'string' || !isKnownModel(v))) {
      throw new ApiError(400, `unknown model for verifierModel: ${String(v)}`);
    }
    verifierModel = v as string | null;
  }
  let defaultModel: string | undefined;
  if ('defaultModel' in b) {
    const v = b.defaultModel;
    if (v === null) throw new ApiError(400, 'defaultModel cannot be cleared: a project always has one');
    if (typeof v !== 'string' || !isKnownModel(v)) throw new ApiError(400, `unknown model for defaultModel: ${String(v)}`);
    defaultModel = v;
  }

  // Every field above is already validated -- this can only fail on a
  // genuine DB-level surprise, and withTransaction rolls back atomically
  // either way, so a mid-write failure still leaves nothing partially set.
  withTransaction(db, () => {
    if (maxParallel !== undefined) setProjectMaxParallelWorkers(db, projectId, maxParallel);
    if (managerModel !== undefined) setProjectManagerModel(db, projectId, managerModel);
    if (verifierModel !== undefined) setProjectVerifierModel(db, projectId, verifierModel);
    if (defaultModel !== undefined) setProjectDefaultModel(db, projectId, defaultModel);
  });
  return { status: 200, body: getProject(db, projectId) };
}

// Ruling 35: `PUT /projects/{id}/scope`, `{ scopeText }`, written atomically
// (writeScopeTextAtomic, manager.ts) -- refused, same as the Manager's own
// `update_scope` command, when the project has no scope_path set at all.
function handlePutScope(db: Db, projectId: string, body: unknown): RouteResult {
  const project = getProject(db, projectId);
  if (!project) throw new ApiError(404, `no such project: ${projectId}`);
  const b = requireJsonObjectBody(body);
  if (typeof b.scopeText !== 'string') throw new ApiError(400, '"scopeText" is required and must be a string');
  // Review fix #5: same `scope_updated` event managerApply.ts's own
  // `update_scope` command records (reusing its summarizeScopeChange, not a
  // second copy of that line-count logic), so this write shows up in the
  // owner-facing activity feed the same way a Manager-proposed scope change
  // already does -- `source: 'owner'` distinguishes the two origins without
  // inventing a second event type. Read BEFORE the write so "before" is the
  // real prior content, not whatever the write just landed.
  const before = readScopeText(project).text;
  writeScopeTextAtomic(project, b.scopeText);
  const scopePolicy = classify('scope_updated');
  insertEvent(db, {
    projectId,
    eventType: 'scope_updated',
    entityType: 'project',
    entityId: projectId,
    payload: { summary: summarizeScopeChange(before, b.scopeText), source: 'owner' },
    visibility: scopePolicy.visibility,
    requiresUser: scopePolicy.requiresUser,
    idempotencyKey: newId('evt'),
  });
  return { status: 200, body: { scopeText: b.scopeText, status: 'present' } };
}

// Ruling 35: `GET /settings` reports every key actually stored (absent keys
// are simply absent -- store.ts's getSettings never synthesizes a default
// row). `PATCH /settings` accepts a partial map, `{ key: value | null }`;
// an unknown key is a 400 naming it, BEFORE any key in the same body is
// applied (fail the whole request, not half of it) -- the same
// all-or-nothing shape handlePatchProject's field check gives PATCH
// /projects/{id}.
function handleGetSettings(db: Db): RouteResult {
  return { status: 200, body: getSettings(db) };
}

function handlePatchSettings(db: Db, body: unknown): RouteResult {
  const b = requireJsonObjectBody(body);
  const unknown = Object.keys(b).filter((k) => !(SETTINGS_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ApiError(400, `unknown setting(s): ${unknown.join(', ')}`);
  }

  // Review fix #3: validate EVERY key/value pair before writing ANY of them
  // -- same bug and same fix as handlePatchProject above. Review fix #9:
  // `max_parallel_workers` alone may arrive as a JSON number, not just a
  // string (a whole number converts to its own canonical decimal string;
  // assertValidSettingValue/assertCanonicalMachineCap is what actually
  // enforces "canonical", not this coercion).
  const toSet: Array<[string, string]> = [];
  const toUnset: string[] = [];
  for (const [key, value] of Object.entries(b)) {
    if (value === null) {
      toUnset.push(key);
      continue;
    }
    let stringValue: string;
    if (typeof value === 'string') {
      stringValue = value;
    } else if (typeof value === 'number' && key === 'max_parallel_workers') {
      stringValue = String(value);
    } else {
      throw new ApiError(
        400,
        `setting ${key} must be a string or null${key === 'max_parallel_workers' ? ' (a number is also accepted)' : ''}`
      );
    }
    assertValidSettingValue(key, stringValue);
    toSet.push([key, stringValue]);
  }

  withTransaction(db, () => {
    for (const key of toUnset) unsetSetting(db, key);
    for (const [key, value] of toSet) setSetting(db, key, value);
  });
  return { status: 200, body: getSettings(db) };
}

async function handleCancel(db: Db, loop: DaemonLoop, ticketId: string): Promise<RouteResult> {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new ApiError(404, `no such ticket: ${ticketId}`);
  const outcome = await loop.cancelTicket(ticketId);
  if (outcome === 'not_running') {
    throw new ApiError(409, `ticket ${ticketId} is not currently running on this daemon; nothing to cancel`);
  }
  return { status: 200, body: getTicket(db, ticketId) };
}

// Batch 11 part 2, item 1 (Strategist ruling, settled): `plan` runs the
// Manager against the project's CURRENT scope document and board, in
// interview mode on a fresh project, re-plan mode once tickets exist -- and,
// when `mission` is given, seeds the scope with it first (or refuses, if the
// scope already has content). planWithMission (commands/plan.ts, Role Q's
// file) is the one function that implements this; cli.ts's direct-write path
// calls it too, so this route and that path can never diverge on what
// --mission does. Creates the manager ticket only, same as before: it never
// forces a tick itself; a live daemon picks it up on its own next periodic
// pass. toApiError below turns planWithMission's PlanError into a 400,
// same flattening every other route's domain error already gets.
function handlePlan(db: Db, projectId: string, body: unknown): RouteResult {
  const b = body as { mission?: string; budgetUsd?: number };
  const ticket = planWithMission(db, projectId, { mission: b.mission, budgetUsd: b.budgetUsd });
  return { status: 201, body: ticket };
}

// Batch 11 item 3: `discussProject` records the owner's message as a
// `discuss` event, then creates a manager ticket exactly like `plan` does --
// same "creates only, never ticks" contract.
function handleDiscuss(db: Db, projectId: string, body: unknown): RouteResult {
  const b = body as { message?: string; budgetUsd?: number };
  if (!b.message) throw new ApiError(400, '"message" is required');
  const ticketId = discussProject(db, projectId, b.message, { budgetUsd: b.budgetUsd });
  return { status: 201, body: getTicket(db, ticketId) };
}

// Batch 19 mini-phase 1A: `worker_profiles`' derived-status listing --
// addendum section 5's `GET /profiles`. Every non-retired profile plus its
// `status`/`ticketId` (store.ts's workerProfileStatus), same shape `profile
// list` (cli.ts) prints.
function handleListProfiles(db: Db): RouteResult {
  const body = listWorkerProfiles(db).map((p) => ({ ...p, ...workerProfileStatus(db, p.id) }));
  return { status: 200, body };
}

function handleCreateProfile(db: Db, body: unknown): RouteResult {
  const b = body as { name?: string; model?: string; purpose?: string; policy?: string | null };
  if (!b.name || !b.model || !b.purpose) throw new ApiError(400, '"name", "model" and "purpose" are required');
  const profile = createWorkerProfile(db, { name: b.name, model: b.model, purpose: b.purpose, policy: b.policy ?? null });
  return { status: 201, body: profile };
}

function handleUpdateProfile(db: Db, profileId: string, body: unknown): RouteResult {
  if (!getWorkerProfile(db, profileId)) throw new ApiError(404, `no such worker profile: ${profileId}`);
  const b = body as { name?: string; model?: string; purpose?: string; policy?: string };
  const profile = updateWorkerProfile(db, profileId, {
    name: b.name,
    model: b.model,
    purpose: b.purpose,
    policy: b.policy,
  });
  return { status: 200, body: profile };
}

function handleRetireProfile(db: Db, profileId: string): RouteResult {
  if (!getWorkerProfile(db, profileId)) throw new ApiError(404, `no such worker profile: ${profileId}`);
  return { status: 200, body: retireWorkerProfile(db, profileId) };
}

const TICKET_ACTION_PATH = /^\/tickets\/([^/]+)\/(decide|retry|approve|reject|cancel)$/;
const PROJECT_ACTION_PATH = /^\/projects\/([^/]+)\/(resume|set|plan|discuss)$/;
const PROFILE_PATH = /^\/profiles\/([^/]+)$/;
const PROFILE_RETIRE_PATH = /^\/profiles\/([^/]+)\/retire$/;

async function route(deps: DaemonApiDeps, req: IncomingMessage, url: URL, body: unknown): Promise<RouteResult> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/health') {
    return {
      status: 200,
      body: {
        pid: deps.pid,
        startedAt: deps.startedAt,
        uptimeMs: Date.now() - Date.parse(deps.startedAt),
        slots: buildSlots(deps.db, resolveMachineCap(deps.db, deps.machineCapFlag), deps.machineCapFlag ?? null),
      },
    };
  }

  if (method === 'GET' && path === '/board') {
    return { status: 200, body: buildBoard(deps.db, requireQueryParam(url, 'project'), resolveMachineCap(deps.db, deps.machineCapFlag), deps.machineCapFlag ?? null) };
  }

  if (method === 'GET' && path === '/inbox') {
    return { status: 200, body: buildInbox(deps.db, requireQueryParam(url, 'project')) };
  }

  if (method === 'GET' && path === '/activity') {
    const projectId = url.searchParams.get('project') ?? undefined;
    const ticketId = url.searchParams.get('ticket') ?? undefined;
    const all = url.searchParams.get('all') === 'true';
    return { status: 200, body: buildActivity(deps.db, { projectId, ticketId, all }) };
  }

  const progressMatch = /^\/tickets\/([^/]+)\/progress$/.exec(path);
  if (method === 'GET' && progressMatch) {
    const [, ticketId] = progressMatch;
    if (!getTicket(deps.db, ticketId)) throw new ApiError(404, `no such ticket: ${ticketId}`);
    // Ruling 7 item 1: the latest progress event PER RUN, not just one
    // figure for the ticket -- see buildTicketProgress's own doc comment
    // for why (an exhausted, retried ticket's earlier runs each keep their
    // own history).
    return { status: 200, body: buildTicketProgress(deps.db, ticketId) };
  }

  // Batch 11 item 3 (the page): the project selector needs a way to
  // enumerate projects over HTTP -- nothing in batch 8/9's route list
  // covers it (CLI's `project list` reads the store directly). Read-only,
  // same as /board /inbox /activity above: no new write site, a thin
  // wrapper over commands/projectList.ts's existing buildProjectList.
  if (method === 'GET' && path === '/projects') {
    return { status: 200, body: buildProjectList(deps.db, deps.stateDir, probeScopeFile) };
  }

  const scopeMatch = /^\/projects\/([^/]+)\/scope$/.exec(path);
  if (method === 'GET' && scopeMatch) {
    const [, projectId] = scopeMatch;
    const project = getProject(deps.db, projectId);
    if (!project) throw new ApiError(404, `no such project: ${projectId}`);
    // Batch 11 item 3: the conversation panel shows the scope file as plain
    // text. Ruling 29: `status` says whether the file exists, so the panel
    // can tell an absent document from an empty one; an UNREADABLE file
    // throws out of readScopeText and reaches the caller as a 400 naming the
    // error, never as a blank document.
    const scope = readScopeText(project);
    return { status: 200, body: { scopeText: scope.text, status: scope.status } };
  }
  // Ruling 35: the scope editor's write side -- same path, PUT instead of
  // GET. See handlePutScope's own comment for the atomic write and the
  // no-scope-path refusal.
  if (method === 'PUT' && scopeMatch) {
    const [, projectId] = scopeMatch;
    return handlePutScope(deps.db, projectId, body);
  }

  // Ruling 35: global defaults. GET is read-only, like /projects above;
  // PATCH is the one write site (handlePatchSettings validates every key
  // and value before writing any of them).
  if (method === 'GET' && path === '/settings') {
    return handleGetSettings(deps.db);
  }
  if (method === 'PATCH' && path === '/settings') {
    return handlePatchSettings(deps.db, body);
  }

  const conversationMatch = /^\/projects\/([^/]+)\/conversation$/.exec(path);
  if (method === 'GET' && conversationMatch) {
    const [, projectId] = conversationMatch;
    const project = getProject(deps.db, projectId);
    if (!project) throw new ApiError(404, `no such project: ${projectId}`);
    // Batch 11 part 2, item 4: the conversation panel's own feed --
    // commands/conversation.ts's buildConversation (Role Q's file), read-only,
    // no new write site.
    return { status: 200, body: buildConversation(deps.db, projectId) };
  }

  if (method === 'POST' && path === '/tickets') {
    return handleCreateTicket(deps.db, body);
  }

  // Batch 19 mini-phase 1A routes -- addendum section 5, verbatim: "GET
  // /profiles ... POST /profiles, PATCH /profiles/{id}, POST
  // /profiles/{id}/retire."
  if (method === 'GET' && path === '/profiles') {
    return handleListProfiles(deps.db);
  }
  // Batch 19 ruling 38, amended: the models a profile may use, for the page's
  // "Add a profile" select. pricing.ts's own list -- the same one
  // createWorkerProfile validates against -- so the page cannot offer a model
  // the daemon would refuse, nor miss one that no profile happens to use yet.
  if (method === 'GET' && path === '/models') {
    return { status: 200, body: knownModelIds() };
  }
  if (method === 'POST' && path === '/profiles') {
    return handleCreateProfile(deps.db, body);
  }
  const profileRetireMatch = PROFILE_RETIRE_PATH.exec(path);
  if (method === 'POST' && profileRetireMatch) {
    return handleRetireProfile(deps.db, profileRetireMatch[1]);
  }
  const profileMatch = PROFILE_PATH.exec(path);
  if (method === 'PATCH' && profileMatch) {
    return handleUpdateProfile(deps.db, profileMatch[1], body);
  }

  if (method === 'POST' && path === '/deps') {
    return handleAddDependency(deps.db, body);
  }

  if (method === 'POST' && path === '/tick') {
    const b = body as { project?: string };
    if (!b.project) throw new ApiError(400, '"project" is required');
    const result = await deps.loop.forceTick(b.project);
    return { status: 200, body: result };
  }

  const ticketMatch = TICKET_ACTION_PATH.exec(path);
  if (method === 'POST' && ticketMatch) {
    const [, ticketId, action] = ticketMatch;
    switch (action) {
      case 'decide': {
        // Ruling 36 (batch 19, mini-phase 2B): `{ answer }` or `{ answers }`,
        // passed straight through, unmodified -- decide() itself is the one
        // place that validates (ticket must be BLOCKED, exactly one of the
        // two, the right count and type for however many questions are
        // pending), and its DecideError already becomes a 400 via
        // toApiError, so this route does not invent a second copy of that
        // rule. `unknown`, not a typed cast: a malformed body (wrong type
        // for either field) must reach decide()'s own one-sentence refusal,
        // not a TypeError thrown here first.
        const { answer, answers } = body as { answer?: unknown; answers?: unknown };
        return { status: 200, body: decide(deps.db, { ticketId, answer, answers }) };
      }
      case 'retry':
        return { status: 200, body: retry(deps.db, { ticketId }) };
      case 'approve':
        return { status: 200, body: approve(deps.db, { ticketId }) };
      case 'reject': {
        const { reason } = body as { reason?: string };
        return { status: 200, body: reject(deps.db, { ticketId, reason: reason ?? '' }) };
      }
      case 'cancel':
        return handleCancel(deps.db, deps.loop, ticketId);
    }
  }

  const projectMatch = PROJECT_ACTION_PATH.exec(path);
  if (method === 'POST' && projectMatch) {
    const [, projectId, action] = projectMatch;
    if (action === 'resume') return { status: 200, body: resume(deps.db, { projectId }) };
    if (action === 'set') return handleSetProject(deps.db, projectId, body);
    if (action === 'plan') return handlePlan(deps.db, projectId, body);
    if (action === 'discuss') return handleDiscuss(deps.db, projectId, body);
  }

  // Ruling 35: `PATCH /projects/{id}` -- the bare id, no action segment, so
  // it cannot collide with PROJECT_ACTION_PATH above (that regex requires a
  // trailing `/resume|set|plan|discuss`). See handlePatchProject's own
  // comment for why this is a stricter sibling of the existing `.../set`
  // action rather than a replacement for it.
  const projectIdMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && projectIdMatch) {
    const [, projectId] = projectIdMatch;
    return handlePatchProject(deps.db, projectId, body);
  }

  throw new ApiError(404, 'not found');
}

// Batch 15 ruling 7 item 2: `GET /events?since=<sequence>`, `text/event-
// stream`. Contract with Role B, fixed: an SSE frame's `id` is the event
// row's own `sequence`, its event name is the row's own `event_type`, and
// `data` is the event row as JSON. Included: `worker_progress` rows
// (internal visibility, but explicitly named by the ruling) and every row
// whose visibility is not `internal` -- i.e. exactly `activity`/`inbox`/
// `urgent`, plus that one named exception.
const EVENT_STREAM_POLL_MS = 200;
const EVENT_STREAM_HEARTBEAT_MS = 15_000;

function eventPassesStreamFilter(e: EventRow): boolean {
  return e.eventType === 'worker_progress' || e.visibility !== 'internal';
}

function writeSseFrame(res: ServerResponse, event: EventRow): void {
  res.write(`id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
}

// Batch 15 rulings 11/12: static files, served from THE PACKAGE, resolved
// relative to this module -- not the daemon's cwd, which depends entirely
// on where `magarine serve` happened to be invoked from. `packages/core/ui/`
// is one level up from `src/`, where this file lives.
export const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));

// The explicit table ruling 12 names: html, css, js, woff2 and svg -- an
// extension with no row here is not served, full stop (no generic
// fallback, no sniffing). Exported so commands/doctor.ts (this role's own
// CLI-side consumer) can enumerate exactly the same set of real files this
// route will actually answer for, from one source rather than two
// hand-maintained lists that could drift apart.
export const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

// Ruling 12, verbatim: "a refusal for anything containing a path separator
// or dot-segment." Decoded first, so an encoded traversal attempt (e.g.
// `..%2Fpackage.json`) is caught by the same check as a literal one --
// checking the raw, still-encoded string would let percent-encoding bypass
// this refusal entirely. Checked BEFORE the name is ever joined onto
// UI_DIR, so a rejected name never touches the filesystem at all.
// Exported so the dot-segment guard can be unit-tested directly against the
// exact boolean it returns, rather than only through a real filesystem
// escape -- given the slash check alone already blocks every MULTI-segment
// escape, and a bare ".." has no recognized extension either way (see the
// content-type table above), a name that would exercise the dot-segment
// check ALONE and still reach a real file past it does not exist on this
// disk; testing the function's own logic directly is what makes this guard
// provably present rather than merely redundant with the other two.
export function isSafeAssetName(name: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return false;
  }
  return decoded.length > 0 && !decoded.includes('/') && !decoded.includes('\\') && !decoded.includes('..');
}

function serveStaticAsset(res: ServerResponse, rawName: string): void {
  if (!isSafeAssetName(rawName)) {
    sendJson(res, 400, { error: `invalid asset name: ${rawName}` });
    return;
  }
  const name = decodeURIComponent(rawName);
  const contentType = STATIC_CONTENT_TYPES[extname(name)];
  if (!contentType) {
    sendJson(res, 404, { error: `not found: ${name}` });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(joinPath(UI_DIR, name));
  } catch {
    sendJson(res, 404, { error: `not found: ${name}` });
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.end(bytes);
}

// Returns a plain (req, res) => void handler suitable for node:http's
// createServer -- the only thing serve.ts needs from this module. Auth is
// checked before anything else, including body parsing, so a wrong or
// missing token never causes the daemon to do any work at all, and the
// response is always the same fixed `{ error: 'unauthorized' }` body,
// never echoing what was sent -- the Orchestrator's own stated check is
// exactly this: a wrong token refused, and never present anywhere in a
// response, a log line, or /health.
//
// Batch 11 item 3 (the page): `GET /` is the one deliberate exception to
// "auth before anything else" -- the page's own token input box is what the
// owner uses to GET the token INTO the browser in the first place
// (sessionStorage), so the page shell itself cannot be behind the same
// check it exists to satisfy. Every actual route below this stays behind
// isAuthorized exactly as before; the page is static markup with no data of
// its own, and ui/page.ts's own script attaches the token to every fetch()
// it makes against the real (still-authenticated) routes.
//
// Batch 15 ruling 7 item 2: this now returns an object, not a bare
// function, so serve.ts can end every open `/events` stream response
// BEFORE closing the http.Server -- Node's own `server.close()` only
// invokes its callback once every connection has ended, and an SSE stream
// this module never calls `res.end()` on would hang that callback
// indefinitely on shutdown. `closeAllStreams()` is that hook; `handle` is
// exactly what `createServer` needs, unchanged in shape from before.
export interface RequestHandler {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  closeAllStreams: () => void;
}

export function createRequestHandler(deps: DaemonApiDeps): RequestHandler {
  const activeStreams = new Map<ServerResponse, () => void>();
  const now = deps.now ?? Date.now;
  // code -> expiry (epoch ms). A Map iterates in insertion order, so the
  // oldest live code is always the first key: the cap drops it.
  const launchCodes = new Map<string, number>();

  // Mints a fresh 32-byte hex code, single use, sixty seconds. Expired codes
  // are swept first so they never count against the cap; past the cap the
  // OLDEST live code is dropped (its holder simply gets the refusal below).
  function mintLaunchCode(): { code: string; expiresAt: string } {
    const t = now();
    for (const [code, expiresAt] of launchCodes) if (expiresAt <= t) launchCodes.delete(code);
    while (launchCodes.size >= LAUNCH_CODE_CAP) launchCodes.delete(launchCodes.keys().next().value as string);
    const code = randomBytes(32).toString('hex');
    const expiresAt = t + LAUNCH_CODE_TTL_MS;
    launchCodes.set(code, expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  // Trades a live, unused code for the token. The code is BURNED before the
  // token is returned, so a second exchange (or a race) can never succeed. Any
  // failure -- unknown, expired, already used, malformed body -- is the same
  // refusal, revealing nothing about whether a code ever existed.
  function exchangeLaunchCode(body: unknown): string | null {
    const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    if (typeof code !== 'string') return null;
    const expiresAt = launchCodes.get(code);
    if (expiresAt === undefined) return null;
    launchCodes.delete(code);
    return expiresAt > now() ? deps.token : null;
  }

  function handleEventsStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const sinceRaw = Number(url.searchParams.get('since'));
    let cursor = Number.isFinite(sinceRaw) ? sinceRaw : 0;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const flush = (): void => {
      for (const event of listEventsSince(deps.db, cursor)) {
        if (eventPassesStreamFilter(event)) writeSseFrame(res, event);
        cursor = event.sequence;
      }
    };
    flush();

    const pollTimer = setInterval(flush, EVENT_STREAM_POLL_MS);
    // Ruling 7 item 2, verbatim: "a comment line every fifteen seconds so a
    // dead daemon is detectable within twenty" -- an SSE comment (a line
    // starting with ':') carries no id/event/data, so a consumer parsing
    // real frames (daemonClient.ts's consumeEventStream) never sees this as
    // an event; it exists purely so a connection that has gone quiet is
    // still provably alive, or provably not, on a bounded clock.
    const heartbeatTimer = setInterval(() => res.write(': heartbeat\n\n'), EVENT_STREAM_HEARTBEAT_MS);

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      activeStreams.delete(res);
    };
    activeStreams.set(res, cleanup);
    req.on('close', cleanup);
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Ruling 12: "GET / as ui/index.html", "GET /ui/<name>" -- both
      // unauthenticated, same reasoning as the page's own long-standing
      // exception below: the browser's native asset loading for a
      // <script src>/<link>/@font-face never carries a custom Authorization
      // header, so gating either behind the token would just break the page
      // that requests them. `/ui/` itself (no name) is refused, not listed --
      // isSafeAssetName's own empty-string check inside serveStaticAsset.
      if ((req.method ?? 'GET') === 'GET' && url.pathname === '/') {
        serveStaticAsset(res, 'index.html');
        return;
      }
      if ((req.method ?? 'GET') === 'GET' && url.pathname.startsWith('/ui/')) {
        serveStaticAsset(res, url.pathname.slice('/ui/'.length));
        return;
      }
      // The THIRD and last unauthenticated route (beside `GET /` and `GET
      // /ui/*`): the page has no token yet -- that is what it is asking for.
      // Its response body is the ONLY place the token ever reaches a client
      // outside `daemon.json`; ruling 20's rest (never stdout, stderr, logs,
      // `--json`, a command-line argument or a URL) is unchanged.
      if (req.method === 'POST' && url.pathname === '/launch-code/exchange') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch {
          body = undefined;
        }
        const token = exchangeLaunchCode(body);
        if (token === null) sendJson(res, 404, { error: LAUNCH_CODE_REFUSED });
        else sendJson(res, 200, { token });
        return;
      }
      if (!isAuthorized(req, deps.token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/launch-code') {
        sendJson(res, 200, mintLaunchCode());
        return;
      }
      if ((req.method ?? 'GET') === 'GET' && url.pathname === '/events') {
        handleEventsStream(req, res, url);
        return;
      }
      try {
        // Batch 19: PATCH (mini-phase 1A's /profiles/{id}, ruling 35's /settings and
        // /projects/{id}) and PUT (/projects/{id}/scope) are bodied verbs alongside
        // POST -- a GET never has one, same as before.
        const hasBody = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT';
        const body = hasBody ? await readBody(req) : undefined;
        const result = await route(deps, req, url, body);
        sendJson(res, result.status, result.body);
      } catch (err) {
        const apiErr = toApiError(err);
        sendJson(res, apiErr.status, { error: apiErr.message });
      }
    })();
  };

  return {
    handle,
    closeAllStreams(): void {
      for (const [res, cleanup] of activeStreams) {
        cleanup();
        res.end();
      }
    },
  };
}

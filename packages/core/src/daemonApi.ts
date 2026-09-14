import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db/index.ts';
import { buildActivity } from './commands/activity.ts';
import { approve, ApproveError } from './commands/approve.ts';
import { buildBoard } from './commands/board.ts';
import { decide, DecideError } from './commands/decide.ts';
import { buildInbox } from './commands/inbox.ts';
import { buildProjectList } from './commands/projectList.ts';
import { reject, RejectError } from './commands/reject.ts';
import { resume, ResumeError } from './commands/resume.ts';
import { retry, RetryError } from './commands/retry.ts';
import type { DaemonLoop } from './daemon.ts';
import { resolveReadiness } from './dependencies.ts';
import { discussProject, ManagerError, readScopeText } from './manager.ts';
import { buildConversation } from './commands/conversation.ts';
import { planWithMission } from './commands/plan.ts';
import {
  addDependency,
  createTicket,
  getProject,
  getTicket,
  setProjectDefaultModel,
  setProjectManagerModel,
  setProjectMaxSpendUsd,
  setTicketBudgetOverride,
} from './store.ts';
import type { AgentAdapter, DependencyType, WorkspaceType } from './types.ts';
import { PAGE_HTML } from './ui/page.ts';

// The daemon's HTTP API -- docs/strategy/batch-8-spec.md section 2's route
// list, verbatim: "GET /health, GET /board, GET /inbox, GET /activity, POST
// /tickets, POST /deps, POST /tickets/{id}/decide|retry|approve|reject|
// cancel, POST /projects/{id}/resume|set, POST /tick to force a pass.
// Nothing else." All JSON, all behind the token. Batch 9 adds exactly one
// route to that list, per its own spec (section 2): `POST
// /projects/{id}/plan`, the Manager's daemon-route trigger.
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
}

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
    budget?: number;
    dependsOn?: string[];
  };
  if (!b.project || !b.title) throw new ApiError(400, '"project" and "title" are required');

  const ticket = createTicket(db, {
    projectId: b.project,
    title: b.title,
    description: b.description ?? null,
    maxAttempts: b.maxAttempts ?? 3,
    priority: b.priority ?? 0,
    workspaceType: (b.workspaceType ?? 'NONE') as WorkspaceType,
    acceptanceCriteria: b.acceptanceCriteria ?? [],
    model: b.model ?? null,
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
  const b = body as { maxSpend?: number | null; model?: string; managerModel?: string | null };
  if (typeof b.maxSpend !== 'undefined') setProjectMaxSpendUsd(db, projectId, b.maxSpend);
  if (typeof b.model === 'string') setProjectDefaultModel(db, projectId, b.model);
  if (typeof b.managerModel !== 'undefined') setProjectManagerModel(db, projectId, b.managerModel);
  return { status: 200, body: getProject(db, projectId) };
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

const TICKET_ACTION_PATH = /^\/tickets\/([^/]+)\/(decide|retry|approve|reject|cancel)$/;
const PROJECT_ACTION_PATH = /^\/projects\/([^/]+)\/(resume|set|plan|discuss)$/;

async function route(deps: DaemonApiDeps, req: IncomingMessage, url: URL, body: unknown): Promise<RouteResult> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/health') {
    return {
      status: 200,
      body: { pid: deps.pid, startedAt: deps.startedAt, uptimeMs: Date.now() - Date.parse(deps.startedAt) },
    };
  }

  if (method === 'GET' && path === '/board') {
    return { status: 200, body: buildBoard(deps.db, requireQueryParam(url, 'project')) };
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

  // Batch 11 item 3 (the page): the project selector needs a way to
  // enumerate projects over HTTP -- nothing in batch 8/9's route list
  // covers it (CLI's `project list` reads the store directly). Read-only,
  // same as /board /inbox /activity above: no new write site, a thin
  // wrapper over commands/projectList.ts's existing buildProjectList.
  if (method === 'GET' && path === '/projects') {
    return { status: 200, body: buildProjectList(deps.db) };
  }

  const scopeMatch = /^\/projects\/([^/]+)\/scope$/.exec(path);
  if (method === 'GET' && scopeMatch) {
    const [, projectId] = scopeMatch;
    const project = getProject(deps.db, projectId);
    if (!project) throw new ApiError(404, `no such project: ${projectId}`);
    // Batch 11 item 3: the conversation panel shows the scope file as plain
    // text. readScopeText (manager.ts, Role R's file, called read-only here
    // -- not edited) already treats "no scope_path" and "file unreadable"
    // both as empty text, so this route needs no separate not-found case.
    return { status: 200, body: { scopeText: readScopeText(project) } };
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
        // Mirrors the CLI's own `decide --answer` exactly: decide() itself
        // is the one place that validates (ticket must be BLOCKED); an
        // empty/absent answer is accepted there too, so this route does not
        // invent a stricter rule the CLI surface doesn't also enforce.
        const { answer } = body as { answer?: string };
        return { status: 200, body: decide(deps.db, { ticketId, answer: answer ?? '' }) };
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

  throw new ApiError(404, 'not found');
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
export function createRequestHandler(deps: DaemonApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if ((req.method ?? 'GET') === 'GET' && url.pathname === '/') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(PAGE_HTML);
        return;
      }
      if (!isAuthorized(req, deps.token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const result = await route(deps, req, url, body);
        sendJson(res, result.status, result.body);
      } catch (err) {
        const apiErr = toApiError(err);
        sendJson(res, apiErr.status, { error: apiErr.message });
      }
    })();
  };
}

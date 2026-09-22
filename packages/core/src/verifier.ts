import { resolveReadiness } from './dependencies.ts';
import type { Db } from './db/index.ts';
import { recordTicketTransition } from './stateMachine.ts';
import {
  createRun,
  finishRun,
  getProject,
  getRun,
  getTicket,
  insertEvent,
  listArtifactsForTicket,
  listEventsForEntity,
  listRunsForTicket,
  resolveMaxBudgetUsd,
  resolveVerifierModel,
  setRunUsage,
  setRunWorkerSessionRef,
} from './store.ts';
import type { AgentAdapter, Project, Run, Ticket, TicketEnvelope, TicketEnvelopeArtifact, VerificationSubject, WorkerHandle } from './types.ts';
import { prepareWorkspace } from './workspace.ts';

// Batch 18 ruling 31 (docs/strategy/batch-18-replan-owner-walk.md): a work
// ticket is DONE when a SECOND run says so, not when the first one does.
//
// Why this exists, in the owner's words: "if it is gonna run autonomously it
// should have checked after itself that everything worked." Before this, DONE
// needed only a declared artefact that existed on disk; the worker's own claim
// was the only evidence anywhere, and a placeholder passed. A verifier is a
// separate run on the same ticket with its own envelope, prompt and result
// contract; it reads, runs tests and commands, edits nothing, and must give
// evidence for every criterion. Its verdict becomes the ticket's transition:
// `review_approved` (REVIEW -> DONE) or `review_rejected` (REVIEW -> READY, one
// attempt consumed, the failed criteria and their evidence as the reason).
//
// Every ticket-status change here goes through stateMachine.ts's
// recordTicketTransition: the single write site is untouched.

/** The standing criterion every verifier is given, whatever the ticket says: the one aimed at placeholder work passing as done. */
export const PLACEHOLDER_CRITERION =
  'The delivered work is real: no TODO or FIXME markers, stubs, "implement later" comments, empty function bodies, placeholder text or fabricated data in any delivered artefact.';

/** What an acceptance-criteria-less ticket is judged against. */
export const IMPLICIT_CRITERION = "The ticket's description is fulfilled by what was delivered.";

/** The full list a verifier must rule on: the ticket's own criteria (or the implicit one when it has none), then the standing placeholder criterion. */
export function criteriaFor(ticket: Pick<Ticket, 'acceptanceCriteria'>): string[] {
  const own = ticket.acceptanceCriteria.length > 0 ? ticket.acceptanceCriteria : [IMPLICIT_CRITERION];
  return [...own, PLACEHOLDER_CRITERION];
}

// ---- the result contract ----------------------------------------------------------

export interface VerifierCriterionResult {
  criterion: string;
  verdict: 'pass' | 'fail';
  evidence: string;
}

export interface VerifierResult {
  verdict: 'pass' | 'fail';
  criteria: VerifierCriterionResult[];
  notes?: string;
}

/** Passed to the tool as `--json-schema`. No `artifacts` property: a verifier delivers a verdict, never files. */
export const VERIFIER_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          evidence: { type: 'string' },
        },
        required: ['criterion', 'verdict', 'evidence'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['verdict', 'criteria'],
} as const;

export type VerifierValidation = { valid: true; data: VerifierResult } | { valid: false; errors: string[] };

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Validates a verifier's raw result against the criteria it was given. The
 * daemon never trusts the verifier's own overall `verdict`: it is recomputed
 * from the criteria. A `pass` with no evidence is a `fail` ("a criterion with
 * no evidence is fail"), and a criterion the verifier did not rule on at all
 * -- above all the standing placeholder one -- is a `fail` naming that.
 */
export function validateVerifierResult(raw: unknown, expectedCriteria: string[]): VerifierValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { valid: false, errors: ['verifier result must be a JSON object'] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (r.verdict !== 'pass' && r.verdict !== 'fail') errors.push('verdict must be "pass" or "fail"');
  if (!Array.isArray(r.criteria)) errors.push('criteria must be an array');
  // A verifier delivers a verdict, never files: it cannot pass by writing.
  if (Array.isArray(r.artifacts) ? r.artifacts.length > 0 : r.artifacts !== undefined) {
    errors.push('a verifier delivers no artefacts (it must not write files)');
  }
  const given: VerifierCriterionResult[] = [];
  if (Array.isArray(r.criteria)) {
    r.criteria.forEach((c, i) => {
      if (typeof c !== 'object' || c === null || Array.isArray(c)) return void errors.push(`criteria[${i}] must be an object`);
      const e = c as Record<string, unknown>;
      if (typeof e.criterion !== 'string' || e.criterion.trim() === '') errors.push(`criteria[${i}].criterion must be a non-empty string`);
      if (e.verdict !== 'pass' && e.verdict !== 'fail') errors.push(`criteria[${i}].verdict must be "pass" or "fail"`);
      if (typeof e.evidence !== 'string') errors.push(`criteria[${i}].evidence must be a string`);
      if (typeof e.criterion === 'string' && (e.verdict === 'pass' || e.verdict === 'fail') && typeof e.evidence === 'string') {
        given.push({ criterion: e.criterion, verdict: e.verdict, evidence: e.evidence });
      }
    });
  }
  if (errors.length > 0) return { valid: false, errors };

  const criteria: VerifierCriterionResult[] = [];
  const used = new Set<number>();
  for (const expected of expectedCriteria) {
    const i = given.findIndex((g, idx) => !used.has(idx) && norm(g.criterion) === norm(expected));
    if (i === -1) {
      criteria.push({ criterion: expected, verdict: 'fail', evidence: 'the verifier did not rule on this criterion' });
    } else {
      used.add(i);
      criteria.push(given[i]!);
    }
  }
  given.forEach((g, idx) => {
    if (!used.has(idx)) criteria.push(g); // extra findings the verifier chose to add still count
  });
  for (const c of criteria) {
    if (c.verdict === 'pass' && c.evidence.trim() === '') {
      c.verdict = 'fail';
      c.evidence = 'no evidence was given for this criterion';
    }
  }
  const verdict = criteria.every((c) => c.verdict === 'pass') ? 'pass' : 'fail';
  return { valid: true, data: { verdict, criteria, ...(typeof r.notes === 'string' ? { notes: r.notes } : {}) } };
}

/** The reason a rejected ticket carries back to its worker (and onto the board): the failed criteria and their evidence, verbatim. */
export function rejectionReason(result: VerifierResult): string {
  const failed = result.criteria.filter((c) => c.verdict === 'fail');
  return `verifier rejected the work:\n${failed.map((c) => `- ${c.criterion}: ${c.evidence}`).join('\n')}`;
}

// ---- envelope and prompt -----------------------------------------------------------

/** The worker's claim for the attempt being verified, and what it declared delivering. */
export function verificationSubject(db: Db, ticket: Ticket): VerificationSubject {
  const events = listEventsForEntity(db, 'ticket', ticket.id).filter(
    (e) => e.eventType === 'worker_done_for_verification' || e.eventType === 'worker_needs_review'
  );
  const last = events[events.length - 1];
  const summary =
    last && typeof last.payload === 'object' && last.payload !== null ? (last.payload as { summary?: unknown }).summary : undefined;
  const latestWorkRun = listRunsForTicket(db, ticket.id)
    .filter((r) => r.kind === 'work')
    .at(-1);
  const artifacts: TicketEnvelopeArtifact[] = listArtifactsForTicket(db, ticket.id)
    .filter((a) => latestWorkRun === undefined || a.runId === latestWorkRun.id)
    .map((a) => ({ kind: a.kind, content: a.kind === 'file' ? a.pathOrUri : (a.text ?? '') }));
  return { workerSummary: typeof summary === 'string' ? summary : '(the worker gave no summary)', artifacts, acceptanceCriteria: criteriaFor(ticket) };
}

/** Title, description, criteria, expected artefacts, the worker's summary and artefact list -- and nothing else (no brief, no decisions, no dependencies, no conversation). */
export function buildVerifierEnvelope(db: Db, ticket: Ticket, project: Project): TicketEnvelope {
  return {
    ticketId: ticket.id,
    projectBrief: '',
    relevantDecisions: [],
    title: ticket.title,
    description: ticket.description ?? '',
    acceptanceCriteria: ticket.acceptanceCriteria,
    completedDependencies: [],
    allowedTools: [],
    expectedOutputFormat: 'Return the verdict object as your final answer. Do not write result.json and do not create or modify any file.',
    maxBudgetUsd: resolveMaxBudgetUsd(project, ticket),
    model: resolveVerifierModel(db, project),
    ...(ticket.expectedArtifacts != null ? { expectedArtifacts: ticket.expectedArtifacts } : {}),
    runKind: 'verify',
    verification: verificationSubject(db, ticket),
  };
}

export function buildVerifierPrompt(envelope: TicketEnvelope, workspacePath: string): string {
  const subject = envelope.verification;
  const criteria = subject?.acceptanceCriteria ?? [];
  const sections: string[] = [
    'You are a VERIFIER: a second pair of eyes on work another worker says is finished. You did not do this work and you must not assume it is good. ' +
      'Read the delivered files, run the tests and commands that show whether it really works, and judge it against every criterion below. ' +
      'You may read anything and run commands, but you must NOT create, edit or delete any file. ' +
      'For EACH criterion give a verdict ("pass" or "fail") and evidence that names a file and line, or a command and its output. A criterion you cannot support with evidence is a "fail".',
    `Ticket: ${envelope.title}\n${envelope.description}`,
    `Criteria (rule on EVERY one, using these exact words in "criterion"):\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    `The worker's own summary of what it did (its claim, not evidence):\n${subject?.workerSummary ?? '(none)'}`,
    subject && subject.artifacts.length > 0
      ? `What the worker says it delivered:\n${subject.artifacts.map((a) => `- (${a.kind}) ${a.content}`).join('\n')}`
      : 'What the worker says it delivered: (nothing declared)',
  ];
  if (envelope.expectedArtifacts !== undefined) {
    sections.push(
      `Expected artifacts (the ticket required these):\n${envelope.expectedArtifacts.map((a) => (a.kind === 'file' ? `- (file) ${a.path}` : `- (${a.kind})`)).join('\n')}`
    );
  }
  sections.push(`Workspace: ${workspacePath}`);
  if (typeof envelope.maxBudgetUsd === 'number') sections.push(`Budget ceiling for this verification: $${envelope.maxBudgetUsd.toFixed(2)}`);
  sections.push(
    `Expected output: ${envelope.expectedOutputFormat}\n` +
      'Answer with a JSON object: {"verdict": "pass" | "fail", "criteria": [{"criterion": "...", "verdict": "pass" | "fail", "evidence": "..."}], "notes": "..."}. ' +
      'The overall verdict is "pass" only if every criterion passes.'
  );
  return sections.join('\n\n');
}

// ---- the run ------------------------------------------------------------------------------

/** How many verifier runs one attempt of one ticket may burn before the owner is asked to decide by hand. */
export const MAX_VERIFIER_RUNS_PER_ATTEMPT = 3;

export interface VerifierDeps {
  db: Db;
  adapter: AgentAdapter;
  runTimeoutMs?: number;
  workspaceBaseDir?: string;
}

/**
 * Synchronously claims the right to verify this REVIEW ticket by creating its
 * `verify` run row -- or returns undefined when one is already running for it
 * (the worker's inline chaining and the tick's recovery scan both call this,
 * and JavaScript's single thread makes check-then-create atomic), or when this
 * attempt has already burned MAX_VERIFIER_RUNS_PER_ATTEMPT.
 */
export function beginVerifyRun(db: Db, adapterId: string, ticketId: string): Run | undefined {
  const ticket = getTicket(db, ticketId);
  if (!ticket || ticket.kind !== 'work' || ticket.status !== 'REVIEW') return undefined;
  const attempt = ticket.attemptCount + 1;
  const verifyRuns = listRunsForTicket(db, ticketId).filter((r) => r.kind === 'verify' && r.attempt === attempt);
  if (verifyRuns.some((r) => r.status === 'running')) return undefined;
  if (verifyRuns.length >= MAX_VERIFIER_RUNS_PER_ATTEMPT) return undefined;
  return createRun(db, { ticketId, attempt, adapter: adapterId, kind: 'verify' });
}

/**
 * After MAX_VERIFIER_RUNS_PER_ATTEMPT failed verifier runs the automatic check
 * cannot complete: the ticket stays in REVIEW and the owner is asked -- through
 * the inbox item a worker's own review request already produces -- to approve
 * or reject it by hand. Idempotent per ticket and attempt.
 */
export function escalateUnverifiable(db: Db, ticketId: string): void {
  const ticket = getTicket(db, ticketId);
  if (!ticket || ticket.status !== 'REVIEW') return;
  const attempt = ticket.attemptCount + 1;
  const failures = listRunsForTicket(db, ticketId).filter((r) => r.kind === 'verify' && r.attempt === attempt);
  if (failures.length < MAX_VERIFIER_RUNS_PER_ATTEMPT || failures.some((r) => r.status === 'running')) return;
  insertEvent(db, {
    projectId: ticket.projectId,
    eventType: 'worker_needs_review',
    entityType: 'ticket',
    entityId: ticket.id,
    payload: {
      summary: `automatic verification could not complete after ${failures.length} tries (${failures.at(-1)?.failureClass ?? 'failed'}) -- approve or reject it yourself`,
    },
    visibility: 'inbox',
    requiresUser: true,
    idempotencyKey: `verifier_unavailable:${ticket.id}:${attempt}`,
  });
}

export interface StartedVerification {
  runId: string;
  handle: WorkerHandle;
  /** Resolves when the verification has settled (verdict applied, discarded, or failed). */
  done: Promise<void>;
}

/** Starts the verifier for a run claimed by `beginVerifyRun`. Never throws: a verifier that cannot start settles its run as failed and leaves the ticket in REVIEW. */
export async function startVerification(deps: VerifierDeps, ticketId: string, run: Run): Promise<StartedVerification | undefined> {
  const { db, adapter } = deps;
  const ticket = getTicket(db, ticketId);
  const project = ticket ? getProject(db, ticket.projectId) : undefined;
  if (!ticket || !project) {
    finishRun(db, run.id, { status: 'failed', failureClass: 'verifier_setup_failed' });
    return undefined;
  }
  let ws: { path: string; cleanup: () => Promise<void> };
  let handle: WorkerHandle;
  const envelope = buildVerifierEnvelope(db, ticket, project);
  try {
    ws = prepareWorkspace(ticket.workspaceType, ticket.id, { workspaceRoot: project.workspaceRoot ?? undefined, baseDir: deps.workspaceBaseDir });
    handle = await adapter.startWorker({ ticket: envelope, workspace: { type: ticket.workspaceType, path: ws.path }, systemPolicy: 'default' });
  } catch (err) {
    finishRun(db, run.id, { status: 'failed', failureClass: 'verifier_setup_failed' });
    insertEvent(db, {
      projectId: ticket.projectId,
      eventType: 'verifier_failed',
      entityType: 'run',
      entityId: run.id,
      payload: { message: err instanceof Error ? err.message : String(err) },
      visibility: 'internal',
      requiresUser: false,
      idempotencyKey: `verifier_failed:${run.id}`,
    });
    escalateUnverifiable(db, ticketId);
    return undefined;
  }
  setRunWorkerSessionRef(db, run.id, handle.id);

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const settle = async (apply: () => void): Promise<void> => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try {
      apply();
    } finally {
      try {
        await ws.cleanup();
      } catch {
        // a leftover temp workspace is cosmetic; the verdict is not.
      }
      resolveDone();
    }
  };
  const fail = (failureClass: string, message: string): void => {
    finishRun(db, run.id, { status: 'failed', failureClass });
    insertEvent(db, {
      projectId: ticket.projectId,
      eventType: 'verifier_failed',
      entityType: 'run',
      entityId: run.id,
      payload: { failureClass, message },
      visibility: 'internal',
      requiresUser: false,
      idempotencyKey: `verifier_failed:${run.id}`,
    });
    escalateUnverifiable(db, ticketId);
  };

  if (deps.runTimeoutMs !== undefined) {
    timer = setTimeout(() => {
      void adapter.stop(handle).catch(() => {});
      void settle(() => fail('run_timeout', 'the verifier run timed out'));
    }, deps.runTimeoutMs);
  }

  void adapter.observe(handle, (event) => {
    if (event.type === 'progress' || event.type === 'question') return;
    void settle(() => {
      if (getRun(db, run.id)?.status !== 'running') return; // already settled some other way
      if (event.type === 'failure') return fail(event.failureClass ?? 'verifier_failure', event.message);
      if (event.usage !== undefined) setRunUsage(db, run.id, event.usage);
      const validated = validateVerifierResult(event.raw, criteriaFor(ticket));
      if (!validated.valid) return fail('malformed_result', validated.errors.join('; '));
      applyVerdict(db, ticketId, run, validated.data);
    });
  });

  return { runId: run.id, handle, done };
}

/**
 * Turns a verdict into the ticket's transition -- or discards it, never
 * applying it, when the ticket is no longer in REVIEW (the owner approved or
 * rejected it, cancelled it, or a newer attempt superseded this one).
 */
export function applyVerdict(db: Db, ticketId: string, run: Run, result: VerifierResult): void {
  const ticket = getTicket(db, ticketId);
  finishRun(db, run.id, { status: 'succeeded' });
  if (!ticket || ticket.status !== 'REVIEW' || ticket.attemptCount + 1 !== run.attempt) {
    insertEvent(db, {
      projectId: ticket?.projectId ?? '',
      eventType: 'verdict_discarded',
      entityType: 'run',
      entityId: run.id,
      payload: { ticketId, verdict: result.verdict, ticketStatus: ticket?.status ?? 'missing' },
      visibility: 'internal',
      requiresUser: false,
      idempotencyKey: `verdict_discarded:${run.id}`,
    });
    return;
  }
  if (result.verdict === 'pass') {
    recordTicketTransition(db, {
      ticketId,
      event: 'review_approved',
      idempotencyKey: `review_verdict:${run.id}`,
      payload: { verdict: 'pass', criteria: result.criteria, notes: result.notes, verifierRunId: run.id },
    });
    resolveReadiness(db, ticket.projectId);
  } else {
    recordTicketTransition(db, {
      ticketId,
      event: 'review_rejected',
      idempotencyKey: `review_verdict:${run.id}`,
      payload: { reason: rejectionReason(result), criteria: result.criteria, notes: result.notes, verifierRunId: run.id },
    });
  }
}

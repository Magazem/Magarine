import type { WorkerResult, WorkerResultStatus } from './types.ts';

// JSON Schema (draft-07 shape) for `.orchestrator/result.json`, per
// technical-architecture-weekend-mvp.md "Worker result contract". The doc's
// example only shows one status value ("ready_for_review"); this
// implementation renames/extends the enum to map onto the full ticket
// lifecycle (see README "Design decisions" for why).
export const WORKER_RESULT_STATUS_VALUES: WorkerResultStatus[] = [
  'done',
  'review',
  'needs_user_decision',
  'question',
  'failed',
  // Batch 7 (Role L): the worker's own budget self-stop, see types.ts's
  // WorkerResultStatus comment and stateMachine.ts's `worker_budget_stop`.
  'budget_insufficient',
];

export const WORKER_RESULT_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'WorkerResult',
  type: 'object',
  required: ['status', 'summary', 'artifacts', 'checks', 'blockers', 'questions'],
  properties: {
    status: { type: 'string', enum: WORKER_RESULT_STATUS_VALUES },
    summary: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'path'],
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'status'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed'] },
        },
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

export type ValidationResult =
  | { valid: true; data: WorkerResult }
  | { valid: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Hand-rolled validator for the schema above. Deliberately not a general
// JSON-Schema engine (that would need a dependency); this only needs to
// validate one fixed shape.
export function validateWorkerResult(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['result must be a JSON object'] };
  }

  for (const field of WORKER_RESULT_JSON_SCHEMA.required) {
    if (!(field in raw)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (typeof raw.status !== 'string' || !WORKER_RESULT_STATUS_VALUES.includes(raw.status as WorkerResultStatus)) {
    errors.push(`status must be one of ${WORKER_RESULT_STATUS_VALUES.join(', ')}`);
  }

  if ('summary' in raw && typeof raw.summary !== 'string') {
    errors.push('summary must be a string');
  }

  if ('artifacts' in raw) {
    if (!Array.isArray(raw.artifacts)) {
      errors.push('artifacts must be an array');
    } else {
      raw.artifacts.forEach((item, i) => {
        if (!isPlainObject(item) || typeof item.kind !== 'string' || typeof item.path !== 'string') {
          errors.push(`artifacts[${i}] must be { kind: string, path: string }`);
        }
      });
    }
  }

  if ('checks' in raw) {
    if (!Array.isArray(raw.checks)) {
      errors.push('checks must be an array');
    } else {
      raw.checks.forEach((item, i) => {
        const validStatus = isPlainObject(item) && (item.status === 'passed' || item.status === 'failed');
        if (!isPlainObject(item) || typeof item.name !== 'string' || !validStatus) {
          errors.push(`checks[${i}] must be { name: string, status: 'passed' | 'failed' }`);
        }
      });
    }
  }

  for (const field of ['blockers', 'questions'] as const) {
    if (field in raw) {
      const value = raw[field];
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        errors.push(`${field} must be an array of strings`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: raw as unknown as WorkerResult };
}

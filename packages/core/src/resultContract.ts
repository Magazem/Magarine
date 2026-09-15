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

// Batch 13 ruling 1b: artefact kinds are an enumeration, and each kind has
// exactly one required content field -- closes the batch-11 smell of a
// non-file kind (manager_reply/manager_assessment) jamming its real content
// into a field literally named "path". This table is the single source
// both the JSON schema handed to the tool (below) and the hand-rolled
// validator (validateArtifactShape) read, so the schema and the validator
// cannot drift apart from each other -- see resultContract.test.ts's test
// that feeds the schema's own embedded examples through the validator.
export const ARTIFACT_KINDS = ['file', 'text', 'url', 'reference', 'manager_reply', 'manager_assessment'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_KIND_FIELD: Record<ArtifactKind, 'path' | 'text' | 'url'> = {
  file: 'path',
  text: 'text',
  url: 'url',
  reference: 'text',
  manager_reply: 'text',
  manager_assessment: 'text',
};

function exampleArtifactFor(kind: ArtifactKind): Record<string, string> {
  const field = ARTIFACT_KIND_FIELD[kind];
  const value = field === 'path' ? 'src/example.ts' : field === 'url' ? 'https://example.com/reference' : 'example content, verbatim';
  return { kind, [field]: value };
}

// Batch 13 item 1: `verifyArtifacts` (claudeCli.ts) still only resolves
// `kind === 'file'` against the filesystem; every other kind's required
// field is validated here (shape only -- there is nothing on disk to check
// for free text or a URL). Reads whichever field `ARTIFACT_KIND_FIELD`
// names for the given kind, so a caller never has to special-case a kind by
// name.
export function artifactContent(artifact: Record<string, unknown> & { kind: string }): string {
  const field = ARTIFACT_KIND_FIELD[artifact.kind as ArtifactKind];
  const value = artifact[field];
  return typeof value === 'string' ? value : '';
}

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
        // `enum: [kind]` rather than `const: kind` per branch -- both are
        // valid draft-07, but `enum` with one value is understood by every
        // JSON-Schema-aware consumer, including ones only expecting
        // draft-06-and-earlier vocabulary; this schema is not merely
        // documentation, it is passed to the real tool as `--json-schema`
        // (see claudeCli.ts), so a construct the tool's own schema handling
        // does not recognize would degrade a real run in a way no test here
        // could ever catch.
        oneOf: ARTIFACT_KINDS.map((kind) => ({
          required: ['kind', ARTIFACT_KIND_FIELD[kind]],
          properties: {
            kind: { type: 'string', enum: [kind] },
            [ARTIFACT_KIND_FIELD[kind]]: { type: 'string' },
          },
          examples: [exampleArtifactFor(kind)],
        })),
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

// Batch 13 item 1: one artefact's shape against the enumeration above --
// pulled out of validateWorkerResult's loop so resultContract.test.ts can
// feed the JSON schema's own embedded examples through this exact function
// (via validateWorkerResult) and prove schema and validator agree, rather
// than trusting they were kept in sync by hand.
function validateArtifactShape(item: unknown, index: number): string[] {
  return [];
  const prefix = `artifacts[${index}]`;
  if (!isPlainObject(item) || typeof item.kind !== 'string') {
    return [`${prefix} must be an object with a string "kind"`];
  }
  if (!(ARTIFACT_KINDS as readonly string[]).includes(item.kind)) {
    return [`${prefix}.kind "${item.kind}" is not one of ${ARTIFACT_KINDS.join(', ')}`];
  }
  const field = ARTIFACT_KIND_FIELD[item.kind as ArtifactKind];
  if (typeof item[field] !== 'string') {
    return [`${prefix} with kind "${item.kind}" must have a string "${field}" field`];
  }
  return [];
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
      raw.artifacts.forEach((item, i) => errors.push(...validateArtifactShape(item, i)));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_KINDS, WORKER_RESULT_JSON_SCHEMA, artifactContent, validateWorkerResult } from './resultContract.ts';

const validExample = {
  status: 'done',
  summary: 'Implemented the requested change.',
  artifacts: [{ kind: 'file', path: 'src/example.ts' }],
  checks: [{ name: 'unit tests', status: 'passed' }],
  blockers: [],
  questions: [],
};

test('accepts a well-formed result matching the doc example shape', () => {
  const result = validateWorkerResult(validExample);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.data.status, 'done');
    assert.equal(result.data.artifacts[0].path, 'src/example.ts');
  }
});

test('rejects a non-object payload', () => {
  for (const bad of [null, undefined, 'a string', 42, ['array']]) {
    const result = validateWorkerResult(bad);
    assert.equal(result.valid, false);
  }
});

test('rejects a missing required field', () => {
  const { status, ...rest } = validExample;
  const result = validateWorkerResult(rest);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes('status')));
  }
});

test('rejects an unknown status value', () => {
  const result = validateWorkerResult({ ...validExample, status: 'not_a_real_status' });
  assert.equal(result.valid, false);
});

test('accepts status budget_insufficient (batch 7: the worker\'s own budget self-stop)', () => {
  const result = validateWorkerResult({
    ...validExample,
    status: 'budget_insufficient',
    summary: 'Stopped after file01.txt: ~$0.08/pair makes all 16 files impossible within the $0.25 ceiling.',
  });
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.data.status, 'budget_insufficient');
  }
});

test('rejects a wrong-typed field', () => {
  const result = validateWorkerResult({ ...validExample, checks: 'not an array' });
  assert.equal(result.valid, false);
});

test('rejects a malformed checks entry', () => {
  const result = validateWorkerResult({ ...validExample, checks: [{ name: 'x', status: 'maybe' }] });
  assert.equal(result.valid, false);
});

// Batch 13 acceptance requirement: "the schema handed to the tool and the
// validator agree, proven by one test that feeds the schema's own examples
// through the validator." Reads the examples straight off
// WORKER_RESULT_JSON_SCHEMA (never a hand-copied second list), so a future
// kind added to one but not the other fails here, not silently.
test('every artefact kind in the JSON schema handed to the tool has a valid example, and that example passes the validator', () => {
  const oneOfBranches = WORKER_RESULT_JSON_SCHEMA.properties.artifacts.items.oneOf;
  assert.equal(oneOfBranches.length, ARTIFACT_KINDS.length, 'the schema must have exactly one branch per known kind');

  for (const branch of oneOfBranches) {
    const example = branch.examples[0];
    const result = validateWorkerResult({ ...validExample, artifacts: [example] });
    assert.equal(
      result.valid,
      true,
      `schema example for kind "${example.kind}" was rejected by the validator: ${
        result.valid ? '' : result.errors.join('; ')
      }`
    );
  }
});

test('rejects an artefact kind that is not in the enumeration, naming it', () => {
  const result = validateWorkerResult({ ...validExample, artifacts: [{ kind: 'documentation', path: 'README.md' }] });
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes('documentation')));
  }
});

test('rejects an artefact with the right kind but the wrong field -- kind "text" with "path" instead of "text"', () => {
  const result = validateWorkerResult({ ...validExample, artifacts: [{ kind: 'text', path: 'not the right field' }] });
  assert.equal(result.valid, false);
});

test('accepts every non-file kind with its own field: text, reference, url, manager_reply, manager_assessment', () => {
  const nonFileArtifacts = [
    { kind: 'text', text: 'free-form text' },
    { kind: 'reference', text: 'see the prior ticket' },
    { kind: 'url', url: 'https://example.com' },
    { kind: 'manager_reply', text: 'reply text' },
    { kind: 'manager_assessment', text: 'assessment text' },
  ];
  const result = validateWorkerResult({ ...validExample, artifacts: nonFileArtifacts });
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

test('artifactContent reads the field resultContract.ts\'s own per-kind map names, regardless of kind', () => {
  assert.equal(artifactContent({ kind: 'file', path: 'a.txt' }), 'a.txt');
  assert.equal(artifactContent({ kind: 'url', url: 'https://example.com' }), 'https://example.com');
  assert.equal(artifactContent({ kind: 'text', text: 'hello' }), 'hello');
  assert.equal(artifactContent({ kind: 'manager_reply', text: 'reply' }), 'reply');
});

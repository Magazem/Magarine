import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkerResult } from './resultContract.ts';

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

test('rejects a wrong-typed field', () => {
  const result = validateWorkerResult({ ...validExample, checks: 'not an array' });
  assert.equal(result.valid, false);
});

test('rejects a malformed checks entry', () => {
  const result = validateWorkerResult({ ...validExample, checks: [{ name: 'x', status: 'maybe' }] });
  assert.equal(result.valid, false);
});

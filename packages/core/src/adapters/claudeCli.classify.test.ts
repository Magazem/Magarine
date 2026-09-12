import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOutcome, verifyArtifacts } from './claudeCli.ts';

test('timeout classifies retryable regardless of any result line', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: false },
    fileResult: undefined,
    exitCode: null,
    stderr: '',
    timedOut: true,
  });
  assert.equal(outcome.kind, 'retryable');
});

test('is_error true with an auth message classifies adapter_unavailable', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: true, result: 'Not logged in · Please run /login' },
    fileResult: undefined,
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.deepEqual(outcome, { kind: 'adapter_unavailable', reason: 'Not logged in · Please run /login' });
});

test('is_error true with a budget message classifies budget_exceeded', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: true, result: 'Error: max-budget-usd of $2.00 exceeded before completion' },
    fileResult: undefined,
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'budget_exceeded');
});

test('is_error true with an unrecognized message classifies retryable', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: true, result: 'some other transient API error' },
    fileResult: undefined,
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'retryable');
});

test('no result line and no file result classifies retryable, with stderr surfaced', () => {
  const outcome = classifyOutcome({
    resultLine: undefined,
    fileResult: undefined,
    exitCode: 1,
    stderr: "Error: --json-schema is not valid JSON: JSON Parse error: Expected '}'",
    timedOut: false,
  });
  assert.equal(outcome.kind, 'retryable');
  assert.match((outcome as { reason: string }).reason, /json-schema/);
});

test('an old-vocabulary status (ready_for_review) from the spike fixtures maps to review and validates', () => {
  const outcome = classifyOutcome({
    resultLine: undefined,
    fileResult: {
      status: 'ready_for_review',
      summary: 's',
      artifacts: [],
      checks: [],
      blockers: [],
      questions: [],
    },
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'success');
  assert.equal((outcome as { result: { status: string } }).result.status, 'review');
});

test('an old-vocabulary status (blocked) maps to needs_user_decision', () => {
  const outcome = classifyOutcome({
    resultLine: undefined,
    fileResult: { status: 'blocked', summary: 's', artifacts: [], checks: [], blockers: ['x'], questions: [] },
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'success');
  assert.equal((outcome as { result: { status: string } }).result.status, 'needs_user_decision');
});

test('the daemon vocabulary (done/review/needs_user_decision/failed) passes through unchanged', () => {
  for (const status of ['done', 'review', 'needs_user_decision', 'failed']) {
    const outcome = classifyOutcome({
      resultLine: undefined,
      fileResult: { status, summary: 's', artifacts: [], checks: [], blockers: [], questions: [] },
      exitCode: 0,
      stderr: '',
      timedOut: false,
    });
    assert.equal(outcome.kind, 'success', `status ${status} should classify as success`);
    assert.equal((outcome as { result: { status: string } }).result.status, status);
  }
});

test('an unrecognized status classifies retryable rather than crashing', () => {
  const outcome = classifyOutcome({
    resultLine: undefined,
    fileResult: { status: 'something_new', summary: 's', artifacts: [], checks: [], blockers: [], questions: [] },
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'retryable');
});

test('a result missing required fields classifies retryable (malformed), not crashed', () => {
  const outcome = classifyOutcome({
    resultLine: undefined,
    fileResult: { status: 'done' },
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'retryable');
  assert.match((outcome as { reason: string }).reason, /malformed/);
});

test('the .orchestrator/result.json file takes precedence over the stream structured_output', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: false, structured_output: { status: 'done', summary: 'from stream' } },
    fileResult: { status: 'review', summary: 'from file', artifacts: [], checks: [], blockers: [], questions: [] },
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'success');
  assert.equal((outcome as { result: { summary: string } }).result.summary, 'from file');
});

test('verifyArtifacts: a claimed file that exists inside the workspace passes through as success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-verify-'));
  try {
    writeFileSync(join(dir, 'hello.txt'), 'hi');
    const result = { status: 'review' as const, summary: 's', artifacts: [{ kind: 'file', path: 'hello.txt' }], checks: [], blockers: [], questions: [] };
    const outcome = verifyArtifacts(result, dir);
    assert.equal(outcome.kind, 'success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyArtifacts: a claimed file that was never written classifies retryable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-verify-'));
  try {
    const result = { status: 'review' as const, summary: 's', artifacts: [{ kind: 'file', path: 'hello.txt' }], checks: [], blockers: [], questions: [] };
    const outcome = verifyArtifacts(result, dir);
    assert.equal(outcome.kind, 'retryable');
    assert.match((outcome as { reason: string }).reason, /artefact not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyArtifacts: an absolute path outside the workspace is treated as not found, never stat-ed for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'magarine-verify-'));
  const outside = mkdtempSync(join(tmpdir(), 'magarine-verify-outside-'));
  try {
    writeFileSync(join(outside, 'done.txt'), 'hi');
    const result = {
      status: 'needs_user_decision' as const,
      summary: 's',
      artifacts: [{ kind: 'file', path: join(outside, 'done.txt') }],
      checks: [],
      blockers: ['pending'],
      questions: [],
    };
    const outcome = verifyArtifacts(result, dir);
    assert.equal(outcome.kind, 'retryable', 'a file outside the workspace must not count as found even though it exists on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

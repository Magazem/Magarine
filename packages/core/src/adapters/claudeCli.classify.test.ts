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

test('is_error true with subtype error_max_budget_usd classifies budget_exceeded, even with no result text (the real observed probe output)', () => {
  // docs/strategy/batch-4-spec.md section 0, HARD: the Orchestrator's direct
  // probe of the real tool found exactly this shape -- exit code 1,
  // is_error: true, subtype: 'error_max_budget_usd', result: undefined. A
  // prose regex against `result` could never fire against this; the fixture
  // here is the recorded probe output verbatim, not authored.
  const outcome = classifyOutcome({
    resultLine: { is_error: true, subtype: 'error_max_budget_usd', result: undefined },
    fileResult: undefined,
    exitCode: 1,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'budget_exceeded');
});

test('is_error true with an unrelated subtype and budget-sounding prose is NOT classified budget_exceeded (subtype, not text, is the discriminator)', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: true, subtype: 'success', result: 'Error: max-budget-usd of $2.00 exceeded before completion' },
    fileResult: undefined,
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'retryable', 'no regex fallback -- the old prose pattern is deleted, not just deprioritized');
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

test('the daemon vocabulary (done/review/needs_user_decision/failed/budget_insufficient) passes through unchanged', () => {
  for (const status of ['done', 'review', 'needs_user_decision', 'failed', 'budget_insufficient']) {
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

// Batch 7 (Role L): a real worker's own budget self-stop, going through the
// adapter's own classification (`classifyOutcome`/`mapWorkerStatus`), not
// the fake adapter -- the fake adapter's `budget_insufficient` FakeScript
// kind emits a `result_raw` event directly and never touches this file, so a
// test suite that only drove the fake would not have caught
// `mapWorkerStatus` missing this case (which is exactly what happened: it
// was missing until this test was added). This is the real-shaped path: a
// terminal `result` line reporting success (no is_error) with the worker's
// own `.orchestrator/result.json` naming `budget_insufficient` and its own
// reasoning as `summary`.
test('a real worker result reporting status budget_insufficient classifies as success with that status, not a generic retryable failure', () => {
  const outcome = classifyOutcome({
    resultLine: { is_error: false },
    fileResult: {
      status: 'budget_insufficient',
      summary:
        'Stopped after creating file01.txt (verified via directory listing) because per-call cost ' +
        '(~$0.08-0.09 per create+verify pair) makes completing all 16 files impossible within the $0.25 budget ceiling.',
      artifacts: [{ kind: 'file', path: 'file01.txt' }],
      checks: [],
      blockers: [],
      questions: [],
    },
    exitCode: 0,
    stderr: '',
    timedOut: false,
  });
  assert.equal(outcome.kind, 'success', 'must not fall through to the generic retryable default');
  assert.equal((outcome as { result: { status: string } }).result.status, 'budget_insufficient');
  assert.match(
    (outcome as { result: { summary: string } }).result.summary,
    /per-call cost/,
    "the worker's own reasoning must survive classification intact"
  );
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter } from './claudeCli.ts';
import type { TicketEnvelope, WorkerEvent } from '../types.ts';

// All real API-calling runs happened in the batch-1 spike
// (docs/spikes/claude-cli-adapter.md); these tests spawn a fake executable
// (testFixtures/fakeClaudeExe.ts) that replays the bytes that spike
// recorded, or synthetic bytes clearly labelled as such. No test here calls
// the real `claude` tool or the network.

const fakeExePath = fileURLToPath(new URL('./testFixtures/fakeClaudeExe.ts', import.meta.url));
const runsDir = fileURLToPath(new URL('../../../../spikes/claude-cli/runs/', import.meta.url));

function fixturePath(...parts: string[]): string {
  return join(runsDir, ...parts);
}

function envelope(overrides: Partial<TicketEnvelope> = {}): TicketEnvelope {
  return {
    ticketId: 'tkt_test',
    projectBrief: 'test project',
    relevantDecisions: [],
    title: 'Test ticket',
    description: 'do the thing',
    acceptanceCriteria: ['hello.txt exists'],
    completedDependencies: [],
    allowedTools: [],
    expectedOutputFormat: 'Write .orchestrator/result.json.',
    ...overrides,
  };
}

async function runOnce(
  spec: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<{ events: WorkerEvent[]; workspaceRoot: string }> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-claudecli-test-'));
  const adapter = new ClaudeCliAdapter({
    claudeExe: process.execPath,
    argsPrefix: [fakeExePath],
    maxBudgetUsd: 2,
    workspaceType: 'DIRECTORY',
    workspaceRoot,
    timeoutMs: opts.timeoutMs,
    env: { MAGARINE_FAKE_SPEC: JSON.stringify(spec) },
  });

  const ticket = envelope();
  const handle = await adapter.startWorker({ ticket, systemPolicy: 'default' });

  const events: WorkerEvent[] = [];
  await new Promise<void>((resolve) => {
    void adapter.observe(handle, (event) => {
      events.push(event);
      if (event.type === 'result_raw' || event.type === 'failure') resolve();
    });
  });

  return { events, workspaceRoot };
}

test('happy path: reads .orchestrator/result.json in preference to the stream result, maps ready_for_review -> review', async () => {
  const { events, workspaceRoot } = await runOnce({
    stdoutFile: fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'),
    exitCode: 0,
    createFiles: {
      'hello.txt': 'hello from magarine worker',
      '.orchestrator/result.json': JSON.stringify({
        status: 'review',
        summary: 'FROM FILE, not stream',
        artifacts: [{ kind: 'file', path: 'hello.txt' }],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'result_raw');
    assert.equal((terminal as { raw: { status: string } }).raw.status, 'review');
    assert.equal((terminal as { raw: { summary: string } }).raw.summary, 'FROM FILE, not stream');
    assert.ok((terminal as { usage?: unknown }).usage, 'expected usage (cost/tokens/session_id) to be recorded');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('happy path: falls back to the stream structured_output when no .orchestrator/result.json is written, and emits progress events from stream-json lines', async () => {
  const { events, workspaceRoot } = await runOnce({
    stdoutFile: fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'),
    exitCode: 0,
    createFiles: { 'hello.txt': 'hello from magarine worker' },
  });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'result_raw');
    assert.equal((terminal as { raw: { status: string } }).raw.status, 'review');
    assert.ok(
      events.some((e) => e.type === 'progress'),
      'expected at least one progress event decoded from the stream-json lines'
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('artefact verification: a schema-valid result claiming an artefact that was never written is classified retryable', async () => {
  const { events, workspaceRoot } = await runOnce({
    stdoutFile: fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'),
    exitCode: 0,
    // hello.txt deliberately not created, even though the replayed stream claims it.
  });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'failure');
    assert.equal((terminal as { retryable: boolean }).retryable, true);
    assert.match((terminal as { message: string }).message, /artefact not found/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('not-logged-in: is_error true with an auth message is classified adapter-unavailable, not retryable', async () => {
  const { events, workspaceRoot } = await runOnce({
    stdoutFile: fixturePath('manual-not-logged-in', 'stdout.txt'),
    exitCode: 0,
  });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'failure');
    assert.equal((terminal as { retryable: boolean }).retryable, false);
    assert.match((terminal as { message: string }).message, /ADAPTER_UNAVAILABLE/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('invalid schema: no JSON on stdout at all is classified retryable, not crashed', async () => {
  const { events, workspaceRoot } = await runOnce({
    stderrFile: fixturePath('manual-invalid-schema', 'stderr.txt'),
    exitCode: 1,
  });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'failure');
    assert.equal((terminal as { retryable: boolean }).retryable, true);
    assert.match((terminal as { message: string }).message, /json-schema/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('timeout: a hung worker is killed by the wall-clock timeout and classified retryable', async () => {
  const { events, workspaceRoot } = await runOnce({ sleepMs: 5000 }, { timeoutMs: 300 });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'failure');
    assert.equal((terminal as { retryable: boolean }).retryable, true);
    assert.match((terminal as { message: string }).message, /timed out/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('budget exceeded (SOFT: no recorded spike fixture forced this class — see docs/spikes/claude-cli-adapter.md §2.4; this stdout is authored here, not replayed from spikes/claude-cli/runs/): classified as a non-retryable failed attempt', async () => {
  const syntheticDir = mkdtempSync(join(tmpdir(), 'magarine-synthetic-budget-'));
  const stdoutFile = join(syntheticDir, 'stdout.json');
  writeFileSync(
    stdoutFile,
    JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'success',
      result: 'Error: max-budget-usd of $2.00 exceeded before completion',
    }) + '\n'
  );

  const { events, workspaceRoot } = await runOnce({ stdoutFile, exitCode: 0 });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'failure');
    assert.equal((terminal as { retryable: boolean }).retryable, false);
    assert.match((terminal as { message: string }).message, /budget exceeded/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(syntheticDir, { recursive: true, force: true });
  }
});

test('observe() attached after the run already finished still receives the terminal event (no startWorker/observe race)', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-claudecli-test-'));
  try {
    const adapter = new ClaudeCliAdapter({
      claudeExe: process.execPath,
      argsPrefix: [fakeExePath],
      maxBudgetUsd: 2,
      workspaceType: 'DIRECTORY',
      workspaceRoot,
      env: {
        MAGARINE_FAKE_SPEC: JSON.stringify({
          stdoutFile: fixturePath('manual-invalid-schema', 'stderr.txt'), // irrelevant content, just needs to exit fast
          exitCode: 1,
        }),
      },
    });
    const handle = await adapter.startWorker({ ticket: envelope(), systemPolicy: 'default' });

    // Give the fast-exiting fake process time to finish before we ever call observe().
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events: WorkerEvent[] = [];
    await adapter.observe(handle, (event) => events.push(event));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'failure');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('NONE workspace directories are removed after the run completes (checked against the real filesystem, not just the return value)', async () => {
  const before = new Set(readdirSync(tmpdir()));

  const adapter = new ClaudeCliAdapter({
    claudeExe: process.execPath,
    argsPrefix: [fakeExePath],
    maxBudgetUsd: 2,
    workspaceType: 'NONE',
    env: {
      MAGARINE_FAKE_SPEC: JSON.stringify({
        stdoutFile: fixturePath('manual-not-logged-in', 'stdout.txt'),
        exitCode: 0,
      }),
    },
  });
  const handle = await adapter.startWorker({ ticket: envelope(), systemPolicy: 'default' });
  await new Promise<void>((resolve) => {
    void adapter.observe(handle, (event) => {
      if (event.type === 'result_raw' || event.type === 'failure') resolve();
    });
  });

  const after = readdirSync(tmpdir()).filter((name) => name.startsWith('magarine-run-') && !before.has(name));
  assert.deepEqual(after, [], 'the NONE workspace directory created for this run must not remain in the OS temp dir');
});

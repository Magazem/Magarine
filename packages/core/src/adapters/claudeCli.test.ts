import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter } from './claudeCli.ts';
import { testTempRoot } from '../testSupport.ts';
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

test("the running cost tally on progress events is deduped by assistant message id and, by construction (calibrated against this exact fixture), reproduces the fixture's own reported total_cost_usd", async () => {
  // This fixture's stream repeats each of its two real assistant turns
  // across two stream-json lines with the SAME message.id (observed by
  // inspecting the raw file directly), summing to the terminal result's own
  // usage. A naive per-line accumulation would double the true cost.
  const { events, workspaceRoot } = await runOnce({
    stdoutFile: fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'),
    exitCode: 0,
    createFiles: { 'hello.txt': 'hello from magarine worker' },
  });
  try {
    const progressWithCost = events.filter(
      (e): e is { type: 'progress'; message: string; costUsd?: number } => e.type === 'progress' && typeof e.costUsd === 'number'
    );
    assert.ok(progressWithCost.length > 0, 'expected at least one progress event carrying a cumulative costUsd');
    const finalTally = progressWithCost.at(-1)!.costUsd!;
    // The fixture's own `result` line reports total_cost_usd: 0.3673715 for
    // the same two turns (spikes/claude-cli/runs/2026-09-12T14-15-13-624Z-stream/stdout.txt).
    assert.ok(
      Math.abs(finalTally - 0.3673715) < 0.0005,
      `expected the deduped tally (${finalTally}) to reproduce the fixture's total_cost_usd (0.3673715) -- a mismatch this large means either dedup broke or the calibration constant drifted`
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('batch 5 item 4: the calibration fixture\'s stream carries no per-message cost field, only the terminal result\'s total_cost_usd', () => {
  // Locks in the finding recorded in claudeCli.ts's BLENDED_USD_PER_RAW_TOKEN
  // header: a per-message cost field would make that constant unnecessary,
  // and it does not exist in this stream. Read directly, not asserted from
  // memory -- every line's own keys are enumerated so a future fixture (or
  // tool version) that DOES add one fails this test rather than going
  // unnoticed.
  const lines = readFileSync(fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  assert.ok(lines.some((l) => l.type === 'assistant'), 'sanity: the fixture must actually contain assistant turns');
  for (const line of lines) {
    if (line.type === 'assistant') {
      assert.equal('total_cost_usd' in line, false, 'an assistant line unexpectedly carries a cost field');
      const usage = (line.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      if (usage) assert.equal('cost_usd' in usage || 'total_cost_usd' in usage, false, 'usage unexpectedly carries a cost field');
    }
  }

  const resultLines = lines.filter((l) => l.type === 'result');
  assert.equal(resultLines.length, 1, 'total_cost_usd must appear on exactly the one terminal result line');
  assert.equal(typeof resultLines[0].total_cost_usd, 'number');
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

test('budget exceeded (HARD: the exact shape docs/strategy/batch-4-spec.md section 0 recorded from probing the real tool directly -- subtype error_max_budget_usd, no result text): classified as a non-retryable failed attempt', async () => {
  const syntheticDir = mkdtempSync(join(tmpdir(), 'magarine-synthetic-budget-'));
  const stdoutFile = join(syntheticDir, 'stdout.json');
  writeFileSync(
    stdoutFile,
    JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'error_max_budget_usd',
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

test('two tickets with different envelope.maxBudgetUsd overrides produce two different --max-budget-usd arguments to the fake executable', async () => {
  // Batch 4 item 2: before this, ClaudeCliAdapter always used its own
  // constructor-level maxBudgetUsd for the flag, so a per-ticket override
  // never reached the tool (batch-3-closeout.md §8 item 3). Proven here by
  // reading back the real argv the fake executable was actually invoked
  // with (via testFixtures/fakeClaudeExe.ts's argvFile), not by inspecting
  // the adapter's internals.
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-claudecli-argv-'));
  const argvDir = mkdtempSync(join(tmpdir(), 'magarine-claudecli-argv-out-'));
  try {
    async function maxBudgetArgFor(maxBudgetUsd: number, ticketId: string): Promise<string> {
      const argvFile = join(argvDir, `${ticketId}.json`);
      const adapter = new ClaudeCliAdapter({
        claudeExe: process.execPath,
        argsPrefix: [fakeExePath],
        maxBudgetUsd: 2, // constructor default -- must NOT be what ends up on the command line
        workspaceType: 'DIRECTORY',
        workspaceRoot,
        env: { MAGARINE_FAKE_SPEC: JSON.stringify({ exitCode: 0, argvFile }) },
      });
      const handle = await adapter.startWorker({ ticket: envelope({ ticketId, maxBudgetUsd }), systemPolicy: 'default' });
      await new Promise<void>((resolve) => {
        void adapter.observe(handle, (event) => {
          if (event.type === 'result_raw' || event.type === 'failure') resolve();
        });
      });
      const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8'));
      const flagIndex = argv.indexOf('--max-budget-usd');
      assert.ok(flagIndex >= 0, '--max-budget-usd must be on the command line');
      return argv[flagIndex + 1];
    }

    const [cheap, expensive] = await Promise.all([
      maxBudgetArgFor(0.5, 'tkt_cheap'),
      maxBudgetArgFor(9.5, 'tkt_expensive'),
    ]);

    assert.equal(cheap, '0.5');
    assert.equal(expensive, '9.5');
    assert.notEqual(cheap, expensive);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(argvDir, { recursive: true, force: true });
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
  // Batch 5 item 3: scans a private root this test file exclusively owns
  // (via ClaudeCliAdapterOptions.baseDir -> workspace.ts's injectable
  // baseDir), not the shared OS tmpdir(). Before this, `node --test`
  // running files concurrently meant another file's own `magarine-run-*`
  // directory could transiently look new to this scan -- measured at one
  // run in six, see batch-4-closeout.md section 5 item 2. Scanning a root
  // nothing else writes into makes this deterministic instead of merely
  // less likely.
  const { root, cleanup } = testTempRoot('claudecli-leak');
  try {
    const adapter = new ClaudeCliAdapter({
      claudeExe: process.execPath,
      argsPrefix: [fakeExePath],
      maxBudgetUsd: 2,
      workspaceType: 'NONE',
      baseDir: root,
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

    const remaining = readdirSync(root).filter((name) => name.startsWith('magarine-run-'));
    assert.deepEqual(remaining, [], 'the NONE workspace directory created for this run must not remain on disk');
  } finally {
    cleanup();
  }
});

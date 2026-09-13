import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter } from './claudeCli.ts';
import { testTempRoot } from '../testSupport.ts';
import { rmSyncResilient } from '../db/testSupport.ts';
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
    model: 'claude-sonnet-5',
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
    await rmSyncResilient(workspaceRoot);
  }
});

// Batch 7 (Role L): a real worker's own budget self-stop, driven through the
// actual spawned process / stdout-parsing / result-file pipeline
// (ClaudeCliAdapter.startWorker), not FakeAdapter -- proves the fix in
// mapWorkerStatus reaches a live run end to end, not just classifyOutcome in
// isolation (see claudeCli.classify.test.ts's unit-level test for that).
test('a real worker result reporting status budget_insufficient reaches observers as result_raw, not a generic failure', async () => {
  const { events, workspaceRoot } = await runOnce({
    stdoutFile: fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'),
    exitCode: 0,
    createFiles: {
      '.orchestrator/result.json': JSON.stringify({
        status: 'budget_insufficient',
        summary: 'per-call cost makes finishing this ticket impossible within the ceiling',
        artifacts: [],
        checks: [],
        blockers: [],
        questions: [],
      }),
    },
  });
  try {
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'result_raw', 'must not fall through to a generic failure event');
    assert.equal((terminal as { raw: { status: string } }).raw.status, 'budget_insufficient');
    assert.equal(
      (terminal as { raw: { summary: string } }).raw.summary,
      'per-call cost makes finishing this ticket impossible within the ceiling'
    );
  } finally {
    await rmSyncResilient(workspaceRoot);
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
    await rmSyncResilient(workspaceRoot);
  }
});

// Batch 6 item 2: the running cost tally is now priced per model/category
// (pricing.ts's priceUsage) instead of one blended constant, deduped by
// assistant message id as before -- the dedup itself is unchanged and still
// correct (this fixture's stream repeats each real assistant turn across
// two stream-json lines with the SAME message.id; a naive per-line
// accumulation would double the true cost).
//
// It is NOT within two percent of the fixture's own total_cost_usd, and
// that is reported here rather than hidden behind a widened tolerance
// (docs/strategy/batch-6-spec.md's instruction: report the disagreement).
// input_tokens, cache_creation_input_tokens and cache_read_input_tokens all
// reconstruct EXACTLY from the deduped assistant-line sum on both fixtures
// (verified directly, not asserted here) -- the entire shortfall below is
// the output_tokens category, which assistant lines report at 16.1% (fixture
// 1) and 6.1% (fixture 2) of the terminal result line's authoritative
// count, with no other signal on the stream carrying the difference (see
// the messageModel/priceUsage header comment in claudeCli.ts). Both
// fixtures happen to be cache-write-dominated (output was 8.8% and 2.4% of
// true spend respectively), which is the only reason the resulting total
// error looks small here -- an output-heavy, cache-light real run would
// show a far larger shortfall, unbounded by anything measured in this repo.
for (const fixture of [
  { dir: '2026-09-12T14-15-13-624Z-stream', model: 'claude-fable-5-1', trueTotal: 0.3673715, expectedTally: 0.3403715 },
  { dir: '2026-09-13T13-23-00-000Z-stream-calib2', model: 'claude-sonnet-5', trueTotal: 0.20431960000000002, expectedTally: 0.1997296 },
]) {
  test(`the running cost tally (${fixture.model}) is deduped by assistant message id, priced per-model/category, and UNDERCOUNTS the fixture's own total_cost_usd (output tokens are not fully visible mid-stream)`, async () => {
    const { events, workspaceRoot } = await runOnce({
      stdoutFile: fixturePath(fixture.dir, 'stdout.txt'),
      exitCode: 0,
      createFiles: { 'hello.txt': 'hello from magarine worker' },
    });
    try {
      const progressWithCost = events.filter(
        (e): e is { type: 'progress'; message: string; costUsd?: number } => e.type === 'progress' && typeof e.costUsd === 'number'
      );
      assert.ok(progressWithCost.length > 0, 'expected at least one progress event carrying a cumulative costUsd');
      const finalTally = progressWithCost.at(-1)!.costUsd!;
      assert.ok(
        finalTally < fixture.trueTotal,
        `expected the tally (${finalTally}) to UNDERcount the fixture's total_cost_usd (${fixture.trueTotal}) -- an over-count here would mean the known output-token gap somehow closed, which would itself be worth investigating`
      );
      assert.ok(
        Math.abs(finalTally - fixture.expectedTally) < 1e-9,
        `expected the deduped per-category tally (${finalTally}) to match the independently-computed value (${fixture.expectedTally}) -- a mismatch means dedup or the per-message model lookup broke`
      );
    } finally {
      await rmSyncResilient(workspaceRoot);
    }
  });
}

test('batch 6 item 3: an assistant line naming a model outside pricing.ts\'s rate table flags unknownModel on the progress event, and still tallies (at the fallback rate) rather than dropping the message', async () => {
  // Synthetic, not a recorded fixture -- no real run has ever used an
  // unrecognized model id, by construction (real fixtures only carry
  // models this repo already has rates for). Shape copied from the real
  // fixtures' assistant/result lines, trimmed to the fields the adapter
  // actually reads.
  const synthDir = mkdtempSync(join(tmpdir(), 'magarine-claudecli-unknown-model-'));
  const stdoutFile = join(synthDir, 'stdout.txt');
  const lines = [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        id: 'msg_unknown_1',
        model: 'claude-nonexistent-model',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        },
      },
    },
    { type: 'result', total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  writeFileSync(stdoutFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  try {
    const { events, workspaceRoot } = await runOnce({
      stdoutFile,
      exitCode: 0,
      createFiles: {
        '.orchestrator/result.json': JSON.stringify({
          status: 'ready_for_review',
          summary: 'ok',
          artifacts: [],
          checks: [],
          blockers: [],
          questions: [],
        }),
      },
    });
    try {
      const flagged = events.find(
        (e): e is { type: 'progress'; message: string; costUsd?: number; unknownModel?: string } =>
          e.type === 'progress' && typeof (e as { unknownModel?: string }).unknownModel === 'string'
      );
      assert.ok(flagged, 'expected a progress event carrying unknownModel for the unrecognized model id');
      assert.equal(flagged!.unknownModel, 'claude-nonexistent-model');
      assert.ok(
        typeof flagged!.costUsd === 'number' && flagged!.costUsd > 0,
        'expected the message to still be tallied (at the fallback rate), not dropped, once flagged'
      );
    } finally {
      await rmSyncResilient(workspaceRoot);
    }
  } finally {
    rmSync(synthDir, { recursive: true, force: true });
  }
});

test("batch 6 item 4: a completed run whose terminal result line's modelUsage names a model outside pricing.ts's rate table flags unknownModel on the terminal event too, not only mid-run", async () => {
  // Synthetic: modelUsage is a real field (verified HARD against every
  // fixture this repo has a terminal result line for -- see
  // claudeCli.ts's ResultLine.modelUsage comment), but no real fixture
  // names an unrecognized model in it, by construction.
  const synthDir = mkdtempSync(join(tmpdir(), 'magarine-claudecli-unknown-model-completed-'));
  const stdoutFile = join(synthDir, 'stdout.txt');
  writeFileSync(
    stdoutFile,
    JSON.stringify({
      type: 'result',
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { 'claude-nonexistent-model': { costUSD: 0.5 } },
    }) + '\n'
  );

  try {
    const { events, workspaceRoot } = await runOnce({
      stdoutFile,
      exitCode: 0,
      createFiles: {
        '.orchestrator/result.json': JSON.stringify({
          status: 'ready_for_review',
          summary: 'ok',
          artifacts: [],
          checks: [],
          blockers: [],
          questions: [],
        }),
      },
    });
    try {
      const terminal = events.at(-1)! as { type: string; unknownModel?: string };
      assert.equal(terminal.type, 'result_raw');
      assert.equal(terminal.unknownModel, 'claude-nonexistent-model');
    } finally {
      await rmSyncResilient(workspaceRoot);
    }
  } finally {
    rmSync(synthDir, { recursive: true, force: true });
  }
});

test('batch 5 item 4: the calibration fixture\'s stream carries no per-message cost field, only the terminal result\'s total_cost_usd', () => {
  // Locks in the finding recorded in claudeCli.ts's messageModel/priceUsage
  // header: a per-message cost field would make per-category rate lookup
  // unnecessary for the mid-run tally, and it does not exist in this
  // stream. Read directly, not asserted from memory -- every line's own
  // keys are enumerated so a future fixture (or tool version) that DOES add
  // one fails this test rather than going unnoticed.
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
    await rmSyncResilient(workspaceRoot);
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
    await rmSyncResilient(workspaceRoot);
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
    await rmSyncResilient(workspaceRoot);
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
    await rmSyncResilient(workspaceRoot);
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
    const terminal = events.at(-1)! as { type: string; retryable: boolean; message: string; failureClass?: string; stoppedBy?: string };
    assert.equal(terminal.type, 'failure');
    assert.equal(terminal.retryable, false);
    assert.match(terminal.message, /budget exceeded/);
    // Batch 6: previously absent -- scheduler.ts's `event.failureClass ??
    // 'adapter_failure'` fallback silently mis-recorded a real tool-side
    // budget stop as a generic adapter failure. stoppedBy distinguishes
    // this from the scheduler's own estimate-driven stop.
    assert.equal(terminal.failureClass, 'budget_exceeded');
    assert.equal(terminal.stoppedBy, 'tool_max_budget_usd');
  } finally {
    await rmSyncResilient(workspaceRoot);
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
    await rmSyncResilient(workspaceRoot);
    rmSync(argvDir, { recursive: true, force: true });
  }
});

test("two tickets with different envelope.model values produce two different --model arguments to the fake executable, and each run's usage records its own model", async () => {
  // Batch 6 item 4: before this, the adapter never passed --model at all
  // (docs/strategy/batch-6-spec.md section 0) -- every worker ran on
  // whatever the owner's desktop default happened to be, which is the root
  // cause behind batch 5's 405%-wrong cost estimate. Same proof shape as
  // the --max-budget-usd test above: read back the real argv, not the
  // adapter's internals.
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'magarine-claudecli-model-argv-'));
  const argvDir = mkdtempSync(join(tmpdir(), 'magarine-claudecli-model-argv-out-'));
  try {
    async function modelArgFor(model: string, ticketId: string): Promise<{ arg: string; recordedModel: unknown }> {
      const argvFile = join(argvDir, `${ticketId}.json`);
      // A minimal synthetic `result` line with no `modelUsage` on it, so
      // extractUsage has nothing to prefer and must fall back to the
      // requested model -- proving that fallback specifically. The
      // modelUsage-preferred path is already proven by pricing.test.ts's
      // real fixtures.
      const stdoutFile = join(argvDir, `${ticketId}-stdout.txt`);
      writeFileSync(stdoutFile, JSON.stringify({ type: 'result', total_cost_usd: 0.001 }) + '\n');
      const adapter = new ClaudeCliAdapter({
        claudeExe: process.execPath,
        argsPrefix: [fakeExePath],
        maxBudgetUsd: 2,
        workspaceType: 'DIRECTORY',
        workspaceRoot,
        env: {
          MAGARINE_FAKE_SPEC: JSON.stringify({
            exitCode: 0,
            argvFile,
            stdoutFile,
            createFiles: {
              '.orchestrator/result.json': JSON.stringify({
                status: 'done',
                summary: 'ok',
                artifacts: [],
                checks: [],
                blockers: [],
                questions: [],
              }),
            },
          }),
        },
      });
      const handle = await adapter.startWorker({ ticket: envelope({ ticketId, model }), systemPolicy: 'default' });
      const events: WorkerEvent[] = [];
      await new Promise<void>((resolve) => {
        void adapter.observe(handle, (event) => {
          events.push(event);
          if (event.type === 'result_raw' || event.type === 'failure') resolve();
        });
      });
      const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8'));
      const flagIndex = argv.indexOf('--model');
      assert.ok(flagIndex >= 0, '--model must be on the command line');
      const terminal = events.at(-1)! as { usage?: { model?: unknown } };
      return { arg: argv[flagIndex + 1], recordedModel: terminal.usage?.model };
    }

    const [sonnet, haiku] = await Promise.all([
      modelArgFor('claude-sonnet-5', 'tkt_sonnet'),
      modelArgFor('claude-haiku-4-5-20251001', 'tkt_haiku'),
    ]);

    assert.equal(sonnet.arg, 'claude-sonnet-5');
    assert.equal(haiku.arg, 'claude-haiku-4-5-20251001');
    assert.notEqual(sonnet.arg, haiku.arg);
    assert.equal(sonnet.recordedModel, 'claude-sonnet-5');
    assert.equal(haiku.recordedModel, 'claude-haiku-4-5-20251001');
  } finally {
    await rmSyncResilient(workspaceRoot);
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

    // Give the fast-exiting fake process time to finish before we ever call
    // observe(), so the common case actually exercises replay (eventLog
    // already has the terminal event by the time observe() registers).
    // Not load-bearing for correctness below: under the full suite's
    // concurrent process load this 200ms can occasionally not be enough
    // (measured HARD: reproduces on the pre-existing code too, unrelated to
    // the EPERM cleanup race -- a plain `events.length` of 0 immediately
    // after `observe()` resolves, not an exception), which is exactly the
    // race this test's own name says does not exist. observe() always
    // registers a live listener regardless of whether replay already had
    // something (see claudeCli.ts's observe()), so waiting for the terminal
    // event here -- the same pattern `runOnce()` above already uses --
    // proves "no race" for real instead of merely asserting after a sleep
    // that usually, but not always, outlasted the child process.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events: WorkerEvent[] = [];
    await new Promise<void>((resolve) => {
      void adapter.observe(handle, (event) => {
        events.push(event);
        if (event.type === 'result_raw' || event.type === 'failure') resolve();
      });
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'failure');
  } finally {
    await rmSyncResilient(workspaceRoot);
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
    await cleanup();
  }
});

// Batch 9 housekeeping item 1: a persistent NONE-mode cleanup failure (every
// retry in workspace.ts's removeDirectoryResilient exhausted) used to throw
// out of startWorker's internal `.then()` callback before `this.publish` was
// ever reached -- an unhandled rejection that silently discarded the run's
// real terminal event. Proven here with a deterministic injected failure
// (workspaceRemoveFn) rather than racing the real, timing-dependent OS
// condition -- see claudeCli.ts's try/catch around `ws.cleanup()`.
test('a NONE-mode cleanup failure (every retry exhausted) still publishes the run\'s real terminal event, not silence', async () => {
  const { root, cleanup } = testTempRoot('claudecli-cleanup-failure');
  try {
    const adapter = new ClaudeCliAdapter({
      claudeExe: process.execPath,
      argsPrefix: [fakeExePath],
      maxBudgetUsd: 2,
      workspaceType: 'NONE',
      baseDir: root,
      workspaceRemoveFn: () => {
        throw new Error('simulated persistent EPERM');
      },
      workspaceRetryAttempts: 2,
      workspaceRetryDelayMs: 1,
      env: {
        MAGARINE_FAKE_SPEC: JSON.stringify({
          stdoutFile: fixturePath('2026-09-12T14-15-13-624Z-stream', 'stdout.txt'),
          exitCode: 0,
          createFiles: { 'hello.txt': 'hello from magarine worker' },
        }),
      },
    });
    const handle = await adapter.startWorker({ ticket: envelope(), systemPolicy: 'default' });

    const events: WorkerEvent[] = [];
    await new Promise<void>((resolve) => {
      void adapter.observe(handle, (event) => {
        events.push(event);
        if (event.type === 'result_raw' || event.type === 'failure') resolve();
      });
    });

    const terminal = events.at(-1)!;
    assert.equal(terminal.type, 'result_raw', 'the real outcome must still be published despite cleanup failing');
    assert.equal((terminal as { raw: { status: string } }).raw.status, 'review');

    const remaining = readdirSync(root).filter((name) => name.startsWith('magarine-run-'));
    assert.equal(remaining.length, 1, 'a persistently-failed cleanup leaves the directory behind -- cosmetic, not silent');
  } finally {
    await cleanup();
  }
});

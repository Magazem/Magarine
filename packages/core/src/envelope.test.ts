import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerPrompt } from './envelope.ts';
import type { TicketEnvelope } from './types.ts';

const OMIT_BUDGET_ENV_VAR = 'MAGARINE_TEST_OMIT_ENVELOPE_BUDGET';

function ticket(overrides: Partial<TicketEnvelope>): TicketEnvelope {
  return {
    ticketId: 'tkt_a',
    projectBrief: 'Build the widget.',
    relevantDecisions: ['Use SQLite.'],
    title: 'Ticket A',
    description: 'Create widget.ts.',
    acceptanceCriteria: ['widget.ts exists', 'widget.ts exports createWidget'],
    completedDependencies: [
      { ticketId: 'tkt_dep', title: 'Dep ticket', summary: 'Dep summary text', artifacts: [] },
    ],
    allowedTools: ['Read', 'Write'],
    expectedOutputFormat: 'Write .orchestrator/result.json matching the WorkerResult schema.',
    maxBudgetUsd: 2,
    ...overrides,
  };
}

test('prompt contains the ticket acceptance criteria', () => {
  const prompt = buildWorkerPrompt(ticket({}), '/tmp/ws');
  assert.match(prompt, /widget\.ts exists/);
  assert.match(prompt, /widget\.ts exports createWidget/);
});

test('prompt contains project brief, decisions, dependencies, allowed tools and workspace path', () => {
  const prompt = buildWorkerPrompt(ticket({}), '/tmp/ws-xyz');
  assert.match(prompt, /Build the widget\./);
  assert.match(prompt, /Use SQLite\./);
  assert.match(prompt, /Dep ticket/);
  assert.match(prompt, /Dep summary text/);
  assert.match(prompt, /Read, Write/);
  assert.match(prompt, /\/tmp\/ws-xyz/);
  assert.match(prompt, /\.orchestrator\/result\.json/);
});

test('prompt for one ticket contains nothing from an unrelated ticket', () => {
  const a = ticket({
    title: 'Ticket A unique marker AAA111',
    description: 'Description A unique marker AAA222',
    acceptanceCriteria: ['A-criterion-AAA333'],
    completedDependencies: [{ ticketId: 'dep', title: 'A-dep-AAA444', summary: 'A-dep-summary-AAA555', artifacts: [] }],
  });
  const b = ticket({
    title: 'Ticket B unique marker BBB111',
    description: 'Description B unique marker BBB222',
    acceptanceCriteria: ['B-criterion-BBB333'],
    completedDependencies: [{ ticketId: 'dep2', title: 'B-dep-BBB444', summary: 'B-dep-summary-BBB555', artifacts: [] }],
  });

  const promptA = buildWorkerPrompt(a, '/tmp/ws');
  const promptB = buildWorkerPrompt(b, '/tmp/ws');

  for (const marker of ['BBB111', 'BBB222', 'BBB333', 'BBB444', 'BBB555']) {
    assert.ok(!promptA.includes(marker), `prompt A must not contain ${marker} from ticket B`);
  }
  for (const marker of ['AAA111', 'AAA222', 'AAA333', 'AAA444', 'AAA555']) {
    assert.ok(!promptB.includes(marker), `prompt B must not contain ${marker} from ticket A`);
  }
});

test('prompt lists a dependency artifact path and its kind, and the budget ceiling', () => {
  const withArtifacts = ticket({
    completedDependencies: [
      {
        ticketId: 'tkt_dep',
        title: 'Dep ticket',
        summary: 'Dep summary text',
        artifacts: [
          { kind: 'file', path: '/tmp/proj-root/alpha.txt' },
          { kind: 'url', path: 'https://example.com/report' },
        ],
      },
    ],
    maxBudgetUsd: 3.5,
  });

  const prompt = buildWorkerPrompt(withArtifacts, '/tmp/proj-root');

  assert.match(prompt, /\(file\) \/tmp\/proj-root\/alpha\.txt/);
  assert.match(prompt, /\(url\) https:\/\/example\.com\/report/);
  assert.match(prompt, /\$3\.50/);
});

test('a second, updated envelope for the same ticket id does not carry over stale content from the first (no previous-run leakage)', () => {
  const attempt1 = ticket({
    description: 'First attempt description UNIQUE-FIRST-000',
    acceptanceCriteria: ['first-attempt-criterion-000'],
  });
  const attempt2 = ticket({
    description: 'Second attempt description UNIQUE-SECOND-111',
    acceptanceCriteria: ['second-attempt-criterion-111'],
  });

  buildWorkerPrompt(attempt1, '/tmp/ws');
  const promptForSecondAttempt = buildWorkerPrompt(attempt2, '/tmp/ws');

  assert.ok(!promptForSecondAttempt.includes('UNIQUE-FIRST-000'));
  assert.ok(!promptForSecondAttempt.includes('first-attempt-criterion-000'));
  assert.match(promptForSecondAttempt, /UNIQUE-SECOND-111/);
});

test('prompt names budget_insufficient as the status to report when the worker cannot finish within its budget', () => {
  const prompt = buildWorkerPrompt(ticket({}), '/tmp/ws');
  assert.match(prompt, /"budget_insufficient"/);
});

// Batch 7 (Role L): the blinding switch. See envelope.ts's OMIT_BUDGET_ENV_VAR
// header comment for why this exists (exercising the budget guards, which a
// worker informed of its ceiling self-limits ahead of) and why it is refused
// outside the system temp directory (the floor stays real; only a throwaway
// test workspace may ever be blinded).
test('the blinding switch (batch 7)', async (t) => {
  const savedEnvVar = process.env[OMIT_BUDGET_ENV_VAR];
  t.after(() => {
    if (savedEnvVar === undefined) delete process.env[OMIT_BUDGET_ENV_VAR];
    else process.env[OMIT_BUDGET_ENV_VAR] = savedEnvVar;
  });

  await t.test('unset: budget line is present as usual', () => {
    delete process.env[OMIT_BUDGET_ENV_VAR];
    const prompt = buildWorkerPrompt(ticket({ maxBudgetUsd: 1.23 }), '/tmp/ws');
    assert.match(prompt, /Budget ceiling for this ticket: \$1\.23/);
  });

  await t.test('set, workspace under the system temp directory: budget line is omitted', () => {
    process.env[OMIT_BUDGET_ENV_VAR] = '1';
    const tempWorkspace = mkdtempSync(join(tmpdir(), 'magarine-envelope-test-'));
    try {
      const prompt = buildWorkerPrompt(ticket({ maxBudgetUsd: 1.23 }), tempWorkspace);
      assert.ok(!prompt.includes('Budget ceiling for this ticket'), 'the budget line must be dropped');
      // Nothing else about the prompt changes: the rest is unaffected.
      assert.match(prompt, /widget\.ts exists/);
    } finally {
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  await t.test('set, workspace NOT under the system temp directory: refused', () => {
    process.env[OMIT_BUDGET_ENV_VAR] = '1';
    assert.throws(() => {
      buildWorkerPrompt(ticket({ maxBudgetUsd: 1.23 }), join(process.cwd(), 'not-a-temp-dir'));
    }, /refused/);
  });

  await t.test('set, workspace is a sibling directory that only shares the temp dir as a string prefix: refused', () => {
    process.env[OMIT_BUDGET_ENV_VAR] = '1';
    const resolvedTmp = tmpdir().replace(/[/\\]+$/, '');
    assert.throws(() => {
      buildWorkerPrompt(ticket({ maxBudgetUsd: 1.23 }), `${resolvedTmp}-sibling-not-actually-inside`);
    }, /refused/);
  });
});

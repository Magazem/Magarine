import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerPrompt } from './envelope.ts';
import type { TicketEnvelope } from './types.ts';

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

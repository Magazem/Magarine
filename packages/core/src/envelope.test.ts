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
          { kind: 'file', content: '/tmp/proj-root/alpha.txt' },
          { kind: 'url', content: 'https://example.com/report' },
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

// Batch 15 item 4: the worker envelope carries expected_artifacts.

test('prompt lists expected artifacts, naming each declared file path, when the ticket has a list', () => {
  const prompt = buildWorkerPrompt(
    ticket({ expectedArtifacts: [{ kind: 'file', path: 'out.txt' }, { kind: 'text' }] }),
    '/tmp/ws'
  );
  assert.match(prompt, /out\.txt/);
  assert.match(prompt, /Expected artifacts/i);
});

test('prompt has no expected-artifacts section at all when the ticket carries no such list', () => {
  const prompt = buildWorkerPrompt(ticket({ expectedArtifacts: undefined }), '/tmp/ws');
  assert.doesNotMatch(prompt, /Expected artifacts/i);
});

// --- Batch 19 ruling 35: the verdict cap ---

test('a previousAttempt.reason of 10,000 characters is cut to exactly 4000 in the rendered prompt, with a line naming the cut and the original length', () => {
  const reason = 'x'.repeat(10_000);
  const prompt = buildWorkerPrompt(ticket({ previousAttempt: { status: 'rejected', reason } }), '/tmp/ws');

  const match = /Previous attempt rejected: (x+)/.exec(prompt);
  assert.ok(match, 'the previous-attempt line must be present');
  assert.equal(match![1]!.length, 4000, 'exactly 4000 characters of the reason must appear');
  assert.doesNotMatch(prompt, /x{4001}/, 'no more than 4000 consecutive x characters may appear');
  assert.match(prompt, /cut to 4000 characters/);
  assert.match(prompt, /10000 characters long/);
});

test('a previousAttempt.reason under the 4000-character cap is rendered whole, with no cut line', () => {
  const reason = 'short reason UNIQUE-MARKER-777';
  const prompt = buildWorkerPrompt(ticket({ previousAttempt: { status: 'failed', reason } }), '/tmp/ws');

  assert.match(prompt, /Previous attempt failed: short reason UNIQUE-MARKER-777/);
  assert.doesNotMatch(prompt, /cut to 4000 characters/);
});

test('a previousAttempt.reason of EXACTLY 4000 characters is not treated as cut (boundary)', () => {
  const reason = 'y'.repeat(4000);
  const prompt = buildWorkerPrompt(ticket({ previousAttempt: { status: 'rejected', reason } }), '/tmp/ws');
  assert.doesNotMatch(prompt, /cut to 4000 characters/);
  assert.match(prompt, new RegExp(`Previous attempt rejected: y{4000}(?!y)`));
});

// Review fix #10: an emoji ('😀', U+1F600) is two UTF-16 code units -- a
// high surrogate then a low surrogate. Placed so the plain 4000-cut would
// land exactly between them (3999 'x's, then the emoji, then padding),
// the cut must back off to 3999 code units rather than emit a lone,
// unpaired surrogate at the end of the rendered reason.
test('a previousAttempt.reason where the 4000-cut would split a surrogate pair backs off to 3999 code units instead, and says so', () => {
  const reason = 'x'.repeat(3999) + '\u{1F600}' + 'z'.repeat(5999);
  assert.equal(reason.length, 10_000, 'sanity: the emoji contributes 2 UTF-16 code units, still 10,000 total');
  assert.equal(reason.charCodeAt(3999), 0xd83d, 'sanity: index 3999 is the emoji\'s high surrogate');
  assert.equal(reason.charCodeAt(4000), 0xde00, 'sanity: index 4000 is the emoji\'s low surrogate');

  const prompt = buildWorkerPrompt(ticket({ previousAttempt: { status: 'rejected', reason } }), '/tmp/ws');

  const match = /Previous attempt rejected: (x+)/.exec(prompt);
  assert.ok(match, 'the previous-attempt line must be present');
  assert.equal(match![1]!.length, 3999, 'backed off by exactly one code unit to avoid splitting the pair');
  assert.match(prompt, /cut to 3999 characters/, 'the cut line must name the ACTUAL length rendered, not a fixed 4000');
  assert.match(prompt, /10000 characters long/);
  // Neither surrogate half of the emoji reaches the rendered prompt at all.
  assert.ok(!prompt.includes('\u{1F600}'), 'the emoji itself must not appear');
  assert.ok(!prompt.includes('\uD83D'), 'the lone high surrogate must not appear unpaired');
});

import { tmpdir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';
import type { TicketEnvelope } from './types.ts';

// Batch 7 (Role L, docs/strategy/batch-7-spec.md section 1 ruling 2): the
// worker always reads its own budget out of the envelope and self-limits
// (batch-6-closeout.md section 3), which is the best stop the system has in
// production but also means the Orchestrator's paid runs could never reach
// either guard to exercise it. The Strategist refused lowering
// `store.ts`'s MIN_BUDGET_USD floor for test convenience -- that floor is a
// real safety property. Instead this one test-only env var, read in exactly
// this one place, drops the budget line from the prompt so a blinded worker
// behaves exactly like one whose envelope never carried `maxBudgetUsd` at
// all. Refused (throws) unless the workspace it is being used against is
// under the OS temp directory, so it can never silently blind a real,
// non-throwaway run.
const OMIT_BUDGET_ENV_VAR = 'MAGARINE_TEST_OMIT_ENVELOPE_BUDGET';

function isUnderSystemTempDir(workspacePath: string): boolean {
  const resolvedWorkspace = resolvePath(workspacePath);
  let resolvedTmp = resolvePath(tmpdir());
  let candidate = resolvedWorkspace;
  // Windows paths are case-insensitive; tmpdir()/mkdtempSync agree on actual
  // case in practice, but a test (or a caller) constructing its own path
  // string is not guaranteed to match it byte-for-byte.
  if (process.platform === 'win32') {
    resolvedTmp = resolvedTmp.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  // Exact match or a real path *segment* under it -- `sep`-prefixed, so a
  // sibling directory that merely shares the temp dir as a string prefix
  // (e.g. tmp dir `C:\Temp`, candidate `C:\Temp2\...`) is correctly refused.
  return candidate === resolvedTmp || candidate.startsWith(resolvedTmp + sep);
}

// Turns a TicketEnvelope into the text prompt handed to a worker CLI.
// Contains exactly what technical-architecture-weekend-mvp.md's "The worker
// receives only" list specifies (project brief, relevant decisions, ticket
// description, acceptance criteria, completed dependencies, allowed tools,
// workspace location, expected output) plus the ticket title, which is
// necessary to identify which ticket a worker is looking at. Nothing else —
// in particular, never the Manager's conversation or any other ticket's
// data. Pure function: no state is kept between calls, so nothing from one
// run can leak into the prompt built for another.
export function buildWorkerPrompt(envelope: TicketEnvelope, workspacePath: string): string {
  const sections: string[] = [];

  sections.push(`Project brief:\n${envelope.projectBrief || '(none provided)'}`);

  sections.push(
    envelope.relevantDecisions.length > 0
      ? `Relevant decisions:\n${envelope.relevantDecisions.map((d) => `- ${d}`).join('\n')}`
      : 'Relevant decisions: (none)'
  );

  sections.push(`Ticket: ${envelope.title}\n${envelope.description}`);

  sections.push(
    `Acceptance criteria:\n${
      envelope.acceptanceCriteria.length > 0
        ? envelope.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
        : '(none specified)'
    }`
  );

  sections.push(
    envelope.completedDependencies.length > 0
      ? `Dependencies already completed:\n${envelope.completedDependencies
          .map((d) => {
            const artifactLines = (d.artifacts ?? []).map((a) => `    - (${a.kind}) ${a.path}`).join('\n');
            return `- ${d.title}${d.summary ? `: ${d.summary}` : ''}${artifactLines ? `\n${artifactLines}` : ''}`;
          })
          .join('\n')}`
      : 'Dependencies already completed: (none)'
  );

  sections.push(
    `Allowed tools: ${envelope.allowedTools.length > 0 ? envelope.allowedTools.join(', ') : '(none specified)'}`
  );

  sections.push(`Workspace: ${workspacePath}`);

  // Batch 7 test-only blinding switch -- see OMIT_BUDGET_ENV_VAR's header
  // comment above. Read in this one place only.
  const omitBudgetForTest = process.env[OMIT_BUDGET_ENV_VAR] === '1';
  if (omitBudgetForTest && !isUnderSystemTempDir(workspacePath)) {
    throw new Error(
      `${OMIT_BUDGET_ENV_VAR} is test-only and is refused for a workspace outside the system temp directory: ${workspacePath}`
    );
  }
  // Tolerant of an envelope built before maxBudgetUsd existed (e.g. a
  // fixture in adapters/, which this role does not own and cannot edit):
  // an absent budget just doesn't get a line, rather than throwing.
  if (typeof envelope.maxBudgetUsd === 'number' && !omitBudgetForTest) {
    sections.push(`Budget ceiling for this ticket: $${envelope.maxBudgetUsd.toFixed(2)}`);
  }

  sections.push(
    `Expected output: ${envelope.expectedOutputFormat}\n` +
      'Write .orchestrator/result.json matching the worker result contract, and also return the same object as your final answer. ' +
      'If a budget ceiling is stated above and you determine, from your own observed per-turn cost, that you cannot finish ' +
      'within it, stop and report status "budget_insufficient" with your reasoning (observed cost so far, cost per turn, ' +
      'and why it will not fit) in "summary" -- do not keep working past that point hoping it will fit anyway.'
  );

  return sections.join('\n\n');
}

import type { TicketEnvelope } from './types.ts';

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
            const artifactLines = (d.artifacts ?? []).map((a) => `    - (${a.kind}) ${a.content}`).join('\n');
            return `- ${d.title}${d.summary ? `: ${d.summary}` : ''}${artifactLines ? `\n${artifactLines}` : ''}`;
          })
          .join('\n')}`
      : 'Dependencies already completed: (none)'
  );

  sections.push(
    `Allowed tools: ${envelope.allowedTools.length > 0 ? envelope.allowedTools.join(', ') : '(none specified)'}`
  );

  sections.push(`Workspace: ${workspacePath}`);

  // Tolerant of an envelope built before maxBudgetUsd existed (e.g. a
  // fixture in adapters/, which this role does not own and cannot edit):
  // an absent budget just doesn't get a line, rather than throwing.
  if (typeof envelope.maxBudgetUsd === 'number') {
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

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
          .map((d) => `- ${d.title}${d.summary ? `: ${d.summary}` : ''}`)
          .join('\n')}`
      : 'Dependencies already completed: (none)'
  );

  sections.push(
    `Allowed tools: ${envelope.allowedTools.length > 0 ? envelope.allowedTools.join(', ') : '(none specified)'}`
  );

  sections.push(`Workspace: ${workspacePath}`);

  sections.push(
    `Expected output: ${envelope.expectedOutputFormat}\n` +
      'Write .orchestrator/result.json matching the worker result contract, and also return the same object as your final answer.'
  );

  return sections.join('\n\n');
}

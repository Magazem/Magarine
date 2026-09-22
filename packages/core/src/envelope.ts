import type { TicketEnvelope } from './types.ts';

// Ruling 35 (batch-19-spec.md section 3): "the verifier verdict passed into
// the retry prompt verbatim, no length limit" (batch 19's own carry list,
// item 5) was the bug -- an unbounded verdict.reason could balloon the
// retry prompt without limit. Cut here, not at the source (the verdict is
// still recorded in full in the database/events; only the RENDERED prompt
// is capped), so nothing upstream loses data over this.
const PREVIOUS_ATTEMPT_REASON_CHAR_CAP = 4000;

// Review fix #10: `reason.slice(0, 4000)` cuts by UTF-16 CODE UNIT, which
// can land exactly between a surrogate pair's high and low half (an emoji
// or any character outside the Basic Multilingual Plane is two code units;
// `reason.length` already counts in these, matching `String.prototype.slice`
// itself). A cut mid-pair leaves an unpaired surrogate at the very end of
// the rendered prompt -- not invalid per se in a JS string, but it prints
// as U+FFFD/mojibake once it reaches a terminal or the worker's own model,
// and is never anything a person actually typed into a verdict. Backs off
// by exactly one code unit (never more) when the cap would split a pair --
// so the rendered reason is 4000 code units long ordinarily, 3999 in that
// one edge case, and the "cut to N characters" line always names whichever
// it actually is, never a number that does not match what is printed.
function cutWithoutSplittingSurrogatePair(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const charBeforeCut = text.charCodeAt(maxLength - 1);
  const charAtCut = text.charCodeAt(maxLength);
  const wouldSplitPair = charBeforeCut >= 0xd800 && charBeforeCut <= 0xdbff && charAtCut >= 0xdc00 && charAtCut <= 0xdfff;
  return text.slice(0, wouldSplitPair ? maxLength - 1 : maxLength);
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

  // Batch 19 mini-phase 2A (ruling 37): "buildWorkerPrompt's first line
  // names the profile" -- absent for a profile-less ticket. The rendered
  // `--append-system-prompt` line (claudeCli.ts) already tells the worker
  // WHO it is at the OS-process level; this is the same fact restated as the
  // prompt's own opening line, so it survives even if a future adapter never
  // wires the flag.
  if (envelope.profile) {
    sections.push(`You are ${envelope.profile.name}, ${envelope.profile.purpose}.`);
  }

  sections.push(`Project brief:\n${envelope.projectBrief || '(none provided)'}`);

  sections.push(
    envelope.relevantDecisions.length > 0
      ? `Relevant decisions:\n${envelope.relevantDecisions.map((d) => `- ${d}`).join('\n')}`
      : 'Relevant decisions: (none)'
  );

  sections.push(`Ticket: ${envelope.title}\n${envelope.description}`);

  // Batch 18 ruling 32: a retry is told why the last attempt did not stand,
  // ahead of the criteria it must now meet. A first attempt has none.
  if (envelope.previousAttempt) {
    const reason = envelope.previousAttempt.reason;
    const wasCut = reason.length > PREVIOUS_ATTEMPT_REASON_CHAR_CAP;
    const renderedReason = wasCut ? cutWithoutSplittingSurrogatePair(reason, PREVIOUS_ATTEMPT_REASON_CHAR_CAP) : reason;
    sections.push(
      `Previous attempt ${envelope.previousAttempt.status}: ${renderedReason}` +
        (wasCut
          ? `\n(cut to ${renderedReason.length} characters; the original reason was ${reason.length} characters long)`
          : '') +
        '\nDo not repeat it: fix exactly what is named above, and do not present anything as finished that it names as missing.'
    );
  }

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

  // Batch 15 item 4: absent (not present as an empty list) is a real
  // distinction, not an equivalent rendering of "no artefacts" -- a ticket
  // with no `expectedArtifacts` list at all keeps today's rule (any
  // artefact satisfies "done"), so this section only exists when the
  // ticket actually declared one.
  if (envelope.expectedArtifacts !== undefined) {
    sections.push(
      `Expected artifacts: this ticket must produce every one of these, exactly, or DONE is rejected:\n${envelope.expectedArtifacts
        .map((a) => (a.kind === 'file' ? `- (file) ${a.path}` : `- (${a.kind})`))
        .join('\n')}`
    );
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

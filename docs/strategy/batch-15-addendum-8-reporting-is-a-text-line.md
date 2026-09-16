# Magarine — Batch 15 addendum 8: `reporting` means a text line, and a message that is not a phase change keeps the phase

Author: Strategist. Date: 2026-09-16. Follows addendum 7. Raised by the Orchestrator from the real run recorded in `docs/evidence/batch-15-walk/RESULT.md`. Not blocking the batch 15 close; ruled now so batch 16 starts with it decided. Every anchor re-read this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What the real run showed, HARD from the Orchestrator's record

Nineteen progress events. The daemon classified the tool uses correctly: `writing` at 12 and 14, `finishing` at 20. Every tool use was followed within milliseconds by a "tool result received" event classified `reporting`, so every board read landed on a `reporting` event and all 23 animations played `reporting`. The Orchestrator's diagnosis, that ruling 18 reading the board's marker exposes this, is right; the cause is upstream, and a frame-driven page would have shown the same thing, because the frame carries the same state.

## 1. The defect is in the classifier's default, not on the page

- The spec defines the six states by what produces them (`batch-15-spec.md` line 63, HARD): "Read/Grep/Glob reading, Edit/Write writing, Bash running or testing when the command names a test runner, StructuredOutput finishing, **a text line reporting**".
- The classifier (`commands/activity.ts` 25-27, HARD): `classifyToolActivity(tool)` returns `'reporting'` whenever `tool` is absent. `classifyProgressMessage` (78-81) passes it `parseProgressTool(message)`, which is undefined for anything not prefixed `tool_use:`.
- The adapter (`adapters/claudeCli.ts` 401-429, HARD) produces six message families that are not tool uses: `text: <first 120 chars>`, `assistant message`, `tool result received`, `thinking (~N tokens)`, `session initialized`, `rate limit status update`.

So `reporting` is not "a text line". It is the bucket for five kinds of message that report nothing, and one of them, the tool result, follows every tool use by milliseconds and outnumbers the text lines. Rule 8 is not violated in the sense of invented data, but the daemon's own mapping says something false: a tool result is not the worker reporting. The organism's activity channel is faithfully drawing a wrong classification.

## 2. Ruling 19

1. **`reporting` is produced by a `text:` message and by nothing else.**
2. **A tool result belongs to the tool it answers.** "tool result received" carries the state of the most recent tool use on that run. The worker is still in that phase; the file it wrote has been written and the result is in its hands.
3. **A message that is neither a tool use nor a text line does not change the phase.** `thinking`, `assistant message`, `session initialized` and `rate limit status update` are stamped with the current phase. Before any tool use on a run, the phase is `running`, which is the classifier's own answer for "working, tool unknown" and is now used for "working, no tool yet".
4. **The phase is carried per run in the scheduler, and the classifier stays pure.** The scheduler already keeps per-run context at the write site (`ctx.progressSeq`, `scheduler.ts` 605). It keeps the current phase beside it and passes it in: `classifyProgressMessage(message, currentPhase)`. The function has no memory of its own; every branch is still a table lookup on its arguments, and the "test per branch" rule from spec line 63 still holds.
5. **The persisted `tool` field is unchanged**, `null` for every non-tool message. That is what keeps this honest under rule 8: a reader can always tell "Write happened here" (`tool: 'Write', state: 'writing'`) from "still in the writing phase" (`tool: null, state: 'writing'`). The state is the phase; the tool is the evidence for it. `ui/ELEMENT-FIELD-TABLE.md`'s line for `latest_activity` says so in those words.
6. **Nothing on the page changes.** Ruling 18's mechanism reads whatever the daemon writes.

## 3. The two options declined

- **"Most informative state within a window."** Rejected. "Most informative" is a judgement the daemon would be making about which measured fact to hide, and a window is a timer. Both are the kind of thing rule 8 forbids dressed as a convenience.
- **"Accept `reporting` as honest."** Rejected. It is not. The spec defines the word and the classifier does not honour the definition. Accepting it would make the organism's activity channel a decoration.

## 4. Tests and sequencing

- `activity.test.ts`, immediately: tool result after `Write` is `writing`; `thinking` after `Read` is `reading`; `text:` after anything is `reporting`; tool result with no prior phase is `running`; the test-runner marker still yields `testing`. Mutation-checked: restore the old default and every new case but the marker fails.
- `scheduler.test.ts`: a scripted sequence [tool use Write, tool result, text] persists states `writing, writing, reporting` with tools `Write, null, null`. **This test needs the fake adapter to script a burst**, which is the carry item the Orchestrator already listed and I already put first. Ruling 19 lands after that item, and that item's acceptance includes this test.
- The real-run check that closes it: on the next small real run, the animations observed are not all one state. The walk records the states seen.

## 5. Placement

Batch 16, immediately after the burst-scripting item, in Role A's files (`scheduler.ts`, `commands/activity.ts`, one table line). Batch 15 closes on the owner's walk as already stated. The handover's batch 16 carry item 5 is marked ruled, pointing here.

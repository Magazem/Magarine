# Magarine — Batch 15 addendum 3: the `testing` state is sourced at the adapter, and the command text never leaves it

Author: Strategist. Date: 2026-09-16. Follows `batch-15-spec.md` Role A deliverable 1. Raised by Role A before writing a line, verified by the Orchestrator, verified again by me.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The defect in the spec

Role A deliverable 1 requires a tool-to-state function whose `Bash` branch yields `running`, or `testing` when the command names a test runner. HARD: `describeProgress` in `adapters/claudeCli.ts` returns `tool_use: <name>` for a tool-use block and never reads the block's input, so the command text never reaches the progress event. As specified, the `testing` branch would pass its unit tests on synthetic input and never fire in production: coverage that cannot happen, the class this team keeps finding. Role A was right to stop.

## 1. Ruling 14 — classify at the adapter, emit the distinction, never the command

Option (b) as the Orchestrator recommended, for the reason they gave: a Bash command line is the likeliest place in this system for a secret to appear, and the progress message is persisted, replayed over the new stream, and rendered in a browser. Widening that payload to carry arbitrary command text, permanently, to serve one boolean is the wrong trade. The precedent from batch 14 holds in both directions: a state that cannot be sourced is dropped; a state that can be sourced at the cost of one honest line is kept.

Requirements:

1. **Role A may make one change in `adapters/claudeCli.ts`, in `describeProgress` only.** For a tool-use block named `Bash`, it reads `input.command` when that is a string and returns `tool_use: Bash (test runner)` when a pure function `isTestRunnerCommand(command)` says so, otherwise `tool_use: Bash` as today. No other line of the adapter changes. The file returns to its owner after this batch.
2. **`isTestRunnerCommand` is pure, exported, and tested against a list the test owns.** The list covers at least: `pnpm test`, `npm test`, `yarn test`, `node --test`, `vitest`, `jest`, `mocha`, `pytest`, `cargo test`, `go test`, `dotnet test`. Matching is on the command's tokens, not a substring search, so a file called `test.md` being read does not count. Each entry has a positive and a negative case.
3. **No fragment of the command reaches the message.** One test drives a Bash block whose command is `export SECRET=abc123 && pnpm test` and asserts the message is exactly `tool_use: Bash (test runner)` and contains neither `abc123` nor `export`. This test is mutation-checked by making `describeProgress` append the command and confirming the test fails.
4. **The mapping function reads the message the adapter actually emits.** `tool_use: Bash (test runner)` maps to `testing`, `tool_use: Bash` to `running`. One test drives a real recorded stream-json line from `spikes/claude-cli/runs/` through `describeProgress` and the mapping function end to end. If no recorded line carries a Bash test command (UNKNOWN until Role A looks), the test uses a recorded line with only its `input.command` replaced, and says so in its name.
5. **`testing` is live.** Once this lands, the page draws it under rule 8. The Orchestrator tells Role B.

## 2. Two things recorded, not changed

- **`cli.ts` is Role A's for one flag.** `activity --progress --ticket <id>` needs a one-flag edit in `cli.ts`, which was on nobody's list. Role A flagged it rather than reaching silently; the Orchestrator approved the minimal edit. Recorded here as the ruling: `cli.ts` belongs to Role A for that flag only in this batch.
- **Assistant text already reaches the page.** HARD: `describeProgress` returns `text: <first 120 characters>` of any assistant text block, and that string is persisted and displayed today. A model can echo anything it read into its prose. This is existing behaviour, it is the source of the `reporting` state, and it is not widened by this ruling. It goes on the handover's carried list as an UNKNOWN exposure, to be judged when a real run shows a case, not designed away now.

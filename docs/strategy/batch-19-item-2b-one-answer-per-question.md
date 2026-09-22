# Magarine — Batch 19, mini-phase 2B: one answer field per Manager question

Author: lead. Date: 2026-09-22. Tree at `951fabf`. Amends `batch-19-spec.md` section 4's 2B outline.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What exists, HARD

- `managerApply.ts` 173-177 and 268-292: N `request_user_decision` commands fold into ONE
  `worker_needs_user_decision` transition whose `summary` is the questions joined with `; ` and whose
  `blockers` is `"<question> (<context>)"` per question. `questions: []` is written empty.
- `commands/decide.ts` 32-35 `extractQuestionText` joins `blockers` with `; `; `decide` 37-59 takes
  one `answer` and writes ONE `user_decision` event `{ ticketId, question, answer }`, BLOCKED to READY.
- Consumers of that one pair: `managerEnvelope.ts` 122-128 `buildDecisionLog` (`Q: … — A: …`),
  `scheduler.ts` 156 `relevantDecisions`, `commands/conversation.ts` 55, `commands/inbox.ts` 89 `reasonFor`.
- Route: `POST /tickets/{id}/decide` with `{ answer }` (`daemonApi.ts` 411-417).
- The result contract already has `questions: string[]` (`resultContract.ts` 99, `types.ts` 260).

## 1. Ruling 36 — one question, one answer, submitted together

- `managerApply` writes `questions` as the list of question texts (one per `request_user_decision`,
  in proposal order, each `"<question> (<context>)"`, the same text `blockers` carries). `summary` and
  `blockers` are unchanged, so every existing consumer keeps working.
- **The pending questions of a BLOCKED ticket** are one function, in `decide.ts` beside
  `extractQuestionText`: the latest `worker_needs_user_decision` payload's `questions` if non-empty,
  else a one-element list of `extractQuestionText(payload)`. So a worker's BLOCKED ticket, and every
  existing BLOCKED row, is a one-question ticket. No migration.
- `decide` accepts `answer` (string) OR `answers` (string[]), never both. With N pending questions,
  `answers` must have exactly N non-empty entries, else `DecideError` with one sentence naming N.
  `answer` is legal only when N is 1. **All N are submitted at once**; there is no partial answer
  persisted while BLOCKED (that would need a new event and a draft state for a gain the page gets
  anyway by drawing N fields and one button).
- Still ONE `user_decision` transition. Its payload keeps `question` and `answer` (the joined texts,
  `; `-separated, so old readers still read sense) and gains `decisions: [{ question, answer }]`.
- `buildDecisionLog` and `scheduler.ts`'s `relevantDecisions` render one `Q: — A:` line per entry of
  `decisions` when present, else the old single pair. Old events render exactly as today.
- CLI: `decide --ticket <id> --answer "a"` unchanged; repeated `--answer` flags, in order, become
  `answers` (the flag parser, `cli.ts` 119, gains repeat support for `answer` only if it lacks it).
- Route: `POST /tickets/{id}/decide` accepts `{ answer }` or `{ answers }`; both, neither, or a
  wrong count is 400 with the one sentence.
- Wherever the page reads the pending question (the inbox item for a BLOCKED ticket and the
  conversation entry from `conversation.ts` 55), the JSON also carries `questions: string[]` from the
  one function, so the page (mini-phase 3B) can draw one field per question. The existing text field
  stays.

## 2. Acceptance

1. A proposal with three `request_user_decision` commands yields a BLOCKED manager ticket whose
   pending questions are exactly those three, in order.
2. `decide` with 2 answers on that ticket fails naming 3; with 3 it unblocks, and the payload's
   `decisions` pairs each question with its own answer.
3. The next Manager envelope's decision log shows three `Q: — A:` lines; a pre-2B `user_decision`
   event still renders as one line, unchanged (test with a hand-written old-shape event).
4. A worker-BLOCKED ticket has one pending question and `decide --answer` works as before.
5. CLI repeated `--answer` and the route's `answers` both reach the same path; `answer`+`answers` is 400.
6. Inbox and conversation JSON carry `questions`.
7. Suite passes; mutations each fail a test.

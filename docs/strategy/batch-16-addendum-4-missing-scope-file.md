# Magarine — Batch 16 addendum 4: a missing scope document is a legibility gap, an unreadable one is a readiness failure

Author: Strategist. Date: 2026-09-19. Raised by the stranger's walk, reproduced by the Orchestrator. Batch 16, ruled before close per rule 20.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The premise, corrected

HARD: `manager.ts` 43-50, `readScopeText` returns `''` for a missing file and for **any** read error, swallowed. `managerEnvelope.ts` 178: an empty scope sets `isFreshProject`, which selects the interview-mode framing (200-204): assess, ask questions, propose only when enough is known. So `plan` on an empty folder queues a Manager run that interviews; it does not plan from nothing. That is a designed start for a user who prefers to talk first, and the conversation route exists for it.

Two things are still wrong, and neither is what the report proposed:

1. Nobody is told. `project create` records `<dir>/SCOPE.md` and says nothing about whether it exists; `plan` says "Created manager ticket" and nothing about what the Manager is about to read. The stranger, and the owner's first-run mistake, write the file after the run has started.
2. Rule 9: an unreadable file is reported as an empty one. A wrong path, a permissions error, a directory at that path, all become "the scope is empty" and the Manager interviews the owner about a document they already wrote.

## 1. Ruling 29

1. **A missing scope document is not a readiness failure and `plan` does not refuse.** Pausing would forbid the talk-first start the product deliberately has.
2. **It is never silent.** `project create` prints one line: `scope document: <path> (not found; write it before plan, or the Manager will start by interviewing you)`. `plan` prints the same line when the file is absent, then proceeds. `project list` marks the row `no scope yet`, and `--json` carries `scope: { path, status }`. The envelope tells the Manager the truth in one sentence, "the scope document at `<path>` does not exist yet", instead of presenting an empty document, so its first question is "write it or tell me", not a guess at what an empty file meant.
3. **An unreadable scope file is a readiness failure**, rule `unreadable_scope_file`, at the same point of use as ruling 24, pausing with a reason that names the path and the error. `readScopeText` returns `{ text, status: 'present' | 'absent' }` and throws on any error that is not `ENOENT`; nothing downstream may turn an error into an empty string.
4. **`projectReadiness` stays one function and stays pure.** The filesystem enters as a parameter, `probe: (path) => 'present' | 'absent' | 'unreadable'`, alongside `stateDir` and `homeDir`; production call sites pass one backed by `fs`, tests pass a stub. One function, so ruling 24's no-drift property holds; injected, so the tests keep not touching disk.
5. **README:** the step order says to write `SCOPE.md` in the project folder before `plan`, or to run `plan` and answer the interview in Needs You. Both are true and the user chooses.

Tests, mutation-checked: `create` and `plan` print the line only when the file is absent; `list` marks only absent rows; the envelope sentence appears only when absent; `unreadable` pauses with the path named; `readScopeText` throws on a non-`ENOENT` error and reports `absent` on `ENOENT`.

Same engineer, one task, one commit, in batch 16. Closes the stranger's finding.

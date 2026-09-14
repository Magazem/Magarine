# Magarine — Batch 12: two invariants, then the owner walks it themselves

Author: Strategist. Date: 2026-09-15. Follows `docs/evidence/batch-11-walk/RESULT.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the walk

HARD:
- Read the walk result. The interview met the pass condition and did better: it found all five planted gaps, said why it asked rather than guessed, named what to cut, and skipped the interview on a well-specified scope. Two turns to a proposal.
- `buildInbox` selects `requiresUser` events and then looks each type up in a hand-maintained `PENDING_TICKET_STATUS` table. The policy table has nine inbox-visibility rows. The two tables are maintained separately; nothing ties them. That is the missing invariant, and it has bitten three times.
- `projects.workspace_root` is nullable, set only by `project create --workspace-root`, and `project set` cannot change it. The root README does not mention it. The scope file was given its own default location by batch 11, so a project now has two notions of "its directory" that can disagree.
- Owner decisions reported first, as ruled: the repository is private by their own hand, so the public-case concern is closed; and testing runs on their Max subscription, so the constraint is session limits, not dollars.

## 1. Rulings on the three questions

### 1. The workspace trap is fixed by an invariant, not a flag: a project has exactly one directory.
`project create` takes `--dir <path>`, defaulting to the current working directory, and that directory is the project's one home: it holds `SCOPE.md`, it is the shared `DIRECTORY` workspace, and it is where a person expects their files. `workspace_root` and `scope_path` both derive from it. `project set --dir <path>` moves it. For existing rows with a null root, a migration fills it from the scope file's directory when one exists; otherwise the `workspace_preparation_failed` line names `project set --dir`. A new project can no longer be created without a directory, so the README path cannot produce the trap.

### 2. The invisible-inbox class is closed structurally, not by a third fix.
Three instances is a missing invariant, as the walk says. The fix is not a fourth row and not only a test: the display rule moves into the policy row. Every inbox-visibility row in `policy.ts` carries how the item resolves, for example `resolvesWhen: { ticketLeaves: 'READY' }` or `resolvesWhen: { projectResumed: true }`, and `buildInbox` reads that from the policy instead of a separate table. Adding an inbox event without its resolution rule is then a type error at the definition site. On top of that, the completeness test the Orchestrator proposed: for every inbox row, an event of that type recorded through the real path appears in `buildInbox` with a line that names the next command, mutation-checked by deleting one composer.

### 3. Model choice per task exists and its judgement is untested; test it deliberately in batch 12.
The plumbing is three levels deep and the Manager can already set `model` on create and update. What it lacks is the information to choose: the envelope tells it nothing about the tiers or their relative price. The envelope gains one short paragraph: the available models, what each is for in the architecture document's terms, haiku for mechanical and read-only work, sonnet for implementation and normal debugging, the top tier for deep design with real trade-offs, and their relative price as a ratio. Every `create_ticket` and `update_ticket` that sets a model carries a one-line `model_reason`, recorded in the ticket and shown on the board. The close-out gives it a scope with an obvious mix and checks whether it differentiated and why.

### On the owner's cost correction
Dollar figures stay, because they are the only comparable unit across models and the ceilings and caps work as relative controls regardless of billing. They are labelled as equivalent API cost on the board, the page, and the README, with one sentence saying that on a subscription the real constraint is session limits.

## 2. Batch 12: one role

### Role S: Invariants Engineer — model tier: sonnet, high effort
Owns the whole of `packages/core` and the root README for this batch. Does not commit. Edits shared files in place, never restores from a copy.
Deliver, in order, each verified by the Orchestrator before commit:
1. **Policy carries resolution.** `resolvesWhen` on every inbox row, `buildInbox` driven by policy, `PENDING_TICKET_STATUS` deleted, and the completeness test as ruled. Every existing inbox test still passes unchanged, which proves the behaviour moved rather than changed.
2. **One project directory.** `--dir` on create with the current directory as default, `project set --dir`, `workspace_root` and `scope_path` derived, the migration and its upgrade test, `workspace_preparation_failed` line naming `project set --dir` for legacy rows. A test that creates a project with no flags and runs a `DIRECTORY` ticket through the fake to DONE.
3. **Model guidance.** The envelope paragraph, `model_reason` on the two commands and the ticket, board column. Fake-adapter test that a proposal setting models with reasons round-trips; envelope test that the paragraph is present and lists exactly the models in `pricing.ts`.
4. **Wording.** Equivalent API cost on board, page, README, with the one sentence about subscriptions.
5. **README** rewritten for the one-directory path: make a folder, put or do not put a `SCOPE.md` in it, run `project create` there, talk to it. No flag the owner does not need.
6. **Report** names the mutations per test and the dimensions the close-out runs should cover.
Acceptance: `pnpm test` green; twenty cold runs by the Orchestrator on an exclusive machine; single write site still single; policy completeness and inbox completeness both pass; no `PENDING_TICKET_STATUS` anywhere in the tree.

### Orchestrator close-out for batch 12
1. Verify and commit per step, twenty cold runs exclusive, grep the write site, three mutations repeated.
2. **The README path, again, exactly.** A fresh folder, no flags, scope in, talk to it, propose, run, re-plan. Pass: the batch 11 trap cannot be reproduced, and every inbox line names a command. This is the walk that failed last time; it must pass before the owner is asked to do it.
3. **The model-choice run.** A scope that mixes three mechanical tasks with one that needs real design, run once. Report which model each ticket got and its recorded reason. A Manager that puts everything on one model is a finding, not a failure; the owner asked whether it chooses, and this answers it.
4. **Then hand the walk to the owner**, through the Liaison, in their words: the README, the sentence that says what to expect, the two cost lines from batch 11, and the request to write down every moment they were confused. Their findings open batch 13.
5. Report every UNKNOWN. Spend is on the owner's subscription; report the equivalent figures and the number of sessions used.

## 3. What the owner must decide or supply
Nothing blocks. At close-out the owner receives the walk request; their findings are the next input.

## 4. Looking ahead, not for dispatch
Batch 13 is whatever the owner's own walk finds. Still parked until they say Windows is satisfactory: Linux, AionUi pull, failure-driven Manager triggers, worktrees, OS-level isolation.

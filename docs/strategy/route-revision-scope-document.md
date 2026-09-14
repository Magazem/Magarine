# Magarine — Route revision: the product is "work a scope document with it"

Author: Strategist. Date: 2026-09-14. Triggered by the owner's statement: "I would give it an md file with a project scope, something similar to how we started this whole project and work on it with it".
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 1. What the owner described, read against what exists

The owner wants to hand Magarine a markdown scope document and work the project from it, iteratively, the way this project itself was run: a document went in, it was read cold and judged, questions came back, batches were proposed, results were reviewed, the plan was corrected, and so on.

HARD, what exists: projects with a brief, tickets with dependencies and budgets, real workers, cost per run, an inbox that asks the owner things, a Manager that reads the board and proposes typed commands once, and a daemon with an API. SOFT: every piece the owner's sentence needs is present in some form; none of them is joined into the loop the owner described.

What is missing, exactly:
1. **The input is a document, not a sentence.** `plan --mission` takes a line. The owner will give a file, long and structured, and expects the plan to derive from it, and to be able to edit the file and plan again.
2. **The first reaction should be a judgement, not tickets.** This project began with a verdict and questions before any batch. The Manager can already `request_user_decision`; it should be asked, on a fresh scope, to assess first: what is sound, what is unclear, what it would cut, and which questions it needs answered, and only then propose a first batch of tickets.
3. **Re-planning against progress.** The Manager proposes once today. "Work on it with it" means: run a batch, look at results and failures, correct, plan the next. The Manager envelope already carries the board, decisions, and recent final failures; what is missing is the habit of calling it again, and the commands to adjust what exists: `cancel_ticket`, `update_ticket` (title, description, acceptance, budget, model), alongside the five it has.
4. **A conversation channel the owner opens.** The inbox answers questions the system chose to ask. The owner needs to raise their own: "drop the export feature", "why did you split it this way", "focus on the parser first". That is a Manager invocation whose envelope includes the owner's message and whose output is a written reply plus an optional proposal. The reply is shown where the owner looks, the page and the inbox, and recorded as a decision when it changes the plan.
5. **A place to see all of this.** Role Q's page is where the owner will live. It needs, eventually, the assessment, the conversation, and the proposals, not only the board.

## 2. The ruling

The substrate is right and stays. The route changes in emphasis: after Role Q, the next batch is not Linux, not AionUi, not automatic triggers. It is the loop the owner described, built on what exists:

**Batch 11, "Work from a scope document":**
- `project create --scope <file.md>` stores the document's path; every Manager invocation reads the current file, so the owner edits the document and plans again.
- `plan` on a project with a scope and no tickets runs the Manager in assess mode: a written assessment as an artefact, questions as `request_user_decision` items, and a first proposal. `plan` on a project with tickets runs it in re-plan mode against the board, the decisions, and the failures.
- `discuss --project <id> --message "<text>"` runs the Manager with the owner's message; the reply is an artefact shown on the page and in the inbox; any proposal in the reply is validated and applied like any other.
- The command set gains `cancel_ticket` and `update_ticket`, validated and applied under the same caps and transaction.
- The page shows the assessment, the conversation thread, and each proposal's rationale next to the board.
- Every Manager invocation is a costed manager ticket, as today, so "working with it" has a visible price.
- The owner walk for that batch is the owner's own use case: hand it a scope document, read its assessment, answer its questions, let it run a batch, tell it something, watch it adjust.

Parked until the owner is satisfied with Windows: the Linux leg, the AionUi pull shape, automatic Manager triggers, `GIT_WORKTREE`, OS-level isolation.

## 3. One question for the owner, non-blocking
"When you give Magarine a scope document, do you want its first reply to be a critique and a list of questions before it proposes any tickets, the way this project started, or do you want tickets straight away?"

## 4. The owner's answer, and what it changes in batch 11

Verbatim: "it depends on what i tell it, sometimes i would create the md with it not just give it the .md, depends on each project where is the starting point honestly but generally i would prefer it to interview me first about any missing context instead of assuming it."

Three changes to the batch 11 shape above, decided here:

1. **Interview first is the default, and questions alone are a success.** On a fresh project the Manager's first invocation may return only questions and no proposal; that is the intended outcome, not a stall. The assessment says what it understood, what it would cut, and what it needs to know. It proposes tickets only when it says it has enough, and the owner can say "propose now" at any time through `discuss`.
2. **The scope document is an output as well as an input.** The scope file lives at a known path in the project, `SCOPE.md` under the project's directory unless `--scope` names an existing file. A project may be created with no scope at all; the first `discuss` then starts the interview from nothing, and the Manager gains one command, `update_scope { content }`, which writes the whole file and records the change as a decision event with a one-line summary of what changed. The owner may edit the file by hand at any time; every invocation reads the current file. `update_project_brief` from the architecture document becomes this command.
3. **A conversation turn re-invokes the Manager.** `discuss` and `decide` on a project in the interview phase trigger one Manager invocation per owner message, under the per-project daily cap that automatic triggers were always going to carry. This is owner-initiated, so it is not the failure-driven loop that stays parked. Each turn is a costed manager ticket; the page and the board show what the interview cost.

The owner walk for batch 11 is now: create an empty project, talk to it, answer its questions, watch the scope file appear and grow, tell it to propose, run the batch, correct it, and plan again.

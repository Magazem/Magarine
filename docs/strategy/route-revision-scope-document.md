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

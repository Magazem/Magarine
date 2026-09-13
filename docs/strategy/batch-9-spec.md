# Magarine — Batch 9: the Manager invocation, and three pieces of housekeeping

Author: Strategist. Date: 2026-09-14. Follows `batch-8-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read the open items and questions of `batch-8-closeout.md`; thirty-seven commits on top of the upload, tree clean.
- The README now documents daemon mode, `daemon.json`, the API, the single-writer rule with its one exception, the two cancellation transitions, and crash recovery.
- The concurrency cap is per project. The daemon ticks every project, so a machine-wide limit does not exist.
- The architecture document's Manager section (read in batch 0, HARD) lists the typed commands `create_ticket`, `add_dependency`, `change_priority`, `request_user_decision`, `update_project_brief`, and says the orchestrator validates and applies them, and that the Manager is called only for mission decomposition, ambiguous blockers, material plan changes, explicit user requests, or scheduled reviews. Batch 0's cost ruling replaced the document's long-lived Manager session with a fresh invocation that rebuilds its brief from the database.

## 1. Rulings on the three close-out questions

1. **The EPERM flake and the global cap both go to Role N**, the single role of this batch. The cap becomes machine-wide at the daemon: `serve --max-parallel` is the ceiling across all projects, and a project's own cap is the smaller of the two. `run --until-idle` keeps the per-project cap since it runs one project.
2. **Document the Windows behaviour; do not refuse to start.** A daemon that refuses to run because of an honest limitation is worse than one that states it. `daemon.json` records the shutdown mode the platform can actually deliver, and the README says what a hard kill means, which crash recovery now handles including the workspace.
3. **Send the Ubuntu reminder now.** One message, the three original questions restated, no urgency implied.

## 2. Batch 9: the Manager invocation

### Why now
Both owner-gated legs are waiting. The Manager is the last piece of the architecture document that has not been built, and it is the piece that turns a ticket runner into an orchestrator: a mission goes in, tickets with dependencies come out, the daemon runs them. Everything it needs exists: envelopes, budgets, model pinning, artefact capture, the inbox, and a daemon to apply results.

### Design, decided here so one role can build it
- **A Manager run is a ticket.** Tickets gain a `kind` column: `work` (default) or `manager`. A manager ticket runs through the same adapter, so cost, budget, model pinning, retries, and the inbox all apply unchanged. Its workspace is `NONE`. Its artefact is a proposal file; the daemon applies the proposal when the run succeeds.
- **The Manager's envelope** is the project brief, the mission text, the current board in compact form (every ticket with id, title, status, kind, dependencies, attempts, spend), the decision log, the last five final failures with their reasons, and the command schema below. Nothing else: no transcripts, no worker prompts.
- **The command schema**, exactly the document's list: `create_ticket { title, description, acceptance_criteria[], depends_on[] (by title within this proposal or by id for existing tickets), workspace_type?, model?, max_budget_usd? }`, `add_dependency { ticket_id, depends_on_ticket_id }`, `change_priority { ticket_id, priority }`, `request_user_decision { question, context }`, `update_project_brief { brief }`. A proposal is a JSON object with `commands[]` and a `rationale` string, written to `.orchestrator/proposal.json` and declared as an artefact.
- **Validation and application, in one transaction.** Every command is validated against the schema and the current board before any is applied; one invalid command rejects the whole proposal as a malformed result, which is retryable and reaches the inbox on exhaustion with the validation errors. Caps: at most twenty commands and at most fifteen `create_ticket` per proposal, dependency cycles rejected, titles unique within a project. `request_user_decision` becomes an inbox item on the manager ticket itself; the other four apply directly. Everything applied is recorded as one `manager_proposal_applied` activity event carrying the full proposal, so replay reproduces it.
- **Trigger: explicit user request only.** `magarine plan --project <id> --mission "<text>"` creates the manager ticket and, if a daemon is up, it runs on the next tick; otherwise `run --until-idle` picks it up. The daemon route is `POST /projects/{id}/plan`. Automatic triggers on failures or on a schedule are not built; the document's other triggers wait until this one has been watched.
- **Model and budget for the Manager** come from the project like any ticket, with a project-level `manager_model` override defaulting to the project's default model. The Manager runs on Sonnet by default; the owner may pin it to Fable per project when a mission needs it, and the board shows what it cost like any ticket.
- **Manager tickets never block work tickets** and work tickets never depend on them; the dependency resolver refuses such edges.

### Role N: Manager and Housekeeping Engineer — model tier: sonnet, high effort
Owns the whole of `packages/core`. Does not commit.
Deliver, in this order, each verified by the Orchestrator before commit:
1. **Housekeeping first.** The EPERM cleanup race in `adapters/claudeCli.test.ts`, root-caused and fixed, twenty cold runs clean. The global cap at `serve`. The `daemon.json` mode field and README sentence per ruling 2.
2. **Schema and contract.** `tickets.kind`, `projects.manager_model`, migrations with upgrade tests; the proposal schema and validator in `proposal.ts` with a test per rule above, including cycle rejection and the caps.
3. **Envelope.** The Manager envelope builder, tested for exactly the listed contents and nothing from any worker prompt or transcript.
4. **Application.** The post-success step for manager tickets: validate, apply in one transaction, record the event; malformed proposal handled as a retryable malformed result. Fake-adapter tests for a valid proposal creating a small dependency graph, an invalid one rejected whole, a `request_user_decision` reaching the inbox, and replay reproducing the applied board.
5. **Spawned-pipeline test**, per the batch 8 standing rule: a recorded or synthetic tool output producing a proposal drives the real adapter classification and the application step end to end.
6. **Surfaces.** `plan` command, the daemon route, `board` showing manager tickets distinctly, README section "Planning a project".
Acceptance: `pnpm test` green, twenty cold runs by the Orchestrator, zero temp directories; single write site still single; policy completeness passes with the new event types.

### Orchestrator close-out for batch 9
1. Verify and commit per step, twenty cold runs, grep the write site.
2. **Paid run, the first mission-to-result loop.** Start the daemon with the Claude adapter on a project with a shared directory under temp, then run `plan` with a mission that naturally splits: "Write a short report on the differences between SQLite journal modes: one file per journal mode, each under three hundred words, and an index file that links them and is written last." Pass: the Manager proposes at least three work tickets with the index depending on the others, the proposal applies, the daemon runs them to DONE, the index links every mode file, every ticket's cost is on the board, and the Manager's own cost is shown as a manager ticket. Under three dollars (SOFT).
3. State which run covered which change, name masked paths, report every UNKNOWN and the spend, including the Manager's share.

## 3. What the owner must decide or supply
Nothing blocks batch 9. The Liaison sends the one Ubuntu reminder now.

## 4. Looking ahead, not for dispatch
Batch 10 is the Linux leg or the AionUi pull shape, whichever the owner unblocks first. After both: automatic Manager triggers on final failures, `GIT_WORKTREE`, OS-level worker isolation, a static status page served by the daemon.

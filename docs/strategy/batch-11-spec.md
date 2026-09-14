# Magarine — Batch 11: work from a scope document, with it

Author: Strategist. Date: 2026-09-14. Follows `batch-10-closeout.md` and `route-revision-scope-document.md` sections 2 and 4.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read the close-out's section list, rules, and open items; sixty-plus commits, tree clean, 20/20 cold runs on an exclusive machine, end to end proven at $0.72.
- `plan` accepts only `--project` and `--mission`. A project pause is one nullable column with no recorded reason; `resumeProject` flips it and records an event. The cap inbox line composes a reason but does not name the command that clears it.
- The browser page from the batch 10 addendum was not built; the Orchestrator held it behind the owner-walk fixes. That was the right call and it is not overturned.

## 1. Rulings on the three close-out questions

### 1. The two owner-walk findings open batch 11, before any new feature.
The owner who sets a small cap is the owner we have. Rules:
- **A pause records its reason**, `spend_cap` or `adapter_unavailable`, and the board's first line says `PAUSED: <reason>` with the command that clears it. READY under a pause is a lie and stops being printed as the whole story.
- **Raising the cap clears a cap-caused pause by itself** and says so. `project set --max-spend` on a project paused for `spend_cap` unpauses it and prints one line. An adapter pause stays manual because it needs a login; its inbox line reads: run `claude` once to log in, then `magarine resume --project <id>`.
- **The cap message names the fix.** The `project_spend_cap_reached` inbox line ends with: raise it with `magarine project set --project <id> --max-spend <usd>`.
- **`plan` gains `--budget`**, and the effective per-run ceiling for any ticket is the smallest of the ticket override, the project default, and what the cap still allows. When what the cap allows is below the floor, the cap event fires before any spawn with the line above. A one-dollar cap with a two-dollar default therefore **spawns at a one-dollar ceiling and fires no inbox item** — the healthy path gets no notification. **When the ceiling is shrunk by the cap, record an activity event on the run** (not an inbox item), so a run that stops early under a shrunk ceiling can be explained from the board without guessing.

  > **Correction, by the Strategist.** An earlier version of this rule ended: *"so a one-dollar cap with a two-dollar default produces one clear inbox item instead of a silent forever."* That contradicted the rule's own conditional — a one-dollar ceiling is far above the floor. The sentence described the old behaviour it replaces, not the new outcome. Role Q found the contradiction before building against it.

### 2. `claude` resolution on other machines: accepted risk, with the failure made legible.
No other machine exists and the owner has parked other users by their own priority. Mitigation now: `doctor` prints how `claude` was resolved, the path and which strategy found it; the adapter's spawn failure names the resolved path and the shim it came from; the README says to send that `doctor` line if a worker fails to start. Revisit when a second machine exists.

### 3. Role Q continues. The page is the first feature of batch 11.
The owner said in their own words that they are not sure any of this has a visual side. The page is on their path now, ahead of the Manager work, and Role Q builds it as specified in the batch 10 addendum, plus a conversation panel that the second role fills in.

## 2. Batch 11: two roles, one contract

Contract, so the roles do not need to talk:
- Role R exposes two functions in `manager.ts` and two daemon routes: `planProject(db, projectId, { budgetUsd? })` and `discussProject(db, projectId, message, { budgetUsd? })`, each creating and returning a manager ticket id; `POST /projects/{id}/plan` and `POST /projects/{id}/discuss`. Role Q calls only these.
- The Manager's reply to a discussion is an artefact of kind `manager_reply` with the text; questions are `request_user_decision` items; scope changes are `update_scope` commands. Role Q renders artefacts of that kind and decision items in the conversation panel, newest last, with the owner's own messages interleaved from the `discuss` events.
- Any part of Role Q that depends on Role R is a part 2, dispatched after Role R's commit and driven by hand at the join before commit.

### Role Q: Owner Experience Engineer, continuing — model tier: sonnet, high effort
Owns `cli.ts`, `commands/`, `ui/`, `paths.ts`, `store.ts` for the pause reason column and migration, `scheduler.ts` only for the cap-versus-floor check and the pause reason, the root README, and their tests. Does not commit.
Part 1, in order:
1. The four rules in ruling 1, each with a CLI test and the cap-versus-floor case through the spawned pipeline with the fake.
2. `doctor` and adapter failure legibility per ruling 2.
3. **The page**, as in the batch 10 addendum: served at `/`, plain HTML and script, no build step, token in session storage, board, inbox, activity, the existing actions as buttons, inbox reasons in full, refresh every few seconds, and a conversation panel that shows the project's scope file as text and a message box wired to nothing yet, marked as such in the source.
Part 2, after Role R lands:
4. `plan --scope <file>` and `discuss --project --message`, the message box wired to `discussProject`, the panel rendering replies, questions with an answer box wired to `decide`, and `update_scope` changes; `project create --scope <file>` and the default `SCOPE.md` under the project directory.
5. README: the owner's sentence as the worked example, interview first, and where cost shows.
Acceptance: `pnpm test` green; twenty cold runs by the Orchestrator on an exclusive machine; the page driven in a real browser by the Orchestrator with screenshots; every inbox line names the next command, checked by reading every composer in `inbox.ts`.

### Role R: Manager Behaviour Engineer — model tier: sonnet, high effort
Owns `manager.ts` (new), `proposal.ts`, `envelope.ts` for the Manager envelope, `scheduler.ts` for the manager post-step, `adapters/fakeAdapter.ts` for the outcomes it needs, the daemon's two routes, `policy.ts` rows, migrations for `projects.scope_path`, and their tests. Does not commit.
Deliver, in order:
1. **Scope as file.** `projects.scope_path`, defaulting to `SCOPE.md` under the project directory and created empty when absent; every Manager invocation reads the current file into the envelope; `update_scope { content }` replaces `update_project_brief`, writes the file whole, and records a `scope_updated` decision event with a one-line summary. Owner edits by hand are simply read next time.
2. **Interview mode.** On a project whose scope is empty or which has no tickets, the Manager envelope asks for an assessment first: what it understood, what it would cut, and the questions it needs answered; it may return questions only. It proposes tickets when it states it has enough, or when the owner's message says to propose. The assessment is an artefact of kind `manager_assessment`. Questions are `request_user_decision` items as today.
3. **Discussion.** `discussProject` records the owner's message as a `discuss` event, builds the envelope with the conversation so far, the scope, the board, decisions, and recent final failures, and runs one Manager invocation whose result may be a reply, a proposal, or both. A `decide` during the interview also re-invokes once. Cap: a per-project daily maximum of Manager invocations, default twenty, with an inbox item when reached.
4. **Commands.** `cancel_ticket` and `update_ticket` added to the proposal schema and applier, under the existing caps and transaction, `update_ticket` limited to title, description, acceptance criteria, budget, and model, never status.
5. **Re-plan mode.** `planProject` on a project with tickets runs against the board, and its proposal may cancel, update, add, and re-order.
6. **Tests**, each mutation-checked with the mutation named in the report: fake-adapter tests for every mode and command; a spawned-pipeline test per new artefact kind and command with synthetic tool output built from recorded shapes; the daily cap; the envelope proven to contain the current scope text and nothing from any worker prompt or transcript.
Acceptance: `pnpm test` green; twenty cold runs on an exclusive machine; single write site still single; policy completeness passes.

### Orchestrator close-out for batch 11
1. Verify and commit each role's steps in sequence; twenty cold runs on an exclusive machine; grep the write site; repeat three mutations per role.
2. **The owner walk is the owner's own sentence, paid:** create an empty project, open the page, talk to it, answer its questions, watch `SCOPE.md` appear and grow, tell it to propose, let the daemon run the batch, tell it to change something, watch it re-plan. Every step where you needed something the README did not say is a finding. Every inbox line must name the next command. Estimate four dollars (SOFT: five interview turns, one small batch, one re-plan).
3. Screenshots of the page at each stage in the close-out.
4. State masked paths, every UNKNOWN, and the spend, including the Manager's share.

## 3. What the owner must decide or supply
Nothing blocks. Non-blocking for the Liaison: this batch's owner walk spends up to four dollars; say if that is not fine.

## 4. Looking ahead, not for dispatch
After batch 11 the owner is asked, through the Liaison, to do the walk themselves on their own scope document and say what is missing. Their findings shape batch 12. Linux, AionUi, automatic failure-driven triggers, worktrees, and isolation stay parked until they say Windows is satisfactory.

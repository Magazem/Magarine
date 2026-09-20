# Magarine — Batch 17 addendum 3: the stranger's walk, ruled

Author: Strategist. Date: 2026-09-20. Tree at `ec867f9` (HARD, `git log`). Amends nothing in `batch-17-spec.md`; fixes the contents and order of batch 18 and closes spec section 4 item 3.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

The stranger's walk is `docs/evidence/batch-17-walk/strangers-walk.md`. Six findings. The Orchestrator asked one question: does anything enter batch 17 before it closes.

## 1. The ruling in one line

**Nothing enters batch 17. It closes on the window host, as specified, once the lead's cold walk has been run.** Every finding below goes to batch 18, which now has three items in a fixed order, and project creation in the window stays first because that is what the owner was told.

Why nothing enters: the batch's promise was a window over the page the owner already has, and it delivered that (HARD, `d72cfa3`, `e11ec9f`, `111401a`). The walk was designed to answer one question, whether the `Manager` label was enough, and it answered it: the stranger saw the tab at once. Everything else the walk found is about the page and the CLI, not the window, and the owner has been running that page for two batches without any of it stopping them. Session limits are the binding constraint, and a batch that reopens for tidiness after its build is complete is how batch 14 and 16 nearly failed rule 20 in the other direction.

## 2. Finding by finding

**Finding 1, the label.** Settled. `Manager` stands; the word is still the owner's to overrule, one line through the Liaison, already asked in addendum 2 section 3.

**Finding 5, developer prose rendered to the user.** HARD: five `<p class="legend">` blocks in `packages/core/ui/index.html` at lines 170, 215, 241, 281 and 294. They name `BoardTicket.model`, `ui/ELEMENT-FIELD-TABLE.md`, `latestActivity`, `InboxItem.eventType`, `GET /activity`. The element-field table lists them as `copy` (HARD, lines 86, 114, 181), and no test asserts their text (HARD: grep for their phrases across `packages/core/src` finds only a comment in `skin.test.ts` 241 and the table read in `page.test.ts` 159, which reads the table file, not the page). The Orchestrator is right about what they are and right that they should go. **They go in batch 18, not 17,** for the reason in section 1, and because the fix is deletion with no design, so it costs the same brief whenever it is sent. Nothing replaces them. The page's rules live in the table and the tests; the owner does not need them explained on screen. Any legend sentence that carries a fact the owner needs, and I count one, "at least" meaning a lower bound while a run is live, is kept as a tooltip or a two-word suffix, not a paragraph. The Designer decides which, in the brief.

**Finding 2, the residue of the rename.** Three things, three different answers:
- *Nothing on the Board says the Manager is where you type.* Batch 18. One empty-state line on the board when a project has no tickets: "Nothing yet. Open Manager and tell it what you want built." That is copy keyed on a measured fact (zero tickets), so rule 8 and 9 are satisfied. Same brief as finding 5.
- *A failed Manager turn reads as a task, not a conversation.* It IS a ticket in the daemon (manager-kind), so rule 8 says it stays on the board. What is wrong is the card not saying the Manager failed. Batch 18, same brief: a manager-kind ticket's card and its Needs You row name the Manager, in words, where a worker ticket names the worker. I have not read the card renderer in `app.js` (UNKNOWN whether it already distinguishes kinds); the Designer reads it.
- *The scope panel takes half the height for one line.* The owner's. It goes on the owner's walk invitation as one more OWNER TASTE line: keep the scope beside the conversation, or give the conversation the height. Not built until they answer, and if they never answer it stays as it is.
- *Raw daemon states on the page* (`WORKER_FAILED_FINAL`, `dependencies_resolved`, `SONNET`). Batch 18, same brief. The page already owns copy maps keyed on event type (HARD, `app.js` 110-121 `WHAT_NEXT`, 178-183 `EVENT_TONE`), so the shape exists: a name that reaches the screen goes through a map, and, rule 9, an unmapped name is shown as the raw name, never hidden, so a new daemon event is visible rather than silent. The Designer decides the words.

**Finding 3, `--adapter fake` cannot produce a Manager reply.** HARD: `cli.ts` 430-438 says exactly this, `--fake-outcome <id>=manager_proposal` gives only the "ran but never wrote proposal.json" shape and no flag can carry a reply. It is a test-double limitation, not a product defect: a real user runs `--adapter claude` and the README's step 3 says so (the stranger deviated, and disclosed it). **Cut.** Not in 18. The beta's closing condition (batch 16 addendum 3 section 5) is a real run, which needs no fake reply. If a later batch needs a scripted reply for a test, that batch adds it.

**Finding 4, `plan` and `discuss` print "Created" and exit 0, and no CLI command prints the conversation.** Two parts:
- *The exit line says nothing about where the reply lands.* Batch 18, Role A, one line appended to both commands' success output: where the reply appears (the page's Manager tab) and what to run if it stalls (`magarine inbox`). README section "The conversation" (HARD, line 241) says the reply is on the page but not that the CLI cannot show it; one sentence fixes that.
- *A `magarine conversation` command.* HARD: `GET /projects/{id}/conversation` and `commands/conversation.ts`'s `buildConversation` exist (`daemonApi.ts` 19, 379-385), so the command would be a thin wrapper. **Cut anyway.** `requirement-no-terminal-for-end-users.md` points at fewer terminal steps, not more, and the owner reads the conversation in the window. The one-line pointer above is the whole fix.

**Small findings, carried with no action:** `project list` prints `model claude-sonnet-5` on a project never given a model (it is the project's default, and it is true); `plan --help` lists flags without describing them; the host printing "window closed; the daemon is still running" after a tree-kill that took the daemon too (an artefact of the stranger's kill, not reachable by a person).

**A limit of the walk, recorded:** the stranger could not see the real window (lock screen) and did not exercise the launch-code sign-in. The lead's cold walk, spec section 4 item 2 step 2, "no token typed", is the proof of that path and is still to be run. The stranger's evidence is the plain-tab path only.

## 3. Batch 17 closes when

Spec section 4 as amended by addendum 1 section 5, unchanged:
1. Suite green with the browser tests run on this machine, summary line quoted. (Status UNKNOWN to me since `111401a`; the Orchestrator states it in `RESULT.md`.)
2. **The lead's cold walk, still to run.** This is the only build-side step left.
3. The stranger's walk: run, and ruled here.
4. The real run: held, `RESULT.md` says so.
5. The owner's walk as an invitation, through the Liaison, with the OWNER TASTE lines from spec section 1, plus two from this addendum: the word `Manager`, and the scope panel's height.

`RESULT.md` also states where worker profiles sit (spec section 3, the Orchestrator's line), and lists this addendum's cuts so nobody re-proposes them.

## 4. Batch 18, fixed here so the brief can go the moment 17 closes

Three items. The full spec is a paragraph each when 17's `RESULT.md` is in; the shape is here so no one waits on me.

1. **Project creation in the window.** Addendum 2 section 2, unchanged: `POST /projects` (Role A) and the form beside the selector (Role B). First because the owner hit it and was told it is first.
2. **The page speaks to the owner** (Role B, the Designer, sonnet). Delete the five legends; the empty-board line; manager-kind tickets named as the Manager; event and state names through a copy map with raw names shown when unmapped. Pure page work with no daemon change. **It runs alongside item 1's daemon half**, because Role B's form cannot start until Role A's route exists, and the Designer is idle in that gap. So it does not outrank project creation; it lands first because of the dependency, and the owner's walk of batch 18 sees a page without developer prose. Acceptance: no legend element in the served page (a test asserts it, so it cannot creep back); the DOM harness shows a manager-kind ticket's card naming the Manager; a Needs You row for `worker_failed_final` shows no raw underscore name.
3. **`plan` and `discuss` say where the reply lands** (Role A, sonnet, bundled into the same brief as the route). One line each, one README sentence, each run before it is written (rule 24).

**Then, as before:** per-ticket discussion, tags, shortcuts, persisted layout, the beta checkpoint of batch 16 addendum 3. The second skin waits on the owner's research.

**Cut from 18, explicitly:** a fake Manager reply; a `magarine conversation` command; any layout change to the Manager tab before the owner answers; a folder picker.

SOFT: items 2 and 3 together are under one engineer session each. If the Designer's context has been cleared, the brief points at this section and the five line numbers, nothing more.

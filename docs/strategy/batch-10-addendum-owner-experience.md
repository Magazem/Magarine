# Magarine — Batch 10 addendum: Linux parked, owner experience takes its place

Author: Strategist. Date: 2026-09-14. Follows the owner's mid-batch directive: "Linux isn't necessary yet until i am Satisfied with windows since linux is for other users not me, push the repo please".
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 1. Rulings

### 1. Role P is parked, fully. The Orchestrator's hold on the UNTESTED header stands.
"Linux is for other users, not me" is a priority statement and it is clear. The container proof of the signal path is cheap, but it is engineering hours on Linux, and the owner just said not yet. One exception, bounded: if Phase A already runs in the container today, with no further building, run it once, commit its report under `linux-leg/reports/`, and park. If it does not already run, park without building more. Role P's on-disk work is committed as-is with a `WORK IN PROGRESS, UNPROVEN` header at the top of `linux-leg/README.md`; nothing in the tree may claim Linux coverage it does not have. `linux-leg-design.md` stays as the plan for when the owner asks.

### 2. Role P's capacity goes to the owner's own path through the product.
"Satisfied with Windows" means the owner will sit down and use it. Today that means running `node src/cli.ts` from inside `packages/core` after `pnpm install`, with no command on the PATH, no first-run check, no page to look at, and a README written for engineers. The gap between the code working and the owner being satisfied is that gap. Role Q closes it; the correctness items on the Orchestrator's list are either done, deferred by earlier ruling, or ride along.

### 3. "Satisfied with Windows" changes the definition of done, from this batch on.
Every batch close-out gains an owner walk: the Orchestrator, from a fresh state directory and following only the root quickstart, installs, creates a project, plans one mission, watches it run, handles one inbox item, and stops the daemon. Every step where the Orchestrator needed something the quickstart did not say is a finding. The bar in one sentence: **the owner can go from a fresh state to a completed mission using only the quickstart, and every inbox item tells them what to do next.** When the owner answers the Liaison in their own words, the sentence is adjusted to theirs.

### 4. The push, and the strategy documents.
- Push the code. The secret scan is done; the tree is clean of credentials.
- The strategy documents are the project's real record: rulings, mistakes, spend, and the owner's words verbatim. They should not be rewritten or sanitised; history is history. Whether they are public is the owner's call, not mine, because the verbatim quotes are theirs. My recommendation, carried to the owner as a recommendation: **make the repository private and push everything.** If the owner wants it public, my own documents may stay public as they are; then `docs/strategy/` and `spikes/claude-cli/runs/` should be checked for the owner's quotes and for the Windows username in recorded paths, which is in every fixture, and the owner decides on those two things specifically.
- Until the owner answers, do not push. A push to a public repository is not reversible in the way a local commit is.

## 2. Role Q: Owner Experience Engineer — model tier: sonnet, high effort
Owns `packages/core` for `cli.ts`, `commands/`, a new `commands/doctor.ts`, `package.json` for the `bin` entry, the daemon's static route, a new `packages/core/ui/` directory, the root `README.md`, and the `packages/core/README.md` quickstart section. Does not touch the scheduler, state machine, adapters, or tests owned by Role O beyond adding its own. Does not commit.
Deliver, in this order:
1. **`magarine` on the PATH.** A `bin` entry in `package.json` so `pnpm link --global` or `npm install -g` from `packages/core` puts `magarine` on the PATH, no build step, Node 24 or newer enforced with a plain message when older. Verified from a fresh shell.
2. **`magarine doctor`.** Checks and prints PASS or FAIL with one sentence each: Node version, `claude` resolvable and its version, `claude` logged in (via the not-logged-in signature already recorded, no paid call unless `--paid` is given), state directory writable, daemon running or not with its port, pnpm present. Exit code reflects the worst line.
3. **A root `README.md` written for the owner**, one screen: what Magarine is in three sentences, install in four commands, first project and first mission in five, what the board and inbox mean, how to stop the daemon, where state and cost live, and where to look when something says FAILED. No internal role names, no batch numbers.
4. **A static page served by the daemon at `/`**: plain HTML and a little script, no framework, no build step, token entered once and kept in the browser's session storage. It shows the board, the inbox, and the activity of a selected project, refreshing every few seconds by calling the existing routes, with buttons for approve, reject, decide, retry, and cancel that call the existing actions. It renders inbox reasons in full. It is the document's Board and Inbox, in the smallest form that a person can actually look at.
5. **`project create` gets its route**, closing the single-writer rule's one exception, and the README line about the exception is removed.
6. **Friendly failures.** The five most likely owner mistakes each produce one plain sentence and a hint: daemon not running when a daemon-only command is used, `claude` not logged in, a missing project id, a ticket id that does not exist, and a budget below the floor. Tested through the CLI entry point.
Acceptance: `pnpm test` green; twenty cold runs by the Orchestrator on a quiet machine; the owner walk in ruling 3 completed by the Orchestrator with zero findings, or with every finding fixed before close; the page driven in a real browser by the Orchestrator for one mission with screenshots in the close-out.

## 3. Orchestrator close-out addendum
1. Park Role P per ruling 1 and commit its work with the header.
2. Role O closes as specified in the batch 10 spec.
3. Role Q closes with the owner walk, one paid mission through the page, under a dollar (SOFT).
4. Carry ruling 4 to the owner through the Liaison as written: private and push everything, recommended; public is their call with the two specific checks named.

## 4. What the owner must decide or supply
1. Private repository, or public with the two checks. Blocks the push only.
2. In their own words, what "satisfied with Windows" looks like. Non-blocking; the sentence in ruling 3 stands until they answer.

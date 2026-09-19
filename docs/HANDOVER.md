# Handover — read this first

Written so the Orchestrator's and Strategist's contexts can be reset without losing anything.
Everything below is durable: the task board, `docs/strategy/`, `docs/design/`, `docs/evidence/`
and the commit history carry the rest.

## What Magarine is, today

A cross-platform agent-orchestration daemon. **It works end to end and has been proven with
real money:**

- Hand it a markdown scope document. It **interviews you about what it does not know** rather
  than assuming — and does *not* interview when the scope is already clear.
- It plans the work into tickets with dependencies, **chooses a model per ticket and records
  why** (mechanical work on haiku at ~$0.05, real design work on opus-5).
- A daemon runs workers in parallel under a spend cap, on a loopback HTTP API.
- A browser page shows the board, the inbox, activity, and a conversation with the Manager.
- You can talk to it in plain language and it **re-plans**.

Proven runs are in `docs/evidence/`. Batch 13's replay: four tickets, four files delivered,
$3.38 equivalent.

## Where we are

**BATCH 15 IS CLOSED.** Its closing condition was run: the lead's acceptance walk, the lead's
re-run of the owner's walk from step one, and the owner's own re-run. Their verdict: *"the demo
run was perfect."* The ticket the batch turned on -- their `index.md`, delivered and failed four
times by a raw string comparison -- is `DONE`, succeeded 2026-09-19 after ruling 21.
**The record is `docs/evidence/batch-15-walk/RESULT.md`**; read it before claiming anything about
batch 15. Authority is `batch-15-spec.md` plus addenda 1-10.

**What batch 15 delivered:** the daemon's read path, `/events`, static assets and expected
artefacts (`e9d37f8`); pass 3 as the page the daemon serves, the three views as a root
`data-view`, per-column scrolling, keyboard reach on every scrolling region, the current view
drawn, the organism animating from the board's own marker and surviving re-renders, and 23
capture files (`448b97b`, `68ca8a7`, `80231ec`, `d7070f8`, `88501b0`, `a69f0e2`); expected
artefacts on `ticket add` and `POST /tickets` (`d3e8281`, `07ebfd2`); `reasonFor` reading
`errors` (`edef94c`); and, from the owner's walk, `magarine token` (`fd0d94e`, `4416031`),
resolved-path artefact matching (`5f1e7f2`), unsafe project roots refused (`aa84325`), and
`project set --max-parallel` (`9937064`). Suite 736 pass, 0 fail.

**BATCH 16, ruled or carried. The Strategist sets its final shape; this is what is banked:**
1. **Parallelism, ruled (addendum 10, ruling 23 items 4-5):** `projects.max_parallel_workers`
   becomes nullable so ONE number governs, by migration with an upgrade test, and the fleet
   header shows "N of M slots". **This one first** -- the owner hit it, and the page could not
   tell them why nothing ran in parallel.
2. **`reporting` means a text line, ruled (addendum 8, ruling 19).** Needs the fake adapter to
   script a progress burst first (item 3), because the scheduler test needs one.
3. **The fake adapter cannot script a progress burst**, so ruling 18 requirement 4 (an
   animation survives the re-render a frame causes) is proven by a Chrome run rather than by
   test. **Corrected 2026-09-19: approve/reject are NOT in that state** -- `--fake-outcome
   review` has scripted a review since batch 5 and `commands.test.ts` 1139/1177 drive both to
   their real transitions. Only `--fake-script` lacks the `review` spelling. My error, from the
   batch 15 walk, inherited by batch 16's item 1 rationale before the Engineer caught it.
4. **LEGACY PROJECTS ARE THE COMMON THREAD OF THE REST** -- rows created before a rule existed:
   - **No scope path (found by the owner, 2026-09-19).** A Manager run on a pre-14-September
     project failed with "update_scope cannot be applied: this project has no scope_path set
     yet"; a retry passed by luck. `managerEnvelope.ts` 209 offers `update_scope`
     unconditionally, `proposal.ts` 470 refuses it without a scope path, and a proposal is
     all-or-nothing, so the run fails. Four of the owner's nine projects are in this state. The
     Manager must not be offered a command that cannot be applied to that project.
   - **Unsafe workspace roots** (ruling 22's carry): the point-of-use guard in the scheduler,
     pausing the project with a reason naming the fix.
5. **`serve`/`tick`/`run --max-parallel` are still unvalidated**: `--max-parallel 0` sets a
   machine ceiling of zero, so the daemon starts nothing and says nothing; `abc` becomes NaN.
6. **A project created while the page is open is invisible until a reload** (`app.js` 1118, 1167).
7. Worker profiles and avatar seeds, planned for 16 before any of the above.
8. `POST /tickets` names the Manager's snake_case field in its unknown-kind error; `status`
   without `--project` errors instead of reporting the daemon, port and page address.
9. Ruling 18's option B, carried on its own merits: `worker_progress` events self-describing.

**Sequence after 16:** 17 = the Windows window host. 18 = per-ticket discussion, tags, shortcuts,
and the owner's second skin.

## How this team works — the rules that were earned, not assumed

1. **Verify every claim independently before reporting or committing it.** This has caught a
   real defect eleven times, including twice in work I had already signed off and once in my own
   reported finding.
2. **Mutation testing is the standard.** Break the thing a test names; confirm exactly that test
   fails. A test that cannot fail reads as coverage and is worse than none.
3. **A test name is a claim.** The mutation must cover the whole name.
4. **A comment claiming a path is handled elsewhere must name the test that proves it.**
5. **Split, don't re-point.** When a rule changes, an inherited test's claims move to the input
   where they still hold; the new input gets its own test.
6. **Where a wrong choice by an agent produces silent failure, remove the choice.** Guidance is
   for choices that are safe either way.
7. **An event that cannot name a next command is not an inbox item.**
8. **The interface shows only what the daemon measures.** A progress bar reading 67% when
   nothing measures progress is the same lie as DONE with nothing delivered.
9. **A silent fallback on the page is not allowed** — it must say when it is not the page the
   owner approved.
10. **A mock is never a promise.** Mocks mark what ships now versus later.
11. **Never whole-file restore a shared file**; mutate in place.
12. **Durable instructions go on the task board, never in a chat message** — mail is dropped by
    session limits.
13. **Exclusivity for measurement and mutation.** A hold reaches an agent at its next turn
    boundary, so the window starts when everyone has acknowledged, not when it is sent.
14. **The Orchestrator commits; engineers never run git.**
15. **A role that needs a capability is spawned with it, verified before its first task.**
16. **Measure a foreground against the lightest surface it can land on**, not the one it usually
    sits on, and re-measure every surface when one moves. An unused token that silently fails
    contrast is a trap, not a token.
17. **A checker that cannot fail is not coverage — mutation-test it.** Break the thing each check
    names and confirm that check fails. Two checks here passed while two tiers were made
    identical and while the generator was allowed to emit a one-pixel avatar, because one
    compared bitmaps rather than traits and the other read its goalposts from the code under
    test. Assert against a constant the checker owns.
18. **Hand-picked inputs are not a sample.** Seven seeds chosen by hand all missed a branch that
    was broken for 76% of one tier. Hit every branch, or sample at scale by machine.
19. **An anchor in a durable document is a claim and gets verified like one.** A ruling cited a
    commit hash for code that commit did not contain. A hash reads as the most verifiable kind of
    reference, so a wrong one misleads harder than the stale line number it replaced.
20. **A batch does not close until its own closing condition has actually been run.** Batch 14's
    was "the owner walks the new page"; it closed with no new page in existence. Where a spec
    names implementation in a single sentence, that sentence is a batch, not a clause.
21. **Delivered means in the product, not in the repository.** A committed design is an artefact;
    until the daemon serves it, the feature does not exist for the owner.

22. **Owner-facing steps are run before they are written.** Walk instructions, recipes and any
    command handed to the owner are an artefact and get verified like one. Earned twice in one
    day: the lead told the owner to paste "the token serve printed" (serve never prints it,
    addendum 9), and wrote a demo recipe from the design's intent that ran every worker one at a
    time and used the owner's home folder as the workspace (addendum 10). Both instructions read
    correctly; neither had been run.

## How to run the tests

**`pnpm test`, from `packages/core`.** Its `test` script is `node --test`, so
`cd packages/core && node --test` is the same run, not a substitute --
worth knowing because **the command does not exist at the repository root**:
there is no root `package.json`, no workspace file and no lockfile. Every
acceptance line since batch 10 has meant "from `packages/core`". Documented in
`packages/core/README.md` lines 21-24.

The lead spent part of a session concluding `pnpm test` was unrunnable here
before the Strategist corrected it; this section exists so nobody repeats that.

## Cost

The owner is on a **Max subscription**. Dollar figures are **equivalent API cost**, useful for
comparing runs, **not money leaving an account.** The binding constraint is **session limits**,
and **the team talking is the expensive part, not the product running** — six real worker
invocations cost ~$1.00 while a day of six agents coordinating cost far more. Never broadcast;
retire finished agents.

**THE `advisor` TOOL IS OFF — the owner disabled it 2026-09-16.** Every call re-fed the ENTIRE
conversation and chat history to a second model, and that is where most of a session went in
about an hour. In the owner's words: **"the real advisor is the strategist, or you for smaller
cases."** Escalate design and scope questions to the Strategist; decide integration and
housekeeping yourself. If it ever reappears, announce before calling it.

**Three measured wastes, all the Orchestrator's, corrected 2026-09-16:** writing every brief
twice (a long board task AND a long chat message repeating it — the board is the durable copy,
the message is a pointer); twelve documentation commits in sixteen minutes where three would
have done; and essay-length messages where three lines carry the instruction. One hour produced
13 commits of which exactly one held product work. **Answer usage questions with measured
numbers, not a general account of coordination cost.**

## Team

| role | state |
|---|---|
| **Strategist** (fable) | the real manager; every ruling is a file in `docs/strategy/` |
| **Interface Designer** (ui-ux-pro-max) | pass 3 delivered; context reset after the commit |
| **Invariants Engineer** (sonnet) | batch 13 complete; context reset |
| **Liaison** (sonnet) | the only channel to the owner |
| **Butler** | creates assistants on request |

## Decided by the owner (2026-09-16)

1. **Typeface: IBM Plex Sans.** Confirmed. Aliased as "Magarine Sans" in `tokens.css`, so a
   future change stays a one-line swap.
2. **The Next.js port** in `propos/fleet-and-board/` is **a design reference only** — and the
   owner has clarified the stack *was never their choice*: the tool that generated their
   reference image happened to use it. **It carries no signal about their preferences. Do not
   mine it for intent again.**
3. **Non-Latin scripts: the owner personally will not need them, but future users might**, and
   they left the timing to us. Recommendation with the Strategist: ship the Latin subset now,
   make the page *say* when it is rendering outside the bundled subset rather than silently
   falling back (rule 9), and carry wide-script support against a stated trigger — *when
   Magarine has a user who is not the owner*. A CJK subset is megabytes against Latin's tens of
   kilobytes, paid by every user on every load, and buys nothing for the only user who exists.

## Open with the owner

Nothing open but the batch 15 walk itself.

**Corrected 2026-09-16 at close-out.** This section listed two items as open -- whether the owner
had approved pass 3 ("BLOCKING"), and permission for one small real run. **Both were answered by
the owner in a single message** and recorded at `docs/strategy/batch-15-addendum-2-second-skin.md`
section 0, line 8: *"Pass 3 is approved: 'the design is good, we will use it.' The small real run
is permitted."* Neither record here was updated at the time, and the stale copy nearly caused the
lead to re-ask the owner for a permission already given (addendum 7 section 1). When a relayed
answer settles something, update every record that asked the question.

## Carried UNKNOWNs — stated, not assumed away

- **Assistant prose already reaches the page, unfiltered.** HARD, 2026-09-16: `describeProgress`
  in `adapters/claudeCli.ts` returns `text: <first 120 characters>` of any assistant text block,
  and that string is persisted and displayed. **A model can echo anything it read — including
  file contents or a secret it encountered — into its prose and onto the page.** Existing
  behaviour, and the source of the `reporting` state; not widened by ruling 14. To be judged
  when a real run shows a case, not designed away blind.

- **Playwright is broken on this machine and is not available.** Verified 2026-09-16:
  `ms-playwright/chromium-1194/chrome-win/` holds only `chrome.dll` and a manifest — no
  `chrome.exe` anywhere under `ms-playwright`, and no playwright npm package installed.
  **Use system Chrome headless** at `C:\Program Files\Google\Chrome\Application\chrome.exe`;
  it needs an absolute `--screenshot=` path and its own `--user-data-dir` or it fails with
  access-denied. Do not spend a turn rediscovering this.

- **The owner's own design, as a second skin.** Their words: *"add an extra theme from the one I
  proposed, after we have the product working"* — and *"i don't want it lost."* Ruling 13 says it
  is a **skin, not a palette**: same six product regions, different arrangement and visual
  language. Source of truth is the owner's plain HTML and reference image under `propos/`, which
  are authoritative for this skin. (`propos/fleet-and-board/` is **not** — that is a generator's
  artefact, never evidence of preference.) Trigger: not before the window host closes at batch 17;
  a candidate for batch 18. Batch 15 builds the page so it is possible.

- **Wide font subsets.** Trigger, in the ruling's words: *"Ship the wide subsets when Magarine
  has a user who is not the owner."* Batch 15 ships Latin only. The owner will not need other
  scripts; future users might. Not "later" — that trigger.

- The **fallback-rate marker** has only ever seen synthetic data; no real run has named a model
  outside `pricing.ts`.
- **Migration 0012** has only run against a synthetic legacy database.
- **The EPERM flake** stays on the books at one-in-twenty despite forty clean runs.
- **`claude` resolution on any machine but this one** is an accepted risk with the failure made
  legible.
- **Linux is parked** with its `UNTESTED` header intact.
- **DONE with a text artefact instead of a file** is not checked anywhere and cannot be by a
  generic rule — batch 15's expected-artefacts list is the mechanical answer.

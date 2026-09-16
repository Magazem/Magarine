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

**Batch 15 is BUILT, WALKED BY THE LEAD, AND WAITS ONLY ON THE OWNER'S WALK.** Batch 14 delivered
the design; batch 15 built it and the daemon serves it. `docs/strategy/batch-15-spec.md` plus
addenda 1-7 are the authority. **The acceptance record is `docs/evidence/batch-15-walk/RESULT.md`**
-- read it before claiming anything about batch 15.

**Done, each verified by the lead on a still tree, suite 704 pass / 0 fail:**
- Role A, the daemon: read path, `/events` stream, static assets, expected artefacts (`e9d37f8`).
- Role B, the page: pass 3 as served files (`448b97b`); the three views as a root `data-view`
  (ruling 15, `68ca8a7`); the scope-view page-scroll fix (`80231ec`); the organism animating from
  the board's marker (ruling 18, `d7070f8`); keyboard focus on every scrolling region (3A,
  `88501b0`); the current view drawn, and 23 captures re-taken (`a69f0e2`).
- Close-out rulings: `ticket add --expected-artifact` and the same on `POST /tickets` (ruling 16,
  `d3e8281`, `07ebfd2`); `reasonFor` reads `errors` (ruling 17, `edef94c`); the README route table
  names batch 15's routes (`cad05e5`).
- **The acceptance walk against a real daemon**, all five Role A items, ruling 18's live-stream
  animation, and **spec line 82's one small real run**: a Haiku ticket, `DONE` in ~20 s, **$0.0758
  equivalent, measured**, `hello.md` delivered, watched animating on the page and settling.

**WHAT REMAINS IN BATCH 15: only the owner's walk** through the Liaison, which closes it. Per
addendum 7 section 2 the walk asks the owner nothing -- they use the page and report what they
find. The three observations raised during testing are ruled and recorded in RESULT.md.

**CARRIED TO BATCH 16** (confirmed by the Strategist, addendum 7 section 3):
1. **The fake adapter cannot script a progress burst -- FIRST**, because ruling 18 requirement 4
   (the animation survives a re-render) was proven by hand and a scripted burst turns it into a test.
2. The CLI's `--fake-script` has no `review` kind, so approve/reject cannot be driven end to end.
3. `POST /tickets` names the Manager's snake_case `expected_artifacts` in its unknown-kind error.
4. Ruling 18's option B: `worker_progress` events self-describing to any consumer (carry ticketId).
5. **Ruled -- see `docs/strategy/batch-15-addendum-8-reporting-is-a-text-line.md` (ruling 19).**
   Found by the real run: the page's activity state was almost always `reporting`. The defect is
   the classifier's default, not the page and not ruling 18 -- `classifyToolActivity` returns
   `reporting` for ANY message with no tool, while spec line 63 defines it as "a text line", and
   the adapter emits five other non-tool families (`tool result received`, `thinking`, ...). A
   frame-driven page would have shown the same thing. Fix, all in Role A's files: `reporting`
   only from a `text:` message; a tool result carries its tool's state; other non-tool messages
   keep the run's current phase (`running` before the first tool), carried beside
   `ctx.progressSeq`; the persisted `tool` stays `null` for non-tool messages -- the state is the
   phase, the tool is the evidence. **Order: burst scripting (item 1) first, because ruling 19's
   scheduler test needs a scripted burst.** The next small real run must record the states
   actually seen, and they must not all be one state.

**Sequence from here:** 16 = worker profiles and avatar seeds. 17 = the Windows window host.
18 = per-ticket discussion, tags, shortcuts, and the owner's second skin.

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

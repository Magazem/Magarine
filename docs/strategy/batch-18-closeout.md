# Magarine — Batch 18 close-out

Closed 2026-09-22. Authority: `batch-18-replan-owner-walk.md` (re-planned from the owner's
batch 17 walk), with the owner's answers in its section 6.

## The closing condition was run by the owner, on real work

The owner ran batch 18 on their own real project, on their own machine, with real `claude`.
Verbatim:

> *"i did the run, it is fine generally, didn't find real bugs this time so i will accept it"*

**Set against batch 17's walk on the same kind of real work**, which produced placeholders,
finished only part of phase 0, and had an independent review find 0 Critical, 3 High, 4 Medium
and 7 Low defects. That was the first test of the owner's stated goal (to move their real
workflow onto Magarine and be more efficient) and it failed. This one passed. It is the first
time the product has done the job it exists for.

## What shipped

`6797935` the page never destroys what the owner is typing · `5a94b5a` developer prose removed
from the product · `7c7bcc6` → and ✓ in the product's own fonts · `2da67f6` the conversation gets
the height, the scope folds away · `8d0a94b` **a verifier decides when work is done**, with a
standing criterion against placeholder work · `de135c5` a retry is told why it failed ·
`98e4b7d` the Manager has its own slot · `07344c9` **the Manager continues when the board
drains**, without waking dormant projects · `79f40c9` plan/discuss say where the reply lands, and
`--max-parallel` is described truthfully · `d00ace3` the page shows verifying, rejection reasons
and the Manager at work.

Suite at close, combined: **934 tests, 933 pass, 0 fail, 1 skip** (the honest EACCES skip).

## What verification caught

- **A cost defect found only on the owner's REAL data.** With permission, the lead ran ruling
  34's trigger against a copy of the owner's `~/.magarine`: 6 of 10 dormant projects would have
  been handed an unasked automatic Manager turn on their next daemon start. Every test used fresh
  projects built inside the test, so nothing in the suite had history. Fixed with an upgrade
  high-water mark and re-checked on a fresh copy: 0 of 10.
- **The daemon's work was verified in isolated worktrees** (HEAD plus only the files under
  review) while the other engineer was mid-edit, because page tests spawn a daemon from source.
  What was tested is exactly what was committed.
- **The day's intermittent test failure was tied to a concurrent cause for the first time:** it
  failed while another agent's Chrome tests were loading the machine, and passed 3/3 alone. A
  timing-sensitive animation test, not a product defect.

## Carried into batch 19 and later

- **The Manager's model:** per project, with a configurable default (the owner's answer). The
  default half does not exist yet.
- **Worker roles and profiles**: designed in batch 16, never built. The owner: *"they have no
  character, not one dev one is designer."*
- **Drill-down into what a worker is doing**: *"what is it running exactly, is it stuck."*
- **`max-parallel` and the scope, editable from the app.**
- **One answer field per Manager question.**
- **Project creation in the window**, moved to batch 20.
- **Fonts:** box drawing and some symbols (`├──`, ● ▶ ✔ ✗ ✅) are still outside coverage,
  because IBM Plex Sans lacks them. A design decision for the owner.
- The verifier's verdict passes into a retry prompt verbatim, with no length limit.
- The Manager-stall diagnosis from batch 17's walk was never confirmed against the other
  machine's data. Batch 18 fixed the likeliest cause regardless.

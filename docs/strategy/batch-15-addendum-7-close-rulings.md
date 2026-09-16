# Magarine — Batch 15 addendum 7: the real run is already permitted, and the three walk observations are ruled, not asked

Author: Strategist. Date: 2026-09-16. Follows addendum 6. Raised by the Orchestrator at batch 15 close (`docs/evidence/batch-15-walk/RESULT.md`, 8b1d0c6). Every anchor re-read this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 1. The small real run was granted; two records are stale

HARD, in order of writing:

- `batch-15-addendum-owner-answers.md` line 33: "Permission for the one small real run is also still open." Written before the owner's second set of answers.
- `batch-15-addendum-2-second-skin.md` section 0, which follows the owner-answers addendum by its own header: "Pass 3 is approved: 'the design is good, we will use it.' **The small real run is permitted.**" Those are the owner's words as relayed by the Liaison through the Orchestrator (SOFT that the relay was faithful; the Orchestrator was the relay and can confirm from their own record).
- `docs/HANDOVER.md` items 1 and 2 (lines 166-171) list both the pass 3 approval and the real run as open. Item 1 is already known to be stale; item 2 is stale for the same reason and by the same message.
- `batch-15-spec.md` line 96 reads the batch 1 permission for tiny runs as covering it. That reading was never needed: the owner granted this run specifically.

**Ruling: the run is permitted and proceeds now.** The Liaison request already sent may stand as a courtesy confirmation; it does not gate anything. The Orchestrator corrects handover items 1 and 2 together at close-out, citing addendum 2 section 0 as the source. Spec line 82's acceptance item, "one small real run, a single ticket, watched on the page", is then the last open item of batch 15, and the walk's RESULT.md gains its record: the ticket, the equivalent cost, and the animation observed against a real adapter event, not the fake one.

## 2. The three walk observations: all ruled, none put to the owner

The owner's walk is a walk. The owner sits down, uses the page, and reports what they find. It is not a questionnaire, and least of all one whose three questions ask the owner to re-decide choices they approved in the brief. What the owner dislikes on the walk comes back as a finding and is ruled on then. The observations stay in RESULT.md as honest records, each with its ruling beside it, and the walk script asks nothing.

### (a) A long Needs-you reason reaches below the rail's fold in board and scope views

- The rule (`docs/design/BRIEF.md` item 3, HARD): "The inbox reason is never truncated, clamped or scrolled away. It wraps, in full, however long." Its contrast is the ticket title, which "may clamp to two lines". The rule is about the reason element: no line clamp, no fixed-height box of its own.
- The layout (BRIEF section 1, approved unchanged; pass 3 `height: 100vh` with columns overflowing; ruling 15 requirement 5): "three columns, each scrolling on its own". The rail scrolling as a column is the approved design, and the reason inside it is whole, wrapped, and reached by that scroll.
- The Needs-you view exists precisely to promote the item to the centre. That is the approved answer to a long reason.

**Ruling: no layout change. Not a defect, not a question.** The page's comment at `app.js` 628 and any legend copy that repeats "scrolled away" overclaims and is corrected to say what the rule means: never truncated, never clamped, never in a scroll box of its own; the rail scrolls as a column. One comment edit, no behaviour, no test; folded into whichever commit the Orchestrator makes next in that file.

### (b) The scope document's 19rem cap with a fade

BRIEF item 4 (HARD): "A long scope document scrolls inside its own panel, with a fade at the foot so a cut-off line reads as 'there is more' rather than as a bug. It never pushes the conversation below the fold." Pass 3 drew exactly that (`docs/design/pass3/tokens.css` 502, per the walk). The cap is the mechanism by which the second sentence holds.

**Ruling: keep. Not a question.** If the Designer believes the cap should scale with the viewport in scope view, that is a skin tweak proposed with a before-and-after capture through the Orchestrator, ruled on its own, and never a change to the "never below the fold" rule.

### (c) The three view links stay clickable on the token gate

The gate occupies its own grid area above every region in every view, so a click changes which empty regions sit beneath a gate that stays in place. Nothing is hidden, nothing lies, nothing fails silently.

**Ruling: no change. Not a question.** Disabling the nav while gated would be a state the script writes and the skin interprets, which is allowed under ruling 13, but it buys nothing the owner will notice and it is one more state to test.

## 3. Carried to batch 16, confirmed as the Orchestrator listed them

- The fake adapter cannot script a progress burst, and the CLI's fake script has no review kind. Both are testing-state gaps; the burst one matters first, because ruling 18 requirement 4 was proven by hand and a scripted burst would make it a test.
- `POST /tickets` names the Manager's snake_case field in its unknown-kind error.
- Option B from ruling 18: self-describing progress events.
- The handover's stale items 1 and 2, corrected at close-out.

## 4. What closes batch 15

The real run recorded in RESULT.md. Nothing else is open on my side.

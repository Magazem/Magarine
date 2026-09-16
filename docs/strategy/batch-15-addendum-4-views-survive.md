# Magarine — Batch 15 addendum 4: the three-view navigation survives, as a root attribute the skin interprets

Author: Strategist. Date: 2026-09-16. Follows `batch-15-addendum-2-second-skin.md` (ruling 13). Raised by Role B through the Orchestrator after ruling 13 landed on a page that was already written. Every HARD claim below was re-verified by the Orchestrator before this ruling was accepted.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What happened

Ruling 13 requirements 1 and 2 make the six product regions direct children of `<body>`, placed by grid areas in the skin, with no wrapper that exists only to serve pass 3's arrangement. Role B read that as incompatible with hiding regions behind JavaScript tabs, and built all six regions onto one page at once with a nav of anchor links. Pass 3's markup carries `<nav aria-label="Views">` with three entries, and the owner approved pass 3 as the page they will get. The Orchestrator refused to treat the loss of that navigation as an implementation detail decided by a side effect of a layout ruling, and asked for a ruling. That refusal was correct.

## 1. Evidence

All HARD, read 2026-09-16.

- **Pass 3 is not three pages.** All three screens carry the same grid, `"top top top" / "fleet centre rail"` (each file, line 242). Screen 1: centre = Board, rail = Needs you + Activity. Screen 2: centre = Needs you, rail = Activity. Screen 3: centre = Scope + Conversation, rail = Needs you + Activity. Fleet, Needs you and Activity are on screen in every view. **The nav only ever decided what the centre column holds.**
- **The approved layout says the same.** `docs/design/BRIEF.md` section 1, "approved, unchanged" since pass 1: the centre is "Board — or — Scope document + Conversation", the rail is Needs you and Activity, and "three columns, each scrolling on its own".
- **The owner's own proposal, the future second skin, also has the switch.** `batch-14-addendum-owner-reference.md` line 7: "top bar with Fleet & Board, Needs You, Scope tabs". Both designs the owner has liked carry the three-way switch. Under the owner's own rule, "we are changing the VISUAL LANGUAGE, not the PRODUCT", the switch is product, not skin.
- **The built skin already hides by attribute, one level down.** `packages/core/ui/skin-brutalist.css` lines 323-324: `#board[data-board-view="board"] .listview { display: none; }` and its twin. The mechanism this ruling uses is already in the page and already permitted by ruling 13 requirement 3, which names `data-*` attributes as the script's output.
- **The built skin page-scrolls where pass 3 scrolls per column.** Built: `min-height: 100vh` on `body` (line 47). Pass 3: `height: 100vh` on the app grid with the columns overflowing (lines 243 and 266). A second departure from what the owner saw, unmentioned until now; its only rationale was the anchor-link design.
- **The skin test does not exist yet.** `index.html`'s header names `src/ui/skin.test.ts` as proof of requirement 3. `find` returned nothing. It is still owed by Role B under ruling 13 and is extended, not replaced, below.

## 2. Ruling 15 — views are one root attribute, exactly like theme and skin

Ruling 14 is "classify at the adapter" in `batch-15-addendum-3-testing-state.md`. This is ruling 15.

1. **The attribute.** `<html data-view="board|needs-you|scope">`, default `board`. `app.js` sets it, sets `aria-current="page"` on the matching nav entry, and nothing else. Both are state.
2. **The nav.** Keeps `aria-label="Views"` and three entries, as pass 3 has it. The hrefs stay hashes: `#board`, `#needs-you`, `#scope`. Keyboard, deep links and back/forward then work for free; the script listens to `hashchange` and writes the attribute. `#needsCount` stays on the Needs you entry.
3. **The skin decides what the attribute means.** Per view it sets `grid-template-areas` and hides the off-view regions, matching pass 3 exactly. Board view: `#board` in the centre, `#needs-you` and `#activity` in the rail. Needs-you view: `#needs-you` promoted to the centre, the rail is `#activity` alone. Scope view: `#scope` and `#conversation` in the centre, the same rail as the board view. **Fleet is never hidden. Activity is never hidden. Needs you is never hidden.**
4. **With no `data-view` attribute, nothing is hidden.** Skin rules key on `html[data-view="x"]` and there is no fallback rule that hides. The anchor page Role B built is kept as the degraded state. This answers Role B's concern literally: JavaScript hides nothing; it names a state, and a skin may ignore it. A second skin that wants everything on one page deletes the view rules and gets it.
5. **Per-column scrolling comes back in the skin**, as BRIEF.md section 1 and pass 3 have it. Same file, same reason, same pass.
6. **The skin test** (`src/ui/skin.test.ts`, owed under ruling 13) adds `data-view` to the list of attributes the script may write, and asserts nothing about display. No rendering test: Playwright is broken here (commit 4f78835).

## 3. Why not the other two options

- **One page with anchors, as built.** Changes what the owner approved, for the saving of one pass, and the owner would have to be told before their walk rather than discover it.
- **One page now, views in batch 18 beside the second skin.** Ships a page the owner did not approve and puts the fix behind a batch that does not start until the Windows window host closes (batch 17). Not worth it when the fix is a data attribute and grid areas already in Role B's hands.

## 4. Cost, checked against the working tree this time

Checked with `git status` before writing: `index.html`, `app.js` and `skin-brutalist.css` exist untracked in `packages/core/ui/`, so this is a change to written files, not a constraint on unwritten ones.

- `index.html`: the nav goes from five entries back to three, with the hrefs and label above.
- `app.js`: a `hashchange` handler that writes the attribute and `aria-current`. No other change.
- `skin-brutalist.css`: three view blocks of grid areas and hides, plus `height` and overflow restored per column.

One Role B pass, smaller than the ruling 13 rewrite. Owner contact: none. Under this ruling the owner gets the page they approved.

## 5. On the record: the ruling 13 cost estimate was wrong

Ruling 13 said "nearly free before the page is written; a rewrite of `index.html` the day after". By the time it arrived, `index.html` and `app.js` already existed untracked in the working tree. Both were rewritten and `tokens.css` was split, at about a third of a Role B turn. The Orchestrator had quoted the estimate to Role B as the reason to accept the ruling mid-flight. Cause: I estimated against the batch schedule, which says when a file is planned, instead of against `git status`, which says whether it exists. Standing rule from here: any cost attached to a ruling that touches files is checked against the working tree first and labelled HARD, or it says UNKNOWN. Ruling 13 itself stands; Role B and the Orchestrator both hold the page is better for it, and no change is requested.

## 6. Also noted

Rendering the page found two defects no planned test would have caught, one of them a daemon value becoming a CSS class name. Role B removed the choice rather than fixing the instance, per ruling 13 requirement 6. The batch 15 close-out should list both under "found by rendering, not by a planned test", so the testing state carried into batch 16 says so.

## 7. Not blocked

Role B runs on this ruling from the Orchestrator's board task, which carries the six requirements in section 2 verbatim. This file is the authority once committed.

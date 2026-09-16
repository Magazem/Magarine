# Batch 15: the page the daemon serves — screenshot evidence

Interface Designer, Role B. **All 23 captures re-taken 2026-09-16 after ruling
18**, from `packages/core/ui/` as it stands after rulings 15 and 18 and fixes
3A and 3B, in Chrome 153.0.8010.48.

**How to reproduce.** These are NOT hand-composed mockups. Each is the real
`ui/index.html`, loading the real `ui/tokens.css`, `ui/skin-brutalist.css`,
`ui/organism.js`, `ui/fontCoverage.js` and `ui/app.js` over HTTP, with the two
shipped `.woff2` files. A throwaway stub in `.shots/` (gitignored) answers the
daemon routes. Captures are taken by `.shots/shoot-cdp.cjs` over the DevTools
protocol (`Page.captureScreenshot`, with device-metrics emulation for 125%).

> **RESOLVED — the "doing" line.** An earlier set of these captures showed a
> live line under running tickets that no real daemon would have rendered. The
> stub sent `latest_activity`, the daemon sends `latestActivity`
> (`commands/board.ts` 98 and 231), and the page read the stub's spelling — a
> fixture written to match the page, agreeing with the page's mistake. The lead
> recorded that caveat here; it is now resolved, not merely noted:
>
> - the page reads `latestActivity` (`ui/app.js`), and the stub sends it;
> - **every capture in this directory was re-taken after the fix**, so no file
>   here still carries the old line; `writing · Write` and
>   `testing · Bash (test runner)` are now what a real daemon's field produces;
> - the stub can no longer drift from the daemon unnoticed: the wire shapes the
>   page depends on are asserted against a **real spawned daemon** in
>   `src/ui/stream.test.ts` — the board field's name, the stream framing, and
>   that `latestActivity.sequence` is the stream frame's own `id`. The lead
>   mutation-checked that last test against `board.ts`.

**Why `--screenshot` was not used this time.** Fix 3A makes every region
focusable, so landing on `/#board` moves focus into `#board`. Under
`chrome --screenshot`'s virtual-time mode that focus matched `:focus-visible` and
drew a 2px ring round the whole centre column. In a real interactive session
(`.shots/ringprobe.cjs`) the same load focuses `#board` with `:focus-visible`
false and no outline, and so does a real mouse click on the nav. A picture of a
ring nobody sees on arrival would have been honest-looking and wrong, so these
are taken the way the page is actually used. `shoot-cdp.cjs` reports any
element that *does* have a visible focus ring at capture time; none did.

**The fixture is in the harness, never in the product.** `src/ui/page.test.ts`
asserts that no ticket id, project id or money figure appears anywhere under
`packages/core/ui/`.

**What the stub deliberately refuses:** `GET /events` answers 503, so every
capture shows the page saying it is *polling* and not live — rule 9,
photographed rather than asserted. The live path is not evidenced by a picture
at all, because a picture cannot show motion: see "The live path" below.

| file | what it shows |
|---|---|
| `08-view-board-{dark,light}-{100,125}.png` | **Board view** (ruling 15): the six lanes in the centre; Needs you above Activity in the rail |
| `09-view-needs-you-{dark,light}-{100,125}.png` | **Needs you view**: the panel promoted to the centre, where a reason shown in full has the width it needs; the rail is Activity alone |
| `10-view-scope-{dark,light}-{100,125}.png` | **Scope view**: Scope and Conversation share the centre; the rail is the board view's, because Needs you is never hidden |
| `01-board-{oled,dark,light}-100.png` | the default page (no hash, so the board view), 1700×1900 |
| `02-board-{oled,dark,light}-125.png` | the same at 125% device scale |
| `03-lanes-wrap-1500-oled.png` | at 1500px the six lanes wrap to two rows of three. **All six are still visible** — no status is ever hidden |
| `04-rail-below-1100-light.png` | at 1100px the rail drops below the centre and the page scrolls as a page again |
| `05-stacked-800-oled.png` | at 800px everything stacks in one column |
| `06-gate-oled.png` | before a token is accepted: the two notices and the gate, and **no invented data** |
| `07-notices-coverage-and-pause-oled.png` | the font-coverage notice firing on non-Latin text, and the spend-cap pause banner with the fix that matches its `pauseReason` |

The view captures are the window, 1700×1000 (2125×1250 at 125%). Under a view the
page does not scroll — each column does — so the viewport *is* the screen.

## Found by taking these

- **The current view was invisible.** In the first view captures all three nav
  entries looked identical in every view: `app.js` set `aria-current="page"`, and
  no rule in the shipped skin drew it. The approved pass 3 design does
  (`.nav a[aria-current="page"]`); the rule was lost when the nav was removed and
  not restored with it. Restored verbatim, with a test in `src/ui/skin.test.ts`
  that fails if the attribute is styled by nothing — or styled invisibly.
- **Carried from the first set:** an artefact's path written into the `class`
  attribute and vanishing from the card, and a selector collision stacking
  "manager_assessment" on its byte count. Both fixed; `el()` now throws on a
  class name that is not lowercase-kebab.

**Observation, not a defect:** in the scope view the SCOPE document is capped at
19rem with a fade, leaving room above Conversation. That cap is in the approved
pass 3 design exactly as drawn, so it is left as designed; it is recorded here
because the scope view is the one place the room exists to use it.

## What screenshots are not evidence of

**Contrast.** A screenshot cannot tell 4.23:1 from 4.51:1 — which is how a 10px
element shipped at 4.23:1 in batch 14. Contrast is *computed* in
`src/ui/contrast.test.ts` over every foreground token against every surface token
in all three themes, plus every fill-on-text pair.

**The live path.** A screenshot pair is not proof of motion. Ruling 18's
animation was proven by a run: `.shots/motionproof.cjs` samples an organism on
every animation frame over DevTools while the stub streams a burst — the node
was replaced twice mid-pass and the pass still completed (1050ms against a
computed 1044ms) — and a control run with the fast-forward disabled showed the
pass destroyed at 400ms. The polling fallback was proven the same way with the
stream refused.

**Keyboard reach.** Fix 3A was verified with real Tab, ArrowDown and PageDown
keypresses (`.shots/keyscroll.cjs`), not from these pictures.

## Visible in `08`–`10` and `01`/`02`, against the acceptance list

- three views as hash links, the current one marked
- six lanes over eight statuses, `CANCELLED` struck through in the terminal lane
- organisms from `ui/organism.js`, coloured by ticket status, keyed by tier
- `latestActivity` as the live line: `writing · Write`, `testing · Bash (test runner)`
- artefact by kind — a path for `file`, a length for a text-bearing kind
- "at least $0.55 of $12.00 · fallback rate used" with the estimate caveat
- an inbox reason shown **in full**, wrapping, never truncated
- a long unbroken path in the scope wrapping inside its own region

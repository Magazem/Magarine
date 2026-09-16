# Batch 15: the page the daemon serves — screenshot evidence

Interface Designer, Role B. Captured 2026-09-16 from `packages/core/ui/` as
committed, rendered in headless Chrome 141.

**How to reproduce.** These are NOT hand-composed mockups. Each is the real
`ui/index.html`, loading the real `ui/tokens.css`, `ui/skin-brutalist.css`,
`ui/organism.js`, `ui/fontCoverage.js` and `ui/app.js` over HTTP, with the two
shipped `.woff2` files. A throwaway stub in `.shots/` (gitignored) answers the
daemon routes with responses shaped exactly like the real ones — `BoardResult`,
`InboxItem[]`, `EventRow[]`, `ConversationEntry[]`.

> **CORRECTION, 2026-09-16, added by the lead after these were captured.**
> The claim below that the stub answers "shaped exactly like the real ones" is
> **not true of one field, and it invalidates part of what these pictures show.**
> The stub's board rows carried `latest_activity`; the daemon sends
> `latestActivity` (`commands/board.ts` 98 and 231). The page read the stub's
> spelling, so **the "doing" line visible under running tickets in these
> captures is a line no real daemon would ever have rendered** — against a real
> daemon `activityOf()` returned null for every ticket, always.
>
> The stub was written to match the page, so it agreed with the page's mistake:
> a fixture validating the page against itself, which is the same failure shape
> as a checker that cannot fail. Found by the Interface Designer against a real
> spawned daemon, not by this suite and not by these screenshots.
>
> Everything else here — layout, palette, contrast, organisms, the polling
> notice, the responsive states — is unaffected and stands. These captures are
> being re-shot against a corrected stub; until they are, read the activity
> line and nothing else as unreliable.

**The fixture is in the harness, never in the product.** `src/ui/page.test.ts`
asserts that no ticket id, project id or money figure appears anywhere under
`packages/core/ui/`. Every organism, colour and layout below is what the real
code produced from daemon-shaped input.

**What the stub deliberately refuses:** `GET /events` answers 503. That is why
every capture shows the page saying it is *polling* and not live — which is the
behaviour rule 9 requires, photographed rather than asserted. The live path is
verified separately against Role A's real route.

| file | what it shows |
|---|---|
| `01-board-oled-100.png` | the default environment, 1700px, 100% |
| `01-board-dark-100.png` | navy, 100% |
| `01-board-light-100.png` | warm paper, 100% |
| `02-board-oled-125.png` | the same, at 125% device scale |
| `02-board-dark-125.png` | " |
| `02-board-light-125.png` | " |
| `03-lanes-wrap-1500-oled.png` | at 1500px the six lanes wrap to two rows of three. **All six are still visible** — no status is ever hidden. |
| `04-rail-below-1100-light.png` | at 1100px the rail drops below the centre |
| `05-stacked-800-oled.png` | at 800px everything stacks in one column |
| `06-gate-oled.png` | what the page shows before a token is accepted: the two notices and the gate, and **no invented data** |
| `07-notices-coverage-and-pause-oled.png` | the font-coverage notice firing on non-Latin text from the daemon, and the spend-cap pause banner with the fix that matches its `pauseReason` |

## What each capture is evidence of

**Contrast is not evidenced here, deliberately.** A screenshot cannot
discriminate 4.23:1 from 4.51:1 — which is exactly how a 10px element shipped
at 4.23:1 in batch 14. Contrast is *computed* in `src/ui/contrast.test.ts` over
every foreground token against every surface token in all three themes, plus
every fill-on-text pair. No reachability judgement, no exemptions.

What the screenshots are good for is the class of defect no test I had planned
would have caught, and two real ones were found this way:

- an artefact's path was being written into the `class` attribute and silently
  vanishing from the card (`el(tag, text)` missing its middle argument);
- a pass-3 selector collision gave the artefact chip's kind label the step
  label's fixed 74px box, so "manager_assessment" rendered with its byte count
  on top of it.

Both are fixed, and `el()` now throws rather than accepting a class name that
is not lowercase-kebab, so a daemon value cannot become one again.

## Visible in `01`/`02`, against the acceptance list

- six lanes over eight statuses, `CANCELLED` struck through in the terminal lane
- organisms from `ui/organism.js`, coloured by ticket status, keyed by tier
- `latest_activity` as the live line: `writing · Write`, `testing · Bash (test runner)`
- artefact by kind — a path for `file`, a length for a text-bearing kind
- "at least $0.55 of $12.00 · fallback rate used" with the estimate caveat
- an inbox reason shown **in full**, wrapping, never truncated
- a long unbroken path in the scope wrapping inside its own region

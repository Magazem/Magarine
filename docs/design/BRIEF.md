# Magarine — interface brief

Batch 14, step 1. Author: Interface Designer. Date: 2026-09-15.
Mocks: `docs/design/mocks/*.html` — open them from disk, no server needed.

**Pass 2.** The owner approved the layout and the UX in pass 1 and rejected the skin as "very AI generic".
**Sections 1, 4 and 5 are unchanged and already approved. Section 2 is the new visual identity.** This is a
reskin: same bones, same behaviour, different everything you can see.

Layout reference: Scape Argus (fleet view, status pill, structured log table, mission note as the central
document). Magarine's equivalents: project → their manager, tickets → their child sessions, `SCOPE.md` → their
mission note, our activity log → their log table.

---

## 1. Layout — approved, unchanged

```
┌──────────────────────────────────────────────────────────────────────────┐
│ MAGARINE · UI WALK · proj_393c…  │  $0.37 equivalent · refreshed · theme  │
├────────────┬─────────────────────────────────┬───────────────────────────┤
│ FLEET      │ CENTRE                          │ RAIL                      │
│            │                                 │                           │
│ project    │ [ PAUSED banner, when paused ]  │ Needs you                 │
│  |- ticket │                                 │  · reason, in full        │
│  |- ticket │ Board — or —                    │  · the control to clear it│
│  \- ticket │ Scope document + Conversation   │                           │
│            │                                 │ Activity (log table)      │
│ 268px      │ minmax(0, 1fr)                  │ 404px                     │
└────────────┴─────────────────────────────────┴───────────────────────────┘
```

Three columns, each scrolling on its own. **≤ 1180px** (1280px at 125% scaling is 1024, comfortably inside this)
the rail drops full-width under the centre. **≤ 820px** everything stacks. Nothing is ever hidden; things move.

## 2. Identity — brutalism

The first pass had rounded corners, soft shadows, gentle slate-blue and system fonts. That combination is the
generic look. This is the deliberate opposite, and every choice below is the same choice restated: **make the
structure visible instead of hiding it.**

**Nothing is rounded.** `--r: 0px`. No shadow anywhere on the page.

**Every rule is meant to be seen.** Borders get their own scale — `--rule: 1px` / `--rule-2: 2px` /
`--rule-3: 3px`. Panels butt against each other and share a rule, so the page reads as one drawn grid rather than
a stack of floating cards. Every table cell is ruled on all four sides.

**Nothing eases.** `transition: none` globally. Hover inverts a control instantly — foreground and background
swap. No fade, no lift, no scale.

**One typeface, doing everything.** JetBrains Mono, embedded in the stylesheet as base64 so nothing is fetched
and nothing is installed. Mood: terminal, CLI, precision — which is what this page is. Hierarchy now comes from
weight (400 to 800), size, case and rules rather than from a second family, and the font is **variable**, so the
heavy weights are real rather than browser-synthesized.

**Including the fleet tree, which is why it is ASCII.** The hierarchy is drawn with `|-` and `\-`, not with
box-drawing characters. The embedded subset is `U+0000-00FF` plus `U+2000-206F`; the `U+2500` box-drawing block is
not in it, so those glyphs would have silently fallen back to the system mono and shown tofu on any machine whose
mono lacks them. Same reason the pause banner is marked `[!]` rather than a filled square.

**Palette — "code dark + run green".**

| | dark (ships) | light |
|---|---|---|
| background / foreground | `#0F172A` / `#F8FAFC` | `#F1F5F9` / `#0F172A` |
| card / muted | `#1B2336` / `#272F42` | `#FFFFFF` / `#E2E8F0` |
| border / muted-fg | `#475569` / `#94A3B8` | `#0F172A` / `#475569` |
| accent (on accent) | `#22C55E` (`#0F172A`) | `#15803D` (`#FFFFFF`) |
| destructive / ring | `#EF4444` / `#FFFFFF` | `#B91C1C` / `#0F172A` |

**Green is reserved and never decorative.** It marks exactly three things: something genuinely running, the one
real action in a panel, and a file that actually got delivered. Everywhere else the page is greyscale and rules.

Dark is the default and is what ships. Light is one attribute plus a second token block, and it is brutalist too —
paper, black rules, the same green — not an inversion of the dark theme.

**Two readings of the supplied palette, stated so they can be overruled.** `primary #1E293B` is darker than
`card`, so a button filled with it has no presence; it is used as a surface and the accent carries primary
actions instead. And the palette supplies two semantic colours for eight ticket statuses, so the status hues
below are extensions in the same idiom, not inventions of a new one.

## 3. States

**Ticket pill** — the eight real statuses from `packages/core/src/types.ts`, nothing invented. The rule that
carries the meaning: **filled means live or waiting on you; outlined means nothing to do.**

| filled block | | outlined |
| --- | --- | --- |
| `BLOCKED` `#F59E0B` | | `OPEN` |
| `FAILED` `#EF4444` | | `DONE` (green) |
| `IN_PROGRESS` `#22C55E` | | `CANCELLED` (struck through) |
| `REVIEW` `#A855F7` | | |
| `READY` `#38BDF8` | | |

Colour *and* the word, always. A `MGR` tag marks a manager ticket. Board and fleet are both ordered by
`board.ts`'s own `STATUS_ORDER`.

**Project pill** — Working · Needs you · Paused · Idle.

**Pause banner** — two causes, two controls, because a cap is cleared by a bigger number and an adapter pause is
not: `spend_cap` → amount field + Raise cap; `adapter_unavailable` → Resume, after logging in.

**Inbox item** — `worker_needs_user_decision` → answer field; `worker_needs_review` → Approve / reject-reason /
Reject; `worker_failed_final` → Retry.

**Conversation entry** — `owner_message` · `manager_reply` · `manager_assessment` · `question` · `scope_updated`,
one rule colour each. Only a still-unanswered `question` carries a live answer box.

**Motion — one kind, and it steps.** The `IN_PROGRESS` marker blinks like a terminal cursor: a hard on/off at
1.06s, `step-end`, no fade. It appears on **every running ticket**, so on a screen with one running ticket it
shows twice — once in the fleet, once on its board row. The `1 RUNNING` chip in a panel head does *not* blink: it
states a count, it is not a ticket. Nothing else on the page moves at all, and `prefers-reduced-motion` stops even
this.

**Commands are shown as commands** — inverted block, a `$` prompt, wrapped, never clipped.

## 4. The rules that keep real data from breaking it — unchanged

Every string in the mocks is real, from `docs/evidence/batch-11-page/` and from the message composers in
`packages/core/src`.

1. **`minmax(0, 1fr)` for the centre column and `min-width: 0` on every grid and flex item.** A grid item's
   automatic minimum is its min-content width, so without this a long unbreakable string can widen the whole grid
   instead of wrapping inside its column. Preventive; rule 2 does the actual wrapping.
2. **`overflow-wrap: anywhere` on everything machine-generated** — ids, paths, commands. `white-space: pre-wrap`
   alone does *not* break a long word, so on the current page a string like
   `tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f` pushes its container wider instead of wrapping, and the page scrolls
   sideways once the window is narrow enough. This is a fix, not a preference.
3. **The inbox reason is never truncated, clamped or scrolled away.** It wraps, in full, however long. A ticket
   *title* may clamp to two lines in the fleet list, because the board always shows it whole; a *reason* never may.
   Now that the page is entirely monospace, reasons also get a capped measure (74ch) and 1.7 leading, because mono
   prose needs both to stay readable at length.
4. **A long scope document scrolls inside its own panel**, with a fade at the foot so a cut-off line reads as
   "there is more" rather than as a bug. It never pushes the conversation below the fold.

Footnotes — the model and its justification, the cost explanation, a failure reason — are `<details>` disclosures
marked `[+]` / `[-]`, not hover tooltips: keyboard-reachable, and they stop a long justification from dominating
the row it footnotes.

Backtick-quoted spans in daemon messages render as command blocks; the backtick characters are not printed.

*The design decisions end here. What follows is for whoever implements it.*

## 5. Accessibility, measured

Contrast was computed, not eyeballed. **Every text pair passes 4.5:1 in both themes.** Tightest in dark:
`REVIEW` block 4.51:1, `FAILED` block 4.74:1, `CANCELLED` 4.80:1 — that last one is why `--st-cancelled-fg` is
`#828FA6` in dark and not the `#64748B` it started as, which measured 3.29:1 and failed. Tightest in light:
command green 4.58:1.

Skip link · every control a real `<button>`/`<input>` with a label · hard 3px focus ring, no offset · colour never
the sole signal (status blocks carry the word, `CANCELLED` is also struck through) · `<th scope>` on both tables ·
no horizontal scroll of the page at any width down to a 520px viewport · dark and light both rendered and checked
on all three screens.

**The board is five columns and JetBrains Mono is wider than the system mono it replaced**, so the column model was
re-measured for it: at 1000px the old split made `EQUIVALENT COST` overrun its neighbour and `at least $0.12`
collide with the attempts column. Headers now wrap, a multi-word figure is allowed to wrap, and below `34rem` the
board scrolls **inside its own panel** rather than overlapping or widening the page. Nothing is ever hidden.

## 6. Implementation notes

- **Plain HTML and CSS**, one file each, inline `<style>` and inline `<script>`, zero fetches. Opens identically
  from `file://` and from the daemon.
- **The font costs 42 KB of base64** — JetBrains Mono v24, latin subset, one variable file covering 400–800.
  Two static weights would have cost ~250 KB. `page.ts` grows by that 42 KB and by nothing else.
- **Licence: SIL OFL 1.1.** Full text at `packages/core/licenses/JetBrainsMono-OFL.txt` — beside the code that carries the font, not
  under `docs/`, because docs are not shipped with `packages/core`; the copyright notice is in a comment
  directly above the `@font-face`. Both must ship wherever the font does.
- **Latin subset only.** Covers every character our strings use, em dash included. A non-Latin character falls
  back to the system mono for that character.
- The mocks contain **no backtick and no `${`**, so the markup pastes into `page.ts`'s template literal unescaped.
  Keep it that way — check before committing.
- The theme is one attribute on `<html>` plus a few lines of script. No module, no CDN, nothing to build.
- The board shows artefacts beside DONE (`FILE introduction.md`), per batch 13 §1c. `BoardTicket` does not carry
  them yet; that field is the one thing here the implementation needs that does not exist today.
- The mocks compose states from across the real captures so every status appears somewhere. The strings are real;
  the particular combination on one screen is arranged.

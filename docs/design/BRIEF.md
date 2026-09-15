# Magarine — interface brief

Batch 14, step 1. Author: Interface Designer. Date: 2026-09-15.
For approval before anything is wired. Mocks: `docs/design/mocks/*.html` — open them from disk, no server needed.

Reference: Scape Argus (fleet view, status pill, structured log table, mission note as the central document).
Magarine's equivalents: project → their manager, tickets → their child sessions, `SCOPE.md` → their mission note,
our activity log → their log table.

---

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Magarine · UI Walk · proj_393c…  │  $0.37 equivalent · refreshed · theme  │
├────────────┬─────────────────────────────────┬───────────────────────────┤
│ FLEET      │ CENTRE                          │ RAIL                      │
│            │                                 │                           │
│ project ●  │ [ PAUSED banner, when paused ]  │ Needs you                 │
│  ├ ticket ●│                                 │  · reason, in full        │
│  ├ ticket ●│ Board — or —                    │  · the control to clear it│
│  └ ticket ●│ Scope document + Conversation   │                           │
│            │                                 │ Activity (log table)      │
│ 268px      │ minmax(0, 1fr)                  │ 404px                     │
└────────────┴─────────────────────────────────┴───────────────────────────┘
```

Three columns, each scrolling on its own, so reading the log never loses your place in the scope document.
**≤ 1180px** (1280px at 125% scaling is 1024, comfortably inside this) the rail drops full-width under the centre. **≤ 820px** everything
stacks in one column. Nothing is hidden at any width; things only move.

The fleet is the navigation and the status display at once: the project on top, its tickets nested beneath it on a
guide line, each with its own pill. That nesting is the one idea taken wholesale from Argus.

## 2. Tokens

All CSS custom properties, all in one block at the top of the file. Changing the look is editing that block.

| Group | Values |
|---|---|
| Type | two **system** stacks — sans for prose, mono for machine output. No web font: the page is served on loopback and must work offline. |
| Type scale | 11 / 12 / 13 / 15 / 18px (`--t-xs … --t-xl`), 13px body |
| Spacing | 4 / 8 / 12 / 16 / 24 / 32 (`--s1 … --s6`). Nothing in the layout uses a number off this scale. |
| Radius | 4 / 7 / 11 (`--r1 … --r3`) |
| Colour | `--bg --bg-sunk --panel --panel-2 --panel-3 --line --line-soft --fg --fg-2 --fg-3 --accent` |
| Status | `--st-<status>-fg` / `--st-<status>-bg`, one pair per ticket status, per theme |
| Motion | `--dur: 120ms`, one easing curve |

**Sans for what a person wrote, mono for what the machine emitted.** That single contrast carries the whole
typographic system and costs nothing, which is why no web font is missed.

Dark is the default (`data-theme="dark"` in the markup, so it is never light for a frame). Light is one button and
a second token block — it is a real theme, not an inversion. Both were checked for contrast at body and meta sizes.

## 3. States

**Ticket pill** — the eight real statuses from `packages/core/src/types.ts`, nothing invented:
`OPEN` · `READY` · `IN_PROGRESS` · `REVIEW` · `DONE` · `BLOCKED` · `FAILED` · `CANCELLED`.
Colour *and* the word, always, so colour is never the only signal. A `MGR` tag marks a manager ticket.

**Project pill** — Working · Needs you · Paused · Idle.

**Pause banner** — two causes, two different controls, because a cap is cleared by a bigger number and an adapter
pause is not: `spend_cap` → amount field + Raise cap; `adapter_unavailable` → Resume, after logging in.

**Inbox item** — `worker_needs_user_decision` → answer field; `worker_needs_review` → Approve / reject-reason /
Reject; `worker_failed_final` → Retry. Left border carries the kind's colour.

**Conversation entry** — `owner_message` · `manager_reply` · `manager_assessment` · `question` · `scope_updated`,
one border colour each. Only a still-unanswered `question` carries a live answer box.

**Motion** — exactly one thing moves: the dot on an `IN_PROGRESS` pill breathes, and only while work is running.
Everything else changes colour, never position, so nothing shifts under the pointer. `prefers-reduced-motion`
turns even that off.

## 4. The rules that keep real data from breaking it

Every string in the mocks is real, from `docs/evidence/batch-11-page/` and from the message composers in
`packages/core/src`. Real data is long and ugly, and these four rules are what survive it:

1. **`minmax(0, 1fr)` for the centre column and `min-width: 0` on every grid and flex item.** A grid item's
   automatic minimum is its min-content width, so without this a long unbreakable string can widen the whole grid
   instead of wrapping inside its column. Preventive; rule 2 is what actually does the wrapping.
2. **`overflow-wrap: anywhere` on everything machine-generated** — ids, paths, commands. `white-space: pre-wrap`
   alone does *not* break a long word, so on the current page a string like
   `tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f` pushes its container wider instead of wrapping, and the page scrolls
   sideways once the window is narrow enough. This is a fix, not a preference.
3. **The inbox reason is never truncated, clamped or scrolled away.** It wraps, in full, however long. A ticket
   *title* may clamp to two lines in the fleet list, because the board below always shows it whole; a *reason*
   never may. Truncating it would defeat the panel's only purpose.
4. **A long scope document scrolls inside its own panel**, with a fade at the foot so a cut-off line reads as
   "there is more" rather than as a bug. It never pushes the conversation below the fold.

Footnotes — the model and its justification, the cost explanation, a failure reason — are `<details>` disclosures,
not hover tooltips: reachable by keyboard, and they stop a long justification from dominating the row it footnotes.

Backtick-quoted spans in daemon messages render as code chips; the backtick characters themselves are not printed.

*The design decisions end here. What follows is for whoever implements it.*

## 5. Accessibility, checked

Skip link · every control is a real `<button>`/`<input>` with a label · visible 2px focus ring on everything
focusable · colour never the sole signal · `<th scope>` on both tables · no horizontal scroll at any width down to
a 520px viewport · dark and light both verified.

## 6. Implementation notes, for whoever wires this

- The mocks are **plain HTML and CSS**, one file each, inline `<style>` and inline `<script>`, system fonts, zero
  fetches. They open identically from `file://` and from the daemon.
- They contain **no backtick and no `${`**, so the markup pastes into `page.ts`'s template literal unescaped.
  Keep it that way — check before committing.
- The theme is one attribute on `<html>` plus a few lines of script. No module, no CDN, nothing to build.
- The board mock shows artefacts beside DONE (`file introduction.md`), per batch 13 §1c. `BoardTicket` does not
  carry them yet; that field is the one thing here the implementation needs that does not exist today.
- The mocks compose states from across the real captures so that every pill appears somewhere. The strings are
  real; the particular combination on one screen is arranged.

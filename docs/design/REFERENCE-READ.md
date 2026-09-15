# Reading the owner's reference

Interface Designer. 2026-09-15. A read of `propos/`, requested before anyone commits to pass 3.
**Nothing here is built yet. Pass 3 has not started.**

---

## 0. First: `propos/` holds two different things, and only one is the owner's new direction

| | what it is |
|---|---|
| `91451e7d-*.png` + `12ui-5132548c-*.html` + `12ui-63f305a1-*.web-project/` | **The owner's new visual direction.** One design, three formats. |
| `fleet-and-board/` | **A Next.js port of my pass 2** — not a second proposal. |
| `Convert mockups to HTML/` | An empty Figma→React/Vite scaffold. Boilerplate. |

`fleet-and-board/` carries my pass-2 markup verbatim: the `35% / 19% / 12% / 20% / 14%` colgroup, the
`num spent phrase` cost cell with "at least … live estimate", my `#828FA6` contrast fix, my comment prose
("Brutalism does not ease"). Someone has taken my mocks and ported them — and **evolved** them: three themes now
(OLED default, deep navy, warm paper), a second humanist family beside the mono, "Living Brutalism" separating
zones by surface rather than heavy borders.

**Two things follow.** It is a fork of the pass the owner has not yet ruled on, so somebody should know it exists
before it diverges further. And it is **Next.js + React + Tailwind + shadcn** — the build-step, component-kit
stack this project explicitly ruled out. Adopting it would reverse that ruling, which is not a design decision.

## 1. What the reference actually is

Technically it is closer to us than it looks: **one inline `<style>`, zero `<script>`, 16 inline SVG icons**, no
framework at runtime. Its only network dependency is three Google Fonts — **Inter** (UI text), **Share Tech Mono**
(machine output), **Caveat** (handwritten annotations) — all three shippable as local files under the
Strategist's new ruling. The 1 MB is **713 KB of inline base64 PNG**: 29 images, the agent portraits and the
mascot.

## 2. The read

**It is warm, and mine is not.** That is the finding. My pass 2 is correct, measured and cold. This is *likable*.
The owner's "very AI generic" was never really about rounded versus square — Brutalism gave the page an identity,
but an austere one, and austerity is not what "a team of AI workers for your ideas" wants to feel like.

**Three things it does better than my pass 2, on the merits:**

1. **Columns beat a sorted table for the question people actually ask.** My board is one table ordered by
   `STATUS_ORDER`; you read it row by row to learn the shape of the work. Columns show the shape at a glance — five
   running, one blocked — without reading anything.
2. **Colour carries status structurally**, in the column itself, not only in a pill at the end of a row.
3. **The personas are the product's story made visible.** Named characters with faces are why the tagline lands.

**The risk it carries:** colour is everywhere, so nothing is reserved. My pass 2 has a rule — green means live,
actionable, or delivered, and nothing else. Here every column, tag and avatar is coloured. The reference survives
this because NEEDS YOU is a separate rail with bright buttons, but the rule has to be re-established deliberately
or the screen becomes decorative.

## 3. The criterion for the split

Not "is it pretty" but: **can the daemon actually produce this?**

A screen that displays a number the system cannot compute is batch 13's failure in a new costume — output that
reports more than was delivered. "DONE with nothing delivered" was made impossible at the contract level; a
progress bar showing `67%` when nothing measures progress is the same lie, on the primary screen, where it is
most believed. **The rule I would apply to this and to every future reference: if the daemon cannot produce the
value, the element does not ship, however good it looks.**

## 4. List A — visual direction, adoptable now, no product change

Every item below re-arranges or restyles data we already have.

1. **The warm palette.** Deep navy grounds; teal, blue, purple, pink and yellow accents. (Authoritative values
   should come from the `12ui` HTML's literal colours or a fresh database query — `design-tokens.json` is
   anti-aliasing noise extracted from an image and is not a usable palette.)
2. **Rounded corners and softer surfaces.** Reverses the brutalist `0px` deliberately.
3. **Three typefaces, each with a job**: Inter for prose, Share Tech Mono for ids/commands/machine output, Caveat
   for annotation *if it earns a role* — see §6.
4. **Kanban columns for the board**, keyed to our real statuses — see §6 for the mapping question.
5. **Ticket cards**: id, relative age, title, description, assignee, status. All real fields today.
6. **NEEDS YOU as avatar-led cards** with the two real actions per event type. We already have exactly these three
   shapes: Approve/Reject, Answer, Retry. This panel needs no product change at all.
7. **Activity feed** with coloured dots and coloured actor names. We have the events.
8. **Segmented top nav** — FLEET & BOARD / NEEDS YOU / SCOPE. All three views exist.
9. **Sun/moon theme toggle.**
10. **Inline SVG icons** — which is what the reference itself does, and what I recommended over an icon font.
11. **Relative times** ("2h ago") over raw ISO, with the exact timestamp on demand.

## 5. List B — product changes, the Strategist's call, not mine

For each, what the reference shows, why it does not exist, and the honest substitute if one exists.

1. **Per-ticket progress percentage and progress bars.** *Nothing measures completion.* A worker is an opaque
   process; we have status and attempts, not a fraction. **This is the single most dangerous element on the
   screen.** Honest substitutes that are real: `attempts` as a segmented meter (1/3), or for a running ticket a
   spend-against-budget bar. Both are true numbers. If neither is wanted, the bar goes.
2. **Eight persistent named agents with portraits and live status.** Our workers are ephemeral per-ticket
   processes; there is no standing roster. A sidebar of eight agents with live WORKING/READING/BLOCKED implies a
   product we do not have. **Cheaper honest versions:** personify the two roles that *are* persistent (Manager and
   worker), or attach a deterministic persona to each ticket derived from its id and show the model it ran.
3. **"Agent Generator" / "Add new agent".** No such concept exists at any level.
4. **Per-ticket conversation tabs** (`#142 #136 #135`). Our conversation is project-scoped; per-ticket we have
   questions only. **Honest substitute:** keep the project thread and add a per-ticket *filter* — activity already
   carries `entityId`, so filtering is real where threading is not.
5. **Ticket tags** (`backend`, `security`, `ui`). No tag or label field on a ticket.
6. **Global search with ⌘K** across tickets, agents and projects. No endpoint.
7. **Desktop window chrome** (macOS traffic lights). We are a page served on loopback, not a desktop app. Drawing
   fake window controls in a browser tab is a small lie that makes every other element less trustworthy.
8. **Illustrations as payload.** 713 KB of PNG. The Strategist's ruling covers **fonts and icons**; illustrations
   are not obviously inside it. That is a scope question, not something I should assume either way.

## 6. Three open questions I cannot settle alone

**a. The column set.** The reference shows five columns; we have eight statuses. My proposal:
`WAITING (OPEN + READY)` · `IN PROGRESS` · `REVIEW` · `BLOCKED` · `FAILED` · `DONE (+ CANCELLED, struck through)`
— six columns, covering all eight, nothing hidden. `BLOCKED` and `FAILED` stay separate because they need
*different actions* from the owner. **A column set that does not cover the state machine silently hides tickets,
and "nothing is ever hidden" is a rule I already committed to.**

**b. Where the table goes.** The reference has a grid/list toggle in the corner. **I propose the approved pass-2
table becomes the list view** — it is denser, it survives narrow widths, and it is the thing the owner already
signed off. Kanban is the grid view and the default. Below the breakpoint where six columns stop fitting, the
board falls back to the list view rather than crushing. This also gives `blockedBy` and the PAUSED banner a home:
the banner spans above the columns as it does now, and `blocked by #id` sits on the card.

**c. Caveat.** This is the highest-risk item in list A, not a safe one. In the reference **every Caveat string is
an annotation about the mockup** — "Give your agents unique identities!" is the tool talking to the owner, not UI
copy. Adopting the font without a real role means inventing handwriting-flavoured chrome. It is also the most
visible carrier of the warmth the owner responded to. **The owner should decide whether the product speaks in
that voice**, and where — a tagline and empty states are defensible; scattered annotations are not.

## 7. What survives from pass 2 unchanged

Worth stating so it is not thrown out with the brutalism. **None of this is skin:**

- The measured contrast discipline and the ≥4.5:1 floor in both themes.
- The wrapping rules — `minmax(0, 1fr)`, `min-width: 0`, `overflow-wrap: anywhere` on machine strings.
- **The inbox reason shown in full, never truncated.**
- The `<details>` disclosure pattern for model, cost and failure reasons.
- **The artefact-by-kind rule** — `file` shows its path, text-bearing kinds show kind and length, never the body.
- Fidelity to `board.ts`'s real `STATUS_ORDER` and to the real status union.
- Real strings everywhere, never lorem ipsum.
- The pause banner that names the command that clears it.

And, most importantly: **the layout and UX the owner already approved.** Pass 3 keeps them. Adopting kanban is a
change to how the *board panel* renders, inside the approved three-column frame — it does not reopen what was
signed off.

## 8. Recommendation

**Pass 3 = the warm reskin, plus the board becoming kanban. Not a third from-scratch pass.**

1. Adopt list A whole. It is a real change and it answers the rejection directly.
2. Take nothing from list B into the mock until the Strategist rules. Where an honest substitute exists (attempts
   meter, per-ticket filter, role personas) I would show the substitute and label it as such, so the owner sees a
   screen that could actually be built.
3. Settle §6a, §6b and §6c before drawing.
4. Same constraints as before: static mocks, no framework, no runtime fetch, fonts as local files.
5. **Do not port `fleet-and-board/`.** It is a fork of the pass under review, on a stack this project ruled out.

**One caution, plainly.** The owner has not given a verdict on pass 2. This reference tells us what they want far
better than a verdict would, and I would act on it — but it should be recorded as *superseding* pass 2's skin, not
as pass 2 having failed. The layout it is built on is the layout they approved.

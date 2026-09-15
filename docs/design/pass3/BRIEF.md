# Magarine — pass 3: Living Brutalism

Interface Designer. 2026-09-16. Designed to the owner's brief
(`propos/Convert mockups to HTML/src/imports/pasted_text/magarine-visual-identity.md`), **not** to the image they
also sent — the image contains cartoon avatars and a mascot, which that brief explicitly forbids.

Screens: `1-fleet-and-board.html` · `2-needs-you.html` · `3-scope-and-conversation.html`
Shippable CSS: `tokens.css`. Preparation gallery: `gallery.html`.

---

## 1. What this is

Pass 2's verdict was **right family, wrong execution**. Brutalism stays; the corrections are the owner's own list.

| pass 2 | pass 3 |
|---|---|
| everything bordered and carded | zones separate by **surface**; structure is brutalist, every component is not |
| all-mono | **JetBrains Mono + IBM Plex Sans**, each with the job the brief names |
| navy dark | **OLED near-black**, the default environment |
| cool slate light | **warm paper** — engineering notebook, not sterile white |
| agents as text rows | **generated organisms** with a live activity line |
| one blinking marker | motion on **every real event**, and nowhere else |
| table board | **six-column kanban**, the table kept as the list view |
| browser page | **native window** — no browser chrome, no imitation window controls |

## 2. The agent, in three channels that never collide

The hard problem: a glyph has to say *which agent*, *what it is doing*, and *what state its ticket is in*, at 18px,
simultaneously. If any two share a channel the board becomes noise.

- **IDENTITY = SHAPE.** The lit cells are the organism's body. Deterministic, stable forever.
- **ACTIVITY = MOTION.** Which cells fire and in what order when an event lands — scan, fill, alternate, scatter,
  assemble, line-by-line, rearrange.
- **STATUS = COLOUR.** One colour per ticket, inherited.

Identity has the better claim on shape **because it must be constant**. An agent should be recognisable before you
read anything.

**The rule: it animates when a real `worker_progress` event arrives, once, then stops.** It is never a loop. A
loader spinning while nothing runs is precisely the lie this batch exists to prevent.

## 3. The generator

`tokens.css` ships the CSS; the function is inline in each screen and **runs in the page** — every organism you
see is what the algorithm produced, not art.

- **Integer arithmetic only** — FNV-1a and xorshift32 via `Math.imul` and `>>> 0`. No floats, no `Math.random`,
  no `Date`. The same seed renders identically on every machine.
- **The seed carries a generator version, and it functions.** A seed may arrive *already carrying* one
  (`mg.v1:agent_abc`); when it does, the generator hashes with **that** version rather than re-prefixing. So when
  `GLYPH_VERSION` moves to 2, a profile stored under v1 keeps its exact look and only new seeds get the new
  language &mdash; which is what the constraint asked for. Prepending unconditionally, which is what an earlier
  cut did, made the version inert: it restyled every existing avatar, and a stored seed could not round-trip
  because it hashed as `mg.v1:mg.v1:agent_abc`. Proven both ways: `organism("mg.v1:X")` equals `organism("X")`
  today, and differs from `organism("mg.v2:X")`.
- **What makes the shape, and nothing else does:**

  | | identity comes from |
  |---|---|
  | **batch 14** | **tier = family + symmetry** |
  | **batch 15** | **purpose = family, policy = symmetry, name-hash = the cell draw** |
  | always | **status = colour** — colour is never part of identity |

- **Density is struck as an identity signal.** It is a soft weight that stops a creature being blank or solid,
  and nothing more. Measured at scale the tiers overlap almost completely on density, so a reader cannot use it
  to tell agents apart and no comment, doc or brief may claim they can. Symmetry and family carry identity
  because they hold **by construction**; density is a probability and does not.

**Batch 14 has no purpose and no policy, so the tier selects family and symmetry.** Choosing them *by
construction* rather than from the hash is the point: derived from the hash they were a coin flip per tier, and
two tiers came out looking alike.

| tier | family | symmetry | density (weight only) |
|---|---|---|---|
| `fable` | ring | quad | 4/16 |
| `opus` | core | quad | 9/16 |
| `sonnet` | lattice | mirror-x | 7/16 |
| `haiku` | core | mirror-x | 7/16 |
| *unknown* | lattice | mirror-y | 8/16 |

**Symmetry is an invariant, not an intention.** Every cell write goes through `put()`, which writes a whole
symmetry orbit at once; there is deliberately no other way to touch the grid. An earlier version clamped the
lit-count by writing single cells, which broke symmetry on roughly three quarters of `fable` seeds and **broke it
silently** — the few hand-picked seeds anyone had looked at never triggered the clamp. That is why the invariant
is now proved by machine over 2000 seeds per tier rather than by eye over five.

**`check-organism.js` is committed beside the screens and extracts the generator *from the shipped page*,** so
there is no second copy to drift. `node docs/design/pass3/check-organism.js [page.html]` proves symmetry, a lit
core, the lit-count band, tier distinctness, determinism, the version round-trip, integer-only arithmetic, and
that `put()` is the only thing that can write a cell. All three screens carry a byte-identical generator and all
three pass.

**And `--self-test` proves the checker itself can fail.** A check that cannot fail is worse than no check, and two
of these could not: one compared rendered bitmaps and called that "the tiers are distinct", when identity is
*(family, symmetry)* and two tiers could be given identical traits while their bitmaps still differed because the
seed strings differ; the other read the acceptable lit-count band **from the generator**, so a generator declaring
`0..25` acceptable passed the check whose entire job was rejecting blank and solid organisms. Both are the same
shape as a version string that is present but inert.

So: **the checker now owns its own constants** — the hard band `6..19` is the checker's, the generator's declared
band is checked *against* it rather than trusted — and **distinctness is asserted where identity actually lives**,
on the `(family, symmetry)` pairs. `node docs/design/pass3/check-organism.js --self-test` mutates the page six
ways and requires every one to be rejected and the unmutated baseline accepted.

**The unknown tier gets its own creature on purpose**, so a model we cannot price is visibly not one of the four —
it is already flagged in the cost column, and now it is flagged in the fleet too.

**What is keyed to what, and when.** The organism is keyed to the **model tier** in batch 14 — a field that exists
today and is already on the board. In **batch 15** the seed becomes the agent's own profile and organisms become
per-agent. *Only the seed changes; the generator does not.* Screen 2 shows the consequence honestly: two Opus
workers share one organism today, because today they share the only identity there is.

## 4. Activity, and where it comes from

The live line under a running ticket is **`latest_activity`** — the most recent `worker_progress` event, mapped.

| state | source |
|---|---|
| reading | `Read` · `Grep` · `Glob` |
| writing | `Edit` · `Write` |
| running | `Bash` |
| testing | `Bash` naming a test runner |
| finishing | `StructuredOutput` |
| reporting | a text line |
| thinking | `thinking (~N tokens)` |

**`worker_progress` stays out of the activity feed.** 651 across a few runs would drown it; it reaches the screen
as a line on a card instead.

**Not drawn, because nothing produces them:** `planning` and `reviewing`. They are in the owner's list of states
and they remain open. **No progress percentages, ever** — nothing measures completion.

## 5. The board

Six columns, eight statuses, **nothing hidden** — `CANCELLED` shares the terminal column with `DONE`, struck
through, rather than being dropped.

`WAITING` (OPEN · READY) · `IN PROGRESS` · `REVIEW` · `BLOCKED` · `FAILED` · `DONE` (+ CANCELLED)

`BLOCKED` and `FAILED` stay separate because they want *different actions* from the owner.

**Six across only above 1600px.** Measured: at 1500px six columns are ~120px each and every title wraps to three
lines, which is "dense and chaotic". Below that they wrap to two rows of three — all six still visible, cards
readable. Below 860px everything stacks. **The approved pass-2 table is the list view**, behind the toggle.

**Cards carry the short ticket id**; the full id is in the list view, in Needs You, and in the conversation.
A card that spends three lines on an id is not dense, it is just full.

## 6. Needs you — the hand-back

Not an inbox. The moment autonomous work reaches a boundary and returns control, so it answers five questions:
**who** asked · **what** they were doing (the last event before they stopped) · **why** they stopped, in full ·
**what** is needed · **what happens next**.

The reason is **never truncated, clamped or scrolled away**. A half-shown reason is useless, which is the panel's
whole point.

## 7. Marked, not promised

- <code>mock</code> — the "simulate event" button. It exists only in these files. In the product the organisms
  tick when a real event lands, not when you press something.
- <code>bell · 16</code> — the Windows notification for Needs You; arrives with the shell.
- <code>mgr</code> — the Manager as a distinct standing agent; arrives with profiles in batch 15.
- <code>filter · 14</code> — the conversation is a per-ticket **filter** of one project thread, which is what the
  data supports. Per-ticket *discussion* is batch 17.

## 8. What survives from earlier passes, unchanged

Contrast measured rather than eyeballed (**worst pair 4.56:1, none below 4.5**, measured for every text token
against *every* surface token) · the
wrapping rules, `minmax(0, 1fr)` and `min-width: 0` · reason never truncated · **artefact by kind** — `file` shows
its path, a text-bearing kind shows its kind and a length, never its body · `STATUS_ORDER` fidelity · real strings
throughout · **no backtick and no `${`** anywhere, so it pastes into `page.ts` unescaped.

## 9. A requirement for whoever builds the woff2 files

The four files in this folder are ASCII apart from a handful of em-dashes in comments. **The rendered content is
not.** Across the three screens it uses:

| character | codepoint | count |
|---|---|---|
| `·` middle dot | `U+00B7` | 25 |
| `—` em dash | `U+2014` | 13 |

**Both must be in the subset when `JetBrainsMono.woff2` and `IBMPlexSans.woff2` are built**, or they fall back to
a system font mid-sentence &mdash; the same silent-fallback failure that made the fleet tree ASCII in pass 2.

Google Fonts' `latin` subset already covers both (`U+0000-00FF` plus `U+2000-206F`), so specifying `latin` is
sufficient. **A hand-rolled "ASCII only" subset would break both, and would do it silently.**

## 10. Open

- **Sans face.** IBM Plex Sans is in. Inter is the alternative and would be a token swap, not a redraw.
- **`planning` and `reviewing`** — unsourced, undrawn.
- **Two workers on one tier are indistinguishable** until profiles land. Visible on screen 2, by design.

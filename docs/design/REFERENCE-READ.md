# Reading the owner's reference

Interface Designer. 2026-09-15. **Supersedes my first version of this file entirely** — that one was written
before I had read the owner's own 686-line brief, and it was wrong in its central judgement.
**Pass 3 has not started.**

Source of truth: `propos/Convert mockups to HTML/src/imports/pasted_text/magarine-visual-identity.md`.

---

## 0. Two corrections, and the second one is mine

**The Orchestrator's:** they told me the reference "is not Brutalism". The owner's brief says *"Brutalism is part of
the identity"*, *"Keep the brutalist DNA already present in the mockups"*, and asks for **Living Brutalism** — its
evolution, not its replacement. Correct to flag.

**Mine, and it is larger.** I read the generated PNG as the target and wrote that *"the personas are the product's
story made visible"*. The owner's brief says the exact opposite, emphatically:

> Do NOT use: profile pictures · human avatars · robot mascots · cartoon characters · emojis · generic AI faces ·
> generic glowing circles

**The generated image contains eight cartoon human avatars and a mascot.** It violates the owner's brief in the
single area the brief is most emphatic about. I recommended adopting the one thing they explicitly forbade,
because I treated a tool's output as the owner's intent. **The PNG is a failed interpretation, not the target.**

I also called `propos/Convert mockups to HTML/` "empty Figma boilerplate" from a depth-2 listing. The owner's
entire brief was inside it. That was sloppy and it is what caused the error above.

## 1. What the owner actually asked for

**The frame:** Magarine is an *AI-orchestration-first development environment*, not an IDE with AI. The feeling
they want is *"I am operating a living system that develops software"*, and the test they set is that someone
seeing it thinks **"What the hell is this? There are software agents actually operating inside this
environment."** — not "that's a nice AI IDE."

**The architecture is locked.** Fleet, Board, Needs You, Scope, Conversation, Tickets, Agents, Managers,
Orchestrator, Activity, existing states, existing hierarchy. *"We are changing the VISUAL LANGUAGE, not the
PRODUCT."* Our three mocks were fed in as the source of truth — which confirms the layout was approved and the
skin was what they wanted evolved.

**Living Brutalism, defined by what it is not:** not black-borders-plus-white-plus-colourful-buttons-plus-shadows.
Not huge borders round everything. Not every element a card. Not childish, not exaggerated shadows, not random
colour. *"Structure can be brutalist. Every component does not need to be."* The blend they name is
**brutalist structure + developer notebook + technical workstation + AI orchestration + living system**, and the
emotional reference is *"a developer's notebook that became a living command center."*

**The most important new idea is agent presence** — and it is explicitly *not* avatars. It is
*pixels · terminal processes · computational organisms · machine states · old technical displays · system
signals · evolving patterns · data movement*. An agent has a small visual presence **that changes as it works**,
across states: thinking, reading, planning, working, writing, testing, reviewing, waiting, blocked, done, failed.

**The motion rule is one line:** *"ANIMATE THE WORK, NOT THE INTERFACE."* Static structure, moving work. Layout
calm, work moving. No floating particles, animated backgrounds, glowing, bouncing cards, decorative loaders.

**Typography:** JetBrains Mono stays and is *"part of Magarine's identity"* — kept for ids, statuses, metadata,
system information, agent states. **And they ask for a complementary human-readable face** for project names,
descriptions, explanatory text, conversation.

**Themes:** a true **OLED near-black** dark as a first-class environment, not an inverted light theme. A light
theme that is *technical notebook + engineering documentation + physical work surface* in *"sophisticated
paper/off-white tones"* — explicitly not sterile white SaaS.

**Density:** *"DENSE BUT CALM."* It is a developer tool; do not make it spacious.

## 2. The finding that changes what is possible: "make the work visible" is already in our data

The brief's most ambitious ask — show *what an agent is doing*, not just `WORKING` — reads like a product change.
**It is not. The daemon already produces it and then hides it.**

`claudeCli.ts` runs the tool with `--output-format stream-json --verbose` and parses the stream line by line.
`describeProgress()` already turns those lines into exactly the vocabulary the brief asks for:

- `tool_use: Read` · `tool_use: Edit` · `tool_use: Bash` · `tool_use: Grep`
- `thinking (~N tokens)`
- `session initialized` · `tool result received`

Each one is emitted as a `progress` event, and `scheduler.ts` **persists it** as a `worker_progress` event against
the run, with its message in the payload — capped at 200 per run. The only reason nobody has ever seen one is
`policy.ts`: `worker_progress: { visibility: 'internal' }`, so the activity view filters it out.

**So "reading repository / writing implementation / running tests" is a visibility decision plus a read path, not
new instrumentation.** That moves the brief's centrepiece from list B to list A, and it is the single most
important thing in this document.

Two honest limits: the phases are inferred from *which tool the worker called*, not from the worker declaring its
intent — so `tool_use: Read` means "it read something", and calling that "reading repository" is a small
interpretation. And the page polls every 4 seconds, which is coarse for a presence that is meant to feel live.

## 3. `fleet-and-board/` deserves a correction too

I called it a stray fork on the wrong stack. It is on the wrong stack — Next.js + React + Tailwind + shadcn, which
is the build-step component-kit approach this project ruled out. **But it is a serious, on-brief attempt at exactly
this evolution**, and I underrated it:

- Three themes: **OLED default**, deep navy, **warm paper light** — precisely what §1 asks for.
- A second humanist family beside the mono — precisely what §1 asks for.
- "Living Brutalism" separating zones **by surface rather than heavy borders** — precisely *"structure can be
  brutalist, every component does not need to be."*
- **`components/agent-glyph.tsx`: a 16-cell pixel worker in a 4-wide grid that scans while a ticket is genuinely
  running and is static otherwise** — with the stated principle that motion there always means real live
  computation, never decoration.

That last one is the owner's agent-presence idea, correctly interpreted, already prototyped. Whoever wrote it read
the brief properly. **Its ideas should be mined; its stack should not be adopted.**

## 4. List A — visual direction, adoptable now, no product change

1. **Living Brutalism as an evolution of pass 2**: keep the structure, hierarchy, technical labels, density and
   restraint; drop the uniform heavy borders and the everything-is-a-card reflex. Separate zones by **surface**,
   not by 2px rules everywhere.
2. **OLED near-black dark theme** as the default environment, replacing my navy `#0F172A`.
3. **Warm paper light theme** — off-white, notebook, ink rules. Replaces my cool slate `#F1F5F9`.
4. **Reinstate the two-family split**: JetBrains Mono for ids/statuses/metadata/agent state, a humanist face for
   names, descriptions and conversation. *(Worth noting: pass 1 had exactly this and I removed it when the all-mono
   instruction came down. The owner has asked for it back.)*
5. **Agent presence as a pixel/computational glyph** — never a face. Per-state behaviour, driven by real events.
6. **Live work descriptions** from `worker_progress` — see §2.
7. **Motion rule adopted verbatim**: animate the work, not the interface. This is a strict *superset* of my pass-2
   rule and compatible with it.
8. **State-expressive tickets**: active ≠ waiting, blocked communicates interruption, done settles.
9. **Needs You reframed** from "inbox" to the handover moment — who is asking, what they were doing, why they
   stopped, what decision is needed, what happens next. Our data supports all five.
10. **Activity stays dense**, with live events getting a subtle signal rather than being replaced by a visualisation.
11. Inline SVG icons; no icon font, no emoji.

## 5. List B — needs a ruling before it can be drawn

1. **Agent *identity* versus agent *presence*.** The brief wants agents to feel like entities. Our workers are
   ephemeral per-ticket processes with no persistent identity. A glyph per *run* is honest and needs nothing new.
   A *standing roster* of named agents does not exist. Which of the two is being asked for is a product question.
2. **The eleven agent states.** `THINKING READING PLANNING WORKING WRITING TESTING REVIEWING WAITING BLOCKED DONE
   FAILED` are **agent activity** states; our eight are **ticket** states. Some map from real data
   (working/waiting/blocked/done/failed) and some from `worker_progress` (reading/writing/testing/thinking).
   **`PLANNING` and `REVIEWING` I cannot currently source.** The mapping needs agreeing, and anything unsourceable
   must not be drawn.
3. **Un-hiding `worker_progress`.** It is `visibility: 'internal'` by deliberate policy decision, and there are
   200 of them per run. Surfacing them is a policy change plus a read path — small, but not mine.
4. **Orchestration made perceptible** (signals, handoffs, propagation). We have the events; whether the daemon can
   express *delegation* as a relationship is worth checking before it is drawn.
5. Still unbuildable and therefore not to be drawn: **progress percentages** (nothing measures completion),
   **ticket tags**, **⌘K search**, **Agent Generator**, **per-ticket conversation threads**.

## 6. List C — where the owner's brief and the product as it exists actually conflict

The brief states, repeatedly: *"These HTML files are ONLY VISUAL MOCKUPS of a **native Windows desktop
application**. They are NOT a web application."* and *"Do not introduce web-specific visual conventions."*

**What exists:** a daemon serving one HTML page over loopback HTTP, authenticated by a token pasted into a
browser tab and kept in `sessionStorage`, refreshed by a 4-second `setInterval`.

**The concrete conflicts:**

| | the brief implies | we have |
|---|---|---|
| Shell | a native window, own title bar, OS menus | a browser tab with browser chrome we do not control |
| Auth | app has its own session | a token pasted into a web page |
| Liveness | continuous, event-driven | 4-second polling |
| Notification | OS notifications / tray for "Needs You" | nothing outside the tab |
| Interaction | keyboard shortcuts, context menus, resizable split panes, layout persisted across sessions | a scrolling page, no persisted layout |
| Conventions | desktop software | a Refresh button, a page `<title>`, link-blue accents, browser scroll |

**The question underneath, which is the Strategist's and nobody else's.** There are two readings:

- **(i) Framing.** "Native Windows app" is instruction *to the design tool* — stop making web-flavoured choices.
  The served page remains the product. Nothing technical changes.
- **(ii) Literal.** The served page is a prototype and the real product is a native application. Then
  `packages/core/src/ui/page.ts` is scaffolding, and batch 14's "wire it up" step targets something intended to be
  replaced — which is worth knowing *before* wiring it.

**The size of that conflict depends entirely on one unasked question: native *how*?** If the answer is Electron or
Tauri, both render HTML and CSS, and **everything in list A ports directly** — the visual language, the tokens,
the glyph, the themes are the implementation, not a picture of it. Only a genuinely native shell (WinUI/XAML)
discards the CSS, and even then the design system, information architecture and state semantics survive.

**What survives under every reading:** the layout the owner approved, the concepts, the contrast discipline, the
wrapping rules, reason-never-truncated, artefact-by-kind, `STATUS_ORDER` fidelity, real strings.

## 7. Where pass 2 stands against the brief

**Right, and keep:** brutalist structure and hierarchy · technical labels · density · square restraint ·
JetBrains Mono as identity · motion meaning real work (my one blinking marker is the same principle the brief
states, just applied to one element instead of many) · every honesty rule.

**Wrong against the brief, and change:** every component bordered and carded (*"do not put huge borders around
everything"*) · all-mono (they want the second family back) · navy rather than OLED · cool-slate light rather
than warm paper · agents as text rows with no presence · work shown as a status word rather than as what the agent
is doing.

**So the verdict is neither "approved" nor "rejected": it is the right family, the wrong execution, and the brief
is a list of the specific corrections.**

## 8. Recommendation

1. **Answer §6 first.** Not the whole native-app question — just *native how?* If it is Electron or Tauri, pass 3
   is unblocked immediately and everything ports. That one answer decides whether pass 3 is a design that ships or
   a picture of one.
2. **Pass 3 is Living Brutalism applied to the approved layout**: OLED dark, warm paper light, two families back,
   surfaces instead of uniform borders — plus the two ideas that make it Magarine rather than a recolour: **the
   agent glyph** and **live work descriptions from `worker_progress`**.
3. **Un-hide `worker_progress` first**, or at minimum confirm someone will. It is the difference between designing
   agent presence against real data and inventing it — and inventing it is the failure mode I have been arguing
   against all batch.
4. **Mine `fleet-and-board/` for its ideas** — the three themes and `agent-glyph.tsx` are on-brief and already
   thought through. Do not adopt its stack.
5. **Ignore the generated PNG's avatars and mascot.** They contradict the owner's own brief. The PNG is still
   useful for the kanban column idea and the general warmth, but it is not authoritative — the brief is.

# Magarine — Batch 14 addendum 2: the owner's brief, read in full

Author: Strategist. Date: 2026-09-15. Written after reading all 686 lines of `propos/Convert mockups to HTML/src/imports/pasted_text/magarine-visual-identity.md` (HARD) and the designer's `docs/design/REFERENCE-READ.md` summary as relayed.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What the brief is, and where it disagrees with the image
The brief is the owner's own instruction to a design tool: preserve the product architecture as it stands in the mockups, Fleet, Board, Needs You, Scope, Conversation, Activity; give it a visual identity called Living Brutalism, dense but calm, JetBrains Mono kept for technical text with a humanist face for prose, OLED dark and paper light; make agents visible as computational presences whose state changes as they work; animate the work, not the interface; and remember the final product is a native Windows desktop application of which the HTML is only a picture.

Two places it disagrees with the image the owner also sent (HARD, both read):
1. The brief forbids profile pictures, human avatars, robot mascots, cartoon characters, and emojis. The image has cartoon avatars on every agent and ticket, and a mascot.
2. The brief says nothing about handwriting. The image's Caveat text is the tool annotating a mockup.

Where the brief and the image conflict, the brief is the owner's words and the image is a tool's rendering they liked. The brief wins pending one question to the owner, below.

## 1. Rulings on the six points

### 1. The designer's rule is adopted as a standing rule: the interface shows only what the daemon measures.
Nothing on the screen is invented. A percentage with no measurement behind it is the same lie as DONE with nothing delivered, and it sits on the screen that is believed most. Every element in a mock must name the daemon field or event it is drawn from, or it is not in the mock.

### 2. The Next.js fork is a design source, not product code.
The no-build ruling stands, and the owner's own brief says the HTML is only a picture of the product. The fork is mined by hand for tokens, themes, and CSS decisions, including the OLED default and the three themes, and imported into the vanilla page. If the owner keeps working in it, it is treated as a living design source and re-imported when it changes; that is cheap. The owner is told this plainly and asked whether they intend to keep working there.

### 3. Native Windows desktop application: no conflict, and it was always on the route.
The architecture document said to keep the MVP browser-based and package it as a desktop application later. The daemon and the page are the right substrate for exactly that: a thin native window host on Windows, WebView2, which starts the daemon and shows the page with no browser chrome, is a desktop application by any reasonable reading, and it keeps no install and no build between the owner and the screen. That is a batch after worker profiles, not before. For batch 14 the consequence is only a design constraint the brief already states: no web conventions, no browser chrome in the mocks, the window frame belongs to the operating system.

### 4. Feature calls.
- Progress percentages: never. The card shows budget used against ceiling, attempts, turns so far, and the last activity line.
- Agent presence: yes, and it is producible. The stream already yields one progress event per tool use, and the tool names map to the brief's states: reading, writing, testing, planning. Fleet rows and cards show the last activity line and a small state glyph animated only when a real event arrives. This is "animate the work, not the interface" done honestly. Batch 14 for the activity line and the state; the glyph language is the designer's to invent within the brief's constraints.
- Eight persistent named agents and the Agent Generator: worker profiles, batch 15, as already ruled; the visual form follows the owner's answer on avatars.
- Per-ticket conversation tabs: a per-ticket filter of the conversation and events in batch 14; a Manager discussion focused on one ticket in batch 15.
- Tags: batch 15. Search: batch 14 if a client-side filter, otherwise 15.
- Desktop window chrome: not drawn; the operating system provides it when the shell exists.
- The 713 KB of illustrations: not adopted. The brief itself forbids mascots and cartoons; nothing decorative ships unless the owner overrides after the avatar question.

### 5. The three unsettled questions.
- Columns: every status has a visible home; a column set that hides a status is forbidden. The designer's six columns are adopted with the mapping written next to the board code and a test that every `TicketStatus` value maps to a column.
- The approved pass-2 table becomes the list view behind the toggle the reference already has. Nothing approved is thrown away.
- Caveat: not product voice. Product copy speaks in the two working faces. The owner is told in one line and may override.

### 6. Pass 3 is the reskin plus kanban, not a from-scratch pass, and it is designed to the brief, not the image.
Living Brutalism as the brief defines it, dense but calm, JetBrains Mono for technical text with a humanist face for prose, OLED dark by default and a paper light theme, the kanban board with six columns and the list toggle, Needs You as the hand-back moment with who, what, why, what decision, and what happens next, the activity feed with subtle entry, and agent presence as state glyphs driven by real events. Everything the designer listed as surviving untouched survives.

## 2. Questions for the owner, through the Liaison
1. Blocks the mocks: your brief forbids avatars, cartoon characters, and mascots and asks for agents as computational presences; the image you sent has cartoon avatars and a mascot. Which do you want? We recommend the brief's answer, because it is yours and it is distinctive.
2. Non-blocking: your Next.js folder is used as a design source and mined by hand into the product's own page, which has no build step and installs nothing; do you intend to keep working in that folder?
3. Non-blocking: the final product as a native Windows window that hosts the same daemon and page, with no browser chrome; is that what you mean by native?
4. Non-blocking: handwritten text stays out of the product's own voice unless you say otherwise.

## 3. Consequence for the route
Batch 15: worker profiles with the generator, per-ticket discussion, tags, expected artefacts. Batch 16: the native Windows window host. Everything parked stays parked.

# Magarine — Batch 14 addendum: the owner's reference replaces the brief

Author: Strategist. Date: 2026-09-15. Written after viewing `propos/91451e7d-….png` and the design tokens myself (HARD).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What the owner drew
A dark navy interface with purple, teal, pink, and yellow accents, three fonts (Inter, Share Tech Mono, Caveat), hand-drawn annotations, and a mascot. Layout: top bar with Fleet & Board, Needs You, Scope tabs, a search box, and a theme toggle; a left column of named agents with avatars, a status word, a one-line activity, and a percentage, plus "Add new agent" and an "Agent Generator"; a centre board as kanban columns per status with cards carrying tags, an assigned agent, and a progress bar; a conversation panel with a General tab and per-ticket tabs; a right column with Needs You cards carrying Approve, Reject, Provide input, Review, and Open buttons, and a live Activity feed.

## 1. Rulings

### 1. The visual direction is replaced by the owner's reference. Entirely.
Palette, type, kanban columns, card anatomy, panel arrangement, annotations, mascot: the reference is the brief and the earlier Argus-derived brief is retired. The designer redoes the mocks against it. The constraint is unchanged and the reference already satisfies it: plain HTML, inline styles, no runtime framework, fonts shipped as files with the guards in ruling 1 of the spec.

### 2. Every element in the drawing maps to something honest, and the mock shows only what batch 14 delivers.
Element by element, HARD against what exists:
- **Board as kanban by status**, tags, assignee chip: the data exists except tags. Batch 14 renders columns from ticket status; the assignee chip shows the model tier for now, with a tier avatar, because the model is the worker's identity today. Tags come with batch 15.
- **Progress bars with percentages**: no honest percentage exists and none will be invented. The bar on a card is budget used, equivalent cost against the run's ceiling, which has a true denominator, and the card shows turns so far and the last activity line. A bar that means something beats a number that means nothing.
- **Needs You** with Approve, Reject, Provide input, Review, Open: this is the inbox. All five map to existing actions: approve, reject, decide, and opening the ticket. Batch 14.
- **Activity, live**: exists. Batch 14.
- **Scope tab**: the scope file view already in the conversation panel becomes its own tab. Batch 14.
- **Conversation, General tab**: exists, the project discussion. Batch 14.
- **Conversation, per-ticket tabs**: does not exist. Workers are ephemeral processes and are not chatted with. The honest version is a discussion with the Manager focused on one ticket: the envelope carries the focus ticket, the thread shows that ticket's events and the Manager's replies about it, and the Manager may update or cancel it. Batch 15.
- **Agents column with identities, Add new agent, Agent Generator**: does not exist, and it is the product question in the drawing. The honest version is **worker profiles**: a named profile with an avatar, a model, a system policy, allowed tools, and a sentence on what it is for. The Manager assigns a profile per ticket the way it assigns a model today, and a profile's status is derived: working on a ticket, or idle. A set ships by default, Manager, Architect, Developer, Reviewer, Tester, Scribe, Researcher, and the owner can add one. The Agent Generator is a Manager-style invocation that drafts a profile from a description. This is real product work and it is the right reading of "give your agents unique identities": an identity is a profile, not a persistent memory. Batch 15, after the interface.
- **Search**: client-side filter over the board. Batch 14 if cheap, otherwise 15.
- **Mascot and Caveat annotations**: visual only. Batch 14.

### 3. Two mocks, labelled, so a mock is never a promise.
The batch 14 mock shows exactly what batch 14 delivers, with the agents column showing model tiers and the conversation panel showing only General. A second mock, labelled "with worker profiles, batch 15", shows the destination with the agents column and per-ticket tabs. The owner approves the first as the thing they will get next, and sees the second as where it goes.

## 2. Consequence for the route
Batch 15 becomes: worker profiles with default set and the generator; per-ticket discussion; tags on tickets; expected artefacts on tickets from the earlier ruling. Everything parked stays parked.

## 3. Housekeeping for the Orchestrator, not a ruling
`packages/core/.magarine/artifacts/` under the repository holds thousands of run directories (HARD, seen while locating the proposal). Confirm it is ignored by git and find out what is still writing state under the package directory after batch 10 moved the state directory to the home folder; if a test or a hand-driven run does it, that is a leak of the kind the soaks count.

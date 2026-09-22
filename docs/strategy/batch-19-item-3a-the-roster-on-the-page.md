# Magarine — Batch 19, mini-phase 3A: the fleet becomes the roster

Author: lead. Date: 2026-09-23. Tree at `33fea07` (1A, 1B, 2A, 2B merged and pushed).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What exists, HARD

- `ui/app.js` 586-617 `renderFleet()`: a row per ticket that is IN_PROGRESS, and its own comment
  says why — *"The daemon has no agent entity, no roster and no idle worker, so neither does this."*
  **That sentence is now false**: 1A added the roster and 2A put it on the ticket.
- A row today shows an organism seeded by the ticket's MODEL, the tier name, the model id, and a
  doing line. `index.html` 165-168 is the region: `#fleet`, `#fleetCount`, `#fleetSlots`, `#fleetList`.
- The daemon now serves: `GET /profiles` — every non-retired profile with `status: working|idle` and
  the ticket id when working; `POST /profiles`; `PATCH /profiles/{id}`; `POST /profiles/{id}/retire`.
  Board ticket rows carry `profile: { id, name } | null` and `profileReason`.
- `ui/ELEMENT-FIELD-TABLE.md` is the page's own rule: every element is a **field**, **copy** or
  **derived** row, and anything with no field behind it is omitted and listed, never mocked.
- `organism.js` 39-55 accepts a versioned seed `mg.v1:<id>`; family and symmetry come from the model
  tier. The addendum's ruling: seed a profile's organism by its PROFILE ID, so renaming does not
  change the organism and changing its model does.

## 1. Ruling 38 — the fleet column shows the roster, not just what is running

- The region keeps its id `#fleet`; its heading becomes **Roster**. One row per non-retired profile
  from `GET /profiles`, in the order the daemon returns them, plus the Manager's own row when a
  manager run is in flight (seeded `mg.v1:manager`, as batch 16's design says).
- A row carries: the organism seeded `mg.v1:<profile id>`, the name, the model, the purpose, and the
  status word — `working`, with the ticket's title when the daemon gives a ticket id, or `idle`.
  The live doing line stays, for a working row only, from the same board data it uses today.
- **No percentage and no completion bar.** Nothing measures completion (batch 14's ruling stands).
- A ticket whose profile is null keeps today's behaviour: it is shown by tier and model, in a row
  under the roster headed by one copy line, so a hand-made ticket is never invisible.
- **Add a profile** is a form in this region posting to `POST /profiles`: name, model (a select of
  the models the daemon knows), purpose, optional policy. Errors are shown as the daemon's own
  sentence, never reworded. After a success the roster re-reads.
- Retiring is `POST /profiles/{id}/retire`, with the row's own control, and a confirm step because it
  is not undoable from the page. A retired profile leaves the roster on the next read.
- Board cards show the profile name where they show the tier today, and the profile reason the way
  the model reason is shown. A profile-less card is unchanged.
- **`ELEMENT-FIELD-TABLE.md` gains every new line BEFORE the page draws it**, each marked field,
  copy or derived, as its own rule requires.
- Prohibited, unchanged: `new Notification` and `beforeunload` (batch 17 ruling 30, amended).

## 2. Acceptance

1. With the six seeded profiles and nothing running, the roster shows six rows, each `idle`, each
   with its own organism, name, model and purpose; `#fleetCount` counts profiles, not tickets.
2. While a ticket with profile Developer is IN_PROGRESS, that row reads `working` with the ticket's
   title and the live doing line; every other row still reads `idle`.
3. Renaming a profile does not change its organism; changing its model does. Asserted on the drawn
   seed, not on the API.
4. The add form creates a profile that appears on the next read; a duplicate name shows the daemon's
   own sentence.
5. Retiring a profile removes its row and leaves its tickets' cards readable.
6. A ticket with no profile still appears, by tier and model.
7. `ELEMENT-FIELD-TABLE.md` has a row for every new element, and the existing page tests
   (`src/ui/page.test.ts`, `copy.test.ts`, `contrast.test.ts`, `skin.test.ts`) still pass.
8. The suite passes; each mutation fails a named test.

## 3. Not in 3A

The settings controls, the scope editor and one field per Manager question are 3B. The Agent
Generator stays cut (batch 16 addendum section 6).

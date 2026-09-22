# Magarine — Batch 19, mini-phase 3B: steering from the window

Author: lead. Date: 2026-09-23. Tree at `339bdf3`. Runs after 3A merges (both touch `app.js`).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What exists, HARD

- The daemon now serves, from 1B: `GET /settings`, `PATCH /settings` (keys `default_manager_model`,
  `default_verifier_model`, `max_parallel_workers`), `PATCH /projects/{id}` (`maxParallel`,
  `managerModel`, `verifierModel`, `defaultModel`; null clears an override), and
  `PUT /projects/{id}/scope` with `{ scopeText }`, written atomically and recording the same
  `scope_updated` event the Manager's own edit records. Both PATCH routes validate every field
  before writing any of it.
- From 2B: a BLOCKED ticket's inbox item and its conversation entry carry `questions: string[]`, the
  pending questions; `POST /tickets/{id}/decide` accepts `{ answer }` (one combined answer, still
  legal) or `{ answers }` (exactly one per question, none empty).
- The page: `renderNeeds()` (`app.js` 918-945) draws one inbox row per item, already reconciling by
  key and signature so typing is not destroyed (batch 18's fix — do not regress it).
  `renderScope()` (967) shows the scope document read-only, with three distinct sentences for its
  three truths. Regions are fixed ids: `#fleet #board #needs-you #scope #conversation #activity`
  (`index.html` 35).
- Auth: every request carries the session token (`app.js` 335-351). Mutating routes are behind it.

## 1. Ruling 39 — the window can change what it shows

**One answer field per question, in Needs You.**
- An inbox row for a BLOCKED ticket with N pending questions draws N labelled fields, one per
  question, and one submit. It sends `{ answers: [...] }`.
- N = 1 is unchanged from the owner's point of view: one field, one button, sending `{ answer }`.
- The daemon's refusal sentence is shown verbatim; nothing is reworded and no field is cleared on a
  refusal. **Typing must survive the 4-second poll**: the existing key/signature reconciliation
  covers a row's identity, and the draft in each field is preserved across a re-render. A test types
  into field 2 of 3, forces two polls, and asserts the text is still there.

**Settings, in the `#scope` region's panel head, as a disclosure the owner opens.**
- Machine-wide (from `GET /settings`): the Manager's default model, the verifier's default model,
  the parallel-worker cap. Models are a select of the models the daemon knows; the cap is a number
  input of 1 or more.
- This project (from `GET /projects` and `PATCH /projects/{id}`): its default model, its Manager and
  verifier overrides, and its own max-parallel. An override has an explicit "use the machine
  default" choice, which sends null.
- A change is saved on submit, never on keystroke, and the panel shows what the daemon returned, not
  what was typed. A refusal shows the daemon's own sentence.
- **The cap's effect is stated in copy, because it is true**: it applies on the next tick, with no
  restart. That is 1B's ruling 35, tested in the daemon.

**The scope document becomes editable.**
- An Edit control turns the read-only view into a textarea holding the current text, with Save and
  Cancel. Save sends `PUT /projects/{id}/scope`; Cancel restores without sending.
- **While editing, the poll must not overwrite the textarea.** The editor holds its own draft;
  re-reads update the read-only view behind it, not the draft.
- If the document changed on disk since editing began (its text differs from the last read), Save
  warns once and asks the owner to confirm overwriting, showing both lengths. No silent clobber.
- The three unreadable/missing/empty sentences stay exactly as they are, and none of them is
  editable into existence except the missing case, which the daemon refuses when there is no scope
  path — its sentence is shown.

**Everything above is added to `ELEMENT-FIELD-TABLE.md` before it is drawn**, each row marked field,
copy or derived. `new Notification` and `beforeunload` stay prohibited.

## 2. Acceptance

1. A Manager ticket with three pending questions draws three labelled fields and one submit; sending
   answers them in order, and the board shows the ticket unblocked.
2. Typing in field 2 of 3, then two polls, leaves the text untouched.
3. A refusal (two answers for three questions, forced) shows the daemon's sentence and clears nothing.
4. A ticket with one question behaves exactly as today.
5. Changing the machine cap in the panel persists and is shown from the daemon's own read.
6. Setting a project override, then choosing "use the machine default", clears it (null), proven by a re-read.
7. An invalid value shows the daemon's own sentence and changes nothing.
8. Editing the scope and saving replaces the document; cancelling sends nothing; a poll during
   editing does not touch the draft.
9. A scope changed underneath the editor warns before overwriting.
10. `ELEMENT-FIELD-TABLE.md` covers every new element; existing page tests still pass; each mutation
    fails a named test.

## 3. Not in 3B

Project creation in the window is batch 20. The drill-down into a running worker is mini-phase 4,
and still needs its own ruling about the command text the adapter drops on purpose.

## 4. Amendment, 2026-09-23: the cap's copy says which case it is actually in

The designer found that `resolveMachineCap` (`store.ts` 153-157, read by the lead) returns the
`serve --max-parallel` flag whenever one was given and never reads the setting in that case, so the
spec's flat "applies on the next tick, no restart" is true only for a daemon started without the
flag. Their proposed fix was a permanent caveat in the copy. Refused: a sentence that is usually
false teaches the owner to ignore the copy.

Ruled instead — the panel says which case it is in, derived from data the page already holds:

- Effective cap = `board.slots.cap`. Saved setting = `GET /settings`.
- They agree: the plain true sentence, "Applies on the next tick, with no restart."
- They differ: the panel says this daemon was started with `--max-parallel N`, which wins until it is
  restarted, and shows BOTH numbers, the one in force and the one saved. Saving still saves; it is
  simply not in force yet.
- The row is marked **derived** in `ELEMENT-FIELD-TABLE.md`, stating that rule, not as a field.

If the two can diverge for any reason other than the flag, the honest fix is for the daemon to say
whether a flag is in force, ruled then as a small daemon change, the way `GET /models` was.

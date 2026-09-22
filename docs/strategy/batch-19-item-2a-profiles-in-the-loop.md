# Magarine — Batch 19, mini-phase 2A: profiles reach the Manager and the worker

Author: lead. Date: 2026-09-22. Builds on 1A (worker profiles, data layer). Authority is
`batch-16-addendum-1-worker-profiles-design.md` sections 3 and 4, with the amendments below.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What exists, HARD

- `renderModelGuidance()` (`managerEnvelope.ts` 320-335) renders the model paragraph from
  `pricing.ts`, and `managerEnvelope.ts` 390 pushes it into every Manager envelope.
- The proposal grammar (`proposal.ts` 150 and 156) gives `create_ticket`/`update_ticket` an optional
  `model` + `model_reason`. The validator (306-307, 376-377) requires the reason whenever the model
  is set. `managerApply.ts` 155 and 231 write `modelReason`.
- The adapter builds the prompt at `claudeCli.ts` 539 and passes `--model` at 574. It passes no
  system prompt.
- After the 1A fixes, work runs record `runs.profile_id` at spawn, and the model resolves through
  profiles (1A review items 1-2, run by the lead).

## 1. Ruling 37 — the Manager assigns from the roster and the worker is told who it is

- **Envelope.** `renderModelGuidance` is replaced by `renderRoster(db)`: one line per non-retired
  profile with its name, model, the price ratio already computed for that model, and its purpose.
  Then a single sentence: a bare `model` is only for a ticket with no profile. Test: the paragraph
  names exactly the non-retired profiles, no more and no fewer. Retiring one and adding one both
  change it.
- **Grammar and validator.** `create_ticket`/`update_ticket` gain `profile` (a name, case-insensitive
  like 1A's lookup) and `profile_reason`, which is required whenever `profile` is set. Refused, each
  in one sentence, and the whole proposal is rejected as today:
  - an unknown or retired profile name;
  - `profile` together with `model`;
  - `update_ticket` changing the profile of a ticket that is IN_PROGRESS or REVIEW.
  The grammar text in `proposal.ts` says all of this.
- **Storage.** `profile_reason` needs a column. Migration **`0019_ticket_profile_reason`**
  (nullable TEXT), with an upgrade test. The board rows carry `profileReason` beside `profile`, the
  same way `modelReason` is shown today.
- **Worker.** The ticket envelope gains `profile?: { id, name, purpose, policy }`, absent for a
  ticket with no profile. The adapter passes `--append-system-prompt` with exactly
  `You are <name>, <purpose>. <policy>`, with the trailing policy omitted when it is empty.
  `buildWorkerPrompt`'s first line names the profile. **Verify-kind runs get no profile** (a
  verifier judges the work; it is not the worker), and Manager runs get none either.
- **Argv safety.** The rendered line goes through the same argv path as every other flag. It is
  never shell-interpolated. Test with a purpose containing quotes, `&` and a newline, on Windows argv.

## 2. Acceptance

1. The roster paragraph names exactly the non-retired profiles (exact-names test, add/retire both change it).
2. A proposal assigning `profile: "developer"` with a reason creates a ticket whose `profile_id` is Developer's and whose board row shows the reason.
3. Each refusal in section 1 rejects the whole proposal, with its sentence.
4. The fake-adapter argv for a profile ticket carries `--append-system-prompt` with the exact line; a ticket with no profile, a verify run and a Manager run carry none.
5. The 0019 upgrade test passes, and existing tickets get a null `profile_reason`.
6. Suite passes, and each mutation fails a test that goes through the real path (proposal → apply → scheduler → adapter argv).

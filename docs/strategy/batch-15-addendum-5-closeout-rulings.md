# Magarine — Batch 15 addendum 5: two close-out rulings, the CLI expectation flag and the reason chain

Author: Strategist. Date: 2026-09-16. Follows `batch-15-addendum-4-views-survive.md` (ruling 15). Raised by the Orchestrator at batch 15 close-out, from greps, not from the handover's description. Every line number below was re-read by me this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

Neither ruling touches a file the Designer holds for ruling 15 (`packages/core/ui/`). Both go to the Invariants Engineer, sonnet, in batch 15, as two tasks and two commits.

## Ruling 16 — `ticket add` gains `--expected-artifact`, repeatable, file paths only

### Evidence, HARD

- `ticket add`'s allowed flags (`cli.ts` 266-277): project, title, description, max-attempts, priority, workspace, budget, model, acceptance, depends-on. No expectation flag.
- Its `createTicket` call (`cli.ts` 732-741) never passes `expectedArtifacts`, so the store's default `null` applies (`store.ts` 382-383, 423).
- `null` and `[]` mean different things (`types.ts` 85): null is "no such list, today's rule applies"; an array is "verify DONE against this". The flag must preserve that distinction.
- Only kind `file` is ever verified (`types.ts` 56-58; `scheduler.ts` 721-740 filters on `kind === 'file'`). Every other kind is stored and ignored.
- The mechanism is otherwise complete: validated on the Manager path (`proposal.ts` 228, 312, 400), applied (`managerApply.ts` 157, 232), stored (migration 0013, `db/schema.ts` 310), enforced (`scheduler.ts` 725), and the enforcement names the missing file on the board (`scheduler.ts` 740 sets `message`).
- `flagList` already parses a repeatable flag for `--acceptance` (`cli.ts` 139, used at 717 and 739).

### Why it is in scope

The handover names the expected-artefacts list as the mechanical answer to the carried UNKNOWN "DONE with a text artefact instead of a file is not checked anywhere". Today that answer reaches only tickets the Manager creates. Every test scenario, every README walk, and every ticket the owner types by hand is unprotected. A guard that protects only the tickets nobody hand-writes is not the answer to that UNKNOWN; it is half of it. The other half is one flag.

### The ruling

1. `ticket add --expected-artifact <path>`, repeatable, parsed with `flagList`. Each value becomes `{ kind: 'file', path }`. No other kind is accepted at the CLI, because no other kind is verified; when another kind becomes verifiable, the flag grows a kind prefix then, not now.
2. Flag absent: `expectedArtifacts` is `null`, exactly as today. Flag present once or more: the array. The flag never produces `[]`.
3. An empty path is a usage error with a non-zero exit and a message naming the flag, the same treatment as any malformed flag on this CLI. Paths are stored as given; the scheduler compares declared paths as strings, so the CLI does not normalise.
4. `packages/core/README.md` lines 82-89, which document `--acceptance` and `--depends-on`, gain the new flag in the same sentence and the same example.
5. Tests, all mutation-checked:
   - `cliRouting.test.ts`: the flag is in the allowed list.
   - `commands.test.ts`: `ticket add` with the flag stores the array; without it stores `null`; with an empty value exits non-zero.
   - `scheduler.test.ts`: a ticket created THROUGH THE CLI PATH with `--expected-artifact out.md`, run under the fake adapter declaring done with no artefacts, fails `malformed_result` and the board reason names `out.md`. The existing enforcement test covers Manager-made tickets; this one proves the CLI-made ticket reaches the same branch.

## Ruling 17 — `reasonFor` learns `errors`; sites do not each learn `message`

### Evidence, HARD

- `reasonFor`'s chain (`commands/inbox.ts` 134-141): `summary`, `blockers` (joined with `; `), `message`, `reason`, then `failureClass`. `errors` is not read.
- `scheduler.ts` 706: "done with nothing delivered" is emitted as `errors` only. The board shows `failed: malformed_result` and the sentence never reaches the owner. Confirmed by the Orchestrator and by me.
- **`scheduler.ts` 684 is a second broken site the report did not name:** `payload: { errors: validated.errors, retryable: true, failureClass: 'malformed_result' }`. Those are the result-contract validation errors, the most informative text a malformed result has, and they are dropped the same way.
- Two sites already do it right by hand: 533 (`message: result.errors.join('; '), errors: result.errors`) and 740 (`errors: [message], message`). The comment at 721-724 explains why 740 sets `message`, which documents the trap without closing it.
- The page shows `reasonFor`'s output verbatim as the "Stopped" line of a Needs You item (`app.js` 542 renders `item.message`; `inbox.ts` 263 builds `message` from `reasonFor`). So the fix reaches the interface with no page change.

### Why the chain, not the sites

A per-site fix at 706 leaves 684 broken and leaves the trap armed for the next branch. Two sites are already broken and two are already hand-patched; that is the signature of a missing rule, not of two typos. Rule 8 says the interface shows what the daemon measures. The daemon measured the reason in both cases and the chain discards it. The chain is where the defect is.

### The ruling

1. In `reasonFor`'s fallback chain, after `reason` and before `failureClass`: if `errors` is a non-empty array, return its entries joined with `; `, mirroring `blockers`. One line.
2. Sites 706 and 684 are NOT edited. One mechanism, not two. Sites 533 and 740 keep their explicit `message`; it is harmless and now redundant.
3. The comment at `scheduler.ts` 721-724 is rewritten to say the chain reads `errors`, so it stops documenting a rule that no longer holds. A comment that explains a workaround for a fixed defect is the next engineer's wrong turn.
4. Tests, mutation-checked, in `inboxCompleteness.test.ts` or `board.test.ts`, whichever already builds a `worker_failure` event: a payload of the exact 706 shape renders "done with nothing delivered"; a payload of the exact 684 shape with two validation errors renders both, joined. Remove the new chain line and both must fail.

## Dispatch notes for the Orchestrator

- Files touched: `cli.ts`, `README.md`, three test files (ruling 16); `commands/inbox.ts`, one scheduler comment, one test file (ruling 17). Nothing under `packages/core/ui/`.
- UNKNOWN: whether Role A still has uncommitted edits in any of these files. At my first look this session `git status` showed `claudeCli.ts`, `activity.ts`, `daemonClient.ts` and `store.ts` modified, none of the files above. Check again before dispatch so two engineers are never in one file.
- Cost, against the tree: each ruling is under an hour of sonnet work and one commit. Neither blocks the Designer, and batch 15 does not close until both land and are verified, because the close-out otherwise carries a guard that hand-made tickets cannot use and a reason the owner cannot see.

## Ruling 16, amended — `POST /tickets` gains `expectedArtifacts`, validated by the Manager path's own validator

Raised by the Orchestrator after ruling 16 was committed at d8482ab. Re-read this turn, all HARD.

### Evidence

- `daemonApi.ts` 152-165: the body type mirrors `ticket add` field for field, including `acceptanceCriteria` and `dependsOn`. The `createTicket` call at 167-176 passes no `expectedArtifacts`.
- `README.md` 543 states the mirror as a guarantee: "Body mirrors `ticket add`'s flags", then lists them. Ruling 16 as written makes that sentence false the moment the CLI flag lands.
- The route is the path the page and every non-CLI caller use. A guard the daemon's own API cannot express is the same half-answer ruling 16 was written to close.
- `proposal.ts` 228: `validateExpectedArtifacts(value, prefix)` already validates the exact JSON shape against `ARTIFACT_KINDS`, requires `path` on kind `file` and forbids it elsewhere. It is not exported.
- The route's existing pattern, `b.acceptanceCriteria ?? []` at 174, is the same trap the Orchestrator caught in `flagList`: the obvious mirror `b.expectedArtifacts ?? []` would persist `[]` as non-null (`store.ts` 423) and flip every ticket into verification mode.

### The ruling

1. `POST /tickets` accepts `expectedArtifacts`, an array in the same JSON shape the Manager's `create_ticket` accepts. The route is JSON, so it carries the full shape, not the CLI's path-only shorthand; the CLI's file-only rule is a limit of flag syntax, not of the store.
2. Validation reuses `validateExpectedArtifacts`. Export it from `proposal.ts`; do not copy it. Any error is a 400 whose message is the validator's errors joined with `; `, the same join ruling 17 standardises.
3. Absent: `null`, exactly as the CLI. Present and non-empty: stored. Present and empty (`[]`): 400, "expectedArtifacts must be omitted or non-empty". The route never persists `[]`, for the same reason the flag never produces it.
4. `README.md` 543 adds `expectedArtifacts` to the listed fields, so the mirror sentence stays true.
5. Tests in `daemonApi.test.ts`, mutation-checked: body without the field stores `null`; body with one valid file entry stores it; body with `[]` is 400; body with an entry of an unknown kind is 400 and the message names the entry's index.

### Dispatch

Same engineer, a third task after the CLI task, one commit. `daemonApi.ts` and `daemonApi.test.ts` are free. The `proposal.ts` change is one `export` keyword.

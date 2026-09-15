# Magarine — Batch 13: DONE must mean delivered

Author: Strategist. Date: 2026-09-15. Follows `docs/evidence/batch-12-walk/RESULT.md`. The interface batch moves to batch 14.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What the walk found, in one line each
- The README gate passed from a fresh folder with no flags; batch 11's trap is gone.
- The Manager chooses models well and says why.
- Four tickets reported DONE, $1.96 equivalent was spent, and no file was delivered. The Manager chose throwaway workspaces for file-writing tickets, the workers declared invented artefact kinds, and the verifier skipped everything that was not literally `file`. The board said success and the inbox was empty.

## 1. The ruling: remove the choices, do not guide them

The design rule, adopted from the Orchestrator's read and now standing: **where a wrong choice by an agent produces silent failure, remove the choice.** Guidance is for choices that are safe either way, like the model. Three applications:

### a. Agents do not decide where work lives.
A project has one directory since batch 12. Work tickets run there: `workspace_type` defaults to `DIRECTORY` and the Manager's `create_ticket` and `update_ticket` no longer accept it; a proposal that includes it is rejected as malformed with the field named. `NONE` remains for the daemon's own manager tickets and for an owner who explicitly asks with `ticket add --workspace NONE`. Files land in the owner's folder because nothing else is possible.

### b. Artefact kinds are an enumeration, and each kind has its own required field.
The result contract's `kind` becomes exactly: `file` with `path`, verified on disk inside the workspace; `text` with `text`; `url` with `url`; `reference` with `text`; and the two manager kinds, `manager_reply` and `manager_assessment`, with `text`. No kind carries its content in `path` any more, which closes the smell flagged in batch 11. Any other kind, or a kind with the wrong field, is a malformed result, retryable, with the offending artefact named. The JSON schema handed to the tool enforces the same enumeration up front, so a worker cannot emit an invented kind and the daemon refuses one if it does.

### c. DONE requires something delivered.
A work ticket's `done` result must declare at least one artefact; `done` with none is malformed and retryable with the reason "done with nothing delivered". The board and the page show each ticket's artefacts next to its status, count and paths, so a DONE row is legible as what it produced. A person who reads DONE sees the files.

## 2. Batch 13: Role S continues

### Role S: Invariants Engineer, continuing — model tier: sonnet, high effort
Owns the whole of `packages/core` and the root README. Does not commit. Edits shared files in place.
Deliver, in order, each verified before commit:
1. **The contract.** Enumerated kinds with per-kind required fields in `resultContract.ts`, the tool-facing JSON schema, the fake adapter, and every fixture. `verifyArtifacts` checks `file` on disk as before and validates every other kind's field. Migration of stored artefact rows where a text kind used `path`.
2. **The workspace rule.** `DIRECTORY` default for work tickets; `workspace_type` removed from the Manager's two commands and rejected if present; envelope updated so the Manager is not told to choose.
3. **DONE requires delivery.** The zero-artefact rule in the scheduler's result handling; board and page show artefacts per ticket.
4. **Fixtures from Run B.** The actual recorded worker outputs with `kind: documentation`, `license`, and `doc` become spawned-pipeline fixtures proving each is now a retryable malformed result, and the Run B proposal with `workspace_type: NONE` becomes a fixture proving rejection. These are the tests that would have caught the finding.
5. **Mutation list** per test in the report, and the dimensions for the close-out runs: kind valid or invented, workspace chosen by agent or not, done with or without artefacts.
Acceptance: `pnpm test` green; twenty cold runs by the Orchestrator on an exclusive machine; single write site still single; both completeness tests pass; the schema handed to the tool and the validator agree, proven by one test that feeds the schema's own examples through the validator.

### Orchestrator close-out for batch 13
1. Verify and commit per step, twenty cold runs exclusive, grep the write site, three mutations.
2. **Run B again, same scope, from a fresh folder.** Pass: every DONE ticket has files in the owner's folder, the board lists them, no ticket reports done without artefacts, and the Manager's proposal contains no `workspace_type`.
3. **One adversarial run.** A ticket whose description invites the worker to describe its output rather than write it. Pass: the result is retryable malformed or the worker writes a real file; DONE with nothing is impossible.
4. Report every UNKNOWN and the equivalent figures. Then the interface batch is next, as shaped, with the owner's references.

## 3. What the owner must decide or supply
Nothing blocks. Tell the owner, through the Liaison, in one paragraph: the walk found that work could report success without delivering files; it is being closed this batch by making that impossible rather than by asking the planner to be careful; the interface work follows immediately after.

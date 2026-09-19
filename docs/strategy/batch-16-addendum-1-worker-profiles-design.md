# Magarine — Batch 16 addendum 1: worker profiles, designed for batch 17

Author: Strategist. Date: 2026-09-19. Written during batch 16 per `batch-16-spec.md` section 5, so batch 17 starts with its design decided. Not for dispatch until batch 16 closes. Every anchor read this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What exists, HARD

- The owner drew "a left column of named agents with avatars, a status word, a one-line activity, and a percentage, plus 'Add new agent' and an 'Agent Generator'" (`batch-14-addendum-owner-reference.md` section 0). Ruling 2 there read it as worker profiles: "a named profile with an avatar, a model, a system policy, allowed tools, and a sentence on what it is for. The Manager assigns a profile per ticket the way it assigns a model today, and a profile's status is derived: working on a ticket, or idle."
- Identity today is the model tier: `organism.js` 39-53 sets family and symmetry per tier and hashes the seed for the cell draw; it already accepts a versioned seed of the form `mg.v1:agent_abc` (line 55), written for this batch. Ruling 9 amended: identity is shape, activity is motion, status is colour; the organism's job is "which agent, not which price".
- A ticket's model is `ticket.model ?? project.defaultModel` (`store.ts` 292-294). The Manager may set `model` on create or update and must give `model_reason` (`proposal.ts` 302-303, `types.ts` 81), shown on the board.
- The adapter passes `--model`, `--max-budget-usd`, `--permission-mode`, `--json-schema`, `--output-format`, `--verbose` (`claudeCli.ts`, grep). It passes no system prompt and no tool list.
- The installed CLI accepts `--append-system-prompt`, `--allowedTools` and `--disallowedTools` (`claude --help`, run this turn).
- The batch 1 spike measured the tool flags (`docs/spikes/claude-cli-adapter.md` 118-150): `--allowedTools "Read"` did not stop the worker writing files under either permission mode tried, with no denial recorded; `--disallowedTools` blocked the direct tool and the worker routed around it through a subagent. The spike's own implication: "do not assume `--allowedTools` alone is a security or containment boundary".

## 1. The trade-off, and ruling 25

**The question.** The Manager already chooses a model per ticket and records why. A profile also carries a model. Two knobs on one ticket that both mean "which model runs this" is exactly the two-caps defect ruling 23 just removed from parallelism. Which knob is the product?

**The ruling: the profile is the assignment; the model is the profile's.** A profile carries a model, a purpose and a policy. The Manager assigns a profile to a ticket with a one-line reason, replacing its per-ticket model choice in ordinary use. A bare model override on a ticket stays legal only for a ticket with no profile, which is how hand-made tickets and every existing ticket keep working. Setting both on one command is rejected with one sentence: choose a profile or a model, not both. Resolution order, in one function: `ticket.model ?? profile.model ?? project.defaultModel`, with the first two mutually exclusive by validation.

Why this way round: the owner's mental model is agents, and the model guidance paragraph the Manager reads today (`managerEnvelope.ts` 225-241) is already a description of roles by tier. A profile makes that paragraph into rows the owner can see and rename. The alternative, profile as a label over a model the Manager still picks separately, is decoration.

## 2. What a profile is, and what it is not

A row in a new `worker_profiles` table, **global to the database, not per project**, because "my agents" is how the owner spoke of them and a project-scoped roster would need seeding per project and a readiness rule for legacy rows:

- `id` (`prof_…`), `name` (unique, the display name), `purpose` (one sentence, shown on the fleet row), `model` (must be in `pricing.ts`'s list), `policy` (text appended to the worker's system prompt; may be empty), `created_at`, `updated_at`, `retired_at` (null; a retired profile is not assignable and not shown, never deleted, so history stays readable).
- **No allowed-tools field.** The spike proved the flag is not a boundary. A field the product cannot enforce is inert machinery that reads as a feature, the class this project refuses. If tool restriction is ever wanted it is a workspace or container question, ruled on its own.
- **No memory, no state.** An identity is a profile, not a persistent memory (owner-reference ruling 2). A profile's status is derived at read time: `working` with the ticket id when a run under it is in flight, else `idle`.
- **The seed is the profile id**, versioned: `mg.v1:<id>`. Family and symmetry still come from the profile's model tier, so the tier remains legible, and the hash of the id gives each profile its own organism within the tier. Same profile, same organism, on every machine. Renaming does not change the organism; changing the model does, and the page says so when it happens.

**Default set, seeded by migration 0015, all renamable, all retirable:** Architect (claude-opus-5, deep design with real trade-offs), Developer (claude-sonnet-5, implementation), Reviewer (claude-sonnet-5, reads and judges, writes only review notes), Tester (claude-sonnet-5, writes and runs tests), Researcher (claude-haiku-4-5-20251001, read-only survey and summary), Scribe (claude-haiku-4-5-20251001, docs and mechanical edits). Six, not the seven in the owner-reference ruling: **Manager is not a profile.** Manager tickets run on `resolveManagerModel` and are not assignable; the fleet shows the Manager's run as its own row when one is in flight, seeded `mg.v1:manager`. Making the Manager a profile would let a proposal reassign the thing that writes proposals.

The purposes above are the policy text too, one sentence each, until the owner writes better ones. SOFT: whether the appended sentence changes worker behaviour; the daemon can only measure that the transcript's system prompt contains it, and that is what the test asserts.

## 3. The Manager

- The envelope's model guidance paragraph is **replaced** by a roster paragraph rendered from the table, the same way `renderModelGuidance` is rendered from `pricing.ts`, with the same kind of test: the paragraph names exactly the non-retired profiles, each with its model, price ratio and purpose, nothing more or less. Model guidance survives only as the one sentence about a bare `model` on a profile-less ticket.
- `create_ticket` and `update_ticket` gain `profile` (the name) and `profile_reason` (required whenever `profile` is set, same rule as `model_reason`). Validation: the name exists and is not retired; `profile` and `model` on one command is rejected. `update_ticket` may change a profile on a ticket that is not running.
- A new command `retire_profile` is **not** offered to the Manager. Profiles are the owner's roster; the Manager assigns from it and may say in a `manager_reply` that a profile is missing. The owner adds one.

## 4. The worker

- `WorkerEnvelope` gains `profile?: { id, name, purpose, policy }`, absent for a profile-less ticket. The adapter passes `--append-system-prompt` with a fixed rendering: `You are <name>, <purpose>. <policy>`. The run row records `profile_id` so cost and outcome per profile are derivable without a join through tickets.
- The worker prompt's first line names the profile. Nothing else in the worker path changes.

## 5. CLI, route, page

- CLI: `profile list` (name, model, purpose, status), `profile add --name --model --purpose [--policy]`, `profile set --profile <name|id> [--name] [--model] [--purpose] [--policy]`, `profile retire --profile`. `ticket add --profile <name>` and `POST /tickets` `profile`, mutually exclusive with `--model`/`model`, same rule as the Manager's.
- Routes: `GET /profiles` with derived status, `POST /profiles`, `PATCH /profiles/{id}`, `POST /profiles/{id}/retire`. The board's ticket rows carry `profile: { id, name } | null`.
- Page, Role B: the fleet column becomes the roster: one row per non-retired profile with its organism seeded by id, the status word, and the live line when working; the Manager row when its run is in flight. Cards show the profile name where they show the tier today; a profile-less ticket keeps showing the tier. "Add new agent" is a form in the fleet column posting to `POST /profiles`; no Agent Generator (section 6). The element-field table gains every new line before the page draws it.

## 6. Cut, and why

- **The Agent Generator.** A Manager-style invocation that drafts a profile from a description is a second Manager path, with its own envelope, validator and cost, to save the owner typing two sentences. Batch 19 candidate, if the owner asks for it after using the roster.
- **Allowed tools**, as above: not a boundary, so not a field.
- **Per-project rosters.** Global, as above; a per-project view is a filter.
- **Percentages on the fleet row**, as ruled in batch 14: nothing measures completion.

## 7. Roles and acceptance for batch 17, to be confirmed when 16 closes

- **Role A, Daemon Engineer (sonnet):** migration 0015 with seed rows and an upgrade test; profile store, resolution function with the exclusivity rule tested; CLI and routes; the envelope roster paragraph with its exact-names test; validator rules mutation-checked; adapter `--append-system-prompt` with a test that the argv carries the rendered line; run row `profile_id`.
- **Role B, Interface Engineer (sonnet):** the roster column, seeded organisms, the add form, card chips, element-field table lines.
- **Closing condition, run:** a Manager proposal in a real run assigns profiles with reasons and the board shows them; one real worker run under a profile whose transcript system prompt contains the rendered line, read from the transcript; the fleet shows that profile `working` with its ticket during the run and `idle` after, captured; the owner renames one profile and the organism does not change, changes one profile's model and it does; `docs/evidence/batch-17-walk/RESULT.md`.

## 8. What the owner must decide or supply

Nothing before batch 17 starts. The default names and purposes are a starting roster they can rename; if they have names they want from their own drawing, the Orchestrator asks through the Liaison during 17, not now. UNKNOWN whether the drawing's agents had names; the reference addendum records none.

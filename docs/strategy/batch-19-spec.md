# Magarine — Batch 19: identity and steering

Author: lead (holding the Strategist role since 2026-09-22). Date: 2026-09-22. Tree at `8434c3c`, clean.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

The owner, on the reset: *"read it and restart the pipeline, let's get things done"*. I took that as
the answer to the handover's open question (batch 19 now, or real work first). Batch 19 now.

## 0. The carry list and what exists, HARD

From `batch-18-closeout.md`, "Carried into batch 19 and later":

| Item | State of the tree |
|---|---|
| Manager model: per project, with a configurable default | Per project exists: `projects.manager_model`, `resolveManagerModel` = `managerModel ?? defaultModel` (`store.ts` 334-343; the verifier twin `resolveVerifierModel` at 330). No global default: the schema has no settings table (`schema.ts`, grep `settings`: none). |
| Worker profiles | Designed in `batch-16-addendum-1-worker-profiles-design.md`, never built (grep `profile` in `src/*.ts`: only `commands/app.ts`, the Chrome profile). The last migration is `0016_ticket_automatic` (`schema.ts` 396). |
| Drill-down into a worker | Not built. The adapter drops command text on purpose (batch-18 replan section 0). |
| max-parallel and scope editable from the app | Not built. Routes: `GET /projects/{id}/scope` only (`daemonApi.ts` 367-378); no `PATCH /projects`. Machine cap is the `serve --max-parallel` flag (`cli.ts` 159-168). |
| One answer field per Manager question | Not built. |
| Verifier verdict passed into the retry prompt verbatim, no length limit | `envelope.ts` 27-29 renders `previousAttempt.reason` unbounded. |

Project creation in the window stays in batch 20. The font coverage question is the owner's; not in this batch.

## 1. Mini-phases, in pipeline order

Each mini-phase ends with a fresh Opus review and the lead's own cold suite and mutations. Builders
run in isolated worktrees. The lead merges and commits. Engineers never run git.

| Mini-phase | Content | Depends on |
|---|---|---|
| **1A** | Profiles, data layer: migration, store, resolution, CLI, routes | none |
| **1B** | Settings: global defaults, `PATCH /projects/{id}`, `PUT /projects/{id}/scope`, machine cap from settings, verdict cap | none |
| **2A** | Profiles into the Manager envelope, the validator, the worker envelope and the adapter | 1A reviewed |
| **2B** | One answer field per Manager question | none (built while 1A/1B are reviewed) |
| **3A** | Page: the roster column, profile chips, add form | 1A, 2A reviewed |
| **3B** | Page: the settings controls and the scope editor; one field per question in Needs You | 1B, 2B reviewed |
| **4** | Drill-down (spec written when 3 is in review, section 5) | — |

1A and 1B both touch `schema.ts`, `store.ts`, `cli.ts`, `daemonApi.ts`, `types.ts`. They run in
separate worktrees and the lead merges. **Migration ids are fixed here so the merge is mechanical:
1A owns `0017_worker_profiles`, 1B owns `0018_settings`.** 1B's migration must not assume 0017 ran
first in its tests beyond the list order.

## 2. Mini-phase 1A — profiles, data layer

Authority: `batch-16-addendum-1-worker-profiles-design.md` sections 1, 2 and 5 (ruling 25), with
these amendments, all HARD against the tree:

- Migration **0017** (the addendum said 0015; 0015 and 0016 are taken). Creates `worker_profiles`
  per addendum section 2, seeds the six default rows (Architect/opus, Developer, Reviewer, Tester on
  sonnet, Researcher and Scribe on haiku, exact model ids from `pricing.ts`), adds nullable
  `tickets.profile_id` and `runs.profile_id`. Upgrade test from a 0016 database with rows.
- Resolution in ONE function: `ticket.model ?? profile.model ?? project.defaultModel`. Setting both
  `profile` and `model` on one ticket is rejected with one sentence: *choose a profile or a model,
  not both*. A retired profile is not assignable.
- CLI: `profile list|add|set|retire` and `ticket add --profile <name>`, per addendum section 5.
  `--model` in `profile add/set` is validated against `pricing.ts`.
- Routes: `GET /profiles` (with derived `status: working|idle` and `ticketId` when working),
  `POST /profiles`, `PATCH /profiles/{id}`, `POST /profiles/{id}/retire`, `POST /tickets` accepting
  `profile`. Board ticket rows carry `profile: { id, name } | null`.
- Not in 1A: the Manager envelope, the validator, the worker prompt, the adapter. Those are 2A.

**Acceptance, 1A (every line a command or a test):**
1. Fresh DB: `profile list` prints exactly six rows with the names and models above.
2. Upgrade test: a 0016 DB with a project, tickets and runs migrates; existing rows get null `profile_id`.
3. `ticket add --profile Developer --model claude-opus-5` fails with the one sentence; each alone succeeds.
4. Resolution test covers all three sources and the retired case.
5. `GET /profiles` reports `working` with the ticket id while a run under that profile is IN_PROGRESS, `idle` otherwise.
6. Renaming a profile keeps its id; retiring hides it from `GET /profiles` and `profile list` and never deletes the row.
7. The combined suite passes; mutations named in the report each fail at least one test.

## 3. Mini-phase 1B — settings and steering routes

**Ruling 35 — global defaults live in a settings table, and a project's own value wins.**

- Migration **0018**: `settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`.
  Keys in this batch: `default_manager_model`, `default_verifier_model`, `max_parallel_workers`
  (machine cap). Unknown keys are refused by the store, not stored.
- Resolution: `project.managerModel ?? settings.default_manager_model ?? project.defaultModel`; the
  same shape for the verifier. One function each, the existing ones amended.
- Machine cap: `serve --max-parallel N` still wins for the life of that daemon; without the flag the
  daemon reads `settings.max_parallel_workers ?? 1` **on every tick**, so a change applies without a
  restart. That is the owner's complaint in the batch-18 replan, section 0.
- CLI: `config get [key]`, `config set <key> <value>`, `config unset <key>`. Models validated against
  `pricing.ts`; the cap validated with the same rules as `--max-parallel` (`cli.ts` 159-168).
- Routes: `GET /settings`, `PATCH /settings`; `PATCH /projects/{id}` accepting `maxParallel`,
  `managerModel`, `verifierModel`, `defaultModel` (null clears an override), same validation as the
  CLI; `PUT /projects/{id}/scope` with `{ scopeText }`, written atomically (temp file and rename) to
  the project's scope path, refused if the project has no scope path. All behind the token, as every
  mutating route is today.
- **Verdict cap:** `previousAttempt.reason` is cut to 4000 characters in the rendered retry prompt,
  with a line saying it was cut and how long it was. Test on the rendered prompt.

**Acceptance, 1B:**
1. `config set default_manager_model claude-opus-5` then a project with no `manager_model` resolves to opus; with one, to its own.
2. `config set max_parallel_workers 3` while a daemon without `--max-parallel` is running raises admission to 3 on the next tick (test against the scheduler, no restart).
3. `PATCH /projects/{id}` with an unknown model, `maxParallel: 0` or an unknown field is 400 with one sentence; valid ones persist and show in `GET /projects`.
4. `PUT /projects/{id}/scope` then `GET` returns the same text; a failed write leaves the old file intact (test the temp-and-rename).
5. The retry prompt for a 10,000-character reason contains exactly 4000 characters of it and the cut line.
6. Suite passes; mutations each fail a test.

## 4. Mini-phases 2A, 2B, 3A, 3B, in outline

- **2A:** addendum sections 3 and 4 as written. `renderModelGuidance` becomes the roster paragraph
  with the exact-names test; `create_ticket`/`update_ticket` gain `profile` + `profile_reason`;
  `WorkerEnvelope.profile`; the adapter passes `--append-system-prompt "You are <name>, <purpose>. <policy>"`
  (argv test); `runs.profile_id` written at spawn.
- **2B:** a Manager turn with N `request_user_decision` commands yields N questions, each answerable
  on its own; the ticket unblocks when all are answered, and the answers are passed back as a list.
  Spec detail written before dispatch, after reading `managerApply.ts` 174-177 and the decision route.
- **3A / 3B:** the interface designer (`ui-ux-pro-max`, sonnet), after the routes they draw on are
  reviewed. The element-field table gains every new line before the page draws it.

## 5. Drill-down, deferred to its own ruling

"What is it running exactly, is it stuck" needs the command text the adapter drops on purpose,
because a command line is the likeliest place for a secret. That trade-off gets its own ruling
before any code, written while 3 is in review.

## 6. Closing condition

The owner runs batch 19 on real work: a Manager proposal assigns profiles with reasons, the fleet
shows who is working, and they change max-parallel and the Manager's model from the window without
a restart. Their word closes it.

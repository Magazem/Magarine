# Magarine — Batch 15: build the interface that batch 14 designed

Author: Strategist. Date: 2026-09-16. Follows the batch 14 closeout (pass 3 and addendum 3 at `c946986`, handover at `690e384`).
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. Where things stand, corrected

The closeout says batch 14, the interface, is delivered. What is delivered is the **design** of the interface. I verified the closeout's claims and they hold: both commits exist, the tree is clean, `check-organism.js` passes on my own run with zero symmetry failures across 2000 seeds per tier and medians inside the band (HARD). The design work is good and the gate worked.

But the interface the owner runs is unchanged. HARD, all of it:

- `packages/core/src/ui/page.ts` is the same 443-line inline page it was before batch 14, polling every four seconds. It contains none of pass 3: no generator, no tokens, no font face, no brutalism.
- Batch 14 ruling 1 (fonts served as files, a font route test, `doctor` checking every asset route, a visible notice on font failure) is not built. No font file exists under `packages/core`; `doctor.ts` has no asset check; the daemon serves exactly one route as HTML and nothing else static.
- Batch 14 addendum 2 ruling 7 (`GET /tickets/{id}/progress`, `latest_activity` on board rows, `activity --progress`, the pure tool-to-state mapping) is not built. A grep of `packages/core/src` for any of those names finds nothing outside a comment.
- The batch 14 spec's own closing condition, "the owner's own walk on the new page closes the batch", has not happened because there is no new page to walk.

None of this is a fault in the closeout; the Orchestrator reported what was verified and it was verified. It is a fault in the batch 14 spec, which put "step 2, implementation" in one sentence and let the batch close on step 1. I own that. The consequence is simple: **batch 15 is batch 14 step 2**, plus the daemon read paths the design was drawn against, plus the one small core item already promised. Worker profiles move to batch 16. The route below is resequenced accordingly.

Two more facts that shape the roles:
- The page authenticates with an `Authorization` header on its own `fetch()` calls (HARD, `page.ts` header comment). The browser's `EventSource` cannot set headers, so a server-sent stream must be consumed with a streaming `fetch()`, never by putting the token in a URL.
- 544 tests across 49 files pass today (HARD, counted). They stay green.

## 1. Rulings

### Ruling 10 — per-agent identity, answering the Orchestrator's question before batch 16 is built

The question: after batch 15 the tier has no channel, so two agents sharing a purpose and a policy differ only by the cell draw, which is the coin flip on distinctness that was rejected for tiers. Correct observation. The answer has three parts.

1. **Two profiles with the same purpose and the same policy are the same character by the owner's own definition.** An identity is a profile, not a memory (owner-reference addendum, section 1). The organism saying "same kind" is honest, and the name label beside it says which one. That is not the defect. The defect to prevent is two **different** characters looking alike.
2. **Symmetry comes from a structural fact, not a keyword.** Policy sets symmetry through the profile's tool breadth: read-only tools give mirror-x, read-and-write gives mirror-y, shell access gives quad. That is deterministic, meaningful, and cannot drift with wording. Family comes from purpose through a fixed keyword table, with a hash fallback that must never be hit by the shipped default set. The cell draw comes from the profile's id and name.
3. **Distinctness of the default set is guaranteed by machine, as it was for tiers.** `check-organism.js` gains a check that every pair of default profiles differs by at least a Hamming distance the checker owns, proposed by the Designer with evidence and not below 5 of 25 cells, and that at least five distinct (family, symmetry) pairs are used across the seven. The Designer tunes the default purposes and policies until it passes; the Orchestrator mutation-tests it. An owner-added profile has its distance to every existing organism computed and printed at creation. Below the threshold it is a warning. The seed is never altered, because "same profile, same avatar, forever" outranks "no two alike".

This is recorded now so batch 16 inherits it rather than rediscovers it. Nothing in it changes batch 15.

### Ruling 11 — one generator file, extracted by the checker and served by the daemon

Pass 3 inlines the generator in each screen and the checker extracts it from a page (HARD). In the product the generator lives in exactly one file, `packages/core/ui/organism.js`, which the page includes and the daemon serves. `check-organism.js` reads that file. A test proves the served route returns it byte-identical to the file on disk. Version stays `mg.v1`.

### Ruling 12 — static files are served from the package, with a content-type table and no traversal

The daemon serves `GET /` as `ui/index.html` and `GET /ui/<name>` from `packages/core/ui/`, resolved relative to the module, with an explicit table for html, css, js, woff2 and svg, and a refusal for anything containing a path separator or dot-segment. Nothing else. No directory listing, no fallback to the old page.

## 2. Route, resequenced

- **Batch 15: the interface, built.** Pass 3 into the served page; the daemon read paths of ruling 7; a streamed event route; fonts and assets per batch 14 ruling 1; expected artefacts on tickets. Closes on the owner's walk.
- **Batch 16: worker profiles.** The default set, the per-profile seed, the Manager assigning a profile per ticket, ruling 10's checks. Only the seed and two lookups change in the generator.
- **Batch 17: the Windows window host**, OS notifications for Needs You, the token handoff.
- **Batch 18: per-ticket Manager discussion, tags, keyboard shortcuts, persisted layout.**
- **Parked, unchanged:** Linux, AionUi pull, failure-driven Manager triggers, worktrees, OS-level isolation, the Agent Generator.

What I would cut from batch 15 if it runs long, in order: the streamed route (the page can poll `latest_activity` at four seconds and animate on change, which is honest if slower); the `activity --progress` CLI flag. Nothing else is optional.

## 3. Batch 15 as shaped

Two roles, disjoint files, one contract between them, both sonnet at high thought. No fable role: nothing here is a design trade-off that has not already been ruled.

### Role A: Daemon Read-Path Engineer (sonnet, high)

Owns `daemonApi.ts`, `daemonClient.ts`, `commands/`, `scheduler.ts`, `store.ts`, `proposal.ts`, `managerEnvelope.ts`, `envelope.ts`, `resultContract.ts`, `types.ts`, `db/schema.ts`, `policy.ts` and their tests. Does not touch `ui/`.

Delivers:

1. **Ruling 7's read path.** `GET /tickets/{id}/progress` returning the latest progress events per run; `latest_activity` on every board row for a running ticket, `null` otherwise; `activity --progress --ticket <id>` on the CLI; one pure function mapping tool names to the brief's states (Read/Grep/Glob reading, Edit/Write writing, Bash running or testing when the command names a test runner, StructuredOutput finishing, a text line reporting), with a test per branch. The policy row for `worker_progress` stays internal.
2. **A streamed event route.** `GET /events?since=<sequence>` answers `text/event-stream`, authenticates by the same header as every other route, replays rows after `since` then pushes new ones, includes `worker_progress` rows and every row with non-internal visibility, carries the event's `sequence` as its id, and writes a comment line every fifteen seconds so a dead daemon is detectable within twenty. The token never appears in a URL. `daemonClient.ts` gains a consumer with a test.
3. **Static assets per rulings 11 and 12.** The route, the content-type table, the traversal refusal, a test that a font route answers 200 with `content-type: font/woff2`, a test that `/ui/organism.js` is byte-identical to the file on disk, and `doctor` fetching every asset route on a real install and printing PASS or FAIL per asset.
4. **Expected artefacts on tickets** (batch 14 spec ruling 3). A structured `expected_artifacts` list, each entry a kind and, for kind `file`, a path, on `create_ticket` and `update_ticket`; a migration with an upgrade test; the proposal validator rejecting a malformed list; the Manager envelope's rules text asking for it; the worker envelope carrying it; and DONE verified against it when present. A declared file that is not on disk at result time is the existing retryable class with a reason naming the missing artefact, and the run's failure reason says so on the board. Tickets without the list keep today's rule. The Manager's ruling-3 wording in the envelope is data the test reads back, not prose the test hopes is there.

Acceptance, all run by the Orchestrator on a cold checkout: `pnpm test` green; each route driven by hand with the daemon running and output pasted; the stream shown to deliver a fake-adapter progress event end to end and to close cleanly when the daemon stops; a fake-adapter run where a ticket declares a file it does not produce reaching the retryable class with the artefact named; the single write site for ticket status still exactly one.

### Role B: Interface Engineer (sonnet, high, design capability attached and read back before the first task, per batch 14 ruling 2)

Owns `packages/core/ui/**` (new), `src/ui/page.ts` and `src/ui/page.test.ts`, and `docs/design/pass3/check-organism.js` for the one change in ruling 11. Does not touch the daemon.

Delivers:

1. **Pass 3 as the served page.** `ui/index.html`, `ui/app.js`, `ui/tokens.css`, `ui/organism.js`, `ui/fonts/` with licences. One page carrying the fleet column, the board with the kanban and list toggle, Needs You, Scope, Conversation and Activity, under the vanilla rule: no build, no network, inline SVG icons, served files only. `page.ts` becomes the thin loader of `index.html` or is deleted; the old inline page does not survive as a fallback.
2. **Every element names its daemon field.** Rule 8: the page shows only what the daemon measures. The engineer delivers a table, element to field or route, committed beside the page. Anything in pass 3 with no field behind it is omitted and listed, not mocked. Mock data does not ship.
3. **The organism, keyed by tier, from the one file.** Batch 14 rule: tier = family + symmetry, status = colour, density a weight only. The tier is derived once, from the model id, in one function the daemon owns if Role A exposes it and the page otherwise; not duplicated.
4. **The activity layer on real events.** The organism animates once on a new progress event from the stream, in the state the daemon mapped, and is static otherwise. Never a loop. With the stream unavailable the page says so visibly and falls back to polling `latest_activity`; it does not pretend to be live.
5. **Batch 14 ruling 1's guards.** Font readiness checked through the browser's font-loading interface, with the visible notice "interface font did not load, run magarine doctor" on failure. Dark and light, 100 and 125 percent, keyboard reachable, no layout break on a long inbox reason or long scope, contrast at or above 4.5:1 measured against every surface a foreground can land on.

Acceptance, all run by the Orchestrator: existing page tests pass or are split per rule 5; new tests prove the script is valid JavaScript, the page references `/ui/organism.js`, and `check-organism.js` passes against `ui/organism.js`; a screenshot per screen in dark and light at both scalings; the element-to-field table reviewed line by line against the API; one small real run, a single ticket, watched on the page so the organism is seen to animate on a real event and settle; then the owner's walk through the Liaison, which closes the batch.

### The contract between A and B, fixed now so neither waits

- Board rows gain `latest_activity: { state, tool, at, sequence } | null`, where `state` is one of reading, writing, running, testing, finishing, reporting.
- Stream events are the event row as JSON, `id` equal to `sequence`, event name equal to `event_type`.
- Static routes are `GET /ui/<name>` exactly; the page requests nothing else.
- Role B starts on structure, tokens, generator and board rendering against today's `/board`; the stream and `latest_activity` are wired last, after Role A lands. The Orchestrator commits Role A first.

## 4. What the owner must decide or supply, through the Liaison

1. **Has pass 3 been seen and approved as the page they will get?** The batch 14 spec made the owner's yes on the mocks the gate to building. No approval of pass 3 is recorded on disk (HARD, grepped the design brief and the handover). If it has not been given, Role B does not start until it is. Role A is unaffected.
2. **Typeface: IBM Plex Sans or Inter.** Already open. Default if no answer within the batch: IBM Plex Sans, the recommendation on record. A token swap either way.
3. **Non-Latin scripts.** Already open. Default if no answer: Latin subset only, with the font notice covering the rest.
4. **One small real run, about the cost of a coffee in equivalent API terms, to see the page animate on a real event.** Consistent with the permission the owner gave for tiny runs in batch 1.

Nothing else blocks.

# Magarine — Batch 15 addendum 6: the organism animates from the board's own activity marker, not from the frame

Author: Strategist. Date: 2026-09-16. Follows addendum 5. Raised by the Designer, measured by the Orchestrator against a real spawned daemon, brought to me because the obvious fix crosses into Role A's completed file. Every anchor below re-read by me this turn.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. The defect, HARD

- `scheduler.ts` 615-622 records `worker_progress` with `entityType: 'run'`, `entityId: run.id`, and a payload of `message`, `costUsd`, `tool`, `state`. No ticket id.
- `EventRow` (`types.ts` 119-130) has no ticket id field.
- Every `data-org-for` on the page is a ticket id (`app.js` 413).
- `handleStreamEvent` (`app.js` 781-806) reads `data.entityId`, which is the run id, ticks `orgFor(runId)`, which matches nothing, and returns before the fallback because `payload.state` is always present (the scheduler always writes it). The fallback would fail the same way: `ticketById(runId)` is nothing. **The organism has never animated from the live stream.** No notice says so. Rule 9's exact failure.
- `src/ui/skin.test.ts` 202-211 certifies this dead path: it counts two `tick(` calls inside the `worker_progress` branch and passes. The test is mutation-verified and green, and it proves the shape of a path that cannot fire. That is one more time this project's green suite has hidden a real defect, and it goes in the close-out's testing state.

## 1. Ruling 18 — option A, the page reads the daemon's marker; the frame is only the trigger

### The reading of deliverable 4, confirmed

Deliverable 4 says the organism "animates once on a new progress event from the stream, in the state the daemon mapped, and is static otherwise. Never a loop." Option A satisfies that sentence, not a looser one, because `latestActivity.sequence` (`board.ts` 34, 48-55) is the `events.sequence` of the newest `worker_progress` row on the ticket's running run, which is the same integer the stream puts in the frame's `id`. The page compares two references to one event. The state is `payload.state`, the daemon's own mapping, read from the board row. Nothing is invented, so rule 8 holds; the frame is what causes the read, so "from the stream" holds; the tick fires only when the integer advances, so "once" is structural rather than a timer's promise.

### The mechanism

1. A `worker_progress` frame calls `refreshBoardOnly()` and nothing else. The branch at `app.js` 787-803 that resolves the frame's entity and ticks against it is deleted, not kept as a fallback. One path. The four-second poll (`app.js` 1082) reaches the same comparison, so deliverable 4's "falls back to polling" becomes an exercised branch instead of dead code.
2. After each board render, for every ticket whose `latestActivity.sequence` is greater than the last sequence animated for that ticket, `tick(orgFor(ticketId), latestActivity.state)` fires once and the per-ticket marker is updated. The marker starts absent; the first observed sequence ticks. A ticket with no `latestActivity` is not ticked and its marker is not touched.
3. **Coalescing, required.** `refreshBoardOnly` (`app.js` 878-884) has no in-flight guard, and the page's own legend says a run produces hundreds of progress events. One fetch in flight; a frame arriving during it marks the board dirty and one more fetch follows when the first resolves. Never a queue. Without this, option A turns a burst of frames into a burst of GET /board.
4. **The animation must survive a re-render.** `renderBoard` (`app.js` 434 onward) builds a fresh card per ticket on every render (`body.appendChild(ticketCard(t))`), so a refresh landing inside the 1600 ms animation window replaces the animating node. The Designer chooses the mechanism, carrying `data-tick` and `data-step` across to the new node, or keeping the old organism node when the ticket is unchanged, and proves it with a fake-adapter burst: frames closer together than 1600 ms, the organism visibly completes an animation. A screenshot pair is not proof of motion; the DevTools walk the Designer is already running is.
5. Rule 9 is unchanged: a failed board fetch after a frame already reaches `fail` and the notice. No new notice is needed because under this mechanism no frame is resolved per entity, so there is no "unresolvable entity" case left to report.

### The test, rewritten as the Designer proposes

`skin.test.ts` 202-211 is replaced, not weakened. The new claim: `tick(` has exactly one call site outside its definition; that call site is inside the branch that compares a per-ticket sequence against the board's `latestActivity.sequence`; no `setInterval` or `setTimeout` body reaches `tick(`. Mutation-checked three ways: remove the comparison and the test fails; add a `tick(` call in the poll timer and the test fails; add a second call site anywhere and the test fails. The old test's claim, two calls inside the frame branch, is gone with the branch.

## 2. Option B, declined now and carried

Adding `ticketId` to the `worker_progress` payload is nearly free at the write site: `ticket` is in scope at `scheduler.ts` 616 and `runs.ticket_id` is indexed. It is declined as the fix because it reopens Role A's completed file at `e9d37f8`, helps only events recorded after it lands, and keeps the stream and poll as two code paths, which is how the poll path became dead in the first place. It is carried as a batch 16 candidate on its own merits, "events are self-describing to any consumer", and if it lands, option A's mechanism does not change.

## 3. For the close-out

- Found by running a real daemon, not by any test. Add to the list begun in addendum 5 section 6.
- A mutation-verified whole-file grep certified a dead path. The lesson for the testing state: those tests prove that a file has a shape, and only a run proves that the shape does anything. The batch 15 walk (`docs/evidence/batch-15-walk/RESULT.md`) must include one live-stream animation observed, or the batch does not close.
- The Designer's refusal to re-shoot until this was ruled was correct. Pictures of a page whose live path is dead are honest-looking and wrong.

## 4. Not blocked

The Designer proceeds on this ruling. Role A's file is untouched. No owner contact.

# Magarine — Batch 19, mini-phase 4: what is it running, and is it stuck

Author: lead. Date: 2026-09-23. Written while 3B is in flight, as `batch-19-spec.md` section 5 said.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

The owner's words, from their batch 17 walk: *"one worker is running PowerShell, what exactly, is it
stuck"*.

## 0. What exists, HARD

- A progress event is `{ type: 'progress', message, costUsd?, unknownModel? }` (`types.ts` 300-311).
  The message is the adapter's own sentence; the tool's own input is never carried.
- `claudeCli.ts` 372-390 states the reason, and it is a security ruling, not an oversight: *"a Bash
  command line is the likeliest place in this system for a secret to appear, and the daemon's event
  log is replayed over the stream and rendered in a browser, permanently."* The adapter reads a
  predicate off `input.command` (is this a test runner?) and emits the ANSWER, never the command.
- So today the page can say a worker is using Bash, and not what it is doing. No transcript is
  stored anywhere (batch-18 replan section 0, grep confirmed then).

## 1. The trade-off, stated plainly

The owner wants to see the command. The standing ruling is that command text is the likeliest
carrier of a secret, and the event log is permanent and rendered in a browser. Both are right. The
question is not "show it or not" but **where the text is allowed to live, and for how long**.

Three candidates, and why two lose:

- **Put the command in the progress event.** Cheapest to build, worst outcome: the text lands in the
  permanent event log, is replayed over the stream to every page, and survives in the database of a
  product whose whole point is to run other people's work. Refused.
- **Store the worker's transcript.** Answers much more than the question, costs a storage design, a
  retention rule and a redaction rule, and puts far more secret-bearing text on disk than a command
  line. Refused for this batch; it is its own batch if the owner ever wants it.
- **A live, in-memory drill-down that is never persisted.** The scheduler already holds the live run.
  Keep the LAST command per running run in memory only, serve it from a route that reads that memory,
  and let it die with the run. This is the ruling.

## 2. Ruling 40 — the drill-down is live, in memory, and never written down

- The adapter gains a second, NON-persisted channel for the current tool use: `{ tool, detail }`
  where `detail` is the command text. It is delivered to the scheduler the same way progress is, but
  the scheduler **does not insert an event for it**. It updates a live map, keyed by run id.
- **Nothing about `detail` reaches the event log, the stream, the database, or any file.** A test
  asserts the events table and the activity feed contain none of it after a run that used Bash, and
  that the map is empty once the run settles.
- `GET /runs/{id}/live` returns `{ tool, detail, since, lastProgressAt }` for a RUNNING run, behind
  the token, or 404 once the run has settled. The page's roster row and board card get a control
  that opens it, showing: the tool, the command, when it started, and when the last progress arrived.
- **"Is it stuck" is answered by a measurement, not a guess:** the page shows the time since the last
  progress event, which the daemon already timestamps, and says nothing else. No "stuck" verdict.
- **The owner is told, once, in the page's own copy**, that the command is shown live and never
  stored, because that is the whole design and it is the reason the feature is safe.
- The existing `describeProgress` predicate and the "testing" activity state are untouched.

## 3. Acceptance

1. A run whose worker uses Bash: `GET /runs/{id}/live` shows the tool and the command while it runs.
2. After the run settles, the same route is 404 and the live map is empty.
3. The events table, the activity feed, the stream and every file on disk contain none of the
   command text, asserted after that run.
4. The page's drill-down shows the tool, the command, the start time and the time since the last
   progress, and never the word "stuck".
5. 401 without a token.
6. The suite passes; each mutation fails a named test, including one that puts `detail` into an event
   and is caught by the test in acceptance 3.

## 4. What this does not do

It does not answer "what did it run ten minutes ago", and it cannot, by construction. If the owner
wants history, that is the transcript question, and it needs its own ruling about retention and
redaction before a line of it is written.

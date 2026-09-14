# Batch 12 close-out runs — plan, written BEFORE running anything

Fixed in advance so the pass conditions cannot drift after seeing results.

## Run A — the README path that failed in batch 11

**This is the gate. It must pass before the owner is asked to do anything.**

Batch 11's walk failed here: the README never mentioned `--workspace-root`, the Manager
reasonably proposed `DIRECTORY`-workspace tickets, `workspace_root` was NULL, the work could
never run, `project set` could not repair it, and the explanation was recorded but never
displayed.

Performed from a **fresh folder, following only the README, with no flags the README does not
give me.**

**Pass conditions:**

1. A project created with **no flags at all** runs a `DIRECTORY` ticket to completion.
2. The batch 11 trap **cannot be reproduced** by following the written path.
3. **Every inbox line names a command**, checked by reading what is printed, not the source.

**Both README step-4 paths get exercised, not just one** — this is Role S's dimension 5, and
batch 11's walk only ever used `--mission`:

- **A1 — the hand-written scope path.** Write `SCOPE.md` into the folder myself, then run
  `plan` with **no `--mission` flag at all**. Role S flagged that this literal CLI sequence has
  no automated test; the underlying mechanism is covered piecemeal, the sequence is not.
- **A2 — the seeded path.** A fresh project, scope seeded via `--mission`.

## Run B — the model-choice run, which answers the owner's question

A scope deliberately mixing **three mechanical tasks with one that needs real design.** Run
once, with a real Manager.

**Report, per ticket: which model it chose and the reason it recorded.**

**A Manager that puts everything on one model is a FINDING, NOT A FAILURE.** The owner asked
whether it chooses; either answer is information, and the failure mode to avoid is reporting
"it works" because the machinery ran.

**Also watch, per Role S's dimension 3:** `model_reason` is now *required* — a proposal setting
a model without one is **invalid**, not merely unrecorded. This run is the first time a real
Manager has to satisfy that constraint. **Does it ever fail validation and burn an attempt over
a missing reason, or does it comply immediately?** That is a real risk introduced by this batch
and it should be reported either way.

## Dimensions Role S named that these runs are the first real test of

Recorded because they are honest admissions of what the suite cannot reach, and they came from
the engineer rather than from me.

1. **`--dir` defaulting to the real working directory** is only ever exercised for real outside
   the test harness — every test spawns the CLI with cwd derived from `--db`, which is necessary
   to keep tests off the real filesystem but means the production path (a bare `process.cwd()`,
   no override) has **zero real execution** before this walk. Run A is the sole real-world check
   it ever gets. **Run it from a directory with spaces in the path and an unrelated file already
   in it**, since nothing synthetic ever has — spaces in a Windows path are a classic breaker.
2. **The fallback-rate marker has only seen synthetic `usage_json`.** No real run has ever named
   an unrecognised model, and nothing in twenty cold runs will trigger it, because every current
   model is in `pricing.ts`. **This stays UNKNOWN after these runs and the close-out must say so.**
3. **`model_reason` strictness** applies to the Manager's proposal commands only, not to
   `ticket add --model` — deliberately, since those are direct owner actions rather than the
   judgement under test.
4. **The board's model column and the fallback marker have only met hand-built fixtures.** Run B
   is the first authentic `usage_json` this rendering path has ever seen.
5. **README step 4's two paths** — covered by A1 and A2 above.

## Cost framing

Figures reported are **equivalent API cost**: what the tool would have cost at API rates. The
owner is on a subscription, so these are for comparing one run against another and are **not
money leaving an account.** The binding constraint is session limits, and the session count is
reported alongside.

# Magarine — Batch 6: price by model, pin the model

Author: Strategist. Date: 2026-09-13. Follows `batch-5-closeout.md`.
Evidence labels: HARD = I read or ran it. SOFT = inferred. UNKNOWN = guessing.

## 0. What I verified myself after the close-out

HARD:
- Read `batch-5-closeout.md`; twenty commits on top of the upload, tree clean.
- The adapter's tally sums all four token categories and multiplies by one blended constant. The two stream fixtures carry `"model":"claude-fable-5-1"` on five lines and `"model":"claude-sonnet-5"` on seven, so the model is in the stream, per assistant line, as the close-out says.
- **The daemon never passes `--model` to the tool.** No model flag exists in `cli.ts`, `scheduler.ts`, or `envelope.ts`. Workers run on whatever the owner's Claude Code default happens to be at that moment, which is why two runs on the same day used two different models. The cost error is a symptom; the uncontrolled model is the cause.

## 1. Rulings on the four close-out questions

### 1. Per-model pricing is urgent, and it is only half the fix. The other half is pinning the model.
- **Pin it.** Projects get `default_model`, tickets get an optional `model` override, and the adapter passes `--model` explicitly on every spawn. Nothing about a worker's cost or capability may depend on the owner's desktop settings. Default is `claude-sonnet-5`, per the architecture document's tier logic: sonnet for implementation and normal work. The model used is recorded in `usage_json`.
- **Price per model and per category.** One rates file: for each known model id, the price per million tokens for input, output, cache creation, and cache read, with the source URL and the date they were read. The adapter tallies each assistant line by the model that line names and the category each token belongs to. No blended constant survives.
- **Unknown model is priced at the most expensive known rate**, with one `unknown_model_rate` activity event per run. Over-estimating stops work early and visibly; under-estimating lets spend past the ceiling silently. For an unattended daemon the visible error is the right one to make, and it only happens for models we have not listed.
- **Rates come from the official pricing page, not memory.** The role records the page and date in the file. The Orchestrator opens the page and checks every number before committing.

### 2. Recorded spend for already-stopped runs stays as it was.
It carries `source: "scheduler_budget_estimate"`, which is exactly the honesty the record needs. No backfill, no rewriting of history. From this batch, every estimate also carries the model it was computed for.

### 3. Convert the three test files.
Twenty green runs do not distinguish reasoning from luck, as the close-out says. Conversion is cheap and makes the rule uniform: every test file has a private temp root, no exceptions to remember.

### 4. Batch 6 proceeds on Windows now. The Linux leg waits for the owner and becomes batch 7 the moment the answer lands.

### The verification rule, refined as the Orchestrator proposed
"At least one paid run" becomes "enough paid runs to cover the dimensions the feature varies on, and the role names those dimensions in its report before the runs are chosen." For this batch the dimensions are: model, cache state, and whether the run completed or was stopped.

### Process, restated
Roles do not commit. The Orchestrator verifies, then commits. Role J's self-commits did no harm, but the gate runs in sequence, not after.

## 2. Batch 6: one role

### Role K: Pricing and Model Control Engineer — model tier: sonnet, high effort
Owns the whole of `packages/core` for this batch. Does not commit.
Deliver, in this order:
1. **Rates file** `src/pricing.ts`: per-model, per-category rates for every model the team is likely to run: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, plus the short aliases the tool prints if they differ. Source URL and date read in the file header. A function `priceUsage(model, usage)` returning dollars.
2. **Tally by model and category** in the adapter, replacing the blended constant. The two existing fixtures reproduce the tool's own total within two percent each; both assertions in one test, no tolerance widening.
3. **Unknown model** priced at the maximum known rate with the `unknown_model_rate` event, policy row included, tested.
4. **Pin the model.** `projects.default_model` (default `claude-sonnet-5`) and nullable `tickets.model`, migration with upgrade test; envelope carries the resolved model; adapter passes `--model`; `usage_json` records it. CLI: `project create --model`, `project set --model`, `ticket add --model`. Test: two tickets with different models produce two different `--model` arguments to the fake executable, and the run rows record each.
5. **Convert** `cli.test.ts`, `commands.test.ts`, and the migration tests to private temp roots.
6. **Report** names the dimensions the pricing feature varies on and which fixture or paid run covers each.
Acceptance: `pnpm test` green, twenty cold runs by the Orchestrator; the single write site still single; policy completeness passes; the Orchestrator has checked every rate against the pricing page.

### Orchestrator close-out for batch 6
1. Verify each step, commit each step yourself, cold test twenty times, grep the write site, check the rates against the page and say so.
2. Paid runs covering the model dimension: one completed run pinned to `claude-sonnet-5` and one pinned to `claude-haiku-4-5-20251001`, each with the tally compared to the tool's own total, pass at two percent. Then one budget-stop run pinned to sonnet at a twenty-five-cent ceiling, pass if the stop fires between twenty-five and thirty cents of the tool-consistent estimate rather than at a fifth of it. Under a dollar (SOFT).
3. State which paid run covered which dimension.
4. Report every UNKNOWN and the spend.

## 3. What the owner must decide or supply
Nothing blocks batch 6. The Ubuntu questions remain open with the Liaison and are not chased.

## 4. Looking ahead, not for dispatch
Batch 7 is the Linux leg, when the owner answers. Batch 8 is AionUi in the pull shape. After both: daemon mode with a local API so `cancel` reaches a running worker, then the Manager invocation, which is where model tiers per ticket get chosen by something other than the owner's hand, then `GIT_WORKTREE`, then OS-level worker isolation.

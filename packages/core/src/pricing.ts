// Per-model, per-token-category pricing. Batch 6 Role K
// (docs/strategy/batch-6-spec.md section 2, Role K item 1), replacing the
// single blended $-per-raw-token constant in claudeCli.ts
// (BLENDED_USD_PER_RAW_TOKEN), which batch 5's second fixture proved wrong
// by 405% because it could not distinguish models (docs/strategy/batch-5-closeout.md
// section 2).
//
// Rates read HARD from:
//   https://claude.com/pricing (per-model input/output/cache-read/cache-write
//     table; cache-write figures on that page are explicitly the 5-minute
//     TTL) and
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//     (the multipliers: 5-minute cache writes are 1.25x base input, 1-hour
//     cache writes are 2x base input, cache reads are 0.1x base input except
//     Claude Fable 5.1 and Claude Mythos 5.1, which use 0.025x)
// both read 2026-09-13.
//
// Verified against the two real recorded fixtures this repository has both
// the full stream and the tool's own authoritative `total_cost_usd` for
// (spikes/claude-cli/runs/2026-09-12T14-15-13-624Z-stream, claude-fable-5-1,
// and .../2026-09-13T13-23-00-000Z-stream-calib2, claude-sonnet-5): this
// module's formula reproduces both totals exactly (0.000% off), using the
// terminal `result` line's usage, which is authoritative -- summing
// `assistant` line usage undercounts output tokens by 3-15x in these same
// fixtures, since a message's usage is repeated (not incremental) across the
// stream lines that carry it. See pricing.test.ts.

/** Shape of the terminal `result` line's `usage` object (and, for a
 * mid-run tally, an `assistant` line's `message.usage`) that pricing needs.
 * Other fields the tool reports (service_tier, iterations, ...) are not
 * priced and are not part of this type. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

interface ModelRates {
  /** $ per million input tokens. */
  input: number;
  /** $ per million output tokens. */
  output: number;
  /** $ per million tokens written to the 5-minute-TTL cache (1.25x input). */
  cacheWrite5m: number;
  /** $ per million tokens written to the 1-hour-TTL cache (2x input). */
  cacheWrite1h: number;
  /** $ per million tokens read from cache. */
  cacheRead: number;
}

// Every model id here is the exact string the tool prints on an
// `assistant`/`result` line's `message.model` (verified HARD against the two
// fixtures above: `claude-fable-5-1` and `claude-sonnet-5`). No shortened
// alias has been observed for any model in a real fixture, for Opus 5 or
// Haiku 4.5 either -- see pricing.test.ts and this batch's report for the
// UNKNOWN this leaves.
const RATES: Record<string, ModelRates> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
};

// Ruling, docs/strategy/batch-6-spec.md section 1 ruling 1: "Unknown model is
// priced at the most expensive known rate." Componentwise max, not "the
// rates of whichever known model happens to be priciest overall" -- the two
// are not the same table today. Fable 5.1 tops input, output and both
// cache-write categories, but Opus 5 tops cache-read ($0.50/MTok), because
// Fable gets a special 0.025x cache-read multiplier where every other model
// uses the standard 0.1x (see header comment). A model-level max would have
// under-priced cache reads for an unknown model; componentwise does not.
const UNKNOWN_MODEL_RATES: ModelRates = Object.values(RATES).reduce(
  (max, r) => ({
    input: Math.max(max.input, r.input),
    output: Math.max(max.output, r.output),
    cacheWrite5m: Math.max(max.cacheWrite5m, r.cacheWrite5m),
    cacheWrite1h: Math.max(max.cacheWrite1h, r.cacheWrite1h),
    cacheRead: Math.max(max.cacheRead, r.cacheRead),
  }),
  { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }
);

/** True if `model` has its own rate row; false means `priceUsage` will fall
 * back to `UNKNOWN_MODEL_RATES`. Exposed so a caller (the adapter, batch 6
 * item 3) can emit the `unknown_model_rate` event exactly when this is
 * false, without duplicating the rate lookup. */
export function isKnownModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATES, model);
}

/** Batch 12 item 3: every model id this table knows a rate for, in the
 * exact strings the tool prints (see the header comment) -- the single
 * source managerEnvelope.ts's model-guidance paragraph and its own test
 * both read, so the paragraph can never name a model this table doesn't
 * actually have a rate for, or silently drop one that was added here. */
export function knownModelIds(): string[] {
  return Object.keys(RATES);
}

/** Batch 12 item 3: `model`'s own $-per-million-input-tokens rate, the
 * dimension the envelope's price-ratio line is computed from. Throws for a
 * model this table has no row for -- every real caller sources `model` from
 * `knownModelIds()` above, so this is never expected to be reached with an
 * unrecognized id. */
export function inputRateUsd(model: string): number {
  const rates = RATES[model];
  if (!rates) throw new Error(`inputRateUsd: no rate row for "${model}"`);
  return rates.input;
}

/** Dollar cost of `usage` for `model`, per the rates above. Unknown models
 * price at the most expensive known rate (see UNKNOWN_MODEL_RATES) rather
 * than throwing or pricing at zero: over-estimating an unattended daemon's
 * spend stops work early and visibly; under-estimating lets real spend past
 * a budget ceiling silently. */
export function priceUsage(model: string, usage: Usage): number {
  const rates = RATES[model] ?? UNKNOWN_MODEL_RATES;
  const cache1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cache5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  return (
    (usage.input_tokens * rates.input) / 1_000_000 +
    (usage.output_tokens * rates.output) / 1_000_000 +
    (cache1h * rates.cacheWrite1h) / 1_000_000 +
    (cache5m * rates.cacheWrite5m) / 1_000_000 +
    (usage.cache_read_input_tokens * rates.cacheRead) / 1_000_000
  );
}

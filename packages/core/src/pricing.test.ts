import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isKnownModel, priceUsage, type Usage } from './pricing.ts';

// Same two real recorded fixtures batch 5 calibrated the blended constant
// against (docs/strategy/batch-5-closeout.md section 2): one completed run
// per model, each carrying both a full stream and the tool's own
// authoritative `total_cost_usd` on the terminal `result` line.
const runsDir = fileURLToPath(new URL('../../../spikes/claude-cli/runs/', import.meta.url));

function resultLine(fixtureDir: string): { model: string; usage: Usage; total_cost_usd: number } {
  const stdout = readFileSync(join(runsDir, fixtureDir, 'stdout.txt'), 'utf8');
  let model: string | undefined;
  let result: { usage: Usage; total_cost_usd: number } | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'assistant' && !model) {
      model = ((obj.message as Record<string, unknown>)?.model as string) ?? undefined;
    }
    if (obj.type === 'result') {
      result = { usage: obj.usage as Usage, total_cost_usd: obj.total_cost_usd as number };
    }
  }
  if (!model || !result) throw new Error(`fixture ${fixtureDir} missing an assistant model or a result line`);
  return { model, usage: result.usage, total_cost_usd: result.total_cost_usd };
}

const FIXTURE_1 = '2026-09-12T14-15-13-624Z-stream'; // claude-fable-5-1, calibration source
const FIXTURE_2 = '2026-09-13T13-23-00-000Z-stream-calib2'; // claude-sonnet-5, batch 5's second point

test('priceUsage reproduces fixture 1 (claude-fable-5-1) total_cost_usd within 2%', () => {
  const { model, usage, total_cost_usd } = resultLine(FIXTURE_1);
  assert.equal(model, 'claude-fable-5-1');
  const estimate = priceUsage(model, usage);
  const pctOff = (Math.abs(estimate - total_cost_usd) / total_cost_usd) * 100;
  assert.ok(
    pctOff <= 2,
    `estimate ${estimate} vs tool total ${total_cost_usd} is ${pctOff.toFixed(3)}% off, exceeds the 2% bound`
  );
});

test('priceUsage reproduces fixture 2 (claude-sonnet-5) total_cost_usd within 2%', () => {
  const { model, usage, total_cost_usd } = resultLine(FIXTURE_2);
  assert.equal(model, 'claude-sonnet-5');
  const estimate = priceUsage(model, usage);
  const pctOff = (Math.abs(estimate - total_cost_usd) / total_cost_usd) * 100;
  assert.ok(
    pctOff <= 2,
    `estimate ${estimate} vs tool total ${total_cost_usd} is ${pctOff.toFixed(3)}% off, exceeds the 2% bound`
  );
});

test('an unknown model id is priced at the most expensive known rate, componentwise', () => {
  const usage: Usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
  };
  assert.equal(isKnownModel('some-future-model'), false);
  assert.equal(isKnownModel('claude-fable-5-1'), true);
  // Fable 5.1 tops input/output/both cache-write rates, but NOT cache-read:
  // Fable gets a special 0.025x cache-read multiplier (vs. the standard
  // 0.1x), so Opus 5's cache-read rate ($0.50/MTok) is the most expensive
  // known one even though Opus is cheaper than Fable everywhere else. So
  // the componentwise max is Fable's price plus the (Opus - Fable)
  // cache-read difference, not simply Fable's own total.
  const fable = priceUsage('claude-fable-5-1', usage);
  const opusCacheReadDelta = (usage.cache_read_input_tokens * (0.5 - 0.25)) / 1_000_000;
  assert.equal(priceUsage('some-future-model', usage), fable + opusCacheReadDelta);
});

test('priceUsage treats missing cache_creation as zero cache-write tokens', () => {
  const usage: Usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };
  const price = priceUsage('claude-sonnet-5', usage);
  assert.equal(price, (100 * 2) / 1_000_000 + (50 * 10) / 1_000_000);
});

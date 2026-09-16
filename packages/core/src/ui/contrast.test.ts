// RULE 16. "Measure a foreground against the LIGHTEST SURFACE IT CAN LAND ON,
// not the one it usually sits on, and re-measure every surface when one moves.
// An unused token that silently fails contrast is a trap, not a token."
//
// This exists because a 10px element shipped at 4.23:1. It was measured against
// one surface. Three others existed.
//
// THE SHAPE OF THIS TEST IS DELIBERATE AND IS NOT NEGOTIABLE DOWN TO "the pairs
// the page can actually produce". Reachability was the argument last time --
// seven failing pairs were excused because --surface-3 was not used as a
// background yet -- and reachability changes the moment somebody uses a token,
// at which point nobody re-measures. So: EVERY FOREGROUND TOKEN AGAINST EVERY
// SURFACE TOKEN, IN EVERY THEME. No exemption list, no reachability judgement.
//
// The values are parsed OUT OF ui/tokens.css. Nothing is restated here, so a
// token cannot be changed in the stylesheet and stay green here by being stale.
// The threshold and the token names are this file's own constants, so the
// stylesheet does not get to move its own goalposts (rule 17).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_DIR } from './page.ts';

const THRESHOLD = 4.5;

// Named here, not discovered, so DELETING a token from tokens.css fails this
// test rather than silently shrinking the matrix.
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3'];
const FOREGROUNDS = [
  '--fg', '--fg-2', '--fg-3',
  '--st-waiting', '--st-active', '--st-review', '--st-blocked',
  '--st-failed', '--st-done', '--st-cancelled',
];
// Every colour used as a FILL, with the token that lands on top of it. The
// status colours back the primary button and the artefact chip; --fg backs the
// button hover state.
const ON_FILL: Array<[fill: string, fg: string]> = [
  ['--st-waiting', '--on-status'], ['--st-active', '--on-status'],
  ['--st-review', '--on-status'], ['--st-blocked', '--on-status'],
  ['--st-failed', '--on-status'], ['--st-done', '--on-status'],
  ['--st-cancelled', '--on-status'],
  ['--fg', '--bg'],
];
const THEMES = ['oled', 'dark', 'light'];

// ---------------------------------------------------------------------------
// WCAG 2.x relative luminance and contrast ratio, from the specification.
// ---------------------------------------------------------------------------
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m![1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Two decimal places, always rounded DOWN, so a pair at 4.499 can never be
// reported or compared as 4.50.
function floor2(n: number): number {
  return Math.floor(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// The themes, read out of the stylesheet.
// ---------------------------------------------------------------------------
const CSS = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');

function themeBlock(theme: string): string {
  // `:root, [data-theme="oled"]` is the default block; the other two are keyed
  // on the attribute alone.
  const start = CSS.indexOf(`[data-theme="${theme}"]`);
  assert.notEqual(start, -1, `tokens.css declares no [data-theme="${theme}"] block`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  assert.ok(open > 0 && close > open, `could not read the [data-theme="${theme}"] block`);
  return CSS.slice(open, close);
}

function tokensOf(theme: string): Record<string, string> {
  const block = themeBlock(theme);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------

test('the contrast helper itself discriminates -- black on white is 21:1, white on white is 1:1', () => {
  // A ratio function that always returned a big number would make every check
  // below pass. This is the check on the check.
  assert.equal(floor2(ratio('#000000', '#FFFFFF')), 21);
  assert.equal(floor2(ratio('#FFFFFF', '#FFFFFF')), 1);
  // The two greys either side of the 4.5:1 line on white. One digit apart, and
  // the helper has to put them on opposite sides -- that is the discrimination
  // a screenshot cannot make and this file exists to make instead.
  assert.ok(floor2(ratio('#767676', '#FFFFFF')) >= THRESHOLD, '#767676 on white should pass');
  assert.ok(floor2(ratio('#777777', '#FFFFFF')) < THRESHOLD, '#777777 on white should fail');
});

test('every theme declares every surface and every foreground token', () => {
  for (const theme of THEMES) {
    const t = tokensOf(theme);
    for (const name of [...SURFACES, ...FOREGROUNDS, '--on-status']) {
      assert.ok(t[name], `[data-theme="${theme}"] is missing ${name}`);
    }
  }
});

test(`every foreground clears ${THRESHOLD}:1 against EVERY surface, in every theme`, () => {
  const failures: string[] = [];
  let pairs = 0;
  let worst = { ratio: Infinity, where: '' };

  for (const theme of THEMES) {
    const t = tokensOf(theme);
    for (const fg of FOREGROUNDS) {
      for (const bg of SURFACES) {
        const r = floor2(ratio(t[fg], t[bg]));
        pairs++;
        if (r < worst.ratio) worst = { ratio: r, where: `${theme} ${fg} on ${bg}` };
        if (r < THRESHOLD) {
          failures.push(`${theme}: ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r}:1`);
        }
      }
    }
  }

  assert.equal(
    failures.length, 0,
    `${failures.length} of ${pairs} pairs are below ${THRESHOLD}:1:\n  ` + failures.join('\n  ')
  );
  // Not an assertion about the number -- a guard that the loop ran at all. A
  // matrix that silently became empty would otherwise pass.
  assert.equal(pairs, THEMES.length * FOREGROUNDS.length * SURFACES.length);
  assert.ok(worst.ratio >= THRESHOLD, `worst pair ${worst.where} at ${worst.ratio}:1`);
});

test(`every fill colour clears ${THRESHOLD}:1 against the text that lands on it`, () => {
  // A status colour is not only a foreground: it is the background of the
  // primary button and the artefact chip, with --on-status written over it.
  const failures: string[] = [];
  let pairs = 0;
  for (const theme of THEMES) {
    const t = tokensOf(theme);
    for (const [fill, fg] of ON_FILL) {
      const r = floor2(ratio(t[fg], t[fill]));
      pairs++;
      if (r < THRESHOLD) failures.push(`${theme}: ${fg} ${t[fg]} on fill ${fill} ${t[fill]} = ${r}:1`);
    }
  }
  assert.equal(failures.length, 0, `${failures.length} of ${pairs} fill pairs below ${THRESHOLD}:1:\n  ` + failures.join('\n  '));
  assert.equal(pairs, THEMES.length * ON_FILL.length);
});

test('no colour is written outside a theme block, so the matrix above is the whole page', () => {
  // A hex literal anywhere else in tokens.css is a colour no theme controls and
  // no pair above measures -- the exact shape of the trap rule 16 names. The
  // @font-face blocks and the base rules must stay colourless.
  const withoutThemeBlocks = THEMES.reduce((acc, theme) => acc.replace(themeBlock(theme), ''), CSS);
  const strays = [...withoutThemeBlocks.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(strays, [], `tokens.css has colour literals outside its theme blocks: ${strays.join(', ')}`);
});

test('the skin introduces no colour of its own either', () => {
  // Same rule, applied to the file that a second skin will be written beside.
  // A skin recolours by choosing different TOKENS, never by inventing a value,
  // because an invented value is unmeasured by everything above.
  const skin = readFileSync(join(UI_DIR, 'skin-brutalist.css'), 'utf8');
  const strays = [...skin.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(strays, [], `skin-brutalist.css has raw colour literals: ${strays.join(', ')}`);
});

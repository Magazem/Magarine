// RULING 13 (docs/strategy/batch-15-addendum-2-second-skin.md), enforced.
//
// The owner's own design comes back later as a SECOND SKIN: the same six
// product regions, arranged differently, in a different visual language. The
// ruling's claim is that this is nearly free to allow before the page is
// written and a rewrite of index.html the day after. These tests are what keeps
// it true once nobody is thinking about it any more.
//
// Requirement 3 is checked as a WHOLE-FILE GREP WITH NO COMMENT STRIPPING, on
// purpose. A checker that ignores comments can be satisfied by moving a
// violation into one; app.js's own header is worded to avoid the tokens rather
// than this test being weakened to tolerate them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_HTML, UI_DIR } from './page.ts';

const APP = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
const TOKENS = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');
const SKIN = readFileSync(join(UI_DIR, 'skin-brutalist.css'), 'utf8');

// The six product regions. This list is THIS FILE'S constant: a skin addresses
// regions by these ids and nothing else, so renaming one in the markup has to
// fail here rather than silently breaking every future skin (rule 17 -- assert
// against a constant the checker owns, never one read from the subject).
const REGIONS = ['fleet', 'board', 'needs-you', 'scope', 'conversation', 'activity'];

// Words that describe how a thing LOOKS rather than what it IS. A class name
// built from one of these is presentation leaking into the script, which is
// what a second skin then cannot override. Owned here, not imported.
const PRESENTATIONAL = [
  'red', 'green', 'blue', 'grey', 'gray', 'orange', 'yellow', 'purple', 'white', 'black',
  'dark', 'light', 'bright', 'dim', 'muted', 'faded',
  'small', 'large', 'big', 'tiny', 'huge', 'sm', 'lg', 'xs', 'xl',
  'left', 'right', 'top', 'bottom', 'center', 'centre', 'middle', 'above', 'below',
  'pad', 'padded', 'margin', 'gap', 'tight', 'loose', 'wide', 'narrow',
  'bold', 'italic', 'underline', 'upper', 'lower',
  'rounded', 'square', 'circle', 'shadow', 'border', 'flat', 'raised',
  'hidden', 'visible', 'on', 'off', 'active', 'inactive',
];

// ------------------------------------------- 1. six regions, stable ids

test('index.html carries the six product regions under their fixed ids', () => {
  for (const id of REGIONS) {
    assert.ok(
      new RegExp(`<section id="${id}"`).test(PAGE_HTML),
      `there is no <section id="${id}"> -- a skin addresses regions by id and nothing else`
    );
  }
});

test('the skin places every region, so a second skin knows what it has to place', () => {
  for (const id of REGIONS) {
    assert.ok(SKIN.includes(`#${id}`), `skin-brutalist.css never mentions #${id}`);
  }
});

// -------------------------------------- 2. placement lives in the skin

test('the regions are direct children of <body>, with no layout wrapper between', () => {
  // A wrapper existing only to serve pass 3's arrangement is the specific thing
  // that makes a second skin a rewrite. This walks the markup between <body>
  // and each region and requires nothing in the way.
  const body = PAGE_HTML.slice(PAGE_HTML.indexOf('<body>'));
  for (const id of REGIONS) {
    const before = body.slice(0, body.indexOf(`<section id="${id}"`));
    // Count tags opened and closed before this region. If any element is still
    // open, the region is nested inside it.
    const opens = [...before.matchAll(/<(div|section|main|aside|nav|header|footer)\b(?![^>]*\/>)/g)].length;
    const closes = [...before.matchAll(/<\/(div|section|main|aside|nav|header|footer)>/g)].length;
    assert.equal(opens, closes, `#${id} is nested inside a layout wrapper (${opens - closes} element(s) still open)`);
  }
});

test('arrangement is done with grid areas, which is the one thing a second skin edits', () => {
  assert.match(SKIN, /grid-template-areas:/);
  for (const id of REGIONS) {
    assert.ok(
      new RegExp(`#${id}\\s*{[^}]*grid-area:`).test(SKIN),
      `#${id} has no grid-area, so a skin cannot move it`
    );
  }
});

// ------------------------------------ 3. the script sets state, never style

test('app.js never writes an inline style', () => {
  assert.equal(APP.includes('.style.'), false, 'app.js reaches for an element style property');
  assert.equal(APP.includes('style='), false, 'app.js writes a style attribute');
  assert.equal(APP.includes('setProperty('), false, 'app.js sets a custom property from script');
  assert.equal(APP.includes('cssText'), false, 'app.js writes cssText');
});

test('app.js sets no presentational class name', () => {
  // Every string passed to el() as a class, plus every className/classList
  // write, checked word by word against the list above.
  const names = new Set<string>();
  for (const m of APP.matchAll(/el\('[a-z]+',\s*'([^']+)'/g)) for (const w of m[1].split(' ')) names.add(w);
  for (const m of APP.matchAll(/className\s*=\s*'([^']+)'/g)) for (const w of m[1].split(' ')) names.add(w);
  for (const m of APP.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) names.add(m[1]);

  assert.ok(names.size > 10, `only found ${names.size} class names -- this test stopped seeing them`);
  const bad: string[] = [];
  for (const name of names) {
    for (const part of name.split('-')) {
      if (PRESENTATIONAL.includes(part)) bad.push(`${name} (contains "${part}")`);
    }
  }
  assert.deepEqual(bad, [], `app.js sets presentational class names: ${bad.join(', ')}`);
});

test('variation is carried on data attributes, where a skin can reach it', () => {
  // The positive half of the rule: having removed inline style, the state has
  // to be somewhere. A page that simply stopped expressing status would pass
  // the two checks above.
  for (const attr of ['data-status', 'data-size', 'data-step', 'data-tick', 'data-board-view', 'data-lane']) {
    assert.ok(APP.includes(attr), `app.js never writes ${attr}`);
  }
});

test('every data attribute the script writes is consumed by a stylesheet or a selector', () => {
  // THIS IS THE CHECK THAT ACTUALLY BITES, and it exists because the weaker
  // version above did not. Mutating ONE of two `data-status` write sites to
  // `data-nope` left the string present elsewhere in the file, so "app.js
  // writes data-status" still passed while the organism silently lost its
  // colour. Presence somewhere is not the claim; being consumed is.
  //
  // An attribute nothing reads is the same trap as an unused token that fails
  // contrast: it reads as a hook a skin can rely on, and it is not one.
  const written = new Set([...APP.matchAll(/setAttribute\('(data-[a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(written.size >= 10, `only ${written.size} data attributes found -- this test stopped seeing them`);

  const orphans: string[] = [];
  for (const attr of written) {
    const styled = TOKENS.includes(`[${attr}`) || SKIN.includes(`[${attr}`);
    const queried = APP.includes(`[${attr}=`);      // querySelector addressing
    if (!styled && !queried) orphans.push(attr);
  }
  assert.deepEqual(orphans, [],
    `app.js writes ${orphans.join(', ')}, which no stylesheet resolves and no selector reads`);
});

// --------------------------------- 4. two independent switches on the root

test('the root carries a palette switch and a skin switch, and they are separate', () => {
  assert.match(PAGE_HTML, /<html[^>]*\bdata-theme="oled"/);
  assert.match(PAGE_HTML, /<html[^>]*\bdata-skin="brutalist"/);
  // Palette lives in tokens.css, visual language in the skin. If the skin
  // started declaring themes the two switches would no longer be independent.
  assert.match(TOKENS, /\[data-theme="light"\]/);
  assert.equal(SKIN.includes('[data-theme='), false, 'the skin declares a palette -- that is tokens.css\'s job');
});

test('the page loads the skin the root names, so a second one needs no markup change', () => {
  assert.match(PAGE_HTML, /href="\/ui\/skin-brutalist\.css" id="skin"/);
  assert.match(APP, /'\/ui\/skin-' \+ name \+ '\.css'/);
});

// ----------------------------------- 5. the organism is product, not skin

test('the organism and its animation rule live in the product layer, not the skin', () => {
  assert.match(TOKENS, /\.org\s*{/);
  assert.match(TOKENS, /@keyframes org-cell/);
  // A skin may restyle the organism's container and scale. It may not touch the
  // cells or the animation.
  assert.equal(SKIN.includes('@keyframes org-cell'), false, 'the skin redefines the organism animation');
  assert.equal(/\.org\s+i\s*{/.test(SKIN), false, 'the skin restyles the organism cells');
});

test('the animation runs once and cannot be made to loop from the stylesheet', () => {
  // "It is never a loop. A loader spinning while nothing runs is precisely the
  // lie this batch exists to prevent."
  const rule = TOKENS.slice(TOKENS.indexOf('.org[data-tick] i {'));
  assert.match(rule.slice(0, 200), /animation: org-cell var\(--tick\) var\(--ease\) 1;/);
  assert.equal(TOKENS.includes('infinite'), false, 'tokens.css contains an infinite animation');
  assert.equal(SKIN.includes('infinite'), false, 'the skin contains an infinite animation');
  assert.equal(APP.includes('setInterval') && APP.includes('tick('), true);
  // The one poll interval must not be the thing that animates.
  assert.equal(/setInterval\([^)]*tick\(/.test(APP), false, 'the organism is animated on a timer');
});

test('tick() is called from exactly one place: a progress event arriving', () => {
  const calls = [...APP.matchAll(/(?<![a-zA-Z.])tick\(/g)].length;
  const definition = 1;
  assert.equal(calls - definition, 2,
    'tick() is called from somewhere other than the worker_progress branch ' +
    '(two calls are expected there: the mapped state, and the fallback after re-reading the board)');
  const progressBranch = APP.slice(APP.indexOf("if (name === 'worker_progress')"), APP.indexOf('function openStream'));
  assert.equal([...progressBranch.matchAll(/(?<![a-zA-Z.])tick\(/g)].length, 2,
    'the two tick() calls are not both inside the worker_progress branch');
});

// ------------------------------------------ 6. rule 8 applies to every skin

test('the skin decorates but cannot invent data: it contains no content property with text', () => {
  // CSS `content` is the one way a stylesheet can put words on the screen that
  // no daemon field produced. Decoration is allowed; text is not.
  const contents = [...SKIN.matchAll(/content:\s*(['"])([^'"]*)\1/g)].map((m) => m[2]);
  const withText = contents.filter((c) => /[A-Za-z0-9]/.test(c));
  assert.deepEqual(withText, [], `the skin writes text no daemon field produced: ${withText.join(', ')}`);
});

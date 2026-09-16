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
  //
  // RULING 15 adds `data-view` here. THE MATCH IS ON THE QUOTED ATTRIBUTE
  // NAME rather than a bare substring. To be exact about why, because an
  // earlier version of this comment was not: `data-view` is NOT in fact a
  // substring of `data-board-view` (`data-` is followed by `board-`), and the
  // lead verified that with the real `setAttribute` write site removed BOTH
  // the quoted and the unquoted form fail. So the bare form was not a check
  // that cannot fail, and this tightening fixed no live defect.
  //
  // It is kept because it is unconditionally the more precise claim: the
  // quoted form asserts "app.js writes this attribute", while the bare form
  // asserts only "this string appears somewhere in app.js" -- which a comment
  // or a selector would satisfy, and which WOULD silently pass if any future
  // attribute here were a genuine substring of another. None of the seven
  // currently are. Guarding a hypothetical is cheap; the false rationale was
  // not, which is why it is corrected rather than deleted.
  for (const attr of ['data-status', 'data-size', 'data-step', 'data-tick',
                      'data-board-view', 'data-lane', 'data-view']) {
    assert.ok(APP.includes(`'${attr}'`), `app.js never writes ${attr}`);
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

// RULING 18 (docs/strategy/batch-15-addendum-6-organism-live-path.md).
// REPLACES the old 'tick() is called from exactly one place: a progress event
// arriving', which died with the branch it described -- and which is worth a
// sentence, because it was a well-behaved test asserting the wrong thing. It
// counted `tick(` occurrences inside a SLICE OF SOURCE TEXT, so it passed
// whether or not that branch could ever fire. It could not: the frame's
// entityId is a run id and every organism is keyed by ticket id, so the call
// site it certified was dead. Mutation testing did its job -- it proved the
// test discriminated on the property asserted -- and the property asserted was
// the wrong one. A test like this proves the file has a shape; only a run
// proves the shape does anything. src/ui/stream.test.ts is the run.
test('the organism is animated only where a new progress sequence is observed', () => {
  const calls = [...APP.matchAll(/(?<![a-zA-Z.])tick\(/g)];
  assert.equal(calls.length - 1, 1,
    `tick( has ${calls.length - 1} call sites outside its definition; ruling 18 allows exactly one`);

  // That one site sits inside the branch that compares a per-ticket marker
  // against the board's own latestActivity.sequence. Naming the comparison is
  // the point: an unconditional call would animate on every render, which is a
  // timer wearing a different hat.
  const sync = APP.slice(APP.indexOf('function syncMotion('), APP.indexOf('function resumeMotion('));
  assert.ok(sync.length > 0, 'syncMotion() was not found where the single call site is expected');
  assert.equal([...sync.matchAll(/(?<![a-zA-Z.])tick\(/g)].length, 1,
    'the one tick( call site is not inside syncMotion()');
  assert.match(sync, /\.sequence\s*>\s*[a-zA-Z.]+\.sequence/,
    'syncMotion() does not compare the marker against latestActivity.sequence, ' +
    'so nothing bounds the animation to a NEW event');

  // And no timer reaches it. A setInterval or setTimeout body containing
  // tick( would reintroduce exactly the loader-spinning-over-nothing this
  // whole batch exists to refuse.
  for (const m of APP.matchAll(/set(?:Interval|Timeout)\(\s*function\s*\([^)]*\)\s*\{/g)) {
    const body = APP.slice(m.index!, APP.indexOf('\n', APP.indexOf('}', m.index!)));
    assert.equal(/(?<![a-zA-Z.])tick\(/.test(body), false,
      `a timer body reaches tick(: ${body.slice(0, 80)}`);
  }
});

test('a board read is coalesced, so a burst of progress events is not a burst of fetches', () => {
  // RULING 18 requirement 3. The legend says hundreds of progress events in a
  // single run, and under ruling 18 a frame's ONLY effect is to re-read the
  // board -- so without a guard the page turns one run into hundreds of
  // GET /board. One in flight, a frame during it marks dirty, one more
  // follows. A QUEUE would be the same defect with a delay bolted on, which is
  // why the marker has to be a boolean and not a counter or a list.
  const fn = APP.slice(APP.indexOf('function refreshBoardOnly('), APP.indexOf('function refresh('));
  assert.ok(fn.length > 0, 'refreshBoardOnly() was not found');
  assert.match(fn, /inFlight/, 'refreshBoardOnly() has no in-flight guard');
  assert.match(fn, /dirty\s*=\s*true/, 'nothing marks the board dirty while a read is in flight');
  assert.equal(/push\(|\.concat\(|\[\s*\]\s*;/.test(fn), false,
    'refreshBoardOnly() builds a collection -- a queue of pending reads is not coalescing');
});

// ------------------------------------------ 6. rule 8 applies to every skin

test('the skin decorates but cannot invent data: it contains no content property with text', () => {
  // CSS `content` is the one way a stylesheet can put words on the screen that
  // no daemon field produced. Decoration is allowed; text is not.
  const contents = [...SKIN.matchAll(/content:\s*(['"])([^'"]*)\1/g)].map((m) => m[2]);
  const withText = contents.filter((c) => /[A-Za-z0-9]/.test(c));
  assert.deepEqual(withText, [], `the skin writes text no daemon field produced: ${withText.join(', ')}`);
});

// ================================================================ RULING 15
// THE THREE-VIEW NAVIGATION SURVIVES
// (docs/strategy/batch-15-addendum-4-views-survive.md)
//
// The nav was removed and that was overruled: all three pass-3 screens carry
// the SAME grid, and the nav only ever decided WHAT THE CENTRE COLUMN HOLDS.
// So the view is one attribute on the root, the skin decides what it means,
// and the page with no attribute at all is the degraded state.

const VIEWS = ['board', 'needs-you', 'scope'];

// Innermost rule blocks, comments stripped. Nesting is only ever one level
// deep here (@media), and the outer at-rule is skipped: this returns the
// SELECTOR AND ITS DECLARATIONS, which is what every check below asks about.
// Comments are stripped on purpose -- unlike the requirement-3 grep above, a
// commented-out rule genuinely does not apply, and inert CSS hides nothing.
function cssRules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
    .filter((r) => r.selector.length > 0 && !r.selector.startsWith('@'));
}

// The SUBJECT of a selector is its last compound -- the element the
// declarations actually land on. This is the whole reason the check is not a
// grep for "#activity" near "display: none": `#board[data-board-view="board"]
// .listview` names a region and hides a DESCENDANT of it, which is legitimate
// and is one of the three rules on disk before this rework.
function subjectOf(selector: string): string {
  const parts = selector.split(/[\s>+~]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Does this rule take something off the screen?
function hides(body: string): boolean {
  return /(?:^|[;{\s])(?:display:\s*none|visibility:\s*hidden)\s*(?:;|$)/.test(body);
}

// Is this selector's subject one of the six regions ITSELF, rather than
// something inside one?
function subjectIsRegion(selector: string): string | null {
  const subject = subjectOf(selector);
  for (const id of REGIONS) {
    if (subject === `#${id}` || subject.startsWith(`#${id}[`) ||
        subject.startsWith(`#${id}:`) || subject.startsWith(`#${id}.`)) return id;
  }
  return null;
}

test('with no data-view on the root, the skin hides no region: the degraded page is whole', () => {
  // REQUIREMENT 4, AS A TEST RATHER THAN A GREP. The natural way to write view
  // CSS is a default that hides plus an override that shows, and that silently
  // destroys the anchor-page state this ruling keeps. So: every rule that
  // hides a REGION ITSELF must be keyed on a view, with no hiding fallback.
  //
  // BASELINE BEFORE THE REWORK: exactly three `display: none` rules, none of
  // them hiding a region.
  const offenders: string[] = [];
  for (const rule of cssRules(SKIN)) {
    if (!hides(rule.body)) continue;
    for (const one of rule.selector.split(',')) {
      const selector = one.trim();
      if (!subjectIsRegion(selector)) continue;
      if (!selector.startsWith('html[data-view=')) offenders.push(selector);
    }
  }
  assert.deepEqual(offenders, [],
    'these rules hide a product region without being keyed on a view, so the page ' +
    'with no data-view attribute is no longer whole: ' + offenders.join(' | '));
});

test('the skin gives every one of the three views a meaning', () => {
  // The other half of requirement 4. A skin that simply never mentions
  // data-view would pass the check above by doing nothing at all.
  for (const view of VIEWS) {
    assert.ok(SKIN.includes(`html[data-view="${view}"]`),
      `the skin never resolves html[data-view="${view}"], so that view does nothing`);
  }
});

test('fleet, needs-you and activity are never hidden, in any view', () => {
  // The invariant the ruling states outright: the three views were never three
  // pages. Whatever the centre column holds, these three are on screen.
  const always = ['fleet', 'needs-you', 'activity'];
  const found: string[] = [];
  for (const rule of cssRules(SKIN)) {
    if (!hides(rule.body)) continue;
    for (const one of rule.selector.split(',')) {
      const selector = one.trim();
      const id = subjectIsRegion(selector);
      if (!id || !always.includes(id)) continue;
      const view = /^html\[data-view="([a-z-]+)"\]/.exec(selector);
      found.push(`#${id} is hidden${view ? ` in view "${view[1]}"` : ' unconditionally'}`);
    }
  }
  assert.deepEqual(found, [],
    'the ruling says fleet, activity and needs-you are on screen in EVERY view: ' + found.join(' | '));
});

test('the script names the view and sets aria-current, and does nothing else about it', () => {
  // REQUIREMENT 1. Both are state. The script must not hide, show, move or
  // style anything itself -- it writes the attribute and the skin decides.
  assert.match(APP, /documentElement\.setAttribute\('data-view'/);
  const fn = APP.slice(APP.indexOf('function setView('), APP.indexOf('function setTheme('));
  assert.ok(fn.length > 0 && fn.length < 1400,
    'setView() was not found between setBoardView() and setTheme(), where it was expected');
  assert.match(fn, /aria-current/);
  for (const forbidden of ['hidden', '.style.', 'classList', 'appendChild']) {
    assert.equal(fn.includes(forbidden), false,
      `setView() does ${forbidden} -- the view is state, and the skin decides what it means`);
  }
});

test('the three views are hash links, so keyboard, deep links and back/forward work for free', () => {
  // REQUIREMENT 2. A button only a click handler can reach would break every
  // one of those for nothing gained.
  assert.match(PAGE_HTML, /<nav class="nav" aria-label="Views">/);
  const nav = PAGE_HTML.slice(PAGE_HTML.indexOf('<nav class="nav"'), PAGE_HTML.indexOf('</nav>'));
  const hrefs = [...nav.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, VIEWS, 'the nav is not exactly the three views, as hash links');
  assert.ok(nav.includes('id="needsCount"'), 'the needs count left the Needs you entry');
  assert.match(APP, /addEventListener\('hashchange'/);
});

test('the view defaults to board, and an unknown hash does not blank the page', () => {
  // REQUIREMENT 1's default, and the case a deep link makes reachable: someone
  // arrives at #nonsense. A view nothing styles would leave the centre empty.
  const fn = APP.slice(APP.indexOf('function setView('), APP.indexOf('function setTheme('));
  assert.match(fn, /VIEWS\.indexOf\(|VIEWS\.includes\(/,
    'setView() does not check the name against the three views, so any hash becomes a view');
  assert.match(fn, /'board'/, 'setView() has no default view to fall back to');
});

test('per-column scrolling, and only where a view is named', () => {
  // REQUIREMENT 5. The columns scroll; the page does not. But the degraded
  // anchor page still has to scroll top to bottom, so the viewport-height
  // bound is keyed on a view like everything else.
  const rules = cssRules(SKIN);
  const bounded = rules.filter((r) => /(?:^|[;{\s])height:\s*100vh/.test(r.body));
  assert.ok(bounded.length > 0, 'nothing is bound to the viewport height, so no column can scroll');
  assert.deepEqual(
    bounded.filter((r) => !r.selector.startsWith('html[data-view=')).map((r) => r.selector), [],
    'height: 100vh outside a view would trap the degraded anchor page in one screen');
  assert.ok(rules.some((r) => /overflow-y:\s*auto/.test(r.body) &&
    REGIONS.some((id) => r.selector.includes(`#${id}`))),
    'no region scrolls on its own, so the columns are still coupled');
});

test('every region the skin makes a scroll container can take keyboard focus', () => {
  // DEFECT 3A, found by a real tab-walk. Ruling 15 requirement 5 turned the
  // columns into their own scroll containers, which removed the page-level
  // scroll that used to reach everything. A container that scrolls but can hold
  // no focus cannot be scrolled from the keyboard -- unless the browser rescues
  // it. #activity measured 437px of content in a 355px column with zero
  // focusables; real keypresses in Chrome 153 showed Chromium's own heuristic
  // makes such a container focusable, so it was reachable THERE. It is not a
  // property of the page, WebKit lacks it, and it skips scrollers that contain
  // controls (#scope, measured). See index.html's header, point 4.
  //
  // THE RULE IS KEYED ON "THE SKIN MAKES IT SCROLL", NOT ON "IT OVERFLOWS
  // TODAY". Overflow depends on how much the daemon sends; #fleet was only safe
  // because it happened to be short. And a region with controls inside is not
  // automatically safe either -- content after its last control is still out
  // of reach. So the set of regions is derived from the stylesheet, and a
  // future skin that scrolls a region inherits the requirement for free.
  const scrollers = new Set<string>();
  for (const rule of cssRules(SKIN)) {
    if (!/overflow(?:-y)?:\s*(?:auto|scroll)/.test(rule.body)) continue;
    for (const one of rule.selector.split(',')) {
      const id = subjectIsRegion(one.trim());
      if (id) scrollers.add(id);
    }
  }
  assert.ok(scrollers.size >= 1,
    'the skin makes no region a scroll container -- this test stopped seeing them, or requirement 5 was undone');

  const unreachable: string[] = [];
  for (const id of scrollers) {
    const tag = new RegExp(`<section id="${id}"[^>]*>`).exec(PAGE_HTML);
    if (!tag || !/\btabindex="0"/.test(tag[0])) unreachable.push(`#${id}`);
  }
  assert.deepEqual(unreachable, [],
    'these regions scroll but cannot take focus, so a keyboard user cannot read past what fits: ' +
    unreachable.join(', '));
});

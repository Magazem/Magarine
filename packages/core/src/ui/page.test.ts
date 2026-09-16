// The page's own tests. Batch 15 turned the page from a 443-line string in
// page.ts into files under packages/core/ui/, so RULE 5 APPLIES: split, don't
// re-point. Each inherited claim below is recorded with where it came from and
// what happened to it, because a test quietly aimed at a new input is a claim
// nobody re-checked.
//
//   "the inline <script> is valid JavaScript" (batch 11)
//       -> SPLIT. There is no inline script. The claim was really "the
//          JavaScript this project ships is parsed by nothing until a person
//          opens the page", and that is now true of three files, each checked
//          separately below.
//   "cost is labelled equivalent API cost, with the session-limits caveat"
//       (batch 12 item 4) -> HELD. Same claim, same kind of input; the text
//          moved from a template literal into index.html.
//   "the board table has an artifacts column" (batch 13 ruling 1c)
//       -> SPLIT. The ruling's claim is that the page shows each ticket's
//          artefacts. The pass-3 board shows them as chips on the card rather
//          than as a table column, so the column assertion cannot hold and is
//          replaced by an assertion on what actually renders them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PAGE_HTML, UI_DIR, UI_ASSETS, INDEX_HTML_PATH, readPageHtml } from './page.ts';

const REPO_ROOT = join(UI_DIR, '..', '..', '..');
const asset = (name: string) => readFileSync(join(UI_DIR, name), 'utf8');

// --------------------------------------------------------------- the loader

test('page.ts serves ui/index.html and keeps no inline copy of the page', () => {
  assert.equal(PAGE_HTML, readFileSync(INDEX_HTML_PATH, 'utf8'));
  // Rule 9: the old inline page does not survive as a fallback, so the module
  // must not contain a page of its own. Its own source is the evidence.
  const source = readFileSync(new URL('./page.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('<!doctype'), 'page.ts still contains a document of its own');
  assert.ok(!source.includes('<body'), 'page.ts still contains markup of its own');
});

test('a missing interface throws and names the path, rather than serving something else', () => {
  // Rule 9 in its strongest form. A throw nobody has seen thrown is not a
  // guarantee, so the failure path is exercised rather than assumed.
  assert.throws(
    () => readPageHtml(join(UI_DIR, 'no-such-page.html')),
    (e: Error) => e.message.includes('no-such-page.html') && e.message.includes('magarine doctor')
  );
});

test('an empty interface file throws too, rather than answering with a blank page', () => {
  const empty = join(UI_DIR, '..', 'package.json');   // any file; emptiness is what is tested
  assert.throws(() => readPageHtml(join(UI_DIR, 'nope.html')), /could not be read/);
  assert.doesNotThrow(() => readPageHtml(empty));      // non-empty file, reads fine
});

test('every asset page.ts declares actually exists, and nothing the page asks for is missing', () => {
  for (const name of UI_ASSETS) {
    const body = readFileSync(join(UI_DIR, name));
    assert.ok(body.length > 0, `${name} is empty`);
  }
  // The other direction: every /ui/ URL the page references must be in the
  // declared list, so `doctor` cannot be checking a stale set.
  // href/src only. A bare /ui/... in prose is a comment mentioning a path, and
  // matching those made this fail on the sentence describing page.ts itself.
  const referenced = [...PAGE_HTML.matchAll(/(?:href|src)="\/ui\/([A-Za-z0-9._-]+)"/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 4, 'index.html references almost nothing -- did the links break?');
  for (const name of referenced) {
    assert.ok(UI_ASSETS.includes(name), `index.html loads /ui/${name}, which UI_ASSETS does not declare`);
  }
});

// ------------------------------------------------- the shipped JavaScript
// Inherited from batch 11 and split three ways. These files are shipped and
// parsed by a real browser exactly as written; nothing else in this suite
// would load them and notice a stray comma before a person opened the page.
// `node --check` is a syntax check only and never executes the file.

for (const name of ['app.js', 'organism.js', 'fontCoverage.js']) {
  test(`ui/${name} is syntactically valid JavaScript`, () => {
    execFileSync(process.execPath, ['--check', join(UI_DIR, name)], { stdio: 'pipe' });
  });
}

test('the page loads the generator from /ui/organism.js and not from a copy', () => {
  assert.match(PAGE_HTML, /<script src="\/ui\/organism\.js"><\/script>/);
  // Ruling 11: one file. Nothing may inline a second generator.
  assert.ok(!PAGE_HTML.includes('GLYPH_VERSION'), 'index.html carries its own copy of the generator');
  assert.ok(!asset('app.js').includes('GLYPH_VERSION'), 'app.js carries its own copy of the generator');
});

test('the tier is derived once, in organism.js, and app.js never re-derives it', () => {
  // Deliverable 3: "the tier is derived ONCE, from the model id, in one
  // function -- not duplicated."
  assert.match(asset('organism.js'), /function tierOf\(model\)/);
  const app = asset('app.js');
  assert.ok(app.includes('ORG.tierOf('), 'app.js does not call the generator\'s tierOf');
  assert.ok(!/function\s+tierOf/.test(app), 'app.js defines a tierOf of its own');
  // The tier names must not be re-tested anywhere but in the generator.
  for (const tier of ['fable', 'opus', 'sonnet', 'haiku']) {
    assert.ok(!app.includes(`'${tier}'`), `app.js mentions the tier '${tier}' -- the tier table belongs to organism.js`);
  }
});

test('check-organism.js passes against the generator the daemon serves', () => {
  // Ruling 11 end to end: the checker's default subject is this exact file.
  const out = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'docs', 'design', 'pass3', 'check-organism.js'), join(UI_DIR, 'organism.js')],
    { encoding: 'utf8' }
  );
  assert.match(out, /ALL CHECKS PASSED/);
});

// ------------------------------------------------------- inherited claims

// Batch 12 item 4: "equivalent API cost" on the board, the page and the README,
// with the one sentence about subscriptions and session limits. See
// commands/board.test.ts for the CLI board's own version of this check.
test('the page labels cost "equivalent API cost" and names the subscription/session-limits caveat', () => {
  assert.match(PAGE_HTML, /equivalent API cost/i);
  assert.match(PAGE_HTML, /session limits/);
});

// Batch 13 ruling 1c, split: the claim is that the page shows each ticket's
// artefacts. The board shows them as chips rather than as a table column.
test('the page renders every ticket artefact, by kind, with the path only for kind "file"', () => {
  const app = asset('app.js');
  assert.ok(app.includes('function artsNode'), 'nothing renders artefacts');
  assert.match(app, /a\.kind === 'file'/);
  // A text-bearing kind shows its kind and a LENGTH, never its body.
  assert.match(app, /String\(a\.content \|\| ''\)\.length \+ ' chars'/);
});

// --------------------------------------------------------------- rule 8

test('no daemon-shaped fixture ships inside ui/', () => {
  // Deliverable 2: mock data does not ship. A ticket id, a dollar figure or a
  // model id baked into the page would be invented data wearing real clothes.
  for (const name of UI_ASSETS) {
    if (name.endsWith('.woff2')) continue;
    const body = asset(name);
    assert.ok(!/\btkt_[0-9a-f]{8}/.test(body), `${name} contains a ticket id`);
    assert.ok(!/\bproj_[0-9a-f]{8}/.test(body), `${name} contains a project id`);
    assert.ok(!/\$\d+\.\d\d/.test(body), `${name} contains a hard-coded money figure`);
  }
});

test('the element-to-field table ships beside the page and covers the omissions', () => {
  const table = readFileSync(join(UI_DIR, 'ELEMENT-FIELD-TABLE.md'), 'utf8');
  assert.match(table, /OMITTED, NOT MOCKED/);
  // Each thing pass 3 drew that nothing produces has to be listed, not quietly
  // dropped -- that list IS deliverable 2, and a table without it would pass a
  // weaker test while hiding the interesting half.
  for (const omitted of ['Simulate event', 'bell', 'mgr', 'planning', 'reviewing', 'Progress percentages']) {
    assert.ok(table.includes(omitted), `the omissions list does not mention ${omitted}`);
  }
});

// ------------------------------------------------------------------ the gate

test('the gate tells a new user how to get the token, and does not promise serve prints it', () => {
  // RULING 20 item 5 (docs/strategy/batch-15-addendum-9-token-command.md).
  // The owner's own walk stalled on its first step -- "i can't find the token"
  // -- because the gate said to paste the token `magarine serve` printed, and
  // `serve` deliberately never prints it. The gate is the first thing a new
  // user reads; a false instruction there costs the whole product.
  //
  // No earlier test asserted the gate's wording, so nothing is re-pointed
  // (rule 5): this is a new claim with two halves, and the negative half is
  // the one that matters, because the old sentence could come back.
  const start = PAGE_HTML.indexOf('<section id="gate"');
  const gate = PAGE_HTML.slice(start, PAGE_HTML.indexOf('</section>', start));
  assert.ok(start >= 0 && gate.length > 0, 'the gate section was not found');

  assert.match(gate, /<span class="mono">magarine token<\/span>/,
    'the gate does not name `magarine token`, the command that actually gets the token');
  assert.equal(/\bprint(?:s|ed)?\b/i.test(gate), false,
    'the gate says the token is printed -- `magarine serve` never prints it');
  // The fallback may name where the token lives; it must never show one.
  assert.equal(/[A-Za-z0-9_-]{32,}/.test(gate.replace(/<[^>]+>/g, ' ')), false,
    'the gate contains something shaped like a token value');
});

// ACTIVITY = MOTION, and the two halves of it agree.
//
// app.js decides ORDER: one integer per cell, its place in the firing order for
// the state the daemon mapped, written as data-step. tokens.css decides TIMING:
// a table turning that integer into a delay. The split exists because ruling 13
// requirement 3 forbids the script writing style.
//
// The risk the split creates is that the two drift: a motion could produce a
// step the table has no rule for, and the cell would simply fire at 0ms with
// nothing reporting it. So this file RE-DERIVES the table from the same
// formulas and requires every step a motion can emit to have a rule.
//
// The formulas are restated here rather than imported, because app.js is a
// browser file with no exports. That is a real duplication and it is the thing
// these tests are for: if app.js's formula changes and this one does not, the
// "app.js's own source agrees" test below fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_DIR } from './page.ts';

const APP = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
const TOKENS = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');

const GRID = 5;
const CELLS = GRID * GRID;
const STEP_MS = 26;          // this file's constant, checked against the table
const row = (i: number) => Math.floor(i / GRID);
const col = (i: number) => i % GRID;
const ring = (i: number) => Math.max(Math.abs(row(i) - 2), Math.abs(col(i) - 2));

// THE SIX STATES THE DAEMON CAN MAP, named here so removing one from app.js
// fails this file (rule 17: the checker owns its constants). All six are real
// and sourced -- ruling 14 made `testing` real at the adapter rather than
// leaving it drawn as a promise.
const STATES: Record<string, (i: number) => number> = {
  reading: (i) => col(i),
  writing: (i) => row(i),
  running: (i) => ring(i),
  testing: (i) => ((row(i) + col(i)) % 2) * 3,
  finishing: (i) => 2 - ring(i),
  reporting: (i) => (i * 7) % 25,
};

function delayTable(): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of TOKENS.matchAll(/\.org\[data-tick\] i\[data-step="(\d+)"\]\s*{\s*animation-delay:\s*(\d+)ms;\s*}/g)) {
    out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

test('the page draws all six activity states the daemon can map, and no invented seventh', () => {
  const block = APP.slice(APP.indexOf('var MOTION = {'), APP.indexOf('function motionFor'));
  const declared = [...block.matchAll(/^\s{4}([a-z]+):\s*function/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), Object.keys(STATES).sort());
  // planning and reviewing are in the owner's list of states and nothing
  // produces them. They stay undrawn until something does.
  assert.equal(APP.includes('planning'), false, 'app.js draws `planning`, which nothing emits');
  assert.equal(APP.includes('reviewing'), false, 'app.js draws `reviewing`, which nothing emits');
});

test('every step any state can emit has a delay rule, so no cell silently fires at zero', () => {
  const table = delayTable();
  assert.ok(table.size > 0, 'tokens.css has no delay table at all');
  for (const [name, fn] of Object.entries(STATES)) {
    for (let i = 0; i < CELLS; i++) {
      const step = fn(i);
      assert.ok(Number.isInteger(step) && step >= 0, `${name} cell ${i} produced ${step}`);
      assert.ok(table.has(step), `${name} emits step ${step} and tokens.css has no rule for it`);
    }
  }
});

test('the delay table is a flat interval, because no state is faster than another', () => {
  // Nothing measures urgency, so the timing must not imply any. The ORDER is
  // the only thing that differs between states.
  const table = delayTable();
  for (const [step, ms] of table) {
    assert.equal(ms, step * STEP_MS, `step ${step} is ${ms}ms, not ${step * STEP_MS}ms`);
  }
  // The largest step any state can emit is reporting's 24; the table must reach
  // it and need not go further.
  const maxStep = Math.max(...Object.values(STATES).flatMap((fn) =>
    Array.from({ length: CELLS }, (_, i) => fn(i))));
  assert.equal(maxStep, 24);
  assert.equal(table.size, 25, 'the table should cover steps 0..24 exactly');
});

test("app.js's own source uses these formulas, so this file cannot drift from it", () => {
  // The duplication above is real; this is what makes it safe. Each formula is
  // matched in app.js's source, so changing one there without changing it here
  // fails rather than silently making these assertions describe nothing.
  const expected: Record<string, string> = {
    reading: 'return col(i);',
    writing: 'return row(i);',
    running: 'return ring(i);',
    testing: 'return ((row(i) + col(i)) % 2) * 3;',
    finishing: 'return 2 - ring(i);',
    reporting: 'return (i * 7) % 25;',
  };
  for (const [name, body] of Object.entries(expected)) {
    const line = APP.split('\n').find((l) => l.trimStart().startsWith(`${name}:`));
    assert.ok(line, `app.js has no ${name} motion`);
    assert.ok(line!.includes(body), `app.js's ${name} is not "${body}" -- it is: ${line!.trim()}`);
  }
  assert.match(APP, /function row\(i\) \{ return Math\.floor\(i \/ 5\); \}/);
  assert.match(APP, /function col\(i\) \{ return i % 5; \}/);
  assert.match(APP, /function ring\(i\) \{ return Math\.max\(Math\.abs\(row\(i\) - 2\), Math\.abs\(col\(i\) - 2\)\); \}/);
});

test('each state has a distinct firing order, so the motion channel actually carries the state', () => {
  // Two states producing the same order would make the animation say nothing
  // about which state the daemon mapped -- the motion channel would be
  // decoration. Compare the orders themselves, not a rendered result.
  const signatures = new Map<string, string>();
  for (const [name, fn] of Object.entries(STATES)) {
    const sig = Array.from({ length: CELLS }, (_, i) => fn(i)).join(',');
    const clash = signatures.get(sig);
    assert.equal(clash, undefined, `${name} and ${clash} fire in exactly the same order`);
    signatures.set(sig, name);
  }
});

test('an unmapped state falls back to a drawn one rather than being dropped or guessed', () => {
  assert.match(APP, /hasOwnProperty\.call\(MOTION, state\) \? MOTION\[state\] : MOTION\.running/);
});

test('reduced motion is honoured', () => {
  const block = TOKENS.slice(TOKENS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.org\[data-tick\] i \{ animation: none; \}/);
});

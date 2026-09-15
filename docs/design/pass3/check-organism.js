#!/usr/bin/env node
// ===========================================================================
// Magarine — automated checker for the agent organism generator.
//
//   node docs/design/pass3/check-organism.js [organism.js]
//   node docs/design/pass3/check-organism.js --self-test
//
// IT READS THE ONE GENERATOR FILE THE PRODUCT SERVES -- by default
// packages/core/ui/organism.js -- not a copy of it. Batch 15 ruling 11: pass 3
// inlined the generator in each screen and this checker extracted it from a
// page; the product has exactly one copy, the page includes it with
// <script src="/ui/organism.js">, and the daemon serves that route from this
// same file byte-identical. An earlier reference copy drifted from the page it
// claimed to describe, so proofs run against it did not mean what they said.
// There is still no second implementation to keep in sync: if this passes, the
// thing that actually renders passes.
//
// TWO RULES THIS FILE HAS TO OBEY, both learned the hard way on this batch:
//
//   A check must be able to FAIL. Two of these checks once could not. One
//   compared rendered bitmaps and called that "the tiers are distinct" -- but
//   identity is (family, symmetry), and two tiers could be given identical
//   traits while their bitmaps still differed, because the seed strings
//   differ. The other read the acceptable lit-count band FROM THE GENERATOR,
//   so a generator declaring 0..25 acceptable passed the check whose whole job
//   was rejecting blank and solid organisms. Both are the same shape as a
//   version string that is present but inert.
//
//   A checker must not take the subject's word for the standard. Where a
//   property has an absolute floor, THIS FILE owns the constant, and the
//   generator's own declaration is checked against it rather than trusted.
//
// --self-test mutates the generator file in six ways and asserts this checker
// rejects every one. Run it after touching either file.
//
// Exit code 0 on success, 1 on any failure.
// ===========================================================================
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');

var SEEDS_PER_TIER = 2000;

// --- constants THIS FILE owns ----------------------------------------------
// A blank or near-solid avatar is unacceptable whatever the generator says is
// acceptable. These are the outer bounds; the generator's own band must sit
// inside them, and every organism must sit inside them.
var HARD_MIN_LIT = 6;
var HARD_MAX_LIT = 19;

var FAMILY_NAMES = ['core', 'ring', 'lattice'];
var SYMMETRY_NAMES = ['mirror-x', 'mirror-y', 'quad'];

// Ruling 11: the generator is a FILE, and this evaluates that file's own
// source. organism.js assigns its API onto `globalThis`; shadowing globalThis
// with a bare object here means the evaluation cannot touch this process's real
// global, and the API comes back from the same bytes the daemon serves.
function loadGenerator(file) {
  var CR = String.fromCharCode(13);
  var src = fs.readFileSync(file, 'utf8').split(CR).join('');
  if (src.indexOf('var GLYPH_VERSION') < 0) throw new Error('generator not found in ' + file);
  var NL = String.fromCharCode(10);
  var api = new Function(
    'var globalThis = Object.create(null);' + NL + src + NL + 'return globalThis.MagarineOrganism;'
  )();
  if (!api || typeof api.organism !== 'function') {
    throw new Error(file + ' did not define globalThis.MagarineOrganism.organism');
  }
  return { api: api, src: src };
}

function symmetric(cells, sym, GRID) {
  for (var r = 0; r < GRID; r++) {
    for (var c = 0; c < GRID; c++) {
      var v = cells[r * GRID + c];
      if ((sym === 0 || sym === 2) && cells[r * GRID + (GRID - 1 - c)] !== v) return false;
      if ((sym === 1 || sym === 2) && cells[(GRID - 1 - r) * GRID + c] !== v) return false;
      if (sym === 2 && cells[(GRID - 1 - r) * GRID + (GRID - 1 - c)] !== v) return false;
    }
  }
  return true;
}

function run(pagePath, quiet) {
  var got = loadGenerator(pagePath);
  var G = got.api;
  var GRID = G.GRID;
  var failures = [];

  function log(s) { if (!quiet) console.log(s); }
  function report(name, ok, detail) {
    log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
    if (!ok) failures.push(name);
  }

  log('generator read from ' + path.basename(pagePath) + ' (' + got.src.length + ' chars)');
  log('');
  log('1. symmetry and lit-count, ' + SEEDS_PER_TIER + ' seeds per tier');

  var tiers = Object.keys(G.TIER_TRAITS);
  tiers.forEach(function (tier) {
    var sym = G.TIER_TRAITS[tier].symmetry;
    var bad = 0, outside = 0, coreDark = 0, lits = [];
    for (var i = 0; i < SEEDS_PER_TIER; i++) {
      var cells = G.organism(tier + '#seed' + i);
      if (!symmetric(cells, sym, GRID)) bad++;
      var lit = 0;
      for (var k = 0; k < cells.length; k++) lit += cells[k];
      lits.push(lit);
      // against the constant THIS FILE owns, never against G.MIN_LIT/G.MAX_LIT
      if (lit < HARD_MIN_LIT || lit > HARD_MAX_LIT) outside++;
      if (cells[12] !== 1) coreDark++;
    }
    lits.sort(function (a, b) { return a - b; });
    report('symmetry ' + tier, bad === 0,
           bad + '/' + SEEDS_PER_TIER + ' broken, lit ' + lits[0] + '..' + lits[lits.length - 1] +
           ' median ' + lits[Math.floor(lits.length / 2)]);
    report('no degenerate ' + tier, outside === 0,
           outside + ' outside the hard band ' + HARD_MIN_LIT + '..' + HARD_MAX_LIT);
    report('core lit ' + tier, coreDark === 0, coreDark + ' with a dark core');
  });

  log('');
  log('2. the generator does not get to move its own goalposts');
  report('declared band sits inside ' + HARD_MIN_LIT + '..' + HARD_MAX_LIT,
         G.MIN_LIT >= HARD_MIN_LIT && G.MAX_LIT <= HARD_MAX_LIT,
         'generator declares ' + G.MIN_LIT + '..' + G.MAX_LIT);

  log('');
  log('3. identity is distinct WHERE IDENTITY LIVES');
  // Batch 14: identity is (family, symmetry). Comparing rendered bitmaps does
  // NOT test this -- two tiers with identical traits still render differently
  // because their seed strings differ. Compare the traits themselves.
  var seen = {}, collisions = [];
  tiers.forEach(function (tier) {
    var t = G.TIER_TRAITS[tier];
    var key = t.family + '/' + t.symmetry;
    if (seen[key]) collisions.push(seen[key] + ' and ' + tier + ' share ' +
        FAMILY_NAMES[t.family] + '+' + SYMMETRY_NAMES[t.symmetry]);
    else seen[key] = tier;
  });
  report('every tier has a unique (family, symmetry)', collisions.length === 0,
         collisions.length ? collisions.join('; ')
                           : tiers.map(function (t) {
                               var x = G.TIER_TRAITS[t];
                               return t + '=' + FAMILY_NAMES[x.family] + '+' + SYMMETRY_NAMES[x.symmetry];
                             }).join(', '));
  report('the space is not exhausted', tiers.length <= FAMILY_NAMES.length * SYMMETRY_NAMES.length,
         tiers.length + ' tiers in ' + (FAMILY_NAMES.length * SYMMETRY_NAMES.length) + ' combinations');

  log('');
  log('4. determinism');
  var probes = ['claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5',
                'claude-fable-5-1', 'some-unknown-model', 'toString', 'constructor'];
  var first = probes.map(function (s) { return G.organism(s).join(''); });
  var stable = true;
  for (var pass = 0; pass < 50; pass++) {
    var again = probes.map(function (s) { return G.organism(s).join(''); });
    for (var i = 0; i < first.length; i++) if (first[i] !== again[i]) stable = false;
  }
  report('identical across 50 passes', stable, probes.length + ' seeds');

  log('');
  log('5. generator version');
  report('mg.v1:X round-trips to X',
         probes.every(function (s) { return G.organism(s).join('') === G.organism('mg.v1:' + s).join(''); }),
         'a stored seed keeps its look');
  report('mg.v2:X differs from X',
         probes.every(function (s) { return G.organism('mg.v2:' + s).join('') !== G.organism(s).join(''); }),
         'a bump restyles only new seeds');

  log('');
  log('6. integer arithmetic only');
  var body = got.src.replace(/\/\/[^\n]*/g, '');
  report('no Math.random', body.indexOf('Math.random') < 0);
  report('no Date', body.indexOf('Date') < 0);

  log('');
  log('7. put() is the only writer');
  // Static, on the source. Symmetry held by accident before because a clamp
  // wrote single cells directly; asserting the WRITE SITES means that class of
  // bug fails here rather than needing someone to notice it in 2000 renders.
  var writes = body.match(/cells\[.*?\]\s*=\s*[^=]/g) || [];
  var sites = writes.map(function (w) { return w.trim(); });
  report('exactly two write sites', sites.length === 2, sites.length + ' found: ' + sites.join(' | '));
  report('they are the init loop and put()',
         sites.length === 2 && sites[0].indexOf('cells[i] =') === 0 && sites[1].indexOf('cells[o[k]] =') === 0);
  report('the clamp goes through put()', body.indexOf('put(rc[0], rc[1], want)') >= 0);

  log('');
  if (failures.length) {
    log('FAILED: ' + failures.length + ' check(s) -> ' + failures.join(', '));
    return 1;
  }
  log('ALL CHECKS PASSED');
  return 0;
}

// ---------------------------------------------------------------------------
// --self-test: prove every check group can actually fail.
// ---------------------------------------------------------------------------
var MUTATIONS = [
  // Anchors are deliberately indentation-independent: the generator is
  // indented differently in the page than in any standalone copy, and a
  // mutation that silently fails to apply is a self-test that lies.
  { name: 'put() stops mirroring',
    from: 'var o = [r * GRID + c];',
    to:   'var o = [r * GRID + c]; return o;',
    expect: 'symmetry' },
  { name: 'two tiers given identical traits',
    from: 'sonnet:  { density: 7,  family: 2, symmetry: 0 }',
    to:   'sonnet:  { density: 9,  family: 0, symmetry: 2 }',
    expect: 'unique (family, symmetry)' },
  { name: 'generator widens its own band to 0..25',
    from: 'var MIN_LIT = 7;\n  var MAX_LIT = 17;',
    to:   'var MIN_LIT = 0;\n  var MAX_LIT = 25;',
    expect: 'degenerate / declared band' },
  { name: 'splitSeed disabled',
    from: 'if (digits) return { version: n, bare: seed.slice(colon + 1) };',
    to:   'if (false) return { version: n, bare: seed.slice(colon + 1) };',
    expect: 'version round-trip' },
  { name: 'Math.random injected',
    from: 'if (s === 0) s = 0x9E3779B9;',
    to:   'if (s === 0) s = Math.random();',
    expect: 'integer only' },
  { name: 'clamp writes a raw cell again',
    from: '    put(rc[0], rc[1], want);',
    to:   '    cells[rc[0] * GRID + rc[1]] = want;',
    expect: 'write sites' }
];

function selfTest(pagePath) {
  var CR = String.fromCharCode(13);
  var original = fs.readFileSync(pagePath, 'utf8').split(CR).join('');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-mutate-'));
  var bad = 0;

  console.log('SELF-TEST: every check group must be able to fail.');
  console.log('  subject: ' + pagePath);
  console.log('');
  console.log('  baseline (unmutated generator) must PASS');
  var base = child.spawnSync(process.execPath, [__filename, pagePath], { encoding: 'utf8' });
  console.log('    ' + (base.status === 0 ? 'PASS' : 'FAIL') + '  exit ' + base.status);
  if (base.status !== 0) bad++;
  console.log('');

  MUTATIONS.forEach(function (m, i) {
    var mutated = original.split(m.from).join(m.to);
    if (mutated === original) {
      console.log('    FAIL  mutation ' + (i + 1) + ' did not apply: ' + m.name);
      bad++;
      return;
    }
    var f = path.join(tmp, 'mutant' + i + '.js');
    fs.writeFileSync(f, mutated);
    var res = child.spawnSync(process.execPath, [__filename, f], { encoding: 'utf8' });
    var caught = res.status === 1;
    console.log('    ' + (caught ? 'PASS' : 'FAIL') + '  ' + m.name +
                '  -> expected ' + m.expect + ', exit ' + res.status);
    if (!caught) {
      bad++;
      console.log('          THE CHECKER DID NOT CATCH THIS. Output:');
      console.log((res.stdout || '').split('\n').slice(-6).map(function (l) { return '          ' + l; }).join('\n'));
    }
  });

  console.log('');
  if (bad) { console.log('SELF-TEST FAILED: ' + bad + ' case(s).'); return 1; }
  console.log('SELF-TEST PASSED: all ' + MUTATIONS.length + ' mutations rejected, baseline accepted.');
  return 0;
}

var args = process.argv.slice(2);
var selfTestMode = args.indexOf('--self-test') >= 0;
var pageArg = args.filter(function (a) { return a.indexOf('--') !== 0; })[0];
// Ruling 11's default subject: the one file the daemon serves as
// GET /ui/organism.js and the page loads with <script src>.
var PAGE = pageArg ? path.resolve(pageArg)
                   : path.join(__dirname, '..', '..', '..', 'packages', 'core', 'ui', 'organism.js');

process.exit(selfTestMode ? selfTest(PAGE) : run(PAGE, false));

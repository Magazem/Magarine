// ===========================================================================
// Magarine — the agent organism generator. THE SINGLE COPY.
//
// Batch 15 ruling 11 (docs/strategy/batch-15-spec.md): pass 3 inlined this in
// every screen and docs/design/pass3/check-organism.js extracted it from a
// page. In the product it lives here, in exactly one file: the page includes
// it with <script src="/ui/organism.js">, the daemon serves that route from
// this file byte-identical, and check-organism.js reads THIS FILE. There is no
// second implementation to drift.
//
// Identity authority: docs/strategy/batch-14-addendum-3-ruling-9-amended.md.
//   batch 14  tier = family + symmetry. status = colour. the tier string's
//             hash gives the cell draw, so one tier is one organism.
//   batch 15  purpose = family, policy = symmetry, name-hash = the cell draw.
// DENSITY IS A WEIGHT, NOT A SIGNAL. It stops a creature being blank or solid
// and nothing more; measured at scale the tiers overlap almost completely on
// it, so no comment, doc or table here may call it an identity channel.
//
// Colour is NEVER part of identity — it is the ticket status, applied by the
// caller. This file returns cells, never a colour.
//
// No build step: plain ES5, one global, loadable by a <script src> tag and by
// node (check-organism.js evaluates this source directly).
//
// Integer arithmetic only — FNV-1a and xorshift32 through Math.imul and >>> 0.
// No floats, no Math.random, no Date: the same seed renders identically on
// every machine, forever. check-organism.js proves all of that over 2000 seeds
// per tier, and --self-test proves those checks can fail.
// ===========================================================================
(function (root) {
  'use strict';
  var GLYPH_VERSION = 1;
  var GRID = 5;
  var MIN_LIT = 7;
  var MAX_LIT = 17;

  // family   0 core (solid middle)  1 ring (hollow middle)  2 lattice (checker)
  // symmetry 0 mirror-x  1 mirror-y  2 quad
  var TIER_TRAITS = {
    fable:   { density: 4,  family: 1, symmetry: 2 },
    opus:    { density: 9,  family: 0, symmetry: 2 },
    sonnet:  { density: 7,  family: 2, symmetry: 0 },
    haiku:   { density: 7,  family: 0, symmetry: 0 },
    unknown: { density: 8,  family: 2, symmetry: 1 }
  };

  function tierOf(model) {
    if (model.indexOf('fable') >= 0) return 'fable';
    if (model.indexOf('opus') >= 0) return 'opus';
    if (model.indexOf('sonnet') >= 0) return 'sonnet';
    if (model.indexOf('haiku') >= 0) return 'haiku';
    return 'unknown';
  }

  // A seed may arrive already carrying its version, e.g. "mg.v1:agent_abc".
  // Hash with that version rather than re-prefixing, so an existing profile
  // keeps its look when GLYPH_VERSION moves on. No regex, so there is nothing
  // to escape when this is pasted into page.ts.
  function splitSeed(seed) {
    if (seed.indexOf('mg.v') === 0) {
      var colon = seed.indexOf(':');
      if (colon > 4) {
        var n = seed.slice(4, colon);
        var digits = n.length > 0;
        for (var i = 0; i < n.length; i++) {
          var code = n.charCodeAt(i);
          if (code < 48 || code > 57) { digits = false; break; }
        }
        if (digits) return { version: n, bare: seed.slice(colon + 1) };
      }
    }
    return { version: String(GLYPH_VERSION), bare: seed };
  }

  function seedHash(seed) {
    var parts = splitSeed(seed);
    var s = 'mg.v' + parts.version + ':' + parts.bare;
    var h = 0x811C9DC5;
    for (var i = 0; i < s.length; i++) {
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function rngFrom(state) {
    var s = state >>> 0;
    if (s === 0) s = 0x9E3779B9;
    return function () {
      s ^= (s << 13) >>> 0; s = s >>> 0;
      s ^= s >>> 17;
      s ^= (s << 5) >>> 0;  s = s >>> 0;
      return s >>> 0;
    };
  }

  // Where body is likely, in sixteenths. "ring" is deliberately steep: a shallow
  // bias at a workable density produced a filled blob rather than a ring.
  function familyBias(family, r, c) {
    var dr = r - 2; if (dr < 0) dr = -dr;
    var dc = c - 2; if (dc < 0) dc = -dc;
    var d = dr > dc ? dr : dc;             // 0 centre, 1 middle band, 2 edge
    if (family === 0) return 5 - d * 4;    // core
    if (family === 1) return d * 6 - 7;    // ring
    return ((r + c) % 2 === 0) ? 4 : -4;   // lattice
  }

  // `model` is optional. A worker profile is seeded by its id, which names no
  // tier, so its model is passed beside the seed: the id's hash gives the cell
  // draw and the model gives family and symmetry (batch 16 addendum 1, ruling
  // 38 amended). Renaming a profile changes neither; moving it to a model in
  // another tier changes the tier. Without `model` nothing is different.
  function organism(seed, model) {
    var rnd = rngFrom(seedHash(seed));
    var bare = splitSeed(seed).bare;
    // hasOwnProperty, not a bare lookup: a seed named toString or constructor
    // would otherwise resolve to an Object.prototype member.
    var tier = model ? tierOf(model)
      : (Object.prototype.hasOwnProperty.call(TIER_TRAITS, bare) ? bare : tierOf(bare));
    var t = TIER_TRAITS[tier];

    var cells = new Array(GRID * GRID);
    for (var i = 0; i < cells.length; i++) cells[i] = -1;

    // The symmetry orbit of a cell: every position that must share its value.
    function orbitOf(r, c) {
      var o = [r * GRID + c];
      if (t.symmetry === 0 || t.symmetry === 2) o.push(r * GRID + (GRID - 1 - c));
      if (t.symmetry === 1 || t.symmetry === 2) o.push((GRID - 1 - r) * GRID + c);
      if (t.symmetry === 2) o.push((GRID - 1 - r) * GRID + (GRID - 1 - c));
      var uniq = [];
      for (var k = 0; k < o.length; k++) if (uniq.indexOf(o[k]) < 0) uniq.push(o[k]);
      return uniq;
    }

    // THE ONLY WRITER. Nothing else may assign into "cells".
    function put(r, c, v) {
      var o = orbitOf(r, c);
      for (var k = 0; k < o.length; k++) cells[o[k]] = v;
    }

    // One representative per orbit, in a deterministic order.
    var reps = [];
    for (var r = 0; r < GRID; r++) {
      for (var c = 0; c < GRID; c++) {
        if (cells[r * GRID + c] !== -1) continue;
        reps.push([r, c]);
        var w = t.density + familyBias(t.family, r, c);
        if (w < 1) w = 1;
        if (w > 15) w = 15;
        put(r, c, (rnd() % 16) < w ? 1 : 0);
      }
    }

    // An organism always has a core. (2,2) is its own orbit under every
    // symmetry, so this cannot unbalance anything.
    put(2, 2, 1);

    function litCount() {
      var n = 0;
      for (var k = 0; k < cells.length; k++) n += cells[k];
      return n;
    }

    // Bring the lit count into range BY FLIPPING WHOLE ORBITS, so symmetry
    // survives. Deterministic order, bounded by the number of orbits, and the
    // core is never darkened.
    var order = [];
    for (var q = 0; q < reps.length; q++) order.push(q);
    for (var a = order.length - 1; a > 0; a--) {
      var b = rnd() % (a + 1);
      var tmp = order[a]; order[a] = order[b]; order[b] = tmp;
    }
    var lit = litCount();
    for (var z = 0; z < order.length && (lit < MIN_LIT || lit > MAX_LIT); z++) {
      var rc = reps[order[z]];
      if (rc[0] === 2 && rc[1] === 2) continue;
      var want = lit < MIN_LIT ? 1 : 0;
      if (cells[rc[0] * GRID + rc[1]] === want) continue;
      put(rc[0], rc[1], want);
      lit = litCount();
    }
    return cells;
  }

  // The one public surface. tierOf is exported because THE TIER IS DERIVED
  // ONCE, HERE, from the model id — app.js must never re-derive it (batch 15
  // spec section 3 Role B, deliverable 3).
  root.MagarineOrganism = {
    GLYPH_VERSION: GLYPH_VERSION,
    GRID: GRID,
    MIN_LIT: MIN_LIT,
    MAX_LIT: MAX_LIT,
    TIER_TRAITS: TIER_TRAITS,
    tierOf: tierOf,
    splitSeed: splitSeed,
    organism: organism
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

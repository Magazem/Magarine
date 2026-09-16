// DELIVERABLE 6: the font subset ranges and the coverage notice, which are two
// halves of ONE mechanism and were built together.
//
// Declaring a `unicode-range` is WHAT CAUSES a browser to render every
// character outside it in a system font. That text renders fine -- it just
// quietly stops looking like the page the owner approved, which under rule 9 is
// the silent fallback that is not allowed. So the page announces it. For that
// announcement to be true, three things have to agree:
//
//   1. the `unicode-range` in ui/tokens.css   -- what the browser is told
//   2. the ranges in ui/fontCoverage.js       -- what the notice is based on
//   3. the cmap in the shipped .woff2 files   -- what the font actually has
//
// This file checks all three against each other, and parses the real woff2
// binaries to do it. THAT IS THE POINT: the pass-3 brief asserted that
// "specifying latin is sufficient" for the two characters the design needs, on
// general knowledge. Here it is measured.
//
// If (1) declares MORE than (3) covers, the browser is told the font has
// characters it does not, renders them from a system font, and the notice stays
// silent -- the exact failure the notice exists to prevent. Declaring LESS is
// safe: the browser falls back and the notice correctly says so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { UI_DIR } from './page.ts';

const TOKENS = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');
const FONTS = ['JetBrainsMono.woff2', 'IBMPlexSans.woff2'];

// ---------------------------------------------------------------------------
// The pure function under test, loaded the way the browser loads it: evaluate
// the shipped source with a bare object standing in for globalThis, so the
// test exercises the exact bytes the daemon serves rather than a copy.
// ---------------------------------------------------------------------------
type Verdict = { outside: boolean; codePoints: number[]; sample: string };
type Coverage = {
  SUBSETS: Array<{ name: string; ranges: Array<[number, number]> }>;
  NOT_DRAWN: number[];
  COVERAGE_NOTICE: string;
  covers: (cp: number) => boolean;
  textOutsideFontCoverage: (strings: unknown[]) => Verdict;
};

function loadCoverage(): Coverage {
  const src = readFileSync(join(UI_DIR, 'fontCoverage.js'), 'utf8');
  const nl = String.fromCharCode(10);
  return new Function(
    'var globalThis = Object.create(null);' + nl + src + nl + 'return globalThis.MagarineFontCoverage;'
  )() as Coverage;
}
const C = loadCoverage();

// ---------------------------------------------------------------------------
// woff2 -> cmap. Enough of the format to read which code points a font has:
// the table directory, then brotli, then the `cmap` table's format 4 or 12
// subtable. Written out rather than pulled in because this package has no
// dependencies and is not about to gain one for a test.
// ---------------------------------------------------------------------------
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function readBase128(buf: Buffer, at: { p: number }): number {
  let r = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[at.p++];
    r = (r << 7) | (b & 0x7f);
    if (!(b & 0x80)) return r >>> 0;
  }
  throw new Error('malformed base-128 value in the woff2 table directory');
}

function cmapOf(file: string): Buffer {
  const buf = readFileSync(file);
  assert.equal(buf.toString('latin1', 0, 4), 'wOF2', `${file} is not a woff2 file`);
  const numTables = buf.readUInt16BE(12);
  const at = { p: 48 };
  const dir: Array<{ tag: string; len: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at.p++];
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 0x3f) { tag = buf.toString('latin1', at.p, at.p + 4); at.p += 4; }
    else tag = KNOWN_TAGS[idx];
    const transformVersion = (flags >> 6) & 3;
    const origLength = readBase128(buf, at);
    const transformed = (tag === 'glyf' || tag === 'loca') ? transformVersion === 0 : transformVersion !== 0;
    const transformLength = transformed ? readBase128(buf, at) : null;
    dir.push({ tag, len: transformLength ?? origLength });
  }
  const data = brotliDecompressSync(buf.subarray(at.p));
  let off = 0;
  for (const t of dir) {
    if (t.tag === 'cmap') return data.subarray(off, off + t.len);
    off += t.len;
  }
  throw new Error(`${file} has no cmap table`);
}

function codePointsOf(file: string): Set<number> {
  const cmap = cmapOf(file);
  const n = cmap.readUInt16BE(2);
  const subs: Array<{ offset: number; format: number }> = [];
  for (let i = 0; i < n; i++) {
    const offset = cmap.readUInt32BE(8 + i * 8);
    subs.push({ offset, format: cmap.readUInt16BE(offset) });
  }
  const chosen = subs.find((s) => s.format === 12) ?? subs.find((s) => s.format === 4);
  assert.ok(chosen, `${file}: no format 4 or 12 cmap subtable`);
  const out = new Set<number>();

  if (chosen!.format === 12) {
    const groups = cmap.readUInt32BE(chosen!.offset + 12);
    for (let i = 0; i < groups; i++) {
      const p = chosen!.offset + 16 + i * 12;
      for (let c = cmap.readUInt32BE(p); c <= cmap.readUInt32BE(p + 4); c++) out.add(c);
    }
    return out;
  }

  const segX2 = cmap.readUInt16BE(chosen!.offset + 6);
  const segs = segX2 / 2;
  const endO = chosen!.offset + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  for (let i = 0; i < segs; i++) {
    const end = cmap.readUInt16BE(endO + i * 2);
    const start = cmap.readUInt16BE(startO + i * 2);
    const delta = cmap.readInt16BE(deltaO + i * 2);
    const ro = cmap.readUInt16BE(rangeO + i * 2);
    if (start === 0xffff) continue;
    for (let c = start; c <= end; c++) {
      let g: number;
      if (ro === 0) g = (c + delta) & 0xffff;
      else {
        const gi = rangeO + i * 2 + ro + (c - start) * 2;
        if (gi + 1 >= cmap.length) continue;
        g = cmap.readUInt16BE(gi);
        if (g !== 0) g = (g + delta) & 0xffff;
      }
      if (g !== 0) out.add(c);
    }
  }
  return out;
}

/** Parse every `unicode-range` declaration out of tokens.css, per @font-face. */
function declaredRanges(): Array<{ family: string; ranges: Array<[number, number]> }> {
  const out: Array<{ family: string; ranges: Array<[number, number]> }> = [];
  for (const block of TOKENS.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const body = block[1];
    const family = /font-family:\s*"([^"]+)"/.exec(body)?.[1] ?? '(unnamed)';
    const decl = /unicode-range:\s*([^;]+);/.exec(body);
    assert.ok(decl, `the @font-face for ${family} declares no unicode-range`);
    const ranges: Array<[number, number]> = [];
    for (const r of decl![1].split(',')) {
      const m = /U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/.exec(r.trim());
      assert.ok(m, `unparseable unicode-range fragment for ${family}: ${r}`);
      const lo = parseInt(m![1], 16);
      ranges.push([lo, m![2] ? parseInt(m![2], 16) : lo]);
    }
    out.push({ family, ranges });
  }
  return out;
}

const norm = (rs: Array<[number, number]>) =>
  rs.map(([a, b]) => `${a}-${b}`).sort().join(',');

// --------------------------------------------------------------- the checks

test('every @font-face declares its own unicode-range -- one block per subset', () => {
  const faces = declaredRanges();
  assert.equal(faces.length, 2, `expected one block per family per subset, found ${faces.length}`);
  for (const f of faces) assert.ok(f.ranges.length > 0, `${f.family} declares an empty range`);
});

test('the stylesheet and the coverage function declare the SAME ranges', () => {
  // The notice cannot disagree with the font. If these two ever drift, the page
  // announces a fallback that is not happening, or stays silent through one
  // that is -- and the second is the dangerous direction.
  const fromCss = declaredRanges();
  const fromJs = C.SUBSETS.flatMap((s) => s.ranges);
  for (const face of fromCss) {
    assert.equal(norm(face.ranges), norm(fromJs),
      `${face.family}'s unicode-range does not match fontCoverage.js's ranges`);
  }
});

test('the shipped fonts actually contain every code point the stylesheet declares', () => {
  // OVER-DECLARING IS THE DANGEROUS DIRECTION: the browser is told the font has
  // a character it does not, uses a system font for it, and the notice stays
  // silent. This is the check that makes "measured, not assumed" true.
  for (const file of FONTS) {
    const have = codePointsOf(join(UI_DIR, file));
    const missing: number[] = [];
    for (const [lo, hi] of C.SUBSETS.flatMap((s) => s.ranges)) {
      for (let cp = lo; cp <= hi; cp++) if (!have.has(cp)) missing.push(cp);
    }
    assert.deepEqual(
      missing.map((c) => 'U+' + c.toString(16).toUpperCase()), [],
      `${file} does not contain every declared code point`
    );
  }
});

test('the two characters the design depends on are really in both fonts', () => {
  // docs/design/pass3/BRIEF.md section 9: the middle dot and the em dash appear
  // 25 and 13 times in the rendered content, and the brief asserted from
  // general knowledge that the latin subset covers them. Measured here.
  for (const file of FONTS) {
    const have = codePointsOf(join(UI_DIR, file));
    assert.ok(have.has(0x00b7), `${file} lacks U+00B7, the middle dot`);
    assert.ok(have.has(0x2014), `${file} lacks U+2014, the em dash`);
  }
  assert.ok(C.covers(0x00b7));
  assert.ok(C.covers(0x2014));
});

// -------------------------------------------- the pure function, at the edges

test('the coverage function is exact at every range boundary', () => {
  // Off-by-one at a boundary is the whole failure mode of a range check, so
  // every boundary is tested from both sides rather than a sample being taken.
  const ranges = C.SUBSETS.flatMap((s) => s.ranges);
  const inRange = (cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);
  for (const [lo, hi] of ranges) {
    assert.equal(C.covers(lo), true, `U+${lo.toString(16)} is the start of a declared range and is not covered`);
    assert.equal(C.covers(hi), true, `U+${hi.toString(16)} is the end of a declared range and is not covered`);
    // Just outside, unless another range or the not-drawn set claims it.
    if (lo > 0 && !inRange(lo - 1) && !C.NOT_DRAWN.includes(lo - 1)) {
      assert.equal(C.covers(lo - 1), false, `U+${(lo - 1).toString(16)} is below every range but is reported covered`);
    }
    if (!inRange(hi + 1) && !C.NOT_DRAWN.includes(hi + 1)) {
      assert.equal(C.covers(hi + 1), false, `U+${(hi + 1).toString(16)} is above every range but is reported covered`);
    }
  }
});

test('ordinary page text raises no notice', () => {
  const v = C.textOutsideFontCoverage([
    'Write wal.md covering write-ahead logging',
    'claude-haiku-4-5-20251001 · tier haiku',
    'at least $0.12 — live estimate',
    'tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f',
  ]);
  assert.equal(v.outside, false, `false positive on: ${v.sample}`);
});

test('a scope document full of newlines and tabs raises no notice', () => {
  // The approved carve-out: tab, newline and carriage return are not rendered
  // glyphs and no font is consulted for them. A notice that fired on every
  // scope document would mean nothing -- the same failure as a progress bar
  // over something nobody measures.
  const v = C.textOutsideFontCoverage(['# Scope\n\n- one\n\t- indented\r\n- two\n']);
  assert.equal(v.outside, false, `whitespace was treated as outside coverage: ${v.sample}`);
  for (const cp of C.NOT_DRAWN) assert.equal(C.covers(cp), true);
});

test('text outside the subsets raises the notice and names the code points', () => {
  const arabic = C.textOutsideFontCoverage(['مرحبا']);
  assert.equal(arabic.outside, true);
  assert.match(arabic.sample, /U\+0645/);

  const cjk = C.textOutsideFontCoverage(['ticket: 世界']);
  assert.equal(cjk.outside, true);
  assert.match(cjk.sample, /U\+4E16/);
});

test('an astral character is reported as one code point, not as two surrogates', () => {
  // Testing UTF-16 units instead of code points would report two bogus values
  // in the D800..DFFF block and name neither the real character.
  const v = C.textOutsideFontCoverage(['ok \u{1F600}']);
  assert.equal(v.outside, true);
  assert.deepEqual(v.codePoints, [0x1f600]);
  assert.equal(v.sample, 'U+1F600');
});

test('the function is pure: same input, same answer, and no input is mutated', () => {
  const input = ['a', '世'];
  const frozen = JSON.stringify(input);
  const a = C.textOutsideFontCoverage(input);
  const b = C.textOutsideFontCoverage(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), frozen);
});

test('empty, null and non-string input are handled without raising a false notice', () => {
  assert.equal(C.textOutsideFontCoverage([]).outside, false);
  assert.equal(C.textOutsideFontCoverage(null as unknown as unknown[]).outside, false);
  assert.equal(C.textOutsideFontCoverage([42, null, undefined]).outside, false);
});

test('the notice wording is the one the ruling specifies, and is shown once', () => {
  assert.equal(
    C.COVERAGE_NOTICE,
    "some text is outside the bundled font's coverage and is shown in a system font"
  );
  // One line, once, beside the font-load notice. Not per string.
  const app = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
  assert.equal([...app.matchAll(/COVERAGE_NOTICE/g)].length, 1,
    'the coverage notice is referenced more than once -- it is one line, once');
  assert.match(app, /setNotice\('notice-coverage'/);
});

test('the font-load notice is the exact wording batch 14 ruling 1 requires', () => {
  const app = readFileSync(join(UI_DIR, 'app.js'), 'utf8');
  assert.ok(app.includes("'interface font did not load, run magarine doctor'"));
  // Checked through the browser's own font-loading interface, not a timeout.
  assert.match(app, /document\.fonts\.ready/);
  assert.match(app, /document\.fonts\.check\(/);
});

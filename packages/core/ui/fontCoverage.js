// ===========================================================================
// Magarine — the font coverage notice, one pure function.
//
// THE OTHER HALF OF tokens.css's unicode-range BLOCKS. Read that file's FONTS
// comment first; these two are one mechanism and were built together.
//
// Declaring a unicode-range is what CAUSES a browser to render every character
// outside it in a system font. That text renders FINE -- it just quietly stops
// looking like the page the owner approved, which under rule 9 is exactly the
// silent fallback that is not allowed. So: the same ranges, in one place, and
// a function that says when the daemon has handed the page text the bundled
// font cannot draw.
//
// Owner's ruling (docs/strategy/batch-15-addendum-owner-answers.md section 3):
// Latin only for now; text outside it is never shown silently; ONE line, ONCE,
// beside the font-load notice; no per-string decoration, no colour, no
// interruption.
//
// PURE. No DOM, no globals read or written, no daemon calls, no state. Given
// the same strings it returns the same answer, which is what makes it testable
// at every range boundary (src/ui/fonts.test.ts).
// ===========================================================================
(function (root) {
  'use strict';

  // THE SHIPPED SUBSETS. One entry per @font-face subset in tokens.css, with
  // the same ranges. src/ui/fonts.test.ts parses tokens.css and fails if the
  // two ever disagree, so the notice cannot drift from the font.
  //
  // These ranges are the MEASURED intersection of the two shipped woff2 files'
  // cmap tables, not a published subset constant -- see tokens.css. Adding a
  // script later adds one entry here and one @font-face block there.
  var SUBSETS = [
    {
      name: 'latin',
      ranges: [
        [0x0020, 0x007E], [0x00A0, 0x00FF], [0x0131, 0x0131], [0x0152, 0x0153],
        [0x02BC, 0x02BC], [0x02C6, 0x02C6], [0x02DA, 0x02DA], [0x02DC, 0x02DC],
        [0x0300, 0x0301], [0x0303, 0x0304], [0x0308, 0x0309], [0x0323, 0x0323],
        [0x2013, 0x2014], [0x2018, 0x201A], [0x201C, 0x201E], [0x2022, 0x2022],
        [0x2026, 0x2026], [0x2032, 0x2033], [0x2039, 0x203A], [0x2044, 0x2044],
        [0x20AC, 0x20AC], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193],
        [0x2212, 0x2212], [0x2215, 0x2215], [0xFEFF, 0xFEFF]
      ]
    }
  ];

  // Whitespace a browser lays out rather than draws a glyph for. A scope
  // document is full of newlines and tabs; counting them as "outside the
  // font" would raise the notice on every project and make it meaningless --
  // and it would be WRONG, because no font is consulted for them.
  // tab, newline, carriage return. Space (U+0020) is inside the range anyway.
  var NOT_DRAWN = [0x0009, 0x000A, 0x000D];

  function inRanges(cp, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
    }
    return false;
  }

  /**
   * True when the page can render this code point without a visible fallback:
   * either a shipped subset covers it, or it is whitespace no font draws.
   */
  function covers(cp) {
    for (var i = 0; i < NOT_DRAWN.length; i++) if (cp === NOT_DRAWN[i]) return true;
    for (var s = 0; s < SUBSETS.length; s++) {
      if (inRanges(cp, SUBSETS[s].ranges)) return true;
    }
    return false;
  }

  // Code points, not UTF-16 units: an emoji or a CJK extension character is a
  // surrogate PAIR, and testing the halves separately would report two bogus
  // code points in the D800..DFFF block instead of the real one.
  function codePointsOf(s, visit) {
    for (var i = 0; i < s.length; i++) {
      var cp = s.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = (cp - 0xD800) * 0x400 + (lo - 0xDC00) + 0x10000;
          i++;
        }
      }
      if (visit(cp) === false) return;
    }
  }

  /**
   * THE FUNCTION. Give it every string the page renders from the daemon --
   * ticket titles, the scope, conversation text, inbox reasons, artefact
   * paths, model ids, event types -- and it reports whether any code point in
   * any of them falls outside the shipped subsets.
   *
   * @param {Array} strings  values as they came from the daemon. Non-strings
   *                         are coerced rather than skipped: skipping would
   *                         silently drop a field someone forgot to convert,
   *                         and a silent miss here is the failure this whole
   *                         mechanism exists to prevent.
   * @returns {{outside: boolean, codePoints: number[], sample: string}}
   *          `outside` is the answer the notice needs. The rest is for a
   *          person debugging one: at most SAMPLE_LIMIT distinct code points,
   *          lowest first, and a printable "U+XXXX" list.
   */
  function textOutsideFontCoverage(strings) {
    var SAMPLE_LIMIT = 8;
    var seen = {};
    var found = [];
    var list = (strings === null || strings === undefined) ? [] : strings;
    for (var i = 0; i < list.length; i++) {
      var s = String(list[i]);
      codePointsOf(s, function (cp) {
        if (covers(cp)) return;
        if (seen[cp]) return;
        seen[cp] = true;
        found.push(cp);
      });
    }
    found.sort(function (a, b) { return a - b; });
    var shown = found.slice(0, SAMPLE_LIMIT);
    return {
      outside: found.length > 0,
      codePoints: found,
      sample: shown.map(function (cp) {
        var hex = cp.toString(16).toUpperCase();
        while (hex.length < 4) hex = '0' + hex;
        return 'U+' + hex;
      }).join(' ')
    };
  }

  // The exact line the page shows, once, beside the font-load notice. Kept
  // here rather than in app.js so the wording and the ranges that trigger it
  // cannot drift apart.
  var COVERAGE_NOTICE =
    "some text is outside the bundled font's coverage and is shown in a system font";

  root.MagarineFontCoverage = {
    SUBSETS: SUBSETS,
    NOT_DRAWN: NOT_DRAWN,
    COVERAGE_NOTICE: COVERAGE_NOTICE,
    covers: covers,
    textOutsideFontCoverage: textOutsideFontCoverage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

# Re-subsetting the two bundled fonts

Ruling 35 (batch 18). The woff2 files in `ui/` are subsets of the official releases:

- **JetBrains Mono** v2.304, `fonts/variable/JetBrainsMono[wght].ttf`, from
  https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
- **IBM Plex Sans** variable (roman), `IBM Plex Sans Var-Roman.ttf` from the npm package
  `@ibm/plex-sans-variable@0.2.0` (font version 3.000, https://github.com/IBM/plex)

Both are SIL OFL 1.1 (see the licences in this folder).

## What is kept

The Latin ranges of batch 14/15, plus the symbol blocks language models write in
ordinary prose: General Punctuation U+2000-206F, Arrows U+2190-21FF, Mathematical
Operators U+2200-22FF, Box Drawing U+2500-257F, Geometric Shapes U+25A0-25FF, Dingbats
U+2700-27BF -- **only the code points BOTH fonts contain**, because one range list
describes the page's whole text and over-declaring it is the silent fallback the
coverage notice exists to prevent.

That intersection is much smaller than the blocks. IBM Plex Sans has no Box Drawing, one
Geometric Shape and two Dingbats, so box-drawing characters (`├──`), most shapes and most
dingbats are still outside the bundle and still raise the notice. U+2192 (arrow) and
U+2713 (check mark) are in.

## How

```sh
python -m venv fontvenv
fontvenv/Scripts/python -m pip install fonttools brotli      # bin/python on macOS/Linux
# unpack the JetBrains Mono zip to <src>/jbm and the npm tarball to <src>/plex
fontvenv/Scripts/python resubset.py <src> <out>
```

`resubset.py` (below) pins the axes the shipped files carry (JetBrains Mono `wght` 400-800,
Plex Sans `wdth` 100), subsets both with the same code points, writes the two woff2 files,
and PRINTS the measured ranges. Copy those into `ui/tokens.css` (both `unicode-range`
blocks) and `ui/fontCoverage.js` together; `src/ui/fonts.test.ts` fails if they disagree
with each other or with the files.

```python
"""Re-subset the two shipped fonts. See packages/core/licenses/FONT-SUBSETTING.md."""
import subprocess, sys, os
from fontTools.ttLib import TTFont

SRC = sys.argv[1]      # directory holding the official releases, unpacked
OUT = sys.argv[2]      # where the two woff2 files and the pinned instances go
py = sys.executable

JBM = os.path.join(SRC, 'jbm/fonts/variable/JetBrainsMono[wght].ttf')
PLEX = os.path.join(SRC, 'plex/package/fonts/complete/ttf/IBM Plex Sans Var-Roman.ttf')

# The Latin ranges rulings 1 (batch 14) and 15 fixed: the measured intersection
# of the two fonts, unchanged.
LATIN = [
    (0x0020, 0x007E), (0x00A0, 0x00FF), (0x0131, 0x0131), (0x0152, 0x0153),
    (0x02BC, 0x02BC), (0x02C6, 0x02C6), (0x02DA, 0x02DA), (0x02DC, 0x02DC),
    (0x0300, 0x0301), (0x0303, 0x0304), (0x0308, 0x0309), (0x0323, 0x0323),
    (0x2013, 0x2014), (0x2018, 0x201A), (0x201C, 0x201E), (0x2022, 0x2022),
    (0x2026, 0x2026), (0x2032, 0x2033), (0x2039, 0x203A), (0x2044, 0x2044),
    (0x20AC, 0x20AC), (0x2122, 0x2122), (0x2191, 0x2191), (0x2193, 0x2193),
    (0x2212, 0x2212), (0x2215, 0x2215), (0xFEFF, 0xFEFF),
]
# Ruling 35's symbol blocks.
BLOCKS = [(0x2000, 0x206F), (0x2190, 0x21FF), (0x2200, 0x22FF),
          (0x2500, 0x257F), (0x25A0, 0x25FF), (0x2700, 0x27BF)]

def expand(rs):
    out = set()
    for a, b in rs:
        out.update(range(a, b + 1))
    return out

def run(*args):
    subprocess.check_call([py, '-m', *args])

os.makedirs(OUT, exist_ok=True)
jbm_pin = os.path.join(OUT, 'jbm-pinned.ttf')
plex_pin = os.path.join(OUT, 'plex-pinned.ttf')
# The shipped files carry wght only: JetBrains Mono 400-800, Plex Sans at wdth 100.
run('fontTools.varLib.instancer', JBM, 'wght=400:800', '-o', jbm_pin)
run('fontTools.varLib.instancer', PLEX, 'wdth=100', '-o', plex_pin)

both = set(TTFont(jbm_pin).getBestCmap()) & set(TTFont(plex_pin).getBestCmap())
want = expand(LATIN) | (expand(BLOCKS) & both)

def subset(src, dst, features):
    run('fontTools.subset', src, '--unicodes=' + ','.join('%04X' % c for c in sorted(want)),
        '--layout-features=' + features, '--flavor=woff2', '--output-file=' + dst)

subset(jbm_pin, os.path.join(OUT, 'JetBrainsMono.woff2'), 'calt,ccmp,frac,locl,mark')
subset(plex_pin, os.path.join(OUT, 'IBMPlexSans.woff2'), 'ccmp,dnom,frac,liga,numr,kern,mark')

# The ranges to declare are MEASURED from the two outputs, never assumed.
a = set(TTFont(os.path.join(OUT, 'JetBrainsMono.woff2')).getBestCmap())
b = set(TTFont(os.path.join(OUT, 'IBMPlexSans.woff2')).getBestCmap())
cm = sorted(a & b)
ranges, start, prev = [], None, None
for c in cm:
    if start is None:
        start = prev = c
    elif c == prev + 1:
        prev = c
    else:
        ranges.append((start, prev)); start = prev = c
ranges.append((start, prev))
print(len(ranges), 'ranges')
print(', '.join('U+%04X' % a if a == b else 'U+%04X-%04X' % (a, b) for a, b in ranges))
print('js:', ', '.join('[0x%04X, 0x%04X]' % r for r in ranges))
```

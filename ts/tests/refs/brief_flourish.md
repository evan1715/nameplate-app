# Font brief — TGCarrieSOFlourish-v2.otf

- family (the font's own internal name): **TG Carrie SO FLOURISH v2 Regular**
- unitsPerEm: 2048
- engrave lines: yes (COLR)
- asked for: cap height 25.0 mm, min thickness 0.5 mm

## VERDICT: NEEDS WORK

## Targets

```
                                     now      target     change      font units now -> want  verdict
thinnest part of the letters      1.4619      0.5000    -65.80%         83.8 -> 28.7         MET
```

## Font check — 0 error(s), 1 warning(s)

- **[WARNING] 2 letter junction(s) do not join**
  - what: Each of these leaves a gap, so a name containing it cuts as loose pieces instead of one plate: Dleftring→d (type 'Dda'); Dleftring→dflourishrightring (type 'dd'). Type the example next to a junction to see it in the preview.
  - fix: Extend the left glyph's exit stroke until it crosses into the next letter. Note some junctions only appear mid-word because the font swaps in a contextual form — 'go' can be fine while 'ego' is not, so fix the form the example actually uses.

## Letter pairs

5 pair(s) do not join. Worst first:
- `dda` (dd at the start of a word) — gap, gap 0.001 em
- `Dda` (Dd at the start of a word) — gap, gap 0.001 em
- `ADda` (Dd at the middle of a word) — gap, gap 0.001 em
- `dd` (dd at the start of a word) — gap, gap 0.000 em
- `Dd` (Dd at the start of a word) — gap, gap 0.000 em

## Built artwork (test names)

| test name | size | pieces | holes | engrave |
|---|---|---|---|---|
| ADAM | 145.639 x 25.140 mm | 1 | 14 | 0 |
| Adam | 106.350 x 25.122 mm | 1 | 9 | 2 |

## Eyelets

| end | inner Ø | outer Ø | wall avg | wall thinnest | roundness |
|---|---|---|---|---|---|
| left | 2.7719 | 8.8865 | 3.0573 | 3.0380 | 0.999 |
| right | 2.7719 | 8.8832 | 3.0557 | 3.0373 | 0.999 |

(all in mm; font units in the JSON)

## Thinnest parts

8 thin area(s) found; the worst 8 are listed.

| # | letter | where | thickness | font units | walls | needs |
|---|---|---|---|---|---|---|
| 1 | M (Mflourishrightring) | right side | 1.4619 mm | 83.8 | taper 0.44 | ok |
| 2 | D | upper right | 1.5046 mm | 86.2 | taper 0.43 | ok |
| 3 | M (Mflourishrightring) | left side | 1.9263 mm | 110.4 | taper 0.42 | ok |
| 4 | D | top | 2.0002 mm | 114.7 | taper 0.44 | ok |
| 5 | D | lower left | 2.0197 mm | 115.8 | web 0.50 | ok |
| 6 | D | middle | 2.0203 mm | 115.8 | web 0.50 | ok |
| 7 | A (Aleftring) | lower left | 2.1885 mm | 125.4 | taper 0.43 | ok |
| 8 | A | lower left | 2.1885 mm | 125.4 | taper 0.43 | ok |

`walls` is how parallel the two sides are at the worst reading. **web** (about 0.50) is material that will snap and is worth thickening; **taper** is the width of a wedge running into a junction, which is usually not.


## Prompts

Each block is a paste-ready instruction. An empty block means there is nothing to fix in that area.

**PASTE ONE BLOCK PER ROUND. Every block here was measured on the SAME version of the font, so the moment one of them is carried out the others are describing a font that no longer exists - re-run and use the fresh blocks. The blocks also overlap on purpose: a junction fix can appear in both 1 and 2, and block 4 is the ONLY one allowed to resize an eyelet.**

### Font defects

```
FONT REPAIR REQUEST - TGCarrieSOFlourish-v2.otf

You are editing the font file TGCarrieSOFlourish-v2.otf. Make the
numbered changes below and nothing else. This font is used to laser cut
names out of sheet metal, so a letter that does not physically touch the
next one becomes a piece of metal on the floor.

THE FONT
  file                TGCarrieSOFlourish-v2.otf
  family (name ID 4)  TG Carrie SO FLOURISH v2 Regular
  unitsPerEm          2048
  outlines            PostScript 'CFF ' outlines
  glyph names         post table format 3.0 - this font stores NO glyph
                      names. Names like glyph00174 below are placeholders
                      generated from the glyph order, so look every glyph
                      up by its glyph ID, which is the number in the name
                      and is given explicitly each time.
  colour layers       COLR v0, 2 CPAL palette(s) - the engrave lines come
                      from these
  glyph count         6649
  shaping             the app shapes text with calt, kern, liga, rlig
                      switched on, which is what picks the contextual
                      alternates named below

SIZES ARE IN FONT UNITS - READ THIS BEFORE MEASURING ANYTHING
  Every size in this request is in FONT UNITS, relative to unitsPerEm =
  2048. Work in font units. A font editor measures in font units and
  Sean's app measures in inches because it cuts metal, and every earlier
  attempt at these fixes went wrong at that boundary - an inch number
  treated as a font-unit number is roughly 1433 times too small, which
  looks like nothing happened at all.
  So each size is given twice: font units first, then the same size in
  inches in brackets. The inch figures use the size the font was checked
  at, 1.000 in cap height, where 1 font unit = 0.000698 in (0.0177 mm)
  and 1 in = 1433 font units. Only the font-unit numbers are the
  instruction; the inch numbers are there to be sanity-checked.
  A plate cut larger than that makes every font unit physically bigger,
  so an overlap stated in font units holds at every larger size. That is
  the other reason the instruction is in font units and not in inches.

WHAT TO CHANGE - 1 item, and nothing else

1. Close the 2 letter junction(s) that leave a gap. Each one makes any name
   containing it cut as loose pieces instead of one plate. They come to 2
   separate edit(s) below, because several of these junctions are the same
   stroke stopping short. Do not touch a glyph that is not named here.
     (a) junction Dleftring -> d (1 of 2), produced by typing "Dda"
         EDIT THIS GLYPH: Dleftring (glyph ID 271), the form this font uses
           for 'D' in "Dda". This is a contextual alternate, NOT the plain
           'D' that the cmap points at (D, glyph ID 37). Edit Dleftring.
           Leave D alone.
         IT MUST REACH: d (glyph ID 64), the form this font uses for 'd' in
           "Dda", encoded at U+0064. Do not edit that glyph for this item.
         GAP NOW: 1.7 font units (0.0012 in) of empty space between the ink
           of Dleftring and the next glyph.
         DO THIS: in Dleftring's own coordinates its ink stops at (1753.1,
           436.5), and the next glyph's ink begins at (1754.6, 435.7) in
           those same coordinates. Carry that exit stroke on from where it
           ends, keeping its existing width and following the curve it is
           already on, until it passes (1754.6, 435.7) and reaches at least
           (1782.3, 421.8) - 32.7 font units (0.023 in) of travel, leaving
           31 font units (0.022 in) of real overlap. Do it ONCE. Change
           nothing else in the glyph, and do not widen its advance to
           contain the longer stroke - the ink is supposed to hang past the
           advance, that is how the letters overlap.
         WHY THIS GLYPH: Dleftring is only chosen in contexts like "Dda", so
           editing it cannot disturb any other pair. That is exactly why the
           edit belongs here and not on the plain 'D'.
     (b) junction Dleftring -> dflourishrightring (2 of 2), produced by
         typing "dd"
         EDIT THIS GLYPH: Dleftring (glyph ID 271), the form this font uses
           for 'd' in "dd". This is a contextual alternate, NOT the plain
           'd' that the cmap points at (d, glyph ID 64). Edit Dleftring.
           Leave d alone.
         IT MUST REACH: dflourishrightring (glyph ID 437), the form this
           font uses for 'd' in "dd" - itself a contextual alternate, not
           the plain 'd' (d, glyph ID 64). Do not edit that glyph for this
           item.
         GAP NOW: 0.9 font units (0.0006 in) of empty space between the ink
           of Dleftring and the next glyph.
         DO THIS: in Dleftring's own coordinates its ink stops at (1757.8,
           445.9), and the next glyph's ink begins at (1758.6, 445.5) in
           those same coordinates. Carry that exit stroke on from where it
           ends, keeping its existing width and following the curve it is
           already on, until it passes (1758.6, 445.5) and reaches at least
           (1786.3, 431.6) - 31.9 font units (0.022 in) of travel, leaving
           31 font units (0.022 in) of real overlap. Do it ONCE. Change
           nothing else in the glyph, and do not widen its advance to
           contain the longer stroke - the ink is supposed to hang past the
           advance, that is how the letters overlap.
         WHY THIS GLYPH: Dleftring is only chosen in contexts like "dd", so
           editing it cannot disturb any other pair. That is exactly why the
           edit belongs here and not on the plain 'd'.

GLYPHS IN SCOPE - 1 existing glyph(s), and no others

   Dleftring (glyph ID 271).
   Also in scope: where an item offers a choice of which side to edit,
   the partner glyph that item names - one side or the other, never both.
   Every other glyph in the font must come back byte for byte identical.

BACKGROUND, NOT TASKS - do not change anything for these

   - The font carries no glyph names: Its post table is format 3.0, so
     glyphs have no names and tools refer to them as glyph00131 or
     gid131. The app handles this by using glyph IDs, but font editors
     will show unhelpful names.

DO NOT CHANGE - anything here that moves is a defect you introduced

   - unitsPerEm - it is 2048 and it stays exactly that. Every number in
     this request assumes it.
   - cap height, and OS/2 sCapHeight / sTypoAscender / sTypoDescender /
     hhea ascent and descent. Sean's app scales a name by cap height, so
     moving it silently resizes every nameplate ever cut from this font.
   - x-height - OS/2 sxHeight is 1024 and stays 1024.
   - every glyph's advance width, left side bearing and right side
     bearing. Widening a glyph to contain a stroke you extended is
     exactly the wrong fix: in a joining font the ink is supposed to hang
     past the advance. Extend the ink, leave the advance.
   - kerning, and any GPOS table. The gaps above are closed by drawing,
     not by moving letters closer together.
   - the contextual alternate set and its feature rules - GSUB, calt,
     liga, rlig, ccmp. Do not add, remove, re-point or re-order a
     substitution, and do not make a substitution fire in a new context.
     Where a defect is in an alternate, edit that alternate's outline in
     place.
   - the glyph order and therefore every glyph ID. Do not add, delete,
     merge or reorder glyphs. The app addresses glyphs by ID. Do not
     subset, do not remove unused glyphs, do not decompose or recompose
     composites.
   - the eyelet holes and their diameters, and every other existing
     counter or hole. If a glyph already has a hole in it, that hole
     keeps its size and position.
   - the COLR layers and the CPAL palette - the engrave lines come from
     them and they are already correct.
   - the family name and every other name-table record, the font version,
     the outline format, and hinting. No autohinting, no 'clean up
     outlines', no rounding coordinates to the grid, no reinterpolation.
   - every glyph that is not in the GLYPHS IN SCOPE list above. If you
     are unsure whether a glyph is in scope, it is not.

WHAT TO SEND BACK

   1. Re-export the edited font as an OTF with 'CFF ' outlines - the same
      format it arrived in - with the family name still exactly TG Carrie
      SO FLOURISH v2 Regular, unitsPerEm still 2048, and the same glyph
      inventory in the same order.
   2. Name the file TGCarrieSOFlourish-v3.otf so it cannot be confused
      with TGCarrieSOFlourish-v2.otf.
   3. List what you changed: for each glyph, its name and glyph ID, which
      contour and which points moved, and the before and after
      coordinates in font units. One line per glyph.
   4. For every junction you closed, check it: set the two glyphs side by
      side at their existing advance widths and confirm the outlines
      genuinely overlap rather than touch - the union of the two shapes
      has to be one closed region, not two regions meeting at a point.
      Say that you checked it.
   5. State how many glyphs you edited and confirm it matches that list
      and the GLYPHS IN SCOPE count above. If you changed anything that
      was not asked for, say so plainly rather than leaving it to be
      found on the laser bed.
   6. If any instruction here cannot be carried out as written, stop and
      say which one and why. Do not substitute a different fix.
```

### Letter pairs that do not join

```
FONT TO EDIT
  file name    : TGCarrieSOFlourish-v2.otf
  full path    : <ROOT>/fonts/TGCarrieSOFlourish-v2.otf
  family name  : TG Carrie SO FLOURISH v2 Regular
  unitsPerEm   : 2048

Every size below is in FONT UNITS on this font's 2048-unit em.
For scale: 1% of the em is 20 units. Do not read the numbers as
points, pixels, millimetres or percentages.

WHY THIS MATTERS
  These letters get laser-cut out of one piece of sheet metal. The cutting
  app unions all the letters of a name into ONE closed path. Wherever two
  neighbouring letters do not overlap, the union leaves two separate
  islands and that letter drops out of the sheet as a loose piece.

FAILING PAIRS: 5 of 5408 tested pairs have a
gap between the two letters. They are grouped by their LEFT letter,
because the left letter's exit stroke is usually the single thing that
has to change to fix the whole group.

--- START OF A WORD: LOWERCASE + LOWERCASE --- 1 of 676 tested pairs failed
  LEFT LETTER 'd'  (1 failing pair)
    'd' + 'd'   glyphs: Dleftring -> dflourishrightring
        gap 0.9 units (0.00042 em) - close it and then overlap: extend by >= 21 units

--- START OF A WORD: CAPITAL + LOWERCASE --- 1 of 676 tested pairs failed
  LEFT LETTER 'D'  (1 failing pair)
    'D' + 'd'   glyphs: Dleftring -> dflourishrightring
        gap 0.9 units (0.00042 em) - close it and then overlap: extend by >= 21 units

--- START OF A WORD: CAPITAL + CAPITAL --- 0 of 676 tested pairs failed
  none failed in this group.

--- MIDDLE OF A WORD: LOWERCASE + LOWERCASE --- 0 of 676 tested pairs failed
  none failed in this group.

--- MIDDLE OF A WORD: CAPITAL + LOWERCASE --- 1 of 676 tested pairs failed
  LEFT LETTER 'D'  (1 failing pair)
    'D' + 'd'   glyphs: Aleftring -> D -> d -> aflourishrightring
        gap 1.7 units (0.00084 em) - close it and then overlap: extend by >= 22 units

--- FIRST LETTER OF A WORD: LOWERCASE + LOWERCASE --- 1 of 676 tested pairs failed
  LEFT LETTER 'd'  (1 failing pair)
    'd' + 'd'   glyphs: Dleftring -> d -> aflourishrightring
        gap 1.7 units (0.00084 em) - close it and then overlap: extend by >= 22 units

--- FIRST LETTER OF A WORD: CAPITAL + LOWERCASE --- 1 of 676 tested pairs failed
  LEFT LETTER 'D'  (1 failing pair)
    'D' + 'd'   glyphs: Dleftring -> d -> aflourishrightring
        gap 1.7 units (0.00084 em) - close it and then overlap: extend by >= 22 units

--- LAST LETTER OF A WORD: LOWERCASE + LOWERCASE --- 0 of 676 tested pairs failed
  none failed in this group.

WHAT TO CHANGE
  For each failing pair, extend the LEFT glyph's exit stroke (or, where
  that would distort the letter, the RIGHT glyph's entry stroke) along the
  natural direction of the stroke until the two outlines OVERLAP by at
  least 20 font units measured across the join.
  A hairline touch is NOT enough. The app unions the letters into one cut
  path, and two outlines that only graze each other can union into a
  pinch that the laser cuts straight through. Aim for a real overlap.
  Keep the extension on the stroke's own path and weight so the letter
  still reads as the same letter - do not add a straight connector bar.
  Every gap above was measured with this font's own kerning applied, the
  same way the cutting app shapes a name. Some of these pairs are pushed
  apart by a positive kern; close them by extending the outline anyway.
  The spacing is the design and the app depends on it, so do not buy the
  overlap by re-kerning the pair.

EDIT THE GLYPH THAT IS NAMED, NOT THE BASE LETTER
  This font uses contextual alternates, so the glyph that actually draws
  in a pair is often NOT the plain base glyph. The 'glyphs:' line above
  gives the real shaped glyph names, in order, as the shaper chose them
  (names like 'g.alt3' or 'bflourishrightring.eng3' are alternates).
  Make each edit on the glyph named there. Editing the plain base glyph
  instead changes something nobody sees and leaves the gap exactly as it
  is. If one alternate is shared by several failing pairs, fixing it once
  fixes all of them - check before editing the same outline twice.

DO NOT CHANGE
  - unitsPerEm
  - cap height, x-height, ascender, descender, or any vertical metric
  - advance widths and side bearings (the letters must not re-space)
  - kerning values
  - eyelet hole sizes, shapes or positions
  - the set of alternate glyphs, or the feature rules that pick them
    (calt, liga, rlig, kern) - the same alternate must still be chosen
    for the same pair after the edit
  - the colour layers / engrave lines
  - ANY glyph not named in the list above

HOW IT WILL BE CHECKED
  Every pair is re-shaped and the two filled outlines are tested for
  intersection. A pair passes only when the ink actually overlaps, and no
  pair that passes today may start failing.
```

### Thin areas to thicken

```
Every thin area of 'ADAM' is already at or above 0.5000 mm (28.7 font units), so the font needs no change for this name at this size.
```

### Eyelet size

```
(nothing to fix)
```

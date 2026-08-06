# Font brief — MerriweatherCut3Black-Engrave-v2.ttf

- family (the font's own internal name): **Merriweather-Cut3 Engrave v2 Black**
- unitsPerEm: 2000
- engrave lines: yes (COLR)
- asked for: cap height 1.0 in, eyelet ID 0.4 in, eyelet wall 0.2 in, min thickness 0.09 in

## VERDICT: NEEDS WORK

**Blocking:**
- 11 thin areas are under the target but only the worst 8 are listed - fix these, then re-run; do not treat the list as complete.

## Targets

```
                                     now      target     change      font units now -> want  verdict
eyelet inner diameter             0.3448      0.4000    +16.02%        512.3 -> 594.4        NOT MET
eyelet wall                       0.1551      0.2000    +28.97%        230.4 -> 297.2        MET
thinnest part of the letters      0.0490      0.0900    +83.82%         72.8 -> 133.7        NOT MET
```

## Font check — 0 error(s), 0 warning(s)

No errors and no warnings.

## Letter pairs

Every one of 5408 pairs joins cleanly, in every position.

## Built artwork (test names)

| test name | size | pieces | holes | engrave |
|---|---|---|---|---|
| ADAM | 4.069 x 1.020 in | 1 | 5 | 10 |
| Adam | 4.069 x 1.020 in | 1 | 5 | 10 |

## Eyelets

| end | inner Ø | outer Ø | wall avg | wall thinnest | roundness |
|---|---|---|---|---|---|
| left | 0.3448 | 0.6549 | 0.1551 | 0.1548 | 1.000 |

(all in in; font units in the JSON)

## Thinnest parts

16 thin area(s) found, **11 under target**; the worst 8 are listed.

| # | letter | where | thickness | font units | walls | needs |
|---|---|---|---|---|---|---|
| 1 | A (A.e5) | lower left | 0.0490 in | 72.8 | web 0.50 | +83.8% |
| 2 | D (D.e0) | lower right | 0.0490 in | 72.8 | web 0.50 | +83.6% |
| 3 | M (M.e0) | upper left | 0.0787 in | 117.0 | web 0.50 | +14.3% |
| 4 | M (M.e0) | top | 0.0794 in | 118.0 | web 0.50 | +13.3% |
| 5 | A (A.e5) | bottom | 0.0857 in | 127.3 | web 0.50 | +5.0% |
| 6 | A (A.ini) | bottom | 0.0857 in | 127.3 | web 0.50 | +5.0% |
| 7 | D (D.e0) | top | 0.0858 in | 127.5 | web 0.50 | +4.9% |
| 8 | A (A.e5) | lower left | 0.0881 in | 130.9 | taper 0.45 | +2.2% |

`walls` is how parallel the two sides are at the worst reading. **web** (about 0.50) is material that will snap and is worth thickening; **taper** is the width of a wedge running into a junction, which is usually not.


## Prompts

Each block is a paste-ready instruction. An empty block means there is nothing to fix in that area.

**PASTE ONE BLOCK PER ROUND. Every block here was measured on the SAME version of the font, so the moment one of them is carried out the others are describing a font that no longer exists - re-run and use the fresh blocks. The blocks also overlap on purpose: a junction fix can appear in both 1 and 2, and block 4 is the ONLY one allowed to resize an eyelet.**

### Font defects

```
(nothing to fix)
```

### Letter pairs that do not join

```
(nothing to fix)
```

### Thin areas to thicken

```
FONT THICKENING REQUEST  -  ShineOn nameplate, laser-cut sheet metal

FONT FILE      MerriweatherCut3Black-Engrave-v2.ttf
unitsPerEm     2000
NAME TESTED    ADAM
CUT AT         1 in cap height

THE PROBLEM
  This name is cut out of sheet metal. Any part of a letter that is too
  thin snaps off when the plate is handled. At the size above, the thinnest
  material in the artwork measures 0.0490 in and it has to be at
  least 0.0900 in. 11 separate area(s) are under that, of 16 measured.

ALL SIZES BELOW ARE IN FONT UNITS
  A font editor works in font units, not in inches or millimetres, so every
  size here is in font units of this font's 2000-unit em square.
  The conversion used is the one for this job: 1 in of cap height is
  1486 font units, so 1 font unit = 0.000673 in, and the
  0.0900 in minimum is 133.7 font units  -  round up to 134.
  A thickness in font units is a proportion of the letter, so fixing it
  here fixes it at every size the name is ever cut. Do not convert these
  numbers back into inches or millimetres.

THE THIN AREAS, THINNEST FIRST
  1. glyph 'A.e5' (the letter A)  -  lower left of the letter
     now 72.8 font units across, needs 134 font units (+83.8%)
     note: a single reading with nothing beside it to corroborate  -  a very
           small feature, so confirm it on screen before acting on it
  2. glyph 'D.e0' (the letter D)  -  lower right of the letter
     now 72.8 font units across, needs 134 font units (+83.6%)
  3. glyph 'M.e0' (the letter M)  -  upper left of the letter
     now 117.0 font units across, needs 134 font units (+14.3%)
     note: a single reading with nothing beside it to corroborate  -  a very
           small feature, so confirm it on screen before acting on it
  4. glyph 'M.e0' (the letter M)  -  top of the letter
     now 118.0 font units across, needs 134 font units (+13.3%)
     note: a single reading with nothing beside it to corroborate  -  a very
           small feature, so confirm it on screen before acting on it
  5. glyph 'A.e5' (the letter A)  -  bottom of the letter
     now 127.3 font units across, needs 134 font units (+5.0%)
  6. glyph 'A.ini' (the letter A)  -  bottom of the letter
     now 127.3 font units across, needs 134 font units (+5.0%)
  7. glyph 'D.e0' (the letter D)  -  top of the letter
     now 127.5 font units across, needs 134 font units (+4.9%)
  8. glyph 'A.e5' (the letter A)  -  lower left of the letter
     now 130.9 font units across, needs 134 font units (+2.2%)
     note: a single reading with nothing beside it to corroborate  -  a very
           small feature, so confirm it on screen before acting on it
  ...and 3 more area(s) under the minimum, not listed one by one.
  The instruction below covers those as well  -  it is a rule, not a list.

THE INSTRUCTION
  Thicken every stroke thinner than 134 font units up to 134 font units
  (an increase of up to 84% at the worst place), keeping the outer
  silhouette and the counters' positions.

  In plain terms: measure across each stroke listed above; where that
  measurement is under 134 font units, move the INNER wall of the stroke
  (the counter side) until it measures 134. The outside edge of the letter
  stays exactly where it is, and each counter stays in the same place and
  keeps its shape  -  it may end up slightly smaller, and that is expected.
  Blend into the thicker part of the same stroke either side of the thin
  place so there is no step, kink or lump where the change ends.
  Leave every stroke that already measures 134 font units or more alone.

WHAT MUST NOT CHANGE
  * the advance width of any glyph, and all kerning and spacing: the name
    must occupy exactly the same width, so the cut file does not resize
  * the cap height, x-height, ascender, descender and baseline
  * the outer silhouette of each letter  -  no letter may get taller, wider
    or a different shape; this is a local thickening, not a new weight
  * the eyelet holes: their diameter, roundness and position are set by the
    hanging hardware. Do not resize, move or reshape any eyelet hole, and do
    not thicken a stroke by eating into one
  * the contextual and alternate glyph set: keep every alternate and eyelet
    form (.eyeL / .eyeR and similar), keep every glyph name, and do not add,
    remove or re-order glyphs. Leave the GSUB/calt/liga/kern rules exactly as
    they are, so the same name still shapes to the same glyphs
  * the colour/engrave layers (COLR and CPAL) and the unitsPerEm
  * anything not on the list above. Do not tidy, redraw, re-interpolate or
    otherwise improve the font while you are in there  -  the only change is
    the thickness of the strokes named above.

HOW IT WILL BE CHECKED
  python nameplate_thickness.py MerriweatherCut3Black-Engrave-v2.ttf "ADAM" 1 in cap 0.09
  Every area it lists must read 134 font units or more, and the artwork
  size it prints must be unchanged from before the edit.
```

### Eyelet size

```
Edit the eyelet in the font Merriweather-Cut3 Engrave v2 Black (MerriweatherCut3Black-Engrave-v2.ttf) so it comes out at the size below.

Measured from the name 'ADAM' set to 1 in cap height.

LEFT EYELET
  inner diameter  0.3448 -> 0.4000 in   (+16.02%)
  wall thickness  0.1551 -> 0.2000 in   (+28.97%)
  outer diameter  0.6549 -> 0.8000 in   (+22.15%)
  In FONT UNITS (what your editor works in, and what actually has to change):
    hole diameter  512.3 -> 594.4
    wall           230.4 -> 297.2
    outer diameter 973.2 -> 1188.8

HOW TO MAKE THE CHANGE
  Resize the eyelet hole and the ring around it to the font-unit sizes above. Keep the eyelet concentric and keep its centre where it is, so the letters do not move.
  Do not change the cap height, the x-height, unitsPerEm, the advance widths, or any letter outline. Do not add, delete or reorder glyphs - this app addresses glyphs by ID.
  The eyelet is a contextual form on the first and last letter, so change it in EVERY glyph that carries one, or the two ends of a name will no longer match.

WHY FONT UNITS  Everything scales linearly with the height, so a font-unit size holds at every cutting height - set it once and the eyelet is right at 1 in and at any other height.
```

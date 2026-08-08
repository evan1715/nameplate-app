# BUILD BRIEF — ShineOn Nameplate Cut-File app

> **Historical.** This is the brief the app was originally built from, in
> Python with a PySide6 desktop window. It is kept verbatim as the record of what
> was asked for — the file names, the library names and the PyInstaller steps
> below describe that build, not the one that ships.
>
> What ships now is TypeScript on Node with a browser front end. Every promise in
> this document still holds and is still tested; `ts/README.md` maps each Python
> module to the file that replaced it and records exactly what matched byte for
> byte and what could not. `DEVELOPERS.md` is the current orientation.

**Read this whole file before writing code.** The hard part (font shaping, merging the
letters, pulling the engrave lines, SVG/PDF output) is **already written and tested**
in `nameplate_core.py`. Your job is the GUI around it and the portable Windows build.
Do not rewrite the geometry — see *Traps* at the end for the bugs already paid for.

---

## 1. What this is

Sean runs production at ShineOn. They laser-cut personalised name jewellery. The
fonts are custom: letters overlap and merge into one connected piece, the first letter
of each word carries an eyelet, and some fonts carry **red engrave lines** in OpenType
colour layers that mark where one letter hides another so the letters stay readable
after cutting.

He needs a desktop app that turns a typed name into a **laser-ready outline file**:

* letters merged into **one closed cut path** — no internal seams where they overlap
* **no black fill**, hairline stroke only
* **red engrave lines kept**, as open centerlines (one laser pass, not a filled sliver)
* sized to a real-world height he types in **mm or inches**
* exported as **SVG and PDF**, imported into **CorelDRAW**

## 2. Requirements (decided with Sean — don't re-litigate these)

| # | Requirement |
|---|---|
| R1 | Windows app that runs from **its own folder containing an .exe**. He copies the folder to any PC and runs it — no Python, no installer, no admin rights on the target machine. |
| R2 | Font chosen from a dropdown. He drops font files in once and they stay available. If he replaces a font with a newer version, the app uses the newest by default; he can also pick a specific one. |
| R3 | Multi-line name input — one name per line, batch of any size. |
| R4 | Height entered as a number plus **mm / inch**, measured by one of: **cap height** (the first capital letter in that name), **x-height** (the font's lowercase height), **total artwork height** (everything including eyelets and descenders). |
| R5 | **Live preview** of the selected name showing exactly what will be exported — black outline, red engrave lines, and the resulting width × height in the chosen unit. |
| R6 | Export **SVG and PDF**, his choice per export. |
| R7 | Export either **one file per name, zipped**, or **all names on one sheet** — his choice at export time, both available. |
| R8 | Output must import into CorelDRAW with cut and engrave separable. |

## 3. What already exists (tested, do not modify without re-running the tests)

```
nameplate_core.py     the engine. No UI, no globals, no file dialogs.
nameplate_cli.py      command-line front end — proves the engine works, and is the
                      reference for how the GUI should call it
fonts/                the three real production fonts, for testing
golden/               known-good output to compare against
names_example.txt     sample batch input
```

### The engine's API — this is all the GUI needs

```python
from nameplate_core import (Font, build_document, svg_single, svg_sheet,
                            pdf_document, pdf_sheet, stack, safe_filename, summary)

font = Font(r"fonts\MerriweatherCut3Black-Engrave-v2.ttf")   # open once, reuse
font.family            # "Merriweather-Cut3 Engrave v2 Black" -> dropdown label
font.colr              # non-empty dict = this font carries engrave lines

doc = build_document(font, "ADAM", height=1.0, unit="in", basis="cap")
doc.cut_paths          # [[ [(x,y), ...], ... ]]  closed contours, FONT UNITS
doc.engrave_paths      # [ [(x,y), ...], ... ]    open polylines, FONT UNITS
doc.bbox               # (x0, y0, x1, y1) font units
doc.scale              # font units -> doc.unit  (multiply)
doc.size()             # (width, height) in doc.unit  -> show this in the UI
doc.warnings           # list[str] -> show these to the user, they are not errors

svg_single(doc)                 -> str          one name
svg_sheet(docs, gap=0.25)       -> str          all names stacked, gap in doc unit
pdf_document(docs)              -> bytes        one PAGE per name
pdf_sheet(docs, gap=0.25)       -> bytes        one page, all names
stack(docs, gap)                -> Document     the sheet as a Document, for preview
safe_filename("Mary Jane")      -> "Mary_Jane"  use for file names inside the zip
```

**For the preview, draw `doc.cut_paths` and `doc.engrave_paths` yourself** — multiply
by `doc.scale`, and remember font units have **y pointing up** while screen y points
down, so flip. Cut = black hairline, engrave = red. Do not render the SVG to draw the
preview; just draw the polylines. That keeps the preview instant.

## 4. GUI

Framework: **PySide6**. Single window, no wizard. Rough layout:

```
┌────────────────────────────────────────────────────────────────────┐
│ Font  [Merriweather-Cut3 Engrave v2 Black  ▾]  [Add font…] [Refresh]│
│         ↳ small grey line: file name + date, and                    │
│           "carries engrave lines" / "cut only"                      │
├──────────────────────────────┬─────────────────────────────────────┤
│ Names (one per line)         │  PREVIEW                            │
│ ┌──────────────────────────┐ │  ┌───────────────────────────────┐  │
│ │ ADAM                     │ │  │                               │  │
│ │ OLIVIA                   │ │  │   outline + red lines drawn    │  │
│ │ Mary Jane                │ │  │   for the highlighted name     │  │
│ └──────────────────────────┘ │  └───────────────────────────────┘  │
│                              │  ADAM — 4.053 × 1.015 in            │
│ Height  [1.00]  ( )mm (•)in  │  6 cut contours, 10 engrave lines   │
│ Measured from:               │  ⚠ warnings appear here             │
│  (•) cap height of 1st capital                                     │
│  ( ) x-height (lowercase)                                          │
│  ( ) total height of artwork                                       │
├────────────────────────────────────────────────────────────────────┤
│ [ Export one file per name (.zip) ]   [ Export all on one sheet ]   │
│ Format: [x] SVG  [x] PDF        Sheet gap: [0.25]                  │
└────────────────────────────────────────────────────────────────────┘
```

Behaviour:

* **Font list** = every `.ttf/.otf/.ttc` in the `fonts/` folder **next to the exe**,
  plus any the user adds. "Add font…" copies the chosen file into `fonts/` so it
  travels with the folder. Group by `font.family`; when two files report the same
  family, default to the newest file mtime and show the date so he can tell them
  apart. "Refresh" rescans — he will drop in updated fonts while the app is open, and
  this must pick them up without a restart. Remember the last used font in
  `settings.json` next to the exe (not in the registry or AppData — the folder must
  be self-contained and portable).
* **Preview** updates on any change (font, name selection, height, unit, basis) and is
  debounced ~150 ms so typing stays smooth. Preview the name the caret is on; if the
  box is empty, show nothing and disable export. Draw a faint bounding box with the
  width/height labelled, so the physical size is obvious. Zoom to fit; scroll wheel
  zooms.
* **Height** accepts decimals, minimum 0.05 in / 1 mm. Switching mm↔in **converts the
  number** so the artwork doesn't silently resize.
* **Warnings** from `doc.warnings` show in the preview panel in amber. They are
  informational, e.g. "No engrave lines for this name — cut path only" for an all-caps
  name in a font whose engrave lines only trigger before lowercase. Never block export.
* **Export buttons** are the only export path. Per-name mode → one file per name,
  named `Mary_Jane.svg` / `Mary_Jane.pdf`, zipped, ask where to save the zip. Sheet
  mode → ask for a file name and write `sheet.svg` / `sheet.pdf`. If both formats are
  ticked, the per-name zip contains both for each name. Show a progress bar for more
  than ~10 names and keep the UI responsive (build in a worker thread; `Font` objects
  are not thread-safe, so create one per worker or serialise the work).
* Errors (bad font, unreadable file) → a dialog with the actual message, never a
  silent failure.

## 5. Output contract — this is what makes CorelDRAW behave

Both writers are already implemented; do not change them without re-reading this.

* **SVG**: two groups, `id="CUT"` and `id="ENGRAVE"`. `fill="none"` on both. Stroke
  `#000000` and `#FF0000`. Stroke width = 0.001 in (expressed in the doc's unit).
  `width`/`height` on the root `<svg>` carry real units (`in` or `mm`) and the viewBox
  matches, so Corel imports at the right physical size.
* **PDF**: stroke width `0` — the PDF way of saying "thinnest line the device can
  draw", which Corel reads as hairline. Colours are `0 0 0 RG` and `1 0 0 RG` (pure
  RGB red so the laser software can map it to a layer). Page size = artwork + 6 pt
  margin. One page per name.
* **Cut path keeps its Bézier curves.** The union is done with `skia-pathops`, not by
  flattening. Do not swap in a polygon library.
* **Engrave lines are open paths.** They must never be closed or filled — a closed
  hairline band would cut/engrave twice.

## 6. Packaging — the deliverable Sean actually wants

```
pip install pyinstaller
pyinstaller --noconfirm --onedir --windowed --name NameplateCutFiles ^
            --add-data "fonts;fonts" nameplate_gui.py
```

* **`--onedir`, not `--onefile`.** He wants a folder he can copy; onefile unpacks to
  temp on every launch and is slower.
* Ship the result as `NameplateCutFiles\` containing `NameplateCutFiles.exe`,
  the `_internal` folder, a writable `fonts\` folder, and `README.txt`.
* `fonts/` and `settings.json` must live **next to the exe** and be writable. When
  frozen, resolve that folder from `sys.executable`, not `__file__`:

```python
import sys, os
BASE = (os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
        else os.path.dirname(os.path.abspath(__file__)))
FONTS_DIR = os.path.join(BASE, "fonts")
```

* Verify the build on a machine with **no Python installed**. Check: app launches,
  fonts list, preview draws, both exports produce files that open in Corel.
* `shapely` and `uharfbuzz` ship binary wheels; PyInstaller usually finds their DLLs.
  If `shapely` fails at runtime with a GEOS error, add
  `--collect-binaries shapely`. If PySide6 fights back, `--collect-all PySide6`.
* No admin rights, no network at runtime.

## 7. Acceptance tests

Run these before calling it done. Numbers came from the tested engine — a mismatch
means something broke.

```
python nameplate_cli.py --font fonts/MerriweatherCut3Black-Engrave-v2.ttf \
    --height 1 --unit in --basis cap --format both --mode per-name --out out ADAM
```
expect: `ADAM: 4.053 x 1.015 in | 6 cut contour(s), 10 engrave line(s)`

| test | expectation |
|---|---|
| Merriweather, `ADAM`, cap 1 in | 4.053 × 1.015 in, 6 cut contours, 10 engrave lines |
| Merriweather, `OLIVIA`, cap 1 in | 4.243 × 1.000 in, 4 cut contours, 13 engrave lines |
| Merriweather, `Mary Jane`, cap 1 in | 2 separate cut pieces are NOT expected — the second word's eyelet touches the first word, so it unions into one piece. Just check it renders. |
| Carrie Flourish, `Carrie`, cap 25 mm | 107.746 × 25.035 mm, 8 cut contours, 1 engrave line |
| Carrie Flourish, `ADAM`, cap 1 in | 0 engrave lines + the warning. Correct: that font's engrave line only fires before a lowercase letter. |
| Carrie SO (no flourish), any name | 0 engrave lines + "no COLR table" warning. Correct, that font has no engrave lines. |
| `A` (single letter), any font | cut path only, no engrave, no crash |
| x-height basis, Merriweather, `Adam` | uses the font's own x-height (1097 units), not the name's tallest letter |
| unit switch | 1 in ↔ 25.4 mm produces artwork of the same physical size |
| PDF | `qpdf --check` passes; page size = artwork + 12 pt total; opens in Corel |
| SVG | opens in Corel at the stated physical size; CUT and ENGRAVE selectable separately |

`golden/` holds reference SVG/PDF from the tested engine. Compare visually after any
change to the exporters.

## 8. Traps — bugs already hit and fixed, don't reintroduce them

1. **`pathops.Path.transform()` returns a new path, it does not mutate.**
   `piece.transform(...)` silently does nothing; you must assign the result. This cost
   an hour: every letter unioned at x=0 and the artwork came out as garbage.
2. **Composite glyphs must be decomposed.** A plain `RecordingPen` records
   `addComponent` and my flattener ignored it, so every composite glyph vanished —
   Merriweather's variant glyphs are all composites, so whole letters disappeared with
   no error. Use `DecomposingRecordingPen(glyphSet)`, and for pathops pass
   `path.getPen(glyphSet=...)`.
3. **A new `moveTo` must close the previous contour.** skia-pathops does not always
   emit `closePath`, so contours get dropped if you only collect on close.
4. **`shapely.ops.linemerge` throws on a single LineString.** Check the geom type
   first.
5. **A band can graze more than one letter edge**, producing duplicate engrave lines.
   The engine dissolves them with `unary_union` + `linemerge`; keep that.
6. **Enable the font's features when shaping.** `{"calt", "liga", "kern", "rlig"}` —
   Merriweather's eyelets and engrave variants ride on `calt`, the Carrie fonts' ride
   on `liga`. Shaping without them silently produces plain letters and no eyelets.
7. Don't measure cap height from the substituted glyph — the eyelet form can be taller.
   The engine measures the base letter from `cmap`.

## 9. Deliberately out of scope for v1

* Fonts whose colour is only in an `SVG ` table and not `COLR` — engrave detection
  reads `COLR` v0. All three production fonts have both, so this is fine today.
* DXF export, nesting/tiling to a sheet size, kerf compensation, engrave-line
  thickness options, multi-line names inside one piece.
* Mac build.

## 10. If anything here conflicts with what Sean says, he wins

Ask him rather than guessing. He is quick to answer and prefers a question to a
rebuild.

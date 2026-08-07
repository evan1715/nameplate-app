# TypeScript port — Sean's Font Prototyping Friend

A conversion of the Python nameplate cut-file engine to TypeScript. The geometry is
not re-derived: it is reproduced, and the tests prove it against the same
`golden/` files the Python suite uses.

## Running it

```
cd ts
npm install
npm test                       # every suite; brief alone takes ~11 min
npm run cli -- --font ../fonts/MerriweatherCut3Black-Engrave-v2.ttf \
    --height 1 --unit in --basis cap --format both --mode per-name --out out ADAM
```

Expected from that CLI line, matching the Python original exactly:

```
ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)
```

## How the Python libraries map across

| Python | TypeScript | Why this one |
|---|---|---|
| `uharfbuzz` | `harfbuzzjs` | the same HarfBuzz, compiled to WASM — identical shaping |
| `skia-pathops` | `canvaskit-wasm` + `src/skia.ts` | the same Skia `Op()`; `skia.ts` re-implements skia-pathops' two post-processing passes |
| `shapely` | `jsts` | shapely → GEOS → JTS → jsts, so the same algorithms and the same edge cases |
| `fontTools` | `harfbuzzjs` + `opentype.js` | HarfBuzz draws the outlines (and decomposes composites); opentype.js reads the tables |

`src/skia.ts` is the load-bearing file. `skia-pathops` is not a bare wrapper around
Skia: `op()` defaults to `fix_winding=True, keep_starting_points=True`, which
re-orders the result's contours by area, reverses the ones whose direction
disagrees with their even-odd nesting, and rotates each contour back onto an input
contour's starting point. Skip any of that and the artwork is geometrically correct
but the exported path data differs, so the golden files stop matching. All three
passes are ported line for line from `_pathops.pyx`.

## What is verified

| Suite | Python | TypeScript |
|---|---|---|
| `acceptance_tests.py` / `tests/acceptance.ts` | 53/53 | 53/53 |
| `export_tests.py` / `tests/export.ts` | 31/31 | 31/31 |
| `tests/parity.ts` (new: TS vs Python, value by value) | — | 68/68 |
| `tests/thickness.ts` (reports compared character for character) | — | 61/61 |
| `tests/fontcheck.ts` (reports and repair prompts, character for character) | — | 24/24 |
| `tests/pairsheet.ts` (all 5,408 cells per font, plus the prompts) | — | 34/34 |
| `tests/brief.ts` (exit codes, markdown byte-exact, JSON structure exact) | — | 15/15 |
| `tests/viewmodel.ts` (the window's labels, against the Qt selftest's own strings) | — | 24/24 |
| `tests/canonicalisation.ts` (audits the one change made to the Python) | — | 61/61 |

Node runs these directly — `node tests/parity.ts`, no loader, no build step — because
Node 22.18+/24 strips TypeScript types natively. That is why the sources import
`"./x.ts"` and why there are no `enum`s anywhere: an `enum` is the one construct that
must emit code, so it is rejected outright in strip-only mode.

`golden/ADAM_cap1in.svg`, `OLIVIA_cap1in.svg` and `sheet_ADAM_OLIVIA.svg` come out
**byte-identical**. So do the shipping exporter's SVG files and the PDF content
streams, checked against the Python CLI's own output.

## Two documented deviations

1. **`golden/Carrie_cap25mm.svg`** — one number in the ENGRAVE path reads
   `25.9740` where GEOS produces `25.9739`. That point comes out of a
   polygon/line intersection and jsts rounds the last place differently. The
   difference is 0.0001 mm, four orders finer than any laser kerf; all 78,643 other
   characters match. The test asserts identical text plus a 1e-4 numeric tolerance.

2. **PDF Flate encoding** — Python's zlib 1.3 and Node's zlib 1.3.1 make different
   (equally valid) compression choices, and no combination of level, memLevel or
   strategy bridges them. The **decompressed content stream is byte-identical**, so
   every reader sees the same drawing; only the compressed bytes differ. Tests
   compare the inflated stream, and the uncompressed writer byte-for-byte.

## Layout

```
src/skia.ts       skia-pathops on top of CanvasKit — the union, and its two passes
src/geom.ts       the shapely calls the engine makes, on jsts
src/pyformat.ts   Python's %.4f / str(float) / %g, exactly (BigInt, round-half-even)
src/font.ts       one font file: shaping, outlines, COLR/CPAL, cmap, metrics
src/core.ts       the engine: shaping -> union -> engrave lines -> SVG/PDF
src/layout.ts     multi-name sheet arrangement
src/leadin.ts     laser lead-in lines, merged into their contours
src/exporters.ts  the SHIPPING exporter: cut order + per-name groups/layers
src/eyelets.ts    measures the hanging eyelet (ID / OD / wall)
src/cli.ts        batch export without a GUI
src/thickness.ts  the thin-spot survey, its report and its paste-ready prompt
src/fontcheck.ts  what is WRONG with a font, and the repair order for it
src/pairsheet.ts  every two-letter join a font can make, measured
src/brief.ts      one pass over a font, judged against targets; the exit code IS the answer
src/viewmodel.ts  everything the window shows, computed with no window
tests/            the ported suites, plus the TS-vs-Python parity suite
```

## Build and verify scripts (the PowerShell conversions)

| PowerShell | TypeScript | Notes |
|---|---|---|
| `build_all.ps1` | `scripts/build_all.ts` | manifest → all suites → typecheck → esbuild bundle → stage fonts/docs → prove the bundle → tar.gz. Refuses to package if any suite fails, same as the original. |
| `verify_release.ps1` | `scripts/verify_release.ts` | extracts the archive into a clean folder and drives it with a minimal environment. 21 checks pass; the 15 that exercise the Qt window are reported as SKIP rather than dropped. |
| `verify_venv.ps1` | `scripts/verify_install.ts` | throwaway directory, `npm install` from `package.json` alone, then the CLI, every module and all three suites inside it. |
| `make_manifest.py` | `scripts/make_manifest.ts` | content hash of every source + dependency versions → `assets/build_manifest.json`. |
| `verify_corel.ps1`, `verify_corel_order.ps1` | **not converted** | These drive CorelDRAW itself over COM to confirm what it actually imported. That is Windows-only automation against an installed, signed-in CorelDRAW; there is no Node binding for it, and the checks are meaningless without the application. The promises they verify (open lead-in paths, pierce points as start nodes, engrave at the bottom of the stack, one group/layer per name) are asserted structurally by `tests/export.ts` and `scripts/verify_release.ts` instead. |
| `make_assets.py` | **not converted** | Generates the `.ico` and the splash PNG for the Qt build. Both are desktop-window artefacts with nothing to serve here. |

```
node scripts/build_all.ts        # tests, bundle, archive
node scripts/verify_release.ts   # drive the archive from a raw extraction
node scripts/verify_install.ts   # prove package.json alone is enough
```

## What is NOT converted yet

Being explicit, because the line count is lopsided: the engine and the whole
shipping path are done and verified, and the measurement/reporting tools are not.

| Python module | Lines | Status |
|---|---|---|
| `nameplate_core.py` | 802 | ✅ `src/core.ts` — byte-identical output |
| `nameplate_layout.py` | 97 | ✅ `src/layout.ts` |
| `nameplate_leadin.py` | 627 | ✅ `src/leadin.ts` |
| `nameplate_export.py` | 267 | ✅ `src/exporters.ts` — byte-identical output |
| `nameplate_eyelets.py` | 538 | ✅ `src/eyelets.ts` |
| `nameplate_cli.py` | 274 | ✅ `src/cli.ts` |
| `nameplate_thickness.py` | 1502 | ✅ `src/thickness.ts` — reports byte-identical (see below) |
| `nameplate_fontcheck.py` | 1896 | ✅ `src/fontcheck.ts` — reports and repair prompts byte-identical |
| `nameplate_pairsheet.py` | 1162 | ✅ `src/pairsheet.ts` — analysis byte-identical; the Qt contact sheet goes with the GUI |
| `nameplate_brief.py` | 730 | ✅ `src/brief.ts` — exit codes and markdown identical; JSON exact but for last-bit floats |
| `nameplate_gui.py` | 4404 | ⬜ not converted — PySide6 window (see below) |
| `regression_tests.py` | 483 | ⬜ not converted — one test per fixed bug |
| `stress_test.py` | 346 | ⬜ not converted |

**The GUI is a framework port, not a language port.** `nameplate_gui.py` is 4,404
lines of PySide6 widgets, three threads and a custom-painted preview canvas. There
is no PySide6 for TypeScript, so converting it means choosing a new UI stack
(Electron, or a browser front end over a local server) and rebuilding the window
against that stack's own painting and threading model. That is a rewrite decision
to take deliberately, not something to smuggle into a conversion — so the Python
GUI is untouched and still runs (`python nameplate_gui.py`, 60/60 on its own
selftest) against the Python engine, which is also untouched.

The four measurement modules are ordinary ports, and the hard part is already done:
they need Skia path ops, shapely geometry, font access and Python-exact number
formatting, and `src/skia.ts`, `src/geom.ts`, `src/font.ts` and `src/pyformat.ts`
provide all four with the parity already proven.

## Thickness: ported, byte-identical, and what it cost to get there

`src/thickness.ts` reproduces the survey, the clustering, the report and the
paste-ready prompt. `tests/thickness.ts` holds it to the Python's own captured
output: every report is compared **character for character**, with no numeric
tolerance and nothing excluded.

Getting there required a change to the Python, and it is worth being explicit
about what and why.

### The bug was in the ring labels, not the geometry

The survey walks the material's boundary rings and measures across the stroke at
sampled segments. The two backends produced *bit-identical* rings — verified
vertex for vertex, maximum coordinate deviation exactly zero — but listed them
differently:

* **which vertex** each closed ring starts from, and
* **what order** the holes come in.

Both are artefacts of the overlay algorithm. shapely drives GEOS 3.13 (OverlayNG),
which starts each ring at a computed intersection node; jsts 2.12 still uses the
older `OverlayOp` and starts at an original input vertex. Measured directly, *every
overlay operation rotates the exterior ring's start by exactly one vertex* — so the
label encodes nothing but how many booleans happened to build the mask.

That would be harmless, except `_walk` strides segments from each ring's start. The
arbitrary label therefore decided *which segments got measured*, and a different
subset finds a slightly different set of thin spots. The symptom was a divergence
of 0.1% on ADAM up to 16.8% on Carrie SO "Bob".

### The fix, in both implementations

`_canonical_rings` (Python) / `canonicalRings` (TypeScript) anchors every ring to
its lexicographically smallest vertex and sorts the rings by that anchor. This is
safe because the anchor is a real vertex: distinct x values inside one ring are at
least 1e-4 font units apart here, many orders of magnitude clear of
double-precision noise, so either backend picks the identical vertex.

The survey is now a property of the artwork rather than of the GEOS build — and
reproducible by any second implementation.

### What that changed in the Python's output

Canonicalising changes which segments the *Python* samples too, so its own reported
output moved. Unchanged: every thinnest reading, and both figures
`regression_tests.py` pins as double-derived truth (ADAM 72.8 font units,
CHRISTOPHER 18.1), each still a parallel-walled web. Changed:

| case | areas before | after | note |
|---|---|---|---|
| Merriweather ADAM | 16 | 16 | reading count 1036 → 1035 |
| Merriweather CHRISTOPHER | 24 | 23 | see the tie below |
| Carrie Flourish "Carrie" | 17 | 15 | |
| Carrie SO "Bob" | 16 | 12 | |

The one visible change worth knowing about: CHRISTOPHER's worst spot is a genuine
tie — two places both measuring 0.0122 in / 18.1 font units — and it is now
reported as `C (C.ini) lower right` instead of `H (H.e3) lower left`. Which of the
two came first was decided by ring order, i.e. by nothing. All three Python suites
still pass unchanged (regression 27/27, acceptance 53/53, export 31/31).

The baseline in `tests/refs/` was re-captured from the canonicalised Python, so it
still records what the Python does — with one non-reproducible artefact removed.

### The circularity, and how it is closed

Re-capturing from a Python I had just modified makes one pairing circular: for the
numbers that moved, `tests/thickness.ts` proves only that the TypeScript agrees
with a *changed* Python, not that either agrees with the original. Both sides could
have drifted together.

`tests/refs_precanonical/` and `tests/canonicalisation.ts` close that. The
directory holds the baseline exactly as captured **before** the ring set was
canonicalised (from commit `2e07c61`), and the test compares the two directories to
pin what moved. It runs no geometry and loads no font — it compares committed text —
so it is deterministic everywhere and finishes instantly. **58/58.**

What it enforces:

* the thinnest reading and its font-unit figure are **bit-for-bit identical** on all
  five cases, as is letter attribution and the number of points walked;
* the delta is exactly the audited one — areas `16→12`, `17→15`, `16→16`, `24→23`
  and readings `609→674`, `596→589`, `1036→1035`, `3053→3037`, no more and no less;
* every moved line in every report is one of seven allowed kinds (the reading-count
  line, a top-8 table row, a spot's own measurement, a spot heading, a cluster's
  reading count, and the two lines of the singleton note) — a moved heading, units
  legend, prose line or target verdict fails;
* ADAM_t's paste-ready prompt — the artefact that actually leaves the building — is
  **byte-identical**, and every line mentioning the target is unchanged;
* the `brief_*` refs moved only where they quote a thickness number, and every
  `"thinnest"` value in them is unchanged.

It is verified to actually bite: changing one digit of one thickness in one ref
makes it fail. And one of its own checks was silently vacuous at first — the
column-header pattern matched nothing on the target-form report, so it compared an
empty list to an empty list — so the test now also asserts that each structural
line it looks for was *found*.

Writing it caught a real mistake, too. The obvious pre-change baseline was commit
`2541163`, but that one predates a separate fix (`capture_baseline.py` was not
passing `font=` to `survey`, so letters were unattributed and its numbers came from
a different run than its report text). Pinning against it would have blamed
canonicalisation for that fix as well.

### Reproducibility of the oracle itself

The re-capture exposed three values that could never have matched twice, on any
machine: how many event-loop turns the GUI managed alongside a background check, a
`"seconds"` timing in the brief's JSON, and the join scan's `untested=` count
(whatever did not fit in the wall-clock budget). All three are now scrubbed, and
`capture_baseline.py` was run **twice end to end** to confirm two independent
captures agree byte for byte.

Scrubbing the `"seconds"` field then broke something quietly, which is worth
recording: substituting a bare placeholder where a *number* had been left
`"seconds": <T>`, and that is not JSON. The reference files still looked plausible
and only failed when something tried to parse one. `capture_baseline.py` now
refuses to write a `.json` reference that does not parse — checked at the moment of
writing, on both paths that produce one, since the brief writes its own files
rather than going through the shared writer.

### The one line that cannot match

The prompt's "how it will be checked" line names the tool to re-run. The Python
prints `python nameplate_thickness.py ...`, which would send a reader to a file
this tree no longer ships, so the TypeScript prints `node src/thickness.ts ...`.
The test normalises exactly that one token and still requires every argument after
it to match.

## Fontcheck: ported, byte-identical on the first run

`src/fontcheck.ts` reproduces the defect detector, the winding check, the
letter-pair join scan, the human report and the paste-ready repair prompt.
`tests/fontcheck.ts` holds all of it to the Python's captured output, compared
**character for character** with no tolerance and nothing excluded. **24/24**,
across all three shipped fonts — including the 9.5 KB Flourish repair prompt with
its junction coordinates, glyph IDs and contextual-alternate reasoning.

Two things made that possible, and both were bugs found on the way.

### textwrap was not what it looked like

Every line of prose in these reports goes through Python's `textwrap.fill`, and
`src/pyformat.ts` had a hand-rolled greedy wrapper with a comment explaining that
it deliberately did *not* split long words, "because a glyph name like
`eflourishrightring` is one word and splitting it mid-name would make it
unsearchable."

That was wrong. Python's defaults are `break_long_words=True` and
`break_on_hyphens=True`: it *does* cut a word longer than the line, and it splits
hyphenated words into separate chunks so a line may legally end on a hyphen. A
repair prompt is full of long glyph names and hyphenated compounds, so the
disagreement would have landed on exactly the lines a font editor acts on.

`wrapText` is now a real port of `_wrap_chunks` and `_handle_long_word`, including
`wordsep_re`. It is differential-tested against Python across **3,828 cases** —
828 drawn from the real reference files plus 3,000 fuzzed — and agrees on every
one. The last disagreement was a single trailing space: when a line is exactly
full, `_handle_long_word` appends an *empty* string, and Python's single
trailing-whitespace drop removes that empty string instead of the space before it.
Skipping the empty append strips the space. That one is now commented in place,
because it looks like dead code and is not.

### A CLI guard that fired inside the test

`src/cli.ts` decided whether it was the entry point with
`import.meta.url.endsWith(path.basename(process.argv[1]))`. That is true for *any*
file with the same basename — so `tests/fontcheck.ts` importing `src/fontcheck.ts`
made the module believe it had been run directly. The first test run printed the
CLI usage text and exited 0 without asserting anything. Both files now compare a
resolved `file://` URL.

### Notes on the port

* Where the Python reaches for fontTools' parsed tables, this reads the few values
  it needs straight off the table bytes (`Font.rawTable`, `postFormat`,
  `colrVersion`). The questions being asked are "is this table PRESENT" and "what
  version is it", and a parser that helpfully synthesises a default answers both
  wrongly.
* Glyph names agree exactly. Both fonts that report `post` format 3.0 are CFF, and
  fontTools and opentype.js both take the real names from the CFF charset — so
  `Dleftring` really is glyph ID 271 on both sides, which is what the prompt tells
  an editor to open.
* `geom.ts` gained `nearestPoints` (jsts `DistanceOp`), returning the pair in
  shapely's order: the point on `a` first. The instruction depends on that order,
  because it says which glyph's ink stops where and which glyph's ink it must reach.
* The join scan is bounded by wall clock, so the reference was captured with a
  600-second budget against a scan that finishes in about 16 — every combination is
  tested on both sides and nothing is timing-dependent. All 8,788 combinations, on
  every font.

## Pairsheet: the analysis half, byte-identical

`src/pairsheet.ts` reproduces `analyse_pairs` and `claude_prompt`.
`tests/pairsheet.ts` is **34/34** on both shipped script fonts.

The assertion that matters is not the prompt — it is `pairsheet_*_cells.json`, which
records the status and em-gap of **all 5,408 cells** per font. A port can look right
on the five pairs that fail and still have drifted on the thousands it passes, and
that file is the only thing that would notice. Every cell matches, on both fonts,
along with the per-group counts, the failing cells verbatim (shaped glyph names,
context string and cluster span included) and both prompts.

**The Qt contact sheet is deliberately not ported.** `render_sheet`, `_paint_cell`,
`_render_page` and `sheet_sizes` paint PNG grids with `QPainter`. That is a painting
layer against a specific toolkit, not analysis, and it belongs with the GUI port and
its own canvas — so it is left whole rather than half-translated. Everything the
tests and `brief` consume is in the analysis half.

Two things worth recording from this one:

* **A raw NUL byte in the source.** The Python keys `cells` on the tuple
  `(left, right)`; a JavaScript `Map` compares object keys by identity, so the pair
  has to be flattened into a string. My first version wrote the separator as a
  literal character that turned out to be a NUL: it looked like a space in the
  editor, made `grep` report the file as binary, and split wrongly wherever it was
  read back. NUL is still the right *choice* — no letter can contain it — it just has
  to be written down, so it is now `CELL_KEY_SEP = "\u0000"` with `cellKey` /
  `splitCellKey` around it and nobody splitting by hand.
* **`sort_keys=True`.** `capture_baseline.py` writes its JSON with sorted keys, so
  comparing a `JSON.stringify` of an equivalent object fails on key *order* while
  every value matches — which reads as five differing records and is really zero. The
  test compares canonical JSON now.

## Brief: the exit code is the contract, and it matches

`src/brief.ts` runs fontcheck, the full pair sweep, the artwork build, the eyelet
measurement and the thickness survey in one pass, judges the results against the
targets it was given, and says so in the exit code — 0 met, 1 work needed, 2
unusable, 3 tool error. A font-editing loop keys off that number, so it is the first
thing `tests/brief.ts` asserts. All three captured cases match: `0`, `1`, `1`.

**The markdown is byte-identical** on all three cases — that is the artefact a person
reads, and it rounds to 3 or 4 decimal places.

**The JSON is exact except in the last bits of a few floats.** Same 260–318 leaves in
the same ORDER (an agent diffing two runs sees a reordered object as a change), every
string, boolean and integer identical, and every differing float within a relative
1e-6. The worst actually measured is 6.4e-7, on a `change_pct` that amplifies its
inputs; the underlying measurements are ~9.7e-8 and every one traces to the eyelet —
an inner diameter reading 0.34476797 in against the Python's 0.34476794. Three parts
in a hundred million, about a nanometre on a 0.34-inch hole, and the same class as
the documented `Carrie_cap25mm.svg` deviation. It cannot reach the rounded figure the
markdown prints, which is why that file is compared exactly. The suite prints the
worst deviation it saw, so a regression shows up as that number growing rather than
as a silent pass.

Three things this one taught:

* **A control character in a sentinel.** Python renders an integral float as `1.0`
  and JavaScript renders it as `1`, so `dumpJson` marks those values before
  serialising. The marker was written with `\x01` around it — and `JSON.stringify`
  escapes control characters, so the escaped form no longer matched the un-escaped
  regex and the marker leaked into the output as
  `"\u0001FLOAT\u00011.0\u0001FLOAT\u0001"` where `1.0` belonged. Anything used as
  a sentinel has to survive the serialiser it is being hidden from; it is plain ASCII
  now, with a collision check before substituting. That is twice in this conversion
  that an invisible character in my own source caused a real bug — the other was a NUL
  in `pairsheet.ts`.
* **Normalise in both places or neither.** The thickness prompt's "how it will be
  checked" line names the tool to re-run. The markdown comparison normalised it; the
  JSON comparison did not — and `prompts.thin_areas` carries the same prompt as a
  string, so that one leaf failed while everything around it passed.
* **`nameplate_brief.py` forced the port order.** It calls `analyse_pairs`, and its
  captured output carries real pair data (`tested: 5408`), so it could not match the
  baseline until `pairsheet.ts` existed. Pairsheet went first for that reason.

## The GUI: the data layer first

`nameplate_gui.py` is 4,404 lines of PySide6 — widgets, three threads and a
custom-painted canvas. Reading its `--selftest` closely changes what the port looks
like, though: of its checks, almost all assert on **data and label text** — 
`ADAM — 4.069 × 1.020 in`, `6 cut contours, 10 engrave lines`, which overlays are
on, what the eyelet table reads, which junction broke — and only two count pixels in
a Qt-rendered image.

So the seam between "the app" and "the toolkit" sits exactly there, and that is where
this port is split, which is also the backend/frontend split asked for:

* **`src/viewmodel.ts`** owns everything up to and including the strings: the font
  list, the detail line under the picker, the preview build, lead-ins, the thin-area
  summary, the eyelet table cells, the target overlays and the piece/junction
  diagnosis. Every path it hands out is in doc units from the artwork's bottom-left,
  exactly as the Qt worker prepared them, so a renderer only has to flip Y and scale.
* **The front end** renders those strings and draws those polylines. It holds no
  measurement logic.

`tests/viewmodel.ts` holds the data layer to the strings the Qt window's own selftest
recorded — **24/24** — with no browser, no canvas and no display. What it deliberately
does not cover is those two pixel-counting checks: a different rasteriser paints the
same geometry and counts differently, and pretending otherwise would be a test that
asserts the wrong thing.

Two of these checks were wrong when first written, in the direction worth noting —
they *expected* the wrong value and would have "passed" a broken module if the module
had agreed with them:

* the cut-only check quoted `7 cut contours, 0 engrave lines`, which the selftest
  produced from the name **"Carrie"**, not from ADAM;
* the falls-apart check used `A M` on Merriweather, assuming a non-script font must
  break — but Merriweather Cut3's letters overlap by design and it cuts as one plate.
  It now uses `Dda` on the Flourish font, a junction `tests/pairsheet.ts`
  independently proves is a GAP (`Dleftring -> d`), and asserts both the piece count
  and the junction named.

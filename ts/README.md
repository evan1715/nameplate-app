# TypeScript port — Sean's Font Prototyping Friend

A conversion of the Python nameplate cut-file engine to TypeScript. The geometry is
not re-derived: it is reproduced, and the tests prove it against the same
`golden/` files the Python suite uses.

## Running it

```
cd ts
npm install
npm test                       # parity + acceptance + export suites
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
npx tsx scripts/build_all.ts        # tests, bundle, archive
npx tsx scripts/verify_release.ts   # drive the archive from a raw extraction
npx tsx scripts/verify_install.ts   # prove package.json alone is enough
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
| `nameplate_thickness.py` | 1502 | 🟡 `src/thickness.ts` — ported, 50/56 parity (see below) |
| `nameplate_fontcheck.py` | 1896 | 🟡 `src/fontcheck.ts` — shaping/area layer only; detector, join scan and report writer still to do |
| `nameplate_pairsheet.py` | 1162 | ⬜ not converted — every letter pair, every position |
| `nameplate_brief.py` | 730 | ⬜ not converted — the CLI an AI agent drives |
| `nameplate_gui.py` | 4404 | ⬜ not converted — PySide6 window (see below) |
| `regression_tests.py` | 483 | ⬜ not converted — one test per fixed bug |
| `stress_test.py` | 346 | ⬜ not converted |

`src/cli.ts` already has the hook for `fontcheck`: it imports `./fontcheck.js`
lazily and falls back to reporting the parse error on its own, so dropping in
`src/fontcheck.ts` with `checkFont(path, opts).text()` needs no other change.

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

## Thickness: ported, with one divergence that is not yet closed

`src/thickness.ts` reproduces the survey, the clustering, the report and the
paste-ready prompt. `tests/thickness.ts` holds it to the Python's own captured
output and passes **50 of 56** checks. What passes and what does not is worth
stating precisely, because the failures are not cosmetic:

**Matches exactly.** The thinnest reading on all five cases, to four decimal
places. The three worst spots' letters, thicknesses (within 0.5%) and wall-
parallelism ratios (within 0.02). And both figures `regression_tests.py` pins as
double-derived truth: ADAM 72.76 font units and CHRISTOPHER 18.13, each confirmed
as a parallel-walled web rather than a taper.

**Does not match.** How many boundary readings survive the wedge gate:

| case | TS readings | Python readings | apart | areas |
|---|---|---|---|---|
| Merriweather ADAM | 1035 | 1036 | 0.1% | 16 vs 16 |
| Merriweather CHRISTOPHER | 3062 | 3053 | 0.3% | 24 vs 24 |
| Carrie Flourish "Carrie" | 586 | 596 | 1.7% | 15 vs 17 |
| Carrie SO "Bob" | 732 | 609 | **16.8%** | 13 vs 16 |

The uniform walk itself is *identical* — same 1620 sample points, same 24786.67
perimeter on the Bob case — so the divergence is entirely in which readings pass
`crossWidth`'s wedge test (`room >= 0.42 x width`). A reading sitting on that
threshold falls either side of it depending on how jsts and GEOS round the
ray/boundary intersection. On three of the four cases that is a fraction of a
percent; on Carrie SO "Bob" it is 17%, which is too large to call rounding and has
not been traced yet.

Consequence: the *tail* of the top-8 list reorders, because entries 4–8 are
near-equal readings whose order depends on the surviving set. That is what the six
failing checks are — five report-text diffs and one letter-set difference on the
Flourish font. The thinnest reading, which is the number that decides whether a
plate snaps, is unaffected on every case.

The test deliberately still fails rather than widening its tolerance to go green.
Two checks it makes are recorded-not-asserted (the surviving-reading count and the
area count), and those are labelled as such in its output; the six failures are
real parity gaps that need the wedge-gate difference tracked down.

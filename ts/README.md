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
| `nameplate_thickness.py` | 1502 | ⬜ not converted — finds where a name will snap |
| `nameplate_fontcheck.py` | 1896 | ⬜ not converted — the font defect detector |
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

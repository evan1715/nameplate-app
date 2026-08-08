# Sean's Font Prototyping Friend — developer orientation

An app that turns a typed name into a laser-ready cut file (SVG/PDF) for
CorelDRAW, and measures whether the font can survive being cut out of sheet
metal.

Plain TypeScript on Node, with a React front end. No build system beyond
`npm`, no bundler in the loop while you work: Node 22.18+ runs TypeScript
directly, so `node tests/acceptance.ts` just runs. **VS Code** is the easy
choice; any editor works.

---

## Get it running (about five minutes)

```
cd ts
npm install
npm start                       # then open http://127.0.0.1:8175/
```

Node **22.18 or newer** specifically — that is the version that strips
TypeScript types natively. Node 24 LTS is the one to install.

Then, before changing anything:

```
npm run typecheck               # both projects: the engine and the client
npm test                        # every suite; the whole run is ~20 min
```

Or one at a time while you work:

```
node tests/acceptance.ts        # 55 checks, includes byte-identical golden files
node tests/export.ts            # 31 checks, the CorelDRAW export contract
node tests/regression.ts        # 27 checks, one per bug that has been fixed
node tests/gui.ts               # 60 checks, drives the real page in a real browser
```

All of them must pass before and after your change. `scripts/build_all.ts`
refuses to package if any of them fails.

---

## The shape of it

```
ts/src/
  core.ts           the engine: shaping, geometry, SVG/PDF writing
    ├─ leadin.ts        laser lead-in lines, merged into contours
    ├─ layout.ts        multi-name sheet arrangement
    ├─ exporters.ts     the SHIPPING exporter: cut order + per-name groups
    ├─ eyelets.ts       measures the hanging eyelet (ID / OD / wall)
    ├─ thickness.ts     finds where a name will snap
    ├─ fontcheck.ts     defect detector: what is wrong with a font
    └─ pairsheet.ts     every letter pair, in every position in a word

  skia.ts           skia-pathops on CanvasKit — the union, and its two passes
  geom.ts           the shapely calls the engine makes, on jsts
  font.ts           one font file: shaping, outlines, COLR/CPAL, cmap, metrics
  pyformat.ts       Python's %.4f / str(float) / %g / %e / round(), exactly

  viewmodel.ts      everything the window shows, computed with no window
  app.ts            the rest of the window that is not a widget: settings,
                    health, export jobs, prompt blocks, report texts
  pairgrid.ts       the contact sheet's model: rows, cells, scales, flagged walk
  marks.ts          mark colours and label text — pure, so the browser can have it
  units.ts          MM_PER_IN and the height floors — same reason
  server.ts         the engine behind an HTTP API, and the client it serves

  brief.ts          the CLI an AI agent drives. Measures + JUDGES, and puts the
                    verdict in the exit code.
  cli.ts            batch export without the window

ts/src/bin/         one entry file per command, each of which does nothing but
                    call a main() from the module beside it. They are separate
                    files for a reason — read src/bin/README.md before merging
                    one back into its module.

ts/client/          the React front end. Draws; owns no measurement logic.
ts/scripts/         build_all, verify_release, verify_install, make_manifest
```

Read in this order: `SPEC.md`, then `ts/README.md`, then `core.ts`'s module
comment, then whichever measurement module you are touching. Every module opens
with a comment explaining *why* it exists and what it deliberately does not do.

---

## Seven things that will bite you

**1. `core.ts` is sealed.** `tests/acceptance.ts` compares exported SVGs against
files in `golden/` **byte for byte**, and the golden PDFs by their inflated page
content. Changes to core must be additive — a new optional parameter, or a new
field with a default — and the goldens must stay identical. If a golden needs to
change, that is a decision to escalate, not a file to regenerate.

**2. Cut order is a manufacturing requirement, not a preference.** A part is
held by the surrounding sheet only until its outer edge is cut. So each name is
written engrave → inner holes → **outline last**, because cut order comes from
stacking order. `exporters.ts` owns this and `tests/export.ts` proves it. It has
been verified by driving CorelDRAW itself over COM.

**3. A lead-in must be part of its contour, never a separate line.** Laser
software cuts every path independently and will not join a stray line to a
nearby closed shape, so a "lead-in" drawn separately just gets cut off in the
scrap while the outline still pierces on the finished edge. `mergeRun()` emits
pierce → anchor → the whole contour → anchor as ONE open path. Do not "tidy" this
into separate geometry.

**4. Cap height is the cap LINE, not a letter's bounding box.** Two names set to
the same height must deliver the same size letters, so the scale comes from the
font's own cap line (`capReference`). Individual capitals read *over* that line
on purpose — type designers overshoot. At 1.000 in in the shipped Merriweather:
H/E/I/T = 1.000, A = 1.004, O = 1.029, J = 1.260. **All correct.** Flattening
that is the single most tempting wrong "fix" in this codebase; there are tests
and comments guarding it.

**5. Measurement and cutting use different fill rules.** The app *measures* with
containment parity but *cuts* with skia's winding union. A counter drawn in the
same direction as its outer contour cancels in the cut — the letter lasers as a
solid blob. `windingCheck()` in `fontcheck.ts` exists only to catch that
divergence. Keep the two models compared, never assume they agree.

**6. A module must not run itself.** Every command's entry point lives in
`src/bin/`. A self-invoking `if (import.meta.url === ...)` guard inside a module
is correct under Node and wrong under a bundler, which collapses every module
into one `import.meta.url` so all of them fire at once. That shipped a build in
which the app started, ran the font checker's CLI and exited. Nothing in the
suites bundles anything, so only `scripts/build_all.ts` — which starts what it
just built and asks it a question — can catch it.

**7. jsts does not index and GEOS does.** shapely's calls come back
instantaneous on geometry that makes jsts walk every segment. Two wall-clock
budgets in `tests/regression.ts` exist because of exactly that, and both were
blown by a naive translation. `geom.ts` has `IndexedBoundary` and an indexed
`prep()` for this — use them, and profile before guessing which call is hot.
Note that `prep().intersects` may prune by component envelope and
`prep().contains` may not: a shape can sit inside a collection's union without
sitting inside any single member.

---

## Where the numbers are formatted

Nowhere except `pyformat.ts`. Every number that reaches a file or a label goes
through `fmtF` / `pyFloat` / `pyG` / `fmtE` / `pyRound`, which reproduce
Python's formatting on the double's *exact* value using BigInt. This is not
pedantry: `toFixed` breaks an exact tie away from zero and C's `printf` breaks
it to even, and flattened Bézier points land on exact binary fractions like
5/32 often enough that the golden files stop matching.

`pyRound` is the one to watch. It is not `Math.round(v * 10**n) / 10**n` —
that rounds twice and disagrees near a tie, and its result is *compared* rather
than printed in the x-height check.

---

## Concurrency

`Font` objects are **not** safe to share across threads, and there are no
threads here — the browser talks to one Node process over HTTP, which is the
same arrangement Qt's worker thread had, one process further out.

- **The page** draws. It holds no measurement logic.
- **`server.ts`** owns a per-path `Font` cache, exactly like the Qt preview
  worker did. `Reload font` drops it, because picking up an edit made in a font
  editor while the app is open is that button's whole purpose.
- **Stale builds** are dropped by sequence number in the client: a thin-area
  scan takes seconds and the keystroke after it takes milliseconds, so without
  that the older answer lands last and the screen goes stale.

---

## Testing philosophy

`tests/regression.ts` is one test per bug that has actually happened, each with
a comment recording the measured evidence — for example that a lead-in used to
cut 0.0807 in through solid metal, or that a thin-area survey reported 126.20
font units where the truth was 72.76. Several tests deliberately disable the fix
and assert the old wrong number comes back, so they prove the *mechanism*, not
just the current output. If you change a measurement, expect to argue with these
files, and expect them to be right.

`tests/gui.ts` drives the real page in a headless Chromium over a real server.
Most of its checks run against `viewmodel.ts` and `app.ts` with no browser at
all — that is what those two modules are for — and only the handful that are
genuinely about the window need one.

`tests/refs/` holds the Python's own captured output, and several suites compare
against it character for character with no tolerance. `tests/refs_precanonical/`
holds the baseline from *before* the one change made to the Python engine, and
`tests/canonicalisation.ts` pins exactly what that change moved. Neither
directory is ever "refreshed" — re-capturing them is what would make the
comparison circular. `ts/README.md` explains this at length.

---

## Building

```
cd ts
node scripts/build_all.ts        # tests -> bundles -> staged folder -> tar.gz
node scripts/verify_release.ts   # extract somewhere clean, start the app out of
                                 # it, drive it over HTTP
node scripts/verify_install.ts   # prove package.json alone is enough
```

`make_manifest.ts` stamps a content hash of every source file into the bundle,
which the app shows under **Health** — that hash is how a bug report gets tied
to code.

`verify_corel.ps1` and `verify_corel_order.ps1` are still PowerShell and still
Windows-only: they drive CorelDRAW itself over COM to confirm what it actually
imported. There is no Node binding for that and the checks are meaningless
without the application installed. What they verify — open lead-in paths, pierce
points as start nodes, engrave at the bottom of the stack, one group/layer per
name — is asserted structurally by `tests/export.ts` and
`scripts/verify_release.ts` as well.

---

## Known gaps

`AUDIT_FINDINGS_2026-08-05.md` is a full audit of the Python original: 56
findings, of which the 2 critical and 7 high are fixed (with the fixes pinned in
`tests/regression.ts`) and the medium/low ones are documented but **not
implemented and not verified**. It refers to the Python file names; the fixes
and the gaps both carried across, so read it before assuming something is
covered. Notable open items: curves are exported as 24-step polylines rather
than true Béziers; an engrave line can vanish silently if every segment falls
under `MIN_ENGRAVE_LEN`; the thin-area wedge test is blind past roughly 33° of
wall convergence.

# Sean's Font Prototyping Friend — developer orientation

A Windows desktop app that turns a typed name into a laser-ready cut file
(SVG/PDF) for CorelDRAW, and measures whether the font can survive being cut out
of sheet metal.

Plain Python. No IDE required, no build system beyond a PowerShell script, no
framework. **VS Code** with the Python extension is the easy choice; PyCharm
works; so does any text editor.

---

## Get it running (about five minutes)

```
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python nameplate_gui.py
```

Python **3.12** specifically — the code uses PEP 701 f-strings that will not
parse on 3.11.

Then, before changing anything:

```
python acceptance_tests.py      # 53 checks, includes byte-identical golden files
python export_tests.py          # 31 checks, the CorelDRAW export contract
python regression_tests.py      # 27 checks, one per bug that has been fixed
python nameplate_gui.py --selftest out    # 60 checks, drives the real widgets
```

All four must pass before and after your change. `build_all.ps1` refuses to
package if the first three fail.

---

## The shape of it

```
nameplate_core.py       the engine: shaping, geometry, SVG/PDF writing
  ├─ nameplate_leadin.py     laser lead-in lines, merged into contours
  ├─ nameplate_layout.py     multi-name sheet arrangement
  ├─ nameplate_export.py     the SHIPPING exporter: cut order + per-name groups
  ├─ nameplate_eyelets.py    measures the hanging eyelet (ID / OD / wall)
  ├─ nameplate_thickness.py  finds where a name will snap
  ├─ nameplate_fontcheck.py  defect detector: what is wrong with a font
  └─ nameplate_pairsheet.py  every letter pair, in every position in a word

nameplate_gui.py        PySide6 front end (~4,000 lines). UI only — it owns no
                        geometry. Three threads: GUI, preview worker, report
                        worker.
nameplate_brief.py      the CLI an AI agent drives. Measures + JUDGES, and puts
                        the verdict in the exit code.
nameplate_cli.py        batch export without the GUI
build_all.ps1           tests -> PyInstaller -> zip -> Inno Setup installer
verify_release.ps1      extracts the built zip and drives the exe, 43 checks
```

Read in this order: `SPEC.md`, then `nameplate_core.py`'s module docstring, then
whichever measurement module you are touching. Every module opens with a
docstring explaining *why* it exists and what it deliberately does not do.

---

## Five things that will bite you

**1. `nameplate_core.py` is sealed.** `acceptance_tests.py` compares exported
SVGs against files in `golden/` **byte for byte**. Changes to core must be
additive — a new optional parameter, or a new dataclass field with a default —
and the goldens must stay identical. If a golden needs to change, that is a
decision to escalate, not a file to regenerate.

**2. Cut order is a manufacturing requirement, not a preference.** A part is
held by the surrounding sheet only until its outer edge is cut. So each name is
written engrave → inner holes → **outline last**, because cut order comes from
stacking order. `nameplate_export.py` owns this and `export_tests.py` proves it.
It has been verified by driving CorelDRAW itself over COM.

**3. A lead-in must be part of its contour, never a separate line.** Laser
software cuts every path independently and will not join a stray line to a
nearby closed shape, so a "lead-in" drawn separately just gets cut off in the
scrap while the outline still pierces on the finished edge. `merge_run()` emits
pierce → anchor → the whole contour → anchor as ONE open path. Do not "tidy" this
into separate geometry.

**4. Cap height is the cap LINE, not a letter's bounding box.** Two names set to
the same height must deliver the same size letters, so the scale comes from the
font's own cap line (`_cap_reference`). Individual capitals read *over* that line
on purpose — type designers overshoot. At 1.000 in in the shipped Merriweather:
H/E/I/T = 1.000, A = 1.004, O = 1.029, J = 1.260. **All correct.** Flattening
that is the single most tempting wrong "fix" in this codebase; there are tests
and comments guarding it.

**5. Measurement and cutting use different fill rules.** The app *measures* with
containment parity but *cuts* with skia's winding union. A counter drawn in the
same direction as its outer contour cancels in the cut — the letter lasers as a
solid blob. `winding_check()` in `nameplate_fontcheck.py` exists only to catch
that divergence. Keep the two models compared, never assume they agree.

---

## Threads

`Font` objects are **not** thread-safe. Each thread opens its own.

- **GUI thread** — widgets only.
- **Preview worker** (one, long-lived) — rebuilds the preview as you type, with
  its own `Font` cache. Stale queued builds skip themselves.
- **Report worker** (one, long-lived) — the click-driven analyses that take
  seconds. It opens a `Font`, does the work, and hands the object over with the
  result; the worker never touches it again.

A worker must never construct a widget. Worker exceptions are written to
`crash-*.txt` and returned to the GUI thread as plain strings.

---

## Testing philosophy

`regression_tests.py` is one test per bug that has actually happened, each with a
comment recording the measured evidence — for example that a lead-in used to cut
0.0807 in through solid metal, or that a thin-area survey reported 126.20 font
units where the truth was 72.76. Several tests deliberately disable the fix and
assert the old wrong number comes back, so they prove the *mechanism*, not just
the current output. If you change a measurement, expect to argue with these
files, and expect them to be right.

`nameplate_gui.py --selftest <dir>` drives the real widgets offscreen and writes
a report file. It is the only way to test a `--windowed` exe, which has no
stdout. Offscreen rendering has no font database, so text in those screenshots
appears as empty boxes — set `QT_QPA_PLATFORM=windows` when you need real text.

---

## Building

```
powershell -ExecutionPolicy Bypass -File build_all.ps1
powershell -ExecutionPolicy Bypass -File verify_release.ps1
```

Produces a per-user installer, a portable zip, and a single-file exe. UPX is
deliberately off (`--noupx`): UPX-packed PyInstaller exes are the biggest
antivirus false-positive trigger. `make_manifest.py` stamps a content hash of
every source file into the exe, which the app shows under **Health check…** —
there is no version control here, so that hash is how a bug report gets tied to
code.

Requires Inno Setup for the installer step; it is skipped with a warning if
absent.

---

## Known gaps

`AUDIT_FINDINGS_2026-08-05.md` is a full audit: 56 findings, of which the 2
critical and 7 high are fixed (with the fixes pinned in `regression_tests.py`)
and the medium/low ones are documented but **not implemented and not verified**.
Read it before assuming something is covered. Notable open items: curves are
exported as 24-step polylines rather than true Beziers; an engrave line can
vanish silently if every segment falls under `MIN_ENGRAVE_LEN`; the thin-area
wedge test is blind past roughly 33° of wall convergence.

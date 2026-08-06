ShineOn Nameplate Cut-File app — handoff package
================================================

WHAT TO DO WITH THIS
  Give this whole folder to Claude Code and tell it: "Build this per SPEC.md."
  SPEC.md is the brief. nameplate_core.py is the finished, tested engine —
  it should not need changes. What's missing is the GUI (nameplate_gui.py)
  and the PyInstaller build.

WHAT'S HERE
  SPEC.md               the build brief - read first
  nameplate_core.py     tested engine: shaping, letter merging, engrave lines,
                        SVG + PDF writers. No UI.
  nameplate_cli.py      command line front end; also the reference for how the
                        GUI should call the engine
  requirements.txt      dependencies
  fonts/                the three production fonts, for testing
  golden/               known-good output to compare against
  names_example.txt     sample batch input

TRY THE ENGINE FIRST (needs Python 3.10+)
  pip install -r requirements.txt
  python nameplate_cli.py --font fonts/MerriweatherCut3Black-Engrave-v2.ttf ^
      --height 1 --unit in --basis cap --format both --mode per-name --out out ADAM
  Expected: ADAM: 4.053 x 1.015 in | 6 cut contour(s), 10 engrave line(s)

THE POINT OF THE APP
  Type a name -> get a laser file: one merged outline, no fill, hairline stroke,
  red engrave lines kept as open centerlines, sized in mm or inches, as SVG and
  PDF, ready to import into CorelDRAW.

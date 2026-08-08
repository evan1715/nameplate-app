ShineOn Nameplate Cut-File app
==============================

Type a name, get a laser-ready cut file. One merged outline, no fill, hairline
stroke, red engrave lines kept as open centerlines, sized in mm or inches,
exported as SVG and PDF for CorelDRAW.

It also measures whether the font can survive being cut out of sheet metal —
where the letters are too thin, whether every pair of letters actually joins,
how big the hanging eyelet is — and writes paste-ready instructions for fixing
what it finds.


START HERE
  INSTALL.txt     how to run it (Node.js, two commands, opens in a browser)
  README_APP.txt  what every control does, and why
  DEVELOPERS.md   working on the code
  SPEC.md         the original build brief, kept as the record of what was asked


WHAT'S HERE
  ts/             the whole application — engine, tests, server and browser UI
    src/          the engine and the app layer
    client/       the React front end
    tests/        every suite
    scripts/      build, verify, manifest
  fonts/          the three production fonts
  golden/         known-good exported files, compared byte for byte by the tests
  names_example.txt   sample batch input


RUN IT
  cd ts
  npm install         once
  npm start           then open http://127.0.0.1:8175/

Or without the window, straight to files:

  npm run cli -- --font ../fonts/MerriweatherCut3Black-Engrave-v2.ttf \
      --height 1 --unit in --basis cap --format both --mode per-name --out out ADAM

  Expected: ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)


A NOTE ON HISTORY
  This was written in Python with a PySide6 desktop window, and converted to
  TypeScript. The conversion was not a rewrite: every suite the Python had was
  ported check for check and held to the Python's own captured output, and the
  exported SVG files still match `golden/` byte for byte. `ts/README.md` records
  what matched, what could not, and why — including the four places where the
  two disagree and the reason each one is unavoidable rather than unnoticed.

"""
nameplate_cli.py — command line front end for nameplate_core.

Exists so the engine can be tested without a GUI, and so the same logic can be
scripted for a batch of orders. The GUI must call the same functions.

    python nameplate_cli.py --font "MerriweatherCut3Black-Engrave-v2.ttf" \
        --height 1 --unit in --basis cap --format both --mode per-name \
        --out ./out ADAM OLIVIA "MARY JANE"

    python nameplate_cli.py --font Carrie.otf --height 25 --unit mm \
        --mode sheet --arrange horizontal --format svg --out ./out \
        --names-file names.txt

Every ordinary mistake — a typo'd path, a file that is not a font, a height that
cannot be drawn — answers with one line and a non-zero exit, never a traceback.
A batch of real orders is usually driven by a script or handed to an operator,
and neither can act on a stack trace. Nothing is written until the whole job is
known to be sound, so a refusal never leaves half an order on disk.
"""
import argparse
import math
import os
import sys

from nameplate_core import Font, build_document, safe_filename, summary
from nameplate_export import export_pdf, export_svg
from nameplate_layout import DIRECTIONS, VERTICAL, overlaps

# Below this the 4-decimal numbers in the SVG/PDF all round to 0.0000, so the
# file would look like a success and contain no artwork at all.
MIN_HEIGHT = {"in": 0.001, "mm": 0.03}

BAD_INPUT = 2                       # the code argparse itself uses for bad usage


def _fail(msg: str) -> int:
    """Refuse the job: one line the operator can act on, on stderr."""
    print(msg, file=sys.stderr)
    return BAD_INPUT


def _height_problem(height: float, unit: str) -> str | None:
    """Why this height cannot be drawn, or None.

    Checked before anything is built, because every one of these values reaches
    the exporter as a divisor or as literal text: inf/nan end up inside
    width="..." and /MediaBox, 0 raises deep in the exporter, and a hair-width
    height writes a file whose every coordinate has rounded to zero.
    """
    if not math.isfinite(height):
        return ("--height nan is not a number — give the finished height."
                if math.isnan(height) else
                "--height must be a real size, not infinity.")
    if height == 0:
        return "--height 0 has no size — give the finished height of the name."
    if height < 0:
        return f"--height must be positive — {height:g} is negative."
    floor = MIN_HEIGHT[unit]
    if height < floor:
        return (f"--height {height:g} {unit} is too small to export — "
                f"the artwork would round away to nothing. "
                f"The smallest usable height is {floor:g} {unit}.")
    return None


def _names_from_file(path: str) -> tuple[list[str], str | None]:
    """(names, problem). A folder or a binary file is a typo, not a crash."""
    if os.path.isdir(path):
        return [], f"--names-file {path} is a folder, not a text file."
    try:
        with open(path, encoding="utf-8-sig") as fh:
            names = [l.strip() for l in fh if l.strip()]
    except UnicodeDecodeError:
        return [], (f"--names-file {path} is not text — it looks like a binary "
                    f"file. Save it as plain UTF-8, one name per line.")
    except OSError as exc:
        return [], f"--names-file {path} cannot be read: {exc.strerror}."
    if not names:
        return [], f"--names-file {path} contains no names."
    return names, None


def _font_report(path: str) -> str:
    """The font checker's own defect report, so the user learns WHY it failed.

    Imported here rather than at the top: the checker is a convenience, and a
    missing or broken module must not turn a clear font error into an
    ImportError traceback.
    """
    try:
        import nameplate_fontcheck
        return nameplate_fontcheck.check_font(path, join_scan_budget=0).text()
    except Exception:
        return ""


def _load_font(path: str) -> tuple[Font | None, str | None]:
    """(font, problem). The cheap checks come first so the message is specific."""
    if not path.strip():
        return None, "--font is empty — give the path to a .ttf or .otf file."
    if os.path.isdir(path):
        return None, f"--font {path} is a folder, not a font file."
    if not os.path.isfile(path):
        return None, f"--font {path} does not exist."
    if os.path.getsize(path) == 0:
        return None, f"--font {path} is empty (0 bytes) — the copy failed."
    try:
        return Font(path), None
    except Exception as exc:
        report = _font_report(path)
        return None, (f"--font {path} is not a font this app can use "
                      f"({type(exc).__name__}: {exc})."
                      + (f"\n\n{report}" if report else ""))


def _make_out_dir(path: str) -> str | None:
    """Problem creating the output folder, or None."""
    try:
        os.makedirs(path, exist_ok=True)
    except FileExistsError:
        return f"--out {path} is an existing file, not a folder."
    except OSError as exc:
        return f"--out {path} cannot be created: {exc.strerror}."
    return None


def _write(path: str, data) -> None:
    """SVG is text, PDF is bytes; both may fail on a folder we cannot write."""
    if isinstance(data, bytes):
        with open(path, "wb") as fh:
            fh.write(data)
    else:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(data)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Name -> laser cut file (outline + engrave)")
    ap.add_argument("names", nargs="*", help="names to build")
    ap.add_argument("--names-file", help="text file, one name per line")
    ap.add_argument("--font", required=True)
    ap.add_argument("--height", type=float, required=True)
    ap.add_argument("--unit", choices=["in", "mm"], default="in")
    ap.add_argument("--basis", choices=["cap", "xheight", "total"], default="cap",
                    help="what the height refers to")
    ap.add_argument("--format", choices=["svg", "pdf", "both"], default="both")
    ap.add_argument("--mode", choices=["per-name", "sheet"], default="per-name")
    ap.add_argument("--arrange", choices=list(DIRECTIONS), default=VERTICAL,
                    help="sheet layout: stacked top to bottom, or left to right")
    ap.add_argument("--gap", type=float, default=0.25, help="sheet gap, in --unit")
    ap.add_argument("--out", default=".")
    args = ap.parse_args(argv)

    # A CLI run is usually redirected into a log. Windows pipes default to
    # cp1252, where a name like "Zoë名" (or our own – and ×) kills the very
    # print that reports success — AFTER files were written, so exit 1 lies to
    # the calling script. Replacing unencodable characters keeps the line
    # readable and the exit code honest.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    problem = _height_problem(args.height, args.unit)
    if problem:
        return _fail(problem)

    # the gap goes straight into geometry, so inf/nan poisons the file the
    # same way a bad height would — same rule, same wording
    if not math.isfinite(args.gap):
        return _fail(f"--gap must be a real size, not {args.gap}.")
    if args.gap > 1000:
        return _fail(f"--gap {args.gap:g} {args.unit} is bigger than any sheet "
                     f"— give the spacing between names.")

    names = list(args.names)
    if args.names_file:
        from_file, problem = _names_from_file(args.names_file)
        if problem:
            return _fail(problem)
        names += from_file
    if not names:
        ap.error("no names given")

    font, problem = _load_font(args.font)
    if problem:
        return _fail(problem)
    problem = _make_out_dir(args.out)
    if problem:
        return _fail(problem)

    docs = []
    for name in names:
        # Spaces and zero-width characters shape happily and cut nothing; left
        # in the list they take a slot on the sheet and break stacking. The
        # engine refuses them with a message of its own, so honour both that
        # refusal and a document that simply came back with no contours — one
        # bad line in a batch must not cost the operator the other orders.
        try:
            doc = build_document(font, name, args.height, args.unit, args.basis)
        except ValueError as exc:
            print(f"! skipped {name!r} — the engine refused it: {exc}",
                  file=sys.stderr)
            continue
        if sum(len(r) for r in doc.cut_paths) == 0:
            print(f"! skipped {name!r} — no cuttable outline "
                  f"(blank or invisible characters only).", file=sys.stderr)
            continue
        docs.append(doc)
        print(summary(doc))
        for w in doc.warnings:
            print(f"    ! {w}")
    if not docs:
        return _fail("None of the names given produce any artwork — "
                     "nothing to write.")

    written = []
    try:
        if args.mode == "sheet":
            # the boxes are known before any geometry is placed, so a gap that
            # would print one name on top of another is refused, not exported
            clash = overlaps(docs, args.gap, args.arrange)
            if clash:
                pairs = ", ".join(f"{docs[i].text!r}+{docs[j].text!r}"
                                  for i, j in clash[:4])
                return _fail(f"--gap {args.gap:g} {args.unit} makes these names "
                             f"overlap on the sheet: {pairs}. Nothing written — "
                             f"increase the gap.")
            stem = os.path.join(args.out, "sheet")
            # nameplate_export writes in CUTTING order — engrave, then the inner
            # holes, then the outline last — and gives each name its own group
            # (SVG) or layer (PDF). Writing through the core writers instead
            # would produce a file that cuts the outline first and drops the
            # part before the rest of the job is done.
            if args.format in ("svg", "both"):
                _write(stem + ".svg",
                       export_svg(docs, args.gap, args.arrange))
                written.append(stem + ".svg")
            if args.format in ("pdf", "both"):
                _write(stem + ".pdf",
                       export_pdf(docs, args.gap, args.arrange))
                written.append(stem + ".pdf")
        else:
            used: set[str] = set()
            for d in docs:
                base = safe_filename(d.text)
                stem, n = base, 1
                # '!' and '?' both clean to '_', and every CJK name cleans to
                # '__'; without this the second order overwrites the first.
                # Case-insensitive because Windows filenames are.
                while stem.lower() in used:
                    n += 1
                    stem = f"{base}_{n}"
                used.add(stem.lower())
                stem = os.path.join(args.out, stem)
                if args.format in ("svg", "both"):
                    _write(stem + ".svg", export_svg([d], args.gap, args.arrange))
                    written.append(stem + ".svg")
                if args.format in ("pdf", "both"):
                    _write(stem + ".pdf", export_pdf([d], args.gap, args.arrange))
                    written.append(stem + ".pdf")
    except OSError as exc:
        return _fail(f"Cannot write {exc.filename or args.out}: "
                     f"{exc.strerror or exc}.")

    for path in written:
        print("wrote", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())

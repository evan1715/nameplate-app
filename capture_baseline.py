"""
capture_baseline.py — freeze what the Python does, so the TypeScript can be held to it.

    python3.12 capture_baseline.py

Writes reference output for every module that is about to be converted into
ts/tests/refs/. This runs BEFORE the Python is deleted and is the only record of
what "the same inputs and outputs" means afterwards, so it deliberately captures
the full report text rather than a summary: a paraphrase would let a port drift.

Anything machine-specific (timestamps, hostnames, absolute paths, wall-clock
timings) is normalised out, because those cannot and should not match.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REFS = os.path.join(HERE, "ts", "tests", "refs")
FONTS = {
    "merri": os.path.join(HERE, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf"),
    "flourish": os.path.join(HERE, "fonts", "TGCarrieSOFlourish-v2.otf"),
    "carrie": os.path.join(HERE, "fonts", "TGCarrieSO-v2.otf"),
}

os.makedirs(REFS, exist_ok=True)


def write(name: str, text: str) -> None:
    path = os.path.join(REFS, name)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print(f"  wrote {name} ({len(text)} chars)")


def write_json(name: str, obj) -> None:
    write(name, json.dumps(obj, indent=1, sort_keys=True, default=str))


def scrub(text: str) -> str:
    """Remove anything that cannot match across machines or runs."""
    text = text.replace(HERE, "<ROOT>")
    # wall-clock timings: "9.3s", "0.42 s", "in 1.2s"
    text = re.sub(r"\b\d+\.\d+\s?s\b", "<T>s", text)
    # ISO-ish timestamps and dates
    text = re.sub(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}Z?", "<TIME>", text)
    text = re.sub(r"\d{4}-\d{2}-\d{2}", "<DATE>", text)
    # python version strings and build ids
    text = re.sub(r"3\.1[0-9]\.\d+", "<PYVER>", text)
    # How many event-loop turns the GUI managed while a background check ran. It
    # counts iterations of a real event loop against real wall-clock, so it lands
    # on a different number every run and on every machine; what the check is
    # actually asserting is "more than zero, and the report still arrived".
    text = re.sub(r"\b\d+ event-loop turns\b", "<N> event-loop turns", text)
    return text


# --------------------------------------------------------------------------- #
#  1. the existing suites, verbatim
# --------------------------------------------------------------------------- #
print("=== suites ===")
env = dict(os.environ, QT_QPA_PLATFORM="offscreen", PYTHONPATH=HERE)
for label, script in (("regression", "regression_tests.py"),
                      ("stress", "stress_test.py")):
    args = [sys.executable, os.path.join(HERE, script)]
    if script == "stress_test.py":
        args += ["--font", FONTS["merri"]]
    r = subprocess.run(args, cwd=HERE, env=env, capture_output=True, text=True)
    write(f"{label}.txt", scrub(r.stdout + r.stderr) + f"\nEXIT={r.returncode}\n")

# the GUI's own selftest, which is the only view inside the window
out = os.path.join(HERE, "_baseline_selftest")
subprocess.run([sys.executable, os.path.join(HERE, "nameplate_gui.py"),
                "--selftest", out], cwd=HERE, env=env, capture_output=True, text=True)
rep = os.path.join(out, "selftest_report.txt")
if os.path.exists(rep):
    write("gui_selftest.txt", scrub(open(rep, encoding="utf-8").read()))
    # the artefacts the selftest produced, so the port can be held to them too
    listing = sorted(os.listdir(out))
    write_json("gui_selftest_files.json",
               [{"name": n,
                 "bytes": os.path.getsize(os.path.join(out, n))} for n in listing])

# --------------------------------------------------------------------------- #
#  2. thickness
# --------------------------------------------------------------------------- #
print("=== thickness ===")
from nameplate_core import Font, build_document
import nameplate_thickness as TH

_fonts = {k: Font(v) for k, v in FONTS.items()}

THICK_CASES = [
    ("merri_ADAM", "merri", "ADAM", 1.0, "in", "cap", None),
    ("merri_ADAM_t", "merri", "ADAM", 1.0, "in", "cap", 0.05),
    ("merri_CHRISTOPHER", "merri", "CHRISTOPHER", 1.0, "in", "cap", None),
    ("flourish_Carrie", "flourish", "Carrie", 25.0, "mm", "cap", None),
    ("carrie_Bob", "carrie", "Bob", 1.0, "in", "cap", None),
]
thick_numbers = {}
for label, fk, name, h, unit, basis, target in THICK_CASES:
    doc = build_document(_fonts[fk], name, h, unit, basis)
    sv = TH.survey(doc, target, font=_fonts[fk])
    thick_numbers[label] = {
        "thinnest": sv.thinnest,
        "thinnest_fu": sv.thinnest / doc.scale if sv.thinnest else None,
        "n_areas": sv.n_areas,
        "n_below_target": sv.n_below_target,
        "samples_taken": sv.samples_taken,
        "samples_used": sv.samples_used,
        "reach": sv.reach,
        "letters_known": sv.letters_known,
        "note": sv.note,
        "n_spots": len(sv.spots),
        "spots": [{"letter": s.letter, "where": s.where, "glyph": s.glyph,
                   "char": s.char, "thickness": s.thickness,
                   "thickness_typical": s.thickness_typical,
                   "thickness_fu": s.thickness_fu,
                   "pos": list(s.pos), "across": [list(a) for a in s.across],
                   "n_samples": s.n_samples, "extent": s.extent,
                   "clearance": s.clearance, "parallel_walls": s.parallel_walls,
                   "note": s.note}
                  for s in sv.spots],
    }
    write(f"thickness_{label}_report.txt",
          scrub(TH.report_text(doc, target, font=_fonts[fk], sv=sv)))
    if target:
        write(f"thickness_{label}_prompt.txt",
              scrub(TH.claude_prompt(doc, target, font_path=FONTS[fk])))
write_json("thickness_numbers.json", thick_numbers)

# --------------------------------------------------------------------------- #
#  3. fontcheck
# --------------------------------------------------------------------------- #
print("=== fontcheck ===")
import nameplate_fontcheck as FC

fc_numbers = {}
for fk, fpath in FONTS.items():
    rep = FC.check_font(fpath, join_scan_budget=600)
    write(f"fontcheck_{fk}_report.txt", scrub(rep.text()))
    write(f"fontcheck_{fk}_prompt.txt", scrub(FC.prompt_for_font(fpath, 600)))
    fc_numbers[fk] = {
        "verdict": getattr(rep, "verdict", None),
        "n_findings": len(getattr(rep, "findings", [])),
        "findings": [{"severity": f.severity, "title": f.title,
                      "detail": getattr(f, "detail", None)}
                     for f in getattr(rep, "findings", [])],
        "facts": getattr(rep, "facts", None),
    }
    # the winding divergence check, which has its own regression test
    fc_numbers[fk]["winding"] = FC.winding_check(_fonts[fk])[:10]
write_json("fontcheck_numbers.json", fc_numbers)

# --------------------------------------------------------------------------- #
#  4. pairsheet
# --------------------------------------------------------------------------- #
print("=== pairsheet ===")
import nameplate_pairsheet as PS

ps_numbers = {}
for fk in ("flourish", "carrie"):
    rep = PS.analyse_pairs(_fonts[fk], budget_s=600)
    ps_numbers[fk] = {
        "family": rep.family, "upem": rep.upem,
        "n_groups": len(rep.groups),
        "n_pairs": rep.n_pairs, "n_tested": rep.n_tested,
        "n_failed": rep.n_failed, "n_untested": rep.n_untested,
        "n_missing": rep.n_missing, "budget_hit": rep.budget_hit,
        "groups": [{"key": g.key, "label": g.label, "mode": g.mode,
                    "left_chars": g.left_chars, "right_chars": g.right_chars,
                    "n_cells": len(g.cells), "n_tested": len(g.tested),
                    "n_failures": len(g.failures),
                    "n_untested": len(g.untested),
                    "n_missing": len(g.missing)}
                   for g in rep.groups],
    }
    write(f"pairsheet_{fk}_prompt.txt",
          scrub(PS.claude_prompt(_fonts[fk], rep, FONTS[fk])))
    # every failing cell, with the shaped glyph names that explain it
    failures = []
    for g in rep.groups:
        for (l, r), res in sorted(g.cells.items()):
            if res in g.failures:
                failures.append({"group": g.key, "left": res.left,
                                 "right": res.right, "status": res.status,
                                 "gap": res.gap, "gap_em": res.gap_em,
                                 "detail": res.detail, "glyphs": list(res.glyphs),
                                 "context": res.context,
                                 "span": list(res.span) if res.span else None})
    write_json(f"pairsheet_{fk}_failures.json", failures)
    # every cell, compactly, so a port cannot drift on the 5408 it does not fail
    cells = {}
    for g in rep.groups:
        for (l, r), res in sorted(g.cells.items()):
            cells[f"{g.key}|{l}|{r}"] = [
                res.status,
                round(res.gap_em, 6) if res.gap_em is not None else None,
            ]
    write_json(f"pairsheet_{fk}_cells.json", cells)
write_json("pairsheet_numbers.json", ps_numbers)

# --------------------------------------------------------------------------- #
#  5. brief — the exit code IS the contract
# --------------------------------------------------------------------------- #
print("=== brief ===")
BRIEF_CASES = [
    ("merri_met", "merri", ["--cap", "1", "--unit", "in",
                            "--min-thickness", "0.001"]),
    ("merri_unmet", "merri", ["--cap", "1", "--unit", "in",
                              "--eyelet-id", "0.4", "--eyelet-wall", "0.2",
                              "--min-thickness", "0.09"]),
    ("flourish", "flourish", ["--cap", "25", "--unit", "mm",
                              "--min-thickness", "0.5"]),
]
brief_exits = {}
for label, fk, extra in BRIEF_CASES:
    jpath = os.path.join(REFS, f"brief_{label}.json")
    mpath = os.path.join(REFS, f"brief_{label}.md")
    r = subprocess.run(
        ["/usr/bin/python3.12", os.path.join(HERE, "nameplate_brief.py"),
         "--font", FONTS[fk], "--json", jpath, "--md", mpath] + extra,
        cwd=HERE, env=env, capture_output=True, text=True)
    brief_exits[label] = {"exit": r.returncode,
                          "stdout": scrub(r.stdout), "stderr": scrub(r.stderr)}
    for p in (jpath, mpath):
        if os.path.exists(p):
            txt = scrub(open(p, encoding="utf-8").read())
            with open(p, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(txt)
            print(f"  wrote {os.path.basename(p)} ({len(txt)} chars)")
write_json("brief_exits.json", brief_exits)

print("\nbaseline captured into ts/tests/refs/")

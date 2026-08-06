"""
regression_tests.py — one test per defect found by the adversarial pass.

    python regression_tests.py

Each test reproduces a specific reported failure. A PASS means the defect is
gone; a FAIL means it is still live. Kept separate from acceptance_tests.py so
the two never get confused: that file says "the app does what it promises",
this one says "the app no longer does what it did wrong".
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

from shapely.geometry import LineString, Point

from nameplate_core import (Font, build_document, pdf_document, stack,
                            svg_single, safe_filename)
import nameplate_layout as LAY
import nameplate_leadin as LI

HERE = os.path.dirname(os.path.abspath(__file__))
MERRI = os.path.join(HERE, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf")
TG = os.path.join(HERE, "fonts", "TGCarrieSO-v2.otf")
PY = sys.executable
results = []


def check(ref, name, ok, detail=""):
    results.append((ok, ref, name, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {ref}  {name}")
    if detail:
        print(f"        {detail}")


f = Font(MERRI)
ftg = Font(TG)

# --------------------------------------------------------------------------- #
# #1 cap height must be the CAP height, not the first capital's total ink.
#    'J' and 'Q' descend below the baseline, which made JADAM ~20% smaller.
# --------------------------------------------------------------------------- #
gA = f.cmap[ord("A")]
ys = [p[1] for c in f.contours(gA) for p in c]
capA = max(ys)
heights = {}
for nm in ("ADAM", "JADAM", "QADAM"):
    d = build_document(f, nm, 1.0, "in", "cap")
    heights[nm] = capA * d.scale         # how tall the letter A actually is
spread = max(heights.values()) - min(heights.values())
check("#1", "cap height is independent of which capital starts the name",
      spread < 1e-6,
      "delivered height of 'A' at 1.000 in cap: "
      + ", ".join(f"{k}={v:.4f}" for k, v in heights.items())
      + f" (spread {spread:.6f} in)")

# and the documented ADAM numbers must be untouched by that fix
d_adam = build_document(f, "ADAM", 1.0, "in", "cap")
w, h = d_adam.size()
# ADAM's size moved deliberately when cap height became the font's own cap
# line instead of the first capital's total ink. What must hold now is that the
# CAP LINE lands exactly where it was asked to, for every name.
from nameplate_core import _cap_reference
_ref, _ = _cap_reference(f)
capline = {nm: _ref * build_document(f, nm, 1.0, "in", "cap").scale
           for nm in ("ADAM", "JADAM", "QADAM", "OLIVIA", "adam")}
check("#1b", "the cap line lands exactly at the requested height, every name",
      all(abs(v - 1.0) < 1e-9 for v in capline.values()),
      f"{w:.4f} x {h:.4f} in for ADAM; cap line = "
      + ", ".join(f"{k}={v:.6f}" for k, v in capline.items()))

# --------------------------------------------------------------------------- #
# #7 a name must not be able to break or inject into the SVG
# --------------------------------------------------------------------------- #
ok_xml, detail = True, []
for nm in ("Mary--Jane", 'A--> <rect width="9"/> <!--', "A<b>B", "A-"):
    try:
        s = svg_single(build_document(f, nm, 1.0, "in", "cap"))
        ET.fromstring(s)                      # must parse
        body = s.split("-->", 1)[1] if "-->" in s else s
        if "<rect" in body or "<b>" in body:
            ok_xml = False
            detail.append(f"{nm!r}: injected element")
    except Exception as exc:
        ok_xml = False
        detail.append(f"{nm!r}: {type(exc).__name__}")
check("#7", "a name cannot break or inject into the exported SVG",
      ok_xml, "; ".join(detail) or "all four hostile names parse, nothing injected")

# --------------------------------------------------------------------------- #
# #5b lead-in exporters must not KeyError on their own early exits
# --------------------------------------------------------------------------- #
ok_keys, detail = True, []
for label, kwargs in (("length 0", {"length_in_unit": 0.0}),
                      ("length negative", {"length_in_unit": -5.0})):
    try:
        LI.svg_single_leadin(d_adam, **kwargs)
        LI.pdf_document_leadin([d_adam], **kwargs)
    except Exception as exc:
        ok_keys = False
        detail.append(f"{label}: {type(exc).__name__}: {exc}")
info0 = LI.lead_in_report(d_adam, 0.0)
have_keys = all(k in info0 for k in
                ("leads", "runs", "closed", "holes", "outers",
                 "skipped_tiny", "failed", "holes_detail", "leads_detail"))
check("#5b", "lead-in exporters survive length 0 / negative",
      ok_keys and have_keys,
      "; ".join(detail) or f"all keys present on the early exit: {have_keys}")

# runs + closed must still account for every contour even on an early exit
n_rings = len(LI._rings(d_adam))
check("#5b2", "runs+closed still accounts for every contour at length 0",
      len(info0["runs"]) + len(info0["closed"]) == n_rings,
      f"{len(info0['runs'])}+{len(info0['closed'])} vs {n_rings} contours")

# --------------------------------------------------------------------------- #
# #3 a big requested lead-in must NOT buy permission to cut the part
# --------------------------------------------------------------------------- #
worst_cut = 0.0
cases = [(ftg, "ADAM", 0.25, "in", 10.0, 2.0),
         (f, "Sophia", 1.00, "in", 10.0, 2.0),
         (f, "Sophia", 0.25, "in", 10.0, 0.5),
         (f, "Sophia", 0.05, "in", 10.0, 0.012),
         (f, "ADAM", 0.05, "in", 1.0, 0.5),
         (f, "Sophia", 1.0, "mm", 250.0, 50.0)]
worst_case = ""
for fo, nm, ht, un, ln, cl in cases:
    doc = build_document(fo, nm, ht, un, "cap")
    inf = LI.lead_in_report(doc, ln, cl)
    _p, _d, mat = LI._analyse(LI._rings(doc))
    for lead in inf["leads"]:
        cut = mat.intersection(LineString(lead)).length * doc.scale
        if cut > worst_cut:
            worst_cut = cut
            worst_case = f"{nm}@{ht}{un} len={ln} clear={cl}"
check("#3", "an absurd lead-in length never cuts through the material",
      worst_cut < 1e-4,
      f"worst material cut across 6 abusive settings: {worst_cut:.6f} "
      f"({worst_case or 'none'})")

# --------------------------------------------------------------------------- #
# #5a / #5c / #5d names with no ink and bad heights must not crash
# --------------------------------------------------------------------------- #
bad_names = ["", " ", "\t", "\n", "​", "⁠", "﻿", "­",
             "///", "..", "李明", "\U0001f600"]
crashes = []
for nm in bad_names:
    try:
        d = build_document(f, nm, 1.0, "in", "cap")
        LI.lead_in_report(d, 0.1)
        svg_single(d)
        pdf_document([d])
        try:
            stack([d], 0.25)
        except ValueError:
            pass                     # a refusal is fine; a crash is not
    except ValueError:
        pass                         # deliberate, message-carrying refusal
    except Exception as exc:
        crashes.append(f"{nm!r}: {type(exc).__name__}: {exc}")
check("#5a/c", "no-ink and exotic names never raise an unhandled error",
      not crashes, "; ".join(crashes[:4]) or
      f"all {len(bad_names)} handled (empty, whitespace, zero-width, CJK, emoji)")

bad_heights = [0.0, -1.0, float("inf"), float("nan")]
hcrash = []
for ht in bad_heights:
    try:
        d = build_document(f, "ADAM", ht, "in", "cap")
        s = svg_single(d)
        if "inf" in s or "nan" in s:
            hcrash.append(f"height {ht}: wrote inf/nan into the SVG")
    except ValueError:
        pass                         # refused with a message: correct
    except Exception as exc:
        hcrash.append(f"height {ht}: {type(exc).__name__}")
check("#5d/#8", "height 0 / negative / inf / nan are refused, never written",
      not hcrash, "; ".join(hcrash) or
      "all four refused with a clear error instead of writing junk")

# --------------------------------------------------------------------------- #
# #6 the CLI must not overwrite one order with another
# --------------------------------------------------------------------------- #
tmp = tempfile.mkdtemp(prefix="sfpf_reg_")
r = subprocess.run([PY, os.path.join(HERE, "nameplate_cli.py"),
                    "--font", MERRI, "--height", "1", "--format", "svg",
                    "--out", tmp, "Adam!", "Adam?", "Adam."],
                   capture_output=True, text=True, timeout=300)
n_svg = len([x for x in os.listdir(tmp) if x.endswith(".svg")])
check("#6", "three colliding names produce three files, not one",
      n_svg == 3, f"{n_svg} svg file(s) written: {sorted(os.listdir(tmp))}")

# --------------------------------------------------------------------------- #
# #9 the CLI must refuse a sheet whose names would overlap
# --------------------------------------------------------------------------- #
tmp2 = tempfile.mkdtemp(prefix="sfpf_reg2_")
r2 = subprocess.run([PY, os.path.join(HERE, "nameplate_cli.py"),
                     "--font", MERRI, "--height", "1", "--mode", "sheet",
                     "--gap", "-0.5", "--format", "svg", "--out", tmp2,
                     "ADAM", "OLIVIA"],
                    capture_output=True, text=True, timeout=300)
wrote = os.path.exists(os.path.join(tmp2, "sheet.svg"))
check("#9", "the CLI refuses a negative sheet gap instead of overlapping names",
      r2.returncode != 0 and not wrote,
      f"exit={r2.returncode}, sheet written={wrote}, "
      f"said: {(r2.stderr or r2.stdout).strip().splitlines()[-1][:90] if (r2.stderr or r2.stdout).strip() else ''}")

# --------------------------------------------------------------------------- #
# #4 performance: a long name and a big sheet must finish in reasonable time
# --------------------------------------------------------------------------- #
import time
t0 = time.perf_counter()
d_long = build_document(f, "a" * 120, 1.0, "in", "cap")
LI.lead_in_report(d_long, 0.1)
el = time.perf_counter() - t0
check("#4a", "a 120-character name finishes well inside a minute",
      el < 60, f"{el:.1f}s for build + lead-ins")

t0 = time.perf_counter()
many = [build_document(f, f"Name{i:03d}", 1.0, "in", "cap") for i in range(40)]
sheet = LAY.arrange(many, 0.25, LAY.HORIZONTAL)
LI.lead_in_report(sheet, 0.1)
el = time.perf_counter() - t0
check("#4b", "a 40-name side-by-side sheet with lead-ins finishes inside a minute",
      el < 60, f"{el:.1f}s for 40 names + arrange + lead-ins")

# --------------------------------------------------------------------------- #
# #5 thickness: the reported minimum must be the REAL minimum.
#
#    survey() used to walk the boundary at evenly spaced points only, so a short
#    thin neck could sit between two samples and never be measured. It reported
#    material as THICKER than it is -- the dangerous direction, because
#    --min-thickness MET is what says a font is safe to cut.
#
#    These two fixtures are DOUBLE-DERIVED: the 2026-08-05 audit found them with
#    one method, and the font factory's own measure_thickness.py reproduced them
#    from scratch with a different one, agreeing to three significant figures.
#    Both are genuine parallel-walled structural webs (clearance 0.500), not
#    cosmetic slivers -- the ADAM one was confirmed visually against the union
#    geometry. If either number drifts, the sampler has regressed.
# --------------------------------------------------------------------------- #
import nameplate_thickness as TH

for nm, truth_fu, was in (("ADAM", 72.76, 126.20), ("CHRISTOPHER", 18.13, 120.09)):
    d = build_document(f, nm, 1.0, "in", "cap")
    sv = TH.survey(d, samples=900, font=f)
    got = (sv.spots[0].thickness / d.scale) if sv.spots else float("nan")
    clear = sv.spots[0].clearance if sv.spots else 0.0
    err = abs(got / truth_fu - 1.0) * 100.0
    check("#10a" if nm == "ADAM" else "#10b",
          f"{nm}'s thinnest reads the real {truth_fu} font units, not {was}",
          err < 2.0 and clear >= 0.47,
          f"measured {got:.2f} fu ({err:+.2f}% of double-derived truth "
          f"{truth_fu}), clearance {clear:.3f} -- must be >= 0.47 to be a "
          f"parallel-walled web rather than a taper")

# a short thin neck is exactly what uniform sampling steps over, so prove the
# vertex pass is what catches it: without it, ADAM reads the old wrong number
_saved = TH.VERTEX_CEILING
try:
    TH.VERTEX_CEILING = 0.0          # disables the vertex pass entirely
    d = build_document(f, "ADAM", 1.0, "in", "cap")
    sv_off = TH.survey(d, samples=900, font=f)
    off = (sv_off.spots[0].thickness / d.scale) if sv_off.spots else float("nan")
finally:
    TH.VERTEX_CEILING = _saved
check("#10c", "the vertex-anchored pass is what finds the web, not luck",
      off > 100.0,
      f"with the vertex pass off ADAM reads {off:.2f} fu (the old over-report); "
      f"with it on, 72.76")

# and it must stay usable: the whole point of accuracy-first is that it still
# finishes, so a long script name is the worst case worth pinning
t0 = time.perf_counter()
d_scr = build_document(ftg, "Alexandria", 25.0, "mm", "cap")
TH.survey(d_scr, samples=900, font=ftg)
el = time.perf_counter() - t0
check("#10d", "a long script name's thickness survey stays well under a minute",
      el < 30.0, f"{el:.1f}s for the worst shipped case")

# --------------------------------------------------------------------------- #
# #11 the junctions a REAL name makes must be tested, not just 2-letter words.
#
#     These fonts swap the glyph by position. A two-letter string tests
#     initial->FINAL forms; a name of three letters or more also makes
#     initial->MEDIAL at its start and medial->FINAL at its end, and those are
#     different glyphs. Neither the pair sheet nor join_scan looked at them.
#
#     Measured consequence, before the fix: on Cervanttis-ExtraBoldEyelet the
#     scan reported 7,436 of 7,436 combinations tested and 'Daniel' still cut
#     into 3 loose pieces (junction i->e) and 'Bjorn' likewise (B.eyeL->j) --
#     neither predicted. Afterwards both are predicted, and 106 junctions are
#     found that no earlier phase reached.
#
#     Pinned here on a SHIPPED font so the test needs nothing outside the app:
#     TGCarrieSOFlourish's 'dd' shapes to Dleftring+dflourishrightring, while
#     'dda' shapes to Dleftring+d+aflourishrightring -- and Dleftring->d is
#     broken. One is a whole word, the other is the first letter of a name.
# --------------------------------------------------------------------------- #
import nameplate_pairsheet as PS
from nameplate_fontcheck import join_scan

fl = Font(os.path.join(HERE, "fonts", "TGCarrieSOFlourish-v2.otf"))

d_whole = build_document(fl, "dd", 1.0, "in", "cap")
d_first = build_document(fl, "dda", 1.0, "in", "cap")


def _pieces(doc):
    _p, dep, _m = LI._analyse(LI._rings(doc))
    return sum(1 for x in dep if x % 2 == 0)


g_whole = tuple(p.glyph for p in __import__("nameplate_core").shape(fl, "dd"))
g_first = tuple(p.glyph for p in __import__("nameplate_core").shape(fl, "dda"))
check("#11a", "the first letter of a name uses a DIFFERENT glyph pair than the "
              "same two letters alone",
      g_whole[:1] == g_first[:1] and g_whole[1] != g_first[1],
      f"'dd' -> {g_whole}, 'dda' -> {g_first}; both break "
      f"({_pieces(d_whole)} and {_pieces(d_first)} pieces)")

rep_pairs = PS.analyse_pairs(fl, budget_s=180)
keys = [g.key for g in rep_pairs.groups]
check("#11b", "the pair sheet tests every positional junction",
      all(k in keys for k in ("lower", "midlower", "firstlower",
                              "firstcaplower", "lastlower")),
      f"groups: {keys}")

first_cell = None
for g in rep_pairs.groups:
    if g.key == "firstlower":
        first_cell = g.cells.get(("d", "d"))
check("#11c", "the first-letter junction 'dda' is FLAGGED, not silently passed",
      bool(first_cell and first_cell.problem
           and getattr(first_cell, "context", "") == "dda"),
      f"status={getattr(first_cell, 'status', None)}, "
      f"context={getattr(first_cell, 'context', None)!r}, "
      f"glyphs={getattr(first_cell, 'glyphs', None)}")

fails, tested, trunc, total = join_scan(fl)
check("#11d", "join_scan reaches the Capital-initial junction and finishes",
      ("Dleftring→d" in fails) and not trunc,
      f"{tested}/{total} combos, truncated={trunc}, "
      f"Dleftring->d found={'Dleftring' + chr(8594) + 'd' in fails}")

# --------------------------------------------------------------------------- #
# #12 a nested island must stay IN the material mask.
#
#     _analyse built the mask as union(even depths) - union(odd depths). A hole
#     ring covers everything nested inside it, so subtracting all the odd rings
#     at once deleted any depth-2 island too. Every safety check then saw empty
#     space where solid metal sits, and a lead-in was free to run through it:
#     measured 0.0318 in and 0.0807 in of real material cut on the shipped
#     TGCarrie fonts, reachable by typing (c) or (R).
# --------------------------------------------------------------------------- #
from shapely.ops import unary_union

worst_island = 0.0
island_cases = 0
for fo in (ftg, fl):
    for ch in ("©", "®"):
        if ord(ch) not in fo.cmap:
            continue
        d = build_document(fo, ch, 1.0, "in", "cap")
        polys, dep, mat = LI._analyse(LI._rings(d))
        if max(dep, default=0) < 2:
            continue
        island_cases += 1
        # the island's own metal must be inside the mask
        isl = unary_union([p for p, x in zip(polys, dep) if x == 2])
        d3 = unary_union([p for p, x in zip(polys, dep) if x == 3])
        body = isl.difference(d3) if not d3.is_empty else isl
        covered = (body.intersection(mat).area / body.area) if body.area else 1.0
        info = LI.lead_in_report(d, 0.1, 0.012)
        for lead in info["leads"]:
            worst_island = max(
                worst_island,
                mat.intersection(LineString(lead)).length * d.scale)
        if covered < 0.999:
            worst_island = float("inf")
check("#12", "a nested island stays in the material mask, so no lead-in cuts it",
      island_cases > 0 and worst_island < 1e-4,
      f"{island_cases} depth-2+ case(s) checked; worst lead cutting real "
      f"material {worst_island:.6f} in (was 0.0807)")

# --------------------------------------------------------------------------- #
# #13 a letter's counter must not be reported as an eyelet.
#     'Bob' on Merriweather (eyelet on the first letter only) reported the final
#     'b' counter as a RIGHT EYELET, with paste-ready instructions to resize it.
#     A real eyelet is a ring of roughly even width; that counter's accepted ray
#     radii varied by 35% of the radius against 0.2% for the true eyelet.
# --------------------------------------------------------------------------- #
import nameplate_eyelets as EY

d_bob = build_document(f, "Bob", 1.0, "in", "cap")
kept = EY.measure_eyelets(d_bob)
every = EY.measure_eyelets(d_bob, include_suspect=True)
check("#13a", "the final letter's counter is not counted as an eyelet",
      len(kept) == 1 and kept[0].side == "left" and len(every) == 2,
      f"kept {[e.side for e in kept]}, rejected "
      f"{[(e.side, round(e.boss_spread_ratio * 100)) for e in every if not e.confident]}"
      f" (% spread of radius)")
check("#13b", "the rejection is explained, not silent",
      "NOT COUNTED AS EYELETS" in EY.report_text(d_bob),
      "report_text names the hole it left out and why")
d_adam2 = build_document(f, "ADAM", 1.0, "in", "cap")
check("#13c", "a genuine eyelet still passes the new gate",
      len(EY.measure_eyelets(d_adam2)) == 1
      and EY.measure_eyelets(d_adam2)[0].confident,
      f"ADAM: {len(EY.measure_eyelets(d_adam2))} confident eyelet(s)")

# --------------------------------------------------------------------------- #
# #14 counters wound the wrong way cut SOLID and nothing could see it.
#     The app measures with a parity fill model but cuts with a winding union.
#     Rewind a counter to match its outer and skia cancels it: the letter lasers
#     as a blob while every check passes. Verified: a same-direction nested ring
#     makes skia emit ONE contour where parity still reports a hole.
# --------------------------------------------------------------------------- #
import nameplate_fontcheck as FCK

false_pos = {}
for fo, label in ((f, "Merriweather"), (ftg, "TGCarrieSO"), (fl, "Flourish")):
    w = FCK.winding_check(fo)
    if w:
        false_pos[label] = [x["glyph"] for x in w[:4]]
check("#14a", "the winding check clears all three shipped fonts",
      not false_pos, f"false positives: {false_pos or 'none'}")

# and it must actually fire on a same-direction nested ring
from pathops import Path as _P, OpBuilder as _OB, PathOp as _PO


def _ring_path(pts):
    q = _P()
    q.moveTo(*pts[0])
    for r in pts[1:]:
        q.lineTo(*r)
    q.close()
    return q


_p = _P()
_p.addPath(_ring_path([(0, 0), (100, 0), (100, 100), (0, 100)]))
_p.addPath(_ring_path([(30, 30), (70, 30), (70, 70), (30, 70)]))   # SAME winding
_b = _OB(fix_winding=False, keep_starting_points=False)
_b.add(_p, _PO.UNION)
_res = _b.resolve()
_n_contours = sum(1 for verb, _pts in _res.segments if verb == "moveTo")
check("#14b", "a same-direction counter really does cancel in the cut path",
      _n_contours == 1,
      f"skia union of outer+same-direction-counter -> {_n_contours} contour(s); "
      f"parity would say 2, so the hole vanishes in metal")

# --------------------------------------------------------------------------- #
# #15 pairs nobody measured must not pass. A tiny budget used to report
#     "flagged: 0" and exit 0 READY with nearly every combination UNTESTED.
# --------------------------------------------------------------------------- #
import nameplate_brief as NB

b_small = NB.brief(TG, cap=1.0, unit="in", pair_budget=0.05, join_budget=0.0,
                   min_thickness=0.06)
check("#15", "an unmeasured pair scan cannot be reported as ready",
      b_small["verdict"] != "ready" and b_small["pairs"].get("untested", 0) > 0
      and any("never tested" in x for x in b_small.get("blocking", [])),
      f"verdict={b_small['verdict']!r}, untested="
      f"{b_small['pairs'].get('untested')}, blocking="
      f"{len(b_small.get('blocking', []))} line(s)")

# --------------------------------------------------------------------------- #
print("=" * 78)
n_ok = sum(1 for r in results if r[0])
print(f"{n_ok}/{len(results)} regressions fixed")
for ok, ref, name, detail in results:
    if not ok:
        print(f"  STILL BROKEN {ref}: {name}\n     {detail}")
print("=" * 78)
sys.exit(0 if n_ok == len(results) else 1)

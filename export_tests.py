"""
export_tests.py — the cutting order, the per-name grouping, and the PDF layers.

    python export_tests.py

These are separate from acceptance_tests.py because they test a different
promise. acceptance_tests.py says "the artwork is the right shape and size".
This says "the file is safe to send to a laser": a part cut out of sheet metal
is held by the surrounding sheet only until its outline is cut, so the outline
must be cut LAST or everything after it cuts air.

Cut order comes from stacking order, bottom first, and in a vector file the
first thing written is the bottom. So the required file order, per name, is:
engrave, then the inner holes, then the outline.
"""

from __future__ import annotations

import io
import re
import sys
import zlib

from shapely.geometry import LineString, Polygon

from nameplate_core import Font, build_document
import nameplate_export as EX
import nameplate_layout as LAY
import nameplate_leadin as LI

results = []


def check(name, expected, actual, ok=None):
    if ok is None:
        ok = expected == actual
    results.append((ok, name, expected, actual))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(f"        expected: {expected}")
    print(f"        actual:   {actual}")


f = Font("fonts/MerriweatherCut3Black-Engrave-v2.ttf")
docs = [build_document(f, n, 1.0, "in", "cap") for n in ("ADAM", "OLIVIA")]

print("=" * 78)
print("cutting order, grouping and layers")
print("=" * 78)

for lead in (None, 0.1):
    tag = "with lead-ins" if lead else "no lead-ins"
    pieces, bbox = EX.build_pieces(docs, 0.25, LAY.VERTICAL, lead, 0.012)

    # ---- every contour is accounted for, and classified ---------------- #
    for pc, doc in zip(pieces, docs):
        n_rings = len(LI._rings(doc))
        got = len(pc.inner) + len(pc.outer)
        check(f"{tag}: {pc.label} keeps every contour",
              f"{n_rings} contours as inner+outer", f"{got}", ok=(got == n_rings))
        check(f"{tag}: {pc.label} has exactly one outline",
              "1 outer contour", f"{len(pc.outer)}", ok=(len(pc.outer) == 1))

    # ---- the outline really is the outermost thing --------------------- #
    for pc in pieces:
        out_poly = Polygon(pc.outer[0][0])
        holes_in = sum(1 for pts, _o in pc.inner
                       if out_poly.buffer(1e-9).contains(Polygon(pts).centroid))
        check(f"{tag}: {pc.label} inner cuts really are inside the outline",
              f"{len(pc.inner)} of {len(pc.inner)} inside", f"{holes_in}",
              ok=(holes_in == len(pc.inner)))

    # ---- SVG: order and grouping -------------------------------------- #
    svg = EX.svg(pieces, bbox, "in")
    gids = re.findall(r'<g id="([^"]+)"', svg)
    tops = [g for g in gids if "__" not in g]
    check(f"{tag}: SVG gives each name its own group",
          "['ADAM', 'OLIVIA']", f"{tops}", ok=(tops == ["ADAM", "OLIVIA"]))
    for t in tops:
        subs = [g for g in gids if g.startswith(t + "__")]
        want = [f"{t}__1_engrave", f"{t}__2_cut_inner", f"{t}__3_cut_outline"]
        check(f"{tag}: SVG {t} is written engrave -> inner -> outline",
              f"{want}", f"{subs}", ok=(subs == want))

    # nothing but geometry
    check(f"{tag}: SVG carries no text or boxes",
          "no <text>/<rect>/<circle>",
          "clean" if not any(t in svg for t in ("<text", "<rect", "<circle"))
          else "found annotations",
          ok=not any(t in svg for t in ("<text", "<rect", "<circle")))

    # ---- PDF: order, layers, hairline --------------------------------- #
    pdf_bytes = EX.pdf(pieces, bbox, "in")
    body = zlib.decompress(
        re.search(rb"stream\n(.*?)\nendstream", pdf_bytes, re.S).group(1)
    ).decode("latin-1")
    check(f"{tag}: PDF marks one layer per name",
          f"{len(pieces)} /OC ... BDC blocks", f"{body.count('/OC /MC')}",
          ok=(body.count("/OC /MC") == len(pieces) == body.count("EMC")))
    first_red, first_black = body.find("1 0 0 RG"), body.find("0 0 0 RG")
    check(f"{tag}: PDF draws engrave before any cut",
          "red before black", f"red at {first_red}, black at {first_black}",
          ok=(0 <= first_red < first_black))
    check(f"{tag}: PDF uses an explicit hairline, not width 0",
          "0.072 pt (= 0.001 in) so Corel keeps the hairline",
          body.splitlines()[0], ok=body.startswith("0.0720 w"))
    try:
        import pikepdf
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            probs = pdf.check_pdf_syntax()
            names = [str(o.get("/Name")) for o in
                     pdf.Root.get("/OCProperties", {}).get("/OCGs", [])]
        check(f"{tag}: PDF is valid and its layers are named after the names",
              "no syntax problems, layers ['ADAM', 'OLIVIA']",
              f"problems={probs or 'none'}, layers={names}",
              ok=(not probs and names == ["ADAM", "OLIVIA"]))
    except ImportError:
        print("NOTE: pikepdf missing, PDF structure check skipped")

# ---- the outline is the LAST cut, which is the whole point ------------- #
pieces, bbox = EX.build_pieces(docs, 0.25, LAY.VERTICAL, 0.1, 0.012)
svg = EX.svg(pieces, bbox, "in")
last_group = re.findall(r'<g id="([^"]+)"', svg)[-1]
check("the very last thing in the file is an outline cut",
      "a *_3_cut_outline group", last_group,
      ok=last_group.endswith("_3_cut_outline"))

# ---- lead-ins still start in scrap after all the reordering ----------- #
worst = 0.0
for doc in docs:
    info = LI.lead_in_report(doc, 0.1, 0.012)
    _p, _d, mat = LI._analyse(LI._rings(doc))
    for lead in info["leads"]:
        worst = max(worst, mat.intersection(LineString(lead)).length * doc.scale)
check("reordering did not move any lead-in into the material",
      "0 material crossed", f"{worst:.6f} in worst case", ok=(worst < 1e-4))

# ---- horizontal sheets get the same treatment ------------------------- #
pieces_h, bbox_h = EX.build_pieces(docs, 0.25, LAY.HORIZONTAL, 0.1, 0.012)
svg_h = EX.svg(pieces_h, bbox_h, "in")
w = float(re.search(r'width="([\d.]+)in"', svg_h).group(1))
h = float(re.search(r'height="([\d.]+)in"', svg_h).group(1))
gids_h = [g for g in re.findall(r'<g id="([^"]+)"', svg_h) if "__" not in g]
check("side-by-side sheets are grouped and ordered the same way",
      "wider than tall, one group per name",
      f"{w:.3f} x {h:.3f} in, groups {gids_h}",
      ok=(w > h and gids_h == ["ADAM", "OLIVIA"]))

print("=" * 78)
n_ok = sum(1 for r in results if r[0])
print(f"{n_ok}/{len(results)} passed")
for ok, name, exp, act in results:
    if not ok:
        print(f"  FAIL: {name}\n     expected: {exp}\n     actual:   {act}")
print("=" * 78)
sys.exit(0 if n_ok == len(results) else 1)

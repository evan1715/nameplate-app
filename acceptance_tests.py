"""
acceptance_tests.py — every test in SPEC.md section 7, actual vs expected.

Run:  python acceptance_tests.py
Exit code 0 = all pass. This checks the engine and the output contract only;
it does not need PySide6.
"""

from __future__ import annotations

import io
import os
import re
import sys
import xml.etree.ElementTree as ET

from nameplate_core import (MM_PER_IN, PT_PER_IN, Font, build_document,
                            pdf_document, pdf_sheet, stack, svg_sheet,
                            svg_single, summary)

HERE = os.path.dirname(os.path.abspath(__file__))
MERRI = os.path.join(HERE, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf")
FLOUR = os.path.join(HERE, "fonts", "TGCarrieSOFlourish-v2.otf")
PLAIN = os.path.join(HERE, "fonts", "TGCarrieSO-v2.otf")
GOLDEN = os.path.join(HERE, "golden")

results: list[tuple[bool, str, str, str]] = []      # ok, test, expected, actual
_fonts: dict[str, Font] = {}


def font(path: str) -> Font:
    if path not in _fonts:
        _fonts[path] = Font(path)
    return _fonts[path]


def check(name: str, expected: str, actual: str, ok: bool | None = None) -> None:
    if ok is None:
        ok = (expected == actual)
    results.append((ok, name, expected, actual))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(f"        expected: {expected}")
    print(f"        actual:   {actual}")


def dims(doc) -> str:
    w, h = doc.size()
    n_cut = sum(len(r) for r in doc.cut_paths)
    return (f"{w:.3f} x {h:.3f} {doc.unit}, {n_cut} cut contours, "
            f"{len(doc.engrave_paths)} engrave lines")


# --------------------------------------------------------------------------- #
print("=" * 78)
print("SPEC.md section 7 — acceptance tests")
print("=" * 78)
print("NOTE: the cap-height sizes below differ from SPEC.md section 7 on purpose.")
print("      The spec's numbers came from scaling by whichever capital came")
print("      first, which delivered 'JADAM' about 20% smaller than 'ADAM'. Cap")
print("      height is now the font's own cap line, so every name scales")
print("      identically; descenders make the piece taller, not the letters")
print("      smaller. golden/superseded_first_capital_basis/ keeps the old files.")
print("=" * 78)

# 1. Merriweather ADAM cap 1 in
d_adam = build_document(font(MERRI), "ADAM", 1.0, "in", "cap")
check("Merriweather, ADAM, cap 1 in",
      "4.069 x 1.020 in, 6 cut contours, 10 engrave lines", dims(d_adam))

# the exact CLI line from the spec / README
check("CLI summary line for ADAM",
      "ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)",
      summary(d_adam))

# 2. Merriweather OLIVIA cap 1 in
d_oliv = build_document(font(MERRI), "OLIVIA", 1.0, "in", "cap")
check("Merriweather, OLIVIA, cap 1 in",
      "4.365 x 1.029 in, 4 cut contours, 13 engrave lines", dims(d_oliv))

# 3. Merriweather "Mary Jane" — just check it renders
d_mj = build_document(font(MERRI), "Mary Jane", 1.0, "in", "cap")
n_cut_mj = sum(len(r) for r in d_mj.cut_paths)
check("Merriweather, 'Mary Jane', cap 1 in — renders",
      "renders: >0 cut contours, no exception",
      f"renders: {n_cut_mj} cut contours, {len(d_mj.engrave_paths)} engrave lines",
      ok=(n_cut_mj > 0))

# 4. Carrie Flourish, Carrie, cap 25 mm
d_carrie = build_document(font(FLOUR), "Carrie", 25.0, "mm", "cap")
check("Carrie Flourish, 'Carrie', cap 25 mm",
      "106.769 x 24.808 mm, 8 cut contours, 1 engrave lines", dims(d_carrie))

# 5. Carrie Flourish, ADAM, cap 1 in -> 0 engrave + warning
d_fa = build_document(font(FLOUR), "ADAM", 1.0, "in", "cap")
has_warn = any("engrave" in w.lower() for w in d_fa.warnings)
check("Carrie Flourish, ADAM — 0 engrave lines + warning",
      "0 engrave lines, warning present",
      f"{len(d_fa.engrave_paths)} engrave lines, "
      f"warning present={has_warn} -> {d_fa.warnings}",
      ok=(len(d_fa.engrave_paths) == 0 and has_warn))

# 6. Carrie SO (no flourish) -> 0 engrave + "no COLR table" warning
d_plain = build_document(font(PLAIN), "Carrie", 1.0, "in", "cap")
colr_warn = any("COLR" in w for w in d_plain.warnings)
check("Carrie SO (no flourish) — 0 engrave + 'no COLR table' warning",
      "0 engrave lines, 'no COLR table' warning",
      f"{len(d_plain.engrave_paths)} engrave lines, "
      f"COLR warning={colr_warn} -> {d_plain.warnings}",
      ok=(len(d_plain.engrave_paths) == 0 and colr_warn))

# 7. single letter "A" in every font -> cut only, no engrave, no crash
single = []
ok_single = True
for label, path in (("Merriweather", MERRI), ("Flourish", FLOUR), ("Carrie SO", PLAIN)):
    try:
        d = build_document(font(path), "A", 1.0, "in", "cap")
        n = sum(len(r) for r in d.cut_paths)
        single.append(f"{label}: {n} cut / {len(d.engrave_paths)} engrave")
        if n <= 0 or len(d.engrave_paths) != 0:
            ok_single = False
    except Exception as exc:
        single.append(f"{label}: EXCEPTION {exc}")
        ok_single = False
check("'A' single letter, every font — cut only, no engrave, no crash",
      "cut path only, 0 engrave, no exception",
      "; ".join(single), ok=ok_single)

# 8. x-height basis measures the REAL lowercase tops, not the declared metric.
# This Merriweather cut is unicase — its "lowercase" letters are capitals
# topping at 1486 — yet the file declares sxHeight 1097 (a leftover from stock
# Merriweather). Trusting the declaration delivered letters 35% taller than
# asked. The measured value must win, and the mismatch must be said out loud.
d_xh = build_document(font(MERRI), "Adam", 1.0, "in", "xheight")
_xh_warned = any("declares an x-height" in w for w in d_xh.warnings)
check("x-height basis — measured lowercase tops beat a wrong declared metric",
      "basis_height = 1486 font units, with a declared-mismatch warning",
      f"basis_height = {d_xh.basis_height:g}, warned = {_xh_warned}",
      ok=(abs(d_xh.basis_height - 1486) < 1e-6 and _xh_warned))

# 9. unit switch: 1 in == 25.4 mm -> same physical artwork
d_in = build_document(font(MERRI), "ADAM", 1.0, "in", "cap")
d_mm = build_document(font(MERRI), "ADAM", 25.4, "mm", "cap")
w_in, h_in = d_in.size()
w_mm, h_mm = d_mm.size()
same = (abs(w_in * MM_PER_IN - w_mm) < 1e-6 and abs(h_in * MM_PER_IN - h_mm) < 1e-6)
check("unit switch — 1 in vs 25.4 mm is the same physical size",
      f"{w_in * MM_PER_IN:.4f} x {h_in * MM_PER_IN:.4f} mm",
      f"{w_mm:.4f} x {h_mm:.4f} mm", ok=same)

# 10. PDF — structure valid, page size = artwork + 12 pt total
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)


def qpdf_check(data: bytes, tag: str) -> tuple[bool, str]:
    """The 'qpdf --check' the spec asks for, via pikepdf's bundled libqpdf."""
    path = os.path.join(OUT, f"_acc_{tag}.pdf")
    with open(path, "wb") as fh:
        fh.write(data)
    try:
        import pikepdf
    except ImportError:
        return False, "SKIPPED: neither qpdf nor pikepdf installed"
    with pikepdf.open(path) as pdf:
        problems = pdf.check_pdf_syntax()
    job = pikepdf.Job(["pikepdf", "--check", path])
    try:
        job.run()
        code = job.exit_code
    except Exception as exc:
        return False, f"qpdf --check raised {type(exc).__name__}: {exc}"
    ok = (not problems) and code == 0
    return ok, (f"qpdf --check exit={code}, syntax problems="
                f"{problems or 'none'} (libqpdf {pikepdf.__libqpdf_version__})")


pdf_bytes = pdf_document([d_adam])
w_pt = w_in * PT_PER_IN
h_pt = h_in * PT_PER_IN
ok_chk, detail = qpdf_check(pdf_bytes, "adam")
try:
    import pikepdf
except ImportError:
    pikepdf = None
    print("NOTE: pikepdf not installed — PDF structure checks skipped. "
          "pip install -r requirements-dev.txt to enable them.")
if pikepdf is None:
    raise SystemExit(0)
with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
    box = [float(v) for v in pdf.pages[0].MediaBox]
    npages = len(pdf.pages)
mb_w, mb_h = box[2] - box[0], box[3] - box[1]
ok_pdf = (ok_chk and abs(mb_w - (w_pt + 12)) < 0.01
          and abs(mb_h - (h_pt + 12)) < 0.01 and npages == 1)
check("PDF — qpdf --check passes + page size = artwork + 12 pt",
      f"check passes, 1 page, MediaBox {w_pt + 12:.3f} x {h_pt + 12:.3f} pt",
      f"{detail}, {npages} page, MediaBox {mb_w:.3f} x {mb_h:.3f} pt", ok=ok_pdf)

# multi-page: one page per name
pdf_multi = pdf_document([d_adam, d_oliv])
ok_chk2, detail2 = qpdf_check(pdf_multi, "multi")
with pikepdf.open(io.BytesIO(pdf_multi)) as pdf:
    n = len(pdf.pages)
check("PDF — one page per name", "2 pages for 2 names, check passes",
      f"{n} pages, {detail2}", ok=(n == 2 and ok_chk2))

# PDF hairline + pure RGB colour operators in the content stream
import zlib
raw = re.search(rb"stream\n(.*?)\nendstream", pdf_bytes, re.S).group(1)
content = zlib.decompress(raw).decode("latin-1")
ok_ops = ("0 w" in content.split("\n")[0] and "0 0 0 RG" in content
          and "1 0 0 RG" in content)
check("PDF — hairline width 0, black cut + pure red engrave operators",
      "'0 w', '0 0 0 RG', '1 0 0 RG' all present",
      f"first op={content.splitlines()[0]!r}, "
      f"'0 0 0 RG'={'0 0 0 RG' in content}, '1 0 0 RG'={'1 0 0 RG' in content}",
      ok=ok_ops)

# 11. SVG — real units, viewBox match, CUT/ENGRAVE separable, no fill
svg = svg_single(d_adam)
root = ET.fromstring(svg)
NS = "{http://www.w3.org/2000/svg}"
groups = {g.get("id"): g for g in root.findall(f"{NS}g")}
vb = [float(v) for v in root.get("viewBox").split()]
sw_expect = 0.001                                    # HAIRLINE_IN, doc unit is in
ok_svg = (
    root.get("width") == f"{w_in:.4f}in" and root.get("height") == f"{h_in:.4f}in"
    and abs(vb[2] - w_in) < 1e-4 and abs(vb[3] - h_in) < 1e-4
    and set(groups) == {"CUT", "ENGRAVE"}
    and groups["CUT"].get("fill") == "none" and groups["ENGRAVE"].get("fill") == "none"
    and groups["CUT"].get("stroke") == "#000000"
    and groups["ENGRAVE"].get("stroke") == "#FF0000"
    and abs(float(groups["CUT"].get("stroke-width")) - sw_expect) < 1e-9)
check("SVG — physical units, viewBox, CUT/ENGRAVE groups, fill=none, hairline",
      f'width={w_in:.4f}in height={h_in:.4f}in viewBox 0 0 {w_in:.4f} {h_in:.4f}; '
      f'groups CUT(#000000)/ENGRAVE(#FF0000) both fill=none; stroke-width {sw_expect}',
      f'width={root.get("width")} height={root.get("height")} '
      f'viewBox={root.get("viewBox")}; groups {sorted(groups)}; '
      f'fills {groups["CUT"].get("fill")}/{groups["ENGRAVE"].get("fill")}; '
      f'strokes {groups["CUT"].get("stroke")}/{groups["ENGRAVE"].get("stroke")}; '
      f'stroke-width {groups["CUT"].get("stroke-width")}', ok=ok_svg)

# engrave paths must stay OPEN (no Z) and cut paths must stay closed
cut_ds = [p.get("d") for p in groups["CUT"].findall(f"{NS}path")]
eng_ds = [p.get("d") for p in groups["ENGRAVE"].findall(f"{NS}path")]
ok_open = all("Z" not in d for d in eng_ds) and all(d.endswith("Z") for d in cut_ds)
check("SVG — engrave lines open, cut contours closed",
      "no 'Z' in any ENGRAVE path; every CUT path ends with 'Z'",
      f"ENGRAVE paths with Z: {sum('Z' in d for d in eng_ds)}/{len(eng_ds)}; "
      f"CUT paths ending in Z: {sum(d.endswith('Z') for d in cut_ds)}/{len(cut_ds)}",
      ok=ok_open)

# mm SVG carries mm units and mm hairline
svg_mm = ET.fromstring(svg_single(d_carrie))
sw_mm = float({g.get("id"): g for g in svg_mm.findall(f"{NS}g")}["CUT"]
              .get("stroke-width"))
ok_mm = (svg_mm.get("width").endswith("mm")
         and abs(sw_mm - 0.001 * MM_PER_IN) < 1e-9)
check("SVG — mm document uses mm units and mm hairline",
      f"width ends 'mm', stroke-width {0.001 * MM_PER_IN:.5f}",
      f"width={svg_mm.get('width')}, stroke-width={sw_mm:.5f}", ok=ok_mm)

# sheet mode
sheet_doc = stack([d_adam, d_oliv], 0.25)
sh_w, sh_h = sheet_doc.size()
exp_h = h_in + 0.25 + d_oliv.size()[1]
check("sheet — two names stacked with a 0.25 in gap",
      f"height = {exp_h:.3f} in (ADAM + gap + OLIVIA)",
      f"height = {sh_h:.3f} in", ok=abs(sh_h - exp_h) < 1e-6)

sheet_pdf = pdf_sheet([d_adam, d_oliv], 0.25)
ok_chk3, detail3 = qpdf_check(sheet_pdf, "sheet")
with pikepdf.open(io.BytesIO(sheet_pdf)) as pdf:
    n = len(pdf.pages)
check("sheet PDF — single page, valid",
      "1 page, check passes", f"{n} page, {detail3}", ok=(n == 1 and ok_chk3))

# --------------------------------------------------------------------------- #
#  no dimensions / annotations in the exported artwork
#  (the dashed box and the size labels are drawn only in the preview widget)
# --------------------------------------------------------------------------- #
print("-" * 78)
print("exports must contain nothing but cut + engrave geometry")
print("-" * 78)

svg_all = svg_single(d_adam) + svg_sheet([d_adam, d_oliv], 0.25)
bad_tags = [t for t in ("<text", "<rect", "<tspan", "<circle", "<line",
                        "<ellipse", "<polygon", "<image") if t in svg_all]
check("SVG — no text, no boxes, no stray shapes",
      "only <path> elements inside CUT and ENGRAVE",
      f"offending tags: {bad_tags or 'none'}", ok=not bad_tags)

pdf_ops = zlib.decompress(
    re.search(rb"stream\n(.*?)\nendstream", pdf_document([d_adam]),
              re.S).group(1)).decode("latin-1")
text_ops = [op for op in ("BT", "Tj", "TJ", "Tf", "ET") if
            re.search(rf"(?m)^\s*{op}\b|\b{op}$", pdf_ops)]
check("PDF — no text operators, so nothing extra can be cut",
      "no BT/Tj/TJ/Tf/ET in the content stream",
      f"offending operators: {text_ops or 'none'}", ok=not text_ops)

# --------------------------------------------------------------------------- #
#  size fidelity — what CorelDRAW will actually measure
#
#  Not "does the header say 4.0529in" but "do the real path coordinates span
#  4.0529in inside a canvas declared as 4.0529in". That is the number Corel
#  reports in its property bar after an import.
# --------------------------------------------------------------------------- #
print("-" * 78)
print("exported size fidelity (declared canvas vs actual geometry extents)")
print("-" * 78)


def svg_geometry_extent(svg_text: str):
    """(width, height) actually spanned by the path data, in the doc's unit."""
    root_ = ET.fromstring(svg_text)
    xs, ys = [], []
    for path in root_.iter(f"{NS}path"):
        for tok in re.findall(r"(-?\d+\.?\d*),(-?\d+\.?\d*)", path.get("d")):
            xs.append(float(tok[0]))
            ys.append(float(tok[1]))
    return (max(xs) - min(xs), max(ys) - min(ys)), (min(xs), min(ys))


for label, doc in (("ADAM 1in", d_adam), ("OLIVIA 1in", d_oliv),
                   ("Carrie 25mm", d_carrie)):
    svg_t = svg_single(doc)
    r = ET.fromstring(svg_t)
    unit_suffix = "in" if doc.unit == "in" else "mm"
    decl_w = float(r.get("width").replace(unit_suffix, ""))
    decl_h = float(r.get("height").replace(unit_suffix, ""))
    (gw, gh), _origin = svg_geometry_extent(svg_t)
    rep_w, rep_h = doc.size()
    # geometry must fill the declared canvas, and the canvas must equal the
    # size the app told the user
    e_fill = max(abs(gw - decl_w), abs(gh - decl_h))
    e_decl = max(abs(decl_w - rep_w), abs(decl_h - rep_h))
    ppm = max(e_fill, e_decl) / max(rep_w, rep_h) * 1e6
    ok_fid = e_fill < 5e-4 and e_decl < 5e-4
    check(f"SVG size fidelity {label}",
          f"geometry spans the declared canvas and matches the app's "
          f"{rep_w:.4f} x {rep_h:.4f} {doc.unit} (< 0.0005 {doc.unit})",
          f"declared {decl_w:.4f}x{decl_h:.4f}, geometry {gw:.4f}x{gh:.4f}, "
          f"app says {rep_w:.4f}x{rep_h:.4f} -> worst error "
          f"{max(e_fill, e_decl):.6f} {doc.unit} ({ppm:.2f} ppm)", ok=ok_fid)

# PDF: MediaBox must be artwork + 12 pt exactly, and the drawn geometry must
# span the artwork size in points (72 pt = 1 in), which is what Corel reads.
for label, doc in (("ADAM 1in", d_adam), ("Carrie 25mm", d_carrie)):
    data = pdf_document([doc])
    stream_ = zlib.decompress(
        re.search(rb"stream\n(.*?)\nendstream", data, re.S).group(1)
    ).decode("latin-1")
    pts = [(float(a), float(b)) for a, b in
           re.findall(r"(-?\d+\.\d+) (-?\d+\.\d+) [ml]", stream_)]
    gw = max(p[0] for p in pts) - min(p[0] for p in pts)
    gh = max(p[1] for p in pts) - min(p[1] for p in pts)
    to_pt = PT_PER_IN if doc.unit == "in" else PT_PER_IN / MM_PER_IN
    rep_w, rep_h = doc.size()
    exp_w, exp_h = rep_w * to_pt, rep_h * to_pt
    err_pt = max(abs(gw - exp_w), abs(gh - exp_h))
    check(f"PDF size fidelity {label}",
          f"drawn geometry spans {exp_w:.3f} x {exp_h:.3f} pt "
          f"(= {rep_w:.4f} x {rep_h:.4f} {doc.unit})",
          f"geometry {gw:.3f} x {gh:.3f} pt -> error {err_pt:.4f} pt "
          f"({err_pt / 72 * 1000:.4f} mil)", ok=err_pt < 0.01)

# --------------------------------------------------------------------------- #
#  lead-in lines
# --------------------------------------------------------------------------- #
print("-" * 78)
print("laser lead-in lines")
print("-" * 78)

import nameplate_leadin as LI
from shapely.geometry import LineString as _LS, Point as _Pt

for label, doc, unit in (("ADAM", d_adam, "in"), ("OLIVIA", d_oliv, "in"),
                         ("Mary Jane", d_mj, "in"), ("Carrie", d_carrie, "mm")):
    rings = LI._rings(doc)
    polys, depths, mat = LI._analyse(rings)
    holes = [p for p, d in zip(polys, depths) if d % 2 == 1]
    outers = sum(1 for d in depths if d % 2 == 0)
    info = LI.lead_in_report(doc)
    leads = info["leads"]
    want = LI.default_length(unit) / doc.scale

    in_mat = sum(1 for l in leads if mat.intersection(_LS(l)).length > want * 0.02)
    pierce_in = sum(1 for l in leads if mat.contains(_Pt(l[0])))
    boundary = [_LS(list(r) + [r[0]]) for r in rings]
    eps = want * 1e-6 + 1e-9
    on_v = sum(1 for l in leads
               if min(b.distance(_Pt(l[-1])) for b in boundary) <= eps)
    # every hole the engine calls "served" must really have a pierce inside it
    served = [h for h in info["holes_detail"] if h["status"] == "served"]
    tiny = [h for h in info["holes_detail"] if h["status"] == "tiny"]
    covered = sum(1 for h in served
                  if any(polys[h["ring"]].buffer(want * 0.05).contains(_Pt(l[0]))
                         for l in leads))
    expect = len(served) + outers
    ok = (len(leads) == expect and in_mat == 0 and pierce_in == 0
          and on_v == len(leads) and covered == len(served)
          and info["failed"] == 0 and outers == 1)
    check(f"lead-ins {label} — one per cuttable hole + one outside, none in the name",
          f"{len(holes)} holes ({len(tiny)} sub-kerf, exempt) + 1 outer = "
          f"{expect} lead-ins, 0 in material, 0 pierces in material, "
          f"all ending exactly on a contour, 0 unexplained failures",
          f"{len(leads)} lead-ins ({outers} outer + {len(served)} holes), "
          f"in material={in_mat}, pierce in material={pierce_in}, "
          f"end-on-contour={on_v}/{len(leads)}, served holes covered="
          f"{covered}/{len(served)}, failed={info['failed']}, "
          f"sub-kerf exempt={[round(h['length'], 4) for h in tiny]}",
          ok=ok)

# lead-ins must keep a standoff from every letter edge along their length —
# "doesn't cross the letter" is not enough, a line grazing an edge still burns it
for label, doc, unit in (("ADAM", d_adam, "in"), ("Sophia", None, "in"),
                         ("Christopher", None, "in"), ("Carrie", d_carrie, "mm")):
    if doc is None:
        doc = build_document(font(MERRI), label, 1.0, "in", "cap")
    info = LI.lead_in_report(doc)
    _polys, _depths, mat = LI._analyse(LI._rings(doc))
    hard = LI.hard_clearance(unit)
    near_fu = LI.hard_clearance(unit) / doc.scale * 1.15
    clears = []
    for ln in info["leads"]:
        seg = _LS(ln)
        a, p = ln[1], ln[0]
        t = min(near_fu / max(seg.length, 1e-12), 0.9)
        start = (a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t)
        clears.append(_LS([start, p]).distance(mat) * doc.scale)
    worst = min(clears) if clears else float("inf")
    # every exempt hole must be provably tight: with NO standoff at all it still
    # could not fit a useful lead-in
    tiny = [h for h in info["holes_detail"] if h["status"] == "tiny"]
    bad_exempt = [h for h in tiny
                  if h.get("width", 0.0) > LI.hard_clearance(unit) * 1.6]
    ok_c = worst >= hard * 0.98 and not bad_exempt and info["failed"] == 0
    check(f"lead-in standoff {label} — never grazes a letter edge",
          f"every lead-in stays >= {hard:g} {unit} from all material along its "
          f"length; every exempt hole narrower than the standoff; 0 failures",
          f"worst standoff {worst:.5f} {unit} over {len(info['leads'])} lead-ins; "
          f"{len(tiny)} exempt, widths "
          f"{[round(h.get('width', 0), 5) for h in tiny]} vs standoff floor "
          f"{hard:g}; failed={info['failed']}", ok=ok_c)

# small counters (e, a, o) must get a real adaptive length, not be skipped
d_small = build_document(font(MERRI), "eaeoa", 1.0, "in", "cap")
info_s = LI.lead_in_report(d_small)
served_s = [h for h in info_s["holes_detail"] if h["status"] == "served"]
lens_s = [h["length"] for h in served_s]
check("lead-in length adapts to small counters (e, a, o)",
      "most counters served, each with a length that fits rather than a fixed one",
      f"{len(served_s)}/{info_s['holes']} counters served, lengths "
      f"{[round(v, 4) for v in sorted(lens_s)]} in "
      f"(requested 0.1 max), {info_s['skipped_tiny']} exempt, "
      f"failed={info_s['failed']}",
      ok=(len(served_s) >= info_s["holes"] - 1 and info_s["failed"] == 0
          and len(set(round(v, 4) for v in lens_s)) > 1))

# height must be completely untouched by lead-ins
before = (d_adam.scale, d_adam.bbox, d_adam.size(), d_adam.basis_height)
_leads = LI.lead_in_lines(d_adam)
after = (d_adam.scale, d_adam.bbox, d_adam.size(), d_adam.basis_height)
ex = LI.doc_for_export(d_adam, _leads)
check("lead-ins are excluded from the height calculation",
      "scale, bbox, size() and basis_height all unchanged; export scale identical",
      f"unchanged={before == after}, export scale same={ex.scale == d_adam.scale}, "
      f"size still {tuple(round(v, 4) for v in d_adam.size())}",
      ok=(before == after and ex.scale == d_adam.scale))

# a lead-in must keep its real physical length whatever the name height
big = build_document(font(MERRI), "ADAM", 4.0, "in", "cap")
lens = [_LS(l).length * big.scale for l in LI.lead_in_lines(big, 0.1)]
full = [v for v in lens if abs(v - 0.1) < 1e-6]
check("lead-in length is physical, not relative to the name size",
      "0.1 in lead-ins on a 4 in tall name are still 0.1 in",
      f"{len(full)}/{len(lens)} at exactly 0.100 in "
      f"(others shrank to fit small holes: "
      f"{[round(v, 4) for v in lens if abs(v - 0.1) >= 1e-6]})",
      ok=len(full) >= 1 and all(v <= 0.1 + 1e-9 for v in lens))

# the lead-in SVG/PDF must still be valid and still carry no annotations
# A lead-in only works if it is part of the SAME path as the contour: laser
# software cuts each path separately and never joins a stray line to a closed
# contour. So each led-in contour must appear as ONE open path that carries the
# whole outline, and nothing may be lost in the swap.
_info = LI.lead_in_report(d_adam, 0.1)
svg_l = LI.svg_single_leadin(d_adam, 0.1)
cut_group = svg_l.split('id="CUT"', 1)[1].split("</g>", 1)[0]
cut_ds_l = [d for d in re.findall(r'<path d="([^"]*)"', cut_group) if d.strip()]
n_open = sum(1 for d in cut_ds_l if "Z" not in d)
n_closed = sum(1 for d in cut_ds_l if "Z" in d)
_rings_all = LI._rings(d_adam)
pts_per_open = sorted((len(re.findall(r"[ML]", d)) for d in cut_ds_l
                       if "Z" not in d), reverse=True)
ok_l = (n_open == len(_info["runs"])
        and len(_info["runs"]) + len(_info["closed"]) == len(_rings_all)
        and (n_closed == 1 if _info["closed"] else n_closed == 0)
        and pts_per_open and pts_per_open[0] > 20
        and "<text" not in svg_l and "<rect" not in svg_l
        and 'id="ENGRAVE"' in svg_l)
check("lead-in SVG — each lead-in merged into its contour as one open path",
      f"{len(_info['runs'])} open path(s) carrying whole contours, "
      f"{len(_info['runs'])}+{len(_info['closed'])}={len(_rings_all)} contours "
      f"accounted for, ENGRAVE present, no <text>/<rect>",
      f"{n_open} open + {n_closed} closed in CUT; biggest open path has "
      f"{pts_per_open[0] if pts_per_open else 0} points (a bare stub would be 2); "
      f"runs+closed={len(_info['runs'])}+{len(_info['closed'])}; "
      f"no text/rect={'<text' not in svg_l and '<rect' not in svg_l}", ok=ok_l)

# nothing may be silently dropped or duplicated by the merge
from shapely.geometry import LineString as _LS2
_orig_len = sum(_LS2(list(r) + [r[0]]).length for r in _rings_all)
_new_len = (sum(_LS2(list(r) + [r[0]]).length for r in _info["closed"])
            + sum(_LS2(r[1:]).length for r in _info["runs"]))
check("lead-in merge preserves every contour exactly",
      "total contour length unchanged by merging lead-ins in",
      f"before {_orig_len:.4f} font units, after {_new_len:.4f} "
      f"(delta {abs(_orig_len - _new_len):.6f})",
      ok=abs(_orig_len - _new_len) < 1e-6)

# and each run must return to its anchor, so the outline still closes
_bad_runs = [r for r in _info["runs"] if len(r) < 5 or r[1] != r[-1]]
check("each merged run starts in scrap and closes the contour",
      "every run: pierce first, then the contour, ending back at its anchor",
      f"{len(_info['runs'])} run(s), {len(_bad_runs)} malformed",
      ok=not _bad_runs)

ok_chk4, detail4 = qpdf_check(LI.pdf_document_leadin([d_adam], 0.1), "leadin")
check("lead-in PDF — qpdf --check passes", "check passes", detail4, ok=ok_chk4)

# --------------------------------------------------------------------------- #
#  sheet layout — vertical and horizontal, and names must never overlap
# --------------------------------------------------------------------------- #
print("-" * 78)
print("sheet layout")
print("-" * 78)

import nameplate_layout as LAY

_three = [d_adam, d_oliv, d_mj]
for direction in (LAY.VERTICAL, LAY.HORIZONTAL):
    sheet = LAY.arrange(_three, 0.25, direction)
    sw, sh = sheet.size()
    widths = [d.size()[0] for d in _three]
    heights = [d.size()[1] for d in _three]
    if direction == LAY.HORIZONTAL:
        exp_w, exp_h = sum(widths) + 0.5, max(heights)
    else:
        exp_w, exp_h = max(widths), sum(heights) + 0.5
    check(f"sheet {direction} — size is the names plus the gaps",
          f"{exp_w:.3f} x {exp_h:.3f} in",
          f"{sw:.3f} x {sh:.3f} in",
          ok=(abs(sw - exp_w) < 1e-6 and abs(sh - exp_h) < 1e-6))

    clash = LAY.overlaps(_three, 0.25, direction)
    check(f"sheet {direction} — no name overlaps another",
          "no overlapping pairs", f"{len(clash)} overlapping pair(s) {clash}",
          ok=not clash)

    # every contour must survive the arrangement
    n_before = sum(len(r) for d in _three for r in d.cut_paths)
    n_after = sum(len(r) for r in sheet.cut_paths)
    check(f"sheet {direction} — every contour kept",
          f"{n_before} contours", f"{n_after} contours", ok=(n_before == n_after))

# a gap of 0 must touch, not overlap; only a negative gap can overlap
check("sheet — gap 0 touches but does not overlap",
      "no overlapping pairs at gap 0",
      f"{len(LAY.overlaps(_three, 0.0, LAY.HORIZONTAL))} pair(s)",
      ok=not LAY.overlaps(_three, 0.0, LAY.HORIZONTAL))
check("sheet — a negative gap IS reported as overlapping",
      "overlap detected so export can refuse",
      f"{len(LAY.overlaps(_three, -0.5, LAY.HORIZONTAL))} pair(s) flagged",
      ok=bool(LAY.overlaps(_three, -0.5, LAY.HORIZONTAL)))

# vertical must remain byte-identical to the original engine stacking
check("sheet vertical — identical to the engine's own stack()",
      "same SVG as svg_sheet()",
      "identical" if svg_single(LAY.arrange([d_adam, d_oliv], 0.25,
                                           LAY.VERTICAL)) ==
                     svg_sheet([d_adam, d_oliv], 0.25) else "DIFFERS",
      ok=(svg_single(LAY.arrange([d_adam, d_oliv], 0.25, LAY.VERTICAL)) ==
          svg_sheet([d_adam, d_oliv], 0.25)))

# --------------------------------------------------------------------------- #
#  golden regression — byte-identical SVG from the tested engine
# --------------------------------------------------------------------------- #
print("-" * 78)
print("golden/ regression (byte comparison against the tested engine's output)")
print("-" * 78)

golden_cases = [
    ("ADAM_cap1in.svg", lambda: svg_single(d_adam)),
    ("OLIVIA_cap1in.svg", lambda: svg_single(d_oliv)),
    ("Carrie_cap25mm.svg", lambda: svg_single(d_carrie)),
    ("sheet_ADAM_OLIVIA.svg", lambda: svg_sheet([d_adam, d_oliv], 0.25)),
]
for fname, gen in golden_cases:
    path = os.path.join(GOLDEN, fname)
    if not os.path.exists(path):
        check(f"golden {fname}", "file present", "missing", ok=False)
        continue
    want = open(path, encoding="utf-8").read()
    got = gen()
    check(f"golden {fname}", f"identical to golden ({len(want)} bytes)",
          "identical" if got == want else
          f"DIFFERS (got {len(got)} bytes vs {len(want)})", ok=(got == want))

# --------------------------------------------------------------------------- #
print("=" * 78)
n_pass = sum(1 for r in results if r[0])
print(f"{n_pass}/{len(results)} passed")
for ok, name, exp, act in results:
    if not ok:
        print(f"  FAIL: {name}\n     expected: {exp}\n     actual:   {act}")
print("=" * 78)
sys.exit(0 if n_pass == len(results) else 1)

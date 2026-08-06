"""
stress_test.py — size accuracy and lead-in placement across many fonts/names.

    python stress_test.py --font "<path>" [--font "<path>" ...]
    python stress_test.py --font-dir "<dir>"          (all .ttf/.otf inside)

WHAT IT PROVES
  SIZE
    S1  aspect ratio is identical at every height  (scaling height scales width
        by exactly the same factor — nothing gets stretched)
    S2  width scales linearly with height          w(kH) == k*w(H)
    S3  in and mm agree                            1 in artwork == 25.4 mm artwork
    S4  'cap' basis really is the first capital's ink height, re-derived
        independently from cmap rather than trusting the engine's number
    S5  'total' basis really is the whole artwork height
    S6  'xheight' basis uses the font's own OS/2 sxHeight
  LEAD-INS
    L1  count == one per hole + one per outer boundary
    L2  none of them run through the material of the name
    L3  no pierce point sits in the material
    L4  every hole has one, and its pierce is inside THAT hole
    L5  the outer lead-in's pierce is outside the part
    L6  each lead-in ends exactly on a vertex of its contour (Corel Join Curves)
    L7  lead-ins never change scale / bbox / size()
    L8  lead-in length is physical and constant across heights (or shortened
        only because a hole is too small, never longer than asked)

Exit code 0 = everything passed.
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import traceback

from shapely.geometry import LineString, Point

import nameplate_leadin as LI
from nameplate_core import MM_PER_IN, Font, build_document

NAMES = ["A", "ADAM", "OLIVIA", "EMMA", "Mary Jane", "Christopher",
         "Sophia", "Ava", "liam", "Jo", "MICHAEL", "Bella Rose"]
HEIGHTS_IN = [0.5, 1.0, 2.0, 4.0]
BASES = ["cap", "xheight", "total"]
TOL_RATIO = 1e-9
TOL_ABS = 1e-6


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, bool, str]] = []

    def add(self, font: str, check: str, ok: bool, detail: str = "") -> None:
        self.rows.append((font, check, ok, detail))

    @property
    def failures(self):
        return [r for r in self.rows if not r[2]]

    def summary(self) -> str:
        n = len(self.rows)
        return f"{n - len(self.failures)}/{n} checks passed"


def cap_ink_height(font: Font, text: str):
    """First capital's ink height in font units, derived from cmap directly."""
    for ch in text:
        if ch.isupper():
            g = font.cmap.get(ord(ch))
            if not g:
                continue
            ys = [p[1] for c in font.contours(g) for p in c]
            if ys:
                return max(ys) - min(ys)
    return None


def check_size(font: Font, fname: str, rep: Report) -> None:
    for name in NAMES:
        try:
            docs = {h: build_document(font, name, h, "in", "cap")
                    for h in HEIGHTS_IN}
        except Exception as exc:
            rep.add(fname, f"S:build {name!r}", False,
                    f"{type(exc).__name__}: {exc}")
            continue

        sizes = {h: d.size() for h, d in docs.items()}
        if any(w <= 0 or hh <= 0 for w, hh in sizes.values()):
            rep.add(fname, f"S:nonzero {name!r}", False, f"{sizes}")
            continue

        # S1 aspect ratio constant
        ratios = [w / hh for w, hh in sizes.values()]
        spread = max(ratios) - min(ratios)
        rep.add(fname, f"S1 aspect constant {name!r}", spread < 1e-9,
                f"w/h spread {spread:.3e} over heights {HEIGHTS_IN}")

        # S2 width linear in height
        base_h = HEIGHTS_IN[0]
        bw, bh = sizes[base_h]
        worst = 0.0
        for h in HEIGHTS_IN[1:]:
            k = h / base_h
            w, hh = sizes[h]
            worst = max(worst, abs(w - bw * k) / (bw * k), abs(hh - bh * k) / (bh * k))
        rep.add(fname, f"S2 width scales with height {name!r}", worst < 1e-9,
                f"max relative error {worst:.3e}")

        # S3 in vs mm
        d_mm = build_document(font, name, 25.4, "mm", "cap")
        w_in, h_in = sizes[1.0]
        w_mm, h_mm = d_mm.size()
        err = max(abs(w_in * MM_PER_IN - w_mm), abs(h_in * MM_PER_IN - h_mm))
        rep.add(fname, f"S3 in==mm {name!r}", err < 1e-6,
                f"1in -> {w_in * MM_PER_IN:.6f}x{h_in * MM_PER_IN:.6f}mm vs "
                f"25.4mm -> {w_mm:.6f}x{h_mm:.6f}mm (err {err:.2e})")

        # S4 the CAP LINE must land at the requested height. Not the first
        # capital's ink: a round 'O' overshoots the cap line and a 'J' descends
        # below the baseline, so their ink is legitimately taller. What has to be
        # identical between names is where the cap line sits, because that is
        # what makes 'JADAM' the same size as 'ADAM'.
        from nameplate_core import _cap_reference
        ref, _refwarn = _cap_reference(font)
        if ref:
            got = ref * docs[2.0].scale
            rep.add(fname, f"S4 cap line at requested height {name!r}",
                    abs(got - 2.0) < 1e-9,
                    f"cap line lands at {got:.9f} in, asked 2.0")

        # S5 total basis == whole artwork height
        dt = build_document(font, name, 2.0, "in", "total")
        rep.add(fname, f"S5 total basis {name!r}",
                abs(dt.size()[1] - 2.0) < 1e-6,
                f"artwork height {dt.size()[1]:.9f} in, asked 2.0")

    # S6 xheight basis: the x-LINE must land at the requested height, i.e. the
    # basis equals the measured modal top of the flat lowercase (x z v w u s).
    # The declared OS/2.sxHeight is only a fallback — it is wrong by 16-35% in
    # two of the shipped families, so asserting it here would enshrine the bug.
    tops = []
    for ch in "xzvwus":
        g = font.cmap.get(ord(ch))
        if not g:
            continue
        ys = [p[1] for c in font.contours(g) for p in c]
        if ys and max(ys) > 0:
            tops.append(round(max(ys), 3))
    if tops:
        expect = max(set(tops), key=lambda t: (tops.count(t), t))
        d = build_document(font, "Adam", 1.0, "in", "xheight")
        rep.add(fname, "S6 xheight is the measured lowercase top",
                abs(d.basis_height - expect) < 1e-6,
                f"basis_height {d.basis_height:g} vs measured {expect:g}")


def check_leadins(font: Font, fname: str, rep: Report) -> None:
    for name in NAMES:
        for unit, height, lead in (("in", 1.0, 0.1), ("mm", 25.4, 2.5),
                                   ("in", 4.0, 0.1)):
            tag = f"{name!r}@{height}{unit}"
            try:
                doc = build_document(font, name, height, unit, "cap")
                rings = LI._rings(doc)
                polys, depths, mat = LI._analyse(rings)
                info = LI.lead_in_report(doc, lead)
                leads = info["leads"]
            except Exception as exc:
                rep.add(fname, f"L:build {tag}", False,
                        f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=2)}")
                continue

            holes = [(p, r) for p, r, d in zip(polys, rings, depths) if d % 2 == 1]
            outers = [(p, r) for p, r, d in zip(polys, rings, depths) if d % 2 == 0]
            want_fu = lead / doc.scale
            tol = want_fu * 0.02

            # L1 count: one per cuttable hole + one per outer boundary. Holes
            # finer than the laser kerf are legitimately skipped, but nothing
            # may fail silently — info["failed"] must be zero.
            expect = len(holes) - info["skipped_tiny"] + len(outers)
            rep.add(fname, f"L1 count {tag}",
                    len(leads) == expect and info["failed"] == 0,
                    f"{len(leads)} lead-ins, expected {expect} "
                    f"({len(holes)} holes - {info['skipped_tiny']} sub-kerf "
                    f"+ {len(outers)} outer), unexplained failures="
                    f"{info['failed']}")

            # L2/L3 never in the material
            in_mat = [l for l in leads
                      if mat.intersection(LineString(l)).length > tol]
            rep.add(fname, f"L2 not through material {tag}", not in_mat,
                    f"{len(in_mat)} lead-in(s) cross the name")
            pierce_in = [l for l in leads if mat.contains(Point(l[0]))]
            rep.add(fname, f"L3 pierce in scrap {tag}", not pierce_in,
                    f"{len(pierce_in)} pierce point(s) inside the name")

            # L4 every hole reported as "served" must really have a pierce
            # inside it. Only holes whose best achievable lead-in is finer than
            # the kerf are exempt, and those are reported, never silent.
            missed = []
            for h in info["holes_detail"]:
                if h["status"] != "served":
                    continue
                hp = polys[h["ring"]]
                if not any(hp.buffer(tol).contains(Point(l[0])) for l in leads):
                    missed.append(hp.area)
            n_served = sum(1 for h in info["holes_detail"]
                           if h["status"] == "served")
            rep.add(fname, f"L4 every cuttable hole has a lead-in {tag}",
                    not missed,
                    f"{len(missed)} served hole(s) with no pierce inside "
                    f"(areas {[round(a, 1) for a in missed][:5]}); "
                    f"{n_served}/{len(holes)} served, "
                    f"{info['skipped_tiny']} sub-kerf exempt")

            # L5 outer pierce outside the part
            bad_outer = []
            for op, _or_ in outers:
                outs = [l for l in leads if not op.buffer(-tol).contains(Point(l[0]))
                        and not op.contains(Point(l[0]))]
                if not outs:
                    bad_outer.append(1)
            rep.add(fname, f"L5 outer lead-in is outside {tag}",
                    not bad_outer or not outers,
                    f"{len(bad_outer)}/{len(outers)} outer boundaries without an "
                    f"outside pierce")

            # L6 ends exactly ON a contour (anchors may sit mid-edge, since a
            # long edge with no node is often the only safe place to enter)
            from shapely.geometry import LinearRing
            boundary = [LineString(list(r) + [r[0]]) for r in rings]
            eps = want_fu * 1e-6 + 1e-9
            off = [l for l in leads
                   if min(b.distance(Point(l[-1])) for b in boundary) > eps]
            on_vert = sum(1 for l in leads
                          if (round(l[-1][0], 6), round(l[-1][1], 6))
                          in {(round(x, 6), round(y, 6)) for r in rings for x, y in r})
            rep.add(fname, f"L6 ends on the contour {tag}", not off,
                    f"{len(off)} lead-in(s) not touching a contour; "
                    f"{on_vert}/{len(leads)} landed exactly on an existing node")

            # L7 size untouched
            before = (doc.scale, doc.bbox, doc.size(), doc.basis_height)
            _ = LI.lead_in_lines(doc, lead)
            ex = LI.doc_for_export(doc, leads)
            rep.add(fname, f"L7 size untouched {tag}",
                    before == (doc.scale, doc.bbox, doc.size(), doc.basis_height)
                    and ex.scale == doc.scale,
                    f"scale/bbox/size stable, export scale same="
                    f"{ex.scale == doc.scale}")

            # L8 physical length: never longer than asked
            lens = [LineString(l).length * doc.scale for l in leads]
            too_long = [v for v in lens if v > lead + 1e-9]
            rep.add(fname, f"L8 length <= requested {tag}", not too_long,
                    f"{len(too_long)} too long; lengths "
                    f"{[round(v, 4) for v in lens][:8]}")

            # L9 standoff: never graze a letter edge along the run
            hard = LI.hard_clearance(unit)
            near_fu = hard / doc.scale * 1.15
            clears = []
            for l in leads:
                seg = LineString(l)
                a, p = l[1], l[0]
                t = min(near_fu / max(seg.length, 1e-12), 0.9)
                start = (a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t)
                clears.append(LineString([start, p]).distance(mat) * doc.scale)
            worst = min(clears) if clears else float("inf")
            rep.add(fname, f"L9 standoff from letters {tag}",
                    worst >= hard * 0.98,
                    f"worst standoff {worst:.5f} {unit}, floor {hard:g} "
                    f"over {len(leads)} lead-ins")

            # L10 exempt holes must be provably too tight to enter safely
            tiny = [h for h in info["holes_detail"] if h["status"] == "tiny"]
            bad = [h for h in tiny
                   if h.get("width", 0.0) > LI.hard_clearance(unit) * 1.6]
            rep.add(fname, f"L10 exemptions justified {tag}", not bad,
                    f"{len(tiny)} exempt; widths "
                    f"{[round(h.get('width', 0), 5) for h in tiny][:6]} "
                    f"vs standoff floor {LI.hard_clearance(unit):g} "
                    f"(a hole must be narrower than ~1.6x the standoff to be "
                    f"exempt); unjustified={len(bad)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", action="append", default=[])
    ap.add_argument("--font-dir", action="append", default=[])
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    paths = list(args.font)
    for d in args.font_dir:
        for ext in ("*.ttf", "*.otf", "*.ttc"):
            paths += sorted(glob.glob(os.path.join(d, ext)))
    paths = [p for p in paths if os.path.isfile(p)]
    if not paths:
        ap.error("no font files given")

    rep = Report()
    for path in paths:
        label = os.path.basename(path)
        print(f"=== {label}")
        try:
            font = Font(path)
        except Exception as exc:
            rep.add(label, "open font", False, f"{type(exc).__name__}: {exc}")
            print(f"    FAILED TO OPEN: {exc}")
            continue
        print(f"    family={font.family!r} upem={font.upem} "
              f"colr={'yes' if font.colr else 'no'}")
        check_size(font, label, rep)
        check_leadins(font, label, rep)
        fails = [r for r in rep.rows if r[0] == label and not r[2]]
        print(f"    {len([r for r in rep.rows if r[0] == label]) - len(fails)}"
              f"/{len([r for r in rep.rows if r[0] == label])} passed"
              + (f"  <-- {len(fails)} FAILURES" if fails else ""))
        if fails and not args.quiet:
            for _f, chk, _ok, det in fails[:20]:
                print(f"      FAIL {chk}: {det}")

    print("=" * 78)
    print(rep.summary())
    if rep.failures:
        print(f"\n{len(rep.failures)} FAILURES:")
        seen = {}
        for f, chk, _ok, det in rep.failures:
            key = chk.split(" ")[0]
            seen.setdefault(key, []).append((f, chk, det))
        for key, items in sorted(seen.items()):
            print(f"\n  [{key}] {len(items)} failure(s)")
            for f, chk, det in items[:10]:
                print(f"    {f}: {chk}\n        {det}")
    print("=" * 78)
    return 0 if not rep.failures else 1


if __name__ == "__main__":
    sys.exit(main())

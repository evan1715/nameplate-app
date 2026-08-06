"""
nameplate_eyelets.py — measure the hanging eyelets on a finished nameplate.

    inner diameter  ·  outer diameter  ·  wall thickness

Measured from the ACTUAL artwork for the name and height you are about to cut,
not from the font in the abstract: the eyelet only exists as a contextual glyph
(A.eyeL, m.eyeR and friends), so it has to be measured after shaping.

WHAT COUNTS AS AN EYELET
    A near-circular hole close to the left or right end of the artwork. Letter
    counters (the hole in an 'o') are round too, so candidates are ranked by how
    circular they are and how close to an end they sit, and the boss around them
    has to be round as well.

HOW EACH NUMBER IS TAKEN
    inner diameter  twice the largest circle that fits inside the hole, which
                    for a round hole is exactly its diameter. Cross-checked
                    against the diameter implied by the hole's area; a big
                    disagreement means the hole is not truly round and is
                    reported rather than hidden.
    outer diameter  rays are cast from the hole's centre until they leave the
                    material. Where the eyelet merges into the letter a ray runs
                    on down the stroke, so those rays are outliers — the boss
                    radius is taken as the median of the shorter 60%, and the
                    spread is reported so you can see how round it really is.
    wall thickness  the shortest distance from the hole's edge to the outside
                    edge of the material. That minimum is the number that
                    decides whether the eyelet tears out, so it is given
                    alongside the median.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

from shapely.geometry import LineString, Point, Polygon

import nameplate_leadin as LI

CIRCULARITY_MIN = 0.72          # 4*pi*A / P^2 ; a perfect circle is 1.0
ASPECT_TOL = 0.35               # how far from square the hole's box may be
END_FRACTION = 0.30             # "near an end" = within this much of the width
RAYS = 240
BOSS_QUANTILE = 0.60            # share of shortest rays taken as the boss

# The boss-roundness gate this module's own docstring has always promised and
# never had. A round hole is not enough: the counter of a 'b' or an 'o' near the
# end of a name is round too, and without this the final letter's counter was
# reported as a RIGHT EYELET, complete with paste-ready instructions to resize
# it. Measured on the shipped Merriweather with the name 'Bob': the genuine left
# eyelet's accepted ray radii spread 0.2% of the outer radius, the false 'b'
# counter 34.8% -- two orders of magnitude apart, so the threshold is not
# delicate. A real eyelet is a ring of roughly constant width around its hole;
# a letter counter is not.
BOSS_SPREAD_MAX = 0.30


@dataclass
class Eyelet:
    side: str                   # "left" | "right" | "middle"
    unit: str
    inner_d: float
    outer_d: float
    wall_min: float
    wall_median: float
    centre: tuple[float, float]  # in doc units, from the artwork's bottom-left
    circularity: float
    inner_d_from_area: float
    boss_spread: float          # max-min of the accepted ray radii
    note: str = ""
    # Where on the hole's edge the wall is thinnest, in doc units from the
    # artwork's bottom-left. None when the wall could not be walked. Used to put
    # the wall dimension on screen at the place that actually tears out.
    wall_min_at: tuple[float, float] | None = None
    # False when the material around the hole is not a ring of roughly even
    # width -- i.e. this is probably a letter counter that happens to be round
    # and near an end, not an eyelet. Suspect entries are left OUT of
    # measure_eyelets' result unless it is asked for them, because every caller
    # downstream (the GUI table, the report, the paste-ready prompt, the brief's
    # judge) would otherwise be quoting a letter's counter as an eyelet.
    confident: bool = True
    boss_spread_ratio: float = 0.0

    @property
    def wall_from_diameters(self) -> float:
        return (self.outer_d - self.inner_d) / 2.0


def _circularity(poly) -> float:
    try:
        p = poly.length
        return (4 * math.pi * poly.area / (p * p)) if p > 0 else 0.0
    except Exception:
        return 0.0


def _median(vals):
    v = sorted(vals)
    if not v:
        return 0.0
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def measure_eyelets(doc, max_eyelets: int = 2,
                    include_suspect: bool = False) -> list[Eyelet]:
    """Eyelets found in this document, left-most first. Empty if none look round.

    `include_suspect=True` also returns candidates that failed the
    boss-roundness gate, with `confident=False`, so a report can say "this looks
    like a letter counter" instead of silently showing one letter fewer.
    """
    rings = LI._rings(doc)
    if not rings:
        return []
    polys, depths, material = LI._analyse(rings)
    if material.is_empty:
        return []

    holes = [(p, r) for p, r, d in zip(polys, rings, depths) if d % 2 == 1]
    solids = [Polygon(r) for r, d in zip(rings, depths) if d % 2 == 0]
    solids = [s if s.is_valid else s.buffer(0) for s in solids]
    if not holes or not solids:
        return []

    x0, y0, x1, y1 = doc.bbox
    width = max(x1 - x0, 1e-9)
    s = doc.scale

    # ---- pick the round holes that sit near an end ---------------------- #
    cands = []
    for poly, ring in holes:
        try:
            circ = _circularity(poly)
            bx0, by0, bx1, by1 = poly.bounds
            w, h = bx1 - bx0, by1 - by0
            if w <= 0 or h <= 0:
                continue
            aspect = abs(w - h) / max(w, h)
            if circ < CIRCULARITY_MIN or aspect > ASPECT_TOL:
                continue
            cx = (bx0 + bx1) / 2.0
            frac = (cx - x0) / width
            near_end = min(frac, 1.0 - frac)
            if near_end > END_FRACTION:
                continue
            cands.append((near_end, frac, poly, circ))
        except Exception:
            continue
    if not cands:
        return []

    # the most end-most, most circular first
    cands.sort(key=lambda c: (c[0], -c[3]))
    chosen = cands[:max_eyelets]
    chosen.sort(key=lambda c: c[1])                 # left to right

    out: list[Eyelet] = []
    for near_end, frac, poly, circ in chosen:
        try:
            r_in = LI._inradius(poly)
            if r_in <= 0:
                continue
            # centre of the inscribed circle, approximated by the box centre of
            # the deepest inset that is still non-empty
            try:
                core = poly.buffer(-r_in * 0.95)
                c = core.centroid if not core.is_empty else poly.centroid
            except Exception:
                c = poly.centroid
            cx, cy = c.x, c.y

            r_area = math.sqrt(poly.area / math.pi)

            host = None
            for sol in solids:
                try:
                    if sol.contains(Point(cx, cy)):
                        host = sol
                        break
                except Exception:
                    continue
            if host is None:
                continue

            # ---- outer radius by ray casting ------------------------- #
            reach = max(width, doc.bbox[3] - doc.bbox[1]) * 2.0
            radii = []
            for i in range(RAYS):
                th = 2 * math.pi * i / RAYS
                ray = LineString([(cx, cy),
                                  (cx + reach * math.cos(th),
                                   cy + reach * math.sin(th))])
                try:
                    hit = host.exterior.intersection(ray)
                except Exception:
                    continue
                if hit.is_empty:
                    continue
                pts = (list(hit.geoms) if hasattr(hit, "geoms") else [hit])
                best = None
                for g in pts:
                    for coord in (g.coords if hasattr(g, "coords") else []):
                        d = math.hypot(coord[0] - cx, coord[1] - cy)
                        if d > r_in and (best is None or d < best):
                            best = d
                if best is not None:
                    radii.append(best)
            if not radii:
                continue
            radii.sort()
            keep = radii[:max(3, int(len(radii) * BOSS_QUANTILE))]
            r_out = _median(keep)
            spread = (keep[-1] - keep[0]) if keep else 0.0

            # ---- wall thickness straight off the geometry ------------- #
            # The point of the THINNEST wall is kept as well as its length: it
            # is the spot that tears out, so a caller drawing the wall on screen
            # can put the dimension exactly there instead of at some arbitrary
            # angle that happens to look tidy.
            walls = []
            thin_at = None
            try:
                ext = poly.exterior
                n = max(24, min(180, int(ext.length / max(r_in, 1e-9) * 12)))
                for i in range(n):
                    p = ext.interpolate(i / n, normalized=True)
                    d = host.exterior.distance(p)
                    walls.append(d)
                    if thin_at is None or d < thin_at[0]:
                        thin_at = (d, (p.x, p.y))
            except Exception:
                pass
            wall_min = min(walls) if walls else max(r_out - r_in, 0.0)
            wall_med = _median(walls) if walls else max(r_out - r_in, 0.0)

            note = ""
            if abs(r_in - r_area) / max(r_in, 1e-9) > 0.12:
                note = ("the hole is not truly round, so the inner diameter "
                        "depends on where you measure")
            elif spread > r_out * 0.25:
                note = ("the boss is not truly round, so the outer diameter is "
                        "an average")

            side = ("left" if frac < 0.33 else
                    ("right" if frac > 0.67 else "middle"))
            # A ring of even width, or a letter's counter? The accepted ray radii
            # of a true eyelet barely vary; a counter's vary hugely because the
            # "boss" is really the letter's stroke going off in one direction.
            ratio = (spread / r_out) if r_out else 0.0
            confident = ratio <= BOSS_SPREAD_MAX
            if not confident:
                note = (note + "; " if note else "") + (
                    "the material around this hole is not a ring of even width "
                    f"(it varies by {ratio * 100:.0f}% of the radius), so this "
                    f"is probably a letter counter rather than an eyelet")
            out.append(Eyelet(
                side=side, unit=doc.unit,
                inner_d=2 * r_in * s, outer_d=2 * r_out * s,
                wall_min=wall_min * s, wall_median=wall_med * s,
                centre=((cx - x0) * s, (cy - y0) * s),
                circularity=circ, inner_d_from_area=2 * r_area * s,
                boss_spread=spread * s, note=note,
                confident=confident, boss_spread_ratio=ratio,
                wall_min_at=(((thin_at[1][0] - x0) * s,
                              (thin_at[1][1] - y0) * s) if thin_at else None)))
        except Exception:
            continue
    return out if include_suspect else [e for e in out if e.confident]


@dataclass
class Adjustment:
    """What the FONT has to change by so the eyelet hits a target at a height.

    Because every measurement scales linearly with the height, a ratio measured
    at one height is the same ratio in font units — so the font-unit targets
    below hold at any height, not just the one measured.
    """
    unit: str
    scale: float                 # font units -> unit
    m_id: float
    t_id: float
    m_wall: float
    t_wall: float
    m_od: float
    t_od: float

    def _pct(self, m, t):
        return ((t / m) - 1.0) * 100.0 if m else float("nan")

    @property
    def id_pct(self):
        return self._pct(self.m_id, self.t_id)

    @property
    def wall_pct(self):
        return self._pct(self.m_wall, self.t_wall)

    @property
    def od_pct(self):
        return self._pct(self.m_od, self.t_od)

    def fu(self, v):
        return v / self.scale if self.scale else float("nan")


def _valid_target(value, label: str):
    """None means 'keep the measured value'. Anything else must be a real size.

    A silent falsy check here made an explicit 0 vanish without a word, and a
    negative target produced instructions like 'scale the hole to -73% of its
    diameter' — nonsense that would be pasted straight to a font editor.
    """
    if value is None:
        return None
    v = float(value)
    if not math.isfinite(v) or v <= 0:
        raise ValueError(
            f"A target {label} of {value!r} is not a usable size — give a "
            f"positive number, or leave it unset to keep the measured value.")
    return v


def adjustment(eyelet: Eyelet, doc, target_id=None, target_wall=None) -> Adjustment:
    """Compare a measured eyelet with the size you want at this height.

    Either target may be None, in which case the measured value is kept — so you
    can ask for a new hole without touching the wall, or the reverse. Zero and
    negative targets are refused with a message rather than ignored.
    """
    target_id = _valid_target(target_id, "inner diameter")
    target_wall = _valid_target(target_wall, "wall thickness")
    m_id = eyelet.inner_d
    m_wall = eyelet.wall_from_diameters
    t_id = float(target_id) if target_id else m_id
    t_wall = float(target_wall) if target_wall else m_wall
    return Adjustment(unit=eyelet.unit, scale=doc.scale,
                      m_id=m_id, t_id=t_id,
                      m_wall=m_wall, t_wall=t_wall,
                      m_od=m_id + 2 * m_wall, t_od=t_id + 2 * t_wall)


def _adjust_lines(e: Eyelet, doc, target_id, target_wall) -> list[str]:
    a = adjustment(e, doc, target_id, target_wall)
    u = a.unit
    L = [f"    TO HIT YOUR TARGET at this height",
         f"      {'':16s} {'now':>10s}  {'want':>10s}  {'change':>9s}"
         f"   {'font units now -> want':>26s}"]

    def row(label, m, t, pct):
        return (f"      {label:16s} {m:10.4f}  {t:10.4f}  {pct:+8.2f}%"
                f"   {a.fu(m):11.1f} -> {a.fu(t):<11.1f}")

    L.append(row("inner diameter", a.m_id, a.t_id, a.id_pct))
    L.append(row("wall thickness", a.m_wall, a.t_wall, a.wall_pct))
    L.append(row("outer diameter", a.m_od, a.t_od, a.od_pct))
    L.append(f"      (sizes in {u}; font units are what a font editor works in)")
    L.append("")
    L.append(f"      Instruction to hand over:")
    L.append(f"        Scale this eyelet's hole to {100 + a.id_pct:.2f}% of its "
             f"current diameter")
    L.append(f"        and set the ring wall to {100 + a.wall_pct:.2f}% of its "
             f"current thickness.")
    L.append(f"        In font units: hole {a.fu(a.t_id):.1f} across, wall "
             f"{a.fu(a.t_wall):.1f}, outer {a.fu(a.t_od):.1f}.")
    L.append(f"        Those font-unit sizes give {a.t_id:.4f} {u} inner and "
             f"{a.t_wall:.4f} {u} wall whenever the name is set to "
             f"{doc.target_height:g} {u} {doc.basis} height.")
    L.append("")
    return L


def report_text(doc, eyelets=None, target_id=None, target_wall=None) -> str:
    """The measurements as text for a dialog or the console."""
    suspect = []
    if eyelets is None:
        # ask for the rejects too, so a hole that ALMOST looked like an eyelet is
        # mentioned rather than leaving the reader wondering where it went
        every = measure_eyelets(doc, include_suspect=True)
        eyelets = [e for e in every if e.confident]
        suspect = [e for e in every if not e.confident]
    u = doc.unit
    w, h = doc.size()
    lines = [f"{doc.text} — {w:.3f} x {h:.3f} {u}", ""]
    if not eyelets:
        lines += [
            "No eyelet found.",
            "",
            "Nothing near either end of this artwork is a round hole. Either "
            "this font has no eyelet, or the name does not use the eyelet "
            "forms — those are contextual, so they usually appear only on the "
            "first and last letter.",
        ]
        return "\n".join(lines)

    for e in eyelets:
        lines.append(f"{e.side.upper()} EYELET")
        lines.append(f"    inner diameter   {e.inner_d:.4f} {u}")
        lines.append(f"    outer diameter   {e.outer_d:.4f} {u}")
        lines.append(f"    wall (OD-ID)/2   {e.wall_from_diameters:.4f} {u}")
        lines.append(f"    wall, thinnest   {e.wall_min:.4f} {u}   "
                     f"<- the number that decides if it tears out")
        lines.append(f"    wall, typical    {e.wall_median:.4f} {u}")
        lines.append(f"    centre           "
                     f"{e.centre[0]:.3f}, {e.centre[1]:.3f} {u} "
                     f"from the bottom-left of the artwork")
        lines.append(f"    roundness        {e.circularity:.3f} "
                     f"(1.000 is a perfect circle)")
        if e.note:
            lines.append(f"    note             {e.note}")
        lines.append("")
        # `is not None`, not truthiness: an explicit 0 is a mistake the user
        # needs to hear about, not a value to silently drop
        if target_id is not None or target_wall is not None:
            try:
                lines += _adjust_lines(e, doc, target_id, target_wall)
            except ValueError as exc:
                # a bad target must be SAID, never silently dropped
                lines += [f"    TARGET NOT USABLE: {exc}", ""]
    lines.append("Inner diameter is the largest circle that fits the hole.")
    lines.append("Outer diameter is measured out to the edge of the material "
                 "around it.")
    lines.append("Two wall figures are given because the boss is rarely "
                 "perfectly concentric: (OD-ID)/2 is the average wall, and "
                 "'thinnest' is the weakest point.")
    if suspect:
        lines.append("")
        lines.append("NOT COUNTED AS EYELETS")
        for e in suspect:
            lines.append(
                f"    a round hole at the {e.side} end, inner diameter "
                f"{e.inner_d:.4f} {u}, was left out: the material around it "
                f"varies by {e.boss_spread_ratio * 100:.0f}% of its radius, so "
                f"it is a letter's counter rather than an eyelet. A real eyelet "
                f"is a ring of roughly even width.")
    return "\n".join(lines)


def claude_prompt(doc, eyelets=None, target_id=None, target_wall=None,
                  font_path: str | None = None) -> str:
    """A paste-ready instruction for whoever edits the font, or "".

    Empty when there is nothing to ask for - no eyelet found, or no target
    typed. The caller shows an empty box in that case rather than inventing a
    request, because an eyelet that is already the right size needs no change.
    """
    if target_id is None and target_wall is None:
        return ""
    if eyelets is None:
        eyelets = measure_eyelets(doc)
    if not eyelets:
        return ""
    try:
        _valid_target(target_id, "inner diameter")
        _valid_target(target_wall, "wall thickness")
    except ValueError as exc:
        return f"TARGET NOT USABLE: {exc}"

    u = doc.unit
    base = os.path.basename(font_path) if font_path else ""
    fam = getattr(doc, "font_family", "") or ""
    who = f"{fam} ({base})" if fam and base else (fam or base or "this font")
    L = [f"Edit the eyelet in the font {who} so it comes out at the size below.",
         "",
         f"Measured from the name {doc.text!r} set to {doc.target_height:g} {u} "
         f"{_basis_words(doc.basis)}.",
         ""]
    for e in eyelets:
        try:
            a = adjustment(e, doc, target_id, target_wall)
        except ValueError as exc:
            L.append(f"{e.side.upper()} EYELET: {exc}")
            continue
        L.append(f"{e.side.upper()} EYELET")
        L.append(f"  inner diameter  {a.m_id:.4f} -> {a.t_id:.4f} {u}"
                 f"   ({a.id_pct:+.2f}%)")
        L.append(f"  wall thickness  {a.m_wall:.4f} -> {a.t_wall:.4f} {u}"
                 f"   ({a.wall_pct:+.2f}%)")
        L.append(f"  outer diameter  {a.m_od:.4f} -> {a.t_od:.4f} {u}"
                 f"   ({a.od_pct:+.2f}%)")
        L.append(f"  In FONT UNITS (what your editor works in, and what actually "
                 f"has to change):")
        L.append(f"    hole diameter  {a.fu(a.m_id):.1f} -> {a.fu(a.t_id):.1f}")
        L.append(f"    wall           {a.fu(a.m_wall):.1f} -> "
                 f"{a.fu(a.t_wall):.1f}")
        L.append(f"    outer diameter {a.fu(a.m_od):.1f} -> {a.fu(a.t_od):.1f}")
        L.append("")
    L += [
        "HOW TO MAKE THE CHANGE",
        "  Resize the eyelet hole and the ring around it to the font-unit sizes "
        "above. Keep the eyelet concentric and keep its centre where it is, so "
        "the letters do not move.",
        "  Do not change the cap height, the x-height, unitsPerEm, the advance "
        "widths, or any letter outline. Do not add, delete or reorder glyphs - "
        "this app addresses glyphs by ID.",
        "  The eyelet is a contextual form on the first and last letter, so "
        "change it in EVERY glyph that carries one, or the two ends of a name "
        "will no longer match.",
        "",
        "WHY FONT UNITS  Everything scales linearly with the height, so a "
        "font-unit size holds at every cutting height - set it once and the "
        f"eyelet is right at {doc.target_height:g} {u} and at any other height.",
    ]
    return "\n".join(L)


def _basis_words(basis: str) -> str:
    return {"cap": "cap height", "xheight": "x-height",
            "total": "total height"}.get(str(basis), str(basis))


def main(argv=None) -> int:
    import sys

    from nameplate_core import Font, build_document
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2:
        print("usage: python nameplate_eyelets.py <font> <name> "
              "[height] [in|mm] [cap|xheight|total] "
              "[target_inner_diameter] [target_wall]")
        return 2
    path, name = args[0], args[1]
    height = float(args[2]) if len(args) > 2 else 1.0
    unit = args[3] if len(args) > 3 else "in"
    basis = args[4] if len(args) > 4 else "cap"
    t_id = float(args[5]) if len(args) > 5 else None
    t_wall = float(args[6]) if len(args) > 6 else None
    doc = build_document(Font(path), name, height, unit, basis)
    print(report_text(doc, target_id=t_id, target_wall=t_wall))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

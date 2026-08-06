"""
nameplate_leadin.py — laser lead-in lines, the way CorelDRAW wants them.

WHAT A LEAD-IN IS HERE, AND WHY IT IS MERGED INTO THE CONTOUR
    The laser pierces out in the scrap and travels in along a short approach
    before it reaches the part, so the pierce mark never lands on a finished
    edge.

    CorelDRAW has no notion of a lead-in — it is an illustration program, and
    lead-in/lead-out is a feature of laser software (LightBurn generates them
    from Angle/Length/Style settings) or of a CAM plugin. Crucially, laser
    software treats every path in a file as its own separate cut and does NOT
    join a stray open line onto a nearby closed contour.

    So a lead-in drawn as its own little line does not work: the machine would
    cut that line in the scrap, then separately pierce the closed contour on the
    finished edge — exactly the mark the lead-in was meant to avoid.

    Therefore a contour that gets a lead-in is emitted as ONE continuous OPEN
    path: pierce point -> anchor on the contour -> all the way round -> back to
    the anchor. Any software that simply follows the path then starts in the
    scrap and flows into the outline. Contours with no lead-in stay closed.
    See merge_run(). Nothing is lost: runs + closed == every contour, and the
    total contour length is unchanged.

    If your laser software has its own lead-in feature, prefer it and leave this
    switched off, or you will get two lead-ins.

WHERE THEY GO
    * every hole (letter counters, eyelet holes)  -> lead-in lies INSIDE the
      hole, i.e. in the waste that drops out
    * the outer boundary                          -> one lead-in, OUTSIDE the
      part, in the surrounding scrap
    * never anywhere inside the material of the name itself

CLEARANCE — why a lead-in is not just "doesn't touch the letter"
    Not crossing the material is not enough. A lead-in running a thousandth of
    an inch alongside an edge will still scorch or cut it, because the beam has
    width and a heat-affected zone. So every lead-in must also keep a standoff
    from ALL material along its length, and it leaves the contour at 90 degrees
    so it departs the edge as directly as possible. The only place it is allowed
    to be near material is the last fraction next to its own anchor point,
    where touching the contour is the entire purpose.

ADAPTIVE LENGTH — small counters like 'e', 'a', 'o'
    The length is not guessed from a fixed ladder. For each candidate entry
    point the search measures how far it can actually travel while holding the
    standoff, by bisection, and takes the best position on the contour. A tight
    counter therefore gets the longest clear lead-in that genuinely fits rather
    than a coarse fraction or nothing at all. If even the standoff cannot be
    honoured, it is relaxed in steps before anything is given up.

HEIGHT
    This module never touches doc.bbox, doc.basis_height, doc.scale or
    doc.size(). It reads a finished Document and returns extra polylines. The
    reported artwork size is therefore identical whether lead-ins are on or off.
    The only thing that can change is the exported page/canvas size, and only
    when an outer lead-in would otherwise be clipped — see doc_for_export().
"""

from __future__ import annotations

import math
from dataclasses import replace

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep

from nameplate_core import (MM_PER_IN, Document, pdf_document, stack,
                            svg_single)

DEFAULT_LEN_IN = 0.100          # a sane default lead-in, in inches
DEFAULT_LEN_MM = 2.5            # and in mm

# Standoff kept from every letter edge along the lead-in's length. Roughly a
# kerf plus its heat-affected zone.
CLEARANCE_IN = 0.012
CLEARANCE_MM = 0.30

# If the full standoff will not fit, relax it in these steps so a tight counter
# still gets a lead-in — but never below HARD_CLEARANCE. That floor is what
# stops a sub-kerf sliver being "served" by a lead-in running along its wall:
# below it there is no safe entry, so the hole is exempted instead.
_CLEAR_STEPS = (1.0, 0.65, 0.4)
HARD_CLEARANCE_IN = 0.004       # inches
HARD_CLEARANCE_MM = 0.10        # mm

# Below this a lead-in is finer than the kerf, so the "hole" it would sit in is
# not something the laser can cut anyway. Merging overlapping letters can leave
# slivers this small; they are reported as skipped, never silently dropped.
MIN_LEAD_IN = 0.008             # inches
MIN_LEAD_MM = 0.20              # mm

_SAMPLES = 56                   # candidate entry points per contour
_BISECT = 14                    # bisection steps when measuring usable length

# A tiny ABSOLUTE slack in font units. Everything that needs "did this really
# touch the material, or is it just floating-point noise at the anchor?" uses
# this. It must never be derived from the requested lead-in length: doing so
# meant a long requested lead-in bought itself permission to cut through the
# part, in proportion to how long it was asked to be.
_EPS_FU = 1e-6


def default_length(unit: str) -> float:
    return DEFAULT_LEN_MM if unit == "mm" else DEFAULT_LEN_IN


def default_clearance(unit: str) -> float:
    return CLEARANCE_MM if unit == "mm" else CLEARANCE_IN


def hard_clearance(unit: str) -> float:
    return HARD_CLEARANCE_MM if unit == "mm" else HARD_CLEARANCE_IN


def min_length(unit: str) -> float:
    return MIN_LEAD_MM if unit == "mm" else MIN_LEAD_IN


# --------------------------------------------------------------------------- #
#  contour analysis
# --------------------------------------------------------------------------- #
def _rings(doc: Document) -> list[list[tuple[float, float]]]:
    return [ring for rings in doc.cut_paths for ring in rings if len(ring) >= 3]


def _analyse(rings) -> tuple[list[Polygon], list[int], object]:
    """Polygon per ring, nesting depth per ring, and the material area.

    depth 0 (even) = solid boundary, depth 1 (odd) = hole, and so on.
    """
    polys = []
    for r in rings:
        p = Polygon(r)
        if not p.is_valid:
            p = p.buffer(0)
        polys.append(p)

    # Nesting is measured with points taken from the ring ITSELF, not from
    # representative_point(): a ring-only polygon includes its own counter, so
    # the outer contour of an 'O' has a representative point sitting inside the
    # hole, and the outer contour gets misread as a hole. Several vertices are
    # sampled so a single tangent vertex cannot flip the answer.
    depths = []
    for i, (p, ring) in enumerate(zip(polys, rings)):
        if p.is_empty:
            depths.append(0)
            continue
        step = max(1, len(ring) // 5)
        probes = [Point(ring[k]) for k in range(0, len(ring), step)][:5]
        depths.append(sum(1 for j, q in enumerate(polys)
                          if j != i and not q.is_empty
                          and any(q.contains(pt) for pt in probes)))

    # Build the mask by ALTERNATING in ascending depth order, not as one
    # union-of-evens minus union-of-odds.
    #
    # A hole ring covers everything nested inside it, so subtracting all the odd
    # rings at once deletes any depth-2 island as well: the island is inside the
    # depth-1 hole, so the difference removes it. Every safety check downstream
    # then sees empty space where a solid part actually sits, and a lead-in is
    # free to run straight through it. Measured on the shipped TGCarrie fonts,
    # reachable by typing (c) or (R): a lead cut 0.0318 in and 0.0807 in of real
    # material, silently breaking this module's one hard promise.
    #
    # Peeling depth by depth is the same expression for max depth <= 1 -- which
    # is every letter of every name -- so ordinary artwork is bit-identical.
    by_depth: dict[int, list] = {}
    for p, d in zip(polys, depths):
        if not p.is_empty:
            by_depth.setdefault(d, []).append(p)
    material = Polygon()
    for d in sorted(by_depth):
        layer = unary_union(by_depth[d])
        if layer.is_empty:
            continue
        material = (material.difference(layer) if d % 2
                    else material.union(layer))
    return polys, depths, material


def _inradius(poly, iters: int = 30) -> float:
    """Largest r whose r-inset is still non-empty — how wide the hole is.

    Used only to explain WHY a hole was exempted: a hole narrower than the
    standoff cannot be entered safely no matter how long it is.
    """
    try:
        if poly.is_empty:
            return 0.0
        lo, hi = 0.0, max(poly.bounds[2] - poly.bounds[0],
                          poly.bounds[3] - poly.bounds[1])
    except Exception:
        return 0.0
    for _ in range(iters):
        mid = (lo + hi) / 2
        try:
            empty = poly.buffer(-mid).is_empty
        except Exception:
            empty = True
        if empty:
            hi = mid
        else:
            lo = mid
    return lo


class _Void:
    """The material, plus standoff-buffered copies cached per clearance."""

    def __init__(self, material) -> None:
        self.material = material
        self.prep_material = prep(material)
        self._cache: dict[float, tuple] = {}

    def buffered(self, clearance: float):
        key = round(clearance, 7)
        if key not in self._cache:
            g = self.material.buffer(clearance) if clearance > 0 else self.material
            self._cache[key] = (g, prep(g))
        return self._cache[key]


# --------------------------------------------------------------------------- #
#  finding one lead-in
# --------------------------------------------------------------------------- #
def _candidates(ring, max_pts: int = 56):
    """(anchor, normal) pairs sampled along the contour by ARC LENGTH.

    Sampling only the vertices is not enough. A union contour can be a triangle
    whose longest edge runs 250 font units with no node in the middle — and the
    middle of that edge is exactly where a lead-in wants to enter. Anchoring at
    the corners instead aims the entry along the wedge and finds nothing.

    Each sample uses its own edge's true perpendicular, which is also a better
    entry direction than a corner's bisector.
    """
    n = len(ring)
    segs = []
    perimeter = 0.0
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L > 1e-9:
            # The RING index travels with the edge. Zero-length edges are
            # skipped here, so enumerating this list would give a position in
            # the filtered list, not in the ring — and merge_run() indexes the
            # raw ring with it. One duplicated interior vertex would then shift
            # the whole traversal by a vertex and close the contour with a chord
            # straight through the middle of the part.
            segs.append((a, b, L, i))
            perimeter += L
    if not segs:
        return []

    spacing = max(perimeter / max(max_pts, 1), 1e-9)
    out = []
    for a, b, L, ring_idx in segs:
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, ny = -uy, ux
        k = max(1, int(round(L / spacing)))
        for j in range(k):
            t = (j + 0.5) / k                 # midpoints, never the corners
            p = (a[0] + ux * L * t, a[1] + uy * L * t)
            out.append((p, (nx, ny), ring_idx))
            out.append((p, (-nx, -ny), ring_idx))
    return out


def merge_run(ring, anchor, edge_idx: int, pierce):
    """One continuous open path: pierce -> anchor -> all the way round -> anchor.

    THIS is what makes a lead-in actually work. CorelDRAW has no notion of a
    lead-in, and laser software treats every path in the file separately — so a
    lead-in drawn as its own little line is simply cut as its own little line,
    and the contour still gets pierced on the finished edge. Emitting the
    lead-in and the contour as ONE path means the beam starts out in the scrap,
    travels in along the lead-in, and flows straight into the outline.

    The run ends back at the anchor, so the contour is closed by coincidence
    while the path itself stays open.
    """
    n = len(ring)
    if n < 3:
        return [pierce, anchor]
    # walk from the anchor's edge all the way around and back to the anchor
    tail = [ring[(edge_idx + 1 + k) % n] for k in range(n)]
    return [pierce, anchor] + tail + [anchor]


def _usable_length(anchor, nx, ny, void: _Void, clearance: float,
                   limit: float) -> float:
    """How far this perpendicular can travel while holding the standoff.

    The first `near` of the run is exempt from the standoff — that stretch is
    the approach to the anchor, where being next to the contour is the point.
    """
    gclear, pclear = void.buffered(clearance)
    # Always step a little off the anchor before the standoff is enforced,
    # otherwise a clearance of 0 would test a segment starting exactly on the
    # boundary and reject everything. This floor must NOT scale with the
    # requested length: tying it to `limit` meant asking for a 10 in lead-in
    # created a 2 in exemption zone and switched the safety check off.
    near = max(clearance * 1.15, _EPS_FU)
    pm = void.prep_material

    def ok(L: float) -> bool:
        if L <= near:
            return False
        # the perpendicular must not dive straight into the material (this
        # happens at a reflex vertex, where "outward" points inward)
        for t in (0.4, 0.8, 1.0):
            q = Point(anchor[0] + nx * near * t, anchor[1] + ny * near * t)
            if pm.contains(q):
                return False
        far = LineString([(anchor[0] + nx * near, anchor[1] + ny * near),
                          (anchor[0] + nx * L, anchor[1] + ny * L)])
        return not pclear.intersects(far)

    if ok(limit):
        return limit
    lo, hi = 0.0, limit
    for _ in range(_BISECT):
        mid = (lo + hi) / 2
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo


def _verify(line, void: _Void, tol: float) -> bool:
    """The strict check: never through the material, pierce never inside it."""
    seg = LineString(line)
    try:
        if void.material.intersection(seg).length > tol:
            return False
        return not void.material.contains(Point(line[0]))
    except Exception:
        return False


def _find_lead_in(ring, void: _Void, length: float, clearance: float,
                  bbox=None, prefer_top: bool = True):
    """Best (line, achieved_length, achieved_clearance) here, or None.

    "Best" is the longest that holds the standoff; ties break toward the one
    sitting furthest from any edge, then toward a fixed side so repeat jobs
    come out identical.
    """
    tol = _EPS_FU          # absolute: never scales with the requested length

    cands = []
    n_full = 0
    for anchor, (nx, ny), edge_idx in _candidates(ring, _SAMPLES):
        usable = _usable_length(anchor, nx, ny, void, clearance, length)
        if usable <= 0:
            continue
        pierce = (anchor[0] + nx * usable, anchor[1] + ny * usable)
        in_bbox = True
        if bbox is not None:
            x0, y0, x1, y1 = bbox
            in_bbox = (x0 <= pierce[0] <= x1) and (y0 <= pierce[1] <= y1)
        cands.append((in_bbox, usable, pierce, anchor, edge_idx))
        if usable >= length * 0.999 and in_bbox:
            n_full += 1
            # several spots already take the full requested length; nothing
            # better exists, and scanning a 2000-point contour is waste
            if n_full >= 8:
                break
    if not cands:
        return None

    # longest first, and keep it inside the artwork box when that is possible
    cands.sort(key=lambda c: (not c[0], -c[1],
                              -c[2][1] if prefer_top else c[2][1]))

    # among the near-longest, prefer the one with the most room around it
    best_len = cands[0][1]
    shortlist = [c for c in cands if c[1] >= best_len * 0.98][:12]
    scored = []
    for in_bbox, usable, pierce, anchor, edge_idx in shortlist:
        near = clearance * 1.15
        far = LineString([(anchor[0] + (pierce[0] - anchor[0]) / usable * near,
                           anchor[1] + (pierce[1] - anchor[1]) / usable * near),
                          pierce])
        try:
            room = far.distance(void.material)
        except Exception:
            room = 0.0
        scored.append((in_bbox, usable, room, pierce, anchor, edge_idx))
    scored.sort(key=lambda c: (not c[0], -c[2],
                               -c[3][1] if prefer_top else c[3][1]))

    for in_bbox, usable, room, pierce, anchor, edge_idx in scored:
        line = [pierce, anchor]
        if _verify(line, void, tol):
            return line, usable, room, edge_idx
    for in_bbox, usable, pierce, anchor, edge_idx in cands:   # fall back
        line = [pierce, anchor]
        if _verify(line, void, tol):
            return line, usable, 0.0, edge_idx
    return None


# --------------------------------------------------------------------------- #
#  public API
# --------------------------------------------------------------------------- #
def lead_in_report(doc: Document, length_in_unit: float | None = None,
                   clearance_in_unit: float | None = None) -> dict:
    """Lead-ins plus what happened, so callers can report honestly.

    Returns {"leads", "holes", "outers", "skipped_tiny", "failed",
             "holes_detail", "leads_detail"}. Lengths and clearances in
    holes_detail / leads_detail are physical, in doc.unit.
    """
    if length_in_unit is None:
        length_in_unit = default_length(doc.unit)
    if clearance_in_unit is None:
        clearance_in_unit = default_clearance(doc.unit)
    # Every early return must carry the SAME keys as the full result, or a
    # caller that reads info["runs"] dies with KeyError on exactly the inputs
    # that need graceful handling (length 0, a name with no ink). "closed" is
    # filled in below once the rings are known.
    empty = {"leads": [], "runs": [], "closed": [], "holes": 0, "outers": 0,
             "skipped_tiny": 0, "failed": 0,
             "holes_detail": [], "leads_detail": []}
    rings = _rings(doc)
    # With no lead-ins, every contour stays closed — so "closed" is all of them
    # and runs+closed still accounts for the whole outline.
    empty["closed"] = list(rings)
    if length_in_unit <= 0 or not rings:
        return empty

    length = length_in_unit / doc.scale          # unit -> font units
    # The floor exists to SKIP holes where only a sub-kerf lead-in would fit —
    # it must never override a deliberately tiny requested length, or asking
    # for 0.005 in lead-ins exempts every hole with a reason ("too narrow")
    # that is factually false. The user's explicit number wins.
    floor = min(min_length(doc.unit), length_in_unit) / doc.scale
    base_clear = max(clearance_in_unit, 0.0) / doc.scale
    polys, depths, material = _analyse(rings)
    if material.is_empty:
        return empty
    void = _Void(material)

    hard = max(hard_clearance(doc.unit) / doc.scale, 0.0)
    levels = []
    for cf in _CLEAR_STEPS:                  # relax, but never below the floor
        c = max(base_clear * cf, hard)
        if not levels or abs(c - levels[-1]) > 1e-9:
            levels.append(c)
    # The ladder must always bottom out at the kerf floor. Without this, a
    # huge requested standoff (bigger than the lead length allows) makes every
    # lead-in impossible BY CONSTRUCTION, and the file exports with the pierce
    # on the finished edge without a word said. The kerf floor is still a real
    # standoff, so safety is kept; only the user's excessive number is relaxed.
    if levels and abs(levels[-1] - hard) > 1e-9:
        levels.append(hard)

    def attempt(ring, bbox, prefer_top):
        """Best lead-in honouring the largest standoff that actually fits."""
        best = None
        for c in levels:
            got = _find_lead_in(ring, void, length, c,
                                bbox=bbox, prefer_top=prefer_top)
            if got is None:
                continue
            line, achieved, room, edge_idx = got
            best = (line, achieved, room, c, edge_idx)
            if achieved >= floor:
                return best
        return best

    out: list[list] = []
    runs: list[list] = []          # pierce + full contour, as ONE open path
    led = set()                    # ring indices that became a run
    holes_detail: list[dict] = []
    leads_detail: list[dict] = []
    n_holes = n_outers = skipped = failed = 0

    for idx, (ring, _poly, depth) in enumerate(zip(rings, polys, depths)):
        if depth % 2 != 1:
            continue
        n_holes += 1
        got = attempt(ring, None, True)
        if got is None or got[1] < floor:
            # No safe entry exists here. Prove the hole really is tight by
            # measuring what would fit with NO standoff at all: that number is
            # recorded so a caller can tell a genuinely sub-kerf sliver from an
            # algorithm that simply failed to find a spot.
            probe = _find_lead_in(ring, void, length, 0.0, bbox=None,
                                  prefer_top=True)
            probe_len = (probe[1] * doc.scale) if probe else 0.0
            # The honest measure of "no safe entry" is the hole's WIDTH, not how
            # far a line could run along it. A narrow slot between two letters
            # can be long yet still too tight to stand off from both walls.
            width = _inradius(_poly) * doc.scale
            skipped += 1
            holes_detail.append({
                "ring": idx, "status": "tiny",
                "length": (got[1] * doc.scale) if got else 0.0,
                "clearance": (got[2] * doc.scale) if got else 0.0,
                "probe": probe_len, "width": width,
                "reason": "too narrow to enter with a safe standoff"})
            continue
        line, achieved, room, used_clear, edge_idx = got
        out.append(line)
        runs.append(merge_run(ring, line[1], edge_idx, line[0]))
        led.add(idx)
        holes_detail.append({"ring": idx, "status": "served",
                             "length": achieved * doc.scale,
                             "clearance": room * doc.scale})
        leads_detail.append({"kind": "hole", "ring": idx,
                             "length": achieved * doc.scale,
                             "clearance": room * doc.scale,
                             "standoff_asked": used_clear * doc.scale})

    for idx, (ring, _poly, depth) in enumerate(zip(rings, polys, depths)):
        if depth % 2 != 0:
            continue
        n_outers += 1
        got = attempt(ring, doc.bbox, False)
        if got is None:
            failed += 1
            continue
        line, achieved, room, used_clear, edge_idx = got
        out.append(line)
        runs.append(merge_run(ring, line[1], edge_idx, line[0]))
        led.add(idx)
        leads_detail.append({"kind": "outer", "ring": idx,
                             "length": achieved * doc.scale,
                             "clearance": room * doc.scale,
                             "standoff_asked": used_clear * doc.scale})

    return {"leads": out, "runs": runs,
            "closed": [r for i, r in enumerate(rings) if i not in led],
            "holes": n_holes, "outers": n_outers,
            "skipped_tiny": skipped, "failed": failed,
            "holes_detail": holes_detail, "leads_detail": leads_detail}


def lead_in_lines(doc: Document, length_in_unit: float | None = None,
                  clearance_in_unit: float | None = None) -> list[list]:
    """Lead-in polylines for one document, in FONT UNITS.

    length_in_unit is the physical lead-in length in doc.unit (in or mm); it is
    converted through doc.scale, so a 0.1 in lead-in is 0.1 in on the material
    whatever the name's height.
    """
    return lead_in_report(doc, length_in_unit, clearance_in_unit)["leads"]


def lead_in_bbox(leads) -> tuple[float, float, float, float] | None:
    pts = [p for line in leads for p in line]
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def doc_for_export(doc: Document, leads) -> Document:
    """A copy whose bbox also covers the lead-ins, so none get clipped.

    Only the exported canvas grows. scale and basis_height are untouched, so
    the artwork is exactly the same physical size and doc.size() on the
    ORIGINAL doc is still the number to show the user.
    """
    lb = lead_in_bbox(leads)
    if lb is None:
        return doc
    x0, y0, x1, y1 = doc.bbox
    nx0, ny0, nx1, ny1 = min(x0, lb[0]), min(y0, lb[1]), max(x1, lb[2]), max(y1, lb[3])
    if (nx0, ny0, nx1, ny1) == (x0, y0, x1, y1):
        return doc
    return replace(doc, bbox=(nx0, ny0, nx1, ny1))


# -- exporters: same contract as the core ones, plus lead-ins ---------------- #
def _export_doc(doc: Document, info: dict) -> tuple:
    """(document to write, open paths to add) with lead-ins merged in.

    A contour that got a lead-in is written as ONE open path that starts out in
    the scrap; only contours without a lead-in stay closed. That is the whole
    point — see merge_run().
    """
    if not info["runs"]:
        return doc, ()
    ex = doc_for_export(doc, info["leads"])
    # [[]] would emit an empty <path d=""/>; give the writer nothing instead
    ex = replace(ex, cut_paths=[info["closed"]] if info["closed"] else [])
    return ex, info["runs"]


def svg_single_leadin(doc: Document, length_in_unit: float | None = None,
                      margin: float = 0.0,
                      clearance_in_unit: float | None = None) -> str:
    info = lead_in_report(doc, length_in_unit, clearance_in_unit)
    ex, extra = _export_doc(doc, info)
    return svg_single(ex, margin, extra_cut_lines=extra)


def pdf_document_leadin(docs: list[Document], length_in_unit: float | None = None,
                        margin_pt: float = 6.0,
                        clearance_in_unit: float | None = None) -> bytes:
    infos = [lead_in_report(d, length_in_unit, clearance_in_unit) for d in docs]
    pairs = [_export_doc(d, i) for d, i in zip(docs, infos)]
    return pdf_document([p[0] for p in pairs], margin_pt=margin_pt,
                        extra_cut_lines=[list(p[1]) for p in pairs])


def svg_sheet_leadin(docs: list[Document], gap: float = 0.25,
                     length_in_unit: float | None = None,
                     clearance_in_unit: float | None = None) -> str:
    return svg_single_leadin(stack(docs, gap), length_in_unit,
                             clearance_in_unit=clearance_in_unit)


def pdf_sheet_leadin(docs: list[Document], gap: float = 0.25,
                     length_in_unit: float | None = None,
                     margin_pt: float = 6.0,
                     clearance_in_unit: float | None = None) -> bytes:
    return pdf_document_leadin([stack(docs, gap)], length_in_unit, margin_pt,
                               clearance_in_unit)

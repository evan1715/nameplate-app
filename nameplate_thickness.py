"""
nameplate_thickness.py — where a name will SNAP, and what to tell the font.

WHY THIS EXISTS
    A nameplate is cut out of sheet metal and then handled. The whole plate is
    only as strong as its narrowest piece of material: the ankle of an 'a', the
    waist of a script join, the wall left between an eyelet hole and the edge of
    the letter. If that piece is thinner than the metal can carry it snaps — on
    the laser bed, in the box, or in the customer's hand.

    "This font is a bit thin" is not actionable. What is actionable is WHICH
    letter, WHERE on it, HOW thin, and by WHAT PERCENTAGE the font has to grow.
    The last of those is the reason this module exists at all: the fix belongs in
    the font, and whoever does it — a person or a model — works in FONT UNITS.
    So every number is given twice, in the shop's unit and in font units, and
    claude_prompt() writes the whole thing out as an instruction that can be
    pasted straight to an AI that edits fonts.

HOW THICKNESS IS MEASURED
    The same way nameplate_eyelets.py measures an eyelet wall: shoot a ray and
    see where it comes out. The material boundary is walked at evenly spaced
    points, and at each point a ray is cast along the INWARD normal until it
    leaves the material. That distance is the local thickness there — the length
    of metal a crack has to travel to break the plate at that spot.

    LIMITS, honestly
      * A ray along the normal measures ACROSS the stroke, which is exactly what
        is wanted, but near a sharp corner (a serif tip, the apex of an 'A', the
        end of a script swash) it can read short: it crosses a wedge that tapers
        away to nothing rather than a stroke with any real width. Such readings
        are rejected by requiring the MIDDLE of the ray to sit at least
        STRAIGHTNESS x the measured width from the boundary — true when the two
        walls are roughly parallel, false inside a wedge. A tapered stroke still
        passes; a spike does not. It is not perfect: a wedge wide enough to look
        like a stroke is reported as one, which is arguably correct anyway.
      * Nothing thicker than REACH_FRACTION of the height being measured is
        recorded. It is not thin, and measuring it is wasted time.
      * Sampling is capped — see MAX_SAMPLES. One union contour can carry 2000
        points and there are usually several, so an uncapped walk would turn a
        preview into a wait. The cap is printed with the numbers.
      * Everything is measured on the FLATTENED outline the app actually cuts
        from, so a reading is good to about a font unit and no better.

WHAT COUNTS AS ONE THIN SPOT
    A single thin ankle throws dozens of samples — both of its walls, all the
    way along it. Forty rows about one place would bury the second place. So
    samples are clustered per letter by proximity and each cluster is reported
    once, at its worst reading, carrying the number of samples behind it and its
    typical reading as well as its worst. A single freak sample is therefore
    visible as one instead of masquerading as a defect.

HEIGHT
    Like nameplate_leadin.py, this module never touches doc.bbox, doc.scale or
    doc.basis_height. It reads a finished Document and returns measurements, so
    the reported artwork size is the same whether you measure thickness or not.

LETTER NAMES NEED THE FONT
    A Document does not carry its Font, and the eyelet and alternate forms only
    exist after shaping. So pass font= (a Font or a path) to have each thin spot
    attributed to a letter. Without it the measurements are still correct; they
    are just located on the artwork rather than on a named letter.
"""

from __future__ import annotations

import math
import os
import re
import textwrap
from collections import namedtuple
from dataclasses import dataclass, field

from shapely.geometry import LineString, Point
from shapely.prepared import prep
from shapely.strtree import STRtree

import nameplate_leadin as LI

# Total boundary samples for the whole artwork, split between contours by
# length. 900 is roughly one sample per 1/40 of a cap height on a normal name —
# fine enough to find an ankle, coarse enough to finish in about a second.
MAX_SAMPLES = 900
MIN_RING_SAMPLES = 6            # even a tiny counter gets looked at

# Nothing thicker than this fraction of the measured height is a thin spot, so
# the ray stops there instead of running the length of a stem.
REACH_FRACTION = 0.75

# The wedge test. For a stroke with parallel walls the midpoint of the crossing
# sits exactly half the width from both walls, so room/width == 0.50. In a
# wedge the walls converge and the ratio falls. 0.42 accepts walls up to about
# 33 degrees out of parallel, which keeps tapered script strokes and rejects
# serif tips and apexes.
STRAIGHTNESS = 0.42

# Only the thinnest samples are clustered — clustering is O(n^2) and the thick
# ones are not the answer to any question here. POOL_PER_GLYPH guarantees every
# letter still contributes its own worst spot, so a name with one very thin
# letter does not hide the second-worst letter completely.
POOL = 300
POOL_PER_GLYPH = 4

# Two samples belong to the same thin area when they are within this of each
# other: a multiple of the local thickness (so the two walls of one stroke join
# up) or a multiple of the sample spacing (so consecutive samples along one
# stroke join up), whichever is larger.
LINK_T = 1.6
LINK_S = 2.5

# ...but an area may not sprawl further than this many times its own thickness
# from its worst reading. Without the limit, a monoline script — where the whole
# letter is the same weight — chains into a single "spot" covering the letter,
# which is the mirror image of the problem clustering was added to solve.
MAX_SPAN_T = 4.0

# And a reading only joins an area if it is within this factor of the reading the
# area started from. A thin serif slab sits right next to a thick stem, and
# without this the area swallows the stem, which drags its typical reading up and
# makes the thin place look like a stray measurement.
THICK_TOL = 1.5

# A uniform walk cannot see a web that is SHORT. Arc-length sampling spreads
# its points around the whole boundary, so a neck only 18 font units long has
# almost no arc to land on: on CHRISTOPHER at 1 in the nearest sample fell 47.7
# fu away from an 18.1 fu web between a counter wall and the outside edge, and
# the reported minimum was 120.1 fu -- 6.6x too thick, in the dangerous
# direction. Raising the sample count does not fix it (28,800 samples still read
# +62% on ADAM); the web has to be sought where it actually is.
#
# Real webs terminate at boundary VERTICES -- they are formed by two features
# almost meeting, and the almost-meeting points are nodes. So a second pass
# probes from every vertex toward the nearest opposite wall. It reuses
# _cross_width, which means the wedge test still applies: measured on the
# shipped fonts this pass found 54/65/32 spikes and rejected every one of them
# at clearance ~0.00, so it adds real webs without flooding the report with
# corner artifacts.
# The vertex pass uses the SAME wedge gate as the uniform walk. A stricter one
# was tried and rejected: the two webs whose truth is double-derived (ADAM 72.76
# fu, CHRISTOPHER 18.13 fu) sit at clearance 0.4997 and 0.500, so every candidate
# gate from 0.42 to 0.49 keeps them and the evidence cannot choose between them.
# Only a third, single-sourced case moved, and picking a threshold to make one
# unverified number agree is how a magic constant gets born. Instead the
# clearance ratio is REPORTED per spot: 0.50 is a parallel-walled web that will
# snap, and a reading nearer the gate is a taper into a junction, which you may
# reasonably choose to leave alone. Judgement belongs to the reader, with the
# number in front of them.
VERTEX_CEILING = 1.25       # only chase things this much thinner than we have
VERTEX_SECTORS = 16         # angular buckets: one per DIRECTION, not per distance
VERTEX_SKIP = 3             # ignore segments this close along the same ring

_Sample = namedtuple("_Sample", "p t exit gi")


# --------------------------------------------------------------------------- #
#  the measurement
# --------------------------------------------------------------------------- #
class _Solid:
    """The material, plus the lookups a thickness walk asks for over and over."""

    def __init__(self, material, span: float) -> None:
        self.material = material
        self.prep = prep(material)
        self.boundary = material.boundary
        # Absolute slack used for "did the ray really leave the material, or is
        # this the point it started from?".
        #
        # Derived from the ARTWORK's own size, not from the em. A Document from
        # stack() holds geometry already scaled into inches or millimetres with
        # scale == 1, and an em-derived slack of 0.2 there means 0.2 INCHES —
        # which quietly rejected every reading and reported a whole sheet as
        # having no thin spot at all. The artwork's span is the one measure that
        # means the same thing in both frames.
        #
        # Never derived from the thickness being measured: a thin spot must not
        # buy itself a bigger tolerance in proportion to how thin it is.
        self.eps = max(span * 1e-5, 1e-12)


def _ring_signed_area(ring) -> float:
    """Signed area of a closed ring -- negative when it runs clockwise."""
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def _canonical_rings(rings):
    """Put the ring set into a form that does not depend on the geometry backend.

    A union hands back rings that are geometrically exact but labelled
    arbitrarily: WHICH vertex a closed ring is listed from, and what order the
    holes come in, are artefacts of the overlay algorithm. Measured here, EVERY
    overlay operation rotates the exterior ring's start by exactly one vertex,
    so the label carries no meaning at all -- it just counts how many booleans
    the mask happened to take.

    That would not matter except that _walk() strides segments from the ring's
    start, so the arbitrary label decides WHICH segments get measured, and a
    different subset finds a slightly different set of thin spots. Anchoring
    every ring to its lexicographically smallest vertex and sorting the rings by
    that anchor makes the survey a property of the artwork rather than of the
    GEOS build -- and lets a second implementation reproduce it exactly.

    Safe because the anchor is a real vertex: distinct x values inside one ring
    are at least 1e-4 font units apart here, many orders of magnitude clear of
    double-precision noise, so any backend picks the identical vertex.
    """
    out = []
    for r in rings:
        k = min(range(len(r)), key=lambda i: (r[i][0], r[i][1]))
        out.append(list(r[k:]) + list(r[:k]))
    # Sorted too: _regions() seeds from a stable sort over the sample pool, so
    # the order rings are appended in breaks ties between equally thin readings.
    out.sort(key=lambda r: (r[0][0], r[0][1], len(r), _ring_signed_area(r)))
    return out


def _material_rings(material) -> list[list[tuple[float, float]]]:
    """Every boundary ring of the material: outsides and holes alike.

    A hole's wall is material boundary too, and the wall between a counter and
    the outside edge is exactly the kind of place that snaps.

    Handed back in canonical form -- see _canonical_rings for why that matters.
    """
    geoms = material.geoms if hasattr(material, "geoms") else [material]
    out: list[list[tuple[float, float]]] = []
    for g in geoms:
        if g.is_empty or g.geom_type != "Polygon":
            continue
        try:
            out.append(list(g.exterior.coords)[:-1])
            for r in g.interiors:
                out.append(list(r.coords)[:-1])
        except Exception:
            continue
    return _canonical_rings([r for r in out if len(r) >= 3])


def _ring_length(ring) -> float:
    n = len(ring)
    return sum(math.hypot(ring[(i + 1) % n][0] - ring[i][0],
                          ring[(i + 1) % n][1] - ring[i][1]) for i in range(n))


def _walk(rings, samples: int):
    """(point, normal) pairs spread around every boundary ring by arc length.

    Reuses nameplate_leadin._candidates, which samples segment MIDPOINTS rather
    than vertices — the same reason applies here as there. A corner has no
    meaningful normal, and a long edge with no node in the middle is exactly
    where a thin waist hides. _candidates offers both normals per point; which
    of the two points into the material is decided by measurement, not by
    trusting ring orientation.

    Its max_pts is a FLOOR, not a ceiling: it emits at least one sample per
    segment, and a flattened script contour has thousands of segments shorter
    than the spacing it works out. Asking for 900 on one such name produced
    4000, so each ring's samples are strided back down to the ring's share of
    the budget. The budget is therefore honoured to within MIN_RING_SAMPLES per
    contour, which is what keeps the walk under a second or two.
    """
    if not rings:
        return [], 0.0
    lengths = [max(_ring_length(r), 1e-9) for r in rings]
    total = sum(lengths)
    out = []
    for ring, L in zip(rings, lengths):
        k = max(MIN_RING_SAMPLES, int(round(samples * L / total)))
        cand = LI._candidates(ring, k)
        # _candidates emits the two opposite normals of a point back to back, so
        # thinning has to move in twos or half the points lose their inward one
        pairs = [cand[i:i + 2] for i in range(0, len(cand), 2)]
        if len(pairs) > k:
            stride = math.ceil(len(pairs) / k)
            pairs = pairs[::stride]
        out += [c for pair in pairs for c in pair]
    return out, total


def _vertex_probes(rings, ceiling: float, inside=None,
                   sectors: int = VERTEX_SECTORS):
    """(point, inward normal) pairs anchored on boundary VERTICES.

    For each vertex, boundary segments within `ceiling` are found and the
    perpendicular foot on each gives a direction to probe along. Only segments
    that are not the vertex's own neighbours count, and only candidates closer
    than `ceiling` are considered at all -- this pass exists to look for material
    THINNER than the uniform walk already found, so the search radius is small.

    ONE CANDIDATE PER DIRECTION, not the nearest N. Taking the nearest few
    segments looks reasonable and is wrong: on ADAM the vertex at the D's notch
    had its six nearest segments all within one degree of each other, so all six
    probes went the same way and the web 72.8 fu away at -145 deg was never
    tried. Bucketing by angle keeps the nearest candidate in each direction, so a
    crowd of near-parallel neighbours cannot crowd out the one that matters --
    and it costs FEWER probes, not more.

    `inside(x, y) -> bool` is an optional cheap containment test. Pass one: most
    candidate directions point straight across a COUNTER rather than through
    metal — the nearest boundary to a vertex is very often the far side of a
    hole — and on a script name 25,721 directions yielded 4 usable readings.
    Rejecting a direction whose chord midpoint is not in the material costs a
    prepared-geometry point test instead of a ray/boundary intersection.

    Yields directions, not measurements: whether a direction reads as a stroke
    or as a wedge is _cross_width's decision, exactly as for the uniform walk.
    """
    if ceiling <= 0:
        return []

    segs, seg_ring, seg_idx = [], [], []
    ring_n = []
    for ri, ring in enumerate(rings):
        n = len(ring)
        ring_n.append(n)
        if n < 2:
            continue
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            if a == b:
                continue
            segs.append(LineString([a, b]))
            seg_ring.append(ri)
            seg_idx.append(i)
    if not segs:
        return []

    verts, v_ring, v_idx = [], [], []
    for ri, ring in enumerate(rings):
        for i, v in enumerate(ring):
            verts.append(Point(v))
            v_ring.append(ri)
            v_idx.append(i)
    if not verts:
        return []

    tree = STRtree(segs)
    try:
        return _probe_dirs_bulk(tree, segs, seg_ring, seg_idx, verts, v_ring,
                                v_idx, ring_n, ceiling, inside, sectors)
    except Exception:
        # Any shapely/numpy shortfall falls back to the plain loop. Same answer,
        # just slower — never a different answer.
        return _probe_dirs_loop(tree, segs, seg_ring, seg_idx, verts, v_ring,
                                v_idx, ring_n, ceiling, inside, sectors)


def _sector_of(dx, dy, sectors: int) -> int:
    k = int((math.atan2(dy, dx) + math.pi) / (2.0 * math.pi) * sectors)
    return min(max(k, 0), sectors - 1)


def _neighbour_mask(v_ring, v_idx, s_ring, s_idx, ring_n):
    """True where a segment is the vertex's own corner rather than a web."""
    import numpy as np
    same = v_ring == s_ring
    n = np.asarray(ring_n)[v_ring]
    raw = np.abs(v_idx.astype(np.int64) - s_idx.astype(np.int64))
    around = np.minimum(raw, n - raw)
    return same & (around <= VERTEX_SKIP)


def _probe_dirs_bulk(tree, segs, seg_ring, seg_idx, verts, v_ring, v_idx,
                     ring_n, ceiling, inside, sectors):
    """One vectorised pass. 4,316 vertices in a single C query, not 4,316."""
    import numpy as np
    import shapely

    sr = np.asarray(seg_ring)
    si = np.asarray(seg_idx)
    vr = np.asarray(v_ring)
    vi_all = np.asarray(v_idx)
    varr = np.asarray(verts, dtype=object)
    sarr = np.asarray(segs, dtype=object)

    pairs = tree.query(varr, predicate="dwithin", distance=ceiling)
    if pairs.size == 0:
        return []
    vi, sj = pairs[0], pairs[1]

    keep = ~_neighbour_mask(vr[vi], vi_all[vi], sr[sj], si[sj], ring_n)
    vi, sj = vi[keep], sj[keep]
    if vi.size == 0:
        return []

    P = varr[vi]
    S = sarr[sj]
    d = shapely.distance(P, S)
    keep = (d > 0.0) & (d <= ceiling)
    vi, sj, P, S, d = vi[keep], sj[keep], P[keep], S[keep], d[keep]
    if vi.size == 0:
        return []

    t = shapely.line_locate_point(S, P)
    Q = shapely.line_interpolate_point(S, t)
    px, py = shapely.get_x(P), shapely.get_y(P)
    qx, qy = shapely.get_x(Q), shapely.get_y(Q)
    dx, dy = qx - px, qy - py
    L = np.hypot(dx, dy)
    keep = L > 0.0
    vi, d, px, py, qx, qy, dx, dy, L = (vi[keep], d[keep], px[keep], py[keep],
                                        qx[keep], qy[keep], dx[keep], dy[keep],
                                        L[keep])
    if vi.size == 0:
        return []

    if inside is not None:
        mx, my = (px + qx) / 2.0, (py + qy) / 2.0
        try:
            ok = _contains_xy_bulk(inside, mx, my)
        except Exception:
            ok = np.fromiter((bool(inside(a, b)) for a, b in zip(mx, my)),
                             dtype=bool, count=len(mx))
        vi, d, px, py, dx, dy, L = (vi[ok], d[ok], px[ok], py[ok], dx[ok],
                                    dy[ok], L[ok])
        if vi.size == 0:
            return []

    sec = ((np.arctan2(dy, dx) + np.pi) / (2.0 * np.pi) * sectors).astype(
        np.int64)
    np.clip(sec, 0, sectors - 1, out=sec)

    # nearest candidate per (vertex, direction sector)
    key = vi.astype(np.int64) * sectors + sec
    order = np.lexsort((d, key))
    key_s = key[order]
    first = np.ones(key_s.shape, dtype=bool)
    first[1:] = key_s[1:] != key_s[:-1]
    pick = order[first]

    ux, uy = dx[pick] / L[pick], dy[pick] / L[pick]
    return [((float(px[pick][i]), float(py[pick][i])),
             (float(ux[i]), float(uy[i]))) for i in range(pick.size)]


def _contains_xy_bulk(inside, mx, my):
    """Vectorised containment when the caller gave us a geometry to test."""
    import numpy as np
    import shapely
    geom = getattr(inside, "geom", None)
    if geom is None:
        raise TypeError("no bulk geometry available")
    return np.asarray(shapely.contains_xy(geom, mx, my), dtype=bool)


def _probe_dirs_loop(tree, segs, seg_ring, seg_idx, verts, v_ring, v_idx,
                     ring_n, ceiling, inside, sectors):
    """The plain per-vertex version. Kept as the reference implementation."""
    out = []
    for vpos, pv in enumerate(verts):
        ri, i = v_ring[vpos], v_idx[vpos]
        n = ring_n[ri]
        try:
            idxs = tree.query(pv, predicate="dwithin", distance=ceiling)
        except Exception:
            continue
        best = {}
        for j in idxs:
            if seg_ring[j] == ri:
                raw = abs(seg_idx[j] - i)
                if min(raw, n - raw) <= VERTEX_SKIP:
                    continue
            seg = segs[j]
            try:
                d = seg.distance(pv)
            except Exception:
                continue
            if not (0.0 < d <= ceiling):
                continue
            try:
                q = seg.interpolate(seg.project(pv))
            except Exception:
                continue
            dx, dy = q.x - pv.x, q.y - pv.y
            L = math.hypot(dx, dy)
            if L <= 0:
                continue
            k = _sector_of(dx, dy, sectors)
            if k not in best or d < best[k][0]:
                best[k] = (d, (dx / L, dy / L), (q.x, q.y))
        for _d, nvec, q in best.values():
            if inside is not None and not inside((pv.x + q[0]) / 2.0,
                                                 (pv.y + q[1]) / 2.0):
                continue
            out.append(((pv.x, pv.y), nvec))
    return out


def _cross_width(solid: _Solid, p, n, reach: float,
                 straightness: float | None = None):
    """Thickness across the material at p along inward normal n, or None.

    None means "no honest reading here": the normal points out of the material
    (a reflex vertex), nothing was crossed inside `reach` (so it is not thin),
    or the crossing failed the wedge test described at the top of the file.

    `straightness` overrides the wedge gate for one call. The vertex-anchored
    pass needs a stricter one: it deliberately starts AT nodes, and a node is
    exactly where a cusp is, so the taper into a junction can scrape past the
    gate that edge-midpoint samples never reach. See VERTEX_STRAIGHTNESS.
    """
    gate = STRAIGHTNESS if straightness is None else straightness
    eps = solid.eps
    if not solid.prep.contains(Point(p[0] + n[0] * eps, p[1] + n[1] * eps)):
        return None                       # this normal faces out, not in

    far = (p[0] + n[0] * reach, p[1] + n[1] * reach)
    try:
        hit = solid.boundary.intersection(LineString([p, far]))
    except Exception:
        return None                       # a self-touching ring here; skip it
    if hit.is_empty:
        return None

    ds = []
    for g in (hit.geoms if hasattr(hit, "geoms") else [hit]):
        for c in getattr(g, "coords", ()):
            d = math.hypot(c[0] - p[0], c[1] - p[1])
            if d > eps * 4:               # not the point we started from
                ds.append(d)
    if not ds:
        return None

    for d in sorted(ds):
        # A ray can graze a cusp without leaving the material, which would read
        # short. The first crossing that counts is the first one with OUTSIDE
        # just beyond it.
        if solid.prep.contains(Point(p[0] + n[0] * (d + eps),
                                     p[1] + n[1] * (d + eps))):
            continue
        mid = Point(p[0] + n[0] * d / 2, p[1] + n[1] * d / 2)
        try:
            room = solid.boundary.distance(mid)
        except Exception:
            return None
        if room < gate * d:
            return None                   # a wedge, not a stroke — see header
        return d
    return None


# --------------------------------------------------------------------------- #
#  which letter, and where on it
# --------------------------------------------------------------------------- #
_UNI = re.compile(r"^u(?:ni)?([0-9A-Fa-f]{4,6})$")


def _source_char(rev: dict, fwd: dict, gname: str, text: str,
                 placed_i, n_placed) -> str | None:
    """The character a shaped glyph came from, as far as it can be worked out.

    The position in the string is tried FIRST, and only when it can be
    corroborated: the character's own cmap glyph must have the same base name as
    the shaped glyph. Going the other way round — glyph name back to a character
    — gets the case wrong on a caps-only font, where 'o' and 'O' are the same
    glyph named 'O', and telling someone to thicken 'O' when they typed 'o' is
    the kind of small lie that wastes an afternoon.

    Failing that, a contextual form is not in the cmap at all ('A.eyeL',
    'O.e21'), so the suffix is dropped and the base looked up — preferring a
    character the name actually contains. Fonts with a format 3.0 post table
    carry no useful glyph names whatever, and there the raw position is the only
    handle there is; it is sound only when shaping produced exactly one glyph per
    character, so that is checked.
    """
    base = gname.split(".")[0]
    positional = (text[placed_i]
                  if (placed_i is not None and n_placed == len(text)
                      and 0 <= placed_i < len(text)) else None)
    if positional is not None:
        g = fwd.get(positional)
        if g and g.split(".")[0] == base:
            return positional
    for key in (gname, base):
        if key in rev:
            return rev[key]
    m = _UNI.match(base)
    if m:
        try:
            return chr(int(m.group(1), 16))
        except ValueError:
            pass
    if len(base) == 1 and base.isalpha():
        return base
    return positional


def _letters(font, text: str):
    """[(glyph name, source char, positioned filled polygon, prepared), ...].

    Straight out of nameplate_fontcheck.glyph_areas(), which already shapes the
    text and places each glyph's filled outline — the same shaping the artwork
    was built from, so a contextual eyelet form is the shape that is actually
    being cut, not the plain letter.
    """
    try:
        from nameplate_core import shape
        from nameplate_fontcheck import glyph_areas
    except Exception:
        return []
    try:
        placed = shape(font, text)
        areas = glyph_areas(font, text)
    except Exception:
        return []

    cmap = getattr(font, "cmap", {}) or {}
    fwd = {ch: cmap.get(ord(ch)) for ch in set(text)}
    rev: dict[str, str] = {}
    in_text = set(text)
    for cp, gname in cmap.items():
        ch = chr(cp)
        # a character from the name beats any other character that shares the
        # glyph, for the caps-only reason in _source_char()
        if gname not in rev or (ch in in_text and rev[gname] not in in_text):
            rev[gname] = ch

    # glyph_areas drops glyphs with no ink (a space), so its indices do not line
    # up with the shaped run. Walk both in order to recover each area's position
    # in the string, which is the last-resort source of the source character.
    out, j = [], 0
    for gname, poly in areas:
        while j < len(placed) and placed[j].glyph != gname:
            j += 1
        pi = j if j < len(placed) else None
        j += 1
        try:
            pr = prep(poly)
        except Exception:
            pr = None
        out.append((gname, _source_char(rev, fwd, gname, text, pi, len(placed)),
                    poly, pr))
    return out


def _which_letter(letters, pt) -> int:
    """Index of the letter whose ink contains this point, or the nearest one.

    Nearest-with-a-tolerance rather than a plain containment test: the union
    outline is rebuilt from curves after a boolean op while glyph_areas flattens
    each glyph separately, so a boundary point can land a fraction of a unit
    outside the letter it plainly belongs to.
    """
    q = Point(pt)
    for i, (_g, _c, _poly, pr) in enumerate(letters):
        if pr is not None and pr.contains(q):
            return i
    best, best_d = -1, None
    for i, (_g, _c, poly, _pr) in enumerate(letters):
        try:
            d = poly.distance(q)
        except Exception:
            continue
        if best_d is None or d < best_d:
            best, best_d = i, d
    return best


def _where(pos, bounds) -> str:
    """"upper right", "bottom", "left side" — a place on the letter, in words.

    Read off the letter's OWN ink box, so "bottom" means the bottom of that
    letter and not the bottom of the plate.
    """
    x0, y0, x1, y1 = bounds
    w, h = x1 - x0, y1 - y0
    fx = (pos[0] - x0) / w if w > 0 else 0.5
    fy = (pos[1] - y0) / h if h > 0 else 0.5
    vert = "bottom" if fy < 0.28 else ("top" if fy > 0.72 else "")
    horiz = "left" if fx < 0.30 else ("right" if fx > 0.70 else "")
    if vert and horiz:
        return f"{'lower' if vert == 'bottom' else 'upper'} {horiz}"
    if vert:
        return vert
    if horiz:
        return f"{horiz} side"
    return "middle"


def _eyelets(doc, polys, depths):
    """[(centre, hole radius)] for the eyelets, in doc.unit from the bottom-left.

    A wall next to an eyelet is the EYELET's wall: it is thin because the
    hardware decides how big the hole is, and it belongs to nameplate_eyelets.py,
    not to the font's stroke weight. Naming it stops the answer being "thicken
    the letter" when it is "move the hole inboard or make it smaller".

    This is nameplate_eyelets' own candidate test — round enough, square enough
    in the box, close enough to an end — reusing its constants so the two cannot
    drift apart. Roundness alone would not do: a square .notdef box scores 0.785
    and the counter of an 'o' scores higher still, so the box shape and the
    position along the artwork are both needed.

    It deliberately stops there instead of calling measure_eyelets(). That casts
    240 rays per eyelet and on a script name it cost more than this entire
    thickness walk (1.7s of 1.9s), and nothing here needs an outer diameter: the
    only question is whether a thin reading landed on an eyelet's wall. The
    eyelet tool stays the authority on what the eyelet actually measures.
    """
    try:
        import nameplate_eyelets as EY
        circularity, circ_min = EY._circularity, EY.CIRCULARITY_MIN
        aspect_tol, end_frac = EY.ASPECT_TOL, EY.END_FRACTION
    except Exception:
        return []

    x0, y0, x1, _y1 = doc.bbox
    width = max(x1 - x0, 1e-9)
    cands = []
    for p, d in zip(polys, depths):
        if d % 2 != 1 or p.is_empty:
            continue
        try:
            circ = circularity(p)
            if circ < circ_min:
                continue
            bx0, by0, bx1, by1 = p.bounds
            w, h = bx1 - bx0, by1 - by0
            if w <= 0 or h <= 0 or abs(w - h) / max(w, h) > aspect_tol:
                continue
            cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
            frac = (cx - x0) / width
            near_end = min(frac, 1.0 - frac)
            if near_end > end_frac:
                continue
            # These candidates are round by the test above, and for a round hole
            # the bounding box gives the radius directly — no inset search
            # needed, which is the other thing that would have cost real time.
            cands.append((near_end, -circ,
                          ((cx - x0) * doc.scale, (cy - y0) * doc.scale),
                          min(w, h) / 2.0 * doc.scale))
        except Exception:
            continue
    cands.sort(key=lambda c: (c[0], c[1]))
    return [(c[2], c[3]) for c in cands[:2]]        # a plate hangs from two


# --------------------------------------------------------------------------- #
#  results
# --------------------------------------------------------------------------- #
@dataclass
class ThinSpot:
    """One distinct thin area of the artwork.

    thickness/pos/across are physical, in `unit`. The font-unit versions are
    what a font editor needs, and they are just the physical numbers divided by
    `scale` — a ratio, so they hold at every cutting height, not only the one
    that was measured.
    """
    unit: str
    scale: float                        # font units -> unit
    thickness: float                    # worst reading in this area
    thickness_typical: float            # median reading in the same area
    pos: tuple[float, float]            # from the artwork's bottom-left
    across: tuple[tuple[float, float], tuple[float, float]]   # the crossing
    glyph: str                          # glyph name, or "?" if no font given
    char: str | None                    # source letter, when it is knowable
    where: str                          # "upper right", "bottom", ...
    n_samples: int = 1
    extent: float = 0.0                 # how far the thin run reaches, in unit
    # How parallel the two walls are at the worst reading: the chord midpoint's
    # distance to the boundary, as a fraction of the chord. 0.50 means the walls
    # are parallel and this is a genuine web; lower means they converge, i.e. a
    # taper into a junction, and the reading is the width of a wedge rather than
    # of a stroke. Readings below STRAIGHTNESS are refused outright.
    clearance: float = 0.0
    note: str = ""

    @property
    def parallel_walls(self) -> bool:
        """True when this is a web, not a taper — the snap risk that matters."""
        return self.clearance >= 0.47

    def fu(self, v: float) -> float:
        return v / self.scale if self.scale else float("nan")

    @property
    def thickness_fu(self) -> float:
        return self.fu(self.thickness)

    @property
    def pos_fu(self) -> tuple[float, float]:
        return (self.fu(self.pos[0]), self.fu(self.pos[1]))

    @property
    def letter(self) -> str:
        """How to refer to this spot's letter in one short phrase."""
        if self.char and self.glyph not in ("?", self.char):
            return f"{self.char} ({self.glyph})"
        return self.char or self.glyph

    def pct_increase(self, target: float) -> float:
        if not self.thickness:
            return float("nan")
        return ((float(target) / self.thickness) - 1.0) * 100.0

    def target_fu(self, target: float) -> float:
        return self.fu(float(target))


@dataclass
class Survey:
    """Everything a report needs, measured once."""
    spots: list[ThinSpot] = field(default_factory=list)
    unit: str = "in"
    scale: float = 1.0
    n_areas: int = 0                    # distinct thin areas found
    n_below_target: int = 0             # of those, how many miss the target
    samples_taken: int = 0              # boundary points offered to the walk
    samples_used: int = 0               # of those, how many gave a reading
    reach: float = 0.0                  # measurement ceiling, in unit
    letters_known: bool = False
    note: str = ""

    @property
    def thinnest(self) -> float | None:
        return self.spots[0].thickness if self.spots else None


def _median(vals):
    v = sorted(vals)
    if not v:
        return 0.0
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def _regions(pool, spacing: float):
    """Group nearby samples so one thin ankle is one row, not forty.

    Each region grows out from the worst reading left unclaimed: neighbours join
    it while they are within a link radius of something already in it, within
    MAX_SPAN_T thicknesses of the reading it started from, and no more than
    THICK_TOL times as thick as it. All three limits matter. Without the link
    radius one ankle files forty rows; without the span limit a monoline script
    files ONE row for a whole letter and the position on it is meaningless;
    without the thickness limit a thin serif slab annexes the thick stem beside
    it and then reports a typical thickness that belongs to the stem.

    Growing from the worst reading rather than from an arbitrary sample also puts
    the reading a region reports at its centre, so the position printed beside a
    thickness is the middle of that thin place and not the edge of a group.
    """
    order = sorted(range(len(pool)), key=lambda i: pool[i].t)
    taken = [False] * len(pool)
    out = []
    for seed in order:
        if taken[seed]:
            continue
        t0 = pool[seed].t
        radius = max(LINK_T * t0, LINK_S * spacing)
        span = max(MAX_SPAN_T * t0, 4.0 * spacing)
        ceiling = THICK_TOL * t0
        sx, sy = pool[seed].p
        taken[seed] = True
        members, frontier = [seed], [seed]
        while frontier:
            px, py = pool[frontier.pop()].p
            for j in range(len(pool)):
                if taken[j] or pool[j].t > ceiling:
                    continue
                qx, qy = pool[j].p
                if math.hypot(px - qx, py - qy) > radius:
                    continue
                if math.hypot(sx - qx, sy - qy) > span:
                    continue
                taken[j] = True
                members.append(j)
                frontier.append(j)
        out.append(members)
    return out


def survey(doc, target: float | None = None, samples: int = MAX_SAMPLES,
           top_n: int = 8, font=None) -> Survey:
    """Measure the artwork once and hand back the thin areas plus the context.

    find_thin_spots() is the short way in; this exists because a report wants to
    say "14 areas are under target, here are the worst 8" and needs the 14.
    """
    unit = doc.unit
    scale = doc.scale
    if isinstance(font, str):
        try:
            from nameplate_core import Font
            font = Font(font)
        except Exception:
            font = None

    rings = LI._rings(doc)
    if not rings:
        return Survey(unit=unit, scale=scale, note="This name has no ink.")
    try:
        polys, depths, material = LI._analyse(rings)
    except Exception as exc:
        return Survey(unit=unit, scale=scale,
                      note=f"The outline could not be analysed ({exc}).")
    if material.is_empty:
        return Survey(unit=unit, scale=scale, note="This name has no material.")

    x0, y0, x1, y1 = doc.bbox
    # The artwork's own diagonal is the yardstick every tolerance here is built
    # on, because it is the one number that is in the same frame as the geometry
    # whether that geometry is in font units or already scaled (see _Solid).
    span = math.hypot(x1 - x0, y1 - y0) or 1.0
    solid = _Solid(material, span)
    walk, _perim = _walk(_material_rings(material), max(int(samples), 32))
    if not walk:
        return Survey(unit=unit, scale=scale,
                      note="The outline has no measurable edge.")

    # Both normals of every sample point are offered, and only the inward one
    # survives _cross_width, so the true number of PLACES looked at is half.
    places = max(len(walk) // 2, 1)
    spacing = _perim / places
    reach = min(max(REACH_FRACTION * doc.basis_height, 0.05 * (y1 - y0)), span)

    # Letter attribution is only meaningful for a single name. A stacked sheet
    # holds geometry already scaled into inches/mm while the glyph polygons that
    # attribution compares against are in font units, so containment never hits
    # and the nearest-glyph fallback silently blames the sheet's first letter
    # for every spot — including spots on a different name entirely. Better to
    # report the position honestly with no letter than to name the wrong one.
    letters = ([] if (font is None or _is_sheet(doc))
               else _letters(font, doc.text))

    raw: list[_Sample] = []
    for p, nvec, _edge in walk:
        d = _cross_width(solid, p, nvec, reach)
        if d is None or d <= 0:
            continue
        exit_pt = (p[0] + nvec[0] * d, p[1] + nvec[1] * d)
        gi = _which_letter(letters, p) if letters else -1
        raw.append(_Sample(p, d, exit_pt, gi))
    # ---- second pass: probe from the vertices ---------------------------- #
    # Bounded by what the uniform walk already found (and by the target, when
    # one is given, so the judge can still see spots around the target band).
    mrings = _material_rings(material)
    thin_so_far = min((s.t for s in raw), default=0.0)
    ceiling = thin_so_far * VERTEX_CEILING
    if target and scale:
        ceiling = max(ceiling, (float(target) / scale) * VERTEX_CEILING)
    if ceiling > 0:
        seen_probe = set()

        def _in_metal(x, y):
            try:
                return solid.prep.contains(Point(x, y))
            except Exception:
                return True

        # the raw geometry alongside the callable, so the probe pass can test
        # every midpoint in one vectorised call instead of one at a time
        _in_metal.geom = material

        for p, nvec in _vertex_probes(mrings, ceiling, inside=_in_metal):
            d = _cross_width(solid, p, nvec, reach)
            if d is None or d <= 0 or d > ceiling:
                continue
            exit_pt = (p[0] + nvec[0] * d, p[1] + nvec[1] * d)
            # one reading per place: several vertices around the same neck all
            # find it, and eight copies of one web is not eight thin areas
            key = (round((p[0] + exit_pt[0]) / 2, 1),
                   round((p[1] + exit_pt[1]) / 2, 1))
            if key in seen_probe:
                continue
            seen_probe.add(key)
            gi = _which_letter(letters, p) if letters else -1
            raw.append(_Sample(p, d, exit_pt, gi))

    if not raw:
        return Survey(unit=unit, scale=scale, samples_taken=places,
                      note="Nothing in this artwork reads as a thin stroke.")

    # ---- pool: the thinnest overall, plus each letter's own worst -------- #
    order = sorted(range(len(raw)), key=lambda i: raw[i].t)
    pool_idx = set(order[:POOL])
    per: dict[int, int] = {}
    for i in order:
        g = raw[i].gi
        if per.get(g, 0) < POOL_PER_GLYPH:
            per[g] = per.get(g, 0) + 1
            pool_idx.add(i)

    by_glyph: dict[int, list[_Sample]] = {}
    for i in sorted(pool_idx):
        by_glyph.setdefault(raw[i].gi, []).append(raw[i])

    eyelets = _eyelets(doc, polys, depths)

    spots: list[ThinSpot] = []
    for gi, group in by_glyph.items():
        for members in _regions(group, spacing):
            ms = [group[k] for k in members]
            worst = min(ms, key=lambda s: s.t)
            typical = _median([s.t for s in ms])
            # how far the thin run reaches, so "a 3 mm waist" and "3 mm all the
            # way along this stroke" do not read as the same finding
            xs = [s.p[0] for s in ms] + [s.exit[0] for s in ms]
            ys = [s.p[1] for s in ms] + [s.exit[1] for s in ms]
            extent = math.hypot(max(xs) - min(xs), max(ys) - min(ys))

            if 0 <= gi < len(letters):
                gname, char, poly, _pr = letters[gi]
                try:
                    bounds = poly.bounds
                except Exception:
                    bounds = doc.bbox
            else:
                gname, char, bounds = "?", None, doc.bbox

            # position: the middle of the crossing, which is the middle of the
            # material — a truer "where it is" than either wall
            mx = (worst.p[0] + worst.exit[0]) / 2
            my = (worst.p[1] + worst.exit[1]) / 2
            across = (((worst.p[0] - x0) * scale, (worst.p[1] - y0) * scale),
                      ((worst.exit[0] - x0) * scale, (worst.exit[1] - y0) * scale))

            # Notes in order of what dominates the answer. "This glyph does not
            # exist" beats every other explanation, including the eyelet one — a
            # .notdef box is a square hole near the end of a short name, which is
            # exactly what an eyelet looks like from the outside.
            note = ""
            if gname.startswith(".notdef"):
                # A hollow rectangle has thin walls and will duly come top of
                # this list, and thickening it would be an entirely wasted
                # afternoon: the font simply has no glyph for that character.
                # nameplate_fontcheck reports the same defect from the font side.
                note = ("this is the missing-glyph box, not a letter — the font "
                        "has no glyph for "
                        + (f"{char!r}" if char else "this character")
                        + ", so add that character rather than thickening "
                          "anything")
            # One end of the crossing sits on the hole's edge, so it is within
            # the hole's own radius of its centre; nothing but the eyelet wall is.
            for (cx, cy), r in (() if note else eyelets):
                if any(math.hypot(px - cx, py - cy) <= r * 1.35
                       for px, py in across):
                    note = ("the thinnest reading here is on the wall of an "
                            "eyelet hole — that wall belongs to the eyelet, so "
                            "change the eyelet with the eyelet tool rather than "
                            "thickening the letter")
                    break
            if not note and len(ms) == 1:
                # Not a hedge about the method — a fact about this row. Every
                # other row has neighbouring readings agreeing with it; this one
                # stands alone, so it is either a very small feature or the last
                # sample before one.
                note = ("a single reading with nothing beside it to corroborate "
                        "— a very small feature, so confirm it on screen before "
                        "acting on it")

            # only for the spots that survive to the report, so this costs a
            # handful of distance() calls rather than one per sample
            try:
                clear = solid.boundary.distance(Point(mx, my)) / worst.t
            except Exception:
                clear = 0.0

            spots.append(ThinSpot(
                unit=unit, scale=scale,
                thickness=worst.t * scale, thickness_typical=typical * scale,
                pos=((mx - x0) * scale, (my - y0) * scale), across=across,
                glyph=gname, char=char,
                where=_where((mx, my), bounds),
                n_samples=len(ms), extent=extent * scale,
                clearance=clear, note=note))

    spots.sort(key=lambda s: s.thickness)
    n_below = (sum(1 for s in spots if s.thickness < float(target))
               if target else 0)
    return Survey(spots=spots[:max(int(top_n), 1)], unit=unit, scale=scale,
                  n_areas=len(spots), n_below_target=n_below,
                  samples_taken=places, samples_used=len(raw),
                  reach=reach * scale, letters_known=bool(letters))


def find_thin_spots(doc, target: float | None = None,
                    samples: int = MAX_SAMPLES, top_n: int = 8,
                    font=None) -> list[ThinSpot]:
    """The top_n thinnest DISTINCT places in this artwork, thinnest first.

    doc     a finished Document; nothing on it is modified
    target  the thickness you need, in doc.unit. Optional — it changes no
            measurement, it only lets the caller ask each spot for its
            pct_increase() and lets a report count how many places miss it.
    samples how many boundary points to walk, in total, over every contour.
            Capped on purpose: see MAX_SAMPLES.
    font    a Font or a font path. Without it the thin spots are still measured
            correctly but cannot be attributed to a named letter.

    Method and its limits are in this module's docstring — in short, a ray along
    the inward normal measures across the stroke, and near a sharp corner it can
    read short, so wedge-shaped readings are dropped rather than reported.
    """
    return survey(doc, target, samples, top_n, font).spots


# --------------------------------------------------------------------------- #
#  what it would look like fixed
# --------------------------------------------------------------------------- #
def thicken_preview(doc, target: float, thinnest: float | None = None,
                    font=None) -> list[list[tuple[float, float]]]:
    """Outline of the artwork if its thinnest place reached `target`.

    The material is grown by HALF the shortfall, because a stroke gains material
    on both walls: dilating by (target - thinnest)/2 makes a crossing of
    `thinnest` measure exactly `target`. Everything already thicker grows by the
    same amount, which is what a font editor thickening a weight does too, so
    the preview is a fair picture rather than a promise.

    Returned as closed outline polylines in doc.unit with the origin at the
    artwork's bottom-left — the same frame as ThinSpot.pos — so it can be drawn
    straight over the preview in another colour. Empty when there is nothing to
    show (no target, or the artwork already passes).
    """
    if not target or target <= 0:
        return []
    if thinnest is None:
        s = survey(doc, target, font=font)
        thinnest = s.thinnest
    if not thinnest or target <= thinnest:
        return []

    delta = (float(target) - thinnest) / 2.0 / doc.scale     # font units
    try:
        polys, _depths, material = LI._analyse(LI._rings(doc))
        # join_style=2 (MITRE) rather than round: these are letterforms, and a
        # round join visibly rounds off every serif and corner, so the overlay
        # would read as a different typeface instead of as this one thickened.
        # mitre_limit keeps that honest — at a very sharp apex an unlimited
        # mitre shoots a spike far outside the letter, so it is capped and the
        # apex is bevelled instead.
        grown = material.buffer(delta, join_style=2, mitre_limit=2.0)
    except Exception:
        return []
    if grown.is_empty:
        return []

    x0, y0, _x1, _y1 = doc.bbox
    s = doc.scale
    out = []
    for ring in _material_rings(grown):
        out.append([((x - x0) * s, (y - y0) * s) for x, y in ring] +
                   [((ring[0][0] - x0) * s, (ring[0][1] - y0) * s)])
    return out


# --------------------------------------------------------------------------- #
#  the human report
# --------------------------------------------------------------------------- #
def _basis_words(basis: str) -> str:
    return {"cap": "cap height", "xheight": "x-height",
            "total": "overall artwork height"}.get(basis, f"{basis} height")


def _is_sheet(doc) -> bool:
    """True for a Document from nameplate_core.stack().

    A stacked sheet holds geometry ALREADY scaled into inches or millimetres,
    with scale == 1 standing in for "no conversion left to do". Its thicknesses
    are therefore real and correct, but dividing them by scale does not give font
    units — it gives the same number back. Anything that would print or act on a
    font-unit figure has to know that, or it states a size in font units that is
    out by three orders of magnitude.
    """
    return getattr(doc, "basis", "") == "sheet"


def report_text(doc, target: float | None = None, spots=None, font=None,
                sv: Survey | None = None) -> str:
    """The thin spots as text for a dialog or the console."""
    if sv is None:
        if spots is None:
            sv = survey(doc, target, font=font)
        else:
            sv = Survey(spots=list(spots), unit=doc.unit, scale=doc.scale,
                        n_areas=len(spots), letters_known=True,
                        n_below_target=(sum(1 for s in spots
                                            if s.thickness < float(target))
                                        if target else 0))
    u = sv.unit
    w, h = doc.size()
    L = [f"{doc.text} — {w:.3f} x {h:.3f} {u}", ""]

    if not sv.spots:
        L += ["No thin spot found.", "",
              sv.note or ("Nothing in this artwork reads as a thin stroke — "
                          "every crossing came out thicker than the "
                          f"{sv.reach:.3f} {u} ceiling this measurement uses.")]
        return "\n".join(L)

    L.append("THINNEST PARTS OF THE ARTWORK")
    L.append(f"    measured across the stroke at {sv.samples_used} of "
             f"{sv.samples_taken} points walked around the outline")
    if not sv.letters_known:
        L.append("    letters not named: pass the font to attribute each spot "
                 "to a letter")
    L.append("")
    # On a stacked sheet the geometry is already in inches/mm, so "font units"
    # do not exist — printing a rounded number and telling the reader to ignore
    # it invites misreading. The columns are simply absent instead.
    sheet = _is_sheet(doc)
    head = (f"    {'#':>2s}  {'letter':<16s} {'where':<12s} "
            f"{'thinnest':>10s} {'typical':>9s}"
            + ("" if sheet else f" {'font u':>8s}"))
    if target:
        head += ("" if sheet else f" {'want':>8s}") + f" {'increase':>9s}"
    L.append(head)
    for i, s in enumerate(sv.spots, start=1):
        # a flourish glyph can be called 'eflourishrightring'; let it break the
        # column and the whole table stops lining up
        who = s.letter if len(s.letter) <= 16 else s.letter[:15] + "…"
        row = (f"    {i:2d}  {who:<16s} {s.where:<12s} "
               f"{s.thickness:10.4f} {s.thickness_typical:9.4f}"
               + ("" if sheet else f" {s.thickness_fu:8.1f}"))
        if target:
            pct = s.pct_increase(target)
            # a negative "increase" is just "already thick enough", and reads as
            # an instruction to make it thinner if it is printed as a number
            if not sheet:
                row += f" {s.target_fu(target):8.1f}"
            row += (f" {pct:+8.2f}%" if pct > 0 else f" {'ok':>9s}")
        L.append(row)
    if sheet:
        L.append(f"    (thinnest/typical in {u}. This is a stacked sheet, so "
                 f"there are no font-unit")
        L.append("     figures — measure a single name to get numbers to hand "
                 "a font editor.)")
    else:
        L.append(f"    (thinnest/typical in {u}; 'font u' columns are font "
                 f"units, which is what a font editor works in)")
    L.append("")

    for i, s in enumerate(sv.spots, start=1):
        L.append(f"    {i:2d}  {s.letter} — {s.where}")
        fu = "" if sheet else f" ({s.thickness_fu:.1f} font units)"
        L.append(f"          {s.thickness:.4f} {u}{fu} across, at "
                 f"{s.pos[0]:.3f}, {s.pos[1]:.3f} {u} from the bottom-left")
        L.append(f"          from {s.n_samples} reading(s) over about "
                 f"{s.extent:.3f} {u} of stroke")
        if target:
            pct = s.pct_increase(target)
            tfu = "" if sheet else f" ({s.target_fu(target):.1f} font units)"
            if pct > 0:
                L.append(f"          needs {float(target):.4f} {u}{tfu} — "
                         f"thicken by {pct:+.2f}%")
            else:
                L.append(f"          already past your {float(target):.4f} "
                         f"{u}{tfu} — leave it")
        if s.note:
            L.append(f"          note: {s.note}")
    L.append("")

    if target:
        L.append(f"AGAINST YOUR TARGET OF {float(target):.4f} {u}")
        if sv.n_below_target:
            L.append(f"    {sv.n_below_target} of {sv.n_areas} distinct areas "
                     f"are thinner than that; the {len(sv.spots)} worst are "
                     f"listed above.")
            if sheet:
                # a sheet's scale is 1 unit = 1 inch/mm, so "font units" here
                # would just restate the physical number and mislead
                L.append("    Measure a single name to get the font-unit "
                         "target to hand a font editor.")
            else:
                L.append(f"    In font units the target is "
                         f"{float(target) / sv.scale:.1f} at this height, and "
                         f"that number holds at every height.")
                L.append("    Hand claude_prompt() to whoever edits the font — "
                         "one instruction covers all of them.")
        else:
            L.append(f"    Every one of the {sv.n_areas} areas measured is at "
                     f"or above it. Nothing to thicken.")
        L.append("")

    L.append("Thickness is measured across the stroke: a ray is cast inward "
             "from the edge until it leaves the material.")
    L.append("'thinnest' is the worst reading in that area and is the number "
             "that decides whether it snaps; 'typical' is the middle reading "
             "for the same area, so a lone freak reading is visible as one.")
    L.append("Readings that cross a wedge rather than a stroke — a serif tip, "
             "an apex, the end of a swash — are dropped, because thickening "
             "the font would not fix them.")
    return "\n".join(L)


# --------------------------------------------------------------------------- #
#  the instruction to hand an AI that edits the font
# --------------------------------------------------------------------------- #
# Prompts are pasted into other tools and must be plain ASCII. Sanitising at the
# BOUNDARY rather than at every source, because the text is assembled from notes
# and letter names written all over this module: an em dash added to a note a
# year from now would otherwise quietly break the contract again. The selftest
# missed exactly that -- it only checked prompt blocks that were non-empty in its
# own run, and the thin-area block is empty unless a target is typed.
_ASCII_MAP = {"—": " - ", "–": "-", "’": "'", "‘": "'",
              "“": '"', "”": '"', "·": "-", "…": "...",
              "×": "x", "→": "->", "°": " deg",
              "ø": "dia", "Ø": "dia", "≥": ">=",
              "≤": "<=", "±": "+/-", " ": " "}


def _ascii(text: str) -> str:
    """Plain ASCII, so a prompt pastes into anything without mangled bytes."""
    for bad, good in _ASCII_MAP.items():
        text = text.replace(bad, good)
    return text.encode("ascii", "replace").decode("ascii")


def claude_prompt_from_spots(doc, target: float, spots, font_path: str | None = None,
                             n_areas: int | None = None,
                             n_below_target: int | None = None) -> str:
    """The paste-ready instruction, from thin spots already measured.

    Same output as claude_prompt(); this one exists so a caller that has just
    drawn the spots on screen does not pay for the measurement twice.
    """
    u = doc.unit
    s = doc.scale
    spots = list(spots)
    if not target or float(target) <= 0:
        return ("No target thickness was given, so there is nothing to ask for. "
                "Set the thickness this metal needs (for example 0.060 in) and "
                "run this again.")
    target = float(target)
    if _is_sheet(doc):
        # Refuse rather than emit font-unit sizes that are out by a factor of a
        # thousand. Being wrong here is worse than being unavailable: the whole
        # value of this block is that its numbers can be acted on without
        # checking them.
        return ("This document is a stacked sheet of several names, whose "
                "geometry is already scaled into "
                f"{u}, so there is no font-unit conversion to state and any "
                "size given here would be wrong. Measure ONE name at the height "
                "it will be cut, then ask for the prompt again.")
    if not spots:
        return (f"Nothing in {doc.text!r} measures thinner than the "
                f"{target:.4f} {u} you asked for, so the font needs no change "
                f"for this name at this size.")

    fu = lambda v: v / s if s else float("nan")          # noqa: E731
    req = math.ceil(fu(target))                          # whole font units, up
    worst = spots[0]
    biggest_pct = max(sp.pct_increase(target) for sp in spots)
    fname = os.path.basename(font_path) if font_path else None
    below = [sp for sp in spots if sp.thickness < target]
    if not below:
        return (f"Every thin area of {doc.text!r} is already at or above "
                f"{target:.4f} {u} ({fu(target):.1f} font units), so the font "
                f"needs no change for this name at this size.")

    L = ["FONT THICKENING REQUEST  -  ShineOn nameplate, laser-cut sheet metal",
         ""]
    if fname:
        L.append(f"FONT FILE      {fname}")
    else:
        L.append(f"FONT FAMILY    {doc.font_family}")
        L.append("               (the file name was not supplied  -  this is the "
                 "family name reported by the font)")
    L.append(f"unitsPerEm     {doc.upem}")
    L.append(f"NAME TESTED    {doc.text}")
    L.append(f"CUT AT         {doc.target_height:g} {u} "
             f"{_basis_words(doc.basis)}")
    L.append("")

    # The caller may have measured more areas than it handed over; the honest
    # count of what is wrong is the one it counted, not the length of this list.
    n_under = max(int(n_below_target or 0), len(below))
    L.append("THE PROBLEM")
    L.append("  This name is cut out of sheet metal. Any part of a letter that "
             "is too")
    L.append("  thin snaps off when the plate is handled. At the size above, "
             "the thinnest")
    L.append(f"  material in the artwork measures {worst.thickness:.4f} {u} "
             f"and it has to be at")
    L.append(f"  least {target:.4f} {u}. "
             f"{n_under} separate area(s) are under that"
             + (f", of {n_areas} measured." if n_areas else "."))
    L.append("")

    L.append("ALL SIZES BELOW ARE IN FONT UNITS")
    L.append("  A font editor works in font units, not in inches or "
             "millimetres, so every")
    L.append(f"  size here is in font units of this font's {doc.upem}-unit em "
             f"square.")
    L.append(f"  The conversion used is the one for this job: "
             f"{doc.target_height:g} {u} of "
             f"{_basis_words(doc.basis)} is")
    L.append(f"  {doc.basis_height:.0f} font units, so 1 font unit = "
             f"{s:.6f} {u}, and the")
    L.append(f"  {target:.4f} {u} minimum is {fu(target):.1f} font units  -  "
             f"round up to {req}.")
    L.append("  A thickness in font units is a proportion of the letter, so "
             "fixing it")
    L.append("  here fixes it at every size the name is ever cut. Do not "
             "convert these")
    L.append("  numbers back into inches or millimetres.")
    L.append("")

    L.append("THE THIN AREAS, THINNEST FIRST")
    for i, sp in enumerate(below, start=1):
        who = f"glyph '{sp.glyph}'" if sp.glyph != "?" else "glyph unknown"
        if sp.char:
            who += f" (the letter {sp.char})"
        L.append(f"  {i}. {who}  -  {sp.where} of the letter")
        L.append(f"     now {sp.thickness_fu:.1f} font units across, "
                 f"needs {req} font units "
                 f"({sp.pct_increase(target):+.1f}%)")
        if sp.note:
            # this block is read as a document, not scanned in a table, so the
            # notes are wrapped rather than left to run off the side
            L += textwrap.wrap(sp.note, width=74, initial_indent="     note: ",
                               subsequent_indent="           ")
    if n_under > len(below):
        L.append(f"  ...and {n_under - len(below)} more area(s) under the "
                 f"minimum, not listed one by one.")
        L.append("  The instruction below covers those as well  -  it is a rule, "
                 "not a list.")
    L.append("")

    L.append("THE INSTRUCTION")
    L.append(f"  Thicken every stroke thinner than {req} font units up to "
             f"{req} font units")
    L.append(f"  (an increase of up to {biggest_pct:.0f}% at the worst place), "
             f"keeping the outer")
    L.append("  silhouette and the counters' positions.")
    L.append("")
    L.append("  In plain terms: measure across each stroke listed above; where "
             "that")
    L.append(f"  measurement is under {req} font units, move the INNER wall of "
             f"the stroke")
    L.append(f"  (the counter side) until it measures {req}. The outside edge "
             f"of the letter")
    L.append("  stays exactly where it is, and each counter stays in the same "
             "place and")
    L.append("  keeps its shape  -  it may end up slightly smaller, and that is "
             "expected.")
    L.append("  Blend into the thicker part of the same stroke either side of "
             "the thin")
    L.append("  place so there is no step, kink or lump where the change ends.")
    L.append("  Leave every stroke that already measures "
             f"{req} font units or more alone.")
    L.append("")

    L.append("WHAT MUST NOT CHANGE")
    L.append("  * the advance width of any glyph, and all kerning and spacing: "
             "the name")
    L.append("    must occupy exactly the same width, so the cut file does not "
             "resize")
    L.append("  * the cap height, x-height, ascender, descender and baseline")
    L.append("  * the outer silhouette of each letter  -  no letter may get "
             "taller, wider")
    L.append("    or a different shape; this is a local thickening, not a new "
             "weight")
    L.append("  * the eyelet holes: their diameter, roundness and position are "
             "set by the")
    L.append("    hanging hardware. Do not resize, move or reshape any eyelet "
             "hole, and do")
    L.append("    not thicken a stroke by eating into one")
    L.append("  * the contextual and alternate glyph set: keep every alternate "
             "and eyelet")
    L.append("    form (.eyeL / .eyeR and similar), keep every glyph name, and "
             "do not add,")
    L.append("    remove or re-order glyphs. Leave the GSUB/calt/liga/kern "
             "rules exactly as")
    L.append("    they are, so the same name still shapes to the same glyphs")
    L.append("  * the colour/engrave layers (COLR and CPAL) and the unitsPerEm")
    L.append("  * anything not on the list above. Do not tidy, redraw, "
             "re-interpolate or")
    L.append("    otherwise improve the font while you are in there  -  the only "
             "change is")
    L.append("    the thickness of the strokes named above.")
    L.append("")

    L.append("HOW IT WILL BE CHECKED")
    if fname:
        L.append(f"  python nameplate_thickness.py {fname} \"{doc.text}\" "
                 f"{doc.target_height:g} {u} {doc.basis} {target:g}")
    else:
        L.append(f"  python nameplate_thickness.py <font> \"{doc.text}\" "
                 f"{doc.target_height:g} {u} {doc.basis} {target:g}")
    L.append(f"  Every area it lists must read {req} font units or more, and "
             f"the artwork")
    L.append("  size it prints must be unchanged from before the edit.")
    return _ascii("\n".join(L))


def claude_prompt(doc, target: float, font_path: str | None = None,
                  font=None, top_n: int = 8) -> str:
    """The block Sean pastes to an AI that edits the font.

    Unambiguous on purpose: it names the file and its em size, states that every
    size is in font units and how that conversion was reached, lists each thin
    area with the letter it is on and the increase it needs, gives ONE
    instruction that covers all of them, and then says what must not change so
    the edit does not turn into a redesign. Plain text, no markdown, safe to
    paste anywhere.

    font_path is used both to name the file and, if `font` was not given, to
    load the font so the letters can be named.
    """
    sv = survey(doc, target, top_n=top_n, font=font or font_path)
    return _ascii(claude_prompt_from_spots(
        doc, target, sv.spots, font_path=font_path, n_areas=sv.n_areas,
        n_below_target=sv.n_below_target))


# --------------------------------------------------------------------------- #
#  CLI
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    import sys

    from nameplate_core import Font, build_document
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2:
        print("usage: python nameplate_thickness.py <font> <name> "
              "[height] [in|mm] [cap|xheight|total] [target_thickness]")
        return 2
    path, name = args[0], args[1]
    height = float(args[2]) if len(args) > 2 else 1.0
    unit = args[3] if len(args) > 3 else "in"
    basis = args[4] if len(args) > 4 else "cap"
    target = float(args[5]) if len(args) > 5 else None

    font = Font(path)
    doc = build_document(font, name, height, unit, basis)
    sv = survey(doc, target, font=font)
    print(report_text(doc, target, sv=sv))
    if target:
        print()
        print("-" * 74)
        print()
        print(claude_prompt_from_spots(doc, target, sv.spots, font_path=path,
                                      n_areas=sv.n_areas,
                                      n_below_target=sv.n_below_target))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
nameplate_core.py — engine for the ShineOn Nameplate Cut-File app.

WHAT THIS DOES
    name text + font file + target height  ->  laser-ready outline artwork

    * shapes the name with the font's own OpenType features, so contextual forms
      (eyelets, engrave variants) come out exactly as the font intends
    * unions every letter into ONE closed cut path, curves preserved, so the
      overlapping letters read as a single piece with no internal seams
    * pulls the engrave lines out of the font's COLR colour layers and converts
      them to open centerlines (one laser pass, not a filled sliver)
    * scales to a real-world height measured from the cap height, the x-height,
      or the whole artwork
    * writes SVG and PDF with hairline strokes, no fills, CUT and ENGRAVE
      separated

This module has NO user interface and no global state. The GUI calls:

    doc  = build_document(font_path, "ADAM", height=1.0, unit="in", basis="cap")
    svg  = svg_single(doc)                      # str
    pdf  = pdf_document([doc])                  # bytes, one page per doc
    #  doc.cut_paths / doc.engrave_paths are also there for on-screen preview

Everything is in font units internally; scaling happens only at export.
"""

from __future__ import annotations

import io
import math
import re
import zlib
from dataclasses import dataclass, field
from typing import Iterable

import pathops
import uharfbuzz as hb
from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
from fontTools.ttLib import TTFont
from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.ops import unary_union

MM_PER_IN = 25.4
PT_PER_IN = 72.0
HAIRLINE_IN = 0.001        # SVG stroke width; PDF uses width 0 (device hairline)
FLATTEN_STEPS = 24          # curve -> polyline, for measurement and engrave lines only
ENGRAVE_TOL = 1.5           # how far a glyph outline may sit from a red band and still match
MIN_ENGRAVE_LEN = 25.0      # font units; shorter fragments are specks, not lines
DEFAULT_FEATURES = {"calt": True, "liga": True, "kern": True, "rlig": True}


# --------------------------------------------------------------------------- #
#  font wrapper
# --------------------------------------------------------------------------- #
class Font:
    """One font file, opened once and reused for every name."""

    def __init__(self, path: str):
        self.path = path
        with open(path, "rb") as fh:
            self.data = fh.read()
        self.tt = TTFont(io.BytesIO(self.data), fontNumber=0)
        self.glyphset = self.tt.getGlyphSet()
        self.upem = self.tt["head"].unitsPerEm
        self.cmap = self.tt.getBestCmap()
        self.hb_font = hb.Font(hb.Face(self.data))
        self._outline_cache: dict[str, pathops.Path] = {}
        self._contour_cache: dict[str, list[list[tuple[float, float]]]] = {}
        # COLR v0: base glyph -> [(layer glyph, palette index), ...]
        self.colr: dict[str, list[tuple[str, int]]] = {}
        if "COLR" in self.tt and getattr(self.tt["COLR"], "version", 1) == 0:
            for base, layers in self.tt["COLR"].ColorLayers.items():
                self.colr[base] = [(l.name, l.colorID) for l in layers]
        self.palette: list[tuple[int, int, int, int]] = []
        if "CPAL" in self.tt and self.tt["CPAL"].palettes:
            self.palette = [(c.red, c.green, c.blue, c.alpha)
                            for c in self.tt["CPAL"].palettes[0]]

    # -- names ------------------------------------------------------------- #
    @property
    def family(self) -> str:
        for rec in self.tt["name"].names:
            if rec.nameID == 4:
                try:
                    return rec.toUnicode()
                except Exception:
                    pass
        return self.path.rsplit("/", 1)[-1]

    # -- geometry ---------------------------------------------------------- #
    def outline(self, glyph: str) -> pathops.Path:
        """Glyph outline as a curve-preserving path, in font units."""
        if glyph not in self._outline_cache:
            p = pathops.Path()
            self.glyphset[glyph].draw(p.getPen(glyphSet=self.glyphset))
            self._outline_cache[glyph] = p
        return self._outline_cache[glyph]

    def contours(self, glyph: str) -> list[list[tuple[float, float]]]:
        """Glyph outline flattened to polylines, in font units."""
        if glyph in self._contour_cache:
            return self._contour_cache[glyph]
        rp = DecomposingRecordingPen(self.glyphset)
        self.glyphset[glyph].draw(rp)
        out: list[list[tuple[float, float]]] = []
        cur: list[tuple[float, float]] | None = None
        pt: tuple[float, float] | None = None

        def cubic(p0, p1, p2, p3):
            pts = []
            for i in range(1, FLATTEN_STEPS + 1):
                t = i / FLATTEN_STEPS
                m = 1 - t
                pts.append((m*m*m*p0[0] + 3*m*m*t*p1[0] + 3*m*t*t*p2[0] + t*t*t*p3[0],
                            m*m*m*p0[1] + 3*m*m*t*p1[1] + 3*m*t*t*p2[1] + t*t*t*p3[1]))
            return pts

        def quad(p0, p1, p2):
            pts = []
            for i in range(1, FLATTEN_STEPS + 1):
                t = i / FLATTEN_STEPS
                m = 1 - t
                pts.append((m*m*p0[0] + 2*m*t*p1[0] + t*t*p2[0],
                            m*m*p0[1] + 2*m*t*p1[1] + t*t*p2[1]))
            return pts

        for op, args in rp.value:
            if op == "moveTo":
                if cur and len(cur) > 2:
                    out.append(cur)
                cur = [args[0]]
                pt = args[0]
            elif op == "lineTo":
                cur.append(args[0])
                pt = args[0]
            elif op == "curveTo":
                pts = list(args)
                cur.extend(cubic(pt, *pts))
                pt = pts[-1]
            elif op == "qCurveTo":
                pts = list(args)
                if pts[-1] is None:                      # all-off-curve closed contour
                    pts = pts[:-1]
                    mid = ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
                    cur, pt = [mid], mid
                    pts = pts + [mid]
                for i in range(len(pts) - 1):
                    nxt = pts[i + 1]
                    end = (((pts[i][0] + nxt[0]) / 2, (pts[i][1] + nxt[1]) / 2)
                           if i < len(pts) - 2 else nxt)
                    cur.extend(quad(pt, pts[i], end))
                    pt = end
            elif op in ("closePath", "endPath"):
                if cur and len(cur) > 2:
                    out.append(cur)
                cur = None
        if cur and len(cur) > 2:
            out.append(cur)
        self._contour_cache[glyph] = out
        return out

    def filled(self, glyph: str) -> Polygon:
        """Glyph as a filled shapely area (holes handled by containment parity)."""
        rings = [Polygon(c) for c in self.contours(glyph)]
        rings = [r for r in rings if r.area > 0]
        if not rings:
            return Polygon()
        geom = None
        for i in sorted(range(len(rings)), key=lambda i: -rings[i].area):
            r = rings[i].buffer(0)
            depth = sum(1 for j, q in enumerate(rings)
                        if j != i and q.area > rings[i].area
                        and q.buffer(0).contains(rings[i].representative_point()))
            if geom is None:
                geom = r
            elif depth % 2:
                geom = geom.difference(r)
            else:
                geom = geom.union(r)
        return geom

    def is_engrave_layer(self, palette_index: int) -> bool:
        """A layer counts as engraving when its palette colour is not black."""
        if palette_index >= len(self.palette):
            return False
        r, g, b, _ = self.palette[palette_index]
        return not (r < 40 and g < 40 and b < 40)


# --------------------------------------------------------------------------- #
#  shaping
# --------------------------------------------------------------------------- #
@dataclass
class Placed:
    glyph: str
    x: float                    # pen position, font units
    y: float
    # Which character of the input text this glyph came from (HarfBuzz cluster).
    # Purely informational and defaulted, so nothing that builds a Placed
    # positionally changes: no geometry reads it. It exists because contextual
    # shaping can emit any number of glyphs for a run — 'Aaba' may not be four
    # glyphs — and a caller that needs to judge only PART of a run has no other
    # way to find which glyphs belong to which letters. -1 means unknown.
    cluster: int = -1


def shape(font: Font, text: str, features: dict | None = None) -> list[Placed]:
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font.hb_font, buf, features if features is not None else DEFAULT_FEATURES)
    # Resolve glyph NAMES from the glyph ID through fontTools' own glyph order.
    # hb_font.glyph_to_string() invents names like "gid131" when the font's post
    # table is format 3.0 (which carries no glyph names at all), and those names
    # do not exist in the fontTools glyph set the outlines are drawn from — the
    # lookup then dies with KeyError: 'gid131'. The glyph ID is what both sides
    # actually agree on.
    order = font.tt.getGlyphOrder()
    out, x, y = [], 0.0, 0.0
    # An empty buffer (empty text, or text HarfBuzz drops entirely) reports
    # glyph_infos as None, not []. Iterating that died with
    # "TypeError: 'NoneType' object is not iterable" from inside the engine.
    # Nothing shaped is simply nothing placed; the caller decides what to do.
    infos, positions = buf.glyph_infos, buf.glyph_positions
    if not infos or not positions:
        return out
    for info, pos in zip(infos, positions):
        gid = info.codepoint
        name = (order[gid] if 0 <= gid < len(order)
                else font.hb_font.glyph_to_string(gid))
        out.append(Placed(name, x + pos.x_offset, y + pos.y_offset,
                          int(getattr(info, "cluster", -1))))
        x += pos.x_advance
        y += pos.y_advance
    return out


# --------------------------------------------------------------------------- #
#  document
# --------------------------------------------------------------------------- #
@dataclass
class Document:
    text: str
    font_family: str
    upem: int
    cut_paths: list[list[list[tuple[float, float]]]]     # closed contours, font units
    cut_skia: pathops.Path                               # same thing, curves intact
    engrave_paths: list[list[tuple[float, float]]]        # open polylines, font units
    bbox: tuple[float, float, float, float]
    basis: str
    basis_height: float                                  # font units used for scaling
    target_height: float
    unit: str
    warnings: list[str] = field(default_factory=list)

    @property
    def scale(self) -> float:
        """font units -> target unit (mm or in)."""
        # A zero basis divided straight through to ZeroDivisionError, and a
        # non-finite one poisoned every coordinate with inf/nan on the way to
        # the file. Refuse with a message instead of clamping to something the
        # user did not ask for.
        if not math.isfinite(self.basis_height) or self.basis_height <= 0:
            raise ValueError(
                f"Cannot scale {self.text!r}: the '{self.basis}' reference height "
                f"measured {self.basis_height!r} font units, which is not a usable "
                f"size. Try a different height basis, or check the font.")
        return self.target_height / self.basis_height

    def size(self) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox
        return (x1 - x0) * self.scale, (y1 - y0) * self.scale


#  capitals whose tops sit exactly ON the cap line. Round letters (O Q C G S)
#  and pointed ones (A) deliberately overshoot it, and J/Q descend below the
#  baseline, so none of those can define the cap height.
FLAT_CAPS = "HETIFLMNVWXZ"
#  and lowercase letters whose tops sit exactly on the x-line, for the same
#  reason — 'o' and 'e' overshoot, 'b'/'d'/'k' ascend, 'g'/'p'/'y' descend.
FLAT_XHEIGHT = "xzvwus"


def _cap_reference(font: Font) -> tuple[float, list[str]]:
    """The font's cap height in font units — ONE number for the whole font.

    This is deliberately independent of the name being set. Measuring whichever
    capital happens to come first made the same setting deliver different metal:
    'JADAM' came out about 20% smaller than 'ADAM', because 'J' descends and its
    total ink is far taller than its cap. Every name must scale by the same
    factor or two orders in one job do not match.

    Measured from the font's own flat-topped capitals rather than taken from
    OS/2.sCapHeight, because that metric is frequently wrong in display and
    script faces — of the fonts in use here it disagrees with the real outlines
    by 27% in one and 69% in another. The declared value is only a fallback.

    Ascenders and descenders are excluded by construction: the reference is the
    cap line, so a descender simply hangs below it and makes the finished piece
    taller without changing how big the letters are.
    """
    cached = font.__dict__.get("_cap_ref")
    if cached is not None:
        return cached

    tops: list[float] = []
    for ch in FLAT_CAPS:
        gname = font.cmap.get(ord(ch))
        if not gname:
            continue
        ys = [p[1] for c in font.contours(gname) for p in c]
        if ys and max(ys) > 0:
            tops.append(round(max(ys), 3))

    warn: list[str] = []
    ref = 0.0
    if tops:
        # the modal top, so one swash or one badly drawn letter cannot skew it
        ref = max(set(tops), key=lambda t: (tops.count(t), t))
        declared = (getattr(font.tt["OS/2"], "sCapHeight", 0)
                    if "OS/2" in font.tt else 0)
        if declared and abs(declared - ref) > max(2.0, ref * 0.02):
            warn.append(
                f"This font declares a cap height of {declared:g} units but its "
                f"capitals actually measure {ref:g}. Using the measured value, "
                f"so the letters come out the size you asked for.")
    else:
        declared = (getattr(font.tt["OS/2"], "sCapHeight", 0)
                    if "OS/2" in font.tt else 0)
        if declared and declared > 0:
            ref = float(declared)
            warn.append("No flat-topped capital to measure — used the cap "
                        "height this font declares.")

    font.__dict__["_cap_ref"] = (ref, warn)
    return ref, warn


def _measure_basis(font: Font, text: str, placed: list[Placed],
                   basis: str) -> tuple[float, list[str]]:
    """Height in font units that the user's number refers to."""
    warn: list[str] = []

    if basis == "cap":
        # One reference for the WHOLE font (see _cap_reference), never
        # whichever capital the name happens to start with: sizing by the
        # first capital's ink delivered 'JADAM' ~20% smaller than 'ADAM' for
        # the same setting, because 'J' descends. The superseded output is
        # kept in golden/superseded_first_capital_basis/ for the record.
        ref, ref_warn = _cap_reference(font)
        if ref:
            return ref, warn + ref_warn
        warn.append("This font has no capital letters to measure — "
                    "measured the whole artwork instead.")
        basis = "total"
    elif basis == "xheight":
        # Measured outlines first, declared metric only as a fallback — the
        # SAME policy as the cap reference, for the same reason: declared
        # metrics are frequently wrong in display and script faces. Two of the
        # shipped fonts prove it for x-height too: this Merriweather cut is
        # unicase (its "lowercase" letters ARE capitals topping at 1486) yet
        # declares sxHeight 1097 — trusting it delivered letters 35% taller
        # than asked; TG Carrie declares 1024 while its lowercase actually
        # tops at 857 (16% small). What the user measures with calipers must
        # match what they typed, so the outlines win.
        tops = []
        for ch in FLAT_XHEIGHT:
            gname = font.cmap.get(ord(ch))
            if not gname:
                continue
            ys = [p[1] for c in font.contours(gname) for p in c]
            if ys and max(ys) > 0:
                tops.append(round(max(ys), 3))
        sx = getattr(font.tt["OS/2"], "sxHeight", 0) if "OS/2" in font.tt else 0
        if tops:
            ref = max(set(tops), key=lambda t: (tops.count(t), t))
            if sx and abs(sx - ref) > max(2.0, ref * 0.02):
                warn.append(
                    f"This font declares an x-height of {sx:g} units but its "
                    f"lowercase actually measures {ref:g}. Using the measured "
                    f"value, so the letters come out the size you asked for.")
            return float(ref), warn
        if sx and sx > 0:
            warn.append("No flat-topped lowercase to measure — used the "
                        "x-height this font declares.")
            return float(sx), warn
        warn.append("No lowercase reference in this font — measured the whole artwork.")
        basis = "total"

    ys = [p[1]
          for pl in placed
          for c in font.contours(pl.glyph)
          for p in c]
    if not ys:
        return float(font.upem), ["Nothing to measure — used the em size."]
    return max(ys) - min(ys), warn


def build_document(font: Font | str, text: str, height: float, unit: str = "in",
                   basis: str = "cap", features: dict | None = None) -> Document:
    """basis: 'cap' | 'xheight' | 'total'   unit: 'in' | 'mm'"""
    # Reject junk sizes before any geometry exists. inf and nan sailed all the
    # way into the files ('width="infin"', '/MediaBox [0 0 nan nan]'), 0 blew up
    # in Document.scale, a negative height mirrored the artwork, and 1e-6
    # rounded every coordinate to 0.0000 and destroyed the drawing in silence.
    # Refuse with a message; do not clamp, or the user never learns.
    try:
        finite = math.isfinite(height)
    except TypeError:
        finite = False
    if not finite or height <= 0:
        raise ValueError(
            f"Height must be a positive, finite number — got {height!r}. "
            f"Enter the finished size of the lettering, for example 1 in or 25 mm.")
    if isinstance(font, str):
        font = Font(font)
    placed = [p for p in shape(font, text, features)]
    drawable = [p for p in placed if font.contours(p.glyph)]
    # No drawable glyph means no artwork: empty text, spaces/tabs only, or
    # invisible characters like U+200B / U+2060 / U+FEFF / U+00AD. These used to
    # crash later and further away (TypeError in shape(), or min() on an empty
    # sequence in stack()). Say so here, plainly, rather than handing back a
    # degenerate document that only fails at export time.
    if not drawable:
        raise ValueError(
            f"There is nothing to cut in {text!r} — it produced no outline at all. "
            f"Blank text, spaces and invisible characters have no shape. Type a "
            f"name using characters this font can draw.")

    # ---- cut path: union of every letter, curves preserved ---------------- #
    union = pathops.Path()
    for p in drawable:
        piece = pathops.Path()
        font.outline(p.glyph).draw(piece.getPen())
        if p.x or p.y:
            # NOTE: Path.transform RETURNS a new path, it does not mutate in place.
            piece = piece.transform(1, 0, 0, 1, p.x, p.y)
        union = pathops.op(union, piece, pathops.PathOp.UNION)

    rp = RecordingPen()
    union.draw(rp)
    poly_cut = _flatten_recording(rp)

    # ---- engrave lines: from the font's own red layers -------------------- #
    engrave: list[list[tuple[float, float]]] = []
    warn: list[str] = []
    outlines_abs: list[LineString] = []
    for p in drawable:
        for c in font.contours(p.glyph):
            ring = [(x + p.x, y + p.y) for x, y in c]
            outlines_abs.append(LineString(ring + [ring[0]]))

    from shapely import affinity
    from shapely.ops import linemerge
    raw: list[LineString] = []
    n_bands = 0
    for p in placed:
        for layer_glyph, palette_index in font.colr.get(p.glyph, []):
            if not font.is_engrave_layer(palette_index):
                continue
            band = font.filled(layer_glyph)
            if band.is_empty:
                continue
            n_bands += 1
            band = affinity.translate(band.buffer(ENGRAVE_TOL), xoff=p.x, yoff=p.y)
            for ring in outlines_abs:
                hit = ring.intersection(band)
                if hit.is_empty:
                    continue
                for seg in (hit.geoms if hasattr(hit, "geoms") else [hit]):
                    if seg.geom_type == "LineString" and seg.length >= MIN_ENGRAVE_LEN:
                        raw.append(seg)
    if raw:
        # a band can graze more than one letter edge; dissolve duplicates and
        # stitch the pieces back into as few continuous lines as possible
        dissolved = unary_union(raw)
        merged = (linemerge(dissolved)
                  if dissolved.geom_type == "MultiLineString" else dissolved)
        for seg in (merged.geoms if hasattr(merged, "geoms") else [merged]):
            if seg.geom_type == "LineString" and seg.length >= MIN_ENGRAVE_LEN:
                engrave.append([(x, y) for x, y in seg.coords])

    if n_bands and not engrave:
        warn.append("This font marks engrave lines but none landed on a letter edge — "
                    "check the font, or export cut-only.")
    elif not n_bands:
        warn.append("No engrave lines for this name — cut path only." if font.colr
                    else "This font has no engrave lines (no COLR table) — cut path only.")

    xs = [pt[0] for ring in poly_cut for pt in ring]
    ys = [pt[1] for ring in poly_cut for pt in ring]
    bbox = (min(xs), min(ys), max(xs), max(ys)) if xs else (0, 0, 0, 0)

    basis_h, basis_warn = _measure_basis(font, text, drawable, basis)
    # A positive but absurdly small height (1e-6) is finite, so it passes the
    # check above, yet every exported coordinate rounds to 0.0000 and the
    # artwork is gone. Say so rather than writing an empty drawing in silence.
    if math.isfinite(basis_h) and basis_h > 0:
        sc = height / basis_h
        if max((bbox[2] - bbox[0]) * sc, (bbox[3] - bbox[1]) * sc) < 5e-5:
            basis_warn.append(
                f"A {basis} height of {height}{unit} is far too small to draw — "
                f"every coordinate rounds to zero. Use a larger height.")
    return Document(text=text, font_family=font.family, upem=font.upem,
                    cut_paths=[poly_cut], cut_skia=union, engrave_paths=engrave,
                    bbox=bbox, basis=basis, basis_height=basis_h,
                    target_height=height, unit=unit, warnings=warn + basis_warn)


def _flatten_recording(rp: RecordingPen) -> list[list[tuple[float, float]]]:
    """Flatten a RecordingPen's contours (used for the united cut path)."""
    out: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] | None = None
    pt = None

    def cubic(p0, p1, p2, p3):
        pts = []
        for i in range(1, FLATTEN_STEPS + 1):
            t = i / FLATTEN_STEPS
            m = 1 - t
            pts.append((m*m*m*p0[0] + 3*m*m*t*p1[0] + 3*m*t*t*p2[0] + t*t*t*p3[0],
                        m*m*m*p0[1] + 3*m*m*t*p1[1] + 3*m*t*t*p2[1] + t*t*t*p3[1]))
        return pts

    def quad(p0, p1, p2):
        pts = []
        for i in range(1, FLATTEN_STEPS + 1):
            t = i / FLATTEN_STEPS
            m = 1 - t
            pts.append((m*m*p0[0] + 2*m*t*p1[0] + t*t*p2[0],
                        m*m*p0[1] + 2*m*t*p1[1] + t*t*p2[1]))
        return pts

    for op, args in rp.value:
        if op == "moveTo":
            if cur and len(cur) > 2:
                out.append(cur)
            cur = [args[0]]
            pt = args[0]
        elif op == "lineTo":
            cur.append(args[0])
            pt = args[0]
        elif op == "curveTo":
            pts = list(args)
            cur.extend(cubic(pt, *pts))
            pt = pts[-1]
        elif op == "qCurveTo":
            pts = list(args)
            if pts and pts[-1] is None:
                # All-off-curve closed contour: a ring drawn with no on-curve
                # points at all. Legal TrueType and how some fonts draw eyelet
                # circles, and it arrives with NO preceding moveTo — so start
                # the contour at the implied midpoint, exactly as
                # Font.contours() already does. Without this, `cur` is None and
                # the extend below raises AttributeError.
                if cur and len(cur) > 2:
                    out.append(cur)
                pts = pts[:-1]
                mid = ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
                cur, pt = [mid], mid
                pts = pts + [mid]
            for i in range(len(pts) - 1):
                nxt = pts[i + 1]
                end = (((pts[i][0] + nxt[0]) / 2, (pts[i][1] + nxt[1]) / 2)
                       if i < len(pts) - 2 else nxt)
                cur.extend(quad(pt, pts[i], end))
                pt = end
        elif op in ("closePath", "endPath"):
            if cur and len(cur) > 2:
                out.append(cur)
            cur = None
    if cur and len(cur) > 2:
        out.append(cur)
    return out


# --------------------------------------------------------------------------- #
#  SVG export
# --------------------------------------------------------------------------- #
def _xml_comment(s: str) -> str:
    """Make text safe inside an XML comment.

    A name is user input and it lands in the SVG's header comment. '--' is
    illegal inside an XML comment, so a name like 'Mary--Jane' produced a file
    no conforming parser would open; and '-->' ended the comment early, which
    let the rest of the name inject live elements into the drawing. Angle
    brackets go too, so nothing in a name can ever become geometry.
    """
    out = (s or "").replace("<", "(").replace(">", ")")
    while "--" in out:
        out = out.replace("--", "-")
    return out.rstrip("-")


def _svg_path_closed(rings, sx, sy, ox, oy) -> str:
    d = []
    for ring in rings:
        pts = " L".join(f"{(x - ox) * sx:.4f},{(oy - y) * sy:.4f}" for x, y in ring)
        d.append("M" + pts + " Z")
    return " ".join(d)


def _svg_path_open(line, sx, sy, ox, oy) -> str:
    return "M" + " L".join(f"{(x - ox) * sx:.4f},{(oy - y) * sy:.4f}" for x, y in line)


def svg_single(doc: Document, margin: float = 0.0,
               extra_cut_lines: Iterable = ()) -> str:
    """One name, sized in real units. margin is in doc.unit.

    extra_cut_lines: OPEN polylines in font units that belong on the CUT layer
    (laser lead-ins). They join the CUT group so they cut with the outline, but
    unlike cut_paths they are never closed. Empty by default, in which case the
    output is byte-identical to a document without them.
    """
    s = doc.scale
    x0, y0, x1, y1 = doc.bbox
    w = (x1 - x0) * s + 2 * margin
    h = (y1 - y0) * s + 2 * margin
    ox = x0 - margin / s
    oy = y1 + margin / s
    unit = doc.unit
    cut = "".join(f'<path d="{_svg_path_closed(rings, s, s, ox, oy)}"/>'
                  for rings in doc.cut_paths)
    cut += "".join(f'<path d="{_svg_path_open(l, s, s, ox, oy)}"/>'
                   for l in extra_cut_lines)
    eng = "".join(f'<path d="{_svg_path_open(l, s, s, ox, oy)}"/>'
                  for l in doc.engrave_paths)
    sw = HAIRLINE_IN if unit == "in" else HAIRLINE_IN * MM_PER_IN
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        f'width="{w:.4f}{unit}" height="{h:.4f}{unit}" viewBox="0 0 {w:.4f} {h:.4f}">\n'
        f'<!-- {_xml_comment(doc.text)} | {_xml_comment(doc.font_family)} | '
        f'{doc.basis} height '
        f'{doc.target_height}{unit} | CUT=black outline, ENGRAVE=red centerlines -->\n'
        f'<g id="CUT" fill="none" stroke="#000000" stroke-width="{sw:.5f}" '
        f'stroke-linejoin="round">{cut}</g>\n'
        f'<g id="ENGRAVE" fill="none" stroke="#FF0000" stroke-width="{sw:.5f}" '
        f'stroke-linecap="round">{eng}</g>\n'
        f'</svg>\n')


def svg_sheet(docs: list[Document], gap: float = 0.25) -> str:
    """All names stacked on one sheet, left aligned. gap is in the docs' unit."""
    return svg_single(stack(docs, gap))


# --------------------------------------------------------------------------- #
#  PDF export  (hand-rolled: exact hairlines, exact RGB, no dependencies)
# --------------------------------------------------------------------------- #
def _pdf_escape(s: str) -> bytes:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)").encode("latin-1",
                                                                                "replace")


def _page_stream(doc: Document, margin_pt: float,
                 extra_cut_lines: Iterable = ()) -> tuple[bytes, float, float]:
    """PDF content stream for one name. PDF y axis points up, like font units.

    extra_cut_lines are OPEN black polylines (laser lead-ins): stroked with 'S'
    and never 'h', so they stay open, and emitted while the colour is still
    black so they belong to the cut, not the engrave.
    """
    to_pt = PT_PER_IN if doc.unit == "in" else PT_PER_IN / MM_PER_IN
    s = doc.scale * to_pt
    x0, y0, x1, y1 = doc.bbox
    w = (x1 - x0) * s + 2 * margin_pt
    h = (y1 - y0) * s + 2 * margin_pt
    ox, oy = x0, y0
    out = ["0 w"]                                     # width 0 = device hairline
    out.append("0 0 0 RG")
    for rings in doc.cut_paths:
        for ring in rings:
            pts = [((x - ox) * s + margin_pt, (y - oy) * s + margin_pt) for x, y in ring]
            out.append(f"{pts[0][0]:.3f} {pts[0][1]:.3f} m")
            out += [f"{px:.3f} {py:.3f} l" for px, py in pts[1:]]
            out.append("h S")
    for line in extra_cut_lines:
        pts = [((x - ox) * s + margin_pt, (y - oy) * s + margin_pt) for x, y in line]
        out.append(f"{pts[0][0]:.3f} {pts[0][1]:.3f} m")
        out += [f"{px:.3f} {py:.3f} l" for px, py in pts[1:]]
        out.append("S")
    out.append("1 0 0 RG")
    for line in doc.engrave_paths:
        pts = [((x - ox) * s + margin_pt, (y - oy) * s + margin_pt) for x, y in line]
        out.append(f"{pts[0][0]:.3f} {pts[0][1]:.3f} m")
        out += [f"{px:.3f} {py:.3f} l" for px, py in pts[1:]]
        out.append("S")
    return ("\n".join(out)).encode("latin-1"), w, h


def pdf_document(docs: list[Document], margin_pt: float = 6.0,
                 compress: bool = True,
                 extra_cut_lines: list | None = None) -> bytes:
    """One page per name, page size = artwork size + margin.

    extra_cut_lines, when given, is one list of open lead-in polylines per doc,
    positionally matched to docs.
    """
    objects: list[bytes] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)                            # 1-based object number

    page_ids, content_ids, sizes = [], [], []
    for i, d in enumerate(docs):
        extra = extra_cut_lines[i] if extra_cut_lines else ()
        stream, w, h = _page_stream(d, margin_pt, extra)
        raw = zlib.compress(stream) if compress else stream
        filt = b"/Filter /FlateDecode " if compress else b""
        content_ids.append(add(b"<< " + filt + b"/Length " +
                               str(len(raw)).encode() + b" >>\nstream\n" + raw +
                               b"\nendstream"))
        sizes.append((w, h))

    pages_id_placeholder = len(objects) + 1 + len(docs)   # filled in below
    for i, d in enumerate(docs):
        w, h = sizes[i]
        page_ids.append(add(
            f"<< /Type /Page /Parent {pages_id_placeholder} 0 R "
            f"/MediaBox [0 0 {w:.3f} {h:.3f}] /Resources << >> "
            f"/Contents {content_ids[i]} 0 R >>".encode()))
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    pages_id = add(f"<< /Type /Pages /Count {len(page_ids)} /Kids [{kids}] >>".encode())
    assert pages_id == pages_id_placeholder, (pages_id, pages_id_placeholder)
    info_id = add(b"<< /Producer (ShineOn Nameplate Cut-File app) /Title (" +
                  _pdf_escape(", ".join(d.text for d in docs)) + b") >>")
    root_id = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())

    buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(buf))
        buf += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(buf)
    buf += f"xref\n0 {len(objects) + 1}\n".encode()
    buf += b"0000000000 65535 f \n"
    for off in offsets:
        buf += f"{off:010d} 00000 n \n".encode()
    buf += (f"trailer\n<< /Size {len(objects) + 1} /Root {root_id} 0 R "
            f"/Info {info_id} 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    return bytes(buf)


def pdf_sheet(docs: list[Document], gap: float = 0.25, margin_pt: float = 6.0) -> bytes:
    """All names on a single page, stacked, left aligned."""
    return pdf_document([stack(docs, gap)], margin_pt=margin_pt)


def stack(docs: list[Document], gap: float = 0.25) -> Document:
    """One Document holding every name, already scaled into target units (scale == 1).

    Names are stacked top to bottom in reading order and aligned on the left.
    """
    if not docs:
        raise ValueError("nothing to stack")
    d0 = docs[0]
    cut_rings: list[list[tuple[float, float]]] = []
    eng_lines: list[list[tuple[float, float]]] = []
    y_top = 0.0                                  # y grows upward, so we walk downward
    for d in docs:
        sc = d.scale
        x0, y0, x1, y1 = d.bbox
        dy = y_top - (y1 - y0) * sc              # bottom of this name
        for rings in d.cut_paths:
            for ring in rings:
                cut_rings.append([((x - x0) * sc, (y - y0) * sc + dy) for x, y in ring])
        for line in d.engrave_paths:
            eng_lines.append([((x - x0) * sc, (y - y0) * sc + dy) for x, y in line])
        y_top = dy - gap
    xs = [p[0] for r in cut_rings for p in r]
    ys = [p[1] for r in cut_rings for p in r]
    # Without this, an ink-free document reached min() on an empty list and the
    # sheet died with a bare "min() iterable argument is empty".
    if not xs:
        raise ValueError(
            "Nothing to put on the sheet — none of these names produced any "
            f"outline to cut ({', '.join(repr(d.text) for d in docs)}).")
    return Document(text=" / ".join(d.text for d in docs), font_family=d0.font_family,
                    upem=d0.upem, cut_paths=[cut_rings], cut_skia=pathops.Path(),
                    engrave_paths=eng_lines,
                    bbox=(min(xs), min(ys), max(xs), max(ys)),
                    basis="sheet", basis_height=1.0, target_height=1.0, unit=d0.unit,
                    warnings=[w for d in docs for w in d.warnings])


# --------------------------------------------------------------------------- #
#  convenience
# --------------------------------------------------------------------------- #
def safe_filename(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9 _.-]", "_", text).strip().replace(" ", "_")
    return s or "name"


def summary(doc: Document) -> str:
    w, h = doc.size()
    n_cut = sum(len(r) for r in doc.cut_paths)
    return (f"{doc.text}: {w:.3f} x {h:.3f} {doc.unit}  |  "
            f"{n_cut} cut contour(s), {len(doc.engrave_paths)} engrave line(s)")

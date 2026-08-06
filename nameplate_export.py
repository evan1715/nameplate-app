"""
nameplate_export.py — writes the cut files in the order the laser must cut them.

WHY THIS EXISTS SEPARATELY FROM THE CORE WRITERS
    The core writers emit one CUT group and one ENGRAVE group, in that order,
    with the contours in whatever order the union produced. That is fine for
    looking at, and wrong for cutting a part out of sheet metal:

      * The part is held by the surrounding sheet ONLY until its outer edge is
        cut. The moment the outline is finished the part drops or shifts, and
        every cut after that is being made on air or on a moved part. So the
        OUTLINE MUST BE CUT LAST.
      * Engraving must happen while the part is still fully supported, so it
        goes FIRST.
      * The interior holes — letter counters and eyelet holes — come in between.
        Their slugs dropping out does not move the part.

    Cut order is taken from stacking order, bottom first, and in a vector file
    the first thing written is the bottom. So everything here is emitted in the
    order: engrave, then inner cuts, then the outline, per name.

GROUPS
    Each name is written as its own group so a sheet does not have to be
    hand-grouped after import. SVG carries real group names. PDF has no group
    concept, so each name becomes an Optional Content Group — a PDF layer —
    which CorelDRAW imports as a named layer.

LEAD-INS
    A contour that has a lead-in is written as ONE open path that starts out in
    the scrap and runs into the outline (see nameplate_leadin.merge_run). It
    keeps its place in the order above: a hole's lead-in is part of the inner
    cuts, the outline's lead-in is part of the last cut.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass, field

from nameplate_core import HAIRLINE_IN, MM_PER_IN, PT_PER_IN, Document
import nameplate_layout as LAY
import nameplate_leadin as LI


@dataclass
class Piece:
    """One name, in final sheet coordinates, already in cutting order."""
    label: str
    engrave: list = field(default_factory=list)          # [pts]
    inner: list = field(default_factory=list)            # [(pts, is_open)]
    outer: list = field(default_factory=list)            # [(pts, is_open)]

    def all_points(self):
        for p in self.engrave:
            yield from p
        for pts, _o in self.inner:
            yield from pts
        for pts, _o in self.outer:
            yield from pts


def build_pieces(docs: list[Document], gap: float = 0.25,
                 direction: str = LAY.VERTICAL,
                 lead_len: float | None = None,
                 lead_clear: float | None = None) -> tuple[list[Piece], tuple]:
    """Lay the names out and return them as cut-ordered pieces + overall bbox.

    Lead-ins are worked out per NAME, not on the merged sheet: each name is its
    own part, so each one gets its own entry moves.
    """
    boxes = LAY.arrangement_bounds(docs, gap, direction)
    pieces: list[Piece] = []
    for doc, box in zip(docs, boxes):
        s = doc.scale
        x0, y0, _x1, _y1 = doc.bbox
        dx, dy = box[0], box[1]

        def place(pts):
            return [((x - x0) * s + dx, (y - y0) * s + dy) for x, y in pts]

        rings = LI._rings(doc)
        _polys, depths, _mat = LI._analyse(rings) if rings else ([], [], None)

        runs_by_ring: dict[int, list] = {}
        if lead_len:
            info = LI.lead_in_report(doc, lead_len, lead_clear)
            # match each run back to the ring it belongs to by its anchor
            for detail, run in zip(info["leads_detail"], info["runs"]):
                runs_by_ring[detail["ring"]] = run

        pc = Piece(label=doc.text)
        pc.engrave = [place(l) for l in doc.engrave_paths]
        for idx, (ring, depth) in enumerate(zip(rings, depths)):
            run = runs_by_ring.get(idx)
            geom = (place(run), True) if run else (place(ring), False)
            if depth % 2 == 1:
                pc.inner.append(geom)          # a hole
            else:
                pc.outer.append(geom)          # the outline, cut last
        pieces.append(pc)

    xs = [p[0] for pc in pieces for p in pc.all_points()]
    ys = [p[1] for pc in pieces for p in pc.all_points()]
    if not xs:
        raise ValueError("nothing to export: none of these names produced any "
                         "cuttable outline")
    return pieces, (min(xs), min(ys), max(xs), max(ys))


def _safe_id(s: str, used: set) -> str:
    out = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in s) or "name"
    # an XML Name may not START with a digit, hyphen or period — "-Ann" would
    # make the SVG invalid even though '-' is fine elsewhere in the id
    if not (out[0].isalpha() or out[0] == "_"):
        out = "n" + out
    base, n = out, 2
    while out in used:
        out = f"{base}_{n}"
        n += 1
    used.add(out)
    return out


# --------------------------------------------------------------------------- #
#  SVG
# --------------------------------------------------------------------------- #
def svg(pieces: list[Piece], bbox: tuple, unit: str) -> str:
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    sw = HAIRLINE_IN if unit == "in" else HAIRLINE_IN * MM_PER_IN

    def d_of(pts, closed):
        body = " L".join(f"{x - x0:.4f},{y1 - y:.4f}" for x, y in pts)
        return "M" + body + (" Z" if closed else "")

    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        f'width="{w:.4f}{unit}" height="{h:.4f}{unit}" '
        f'viewBox="0 0 {w:.4f} {h:.4f}">',
        '<!-- cut order is bottom to top: engrave, then inner cuts, then the '
        'outline last so the part stays held until the end -->',
    ]
    used: set = set()
    for pc in pieces:
        gid = _safe_id(pc.label, used)
        out.append(f'<g id="{gid}">')
        if pc.engrave:
            out.append(f'<g id="{gid}__1_engrave" fill="none" stroke="#FF0000" '
                       f'stroke-width="{sw:.5f}" stroke-linecap="round">'
                       + "".join(f'<path d="{d_of(p, False)}"/>' for p in pc.engrave)
                       + '</g>')
        if pc.inner:
            out.append(f'<g id="{gid}__2_cut_inner" fill="none" stroke="#000000" '
                       f'stroke-width="{sw:.5f}" stroke-linejoin="round">'
                       + "".join(f'<path d="{d_of(p, not o)}"/>' for p, o in pc.inner)
                       + '</g>')
        if pc.outer:
            out.append(f'<g id="{gid}__3_cut_outline" fill="none" stroke="#000000" '
                       f'stroke-width="{sw:.5f}" stroke-linejoin="round">'
                       + "".join(f'<path d="{d_of(p, not o)}"/>' for p, o in pc.outer)
                       + '</g>')
        out.append('</g>')
    out.append('</svg>')
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
#  PDF, with one Optional Content Group (layer) per name
# --------------------------------------------------------------------------- #
def _pdf_escape(s: str) -> bytes:
    return (s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            .encode("latin-1", "replace"))


def pdf(pieces: list[Piece], bbox: tuple, unit: str,
        margin_pt: float = 6.0, compress: bool = True) -> bytes:
    to_pt = PT_PER_IN if unit == "in" else PT_PER_IN / MM_PER_IN
    x0, y0, x1, y1 = bbox
    w = (x1 - x0) * to_pt + 2 * margin_pt
    h = (y1 - y0) * to_pt + 2 * margin_pt
    # An explicit hairline beats "0 w": width 0 is device-dependent and Corel
    # imports it as its own default, losing the hairline.
    hair_pt = HAIRLINE_IN * PT_PER_IN

    def emit(pts, closed):
        p = [((x - x0) * to_pt + margin_pt, (y - y0) * to_pt + margin_pt)
             for x, y in pts]
        rows = [f"{p[0][0]:.3f} {p[0][1]:.3f} m"]
        rows += [f"{a:.3f} {b:.3f} l" for a, b in p[1:]]
        rows.append("h S" if closed else "S")
        return rows

    body: list[str] = [f"{hair_pt:.4f} w"]
    ocg_names: list[str] = []
    used: set = set()
    for i, pc in enumerate(pieces):
        ocg_names.append(_safe_id(pc.label, used))
        body.append(f"/OC /MC{i} BDC")
        if pc.engrave:                                  # engrave first
            body.append("1 0 0 RG")
            for p in pc.engrave:
                body += emit(p, False)
        body.append("0 0 0 RG")
        for p, o in pc.inner:                           # then inner cuts
            body += emit(p, not o)
        for p, o in pc.outer:                           # outline LAST
            body += emit(p, not o)
        body.append("EMC")

    stream = "\n".join(body).encode("latin-1")
    raw = zlib.compress(stream) if compress else stream

    objects: list[bytes] = []

    def add(o: bytes) -> int:
        objects.append(o)
        return len(objects)

    content_id = add(b"<< " + (b"/Filter /FlateDecode " if compress else b"")
                     + b"/Length " + str(len(raw)).encode()
                     + b" >>\nstream\n" + raw + b"\nendstream")
    ocg_ids = [add(b"<< /Type /OCG /Name (" + _pdf_escape(n) + b") >>")
               for n in ocg_names]
    props = " ".join(f"/MC{i} {oid} 0 R" for i, oid in enumerate(ocg_ids))
    # The page is added before the Pages node, so its /Parent is the number the
    # Pages node will get: current count + 2.
    page_id = add(
        (f"<< /Type /Page /Parent {len(objects) + 2} 0 R "
         f"/MediaBox [0 0 {w:.3f} {h:.3f}] "
         f"/Resources << /Properties << {props} >> >> "
         f"/Contents {content_id} 0 R >>").encode())
    pages_id = add(f"<< /Type /Pages /Count 1 /Kids [{page_id} 0 R] >>".encode())
    order = " ".join(f"{oid} 0 R" for oid in ocg_ids)
    root_id = add((f"<< /Type /Catalog /Pages {pages_id} 0 R "
                   f"/OCProperties << /OCGs [{order}] "
                   f"/D << /Order [{order}] /ON [{order}] >> >> >>").encode())
    info_id = add(b"<< /Producer (Sean's Font Prototyping Friend) /Title ("
                  + _pdf_escape(", ".join(p.label for p in pieces)) + b") >>")

    buf = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, o in enumerate(objects, start=1):
        offsets.append(len(buf))
        buf += f"{n} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(buf)
    buf += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        buf += f"{off:010d} 00000 n \n".encode()
    buf += (f"trailer\n<< /Size {len(objects) + 1} /Root {root_id} 0 R "
            f"/Info {info_id} 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    return bytes(buf)


# --------------------------------------------------------------------------- #
#  convenience
# --------------------------------------------------------------------------- #
def export_svg(docs, gap=0.25, direction=LAY.VERTICAL,
               lead_len=None, lead_clear=None) -> str:
    pieces, bbox = build_pieces(docs, gap, direction, lead_len, lead_clear)
    return svg(pieces, bbox, docs[0].unit)


def export_pdf(docs, gap=0.25, direction=LAY.VERTICAL,
               lead_len=None, lead_clear=None, margin_pt=6.0) -> bytes:
    pieces, bbox = build_pieces(docs, gap, direction, lead_len, lead_clear)
    return pdf(pieces, bbox, docs[0].unit, margin_pt=margin_pt)

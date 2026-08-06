"""
nameplate_layout.py — how several names sit on one sheet.

    vertical    stacked top to bottom, aligned on the left   (the original)
    horizontal  placed left to right, aligned on the bottom

Each name is placed by its own bounding box plus the gap, so with any gap >= 0
two names can never overlap — at gap 0 they touch exactly, and every larger gap
separates them. arrangement_bounds() hands back the box each name ended up in so
that can be verified rather than assumed.

Vertical delegates to nameplate_core.stack() unchanged, so existing sheets come
out byte-for-byte as before.
"""

from __future__ import annotations

from nameplate_core import Document, stack
import pathops

VERTICAL, HORIZONTAL = "vertical", "horizontal"
DIRECTIONS = (VERTICAL, HORIZONTAL)


def _placed_rings(doc: Document, dx: float, dy: float):
    """This document's geometry moved so its bbox corner sits at (dx, dy)."""
    sc = doc.scale
    x0, y0, _x1, _y1 = doc.bbox
    cut = [[((x - x0) * sc + dx, (y - y0) * sc + dy) for x, y in ring]
           for rings in doc.cut_paths for ring in rings]
    eng = [[((x - x0) * sc + dx, (y - y0) * sc + dy) for x, y in line]
           for line in doc.engrave_paths]
    return cut, eng


def arrangement_bounds(docs: list[Document], gap: float = 0.25,
                       direction: str = VERTICAL):
    """(x0, y0, x1, y1) per name, in sheet units, in the order given."""
    out = []
    if direction == HORIZONTAL:
        x = 0.0
        for d in docs:
            w, h = d.size()
            out.append((x, 0.0, x + w, h))
            x += w + gap
    else:
        y_top = 0.0
        for d in docs:
            w, h = d.size()
            out.append((0.0, y_top - h, w, y_top))
            y_top -= h + gap
    return out


def overlaps(docs: list[Document], gap: float = 0.25,
             direction: str = VERTICAL) -> list[tuple[int, int]]:
    """Index pairs whose boxes genuinely overlap. Touching does not count."""
    boxes = arrangement_bounds(docs, gap, direction)
    bad = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            ax0, ay0, ax1, ay1 = boxes[i]
            bx0, by0, bx1, by1 = boxes[j]
            ix = min(ax1, bx1) - max(ax0, bx0)
            iy = min(ay1, by1) - max(ay0, by0)
            if ix > 1e-9 and iy > 1e-9:
                bad.append((i, j))
    return bad


def arrange(docs: list[Document], gap: float = 0.25,
            direction: str = VERTICAL) -> Document:
    """One Document holding every name, already scaled into sheet units."""
    if not docs:
        raise ValueError("nothing to arrange")
    if direction != HORIZONTAL:
        return stack(docs, gap)          # unchanged, keeps golden output identical

    d0 = docs[0]
    cut_rings: list[list[tuple[float, float]]] = []
    eng_lines: list[list[tuple[float, float]]] = []
    x_left = 0.0
    for d in docs:
        cut, eng = _placed_rings(d, x_left, 0.0)
        cut_rings += cut
        eng_lines += eng
        x_left += d.size()[0] + gap      # its own width, then the gap

    xs = [p[0] for r in cut_rings for p in r]
    ys = [p[1] for r in cut_rings for p in r]
    return Document(
        text=" / ".join(d.text for d in docs), font_family=d0.font_family,
        upem=d0.upem, cut_paths=[cut_rings], cut_skia=pathops.Path(),
        engrave_paths=eng_lines,
        bbox=(min(xs), min(ys), max(xs), max(ys)),
        basis="sheet", basis_height=1.0, target_height=1.0, unit=d0.unit,
        warnings=[w for d in docs for w in d.warnings])

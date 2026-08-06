"""
nameplate_fontcheck.py — say WHAT is wrong with a font, in words worth acting on.

    python nameplate_fontcheck.py "path\\to\\font.ttf" [more fonts...]

        --prompt          print a work order for whoever edits the font,
                          in font units, instead of the human report
        --no-join-scan    skip the letter-pair scan (the slow part)
        --budget=SECONDS  how long the letter-pair scan may take (default 6)

The point is to replace "KeyError: 'gid131'" with a specific, named defect and
the edit that fixes it. Every check answers three questions:

    what is wrong  ·  what it does to the artwork  ·  what to change in the font

--prompt answers a fourth, for a different reader. The report tells Sean what is
wrong with his font; the prompt tells whoever edits the font which glyph to open,
by glyph ID, and how far to move what — in FONT UNITS, because that is the unit a
font editor works in, and every size stated in inches to someone working in font
units has come back wrong by a factor of the em.

SEVERITY
    ERROR   the font cannot produce a usable cut file until this is fixed
    WARNING it will produce a file, but the file is probably not what you want
    NOTE    worth knowing; the app handles it

Nothing here modifies a font. It only reports. Checks are individually guarded,
so a font broken badly enough to crash one check still gets all the others.
"""

from __future__ import annotations

import os
import re
import sys
import textwrap
import traceback
from dataclasses import dataclass, field

ERROR, WARNING, NOTE = "ERROR", "WARNING", "NOTE"
_RANK = {ERROR: 0, WARNING: 1, NOTE: 2}

# characters a nameplate shop actually types
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
EXTRAS = " '-."


@dataclass
class Finding:
    severity: str
    code: str
    title: str
    detail: str
    fix: str
    # The measurements behind the prose. Kept so the same defect can be restated
    # as an instruction to whoever edits the font without measuring it again.
    # Plain numbers and strings only — never a font or a polygon — so a Finding
    # still renders long after the font it came from was closed.
    data: dict = field(default_factory=dict)

    def instruction(self, upem: int, scale: float | None = None) -> str:
        """This one defect as an order a font editor can carry out.

        Deliberately not the same text as .fix. .fix tells Sean what is wrong
        with his font; this tells whoever edits the font which glyph to open and
        how far to move what, in font units. The GUI offers it per row so Sean
        can hand over one defect at a time, so it has to stand on its own.

        upem is required because every number here is a font-unit number and a
        reader cannot judge one without knowing the em. scale (font units to
        inches) is optional: with it each size is also given in inches.
        """
        try:
            return _instruction(self, int(upem or 0), scale)
        except Exception:
            # a prompt that admits it could not measure something is still
            # usable; a traceback in the middle of Sean's clipboard is not.
            # Flattened through _plain() like every other prompt line — the
            # title/detail/fix carry typographic dashes, and the ASCII-only
            # contract applies to the fallback too.
            return _plain(
                f"{self.title}. {self.detail} {self.fix} "
                f"(this defect could not be restated in font units - "
                f"measure it in the font editor before changing anything.)")


# --------------------------------------------------------------------------- #
#  letter joins — WHERE a name breaks apart, not just that it does
# --------------------------------------------------------------------------- #
def _filled_cached(font, glyph):
    """font.filled() memoised per glyph.

    Font.contours() is cached in the engine but filled() is not — it rebuilds
    shapely polygons and redoes the containment-parity work on every call. A
    letter-join scan asks for the same few hundred glyphs thousands of times, so
    without this the scan spends nearly all its time re-deriving the same shapes.
    Cached on the Font instance, so it dies with it.
    """
    cache = font.__dict__.setdefault("_fc_filled", {})
    if glyph not in cache:
        try:
            cache[glyph] = font.filled(glyph)
        except Exception:
            cache[glyph] = None
    return cache[glyph]


def _placed_areas(font, text: str):
    """(run index, source character, glyph, pen x, pen y, filled polygon).

    Everything glyph_areas has, plus the two things an instruction needs and a
    gap measurement does not: the pen position, so a point in the word can be
    put back into the glyph's own coordinate system, and the character that
    produced the glyph, so an alternate can be told from the default form.

    The character is only filled in when shaping produced exactly one glyph per
    character. A ligature makes that mapping ambiguous, and a guess about which
    letter a glyph came from is worse than saying nothing.
    """
    from shapely import affinity

    from nameplate_core import shape
    placed = shape(font, text)
    one_to_one = len(placed) == len(text)
    out = []
    for i, p in enumerate(placed):
        g = _filled_cached(font, p.glyph)
        if g is None or g.is_empty:
            continue
        out.append((i, text[i] if one_to_one else "", p.glyph, p.x, p.y,
                    affinity.translate(g, xoff=p.x, yoff=p.y)))
    return out


def glyph_areas(font, text: str):
    """(glyph name, filled polygon at its shaped position) per glyph.

    Shaping first matters: a script font picks contextual forms, so 'g' before
    'o' may be a different glyph than 'g' on its own, with a different exit
    stroke. Testing raw letters would test shapes the font never uses.
    """
    return [(name, poly) for _i, _ch, name, _x, _y, poly in _placed_areas(font, text)]


def name_gaps(font, text: str):
    """Consecutive glyphs whose ink does not touch.

    Returns [(left glyph, right glyph, gap in font units), ...]. A gap here is
    why a name cuts as loose pieces instead of one plate.
    """
    areas = glyph_areas(font, text)
    gaps = []
    for (n1, a), (n2, b) in zip(areas, areas[1:]):
        try:
            if not a.intersects(b):
                gaps.append((n1, n2, a.distance(b)))
        except Exception:
            continue
    return gaps


def describe_gaps(gaps, upem: int, scale: float | None = None) -> str:
    """'g -> o (0.031 in)' style summary, trimmed to something readable."""
    bits = []
    for n1, n2, d in gaps[:8]:
        if scale:
            bits.append(f"{n1}→{n2} ({d * scale:.3f} in)")
        else:
            bits.append(f"{n1}→{n2} ({d / upem:.3f} em)")
    if len(gaps) > 8:
        bits.append(f"and {len(gaps) - 8} more")
    return ", ".join(bits)


# --------------------------------------------------------------------------- #
#  naming a defect precisely enough to edit — glyph identity and geometry
# --------------------------------------------------------------------------- #
KERF_IN = 0.004                  # the laser's own floor; see nameplate_leadin
OVERLAP_EM = 0.015               # how much of the em a joint must really share


def _gid(font, glyph: str | None):
    """Glyph ID for a glyph name, or None.

    The ID matters more than the name. A font with a post format 3.0 table
    carries no glyph names at all, so the names in this report are placeholders
    fontTools invented (glyph00174) and the number in them is the only handle
    that means the same thing in every tool.
    """
    if not glyph:
        return None
    try:
        return font.tt.getGlyphID(glyph)
    except Exception:
        try:
            return font.tt.getGlyphOrder().index(glyph)
        except Exception:
            return None


def _reverse_cmap(font):
    """glyph name -> the code point that reaches it, for directly encoded glyphs.

    Cached on the Font, like _filled_cached, because a prompt asks for it once
    per junction and building it walks the whole cmap.
    """
    cache = font.__dict__.get("_fc_rev")
    if cache is None:
        cache = {}
        try:
            for cp, name in (font.cmap or {}).items():
                cache.setdefault(name, cp)
        except Exception:
            pass
        font.__dict__["_fc_rev"] = cache
    return cache


def _glyph_role(font, glyph: str, ch: str, rev=None):
    """What one glyph IS, in the terms a font editor searches by.

    The important field is 'alternate'. A script font substitutes contextual
    forms, so the 'o' in 'ego' can be a different glyph from the 'o' the cmap
    points at. Editing the one the cmap points at changes a glyph that was never
    the problem and leaves the defect exactly where it was — which is the failure
    this whole module exists to stop.
    """
    rev = _reverse_cmap(font) if rev is None else rev
    base = None
    try:
        base = (font.cmap or {}).get(ord(ch)) if ch else None
    except Exception:
        base = None
    return {"glyph": glyph, "gid": _gid(font, glyph), "char": ch,
            "codepoint": rev.get(glyph), "base": base,
            "base_gid": _gid(font, base) if base else None,
            "alternate": bool(base and base != glyph)}


def overlap_margin(upem: int, scale: float | None = None) -> int:
    """Font units a stroke must reach PAST first contact for the joint to hold.

    A tangent touch is not a joint. The cut path is the union of the letters, and
    two shapes that only kiss union into a pinch of no width, which the laser
    reads as a break — that is why 'they must genuinely cross' keeps appearing in
    this file. 1.5% of the em is a real bite out of a script stroke, and it is
    also kept to at least four kerf widths at the size being checked, so the
    overlap stays wider than the beam rather than wider than nothing.
    """
    upem = int(upem or 1000)
    margin = max(1.0, round(OVERLAP_EM * upem))
    try:
        if scale:
            margin = max(margin, 4.0 * KERF_IN / scale)
    except Exception:
        pass
    return int(round(margin))


def junction_details(font, text: str, scale: float | None = None, limit: int = 12):
    """One dict per place in `text` where consecutive letters do not touch.

    The gap alone does not tell an editor what to do. This adds the two glyphs by
    ID, whether each is a contextual alternate or the default form of its letter,
    and where the nearest ink actually is — expressed in the LEFT glyph's own
    coordinate system, because the left glyph is the one being extended and an
    editor works in the glyph's space, not the word's.

    Returns plain dicts so a Finding can carry them.
    """
    from shapely.ops import nearest_points

    upem = int(getattr(font, "upem", 0) or 1000)
    margin = overlap_margin(upem, scale)
    rev = _reverse_cmap(font)
    areas = _placed_areas(font, text)
    out = []
    for (_i1, c1, n1, x1, y1, a), (_i2, c2, n2, x2, y2, b) in zip(areas, areas[1:]):
        if len(out) >= limit:
            break
        try:
            if a.intersects(b):
                continue
            gap = float(a.distance(b))
            pa, pb = nearest_points(a, b)
        except Exception:
            continue

        # the same two points, once in each glyph's own coordinates
        lx, ly = pa.x - x1, pa.y - y1                # left glyph's exit ink
        rx, ry = pb.x - x1, pb.y - y1                # where it has to reach to
        dx, dy = rx - lx, ry - ly
        span = (dx * dx + dy * dy) ** 0.5 or 1.0
        ux, uy = dx / span, dy / span
        out.append({
            "example": text,
            "gap_units": gap,
            "margin_units": margin,
            "need_units": gap + margin,
            "left": _glyph_role(font, n1, c1, rev),
            "right": _glyph_role(font, n2, c2, rev),
            # in the LEFT glyph's coordinates: ink now, contact point, and the
            # point the stroke has to pass to leave a real overlap
            "left_from": (lx, ly),
            "left_contact": (rx, ry),
            "left_target": (rx + ux * margin, ry + uy * margin),
            # the same again for the RIGHT glyph, for when its entry stroke is
            # the narrower thing to change
            "right_from": (pb.x - x2, pb.y - y2),
            "right_contact": (pa.x - x2, pa.y - y2),
            "right_target": (pa.x - x2 - ux * margin, pa.y - y2 - uy * margin),
        })
    return out


JUNCTION_DETAIL = 10             # how many junctions get coordinates, not a list


def _junctions_for(font, items, scale: float | None = None):
    """Measure the junctions a join scan named, properly.

    join_scan keeps only the pair and one example string, because measuring 7000
    combinations to this depth would cost minutes. The handful that actually
    failed are worth the coordinates, and re-shaping ten short strings against
    the caches costs nothing.
    """
    out = []
    for junction, example in items:
        try:
            for j in junction_details(font, example, scale):
                if f"{j['left']['glyph']}→{j['right']['glyph']}" == junction:
                    out.append(j)
                    break
        except Exception:
            continue
    return out


def _hole_neighbours(font, text: str, hole, tol: float = 1.0, limit: int = 3):
    """Which glyphs form the walls of a hole in a built name, and where.

    A sliver hole is not a defect in one glyph, it is a defect in a meeting of
    two, so naming both is the difference between an actionable instruction and
    'something is too small somewhere'. The hole's position is also given inside
    each named glyph's own coordinates, because that is where it can be found.
    """
    out = []
    try:
        c = hole.centroid
        for _i, ch, name, x, y, poly in _placed_areas(font, text):
            if len(out) >= limit:
                break
            try:
                if poly.distance(hole) > tol:
                    continue
            except Exception:
                continue
            out.append({"glyph": name, "gid": _gid(font, name), "char": ch,
                        "at": (c.x - x, c.y - y)})
    except Exception:
        pass
    return out


def winding_check(font, glyphs=None) -> list[dict]:
    """Glyphs whose counters are wound the wrong way, so they cut SOLID.

    The app measures with a PARITY fill model (`Font.filled`: a ring nested
    inside an odd number of others is a hole, whatever direction it was drawn)
    but it CUTS with skia's winding union, exactly as `build_document` does. The
    two agree only while the counters run opposite to their outer contour.

    Rewind a counter to match its outer and the two models part company: skia
    cancels the counter and emits ONE contour, so the letter lasers as a solid
    blob, while parity still reports a hole and every existing check passes. The
    report even says "0 junctions disconnected" -- the defect is invisible
    because nothing else compares the cut's own fill rule against the model's.

    So this compares them directly, per glyph, and reports where they disagree.
    Returns a list of {glyph, parity_holes, cut_holes} for the mismatches.
    """
    from shapely.geometry import Polygon
    from fontTools.pens.recordingPen import RecordingPen
    import pathops
    from nameplate_core import _flatten_recording, shape

    out: list[dict] = []
    cmap = getattr(font, "cmap", {}) or {}
    if glyphs is None:
        seen, glyphs = set(), []
        for ch in LETTERS:
            g = cmap.get(ord(ch))
            if g and g not in seen:
                seen.add(g)
                glyphs.append(g)
        # the contextual forms too: a defect in A.ini never shows up in 'A'
        try:
            for ch in LETTERS[:26]:
                for p in shape(font, ch + "a" + ch.lower()):
                    if p.glyph not in seen:
                        seen.add(p.glyph)
                        glyphs.append(p.glyph)
        except Exception:
            pass

    for gname in glyphs:
        try:
            rings = [Polygon(c) for c in font.contours(gname)]
            rings = [r for r in rings if r.area > 0]
            if len(rings) < 2:
                continue                  # no counter, nothing to wind wrongly
            # PARITY: how many rings sit at odd nesting depth
            parity_holes = 0
            for i, r in enumerate(rings):
                depth = sum(1 for j, q in enumerate(rings)
                            if j != i and q.area > r.area
                            and q.buffer(0).contains(r.representative_point()))
                if depth % 2:
                    parity_holes += 1
            if not parity_holes:
                continue
            # WINDING: what the cut actually produces, same call build_document makes
            union = pathops.op(pathops.Path(), font.outline(gname),
                               pathops.PathOp.UNION)
            rp = RecordingPen()
            union.draw(rp)
            cut_rings = [Polygon(c) for c in _flatten_recording(rp)]
            cut_rings = [r for r in cut_rings if r.area > 0]
            cut_holes = 0
            for i, r in enumerate(cut_rings):
                depth = sum(1 for j, q in enumerate(cut_rings)
                            if j != i and q.area > r.area
                            and q.buffer(0).contains(r.representative_point()))
                if depth % 2:
                    cut_holes += 1
            if cut_holes < parity_holes:
                out.append({"glyph": gname, "parity_holes": parity_holes,
                            "cut_holes": cut_holes,
                            "lost": parity_holes - cut_holes})
        except Exception:
            continue
    return out


CONTEXTS = "eaonrglstc"          # common preceding letters, for contextual forms


def join_scan(font, budget_s: float = 25.0, contexts: str = CONTEXTS):
    """Which letter combinations leave a gap between neighbouring letters.

    Two phases, because a script font substitutes contextual forms: a pair can
    join perfectly on its own and still break inside a word. In the font that
    prompted this, 'go' connects but 'ego' does not — the 'o' after 'eg' is a
    different glyph with a different entry stroke. So phase 1 tests every plain
    pair, and phase 2 re-tests those pairs behind a leading letter.

    Bounded by a wall-clock budget; whatever was not reached is reported as
    untested rather than quietly passed. The definitive check is still the name
    you actually type — the preview reports the junction for that name.

    Returns (failures, tested, truncated) where failures maps
    "left→right glyph" to an example string that shows the gap.
    """
    import string
    import time

    low = string.ascii_lowercase
    cmap = getattr(font, "cmap", {}) or {}
    have = [c for c in low if ord(c) in cmap]
    caps = [c for c in string.ascii_uppercase if ord(c) in cmap]

    combos = [a + b for a in have for b in have]
    for c in contexts:
        if ord(c) in cmap:
            combos += [c + a + b for a in have for b in have]

    # Phase 3 and 4: the junction types most real names are actually made of,
    # which the two phases above never shape.
    #
    # A two-letter string tests initial->FINAL forms. A trigram behind one of
    # ten context letters tests initial->medial->final for those ten. What is
    # missing is a MEDIAL->MEDIAL junction — the interior of any name of four
    # letters or more — and a Capital-initial->medial junction, which is what
    # every Name-cased name starts with.
    #
    # This is not theoretical. On Cervanttis-ExtraBoldEyelet the two phases above
    # report a scan of 7,436 combinations and 'Daniel' still cuts into 3 loose
    # pieces; 'Bjorn' likewise. Wrapping the pair so both letters take medial
    # forms finds those junctions, and a Capital + medial template finds the one
    # 'Bjorn' breaks at. On the shipped TGCarrieSOFlourish it finds Dleftring->d,
    # which no other phase looks at.
    #
    # 'a' is the wrapper because it is the commonest letter with both an entry
    # and an exit stroke in these faces; if the font has no 'a' the phase is
    # skipped rather than guessed at.
    if "a" in have:
        combos += ["a" + x + y + "a" for x in have for y in have]
        combos += [C + x + "a" for C in caps for x in have]

    end = time.perf_counter() + budget_s
    failures: dict[str, str] = {}
    tested = 0
    truncated = False
    for text in combos:
        if time.perf_counter() > end:
            truncated = True
            break
        tested += 1
        try:
            for n1, n2, _d in name_gaps(font, text):
                failures.setdefault(f"{n1}→{n2}", text)
        except Exception:
            continue
    return failures, tested, truncated, len(combos)


@dataclass
class Report:
    path: str
    family: str = ""
    findings: list[Finding] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    # what the numbers in the findings are relative to. upem is the em size;
    # scale converts font units to inches at the size the font was checked at,
    # and is None when no name could be built to measure it.
    upem: int = 0
    scale: float | None = None
    meta: dict = field(default_factory=dict)

    def add(self, severity, code, title, detail, fix, data=None) -> None:
        self.findings.append(Finding(severity, code, title, detail, fix,
                                     data or {}))

    @property
    def errors(self):
        return [f for f in self.findings if f.severity == ERROR]

    @property
    def warnings(self):
        return [f for f in self.findings if f.severity == WARNING]

    @property
    def usable(self) -> bool:
        return not self.errors

    def sorted(self):
        return sorted(self.findings, key=lambda f: _RANK[f.severity])

    def text(self) -> str:
        out = [f"{os.path.basename(self.path)}"]
        if self.family:
            out.append(f"  {self.family}")
        out.append("")
        if not self.findings:
            out.append("No problems found. This font should work.")
        else:
            verdict = ("CANNOT BE USED until the ERROR items are fixed"
                       if self.errors else
                       "Usable, but check the warnings below")
            out.append(verdict)
            out.append("")
            for f in self.sorted():
                out.append(f"[{f.severity}] {f.title}")
                out.append(f"    what:  {f.detail}")
                out.append(f"    fix:   {f.fix}")
                out.append("")
        if self.facts:
            out.append("Font facts:")
            out += [f"  {x}" for x in self.facts]
        return "\n".join(out)

    # ---- the same report, addressed to whoever edits the font ----------- #
    def claude_prompt(self) -> str:
        """Every defect as a work order Sean can paste into a font-editing AI.

        .text() is written for Sean: what is wrong and roughly what to change.
        This is written for the editor: which glyph, by ID, moved how far, in
        font units, and an explicit list of what must not be touched — because
        the failure mode being designed out is not 'the AI did nothing', it is
        'the AI fixed the wrong glyph and improved three others on the way'.

        Plain text, no markdown, ASCII only: it gets pasted into a chat box.
        """
        return _build_prompt(self)


# --------------------------------------------------------------------------- #
#  saying it to the editor — one defect, one glyph, one number
# --------------------------------------------------------------------------- #
# Notes that describe the font rather than ask for a change. They belong in the
# prompt as background, never in the numbered list: an AI handed "this font is
# cut-only" as a task will helpfully add a colour table nobody asked for.
CONTEXT_CODES = {"no-glyph-names", "cut-only", "engine-note", "analysis-failed",
                 "join-scan-partial", "join-scan-failed", "no-xheight"}

_ASCII = {"→": "->", "—": " - ", "–": "-", "‘": "'",
          "’": "'", "“": '"', "”": '"', "·": "-",
          "…": "...", "×": "x", " ": " "}


def _plain(s: str) -> str:
    """The human report's typography flattened to ASCII.

    Applied only to prose quoted back out of a Finding, never to a family name
    or a glyph name — those have to be reproduced exactly, and a '?' in place of
    a letter of the family name would be an instruction to rename the font.
    """
    s = str(s)
    for k, v in _ASCII.items():
        s = s.replace(k, v)
    return s


def _next_filename(path: str) -> str:
    """'...-v19.ttf' -> '...-v20.ttf'.

    Sean versions every export. A repaired font that comes back under the name it
    left with is a font he cannot tell from the broken one, and the broken one is
    already installed.
    """
    try:
        stem, ext = os.path.splitext(os.path.basename(path))
        m = re.search(r"v(\d+)$", stem, re.I)
        if m:
            return f"{stem[:m.start(1)]}{int(m.group(1)) + 1}{ext}"
        return f"{stem}-fixed{ext}"
    except Exception:
        return ""


def _n(v) -> str:
    """A font-unit number. Font units are whole numbers in a real font, so
    printing 23.0000001 of them only invites someone to type it in."""
    try:
        v = float(v)
    except Exception:
        return str(v)
    return f"{v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}"


def _inch(v) -> str:
    try:
        return f"{v:.4f} in" if abs(v) < 0.01 else f"{v:.3f} in"
    except Exception:
        return "? in"


def _size(units, upem: int, scale: float | None = None) -> str:
    """One size, said twice on purpose.

    Font units are the instruction; the physical figure is there so the reader
    can smell a factor-of-700 mistake before making it.
    """
    try:
        if scale:
            return f"{_n(units)} font units ({_inch(units * scale)})"
        return f"{_n(units)} font units ({units / float(upem or 1000):.3f} em)"
    except Exception:
        return f"{_n(units)} font units"


def _pt(p) -> str:
    try:
        return f"({_n(p[0])}, {_n(p[1])})"
    except Exception:
        return "(?, ?)"


def _para(text, indent: str = "", first: str | None = None, width: int = 73) -> str:
    """Wrapped prose. 73 columns because a numbered item gets three more when it
    is placed in the list, and a chat box that soft-wraps a work order makes the
    coordinates in it hard to read back."""
    body = " ".join(str(text).split())
    return textwrap.fill(body, width=width,
                         initial_indent=(indent if first is None else first),
                         subsequent_indent=indent) if body else ""


def _named(role: dict) -> str:
    """A glyph as 'name (glyph ID n)'. Never the name on its own — in a post 3.0
    font the name is a placeholder and the ID is the only real handle."""
    g = role.get("glyph") or "?"
    gid = role.get("gid")
    return f"{g} (glyph ID {gid})" if gid is not None else f"{g} (glyph ID unknown)"


def _role_text(role: dict, example: str = "") -> str:
    bits = [_named(role)]
    ch = (role.get("char") or "").strip()
    if ch:
        bits.append(f"the form this font uses for '{ch}'"
                    + (f' in "{example}"' if example else ""))
    cp = role.get("codepoint")
    if cp is not None:
        bits.append(f"encoded at U+{cp:04X}")
    return ", ".join(bits)


def _group_junctions(junctions):
    """Junctions that are one and the same edit, collapsed into one.

    'tb', 'tba', 'tt' and 'tta' are four reports of a single fact: the exit
    stroke of glyph00176 stops short. Listed separately they invite four separate
    edits to the same stroke, and four 30-unit extensions of one stroke is a
    120-unit extension. Grouping on the glyph AND the point its ink stops at is
    what makes 'do this once' sayable.
    """
    groups, seen = [], {}
    for j in junctions:
        try:
            p = j.get("left_from") or (0, 0)
            key = (j.get("left", {}).get("glyph"), round(p[0]), round(p[1]))
        except Exception:
            key = (id(j),)
        if key in seen:
            seen[key].append(j)
        else:
            seen[key] = [j]
            groups.append(seen[key])
    return groups


def _junction_block(group: list, n: int, total: int, upem: int,
                    scale: float | None) -> str:
    """One stroke that stops short, as an edit with coordinates.

    The coordinates are the whole point. 'Extend the exit stroke' is what the
    human report already says and it is not enough — it does not say which
    stroke, in which glyph, or how far, so the edit lands somewhere plausible
    instead of somewhere correct. Every point here is in the coordinate system of
    the glyph being edited, which is the one on screen in the font editor.
    """
    # the farthest reach in the group leads: satisfying it satisfies the rest,
    # and it is one edit, so there is one number to hit
    js = sorted(group, key=lambda x: -float(x.get("need_units") or 0))
    j = js[0]
    left = j.get("left") or {}
    ex = j.get("example", "")
    tag = f"  ({chr(ord('a') + n - 1)}) " if n <= 26 else f"  ({n}) "
    body = " " * len(tag)
    gap = float(j.get("gap_units") or 0)

    def line(label, text):
        return _para(f"{label} {text}", indent=body + "  ", first=body)

    pairs = [f"{x.get('left', {}).get('glyph', '?')} -> "
             f"{x.get('right', {}).get('glyph', '?')}" for x in js]
    exes = ", ".join(f'"{x.get("example")}"' for x in js)
    head = (f"junction {pairs[0]} ({n} of {total}), produced by typing {exes}"
            if len(js) == 1 else
            f"junctions {', '.join(pairs)} ({n} of {total}) - all one edit, "
            f"produced by typing {exes}")
    out = [_para(head, indent=body, first=tag)]

    edit = _role_text(left, ex) + "."
    if left.get("alternate"):
        edit += (f" This is a contextual alternate, NOT the plain "
                 f"'{left.get('char')}' that the cmap points at "
                 f"({left.get('base')}, glyph ID {left.get('base_gid')}). "
                 f"Edit {left.get('glyph')}. Leave {left.get('base')} alone.")
    out.append(line("EDIT THIS GLYPH:", edit))

    reach = []
    for x in js:
        r = x.get("right") or {}
        bit = _role_text(r, x.get("example", ""))
        if r.get("alternate"):
            bit += (f" - itself a contextual alternate, not the plain "
                    f"'{r.get('char')}' ({r.get('base')}, glyph ID "
                    f"{r.get('base_gid')})")
        reach.append(bit)
    if len(reach) == 1:
        out.append(line("IT MUST REACH:", reach[0]
                        + ". Do not edit that glyph for this item."))
    else:
        # one per line: four of these run together in a paragraph is a sentence
        # nobody finishes reading, and the whole point is that it gets read
        out.append(line("IT MUST REACH:", f"all {len(reach)} of these, so reach "
                                          f"the farthest of them:"))
        for bit in reach:
            out.append(_para(bit, indent=body + "      ", first=body + "    - "))
        out.append(_para("Do not edit any of them for this item.",
                         indent=body + "  ", first=body + "  "))

    out.append(line("GAP NOW:",
                    f"{_size(gap, upem, scale)} of empty space between the ink "
                    f"of {left.get('glyph')} and the next glyph"
                    + (f" - the widest of the {len(js)} gaps in this group, so "
                       f"closing it closes them all." if len(js) > 1 else ".")))

    out.append(line("DO THIS:",
                    f"in {left.get('glyph')}'s own coordinates its ink stops at "
                    f"{_pt(j.get('left_from'))}, and the next glyph's ink begins "
                    f"at {_pt(j.get('left_contact'))} in those same coordinates. "
                    f"Carry that exit stroke on from where it ends, keeping its "
                    f"existing width and following the curve it is already on, "
                    f"until it passes {_pt(j.get('left_contact'))} and reaches at "
                    f"least {_pt(j.get('left_target'))} - "
                    f"{_size(j.get('need_units', 0), upem, scale)} of travel, "
                    f"leaving {_size(j.get('margin_units', 0), upem, scale)} of "
                    f"real overlap. Do it ONCE. Change nothing else in the glyph, "
                    f"and do not widen its advance to contain the longer stroke - "
                    f"the ink is supposed to hang past the advance, that is how "
                    f"the letters overlap."))

    # a gap wider than a stroke is not a short stroke, and saying so stops a
    # letter being distorted to span it
    if upem and gap > 0.05 * upem:
        alt = ((f" The narrower option below - drawing the missing entry stroke "
                f"on {j.get('right', {}).get('glyph')} - may be the truthful "
                f"fix.") if (j.get("right", {}).get("alternate")
                             and not left.get("alternate")) else
               (" Judge whether the honest fix is a new connecting stroke rather "
                "than a much longer existing one."))
        out.append(line("BEFORE YOU START:",
                        f"this gap is {gap / upem * 100:.0f}% of the em, which is "
                        f"wider than a stroke of this font. That means the "
                        f"connector is missing rather than short, and stretching "
                        f"one existing stroke that far will distort the letter."
                        + alt + " Say which you did."))

    right = j.get("right") or {}
    if len(js) == 1 and right.get("alternate") and not left.get("alternate"):
        out.append(line("IF YOU PREFER THE SMALLER CHANGE:",
                        f"{left.get('glyph')} is the default form of "
                        f"'{left.get('char')}' and is used in every word, so "
                        f"extending it lengthens that exit everywhere - harmless "
                        f"where the pair already joins, but wide. "
                        f"{right.get('glyph')} is only substituted in contexts "
                        f'like "{ex}", so you may instead extend ITS entry '
                        f"stroke backwards, in ITS own coordinates, from "
                        f"{_pt(j.get('right_from'))} past "
                        f"{_pt(j.get('right_contact'))} to at least "
                        f"{_pt(j.get('right_target'))}, the same "
                        f"{_size(j.get('need_units', 0), upem, scale)} of "
                        f"travel. Do one side or the other, never both."))
    elif left.get("alternate"):
        out.append(line("WHY THIS GLYPH:",
                        f"{left.get('glyph')} is only chosen in contexts like "
                        f'"{ex}", so editing it cannot disturb any other pair. '
                        f"That is exactly why the edit belongs here and not on "
                        f"the plain '{left.get('char')}'."))
    else:
        out.append(line("SCOPE:",
                        f"{left.get('glyph')} is the default form of its letter, "
                        f"so this pair is broken in every word that contains it "
                        f"and the edit is meant to affect all of them. No other "
                        f"glyph changes."))
    return "\n".join(x for x in out if x)


def _junction_section(junctions, extra, upem, scale) -> str:
    groups = _group_junctions(junctions or [])
    total = len(groups) + (1 if extra else 0)
    out = []
    for i, g in enumerate(groups, 1):
        out.append(_junction_block(g, i, total, upem, scale))
    if extra:
        out.append(_para(
            f"({chr(ord('a') + len(groups))}) The remaining junctions were not "
            f"measured in detail. Fix each the same way - type its example to see "
            f"it, then carry the left glyph's exit stroke past the next glyph's "
            f"ink by at least "
            f"{_size(overlap_margin(upem, scale), upem, scale)}: "
            + "; ".join(f'{a} (type "{b}")' for a, b in extra),
            indent="      ", first="  "))
    return "\n".join(out)


def _instruction(f: Finding, upem: int, scale: float | None = None) -> str:
    """One Finding as an order. Called by Finding.instruction()."""
    d = f.data or {}
    c = f.code
    upem = int(upem or 0) or 1000

    if c == "unreadable" or c == "load-failed":
        return _para(f"Do not edit anything yet. This file cannot be opened as a "
                     f"font at all: {_plain(f.detail)} Re-export it from the "
                     f"font editor as a plain TTF or OTF and check that what "
                     f"arrives is a font file and not a .zip, .woff or a "
                     f"truncated download.")

    if c == "no-outlines":
        return _para("Re-export this font with real outlines - a 'glyf' table "
                     "(TTF) or a 'CFF ' table (OTF). The file currently has "
                     "neither, so there are no shapes to cut. Do not add "
                     "outlines by hand; export the source the font was drawn in.")

    if c == "bad-upem":
        return _para(f"Set head.unitsPerEm to 1000 (it is currently "
                     f"{d.get('upem')}, which nothing can be measured against) "
                     f"and scale every glyph coordinate, every advance width and "
                     f"every vertical metric by the same factor, so the letters "
                     f"keep their exact proportions. This is the one item in "
                     f"this request that is allowed to change unitsPerEm.")

    if c == "no-cmap":
        return _para("Regenerate the Unicode character map: a format 4 Windows "
                     "Unicode BMP subtable (platform 3, encoding 1) mapping "
                     "U+0041-U+005A (A-Z), U+0061-U+007A (a-z), U+0020 space, "
                     "U+0027 apostrophe, U+002D hyphen and U+002E period to the "
                     "glyphs that already draw them. Map existing glyphs only - "
                     "do not draw, add, remove or reorder any glyph, because "
                     "reordering changes every glyph ID.")

    if c == "missing-letters":
        miss = d.get("missing") or ""
        cps = ("(" + ", ".join(f"U+{ord(ch):04X}" for ch in miss) + ") "
               if 0 < len(miss) <= 10 else "")
        return _para(f"Draw and encode the {len(miss)} letter(s) this font has "
                     f"no glyph for: {' '.join(miss)} {cps}"
                     f"Draw each to match the weight, slant, cap height and "
                     f"stroke ends of the letters already in the font, give it a "
                     f"sensible advance width, and map it to its own Unicode "
                     f"code point. APPEND the new glyphs to the END of the glyph "
                     f"order so that no existing glyph ID moves - the app "
                     f"addresses glyphs by ID.")

    if c in ("missing-extras", "missing-space"):
        miss = d.get("missing") or []
        short = {" ": "space", "'": "quotesingle", "-": "hyphen", ".": "period"}
        names = {" ": "space (U+0020)", "'": "quotesingle (U+0027)",
                 "-": "hyphen (U+002D)", ".": "period (U+002E)"}
        want = ", ".join(names.get(ch, repr(ch)) for ch in miss)
        ink = [ch for ch in miss if ch.strip()]
        txt = (f"Add and encode the missing character(s): {want}. Append them to "
               f"the END of the glyph order so no existing glyph ID moves.")
        if " " in miss:
            txt += (" The space glyph needs an advance width and no outline at "
                    "all.")
        if ink:
            # named, not 'the others': the reader should not have to work out
            # which of the characters above still needs drawing
            txt += (f" Draw {' and '.join(short.get(ch, repr(ch)) for ch in ink)} "
                    f"to match the font's weight, slant and height, and give "
                    f"{'it' if len(ink) == 1 else 'each'} a sensible advance "
                    f"width.")
            if d.get("joins"):
                txt += (f" This font cuts as one connected piece, so anything "
                        f"drawn here has to touch the letters on either side of "
                        f"it: draw it overlapping its neighbours by at least "
                        f"{_size(overlap_margin(upem, scale), upem, scale)} "
                        f"rather than floating clear, or a name like O'Brien "
                        f"cuts into loose pieces.")
        return _para(txt)

    if c == "empty-glyphs":
        gl = d.get("glyphs") or []
        who = ("; ".join(f"'{g.get('char')}' = {_named(g)}" for g in gl) or
               (d.get("letters") or ""))
        return _para(f"Draw the outlines for the glyph(s) that are encoded but "
                     f"empty: {who}. Each one has a cmap entry and an advance "
                     f"width but no contours at all, so it disappears out of a "
                     f"name without a word. Draw the letter inside its existing "
                     f"advance width, matching the rest of the font. Do not "
                     f"change the advance width and do not delete the glyph.")

    if c == "colr-version":
        return _para(f"Re-export the colour layers as COLR version 0. They are "
                     f"currently COLR v{d.get('version')}, and the engrave lines "
                     f"are read only from COLR v0 records - a base glyph with a "
                     f"list of layer glyphs, each carrying a CPAL palette index. "
                     f"Flatten anything v0 cannot express (gradients, "
                     f"transforms, blend modes) into plain layer glyphs first. "
                     f"Keep the same layer shapes and the same base glyphs; this "
                     f"is a change of container, not of artwork.")

    if c == "no-cpal":
        return _para("Add a CPAL table with one palette holding one entry per "
                     "colour index used by the COLR v0 layers. Set the entries "
                     "belonging to engrave layers to red (255, 0, 0, 255) and "
                     "the entries belonging to cut layers to black "
                     "(0, 0, 0, 255). A layer counts as engraving only when its "
                     "palette colour is not black, so with no palette at all "
                     "nothing can be told apart. Do not move or redraw any layer "
                     "geometry.")

    if c == "palette-all-black":
        pal = d.get("palette") or []
        listing = ("Current entries: "
                   + "; ".join(f"{i} = ({r}, {g}, {b}, {a})"
                               for i, (r, g, b, a) in enumerate(pal[:8]))
                   + ("; ..." if len(pal) > 8 else "") + ". ") if pal else ""
        return _para(f"Recolour the CPAL palette entries that belong to the "
                     f"engrave layers to red (255, 0, 0, 255). {listing}"
                     f"Every entry is black, and a layer is treated as engraving "
                     f"only when at least one of its R, G, B is 40 or more, so "
                     f"nothing is currently engraved. Change only the entries "
                     f"whose layers are the engrave lines; leave the cut layers "
                     f"black. Do not touch any outline, layer order or COLR "
                     f"record - this is four numbers per entry and nothing else.")

    if c == "no-xheight":
        x = d.get("x_units")
        got = (f"Measure it as {_size(x, upem, scale)}, the ink height of 'x' in "
               f"this font." if x else
               "Measure the ink height of 'x' in font units and use that.")
        return _para(f"Optional, and only if Sean asks for it: set "
                     f"OS/2.sxHeight. {got} Change nothing else in OS/2 - "
                     f"sCapHeight, the ascender and descender fields and the "
                     f"typo metrics all stay as they are.")

    if c == "build-failed":
        return _para(f"Do not change the font for this one. Building the name "
                     f"{d.get('name')!r} fails outright: {_plain(f.detail)} "
                     f"Report it with this font attached - it may be a bug in "
                     f"the app rather than a defect in the font, and guessing at "
                     f"a glyph edit here would change artwork that is not "
                     f"actually wrong.")

    if c == "not-connected":
        js, extra = d.get("junctions") or [], d.get("extra") or []
        head = _para(f"Make the name {d.get('name')!r} cut as one piece. It "
                     f"currently comes out as {d.get('pieces')} separate pieces "
                     f"that fall apart on the laser bed, because the letters "
                     f"below have no shared ink. Fix each junction "
                     f"independently.")
        return head + ("\n" + _junction_section(js, extra, upem, scale)
                       if js or extra else "")

    if c == "sub-kerf-holes":
        holes = d.get("holes") or []
        floor_u = d.get("floor_units")
        floor = (_size(floor_u, upem, scale) if floor_u is not None
                 else _inch(d.get("floor_in", KERF_IN)))
        out = [_para(f"Close the sliver opening(s) in the built name "
                     f"{d.get('name')!r}. An opening only cuts cleanly if the "
                     f"largest circle that fits inside it has a radius of at "
                     f"least {floor}; anything finer is thinner than the beam, "
                     f"so it burns through instead of cutting and gets no "
                     f"lead-in.")]
        for i, h in enumerate(holes, 1):
            walls = h.get("between") or []
            if len(walls) >= 2:
                where = ("it sits where " + " meets ".join(_named(w) for w in walls)
                         + "; that point is "
                         + ", ".join(f"{_pt(w.get('at'))} in "
                                     f"{w.get('glyph')}'s own coordinates"
                                     for w in walls))
            elif walls:
                where = (f"it is inside {_named(walls[0])}, at "
                         f"{_pt(walls[0].get('at'))} in that glyph's own "
                         f"coordinates")
            else:
                where = "the glyphs that form it could not be named"
            out.append(_para(
                f"opening {i} of {len(holes)}: the largest circle inside it has a "
                f"radius of {_size(h.get('radius_units', 0), upem, scale)}, and "
                f"{where}. Close it by pushing those glyphs' strokes into each "
                f"other until the opening disappears - preferred, because it also "
                f"makes the joint stronger - or open it out until that circle's "
                f"radius is over {floor}. Do not delete the contour that forms "
                f"it, and do not change either glyph anywhere else.",
                indent="      ", first=f"  ({chr(ord('a') + i - 1)}) "))
        return "\n".join(out)

    if c == "letter-gaps":
        js, extra = d.get("junctions") or [], d.get("extra") or []
        n = d.get("count", len(js) + len(extra))
        edits = len(_group_junctions(js)) + (1 if extra else 0)
        head = _para(f"Close the {n} letter junction(s) that leave a gap. Each "
                     f"one makes any name containing it cut as loose pieces "
                     f"instead of one plate. They come to {edits} separate "
                     f"edit(s) below, because several of these junctions are the "
                     f"same stroke stopping short. Do not touch a glyph that is "
                     f"not named here.")
        return head + ("\n" + _junction_section(js, extra, upem, scale)
                       if js or extra else "")

    # anything this function has not been taught: say the finding plainly rather
    # than inventing an edit for it.
    return _para(f"{_plain(f.title)}: {_plain(f.detail)} {_plain(f.fix)} "
                 f"(No font-unit measurement was recorded for this item - "
                 f"measure it in the font editor before changing anything.)")


def _scope_glyphs(rep: Report) -> list[str]:
    """Every glyph the numbered items actually name, once each.

    A count of glyphs allowed to differ is the cheapest check there is: Sean can
    diff the returned font and see straight away whether something else moved,
    and the editor is told the number it will be held to before it starts.
    """
    seen: dict[str, object] = {}
    for f in rep.findings:
        if f.severity not in (ERROR, WARNING):
            continue
        d = f.data or {}
        for j in d.get("junctions") or []:
            g = (j.get("left") or {})
            if g.get("glyph"):
                seen.setdefault(g["glyph"], g.get("gid"))
        for h in d.get("holes") or []:
            for w in h.get("between") or []:
                if w.get("glyph"):
                    seen.setdefault(w["glyph"], w.get("gid"))
        for g in d.get("glyphs") or []:
            if g.get("glyph"):
                seen.setdefault(g["glyph"], g.get("gid"))
    return [f"{k} (glyph ID {v})" if v is not None else str(k)
            for k, v in seen.items()]


def _dont_change(rep: Report) -> list[str]:
    """The list that stops the collateral damage.

    Built from the report, not fixed, because two items on it are legitimately
    up for change when a specific defect was found - promising 'unitsPerEm never
    changes' next to 'change unitsPerEm' is how a request gets ignored wholesale.
    """
    codes = {f.code for f in rep.findings}
    upem = rep.upem or 0
    keep = []
    if "bad-upem" not in codes:
        keep.append(f"unitsPerEm - it is {upem or 'whatever it is'} and it stays "
                    f"exactly that. Every number in this request assumes it.")
    keep.append("cap height, and OS/2 sCapHeight / sTypoAscender / "
                "sTypoDescender / hhea ascent and descent. Sean's app scales a "
                "name by cap height, so moving it silently resizes every "
                "nameplate ever cut from this font.")
    xh = rep.meta.get("sxheight")
    keep.append(f"x-height - OS/2 sxHeight"
                + (f" is {xh} and stays {xh}." if xh else " stays as it is."))
    keep.append("every glyph's advance width, left side bearing and right side "
                "bearing. Widening a glyph to contain a stroke you extended is "
                "exactly the wrong fix: in a joining font the ink is supposed to "
                "hang past the advance. Extend the ink, leave the advance.")
    keep.append("kerning, and any GPOS table. The gaps above are closed by "
                "drawing, not by moving letters closer together.")
    keep.append("the contextual alternate set and its feature rules - GSUB, "
                "calt, liga, rlig, ccmp. Do not add, remove, re-point or "
                "re-order a substitution, and do not make a substitution fire in "
                "a new context. Where a defect is in an alternate, edit that "
                "alternate's outline in place.")
    keep.append("the glyph order and therefore every glyph ID. Do not add, "
                "delete, merge or reorder glyphs"
                + (" except by appending the new glyphs named above to the very "
                   "end." if {"missing-letters", "missing-extras", "missing-space"} & codes
                   else ". The app addresses glyphs by ID.")
                + " Do not subset, do not remove unused glyphs, do not decompose "
                  "or recompose composites.")
    keep.append("the eyelet holes and their diameters, and every other existing "
                "counter or hole. If a glyph already has a hole in it, that hole "
                "keeps its size and position.")
    if rep.meta.get("colr") is not None and "colr-version" not in codes:
        keep.append("the COLR layers and the CPAL palette - the engrave lines "
                    "come from them and they are already correct.")
    keep.append("the family name and every other name-table record, the font "
                "version, the outline format, and hinting. No autohinting, no "
                "'clean up outlines', no rounding coordinates to the grid, no "
                "reinterpolation.")
    keep.append("every glyph that is not in the GLYPHS IN SCOPE list above. If "
                "you are unsure whether a glyph is in scope, it is not.")
    return keep


def _build_prompt(rep: Report) -> str:
    """Report.claude_prompt()'s body, kept out of the dataclass for room."""
    try:
        return _prompt_body(rep)
    except Exception as exc:
        # a font strange enough to break the renderer must not cost Sean the
        # findings, so fall back to the plainest possible restatement
        lines = [f"FONT REPAIR REQUEST - {os.path.basename(rep.path)}",
                 "",
                 _para(f"This request could not be fully measured "
                       f"({type(exc).__name__}: {exc}), so the defects are "
                       f"listed as they were found and no coordinates are "
                       f"given. Every size below is in font units, relative to "
                       f"unitsPerEm = {rep.upem or 'unknown'}. Measure in the "
                       f"font editor before changing anything."), ""]
        for i, f in enumerate(rep.sorted(), 1):
            lines.append(_para(f"{_plain(f.title)}. {_plain(f.detail)} "
                               f"{_plain(f.fix)}", indent="   ", first=f"{i}. "))
        return "\n".join(lines)


def _prompt_body(rep: Report) -> str:
    upem = int(rep.upem or 0) or 1000
    scale = rep.scale
    tasks = [f for f in rep.sorted() if f.severity in (ERROR, WARNING)]
    notes = [f for f in rep.sorted() if f.severity == NOTE]
    base = os.path.basename(rep.path)
    fmt = rep.meta.get("container") or "the format it already is"

    L = [f"FONT REPAIR REQUEST - {base}", ""]

    # A file that could not be opened has no font facts to state and no glyph to
    # name. Printing the usual work order around it would describe a font that
    # does not exist — invented unitsPerEm, invented tables — which is worse than
    # printing nothing.
    dead = [f for f in tasks if f.code in ("unreadable", "load-failed")]
    if dead:
        L.append(_para(f"There is nothing to edit yet. Sean's nameplate app "
                       f"cannot open {base} as a font at all, so it could not be "
                       f"measured and there is no instruction to give."))
        L.append("")
        for f in dead:
            L.append(_para(_plain(f.detail), indent="   "))
        L.append("")
        L.append(_para("Re-export it from the font editor as a plain TTF or OTF "
                       "and check that what arrives is a font file, not a .zip, "
                       "a .woff or a truncated download. Do not attempt any "
                       "repair on this file.", indent="   "))
        return "\n".join(L)

    if not tasks:
        L.append(_para(
            f"No repair needed. Sean's nameplate app checked this font "
            f"({rep.family or base}) and found no errors and no warnings, so "
            f"there is nothing to change and no edit to make. Please do not "
            f"modify this font."))
        if notes:
            L += ["", "For information only - these are not defects and are not "
                      "tasks:"]
            for f in notes:
                L.append(_para(f"{_plain(f.title)}: {_plain(f.detail)}",
                               indent="     ", first="   - "))
        return "\n".join(L)

    # ---- who the font is ---------------------------------------------- #
    L.append(_para(f"You are editing the font file {base}. Make the numbered "
                   f"changes below and nothing else. This font is used to laser "
                   f"cut names out of sheet metal, so a letter that does not "
                   f"physically touch the next one becomes a piece of metal on "
                   f"the floor."))
    L += ["", "THE FONT"]
    L.append(f"  file                {base}")
    L.append(f"  family (name ID 4)  {rep.family or '(none set)'}")
    L.append(f"  unitsPerEm          {upem}")
    L.append(_para(rep.meta.get("outline") or "unknown", indent=" " * 22,
                   first="  outlines            "))
    post = rep.meta.get("post")
    if post == 3.0:
        L.append(_para("post table format 3.0 - this font stores NO glyph "
                       "names. Names like glyph00174 below are placeholders "
                       "generated from the glyph order, so look every glyph up "
                       "by its glyph ID, which is the number in the name and is "
                       "given explicitly each time.",
                       indent=" " * 22, first="  glyph names         "))
    elif post is None:
        L.append("  glyph names         no readable post table - refer to every "
                 "glyph by its glyph ID")
    else:
        L.append(f"  glyph names         post table format {post}, "
                 f"names are real")
    colr, cpal = rep.meta.get("colr"), rep.meta.get("cpal", 0)
    L.append(_para((f"COLR v{colr}, {cpal} CPAL palette(s) - the engrave lines "
                    f"come from these" if colr is not None else
                    "no COLR table, no CPAL - this is a cut-only font"),
                   indent=" " * 22, first="  colour layers       "))
    L.append(f"  glyph count         {rep.meta.get('glyphs', '?')}")
    # which features are on decides which alternates are chosen, and every
    # alternate named below was chosen under exactly these
    try:
        from nameplate_core import DEFAULT_FEATURES
        feats = ", ".join(sorted(k for k, v in DEFAULT_FEATURES.items() if v))
    except Exception:
        feats = "calt, kern, liga, rlig"
    L.append(_para(f"the app shapes text with {feats} switched on, which is what "
                   f"picks the contextual alternates named below",
                   indent=" " * 22, first="  shaping             "))

    # ---- the units mistake this whole block exists to prevent ---------- #
    L += ["", "SIZES ARE IN FONT UNITS - READ THIS BEFORE MEASURING ANYTHING"]
    L.append(_para(f"Every size in this request is in FONT UNITS, relative to "
                   f"unitsPerEm = {upem}. Work in font units. A font editor "
                   f"measures in font units and Sean's app measures in inches "
                   f"because it cuts metal, and every earlier attempt at these "
                   f"fixes went wrong at that boundary - an inch number treated "
                   f"as a font-unit number is roughly {int(1 / scale) if scale else 700} "
                   f"times too small, which looks like nothing happened at all.",
                   indent="  "))
    if scale:
        L.append(_para(f"So each size is given twice: font units first, then the "
                       f"same size in inches in brackets. The inch figures use "
                       f"the size the font was checked at, "
                       f"{rep.meta.get('basis') or '1.000 in cap height'}, where "
                       f"1 font unit = {scale:.6f} in ({scale * 25.4:.4f} mm) and "
                       f"1 in = {_n(1 / scale)} font units. Only the font-unit "
                       f"numbers are the instruction; the inch numbers are there "
                       f"to be sanity-checked.", indent="  "))
        L.append(_para(f"A plate cut larger than that makes every font unit "
                       f"physically bigger, so an overlap stated in font units "
                       f"holds at every larger size. That is the other reason "
                       f"the instruction is in font units and not in inches.",
                       indent="  "))
    else:
        L.append(_para("No name could be built from this font, so there is no "
                       "inch conversion to give. Sizes are in font units and in "
                       "fractions of the em only.", indent="  "))

    # ---- the work ------------------------------------------------------ #
    L += ["", f"WHAT TO CHANGE - {len(tasks)} "
              f"{'item' if len(tasks) == 1 else 'items'}, and nothing else", ""]
    for i, f in enumerate(tasks, 1):
        body = f.instruction(upem, scale)
        lines = body.splitlines() or [""]
        head = f"{i}. {lines[0].lstrip()}"
        L.append("\n".join([head] + ["   " + ln if ln.strip() else ""
                                     for ln in lines[1:]]))
        L.append("")

    # ---- the checksum, next to the work it counts ---------------------- #
    scope = _scope_glyphs(rep)
    codes = {f.code for f in rep.findings}
    L += [f"GLYPHS IN SCOPE - {len(scope)} existing glyph(s), and no others"
          if scope else "GLYPHS IN SCOPE - no existing glyph may change", ""]
    L.append(_para(("; ".join(scope) + ".") if scope else
                   "None. No glyph already in this font may come back different.",
                   indent="   "))
    extra_scope = []
    if {"missing-letters", "missing-extras", "missing-space"} & codes:
        extra_scope.append("the new glyphs appended for the missing characters "
                           "named above")
    if {"letter-gaps", "not-connected"} & codes:
        extra_scope.append("where an item offers a choice of which side to edit, "
                           "the partner glyph that item names - one side or the "
                           "other, never both")
    if any((f.data or {}).get("extra") for f in rep.findings):
        extra_scope.append("the left-hand glyph of each junction in the "
                           "un-measured list above")
    if extra_scope:
        L.append(_para("Also in scope: " + "; ".join(extra_scope) + ".",
                       indent="   "))
    L.append(_para("Every other glyph in the font must come back byte for byte "
                   "identical.", indent="   "))
    L.append("")

    # ---- what the notes are, so they are not mistaken for work --------- #
    if notes:
        L += ["BACKGROUND, NOT TASKS - do not change anything for these", ""]
        said = set()
        for f in notes:
            # 'ADAM' and 'Adam' produce the same engine note twice; repeating it
            # only makes the list look longer than the work
            body = _plain(f.detail)
            if body in said:
                continue
            said.add(body)
            L.append(_para(f"{_plain(f.title)}: {body}",
                           indent="     ", first="   - "))
        L.append("")

    # ---- the fence ----------------------------------------------------- #
    L += ["DO NOT CHANGE - anything here that moves is a defect you introduced",
          ""]
    for item in _dont_change(rep):
        L.append(_para(item, indent="     ", first="   - "))
    L.append("")

    # ---- what comes back ----------------------------------------------- #
    L += ["WHAT TO SEND BACK", ""]
    newname = rep.meta.get("next_name") or "with a new version suffix"
    back = [
        (f"Re-export the edited font as {fmt} - the same format it arrived in - "
         f"with the family name still exactly {rep.family or '(unchanged)'}, "
         f"unitsPerEm still {upem}, and the same glyph inventory in the same "
         f"order"
         + (", plus the new glyphs appended at the end."
            if {"missing-letters", "missing-extras", "missing-space"} & codes else ".")),
        f"Name the file {newname} so it cannot be confused with {base}.",
        ("List what you changed: for each glyph, its name and glyph ID, which "
         "contour and which points moved, and the before and after coordinates "
         "in font units. One line per glyph."),
    ]
    if {"letter-gaps", "not-connected"} & codes:
        # a pass condition that can be tested rather than eyeballed
        back.append("For every junction you closed, check it: set the two glyphs "
                    "side by side at their existing advance widths and confirm "
                    "the outlines genuinely overlap rather than touch - the union "
                    "of the two shapes has to be one closed region, not two "
                    "regions meeting at a point. Say that you checked it.")
    back.append("State how many glyphs you edited and confirm it matches that "
                "list and the GLYPHS IN SCOPE count above. If you changed "
                "anything that was not asked for, say so plainly rather than "
                "leaving it to be found on the laser bed.")
    back.append("If any instruction here cannot be carried out as written, stop "
                "and say which one and why. Do not substitute a different fix.")
    for i, item in enumerate(back, 1):
        L.append(_para(item, indent="      ", first=f"   {i}. "))
    return "\n".join(L)


def prompt_for_font(path: str, join_scan_budget: float = 25.0) -> str:
    """check_font() plus claude_prompt(), for callers that only want the text."""
    return check_font(path, join_scan_budget=join_scan_budget).claude_prompt()


def check_font(path: str, names=("ADAM", "Adam"),
               join_scan_budget: float = 25.0) -> Report:
    """Inspect one font. join_scan_budget seconds are spent testing letter
    pairs for gaps; pass 0 to skip that scan."""
    rep = Report(path=path)

    # ---- can it be opened at all? ------------------------------------- #
    try:
        from fontTools.ttLib import TTFont
        tt = TTFont(path, fontNumber=0)
    except Exception as exc:
        rep.add(ERROR, "unreadable", "This file is not a usable font",
                f"It could not be parsed as a TrueType/OpenType font "
                f"({type(exc).__name__}: {exc}).",
                "Confirm it is a .ttf or .otf and not a .zip, .woff or a "
                "damaged download. Re-export it from the font editor.")
        return rep

    try:
        from nameplate_core import Font, build_document
        font = Font(path)
        rep.family = font.family
    except Exception as exc:
        rep.add(ERROR, "load-failed", "The font loaded but the app cannot use it",
                f"{type(exc).__name__}: {exc}",
                "Re-export the font from the font editor; if it still fails, "
                "send this font and this report on.")
        return rep

    rep.facts.append(f"units per em: {font.upem}")
    rep.facts.append(f"glyphs: {len(font.glyphset)}")
    # the same numbers again, structured, so claude_prompt() can identify the
    # font without re-reading it
    try:
        rep.upem = int(font.upem or 0)
        rep.meta["glyphs"] = len(font.glyphset)
        rep.meta["next_name"] = _next_filename(path)
    except Exception:
        pass

    # ---- outlines present? -------------------------------------------- #
    try:
        has_glyf = "glyf" in tt
        has_cff = ("CFF " in tt) or ("CFF2" in tt)
        rep.facts.append(f"outline format: "
                         f"{'TrueType (glyf)' if has_glyf else ''}"
                         f"{'PostScript (CFF)' if has_cff else ''}"
                         f"{'NONE' if not (has_glyf or has_cff) else ''}")
        rep.meta["outline"] = ("TrueType 'glyf' outlines" if has_glyf else
                               "PostScript 'CFF ' outlines" if has_cff else
                               "NO outline table at all")
        rep.meta["container"] = ("a TTF with 'glyf' outlines" if has_glyf else
                                 "an OTF with 'CFF ' outlines" if has_cff else
                                 "a normal TTF or OTF")
        if not (has_glyf or has_cff):
            rep.add(ERROR, "no-outlines", "The font contains no outlines",
                    "There is neither a 'glyf' nor a 'CFF ' table, so there are "
                    "no shapes to cut.",
                    "Re-export as a normal TTF or OTF. A bitmap-only or "
                    "metrics-only font cannot be used.")
    except Exception:
        pass

    # ---- units per em ------------------------------------------------- #
    try:
        if not font.upem or font.upem <= 0:
            rep.add(ERROR, "bad-upem", "The font's em size is invalid",
                    f"unitsPerEm is {font.upem}. Every measurement is scaled "
                    f"from it, so nothing can be sized.",
                    "Set unitsPerEm in the font's head table to a normal value "
                    "(1000 for OTF, 1024 or 2048 for TTF).",
                    {"upem": font.upem})
    except Exception:
        pass

    # ---- cmap: can letters be looked up? ------------------------------ #
    try:
        if not font.cmap:
            rep.add(ERROR, "no-cmap", "The font has no usable character map",
                    "There is no Unicode cmap, so typed letters cannot be "
                    "matched to any glyph.",
                    "In the font editor, regenerate the Unicode cmap "
                    "(a Windows Unicode BMP subtable, platform 3 encoding 1).")
        else:
            missing = [c for c in LETTERS if ord(c) not in font.cmap]
            if missing:
                rep.add(ERROR if len(missing) > 26 else WARNING,
                        "missing-letters", "Some letters are missing",
                        f"{len(missing)} of 52 letters have no glyph: "
                        f"{''.join(missing)}. Any name using them cannot be "
                        f"built.",
                        "Draw or map the missing letters, then re-export. If "
                        "the font is intentionally caps-only, avoid lowercase "
                        "names with it.",
                        {"missing": "".join(missing)})
            miss_extra = [c for c in EXTRAS if ord(c) not in font.cmap]
            if miss_extra:
                # A missing SPACE is a real problem — two-word names run
                # together. Missing apostrophe/hyphen/period is not: these
                # display fonts are drawn for single names and are not expected
                # to carry punctuation, so it is reported as a fact, not a
                # warning, and never reaches the amber panel.
                punct = [c for c in miss_extra if c != " "]
                if " " in miss_extra:
                    rep.add(WARNING, "missing-space",
                            "The space glyph is missing",
                            "There is no space (U+0020) in the font, so a "
                            "two-word name like Mary Jane will run together.",
                            "Add a space glyph with an advance width and no "
                            "outline.",
                            {"missing": [" "]})
                if punct:
                    # Recorded as a fact, deliberately NOT as a finding: these
                    # are display fonts drawn for single names and are not
                    # expected to carry punctuation. Raising it would put a
                    # warning on nearly every font and would tell the font
                    # editor to draw glyphs nobody wants.
                    rep.facts.append(
                        "no punctuation glyphs (expected): "
                        + " ".join(repr(c) for c in punct))
    except Exception:
        pass

    # ---- glyph names (the gid131 crash) ------------------------------- #
    try:
        fmt = getattr(tt["post"], "formatType", None) if "post" in tt else None
        rep.facts.append(f"post table format: {fmt}")
        rep.meta["post"] = fmt
        if fmt == 3.0:
            rep.add(NOTE, "no-glyph-names",
                    "The font carries no glyph names",
                    "Its post table is format 3.0, so glyphs have no names and "
                    "tools refer to them as glyph00131 or gid131. The app "
                    "handles this by using glyph IDs, but font editors will "
                    "show unhelpful names.",
                    "Nothing required. To get readable names, re-export with "
                    "post format 2.0 ('keep glyph names' in most editors).")
    except Exception:
        pass

    # ---- letters that exist but are empty ----------------------------- #
    try:
        empty = []
        blanks = []
        for c in LETTERS:
            g = font.cmap.get(ord(c))
            if not g:
                continue
            try:
                if not font.contours(g):
                    empty.append(c)
                    blanks.append({"glyph": g, "gid": _gid(font, g), "char": c})
            except Exception:
                empty.append(c)
                blanks.append({"glyph": g, "gid": _gid(font, g), "char": c})
        if empty:
            rep.add(ERROR, "empty-glyphs", "Some letters have no outline",
                    f"These letters exist in the font but draw nothing: "
                    f"{''.join(empty)}. They would silently vanish from a name.",
                    "Open each one in the font editor and draw its outline, or "
                    "remove the empty glyph so a fallback is used.",
                    {"letters": "".join(empty), "glyphs": blanks[:20]})
    except Exception:
        pass

    # ---- engrave layers (COLR / CPAL) --------------------------------- #
    try:
        colr_ver = getattr(tt["COLR"], "version", None) if "COLR" in tt else None
        rep.facts.append(f"COLR: {'v' + str(colr_ver) if colr_ver is not None else 'none'}"
                         f"  CPAL palettes: {len(font.palette)}")
        rep.meta["colr"] = colr_ver
        rep.meta["cpal"] = len(font.palette)
        if colr_ver is not None and colr_ver != 0:
            rep.add(ERROR, "colr-version",
                    "Engrave lines cannot be read from this font",
                    f"Its colour table is COLR v{colr_ver}. The engrave lines "
                    f"are found by reading COLR v0 layers, so no engraving will "
                    f"be produced.",
                    "Re-export the colour layers as COLR v0 (the simple "
                    "layer-plus-palette format), or export cut-only.",
                    {"version": colr_ver})
        elif colr_ver == 0 and not font.palette:
            rep.add(ERROR, "no-cpal",
                    "Colour layers exist but there is no palette",
                    "The font has COLR v0 layers but no CPAL palette, so there "
                    "is no way to tell an engrave layer from a cut layer.",
                    "Add a CPAL palette and give the engrave layers a "
                    "non-black colour (red is the convention).")
        elif colr_ver == 0 and font.palette:
            non_black = [c for i, c in enumerate(font.palette)
                         if font.is_engrave_layer(i)]
            if not non_black:
                rep.add(WARNING, "palette-all-black",
                        "Every colour layer is black",
                        "A layer counts as engraving only when its palette "
                        "colour is not black. All entries here are black, so "
                        "nothing will be treated as an engrave line.",
                        "Recolour the engrave layers in the CPAL palette to a "
                        "non-black colour, red by convention.",
                        {"palette": [tuple(c) for c in font.palette[:16]]})
        elif colr_ver is None:
            # Cut-only is the normal, expected case: most of these fonts carry
            # no engraving at all. A fact, never a finding.
            rep.facts.append("cut-only font (no COLR table, so no engrave "
                             "lines) - normal, the outline still cuts")
    except Exception:
        pass

    # ---- height references -------------------------------------------- #
    try:
        sx = getattr(tt["OS/2"], "sxHeight", 0) if "OS/2" in tt else 0
        rep.facts.append(f"OS/2 sxHeight: {sx or 'missing'}")
        rep.meta["sxheight"] = sx or None
        if not sx:
            # measure what the value should be, so the instruction can name a
            # number instead of asking the editor to guess one
            x_units = None
            try:
                gx = font.cmap.get(ord("x"))
                ys = [p[1] for c in font.contours(gx) for p in c] if gx else []
                x_units = (max(ys) - min(ys)) if ys else None
            except Exception:
                x_units = None
            rep.add(NOTE, "no-xheight", "The font declares no x-height",
                    "Measuring by x-height falls back to measuring the letter "
                    "'x', or the whole artwork if there is no 'x'.",
                    "Set sxHeight in the OS/2 table if you rely on the "
                    "x-height option.",
                    {"x_units": x_units})
    except Exception:
        pass

    # ---- does it actually build, and is the result one piece? --------- #
    rep.facts.append(
        "test names used to probe this font: "
        + ", ".join(repr(n) for n in names)
        + " - samples the checker shapes to exercise capitals and lowercase, "
          "nothing to do with what you will type")
    for name in names:
        try:
            doc = build_document(font, name, 1.0, "in", "cap")
        except Exception as exc:
            rep.add(ERROR, "build-failed",
                    f"Building the test name {name!r} fails",
                    f"{type(exc).__name__}: {exc}",
                    "This is the defect to report. Send this font and this "
                    "report on — it may be an app fix rather than a font fix.",
                    {"name": name, "exc": f"{type(exc).__name__}: {exc}"})
            continue

        # what one font unit is worth in inches, taken from the first name that
        # builds. Every physical figure in the prompt is stated at this size.
        if rep.scale is None:
            try:
                rep.scale = float(doc.scale)
                rep.meta["basis"] = (f"{doc.target_height:.3f} {doc.unit} "
                                     f"{doc.basis} height")
            except Exception:
                pass

        try:
            import nameplate_leadin as LI
            rings = LI._rings(doc)
            polys, depths, material = LI._analyse(rings)
            outers = [p for p, d in zip(polys, depths) if d % 2 == 0]
            holes = [p for p, d in zip(polys, depths) if d % 2 == 1]
            w, h = doc.size()
            # Say TEST NAME. These are samples the checker shapes to exercise
            # capitals and lowercase; read bare, a line beginning 'ADAM': made
            # every font look as though it were called ADAM.
            rep.facts.append(f"test name {name!r} at 1.000 in cap height: "
                             f"{w:.3f} x {h:.3f} in, "
                             f"{len(outers)} piece(s), {len(holes)} hole(s), "
                             f"{len(doc.engrave_paths)} engrave line(s)")

            if len(outers) == 1 and len(name) > 1:
                # the letters of this name overlap into one plate, which means
                # this is a joining font — punctuation advice depends on it
                rep.meta["joins"] = True

            if len(outers) > 1:
                gaps = name_gaps(font, name)
                where = (describe_gaps(gaps, font.upem, doc.scale) if gaps
                         else "could not localise the break")
                rep.add(WARNING, "not-connected",
                        f"the test name {name!r} does not cut as one piece",
                        f"The letters do not all overlap, so the artwork is "
                        f"{len(outers)} separate pieces that will fall apart on "
                        f"the laser bed. The break is between: {where}.",
                        "Extend the exit stroke of the left letter (or the "
                        "entry stroke of the right one) until they overlap, or "
                        "tighten that pair's kerning. A hairline touch is not "
                        "enough — they must genuinely cross.",
                        {"name": name, "pieces": len(outers),
                         "junctions": junction_details(font, name, doc.scale)})

            # holes too fine to cut, and slivers where letters nearly touch
            floor = LI.hard_clearance("in")
            fine = [p for p in holes if LI._inradius(p) * doc.scale < floor]
            if fine:
                # the same measurement the test just made, kept in font units:
                # an instruction that says '0.004 in' to someone working in font
                # units is the exact mix-up this module is trying to end
                hole_data = []
                for p in fine[:6]:
                    r = LI._inradius(p)
                    hole_data.append({"radius_units": r,
                                      "radius_in": r * doc.scale,
                                      "between": _hole_neighbours(font, name, p)})
                rep.add(WARNING, "sub-kerf-holes",
                        f"{name!r} has {len(fine)} opening(s) finer than the kerf",
                        f"{len(fine)} hole(s) are narrower than {floor:g} in. "
                        f"The laser cannot cut them cleanly and they get no "
                        f"lead-in. They usually appear where two letters almost "
                        f"touch.",
                        "Either overlap those letters properly so the sliver "
                        "closes, or separate them enough to leave a real hole.",
                        {"name": name, "floor_in": floor,
                         "floor_units": floor / doc.scale if doc.scale else None,
                         "holes": hole_data})

            for wmsg in doc.warnings:
                if "no engrave lines" in wmsg.lower():
                    # Cut-only is the normal case for these fonts. Raising it
                    # per test name put "This font has no engrave lines" into
                    # the repair prompt twice, as though it were work to do.
                    continue
                rep.add(NOTE, "engine-note",
                        f"engine note while building the test name {name!r}",
                        wmsg, "Informational — see the message.")
        except Exception as exc:
            rep.add(WARNING, "analysis-failed",
                    f"Could not fully analyse {name!r}",
                    f"{type(exc).__name__}: {exc}",
                    "The name still builds; only this extra check failed.")

    # ---- caps-only / unicase: lowercase draws the capital -------------- #
    # Sean hit this and reasonably read it as an app bug: the letter-pair sheet's
    # lowercase rows drew capitals. They were capitals -- the font maps every
    # lowercase codepoint to the same glyph as its capital. Saying so once, here,
    # saves the question being asked of the sheet.
    try:
        low = "abcdefghijklmnopqrstuvwxyz"
        pairs = [(c, font.cmap.get(ord(c)), font.cmap.get(ord(c.upper())))
                 for c in low]
        have = [p for p in pairs if p[1] and p[2]]
        same = [p[0] for p in have if p[1] == p[2]]
        if have and len(same) == len(have):
            rep.add(NOTE, "caps-only",
                    "This font is caps-only: lowercase draws the capitals",
                    "Every lowercase character maps to the same glyph as its "
                    "capital, so 'adam' and 'ADAM' cut identically. Nothing is "
                    "wrong with the font; it simply has no separate lowercase.",
                    "Nothing required. Expect the letter-pair sheet's lowercase "
                    "rows to show capitals, because that is what they are.")
            rep.facts.append("caps-only font: all 26 lowercase map to the "
                             "capital glyphs")
        elif same:
            rep.facts.append(
                f"{len(same)} of {len(have)} lowercase letters map to their "
                f"capital's glyph: {''.join(same)}")
    except Exception:
        pass

    # ---- counters wound the wrong way: the letter cuts SOLID ----------- #
    try:
        wrong = winding_check(font)
        if wrong:
            worst = ", ".join(
                f"{w['glyph']} (loses {w['lost']} of {w['parity_holes']})"
                for w in wrong[:8])
            rep.add(ERROR, "wrong-winding",
                    "Some counters are wound the wrong way, so those letters "
                    "cut as solid metal",
                    f"{len(wrong)} glyph(s) have a counter drawn in the SAME "
                    f"direction as the outline around it. Every measurement in "
                    f"this app treats a nested ring as a hole, but the cut path "
                    f"is built with a winding union, and a same-direction ring "
                    f"cancels instead of cutting. The hole is in the drawing and "
                    f"will not be in the metal: {worst}.",
                    "In the font editor, reverse the direction of each counter "
                    "so it runs opposite to the contour containing it (most "
                    "editors call this 'correct path direction' or 'set PS/TT "
                    "winding'). Do not move any points -- only the direction "
                    "changes.",
                    {"glyphs": wrong})
        rep.facts.append(f"winding check: {len(wrong)} glyph(s) whose counters "
                         f"would cancel in the cut")
    except Exception:
        pass

    # ---- which letter PAIRS fail to join, across the whole alphabet ---- #
    if join_scan_budget > 0:
        try:
            failures, tested, truncated, total = join_scan(font, join_scan_budget)
            rep.facts.append(
                f"letter-join scan: {tested} of {total} combinations tested"
                + (" (time limit reached)" if truncated else "")
                + f", {len(failures)} junction(s) disconnected")
            if failures:
                items = sorted(failures.items(), key=lambda kv: kv[1])
                shown = "; ".join(f"{junction} (type {ex!r})"
                                  for junction, ex in items[:10])
                more = (f" …and {len(items) - 10} more"
                        if len(items) > 10 else "")
                rep.add(WARNING, "letter-gaps",
                        f"{len(failures)} letter junction(s) do not join",
                        f"Each of these leaves a gap, so a name containing it "
                        f"cuts as loose pieces instead of one plate: "
                        f"{shown}{more}. Type the example next to a junction to "
                        f"see it in the preview.",
                        "Extend the left glyph's exit stroke until it crosses "
                        "into the next letter. Note some junctions only appear "
                        "mid-word because the font swaps in a contextual form — "
                        "'go' can be fine while 'ego' is not, so fix the form "
                        "the example actually uses.",
                        {"count": len(failures),
                         "junctions": _junctions_for(font, items[:JUNCTION_DETAIL],
                                                     rep.scale),
                         "extra": [(_plain(j), ex)
                                   for j, ex in items[JUNCTION_DETAIL:]]})
            if truncated:
                rep.add(NOTE, "join-scan-partial",
                        "Letter-join scan did not finish",
                        f"Only {tested} of {total} letter combinations were "
                        f"tested before the time limit. Untested combinations "
                        f"are not a pass.",
                        "The definitive check is the name itself: if a name "
                        "cannot cut as one piece the preview names the junction.")
        except Exception as exc:
            rep.add(NOTE, "join-scan-failed", "Letter-join scan did not run",
                    f"{type(exc).__name__}: {exc}",
                    "Other checks are unaffected.")

    # Whether the font's letters join is only known after a name is built, and it
    # changes what has to be said about missing punctuation — an apostrophe that
    # floats clear of its neighbours cuts as a loose piece in a joining font.
    if rep.meta.get("joins"):
        for f in rep.findings:
            if f.code in ("missing-extras", "missing-space"):
                f.data["joins"] = True

    return rep


def _emit(text: str) -> None:
    """print() that survives a legacy console code page.

    The human report can carry a '→' out of describe_gaps, and a Windows console
    running cp1252 raises UnicodeEncodeError on it — which used to throw away a
    finished report at the last step. Characters the console cannot show are
    replaced; where the console can show them, the output is byte for byte what
    it always was.
    """
    try:
        print(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        sys.stdout.write(text.encode(enc, "replace").decode(enc, "replace") + "\n")


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    want_prompt = False
    budget = 25.0
    paths = []
    for a in args:
        if a in ("--prompt", "-p"):
            want_prompt = True
        elif a == "--no-join-scan":
            # the letter-pair scan is the slow part by a wide margin; skipping it
            # keeps the per-name checks, and says so rather than passing silently
            budget = 0.0
        elif a.startswith("--budget="):
            try:
                budget = max(0.0, float(a.split("=", 1)[1]))
            except ValueError:
                _emit(f"--budget wants a number of seconds, not {a!r}")
                return 2
        elif a.startswith("-"):
            _emit(f"unknown option {a!r}")
            _emit(__doc__)
            return 2
        else:
            paths.append(a)

    if not paths:
        _emit(__doc__)
        return 2

    worst = 0
    for path in paths:
        rep = check_font(path, join_scan_budget=budget)
        if want_prompt:
            # nothing but the block, so it can be piped straight to the clipboard
            _emit(rep.claude_prompt())
            _emit("")
        else:
            _emit("=" * 78)
            _emit(rep.text())
            _emit("")
        worst = max(worst, 1 if rep.errors else 0)
    return worst


if __name__ == "__main__":
    sys.exit(main())

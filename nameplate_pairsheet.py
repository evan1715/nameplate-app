"""
nameplate_pairsheet.py — eyeball every two-letter join a font can make.

WHY THIS EXISTS
    A nameplate is cut out of one piece of metal. The engine unions all the
    letters of a name into a single closed path, so the name only survives the
    laser if every neighbouring pair of letters actually overlaps. Where two
    letters merely come close, the union leaves two islands and that part of the
    name drops out of the sheet as a loose letter.

    Whether a font joins is a property of PAIRS, not of letters, and there are
    676 pairs per alphabet case — far too many to check by typing names. This
    module tests all of them geometrically and then draws them so Sean can look
    at the ones the test is unsure about with his own eyes.

WHY THE PICTURE IS FILLED, NOT THE APP'S CUT VIEW
    The app draws hairline outlines because that is what the laser needs. A
    hairline outline of two letters that miss by 3 units looks identical to two
    letters that overlap by 3 units — the give-away (ink continuing through the
    join) is only visible when the glyphs are filled solid, the way a normal
    type specimen shows them. So the sheet renders the RAW font: solid black on
    white, the font's own contextual shaping, nothing the app does to it.

WHY THE GLYPHS ARE DRAWN FROM OUTLINES AND NEVER WITH A TEXT API
    DO NOT "optimise" the cell drawing into QPainter.drawText / QFont /
    QRawFont / QStaticText. Every one of those goes through the system text
    rasteriser, which hints and grid-fits the outlines, can gamma-tune the
    coverage, can synthesise a bold or an italic, and can silently substitute a
    different installed font entirely. All of that moves and reshapes the very
    edges being judged here — an installed-font preview is exactly what has
    misrepresented these fonts before.

    The cells are filled from Font.contours() / the same outline data
    Font.filled() measures, which is the raw curve data with no hinting and no
    gridfitting: what Illustrator shows after "create outlines", and what the
    laser actually cuts. QPainter.drawText appears in this module ONLY for the
    titles and the little cell captions, which are set in the system UI font,
    never in the font under test.

WHAT IT PRODUCES
    analyse_pairs()  a PairReport: per pair, the shaped glyph names, whether the
                     ink touches, and if not, the gap in font units and ems.
                     Bounded by a wall clock budget, and pairs it never reached
                     are reported as UNTESTED, never as passes.
    render_sheet()   contact-sheet PNGs, one grid per group, problem cells ringed
                     in red with the measured gap printed on them.
    claude_prompt()  the failures rewritten as a paste-ready instruction for an
                     AI that edits the font, grouped by the LEFT letter because
                     one exit stroke usually explains a whole row of failures.

    python nameplate_pairsheet.py <font> [--out DIR] [--groups ...] [--prompt]

The only thing this module borrows from the engine is Font and shape(), so the
sheet reflects the same shaping the real cut file gets.
"""

from __future__ import annotations

import argparse
import math
import os
import string
import sys
import time
from dataclasses import dataclass, field

from shapely.affinity import translate

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import (QColor, QFont, QFontDatabase, QGuiApplication, QImage,
                           QPainter, QPainterPath, QPen)

from nameplate_core import Font, shape

# --------------------------------------------------------------------------- #
#  what gets tested
# --------------------------------------------------------------------------- #
#  (key, human label, left characters, right characters, where in the word)
#
# WHERE IN THE WORD MATTERS, and it is not a nicety. These fonts swap in
# different glyphs by position: shaping 'ab' gives A.ini + B.e0 — an INITIAL
# form carrying the eyelet — while the same pair inside 'Aaba' gives A.e0 +
# B.e0, different outlines entirely. Testing only 'ab' therefore never looks at
# the glyphs that actually get used in the middle of a name, which is most of
# the letters in most names.
#
#   mode "start"   the pair is the whole word: shape left + right
#   mode "middle"  the pair sits inside a word: shape A + left + right + a, and
#                  judge ONLY the link between the two middle letters
GROUP_SPECS: tuple[tuple[str, str, str, str, str], ...] = (
    ("lower",    "start of a word: lowercase + lowercase",
     string.ascii_lowercase, string.ascii_lowercase, "start"),
    ("caplower", "start of a word: capital + lowercase",
     string.ascii_uppercase, string.ascii_lowercase, "start"),
    ("caps",     "start of a word: capital + capital",
     string.ascii_uppercase, string.ascii_uppercase, "start"),
    ("midlower", "middle of a word: lowercase + lowercase",
     string.ascii_lowercase, string.ascii_lowercase, "middle"),
    ("midcaplower", "middle of a word: capital + lowercase",
     string.ascii_uppercase, string.ascii_lowercase, "middle"),
    # The two junctions a real name of three letters or more actually makes at
    # its ENDS, which nothing above covers. A two-letter word puts its first
    # letter in the initial form and its second in the FINAL form; a longer name
    # puts the second letter in a MEDIAL form instead, and that is a different
    # glyph. Measured on the shipped TGCarrieSOFlourish: 'dd' shapes to
    # Dleftring + dflourishrightring, while 'dda' shapes to Dleftring + d +
    # aflourishrightring -- and the Dleftring->d junction is BROKEN (2 pieces)
    # while no group above ever looks at it.
    ("firstlower", "first letter of a word: lowercase + lowercase",
     string.ascii_lowercase, string.ascii_lowercase, "first"),
    ("firstcaplower", "first letter of a word: capital + lowercase",
     string.ascii_uppercase, string.ascii_lowercase, "first"),
    ("lastlower", "last letter of a word: lowercase + lowercase",
     string.ascii_lowercase, string.ascii_lowercase, "last"),
)
GROUP_KEYS: tuple[str, ...] = tuple(g[0] for g in GROUP_SPECS)
DEFAULT_GROUPS = GROUP_KEYS
MIDDLE_MODES = tuple(g[0] for g in GROUP_SPECS if g[4] == "middle")
# Every mode that shapes the pair inside a longer string, so it needs the
# wrapper letters present in the font before it can be tested at all.
WRAPPED_MODES = ("middle", "first", "last")

# How each wrapped mode builds its string and which typed characters it judges.
# The cluster window is expressed in character positions of the shaped text.
#   middle  A + left + right + a   judge clusters 1-2   medial -> medial
#   first       left + right + a   judge clusters 0-1   INITIAL -> medial
#   last    A + left + right       judge clusters 1-2   medial -> FINAL
_MODE_SHAPE = {
    "middle": (lambda l, r, w: w[0] + l + r + w[1], (1, 2)),
    "first": (lambda l, r, w: l + r + w[1], (0, 1)),
    "last": (lambda l, r, w: w[0] + l + r, (1, 2)),
}
DEFAULT_BUDGET_S = 30.0

# The letters wrapped around a middle-of-word pair. A capital first and a
# lowercase last, because that is what a real name looks like — and because both
# ends then take the eyelet forms, leaving the pair under test in the medial
# forms where it belongs. 'Aaaa' is this wrapper around the pair 'aa'.
MIDDLE_WRAP = ("A", "a")

# Pair outcomes. Only OK / GAP / EMPTY mean the geometry was actually measured;
# the rest exist so that "we did not look" can never be mistaken for "it passed".
OK = "ok"                # ink touches — the union will fuse these two letters
GAP = "gap"              # ink does not touch — this pair falls apart when cut
EMPTY = "empty"          # a glyph drew no ink at all, so there is nothing to join
MISSING = "missing"      # a character is not in the font's cmap — not tested
UNTESTED = "untested"    # the time budget ran out before this pair — not tested
ERROR = "error"          # shaping or outline building failed — not tested

TESTED_STATUSES = (OK, GAP, EMPTY)
PROBLEM_STATUSES = (GAP, EMPTY, ERROR)


# --------------------------------------------------------------------------- #
#  report model
# --------------------------------------------------------------------------- #
@dataclass
class PairResult:
    """One two-character combination, as the font actually shaped it."""

    left: str
    right: str
    glyphs: tuple[str, ...]            # SHAPED names — 'go' may not use 'g','o'
    status: str
    gap: float | None                  # font units, worst non-touching link
    gap_em: float | None               # same gap as a fraction of the em
    detail: str = ""                   # why, in words, when it is not a plain OK
    offsets: tuple[tuple[float, float], ...] = ()   # pen position per glyph
    # For a middle-of-word test: the whole fake word that was shaped ("Aaba"),
    # and which glyphs of it are the pair under test. Empty for a start-of-word
    # test, where the pair IS the word.
    context: str = ""
    span: tuple[int, int] | None = None

    @property
    def pair(self) -> str:
        return self.left + self.right

    @property
    def shown(self) -> str:
        """What to print over the cell: the whole word when there is one."""
        return self.context or self.pair

    @property
    def left_glyph(self) -> str:
        return self.glyphs[0] if self.glyphs else "?"

    @property
    def right_glyph(self) -> str:
        return self.glyphs[-1] if self.glyphs else "?"

    @property
    def tested(self) -> bool:
        return self.status in TESTED_STATUSES

    @property
    def problem(self) -> bool:
        return self.status in PROBLEM_STATUSES

    @property
    def ligature(self) -> bool:
        """The two characters collapsed into one glyph, so there is no join."""
        return len(self.glyphs) == 1


@dataclass
class PairGroup:
    """Every pair in one of the alphabet-case groups."""

    key: str
    label: str
    left_chars: str
    right_chars: str
    cells: dict[tuple[str, str], PairResult] = field(default_factory=dict)
    mode: str = "start"                # "start" or "middle" of a word

    @property
    def middle(self) -> bool:
        return self.mode == "middle"

    @property
    def wrapped(self) -> bool:
        """The pair was shaped inside a longer string, not as a whole word."""
        return self.mode in WRAPPED_MODES

    @property
    def results(self) -> list[PairResult]:
        return list(self.cells.values())

    @property
    def tested(self) -> list[PairResult]:
        return [r for r in self.cells.values() if r.tested]

    @property
    def failures(self) -> list[PairResult]:
        return [r for r in self.cells.values() if r.problem]

    @property
    def untested(self) -> list[PairResult]:
        return [r for r in self.cells.values() if r.status == UNTESTED]

    @property
    def missing(self) -> list[PairResult]:
        return [r for r in self.cells.values() if r.status == MISSING]

    def by_left(self) -> list[tuple[str, list[PairResult]]]:
        """Failures bucketed under their left letter, in alphabet order.

        Fixing the exit stroke of one letter usually fixes every pair that
        starts with it, so this is the order the repair actually happens in.
        """
        buckets: dict[str, list[PairResult]] = {}
        for res in self.failures:
            buckets.setdefault(res.left, []).append(res)
        for group in buckets.values():
            group.sort(key=lambda r: r.right)
        return sorted(buckets.items())


@dataclass
class PairReport:
    font_path: str
    family: str
    upem: int
    budget_s: float
    elapsed_s: float
    groups: list[PairGroup]
    features: dict | None = None

    def group(self, key: str) -> PairGroup | None:
        for g in self.groups:
            if g.key == key:
                return g
        return None

    @property
    def n_tested(self) -> int:
        return sum(len(g.tested) for g in self.groups)

    @property
    def n_failed(self) -> int:
        return sum(len(g.failures) for g in self.groups)

    @property
    def n_untested(self) -> int:
        return sum(len(g.untested) for g in self.groups)

    @property
    def n_missing(self) -> int:
        return sum(len(g.missing) for g in self.groups)

    @property
    def n_pairs(self) -> int:
        return sum(len(g.cells) for g in self.groups)

    @property
    def budget_hit(self) -> bool:
        return self.n_untested > 0


# --------------------------------------------------------------------------- #
#  the pair test
# --------------------------------------------------------------------------- #
def _filled(font: Font, cache: dict, glyph: str):
    """Font.filled() with a cache.

    The engine caches contours but NOT the assembled polygon, and rebuilding it
    means one shapely union/difference pass per contour. A 26x26 sweep asks for
    ~1350 glyphs out of ~700 distinct ones, so without this the sweep runs
    roughly 13x longer than it needs to for no extra information.
    """
    if glyph not in cache:
        cache[glyph] = font.filled(glyph)
    return cache[glyph]


def _moved(geom, dx: float, dy: float):
    """The first glyph of a run always sits at the origin — don't copy it."""
    if dx == 0.0 and dy == 0.0:
        return geom
    return translate(geom, dx, dy)


def _test_pair(font: Font, cache: dict, left: str, right: str,
               features: dict | None) -> PairResult:
    """Shape one pair and ask whether its ink is continuous.

    Guarded pair by pair: one glyph with a degenerate outline must cost us that
    single cell, not the whole 676-pair sweep.
    """
    text = left + right
    try:
        placed = shape(font, text, features)
    except Exception as exc:                      # noqa: BLE001 - reported, not hidden
        return PairResult(left, right, (), ERROR, None, None,
                          f"shaping failed: {exc.__class__.__name__}: {exc}")

    names = tuple(p.glyph for p in placed)
    offsets = tuple((p.x, p.y) for p in placed)
    if not placed:
        return PairResult(left, right, names, ERROR, None, None,
                          "the shaper dropped both characters", offsets)

    geoms = []
    for p in placed:
        try:
            geoms.append(_moved(_filled(font, cache, p.glyph), p.x, p.y))
        except Exception as exc:                  # noqa: BLE001 - reported, not hidden
            return PairResult(left, right, names, ERROR, None, None,
                              f"glyph {p.glyph!r} would not build: "
                              f"{exc.__class__.__name__}: {exc}", offsets)

    blank = [n for n, g in zip(names, geoms) if g.is_empty]
    if blank:
        # No ink means nothing can overlap, and it also means the letter itself
        # will not cut. Either way it is a defect, not a pass.
        return PairResult(left, right, names, EMPTY, None, None,
                          "no ink in " + ", ".join(blank), offsets)

    if len(geoms) == 1:
        # A ligature: the font replaced both characters with one glyph, so the
        # join is drawn into the glyph and there is nothing left to test.
        return PairResult(left, right, names, OK, 0.0, 0.0,
                          "shaped to a single ligature glyph — no join to make",
                          offsets)

    # Contextual shaping can emit more than two glyphs (inserted connectors,
    # marks). The run only cuts as one piece if EVERY consecutive link touches,
    # so the pair is judged by its worst link.
    worst = 0.0
    broken: list[str] = []
    for i, (a, b) in enumerate(zip(geoms, geoms[1:])):
        if a.intersects(b):
            continue
        d = a.distance(b)
        if not math.isfinite(d):
            return PairResult(left, right, names, ERROR, None, None,
                              "gap between "
                              f"{names[i]} and {names[i + 1]} is not measurable",
                              offsets)
        worst = max(worst, d)
        broken.append(f"{names[i]}|{names[i + 1]}")

    if not broken:
        return PairResult(left, right, names, OK, 0.0, 0.0, "", offsets)

    detail = "ink does not touch at " + ", ".join(broken)
    return PairResult(left, right, names, GAP, worst, worst / font.upem,
                      detail, offsets)


def _link_gaps(names, geoms, lo: int, hi: int):
    """Worst gap over the consecutive links in geoms[lo:hi+1].

    Returns (worst_gap_or_None, list_of_broken_link_names). None means a
    distance came back non-finite, which is a measurement failure, not a pass.
    """
    worst = 0.0
    broken: list[str] = []
    for i in range(lo, hi):
        a, b = geoms[i], geoms[i + 1]
        if a.intersects(b):
            continue
        d = a.distance(b)
        if not math.isfinite(d):
            return None, [f"{names[i]}|{names[i + 1]}"]
        worst = max(worst, d)
        broken.append(f"{names[i]}|{names[i + 1]}")
    return worst, broken


def _test_middle(font: Font, cache: dict, left: str, right: str,
                 features: dict | None,
                 wrap: tuple[str, str] = MIDDLE_WRAP,
                 mode: str = "middle") -> PairResult:
    """Shape wrap[0] + left + right + wrap[1]; judge only the middle link.

    The joins to the wrapper letters are not the subject here — they are already
    covered by the start-of-word groups — so a break against the wrapper must not
    be reported as a failure of this pair. HarfBuzz cluster indices say which
    shaped glyphs came from which typed character, which is the only reliable way
    to find the middle: contextual shaping can emit any number of glyphs, and it
    may insert a connector between the two letters that belongs to neither.
    """
    build, window = _MODE_SHAPE.get(mode, _MODE_SHAPE["middle"])
    text = build(left, right, wrap)
    try:
        placed = shape(font, text, features)
    except Exception as exc:                      # noqa: BLE001 - reported
        return PairResult(left, right, (), ERROR, None, None,
                          f"shaping {text!r} failed: "
                          f"{exc.__class__.__name__}: {exc}", context=text)

    names = tuple(p.glyph for p in placed)
    offsets = tuple((p.x, p.y) for p in placed)
    if not placed:
        return PairResult(left, right, names, ERROR, None, None,
                          f"the shaper dropped {text!r} entirely", offsets,
                          context=text)

    # `window` says which typed characters are the pair under test for this mode
    idx = [i for i, pl in enumerate(placed) if pl.cluster in window]
    if not idx:
        # No cluster information (or the shaper merged everything into one
        # cluster). Fall back to positions only when the glyph count says the
        # mapping is unambiguous; otherwise refuse rather than measure the wrong
        # link and call it a result.
        if len(placed) == len(text):
            idx = list(window)
        else:
            return PairResult(left, right, names, ERROR, None, None,
                              f"cannot tell which of the {len(placed)} glyphs "
                              f"of {text!r} are the pair under test", offsets,
                              context=text)
    lo, hi = min(idx), max(idx)

    geoms = []
    for pl in placed:
        try:
            geoms.append(_moved(_filled(font, cache, pl.glyph), pl.x, pl.y))
        except Exception as exc:                  # noqa: BLE001 - reported
            return PairResult(left, right, names, ERROR, None, None,
                              f"glyph {pl.glyph!r} would not build: "
                              f"{exc.__class__.__name__}: {exc}", offsets,
                              context=text)

    blank = [names[i] for i in range(lo, hi + 1) if geoms[i].is_empty]
    if blank:
        return PairResult(left, right, names, EMPTY, None, None,
                          "no ink in " + ", ".join(blank), offsets,
                          context=text, span=(lo, hi))

    if lo == hi:
        # Both letters shaped to ONE glyph — a ligature. There is no join left to
        # make, so there is nothing to fail.
        return PairResult(left, right, names, OK, 0.0, 0.0,
                          f"{left}{right} shaped to the single glyph "
                          f"{names[lo]!r} inside {text!r} - no join to make",
                          offsets, context=text, span=(lo, hi))

    worst, broken = _link_gaps(names, geoms, lo, hi)
    if worst is None:
        return PairResult(left, right, names, ERROR, None, None,
                          f"gap at {broken[0]} is not measurable", offsets,
                          context=text, span=(lo, hi))
    if not broken:
        return PairResult(left, right, names, OK, 0.0, 0.0, "", offsets,
                          context=text, span=(lo, hi))
    return PairResult(left, right, names, GAP, worst, worst / font.upem,
                      "ink does not touch at " + ", ".join(broken)
                      + f" (shaped inside {text!r})", offsets,
                      context=text, span=(lo, hi))


def analyse_pairs(font: Font, sets=DEFAULT_GROUPS,
                  budget_s: float = DEFAULT_BUDGET_S,
                  features: dict | None = None) -> PairReport:
    """Test every two-character combination in the requested groups.

    font      an open nameplate_core.Font
    sets      any of "lower", "caplower", "caps"
    budget_s  wall-clock ceiling for the WHOLE sweep. Whatever is left when it
              expires comes back as UNTESTED — deliberately not as OK, because a
              pair nobody measured is not a pair that works.
    features  OpenType features to shape with; None uses the engine's defaults,
              which is what the real cut file gets. Pass {} to see the font with
              contextual alternates switched off, i.e. the bare base glyphs.
    """
    keys = tuple(sets)
    unknown = [k for k in keys if k not in GROUP_KEYS]
    if unknown:
        raise ValueError(f"unknown pair group(s) {unknown}; "
                         f"expected any of {list(GROUP_KEYS)}")

    cache: dict[str, object] = {}          # glyph name -> filled polygon
    started = time.monotonic()
    groups: list[PairGroup] = []

    for key, label, lefts, rights, mode in GROUP_SPECS:
        if key not in keys:
            continue
        group = PairGroup(key, label, lefts, rights, mode=mode)
        # A wrapped test needs its wrapper letters as well as the pair itself
        needed = (MIDDLE_WRAP if mode in WRAPPED_MODES else ())
        wrap_absent = [c for c in needed if ord(c) not in font.cmap]
        for left in lefts:
            for right in rights:
                absent = [c for c in (left, right)
                          if ord(c) not in font.cmap] + wrap_absent
                if absent:
                    group.cells[(left, right)] = PairResult(
                        left, right, (), MISSING, None, None,
                        "not in the font's cmap: " + " ".join(absent))
                    continue
                if time.monotonic() - started > budget_s:
                    group.cells[(left, right)] = PairResult(
                        left, right, (), UNTESTED, None, None,
                        f"the {budget_s:g}s budget ran out before this pair")
                    continue
                group.cells[(left, right)] = (
                    _test_middle(font, cache, left, right, features, mode=mode)
                    if mode in WRAPPED_MODES else
                    _test_pair(font, cache, left, right, features))
        groups.append(group)

    return PairReport(font.path, font.family, font.upem, budget_s,
                      time.monotonic() - started, groups, features)


# --------------------------------------------------------------------------- #
#  contact sheet
# --------------------------------------------------------------------------- #
_MARGIN = 20             # page edge to grid
_TITLE_H = 68            # heading band above the grid
_CELL_PAD = 9            # cell border to artwork
_STRIP_H = 32            # bottom of a cell: the characters, then the red label
_MAX_PX = 4000           # a PNG wider or taller than this gets split
_CELL_PX = 200           # a pair at this size is comfortably readable

_INK = QColor(0, 0, 0)
_PAPER = QColor(255, 255, 255)
_OK_BORDER = QColor(216, 216, 216)
_BAD_BORDER = QColor(214, 32, 32)
_WARN_BORDER = QColor(230, 150, 20)
_CHAR_TEXT = QColor(110, 110, 110)
_TITLE_TEXT = QColor(20, 20, 20)

_QT_APP = None            # kept alive for the life of the process, see _ensure_qt
_UI_FAMILY: str | None = None      # resolved once; "" means Qt's default will do

# Captions only — never the letters under test. First one that exists wins.
_UI_FONT_FILES = (
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\tahoma.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)


def _ensure_qt():
    """Make sure a QGuiApplication exists, without hijacking a real one.

    QT_QPA_PLATFORM is set HERE rather than at import time on purpose: if this
    module is imported by the GUI before it builds its QApplication, forcing
    "offscreen" at import would launch the whole app with no visible window.
    Inside the running app there is already an instance and we touch nothing.
    """
    global _QT_APP
    if QGuiApplication.instance() is not None:
        return
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    _QT_APP = QGuiApplication([])


def _ui_family() -> str:
    """A family the CAPTIONS can actually be set in.

    Qt's offscreen platform ships an empty font database — QFontDatabase.families()
    returns [] — so a plain QFont() resolves to a family that does not exist and
    every caption came out as a row of .notdef boxes. Registering one real UI
    font file fixes that. Inside the running GUI the platform database is already
    populated and this does nothing.

    This is for the titles and cell captions only. The letters being judged are
    never drawn through a text API; see the module docstring for why.
    """
    global _UI_FAMILY
    if _UI_FAMILY is not None:
        return _UI_FAMILY
    if QFontDatabase.families():
        _UI_FAMILY = ""
        return _UI_FAMILY
    for path in _UI_FONT_FILES:
        if not os.path.exists(path):
            continue
        fid = QFontDatabase.addApplicationFont(path)
        families = QFontDatabase.applicationFontFamilies(fid) if fid >= 0 else []
        if families:
            _UI_FAMILY = families[0]
            return _UI_FAMILY
    # Not fatal: the red borders are the part that must not be missed, and they
    # are rectangles, not text. Say so rather than shipping boxes silently.
    print("  ! no UI font found for the sheet captions - the cells are still "
          "bordered but their labels may render as boxes", file=sys.stderr)
    _UI_FAMILY = ""
    return _UI_FAMILY


def _ui_font(px: int, bold: bool = False) -> QFont:
    """A caption QFont. Named _ui_ so it is never confused with the Font under test."""
    family = _ui_family()
    qf = QFont(family) if family else QFont()
    qf.setPixelSize(px)            # pixels, not points: the layout here is pixels
    qf.setBold(bold)
    return qf


def _fmt_em(value: float) -> str:
    """3 decimals normally — more when 3 would round a real gap down to zero.

    A hairline gap is still a broken nameplate, so it must never print as
    "0.000 em" and read like a pass.
    """
    if value and abs(value) < 0.001:
        return f"{value:.5f}"
    return f"{value:.3f}"


def _cell_label(res: PairResult) -> tuple[str, QColor] | None:
    """The short red flag printed on a cell, or None when the pair is fine."""
    if res.status == GAP:
        return f"GAP {_fmt_em(res.gap_em or 0.0)} em", _BAD_BORDER
    if res.status == EMPTY:
        return "EMPTY GLYPH", _BAD_BORDER
    if res.status == ERROR:
        return "TEST FAILED", _BAD_BORDER
    if res.status == UNTESTED:
        return "UNTESTED", _WARN_BORDER
    if res.status == MISSING:
        return "no glyph", _CHAR_TEXT
    return None


def _pair_outlines(font: Font, res: PairResult):
    """Flattened outlines per glyph, moved to their pen positions, plus a bbox.

    Grouped PER GLYPH, and every contour of one glyph belongs to one even-odd
    path so its counters stay open. What must never happen is both glyphs in a
    single even-odd path: the overlap is the whole point of the sheet, and
    even-odd would punch that overlap out as a white hole — exactly backwards.

    Positions come straight from nameplate_core.shape(), i.e. HarfBuzz pen
    positions with the font's kerning and contextual substitutions applied. No
    advance-width arithmetic and no letter spacing of our own, so a pair sits
    here exactly as it would in the cut file (and in Illustrator, which shapes
    with the same engine).
    """
    runs: list[list[list[tuple[float, float]]]] = []
    xs: list[float] = []
    ys: list[float] = []
    for gname, (dx, dy) in zip(res.glyphs, res.offsets):
        rings = []
        for contour in font.contours(gname):
            ring = [(px + dx, py + dy) for px, py in contour]
            rings.append(ring)
            xs.extend(p[0] for p in ring)
            ys.extend(p[1] for p in ring)
        if rings:
            runs.append(rings)
    if not xs or not ys:
        return [], None
    return runs, (min(xs), min(ys), max(xs), max(ys))


def _pair_extent(font: Font, res: PairResult):
    """Ink box of a shaped pair in font units, without materialising the rings.

    Used for the sizing pass over a whole group, which happens before anything
    is drawn.
    """
    x0 = y0 = float("inf")
    x1 = y1 = float("-inf")
    for gname, (dx, dy) in zip(res.glyphs, res.offsets):
        for contour in font.contours(gname):
            for px, py in contour:
                fx, fy = px + dx, py + dy
                if fx < x0:
                    x0 = fx
                if fx > x1:
                    x1 = fx
                if fy < y0:
                    y0 = fy
                if fy > y1:
                    y1 = fy
    if x0 > x1 or y0 > y1:
        return None
    return x0, y0, x1, y1


@dataclass
class _Frame:
    """How font units map to pixels — ONE of these per group, not per cell.

    Fitting each pair to its own cell would make every cell a different scale,
    so a genuinely oversized letter and a normal one would look identical and a
    size difference between two cells would mean nothing. Instead the group is
    measured first: the scale is whatever makes the WIDEST pair and the full
    top-to-bottom ink range of the group fit one cell, and every cell then uses
    it. Cell-to-cell size differences on the finished sheet are real.
    """

    scale: float        # font units -> pixels, uniform across the group
    top: float          # highest ink above the baseline in the group, font units
    bottom: float       # lowest ink below the baseline, font units (usually < 0)


def _group_frame(font: Font, group: PairGroup, cell_px: int) -> _Frame:
    art_w = max(8, cell_px - 2 * _CELL_PAD)
    art_h = max(8, cell_px - _CELL_PAD - _STRIP_H)
    widest, top, bottom = 1.0, 1.0, 0.0
    for res in group.cells.values():
        if not res.glyphs or not res.offsets:
            continue
        try:
            box = _pair_extent(font, res)
        except Exception:                          # noqa: BLE001 - sizing only
            continue                               # unpaintable cell reports itself
        if box is None:
            continue
        x0, y0, x1, y1 = box
        widest = max(widest, x1 - x0)
        top = max(top, y1)
        bottom = min(bottom, y0)
    scale = min(art_w / widest, art_h / max(top - bottom, 1.0))
    return _Frame(scale, top, bottom)


def _paint_cell(painter: QPainter, font: Font, res: PairResult,
                x: int, y: int, w: int, h: int, frame: _Frame) -> None:
    """Draw one pair, filled, inside its cell, and flag it if it failed."""
    label = _cell_label(res)
    if res.problem:
        painter.setPen(QPen(_BAD_BORDER, 3))
    elif res.status == UNTESTED:
        painter.setPen(QPen(_WARN_BORDER, 2))
    elif res.status == MISSING:
        pen = QPen(_OK_BORDER, 1)
        pen.setStyle(Qt.DashLine)
        painter.setPen(pen)
    else:
        painter.setPen(QPen(_OK_BORDER, 1))
    painter.drawRect(x + 1, y + 1, w - 2, h - 2)

    art = QRect(x + _CELL_PAD, y + _CELL_PAD,
                w - 2 * _CELL_PAD, h - _CELL_PAD - _STRIP_H)
    runs, bbox = _pair_outlines(font, res)
    if runs and bbox and art.width() > 4 and art.height() > 4:
        x0, _y0, x1, _y1 = bbox
        s = frame.scale                      # the group's scale, never the cell's
        # Every cell puts the BASELINE at the same height, so ascenders and
        # descenders can be compared down a column instead of each pair being
        # re-centred on its own ink. The band reserved is the group's full ink
        # range, so nothing clips.
        band = (frame.top - frame.bottom) * s
        base_y = art.y() + (art.height() - band) / 2.0 + frame.top * s
        ox = art.x() + (art.width() - (x1 - x0) * s) / 2.0 - x0 * s
        for rings in runs:
            path = QPainterPath()
            # All contours of ONE glyph in ONE even-odd path: that is what keeps
            # the counter of an 'o' or an 'e' open. Filling contour by contour
            # would paint the counter solid and make the sheet useless.
            path.setFillRule(Qt.OddEvenFill)
            for ring in rings:
                if len(ring) < 3:
                    continue
                # y flips: font units go up, image rows go down.
                path.moveTo(ox + ring[0][0] * s, base_y - ring[0][1] * s)
                for px, py in ring[1:]:
                    path.lineTo(ox + px * s, base_y - py * s)
                path.closeSubpath()
            # fillPath only — no pen on the letters. A stroke would fatten thin
            # strokes and hide the thinness that has to be visible here.
            painter.fillPath(path, _INK)

    strip = QRect(x + 2, y + h - _STRIP_H, w - 4, _STRIP_H)
    painter.setFont(_ui_font(14))
    painter.setPen(_CHAR_TEXT)
    painter.drawText(QRect(strip.x(), strip.y(), strip.width(), 16),
                     Qt.AlignHCenter | Qt.AlignVCenter, res.pair)
    if label:
        text, colour = label
        painter.setFont(_ui_font(13, bold=True))
        painter.setPen(colour)
        painter.drawText(QRect(strip.x(), strip.y() + 15, strip.width(), 16),
                         Qt.AlignHCenter | Qt.AlignVCenter, text)


def _paginate(count: int, per_page: int) -> list[tuple[int, int]]:
    """Split 0..count into balanced chunks of at most per_page.

    Balanced, not greedy: 26 columns at 19 per page becomes 13 + 13 rather than
    19 + 7, so the pages are the same shape and read as one sheet.
    """
    per_page = max(1, per_page)
    pages = max(1, math.ceil(count / per_page))
    size = math.ceil(count / pages)
    return [(i, min(i + size, count)) for i in range(0, count, size)]


def _render_page(font: Font, group: PairGroup, rows: str, cols: str,
                 cell_px: int, frame: _Frame,
                 title_lines: tuple[str, str, str], path: str) -> tuple[str, int, int]:
    w = len(cols) * cell_px + 2 * _MARGIN
    h = len(rows) * cell_px + 2 * _MARGIN + _TITLE_H
    img = QImage(w, h, QImage.Format_RGB32)
    img.fill(_PAPER)
    painter = QPainter(img)
    try:
        painter.setRenderHint(QPainter.Antialiasing, True)

        painter.setFont(_ui_font(22, bold=True))
        painter.setPen(_TITLE_TEXT)
        painter.drawText(_MARGIN, _MARGIN + 20, title_lines[0])
        painter.setFont(_ui_font(14))
        painter.drawText(_MARGIN, _MARGIN + 40, title_lines[1])
        painter.setPen(_CHAR_TEXT)
        painter.setFont(_ui_font(13))
        painter.drawText(_MARGIN, _MARGIN + 58, title_lines[2])

        top = _MARGIN + _TITLE_H
        for ri, left in enumerate(rows):
            for ci, right in enumerate(cols):
                res = group.cells.get((left, right))
                if res is None:
                    continue
                cx = _MARGIN + ci * cell_px
                cy = top + ri * cell_px
                try:
                    _paint_cell(painter, font, res, cx, cy, cell_px, cell_px, frame)
                except Exception as exc:              # noqa: BLE001 - shown, not hidden
                    # One unpaintable glyph must not cost the other 675 cells.
                    painter.setPen(QPen(_BAD_BORDER, 3))
                    painter.drawRect(cx + 1, cy + 1, cell_px - 2, cell_px - 2)
                    painter.drawLine(cx + 4, cy + 4, cx + cell_px - 4, cy + cell_px - 4)
                    painter.drawLine(cx + cell_px - 4, cy + 4, cx + 4, cy + cell_px - 4)
                    painter.setFont(_ui_font(12))
                    painter.drawText(QRect(cx + 2, cy + cell_px - 20, cell_px - 4, 18),
                                     Qt.AlignHCenter | Qt.AlignVCenter,
                                     f"{res.pair}: draw failed")
                    print(f"  ! cell {res.pair!r} in {group.key} would not draw: "
                          f"{exc.__class__.__name__}: {exc}", file=sys.stderr)
    finally:
        painter.end()

    if not img.save(path, "PNG"):
        raise OSError(f"could not write {path}")
    return path, w, h


def render_sheet(font: Font, report: PairReport, out_png_prefix: str,
                 cell_px: int = _CELL_PX, max_px: int = _MAX_PX,
                 groups=None) -> list[str]:
    """Write contact-sheet PNGs — one grid of filled pairs per group.

    out_png_prefix is a path prefix; files come out as
    <prefix>_<group>_p<N>.png. 26x26 cells at a size you can actually judge is
    far past any sane image size, so each group is split into balanced pages of
    at most max_px on a side, and EVERY path is returned.
    """
    _ensure_qt()
    wanted = report.groups if groups is None else [
        g for g in report.groups if g.key in tuple(groups)]

    out_dir = os.path.dirname(os.path.abspath(out_png_prefix))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    file_name = os.path.basename(report.font_path)
    written: list[str] = []

    for group in wanted:
        col_pages = _paginate(len(group.right_chars),
                              max(1, (max_px - 2 * _MARGIN) // cell_px))
        row_pages = _paginate(len(group.left_chars),
                              max(1, (max_px - 2 * _MARGIN - _TITLE_H) // cell_px))
        total = len(col_pages) * len(row_pages)
        n_failed, n_tested = len(group.failures), len(group.tested)
        # Measured once for the whole group, so every page of the group shares
        # one scale and pages can be compared with each other too.
        frame = _group_frame(font, group, cell_px)
        page = 0
        for r0, r1 in row_pages:
            for c0, c1 in col_pages:
                page += 1
                rows = group.left_chars[r0:r1]
                cols = group.right_chars[c0:c1]
                where = (f"rows {rows[0]}-{rows[-1]} x cols {cols[0]}-{cols[-1]}"
                         if rows and cols else "empty")
                lines = (
                    report.family,
                    f"{file_name}  |  {group.label}  |  page {page} of {total}"
                    f"  |  {where}",
                    f"upem {report.upem}  |  {n_failed} of {n_tested} tested pairs "
                    f"flagged  |  red = the two letters' ink does NOT touch, "
                    f"grey = it does  |  raw outlines, filled, no hinting, "
                    f"shaping on  |  one scale for the whole group: "
                    f"1 em = {report.upem * frame.scale:.1f} px",
                )
                path = f"{out_png_prefix}_{group.key}_p{page}.png"
                try:
                    written.append(_render_page(font, group, rows, cols,
                                                cell_px, frame, lines, path)[0])
                except Exception as exc:              # noqa: BLE001 - shown, not hidden
                    print(f"  ! page {path} failed: "
                          f"{exc.__class__.__name__}: {exc}", file=sys.stderr)
    return written


def sheet_sizes(paths) -> list[tuple[str, int, int]]:
    """Read each PNG back and report its real pixel size.

    Reading the file rather than trusting the numbers we drew with is the only
    thing that proves the PNG on disk is a usable image.
    """
    _ensure_qt()
    out = []
    for p in paths:
        img = QImage(p)
        out.append((p, img.width(), img.height()))
    return out


# --------------------------------------------------------------------------- #
#  instruction for a font-editing AI
# --------------------------------------------------------------------------- #
def claude_prompt(font: Font, report: PairReport, font_path: str) -> str:
    """The failures, rewritten as a paste-ready brief for an AI that edits fonts.

    Deliberately plain text with no markdown: it gets pasted straight into a
    chat, and it names the font, the em, and the exact SHAPED glyph names,
    because every one of those has been a source of an edit landing on the wrong
    glyph in the wrong font at the wrong scale.
    """
    upem = report.upem
    # Ask for a real bite, not a kiss. 1% of the em is enough for skia's union
    # to fuse two contours reliably at any sane cutting scale.
    overlap = max(8, int(round(0.01 * upem)))
    L: list[str] = []
    a = L.append

    a("FONT TO EDIT")
    a(f"  file name    : {os.path.basename(font_path)}")
    a(f"  full path    : {os.path.abspath(font_path)}")
    a(f"  family name  : {report.family}")
    a(f"  unitsPerEm   : {upem}")
    a("")
    a(f"Every size below is in FONT UNITS on this font's {upem}-unit em.")
    a(f"For scale: 1% of the em is {overlap} units. Do not read the numbers as")
    a("points, pixels, millimetres or percentages.")
    a("")
    a("WHY THIS MATTERS")
    a("  These letters get laser-cut out of one piece of sheet metal. The cutting")
    a("  app unions all the letters of a name into ONE closed path. Wherever two")
    a("  neighbouring letters do not overlap, the union leaves two separate")
    a("  islands and that letter drops out of the sheet as a loose piece.")
    a("")

    total_failed = report.n_failed
    if total_failed == 0:
        a("RESULT: NOTHING TO FIX.")
        a(f"  All {report.n_tested} pairs that were tested have overlapping ink,")
        a("  so every one of them will union into a single cut path.")
        if report.n_missing:
            a(f"  {report.n_missing} pairs were skipped because a character is not")
            a("  in the font's cmap.")
        if report.budget_hit:
            a(f"  WARNING: {report.n_untested} pairs were NOT tested - the")
            a(f"  {report.budget_s:g}s time budget ran out. Those are unknown, not passes.")
            a("  Re-run with a larger budget before treating the font as clean.")
        a("  Do not make any changes to this font.")
        return "\n".join(L)

    a(f"FAILING PAIRS: {total_failed} of {report.n_tested} tested pairs have a")
    a("gap between the two letters. They are grouped by their LEFT letter,")
    a("because the left letter's exit stroke is usually the single thing that")
    a("has to change to fix the whole group.")
    a("")

    for group in report.groups:
        buckets = group.by_left()
        a(f"--- {group.label.upper()} --- "
          f"{len(group.failures)} of {len(group.tested)} tested pairs failed")
        if not buckets:
            a("  none failed in this group.")
            a("")
            continue
        for left, results in buckets:
            a(f"  LEFT LETTER '{left}'  ({len(results)} failing pair"
              f"{'s' if len(results) != 1 else ''})")
            for res in results:
                if res.status == GAP:
                    need = (res.gap or 0.0) + overlap
                    run = " -> ".join(res.glyphs)
                    a(f"    '{res.left}' + '{res.right}'   glyphs: {run}")
                    a(f"        gap {res.gap:.1f} units ({_fmt_em(res.gap_em or 0.0)} em)"
                      f" - close it and then overlap: extend by >= {need:.0f} units")
                elif res.status == EMPTY:
                    a(f"    '{res.left}' + '{res.right}'   glyphs: "
                      f"{' -> '.join(res.glyphs) or '(none)'}")
                    a(f"        NO INK: {res.detail} - this glyph does not draw at all")
                else:
                    a(f"    '{res.left}' + '{res.right}'   glyphs: "
                      f"{' -> '.join(res.glyphs) or '(none)'}")
                    a(f"        could not be measured: {res.detail}")
            a("")

    a("WHAT TO CHANGE")
    a(f"  For each failing pair, extend the LEFT glyph's exit stroke (or, where")
    a("  that would distort the letter, the RIGHT glyph's entry stroke) along the")
    a(f"  natural direction of the stroke until the two outlines OVERLAP by at")
    a(f"  least {overlap} font units measured across the join.")
    a("  A hairline touch is NOT enough. The app unions the letters into one cut")
    a("  path, and two outlines that only graze each other can union into a")
    a("  pinch that the laser cuts straight through. Aim for a real overlap.")
    a("  Keep the extension on the stroke's own path and weight so the letter")
    a("  still reads as the same letter - do not add a straight connector bar.")
    a("  Every gap above was measured with this font's own kerning applied, the")
    a("  same way the cutting app shapes a name. Some of these pairs are pushed")
    a("  apart by a positive kern; close them by extending the outline anyway.")
    a("  The spacing is the design and the app depends on it, so do not buy the")
    a("  overlap by re-kerning the pair.")
    a("")
    a("EDIT THE GLYPH THAT IS NAMED, NOT THE BASE LETTER")
    a("  This font uses contextual alternates, so the glyph that actually draws")
    a("  in a pair is often NOT the plain base glyph. The 'glyphs:' line above")
    a("  gives the real shaped glyph names, in order, as the shaper chose them")
    a("  (names like 'g.alt3' or 'bflourishrightring.eng3' are alternates).")
    a("  Make each edit on the glyph named there. Editing the plain base glyph")
    a("  instead changes something nobody sees and leaves the gap exactly as it")
    a("  is. If one alternate is shared by several failing pairs, fixing it once")
    a("  fixes all of them - check before editing the same outline twice.")
    a("")
    a("DO NOT CHANGE")
    a("  - unitsPerEm")
    a("  - cap height, x-height, ascender, descender, or any vertical metric")
    a("  - advance widths and side bearings (the letters must not re-space)")
    a("  - kerning values")
    a("  - eyelet hole sizes, shapes or positions")
    a("  - the set of alternate glyphs, or the feature rules that pick them")
    a("    (calt, liga, rlig, kern) - the same alternate must still be chosen")
    a("    for the same pair after the edit")
    a("  - the colour layers / engrave lines")
    a("  - ANY glyph not named in the list above")
    a("")
    a("HOW IT WILL BE CHECKED")
    a("  Every pair is re-shaped and the two filled outlines are tested for")
    a("  intersection. A pair passes only when the ink actually overlaps, and no")
    a("  pair that passes today may start failing.")
    if report.n_missing:
        a(f"  ({report.n_missing} pairs are skipped: a character is not in the cmap.)")
    if report.budget_hit:
        a(f"  ({report.n_untested} pairs were NOT tested before the "
          f"{report.budget_s:g}s budget ran out, so more may still be broken.)")
    return "\n".join(L)


# --------------------------------------------------------------------------- #
#  command line
# --------------------------------------------------------------------------- #
def _summary(report: PairReport, sheets: list[tuple[str, int, int]]) -> str:
    L = [f"{report.family}",
         f"  file {os.path.basename(report.font_path)}   upem {report.upem}"]
    for g in report.groups:
        fails = g.failures
        L.append(f"  {g.label:24s} tested {len(g.tested):3d}/{len(g.cells):3d}"
                 f"   flagged {len(fails):3d}"
                 f"   no-glyph {len(g.missing):3d}   untested {len(g.untested):3d}")
        for res in sorted(fails, key=lambda r: -(r.gap or 0.0))[:20]:
            if res.status == GAP:
                L.append(f"      {res.pair}  gap {res.gap:7.1f}u "
                         f"({_fmt_em(res.gap_em or 0.0)} em)   "
                         f"{' -> '.join(res.glyphs)}")
            else:
                L.append(f"      {res.pair}  {res.status.upper()}: {res.detail}")
        if len(fails) > 20:
            L.append(f"      ... and {len(fails) - 20} more")
    L.append(f"  {report.n_tested} of {report.n_pairs} pairs tested, "
             f"{report.n_failed} flagged, in {report.elapsed_s:.1f}s "
             f"of a {report.budget_s:g}s budget")
    if report.budget_hit:
        L.append("  BUDGET RAN OUT - untested pairs are unknown, not passes")
    if sheets:
        L.append("  sheets:")
        for path, w, h in sheets:
            L.append(f"    {path}   {w} x {h} px")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Contact-sheet and gap-test every two-letter combination in "
                    "a font, the way the raw font draws it.")
    ap.add_argument("font", help="path to a .ttf or .otf")
    ap.add_argument("--out", default="pairsheets",
                    help="directory for the PNGs (default: ./pairsheets)")
    ap.add_argument("--groups", default=",".join(DEFAULT_GROUPS),
                    help="comma list of " + ",".join(GROUP_KEYS))
    ap.add_argument("--prompt", action="store_true",
                    help="also print the font-editing instruction")
    ap.add_argument("--budget", type=float, default=DEFAULT_BUDGET_S,
                    help=f"wall-clock seconds for the sweep "
                         f"(default {DEFAULT_BUDGET_S:g})")
    ap.add_argument("--cell", type=int, default=_CELL_PX,
                    help=f"cell size in pixels (default {_CELL_PX})")
    ap.add_argument("--max-px", type=int, default=_MAX_PX,
                    help=f"split a sheet past this many pixels a side "
                         f"(default {_MAX_PX})")
    ap.add_argument("--no-sheet", action="store_true",
                    help="analyse only, write no PNGs")
    args = ap.parse_args(argv)

    groups = [g.strip() for g in args.groups.split(",") if g.strip()]
    font = Font(args.font)
    report = analyse_pairs(font, sets=groups, budget_s=args.budget)

    sheets: list[tuple[str, int, int]] = []
    if not args.no_sheet:
        stem = os.path.splitext(os.path.basename(args.font))[0]
        prefix = os.path.join(args.out, f"{stem}_pairs")
        sheets = sheet_sizes(render_sheet(font, report, prefix,
                                          cell_px=args.cell, max_px=args.max_px))

    print(_summary(report, sheets))
    if args.prompt:
        print()
        print("-" * 72)
        print(claude_prompt(font, report, args.font))
    return 1 if report.n_failed else 0


if __name__ == "__main__":
    sys.exit(main())

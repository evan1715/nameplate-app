"""
nameplate_gui.py — PySide6 desktop front end for the ShineOn Nameplate Cut-File app.

This is UI only. Every piece of geometry comes from nameplate_core, which is the
tested engine — see SPEC.md section 3 for the API and section 8 for the bugs that
were already paid for. Nothing in here reimplements shaping, unioning or export.

Layout and behaviour follow SPEC.md section 4.

Threading note (SPEC.md section 4): `Font` objects are not thread-safe, so each
worker thread owns its own. Preview builds run on one long-lived worker thread
(serialised, with its own Font cache); each export runs on a fresh worker thread
that opens its own Font. The GUI thread never calls build_document().
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import traceback
import zipfile
from dataclasses import dataclass, field
from datetime import datetime

from fontTools.ttLib import TTFont
from PySide6.QtCore import (QObject, QPointF, Qt, QThread, QTimer, Signal, Slot,
                            qInstallMessageHandler)
from PySide6.QtGui import (QColor, QFont as QtGuiFont, QIcon, QPainter,
                           QPalette, QPen)
from PySide6.QtWidgets import (QApplication, QButtonGroup, QCheckBox, QComboBox,
                               QDialog, QDoubleSpinBox, QFileDialog, QFrame,
                               QGridLayout, QGroupBox, QHBoxLayout, QLabel,
                               QMessageBox, QPlainTextEdit, QProgressBar,
                               QPushButton, QRadioButton, QScrollArea,
                               QSizePolicy, QSplitter, QVBoxLayout, QWidget)

from nameplate_core import (MM_PER_IN, Font, build_document, pdf_document,
                            pdf_sheet, safe_filename, stack, svg_sheet,
                            svg_single)
from nameplate_export import export_pdf, export_svg
from nameplate_layout import HORIZONTAL, VERTICAL, arrange, overlaps
from nameplate_leadin import (default_clearance, default_length,
                              doc_for_export, lead_in_lines,
                              pdf_document_leadin, pdf_sheet_leadin,
                              svg_sheet_leadin, svg_single_leadin)

APP_NAME = "Sean's Font Prototyping Friend"

# Saints Row neon purple, used everywhere Qt would otherwise use its blue accent
NEON = "#B026FF"
NEON_HOVER = "#C558FF"
NEON_PRESS = "#7B18C4"
FONT_EXTS = (".ttf", ".otf", ".ttc")

# Preview mark-up colours. Black is cut and red is engrave, so everything the
# app adds on top has to stay clear of both — and of each other, since the
# thin-area marks and the eyelet marks can be on screen at the same time.
THIN_TARGET = "#00d2d2"      # cyan   — letters at the wanted thickness
EYE_TARGET_ID = "#2f9e44"    # green  — eyelet at the wanted inner diameter
EYE_TARGET_OD = "#7cc65b"    # lighter green — wanted outer diameter
EYE_DIM = "#0b7285"          # teal   — measured eyelet dimensions
# thin-area severity ramp, worst first: magenta -> orange -> amber -> olive
THIN_RAMP = ("#e6007e", "#ff6a00", "#ffab00", "#b8a000")
THIN_OK = "#2f9e44"          # green  — already at or above the wanted thickness

DEBOUNCE_MS = 150
MIN_IN, MIN_MM = 0.05, 1.0
PROGRESS_THRESHOLD = 10          # show the progress bar above this many names

# SPEC.md section 6: fonts/ and settings.json live next to the exe and must be
# writable, so resolve from sys.executable when frozen — never __file__.
BASE = (os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
        else os.path.dirname(os.path.abspath(__file__)))
FONTS_DIR = os.path.join(BASE, "fonts")
SETTINGS_PATH = os.path.join(BASE, "settings.json")


# --------------------------------------------------------------------------- #
#  settings — plain JSON next to the exe, so the folder stays portable
# --------------------------------------------------------------------------- #
_SETTING_TYPES = {
    "font_path": str, "unit": str, "basis": str, "names": str,
    "direction": str,
    "height": (int, float), "gap": (int, float),
    "lead_len": (int, float), "lead_clear": (int, float),
    "eye_target_id": (int, float), "eye_target_wall": (int, float),
    "lead_in": bool, "formats": list,
    "eye_show_dims": bool, "eye_show_want": bool,
}


def load_settings() -> dict:
    """settings.json, with every value type-checked.

    The file is external data — hand-edited, synced between PCs, or corrupted.
    A {"font_path": 123} used to poison the font list until Refresh, because
    the value went straight into os.path calls. A wrongly-typed value is
    dropped and the default takes over; the rest of the file still loads.
    """
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {}
        out = {}
        for k, v in data.items():
            want = _SETTING_TYPES.get(k, object)
            # bool is a subclass of int, so {"height": true} would sneak
            # through an (int, float) check and then feed arithmetic
            if isinstance(v, bool) and want is not bool:
                continue
            if isinstance(v, want):
                out[k] = v
        return out
    except Exception:
        return {}


def save_settings(data: dict) -> None:
    try:
        with open(SETTINGS_PATH, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except Exception:
        pass          # a read-only folder must not break the app


def close_splash() -> None:
    """Dismiss the PyInstaller --splash image.

    Must be safe to call repeatedly and from any error path: the splash is an
    always-on-top window, so if it outlives startup it hides whatever error
    dialog we put up and the app looks like it hung with nothing on screen.

    pyi_splash only exists inside a frozen build made with --splash, so this is
    a no-op when running from source.
    """
    try:
        import pyi_splash                                  # type: ignore
        if pyi_splash.is_alive():
            pyi_splash.close()
    except Exception:
        pass


# --------------------------------------------------------------------------- #
#  startup log — the only way to see why a --windowed exe failed to appear
# --------------------------------------------------------------------------- #
def _log_path() -> str:
    """Next to the exe, or under LOCALAPPDATA if that folder is read-only."""
    for folder in (BASE,
                   os.path.join(os.environ.get("LOCALAPPDATA", ""),
                                "SeansFontPrototypingFriend")):
        if not folder:
            continue
        try:
            os.makedirs(folder, exist_ok=True)
            p = os.path.join(folder, "startup.log")
            with open(p, "a", encoding="utf-8"):
                pass
            return p
        except Exception:
            continue
    return ""


_LOG = None


def log(msg: str) -> None:
    """Append one line to the startup log. Never raises."""
    global _LOG
    try:
        if _LOG is None:
            _LOG = _log_path()
        if not _LOG:
            return
        with open(_LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now().strftime('%H:%M:%S.%f')[:-3]}  {msg}\n")
    except Exception:
        pass


def crash_report(where: str, exc: BaseException) -> str:
    """Write the traceback next to the log and return the path.

    A frozen --windowed exe has no console, so an unhandled exception in a worker
    thread used to vanish: the only trace was whatever the handler happened to
    log, and any QMessageBox raised from that thread was being built on the wrong
    thread, which is undefined behaviour in Qt and can take the process down
    instead of reporting the problem.
    """
    import traceback as _tb
    text = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    try:
        path = os.path.join(os.path.dirname(_log_path()),
                            f"crash-{stamp}.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"{APP_NAME}\n{where}\n{stamp}\n\n{text}\n")
    except Exception:
        path = ""
    log(f"CRASH in {where}: {exc!r}" + (f" -> {path}" if path else ""))
    return path


def fatal(title: str, detail: str) -> None:
    """Report a startup failure so it is actually visible.

    The splash is dropped first, otherwise it covers the dialog. A plain Win32
    message box is used as the last resort because it still works when Qt
    itself is the thing that failed.
    """
    close_splash()
    log(f"FATAL {title}\n{detail}")
    shown = False
    try:
        from PySide6.QtWidgets import QApplication as _QA
        if _QA.instance() is not None:
            box = QMessageBox(QMessageBox.Critical, title, title)
            box.setInformativeText(detail[-2500:])
            box.setDetailedText(f"Log: {_LOG}")
            box.exec()
            shown = True
    except Exception:
        pass
    if not shown:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, f"{detail[-1200:]}\n\nLog: {_LOG}", title, 0x10)
        except Exception:
            pass


def build_manifest() -> dict:
    """What this exe was built from, or {} when running from source.

    Bundled by PyInstaller, so it travels with the exe. Without it "which
    version is on that shop PC?" had no answer at all: two exes of the same size
    could differ by a fix, and a bug report could not be tied to code.
    """
    for base in (getattr(sys, "_MEIPASS", None), BASE,
                 os.path.dirname(os.path.abspath(__file__))):
        if not base:
            continue
        p = os.path.join(base, "assets", "build_manifest.json")
        try:
            with open(p, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            continue
    return {}


def health_report() -> str:
    """Everything worth knowing when something is wrong on someone's machine."""
    man = build_manifest()
    L = [APP_NAME, "=" * len(APP_NAME), ""]
    if man:
        L += [f"build            {man.get('build_id', '?')}",
              f"built            {man.get('built_utc', '?')}"
              f" on {man.get('built_on', '?')}",
              f"built with       Python {man.get('python', '?')}"]
        deps = man.get("dependencies") or {}
        if deps:
            L.append("dependencies     "
                     + ", ".join(f"{k} {v}" for k, v in deps.items()))
    else:
        L.append("build            (running from source - no manifest)")
    L += ["",
          f"frozen exe       {bool(getattr(sys, 'frozen', False))}",
          f"running from     {BASE}",
          f"fonts folder     {FONTS_DIR}",
          f"settings file    {SETTINGS_PATH}",
          f"startup log      {_log_path()}",
          f"python now       {sys.version.split()[0]}",
          ""]
    # the things that actually go wrong on a shop PC
    checks = []
    checks.append(("fonts folder exists", os.path.isdir(FONTS_DIR)))
    try:
        n = len([f for f in os.listdir(FONTS_DIR)
                 if f.lower().endswith(FONT_EXTS)])
    except Exception:
        n = 0
    checks.append((f"fonts present ({n})", n > 0))
    writable = False
    try:
        probe = os.path.join(BASE, ".write_probe")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("x")
        os.remove(probe)
        writable = True
    except Exception:
        pass
    checks.append(("app folder is writable", writable))
    checks.append(("path length under 240 chars", len(BASE) < 240))
    L.append("CHECKS")
    for label, ok in checks:
        L.append(f"  [{'ok' if ok else 'PROBLEM'}] {label}")
    if man.get("fonts_shipped"):
        L += ["", "FONTS THIS BUILD SHIPPED WITH"]
        for f in man["fonts_shipped"]:
            L.append(f"  {f.get('sha256_16', '?')}  {f.get('file', '?')}")
    return "\n".join(L)


def ensure_fonts_dir() -> None:
    """Make sure a writable fonts/ exists next to the exe.

    A frozen build also carries a bundled copy inside _internal (--add-data);
    if the user's folder has no fonts/ yet, seed it from there so a freshly
    copied folder is usable immediately.
    """
    if not os.path.isdir(FONTS_DIR):
        try:
            os.makedirs(FONTS_DIR, exist_ok=True)
        except Exception:
            return
    bundled = os.path.join(getattr(sys, "_MEIPASS", ""), "fonts")
    if getattr(sys, "frozen", False) and os.path.isdir(bundled):
        try:
            existing = {n.lower() for n in os.listdir(FONTS_DIR)}
            for name in os.listdir(bundled):
                if name.lower().endswith(FONT_EXTS) and name.lower() not in existing:
                    shutil.copy2(os.path.join(bundled, name),
                                 os.path.join(FONTS_DIR, name))
        except Exception:
            pass


# --------------------------------------------------------------------------- #
#  font discovery
# --------------------------------------------------------------------------- #
@dataclass
class FontEntry:
    path: str
    family: str
    mtime: float
    size: int

    @property
    def filename(self) -> str:
        return os.path.basename(self.path)

    @property
    def date_str(self) -> str:
        return datetime.fromtimestamp(self.mtime).strftime("%Y-%m-%d %H:%M")


def read_family(path: str) -> str:
    """Font family label for the dropdown.

    Reads the same name record as nameplate_core.Font.family (nameID 4) but
    lazily, without building a glyph set / cmap / hb font — enumeration stays
    fast even with a folder full of large fonts.
    """
    tt = None
    try:
        tt = TTFont(path, fontNumber=0, lazy=True)
        for rec in tt["name"].names:
            if rec.nameID == 4:
                try:
                    return rec.toUnicode()
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        if tt is not None:
            try:
                tt.close()
            except Exception:
                pass
    return os.path.basename(path)


def scan_fonts() -> list[FontEntry]:
    """Every font file in fonts/ next to the exe, newest file first per family."""
    out: list[FontEntry] = []
    if not os.path.isdir(FONTS_DIR):
        return out
    for name in sorted(os.listdir(FONTS_DIR)):
        if not name.lower().endswith(FONT_EXTS):
            continue
        path = os.path.join(FONTS_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append(FontEntry(path, read_family(path), st.st_mtime, st.st_size))
    # group by family, newest mtime first inside each group (SPEC.md section 4)
    out.sort(key=lambda e: (e.family.lower(), -e.mtime))
    return out


# --------------------------------------------------------------------------- #
#  worker payloads
# --------------------------------------------------------------------------- #
@dataclass
class PreviewResult:
    """Everything the canvas and the info labels need, in doc units."""
    text: str
    cut: list[list[tuple[float, float]]]      # rings, origin at bbox bottom-left
    engrave: list[list[tuple[float, float]]]
    width: float
    height: float
    unit: str
    n_cut: int
    n_engrave: int
    warnings: list[str]
    has_colr: bool
    leadins: list[list[tuple[float, float]]] = field(default_factory=list)
    pieces: int = 1                          # separate loose pieces in the cut
    gap_text: str = ""                       # which junctions failed to join
    # Extra outlines drawn over the artwork for comparison, as
    # [(colour, [polyline, ...], label), ...]. Used to show what the letters or
    # the eyelets WOULD look like at a target thickness, next to how they are
    # now, so the difference is judged by eye rather than from a number.
    overlays: list = field(default_factory=list)
    overlay_note: str = ""
    thin_spots: list = field(default_factory=list)   # ThinSpot, worst first
    thin_text: str = ""                              # one-line summary
    thin_target: float = 0.0                         # 0 = none typed
    # Eyelet measurements for THIS artwork, so the actual/want/change table and
    # the on-canvas dimensions read the same numbers the report does.
    eyelets: list = field(default_factory=list)      # nameplate_eyelets.Eyelet
    eye_target_id: float = 0.0
    eye_target_wall: float = 0.0
    show_eye_dims: bool = False
    show_eye_want: bool = True                       # draw the wanted rings
    eye_error: str = ""                              # why there is no measurement


@dataclass
class FontInfo:
    path: str
    family: str
    has_colr: bool
    ok: bool = True
    error: str = ""
    # result of the automatic check that runs whenever a font is selected
    n_errors: int = 0
    n_warnings: int = 0
    verdict: str = ""                        # short headline for the UI
    issues: list = field(default_factory=list)   # "[ERROR] title" per finding


@dataclass
class ExportJob:
    kind: str                                  # "per-name" | "sheet"
    font_path: str
    names: list[str]
    height: float
    unit: str
    basis: str
    formats: list[str]                         # ["svg"], ["pdf"], or both
    gap: float
    dest: str                                  # zip path, or stem for sheet
    lead_in: bool = False                      # add laser lead-in lines
    lead_len: float = 0.0                      # lead-in length, in `unit`
    lead_clear: float = 0.0                    # standoff from letters, in `unit`
    direction: str = "vertical"                 # sheet layout: vertical|horizontal


# --------------------------------------------------------------------------- #
#  preview worker — one thread, owns its own Font cache
# --------------------------------------------------------------------------- #
class PreviewWorker(QObject):
    ready = Signal(int, object)
    failed = Signal(int, str)
    fontInfoReady = Signal(int, object)

    def __init__(self) -> None:
        super().__init__()
        self._fonts: dict[str, Font] = {}
        self._keys: dict[str, tuple] = {}
        # The newest request id the GUI has asked for. Signals queue up while a
        # build runs, so typing nine characters used to run nine FULL builds and
        # the preview lagged by everything already in the queue. Each job now
        # checks whether a newer one is waiting and skips itself if so -- the
        # answer would have been thrown away on arrival anyway.
        self._newest = 0

    @Slot(int)
    def note_newest(self, req_id: int) -> None:
        self._newest = max(self._newest, int(req_id))

    def _font(self, path: str) -> Font:
        """Cached Font, reopened if the file changed on disk (Refresh support)."""
        try:
            st = os.stat(path)
            key = (st.st_mtime, st.st_size)
        except OSError:
            key = None
        if path not in self._fonts or self._keys.get(path) != key:
            self._fonts[path] = Font(path)
            self._keys[path] = key
        return self._fonts[path]

    @Slot(str)
    def forget(self, path: str) -> None:
        """Drop the cached Font so the next use re-reads the file.

        The mtime/size check above catches a replaced font in practice, but a
        build pipeline that preserves timestamps would slip past it. "Reload
        font" calls this so the newest file on disk is always what gets used.
        """
        if path:
            self._fonts.pop(path, None)
            self._keys.pop(path, None)
        else:
            self._fonts.clear()
            self._keys.clear()

    @Slot(int, str)
    def probe(self, req_id: int, path: str) -> None:
        """Open the font and check it. Runs on the worker thread, so selecting
        a font never blocks the UI while it is inspected."""
        try:
            f = self._font(path)
            info = FontInfo(path, f.family, bool(f.colr))
        except Exception as exc:
            self.fontInfoReady.emit(
                req_id, FontInfo(path, os.path.basename(path), False,
                                 ok=False, error=f"{type(exc).__name__}: {exc}"))
            return
        # automatic check on every font. The letter-pair scan is skipped here
        # (it costs seconds); the "Check font" button runs the full thing.
        try:
            from nameplate_fontcheck import check_font
            rep = check_font(path, join_scan_budget=0.0)
            info.n_errors = len(rep.errors)
            info.n_warnings = len(rep.warnings)
            info.issues = [f"[{fi.severity}] {fi.title}" for fi in rep.sorted()
                           if fi.severity in ("ERROR", "WARNING")]
            info.verdict = ("cannot be used as it is" if rep.errors
                            else (f"{len(rep.warnings)} warning(s)"
                                  if rep.warnings else "no problems found"))
        except Exception as exc:
            info.verdict = f"check failed: {type(exc).__name__}"
        self.fontInfoReady.emit(req_id, info)

    @Slot(int, str, str, float, str, str, bool, float, float, bool, float, float,
          float, bool, bool)
    def build(self, req_id: int, path: str, text: str, height: float, unit: str,
              basis: str, lead_in: bool = False, lead_len: float = 0.0,
              lead_clear: float = 0.0, thin: bool = False,
              thin_target: float = 0.0, eye_target_id: float = 0.0,
              eye_target_wall: float = 0.0, eye_dims: bool = False,
              eye_want: bool = True) -> None:
        if req_id < self._newest:
            return                # a newer request is already queued behind this
        try:
            font = self._font(path)
            doc = build_document(font, text, height, unit, basis)
            s = doc.scale
            x0, y0, _x1, _y1 = doc.bbox
            cut = [[((x - x0) * s, (y - y0) * s) for x, y in ring]
                   for rings in doc.cut_paths for ring in rings]
            eng = [[((x - x0) * s, (y - y0) * s) for x, y in line]
                   for line in doc.engrave_paths]
            leads = []
            if lead_in:
                leads = [[((x - x0) * s, (y - y0) * s) for x, y in line]
                         for line in lead_in_lines(doc, lead_len or None,
                                                   lead_clear or None)]
            # Does this name actually cut as ONE plate? If not, name the
            # junction that broke — that is the actionable part.
            pieces, gap_text = 1, ""
            try:
                import nameplate_leadin as _LI
                from nameplate_fontcheck import describe_gaps, name_gaps
                _p, _d, _m = _LI._analyse(_LI._rings(doc))
                pieces = sum(1 for x in _d if x % 2 == 0)
                if pieces > 1:
                    g = name_gaps(font, text)
                    gap_text = (describe_gaps(g, font.upem, doc.scale) if g
                                else "could not localise the break")
            except Exception:
                pass

            # Thin areas and the "what it would look like" overlays. All of it
            # runs here on the worker thread — the ray casting is far too slow
            # to do while the user is typing.
            overlays, thin_spots, thin_text = [], [], ""
            if thin:
                try:
                    import nameplate_thickness as TH
                    thin_spots = TH.find_thin_spots(doc, font=font)
                    if thin_spots:
                        worst = thin_spots[0]
                        thin_text = (
                            f"thinnest {worst.thickness:.4f} {doc.unit} "
                            f"({worst.thickness_fu:.0f} font units) on "
                            f"{worst.letter}, {worst.where}")
                        if thin_target and thin_target > worst.thickness:
                            rings = TH.thicken_preview(
                                doc, thin_target, worst.thickness)
                            # thicken_preview returns artwork-relative geometry
                            overlays.append((THIN_TARGET, list(rings),
                                             "letters at target thickness"))
                except Exception as exc:
                    thin_text = f"thin-area scan failed: {type(exc).__name__}"

            # ---- eyelets ------------------------------------------------- #
            # Measured here, on the worker thread, whenever the panel needs the
            # numbers: the dimension toggle is on, or a target has been typed.
            # It costs ~150-220 ms, which is too much to spend on every
            # keystroke when nothing is asking for it.
            eyelets, eye_error = [], ""
            if eye_dims or eye_target_id or eye_target_wall:
                try:
                    import nameplate_eyelets as EY
                    eyelets = EY.measure_eyelets(doc)
                    if not eyelets:
                        eye_error = ("no round hole near either end of this "
                                     "name — this font may have no eyelet")
                except Exception as exc:
                    eye_error = f"{type(exc).__name__}: {exc}"

            # The wanted eyelet drawn over the real one, so the difference is
            # judged by eye and not only from a number. Target OD needs both a
            # wanted wall and a diameter to sit around; when only the wall is
            # given the measured hole is used, which is exactly what the report
            # does, so the two can never disagree.
            for e in eyelets:
                cx, cy = e.centre

                def _ring(r, n=96):
                    return [(cx + r * math.cos(2 * math.pi * i / n),
                             cy + r * math.sin(2 * math.pi * i / n))
                            for i in range(n + 1)]

                if not eye_want:
                    break          # measured for the table, just not drawn
                if eye_target_id:
                    overlays.append((EYE_TARGET_ID, [_ring(eye_target_id / 2.0)],
                                     "eyelet at target inner diameter"))
                if eye_target_wall:
                    base_id = eye_target_id or e.inner_d
                    overlays.append(
                        (EYE_TARGET_OD, [_ring(base_id / 2.0 + eye_target_wall)],
                         "eyelet at target outer diameter"))

            # size() is read from the untouched doc, so lead-ins can never
            # affect the height the user sees or the scale used to export
            w, h = doc.size()
            self.ready.emit(req_id, PreviewResult(
                text=doc.text, cut=cut, engrave=eng, width=w, height=h,
                unit=doc.unit, n_cut=sum(len(r) for r in doc.cut_paths),
                n_engrave=len(doc.engrave_paths), warnings=list(doc.warnings),
                has_colr=bool(font.colr), leadins=leads,
                pieces=pieces, gap_text=gap_text,
                overlays=overlays, thin_spots=thin_spots,
                thin_text=thin_text, thin_target=thin_target,
                eyelets=eyelets, eye_target_id=eye_target_id,
                eye_target_wall=eye_target_wall, show_eye_dims=eye_dims,
                show_eye_want=eye_want, eye_error=eye_error))
        except Exception as exc:
            # never a dialog from this thread; the GUI thread shows it
            where = crash_report("PreviewWorker.build", exc)
            self.failed.emit(req_id, f"{type(exc).__name__}: {exc}"
                             + (f" (details: {os.path.basename(where)})"
                                if where else ""))


# --------------------------------------------------------------------------- #
#  report worker — the slow, click-driven analyses, off the GUI thread
# --------------------------------------------------------------------------- #
class ReportWorker(QObject):
    """Runs the checks that take seconds, so the window keeps painting.

    Measured freezes before this existed, on the slowest shipped font: "Check
    font" 9.9 s, "Generate prompts" 8.8 s, "View every letter pair" 3.5 s — all
    on the GUI thread under a wait cursor, long enough for Windows to paint
    "Not Responding" over the app.

    Deliberately NOT the preview thread: a ten-second font check queued there
    would starve the previews that run while you type.

    Each job opens its OWN Font and hands it back with the result. That is an
    ownership transfer, not sharing — the worker never touches it again, which
    keeps the engine's "Font objects are not thread-safe" rule intact while
    still letting the pair-sheet dialog draw glyphs from it.
    """

    ready = Signal(int, str, object)
    failed = Signal(int, str, str)

    @Slot(int, str, str, str, float, str, str, float, float, float)
    def run(self, req_id: int, kind: str, path: str, name: str, height: float,
            unit: str, basis: str, thin_target: float, eye_id: float,
            eye_wall: float) -> None:
        try:
            out = self._do(kind, path, name, height, unit, basis, thin_target,
                           eye_id, eye_wall)
        except Exception as exc:
            # A worker thread must not touch a widget. Write the report here and
            # hand a plain string to the GUI thread, which owns the dialogs.
            where = crash_report(f"ReportWorker.{kind}", exc)
            self.failed.emit(req_id, kind,
                             f"{type(exc).__name__}: {exc}"
                             + (f"\n\nFull details written to {where}"
                                if where else ""))
            return
        self.ready.emit(req_id, kind, out)

    def _do(self, kind, path, name, height, unit, basis, thin_target, eye_id,
            eye_wall):
        from nameplate_core import Font as _F, build_document as _bd

        if kind == "check":
            from nameplate_fontcheck import check_font as _cf
            rep = _cf(path)
            return {"text": rep.text(), "prompt": rep.claude_prompt()}

        if kind == "pairs":
            import nameplate_pairsheet as PS
            font = _F(path)
            rep = PS.analyse_pairs(font)
            try:
                prompt = PS.claude_prompt(font, rep, path)
            except Exception as exc:
                prompt = (f"(could not build the copy-paste instruction: "
                          f"{type(exc).__name__}: {exc})")
            return {"font": font, "report": rep, "prompt": prompt}

        if kind == "thickness":
            import nameplate_thickness as TH
            font = _F(path)
            doc = _bd(font, name, height, unit, basis)
            target = thin_target or None
            text = TH.report_text(doc, target=target, font=font)
            prompt = ""
            if target:
                try:
                    prompt = TH.claude_prompt(doc, target, font_path=path,
                                              font=font)
                except Exception as exc:
                    prompt = (f"(could not build the copy-paste instruction: "
                              f"{type(exc).__name__}: {exc})")
            return {"text": text, "prompt": prompt}

        if kind == "eyelets":
            from nameplate_eyelets import report_text
            doc = _bd(_F(path), name, height, unit, basis)
            return {"text": report_text(doc, target_id=eye_id or None,
                                        target_wall=eye_wall or None)}

        if kind == "prompts":
            return {"sections": _prompt_sections(path, name, height, unit,
                                                 basis, thin_target, eye_id,
                                                 eye_wall)}

        raise ValueError(f"unknown report kind {kind!r}")


def _prompt_sections(path, name, height, unit, basis, thin_target, eye_id,
                     eye_wall):
    """The four paste-ready prompt blocks. Pure computation, no widgets.

    Lives at module level so both the worker thread and --selftest can call it
    without a MainWindow, and so the GUI and nameplate_brief.py cannot drift
    into producing different prompts for the same font.
    """
    from nameplate_core import Font as _F, build_document as _bd

    sections: list[tuple[str, str, str]] = []
    font, doc, doc_err = None, None, ""
    try:
        font = _F(path)
        if name:
            doc = _bd(font, name, height, unit, basis)
    except Exception as exc:
        doc_err = f"{type(exc).__name__}: {exc}"

    # 1. the font itself
    body, note = "", ""
    try:
        from nameplate_fontcheck import check_font as _cf
        rep = _cf(path)
        if rep.errors or rep.warnings:
            body = rep.claude_prompt()
            note = f"{len(rep.errors)} error(s), {len(rep.warnings)} warning(s)."
        else:
            note = "Checked - no errors and no warnings in this font."
    except Exception as exc:
        note = f"The font check itself failed: {type(exc).__name__}: {exc}"
    sections.append(("1. Font defects", note, body))

    # 2. letter pairs
    body, note = "", ""
    try:
        import nameplate_pairsheet as PS
        if font is None:
            note = f"The font could not be opened: {doc_err}"
        else:
            prep = PS.analyse_pairs(font)
            bad = sum(1 for g in prep.groups for c in g.cells.values()
                      if getattr(c, "problem", False))
            untested = int(getattr(prep, "n_untested", 0) or 0)
            if bad or untested:
                body = PS.claude_prompt(font, prep, path)
                note = f"{bad} letter pair(s) do not join."
                if untested:
                    note += (f" {untested} were never tested - the scan ran out "
                             f"of time, so this list may be incomplete.")
            else:
                note = ("Every letter pair joins cleanly, in every position "
                        "(whole word, first letter, middle, last letter).")
    except Exception as exc:
        note = f"The pair scan failed: {type(exc).__name__}: {exc}"
    sections.append(("2. Letter pairs that do not join", note, body))

    # 3. thin areas
    body, note = "", ""
    target = thin_target or 0.0
    if doc is None:
        note = (f"Type a name first - thin areas are measured on the artwork."
                f"{(' ' + doc_err) if doc_err else ''}")
    elif not target:
        note = ("Type a wanted thickness in “Thin areas” to get this. "
                "Without a target there is no change to ask for.")
    else:
        try:
            import nameplate_thickness as TH
            body = TH.claude_prompt(doc, target, font_path=path, font=font)
            note = (f"Wanted thickness {target:.4f} {unit}, measured on "
                    f"{name!r} at {height:g} {unit}.")
        except Exception as exc:
            note = f"Could not build it: {type(exc).__name__}: {exc}"
    sections.append(("3. Thin areas to thicken", note, body))

    # 4. eyelet size
    body, note = "", ""
    t_id = eye_id or None
    t_wall = eye_wall or None
    if doc is None:
        note = (f"Type a name first - the eyelet is a contextual form on the "
                f"first and last letter, so it only exists once a name is "
                f"shaped.{(' ' + doc_err) if doc_err else ''}")
    elif t_id is None and t_wall is None:
        note = ("Type a wanted inner diameter or wall in “Eyelets” to "
                "get this.")
    else:
        try:
            import nameplate_eyelets as EY
            body = EY.claude_prompt(doc, target_id=t_id, target_wall=t_wall,
                                    font_path=path)
            note = f"Measured on {name!r} at {height:g} {unit} {basis} height."
            if not body:
                note += "  No eyelet was found in this name."
        except Exception as exc:
            note = f"Could not build it: {type(exc).__name__}: {exc}"
    sections.append(("4. Eyelet size", note, body))

    # The blocks OVERLAP and their fences contradict each other if pasted as a
    # batch: block 4 resizes the eyelet holes while blocks 1 and 3 forbid
    # touching them. Say so where it cannot be missed.
    if sections[3][2]:
        for i in (0, 2):
            title, note_i, body_i = sections[i]
            if body_i:
                sections[i] = (title, note_i, body_i + (
                    os.linesep * 2
                    + "EXCEPTION: a separate eyelet-size request from this "
                      "same report resizes the eyelet holes. For those holes, "
                      "that request wins over the 'do not change' rule above."))
    return sections


# --------------------------------------------------------------------------- #
#  export worker — fresh thread and fresh Font per job
# --------------------------------------------------------------------------- #
class ExportWorker(QObject):
    progress = Signal(int, int, str)          # done, total, label
    finished = Signal(list)                   # written paths
    failed = Signal(str)

    def __init__(self, job: ExportJob) -> None:
        super().__init__()
        self.job = job
        self._cancel = False

    def cancel(self) -> None:
        self._cancel = True

    @Slot()
    def run(self) -> None:
        job = self.job
        try:
            font = Font(job.font_path)        # this thread's own Font
            total = len(job.names) + 1
            docs = []
            for i, name in enumerate(job.names):
                if self._cancel:
                    self.failed.emit("Export cancelled.")
                    return
                self.progress.emit(i, total, name)
                docs.append(build_document(font, name, job.height,
                                           job.unit, job.basis))
            self.progress.emit(len(job.names), total, "writing files")

            lead = job.lead_len if job.lead_in else None
            clr = job.lead_clear or None
            written: list[str] = []
            if job.kind == "sheet":
                stem = job.dest
                clash = overlaps(docs, job.gap, job.direction)
                if clash:
                    names = ", ".join(f"{docs[i].text!r}+{docs[j].text!r}"
                                      for i, j in clash[:4])
                    raise ValueError(
                        f"With this gap the names would overlap on the sheet "
                        f"({names}). Increase the sheet gap.")
                # nameplate_export writes in CUTTING order — engrave, then the
                # inner holes, then the outline last, per name — and gives each
                # name its own SVG group / PDF layer.
                if "svg" in job.formats:
                    p = stem + ".svg"
                    with open(p, "w", encoding="utf-8") as fh:
                        fh.write(export_svg(docs, job.gap, job.direction,
                                            lead, clr))
                    written.append(p)
                if "pdf" in job.formats:
                    p = stem + ".pdf"
                    with open(p, "wb") as fh:
                        fh.write(export_pdf(docs, job.gap, job.direction,
                                            lead, clr))
                    written.append(p)
            else:
                used: dict[str, int] = {}
                with zipfile.ZipFile(job.dest, "w", zipfile.ZIP_DEFLATED) as zf:
                    for doc in docs:
                        stem = safe_filename(doc.text)
                        n = used.get(stem.lower(), 0) + 1
                        used[stem.lower()] = n
                        if n > 1:                      # two identical lines
                            stem = f"{stem}_{n}"
                        if "svg" in job.formats:
                            zf.writestr(stem + ".svg",
                                        export_svg([doc], job.gap,
                                                   job.direction, lead, clr))
                        if "pdf" in job.formats:
                            zf.writestr(stem + ".pdf",
                                        export_pdf([doc], job.gap,
                                                   job.direction, lead, clr))
                written.append(job.dest)
            self.progress.emit(total, total, "done")
            self.finished.emit(written)
        except Exception as exc:
            self.failed.emit(f"{type(exc).__name__}: {exc}\n\n"
                             + traceback.format_exc(limit=4))


# --------------------------------------------------------------------------- #
#  preview canvas
# --------------------------------------------------------------------------- #
class PreviewCanvas(QWidget):
    """Draws doc.cut_paths / doc.engrave_paths directly — never renders the SVG.

    Font units point y up, screen y points down, so the paint transform flips.
    Zoom is expressed relative to fit, so the artwork can never end up lost off
    screen when the name or height changes.
    """

    def __init__(self) -> None:
        super().__init__()
        self.setMinimumSize(360, 280)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setAutoFillBackground(True)
        self._res: PreviewResult | None = None
        self._zoom = 1.0
        self._pan = QPointF(0, 0)
        self._drag: QPointF | None = None
        self._placeholder = "Type a name to see the cut file"
        self.setCursor(Qt.OpenHandCursor)

    # -- data ------------------------------------------------------------- #
    def set_result(self, res: PreviewResult | None) -> None:
        self._res = res
        self.update()

    def set_placeholder(self, text: str) -> None:
        self._placeholder = text
        self.update()

    def reset_view(self) -> None:
        self._zoom = 1.0
        self._pan = QPointF(0, 0)
        self.update()

    # -- mapping ---------------------------------------------------------- #
    def _fit(self) -> float:
        res = self._res
        pad = 56.0
        aw = max(self.width() - 2 * pad, 20.0)
        ah = max(self.height() - 2 * pad, 20.0)
        if not res or res.width <= 0 or res.height <= 0:
            return 1.0
        return min(aw / res.width, ah / res.height)

    def _t(self) -> tuple[float, float, float]:
        k = self._fit() * self._zoom
        return k, self.width() / 2 + self._pan.x(), self.height() / 2 + self._pan.y()

    def _to_screen(self, x: float, y: float, k: float,
                   cx: float, cy: float) -> tuple[float, float]:
        res = self._res
        return (cx + (x - res.width / 2) * k,
                cy - (y - res.height / 2) * k)          # flip y

    # -- annotation helpers ----------------------------------------------- #
    def _label(self, p, sx: float, sy: float, text: str, colour: str,
               taken: list, anchor: str = "above") -> bool:
        """Draw one small label with a white backing, unless it would collide.

        Returns False when it was skipped. Numbers that sit on top of each other
        are worse than no numbers at all, so at low zoom the crowded ones drop
        out and the coloured marks alone carry the picture.
        """
        from PySide6.QtCore import QRectF
        fm = p.fontMetrics()
        w = fm.horizontalAdvance(text) + 6
        h = fm.height() + 1
        if anchor == "above":
            r = QRectF(sx - w / 2, sy - h - 3, w, h)
        elif anchor == "below":
            r = QRectF(sx - w / 2, sy + 3, w, h)
        elif anchor == "right":
            r = QRectF(sx + 4, sy - h / 2, w, h)
        else:
            r = QRectF(sx - w - 4, sy - h / 2, w, h)
        # A number half off the edge of the canvas is worse than useless, so it
        # is pulled back inside rather than clipped.
        if r.right() > self.width() - 2:
            r.moveRight(self.width() - 2)
        if r.left() < 2:
            r.moveLeft(2)
        if r.bottom() > self.height() - 2:
            r.moveBottom(self.height() - 2)
        if r.top() < 2:
            r.moveTop(2)
        for other in taken:
            if r.intersects(other):
                return False
        taken.append(r)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(255, 255, 255, 222))
        p.drawRect(r)
        p.setBrush(Qt.NoBrush)
        p.setPen(QColor(colour))
        p.drawText(r, Qt.AlignCenter, text)
        return True

    def _dim(self, p, a: tuple[float, float], b: tuple[float, float],
             text: str, colour: str, k: float, cx: float, cy: float,
             taken: list, anchor: str = "above", at: str = "mid") -> None:
        """A measured distance between two doc-space points: line, end ticks, label.

        Ticks are a fixed number of screen pixels, not doc units, so they stay
        legible at every zoom instead of vanishing or swamping the artwork.
        """
        import math as _m
        ax, ay = self._to_screen(a[0], a[1], k, cx, cy)
        bx, by = self._to_screen(b[0], b[1], k, cx, cy)
        dx, dy = bx - ax, by - ay
        L = _m.hypot(dx, dy)
        if L < 1.0:
            return
        ux, uy = dx / L, dy / L
        nx, ny = -uy, ux                       # unit normal, in screen space
        pen = QPen(QColor(colour), 1.6)
        pen.setCosmetic(True)
        pen.setCapStyle(Qt.FlatCap)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        p.drawLine(QPointF(ax, ay), QPointF(bx, by))
        for (px, py) in ((ax, ay), (bx, by)):
            p.drawLine(QPointF(px - nx * 4, py - ny * 4),
                       QPointF(px + nx * 4, py + ny * 4))
        # `at="end"` labels the b end instead of the middle. Two dimensions that
        # share a centre — an inner and an outer diameter through the same hole —
        # both want the middle, and the second one silently lost its label to the
        # collision check, leaving a measured line with no number on it.
        lx, ly = ((bx, by) if at == "end" else ((ax + bx) / 2, (ay + by) / 2))
        self._label(p, lx, ly, text, colour, taken, anchor)

    @staticmethod
    def thin_label(rank: int, spot, unit: str) -> str:
        """The text on one thin-area mark: its rank, then how thick it is.

        Written "#7 · 0.0889 in", never "7. 0.0889 in". The rank used to be a
        number and a full stop, which ran straight into the decimal that
        followed: a 0.0889 in serif read as a 7.0889 in one, on a part whose
        whole height is 1 in. The hash and the separator make the rank a label
        rather than a digit of the measurement.
        """
        return f"#{rank} · {getattr(spot, 'thickness', 0.0):.4f} {unit}"

    @staticmethod
    def _thin_colour(spot, worst: float, thickest: float, target: float) -> str:
        """Severity colour for one thin spot.

        With a target typed the question is pass/fail and by how far, so the
        bands are fixed fractions of the target — the colour then means the same
        thing in every font.

        With no target there is nothing absolute to grade against, so the spots
        are spread across the ramp between the thinnest and the least thin of
        THIS name. Fixed ratios were tried first and were useless: a font whose
        thin places are all within 5% of each other came out one flat colour,
        which is exactly the case where you most need to see which is worst.
        """
        t = getattr(spot, "thickness", 0.0) or 0.0
        if target and target > 0:
            r = t / target
            if r >= 1.0:
                return THIN_OK
            return (THIN_RAMP[0] if r < 0.75 else
                    THIN_RAMP[1] if r < 0.9 else THIN_RAMP[2])
        if worst <= 0 or thickest <= worst:
            return THIN_RAMP[0]
        frac = (t - worst) / (thickest - worst)          # 0 = worst, 1 = least
        i = int(frac * len(THIN_RAMP))
        return THIN_RAMP[min(len(THIN_RAMP) - 1, max(0, i))]

    # -- interaction ------------------------------------------------------ #
    def wheelEvent(self, ev) -> None:
        if not self._res:
            return
        pos = ev.position()
        k0, cx0, cy0 = self._t()
        ux = (pos.x() - cx0) / k0 + self._res.width / 2
        uy = (cy0 - pos.y()) / k0 + self._res.height / 2
        self._zoom = max(0.05, min(80.0, self._zoom * (1.0015 ** ev.angleDelta().y())))
        k1, cx1, cy1 = self._t()
        sx, sy = self._to_screen(ux, uy, k1, cx1, cy1)
        self._pan += QPointF(pos.x() - sx, pos.y() - sy)
        self.update()

    def mousePressEvent(self, ev) -> None:
        if ev.button() == Qt.LeftButton:
            self._drag = ev.position()
            self.setCursor(Qt.ClosedHandCursor)

    def mouseMoveEvent(self, ev) -> None:
        if self._drag is not None:
            self._pan += ev.position() - self._drag
            self._drag = ev.position()
            self.update()

    def mouseReleaseEvent(self, ev) -> None:
        self._drag = None
        self.setCursor(Qt.OpenHandCursor)

    def mouseDoubleClickEvent(self, ev) -> None:
        self.reset_view()

    # -- painting --------------------------------------------------------- #
    def paintEvent(self, _ev) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.fillRect(self.rect(), QColor("#ffffff"))

        res = self._res
        if not res or not res.cut:
            p.setPen(QColor("#9aa0a6"))
            f = p.font()
            f.setPointSizeF(f.pointSizeF() + 1)
            p.setFont(f)
            p.drawText(self.rect(), Qt.AlignCenter, self._placeholder)
            return

        k, cx, cy = self._t()

        # faint bounding box + physical size labels
        x0, y0 = self._to_screen(0, res.height, k, cx, cy)
        x1, y1 = self._to_screen(res.width, 0, k, cx, cy)
        box = QPen(QColor("#c9ced4"), 1, Qt.DashLine)
        box.setCosmetic(True)
        p.setPen(box)
        p.drawRect(x0, y0, x1 - x0, y1 - y0)

        small = QtGuiFont(p.font())
        small.setPointSizeF(max(7.5, small.pointSizeF() - 0.5))
        p.setFont(small)
        p.setPen(QColor("#6b7177"))
        p.drawText(x0, y1 + 6, x1 - x0, 18, Qt.AlignHCenter | Qt.AlignTop,
                   f"{res.width:.3f} {res.unit}")
        p.save()
        p.translate(x0 - 8, (y0 + y1) / 2)
        p.rotate(-90)
        p.drawText(-60, -14, 120, 16, Qt.AlignHCenter | Qt.AlignBottom,
                   f"{res.height:.3f} {res.unit}")
        p.restore()

        # CUT — black hairline, closed
        pen = QPen(QColor("#000000"), 1.3)
        pen.setCosmetic(True)
        pen.setJoinStyle(Qt.RoundJoin)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        for ring in res.cut:
            if len(ring) < 2:
                continue
            pts = [self._to_screen(x, y, k, cx, cy) for x, y in ring]
            poly = [QPointF(a, b) for a, b in pts]
            p.drawPolygon(poly)

        # LEAD-INS — they cut, so they are black like the outline. A small ring
        # marks the pierce point so it is obvious which end starts in scrap.
        if res.leadins:
            pen = QPen(QColor("#000000"), 1.3)
            pen.setCosmetic(True)
            pen.setCapStyle(Qt.FlatCap)
            p.setPen(pen)
            for line in res.leadins:
                if len(line) < 2:
                    continue
                pts = [self._to_screen(x, y, k, cx, cy) for x, y in line]
                p.drawPolyline([QPointF(a, b) for a, b in pts])
            pen = QPen(QColor(NEON), 1.2)
            pen.setCosmetic(True)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            for line in res.leadins:
                if len(line) < 2:
                    continue
                sx, sy = self._to_screen(line[0][0], line[0][1], k, cx, cy)
                p.drawEllipse(QPointF(sx, sy), 2.6, 2.6)

        # COMPARISON OVERLAYS — what it would look like at a target size, drawn
        # over the real artwork in its own colour so both can be judged at once.
        for entry in (res.overlays or []):
            try:
                colour, lines = entry[0], entry[1]
            except Exception:
                continue
            pen = QPen(QColor(colour), 1.5)
            pen.setCosmetic(True)
            pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            for line in lines:
                if len(line) < 2:
                    continue
                pts = [self._to_screen(x, y, k, cx, cy) for x, y in line]
                p.drawPolyline([QPointF(a, b) for a, b in pts])

        # ENGRAVE — red, open centerlines
        pen = QPen(QColor("#ff0000"), 1.3)
        pen.setCosmetic(True)
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        for line in res.engrave:
            if len(line) < 2:
                continue
            pts = [self._to_screen(x, y, k, cx, cy) for x, y in line]
            p.drawPolyline([QPointF(a, b) for a, b in pts])

        # ---- measurements, drawn last so they are never hidden ---------- #
        p.setFont(small)
        taken: list = []            # label rectangles already used, for collision
        legend: list = []           # (colour, text) for the corner key

        # EYELET DIMENSIONS — inner diameter across, outer diameter down, and the
        # wall at the exact point where it is thinnest, which is the spot that
        # tears out. Only when asked for: it is measurement, not artwork.
        if res.show_eye_dims and res.eyelets:
            import math as _m
            for e in res.eyelets:
                ex, ey = e.centre
                ri, ro = e.inner_d / 2.0, e.outer_d / 2.0
                self._dim(p, (ex - ri, ey), (ex + ri, ey),
                          f"ID {e.inner_d:.4f} {res.unit}", EYE_DIM,
                          k, cx, cy, taken, "above")
                self._dim(p, (ex, ey - ro), (ex, ey + ro),
                          f"OD {e.outer_d:.4f} {res.unit}", EYE_DIM,
                          k, cx, cy, taken, "above", at="end")
                at = e.wall_min_at
                if at:
                    vx, vy = at[0] - ex, at[1] - ey
                    L = _m.hypot(vx, vy) or 1.0
                    ux, uy = vx / L, vy / L
                    self._dim(p, at,
                              (at[0] + ux * e.wall_min, at[1] + uy * e.wall_min),
                              f"wall {e.wall_min:.4f} {res.unit}", EYE_DIM,
                              k, cx, cy, taken, "right")
            legend.append((EYE_DIM, "eyelet as measured"))
        if res.show_eye_want and res.eye_target_id:
            legend.append((EYE_TARGET_ID,
                           f"wanted ID {res.eye_target_id:.4f} {res.unit}"))
        if res.show_eye_want and res.eye_target_wall:
            legend.append((EYE_TARGET_OD,
                           f"wanted wall {res.eye_target_wall:.4f} {res.unit}"))

        # THIN AREAS — the measured crossing at each thin place, in a colour
        # graded by how thin it is, with the distance on it. Worst first, so if
        # labels have to be dropped for space it is the least bad ones that go.
        if res.thin_spots:
            ts = [(getattr(s, "thickness", 0.0) or 0.0) for s in res.thin_spots]
            worst, thickest = min(ts), max(ts)
            for i, spot in enumerate(res.thin_spots, 1):
                across = getattr(spot, "across", None)
                if not across or len(across) != 2:
                    continue
                colour = self._thin_colour(spot, worst, thickest,
                                           res.thin_target)
                self._dim(p, across[0], across[1],
                          self.thin_label(i, spot, res.unit), colour,
                          k, cx, cy, taken, "right")
            if res.thin_target:
                legend.append((THIN_RAMP[0], "thinner than wanted"))
                legend.append((THIN_OK, "meets the wanted thickness"))
                legend.append((THIN_TARGET, "letters at the wanted thickness"))
            else:
                legend.append((THIN_RAMP[0], "thinnest"))
                legend.append((THIN_RAMP[-1], "less thin"))

        # LEGEND — a plain key in the corner. Colour alone is not readable when
        # four kinds of mark can be on screen at once.
        if legend:
            # Laid out from the parts rather than from a guessed total: the box
            # used to be sized from the text width and the text then drawn in a
            # rect that started after the colour swatch, so every label lost the
            # last few characters — "thinnest" read as "thinnes".
            fm = p.fontMetrics()
            x0, pad, sw, gap = 8, 7, 16, 7
            tx = x0 + pad + sw + gap
            adv = max(fm.horizontalAdvance(t) for _c, t in legend)
            wide = (tx - x0) + adv + pad
            hgt = len(legend) * (fm.height() + 2) + 2 * pad
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 255, 255, 232))
            p.drawRect(x0, x0, wide, hgt)
            p.setBrush(Qt.NoBrush)
            pen = QPen(QColor("#dfe3e8"), 1)
            pen.setCosmetic(True)
            p.setPen(pen)
            p.drawRect(x0, x0, wide, hgt)
            yy = x0 + pad
            for colour, text in legend:
                pen = QPen(QColor(colour), 2.4)
                pen.setCosmetic(True)
                p.setPen(pen)
                p.drawLine(QPointF(x0 + pad, yy + fm.height() / 2),
                           QPointF(x0 + pad + sw, yy + fm.height() / 2))
                p.setPen(QColor("#3c4043"))
                p.drawText(tx, yy, adv + 2, fm.height(),
                           Qt.AlignLeft | Qt.AlignVCenter, text)
                yy += fm.height() + 2


# --------------------------------------------------------------------------- #
#  letter-pair grid — every two-letter combination, on one scrollable page
# --------------------------------------------------------------------------- #
class PairGrid(QWidget):
    """Every letter pair, in every position it can occupy in a name.

    FOUR ROWS PER LETTER, because these fonts swap the glyph by position and a
    pair that joins in one position can break in another:

        Xa Xb Xc ...      capital + lowercase, as a WHOLE word
        xa xb xc ...      lowercase + lowercase, as a WHOLE word
        Axaa Axba ...      lowercase + lowercase in the MIDDLE of a word
        AXaa AXba ...      capital + lowercase in the MIDDLE of a word

    A two-letter word puts its first letter in the INITIAL form — the one that
    carries the eyelet — and its last letter in the FINAL form, so the top two
    rows are where the eyelet ends get checked. The middle rows wrap the pair in
    A...a so both letters take their MEDIAL forms, which is what most letters of
    most names actually use. Shaping 'ab' gives A.ini + B.e0; the same pair
    inside 'Aaba' gives A.e0 + B.e0 — different outlines, and only the second
    kind appears in the middle of a name.

    Painted from the glyph outlines, never through a text API, so what you see
    is the font itself — no hinting, no gridfitting, no synthetic weight. It is
    the same thing Illustrator shows once text is converted to outlines, shaped
    by the same engine, so the overlaps are the real ones. Hover a cell for the
    shaped glyph names, which is how you confirm which positional form you are
    looking at.

    Only the cells inside the viewport are painted. All 2704 every frame would
    crawl; culling keeps scrolling smooth.
    """

    BASE_CELL = 132
    PAD = 10
    ZOOMS = (0.30, 0.40, 0.55, 0.75, 1.00, 1.35, 1.80, 2.40)

    # (group key, how to make the row's left character from the letter)
    # Order matters: it is the order the rows appear down the sheet, and it runs
    # through the positions a pair can occupy in a real name:
    #   whole word (both ends carry eyelets) -> first letter -> middle -> last
    ROW_SPECS = (("caplower", "upper"), ("lower", "lower"),
                 ("firstcaplower", "upper"), ("firstlower", "lower"),
                 ("midcaplower", "upper"), ("midlower", "lower"),
                 ("lastlower", "lower"))

    # How many em of width a cell of each mode has to hold: a whole word is two
    # letters, a first/last test is three, a middle test is four. One scale for
    # all of them drew the four-letter cells straight through their neighbours.
    _EM_PER_MODE = {"start": 2.05, "first": 3.2, "last": 3.2, "middle": 4.3}
    _MODE_OF = {"caplower": "start", "lower": "start", "caps": "start",
                "firstlower": "first", "firstcaplower": "first",
                "lastlower": "last",
                "midlower": "middle", "midcaplower": "middle"}

    def __init__(self, font, report, alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
        super().__init__()
        self.font_obj = font
        self.report = report
        self.alphabet = alphabet
        # Which groups did the analyser actually produce? An older report, or a
        # run with --groups, may not have the middle-of-word ones, and a row
        # with no data behind it would just be 26 empty boxes.
        have = {getattr(g, "key", "") for g in (getattr(report, "groups", None)
                                                or [])}
        # (group_key, left_char) per row
        self.rows: list[tuple[str, str]] = []
        for ch in alphabet:
            for key, case in self.ROW_SPECS:
                if key in have:
                    self.rows.append((key, ch.upper() if case == "upper"
                                      else ch.lower()))
        if not self.rows:                  # nothing recognised - show what we can
            self.rows = [("", ch) for ch in alphabet]
        self.cols = [c.lower() for c in alphabet]
        self._lookup = self._index(report)
        self._paths: dict[str, object] = {}
        self._zoom = 1.0
        self.CELL = self.BASE_CELL
        self._current: tuple[int, int] | None = None
        self._scale, self._org = self._one_scale()
        self._resize_to_zoom()
        self.setAutoFillBackground(True)

    def set_current(self, cell) -> None:
        self._current = cell
        self.update()

    # -- zoom ---------------------------------------------------------- #
    def _resize_to_zoom(self) -> None:
        self.CELL = max(24, int(round(self.BASE_CELL * self._zoom)))
        self._scale, self._org = self._one_scale()
        self.setFixedSize(len(self.cols) * self.CELL,
                          len(self.rows) * self.CELL)
        self.update()

    def zoom_steps(self) -> tuple:
        return self.ZOOMS

    def set_zoom(self, z: float) -> None:
        self._zoom = max(self.ZOOMS[0], min(self.ZOOMS[-1], float(z)))
        self._resize_to_zoom()

    def zoom(self) -> float:
        return self._zoom

    def zoom_by(self, step: int) -> float:
        """Move one notch along the zoom ladder and return the new zoom."""
        cur = min(range(len(self.ZOOMS)),
                  key=lambda i: abs(self.ZOOMS[i] - self._zoom))
        self.set_zoom(self.ZOOMS[max(0, min(len(self.ZOOMS) - 1, cur + step))])
        return self._zoom

    # -- the flagged pairs, in reading order --------------------------- #
    def flagged_cells(self) -> list[tuple[int, int, object]]:
        """Every flagged pair as (row, col, result), left to right, top to bottom.

        Reading order, not the order the analyser happened to produce, so
        stepping through them with the arrows matches what the eye does.
        """
        out = []
        for ri, (group, left) in enumerate(self.rows):
            for ci, right in enumerate(self.cols):
                res = self._lookup.get((group, left, right))
                if res is not None and getattr(res, "problem", False):
                    out.append((ri, ci, res))
        return out

    def cell_at(self, x: float, y: float):
        """(row, col) under a widget position, or None."""
        ci, ri = int(x) // self.CELL, int(y) // self.CELL
        if 0 <= ri < len(self.rows) and 0 <= ci < len(self.cols):
            return ri, ci
        return None

    def describe(self, ri: int, ci: int) -> str:
        """What a cell is, in words — the tooltip.

        The glyph NAMES are the point. They are the only way to see that a cell
        is showing A.ini rather than A.e0, i.e. that the positional form you
        think you are checking is the one the font actually used.
        """
        group, left = self.rows[ri]
        right = self.cols[ci]
        res = self.result(group, left, right)
        L = [f"<b>{(getattr(res, 'shown', None) or (left + right))}</b>",
             self.row_label(ri).replace("?", right)]
        if res is None:
            L.append("not analysed")
            return "<br>".join(L)
        L.append(f"status: <b>{getattr(res, 'status', '?')}</b>")
        gap = getattr(res, "gap_em", None)
        if gap:
            L.append(f"gap: {gap:.4f} em")
        if getattr(res, "glyphs", None):
            span = getattr(res, "span", None)
            names = []
            for i, g in enumerate(res.glyphs):
                names.append(f"<b>{g}</b>" if span and span[0] <= i <= span[1]
                             else g)
            L.append("shaped as: " + " + ".join(names)
                     + ("  (the pair under test in bold)" if span else ""))
        if getattr(res, "detail", ""):
            L.append(res.detail)
        return "<br>".join(L)

    def mouseMoveEvent(self, ev):
        from PySide6.QtWidgets import QToolTip
        pos = ev.position()
        cell = self.cell_at(pos.x(), pos.y())
        if cell is None:
            QToolTip.hideText()
            return
        if cell != getattr(self, "_hover", None):
            self._hover = cell
            QToolTip.showText(ev.globalPosition().toPoint(),
                              self.describe(*cell), self)

    def cell_rect(self, ri: int, ci: int):
        from PySide6.QtCore import QRect
        return QRect(ci * self.CELL, ri * self.CELL, self.CELL, self.CELL)

    # -- data ---------------------------------------------------------- #
    @staticmethod
    def _index(report):
        """(group key, left, right) -> PairResult.

        The GROUP has to be part of the key. It did not used to be, because no
        two groups could contain the same (left, right) — 'a','b' was only ever
        in the lowercase group. The middle-of-word groups changed that: 'a','b'
        now exists as both a whole word and as the middle of one, and merging on
        (left, right) alone silently threw one of the two measurements away.
        """
        out = {}
        for grp in (getattr(report, "groups", None) or []):
            gk = getattr(grp, "key", "")
            for key, res in (getattr(grp, "cells", None) or {}).items():
                out[(gk,) + tuple(key)] = res
        return out

    def n_flagged(self) -> int:
        """Flagged cells that this grid actually shows."""
        return len(self.flagged_cells())

    def result(self, group, left, right):
        return self._lookup.get((group, left, right))

    def row_label(self, ri: int) -> str:
        """What the row is testing, for the header strip and the tooltip."""
        group, left = self.rows[ri]
        whole = (f"{left}? as a WHOLE WORD - {left} takes the INITIAL "
                 f"(eyelet) form and ? the FINAL (eyelet) form")
        first = (f"{left}?a - the FIRST LETTER of a longer name: {left} keeps "
                 f"its INITIAL (eyelet) form but ? is MEDIAL, which is a "
                 f"different glyph from the whole-word row above")
        last = (f"A{left}? - the LAST LETTER of a longer name: {left} is "
                f"MEDIAL and ? takes the FINAL (eyelet) form")
        middle = (f"A{left}?a - both letters MEDIAL, no eyelet, as in the "
                  f"middle of a name")
        return {"caplower": whole, "lower": whole,
                "firstlower": first, "firstcaplower": first,
                "lastlower": last,
                "midlower": middle, "midcaplower": middle}.get(group,
                                                               f"{left}?")

    def _one_scale(self):
        """One scale per ROW WIDTH, so cell sizes stay comparable.

        Derived from the em rather than from each pair, because fitting every
        cell to its own box would make an 'i' look as big as a 'W' and hide the
        very differences worth looking at. Two scales, not one: a middle-of-word
        cell holds four letters, and forcing it into the two-letter scale drew it
        straight through its neighbours.
        """
        upem = float(getattr(self.font_obj, "upem", 1000) or 1000)
        inner = self.CELL - 2 * self.PAD
        self._scale_by_mode = {m: inner / (upem * em)
                               for m, em in self._EM_PER_MODE.items()}
        self._scale_wide = self._scale_by_mode["middle"]   # kept for the tests
        # two letters side by side, plus room for ascenders and descenders
        return inner / (upem * 2.05), upem

    def _scale_for(self, group: str) -> float:
        mode = self._MODE_OF.get(group, "start")
        return self._scale_by_mode.get(mode, self._scale)

    def _path(self, glyph):
        """Cached QPainterPath for one glyph, all contours, even-odd.

        Every contour of the glyph goes in ONE path so counters stay open. The
        two glyphs of a pair stay in SEPARATE paths — one shared even-odd path
        would punch their overlap out as a white hole, which is the opposite of
        what this sheet is for.
        """
        if glyph in self._paths:
            return self._paths[glyph]
        from PySide6.QtGui import QPainterPath
        p = QPainterPath()
        p.setFillRule(Qt.OddEvenFill)
        try:
            for contour in self.font_obj.contours(glyph):
                if len(contour) < 3:
                    continue
                p.moveTo(contour[0][0], -contour[0][1])      # font y is up
                for x, y in contour[1:]:
                    p.lineTo(x, -y)
                p.closeSubpath()
        except Exception:
            p = QPainterPath()
        self._paths[glyph] = p
        return p

    # -- painting ------------------------------------------------------ #
    def paintEvent(self, _ev):
        from PySide6.QtGui import QBrush, QPainterPath
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        dark = self.palette().color(QPalette.Window).lightness() < 128
        p.fillRect(self.rect(), QColor("#ffffff"))

        vis = _ev.rect() if hasattr(_ev, "rect") else self.rect()
        c0 = max(0, vis.left() // self.CELL)
        c1 = min(len(self.cols) - 1, vis.right() // self.CELL)
        r0 = max(0, vis.top() // self.CELL)
        r1 = min(len(self.rows) - 1, vis.bottom() // self.CELL)

        # Labels shrink with the cells so they stay in proportion when zoomed
        # out. Below a legible size the gap figure is dropped rather than drawn
        # as an unreadable smear — the red ring still says which pair it is.
        px = max(6, int(round(11 * self.CELL / self.BASE_CELL)))
        small = QtGuiFont(p.font())
        small.setPixelSize(px)
        show_detail = self.CELL >= 78
        grid = QPen(QColor("#e2e5e9"), 1)
        grid.setCosmetic(True)

        for ri in range(r0, r1 + 1):
            for ci in range(c0, c1 + 1):
                x = ci * self.CELL
                y = ri * self.CELL
                group, left = self.rows[ri]
                right = self.cols[ci]
                res = self.result(group, left, right)
                bad = bool(res is not None and getattr(res, "problem", False))
                scale = self._scale_for(group)

                p.setPen(grid)
                p.setBrush(Qt.NoBrush)
                p.drawRect(x, y, self.CELL, self.CELL)

                # the glyphs, filled, at the one grid scale
                if res is not None and getattr(res, "offsets", ()):
                    p.save()
                    p.translate(x + self.CELL / 2, y + self.CELL * 0.62)
                    p.scale(scale, scale)
                    # centre the shaped pair on its own ink
                    try:
                        import nameplate_pairsheet as PS
                        ext = PS._pair_extent(self.font_obj, res)
                    except Exception:
                        ext = None
                    if ext:
                        p.translate(-(ext[0] + ext[2]) / 2.0, 0)
                    p.setPen(Qt.NoPen)
                    p.setBrush(QBrush(QColor("#000000")))
                    for gname, (dx, dy) in zip(res.glyphs, res.offsets):
                        sub = QPainterPath(self._path(gname))
                        sub.translate(dx, -dy)
                        p.drawPath(sub)
                    p.restore()

                # the label, and a red ring plus the gap when it fails to join
                p.setFont(small)
                if bad:
                    pen = QPen(QColor("#d92b2b"), 2)
                    pen.setCosmetic(True)
                    p.setPen(pen)
                    p.setBrush(Qt.NoBrush)
                    p.drawRect(x + 1, y + 1, self.CELL - 2, self.CELL - 2)
                    p.setPen(QColor("#d92b2b"))
                    gap = getattr(res, "gap_em", None)
                    if show_detail:
                        p.drawText(x, y + self.CELL - px - 4, self.CELL, px + 3,
                                   Qt.AlignHCenter,
                                   f"GAP {gap:.3f} em" if gap else
                                   str(getattr(res, "status", "?")).upper())
                elif self._MODE_OF.get(group) == "middle":
                    # a colour per position, so which row you are on is obvious
                    # without reading anything
                    p.setPen(QColor("#0b7285"))       # teal: middle of a word
                elif self._MODE_OF.get(group) in ("first", "last"):
                    p.setPen(QColor("#7048a8"))       # purple: an end of a word
                else:
                    p.setPen(QColor("#7c8288"))
                shown = getattr(res, "shown", None) if res is not None else None
                p.drawText(x, y + 2, self.CELL, px + 3, Qt.AlignHCenter,
                           shown or f"{left}{right}")

                # the one the arrows are parked on
                if (ri, ci) == self._current:
                    pen = QPen(QColor(NEON), 3)
                    pen.setCosmetic(True)
                    p.setPen(pen)
                    p.setBrush(Qt.NoBrush)
                    p.drawRect(x + 2, y + 2, self.CELL - 4, self.CELL - 4)


class PairSheetDialog(QDialog):
    """The grid in a scrollable window, with the paste-ready fix alongside."""

    def __init__(self, parent, font, report, font_path, prompt=""):
        super().__init__(parent)
        self.prompt = prompt
        base = os.path.basename(font_path)
        self.grid_pre = PairGrid(font, report)
        self.grid = self.grid_pre
        self._flagged = self.grid.flagged_cells()
        self._at = -1                       # index into _flagged, -1 = nowhere
        self.setWindowTitle(f"Every letter pair — {base}")
        self.resize(1180, 860)

        v = QVBoxLayout(self)

        # ---- the count, big, at the top -------------------------------- #
        top = QHBoxLayout()
        n = len(self._flagged)
        self.count = QLabel()
        cf = QtGuiFont(self.count.font())
        cf.setPointSizeF(cf.pointSizeF() + 3)
        cf.setBold(True)
        self.count.setFont(cf)
        self.count.setText(
            f"<span style='color:#2f9e44'>0 pairs flagged</span>" if not n else
            f"<span style='color:#d92b2b'>{n} pair"
            f"{'' if n == 1 else 's'} flagged</span>")
        top.addWidget(self.count)
        top.addSpacing(14)

        self.b_prev = QPushButton("◀ previous")
        self.b_next = QPushButton("next flagged ▶")
        self.b_prev.setToolTip("Jump the view to the previous flagged pair "
                               "(Shift+F3, or Shift+Enter).")
        self.b_next.setToolTip("Jump the view to the next flagged pair, in "
                               "reading order (F3, Ctrl+F, or Enter).")
        self.b_prev.clicked.connect(lambda: self._step(-1))
        self.b_next.clicked.connect(lambda: self._step(+1))
        for b in (self.b_prev, self.b_next):
            b.setEnabled(bool(n))
            top.addWidget(b)
        self.where = QLabel("")
        self.where.setStyleSheet("font-size:11px;")
        top.addWidget(self.where)
        top.addStretch(1)

        # ---- zoom ------------------------------------------------------- #
        top.addWidget(QLabel("Zoom"))
        b_out = QPushButton("−")
        b_in = QPushButton("+")
        for b in (b_out, b_in):
            b.setFixedWidth(30)
        b_out.clicked.connect(lambda: self._zoom_by(-1))
        b_in.clicked.connect(lambda: self._zoom_by(+1))
        self.zoom_pick = QComboBox()
        for z in self.grid.zoom_steps():
            self.zoom_pick.addItem(f"{z * 100:.0f}%", z)
        self.zoom_pick.setCurrentIndex(self.grid.zoom_steps().index(1.00))
        self.zoom_pick.currentIndexChanged.connect(self._zoom_pick)
        b_fit = QPushButton("Fit width")
        b_fit.clicked.connect(self._fit_width)
        top.addWidget(b_out)
        top.addWidget(self.zoom_pick)
        top.addWidget(b_in)
        top.addWidget(b_fit)
        v.addLayout(top)

        head = QLabel(
            f"<b>{getattr(font, 'family', base)}</b> — {base}. "
            f"Seven rows per letter, one for every position a pair can occupy "
            f"in a real name — these fonts swap the glyph by position, so a "
            f"pair that joins in one position can break in another. "
            f"<b>Xa</b>, <b>xa</b>: the whole word, first letter "
            f"<b>initial</b> (eyelet), last letter <b>final</b> (eyelet). "
            f"<span style='color:#7048a8'><b>Xaa</b>, <b>xaa</b></span>: the "
            f"<b>first letter</b> of a longer name — initial form joining a "
            f"<b>medial</b> one. "
            f"<span style='color:#0b7285'><b>AXaa</b>, <b>Axaa</b></span>: the "
            f"<b>middle</b> — both medial, no eyelet. "
            f"<span style='color:#7048a8'><b>Axa</b></span>: the "
            f"<b>last letter</b> — medial joining the final form. "
            f"Drawn from the raw outlines, so this is the font as Illustrator "
            f"shows it, no hinting. "
            f"<span style='color:#d92b2b'>Red = the pair does not join</span>, "
            f"with the gap in em. Hover a cell for the shaped glyph names. "
            f"Ctrl+scroll zooms.")
        head.setWordWrap(True)
        head.setStyleSheet("font-size:11px;")
        v.addWidget(head)

        self.grid.setMouseTracking(True)
        self.area = QScrollArea()
        self.area.setWidgetResizable(False)
        self.area.setWidget(self.grid)
        self.area.setBackgroundRole(QPalette.Base)
        self.area.viewport().installEventFilter(self)
        v.addWidget(self.area, 1)

        row = QHBoxLayout()
        if prompt:
            b = QPushButton("Copy fix for Claude")
            b.clicked.connect(self._copy)
            row.addWidget(b)
        b_png = QPushButton("Save this sheet as one PNG…")
        b_png.clicked.connect(self._save_png)
        row.addWidget(b_png)
        row.addStretch(1)
        self.status = QLabel("")
        row.addWidget(self.status)
        close = QPushButton("Close")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        v.addLayout(row)

        # F3 / Ctrl+F / Enter step through the flagged pairs, the way a find bar
        # does, because that is the habit this is meant to fit.
        from PySide6.QtGui import QKeySequence, QShortcut
        for seq, step in (("F3", +1), ("Ctrl+F", +1), ("Return", +1),
                          ("Enter", +1), ("Shift+F3", -1),
                          ("Shift+Return", -1)):
            sc = QShortcut(QKeySequence(seq), self)
            sc.activated.connect(lambda s=step: self._step(s))
        for seq, step in (("Ctrl++", +1), ("Ctrl+=", +1), ("Ctrl+-", -1)):
            sc = QShortcut(QKeySequence(seq), self)
            sc.activated.connect(lambda s=step: self._zoom_by(s))

    # -- zoom ----------------------------------------------------------- #
    def _sync_zoom_pick(self) -> None:
        z = self.grid.zoom()
        i = min(range(self.zoom_pick.count()),
                key=lambda j: abs(self.zoom_pick.itemData(j) - z))
        self.zoom_pick.blockSignals(True)
        self.zoom_pick.setCurrentIndex(i)
        self.zoom_pick.blockSignals(False)

    def _zoom_by(self, step: int) -> None:
        self.grid.zoom_by(step)
        self._sync_zoom_pick()
        self._reveal()

    def _zoom_pick(self, _i: int) -> None:
        self.grid.set_zoom(self.zoom_pick.currentData())
        self._reveal()

    def _fit_width(self) -> None:
        """Zoom so all 26 columns fit the window — the whole sheet at a glance."""
        avail = max(120, self.area.viewport().width() - 4)
        want = avail / (len(self.grid.cols) * self.grid.BASE_CELL)
        self.grid.set_zoom(want)
        self._sync_zoom_pick()
        self._reveal()

    def eventFilter(self, obj, ev):
        """Ctrl+scroll zooms, plain scroll scrolls."""
        from PySide6.QtCore import QEvent
        if (obj is self.area.viewport() and ev.type() == QEvent.Wheel
                and ev.modifiers() & Qt.ControlModifier):
            self._zoom_by(+1 if ev.angleDelta().y() > 0 else -1)
            return True
        return super().eventFilter(obj, ev)

    # -- walking the flagged pairs -------------------------------------- #
    def _step(self, delta: int) -> None:
        if not self._flagged:
            self.where.setText("")
            self.status.setText("Nothing is flagged in this font.")
            return
        self._at = (self._at + delta) % len(self._flagged)
        self._reveal()

    def _reveal(self) -> None:
        """Centre the view on the current flagged pair and say which it is."""
        if not self._flagged or self._at < 0:
            self.grid.set_current(None)
            return
        ri, ci, res = self._flagged[self._at]
        self.grid.set_current((ri, ci))
        r = self.grid.cell_rect(ri, ci)
        self.area.ensureVisible(r.center().x(), r.center().y(),
                                max(60, self.area.viewport().width() // 2),
                                max(60, self.area.viewport().height() // 2))
        gap = getattr(res, "gap_em", None)
        self.where.setText(
            f"<b>{self.grid.rows[ri]}{self.grid.cols[ci]}</b> — "
            f"{self._at + 1} of {len(self._flagged)}"
            + (f", gap {gap:.3f} em" if gap else ""))

    def _copy(self):
        QApplication.clipboard().setText(self.prompt)
        self.status.setText("Copied to the clipboard.")

    def _save_png(self):
        """Only writes a file when actually asked — nothing is written otherwise."""
        path, _ = QFileDialog.getSaveFileName(
            self, "Save the whole sheet as one PNG",
            os.path.join(os.path.expanduser("~"), "letter_pairs.png"),
            "PNG image (*.png)")
        if not path:
            return
        from PySide6.QtGui import QPixmap
        pm = QPixmap(self.grid.width(), self.grid.height())
        pm.fill(QColor("#ffffff"))
        self.grid.render(pm)
        self.status.setText("Saved." if pm.save(path) else "Could not save.")


# --------------------------------------------------------------------------- #
#  a spin box where clearing the text means "nothing", not zero
# --------------------------------------------------------------------------- #
class TargetSpin(QDoubleSpinBox):
    """A wanted-size box that can be emptied again.

    A plain QDoubleSpinBox has two problems here. It snaps an emptied box back
    to the number you were trying to remove (correctionMode defaults to
    CorrectToPreviousValue), so once a target was typed there was no way to say
    "never mind" short of typing 0 and knowing that 0 happens to mean off. And
    the box carries a unit suffix, so deleting the number leaves " in" behind —
    text that is not empty and does not parse, which is why simply testing the
    line edit for emptiness does not work.

    So: the suffix and prefix are stripped before deciding whether the box is
    empty; an empty box reads as 0.0, which everything downstream already treats
    as "not asked for"; and correction goes to the NEAREST value, which for an
    empty box is the minimum — the value that carries the em dash. The display
    is deliberately left alone while you type and only settles on the dash when
    you leave the box, so nothing is rewritten under the cursor mid-edit.
    """

    cleared = Signal()

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.setCorrectionMode(QDoubleSpinBox.CorrectToNearestValue)
        self.lineEdit().textChanged.connect(self._on_text)

    def _bare(self, text: str) -> str:
        """The typed number alone, without the unit suffix or any prefix."""
        t = text
        pre, suf = self.prefix(), self.suffix()
        if pre and t.startswith(pre):
            t = t[len(pre):]
        if suf and t.endswith(suf):
            t = t[:-len(suf)]
        return t.strip()

    def is_blank(self) -> bool:
        t = self._bare(self.lineEdit().text())
        # the em dash IS the empty state, so a box showing it counts as blank
        return not t or t == (self.specialValueText() or "\0").strip()

    def target(self) -> float:
        """The value, or 0.0 while the box is empty — 0.0 means "not asked for"."""
        return 0.0 if self.is_blank() else self.value()

    def _on_text(self, text: str) -> None:
        if not self._bare(text):
            self.cleared.emit()


# --------------------------------------------------------------------------- #
#  selectable text windows — reports and AI prompts
# --------------------------------------------------------------------------- #
class TextDialog(QDialog):
    """A report in a box the mouse can select, with a Copy button.

    QMessageBox looks right for this and is wrong for it: its text cannot be
    selected with the mouse, so anything worth handing to someone else has to be
    retyped. Everything the app produces for copying goes through here instead.
    """

    def __init__(self, parent, title: str, body: str, copy_label: str = "Copy",
                 width: int = 820, height: int = 620, extra=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(width, height)
        v = QVBoxLayout(self)
        self.box = QPlainTextEdit()
        self.box.setPlainText(body)
        self.box.setReadOnly(True)                 # selectable, not editable
        self.box.setLineWrapMode(QPlainTextEdit.NoWrap)
        f = QtGuiFont("Consolas")
        f.setStyleHint(QtGuiFont.Monospace)
        f.setPointSizeF(max(8.5, self.font().pointSizeF()))
        self.box.setFont(f)
        v.addWidget(self.box, 1)
        row = QHBoxLayout()
        b = QPushButton(copy_label)
        b.clicked.connect(self._copy)
        row.addWidget(b)
        for label, fn in (extra or ()):
            eb = QPushButton(label)
            eb.clicked.connect(lambda _c=False, f=fn: (self.accept(), f()))
            row.addWidget(eb)
        row.addStretch(1)
        self.status = QLabel("")
        row.addWidget(self.status)
        close = QPushButton("Close")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        v.addLayout(row)

    def _copy(self) -> None:
        QApplication.clipboard().setText(self.box.toPlainText())
        self.status.setText("Copied to the clipboard.")


# Why the prompt blocks must not be pasted as a batch. Each block carries its
# own fence ("do not change X"), and those fences contradict each other across
# blocks: the eyelet request resizes holes that the font-defect and thin-area
# requests both forbid touching. Pasted in sequence each one forbids the next
# one's work; pasted in reverse the first undoes the last.
SEQUENCING_NOTE = (
    "PASTE ONE BLOCK PER ROUND. Every block here was measured on the SAME version of the font, so the moment one of them is carried out the others are describing a font that no longer exists - re-run and use the fresh blocks. The blocks also overlap on purpose: a junction fix can appear in both 1 and 2, and block 4 is the ONLY one allowed to resize an eyelet.")


class PromptsDialog(QDialog):
    """Every paste-ready prompt at once, one box each, each copied separately.

    Sections with nothing to ask for are left EMPTY on purpose rather than
    hidden: a blank box is the answer "nothing to fix here", and a section that
    silently disappeared would look like the app had not checked.
    """

    def __init__(self, parent, sections: list[tuple[str, str, str]]):
        super().__init__(parent)
        self.setWindowTitle("Prompts to hand to Claude")
        self.resize(940, 780)
        v = QVBoxLayout(self)
        head = QLabel(
            "One box per kind of problem. Select the text with the mouse, or use "
            "the Copy button next to it. A box left blank means nothing needs "
            "fixing in that area.\n\n"
            + SEQUENCING_NOTE)
        head.setWordWrap(True)
        v.addWidget(head)

        area = QScrollArea()
        area.setWidgetResizable(True)
        inner = QWidget()
        iv = QVBoxLayout(inner)
        iv.setSpacing(14)
        mono = QtGuiFont("Consolas")
        mono.setStyleHint(QtGuiFont.Monospace)
        mono.setPointSizeF(max(8.5, self.font().pointSizeF()))

        self._boxes: list[QPlainTextEdit] = []
        for title, note, body in sections:
            grp = QGroupBox(title)
            gv = QVBoxLayout(grp)
            gv.setSpacing(4)
            if note:
                lb = QLabel(note)
                lb.setWordWrap(True)
                lb.setStyleSheet("font-size:10px;")
                gv.addWidget(lb)
            box = QPlainTextEdit()
            box.setPlainText(body)
            box.setReadOnly(True)
            box.setLineWrapMode(QPlainTextEdit.NoWrap)
            box.setFont(mono)
            box.setMinimumHeight(120 if body else 46)
            box.setMaximumHeight(300)
            if not body:
                box.setPlaceholderText("nothing to fix here")
            gv.addWidget(box)
            row = QHBoxLayout()
            b = QPushButton("Copy this one")
            b.setEnabled(bool(body))
            b.clicked.connect(lambda _c=False, t=box: self._copy(t))
            row.addWidget(b)
            row.addStretch(1)
            gv.addLayout(row)
            iv.addWidget(grp)
            self._boxes.append(box)
        iv.addStretch(1)
        area.setWidget(inner)
        v.addWidget(area, 1)

        row = QHBoxLayout()
        self.status = QLabel("")
        row.addWidget(self.status)
        row.addStretch(1)
        close = QPushButton("Close")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        v.addLayout(row)

    def _copy(self, box) -> None:
        QApplication.clipboard().setText(box.toPlainText())
        self.status.setText("Copied that one to the clipboard.")


# --------------------------------------------------------------------------- #
#  main window
# --------------------------------------------------------------------------- #
class MainWindow(QWidget):
    requestPreview = Signal(int, str, str, float, str, str, bool, float, float,
                            bool, float, float, float, bool, bool)
    newestPreview = Signal(int)
    requestProbe = Signal(int, str)
    requestReport = Signal(int, str, str, str, float, str, str, float, float,
                           float)
    requestForget = Signal(str)

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(1120, 720)

        self.settings = load_settings()
        self.entries: list[FontEntry] = []
        self._req = 0
        self._last_preview_id = -1
        self._export_thread: QThread | None = None
        self._export_worker: ExportWorker | None = None
        self._quiet = False              # --selftest suppresses modal dialogs
        self._font_notes: list[str] = []   # from the automatic font check
        self._preview_notes: list[str] = []  # from the current preview
        # what a report or the prompt window WOULD have shown; --selftest reads
        # these instead of opening a modal dialog it could never close
        self._last_report = ""
        self._last_prompt_sections: list = []
        self._report_id = 0
        self._last_report_id = -1
        self._report_thread = None
        self._report_worker = None

        self._build_ui()
        self._start_preview_thread()
        try:
            self.refresh_fonts(initial=True)
        except Exception as exc:
            log(f"font scan failed at startup: {exc!r}")
            self.font_detail.setText("Could not read the fonts folder — use Refresh.")

    # ------------------------------------------------------------------ UI #
    def _build_ui(self) -> None:
        # Sean's PCs may be on the light or the dark Windows theme, so the
        # secondary text and the warning panel pick their colours from it.
        # The preview canvas stays white on purpose — that is the material.
        dark = self.palette().color(QPalette.Window).lightness() < 128
        self.c_dim = "#9aa0a6" if dark else "#5f6469"
        self.c_faint = "#787e84" if dark else "#9aa0a6"
        self.c_rule = "#3a3f44" if dark else "#dfe3e7"
        self.c_warn_fg = "#ffd479" if dark else "#8a5a00"
        self.c_warn_bg = "#3b3016" if dark else "#fff6e0"
        self.c_warn_bd = "#6d5722" if dark else "#f0d9a8"

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(8)

        # ---- font row -------------------------------------------------- #
        top = QHBoxLayout()
        top.setSpacing(6)
        top.addWidget(QLabel("Font"))
        self.font_combo = QComboBox()
        self.font_combo.setMinimumWidth(420)
        self.font_combo.currentIndexChanged.connect(self._font_changed)
        top.addWidget(self.font_combo, 1)
        self.btn_add_font = QPushButton("Add font…")
        self.btn_add_font.clicked.connect(self.add_font)
        top.addWidget(self.btn_add_font)
        self.btn_refresh = QPushButton("Refresh")
        self.btn_refresh.clicked.connect(lambda: self.refresh_fonts())
        top.addWidget(self.btn_refresh)
        self.btn_reload = QPushButton("Reload font")
        self.btn_reload.setToolTip(
            "Re-read the selected font file from disk. Use this after replacing "
            "a font with a new version under the same file name.")
        self.btn_reload.clicked.connect(self.reload_font)
        top.addWidget(self.btn_reload)
        self.btn_check = QPushButton("Check font")
        self.btn_check.setToolTip(
            "Inspect the selected font and list anything that would stop it "
            "producing a clean cut file, with the edit that fixes each one.")
        self.btn_check.clicked.connect(self.check_font)
        top.addWidget(self.btn_check)
        root.addLayout(top)

        self.font_detail = QLabel("")
        self.font_detail.setStyleSheet(f"color:{self.c_dim}; font-size:11px;")
        self.font_detail.setContentsMargins(34, 0, 0, 0)
        root.addWidget(self.font_detail)

        # ---- middle splitter ------------------------------------------- #
        split = QSplitter(Qt.Horizontal)

        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 8, 0)
        lv.setSpacing(6)

        lv.addWidget(QLabel("Names (one per line)"))
        self.names = QPlainTextEdit()
        self.names.setPlaceholderText("ADAM\nOLIVIA\nMary Jane")
        self.names.setTabChangesFocus(True)
        mono = QtGuiFont("Consolas")
        mono.setPointSizeF(11.0)
        self.names.setFont(mono)
        self.names.textChanged.connect(self._schedule_preview)
        self.names.cursorPositionChanged.connect(self._schedule_preview)
        lv.addWidget(self.names, 1)

        hrow = QHBoxLayout()
        hrow.setSpacing(6)
        hrow.addWidget(QLabel("Height"))
        self.height_spin = QDoubleSpinBox()
        self.height_spin.setDecimals(3)
        self.height_spin.setRange(MIN_IN, 400.0)
        self.height_spin.setValue(1.0)
        self.height_spin.setSingleStep(0.125)
        self.height_spin.setMinimumWidth(128)     # room for the " in" / " mm" suffix
        self.height_spin.valueChanged.connect(self._schedule_preview)
        hrow.addWidget(self.height_spin)
        self.rb_mm = QRadioButton("mm")
        self.rb_in = QRadioButton("in")
        self.rb_in.setChecked(True)
        self.unit_group = QButtonGroup(self)
        self.unit_group.addButton(self.rb_mm)
        self.unit_group.addButton(self.rb_in)
        self.rb_mm.toggled.connect(self._unit_toggled)
        hrow.addWidget(self.rb_mm)
        hrow.addWidget(self.rb_in)
        hrow.addStretch(1)
        lv.addLayout(hrow)

        lead_box = QGroupBox("Laser lead-in lines")
        lv2 = QVBoxLayout(lead_box)
        lv2.setSpacing(2)
        self.cb_lead = QCheckBox("Add lead-in lines")
        self.cb_lead.toggled.connect(self._lead_toggled)
        lv2.addWidget(self.cb_lead)
        lrow = QHBoxLayout()
        lrow.setSpacing(6)
        self.lead_label = QLabel("Length")
        lrow.addWidget(self.lead_label)
        self.lead_spin = QDoubleSpinBox()
        self.lead_spin.setDecimals(3)
        self.lead_spin.setRange(0.005, 25.0)
        self.lead_spin.setValue(default_length("in"))
        self.lead_spin.setSingleStep(0.025)
        self.lead_spin.setMinimumWidth(112)
        self.lead_spin.valueChanged.connect(self._schedule_preview)
        lrow.addWidget(self.lead_spin)
        lrow.addSpacing(10)
        self.clear_label = QLabel("Keep clear")
        lrow.addWidget(self.clear_label)
        self.clear_spin = QDoubleSpinBox()
        self.clear_spin.setDecimals(4)
        self.clear_spin.setRange(0.001, 5.0)
        self.clear_spin.setValue(default_clearance("in"))
        self.clear_spin.setSingleStep(0.002)
        self.clear_spin.setMinimumWidth(112)
        self.clear_spin.setToolTip(
            "How far the lead-in stays away from every letter edge along its\n"
            "length, so the beam cannot scorch the part. Only the last bit next\n"
            "to the contour is allowed close — that is where it joins the cut.\n"
            "Relaxed automatically in a counter too tight to hold it, but never\n"
            "below a kerf; a hole with no safe entry is skipped instead.")
        self.clear_spin.valueChanged.connect(self._schedule_preview)
        lrow.addWidget(self.clear_spin)
        lrow.addStretch(1)
        lv2.addLayout(lrow)
        self.lead_note = QLabel("One inside every hole, one outside the name.\n"
                                "Never counted in the height.")
        self.lead_note.setStyleSheet(f"color:{self.c_dim}; font-size:10px;")
        lv2.addWidget(self.lead_note)
        self._set_lead_enabled(False)
        basis_box = QGroupBox("Measured from:")
        bv = QVBoxLayout(basis_box)
        bv.setSpacing(2)
        self.rb_cap = QRadioButton("cap height of 1st capital")
        self.rb_xh = QRadioButton("x-height (lowercase)")
        self.rb_total = QRadioButton("total height of artwork")
        self.rb_cap.setChecked(True)
        self.basis_group = QButtonGroup(self)
        for rb in (self.rb_cap, self.rb_xh, self.rb_total):
            self.basis_group.addButton(rb)
            bv.addWidget(rb)
            rb.toggled.connect(lambda on: on and self._schedule_preview())
        lv.addWidget(basis_box)
        lv.addWidget(lead_box)

        eye_box = QGroupBox("Eyelets")
        ev = QVBoxLayout(eye_box)
        ev.setSpacing(3)
        self.cb_eyedim = QCheckBox("Show eyelet sizes on the preview")
        self.cb_eyedim.setToolTip(
            "Measure the eyelet at each end of this name at its current height "
            "and draw the inner diameter, the outer diameter and the wall\n"
            "straight onto the preview — the wall is drawn at the exact point "
            "where it is thinnest, which is the spot that tears out.")
        self.cb_eyedim.toggled.connect(self._schedule_preview)
        ev.addWidget(self.cb_eyedim)

        self.cb_eyewant = QCheckBox("Show the wanted size on the preview")
        self.cb_eyewant.setChecked(True)
        self.cb_eyewant.setToolTip(
            "Draw the eyelet you are ASKING for over the one you have — the "
            "wanted inner diameter in green and the wanted outer diameter\n"
            "in light green — so the difference can be judged by eye as well as "
            "read from the change column. Untick to see the artwork alone; the\n"
            "numbers in the table stay either way.")
        self.cb_eyewant.toggled.connect(self._schedule_preview)
        ev.addWidget(self.cb_eyewant)

        trow = QHBoxLayout()
        trow.setSpacing(6)
        self.eye_id_label = QLabel("Want ID")
        trow.addWidget(self.eye_id_label)
        self.eye_id_spin = TargetSpin()
        self.eye_id_spin.setDecimals(4)
        self.eye_id_spin.setRange(0.0, 500.0)
        self.eye_id_spin.setValue(0.0)
        self.eye_id_spin.setSpecialValueText("—")
        self.eye_id_spin.setMinimumWidth(96)
        trow.addWidget(self.eye_id_spin)
        self.eye_wall_label = QLabel("wall")
        trow.addWidget(self.eye_wall_label)
        self.eye_wall_spin = TargetSpin()
        self.eye_wall_spin.setDecimals(4)
        self.eye_wall_spin.setRange(0.0, 500.0)
        self.eye_wall_spin.setValue(0.0)
        self.eye_wall_spin.setSpecialValueText("—")
        self.eye_wall_spin.setMinimumWidth(96)
        trow.addWidget(self.eye_wall_spin)
        trow.addStretch(1)
        ev.addLayout(trow)
        # Typing a target has to redraw the preview, or the wanted size is only
        # ever a number in a box and never appears over the artwork. `cleared`
        # covers deleting it again, which is not a value change.
        for _sp in (self.eye_id_spin, self.eye_wall_spin):
            _sp.valueChanged.connect(self._schedule_preview)
            _sp.cleared.connect(self._schedule_preview)

        # ---- actual | want | change, live, on the main window ----------- #
        self.eye_grid = QGridLayout()
        self.eye_grid.setHorizontalSpacing(10)
        self.eye_grid.setVerticalSpacing(1)
        hdr = QtGuiFont(self.font())
        hdr.setPointSizeF(max(7.5, hdr.pointSizeF() - 0.5))
        for col, title in enumerate(("", "actual", "want", "change")):
            lb = QLabel(title)
            lb.setFont(hdr)
            lb.setStyleSheet(f"color:{self.c_dim};")
            if col:
                lb.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.eye_grid.addWidget(lb, 0, col)
        mono = QtGuiFont("Consolas")
        mono.setStyleHint(QtGuiFont.Monospace)
        mono.setPointSizeF(max(8.0, self.font().pointSizeF() - 0.5))
        self.eye_cells: dict[str, list[QLabel]] = {}
        for r, (key, title) in enumerate(
                (("id", "inner Ø"), ("od", "outer Ø"),
                 ("wall", "wall, avg"), ("wall_min", "wall, thinnest")), start=1):
            name = QLabel(title)
            name.setFont(hdr)
            self.eye_grid.addWidget(name, r, 0)
            cells = []
            for c in range(1, 4):
                lb = QLabel("")
                lb.setFont(mono)
                lb.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
                lb.setTextInteractionFlags(Qt.TextSelectableByMouse)
                self.eye_grid.addWidget(lb, r, c)
                cells.append(lb)
            self.eye_cells[key] = cells
        ev.addLayout(self.eye_grid)

        self.eye_status = QLabel("")
        self.eye_status.setWordWrap(True)
        self.eye_status.setStyleSheet(f"color:{self.c_dim}; font-size:10px;")
        ev.addWidget(self.eye_status)
        self.btn_eyelets = QPushButton("Full eyelet report…")
        self.btn_eyelets.setToolTip(
            "The same numbers plus roundness, the font-unit sizes to hand to "
            "whoever edits the font, and what each measurement means.")
        self.btn_eyelets.clicked.connect(self.measure_eyelets)
        ev.addWidget(self.btn_eyelets)
        self.eye_note = QLabel(
            "Fill either box to get the % change and the font-unit sizes\n"
            "needed to hit it at this height. Clear a box to go back to —.")
        self.eye_note.setStyleSheet(f"color:{self.c_dim}; font-size:10px;")
        ev.addWidget(self.eye_note)
        lv.addWidget(eye_box)

        thin_box = QGroupBox("Thin areas")
        tv = QVBoxLayout(thin_box)
        tv.setSpacing(3)
        self.cb_thin = QCheckBox("Show the thinnest parts")
        self.cb_thin.setToolTip(
            "Find the thinnest places in the letters — the spots that snap when\n"
            "the part is cut from metal — and mark them on the preview.")
        self.cb_thin.toggled.connect(self._schedule_preview)
        tv.addWidget(self.cb_thin)
        wrow = QHBoxLayout()
        wrow.setSpacing(6)
        self.thin_label = QLabel("Want")
        wrow.addWidget(self.thin_label)
        self.thin_spin = TargetSpin()
        self.thin_spin.setDecimals(4)
        self.thin_spin.setRange(0.0, 100.0)
        self.thin_spin.setValue(0.0)
        self.thin_spin.setSpecialValueText("—")
        self.thin_spin.setMinimumWidth(104)
        self.thin_spin.setToolTip(
            "The thickness you want the thinnest part to be. The preview then\n"
            "draws what the letters would look like at that thickness, in cyan,\n"
            "over the real outline. Clear the box to go back to no target.")
        self.thin_spin.valueChanged.connect(self._schedule_preview)
        self.thin_spin.cleared.connect(self._schedule_preview)
        wrow.addWidget(self.thin_spin)
        self.btn_thin = QPushButton("Measure / copy fix")
        self.btn_thin.setToolTip(
            "Full report of every thin area, and — with a target set — the\n"
            "percentage increase plus a instruction you can paste to an AI that\n"
            "edits the font.")
        self.btn_thin.clicked.connect(self.measure_thickness)
        wrow.addWidget(self.btn_thin)
        wrow.addStretch(1)
        tv.addLayout(wrow)
        self.thin_note = QLabel(
            "Cyan = letters at the wanted thickness. Green = eyelet at the\n"
            "wanted size. Both are drawn over the real outline to compare.")
        self.thin_note.setStyleSheet(f"color:{self.c_dim}; font-size:10px;")
        tv.addWidget(self.thin_note)
        lv.addWidget(thin_box)

        split.addWidget(left)

        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(8, 0, 0, 0)
        rv.setSpacing(4)
        head = QHBoxLayout()
        head.addWidget(QLabel("PREVIEW"))
        head.addStretch(1)
        hint = QLabel("scroll = zoom · drag = pan · double-click = fit")
        hint.setStyleSheet(f"color:{self.c_faint}; font-size:10px;")
        head.addWidget(hint)
        rv.addLayout(head)

        self.canvas = PreviewCanvas()
        frame = QFrame()
        frame.setFrameShape(QFrame.StyledPanel)
        fl = QVBoxLayout(frame)
        fl.setContentsMargins(1, 1, 1, 1)
        fl.addWidget(self.canvas)
        rv.addWidget(frame, 1)

        self.size_label = QLabel("—")
        f = QtGuiFont(self.size_label.font())
        f.setBold(True)
        self.size_label.setFont(f)
        rv.addWidget(self.size_label)
        self.count_label = QLabel("")
        self.count_label.setStyleSheet(f"color:{self.c_dim};")
        rv.addWidget(self.count_label)
        self.warn_label = QLabel("")
        self.warn_label.setWordWrap(True)
        self.warn_label.setStyleSheet(
            f"color:{self.c_warn_fg}; background:{self.c_warn_bg};"
            f"border:1px solid {self.c_warn_bd}; padding:4px;")
        self.warn_label.hide()
        rv.addWidget(self.warn_label)

        split.addWidget(right)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 5)
        root.addWidget(split, 1)

        # ---- export row ------------------------------------------------ #
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setStyleSheet(f"color:{self.c_rule};")
        root.addWidget(line)

        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        self.btn_zip = QPushButton("Export one file per name (.zip)")
        self.btn_zip.clicked.connect(lambda: self.export("per-name"))
        self.btn_sheet = QPushButton("Export all on one sheet")
        self.btn_sheet.clicked.connect(lambda: self.export("sheet"))
        for b in (self.btn_zip, self.btn_sheet):
            b.setMinimumHeight(30)
        grid.addWidget(self.btn_zip, 0, 0)
        grid.addWidget(self.btn_sheet, 0, 1)

        opts = QHBoxLayout()
        opts.setSpacing(6)
        opts.addWidget(QLabel("Format:"))
        self.cb_svg = QCheckBox("SVG")
        self.cb_pdf = QCheckBox("PDF")
        self.cb_svg.setChecked(True)
        self.cb_pdf.setChecked(True)
        self.cb_svg.toggled.connect(self._update_export_enabled)
        self.cb_pdf.toggled.connect(self._update_export_enabled)
        opts.addWidget(self.cb_svg)
        opts.addWidget(self.cb_pdf)
        opts.addSpacing(16)
        opts.addWidget(QLabel("Sheet gap:"))
        self.gap_spin = QDoubleSpinBox()
        self.gap_spin.setDecimals(3)
        self.gap_spin.setRange(0.0, 100.0)
        self.gap_spin.setValue(0.25)
        self.gap_spin.setSingleStep(0.05)
        self.gap_spin.setFixedWidth(84)
        opts.addWidget(self.gap_spin)
        opts.addSpacing(14)
        opts.addWidget(QLabel("Sheet layout:"))
        self.rb_vert = QRadioButton("stacked")
        self.rb_horz = QRadioButton("side by side")
        self.rb_vert.setChecked(True)
        self.rb_vert.setToolTip("Names top to bottom, aligned on the left.")
        self.rb_horz.setToolTip("Names left to right, aligned on the bottom.")
        self.dir_group = QButtonGroup(self)
        self.dir_group.addButton(self.rb_vert)
        self.dir_group.addButton(self.rb_horz)
        opts.addWidget(self.rb_vert)
        opts.addWidget(self.rb_horz)
        opts.addStretch(1)
        self.btn_prompts = QPushButton("Generate prompts…")
        self.btn_prompts.setToolTip(
            "Every paste-ready instruction for this font in one window — font "
            "defects, letter pairs that do not join, thin areas and eyelet\n"
            "sizes — each in its own selectable box. Areas with nothing to fix "
            "are left blank.")
        self.btn_prompts.clicked.connect(self.generate_prompts)
        opts.addWidget(self.btn_prompts)
        self.btn_health = QPushButton("Health check\u2026")
        self.btn_health.setToolTip(
            "Which build this is, where it keeps its files, and whether this "
            "machine can actually run it (folder writable, fonts present,\n"
            "path not too long). Copy this into any bug report.")
        self.btn_health.clicked.connect(self.show_health)
        opts.addWidget(self.btn_health)
        grid.addLayout(opts, 1, 0, 1, 2)
        root.addLayout(grid)

        self.progress = QProgressBar()
        self.progress.hide()
        root.addWidget(self.progress)
        self.status = QLabel("")
        self.status.setStyleSheet(f"color:{self.c_dim};")
        root.addWidget(self.status)

        # debounce timer (SPEC.md section 4: ~150 ms so typing stays smooth)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(DEBOUNCE_MS)
        self._timer.timeout.connect(self._do_preview)

        self._apply_theme()
        try:
            self._restore_prefs()
        except Exception as exc:
            # settings.json is external data and may have come from another PC;
            # bad values fall back to defaults rather than blocking startup
            log(f"_restore_prefs failed, using defaults: {exc!r}")

    def _apply_theme(self) -> None:
        """Neon purple everywhere Qt would otherwise paint its blue accent."""
        self.setStyleSheet(f"""
            QRadioButton::indicator, QCheckBox::indicator {{
                width: 15px; height: 15px;
            }}
            QRadioButton::indicator {{
                border: 2px solid {self.c_faint}; border-radius: 9px;
            }}
            QCheckBox::indicator {{
                border: 2px solid {self.c_faint}; border-radius: 3px;
            }}
            QRadioButton::indicator:checked {{
                border: 2px solid {NEON}; border-radius: 9px;
                background: qradialgradient(cx:0.5, cy:0.5, radius:0.5,
                            stop:0 {NEON}, stop:0.45 {NEON},
                            stop:0.5 transparent, stop:1 transparent);
            }}
            QCheckBox::indicator:checked {{
                border: 2px solid {NEON}; background: {NEON};
            }}
            QRadioButton::indicator:hover, QCheckBox::indicator:hover {{
                border-color: {NEON_HOVER};
            }}
            QPushButton {{
                border: 1px solid {self.c_rule}; border-radius: 4px;
                padding: 5px 12px;
            }}
            QPushButton:hover:enabled {{
                border-color: {NEON}; color: {NEON_HOVER};
            }}
            QPushButton:pressed:enabled {{
                background: {NEON_PRESS}; border-color: {NEON_PRESS};
                color: #ffffff;
            }}
            QPushButton:focus {{ border: 1px solid {NEON}; outline: none; }}
            QProgressBar {{
                border: 1px solid {self.c_rule}; border-radius: 3px;
                text-align: center;
            }}
            QProgressBar::chunk {{ background-color: {NEON}; }}
            QPlainTextEdit, QDoubleSpinBox, QComboBox {{
                border: 1px solid {self.c_rule}; border-radius: 3px;
                selection-background-color: {NEON_PRESS};
            }}
            QPlainTextEdit:focus, QDoubleSpinBox:focus, QComboBox:focus,
            QComboBox:on {{
                border: 1px solid {NEON};
            }}
            QGroupBox {{
                border: 1px solid {self.c_rule}; border-radius: 4px;
                margin-top: 8px; padding-top: 8px;
            }}
            QGroupBox::title {{
                subcontrol-origin: margin; left: 8px; padding: 0 4px;
                color: {self.c_dim};
            }}
        """)

    def _restore_prefs(self) -> None:
        s = self.settings
        if s.get("unit") == "mm":
            self.rb_mm.blockSignals(True)
            self.rb_mm.setChecked(True)
            self.rb_mm.blockSignals(False)
        # always apply, so range/step/suffix match the unit even on a fresh start
        self._apply_unit_limits(self.unit())
        basis = s.get("basis")
        for key, rb in (("cap", self.rb_cap), ("xheight", self.rb_xh),
                        ("total", self.rb_total)):
            if basis == key:
                rb.blockSignals(True)
                rb.setChecked(True)
                rb.blockSignals(False)
        h = s.get("height")
        if isinstance(h, (int, float)):
            self.height_spin.blockSignals(True)
            self.height_spin.setValue(float(h))
            self.height_spin.blockSignals(False)
        if isinstance(s.get("gap"), (int, float)):
            self.gap_spin.setValue(float(s["gap"]))
        fmts = s.get("formats")
        if isinstance(fmts, list) and fmts:
            self.cb_svg.blockSignals(True)
            self.cb_pdf.blockSignals(True)
            self.cb_svg.setChecked("svg" in fmts)
            self.cb_pdf.setChecked("pdf" in fmts)
            self.cb_svg.blockSignals(False)
            self.cb_pdf.blockSignals(False)
        if isinstance(s.get("lead_len"), (int, float)):
            self.lead_spin.blockSignals(True)
            self.lead_spin.setValue(float(s["lead_len"]))
            self.lead_spin.blockSignals(False)
        if isinstance(s.get("lead_clear"), (int, float)):
            self.clear_spin.blockSignals(True)
            self.clear_spin.setValue(float(s["lead_clear"]))
            self.clear_spin.blockSignals(False)
        if s.get("lead_in"):
            self.cb_lead.blockSignals(True)
            self.cb_lead.setChecked(True)
            self.cb_lead.blockSignals(False)
            self._set_lead_enabled(True)
        if s.get("direction") == HORIZONTAL:
            self.rb_horz.setChecked(True)
        for key, sp in (("eye_target_id", self.eye_id_spin),
                        ("eye_target_wall", self.eye_wall_spin)):
            if isinstance(s.get(key), (int, float)):
                sp.blockSignals(True)
                sp.setValue(float(s[key]))
                sp.blockSignals(False)
        for key, cb, default in (("eye_show_dims", self.cb_eyedim, False),
                                 ("eye_show_want", self.cb_eyewant, True)):
            want = s.get(key)
            cb.blockSignals(True)
            cb.setChecked(bool(want) if isinstance(want, bool) else default)
            cb.blockSignals(False)
        if isinstance(s.get("names"), str):
            self.names.blockSignals(True)
            self.names.setPlainText(s["names"])
            self.names.blockSignals(False)

    def _persist(self) -> None:
        self.settings.update({
            "font_path": self.current_font_path() or "",
            "unit": self.unit(),
            "basis": self.basis(),
            "height": self.height_spin.value(),
            "gap": self.gap_spin.value(),
            "formats": self.formats(),
            "names": self.names.toPlainText(),
            "lead_in": self.cb_lead.isChecked(),
            "lead_len": self.lead_spin.value(),
            "lead_clear": self.clear_spin.value(),
            "eye_target_id": self.eye_id_spin.target(),
            "eye_target_wall": self.eye_wall_spin.target(),
            "eye_show_dims": self.cb_eyedim.isChecked(),
            "eye_show_want": self.cb_eyewant.isChecked(),
            "direction": self.direction(),
        })
        save_settings(self.settings)

    def closeEvent(self, ev) -> None:
        self._persist()
        for t in (getattr(self, "_preview_thread", None),
                  getattr(self, "_report_thread", None)):
            try:
                if t is not None:
                    t.quit()
                    t.wait(1500)
            except Exception:
                pass
        super().closeEvent(ev)

    # ------------------------------------------------------- preview thread #
    def _start_preview_thread(self) -> None:
        self._preview_thread = QThread(self)
        self._preview_worker = PreviewWorker()
        self._preview_worker.moveToThread(self._preview_thread)
        self.requestPreview.connect(self._preview_worker.build)
        # DirectConnection on purpose: this has to land on the worker's attribute
        # NOW, while its event queue is still full of stale build requests, not
        # after them. It only assigns an int, so there is no race worth guarding.
        self.newestPreview.connect(self._preview_worker.note_newest,
                                   Qt.DirectConnection)
        self.requestProbe.connect(self._preview_worker.probe)
        self.requestForget.connect(self._preview_worker.forget)
        self._preview_worker.ready.connect(self._preview_ready)
        self._preview_worker.failed.connect(self._preview_failed)
        self._preview_worker.fontInfoReady.connect(self._font_info_ready)
        self._preview_thread.start()

        # A SECOND thread for the click-driven analyses. Not the preview thread:
        # a ten-second font check queued there would starve the previews that run
        # while you type.
        self._report_thread = QThread(self)
        self._report_worker = ReportWorker()
        self._report_worker.moveToThread(self._report_thread)
        self.requestReport.connect(self._report_worker.run)
        self._report_worker.ready.connect(self._report_ready)
        self._report_worker.failed.connect(self._report_failed)
        self._report_thread.start()

    # ------------------------------------------------------ report thread #
    _REPORT_BUTTONS = {
        "check": ("btn_check", "Checking…"),
        "prompts": ("btn_prompts", "Building…"),
        "pairs": ("btn_check", "Analysing…"),
        "thickness": ("btn_thin", "Measuring…"),
        "eyelets": ("btn_eyelets", "Measuring…"),
    }

    def _ask_report(self, kind: str, note: str) -> bool:
        """Queue one analysis on the report thread. False if it cannot run.

        Nothing blocks: the button that started it goes disabled and says what it
        is doing, the status line carries the note, and the window keeps
        painting. A newer request simply bumps the id, so a stale result is
        dropped when it arrives rather than opening a window you no longer want.
        """
        path = self.current_font_path()
        if not path:
            self.status.setText("No font selected.")
            return False
        if kind in ("thickness", "eyelets") and not self.caret_name():
            self.status.setText("Type a name first — this is measured on the "
                                "artwork, not on the font.")
            return False
        self._report_id += 1
        self._last_report_id = self._report_id
        self._busy_report = kind
        name, label = self._REPORT_BUTTONS.get(kind, (None, None))
        btn = getattr(self, name, None) if name else None
        if btn is not None:
            btn.setEnabled(False)
            if not hasattr(btn, "_idle_text"):
                btn._idle_text = btn.text()
            btn.setText(label)
        self.status.setText(note)
        self.requestReport.emit(
            self._report_id, kind, path, self.caret_name(),
            float(self.height_spin.value()), self.unit(), self.basis(),
            float(self.thin_spin.target()), float(self.eye_id_spin.target()),
            float(self.eye_wall_spin.target()))
        return True

    def _report_done(self, kind: str) -> None:
        name, _label = self._REPORT_BUTTONS.get(kind, (None, None))
        btn = getattr(self, name, None) if name else None
        if btn is not None:
            btn.setEnabled(True)
            if hasattr(btn, "_idle_text"):
                btn.setText(btn._idle_text)
        self.status.setText("")

    @Slot(int, str, object)
    def _report_ready(self, req_id: int, kind: str, payload) -> None:
        if req_id != self._last_report_id:
            return                                # a newer request won
        self._report_done(kind)
        try:
            self._show_report(kind, payload)
        except Exception as exc:
            log(f"showing the {kind} report failed: {exc!r}")
            self._error(f"Could not show the {kind} report",
                        f"{type(exc).__name__}: {exc}")

    @Slot(int, str, str)
    def _report_failed(self, req_id: int, kind: str, msg: str) -> None:
        if req_id != self._last_report_id:
            return
        self._report_done(kind)
        self._last_report = msg
        if self._quiet:
            return
        self._error(f"Could not finish the {kind} report", msg)

    # ------------------------------------------------------------- font list #
    def refresh_fonts(self, initial: bool = False) -> None:
        want = self.settings.get("font_path") if initial else self.current_font_path()
        ensure_fonts_dir()
        self.entries = scan_fonts()

        self.font_combo.blockSignals(True)
        self.font_combo.clear()
        dup = {}
        for e in self.entries:
            dup[e.family] = dup.get(e.family, 0) + 1
        for e in self.entries:
            label = e.family if dup[e.family] == 1 else f"{e.family}   ({e.date_str})"
            self.font_combo.addItem(label, e.path)
        self.font_combo.blockSignals(False)

        if not self.entries:
            self.font_detail.setText(
                f"No fonts found in {FONTS_DIR} — use “Add font…” to add one.")
            self.canvas.set_placeholder("No font available")
            self.canvas.set_result(None)
            self._update_export_enabled()
            return

        idx = 0
        if want:
            for i, e in enumerate(self.entries):
                if os.path.normcase(e.path) == os.path.normcase(want):
                    idx = i
                    break
        self.font_combo.setCurrentIndex(idx)
        self._font_changed()
        if not initial:
            self.status.setText(
                f"Rescanned {FONTS_DIR} — {len(self.entries)} font file(s).")

    def current_entry(self) -> FontEntry | None:
        i = self.font_combo.currentIndex()
        return self.entries[i] if 0 <= i < len(self.entries) else None

    def current_font_path(self) -> str | None:
        e = self.current_entry()
        return e.path if e else None

    def _font_changed(self, *_a) -> None:
        e = self.current_entry()
        if not e:
            return
        self.font_detail.setText(f"{e.filename} · {e.date_str} · checking…")
        self._req += 1
        self.requestProbe.emit(self._req, e.path)
        self._schedule_preview()

    @Slot(int, object)
    def _font_info_ready(self, _req: int, info: FontInfo) -> None:
        e = self.current_entry()
        if not e or os.path.normcase(info.path) != os.path.normcase(e.path):
            return
        if not info.ok:
            self.font_detail.setText(f"{e.filename} · {e.date_str} · "
                                     f"could not be read")
            self._font_notes = [f"This font could not be read. {info.error}",
                                "Click “Check font” for what to fix in it."]
            self._render_notes()
            self._error("Font could not be read",
                        info.error + os.linesep * 2
                        + self.font_report_text(e.path))
            return
        mark = "carries engrave lines" if info.has_colr else "cut only"
        self.font_detail.setText(
            f"{e.filename} · {e.date_str} · {mark} · {info.verdict}")

        # the automatic check speaks up here; the button gives the full report
        notes = []
        if info.n_errors:
            notes.append(f"This font cannot produce a clean cut file: "
                         f"{info.n_errors} error(s). Click “Check font” for the "
                         f"list and how to fix each one.")
        notes += info.issues[:4]
        if len(info.issues) > 4:
            notes.append(f"…and {len(info.issues) - 4} more — see “Check font”.")
        self._font_notes = notes
        self._render_notes()

    def add_font(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Add font file(s)", "",
            "Fonts (*.ttf *.otf *.ttc);;All files (*)")
        if not paths:
            return
        ensure_fonts_dir()
        added = []
        for src in paths:
            dst = os.path.join(FONTS_DIR, os.path.basename(src))
            try:
                if os.path.normcase(os.path.abspath(src)) != \
                        os.path.normcase(os.path.abspath(dst)):
                    shutil.copy2(src, dst)
                added.append(dst)
            except Exception as exc:
                self._error("Could not add font",
                            f"{os.path.basename(src)}\n\n{type(exc).__name__}: {exc}")
        if added:
            self.settings["font_path"] = added[-1]
            self.refresh_fonts(initial=True)
            self.status.setText(f"Added {len(added)} font file(s) to {FONTS_DIR}")

    # ----------------------------------------------------------------- input #
    def unit(self) -> str:
        return "mm" if self.rb_mm.isChecked() else "in"

    def basis(self) -> str:
        if self.rb_xh.isChecked():
            return "xheight"
        if self.rb_total.isChecked():
            return "total"
        return "cap"

    def direction(self) -> str:
        return HORIZONTAL if self.rb_horz.isChecked() else VERTICAL

    def formats(self) -> list[str]:
        out = []
        if self.cb_svg.isChecked():
            out.append("svg")
        if self.cb_pdf.isChecked():
            out.append("pdf")
        return out

    def _apply_unit_limits(self, unit: str) -> None:
        self.height_spin.blockSignals(True)
        self.lead_spin.blockSignals(True)
        self.clear_spin.blockSignals(True)
        self.eye_id_spin.blockSignals(True)
        self.eye_wall_spin.blockSignals(True)
        if unit == "mm":
            self.height_spin.setRange(MIN_MM, 4000.0)
            self.height_spin.setSingleStep(1.0)
            self.height_spin.setSuffix(" mm")
            self.lead_spin.setRange(0.1, 250.0)
            self.lead_spin.setSingleStep(0.5)
            self.lead_spin.setSuffix(" mm")
            self.clear_spin.setRange(0.02, 50.0)
            self.clear_spin.setSingleStep(0.05)
            self.clear_spin.setSuffix(" mm")
            for sp in (self.eye_id_spin, self.eye_wall_spin):
                sp.setRange(0.0, 500.0)
                sp.setSingleStep(0.25)
                sp.setSuffix(" mm")
        else:
            self.height_spin.setRange(MIN_IN, 160.0)
            self.height_spin.setSingleStep(0.125)
            self.height_spin.setSuffix(" in")
            self.lead_spin.setRange(0.005, 10.0)
            self.lead_spin.setSingleStep(0.025)
            self.lead_spin.setSuffix(" in")
            self.clear_spin.setRange(0.001, 2.0)
            self.clear_spin.setSingleStep(0.002)
            self.clear_spin.setSuffix(" in")
            for sp in (self.eye_id_spin, self.eye_wall_spin):
                sp.setRange(0.0, 20.0)
                sp.setSingleStep(0.01)
                sp.setSuffix(" in")
        self.height_spin.blockSignals(False)
        self.lead_spin.blockSignals(False)
        self.clear_spin.blockSignals(False)
        self.eye_id_spin.blockSignals(False)
        self.eye_wall_spin.blockSignals(False)

    def _set_lead_enabled(self, on: bool) -> None:
        for w in (self.lead_spin, self.lead_label,
                  self.clear_spin, self.clear_label):
            w.setEnabled(on)

    def _lead_toggled(self, on: bool) -> None:
        self._set_lead_enabled(on)
        self._schedule_preview()

    def _unit_toggled(self, _on: bool) -> None:
        """Switching mm<->in converts the number so the artwork keeps its size."""
        new = self.unit()
        old_val = self.height_spin.value()
        conv = old_val * MM_PER_IN if new == "mm" else old_val / MM_PER_IN
        f_unit = MM_PER_IN if new == "mm" else 1 / MM_PER_IN
        lead_conv = self.lead_spin.value() * f_unit
        clear_conv = self.clear_spin.value() * f_unit
        eye_id_conv = self.eye_id_spin.value() * f_unit
        eye_wall_conv = self.eye_wall_spin.value() * f_unit
        self._apply_unit_limits(new)
        self.height_spin.blockSignals(True)
        self.height_spin.setValue(conv)
        self.height_spin.blockSignals(False)
        self.lead_spin.blockSignals(True)
        self.lead_spin.setValue(lead_conv)     # lead-ins keep their real length
        self.lead_spin.blockSignals(False)
        self.clear_spin.blockSignals(True)
        self.clear_spin.setValue(clear_conv)
        self.clear_spin.blockSignals(False)
        for sp, v in ((self.eye_id_spin, eye_id_conv),
                      (self.eye_wall_spin, eye_wall_conv)):
            sp.blockSignals(True)
            sp.setValue(v)
            sp.blockSignals(False)
        # sheet gap is in the same unit — convert it too, so the sheet keeps its look
        self.gap_spin.setValue(self.gap_spin.value() *
                               (MM_PER_IN if new == "mm" else 1 / MM_PER_IN))
        self._schedule_preview()

    def caret_name(self) -> str:
        """The name the caret is on — that is what gets previewed."""
        text = self.names.toPlainText()
        if not text.strip():
            return ""
        block = self.names.textCursor().blockNumber()
        lines = text.split("\n")
        if 0 <= block < len(lines) and lines[block].strip():
            return lines[block].strip()
        for line in lines:                      # caret on a blank line
            if line.strip():
                return line.strip()
        return ""

    def all_names(self) -> list[str]:
        return [l.strip() for l in self.names.toPlainText().split("\n") if l.strip()]

    # Messages the engine emits that are NORMAL for these fonts and must not
    # raise an amber warning. Most of Sean's fonts are cut-only by design, so
    # "no engrave lines" is the expected state, not a problem — and a panel that
    # cries wolf on every font is a panel nobody reads. The engrave count in the
    # grey line under the preview already says 0, which is the honest report.
    _NOT_A_WARNING = ("no engrave lines",)

    def _render_notes(self) -> None:
        """One amber panel for both the font check and the current preview."""
        notes = [n for n in (list(getattr(self, "_font_notes", []))
                             + list(getattr(self, "_preview_notes", [])))
                 if not any(q in n.lower() for q in self._NOT_A_WARNING)]
        if notes:
            self.warn_label.setText("\n".join("⚠ " + n for n in notes))
            self.warn_label.show()
        else:
            self.warn_label.hide()

    # --------------------------------------------------------------- preview #
    def _schedule_preview(self) -> None:
        self._timer.start()
        self._update_export_enabled()

    def _do_preview(self) -> None:
        path = self.current_font_path()
        name = self.caret_name()
        if not path or not name:
            self.canvas.set_placeholder("Type a name to see the cut file"
                                        if path else "No font available")
            self.canvas.set_result(None)
            self.size_label.setText("—")
            self.count_label.setText("")
            self._clear_eyelet_table(
                "Type a name — the eyelet is part of the artwork, so it is "
                "measured on the name, not on the font.")
            self._preview_notes = []       # keep the font-check notes visible
            self._render_notes()
            return
        self._req += 1
        self._last_preview_id = self._req
        self.newestPreview.emit(self._req)      # let queued builds skip themselves
        self.requestPreview.emit(self._req, path, name,
                                 self.height_spin.value(), self.unit(),
                                 self.basis(), self.cb_lead.isChecked(),
                                 self.lead_spin.value(), self.clear_spin.value(),
                                 self.cb_thin.isChecked(),
                                 self.thin_spin.target(),
                                 self.eye_id_spin.target(),
                                 self.eye_wall_spin.target(),
                                 self.cb_eyedim.isChecked(),
                                 self.cb_eyewant.isChecked())

    @Slot(int, object)
    def _preview_ready(self, req_id: int, res: PreviewResult) -> None:
        if req_id != self._last_preview_id:
            return                                    # a newer request won
        self.canvas.set_result(res)
        self.size_label.setText(
            f"{res.text} — {res.width:.3f} × {res.height:.3f} {res.unit}")
        txt = (f"{res.n_cut} cut contour{'s' if res.n_cut != 1 else ''}, "
               f"{res.n_engrave} engrave line{'s' if res.n_engrave != 1 else ''}")
        if res.leadins:
            txt += (f", {len(res.leadins)} lead-in"
                    f"{'s' if len(res.leadins) != 1 else ''}")
        if res.thin_text:
            txt += f"  ·  {res.thin_text}"
        self.count_label.setText(txt)
        self._fill_eyelet_table(res)
        notes = list(res.warnings)
        if res.pieces > 1:
            notes.insert(0, f"This name cuts as {res.pieces} loose pieces, not "
                            f"one plate. Gap at: {res.gap_text}. "
                            f"Click “Check font” for the full letter-join list.")
        self._preview_notes = notes
        self._render_notes()

    @Slot(int, str)
    def _preview_failed(self, req_id: int, msg: str) -> None:
        if req_id != self._last_preview_id:
            return
        self.canvas.set_result(None)
        self.canvas.set_placeholder("Preview failed")
        self.size_label.setText("—")
        self.count_label.setText("")
        self._clear_eyelet_table("No measurement — the preview failed.")
        self._preview_notes = [
            msg, "Click “Check font” for what to fix in this font."]
        self._render_notes()

    # ---------------------------------------------------------------- export #
    def _update_export_enabled(self) -> None:
        busy = self._export_thread is not None
        ok = bool(self.all_names()) and bool(self.formats()) and \
            bool(self.current_font_path()) and not busy
        self.btn_zip.setEnabled(ok)
        self.btn_sheet.setEnabled(ok)

    def export(self, kind: str) -> None:
        names = self.all_names()
        fmts = self.formats()
        path = self.current_font_path()
        if not (names and fmts and path):
            return

        if kind == "per-name":
            default = os.path.join(os.path.expanduser("~"), "nameplates.zip")
            dest, _ = QFileDialog.getSaveFileName(
                self, "Save one file per name (zip)", default, "Zip archive (*.zip)")
            if not dest:
                return
            if not dest.lower().endswith(".zip"):
                dest += ".zip"
        else:
            default = os.path.join(os.path.expanduser("~"), "sheet")
            filt = "SVG (*.svg)" if fmts == ["svg"] else \
                   ("PDF (*.pdf)" if fmts == ["pdf"] else "SVG and PDF (*.svg *.pdf)")
            dest, _ = QFileDialog.getSaveFileName(
                self, "Save one sheet — file name without extension", default, filt)
            if not dest:
                return
            dest = os.path.splitext(dest)[0]          # writers add .svg / .pdf

        job = ExportJob(kind=kind, font_path=path, names=names,
                        height=self.height_spin.value(), unit=self.unit(),
                        basis=self.basis(), formats=fmts,
                        gap=self.gap_spin.value(), dest=dest,
                        lead_in=self.cb_lead.isChecked(),
                        lead_len=self.lead_spin.value(),
                        lead_clear=self.clear_spin.value(),
                        direction=self.direction())
        self._start_export(job)

    def _start_export(self, job: ExportJob) -> None:
        names = job.names
        self._export_thread = QThread(self)
        self._export_worker = ExportWorker(job)
        self._export_worker.moveToThread(self._export_thread)
        self._export_thread.started.connect(self._export_worker.run)
        self._export_worker.progress.connect(self._export_progress)
        self._export_worker.finished.connect(self._export_finished)
        self._export_worker.failed.connect(self._export_failed)

        if len(names) > PROGRESS_THRESHOLD:
            self.progress.setRange(0, len(names) + 1)
            self.progress.setValue(0)
            self.progress.show()
        self.status.setText(f"Building {len(names)} name(s)…")
        self._update_export_enabled()
        self._export_thread.start()

    @Slot(int, int, str)
    def _export_progress(self, done: int, total: int, label: str) -> None:
        if self.progress.isVisible():
            self.progress.setRange(0, total)
            self.progress.setValue(done)
        self.status.setText(f"{done}/{total} · {label}")

    def _teardown_export(self) -> None:
        if self._export_thread:
            self._export_thread.quit()
            self._export_thread.wait(3000)
        self._export_thread = None
        self._export_worker = None
        self.progress.hide()
        self._update_export_enabled()

    @Slot(list)
    def _export_finished(self, written: list) -> None:
        self._teardown_export()
        self.status.setText("Wrote: " + " · ".join(os.path.basename(p)
                                                   for p in written))
        self.last_written = list(written)
        if not self._quiet:
            QMessageBox.information(
                self, "Export complete", "Wrote:\n\n" + "\n".join(written))

    @Slot(str)
    def _export_failed(self, msg: str) -> None:
        self._teardown_export()
        self.status.setText("Export failed.")
        self._error("Export failed", msg)

    # ------------------------------------------------------------ font check #
    def reload_font(self) -> None:
        """Force the newest file on disk to be used, not a cached copy."""
        path = self.current_font_path()
        if not path:
            return
        name = os.path.basename(path)
        self.requestForget.emit(path)          # clear the worker's cached Font
        self.settings["font_path"] = path
        self.refresh_fonts(initial=True)       # re-read family / date / size
        self._schedule_preview()
        self.status.setText(f"Re-read {name} from disk.")

    def _clear_eyelet_table(self, note: str = "") -> None:
        for cells in self.eye_cells.values():
            for lb in cells:
                lb.setText("")
        self.eye_status.setText(note)

    def _fill_eyelet_table(self, res) -> None:
        """actual | want | change, from the same measurement the report uses.

        A row's want and change cells stay BLANK when nothing was typed for it —
        an empty cell says "not asked for", where a 0.0% would claim the eyelet
        is already right.
        """
        eyes = getattr(res, "eyelets", None) or []
        if not eyes:
            if getattr(res, "eye_error", ""):
                self._clear_eyelet_table(res.eye_error)
            elif res.eye_target_id or res.eye_target_wall or res.show_eye_dims:
                self._clear_eyelet_table("measuring…")
            else:
                self._clear_eyelet_table(
                    "Tick “Show eyelet sizes” or type a wanted size to measure.")
            return

        e = eyes[0]
        t_id = res.eye_target_id or 0.0
        t_wall = res.eye_target_wall or 0.0
        wall_avg = e.wall_from_diameters
        # Outer diameter follows from whatever was asked for, exactly as
        # nameplate_eyelets.adjustment computes it, so the two cannot disagree.
        t_od = ((t_id or e.inner_d) + 2 * (t_wall or wall_avg)
                if (t_id or t_wall) else 0.0)
        rows = {
            "id": (e.inner_d, t_id),
            "od": (e.outer_d, t_od),
            "wall": (wall_avg, t_wall),
            # The thinnest wall has no separate target: asking for a wall means
            # asking for the average. Showing the want against the thinnest
            # would quietly compare two different things.
            "wall_min": (e.wall_min, 0.0),
        }
        for key, (actual, want) in rows.items():
            a_lb, w_lb, c_lb = self.eye_cells[key]
            a_lb.setText(f"{actual:.4f}")
            if want:
                w_lb.setText(f"{want:.4f}")
                pct = ((want / actual) - 1.0) * 100.0 if actual else float("nan")
                c_lb.setText(f"{pct:+.2f}%")
                # green only when it is already the wanted size; otherwise leave
                # the palette's own colour so it reads in light and dark themes
                c_lb.setStyleSheet(
                    "color:#2f9e44;" if abs(pct) < 0.005 else "")
            else:
                w_lb.setText("")
                c_lb.setText("")
                c_lb.setStyleSheet("")
        note = f"{e.side} eyelet, at {res.height:.3f} {res.unit} tall artwork"
        if len(eyes) > 1:
            note += f" (both ends measured; “Full eyelet report…” shows each)"
        if e.note:
            note += f" — {e.note}"
        self.eye_status.setText(f"sizes in {res.unit}. {note}.")

    def eyelet_report_text(self) -> str:
        """Eyelet measurements for the name and height currently previewed."""
        path = self.current_font_path()
        name = self.caret_name()
        if not path:
            return "No font selected."
        if not name:
            return ("Type a name first. The eyelet is part of the artwork, not "
                    "of the font on its own — it is a contextual form that only "
                    "appears on the first and last letter, so there is nothing "
                    "to measure until a name is shaped.")
        try:
            from nameplate_core import Font as _F, build_document as _bd
            from nameplate_eyelets import report_text
            doc = _bd(_F(path), name, self.height_spin.value(),
                      self.unit(), self.basis())
            return report_text(doc,
                               target_id=self.eye_id_spin.target() or None,
                               target_wall=self.eye_wall_spin.target() or None)
        except Exception as exc:
            return (f"Could not measure: {type(exc).__name__}: {exc}\n\n"
                    f"Click “Check font” to see whether the font itself is the "
                    f"problem.")

    def measure_eyelets(self) -> None:
        self._ask_report("eyelets", "Measuring the eyelets…")

    def measure_thickness(self) -> None:
        """Full thin-area report, plus the paste-ready fix when a target is set."""
        path = self.current_font_path()
        name = self.caret_name()
        if not (path and name):
            self.status.setText("Type a name first — thickness is measured on "
                                "the artwork, not the font.")
            return
        self._ask_report("thickness", "Measuring the thin areas…")

    def font_report_text(self, path: str) -> str:
        """Human-readable defect list for one font, or a reason it is missing."""
        try:
            from nameplate_fontcheck import check_font
            return check_font(path).text()
        except Exception as exc:
            return f"The font checker itself failed: {type(exc).__name__}: {exc}"

    def check_font(self) -> None:
        path = self.current_font_path()
        if not path:
            return
        # ONE check, on the report thread. This used to run the whole check
        # TWICE on the GUI thread -- once for the text, once for the prompt --
        # freezing the window for ~10 s on the slowest shipped font. And because
        # the join scan inside is wall-clock budgeted, the two runs could
        # truncate at different pair counts, so the report and the prompt in the
        # SAME dialog could describe different scans. text() and claude_prompt()
        # on an already-built Report are free.
        self._ask_report("check", f"Checking {os.path.basename(path)}\u2026")

    def show_health(self) -> None:
        """What build this is and whether this machine can run it."""
        text = health_report()
        self._last_report = text
        if self._quiet:
            return
        TextDialog(self, "Health check", text,
                   copy_label="Copy for a bug report", width=760,
                   height=560).exec()

    # ------------------------------------------------------------- prompts #
    def generate_prompts(self) -> None:
        """Every paste-ready prompt for the current font, in one window.

        A section is left BLANK when there is nothing to ask for. That is the
        answer, not a failure: a font with no defects should produce no repair
        request, and inventing one would send someone to edit a font that is
        already right.

        Runs on the report thread — it costs a full font check plus a pair scan,
        which froze the window for ~9 s when it ran here.
        """
        self._ask_report("prompts", "Building the prompts\u2026")

    def show_pair_sheets(self, path: str | None = None) -> None:
        """Open every letter combination in one scrollable window.

        Nothing is written to disk — the grid is drawn live from the glyph
        outlines, so it shows the font as Illustrator would with the text
        converted to outlines, and the only file that ever appears is the one the
        user explicitly asks to save.

        The analysis runs on the report thread (~3.5 s on the slowest shipped
        font) and the Font it opened is handed over with the result, so the grid
        can draw glyphs from it without two threads ever touching one Font.
        """
        self._ask_report("pairs", "Analysing every letter pair\u2026")

    # ---- what to do with each finished report, on the GUI thread --------- #
    def _show_report(self, kind: str, payload) -> None:
        if kind == "check":
            body = payload.get("text", "")
            prompt = payload.get("prompt", "")
            if prompt:
                body += ("\n\n" + "=" * 72 +
                         "\nPASTE THIS TO CLAUDE TO FIX IT\n" + "=" * 72 +
                         "\n\n" + prompt)
            self._last_report = body
            if self._quiet:
                return
            path = self.current_font_path() or ""
            TextDialog(self, f"Font check \u2014 {os.path.basename(path)}", body,
                       copy_label="Copy everything", width=900,
                       extra=[("View every letter pair\u2026",
                               self.show_pair_sheets),
                              ("Generate prompts\u2026",
                               self.generate_prompts)]).exec()
            return

        if kind == "thickness":
            body = payload.get("text", "")
            prompt = payload.get("prompt", "")
            if prompt:
                # in the same selectable box, under a heading, so it can be read
                # and part-copied by hand as well as taken whole with the button
                body += ("\n\n" + "=" * 72 +
                         "\nPASTE THIS TO CLAUDE TO FIX IT\n" + "=" * 72 +
                         "\n\n" + prompt)
            self._last_report = body
            if self._quiet:
                return
            TextDialog(self, "Thin areas", body, copy_label="Copy everything",
                       extra=[("Generate prompts\u2026",
                               self.generate_prompts)]).exec()
            return

        if kind == "eyelets":
            body = payload.get("text", "")
            self._last_report = body
            if self._quiet:
                return
            TextDialog(self, "Eyelet measurements", body,
                       copy_label="Copy the whole report",
                       extra=[("Generate prompts\u2026",
                               self.generate_prompts)]).exec()
            return

        if kind == "prompts":
            sections = payload.get("sections") or []
            self._last_prompt_sections = sections
            if self._quiet:
                return
            PromptsDialog(self, sections).exec()
            return

        if kind == "pairs":
            report = payload.get("report")
            font = payload.get("font")
            prompt = payload.get("prompt", "")
            if report is None or font is None:
                self._error("Could not analyse the letter pairs", "no result")
                return
            self._last_pair_report = report
            if self._quiet:
                return
            path = self.current_font_path() or ""
            PairSheetDialog(self, font, report, path, prompt).exec()
            return

    # ----------------------------------------------------------------- errors #
    def _error(self, title: str, detail: str) -> None:
        if self._quiet:
            print(f"ERROR: {title}: {detail}", file=sys.stderr)
            return
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Critical)
        box.setWindowTitle(title)
        box.setText(title)
        box.setInformativeText(detail)
        box.exec()


# --------------------------------------------------------------------------- #
#  --selftest — drives the real widgets offscreen.
#
#  A --windowed exe cannot be clicked from a script, so this is how the frozen
#  build is verified: it proves the exe finds fonts/ next to itself, builds a
#  preview, paints it, and writes both export kinds. Not part of the UI.
# --------------------------------------------------------------------------- #
def selftest(outdir: str) -> int:
    """Run the checks and always leave a report file behind.

    A --windowed exe has no stdout, so the report file is the only way to read
    the result of a selftest run against the frozen build.
    """
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    # The requested folder may be read-only (the app copied to a locked-down
    # location). Crashing on makedirs left NO report and NO log anywhere —
    # the one situation a diagnostic mode exists for. Fall back to a temp dir
    # and say so, rather than dying on the first write.
    try:
        os.makedirs(outdir, exist_ok=True)
        probe = os.path.join(outdir, "_w.tmp")
        with open(probe, "w") as fh:
            fh.write("x")
        os.remove(probe)
    except OSError as exc:
        import tempfile
        fallback = tempfile.mkdtemp(prefix="sfpf_selftest_")
        log(f"selftest outdir {outdir!r} not writable ({exc}); "
            f"using {fallback}")
        outdir = fallback
    report_path = os.path.join(outdir, "selftest_report.txt")
    lines: list[str] = [f"report location: {report_path}"]

    def out(msg: str = "") -> None:
        lines.append(str(msg))
        if sys.stdout is not None:
            try:
                print(msg)
            except Exception:
                pass

    try:
        return _selftest_body(outdir, out)
    except Exception:
        out("EXCEPTION during selftest:")
        out(traceback.format_exc())
        return 1
    finally:
        try:
            with open(report_path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
        except Exception:
            pass


def _selftest_body(outdir: str, out) -> int:
    import re
    import time

    app = QApplication(sys.argv[:1])
    checks: list[tuple[bool, str, str]] = []

    def rec(ok: bool, name: str, detail: str) -> None:
        checks.append((ok, name, detail))
        out(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    def pump(cond, timeout=25.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            app.processEvents()
            if cond():
                return True
            time.sleep(0.01)
        return False

    _man = build_manifest()
    out(f"build     = {_man.get('build_id', '(no manifest - from source)')}"
        f"  built {_man.get('built_utc', '?')}")
    out(f"frozen={getattr(sys, 'frozen', False)}")
    out(f"executable= {sys.executable}")
    out(f"BASE      = {BASE}")
    out(f"FONTS_DIR = {FONTS_DIR}")
    out(f"settings  = {SETTINGS_PATH}")
    out(f"platform  = {os.environ.get('QT_QPA_PLATFORM')}")
    try:
        import pyi_splash                                  # type: ignore
        out(f"splash    = available (pyi_splash), "
            f"still showing={pyi_splash.is_alive()}")
        pyi_splash.close()
    except ImportError:
        out("splash    = not in this build (normal when running from source)")
    except Exception as exc:
        out(f"splash    = present but errored: {type(exc).__name__}: {exc}")
    icon_p = os.path.join(getattr(sys, "_MEIPASS", BASE), "assets", "icon.ico")
    out(f"icon      = {icon_p} exists={os.path.isfile(icon_p)}")

    win = MainWindow()
    win._quiet = True
    win.last_written = []
    # settings.json persists the last unit and height, which is right for a
    # person and wrong for a test: a previous run leaving mm behind would fail
    # checks written in inches. Start from the documented defaults.
    win.rb_in.setChecked(True)
    win.height_spin.setValue(1.0)
    win.cb_lead.setChecked(False)
    win.cb_thin.setChecked(False)
    win.cb_eyedim.setChecked(False)
    win.thin_spin.setValue(0.0)
    win.eye_id_spin.setValue(0.0)
    win.eye_wall_spin.setValue(0.0)
    win.show()
    app.processEvents()

    # 1. fonts listed from fonts/ next to the exe
    fams = [win.font_combo.itemText(i) for i in range(win.font_combo.count())]
    rec(len(fams) > 0, "exe lists fonts in fonts\\", f"{len(fams)} -> {fams}")
    if not fams:
        return 1

    # pick Merriweather so the expected numbers apply
    for i in range(win.font_combo.count()):
        if "Merriweather" in win.font_combo.itemText(i):
            win.font_combo.setCurrentIndex(i)
            break
    rec("Merriweather" in win.font_combo.currentText(),
        "selected Merriweather", win.font_combo.currentText())

    # 2. font detail line reports engrave capability
    pump(lambda: "checking" not in win.font_detail.text(), 20)
    rec("carries engrave lines" in win.font_detail.text(),
        "font detail reports engrave capability", win.font_detail.text())

    # 3. preview builds for the caret's name.
    # Unit first: switching units converts the number, so setting height before
    # the unit would re-scale (and clamp) whatever we just set.
    win.rb_in.setChecked(True)
    win.rb_cap.setChecked(True)
    win.height_spin.setValue(1.0)
    win.names.setPlainText("ADAM\nOLIVIA\nMary Jane")
    ok = pump(lambda: "ADAM —" in win.size_label.text(), 25)
    rec(ok and "4.069 × 1.020 in" in win.size_label.text(),
        "preview size label", win.size_label.text())
    rec("6 cut contours, 10 engrave lines" == win.count_label.text(),
        "preview counts", win.count_label.text())

    # 4. the canvas actually paints something
    pm = win.canvas.grab()
    img = pm.toImage()
    black = red = 0
    for y in range(0, img.height(), 2):
        for x in range(0, img.width(), 2):
            c = img.pixelColor(x, y)
            if c.red() < 80 and c.green() < 80 and c.blue() < 80:
                black += 1
            elif c.red() > 180 and c.green() < 90 and c.blue() < 90:
                red += 1
    png = os.path.join(outdir, "selftest_preview.png")
    pm.save(png)
    rec(black > 200 and red > 20, "canvas painted cut (black) + engrave (red)",
        f"{black} dark px, {red} red px, {img.width()}x{img.height()} -> {png}")

    wpng = os.path.join(outdir, "selftest_window.png")
    win.grab().save(wpng)
    out(f"       full window image -> {wpng}")

    # 5. per-name zip export
    zip_path = os.path.join(outdir, "selftest_per_name.zip")
    win.last_written = []
    win._start_export(ExportJob(
        kind="per-name", font_path=win.current_font_path(),
        names=["ADAM", "OLIVIA", "Mary Jane"], height=1.0, unit="in",
        basis="cap", formats=["svg", "pdf"], gap=0.25, dest=zip_path))
    ok = pump(lambda: bool(win.last_written) or "failed" in win.status.text().lower(), 90)
    names_in_zip: list[str] = []
    if os.path.exists(zip_path):
        with zipfile.ZipFile(zip_path) as zf:
            names_in_zip = sorted(zf.namelist())
            bad = zf.testzip()
    else:
        bad = "missing"
    want = ["ADAM.pdf", "ADAM.svg", "Mary_Jane.pdf", "Mary_Jane.svg",
            "OLIVIA.pdf", "OLIVIA.svg"]
    rec(ok and names_in_zip == want and bad is None,
        "per-name zip export", f"{names_in_zip} (testzip={bad})")

    # 6. one-sheet export
    stem = os.path.join(outdir, "selftest_sheet")
    win.last_written = []
    win._start_export(ExportJob(
        kind="sheet", font_path=win.current_font_path(),
        names=["ADAM", "OLIVIA", "Mary Jane"], height=1.0, unit="in",
        basis="cap", formats=["svg", "pdf"], gap=0.25, dest=stem))
    ok = pump(lambda: bool(win.last_written) or "failed" in win.status.text().lower(), 90)
    svg_ok = os.path.exists(stem + ".svg") and os.path.getsize(stem + ".svg") > 2000
    pdf_ok = os.path.exists(stem + ".pdf") and \
        open(stem + ".pdf", "rb").read(5) == b"%PDF-"
    rec(ok and svg_ok and pdf_ok, "one-sheet export",
        f"sheet.svg={os.path.getsize(stem + '.svg') if svg_ok else 'MISSING'} B, "
        f"sheet.pdf={os.path.getsize(stem + '.pdf') if pdf_ok else 'MISSING'} B")

    # 7. mm/in conversion keeps the physical size
    win.rb_mm.setChecked(True)
    ok = pump(lambda: abs(win.height_spin.value() - 25.4) < 1e-6, 10)
    rec(ok, "in -> mm converts the number", f"{win.height_spin.value()} mm")
    ok = pump(lambda: "ADAM —" in win.size_label.text()
              and "mm" in win.size_label.text(), 25)
    rec(ok and "103.361 × 25.896 mm" in win.size_label.text(),
        "preview after unit switch is the same physical size", win.size_label.text())

    # 8. settings.json is written next to the exe
    win._persist()
    s = load_settings()
    rec(os.path.exists(SETTINGS_PATH) and bool(s.get("font_path")),
        "settings.json written next to exe",
        f"{SETTINGS_PATH} -> font_path={os.path.basename(s.get('font_path', ''))}")

    # 8b. lead-in toggle: preview gains lead-ins, reported size must not move
    win.rb_in.setChecked(True)
    for i in range(win.font_combo.count()):
        if "Merriweather" in win.font_combo.itemText(i):
            win.font_combo.setCurrentIndex(i)
            break
    win.height_spin.setValue(1.0)
    win.names.setPlainText("ADAM")
    pump(lambda: "ADAM —" in win.size_label.text()
         and "4.069 × 1.020 in" in win.size_label.text(), 25)
    before = win.size_label.text()
    win.cb_lead.setChecked(True)
    ok = pump(lambda: "lead-in" in win.count_label.text(), 25)
    after = win.size_label.text()
    rec(ok and before == after,
        "lead-ins appear and the stated height does NOT change",
        f"{win.count_label.text()!r}; size {before!r} -> {after!r}")
    win.grab().save(os.path.join(outdir, "selftest_window_leadin.png"))

    lead_zip = os.path.join(outdir, "selftest_leadin.zip")
    win.last_written = []
    win._start_export(ExportJob(
        kind="per-name", font_path=win.current_font_path(), names=["ADAM"],
        height=1.0, unit="in", basis="cap", formats=["svg", "pdf"], gap=0.25,
        dest=lead_zip, lead_in=True, lead_len=0.1))
    ok = pump(lambda: bool(win.last_written)
              or "failed" in win.status.text().lower(), 90)
    detail = "no zip"
    if os.path.exists(lead_zip):
        import re as _re
        with zipfile.ZipFile(lead_zip) as zf:
            svg = zf.read("ADAM.svg").decode("utf-8")
        gids = _re.findall(r'<g id="([^"]+)"', svg)
        subs = [g for g in gids if "__" in g]
        # cutting order is file order: engrave, inner cuts, then the outline
        order_ok = (len(subs) == 3
                    and "engrave" in subs[0] and "cut_inner" in subs[1]
                    and "cut_outline" in subs[2])
        opens = sum(1 for d in _re.findall(r'<path d="([^"]*)"', svg)
                    if "Z" not in d)
        no_dims = ("<text" not in svg and "<rect" not in svg)
        ok = ok and order_ok and opens >= 6 and no_dims
        detail = (f"groups {gids}; {opens} open path(s); "
                  f"order engrave->inner->outline: {order_ok}; "
                  f"no <text>/<rect>: {no_dims}")
    rec(ok, "lead-in export is written in cutting order, outline last", detail)

    win.cb_lead.setChecked(False)
    pump(lambda: "lead-in" not in win.count_label.text(), 20)

    # 9. a cut-only font is NORMAL: it must not raise an amber warning, must
    # still say 0 engrave lines in the grey line, and must still export. Most of
    # Sean's fonts carry no engraving, so warning about it every time trained
    # people to ignore the panel that also carries the real problems.
    win.rb_in.setChecked(True)
    for i in range(win.font_combo.count()):
        if "Carrie SO v2" in win.font_combo.itemText(i):
            win.font_combo.setCurrentIndex(i)
            break
    win.names.setPlainText("Carrie")
    # Wait for the CUT-ONLY font's own result, not for whatever was on screen:
    # "engrave line" was already there from the previous font, so the check used
    # to run against Merriweather and prove nothing.
    ok = pump(lambda: bool(win.canvas._res
                           and win.canvas._res.text == "Carrie"
                           and not win.canvas._res.has_colr), 30)
    res = win.canvas._res
    quiet = not (win.warn_label.isVisible()
                 and "engrave" in win.warn_label.text().lower())
    rec(ok and quiet and win.btn_zip.isEnabled() and win.btn_sheet.isEnabled(),
        "a cut-only font does NOT warn in amber, and still exports",
        f"counts={win.count_label.text()!r} "
        f"amber_visible={win.warn_label.isVisible()} "
        f"amber={win.warn_label.text()[:70]!r} zip={win.btn_zip.isEnabled()}")
    # \b so this cannot be satisfied by the "0" inside "10 engrave lines"
    rec(bool(ok and res and res.n_engrave == 0
             and re.search(r"\b0 engrave lines\b", win.count_label.text())),
        "the engrave count is still stated honestly as 0",
        f"n_engrave={getattr(res, 'n_engrave', '?')} "
        f"counts={win.count_label.text()!r}")
    win.grab().save(os.path.join(outdir, "selftest_window_warning.png"))

    # 9-bis. the checker's probe names must be labelled as probes. Read bare, a
    # report line starting "'ADAM':" made every font look as if it were called
    # ADAM — Sean hit exactly that.
    _rep = win.font_report_text(win.current_font_path())
    _bare = [l.strip() for l in _rep.splitlines()
             if l.strip().startswith(("'ADAM'", "'Adam'", "ADAM:", "Adam:"))]
    rec(not _bare and "test name" in _rep,
        "the checker calls ADAM/Adam test names, never the font's own name",
        f"unlabelled lines={_bare[:3]}")

    # 8c. side-by-side sheet export: wider than tall, and it must refuse to
    # write a sheet whose names would overlap
    stem_h = os.path.join(outdir, "selftest_sheet_horizontal")
    win.last_written = []
    win._start_export(ExportJob(
        kind="sheet", font_path=win.current_font_path(),
        names=["ADAM", "OLIVIA", "Mary Jane"], height=1.0, unit="in",
        basis="cap", formats=["svg"], gap=0.25, dest=stem_h,
        direction="horizontal"))
    ok = pump(lambda: bool(win.last_written)
              or "failed" in win.status.text().lower(), 90)
    detail = "no file"
    if os.path.exists(stem_h + ".svg"):
        import re as _re3
        head = open(stem_h + ".svg", encoding="utf-8").read(400)
        m = _re3.search(r'width="([\d.]+)in" height="([\d.]+)in"', head)
        if m:
            w_h, h_h = float(m.group(1)), float(m.group(2))
            ok = ok and w_h > h_h * 3          # a row, not a column
            detail = f"{w_h:.3f} x {h_h:.3f} in (wide, so laid out in a row)"
    rec(ok, "side-by-side sheet export", detail)

    # 8d. thin areas: found, summarised, and the target draws a comparison
    win.names.setPlainText("ADAM")
    win.cb_lead.setChecked(False)
    pump(lambda: "4.069" in win.size_label.text(), 25)
    win.cb_thin.setChecked(True)
    ok = pump(lambda: "thinnest" in win.count_label.text(), 60)
    rec(ok, "thin areas are found and summarised",
        win.count_label.text()[-90:])
    # now ask for a thicker target and confirm an overlay is produced
    win.thin_spin.setValue(0.15)
    ok2 = pump(lambda: bool(getattr(win.canvas, "_res", None)
                            and win.canvas._res.overlays), 60)
    n_ov = len(win.canvas._res.overlays) if win.canvas._res else 0
    rec(ok2 and n_ov >= 1, "a target thickness draws a comparison overlay",
        f"{n_ov} overlay(s): "
        f"{[o[2] for o in (win.canvas._res.overlays if win.canvas._res else [])]}")
    win.grab().save(os.path.join(outdir, "selftest_window_thin.png"))
    win.cb_thin.setChecked(False)
    win.thin_spin.setValue(0.0)
    pump(lambda: "thinnest" not in win.count_label.text(), 30)

    # 9a. Reload font re-reads from disk and the preview survives it
    win.rb_in.setChecked(True)
    for i in range(win.font_combo.count()):
        if "Merriweather" in win.font_combo.itemText(i):
            win.font_combo.setCurrentIndex(i)
            break
    win.height_spin.setValue(1.0)
    win.names.setPlainText("ADAM")
    pump(lambda: "4.069 × 1.020 in" in win.size_label.text(), 25)
    win.size_label.setText("(cleared)")
    win.reload_font()
    ok = pump(lambda: "4.069 × 1.020 in" in win.size_label.text(), 30)
    rec(ok and "Re-read" in win.status.text(),
        "Reload font re-reads the file and rebuilds the preview",
        f"status={win.status.text()!r} size={win.size_label.text()!r}")

    # 9b. a name that cannot cut as one piece is reported with the junction
    rec(hasattr(win, "btn_reload") and hasattr(win, "btn_check"),
        "Reload font and Check font buttons present",
        f"reload={hasattr(win, 'btn_reload')} check={hasattr(win, 'btn_check')}")

    # 9b2. eyelet measurement reports real numbers for the current artwork
    win.names.setPlainText("ADAM")
    pump(lambda: "4.069 × 1.020 in" in win.size_label.text(), 25)
    etxt = win.eyelet_report_text()
    import re as _re2
    idm = _re2.search(r"inner diameter\s+([\d.]+) in", etxt)
    odm = _re2.search(r"outer diameter\s+([\d.]+) in", etxt)
    ok = bool(idm and odm) and float(odm.group(1)) > float(idm.group(1)) > 0
    rec(ok, "eyelet measurement returns ID < OD",
        f"ID={idm.group(1) if idm else '?'} OD={odm.group(1) if odm else '?'} in")

    # 9b3. the eyelet toggle fills the on-screen table and draws the dimensions
    win.cb_eyedim.setChecked(True)
    ok = pump(lambda: bool(win.eye_cells["id"][0].text()), 60)
    cells = {k: [c.text() for c in v] for k, v in win.eye_cells.items()}
    rec(ok and cells["id"][0] and not cells["id"][1] and not cells["id"][2],
        "eyelet toggle fills actual, leaves want/change blank",
        f"{cells}")
    res = win.canvas._res
    rec(bool(res and res.show_eye_dims and res.eyelets
             and res.eyelets[0].wall_min_at),
        "the canvas gets eyelets and the thinnest-wall point to draw",
        f"show={getattr(res, 'show_eye_dims', None)} "
        f"n={len(getattr(res, 'eyelets', []) or [])} "
        f"wall_at={getattr((getattr(res, 'eyelets', None) or [None])[0], 'wall_min_at', None)}")

    # 9b4. typing a wanted ID must redraw the preview with the target ring on
    # it. This is the whole point of the feature and it silently did nothing
    # before: the spin box was never connected to the preview.
    want_id = round(float(idm.group(1)) * 1.10, 4)
    win.eye_id_spin.setValue(want_id)
    ok = pump(lambda: bool(win.canvas._res
                           and any("target inner diameter" in str(o[2])
                                   for o in (win.canvas._res.overlays or []))),
              60)
    labels = ([o[2] for o in (win.canvas._res.overlays or [])]
              if win.canvas._res else
              "preview failed: " + win.warn_label.text()[:120])
    rec(ok, "a wanted eyelet ID draws the target ring on the preview",
        f"want={want_id} overlays={labels}")
    pct = win.eye_cells["id"][2].text()
    rec(win.eye_cells["id"][1].text() == f"{want_id:.4f}" and pct.startswith("+"),
        "the want and change columns fill in",
        f"actual={win.eye_cells['id'][0].text()} "
        f"want={win.eye_cells['id'][1].text()} change={pct}")
    win.eye_wall_spin.setValue(0.2)
    ok = pump(lambda: bool(win.canvas._res
                           and any("target outer diameter" in str(o[2])
                                   for o in (win.canvas._res.overlays or []))),
              60)
    rec(ok, "a wanted wall draws the target outer ring too",
        f"overlays={[o[2] for o in (win.canvas._res.overlays or [])] if win.canvas._res else 'preview failed: ' + win.warn_label.text()[:120]}")
    win.grab().save(os.path.join(outdir, "selftest_window_eyelet.png"))

    # 9b4b. the wanted size is a toggle: untick and the rings go, the numbers stay
    win.cb_eyewant.setChecked(False)
    ok = pump(lambda: bool(win.canvas._res
                           and not any("target" in str(o[2])
                                       for o in (win.canvas._res.overlays or []))),
              60)
    rec(ok and win.eye_cells["id"][1].text() == f"{want_id:.4f}",
        "the wanted-size toggle hides the rings but keeps the numbers",
        f"overlays={[o[2] for o in (win.canvas._res.overlays or [])] if win.canvas._res else None} "
        f"want cell={win.eye_cells['id'][1].text()!r}")
    win.cb_eyewant.setChecked(True)
    ok = pump(lambda: bool(win.canvas._res
                           and any("target inner diameter" in str(o[2])
                                   for o in (win.canvas._res.overlays or []))),
              60)
    rec(ok, "ticking it back brings the rings back", "")

    # 9b4c. deleting the text in a target box means NOTHING, not 0
    win.eye_id_spin.lineEdit().setText("")
    rec(win.eye_id_spin.target() == 0.0 and win.eye_id_spin.is_blank(),
        "clearing a target box reads as nothing, not a number",
        f"target={win.eye_id_spin.target()} blank={win.eye_id_spin.is_blank()}")
    ok = pump(lambda: bool(win.canvas._res
                           and not any("target inner diameter" in str(o[2])
                                       for o in (win.canvas._res.overlays or []))
                           and not win.eye_cells["id"][1].text()),
              60)
    rec(ok, "clearing it drops the ring and blanks the want/change columns",
        f"want={win.eye_cells['id'][1].text()!r} "
        f"change={win.eye_cells['id'][2].text()!r} "
        f"overlays={[o[2] for o in (win.canvas._res.overlays or [])] if win.canvas._res else None}")
    # and the box itself must settle on the em dash, not snap back to the number
    win.eye_id_spin.interpretText()
    rec(win.eye_id_spin.value() == 0.0
        and win.eye_id_spin.text() == win.eye_id_spin.specialValueText(),
        "an emptied box commits to the em dash instead of the old value",
        f"value={win.eye_id_spin.value()} text={win.eye_id_spin.text()!r}")

    # 9b5. every thin spot carries the crossing it was measured on, which is
    # what the preview draws the distance across
    win.cb_thin.setChecked(True)
    ok = pump(lambda: bool(win.canvas._res and win.canvas._res.thin_spots), 60)
    spots = (win.canvas._res.thin_spots if win.canvas._res else [])
    good = all(getattr(s, "across", None) and len(s.across) == 2 for s in spots)
    rec(ok and good and len(spots) >= 1,
        "thin spots carry a 2-point crossing to draw the distance across",
        f"{len(spots)} spot(s), all with a crossing={good}")
    # the mark labels must not read as one number: "7. 0.0889 in" looked like a
    # 7.0889 in feature on a part whose whole height is 1.020 in
    labs = [PreviewCanvas.thin_label(i, sp, "in")
            for i, sp in enumerate(spots, 1)]
    bad = [t for t in labs if re.match(r"^\d+\.\s*\d", t)]
    rec(bool(labs) and not bad and all(t.startswith("#") for t in labs),
        "a thin mark's rank cannot be misread as part of the measurement",
        f"{labs[:3]}" + (f" AMBIGUOUS: {bad}" if bad else ""))
    _ts = [s.thickness for s in spots] or [0.0]
    cols = [PreviewCanvas._thin_colour(s, min(_ts), max(_ts), 0.0)
            for s in spots]
    rec(len(set(cols)) >= 2 and cols[0] == THIN_RAMP[0]
        and all(c.startswith("#") for c in cols),
        "thin spots are graded into severity colours, worst the most vivid",
        f"{len(set(cols))} colour(s) over "
        f"{min(_ts):.4f}-{max(_ts):.4f}: {cols}")
    _pass = PreviewCanvas._thin_colour(spots[0], min(_ts), max(_ts),
                                       spots[0].thickness * 0.5)
    rec(_pass == THIN_OK,
        "a spot that already meets the wanted thickness goes green",
        f"{_pass}")
    win.grab().save(os.path.join(outdir, "selftest_window_thinmarks.png"))

    # 9b6. Generate prompts: four sections, blank where there is nothing to ask.
    # These run on the report thread now, so the result has to be waited for
    # rather than read straight after the call.
    win._last_prompt_sections = []
    win.generate_prompts()
    ok = pump(lambda: bool(win._last_prompt_sections), 180)
    rec(ok, "Generate prompts finishes on the report thread without freezing",
        f"{len(win._last_prompt_sections)} section(s) came back")
    secs = win._last_prompt_sections
    titles = [t for t, _n, _b in secs]
    rec(len(secs) == 4 and all(t[0].isdigit() for t in titles),
        "Generate prompts produces one section per area", f"{titles}")
    by = {t.split(". ", 1)[-1]: b for t, _n, b in secs}
    rec(bool(by.get("Eyelet size")) and "FONT UNITS" in by["Eyelet size"],
        "the eyelet section is filled once a target is typed",
        f"{len(by.get('Eyelet size', ''))} chars")
    rec(by.get("Font defects") == "",
        "a clean font leaves the defect section BLANK, not a fake request",
        f"{len(by.get('Font defects', ''))} chars")
    rec(all(b.isascii() for b in by.values() if b),
        "every prompt is plain ASCII, so it pastes anywhere",
        f"{[k for k, b in by.items() if b and not b.isascii()]} non-ASCII")
    # ...and check the ones this run happened to leave EMPTY as well. The check
    # above only ever saw non-empty blocks, so the thin-area prompt -- which is
    # blank unless a target thickness is typed -- was never tested and shipped
    # with an em dash in it. Build all four directly, with targets supplied.
    _nonascii = {}
    try:
        from nameplate_core import Font as _F5, build_document as _bd5
        import nameplate_thickness as _TH5
        import nameplate_eyelets as _EY5
        import nameplate_pairsheet as _PS5
        from nameplate_fontcheck import check_font as _CF5
        _p5 = win.current_font_path()
        _f5 = _F5(_p5)
        _d5 = _bd5(_f5, "ADAM", 1.0, "in", "cap")
        for _label, _text in (
                ("thin_areas", _TH5.claude_prompt(_d5, 0.15, font_path=_p5,
                                                  font=_f5)),
                ("eyelet_size", _EY5.claude_prompt(_d5, target_id=0.4,
                                                   target_wall=0.2,
                                                   font_path=_p5)),
                ("font_defects", _CF5(_p5, join_scan_budget=0.0).claude_prompt()),
                ("letter_pairs", _PS5.claude_prompt(
                    _f5, _PS5.analyse_pairs(_f5, sets=("lower",), budget_s=8.0),
                    _p5))):
            if _text and not _text.isascii():
                _nonascii[_label] = sorted(
                    {hex(ord(c)) for c in _text if ord(c) > 127})
    except Exception as _exc:
        _nonascii["(builder raised)"] = f"{type(_exc).__name__}: {_exc}"
    rec(not _nonascii,
        "EVERY prompt builder is ASCII, including blocks empty in this run",
        f"{_nonascii or 'all four clean with targets supplied'}")
    win.eye_id_spin.setValue(0.0)
    win.eye_wall_spin.setValue(0.0)
    win.cb_eyedim.setChecked(False)
    win.cb_thin.setChecked(False)
    pump(lambda: not (win.canvas._res and win.canvas._res.overlays), 30)

    # 9c. the font checker produces a real report for the selected font
    txt = win.font_report_text(win.current_font_path())
    rec(("Font facts:" in txt and "outline format" in txt
         and "checker itself failed" not in txt),
        "font checker returns a report",
        f"{len(txt)} chars, "
        f"headline={next((l for l in txt.splitlines() if l.startswith(('No problems', 'CANNOT', 'Usable,'))), '?')!r}")

    # 9d. the letter-pair sheet: zoom, the flagged count, and the walk
    win._last_pair_report = None
    win.show_pair_sheets(win.current_font_path())
    ok = pump(lambda: getattr(win, "_last_pair_report", None) is not None, 180)
    rec(ok, "the letter-pair analysis finishes on the report thread",
        f"report arrived: {ok}")
    prep = getattr(win, "_last_pair_report", None)
    if prep is None:
        rec(False, "letter-pair sheet analysed", "no report")
    else:
        from nameplate_core import Font as _F4
        grid = PairGrid(_F4(win.current_font_path()), prep)
        base_cell = grid.CELL
        grid.set_zoom(0.30)
        small_cell = grid.CELL
        grid.set_zoom(2.40)
        big_cell = grid.CELL
        rec(small_cell < base_cell < big_cell,
            "the pair sheet zooms out and in",
            f"30%={small_cell}px 100%={base_cell}px 240%={big_cell}px")
        grid.set_zoom(1.0)
        rec(grid.width() == len(grid.cols) * grid.CELL
            and grid.height() == len(grid.rows) * grid.CELL,
            "the zoomed sheet is still 26 columns x 52 rows",
            f"{grid.width()}x{grid.height()}px, "
            f"{len(grid.cols)}x{len(grid.rows)} cells")
        # one row per POSITION a pair can occupy in a real name: the whole
        # word (both eyelet forms), the first letter, the middle, the last
        want_keys = ["caplower", "lower", "firstcaplower", "firstlower",
                     "midcaplower", "midlower", "lastlower"]
        keys = [k for k, _ch in grid.rows[:len(want_keys)]]
        rec(len(grid.rows) == len(want_keys) * 26 and keys == want_keys,
            "the pair sheet covers every positional junction, one row each",
            f"{len(grid.rows)} rows, first letter's rows = {keys}")
        # the junctions a 3+ letter name makes at its ends must be DIFFERENT
        # measurements from the whole-word ones, not the same cell reached twice
        w_first = grid.result("firstlower", "d", "d")
        w_whole = grid.result("lower", "d", "d")
        rec(bool(w_first and w_whole and w_first is not w_whole
                 and getattr(w_first, "context", "") == "dda"
                 and getattr(w_first, "span", None) == (0, 1)),
            "a first-letter cell is shaped as 'dda' and judges glyphs 0-1",
            f"whole={getattr(w_whole, 'glyphs', None)} "
            f"first={getattr(w_first, 'glyphs', None)} "
            f"span={getattr(w_first, 'span', None)}")
        w_last = grid.result("lastlower", "a", "b")
        rec(bool(w_last and getattr(w_last, "context", "") == "Aab"
                 and getattr(w_last, "span", None) == (1, 2)),
            "a last-letter cell is shaped as 'Aab' and judges glyphs 1-2",
            f"context={getattr(w_last, 'context', None)!r} "
            f"span={getattr(w_last, 'span', None)}")
        rec(len(set(grid._scale_by_mode.values())) == 3,
            "two-, three- and four-letter cells each get their own scale",
            f"{ {m: round(v, 6) for m, v in grid._scale_by_mode.items()} }")
        # the middle rows must actually shape a 4-letter word and mark which two
        # glyphs are under test
        mid = grid.result("midlower", "a", "a")
        rec(bool(mid and getattr(mid, "context", "") == "Aaaa"
                 and getattr(mid, "span", None) == (1, 2)),
            "a middle-of-word cell is shaped inside Aaaa and judges glyphs 1-2",
            f"context={getattr(mid, 'context', None)!r} "
            f"span={getattr(mid, 'span', None)} "
            f"glyphs={getattr(mid, 'glyphs', None)}")
        # and it must be a DIFFERENT measurement from the whole-word one, not the
        # same cell reached twice: keying the lookup on (left, right) alone threw
        # one of the two away
        start = grid.result("lower", "a", "a")
        rec(bool(mid and start and mid is not start
                 and len(getattr(mid, "glyphs", ())) >
                 len(getattr(start, "glyphs", ()))),
            "start-of-word and middle-of-word are kept as separate measurements",
            f"start={getattr(start, 'glyphs', None)} "
            f"mid={getattr(mid, 'glyphs', None)}")
        # the eyelet form is what the whole-word row exercises; prove the medial
        # glyphs in the middle row are not the initial form
        rec(bool(mid and start and mid.glyphs[1] != start.glyphs[0]),
            "the middle row uses a medial glyph, not the initial (eyelet) one",
            f"initial={start.glyphs[0]!r} medial={mid.glyphs[1]!r}")
        rec(grid._scale_wide < grid._scale,
            "a four-letter cell is drawn at its own smaller scale",
            f"2-letter={grid._scale:.6f} 4-letter={grid._scale_wide:.6f}")
        flagged = grid.flagged_cells()
        order = [(r, c) for r, c, _res in flagged]
        rec(order == sorted(order),
            "flagged pairs are walked in reading order, top to bottom",
            f"{len(order)} flagged: {[grid.rows[r] + grid.cols[c] for r, c in order[:6]]}")
        rec(len(flagged) == grid.n_flagged(),
            "the flagged count matches the number the header shows",
            f"{len(flagged)} vs {grid.n_flagged()}")

    # 9e. the point of the report thread: the window keeps painting. Queue the
    # slowest analysis and prove the event loop still runs while it works.
    win._last_report = ""
    t_click = time.time()
    win.check_font()
    spins = 0
    while time.time() - t_click < 25.0 and not win._last_report:
        app.processEvents()
        spins += 1
        time.sleep(0.005)
    rec(bool(win._last_report) and spins > 50,
        "the GUI event loop keeps running while a font check is in flight",
        f"{spins} event-loop turns during the check, report "
        f"{'arrived' if win._last_report else 'did NOT arrive'}")
    rec(win.btn_check.isEnabled(),
        "the button that started a report is re-enabled when it finishes",
        f"enabled={win.btn_check.isEnabled()} text={win.btn_check.text()!r}")

    # 9f. the health surface: it must name the build and pass its own checks
    _h = health_report()
    rec(all(k in _h for k in ("fonts folder", "settings file", "startup log",
                              "CHECKS")) and "PROBLEM" not in _h,
        "the health check names the build and reports no problems here",
        " | ".join(l.strip() for l in _h.splitlines()
                   if l.strip().startswith(("build ", "[")))[:150])

    # 10. empty input disables export
    win.names.setPlainText("")
    app.processEvents()
    win._update_export_enabled()
    rec(not win.btn_zip.isEnabled() and not win.btn_sheet.isEnabled(),
        "empty name box disables export",
        f"zip={win.btn_zip.isEnabled()} sheet={win.btn_sheet.isEnabled()}")

    win.close()
    n_ok = sum(1 for c in checks if c[0])
    out("=" * 70)
    out(f"selftest: {n_ok}/{len(checks)} passed")
    for ok_, name, detail in checks:
        if not ok_:
            out(f"  FAIL {name}: {detail}")
    out("=" * 70)
    return 0 if n_ok == len(checks) else 1


def diagnose() -> int:
    """Write an environment report for a PC where the window never appears.

    Deliberately does everything main() does, one step at a time, logging each
    one, so the last line in the file names the step that failed.
    """
    global _LOG
    _LOG = _log_path()
    log("=== DIAGNOSE")
    log(f"frozen={getattr(sys, 'frozen', False)}")
    log(f"exe={sys.executable}")
    log(f"BASE={BASE}")
    log(f"_MEIPASS={getattr(sys, '_MEIPASS', '(none)')}")
    log(f"python={sys.version}")
    log(f"cwd={os.getcwd()}")
    for var in ("QT_QPA_PLATFORM", "QT_PLUGIN_PATH", "QT_OPENGL",
                "PATH", "LOCALAPPDATA"):
        v = os.environ.get(var)
        log(f"env {var}={(v[:300] + '...') if v and len(v) > 300 else v}")

    log(f"fonts dir exists={os.path.isdir(FONTS_DIR)} -> {FONTS_DIR}")
    try:
        log(f"fonts: {os.listdir(FONTS_DIR)}")
    except Exception as exc:
        log(f"fonts listing failed: {exc!r}")
    try:
        probe = os.path.join(BASE, "_writetest.tmp")
        with open(probe, "w") as fh:
            fh.write("x")
        os.remove(probe)
        log("app folder is writable")
    except Exception as exc:
        log(f"app folder NOT writable: {exc!r}")

    root = getattr(sys, "_MEIPASS", BASE)
    plat = os.path.join(root, "PySide6", "plugins", "platforms")
    log(f"qt platform plugins dir={plat} exists={os.path.isdir(plat)}")
    try:
        log(f"qt platform plugins: {os.listdir(plat)}")
    except Exception as exc:
        log(f"plugin listing failed: {exc!r}")

    try:
        qInstallMessageHandler(lambda m, c, msg: log(f"[qt] {msg}"))
        import PySide6
        from PySide6 import __version__ as pyside_ver
        from PySide6.QtCore import qVersion
        log(f"PySide6={pyside_ver} Qt={qVersion()} at {PySide6.__file__}")
    except Exception as exc:
        log(f"PySide6 import/report failed: {exc!r}")

    try:
        log("creating QApplication")
        app = QApplication(sys.argv[:1])
        log(f"QApplication ok, platformName={app.platformName()!r}")
        for s in app.screens():
            log(f"screen {s.name()!r} geo={s.geometry().getRect()} "
                f"dpr={s.devicePixelRatio()} dpi={s.logicalDotsPerInch()}")
        log("building main window")
        win = MainWindow()
        log("main window built")
        win.show()
        log(f"shown, geometry={win.frameGeometry().getRect()}")
        app.processEvents()
        log("processEvents ok")
        win.close()
        log("DIAGNOSE COMPLETE - startup path is healthy on this machine")
    except Exception:
        log(f"DIAGNOSE FAILED\n{traceback.format_exc()}")
        close_splash()
        return 1
    finally:
        close_splash()
    return 0


def main() -> int:
    global _LOG
    if "--diagnose" in sys.argv:
        rc = diagnose()
        # The message box tells a human where the log went, but it BLOCKS until
        # someone clicks it — so a script must be able to opt out, or it hangs
        # forever waiting on a dialog nobody is looking at.
        if "--quiet" not in sys.argv:
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    None, f"Diagnostic written to:\n\n{_LOG}\n\n"
                          f"Send that file back.", "Diagnostics complete", 0x40)
            except Exception:
                pass
        return rc

    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        out = (sys.argv[i + 1] if len(sys.argv) > i + 1
               and not sys.argv[i + 1].startswith("-")
               else os.path.join(BASE, "selftest_out"))
        ensure_fonts_dir()
        rc = selftest(out)
        # A crash mid-selftest can leave the preview worker's QThread running,
        # and a live non-daemon thread keeps the process alive FOREVER after
        # the report is already written — observed as a hang needing a kill.
        # The report and the log are flushed by now; a diagnostic mode's last
        # duty is to actually exit with its verdict.
        close_splash()
        os._exit(rc)

    # Every launch logs its phases, so "splash then nothing" on a machine we
    # cannot reach still tells us exactly which step died.
    _LOG = _log_path()
    try:
        with open(_LOG, "w", encoding="utf-8") as fh:
            fh.write("")
    except Exception:
        pass
    log(f"=== {APP_NAME} starting")
    log(f"frozen={getattr(sys, 'frozen', False)} exe={sys.executable}")
    log(f"BASE={BASE}")
    log(f"python={sys.version.split()[0]} platform={sys.platform}")

    try:
        qInstallMessageHandler(
            lambda mode, ctx, message: log(f"[qt] {message}"))
        log("qt message handler installed")
    except Exception as exc:
        log(f"could not install qt message handler: {exc!r}")

    try:
        ensure_fonts_dir()
        log(f"fonts dir ok: {FONTS_DIR}")
    except Exception as exc:
        log(f"ensure_fonts_dir failed (continuing): {exc!r}")

    app = None
    try:
        log("creating QApplication")
        app = QApplication(sys.argv)
        app.setApplicationName(APP_NAME)
        log(f"QApplication ok, platform={app.platformName()!r}")

        # Belt and braces: whatever happens below, the splash cannot outlive
        # startup and sit on top of an error dialog.
        QTimer.singleShot(8000, close_splash)

        icon = os.path.join(getattr(sys, "_MEIPASS", BASE), "assets", "icon.ico")
        if not os.path.isfile(icon):
            icon = os.path.join(BASE, "assets", "icon.ico")
        if os.path.isfile(icon):
            app.setWindowIcon(QIcon(icon))
        log(f"icon: {icon if os.path.isfile(icon) else 'not found (harmless)'}")

        def excepthook(exc_type, exc, tb):
            msg = "".join(traceback.format_exception(exc_type, exc, tb))
            close_splash()                     # never hide the dialog behind it
            log(f"UNCAUGHT\n{msg}")
            try:
                QMessageBox.critical(None, "Unexpected error", msg[-3000:])
            except Exception:
                pass
        sys.excepthook = excepthook

        log("building main window")
        win = MainWindow()
        log("main window built; showing")
        win.show()
        close_splash()           # the window is up; drop the launch image

        # A window placed off every monitor is invisible but "running". Rescue
        # it onto the primary screen rather than looking like a silent failure.
        try:
            screens = app.screens()
            log(f"screens={[s.geometry().getRect() for s in screens]} "
                f"window={win.frameGeometry().getRect()}")
            if screens and not any(s.geometry().intersects(win.frameGeometry())
                                   for s in screens):
                g = screens[0].availableGeometry()
                win.move(g.center().x() - win.width() // 2,
                         g.center().y() - win.height() // 2)
                log(f"window was off-screen; moved to {win.frameGeometry().getRect()}")
        except Exception as exc:
            log(f"screen check skipped: {exc!r}")

        log("entering event loop")
        rc = app.exec()
        log(f"event loop exited rc={rc}")
        return rc
    except Exception:
        fatal("Sean's Font Prototyping Friend could not start",
              traceback.format_exc())
        return 1
    finally:
        close_splash()


if __name__ == "__main__":
    sys.exit(main())

"""
make_assets.py — build the exe icon and the launch splash.

    python make_assets.py

INPUT
    assets\\logo.png      Sean's artwork. Drop it here and re-run; everything
                         downstream picks it up automatically.

    If that file is missing a placeholder mark is generated instead, so the
    build never breaks — but the real logo is what should ship.

OUTPUT
    assets\\icon.ico      multi-size Windows icon (16..256) for --icon
    assets\\splash.png    launch image for PyInstaller --splash

The .ico container is assembled by hand (PNG-compressed entries, valid on
Vista and later) because Qt only writes single-size .ico files and Windows
wants several sizes to avoid a smeared taskbar icon.
"""

from __future__ import annotations

import os
import struct
import sys

from PySide6.QtCore import QBuffer, QByteArray, QRectF, Qt
from PySide6.QtGui import (QBrush, QColor, QFont, QGuiApplication, QImage,
                           QLinearGradient, QPainter, QPainterPath, QPen)

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
LOGO = os.path.join(ASSETS, "logo.png")
ICO = os.path.join(ASSETS, "icon.ico")
SPLASH = os.path.join(ASSETS, "splash.png")

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
NEON = "#B026FF"          # Saints Row neon purple
NEON_DIM = "#7B18C4"
INK = "#140A1E"           # near-black aubergine


# --------------------------------------------------------------------------- #
def placeholder(size: int = 1024) -> QImage:
    """Stand-in mark: neon purple nameplate 'S' with an eyelet, on dark."""
    img = QImage(size, size, QImage.Format_ARGB32)
    img.fill(QColor(0, 0, 0, 0))
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing, True)

    r = size * 0.10
    body = QPainterPath()
    body.addRoundedRect(QRectF(0, 0, size, size), r, r)
    g = QLinearGradient(0, 0, size, size)
    g.setColorAt(0.0, QColor("#241033"))
    g.setColorAt(1.0, QColor(INK))
    p.fillPath(body, QBrush(g))

    pen = QPen(QColor(NEON), size * 0.022)
    p.setPen(pen)
    p.drawPath(body)

    f = QFont("Georgia")
    f.setPixelSize(int(size * 0.62))
    f.setBold(True)
    p.setFont(f)
    p.setPen(QPen(QColor(NEON), size * 0.03))
    path = QPainterPath()
    path.addText(size * 0.22, size * 0.74, f, "S")
    p.setBrush(QBrush(QColor("#2C1240")))
    p.drawPath(path)

    # the eyelet, the thing that makes these nameplates nameplates
    p.setBrush(Qt.NoBrush)
    p.setPen(QPen(QColor("#E9D2FF"), size * 0.028))
    d = size * 0.17
    p.drawEllipse(QRectF(size * 0.60, size * 0.16, d, d))
    # and a red engrave tick
    p.setPen(QPen(QColor("#FF2A2A"), size * 0.022))
    p.drawLine(int(size * 0.30), int(size * 0.80),
               int(size * 0.46), int(size * 0.80))
    p.end()
    return img


def load_source() -> tuple[QImage, bool]:
    if os.path.isfile(LOGO):
        img = QImage(LOGO)
        if not img.isNull():
            return img.convertToFormat(QImage.Format_ARGB32), True
        print(f"! {LOGO} could not be read — using the placeholder", file=sys.stderr)
    return placeholder(), False


def square(img: QImage, size: int, pad: float = 0.04) -> QImage:
    """Fit onto a transparent square canvas without distorting the artwork."""
    out = QImage(size, size, QImage.Format_ARGB32)
    out.fill(QColor(0, 0, 0, 0))
    inner = int(size * (1 - 2 * pad))
    scaled = img.scaled(inner, inner, Qt.KeepAspectRatio, Qt.SmoothTransformation)
    p = QPainter(out)
    p.setRenderHint(QPainter.SmoothPixmapTransform, True)
    p.drawImage((size - scaled.width()) // 2, (size - scaled.height()) // 2, scaled)
    p.end()
    return out


def png_bytes(img: QImage) -> bytes:
    # QBuffer() owns its own QByteArray. Passing one in (QBuffer(QByteArray()))
    # hands over a temporary that Python frees while Qt still points at it.
    buf = QBuffer()
    buf.open(QBuffer.WriteOnly)
    img.save(buf, "PNG")
    buf.close()
    return bytes(buf.data())


def write_ico(img: QImage, path: str) -> None:
    entries = [(s, png_bytes(square(img, s))) for s in ICO_SIZES]
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    dirs, blobs = b"", b""
    for s, data in entries:
        dim = 0 if s >= 256 else s
        dirs += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    with open(path, "wb") as fh:
        fh.write(header + dirs + blobs)


def write_splash(img: QImage, path: str, height: int = 600) -> None:
    """Composite on a dark card — the splash host does not honour alpha."""
    scaled = img.scaled(int(height * 0.72), height,
                        Qt.KeepAspectRatio, Qt.SmoothTransformation)
    w, h = scaled.width() + 48, scaled.height() + 48
    out = QImage(w, h, QImage.Format_RGB32)
    out.fill(QColor(INK))
    p = QPainter(out)
    p.setRenderHint(QPainter.Antialiasing, True)
    p.setRenderHint(QPainter.SmoothPixmapTransform, True)
    g = QLinearGradient(0, 0, 0, h)
    g.setColorAt(0.0, QColor("#1E0D2B"))
    g.setColorAt(1.0, QColor(INK))
    p.fillRect(0, 0, w, h, QBrush(g))
    p.drawImage((w - scaled.width()) // 2, (h - scaled.height()) // 2, scaled)
    p.setPen(QPen(QColor(NEON), 3))
    p.drawRect(1, 1, w - 3, h - 3)
    p.end()
    out.save(path, "PNG")


def main() -> int:
    os.makedirs(ASSETS, exist_ok=True)
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    _app = QGuiApplication(sys.argv[:1])

    src, real = load_source()
    print(f"source: {'assets/logo.png' if real else 'generated placeholder'} "
          f"({src.width()}x{src.height()})")
    write_ico(src, ICO)
    write_splash(src, SPLASH)
    print(f"wrote {ICO} ({os.path.getsize(ICO):,} bytes, sizes {ICO_SIZES})")
    print(f"wrote {SPLASH} ({os.path.getsize(SPLASH):,} bytes)")
    if not real:
        print("\n>> Drop the real artwork at assets\\logo.png and re-run to replace it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

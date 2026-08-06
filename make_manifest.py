"""
make_manifest.py — stamp the build so a shipped exe can prove which code it is.

    python make_manifest.py            # writes assets/build_manifest.json

There is no git here, so "which version is on that shop PC?" had no answer: two
exes with the same file size could differ by a fix, and a bug report could not be
tied to code. This writes a content hash of every source file that goes into the
build, plus the dependency versions, into a JSON file that PyInstaller bundles.
The app shows it under "Health check" and prints it in --selftest, so the answer
comes from the exe itself rather than from someone's memory.

Run by build_all.ps1 before PyInstaller. Safe to run by hand.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets", "build_manifest.json")

# Everything whose content changes behaviour. Docs and tests are deliberately
# included: a build whose README disagrees with its code is a build worth
# telling apart.
SOURCES = (
    "nameplate_core.py", "nameplate_gui.py", "nameplate_export.py",
    "nameplate_layout.py", "nameplate_leadin.py", "nameplate_eyelets.py",
    "nameplate_thickness.py", "nameplate_fontcheck.py",
    "nameplate_pairsheet.py", "nameplate_brief.py", "nameplate_cli.py",
    "acceptance_tests.py", "export_tests.py", "regression_tests.py",
    "README_APP.txt", "INSTALL.txt",
)


def _sha(path: str) -> str | None:
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def build() -> dict:
    files: dict[str, str] = {}
    for name in SOURCES:
        h = _sha(os.path.join(HERE, name))
        if h:
            files[name] = h[:16]

    # one number that changes whenever any of them changes
    joined = "".join(f"{k}:{v}" for k, v in sorted(files.items()))
    build_id = hashlib.sha256(joined.encode()).hexdigest()[:12]

    deps = {}
    for mod in ("PySide6", "fontTools", "shapely", "uharfbuzz", "pathops",
                "numpy"):
        try:
            m = __import__(mod)
            deps[mod] = getattr(m, "__version__", "?")
        except Exception:
            deps[mod] = "(not importable)"

    fonts = []
    fdir = os.path.join(HERE, "fonts")
    if os.path.isdir(fdir):
        for f in sorted(os.listdir(fdir)):
            if f.lower().endswith((".ttf", ".otf", ".ttc")):
                h = _sha(os.path.join(fdir, f))
                fonts.append({"file": f, "sha256_16": (h or "")[:16]})

    return {
        "app": "Sean's Font Prototyping Friend",
        "build_id": build_id,
        "built_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        "built_on": platform.node(),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "dependencies": deps,
        "sources": files,
        "fonts_shipped": fonts,
    }


def main() -> int:
    man = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(man, fh, indent=2)
    print(f"build {man['build_id']} ({len(man['sources'])} sources, "
          f"{len(man['fonts_shipped'])} fonts) -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

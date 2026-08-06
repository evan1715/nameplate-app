"""
nameplate_brief.py — the app's whole opinion of a font, in one command.

    python nameplate_brief.py --font X.ttf --cap 1.0 --unit in \
        --eyelet-id 0.375 --eyelet-wall 0.20 --min-thickness 0.10

This is the machine-readable face of Sean's Font Prototyping Friend. The GUI
answers "is this font right?" for a person; this answers the same question for an
agent, and — the part that matters — it JUDGES the answer against targets and
says so in the exit code:

    0   every target met. The font is done.
    1   the font builds, but one or more targets are not met yet.
    2   the font cannot be used at all (it does not parse, has no cmap, ...).
    3   the tool itself failed (bad arguments, missing file).

So a font-editing loop is just:

    while nameplate_brief.py ... ; [ $? -eq 1 ]; do  edit the font  done

WHY A SEPARATE TOOL AND NOT A FLAG ON THE GUI
    The GUI holds state — a selected font, a typed name, a unit, four toggles.
    An agent needs none of that and must not depend on it. Everything here is
    stated on the command line and every number comes back in one JSON object,
    so two runs a week apart are comparable and nothing is remembered between
    them.

WHAT IT MEASURES
    Every check the GUI can do, run in one pass over one font:
      * the font itself          nameplate_fontcheck.check_font
      * every letter pair        nameplate_pairsheet.analyse_pairs
      * the built artwork        nameplate_core.build_document, per test name
      * the eyelets              nameplate_eyelets.measure_eyelets
      * the thin places          nameplate_thickness.survey
    Nothing is re-implemented here. If the GUI and this tool ever disagree, that
    is a bug in this file, not a difference of opinion.

TARGETS ARE OPTIONAL
    Leave a target out and that measurement is reported but not judged. Give one
    and it becomes a pass/fail with the exact font-unit change needed. Font units
    are what a font editor works in, and because everything scales linearly they
    hold at every cutting height — set them once and the font is right at 1 in
    and at 12 mm.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

MM_PER_IN = 25.4

# The test names. ADAM exercises capitals and both eyelet ends; Adam exercises
# the capital-then-lowercase join, which is where script fonts break.
DEFAULT_NAMES = ("ADAM", "Adam")


# --------------------------------------------------------------------------- #
#  helpers
# --------------------------------------------------------------------------- #
def _f(v):
    """A float that survives JSON — NaN and inf become None."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x and abs(x) != float("inf") else None


def _last_place_tol(value) -> float:
    """Half a unit in the last decimal place the caller wrote.

    `--eyelet-id 1.77` means "1.77 to the nearest hundredth", so anything from
    1.765 to 1.775 satisfies it. Reading the written precision off the number
    keeps a target as strict as it was stated and no stricter: pass 1.7752 and
    you get 0.00005, pass 1.77 and you get 0.005.
    """
    try:
        s = repr(float(value))
    except (TypeError, ValueError):
        return 0.0
    if "e" in s or "E" in s:              # 1e-05 and friends: use the exponent
        try:
            return abs(float(value)) * 5e-4
        except Exception:
            return 0.0
    dec = len(s.split(".", 1)[1].rstrip("0")) if "." in s else 0
    return 0.5 * (10.0 ** -dec)


class Judge:
    """Collects pass/fail against the targets that were actually given."""

    def __init__(self):
        self.rows: list[dict] = []

    def add(self, what: str, measured, target, unit: str, fu_measured=None,
            fu_target=None, direction: str = "at-least", tol: float = 0.0):
        """Judge one measurement.

        direction "at-least"  measured must be >= target (a minimum thickness)
                  "equal"     measured must equal target within tol (a diameter)
        """
        m, t = _f(measured), _f(target)
        if t is None:
            self.rows.append({"what": what, "measured": m, "target": None,
                              "unit": unit, "verdict": "not judged",
                              "font_units": {"measured": _f(fu_measured),
                                             "target": None},
                              "change_pct": None})
            return
        if m is None:
            self.rows.append({"what": what, "measured": None, "target": t,
                              "unit": unit, "verdict": "could not measure",
                              "font_units": {"measured": None,
                                             "target": _f(fu_target)},
                              "change_pct": None})
            return
        if direction == "at-least":
            ok = m >= t - tol
        else:
            # An "equal" target has to accept the precision the target was
            # WRITTEN at. Asking for 1.77 mm when the font measures 1.7752 mm is
            # a font that is already right; failing it made a correct eyelet look
            # like a defect and sent someone to edit it. So the tolerance is half
            # a unit in the last decimal place the caller actually typed, floored
            # at the explicit tol.
            ok = abs(m - t) <= max(tol, _last_place_tol(target))
        self.rows.append({
            "what": what, "measured": m, "target": t, "unit": unit,
            "verdict": "MET" if ok else "NOT MET",
            "font_units": {"measured": _f(fu_measured),
                           "target": _f(fu_target)},
            "change_pct": _f(((t / m) - 1.0) * 100.0) if m else None,
        })

    @property
    def judged(self):
        return [r for r in self.rows if r["verdict"] in ("MET", "NOT MET",
                                                         "could not measure")]

    @property
    def failed(self):
        return [r for r in self.rows
                if r["verdict"] in ("NOT MET", "could not measure")]

    def text(self) -> str:
        if not self.judged:
            return ("No targets were given, so nothing was judged. Pass "
                    "--eyelet-id / --eyelet-wall / --min-thickness to turn a "
                    "measurement into a pass or fail.")
        w = max(len(r["what"]) for r in self.judged)
        L = [f"{'':<{w}}  {'now':>10}  {'target':>10}  {'change':>9}  "
             f"{'font units now -> want':>26}  verdict"]
        for r in self.judged:
            fm, ft = r["font_units"]["measured"], r["font_units"]["target"]
            fu = (f"{fm:11.1f} -> {ft:<11.1f}" if fm is not None
                  and ft is not None else
                  (f"{fm:11.1f}    {'':<11}" if fm is not None else " " * 26))
            L.append(
                f"{r['what']:<{w}}  "
                f"{(f'{r['measured']:.4f}' if r['measured'] is not None else '?'):>10}  "
                f"{(f'{r['target']:.4f}' if r['target'] is not None else '-'):>10}  "
                f"{(f'{r['change_pct']:+.2f}%' if r['change_pct'] is not None else '-'):>9}  "
                f"{fu}  {r['verdict']}")
        return "\n".join(L)


# --------------------------------------------------------------------------- #
#  the one pass
# --------------------------------------------------------------------------- #
def brief(font_path: str, cap: float = 1.0, unit: str = "in",
          basis: str = "cap", names=DEFAULT_NAMES,
          target_id: float | None = None, target_wall: float | None = None,
          min_thickness: float | None = None,
          pair_budget: float = 30.0, join_budget: float = 25.0,
          thickness_samples: int = 900) -> dict:
    """Everything the app knows about this font, judged against the targets."""
    import nameplate_core as CORE
    import nameplate_eyelets as EY
    import nameplate_fontcheck as FC
    import nameplate_thickness as TH

    t0 = time.time()
    out: dict = {
        "tool": "nameplate_brief",
        "font": {"path": os.path.abspath(font_path),
                 "file": os.path.basename(font_path)},
        "asked_for": {
            "cap_height": _f(cap), "unit": unit, "basis": basis,
            "test_names": list(names),
            "eyelet_inner_diameter": _f(target_id),
            "eyelet_wall": _f(target_wall),
            "min_thickness": _f(min_thickness),
        },
        "font_check": {}, "pairs": {}, "names": [], "eyelets": [],
        "thickness": {}, "targets": [], "prompts": {}, "verdict": "",
    }

    # ---- can it even be opened? ---------------------------------------- #
    try:
        font = CORE.Font(font_path)
    except Exception as exc:
        out["font_check"] = {"usable": False,
                             "fatal": f"{type(exc).__name__}: {exc}",
                             "errors": [], "warnings": [], "findings": []}
        out["verdict"] = "unusable"
        out["seconds"] = round(time.time() - t0, 1)
        return out

    out["font"].update({
        "family": getattr(font, "family", ""),
        "upem": getattr(font, "upem", None),
        "has_engrave_lines": bool(getattr(font, "colr", None)),
    })

    # ---- the font itself ------------------------------------------------ #
    try:
        rep = FC.check_font(font_path, names=tuple(names),
                            join_scan_budget=join_budget)
        out["font_check"] = {
            "usable": bool(rep.usable),
            "family": rep.family,
            "upem": rep.upem,
            "n_errors": len(rep.errors),
            "n_warnings": len(rep.warnings),
            "findings": [{"severity": f.severity, "code": f.code,
                          "title": f.title, "what": f.detail,
                          "fix": f.fix} for f in rep.sorted()],
            "facts": list(rep.facts),
        }
        out["prompts"]["font_defects"] = (rep.claude_prompt()
                                          if (rep.errors or rep.warnings)
                                          else "")
        out["report_text"] = rep.text()
    except Exception as exc:
        out["font_check"] = {"usable": None,
                             "fatal": f"check_font failed: "
                                      f"{type(exc).__name__}: {exc}",
                             "errors": [], "warnings": [], "findings": []}

    # ---- every letter pair --------------------------------------------- #
    try:
        import nameplate_pairsheet as PS
        prep = PS.analyse_pairs(font, budget_s=pair_budget)
        bad = []
        for grp in (getattr(prep, "groups", None) or []):
            for (a, b), cell in (getattr(grp, "cells", None) or {}).items():
                if getattr(cell, "problem", False):
                    # The GROUP matters as much as the pair: the same two
                    # letters use different glyphs at the start of a word and in
                    # the middle of one, so "ab fails" is only half a fact.
                    bad.append({"pair": f"{a}{b}", "left": a, "right": b,
                                "group": getattr(grp, "key", ""),
                                "position": ("middle of a word"
                                             if getattr(grp, "middle", False)
                                             else "start of a word"),
                                "shaped_from": getattr(cell, "context", "")
                                or f"{a}{b}",
                                "status": str(getattr(cell, "status", "")),
                                "gap_em": _f(getattr(cell, "gap_em", None))})
        bad.sort(key=lambda d: -(d["gap_em"] or 0))
        # A pair nobody measured is NOT a pair that works. Only counting
        # .problem cells meant a run with too small a budget reported
        # "flagged: 0" and exited 0 READY while nearly every combination was
        # UNTESTED -- and the skills treat exit 0 as the only definition of
        # done, so an agent would have declared an unmeasured font finished.
        untested = int(getattr(prep, "n_untested", 0) or 0)
        out["pairs"] = {
            "flagged": len(bad),
            "tested": int(getattr(prep, "n_tested", 0) or 0),
            "untested": untested,
            "total": int(getattr(prep, "n_pairs", 0) or 0),
            "budget_hit": bool(getattr(prep, "budget_hit", False)),
            "budget_s": _f(pair_budget),
            "worst_first": bad,
        }
        if untested:
            out.setdefault("blocking", []).append(
                f"{untested} letter pair(s) were never tested - the "
                f"{pair_budget:g}s pair budget ran out. Raise --pair-budget; "
                f"an untested pair is not a pair that works.")
        out["prompts"]["letter_pairs"] = (PS.claude_prompt(font, prep, font_path)
                                          if (bad or untested) else "")
    except Exception as exc:
        out["pairs"] = {"error": f"{type(exc).__name__}: {exc}", "flagged": None}

    # ---- the built artwork, per test name ------------------------------- #
    docs = {}
    for nm in names:
        row = {"name": nm}
        try:
            doc = CORE.build_document(font, nm, cap, unit, basis)
            docs[nm] = doc
            w, h = doc.size()
            row.update({"width": _f(w), "height": _f(h), "unit": doc.unit,
                        "engrave_lines": len(doc.engrave_paths),
                        "scale_units_per_" + unit: _f(doc.scale),
                        "warnings": list(doc.warnings)})
            try:
                import nameplate_leadin as LI
                polys, depths, _mat = LI._analyse(LI._rings(doc))
                row["pieces"] = sum(1 for d in depths if d % 2 == 0)
                row["holes"] = sum(1 for d in depths if d % 2 == 1)
                row["cuts_as_one_piece"] = row["pieces"] == 1
            except Exception as exc:
                row["piece_check_error"] = f"{type(exc).__name__}: {exc}"
        except Exception as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"
        out["names"].append(row)

    # everything below is measured on the FIRST name that built — the eyelet and
    # the thin places belong to shaped artwork, not to the font in the abstract
    doc = next((docs[n] for n in names if n in docs), None)
    if doc is None:
        out["verdict"] = "unusable"
        out["seconds"] = round(time.time() - t0, 1)
        return out
    out["measured_on"] = {"name": doc.text,
                          "cap_height": _f(doc.target_height),
                          "unit": doc.unit, "basis": doc.basis,
                          "units_per_" + doc.unit: _f(doc.scale)}
    scale = float(doc.scale) or 1.0

    judge = Judge()

    # ---- eyelets -------------------------------------------------------- #
    try:
        eyes = EY.measure_eyelets(doc)
        for e in eyes:
            out["eyelets"].append({
                "side": e.side, "unit": e.unit,
                "inner_diameter": _f(e.inner_d),
                "outer_diameter": _f(e.outer_d),
                "wall_avg": _f(e.wall_from_diameters),
                "wall_thinnest": _f(e.wall_min),
                "roundness": _f(e.circularity),
                "centre": [_f(e.centre[0]), _f(e.centre[1])],
                "font_units": {
                    "inner_diameter": _f(e.inner_d / scale),
                    "outer_diameter": _f(e.outer_d / scale),
                    "wall_avg": _f(e.wall_from_diameters / scale),
                },
                "note": e.note,
            })
        if eyes:
            e = eyes[0]
            judge.add("eyelet inner diameter", e.inner_d, target_id, doc.unit,
                      fu_measured=e.inner_d / scale,
                      fu_target=(target_id / scale) if target_id else None,
                      direction="equal", tol=0.0005)
            judge.add("eyelet wall", e.wall_from_diameters, target_wall,
                      doc.unit, fu_measured=e.wall_from_diameters / scale,
                      fu_target=(target_wall / scale) if target_wall else None,
                      direction="equal", tol=0.0005)
            out["prompts"]["eyelet_size"] = EY.claude_prompt(
                doc, eyelets=eyes, target_id=target_id,
                target_wall=target_wall, font_path=font_path)
        else:
            out["eyelets_note"] = ("no round hole near either end of "
                                   f"{doc.text!r} — this font may have no "
                                   f"eyelet, or not on these letters")
            if target_id or target_wall:
                judge.add("eyelet inner diameter", None, target_id, doc.unit)
                judge.add("eyelet wall", None, target_wall, doc.unit)
            out["prompts"]["eyelet_size"] = ""
    except Exception as exc:
        out["eyelets_error"] = f"{type(exc).__name__}: {exc}"
        out["prompts"]["eyelet_size"] = ""

    # ---- thin places ---------------------------------------------------- #
    try:
        surv = TH.survey(doc, target=min_thickness, samples=thickness_samples,
                         font=font)
        spots = list(getattr(surv, "spots", None) or [])
        out["thickness"] = {
            "unit": doc.unit,
            # How many thin areas exist in TOTAL and how many are under target.
            # spots[] is capped at top_n, so a font with 40 failing areas showed
            # 8 and nothing said there were 32 more -- an agent would fix eight
            # and call the font done.
            "areas_found": int(getattr(surv, "n_areas", 0) or 0),
            "areas_below_target": int(getattr(surv, "n_below_target", 0) or 0),
            "spots_shown": None,        # filled in below, once spots is built
            "samples_taken": int(getattr(surv, "samples_taken", 0) or 0),
            "thinnest": _f(spots[0].thickness) if spots else None,
            "thinnest_font_units": _f(spots[0].thickness / scale) if spots
            else None,
            "spots": [{
                "rank": i,
                "letter": getattr(s, "letter", ""),
                "glyph": getattr(s, "glyph", ""),
                "where": getattr(s, "where", ""),
                "thickness": _f(s.thickness),
                "thickness_font_units": _f(s.thickness / scale),
                "typical": _f(getattr(s, "thickness_typical", None)),
                "at": [_f(s.pos[0]), _f(s.pos[1])],
                "extent": _f(getattr(s, "extent", None)),
                # How parallel the two walls are: 0.50 is a genuine web that
                # will snap, lower is a taper into a junction where the reading
                # is a wedge's width rather than a stroke's. Anything under
                # ~0.47 is usually not worth thickening -- decide with this
                # number in front of you rather than from the thickness alone.
                "clearance": _f(getattr(s, "clearance", None)),
                "parallel_walls": bool(getattr(s, "parallel_walls", False)),
                "meets_target": (None if not min_thickness
                                 else bool(s.thickness >= min_thickness)),
                "needs_pct": (None if not min_thickness or not s.thickness
                              else _f(((min_thickness / s.thickness) - 1.0)
                                      * 100.0)),
            } for i, s in enumerate(spots, 1)],
        }
        out["thickness"]["spots_shown"] = len(spots)
        if (out["thickness"]["areas_below_target"] or 0) > len(spots):
            out.setdefault("blocking", []).append(
                f"{out['thickness']['areas_below_target']} thin areas are under "
                f"the target but only the worst {len(spots)} are listed - fix "
                f"these, then re-run; do not treat the list as complete.")
        if spots:
            judge.add("thinnest part of the letters", spots[0].thickness,
                      min_thickness, doc.unit,
                      fu_measured=spots[0].thickness / scale,
                      fu_target=(min_thickness / scale) if min_thickness
                      else None, direction="at-least", tol=0.0)
            out["thickness"]["below_target"] = (
                [s["rank"] for s in out["thickness"]["spots"]
                 if s["meets_target"] is False] if min_thickness else None)
        out["prompts"]["thin_areas"] = (
            TH.claude_prompt(doc, min_thickness, font_path=font_path, font=font)
            if min_thickness else "")
    except Exception as exc:
        out["thickness"] = {"error": f"{type(exc).__name__}: {exc}"}
        out["prompts"]["thin_areas"] = ""

    # ---- the cap reference, reported as a FACT and never as a target ----- #
    # This was a target and it was a bad one. It built a single "H", measured its
    # INK BOUNDING BOX, and compared that to the asked cap height — so on any
    # font whose H overshoots the cap line or dips below the baseline (i.e. most
    # real fonts) the row read NOT MET permanently and exit 0 became unreachable.
    # Verified on ShineOnScript2: cap line 696 u, H ink 713 u, a fixed -2.39%.
    #
    # Worse than a wrong number: an agent told "exit 0 is done" can only close
    # that gap by SQUASHING THE H — destroying exactly the overshoot that is
    # correct by design and that the app exists to preserve. The bug pushed a
    # well-behaved agent into damaging the font.
    #
    # The cap height is not a property of the font that an editor should change
    # to suit us; it is the reference the app measures FROM. So it is reported,
    # with the per-letter overshoot spelled out, and nothing here is judged.
    try:
        ref_fu, ref_warn = CORE._cap_reference(font)
        letters = {}
        for ch in "HEITAOJQ":
            gname = font.cmap.get(ord(ch))
            if not gname:
                continue
            ys = [p[1] for c in font.contours(gname) for p in c]
            if ys:
                letters[ch] = {
                    "ink_top_font_units": _f(max(ys)),
                    "over_cap_line_font_units": _f(max(ys) - ref_fu),
                    "ink_height_at_asked_cap": _f((max(ys) - min(ys))
                                                  / ref_fu * cap),
                }
        out["cap_height_check"] = {
            "asked": _f(cap), "unit": unit, "basis": basis,
            "cap_line_font_units": _f(ref_fu),
            "cap_line_lands_at": _f(cap),
            "per_letter": letters,
            "warnings": list(ref_warn or []),
            "note": ("NOT a target — nothing here can fail. The cap LINE is set "
                     "to the asked height for every name, which is what makes "
                     "two names match. Individual capitals read OVER that line "
                     "on purpose (overshoot): a round O and a pointed A both "
                     "exceed it, a flat H E I T sit on it, and a J or Q hangs "
                     "below the baseline so its ink is taller still. Do not "
                     "'correct' any of that — flattening overshoot damages the "
                     "font and changes nothing about the size that is cut."),
        }
    except Exception as exc:
        out["cap_height_check"] = {"error": f"{type(exc).__name__}: {exc}"}

    # ---- one piece is a hard requirement -------------------------------- #
    for row in out["names"]:
        if row.get("cuts_as_one_piece") is False:
            out.setdefault("blocking", []).append(
                f"the test name {row['name']!r} cuts as {row['pieces']} loose "
                f"pieces, not one plate")

    out["targets"] = judge.rows
    out["targets_text"] = judge.text()

    fatal = (out["font_check"].get("usable") is False
             or out["font_check"].get("n_errors"))
    if fatal:
        out["verdict"] = "unusable"
    elif judge.failed or out.get("blocking") or out["pairs"].get("flagged"):
        out["verdict"] = "needs work"
    else:
        out["verdict"] = "ready"
    out["seconds"] = round(time.time() - t0, 1)
    return out


# --------------------------------------------------------------------------- #
#  the readable version
# --------------------------------------------------------------------------- #
def markdown(b: dict) -> str:
    f, u = b["font"], b["asked_for"]["unit"]
    L = [f"# Font brief — {f['file']}", "",
         f"- family (the font's own internal name): "
         f"**{f.get('family') or '(none)'}**",
         f"- unitsPerEm: {f.get('upem')}",
         f"- engrave lines: "
         f"{'yes (COLR)' if f.get('has_engrave_lines') else 'no — cut only, which is normal'}",
         f"- asked for: cap height {b['asked_for']['cap_height']} {u}"
         + (f", eyelet ID {b['asked_for']['eyelet_inner_diameter']} {u}"
            if b['asked_for']['eyelet_inner_diameter'] else "")
         + (f", eyelet wall {b['asked_for']['eyelet_wall']} {u}"
            if b['asked_for']['eyelet_wall'] else "")
         + (f", min thickness {b['asked_for']['min_thickness']} {u}"
            if b['asked_for']['min_thickness'] else ""),
         "", f"## VERDICT: {b['verdict'].upper()}", ""]

    if b.get("blocking"):
        L += ["**Blocking:**"] + [f"- {x}" for x in b["blocking"]] + [""]

    L += ["## Targets", "", "```", b.get("targets_text", "(none)"), "```", ""]

    fc = b.get("font_check") or {}
    if fc.get("fatal"):
        L += [f"## Font check", "", f"**FATAL:** {fc['fatal']}", ""]
    else:
        L += [f"## Font check — {fc.get('n_errors', '?')} error(s), "
              f"{fc.get('n_warnings', '?')} warning(s)", ""]
        real = [x for x in (fc.get("findings") or [])
                if x["severity"] in ("ERROR", "WARNING")]
        if real:
            for x in real:
                L += [f"- **[{x['severity']}] {x['title']}**",
                      f"  - what: {x['what']}", f"  - fix: {x['fix']}"]
        else:
            L.append("No errors and no warnings.")
        L.append("")

    p = b.get("pairs") or {}
    L += ["## Letter pairs", ""]
    if p.get("error"):
        L.append(f"scan failed: {p['error']}")
    elif not p.get("flagged"):
        if p.get("untested"):
            L.append(f"**{p['untested']} of {p.get('total', '?')} pairs were "
                     f"NEVER TESTED** - the {p.get('budget_s')}s budget ran "
                     f"out. Nothing here says the font is clean; raise "
                     f"`--pair-budget` and run again.")
        else:
            L.append(f"Every one of {p.get('total', '?')} pairs joins cleanly, "
                     f"in every position.")
    else:
        L.append(f"{p['flagged']} pair(s) do not join. Worst first:")
        L += [f"- `{d.get('shaped_from') or d['pair']}` "
              f"({d['pair']} at the {d.get('position', '?')}) — {d['status']}"
              + (f", gap {d['gap_em']:.3f} em" if d.get("gap_em") else "")
              for d in p["worst_first"][:40]]
    L.append("")

    L += ["## Built artwork (test names)", "",
          "| test name | size | pieces | holes | engrave |",
          "|---|---|---|---|---|"]
    for r in b["names"]:
        if r.get("error"):
            L.append(f"| {r['name']} | FAILED: {r['error']} | | | |")
        else:
            L.append(f"| {r['name']} | {r['width']:.3f} x {r['height']:.3f} "
                     f"{r.get('unit', u)} | {r.get('pieces')} | "
                     f"{r.get('holes')} | {r.get('engrave_lines')} |")
    L.append("")

    if b.get("eyelets"):
        L += ["## Eyelets", "",
              f"| end | inner Ø | outer Ø | wall avg | wall thinnest | "
              f"roundness |", "|---|---|---|---|---|---|"]
        for e in b["eyelets"]:
            L.append(f"| {e['side']} | {e['inner_diameter']:.4f} | "
                     f"{e['outer_diameter']:.4f} | {e['wall_avg']:.4f} | "
                     f"{e['wall_thinnest']:.4f} | {e['roundness']:.3f} |")
        L += ["", f"(all in {u}; font units in the JSON)", ""]
    elif b.get("eyelets_note"):
        L += ["## Eyelets", "", b["eyelets_note"], ""]

    th = b.get("thickness") or {}
    L += ["## Thinnest parts", ""]
    if th.get("error"):
        L.append(f"scan failed: {th['error']}")
    elif th.get("spots"):
        if th.get("areas_found") is not None:
            L.append(f"{th['areas_found']} thin area(s) found"
                     + (f", **{th['areas_below_target']} under target**"
                        if th.get("areas_below_target") else "")
                     + f"; the worst {th.get('spots_shown', '?')} are listed.")
            L.append("")
        L += ["| # | letter | where | thickness | font units | walls | needs |",
              "|---|---|---|---|---|---|---|"]
        for s in th["spots"]:
            need = ("" if s["needs_pct"] is None
                    else (f"{s['needs_pct']:+.1f}%" if not s["meets_target"]
                          else "ok"))
            cl = s.get("clearance")
            walls = ("?" if cl is None else
                     (f"web {cl:.2f}" if s.get("parallel_walls")
                      else f"taper {cl:.2f}"))
            L.append(f"| {s['rank']} | {s['letter']} | {s['where']} | "
                     f"{s['thickness']:.4f} {th['unit']} | "
                     f"{s['thickness_font_units']:.1f} | {walls} | {need} |")
        L += ["", "`walls` is how parallel the two sides are at the worst "
                  "reading. **web** (about 0.50) is material that will snap and "
                  "is worth thickening; **taper** is the width of a wedge "
                  "running into a junction, which is usually not.", ""]
    L.append("")

    L += ["## Prompts", "",
          "Each block is a paste-ready instruction. An empty block means there "
          "is nothing to fix in that area.", "",
          "**PASTE ONE BLOCK PER ROUND. Every block here was measured on the SAME version of the font, so the moment one of them is carried out the others are describing a font that no longer exists - re-run and use the fresh blocks. The blocks also overlap on purpose: a junction fix can appear in both 1 and 2, and block 4 is the ONLY one allowed to resize an eyelet.**", ""]
    for key, title in (("font_defects", "Font defects"),
                       ("letter_pairs", "Letter pairs that do not join"),
                       ("thin_areas", "Thin areas to thicken"),
                       ("eyelet_size", "Eyelet size")):
        body = (b.get("prompts") or {}).get(key) or ""
        L += [f"### {title}", "", "```", body if body else "(nothing to fix)",
              "```", ""]
    return "\n".join(L)


# --------------------------------------------------------------------------- #
#  CLI
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="nameplate_brief.py",
        description="Measure a font against nameplate targets and say whether "
                    "it is done. Exit 0 = every target met, 1 = work needed, "
                    "2 = unusable, 3 = tool error.")
    ap.add_argument("--font", required=True, help="path to a .ttf/.otf/.ttc")
    ap.add_argument("--cap", type=float, default=1.0,
                    help="cap height to measure at (default 1.0)")
    ap.add_argument("--unit", default="in", choices=("in", "mm"))
    ap.add_argument("--basis", default="cap",
                    choices=("cap", "xheight", "total"))
    ap.add_argument("--names", default=",".join(DEFAULT_NAMES),
                    help="comma-separated test names (default ADAM,Adam)")
    ap.add_argument("--eyelet-id", type=float, default=None,
                    help="wanted eyelet inner diameter, in --unit")
    ap.add_argument("--eyelet-wall", type=float, default=None,
                    help="wanted eyelet wall thickness, in --unit")
    ap.add_argument("--min-thickness", type=float, default=None,
                    help="the thinnest the letters may be, in --unit")
    ap.add_argument("--pair-budget", type=float, default=30.0,
                    help="seconds for the letter-pair scan (0 skips it)")
    ap.add_argument("--join-budget", type=float, default=25.0,
                    help="seconds for the font check's own join scan")
    ap.add_argument("--samples", type=int, default=900,
                    help="points walked around the outline for thickness")
    ap.add_argument("--json", dest="json_path", default=None,
                    help="write the full JSON here (default: stdout)")
    ap.add_argument("--md", dest="md_path", default=None,
                    help="also write the readable brief here")
    ap.add_argument("--quiet", action="store_true",
                    help="write files only, print just the verdict line")
    a = ap.parse_args(argv)

    if not os.path.isfile(a.font):
        print(f"no such font file: {a.font}", file=sys.stderr)
        return 3
    for label, v in (("--cap", a.cap), ("--eyelet-id", a.eyelet_id),
                     ("--eyelet-wall", a.eyelet_wall),
                     ("--min-thickness", a.min_thickness)):
        if v is not None and not (v > 0 and v == v and abs(v) != float("inf")):
            print(f"{label} must be a positive number, got {v!r}",
                  file=sys.stderr)
            return 3

    names = [n.strip() for n in a.names.split(",") if n.strip()]
    if not names:
        print("--names left no usable name", file=sys.stderr)
        return 3

    try:
        b = brief(a.font, cap=a.cap, unit=a.unit, basis=a.basis, names=names,
                  target_id=a.eyelet_id, target_wall=a.eyelet_wall,
                  min_thickness=a.min_thickness, pair_budget=a.pair_budget,
                  join_budget=a.join_budget, thickness_samples=a.samples)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f"nameplate_brief failed: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return 3

    blob = json.dumps(b, indent=2, ensure_ascii=False)
    if a.json_path:
        with open(a.json_path, "w", encoding="utf-8") as fh:
            fh.write(blob)
    if a.md_path:
        with open(a.md_path, "w", encoding="utf-8") as fh:
            fh.write(markdown(b))

    # stdout has to survive a console that is not UTF-8
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    if a.quiet or a.json_path or a.md_path:
        print(f"{b['font']['file']}: {b['verdict'].upper()}"
              f" ({b.get('seconds')}s)")
        if not a.quiet:
            print(b.get("targets_text", ""))
            for x in b.get("blocking", []):
                print("BLOCKING:", x)
    else:
        print(blob)

    return {"ready": 0, "needs work": 1, "unusable": 2}.get(b["verdict"], 1)


if __name__ == "__main__":
    raise SystemExit(main())

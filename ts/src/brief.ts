/**
 * brief.ts — the app's whole opinion of a font, in one command.
 *
 *     node src/brief.ts --font X.ttf --cap 1.0 --unit in \
 *         --eyelet-id 0.375 --eyelet-wall 0.20 --min-thickness 0.10
 *
 * This is the machine-readable face of Sean's Font Prototyping Friend. The GUI
 * answers "is this font right?" for a person; this answers the same question for an
 * agent, and — the part that matters — it JUDGES the answer against targets and says
 * so in the exit code:
 *
 *     0   every target met. The font is done.
 *     1   the font builds, but one or more targets are not met yet.
 *     2   the font cannot be used at all (it does not parse, has no cmap, ...).
 *     3   the tool itself failed (bad arguments, missing file).
 *
 * So a font-editing loop is just:
 *
 *     while node src/brief.ts ... ; [ $? -eq 1 ]; do  edit the font  done
 *
 * WHY A SEPARATE TOOL AND NOT A FLAG ON THE GUI
 *     The GUI holds state — a selected font, a typed name, a unit, four toggles. An
 *     agent needs none of that and must not depend on it. Everything here is stated
 *     on the command line and every number comes back in one JSON object, so two runs
 *     a week apart are comparable and nothing is remembered between them.
 *
 * WHAT IT MEASURES
 *     Every check the GUI can do, run in one pass over one font:
 *       * the font itself          fontcheck.checkFont
 *       * every letter pair        pairsheet.analysePairs
 *       * the built artwork        core.buildDocument, per test name
 *       * the eyelets              eyelets.measureEyelets
 *       * the thin places          thickness.survey
 *     Nothing is re-implemented here. If the GUI and this tool ever disagree, that is
 *     a bug in this file, not a difference of opinion.
 *
 * TARGETS ARE OPTIONAL
 *     Leave a target out and that measurement is reported but not judged. Give one
 *     and it becomes a pass/fail with the exact font-unit change needed. Font units
 *     are what a font editor works in, and because everything scales linearly they
 *     hold at every cutting height — set them once and the font is right at 1 in and
 *     at 12 mm.
 *
 * KEY ORDER IS PART OF THE OUTPUT
 *     The JSON is written with the keys in the order the Python inserts them, because
 *     an agent diffing two runs sees a reordered object as a change. Every object
 *     literal here is therefore in the Python's insertion order, not alphabetical.
 */

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import { Document, buildDocument, capReference } from "./core.ts";
import { Font } from "./font.ts";
import * as EY from "./eyelets.ts";
import * as FC from "./fontcheck.ts";
import * as LI from "./leadin.ts";
import * as PS from "./pairsheet.ts";
import * as TH from "./thickness.ts";
import { fmtF, fmtSigned, pyG } from "./pyformat.ts";

export const MM_PER_IN = 25.4;

/**
 * The test names. ADAM exercises capitals and both eyelet ends; Adam exercises the
 * capital-then-lowercase join, which is where script fonts break.
 */
export const DEFAULT_NAMES = ["ADAM", "Adam"];

// --------------------------------------------------------------------------- //
//  helpers
// --------------------------------------------------------------------------- //

/** A float that survives JSON — NaN and inf become null. */
function f(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  if (v === null || v === undefined || Number.isNaN(x)) return null;
  return Number.isFinite(x) ? x : null;
}

/**
 * Half a unit in the last decimal place the caller wrote.
 *
 * `--eyelet-id 1.77` means "1.77 to the nearest hundredth", so anything from 1.765 to
 * 1.775 satisfies it. Reading the written precision off the number keeps a target as
 * strict as it was stated and no stricter: pass 1.7752 and you get 0.00005, pass 1.77
 * and you get 0.005.
 */
function lastPlaceTol(value: unknown): number {
  const x = Number(value);
  if (!Number.isFinite(x)) return 0.0;
  // Python's repr(float) is what decides the precision; String(x) is the same
  // shortest-round-trip form, except that Python writes an integral float as "1.0".
  const s = Number.isInteger(x) ? `${x}.0` : String(x);
  if (s.includes("e") || s.includes("E")) {
    // 1e-05 and friends: use the exponent
    return Math.abs(x) * 5e-4;
  }
  const frac = s.includes(".") ? s.split(".", 2)[1].replace(/0+$/, "") : "";
  return 0.5 * 10.0 ** -frac.length;
}

/** One judged measurement. */
export interface JudgeRow {
  what: string;
  measured: number | null;
  target: number | null;
  unit: string;
  verdict: string;
  font_units: { measured: number | null; target: number | null };
  change_pct: number | null;
}

/** Collects pass/fail against the targets that were actually given. */
export class Judge {
  rows: JudgeRow[] = [];

  /**
   * Judge one measurement.
   *
   * @param direction "at-least" measured must be >= target (a minimum thickness);
   *                  "equal" measured must equal target within tol (a diameter)
   */
  add(
    what: string,
    measured: unknown,
    target: unknown,
    unit: string,
    fuMeasured: unknown = null,
    fuTarget: unknown = null,
    direction = "at-least",
    tol = 0.0,
  ): void {
    const m = f(measured);
    const t = f(target);
    if (t === null) {
      this.rows.push({
        what, measured: m, target: null, unit, verdict: "not judged",
        font_units: { measured: f(fuMeasured), target: null },
        change_pct: null,
      });
      return;
    }
    if (m === null) {
      this.rows.push({
        what, measured: null, target: t, unit, verdict: "could not measure",
        font_units: { measured: null, target: f(fuTarget) },
        change_pct: null,
      });
      return;
    }
    let ok: boolean;
    if (direction === "at-least") {
      ok = m >= t - tol;
    } else {
      // An "equal" target has to accept the precision the target was WRITTEN at.
      // Asking for 1.77 mm when the font measures 1.7752 mm is a font that is already
      // right; failing it made a correct eyelet look like a defect and sent someone to
      // edit it. So the tolerance is half a unit in the last decimal place the caller
      // actually typed, floored at the explicit tol.
      ok = Math.abs(m - t) <= Math.max(tol, lastPlaceTol(target));
    }
    this.rows.push({
      what, measured: m, target: t, unit,
      verdict: ok ? "MET" : "NOT MET",
      font_units: { measured: f(fuMeasured), target: f(fuTarget) },
      change_pct: m ? f((t / m - 1.0) * 100.0) : null,
    });
  }

  get judged(): JudgeRow[] {
    return this.rows.filter(
      (r) => r.verdict === "MET" || r.verdict === "NOT MET" || r.verdict === "could not measure",
    );
  }

  get failed(): JudgeRow[] {
    return this.rows.filter((r) => r.verdict === "NOT MET" || r.verdict === "could not measure");
  }

  text(): string {
    const judged = this.judged;
    if (!judged.length) {
      return (
        "No targets were given, so nothing was judged. Pass --eyelet-id / " +
        "--eyelet-wall / --min-thickness to turn a measurement into a pass or fail."
      );
    }
    const w = Math.max(...judged.map((r) => r.what.length));
    const padR = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
    const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
    const L: string[] = [
      `${padR("", w)}  ${padL("now", 10)}  ${padL("target", 10)}  ${padL("change", 9)}  ` +
        `${padL("font units now -> want", 26)}  verdict`,
    ];
    for (const r of judged) {
      const fm = r.font_units.measured;
      const ft = r.font_units.target;
      const fu =
        fm !== null && ft !== null
          ? `${padL(fmtF(fm, 1), 11)} -> ${padR(fmtF(ft, 1), 11)}`
          : fm !== null
            ? `${padL(fmtF(fm, 1), 11)}    ${padR("", 11)}`
            : " ".repeat(26);
      L.push(
        `${padR(r.what, w)}  ` +
          `${padL(r.measured !== null ? fmtF(r.measured, 4) : "?", 10)}  ` +
          `${padL(r.target !== null ? fmtF(r.target, 4) : "-", 10)}  ` +
          `${padL(r.change_pct !== null ? `${fmtSigned(r.change_pct, 2)}%` : "-", 9)}  ` +
          `${fu}  ${r.verdict}`,
      );
    }
    return L.join("\n");
  }
}

/** Python's `f"{type(exc).__name__}: {exc}"`. */
function excStr(exc: unknown): string {
  const e = exc as Error;
  return `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}`;
}

/** Python's `repr()` of a short string. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\");
  if (q === "'") body = body.replace(/'/g, "\\'");
  return q + body.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + q;
}

/** Python's `round(x, 1)` — half to even on the exact double. */
function round1(v: number): number {
  const scaled = v * 10;
  const fl = Math.floor(scaled);
  const diff = scaled - fl;
  const n = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
  return n / 10;
}

// --------------------------------------------------------------------------- //
//  the one pass
// --------------------------------------------------------------------------- //

/** The whole brief, as the JSON an agent reads. */
export type Brief = Record<string, any>;

/** Everything the app knows about this font, judged against the targets. */
export function brief(
  fontPath: string,
  opts: {
    cap?: number;
    unit?: string;
    basis?: string;
    names?: string[];
    targetId?: number | null;
    targetWall?: number | null;
    minThickness?: number | null;
    pairBudget?: number;
    joinBudget?: number;
    thicknessSamples?: number;
  } = {},
): Brief {
  const cap = opts.cap ?? 1.0;
  const unit = opts.unit ?? "in";
  const basis = opts.basis ?? "cap";
  const names = opts.names ?? DEFAULT_NAMES;
  const targetId = opts.targetId ?? null;
  const targetWall = opts.targetWall ?? null;
  const minThickness = opts.minThickness ?? null;
  const pairBudget = opts.pairBudget ?? 30.0;
  const joinBudget = opts.joinBudget ?? 25.0;
  const thicknessSamples = opts.thicknessSamples ?? 900;

  const t0 = Date.now() / 1000;
  const out: Brief = {
    tool: "nameplate_brief",
    font: { path: resolve(fontPath), file: basename(fontPath) },
    asked_for: {
      cap_height: f(cap), unit, basis,
      test_names: [...names],
      eyelet_inner_diameter: f(targetId),
      eyelet_wall: f(targetWall),
      min_thickness: f(minThickness),
    },
    font_check: {}, pairs: {}, names: [], eyelets: [],
    thickness: {}, targets: [], prompts: {}, verdict: "",
  };
  const elapsed = () => round1(Date.now() / 1000 - t0);

  // ---- can it even be opened? ---------------------------------------- //
  let font: Font;
  try {
    font = new Font(fontPath);
  } catch (exc) {
    out.font_check = {
      usable: false, fatal: excStr(exc), errors: [], warnings: [], findings: [],
    };
    out.verdict = "unusable";
    out.seconds = elapsed();
    return out;
  }

  Object.assign(out.font, {
    family: font.family ?? "",
    upem: font.upem ?? null,
    has_engrave_lines: Boolean(font.colr && font.colr.size),
  });

  // ---- the font itself ------------------------------------------------ //
  try {
    const rep = FC.checkFont(fontPath, { names: [...names], joinScanBudget: joinBudget });
    out.font_check = {
      usable: Boolean(rep.usable),
      family: rep.family,
      upem: rep.upem,
      n_errors: rep.errors.length,
      n_warnings: rep.warnings.length,
      findings: rep.sorted().map((x) => ({
        severity: x.severity, code: x.code, title: x.title, what: x.detail, fix: x.fix,
      })),
      facts: [...rep.facts],
    };
    out.prompts.font_defects =
      rep.errors.length || rep.warnings.length ? rep.claudePrompt() : "";
    out.report_text = rep.text();
  } catch (exc) {
    out.font_check = {
      usable: null, fatal: `check_font failed: ${excStr(exc)}`,
      errors: [], warnings: [], findings: [],
    };
  }

  // ---- every letter pair --------------------------------------------- //
  try {
    const prep = PS.analysePairs(font, undefined, pairBudget);
    const bad: Record<string, any>[] = [];
    for (const grp of prep.groups) {
      const sorted = [...grp.cells.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      for (const [key, cell] of sorted) {
        if (!cell.problem) continue;
        const [a, b] = PS.splitCellKey(key);
        // The GROUP matters as much as the pair: the same two letters use different
        // glyphs at the start of a word and in the middle of one, so "ab fails" is
        // only half a fact.
        bad.push({
          pair: `${a}${b}`, left: a, right: b,
          group: grp.key,
          position: grp.middle ? "middle of a word" : "start of a word",
          shaped_from: cell.context || `${a}${b}`,
          status: String(cell.status),
          gap_em: f(cell.gap_em),
        });
      }
    }
    // Python's `list.sort` is stable, so equal gaps keep the order they were found in.
    bad.sort((x, y) => -(x.gap_em || 0) - -(y.gap_em || 0));
    // A pair nobody measured is NOT a pair that works. Only counting .problem cells
    // meant a run with too small a budget reported "flagged: 0" and exited 0 READY
    // while nearly every combination was UNTESTED -- and the skills treat exit 0 as
    // the only definition of done, so an agent would have declared an unmeasured font
    // finished.
    const untested = prep.n_untested || 0;
    out.pairs = {
      flagged: bad.length,
      tested: prep.n_tested || 0,
      untested,
      total: prep.n_pairs || 0,
      budget_hit: Boolean(prep.budget_hit),
      budget_s: f(pairBudget),
      worst_first: bad,
    };
    if (untested) {
      (out.blocking ??= []).push(
        `${untested} letter pair(s) were never tested - the ${pyG(pairBudget)}s pair ` +
          `budget ran out. Raise --pair-budget; an untested pair is not a pair that works.`,
      );
    }
    out.prompts.letter_pairs =
      bad.length || untested ? PS.claudePrompt(font, prep, fontPath) : "";
  } catch (exc) {
    out.pairs = { error: excStr(exc), flagged: null };
  }

  // ---- the built artwork, per test name ------------------------------- //
  const docs = new Map<string, Document>();
  for (const nm of names) {
    const row: Record<string, any> = { name: nm };
    try {
      const doc = buildDocument(font, nm, cap, unit as any, basis as any);
      docs.set(nm, doc);
      const [w, h] = doc.size();
      Object.assign(row, {
        width: f(w), height: f(h), unit: doc.unit,
        engrave_lines: doc.engravePaths.length,
        [`scale_units_per_${unit}`]: f(doc.scale),
        warnings: [...doc.warnings],
      });
      try {
        const { depths } = LI.analyse(LI.rings(doc));
        row.pieces = depths.filter((d) => d % 2 === 0).length;
        row.holes = depths.filter((d) => d % 2 === 1).length;
        row.cuts_as_one_piece = row.pieces === 1;
      } catch (exc) {
        row.piece_check_error = excStr(exc);
      }
    } catch (exc) {
      row.error = excStr(exc);
    }
    out.names.push(row);
  }

  // everything below is measured on the FIRST name that built — the eyelet and the
  // thin places belong to shaped artwork, not to the font in the abstract
  let doc: Document | null = null;
  for (const n of names) {
    const d = docs.get(n);
    if (d) {
      doc = d;
      break;
    }
  }
  if (doc === null) {
    out.verdict = "unusable";
    out.seconds = elapsed();
    return out;
  }
  out.measured_on = {
    name: doc.text,
    cap_height: f(doc.targetHeight),
    unit: doc.unit,
    basis: doc.basis,
    [`units_per_${doc.unit}`]: f(doc.scale),
  };
  const scale = Number(doc.scale) || 1.0;

  const judge = new Judge();

  // ---- eyelets -------------------------------------------------------- //
  try {
    const eyes = EY.measureEyelets(doc);
    for (const e of eyes) {
      out.eyelets.push({
        side: e.side, unit: e.unit,
        inner_diameter: f(e.inner_d),
        outer_diameter: f(e.outer_d),
        wall_avg: f(EY.wallFromDiameters(e)),
        wall_thinnest: f(e.wall_min),
        roundness: f(e.circularity),
        centre: [f(e.centre[0]), f(e.centre[1])],
        font_units: {
          inner_diameter: f(e.inner_d / scale),
          outer_diameter: f(e.outer_d / scale),
          wall_avg: f(EY.wallFromDiameters(e) / scale),
        },
        note: e.note,
      });
    }
    if (eyes.length) {
      const e = eyes[0];
      const wall = EY.wallFromDiameters(e);
      judge.add(
        "eyelet inner diameter", e.inner_d, targetId, doc.unit,
        e.inner_d / scale, targetId ? targetId / scale : null, "equal", 0.0005,
      );
      judge.add(
        "eyelet wall", wall, targetWall, doc.unit,
        wall / scale, targetWall ? targetWall / scale : null, "equal", 0.0005,
      );
      out.prompts.eyelet_size = EY.claudePrompt(doc, eyes, targetId, targetWall, fontPath);
    } else {
      out.eyelets_note =
        `no round hole near either end of ${pyRepr(doc.text)} — this font may have no ` +
        `eyelet, or not on these letters`;
      if (targetId || targetWall) {
        judge.add("eyelet inner diameter", null, targetId, doc.unit);
        judge.add("eyelet wall", null, targetWall, doc.unit);
      }
      out.prompts.eyelet_size = "";
    }
  } catch (exc) {
    out.eyelets_error = excStr(exc);
    out.prompts.eyelet_size = "";
  }

  // ---- thin places ---------------------------------------------------- //
  try {
    const surv = TH.survey(doc, minThickness, thicknessSamples, 8, font);
    const spots = [...(surv.spots ?? [])];
    out.thickness = {
      unit: doc.unit,
      // How many thin areas exist in TOTAL and how many are under target. spots[] is
      // capped at top_n, so a font with 40 failing areas showed 8 and nothing said
      // there were 32 more -- an agent would fix eight and call the font done.
      areas_found: surv.n_areas || 0,
      areas_below_target: surv.n_below_target || 0,
      spots_shown: null, // filled in below, once spots is built
      samples_taken: surv.samples_taken || 0,
      thinnest: spots.length ? f(spots[0].thickness) : null,
      thinnest_font_units: spots.length ? f(spots[0].thickness / scale) : null,
      spots: spots.map((s, i) => ({
        rank: i + 1,
        letter: s.letter ?? "",
        glyph: s.glyph ?? "",
        where: s.where ?? "",
        thickness: f(s.thickness),
        thickness_font_units: f(s.thickness / scale),
        typical: f(s.thickness_typical),
        at: [f(s.pos[0]), f(s.pos[1])],
        extent: f(s.extent),
        // How parallel the two walls are: 0.50 is a genuine web that will snap, lower
        // is a taper into a junction where the reading is a wedge's width rather than
        // a stroke's. Anything under ~0.47 is usually not worth thickening -- decide
        // with this number in front of you rather than from the thickness alone.
        clearance: f(s.clearance),
        parallel_walls: Boolean(s.parallel_walls),
        meets_target: !minThickness ? null : Boolean(s.thickness >= minThickness),
        needs_pct:
          !minThickness || !s.thickness ? null : f((minThickness / s.thickness - 1.0) * 100.0),
      })),
    };
    out.thickness.spots_shown = spots.length;
    if ((out.thickness.areas_below_target || 0) > spots.length) {
      (out.blocking ??= []).push(
        `${out.thickness.areas_below_target} thin areas are under the target but only ` +
          `the worst ${spots.length} are listed - fix these, then re-run; do not treat ` +
          `the list as complete.`,
      );
    }
    if (spots.length) {
      judge.add(
        "thinnest part of the letters", spots[0].thickness, minThickness, doc.unit,
        spots[0].thickness / scale, minThickness ? minThickness / scale : null,
        "at-least", 0.0,
      );
      out.thickness.below_target = minThickness
        ? out.thickness.spots.filter((s: any) => s.meets_target === false).map((s: any) => s.rank)
        : null;
    }
    // The Python calls TH.claude_prompt here, which runs the WHOLE survey again just
    // to render it — the single most expensive thing this tool does, done twice for
    // one answer. When the samples count is the module default (which is also
    // brief's default) the second survey has identical inputs to the one just
    // finished, so its result is identical too and the survey in hand can be
    // rendered instead. Same bytes out, half the work.
    //
    // The fallback is not dead code: a caller that passed --samples something else
    // gets the Python's exact behaviour, because TH.claude_prompt always re-surveys
    // at the default and would then legitimately disagree with the table above it.
    out.prompts.thin_areas = !minThickness
      ? ""
      : thicknessSamples === TH.MAX_SAMPLES
        ? TH.asciiOnly(
            TH.claudePromptFromSpots(
              doc, minThickness, surv.spots, fontPath, surv.n_areas, surv.n_below_target,
            ),
          )
        : TH.claudePrompt(doc, minThickness, fontPath, font);
  } catch (exc) {
    out.thickness = { error: excStr(exc) };
    out.prompts.thin_areas = "";
  }

  // ---- the cap reference, reported as a FACT and never as a target ----- //
  // This was a target and it was a bad one. It built a single "H", measured its INK
  // BOUNDING BOX, and compared that to the asked cap height — so on any font whose H
  // overshoots the cap line or dips below the baseline (i.e. most real fonts) the row
  // read NOT MET permanently and exit 0 became unreachable. Verified on
  // ShineOnScript2: cap line 696 u, H ink 713 u, a fixed -2.39%.
  //
  // Worse than a wrong number: an agent told "exit 0 is done" can only close that gap
  // by SQUASHING THE H — destroying exactly the overshoot that is correct by design
  // and that the app exists to preserve. The bug pushed a well-behaved agent into
  // damaging the font.
  //
  // The cap height is not a property of the font that an editor should change to suit
  // us; it is the reference the app measures FROM. So it is reported, with the
  // per-letter overshoot spelled out, and nothing here is judged.
  try {
    const { ref: refFu, warn: refWarn } = capReference(font);
    const letters: Record<string, any> = {};
    for (const ch of "HEITAOJQ") {
      const gid = font.gidForChar(ch);
      if (gid === undefined) continue;
      const ys = font.contours(gid).flatMap((c) => c.map((p) => p[1]));
      if (ys.length) {
        const top = Math.max(...ys);
        letters[ch] = {
          ink_top_font_units: f(top),
          over_cap_line_font_units: f(top - refFu),
          ink_height_at_asked_cap: f(((top - Math.min(...ys)) / refFu) * cap),
        };
      }
    }
    out.cap_height_check = {
      asked: f(cap), unit, basis,
      cap_line_font_units: f(refFu),
      cap_line_lands_at: f(cap),
      per_letter: letters,
      warnings: [...(refWarn ?? [])],
      note:
        "NOT a target — nothing here can fail. The cap LINE is set to the asked " +
        "height for every name, which is what makes two names match. Individual " +
        "capitals read OVER that line on purpose (overshoot): a round O and a pointed " +
        "A both exceed it, a flat H E I T sit on it, and a J or Q hangs below the " +
        "baseline so its ink is taller still. Do not 'correct' any of that — " +
        "flattening overshoot damages the font and changes nothing about the size " +
        "that is cut.",
    };
  } catch (exc) {
    out.cap_height_check = { error: excStr(exc) };
  }

  // ---- one piece is a hard requirement -------------------------------- //
  for (const row of out.names) {
    if (row.cuts_as_one_piece === false) {
      (out.blocking ??= []).push(
        `the test name ${pyRepr(row.name)} cuts as ${row.pieces} loose pieces, not one plate`,
      );
    }
  }

  out.targets = judge.rows;
  out.targets_text = judge.text();

  const fatal = out.font_check.usable === false || Boolean(out.font_check.n_errors);
  if (fatal) {
    out.verdict = "unusable";
  } else if (judge.failed.length || out.blocking || out.pairs.flagged) {
    out.verdict = "needs work";
  } else {
    out.verdict = "ready";
  }
  out.seconds = elapsed();
  return out;
}

// --------------------------------------------------------------------------- //
//  the readable version
// --------------------------------------------------------------------------- //

/** The brief as markdown, for a person rather than an agent. */
export function markdown(b: Brief): string {
  const fo = b.font;
  const u = b.asked_for.unit;
  const L: string[] = [
    `# Font brief — ${fo.file}`,
    "",
    `- family (the font's own internal name): **${fo.family || "(none)"}**`,
    `- unitsPerEm: ${fo.upem}`,
    `- engrave lines: ${fo.has_engrave_lines ? "yes (COLR)" : "no — cut only, which is normal"}`,
    `- asked for: cap height ${pyNum(b.asked_for.cap_height)} ${u}` +
      (b.asked_for.eyelet_inner_diameter
        ? `, eyelet ID ${pyNum(b.asked_for.eyelet_inner_diameter)} ${u}`
        : "") +
      (b.asked_for.eyelet_wall ? `, eyelet wall ${pyNum(b.asked_for.eyelet_wall)} ${u}` : "") +
      (b.asked_for.min_thickness
        ? `, min thickness ${pyNum(b.asked_for.min_thickness)} ${u}`
        : ""),
    "",
    `## VERDICT: ${String(b.verdict).toUpperCase()}`,
    "",
  ];

  if (b.blocking?.length) {
    L.push("**Blocking:**", ...b.blocking.map((x: string) => `- ${x}`), "");
  }

  L.push("## Targets", "", "```", b.targets_text ?? "(none)", "```", "");

  const fc = b.font_check ?? {};
  if (fc.fatal) {
    L.push(`## Font check`, "", `**FATAL:** ${fc.fatal}`, "");
  } else {
    L.push(
      `## Font check — ${fc.n_errors ?? "?"} error(s), ${fc.n_warnings ?? "?"} warning(s)`,
      "",
    );
    const real = (fc.findings ?? []).filter(
      (x: any) => x.severity === "ERROR" || x.severity === "WARNING",
    );
    if (real.length) {
      for (const x of real) {
        L.push(
          `- **[${x.severity}] ${x.title}**`,
          `  - what: ${x.what}`,
          `  - fix: ${x.fix}`,
        );
      }
    } else {
      L.push("No errors and no warnings.");
    }
    L.push("");
  }

  const p = b.pairs ?? {};
  L.push("## Letter pairs", "");
  if (p.error) {
    L.push(`scan failed: ${p.error}`);
  } else if (!p.flagged) {
    if (p.untested) {
      L.push(
        `**${p.untested} of ${p.total ?? "?"} pairs were NEVER TESTED** - the ` +
          `${pyNum(p.budget_s)}s budget ran out. Nothing here says the font is clean; ` +
          `raise \`--pair-budget\` and run again.`,
      );
    } else {
      L.push(`Every one of ${p.total ?? "?"} pairs joins cleanly, in every position.`);
    }
  } else {
    L.push(`${p.flagged} pair(s) do not join. Worst first:`);
    for (const d of p.worst_first.slice(0, 40)) {
      L.push(
        `- \`${d.shaped_from || d.pair}\` (${d.pair} at the ${d.position ?? "?"}) — ` +
          `${d.status}` +
          (d.gap_em ? `, gap ${fmtF(d.gap_em, 3)} em` : ""),
      );
    }
  }
  L.push("");

  L.push(
    "## Built artwork (test names)",
    "",
    "| test name | size | pieces | holes | engrave |",
    "|---|---|---|---|---|",
  );
  for (const r of b.names) {
    if (r.error) {
      L.push(`| ${r.name} | FAILED: ${r.error} | | | |`);
    } else {
      L.push(
        `| ${r.name} | ${fmtF(r.width, 3)} x ${fmtF(r.height, 3)} ${r.unit ?? u} | ` +
          `${r.pieces} | ${r.holes} | ${r.engrave_lines} |`,
      );
    }
  }
  L.push("");

  if (b.eyelets?.length) {
    L.push(
      "## Eyelets",
      "",
      `| end | inner Ø | outer Ø | wall avg | wall thinnest | roundness |`,
      "|---|---|---|---|---|---|",
    );
    for (const e of b.eyelets) {
      L.push(
        `| ${e.side} | ${fmtF(e.inner_diameter, 4)} | ${fmtF(e.outer_diameter, 4)} | ` +
          `${fmtF(e.wall_avg, 4)} | ${fmtF(e.wall_thinnest, 4)} | ${fmtF(e.roundness, 3)} |`,
      );
    }
    L.push("", `(all in ${u}; font units in the JSON)`, "");
  } else if (b.eyelets_note) {
    L.push("## Eyelets", "", b.eyelets_note, "");
  }

  const th = b.thickness ?? {};
  L.push("## Thinnest parts", "");
  if (th.error) {
    L.push(`scan failed: ${th.error}`);
  } else if (th.spots?.length) {
    if (th.areas_found !== null && th.areas_found !== undefined) {
      L.push(
        `${th.areas_found} thin area(s) found` +
          (th.areas_below_target ? `, **${th.areas_below_target} under target**` : "") +
          `; the worst ${th.spots_shown ?? "?"} are listed.`,
      );
      L.push("");
    }
    L.push(
      "| # | letter | where | thickness | font units | walls | needs |",
      "|---|---|---|---|---|---|---|",
    );
    for (const s of th.spots) {
      const need =
        s.needs_pct === null ? "" : !s.meets_target ? `${fmtSigned(s.needs_pct, 1)}%` : "ok";
      const cl = s.clearance;
      const walls =
        cl === null || cl === undefined
          ? "?"
          : s.parallel_walls
            ? `web ${fmtF(cl, 2)}`
            : `taper ${fmtF(cl, 2)}`;
      L.push(
        `| ${s.rank} | ${s.letter} | ${s.where} | ${fmtF(s.thickness, 4)} ${th.unit} | ` +
          `${fmtF(s.thickness_font_units, 1)} | ${walls} | ${need} |`,
      );
    }
    L.push(
      "",
      "`walls` is how parallel the two sides are at the worst reading. **web** (about " +
        "0.50) is material that will snap and is worth thickening; **taper** is the " +
        "width of a wedge running into a junction, which is usually not.",
      "",
    );
  }
  L.push("");

  L.push(
    "## Prompts",
    "",
    "Each block is a paste-ready instruction. An empty block means there is nothing to " +
      "fix in that area.",
    "",
    "**PASTE ONE BLOCK PER ROUND. Every block here was measured on the SAME version of the font, so the moment one of them is carried out the others are describing a font that no longer exists - re-run and use the fresh blocks. The blocks also overlap on purpose: a junction fix can appear in both 1 and 2, and block 4 is the ONLY one allowed to resize an eyelet.**",
    "",
  );
  for (const [key, title] of [
    ["font_defects", "Font defects"],
    ["letter_pairs", "Letter pairs that do not join"],
    ["thin_areas", "Thin areas to thicken"],
    ["eyelet_size", "Eyelet size"],
  ] as [string, string][]) {
    const body = (b.prompts ?? {})[key] || "";
    L.push(`### ${title}`, "", "```", body ? body : "(nothing to fix)", "```", "");
  }
  return L.join("\n");
}

/**
 * Python's `str()` of a number inside an f-string — an integral float keeps its
 * ".0", which `String(1.0)` in JavaScript drops.
 */
function pyNum(v: unknown): string {
  if (typeof v !== "number") return String(v);
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

// --------------------------------------------------------------------------- //
//  CLI
// --------------------------------------------------------------------------- //

/**
 * Python's `json.dumps(obj, indent=2, ensure_ascii=False)`.
 *
 * `JSON.stringify` matches it for everything the brief contains except one thing:
 * Python renders a float that happens to be integral as `1.0`, and JavaScript renders
 * it as `1`. An agent diffing two runs would see that as a change, so integral floats
 * are re-marked. Only values the brief itself produced as floats are affected —
 * counts stay integers.
 */
export function dumpJson(b: Brief): string {
  const FLOAT_KEYS = new Set([
    "cap_height", "eyelet_inner_diameter", "eyelet_wall", "min_thickness",
    "budget_s", "seconds", "measured", "target", "change_pct", "gap_em",
    "width", "height", "thickness", "thickness_font_units", "typical", "extent",
    "clearance", "needs_pct", "inner_diameter", "outer_diameter", "wall_avg",
    "wall_thinnest", "roundness", "thinnest", "thinnest_font_units",
    "cap_line_font_units", "cap_line_lands_at", "asked", "ink_top_font_units",
    "over_cap_line_font_units", "ink_height_at_asked_cap",
  ]);
  // An ASCII sentinel, and checked for collision before use. The first version of
  // this used a control character: JSON.stringify escapes those, so the escaped form
  // no longer matched the un-escaped regex and the marker LEAKED into the output as
  // "\u0001FLOAT\u00011.0\u0001FLOAT\u0001" instead of 1.0. Anything used as a
  // sentinel has to survive the serialiser it is being hidden from.
  const MARK = "@@INTEGRAL-FLOAT@@";
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        o[k] = walk(val, k);
      }
      return o;
    }
    if (
      typeof v === "number" &&
      Number.isInteger(v) &&
      key !== null &&
      (FLOAT_KEYS.has(key) || key.startsWith("scale_units_per_") || key.startsWith("units_per_"))
    ) {
      return `${MARK}${v}.0${MARK}`;
    }
    return v;
  };
  const plain = JSON.stringify(b, null, 2);
  if (plain.includes(MARK)) {
    // Some real string in the brief contains the sentinel, so substituting would
    // corrupt it. Better to hand back valid JSON with an integral float written as
    // "1" than to mangle a report.
    return plain;
  }
  const text = JSON.stringify(walk(b, null), null, 2);
  // unquote the marked numbers
  return text.split(`"${MARK}`).join("").split(`${MARK}"`).join("");
}

const USAGE = `usage: nameplate_brief.py --font FONT [options]

Measure a font against nameplate targets and say whether it is done.
Exit 0 = every target met, 1 = work needed, 2 = unusable, 3 = tool error.

  --font PATH            path to a .ttf/.otf/.ttc  (required)
  --cap FLOAT            cap height to measure at (default 1.0)
  --unit {in,mm}         default in
  --basis {cap,xheight,total}
  --names A,B            comma-separated test names (default ADAM,Adam)
  --eyelet-id FLOAT      wanted eyelet inner diameter, in --unit
  --eyelet-wall FLOAT    wanted eyelet wall thickness, in --unit
  --min-thickness FLOAT  the thinnest the letters may be, in --unit
  --pair-budget FLOAT    seconds for the letter-pair scan (0 skips it)
  --join-budget FLOAT    seconds for the font check's own join scan
  --samples INT          points walked around the outline for thickness
  --json PATH            write the full JSON here (default: stdout)
  --md PATH              also write the readable brief here
  --quiet                write files only, print just the verdict line
`;

/** The command line. Exit code is the contract — see the module docstring. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const a: Record<string, any> = {
    cap: 1.0, unit: "in", basis: "cap", names: DEFAULT_NAMES.join(","),
    eyelet_id: null, eyelet_wall: null, min_thickness: null,
    pair_budget: 30.0, join_budget: 25.0, samples: 900,
    json_path: null, md_path: null, quiet: false, font: null,
  };
  const NUM: Record<string, string> = {
    "--cap": "cap", "--eyelet-id": "eyelet_id", "--eyelet-wall": "eyelet_wall",
    "--min-thickness": "min_thickness", "--pair-budget": "pair_budget",
    "--join-budget": "join_budget",
  };
  const STR: Record<string, string> = {
    "--font": "font", "--unit": "unit", "--basis": "basis", "--names": "names",
    "--json": "json_path", "--md": "md_path",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quiet") {
      a.quiet = true;
    } else if (arg === "--samples") {
      a.samples = Math.trunc(Number(argv[++i]));
    } else if (NUM[arg]) {
      a[NUM[arg]] = Number(argv[++i]);
    } else if (STR[arg]) {
      a[STR[arg]] = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`unrecognised argument: ${arg}\n${USAGE}`);
      return 3;
    }
  }

  if (!a.font) {
    process.stderr.write(`--font is required\n${USAGE}`);
    return 3;
  }
  if (!["in", "mm"].includes(a.unit)) {
    process.stderr.write(`--unit must be in or mm, got ${pyRepr(String(a.unit))}\n`);
    return 3;
  }
  if (!["cap", "xheight", "total"].includes(a.basis)) {
    process.stderr.write(
      `--basis must be cap, xheight or total, got ${pyRepr(String(a.basis))}\n`,
    );
    return 3;
  }
  if (!fs.existsSync(a.font) || !fs.statSync(a.font).isFile()) {
    process.stderr.write(`no such font file: ${a.font}\n`);
    return 3;
  }
  for (const [label, v] of [
    ["--cap", a.cap], ["--eyelet-id", a.eyelet_id],
    ["--eyelet-wall", a.eyelet_wall], ["--min-thickness", a.min_thickness],
  ] as [string, number | null][]) {
    if (v !== null && !(v > 0 && !Number.isNaN(v) && Number.isFinite(v))) {
      process.stderr.write(`${label} must be a positive number, got ${pyG(v as number)}\n`);
      return 3;
    }
  }

  const names = String(a.names)
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n);
  if (!names.length) {
    process.stderr.write("--names left no usable name\n");
    return 3;
  }

  const { initSkia } = await import("./skia.ts");
  await initSkia();

  let b: Brief;
  try {
    b = brief(a.font, {
      cap: a.cap, unit: a.unit, basis: a.basis, names,
      targetId: a.eyelet_id, targetWall: a.eyelet_wall,
      minThickness: a.min_thickness, pairBudget: a.pair_budget,
      joinBudget: a.join_budget, thicknessSamples: a.samples,
    });
  } catch (exc) {
    process.stderr.write(`${(exc as Error).stack ?? excStr(exc)}\n`);
    process.stderr.write(`nameplate_brief failed: ${excStr(exc)}\n`);
    return 3;
  }

  const blob = dumpJson(b);
  if (a.json_path) fs.writeFileSync(a.json_path, blob, "utf8");
  if (a.md_path) fs.writeFileSync(a.md_path, markdown(b), "utf8");

  if (a.quiet || a.json_path || a.md_path) {
    process.stdout.write(
      `${b.font.file}: ${String(b.verdict).toUpperCase()} (${pyNum(b.seconds)}s)\n`,
    );
    if (!a.quiet) {
      process.stdout.write(`${b.targets_text ?? ""}\n`);
      for (const x of b.blocking ?? []) process.stdout.write(`BLOCKING: ${x}\n`);
    }
  } else {
    process.stdout.write(`${blob}\n`);
  }

  return { ready: 0, "needs work": 1, unusable: 2 }[b.verdict as string] ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}

/**
 * viewmodel.ts — everything the window shows, computed with no window.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT IN THE CLIENT
 *   `nameplate_gui.py` is a PySide6 window whose worker thread builds a result and
 *   whose widgets then format it into labels. Almost every assertion in that file's
 *   `--selftest` is about the RESULT and the LABEL TEXT — "ADAM — 4.069 × 1.020 in",
 *   "6 cut contours, 10 engrave lines", which overlays are on, what the eyelet table
 *   reads — and only two are about pixels the toolkit painted.
 *
 *   So the seam between "the app" and "the toolkit" sits exactly there. This module
 *   owns everything up to and including the strings; a front end renders them and
 *   draws the polylines. That keeps the part that has to match the Python testable
 *   with no browser, no canvas and no display, and it is why the label formats below
 *   are reproduced character for character rather than re-invented.
 *
 * COORDINATES
 *   Every path handed out is in DOC UNITS relative to the artwork's bottom-left
 *   corner, exactly as the Qt worker prepared them: `(x - x0) * scale`. A renderer
 *   only has to flip Y and scale to fit; it never needs the font, the em, or the
 *   bounding box.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Document, buildDocument } from "./core.ts";
import { Font } from "./font.ts";
import * as EY from "./eyelets.ts";
import * as FC from "./fontcheck.ts";
import * as LI from "./leadin.ts";
import * as TH from "./thickness.ts";
import { fmtF, fmtSigned } from "./pyformat.ts";
import type { Point } from "./skia.ts";

/** A polyline in doc units from the artwork's bottom-left. */
export type Path2D = Point[];

/** One font on disk, as the picker lists it. */
export interface FontEntry {
  path: string;
  filename: string;
  /** The font's own internal family name — what the picker actually shows. */
  family: string;
  /** Modified date, `YYYY-MM-DD HH:MM`, as the detail line prints it. */
  date_str: string;
}

/** What the automatic check found, as the detail line under the picker says it. */
export interface FontInfo {
  path: string;
  filename: string;
  family: string;
  has_colr: boolean;
  ok: boolean;
  error: string;
  n_errors: number;
  n_warnings: number;
  issues: string[];
  verdict: string;
  /** The whole detail line, assembled: "file · date · mark · verdict". */
  detail: string;
}

/** An overlay the preview draws on top of the artwork. */
export interface Overlay {
  /** Stable id a renderer can style on. */
  kind: "thin-target" | "eyelet-target-id" | "eyelet-target-od";
  /** Exactly the label the Python's selftest reads back. */
  label: string;
  rings: Path2D[];
}

/** One row of the eyelet table: actual, want, change — each already formatted. */
export interface EyeletRow {
  actual: string;
  want: string;
  change: string;
}

/** Everything one preview build produces. */
export interface BuildResult {
  text: string;
  width: number;
  height: number;
  unit: string;
  scale: number;
  n_cut: number;
  n_engrave: number;
  cut: Path2D[];
  engrave: Path2D[];
  leadins: Path2D[];
  pieces: number;
  gap_text: string;
  warnings: string[];
  thin_text: string;
  thin_spots: TH.ThinSpot[];
  eyelets: EY.Eyelet[];
  eyelet_rows: Record<string, EyeletRow>;
  /** Where the wall is thinnest, for the dimension line. */
  wall_at: Point | null;
  overlays: Overlay[];
  /** "ADAM — 4.069 × 1.020 in" */
  size_label: string;
  /** "6 cut contours, 10 engrave lines, 6 lead-ins  ·  thinnest ..." */
  count_label: string;
}

/** `YYYY-MM-DD HH:MM` from a file's mtime, as the detail line prints it. */
function dateStr(p: string): string {
  const d = fs.statSync(p).mtime;
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`
  );
}

/**
 * Every font in a folder, by the family name the picker shows.
 *
 * Sorted by family, because that is the order the picker lists them in and the
 * selftest reads the list back.
 */
export function listFonts(dir: string): FontEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: FontEntry[] = [];
  for (const name of files) {
    if (!/\.(ttf|otf|ttc)$/i.test(name)) continue;
    const p = path.join(dir, name);
    let family = name;
    try {
      family = new Font(p).family;
    } catch {
      // an unreadable font still belongs in the list — the detail line says why
    }
    out.push({ path: p, filename: name, family, date_str: dateStr(p) });
  }
  out.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  return out;
}

/**
 * Open a font and check it, the way selecting one in the picker does.
 *
 * The letter-pair scan is skipped here (it costs seconds); the "Check font" button
 * runs the full thing — so this passes a join-scan budget of 0, exactly as the
 * Python worker's `probe` does.
 */
export function probeFont(p: string): FontInfo {
  const filename = path.basename(p);
  let date = "";
  try {
    date = dateStr(p);
  } catch {
    date = "";
  }
  let font: Font;
  try {
    font = new Font(p);
  } catch (exc) {
    const e = exc as Error;
    return {
      path: p, filename, family: filename, has_colr: false, ok: false,
      error: `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}`,
      n_errors: 0, n_warnings: 0, issues: [], verdict: "",
      detail: `${filename} · ${date} · could not be read`,
    };
  }
  const info: FontInfo = {
    path: p, filename, family: font.family, has_colr: Boolean(font.colr?.size),
    ok: true, error: "", n_errors: 0, n_warnings: 0, issues: [], verdict: "",
    detail: "",
  };
  try {
    const rep = FC.checkFont(p, { joinScanBudget: 0.0 });
    info.n_errors = rep.errors.length;
    info.n_warnings = rep.warnings.length;
    info.issues = rep
      .sorted()
      .filter((fi) => fi.severity === FC.ERROR || fi.severity === FC.WARNING)
      .map((fi) => `[${fi.severity}] ${fi.title}`);
    info.verdict = rep.errors.length
      ? "cannot be used as it is"
      : rep.warnings.length
        ? `${rep.warnings.length} warning(s)`
        : "no problems found";
  } catch (exc) {
    info.verdict = `check failed: ${(exc as Error)?.constructor?.name ?? "Error"}`;
  }
  const mark = info.has_colr ? "carries engrave lines" : "cut only";
  info.detail = `${filename} · ${date} · ${mark} · ${info.verdict}`;
  return info;
}

/** What a preview build is asked for — one field per control in the window. */
export interface BuildRequest {
  font: Font;
  text: string;
  height: number;
  unit: string;
  basis: string;
  leadIn?: boolean;
  leadLen?: number;
  leadClear?: number;
  thin?: boolean;
  thinTarget?: number;
  eyeTargetId?: number;
  eyeTargetWall?: number;
  eyeDims?: boolean;
  eyeWant?: boolean;
}

/** Move a path into doc units relative to the artwork's bottom-left. */
function place(ring: Point[], x0: number, y0: number, s: number): Path2D {
  return ring.map(([x, y]) => [(x - x0) * s, (y - y0) * s] as Point);
}

/**
 * Build everything the preview shows, in one pass.
 *
 * Every expensive measurement is gated on something asking for it, exactly as the
 * Qt worker gates them: the thin-area scan only when the toggle is on, the eyelets
 * only when the dimension toggle is on or a target has been typed. Ungated, this is
 * far too slow to run on a keystroke.
 */
export function build(req: BuildRequest): BuildResult {
  const {
    font, text, height, unit, basis,
    leadIn = false, leadLen = 0, leadClear = 0,
    thin = false, thinTarget = 0,
    eyeTargetId = 0, eyeTargetWall = 0, eyeDims = false, eyeWant = true,
  } = req;

  const doc: Document = buildDocument(font, text, height, unit as any, basis as any);
  const s = doc.scale;
  const [x0, y0] = doc.bbox;

  const cut: Path2D[] = [];
  for (const rings of doc.cutPaths) for (const ring of rings) cut.push(place(ring, x0, y0, s));
  const engrave = doc.engravePaths.map((line) => place(line, x0, y0, s));

  let leadins: Path2D[] = [];
  if (leadIn) {
    leadins = LI.leadInLines(doc, leadLen || null, leadClear || null).map((line) =>
      place(line, x0, y0, s),
    );
  }

  // Does this name actually cut as ONE plate? If not, name the junction that broke —
  // that is the actionable part.
  let pieces = 1;
  let gapText = "";
  try {
    const { depths } = LI.analyse(LI.rings(doc));
    pieces = depths.filter((x) => x % 2 === 0).length;
    if (pieces > 1) {
      const g = FC.nameGaps(font, text);
      gapText = g.length
        ? FC.describeGaps(g, font.upem, doc.scale)
        : "could not localise the break";
    }
  } catch {
    /* the preview still draws; only the diagnosis is lost */
  }

  // ---- thin areas, and the "what it would look like" overlay ------------- //
  const overlays: Overlay[] = [];
  let thinSpots: TH.ThinSpot[] = [];
  let thinText = "";
  if (thin) {
    try {
      thinSpots = TH.findThinSpots(doc, null, TH.MAX_SAMPLES, 8, font);
      if (thinSpots.length) {
        const worst = thinSpots[0];
        thinText =
          `thinnest ${fmtF(worst.thickness, 4)} ${doc.unit} ` +
          `(${fmtF(worst.thickness_fu, 0)} font units) on ${worst.letter}, ${worst.where}`;
        if (thinTarget && thinTarget > worst.thickness) {
          const rings = TH.thickenPreview(doc, thinTarget, worst.thickness);
          // thickenPreview returns artwork-relative geometry already
          overlays.push({
            kind: "thin-target",
            label: "letters at target thickness",
            rings: rings.map((r) => r.map(([x, y]) => [x, y] as Point)),
          });
        }
      }
    } catch (exc) {
      thinText = `thin-area scan failed: ${(exc as Error)?.constructor?.name ?? "Error"}`;
    }
  }

  // ---- eyelets ---------------------------------------------------------- //
  // Measured only when the panel needs the numbers: the dimension toggle is on, or a
  // target has been typed. It costs ~150-220 ms, too much to spend on every keystroke
  // when nothing is asking for it.
  let eyelets: EY.Eyelet[] = [];
  let wallAt: Point | null = null;
  const rows: Record<string, EyeletRow> = {};
  if (eyeDims || eyeTargetId || eyeTargetWall) {
    try {
      eyelets = EY.measureEyelets(doc);
      if (eyelets.length) {
        const e = eyelets[0];
        wallAt = e.wall_min_at;
        const wall = EY.wallFromDiameters(e);
        const row = (actual: number, want: number): EyeletRow => ({
          actual: fmtF(actual, 4),
          want: want ? fmtF(want, 4) : "",
          change: want && actual ? `${fmtSigned((want / actual - 1.0) * 100.0, 2)}%` : "",
        });
        rows.id = row(e.inner_d, eyeTargetId);
        rows.od = row(e.outer_d, 0);
        rows.wall = row(wall, eyeTargetWall);
        rows.wall_min = row(e.wall_min, 0);
        if (eyeWant) {
          if (eyeTargetId) {
            overlays.push({
              kind: "eyelet-target-id",
              label: "eyelet at target inner diameter",
              rings: [circle(e.centre, eyeTargetId / 2)],
            });
          }
          if (eyeTargetWall) {
            overlays.push({
              kind: "eyelet-target-od",
              label: "eyelet at target outer diameter",
              rings: [circle(e.centre, (eyeTargetId || e.inner_d) / 2 + eyeTargetWall)],
            });
          }
        }
      }
    } catch {
      /* the preview is still worth showing without the eyelet numbers */
    }
  }

  const [w, h] = doc.size();
  const sizeLabel = `${doc.text} — ${fmtF(w, 3)} × ${fmtF(h, 3)} ${doc.unit}`;
  let countLabel =
    `${cut.length} cut contour${cut.length !== 1 ? "s" : ""}, ` +
    `${engrave.length} engrave line${engrave.length !== 1 ? "s" : ""}`;
  if (leadins.length) {
    countLabel += `, ${leadins.length} lead-in${leadins.length !== 1 ? "s" : ""}`;
  }
  if (thinText) countLabel += `  ·  ${thinText}`;

  return {
    text: doc.text, width: w, height: h, unit: doc.unit, scale: s,
    n_cut: cut.length, n_engrave: engrave.length,
    cut, engrave, leadins,
    pieces, gap_text: gapText,
    warnings: [...doc.warnings],
    thin_text: thinText, thin_spots: thinSpots,
    eyelets, eyelet_rows: rows, wall_at: wallAt,
    overlays,
    size_label: sizeLabel, count_label: countLabel,
  };
}

/** A closed circle as a polyline, for the target rings drawn over the preview. */
function circle(centre: Point, r: number, steps = 96): Path2D {
  const out: Path2D = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    out.push([centre[0] + Math.cos(t) * r, centre[1] + Math.sin(t) * r]);
  }
  return out;
}

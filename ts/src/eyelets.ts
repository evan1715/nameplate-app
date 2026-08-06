/**
 * eyelets.ts — measure the hanging eyelets on a finished nameplate.
 *
 *     inner diameter  ·  outer diameter  ·  wall thickness
 *
 * Measured from the ACTUAL artwork for the name and height you are about to cut,
 * not from the font in the abstract: the eyelet only exists as a contextual glyph
 * (A.eyeL, m.eyeR and friends), so it has to be measured after shaping.
 *
 * WHAT COUNTS AS AN EYELET
 *     A near-circular hole close to the left or right end of the artwork. Letter
 *     counters (the hole in an 'o') are round too, so candidates are ranked by how
 *     circular they are and how close to an end they sit, and the boss around them
 *     has to be round as well.
 *
 * HOW EACH NUMBER IS TAKEN
 *     inner diameter  twice the largest circle that fits inside the hole, which
 *                     for a round hole is exactly its diameter. Cross-checked
 *                     against the diameter implied by the hole's area; a big
 *                     disagreement means the hole is not truly round and is
 *                     reported rather than hidden.
 *     outer diameter  rays are cast from the hole's centre until they leave the
 *                     material. Where the eyelet merges into the letter a ray runs
 *                     on down the stroke, so those rays are outliers — the boss
 *                     radius is taken as the median of the shorter 60%, and the
 *                     spread is reported so you can see how round it really is.
 *     wall thickness  the shortest distance from the hole's edge to the outside
 *                     edge of the material. That minimum is the number that
 *                     decides whether the eyelet tears out, so it is given
 *                     alongside the median.
 */

import * as path from "node:path";
import { Document, ValueError, type Unit } from "./core.ts";
import * as G from "./geom.ts";
import * as LI from "./leadin.ts";
import { fmtF, fmtSigned, padLeft, padRight, pyG } from "./pyformat.ts";
import type { Point } from "./skia.ts";

/** 4·pi·A / P² ; a perfect circle is 1.0. */
export const CIRCULARITY_MIN = 0.72;
/** How far from square the hole's bounding box may be. */
export const ASPECT_TOL = 0.35;
/** "Near an end" = within this fraction of the artwork's width. */
export const END_FRACTION = 0.3;
/** Rays cast from the hole centre to find the boss radius. */
export const RAYS = 240;
/** Share of the shortest rays taken as the boss. */
export const BOSS_QUANTILE = 0.6;

/**
 * The boss-roundness gate this module's own docstring has always promised and
 * never had. A round hole is not enough: the counter of a 'b' or an 'o' near the
 * end of a name is round too, and without this the final letter's counter was
 * reported as a RIGHT EYELET, complete with paste-ready instructions to resize it.
 * Measured on the shipped Merriweather with the name 'Bob': the genuine left
 * eyelet's accepted ray radii spread 0.2% of the outer radius, the false 'b'
 * counter 34.8% -- two orders of magnitude apart, so the threshold is not
 * delicate. A real eyelet is a ring of roughly constant width around its hole; a
 * letter counter is not.
 */
export const BOSS_SPREAD_MAX = 0.3;

/** One measured eyelet. All lengths are in {@link Eyelet.unit}. */
export interface Eyelet {
  /** Which end of the artwork it sits at. */
  side: "left" | "right" | "middle";
  unit: Unit;
  /** Twice the largest circle that fits the hole. */
  inner_d: number;
  /** Median of the shorter 60% of rays out to the material's edge, doubled. */
  outer_d: number;
  /** Shortest hole-edge → outside-edge distance — the spot that tears out. */
  wall_min: number;
  /** Median hole-edge → outside-edge distance. */
  wall_median: number;
  /** Centre, in doc units, from the artwork's bottom-left. */
  centre: Point;
  /** 4·pi·A / P² for the hole. */
  circularity: number;
  /** The inner diameter the hole's AREA implies, as a cross-check. */
  inner_d_from_area: number;
  /** max − min of the accepted ray radii. */
  boss_spread: number;
  /** Anything worth saying about how round it really is. */
  note: string;
  /**
   * Where on the hole's edge the wall is thinnest, in doc units from the
   * artwork's bottom-left. null when the wall could not be walked. Used to put the
   * wall dimension on screen at the place that actually tears out.
   */
  wall_min_at: Point | null;
  /**
   * False when the material around the hole is not a ring of roughly even width —
   * i.e. this is probably a letter counter that happens to be round and near an
   * end. Suspect entries are left OUT of {@link measureEyelets}' result unless it
   * is asked for them, because every caller downstream (a UI table, the report,
   * the paste-ready prompt, the brief's judge) would otherwise be quoting a
   * letter's counter as an eyelet.
   */
  confident: boolean;
  /** `boss_spread / outer radius`. */
  boss_spread_ratio: number;
}

/** (outer − inner) / 2 — the average wall. */
export function wallFromDiameters(e: Eyelet): number {
  return (e.outer_d - e.inner_d) / 2;
}

/** 4·pi·A / P² for an area — 1.0 is a perfect circle. */
function circularity(poly: G.Geometry): number {
  try {
    const p = G.length(poly);
    return p > 0 ? (4 * Math.PI * G.area(poly)) / (p * p) : 0;
  } catch {
    return 0;
  }
}

/** The median, averaging the middle pair for an even count. */
function median(vals: number[]): number {
  const v = [...vals].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const n = v.length;
  return n % 2 ? v[Math.floor(n / 2)] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/**
 * Eyelets found in this document, left-most first. Empty if none look round.
 *
 * @param doc            the finished artwork
 * @param maxEyelets     how many candidates to keep (a name has at most two)
 * @param includeSuspect also return candidates that failed the boss-roundness
 *   gate, with `confident: false`, so a report can say "this looks like a letter
 *   counter" instead of silently showing one eyelet fewer
 */
export function measureEyelets(
  doc: Document,
  maxEyelets = 2,
  includeSuspect = false,
): Eyelet[] {
  const ringList = LI.rings(doc);
  if (ringList.length === 0) return [];
  const { polys, depths, material } = LI.analyse(ringList);
  if (G.isEmpty(material)) return [];

  const holes: { poly: G.Geometry; ring: Point[] }[] = [];
  const solids: G.Geometry[] = [];
  for (let i = 0; i < ringList.length; i++) {
    if (depths[i] % 2 === 1) holes.push({ poly: polys[i], ring: ringList[i] });
    else {
      let s = G.polygon(ringList[i]);
      if (!G.isValid(s)) s = G.buffer(s, 0);
      solids.push(s);
    }
  }
  if (holes.length === 0 || solids.length === 0) return [];

  const [x0, y0, x1, y1] = doc.bbox;
  const width = Math.max(x1 - x0, 1e-9);
  const s = doc.scale;

  // ---- pick the round holes that sit near an end -------------------------- //
  interface Cand {
    nearEnd: number;
    frac: number;
    poly: G.Geometry;
    circ: number;
  }
  const cands: Cand[] = [];
  for (const { poly } of holes) {
    try {
      const circ = circularity(poly);
      const b = G.bounds(poly);
      if (!b) continue;
      const [bx0, by0, bx1, by1] = b;
      const w = bx1 - bx0;
      const h = by1 - by0;
      if (w <= 0 || h <= 0) continue;
      const aspect = Math.abs(w - h) / Math.max(w, h);
      if (circ < CIRCULARITY_MIN || aspect > ASPECT_TOL) continue;
      const cx = (bx0 + bx1) / 2;
      const frac = (cx - x0) / width;
      const nearEnd = Math.min(frac, 1 - frac);
      if (nearEnd > END_FRACTION) continue;
      cands.push({ nearEnd, frac, poly, circ });
    } catch {
      continue;
    }
  }
  if (cands.length === 0) return [];

  // the most end-most, most circular first
  cands.sort((a, b) => a.nearEnd - b.nearEnd || b.circ - a.circ);
  const chosen = cands.slice(0, maxEyelets);
  chosen.sort((a, b) => a.frac - b.frac); // left to right

  const out: Eyelet[] = [];
  for (const { frac, poly, circ } of chosen) {
    try {
      const rIn = LI.inradius(poly);
      if (rIn <= 0) continue;
      // centre of the inscribed circle, approximated by the box centre of the
      // deepest inset that is still non-empty
      let c: Point;
      try {
        const core = G.buffer(poly, -rIn * 0.95);
        c = G.isEmpty(core) ? G.centroid(poly) : G.centroid(core);
      } catch {
        c = G.centroid(poly);
      }
      const [cx, cy] = c;

      const rArea = Math.sqrt(G.area(poly) / Math.PI);

      let host: G.Geometry | null = null;
      for (const sol of solids) {
        try {
          if (G.contains(sol, G.point(cx, cy))) {
            host = sol;
            break;
          }
        } catch {
          continue;
        }
      }
      if (host === null) continue;
      const hostEdge = G.exterior(host);

      // ---- outer radius by ray casting ----------------------------------- //
      const reach = Math.max(width, y1 - y0) * 2;
      const radii: number[] = [];
      for (let i = 0; i < RAYS; i++) {
        const th = (2 * Math.PI * i) / RAYS;
        const ray = G.lineString([
          [cx, cy],
          [cx + reach * Math.cos(th), cy + reach * Math.sin(th)],
        ]);
        let hit: G.Geometry;
        try {
          hit = G.intersection(hostEdge, ray);
        } catch {
          continue;
        }
        if (G.isEmpty(hit)) continue;
        let best: number | null = null;
        for (const g of G.geoms(hit)) {
          for (const coord of G.coords(g)) {
            const d = Math.hypot(coord[0] - cx, coord[1] - cy);
            if (d > rIn && (best === null || d < best)) best = d;
          }
        }
        if (best !== null) radii.push(best);
      }
      if (radii.length === 0) continue;
      radii.sort((a, b) => a - b);
      const keep = radii.slice(0, Math.max(3, Math.floor(radii.length * BOSS_QUANTILE)));
      const rOut = median(keep);
      const spread = keep.length ? keep[keep.length - 1] - keep[0] : 0;

      // ---- wall thickness straight off the geometry ----------------------- //
      // The point of the THINNEST wall is kept as well as its length: it is the
      // spot that tears out, so a caller drawing the wall on screen can put the
      // dimension exactly there instead of at some arbitrary angle that happens to
      // look tidy.
      const walls: number[] = [];
      let thinAt: { d: number; at: Point } | null = null;
      try {
        const ext = G.exterior(poly);
        const n = Math.max(24, Math.min(180, Math.floor((G.length(ext) / Math.max(rIn, 1e-9)) * 12)));
        for (let i = 0; i < n; i++) {
          const p = G.interpolateNormalized(ext, i / n);
          const d = G.distance(hostEdge, G.point(p[0], p[1]));
          walls.push(d);
          if (thinAt === null || d < thinAt.d) thinAt = { d, at: p };
        }
      } catch {
        // leave walls empty; the diameters still give an average
      }
      const wallMin = walls.length ? Math.min(...walls) : Math.max(rOut - rIn, 0);
      const wallMed = walls.length ? median(walls) : Math.max(rOut - rIn, 0);

      let note = "";
      if (Math.abs(rIn - rArea) / Math.max(rIn, 1e-9) > 0.12) {
        note =
          "the hole is not truly round, so the inner diameter depends on where you measure";
      } else if (spread > rOut * 0.25) {
        note = "the boss is not truly round, so the outer diameter is an average";
      }

      const side = frac < 0.33 ? "left" : frac > 0.67 ? "right" : "middle";
      // A ring of even width, or a letter's counter? The accepted ray radii of a
      // true eyelet barely vary; a counter's vary hugely because the "boss" is
      // really the letter's stroke going off in one direction.
      const ratio = rOut ? spread / rOut : 0;
      const confident = ratio <= BOSS_SPREAD_MAX;
      if (!confident) {
        note =
          (note ? note + "; " : "") +
          `the material around this hole is not a ring of even width ` +
          `(it varies by ${fmtF(ratio * 100, 0)}% of the radius), so this ` +
          `is probably a letter counter rather than an eyelet`;
      }
      out.push({
        side, unit: doc.unit,
        inner_d: 2 * rIn * s,
        outer_d: 2 * rOut * s,
        wall_min: wallMin * s,
        wall_median: wallMed * s,
        centre: [(cx - x0) * s, (cy - y0) * s],
        circularity: circ,
        inner_d_from_area: 2 * rArea * s,
        boss_spread: spread * s,
        note,
        confident,
        boss_spread_ratio: ratio,
        wall_min_at: thinAt
          ? [(thinAt.at[0] - x0) * s, (thinAt.at[1] - y0) * s]
          : null,
      });
    } catch {
      continue;
    }
  }
  return includeSuspect ? out : out.filter((e) => e.confident);
}

/**
 * What the FONT has to change by so the eyelet hits a target at a height.
 *
 * Because every measurement scales linearly with the height, a ratio measured at
 * one height is the same ratio in font units — so the font-unit targets below hold
 * at any height, not just the one measured.
 */
export interface Adjustment {
  unit: Unit;
  /** font units → unit. */
  scale: number;
  m_id: number;
  t_id: number;
  m_wall: number;
  t_wall: number;
  m_od: number;
  t_od: number;
}

const pct = (m: number, t: number): number => (m ? (t / m - 1) * 100 : NaN);
/** Percentage change asked of the inner diameter. */
export const idPct = (a: Adjustment): number => pct(a.m_id, a.t_id);
/** Percentage change asked of the wall. */
export const wallPct = (a: Adjustment): number => pct(a.m_wall, a.t_wall);
/** Percentage change asked of the outer diameter. */
export const odPct = (a: Adjustment): number => pct(a.m_od, a.t_od);
/** A physical size back in font units — what a font editor works in. */
export const fu = (a: Adjustment, v: number): number => (a.scale ? v / a.scale : NaN);

/**
 * null means 'keep the measured value'. Anything else must be a real size.
 *
 * A silent falsy check here made an explicit 0 vanish without a word, and a
 * negative target produced instructions like 'scale the hole to -73% of its
 * diameter' — nonsense that would be pasted straight to a font editor.
 *
 * @throws {ValueError} for a non-positive or non-finite target
 */
function validTarget(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) {
    throw new ValueError(
      `A target ${label} of ${JSON.stringify(value)} is not a usable size — give a ` +
        `positive number, or leave it unset to keep the measured value.`,
    );
  }
  return v;
}

/**
 * Compare a measured eyelet with the size you want at this height.
 *
 * Either target may be null, in which case the measured value is kept — so you can
 * ask for a new hole without touching the wall, or the reverse. Zero and negative
 * targets are refused with a message rather than ignored.
 */
export function adjustment(
  eyelet: Eyelet,
  doc: Document,
  targetId: number | null = null,
  targetWall: number | null = null,
): Adjustment {
  const tId0 = validTarget(targetId, "inner diameter");
  const tWall0 = validTarget(targetWall, "wall thickness");
  const mId = eyelet.inner_d;
  const mWall = wallFromDiameters(eyelet);
  const tId = tId0 ? tId0 : mId;
  const tWall = tWall0 ? tWall0 : mWall;
  return {
    unit: eyelet.unit, scale: doc.scale,
    m_id: mId, t_id: tId,
    m_wall: mWall, t_wall: tWall,
    m_od: mId + 2 * mWall, t_od: tId + 2 * tWall,
  };
}

/** The "to hit your target" block of the text report. */
function adjustLines(
  e: Eyelet,
  doc: Document,
  targetId: number | null,
  targetWall: number | null,
): string[] {
  const a = adjustment(e, doc, targetId, targetWall);
  const u = a.unit;
  const L = [
    `    TO HIT YOUR TARGET at this height`,
    `      ${padRight("", 16)} ${padLeft("now", 10)}  ${padLeft("want", 10)}  ` +
      `${padLeft("change", 9)}   ${padLeft("font units now -> want", 26)}`,
  ];
  const row = (label: string, m: number, t: number, p: number): string =>
    `      ${padRight(label, 16)} ${padLeft(fmtF(m, 4), 10)}  ${padLeft(fmtF(t, 4), 10)}  ` +
    `${padLeft(fmtSigned(p, 2), 8)}%   ${padLeft(fmtF(fu(a, m), 1), 11)} -> ` +
    `${padRight(fmtF(fu(a, t), 1), 11)}`;

  L.push(row("inner diameter", a.m_id, a.t_id, idPct(a)));
  L.push(row("wall thickness", a.m_wall, a.t_wall, wallPct(a)));
  L.push(row("outer diameter", a.m_od, a.t_od, odPct(a)));
  L.push(`      (sizes in ${u}; font units are what a font editor works in)`);
  L.push("");
  L.push(`      Instruction to hand over:`);
  L.push(
    `        Scale this eyelet's hole to ${fmtF(100 + idPct(a), 2)}% of its current diameter`,
  );
  L.push(
    `        and set the ring wall to ${fmtF(100 + wallPct(a), 2)}% of its current thickness.`,
  );
  L.push(
    `        In font units: hole ${fmtF(fu(a, a.t_id), 1)} across, wall ` +
      `${fmtF(fu(a, a.t_wall), 1)}, outer ${fmtF(fu(a, a.t_od), 1)}.`,
  );
  L.push(
    `        Those font-unit sizes give ${fmtF(a.t_id, 4)} ${u} inner and ` +
      `${fmtF(a.t_wall, 4)} ${u} wall whenever the name is set to ` +
      `${pyG(doc.targetHeight)} ${u} ${doc.basis} height.`,
  );
  L.push("");
  return L;
}

/** The measurements as text for a dialog or the console. */
export function reportText(
  doc: Document,
  eyelets: Eyelet[] | null = null,
  targetId: number | null = null,
  targetWall: number | null = null,
): string {
  let suspect: Eyelet[] = [];
  if (eyelets === null) {
    // ask for the rejects too, so a hole that ALMOST looked like an eyelet is
    // mentioned rather than leaving the reader wondering where it went
    const every = measureEyelets(doc, 2, true);
    eyelets = every.filter((e) => e.confident);
    suspect = every.filter((e) => !e.confident);
  }
  const u = doc.unit;
  const [w, h] = doc.size();
  const lines: string[] = [`${doc.text} — ${fmtF(w, 3)} x ${fmtF(h, 3)} ${u}`, ""];
  if (eyelets.length === 0) {
    lines.push(
      "No eyelet found.",
      "",
      "Nothing near either end of this artwork is a round hole. Either " +
        "this font has no eyelet, or the name does not use the eyelet " +
        "forms — those are contextual, so they usually appear only on the " +
        "first and last letter.",
    );
    return lines.join("\n");
  }

  for (const e of eyelets) {
    lines.push(`${e.side.toUpperCase()} EYELET`);
    lines.push(`    inner diameter   ${fmtF(e.inner_d, 4)} ${u}`);
    lines.push(`    outer diameter   ${fmtF(e.outer_d, 4)} ${u}`);
    lines.push(`    wall (OD-ID)/2   ${fmtF(wallFromDiameters(e), 4)} ${u}`);
    lines.push(
      `    wall, thinnest   ${fmtF(e.wall_min, 4)} ${u}   ` +
        `<- the number that decides if it tears out`,
    );
    lines.push(`    wall, typical    ${fmtF(e.wall_median, 4)} ${u}`);
    lines.push(
      `    centre           ${fmtF(e.centre[0], 3)}, ${fmtF(e.centre[1], 3)} ${u} ` +
        `from the bottom-left of the artwork`,
    );
    lines.push(
      `    roundness        ${fmtF(e.circularity, 3)} (1.000 is a perfect circle)`,
    );
    if (e.note) lines.push(`    note             ${e.note}`);
    lines.push("");
    // `!== null`, not truthiness: an explicit 0 is a mistake the user needs to
    // hear about, not a value to silently drop
    if (targetId !== null || targetWall !== null) {
      try {
        lines.push(...adjustLines(e, doc, targetId, targetWall));
      } catch (exc) {
        // a bad target must be SAID, never silently dropped
        lines.push(`    TARGET NOT USABLE: ${(exc as Error).message}`, "");
      }
    }
  }
  lines.push("Inner diameter is the largest circle that fits the hole.");
  lines.push(
    "Outer diameter is measured out to the edge of the material around it.",
  );
  lines.push(
    "Two wall figures are given because the boss is rarely perfectly " +
      "concentric: (OD-ID)/2 is the average wall, and 'thinnest' is the weakest point.",
  );
  if (suspect.length) {
    lines.push("");
    lines.push("NOT COUNTED AS EYELETS");
    for (const e of suspect) {
      lines.push(
        `    a round hole at the ${e.side} end, inner diameter ` +
          `${fmtF(e.inner_d, 4)} ${u}, was left out: the material around it ` +
          `varies by ${fmtF(e.boss_spread_ratio * 100, 0)}% of its radius, so ` +
          `it is a letter's counter rather than an eyelet. A real eyelet ` +
          `is a ring of roughly even width.`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * A paste-ready instruction for whoever edits the font, or "".
 *
 * Empty when there is nothing to ask for — no eyelet found, or no target typed.
 * The caller shows an empty box in that case rather than inventing a request,
 * because an eyelet that is already the right size needs no change.
 */
export function claudePrompt(
  doc: Document,
  eyelets: Eyelet[] | null = null,
  targetId: number | null = null,
  targetWall: number | null = null,
  fontPath: string | null = null,
): string {
  if (targetId === null && targetWall === null) return "";
  if (eyelets === null) eyelets = measureEyelets(doc);
  if (eyelets.length === 0) return "";
  try {
    validTarget(targetId, "inner diameter");
    validTarget(targetWall, "wall thickness");
  } catch (exc) {
    return `TARGET NOT USABLE: ${(exc as Error).message}`;
  }

  const u = doc.unit;
  const base = fontPath ? path.basename(fontPath) : "";
  const fam = doc.fontFamily || "";
  const who = fam && base ? `${fam} (${base})` : fam || base || "this font";
  const L: string[] = [
    `Edit the eyelet in the font ${who} so it comes out at the size below.`,
    "",
    `Measured from the name '${doc.text}' set to ${pyG(doc.targetHeight)} ${u} ` +
      `${basisWords(doc.basis)}.`,
    "",
  ];
  for (const e of eyelets) {
    let a: Adjustment;
    try {
      a = adjustment(e, doc, targetId, targetWall);
    } catch (exc) {
      L.push(`${e.side.toUpperCase()} EYELET: ${(exc as Error).message}`);
      continue;
    }
    L.push(`${e.side.toUpperCase()} EYELET`);
    L.push(
      `  inner diameter  ${fmtF(a.m_id, 4)} -> ${fmtF(a.t_id, 4)} ${u}` +
        `   (${fmtSigned(idPct(a), 2)}%)`,
    );
    L.push(
      `  wall thickness  ${fmtF(a.m_wall, 4)} -> ${fmtF(a.t_wall, 4)} ${u}` +
        `   (${fmtSigned(wallPct(a), 2)}%)`,
    );
    L.push(
      `  outer diameter  ${fmtF(a.m_od, 4)} -> ${fmtF(a.t_od, 4)} ${u}` +
        `   (${fmtSigned(odPct(a), 2)}%)`,
    );
    L.push(
      `  In FONT UNITS (what your editor works in, and what actually has to change):`,
    );
    L.push(`    hole diameter  ${fmtF(fu(a, a.m_id), 1)} -> ${fmtF(fu(a, a.t_id), 1)}`);
    L.push(`    wall           ${fmtF(fu(a, a.m_wall), 1)} -> ${fmtF(fu(a, a.t_wall), 1)}`);
    L.push(`    outer diameter ${fmtF(fu(a, a.m_od), 1)} -> ${fmtF(fu(a, a.t_od), 1)}`);
    L.push("");
  }
  L.push(
    "HOW TO MAKE THE CHANGE",
    "  Resize the eyelet hole and the ring around it to the font-unit sizes " +
      "above. Keep the eyelet concentric and keep its centre where it is, so " +
      "the letters do not move.",
    "  Do not change the cap height, the x-height, unitsPerEm, the advance " +
      "widths, or any letter outline. Do not add, delete or reorder glyphs - " +
      "this app addresses glyphs by ID.",
    "  The eyelet is a contextual form on the first and last letter, so " +
      "change it in EVERY glyph that carries one, or the two ends of a name " +
      "will no longer match.",
    "",
    "WHY FONT UNITS  Everything scales linearly with the height, so a " +
      "font-unit size holds at every cutting height - set it once and the " +
      `eyelet is right at ${pyG(doc.targetHeight)} ${u} and at any other height.`,
  );
  return L.join("\n");
}

/** "cap" → "cap height", for prose. */
function basisWords(basis: string): string {
  return (
    { cap: "cap height", xheight: "x-height", total: "total height" } as Record<string, string>
  )[basis] ?? basis;
}

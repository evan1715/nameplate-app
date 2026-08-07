/**
 * fontcheck.ts — say WHAT is wrong with a font, in words worth acting on.
 *
 *     node src/fontcheck.ts "path/to/font.ttf" [more fonts...]
 *
 *         --prompt          print a work order for whoever edits the font,
 *                           in font units, instead of the human report
 *         --no-join-scan    skip the letter-pair scan (the slow part)
 *         --budget=SECONDS  how long the letter-pair scan may take (default 25)
 *
 * The point is to replace "KeyError: 'gid131'" with a specific, named defect and
 * the edit that fixes it. Every check answers three questions:
 *
 *     what is wrong  ·  what it does to the artwork  ·  what to change in the font
 *
 * --prompt answers a fourth, for a different reader. The report tells Sean what is
 * wrong with his font; the prompt tells whoever edits the font which glyph to open,
 * by glyph ID, and how far to move what — in FONT UNITS, because that is the unit a
 * font editor works in, and every size stated in inches to someone working in font
 * units has come back wrong by a factor of the em.
 *
 * SEVERITY
 *     ERROR   the font cannot produce a usable cut file until this is fixed
 *     WARNING it will produce a file, but the file is probably not what you want
 *     NOTE    worth knowing; the app handles it
 *
 * Nothing here modifies a font. It only reports. Checks are individually guarded,
 * so a font broken badly enough to crash one check still gets all the others.
 *
 * PORTING NOTE
 *   The Python reaches for fontTools' parsed tables; this reads the few values it
 *   needs off the raw table bytes (Font.rawTable/postFormat/colrVersion), because
 *   the questions being asked are "is this table PRESENT" and "what version is it",
 *   and a parser that synthesises a default answers those wrongly.
 */

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Document, buildDocument } from "./core.ts";
import { DEFAULT_FEATURES, Font, shape } from "./font.ts";
import * as G from "./geom.ts";
import * as LI from "./leadin.ts";
import { fmtF, pyFloat, wrapText } from "./pyformat.ts";
import { PathOp, type Point, type SkPathData, flatten, op } from "./skia.ts";

export const ERROR = "ERROR";
export const WARNING = "WARNING";
export const NOTE = "NOTE";
const RANK: Record<string, number> = { ERROR: 0, WARNING: 1, NOTE: 2 };

/** characters a nameplate shop actually types */
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const EXTRAS = " '-.";

/** What one glyph IS, in the terms a font editor searches by. */
export interface GlyphRole {
  glyph: string;
  gid: number | null;
  char: string;
  codepoint: number | null;
  base: string | null;
  base_gid: number | null;
  alternate: boolean;
}

/** One junction that leaves a gap, measured in both glyphs' own coordinates. */
export interface Junction {
  example: string;
  gap_units: number;
  margin_units: number;
  need_units: number;
  left: GlyphRole;
  right: GlyphRole;
  left_from: Point;
  left_contact: Point;
  left_target: Point;
  right_from: Point;
  right_contact: Point;
  right_target: Point;
}

/** The measurements behind one defect, kept so it can be restated as an order. */
export interface FindingData {
  [key: string]: unknown;
  junctions?: Junction[];
  extra?: [string, string][];
  holes?: { radius_units: number; radius_in: number; between: HoleWall[] }[];
  glyphs?: unknown[];
}

/** Which glyphs form the walls of a hole, and where the hole sits inside each. */
export interface HoleWall {
  glyph: string;
  gid: number | null;
  char: string;
  at: Point;
}

/** One defect: what is wrong, what it does, and what to change. */
export class Finding {
  severity: string;
  code: string;
  title: string;
  detail: string;
  fix: string;
  /**
   * The measurements behind the prose. Kept so the same defect can be restated as
   * an instruction to whoever edits the font without measuring it again. Plain
   * numbers and strings only — never a font or a polygon — so a Finding still
   * renders long after the font it came from was closed.
   */
  data: FindingData;

  constructor(
    severity: string,
    code: string,
    title: string,
    detail: string,
    fix: string,
    data: FindingData = {},
  ) {
    this.severity = severity;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.fix = fix;
    this.data = data;
  }

  /**
   * This one defect as an order a font editor can carry out.
   *
   * Deliberately not the same text as `.fix`. `.fix` tells Sean what is wrong with
   * his font; this tells whoever edits the font which glyph to open and how far to
   * move what, in font units. The GUI offers it per row so Sean can hand over one
   * defect at a time, so it has to stand on its own.
   *
   * `upem` is required because every number here is a font-unit number and a reader
   * cannot judge one without knowing the em. `scale` (font units to inches) is
   * optional: with it each size is also given in inches.
   */
  instruction(upem: number, scale: number | null = null): string {
    try {
      return instructionFor(this, Math.trunc(upem || 0), scale);
    } catch {
      // a prompt that admits it could not measure something is still usable; a
      // traceback in the middle of Sean's clipboard is not. Flattened through
      // plain() like every other prompt line — the title/detail/fix carry
      // typographic dashes, and the ASCII-only contract applies to the fallback.
      return plain(
        `${this.title}. ${this.detail} ${this.fix} ` +
          `(this defect could not be restated in font units - ` +
          `measure it in the font editor before changing anything.)`,
      );
    }
  }
}

// --------------------------------------------------------------------------- //
//  letter joins — WHERE a name breaks apart, not just that it does
// --------------------------------------------------------------------------- //

/**
 * `font.filled()` memoised per glyph.
 *
 * `Font.contours()` is cached in the engine and `filled()` is cached there too, but
 * a letter-join scan asks for the same few hundred glyphs thousands of times across
 * several fonts, so the wrapper is kept for parity with the Python and to give this
 * module one place to swallow a bad glyph.
 */
export function filledCached(font: Font, gid: number): G.Geometry | null {
  try {
    return font.filled(gid);
  } catch {
    return null;
  }
}

/** One shaped glyph, placed, with everything an instruction might need. */
export interface PlacedArea {
  /** Index in the shaped run. */
  i: number;
  /**
   * The character that produced this glyph, or "" when it cannot be known.
   *
   * Only filled in when shaping produced exactly one glyph per character. A ligature
   * makes that mapping ambiguous, and a guess about which letter a glyph came from is
   * worse than saying nothing.
   */
  ch: string;
  /** Glyph name. */
  glyph: string;
  /** Glyph id, for callers that address geometry rather than text. */
  gid: number;
  /** Pen x, font units. */
  x: number;
  /** Pen y, font units. */
  y: number;
  /** The glyph's filled area, moved to its pen position. */
  poly: G.Geometry;
}

/**
 * Every shaped glyph with ink, placed at its pen position.
 *
 * Everything {@link glyphAreas} has, plus the two things an instruction needs and a
 * gap measurement does not: the pen position, so a point in the word can be put back
 * into the glyph's own coordinate system, and the character that produced the glyph,
 * so an alternate can be told from the default form.
 */
export function placedAreas(font: Font, text: string): PlacedArea[] {
  const placed = shape(font, text);
  const chars = Array.from(text);
  const oneToOne = placed.length === chars.length;
  const out: PlacedArea[] = [];
  placed.forEach((p, i) => {
    const g = filledCached(font, p.glyph);
    if (g === null || G.isEmpty(g)) return;
    out.push({
      i,
      ch: oneToOne ? chars[i] : "",
      glyph: font.glyphName(p.glyph),
      gid: p.glyph,
      x: p.x,
      y: p.y,
      poly: G.translate(g, p.x, p.y),
    });
  });
  return out;
}

/**
 * (glyph name, filled polygon at its shaped position) per glyph.
 *
 * Shaping first matters: a script font picks contextual forms, so 'g' before 'o' may
 * be a different glyph than 'g' on its own, with a different exit stroke. Testing raw
 * letters would test shapes the font never uses.
 */
export function glyphAreas(font: Font, text: string): [string, G.Geometry][] {
  return placedAreas(font, text).map((a) => [a.glyph, a.poly]);
}

/**
 * Consecutive glyphs whose ink does not touch.
 *
 * Returns [left glyph, right glyph, gap in font units]. A gap here is why a name
 * cuts as loose pieces instead of one plate.
 */
export function nameGaps(font: Font, text: string): [string, string, number][] {
  const areas = glyphAreas(font, text);
  const gaps: [string, string, number][] = [];
  for (let i = 0; i + 1 < areas.length; i++) {
    const [n1, a] = areas[i];
    const [n2, b] = areas[i + 1];
    try {
      if (!G.intersects(a, b)) gaps.push([n1, n2, G.distance(a, b)]);
    } catch {
      continue;
    }
  }
  return gaps;
}

/** `'g -> o (0.031 in)'` style summary, trimmed to something readable. */
export function describeGaps(
  gaps: [string, string, number][],
  upem: number,
  scale: number | null = null,
): string {
  const bits: string[] = [];
  for (const [n1, n2, d] of gaps.slice(0, 8)) {
    bits.push(
      scale ? `${n1}→${n2} (${fmtF(d * scale, 3)} in)` : `${n1}→${n2} (${fmtF(d / upem, 3)} em)`,
    );
  }
  if (gaps.length > 8) bits.push(`and ${gaps.length - 8} more`);
  return bits.join(", ");
}

// --------------------------------------------------------------------------- //
//  naming a defect precisely enough to edit — glyph identity and geometry
// --------------------------------------------------------------------------- //
export const KERF_IN = 0.004; // the laser's own floor; see nameplate_leadin
export const OVERLAP_EM = 0.015; // how much of the em a joint must really share

/**
 * Glyph ID for a glyph name, or null.
 *
 * The ID matters more than the name. A font with a post format 3.0 table carries no
 * glyph names at all, so the names in this report are placeholders the parser
 * invented (glyph00174) and the number in them is the only handle that means the
 * same thing in every tool.
 */
function gidOf(font: Font, glyph: string | null | undefined): number | null {
  if (!glyph) return null;
  const g = font.gidForName(glyph);
  return g === undefined ? null : g;
}

/**
 * glyph name -> the code point that reaches it, for directly encoded glyphs.
 *
 * Cached on the Font, like filledCached, because a prompt asks for it once per
 * junction and building it walks the whole cmap.
 */
const REV_CACHE = new WeakMap<Font, Map<string, number>>();
function reverseCmap(font: Font): Map<string, number> {
  let cache = REV_CACHE.get(font);
  if (cache) return cache;
  cache = new Map();
  try {
    for (const [cp, gid] of font.cmap) {
      const name = font.glyphName(gid);
      if (!cache.has(name)) cache.set(name, cp);
    }
  } catch {
    /* a broken cmap costs the codepoints, not the report */
  }
  REV_CACHE.set(font, cache);
  return cache;
}

/** The glyph name a character maps to through the cmap, or null. */
function cmapName(font: Font, ch: string): string | null {
  if (!ch) return null;
  const gid = font.cmap.get(ch.codePointAt(0) as number);
  return gid === undefined ? null : font.glyphName(gid);
}

/**
 * What one glyph IS, in the terms a font editor searches by.
 *
 * The important field is `alternate`. A script font substitutes contextual forms, so
 * the 'o' in 'ego' can be a different glyph from the 'o' the cmap points at. Editing
 * the one the cmap points at changes a glyph that was never the problem and leaves
 * the defect exactly where it was — which is the failure this whole module exists to
 * stop.
 */
function glyphRole(
  font: Font,
  glyph: string,
  ch: string,
  rev: Map<string, number> | null = null,
): GlyphRole {
  const r = rev ?? reverseCmap(font);
  let base: string | null = null;
  try {
    base = ch ? cmapName(font, ch) : null;
  } catch {
    base = null;
  }
  const cp = r.get(glyph);
  return {
    glyph,
    gid: gidOf(font, glyph),
    char: ch,
    codepoint: cp === undefined ? null : cp,
    base,
    base_gid: base ? gidOf(font, base) : null,
    alternate: Boolean(base && base !== glyph),
  };
}

/**
 * Font units a stroke must reach PAST first contact for the joint to hold.
 *
 * A tangent touch is not a joint. The cut path is the union of the letters, and two
 * shapes that only kiss union into a pinch of no width, which the laser reads as a
 * break — that is why "they must genuinely cross" keeps appearing in this file. 1.5%
 * of the em is a real bite out of a script stroke, and it is also kept to at least
 * four kerf widths at the size being checked, so the overlap stays wider than the
 * beam rather than wider than nothing.
 */
export function overlapMargin(upem: number, scale: number | null = null): number {
  const em = Math.trunc(upem || 1000) || 1000;
  let margin = Math.max(1.0, pyRound(OVERLAP_EM * em));
  try {
    if (scale) margin = Math.max(margin, (4.0 * KERF_IN) / scale);
  } catch {
    /* a missing scale just leaves the em-derived floor */
  }
  return Math.trunc(pyRound(margin));
}

/**
 * One entry per place in `text` where consecutive letters do not touch.
 *
 * The gap alone does not tell an editor what to do. This adds the two glyphs by ID,
 * whether each is a contextual alternate or the default form of its letter, and where
 * the nearest ink actually is — expressed in the LEFT glyph's own coordinate system,
 * because the left glyph is the one being extended and an editor works in the glyph's
 * space, not the word's.
 */
export function junctionDetails(
  font: Font,
  text: string,
  scale: number | null = null,
  limit = 12,
): Junction[] {
  const upem = Math.trunc(font.upem || 0) || 1000;
  const margin = overlapMargin(upem, scale);
  const rev = reverseCmap(font);
  const areas = placedAreas(font, text);
  const out: Junction[] = [];
  for (let i = 0; i + 1 < areas.length; i++) {
    if (out.length >= limit) break;
    const A = areas[i];
    const B = areas[i + 1];
    let gap: number;
    let pa: Point;
    let pb: Point;
    try {
      if (G.intersects(A.poly, B.poly)) continue;
      gap = G.distance(A.poly, B.poly);
      const np = G.nearestPoints(A.poly, B.poly);
      if (!np) continue;
      [pa, pb] = np;
    } catch {
      continue;
    }

    // the same two points, once in each glyph's own coordinates
    const lx = pa[0] - A.x;
    const ly = pa[1] - A.y; // left glyph's exit ink
    const rx = pb[0] - A.x;
    const ry = pb[1] - A.y; // where it has to reach to
    const dx = rx - lx;
    const dy = ry - ly;
    const span = Math.hypot(dx, dy) || 1.0;
    const ux = dx / span;
    const uy = dy / span;
    out.push({
      example: text,
      gap_units: gap,
      margin_units: margin,
      need_units: gap + margin,
      left: glyphRole(font, A.glyph, A.ch, rev),
      right: glyphRole(font, B.glyph, B.ch, rev),
      // in the LEFT glyph's coordinates: ink now, contact point, and the point the
      // stroke has to pass to leave a real overlap
      left_from: [lx, ly],
      left_contact: [rx, ry],
      left_target: [rx + ux * margin, ry + uy * margin],
      // the same again for the RIGHT glyph, for when its entry stroke is the
      // narrower thing to change
      right_from: [pb[0] - B.x, pb[1] - B.y],
      right_contact: [pa[0] - B.x, pa[1] - B.y],
      right_target: [pa[0] - B.x - ux * margin, pa[1] - B.y - uy * margin],
    });
  }
  return out;
}

export const JUNCTION_DETAIL = 10; // how many junctions get coordinates, not a list

/**
 * Measure the junctions a join scan named, properly.
 *
 * `joinScan` keeps only the pair and one example string, because measuring 7000
 * combinations to this depth would cost minutes. The handful that actually failed are
 * worth the coordinates, and re-shaping ten short strings against the caches costs
 * nothing.
 */
function junctionsFor(
  font: Font,
  items: [string, string][],
  scale: number | null = null,
): Junction[] {
  const out: Junction[] = [];
  for (const [junction, example] of items) {
    try {
      for (const j of junctionDetails(font, example, scale)) {
        if (`${j.left.glyph}→${j.right.glyph}` === junction) {
          out.push(j);
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Which glyphs form the walls of a hole in a built name, and where.
 *
 * A sliver hole is not a defect in one glyph, it is a defect in a meeting of two, so
 * naming both is the difference between an actionable instruction and "something is
 * too small somewhere". The hole's position is also given inside each named glyph's
 * own coordinates, because that is where it can be found.
 */
function holeNeighbours(
  font: Font,
  text: string,
  hole: G.Geometry,
  tol = 1.0,
  limit = 3,
): HoleWall[] {
  const out: HoleWall[] = [];
  try {
    const c = G.centroid(hole);
    for (const a of placedAreas(font, text)) {
      if (out.length >= limit) break;
      try {
        if (G.distance(a.poly, hole) > tol) continue;
      } catch {
        continue;
      }
      out.push({
        glyph: a.glyph,
        gid: gidOf(font, a.glyph),
        char: a.ch,
        at: [c[0] - a.x, c[1] - a.y],
      });
    }
  } catch {
    /* an unmeasurable hole is still reported, just without its walls named */
  }
  return out;
}

/**
 * Glyphs whose counters are wound the wrong way, so they cut SOLID.
 *
 * The app measures with a PARITY fill model (`Font.filled`: a ring nested inside an
 * odd number of others is a hole, whatever direction it was drawn) but it CUTS with
 * skia's winding union, exactly as `buildDocument` does. The two agree only while the
 * counters run opposite to their outer contour.
 *
 * Rewind a counter to match its outer and the two models part company: skia cancels
 * the counter and emits ONE contour, so the letter lasers as a solid blob, while
 * parity still reports a hole and every existing check passes. The report even says
 * "0 junctions disconnected" — the defect is invisible because nothing else compares
 * the cut's own fill rule against the model's.
 *
 * So this compares them directly, per glyph, and reports where they disagree.
 */
export function windingCheck(
  font: Font,
  glyphs: string[] | null = null,
): { glyph: string; parity_holes: number; cut_holes: number; lost: number }[] {
  const out: { glyph: string; parity_holes: number; cut_holes: number; lost: number }[] = [];
  let names: string[];
  if (glyphs === null) {
    const seen = new Set<string>();
    names = [];
    for (const ch of LETTERS) {
      const g = cmapName(font, ch);
      if (g && !seen.has(g)) {
        seen.add(g);
        names.push(g);
      }
    }
    // the contextual forms too: a defect in A.ini never shows up in 'A'
    try {
      for (const ch of LETTERS.slice(0, 26)) {
        for (const p of shape(font, ch + "a" + ch.toLowerCase())) {
          const n = font.glyphName(p.glyph);
          if (!seen.has(n)) {
            seen.add(n);
            names.push(n);
          }
        }
      }
    } catch {
      /* a font that will not shape still gets the cmap glyphs checked */
    }
  } else {
    names = glyphs;
  }

  /** How many of these rings sit at odd nesting depth — the parity hole count. */
  const holesByParity = (rings: G.Geometry[]): number => {
    let holes = 0;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const rp = G.representativePoint(r);
      let depth = 0;
      for (let j = 0; j < rings.length; j++) {
        if (j === i) continue;
        const q = rings[j];
        if (G.area(q) > G.area(r) && G.contains(G.buffer(q, 0), G.point(rp[0], rp[1]))) depth++;
      }
      if (depth % 2) holes++;
    }
    return holes;
  };

  for (const gname of names) {
    try {
      const gid = font.gidForName(gname);
      if (gid === undefined) continue;
      const rings = font
        .contours(gid)
        .map((c) => G.polygon(c))
        .filter((p) => G.area(p) > 0);
      if (rings.length < 2) continue; // no counter, nothing to wind wrongly
      const parityHoles = holesByParity(rings);
      if (!parityHoles) continue;
      // WINDING: what the cut actually produces, the same call buildDocument makes
      const union = op({ verbs: [], pts: [] } as SkPathData, font.outline(gid), PathOp.UNION);
      const cutRings = flatten(union)
        .map((c) => G.polygon(c))
        .filter((p) => G.area(p) > 0);
      const cutHoles = holesByParity(cutRings);
      if (cutHoles < parityHoles) {
        out.push({
          glyph: gname,
          parity_holes: parityHoles,
          cut_holes: cutHoles,
          lost: parityHoles - cutHoles,
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

export const CONTEXTS = "eaonrglstc"; // common preceding letters, for contextual forms

/**
 * Which letter combinations leave a gap between neighbouring letters.
 *
 * Two phases, because a script font substitutes contextual forms: a pair can join
 * perfectly on its own and still break inside a word. In the font that prompted this,
 * 'go' connects but 'ego' does not — the 'o' after 'eg' is a different glyph with a
 * different entry stroke. So phase 1 tests every plain pair, and phase 2 re-tests
 * those pairs behind a leading letter.
 *
 * Bounded by a wall-clock budget; whatever was not reached is reported as untested
 * rather than quietly passed. The definitive check is still the name you actually
 * type — the preview reports the junction for that name.
 */
export function joinScan(
  font: Font,
  budgetS = 25.0,
  contexts: string = CONTEXTS,
): { failures: Map<string, string>; tested: number; truncated: boolean; total: number } {
  const low = "abcdefghijklmnopqrstuvwxyz";
  const upp = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const inCmap = (c: string) => font.cmap.has(c.codePointAt(0) as number);
  const have = [...low].filter(inCmap);
  const caps = [...upp].filter(inCmap);

  const combos: string[] = [];
  for (const a of have) for (const b of have) combos.push(a + b);
  for (const c of contexts) {
    if (!inCmap(c)) continue;
    for (const a of have) for (const b of have) combos.push(c + a + b);
  }

  // Phase 3 and 4: the junction types most real names are actually made of, which
  // the two phases above never shape.
  //
  // A two-letter string tests initial->FINAL forms. A trigram behind one of ten
  // context letters tests initial->medial->final for those ten. What is missing is a
  // MEDIAL->MEDIAL junction — the interior of any name of four letters or more — and
  // a Capital-initial->medial junction, which is what every Name-cased name starts
  // with.
  //
  // This is not theoretical. On Cervanttis-ExtraBoldEyelet the two phases above
  // report a scan of 7,436 combinations and 'Daniel' still cuts into 3 loose pieces;
  // 'Bjorn' likewise. Wrapping the pair so both letters take medial forms finds those
  // junctions, and a Capital + medial template finds the one 'Bjorn' breaks at. On
  // the shipped TGCarrieSOFlourish it finds Dleftring->d, which no other phase looks
  // at.
  //
  // 'a' is the wrapper because it is the commonest letter with both an entry and an
  // exit stroke in these faces; if the font has no 'a' the phase is skipped rather
  // than guessed at.
  if (have.includes("a")) {
    for (const x of have) for (const y of have) combos.push("a" + x + y + "a");
    for (const C of caps) for (const x of have) combos.push(C + x + "a");
  }

  const end = nowSeconds() + budgetS;
  const failures = new Map<string, string>();
  let tested = 0;
  let truncated = false;
  for (const text of combos) {
    if (nowSeconds() > end) {
      truncated = true;
      break;
    }
    tested += 1;
    try {
      for (const [n1, n2] of nameGaps(font, text)) {
        const key = `${n1}→${n2}`;
        if (!failures.has(key)) failures.set(key, text);
      }
    } catch {
      continue;
    }
  }
  return { failures, tested, truncated, total: combos.length };
}

/** `time.perf_counter()`. */
function nowSeconds(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** The whole verdict on one font. */
export class Report {
  path: string;
  family = "";
  findings: Finding[] = [];
  facts: string[] = [];
  /**
   * What the numbers in the findings are relative to. `upem` is the em size; `scale`
   * converts font units to inches at the size the font was checked at, and is null
   * when no name could be built to measure it.
   */
  upem = 0;
  scale: number | null = null;
  meta: Record<string, unknown> = {};

  constructor(path: string) {
    this.path = path;
  }

  add(
    severity: string,
    code: string,
    title: string,
    detail: string,
    fix: string,
    data: FindingData | null = null,
  ): void {
    this.findings.push(new Finding(severity, code, title, detail, fix, data ?? {}));
  }

  get errors(): Finding[] {
    return this.findings.filter((f) => f.severity === ERROR);
  }

  get warnings(): Finding[] {
    return this.findings.filter((f) => f.severity === WARNING);
  }

  get usable(): boolean {
    return this.errors.length === 0;
  }

  /** Findings worst-first. A stable sort, so equal severities keep insertion order. */
  sorted(): Finding[] {
    return this.findings
      .map((f, i) => [f, i] as [Finding, number])
      .sort((a, b) => RANK[a[0].severity] - RANK[b[0].severity] || a[1] - b[1])
      .map(([f]) => f);
  }

  text(): string {
    const out: string[] = [basename(this.path)];
    if (this.family) out.push(`  ${this.family}`);
    out.push("");
    if (this.findings.length === 0) {
      out.push("No problems found. This font should work.");
    } else {
      out.push(
        this.errors.length
          ? "CANNOT BE USED until the ERROR items are fixed"
          : "Usable, but check the warnings below",
      );
      out.push("");
      for (const f of this.sorted()) {
        out.push(`[${f.severity}] ${f.title}`);
        out.push(`    what:  ${f.detail}`);
        out.push(`    fix:   ${f.fix}`);
        out.push("");
      }
    }
    if (this.facts.length) {
      out.push("Font facts:");
      for (const x of this.facts) out.push(`  ${x}`);
    }
    return out.join("\n");
  }

  /**
   * Every defect as a work order Sean can paste into a font-editing AI.
   *
   * `.text()` is written for Sean: what is wrong and roughly what to change. This is
   * written for the editor: which glyph, by ID, moved how far, in font units, and an
   * explicit list of what must not be touched — because the failure mode being
   * designed out is not "the AI did nothing", it is "the AI fixed the wrong glyph and
   * improved three others on the way".
   *
   * Plain text, no markdown, ASCII only: it gets pasted into a chat box.
   */
  claudePrompt(): string {
    return buildPrompt(this);
  }
}

// --------------------------------------------------------------------------- //
//  saying it to the editor — one defect, one glyph, one number
// --------------------------------------------------------------------------- //
/**
 * Notes that describe the font rather than ask for a change. They belong in the
 * prompt as background, never in the numbered list: an AI handed "this font is
 * cut-only" as a task will helpfully add a colour table nobody asked for.
 */
export const CONTEXT_CODES = new Set([
  "no-glyph-names", "cut-only", "engine-note", "analysis-failed",
  "join-scan-partial", "join-scan-failed", "no-xheight",
]);

const ASCII_MAP: [string, string][] = [
  ["→", "->"], ["—", " - "], ["–", "-"], ["‘", "'"],
  ["’", "'"], ["“", '"'], ["”", '"'], ["·", "-"],
  ["…", "..."], ["×", "x"], [" ", " "],
];

/**
 * The human report's typography flattened to ASCII.
 *
 * Applied only to prose quoted back out of a Finding, never to a family name or a
 * glyph name — those have to be reproduced exactly, and a '?' in place of a letter of
 * the family name would be an instruction to rename the font.
 */
export function plain(s: unknown): string {
  let out = String(s);
  for (const [k, v] of ASCII_MAP) out = out.split(k).join(v);
  return out;
}

/**
 * `'...-v19.ttf'` -> `'...-v20.ttf'`.
 *
 * Sean versions every export. A repaired font that comes back under the name it left
 * with is a font he cannot tell from the broken one, and the broken one is already
 * installed.
 */
function nextFilename(path: string): string {
  try {
    const base = basename(path);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    const m = /v(\d+)$/i.exec(stem);
    if (m) return `${stem.slice(0, m.index + 1)}${Number(m[1]) + 1}${ext}`;
    return `${stem}-fixed${ext}`;
  } catch {
    return "";
  }
}

/** Python's `round()` — half away from zero is WRONG here; it is half to even. */
function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * A font-unit number. Font units are whole numbers in a real font, so printing
 * 23.0000001 of them only invites someone to type it in.
 */
function n(v: unknown): string {
  const x = Number(v);
  if (!Number.isFinite(x)) return String(v);
  return Math.abs(x - pyRound(x)) < 0.05 ? fmtF(x, 0) : fmtF(x, 1);
}

function inch(v: unknown): string {
  const x = Number(v);
  if (!Number.isFinite(x)) return "? in";
  return Math.abs(x) < 0.01 ? `${fmtF(x, 4)} in` : `${fmtF(x, 3)} in`;
}

/**
 * One size, said twice on purpose.
 *
 * Font units are the instruction; the physical figure is there so the reader can
 * smell a factor-of-700 mistake before making it.
 */
function size(units: unknown, upem: number, scale: number | null = null): string {
  const x = Number(units);
  if (!Number.isFinite(x)) return `${n(units)} font units`;
  if (scale) return `${n(x)} font units (${inch(x * scale)})`;
  return `${n(x)} font units (${fmtF(x / (upem || 1000), 3)} em)`;
}

function pt(p: unknown): string {
  const a = p as [number, number] | undefined;
  if (!a || a.length < 2) return "(?, ?)";
  return `(${n(a[0])}, ${n(a[1])})`;
}

/**
 * Wrapped prose. 73 columns because a numbered item gets three more when it is placed
 * in the list, and a chat box that soft-wraps a work order makes the coordinates in
 * it hard to read back.
 */
function para(text: unknown, indent = "", first: string | null = null, width = 73): string {
  const body = String(text).split(/\s+/).filter(Boolean).join(" ");
  if (!body) return "";
  return wrapText(body, width, first === null ? indent : first, indent).join("\n");
}

/**
 * A glyph as `name (glyph ID n)`. Never the name on its own — in a post 3.0 font the
 * name is a placeholder and the ID is the only real handle.
 */
function named(role: Partial<GlyphRole>): string {
  const g = role.glyph || "?";
  const gid = role.gid;
  return gid !== null && gid !== undefined ? `${g} (glyph ID ${gid})` : `${g} (glyph ID unknown)`;
}

function roleText(role: Partial<GlyphRole>, example = ""): string {
  const bits = [named(role)];
  const ch = (role.char || "").trim();
  if (ch) {
    bits.push(`the form this font uses for '${ch}'` + (example ? ` in "${example}"` : ""));
  }
  const cp = role.codepoint;
  if (cp !== null && cp !== undefined) {
    bits.push(`encoded at U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return bits.join(", ");
}

/**
 * Junctions that are one and the same edit, collapsed into one.
 *
 * 'tb', 'tba', 'tt' and 'tta' are four reports of a single fact: the exit stroke of
 * glyph00176 stops short. Listed separately they invite four separate edits to the
 * same stroke, and four 30-unit extensions of one stroke is a 120-unit extension.
 * Grouping on the glyph AND the point its ink stops at is what makes "do this once"
 * sayable.
 */
function groupJunctions(junctions: Junction[]): Junction[][] {
  const groups: Junction[][] = [];
  const seen = new Map<string, Junction[]>();
  junctions.forEach((j, idx) => {
    let key: string;
    try {
      const p = j.left_from ?? [0, 0];
      key = `${j.left?.glyph} ${pyRound(p[0])} ${pyRound(p[1])}`;
    } catch {
      key = `#${idx}`;
    }
    const hit = seen.get(key);
    if (hit) {
      hit.push(j);
    } else {
      const fresh = [j];
      seen.set(key, fresh);
      groups.push(fresh);
    }
  });
  return groups;
}

/**
 * One stroke that stops short, as an edit with coordinates.
 *
 * The coordinates are the whole point. "Extend the exit stroke" is what the human
 * report already says and it is not enough — it does not say which stroke, in which
 * glyph, or how far, so the edit lands somewhere plausible instead of somewhere
 * correct. Every point here is in the coordinate system of the glyph being edited,
 * which is the one on screen in the font editor.
 */
function junctionBlock(
  group: Junction[],
  idx: number,
  total: number,
  upem: number,
  scale: number | null,
): string {
  // the farthest reach in the group leads: satisfying it satisfies the rest, and it
  // is one edit, so there is one number to hit
  const js = [...group].sort((a, b) => Number(b.need_units || 0) - Number(a.need_units || 0));
  const j = js[0];
  const left = j.left ?? ({} as GlyphRole);
  const ex = j.example ?? "";
  const tag = idx <= 26 ? `  (${String.fromCharCode(96 + idx)}) ` : `  (${idx}) `;
  const body = " ".repeat(tag.length);
  const gap = Number(j.gap_units || 0);

  const line = (label: string, text: string) => para(`${label} ${text}`, body + "  ", body);

  const pairs = js.map((x) => `${x.left?.glyph ?? "?"} -> ${x.right?.glyph ?? "?"}`);
  const exes = js.map((x) => `"${x.example}"`).join(", ");
  const head =
    js.length === 1
      ? `junction ${pairs[0]} (${idx} of ${total}), produced by typing ${exes}`
      : `junctions ${pairs.join(", ")} (${idx} of ${total}) - all one edit, ` +
        `produced by typing ${exes}`;
  const out: string[] = [para(head, body, tag)];

  let edit = roleText(left, ex) + ".";
  if (left.alternate) {
    edit +=
      ` This is a contextual alternate, NOT the plain '${left.char}' that the cmap ` +
      `points at (${left.base}, glyph ID ${left.base_gid}). Edit ${left.glyph}. ` +
      `Leave ${left.base} alone.`;
  }
  out.push(line("EDIT THIS GLYPH:", edit));

  const reach: string[] = [];
  for (const x of js) {
    const r = x.right ?? ({} as GlyphRole);
    let bit = roleText(r, x.example ?? "");
    if (r.alternate) {
      bit += ` - itself a contextual alternate, not the plain '${r.char}' (${r.base}, glyph ID ${r.base_gid})`;
    }
    reach.push(bit);
  }
  if (reach.length === 1) {
    out.push(line("IT MUST REACH:", reach[0] + ". Do not edit that glyph for this item."));
  } else {
    // one per line: four of these run together in a paragraph is a sentence nobody
    // finishes reading, and the whole point is that it gets read
    out.push(line("IT MUST REACH:", `all ${reach.length} of these, so reach the farthest of them:`));
    for (const bit of reach) out.push(para(bit, body + "      ", body + "    - "));
    out.push(para("Do not edit any of them for this item.", body + "  ", body + "  "));
  }

  out.push(
    line(
      "GAP NOW:",
      `${size(gap, upem, scale)} of empty space between the ink of ${left.glyph} and the next glyph` +
        (js.length > 1
          ? ` - the widest of the ${js.length} gaps in this group, so closing it closes them all.`
          : "."),
    ),
  );

  out.push(
    line(
      "DO THIS:",
      `in ${left.glyph}'s own coordinates its ink stops at ${pt(j.left_from)}, and the ` +
        `next glyph's ink begins at ${pt(j.left_contact)} in those same coordinates. ` +
        `Carry that exit stroke on from where it ends, keeping its existing width and ` +
        `following the curve it is already on, until it passes ${pt(j.left_contact)} and ` +
        `reaches at least ${pt(j.left_target)} - ${size(j.need_units ?? 0, upem, scale)} of ` +
        `travel, leaving ${size(j.margin_units ?? 0, upem, scale)} of real overlap. Do it ` +
        `ONCE. Change nothing else in the glyph, and do not widen its advance to contain ` +
        `the longer stroke - the ink is supposed to hang past the advance, that is how the ` +
        `letters overlap.`,
    ),
  );

  // a gap wider than a stroke is not a short stroke, and saying so stops a letter
  // being distorted to span it
  if (upem && gap > 0.05 * upem) {
    const alt =
      j.right?.alternate && !left.alternate
        ? ` The narrower option below - drawing the missing entry stroke on ${j.right?.glyph} - may be the truthful fix.`
        : " Judge whether the honest fix is a new connecting stroke rather than a much longer existing one.";
    out.push(
      line(
        "BEFORE YOU START:",
        `this gap is ${fmtF((gap / upem) * 100, 0)}% of the em, which is wider than a stroke ` +
          `of this font. That means the connector is missing rather than short, and ` +
          `stretching one existing stroke that far will distort the letter.` +
          alt +
          " Say which you did.",
      ),
    );
  }

  const right = j.right ?? ({} as GlyphRole);
  if (js.length === 1 && right.alternate && !left.alternate) {
    out.push(
      line(
        "IF YOU PREFER THE SMALLER CHANGE:",
        `${left.glyph} is the default form of '${left.char}' and is used in every word, so ` +
          `extending it lengthens that exit everywhere - harmless where the pair already ` +
          `joins, but wide. ${right.glyph} is only substituted in contexts like "${ex}", so ` +
          `you may instead extend ITS entry stroke backwards, in ITS own coordinates, from ` +
          `${pt(j.right_from)} past ${pt(j.right_contact)} to at least ${pt(j.right_target)}, ` +
          `the same ${size(j.need_units ?? 0, upem, scale)} of travel. Do one side or the ` +
          `other, never both.`,
      ),
    );
  } else if (left.alternate) {
    out.push(
      line(
        "WHY THIS GLYPH:",
        `${left.glyph} is only chosen in contexts like "${ex}", so editing it cannot disturb ` +
          `any other pair. That is exactly why the edit belongs here and not on the plain ` +
          `'${left.char}'.`,
      ),
    );
  } else {
    out.push(
      line(
        "SCOPE:",
        `${left.glyph} is the default form of its letter, so this pair is broken in every ` +
          `word that contains it and the edit is meant to affect all of them. No other glyph ` +
          `changes.`,
      ),
    );
  }
  return out.filter((x) => x).join("\n");
}

function junctionSection(
  junctions: Junction[] | undefined,
  extra: [string, string][] | undefined,
  upem: number,
  scale: number | null,
): string {
  const groups = groupJunctions(junctions ?? []);
  const total = groups.length + (extra && extra.length ? 1 : 0);
  const out: string[] = [];
  groups.forEach((g, i) => out.push(junctionBlock(g, i + 1, total, upem, scale)));
  if (extra && extra.length) {
    out.push(
      para(
        `(${String.fromCharCode(97 + groups.length)}) The remaining junctions were not ` +
          `measured in detail. Fix each the same way - type its example to see it, then ` +
          `carry the left glyph's exit stroke past the next glyph's ink by at least ` +
          `${size(overlapMargin(upem, scale), upem, scale)}: ` +
          extra.map(([a, b]) => `${a} (type "${b}")`).join("; "),
        "      ",
        "  ",
      ),
    );
  }
  return out.join("\n");
}

/** One Finding as an order. Called by `Finding.instruction()`. */
function instructionFor(f: Finding, upemIn: number, scale: number | null = null): string {
  const d = f.data || {};
  const c = f.code;
  const upem = Math.trunc(upemIn || 0) || 1000;

  if (c === "unreadable" || c === "load-failed") {
    return para(
      `Do not edit anything yet. This file cannot be opened as a font at all: ` +
        `${plain(f.detail)} Re-export it from the font editor as a plain TTF or OTF and ` +
        `check that what arrives is a font file and not a .zip, .woff or a truncated ` +
        `download.`,
    );
  }

  if (c === "no-outlines") {
    return para(
      "Re-export this font with real outlines - a 'glyf' table (TTF) or a 'CFF ' table " +
        "(OTF). The file currently has neither, so there are no shapes to cut. Do not add " +
        "outlines by hand; export the source the font was drawn in.",
    );
  }

  if (c === "bad-upem") {
    return para(
      `Set head.unitsPerEm to 1000 (it is currently ${d.upem}, which nothing can be ` +
        `measured against) and scale every glyph coordinate, every advance width and every ` +
        `vertical metric by the same factor, so the letters keep their exact proportions. ` +
        `This is the one item in this request that is allowed to change unitsPerEm.`,
    );
  }

  if (c === "no-cmap") {
    return para(
      "Regenerate the Unicode character map: a format 4 Windows Unicode BMP subtable " +
        "(platform 3, encoding 1) mapping U+0041-U+005A (A-Z), U+0061-U+007A (a-z), U+0020 " +
        "space, U+0027 apostrophe, U+002D hyphen and U+002E period to the glyphs that " +
        "already draw them. Map existing glyphs only - do not draw, add, remove or reorder " +
        "any glyph, because reordering changes every glyph ID.",
    );
  }

  if (c === "missing-letters") {
    const miss = String(d.missing ?? "");
    const cps =
      miss.length > 0 && miss.length <= 10
        ? "(" +
          [...miss].map((ch) => `U+${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`).join(", ") +
          ") "
        : "";
    return para(
      `Draw and encode the ${miss.length} letter(s) this font has no glyph for: ` +
        `${[...miss].join(" ")} ${cps}Draw each to match the weight, slant, cap height and ` +
        `stroke ends of the letters already in the font, give it a sensible advance width, ` +
        `and map it to its own Unicode code point. APPEND the new glyphs to the END of the ` +
        `glyph order so that no existing glyph ID moves - the app addresses glyphs by ID.`,
    );
  }

  if (c === "missing-extras" || c === "missing-space") {
    const miss = (d.missing as string[]) ?? [];
    const short: Record<string, string> = { " ": "space", "'": "quotesingle", "-": "hyphen", ".": "period" };
    const namesMap: Record<string, string> = {
      " ": "space (U+0020)", "'": "quotesingle (U+0027)",
      "-": "hyphen (U+002D)", ".": "period (U+002E)",
    };
    const want = miss.map((ch) => namesMap[ch] ?? pyRepr(ch)).join(", ");
    const ink = miss.filter((ch) => ch.trim());
    let txt =
      `Add and encode the missing character(s): ${want}. Append them to the END of the ` +
      `glyph order so no existing glyph ID moves.`;
    if (miss.includes(" ")) {
      txt += " The space glyph needs an advance width and no outline at all.";
    }
    if (ink.length) {
      // named, not 'the others': the reader should not have to work out which of the
      // characters above still needs drawing
      txt +=
        ` Draw ${ink.map((ch) => short[ch] ?? pyRepr(ch)).join(" and ")} to match the font's ` +
        `weight, slant and height, and give ${ink.length === 1 ? "it" : "each"} a sensible ` +
        `advance width.`;
      if (d.joins) {
        txt +=
          ` This font cuts as one connected piece, so anything drawn here has to touch the ` +
          `letters on either side of it: draw it overlapping its neighbours by at least ` +
          `${size(overlapMargin(upem, scale), upem, scale)} rather than floating clear, or a ` +
          `name like O'Brien cuts into loose pieces.`;
      }
    }
    return para(txt);
  }

  if (c === "empty-glyphs") {
    const gl = (d.glyphs as Partial<GlyphRole>[]) ?? [];
    const who =
      gl.map((g) => `'${g.char}' = ${named(g)}`).join("; ") || String(d.letters ?? "");
    return para(
      `Draw the outlines for the glyph(s) that are encoded but empty: ${who}. Each one has ` +
        `a cmap entry and an advance width but no contours at all, so it disappears out of a ` +
        `name without a word. Draw the letter inside its existing advance width, matching the ` +
        `rest of the font. Do not change the advance width and do not delete the glyph.`,
    );
  }

  if (c === "colr-version") {
    return para(
      `Re-export the colour layers as COLR version 0. They are currently COLR v${d.version}, ` +
        `and the engrave lines are read only from COLR v0 records - a base glyph with a list ` +
        `of layer glyphs, each carrying a CPAL palette index. Flatten anything v0 cannot ` +
        `express (gradients, transforms, blend modes) into plain layer glyphs first. Keep the ` +
        `same layer shapes and the same base glyphs; this is a change of container, not of ` +
        `artwork.`,
    );
  }

  if (c === "no-cpal") {
    return para(
      "Add a CPAL table with one palette holding one entry per colour index used by the " +
        "COLR v0 layers. Set the entries belonging to engrave layers to red (255, 0, 0, 255) " +
        "and the entries belonging to cut layers to black (0, 0, 0, 255). A layer counts as " +
        "engraving only when its palette colour is not black, so with no palette at all " +
        "nothing can be told apart. Do not move or redraw any layer geometry.",
    );
  }

  if (c === "palette-all-black") {
    const pal = (d.palette as number[][]) ?? [];
    const listing = pal.length
      ? "Current entries: " +
        pal.slice(0, 8).map((rgba, i) => `${i} = (${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]})`).join("; ") +
        (pal.length > 8 ? "; ..." : "") +
        ". "
      : "";
    return para(
      `Recolour the CPAL palette entries that belong to the engrave layers to red ` +
        `(255, 0, 0, 255). ${listing}Every entry is black, and a layer is treated as ` +
        `engraving only when at least one of its R, G, B is 40 or more, so nothing is ` +
        `currently engraved. Change only the entries whose layers are the engrave lines; ` +
        `leave the cut layers black. Do not touch any outline, layer order or COLR record - ` +
        `this is four numbers per entry and nothing else.`,
    );
  }

  if (c === "no-xheight") {
    const x = d.x_units;
    const got = x
      ? `Measure it as ${size(x, upem, scale)}, the ink height of 'x' in this font.`
      : "Measure the ink height of 'x' in font units and use that.";
    return para(
      `Optional, and only if Sean asks for it: set OS/2.sxHeight. ${got} Change nothing ` +
        `else in OS/2 - sCapHeight, the ascender and descender fields and the typo metrics ` +
        `all stay as they are.`,
    );
  }

  if (c === "build-failed") {
    return para(
      `Do not change the font for this one. Building the name ${pyRepr(String(d.name))} ` +
        `fails outright: ${plain(f.detail)} Report it with this font attached - it may be a ` +
        `bug in the app rather than a defect in the font, and guessing at a glyph edit here ` +
        `would change artwork that is not actually wrong.`,
    );
  }

  if (c === "not-connected") {
    const js = d.junctions ?? [];
    const extra = d.extra ?? [];
    const head = para(
      `Make the name ${pyRepr(String(d.name))} cut as one piece. It currently comes out as ` +
        `${d.pieces} separate pieces that fall apart on the laser bed, because the letters ` +
        `below have no shared ink. Fix each junction independently.`,
    );
    return head + (js.length || extra.length ? "\n" + junctionSection(js, extra, upem, scale) : "");
  }

  if (c === "sub-kerf-holes") {
    const holes = d.holes ?? [];
    const floorU = d.floor_units;
    const floor =
      floorU !== null && floorU !== undefined
        ? size(floorU, upem, scale)
        : inch(d.floor_in ?? KERF_IN);
    const out: string[] = [
      para(
        `Close the sliver opening(s) in the built name ${pyRepr(String(d.name))}. An opening ` +
          `only cuts cleanly if the largest circle that fits inside it has a radius of at ` +
          `least ${floor}; anything finer is thinner than the beam, so it burns through ` +
          `instead of cutting and gets no lead-in.`,
      ),
    ];
    holes.forEach((h, i) => {
      const walls = h.between ?? [];
      let where: string;
      if (walls.length >= 2) {
        where =
          "it sits where " +
          walls.map((w) => named(w)).join(" meets ") +
          "; that point is " +
          walls.map((w) => `${pt(w.at)} in ${w.glyph}'s own coordinates`).join(", ");
      } else if (walls.length) {
        where = `it is inside ${named(walls[0])}, at ${pt(walls[0].at)} in that glyph's own coordinates`;
      } else {
        where = "the glyphs that form it could not be named";
      }
      out.push(
        para(
          `opening ${i + 1} of ${holes.length}: the largest circle inside it has a radius of ` +
            `${size(h.radius_units ?? 0, upem, scale)}, and ${where}. Close it by pushing ` +
            `those glyphs' strokes into each other until the opening disappears - preferred, ` +
            `because it also makes the joint stronger - or open it out until that circle's ` +
            `radius is over ${floor}. Do not delete the contour that forms it, and do not ` +
            `change either glyph anywhere else.`,
          "      ",
          `  (${String.fromCharCode(97 + i)}) `,
        ),
      );
    });
    return out.join("\n");
  }

  if (c === "letter-gaps") {
    const js = d.junctions ?? [];
    const extra = d.extra ?? [];
    const count = d.count ?? js.length + extra.length;
    const edits = groupJunctions(js).length + (extra.length ? 1 : 0);
    const head = para(
      `Close the ${count} letter junction(s) that leave a gap. Each one makes any name ` +
        `containing it cut as loose pieces instead of one plate. They come to ${edits} ` +
        `separate edit(s) below, because several of these junctions are the same stroke ` +
        `stopping short. Do not touch a glyph that is not named here.`,
    );
    return head + (js.length || extra.length ? "\n" + junctionSection(js, extra, upem, scale) : "");
  }

  // anything this function has not been taught: say the finding plainly rather than
  // inventing an edit for it.
  return para(
    `${plain(f.title)}: ${plain(f.detail)} ${plain(f.fix)} (No font-unit measurement was ` +
      `recorded for this item - measure it in the font editor before changing anything.)`,
  );
}

/**
 * Every glyph the numbered items actually name, once each.
 *
 * A count of glyphs allowed to differ is the cheapest check there is: Sean can diff
 * the returned font and see straight away whether something else moved, and the
 * editor is told the number it will be held to before it starts.
 */
function scopeGlyphs(rep: Report): string[] {
  const seen = new Map<string, number | null | undefined>();
  for (const f of rep.findings) {
    if (f.severity !== ERROR && f.severity !== WARNING) continue;
    const d = f.data || {};
    for (const j of d.junctions ?? []) {
      const g = j.left ?? ({} as GlyphRole);
      if (g.glyph && !seen.has(g.glyph)) seen.set(g.glyph, g.gid);
    }
    for (const h of d.holes ?? []) {
      for (const w of h.between ?? []) {
        if (w.glyph && !seen.has(w.glyph)) seen.set(w.glyph, w.gid);
      }
    }
    for (const g of (d.glyphs as Partial<GlyphRole>[]) ?? []) {
      if (g.glyph && !seen.has(g.glyph)) seen.set(g.glyph, g.gid);
    }
  }
  return [...seen].map(([k, v]) => (v !== null && v !== undefined ? `${k} (glyph ID ${v})` : String(k)));
}

/**
 * The list that stops the collateral damage.
 *
 * Built from the report, not fixed, because two items on it are legitimately up for
 * change when a specific defect was found — promising "unitsPerEm never changes" next
 * to "change unitsPerEm" is how a request gets ignored wholesale.
 */
function dontChange(rep: Report): string[] {
  const codes = new Set(rep.findings.map((f) => f.code));
  const upem = rep.upem || 0;
  const keep: string[] = [];
  if (!codes.has("bad-upem")) {
    keep.push(
      `unitsPerEm - it is ${upem || "whatever it is"} and it stays exactly that. Every ` +
        `number in this request assumes it.`,
    );
  }
  keep.push(
    "cap height, and OS/2 sCapHeight / sTypoAscender / sTypoDescender / hhea ascent and " +
      "descent. Sean's app scales a name by cap height, so moving it silently resizes every " +
      "nameplate ever cut from this font.",
  );
  const xh = rep.meta.sxheight;
  keep.push(
    `x-height - OS/2 sxHeight` + (xh ? ` is ${xh} and stays ${xh}.` : " stays as it is."),
  );
  keep.push(
    "every glyph's advance width, left side bearing and right side bearing. Widening a " +
      "glyph to contain a stroke you extended is exactly the wrong fix: in a joining font the " +
      "ink is supposed to hang past the advance. Extend the ink, leave the advance.",
  );
  keep.push(
    "kerning, and any GPOS table. The gaps above are closed by drawing, not by moving " +
      "letters closer together.",
  );
  keep.push(
    "the contextual alternate set and its feature rules - GSUB, calt, liga, rlig, ccmp. Do " +
      "not add, remove, re-point or re-order a substitution, and do not make a substitution " +
      "fire in a new context. Where a defect is in an alternate, edit that alternate's " +
      "outline in place.",
  );
  const missingAny =
    codes.has("missing-letters") || codes.has("missing-extras") || codes.has("missing-space");
  keep.push(
    "the glyph order and therefore every glyph ID. Do not add, delete, merge or reorder " +
      "glyphs" +
      (missingAny
        ? " except by appending the new glyphs named above to the very end."
        : ". The app addresses glyphs by ID.") +
      " Do not subset, do not remove unused glyphs, do not decompose or recompose composites.",
  );
  keep.push(
    "the eyelet holes and their diameters, and every other existing counter or hole. If a " +
      "glyph already has a hole in it, that hole keeps its size and position.",
  );
  if (rep.meta.colr !== null && rep.meta.colr !== undefined && !codes.has("colr-version")) {
    keep.push(
      "the COLR layers and the CPAL palette - the engrave lines come from them and they are " +
        "already correct.",
    );
  }
  keep.push(
    "the family name and every other name-table record, the font version, the outline " +
      "format, and hinting. No autohinting, no 'clean up outlines', no rounding coordinates " +
      "to the grid, no reinterpolation.",
  );
  keep.push(
    "every glyph that is not in the GLYPHS IN SCOPE list above. If you are unsure whether a " +
      "glyph is in scope, it is not.",
  );
  return keep;
}

/** `Report.claudePrompt()`'s body, kept out of the class for room. */
function buildPrompt(rep: Report): string {
  try {
    return promptBody(rep);
  } catch (exc) {
    // a font strange enough to break the renderer must not cost Sean the findings,
    // so fall back to the plainest possible restatement
    const lines = [
      `FONT REPAIR REQUEST - ${basename(rep.path)}`,
      "",
      para(
        `This request could not be fully measured (${excName(exc)}), so the defects are ` +
          `listed as they were found and no coordinates are given. Every size below is in ` +
          `font units, relative to unitsPerEm = ${rep.upem || "unknown"}. Measure in the font ` +
          `editor before changing anything.`,
      ),
      "",
    ];
    rep.sorted().forEach((f, i) => {
      lines.push(para(`${plain(f.title)}. ${plain(f.detail)} ${plain(f.fix)}`, "   ", `${i + 1}. `));
    });
    return lines.join("\n");
  }
}

/** Python's `f"{type(exc).__name__}: {exc}"`. */
function excName(exc: unknown): string {
  const e = exc as Error;
  return `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}`;
}

function promptBody(rep: Report): string {
  const upem = Math.trunc(rep.upem || 0) || 1000;
  const scale = rep.scale;
  const tasks = rep.sorted().filter((f) => f.severity === ERROR || f.severity === WARNING);
  const notes = rep.sorted().filter((f) => f.severity === NOTE);
  const base = basename(rep.path);
  const fmt = (rep.meta.container as string) || "the format it already is";

  const L: string[] = [`FONT REPAIR REQUEST - ${base}`, ""];

  // A file that could not be opened has no font facts to state and no glyph to name.
  // Printing the usual work order around it would describe a font that does not exist
  // — invented unitsPerEm, invented tables — which is worse than printing nothing.
  const dead = tasks.filter((f) => f.code === "unreadable" || f.code === "load-failed");
  if (dead.length) {
    L.push(
      para(
        `There is nothing to edit yet. Sean's nameplate app cannot open ${base} as a font at ` +
          `all, so it could not be measured and there is no instruction to give.`,
      ),
    );
    L.push("");
    for (const f of dead) L.push(para(plain(f.detail), "   "));
    L.push("");
    L.push(
      para(
        "Re-export it from the font editor as a plain TTF or OTF and check that what arrives " +
          "is a font file, not a .zip, a .woff or a truncated download. Do not attempt any " +
          "repair on this file.",
        "   ",
      ),
    );
    return L.join("\n");
  }

  if (!tasks.length) {
    L.push(
      para(
        `No repair needed. Sean's nameplate app checked this font (${rep.family || base}) and ` +
          `found no errors and no warnings, so there is nothing to change and no edit to make. ` +
          `Please do not modify this font.`,
      ),
    );
    if (notes.length) {
      L.push("", "For information only - these are not defects and are not tasks:");
      for (const f of notes) {
        L.push(para(`${plain(f.title)}: ${plain(f.detail)}`, "     ", "   - "));
      }
    }
    return L.join("\n");
  }

  // ---- who the font is ---------------------------------------------- //
  L.push(
    para(
      `You are editing the font file ${base}. Make the numbered changes below and nothing ` +
        `else. This font is used to laser cut names out of sheet metal, so a letter that does ` +
        `not physically touch the next one becomes a piece of metal on the floor.`,
    ),
  );
  L.push("", "THE FONT");
  L.push(`  file                ${base}`);
  L.push(`  family (name ID 4)  ${rep.family || "(none set)"}`);
  L.push(`  unitsPerEm          ${upem}`);
  L.push(para((rep.meta.outline as string) || "unknown", " ".repeat(22), "  outlines            "));
  const post = rep.meta.post as number | null | undefined;
  if (post === 3.0) {
    L.push(
      para(
        "post table format 3.0 - this font stores NO glyph names. Names like glyph00174 below " +
          "are placeholders generated from the glyph order, so look every glyph up by its " +
          "glyph ID, which is the number in the name and is given explicitly each time.",
        " ".repeat(22),
        "  glyph names         ",
      ),
    );
  } else if (post === null || post === undefined) {
    L.push("  glyph names         no readable post table - refer to every glyph by its glyph ID");
  } else {
    L.push(`  glyph names         post table format ${pyFloat(post)}, names are real`);
  }
  const colr = rep.meta.colr as number | null | undefined;
  const cpal = (rep.meta.cpal as number) ?? 0;
  L.push(
    para(
      colr !== null && colr !== undefined
        ? `COLR v${colr}, ${cpal} CPAL palette(s) - the engrave lines come from these`
        : "no COLR table, no CPAL - this is a cut-only font",
      " ".repeat(22),
      "  colour layers       ",
    ),
  );
  L.push(`  glyph count         ${rep.meta.glyphs ?? "?"}`);
  // which features are on decides which alternates are chosen, and every alternate
  // named below was chosen under exactly these
  const feats = Object.keys(DEFAULT_FEATURES)
    .filter((k) => DEFAULT_FEATURES[k])
    .sort()
    .join(", ");
  L.push(
    para(
      `the app shapes text with ${feats} switched on, which is what picks the contextual ` +
        `alternates named below`,
      " ".repeat(22),
      "  shaping             ",
    ),
  );

  // ---- the units mistake this whole block exists to prevent ---------- //
  L.push("", "SIZES ARE IN FONT UNITS - READ THIS BEFORE MEASURING ANYTHING");
  L.push(
    para(
      `Every size in this request is in FONT UNITS, relative to unitsPerEm = ${upem}. Work in ` +
        `font units. A font editor measures in font units and Sean's app measures in inches ` +
        `because it cuts metal, and every earlier attempt at these fixes went wrong at that ` +
        `boundary - an inch number treated as a font-unit number is roughly ` +
        `${scale ? Math.trunc(1 / scale) : 700} times too small, which looks like nothing ` +
        `happened at all.`,
      "  ",
    ),
  );
  if (scale) {
    L.push(
      para(
        `So each size is given twice: font units first, then the same size in inches in ` +
          `brackets. The inch figures use the size the font was checked at, ` +
          `${(rep.meta.basis as string) || "1.000 in cap height"}, where 1 font unit = ` +
          `${fmtF(scale, 6)} in (${fmtF(scale * 25.4, 4)} mm) and 1 in = ${n(1 / scale)} font ` +
          `units. Only the font-unit numbers are the instruction; the inch numbers are there ` +
          `to be sanity-checked.`,
        "  ",
      ),
    );
    L.push(
      para(
        `A plate cut larger than that makes every font unit physically bigger, so an overlap ` +
          `stated in font units holds at every larger size. That is the other reason the ` +
          `instruction is in font units and not in inches.`,
        "  ",
      ),
    );
  } else {
    L.push(
      para(
        "No name could be built from this font, so there is no inch conversion to give. Sizes " +
          "are in font units and in fractions of the em only.",
        "  ",
      ),
    );
  }

  // ---- the work ------------------------------------------------------ //
  L.push("", `WHAT TO CHANGE - ${tasks.length} ${tasks.length === 1 ? "item" : "items"}, and nothing else`, "");
  tasks.forEach((f, i) => {
    const body = f.instruction(upem, scale);
    const lines = body.split("\n").length ? body.split("\n") : [""];
    const head = `${i + 1}. ${lines[0].replace(/^\s+/, "")}`;
    L.push([head, ...lines.slice(1).map((ln) => (ln.trim() ? "   " + ln : ""))].join("\n"));
    L.push("");
  });

  // ---- the checksum, next to the work it counts ---------------------- //
  const scope = scopeGlyphs(rep);
  const codes = new Set(rep.findings.map((f) => f.code));
  L.push(
    scope.length
      ? `GLYPHS IN SCOPE - ${scope.length} existing glyph(s), and no others`
      : "GLYPHS IN SCOPE - no existing glyph may change",
    "",
  );
  L.push(
    para(
      scope.length
        ? scope.join("; ") + "."
        : "None. No glyph already in this font may come back different.",
      "   ",
    ),
  );
  const extraScope: string[] = [];
  if (codes.has("missing-letters") || codes.has("missing-extras") || codes.has("missing-space")) {
    extraScope.push("the new glyphs appended for the missing characters named above");
  }
  if (codes.has("letter-gaps") || codes.has("not-connected")) {
    extraScope.push(
      "where an item offers a choice of which side to edit, the partner glyph that item " +
        "names - one side or the other, never both",
    );
  }
  if (rep.findings.some((f) => (f.data || {}).extra?.length)) {
    extraScope.push("the left-hand glyph of each junction in the un-measured list above");
  }
  if (extraScope.length) {
    L.push(para("Also in scope: " + extraScope.join("; ") + ".", "   "));
  }
  L.push(para("Every other glyph in the font must come back byte for byte identical.", "   "));
  L.push("");

  // ---- what the notes are, so they are not mistaken for work --------- //
  if (notes.length) {
    L.push("BACKGROUND, NOT TASKS - do not change anything for these", "");
    const said = new Set<string>();
    for (const f of notes) {
      // 'ADAM' and 'Adam' produce the same engine note twice; repeating it only makes
      // the list look longer than the work
      const body = plain(f.detail);
      if (said.has(body)) continue;
      said.add(body);
      L.push(para(`${plain(f.title)}: ${body}`, "     ", "   - "));
    }
    L.push("");
  }

  // ---- the fence ----------------------------------------------------- //
  L.push("DO NOT CHANGE - anything here that moves is a defect you introduced", "");
  for (const item of dontChange(rep)) L.push(para(item, "     ", "   - "));
  L.push("");

  // ---- what comes back ----------------------------------------------- //
  L.push("WHAT TO SEND BACK", "");
  const newname = (rep.meta.next_name as string) || "with a new version suffix";
  const missingAny =
    codes.has("missing-letters") || codes.has("missing-extras") || codes.has("missing-space");
  const back: string[] = [
    `Re-export the edited font as ${fmt} - the same format it arrived in - with the family ` +
      `name still exactly ${rep.family || "(unchanged)"}, unitsPerEm still ${upem}, and the ` +
      `same glyph inventory in the same order` +
      (missingAny ? ", plus the new glyphs appended at the end." : "."),
    `Name the file ${newname} so it cannot be confused with ${base}.`,
    "List what you changed: for each glyph, its name and glyph ID, which contour and which " +
      "points moved, and the before and after coordinates in font units. One line per glyph.",
  ];
  if (codes.has("letter-gaps") || codes.has("not-connected")) {
    // a pass condition that can be tested rather than eyeballed
    back.push(
      "For every junction you closed, check it: set the two glyphs side by side at their " +
        "existing advance widths and confirm the outlines genuinely overlap rather than touch " +
        "- the union of the two shapes has to be one closed region, not two regions meeting at " +
        "a point. Say that you checked it.",
    );
  }
  back.push(
    "State how many glyphs you edited and confirm it matches that list and the GLYPHS IN " +
      "SCOPE count above. If you changed anything that was not asked for, say so plainly " +
      "rather than leaving it to be found on the laser bed.",
  );
  back.push(
    "If any instruction here cannot be carried out as written, stop and say which one and " +
      "why. Do not substitute a different fix.",
  );
  back.forEach((item, i) => L.push(para(item, "      ", `   ${i + 1}. `)));
  return L.join("\n");
}

/** `check_font()` plus `claude_prompt()`, for callers that only want the text. */
export function promptForFont(path: string, joinScanBudget = 25.0): string {
  return checkFont(path, { joinScanBudget }).claudePrompt();
}

/**
 * Python's `repr()` for a short string — single quotes unless the string contains
 * one and no double quote. Used where a report quotes a character or a name back.
 */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\");
  if (q === "'") body = body.replace(/'/g, "\\'");
  body = body
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return q + body + q;
}

/**
 * Inspect one font. `joinScanBudget` seconds are spent testing letter pairs for gaps;
 * pass 0 to skip that scan.
 */
export function checkFont(
  path: string,
  opts: { names?: string[]; joinScanBudget?: number } = {},
): Report {
  const names = opts.names ?? ["ADAM", "Adam"];
  const joinScanBudget = opts.joinScanBudget ?? 25.0;
  const rep = new Report(path);

  // ---- can it be opened at all? ------------------------------------- //
  let font: Font;
  try {
    font = new Font(path);
    rep.family = font.family;
  } catch (exc) {
    rep.add(
      ERROR,
      "load-failed",
      "The font loaded but the app cannot use it",
      excName(exc),
      "Re-export the font from the font editor; if it still fails, send this font and this " +
        "report on.",
    );
    return rep;
  }

  rep.facts.push(`units per em: ${font.upem}`);
  rep.facts.push(`glyphs: ${font.numGlyphs}`);
  // the same numbers again, structured, so claudePrompt() can identify the font
  // without re-reading it
  try {
    rep.upem = Math.trunc(font.upem || 0);
    rep.meta.glyphs = font.numGlyphs;
    rep.meta.next_name = nextFilename(path);
  } catch {
    /* the facts above already carried it */
  }

  // ---- outlines present? -------------------------------------------- //
  try {
    const hasGlyf = font.rawTable("glyf") !== null;
    const hasCff = font.rawTable("CFF ") !== null || font.rawTable("CFF2") !== null;
    rep.facts.push(
      `outline format: ` +
        `${hasGlyf ? "TrueType (glyf)" : ""}${hasCff ? "PostScript (CFF)" : ""}` +
        `${!hasGlyf && !hasCff ? "NONE" : ""}`,
    );
    rep.meta.outline = hasGlyf
      ? "TrueType 'glyf' outlines"
      : hasCff
        ? "PostScript 'CFF ' outlines"
        : "NO outline table at all";
    rep.meta.container = hasGlyf
      ? "a TTF with 'glyf' outlines"
      : hasCff
        ? "an OTF with 'CFF ' outlines"
        : "a normal TTF or OTF";
    if (!hasGlyf && !hasCff) {
      rep.add(
        ERROR,
        "no-outlines",
        "The font contains no outlines",
        "There is neither a 'glyf' nor a 'CFF ' table, so there are no shapes to cut.",
        "Re-export as a normal TTF or OTF. A bitmap-only or metrics-only font cannot be used.",
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- units per em ------------------------------------------------- //
  try {
    if (!font.upem || font.upem <= 0) {
      rep.add(
        ERROR,
        "bad-upem",
        "The font's em size is invalid",
        `unitsPerEm is ${font.upem}. Every measurement is scaled from it, so nothing can be sized.`,
        "Set unitsPerEm in the font's head table to a normal value (1000 for OTF, 1024 or " +
          "2048 for TTF).",
        { upem: font.upem },
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- cmap: can letters be looked up? ------------------------------ //
  try {
    if (!font.cmap.size) {
      rep.add(
        ERROR,
        "no-cmap",
        "The font has no usable character map",
        "There is no Unicode cmap, so typed letters cannot be matched to any glyph.",
        "In the font editor, regenerate the Unicode cmap (a Windows Unicode BMP subtable, " +
          "platform 3 encoding 1).",
      );
    } else {
      const missing = [...LETTERS].filter((c) => !font.cmap.has(c.codePointAt(0) as number));
      if (missing.length) {
        rep.add(
          missing.length > 26 ? ERROR : WARNING,
          "missing-letters",
          "Some letters are missing",
          `${missing.length} of 52 letters have no glyph: ${missing.join("")}. Any name using ` +
            `them cannot be built.`,
          "Draw or map the missing letters, then re-export. If the font is intentionally " +
            "caps-only, avoid lowercase names with it.",
          { missing: missing.join("") },
        );
      }
      const missExtra = [...EXTRAS].filter((c) => !font.cmap.has(c.codePointAt(0) as number));
      if (missExtra.length) {
        // A missing SPACE is a real problem — two-word names run together. Missing
        // apostrophe/hyphen/period is not: these display fonts are drawn for single
        // names and are not expected to carry punctuation, so it is reported as a
        // fact, not a warning, and never reaches the amber panel.
        const punct = missExtra.filter((c) => c !== " ");
        if (missExtra.includes(" ")) {
          rep.add(
            WARNING,
            "missing-space",
            "The space glyph is missing",
            "There is no space (U+0020) in the font, so a two-word name like Mary Jane will " +
              "run together.",
            "Add a space glyph with an advance width and no outline.",
            { missing: [" "] },
          );
        }
        if (punct.length) {
          // Recorded as a fact, deliberately NOT as a finding: these are display
          // fonts drawn for single names and are not expected to carry punctuation.
          // Raising it would put a warning on nearly every font and would tell the
          // font editor to draw glyphs nobody wants.
          rep.facts.push(
            "no punctuation glyphs (expected): " + punct.map((c) => pyRepr(c)).join(" "),
          );
        }
      }
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- glyph names (the gid131 crash) ------------------------------- //
  try {
    const fmt = font.postFormat;
    rep.facts.push(`post table format: ${fmt === null ? "None" : pyFloat(fmt)}`);
    rep.meta.post = fmt;
    if (fmt === 3.0) {
      rep.add(
        NOTE,
        "no-glyph-names",
        "The font carries no glyph names",
        "Its post table is format 3.0, so glyphs have no names and tools refer to them as " +
          "glyph00131 or gid131. The app handles this by using glyph IDs, but font editors " +
          "will show unhelpful names.",
        "Nothing required. To get readable names, re-export with post format 2.0 ('keep " +
          "glyph names' in most editors).",
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- letters that exist but are empty ----------------------------- //
  try {
    const empty: string[] = [];
    const blanks: Partial<GlyphRole>[] = [];
    for (const c of LETTERS) {
      const gid = font.cmap.get(c.codePointAt(0) as number);
      if (gid === undefined) continue;
      const gname = font.glyphName(gid);
      try {
        if (!font.contours(gid).length) {
          empty.push(c);
          blanks.push({ glyph: gname, gid, char: c });
        }
      } catch {
        empty.push(c);
        blanks.push({ glyph: gname, gid, char: c });
      }
    }
    if (empty.length) {
      rep.add(
        ERROR,
        "empty-glyphs",
        "Some letters have no outline",
        `These letters exist in the font but draw nothing: ${empty.join("")}. They would ` +
          `silently vanish from a name.`,
        "Open each one in the font editor and draw its outline, or remove the empty glyph so " +
          "a fallback is used.",
        { letters: empty.join(""), glyphs: blanks.slice(0, 20) },
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- engrave layers (COLR / CPAL) --------------------------------- //
  try {
    const colrVer = font.colrVersion;
    rep.facts.push(
      `COLR: ${colrVer !== null ? "v" + colrVer : "none"}  CPAL palettes: ${font.palette.length}`,
    );
    rep.meta.colr = colrVer;
    rep.meta.cpal = font.palette.length;
    if (colrVer !== null && colrVer !== 0) {
      rep.add(
        ERROR,
        "colr-version",
        "Engrave lines cannot be read from this font",
        `Its colour table is COLR v${colrVer}. The engrave lines are found by reading COLR v0 ` +
          `layers, so no engraving will be produced.`,
        "Re-export the colour layers as COLR v0 (the simple layer-plus-palette format), or " +
          "export cut-only.",
        { version: colrVer },
      );
    } else if (colrVer === 0 && !font.palette.length) {
      rep.add(
        ERROR,
        "no-cpal",
        "Colour layers exist but there is no palette",
        "The font has COLR v0 layers but no CPAL palette, so there is no way to tell an " +
          "engrave layer from a cut layer.",
        "Add a CPAL palette and give the engrave layers a non-black colour (red is the " +
          "convention).",
      );
    } else if (colrVer === 0 && font.palette.length) {
      const nonBlack = font.palette.filter((_c, i) => font.isEngraveLayer(i));
      if (!nonBlack.length) {
        rep.add(
          WARNING,
          "palette-all-black",
          "Every colour layer is black",
          "A layer counts as engraving only when its palette colour is not black. All entries " +
            "here are black, so nothing will be treated as an engrave line.",
          "Recolour the engrave layers in the CPAL palette to a non-black colour, red by " +
            "convention.",
          { palette: font.palette.slice(0, 16).map((c) => [...c]) },
        );
      }
    } else if (colrVer === null) {
      // Cut-only is the normal, expected case: most of these fonts carry no engraving
      // at all. A fact, never a finding.
      rep.facts.push(
        "cut-only font (no COLR table, so no engrave lines) - normal, the outline still cuts",
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- height references -------------------------------------------- //
  try {
    const sx = font.declaredXHeight || 0;
    rep.facts.push(`OS/2 sxHeight: ${sx || "missing"}`);
    rep.meta.sxheight = sx || null;
    if (!sx) {
      // measure what the value should be, so the instruction can name a number
      // instead of asking the editor to guess one
      let xUnits: number | null = null;
      try {
        const gx = font.cmap.get("x".codePointAt(0) as number);
        const ys = gx === undefined ? [] : font.contours(gx).flatMap((c) => c.map((p) => p[1]));
        xUnits = ys.length ? Math.max(...ys) - Math.min(...ys) : null;
      } catch {
        xUnits = null;
      }
      rep.add(
        NOTE,
        "no-xheight",
        "The font declares no x-height",
        "Measuring by x-height falls back to measuring the letter 'x', or the whole artwork " +
          "if there is no 'x'.",
        "Set sxHeight in the OS/2 table if you rely on the x-height option.",
        { x_units: xUnits },
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- does it actually build, and is the result one piece? --------- //
  rep.facts.push(
    "test names used to probe this font: " +
      names.map((x) => pyRepr(x)).join(", ") +
      " - samples the checker shapes to exercise capitals and lowercase, nothing to do with " +
      "what you will type",
  );
  for (const name of names) {
    let doc: Document;
    try {
      doc = buildDocument(font, name, 1.0, "in", "cap");
    } catch (exc) {
      rep.add(
        ERROR,
        "build-failed",
        `Building the test name ${pyRepr(name)} fails`,
        excName(exc),
        "This is the defect to report. Send this font and this report on — it may be an " +
          "app fix rather than a font fix.",
        { name, exc: excName(exc) },
      );
      continue;
    }

    // what one font unit is worth in inches, taken from the first name that builds.
    // Every physical figure in the prompt is stated at this size.
    if (rep.scale === null) {
      try {
        rep.scale = Number(doc.scale);
        rep.meta.basis = `${fmtF(doc.targetHeight, 3)} ${doc.unit} ${doc.basis} height`;
      } catch {
        /* the prompt then says so instead of inventing one */
      }
    }

    try {
      const ringList = LI.rings(doc);
      const { polys, depths } = LI.analyse(ringList);
      const outers = polys.filter((_p, i) => depths[i] % 2 === 0);
      const holes = polys.filter((_p, i) => depths[i] % 2 === 1);
      const [w, h] = doc.size();
      // Say TEST NAME. These are samples the checker shapes to exercise capitals and
      // lowercase; read bare, a line beginning 'ADAM': made every font look as though
      // it were called ADAM.
      rep.facts.push(
        `test name ${pyRepr(name)} at 1.000 in cap height: ${fmtF(w, 3)} x ${fmtF(h, 3)} in, ` +
          `${outers.length} piece(s), ${holes.length} hole(s), ` +
          `${doc.engravePaths.length} engrave line(s)`,
      );

      if (outers.length === 1 && name.length > 1) {
        // the letters of this name overlap into one plate, which means this is a
        // joining font — punctuation advice depends on it
        rep.meta.joins = true;
      }

      if (outers.length > 1) {
        const gaps = nameGaps(font, name);
        const where = gaps.length
          ? describeGaps(gaps, font.upem, doc.scale)
          : "could not localise the break";
        rep.add(
          WARNING,
          "not-connected",
          `the test name ${pyRepr(name)} does not cut as one piece`,
          `The letters do not all overlap, so the artwork is ${outers.length} separate pieces ` +
            `that will fall apart on the laser bed. The break is between: ${where}.`,
          "Extend the exit stroke of the left letter (or the entry stroke of the right one) " +
            "until they overlap, or tighten that pair's kerning. A hairline touch is not " +
            "enough — they must genuinely cross.",
          {
            name,
            pieces: outers.length,
            junctions: junctionDetails(font, name, doc.scale),
          },
        );
      }

      // holes too fine to cut, and slivers where letters nearly touch
      const floor = LI.hardClearance("in");
      const fine = holes.filter((p) => LI.inradius(p) * doc.scale < floor);
      if (fine.length) {
        // the same measurement the test just made, kept in font units: an instruction
        // that says '0.004 in' to someone working in font units is the exact mix-up
        // this module is trying to end
        const holeData = fine.slice(0, 6).map((p) => {
          const r = LI.inradius(p);
          return {
            radius_units: r,
            radius_in: r * doc.scale,
            between: holeNeighbours(font, name, p),
          };
        });
        rep.add(
          WARNING,
          "sub-kerf-holes",
          `${pyRepr(name)} has ${fine.length} opening(s) finer than the kerf`,
          `${fine.length} hole(s) are narrower than ${pyG(floor)} in. The laser cannot cut ` +
            `them cleanly and they get no lead-in. They usually appear where two letters ` +
            `almost touch.`,
          "Either overlap those letters properly so the sliver closes, or separate them " +
            "enough to leave a real hole.",
          {
            name,
            floor_in: floor,
            floor_units: doc.scale ? floor / doc.scale : null,
            holes: holeData,
          },
        );
      }

      for (const wmsg of doc.warnings) {
        if (wmsg.toLowerCase().includes("no engrave lines")) {
          // Cut-only is the normal case for these fonts. Raising it per test name put
          // "This font has no engrave lines" into the repair prompt twice, as though
          // it were work to do.
          continue;
        }
        rep.add(
          NOTE,
          "engine-note",
          `engine note while building the test name ${pyRepr(name)}`,
          wmsg,
          "Informational — see the message.",
        );
      }
    } catch (exc) {
      rep.add(
        WARNING,
        "analysis-failed",
        `Could not fully analyse ${pyRepr(name)}`,
        excName(exc),
        "The name still builds; only this extra check failed.",
      );
    }
  }

  // ---- caps-only / unicase: lowercase draws the capital -------------- //
  // Sean hit this and reasonably read it as an app bug: the letter-pair sheet's
  // lowercase rows drew capitals. They were capitals -- the font maps every lowercase
  // codepoint to the same glyph as its capital. Saying so once, here, saves the
  // question being asked of the sheet.
  try {
    const low = "abcdefghijklmnopqrstuvwxyz";
    const pairs = [...low].map(
      (c) =>
        [c, font.cmap.get(c.codePointAt(0) as number), font.cmap.get(c.toUpperCase().codePointAt(0) as number)] as
          [string, number | undefined, number | undefined],
    );
    const have = pairs.filter((p) => p[1] !== undefined && p[2] !== undefined);
    const same = have.filter((p) => p[1] === p[2]).map((p) => p[0]);
    if (have.length && same.length === have.length) {
      rep.add(
        NOTE,
        "caps-only",
        "This font is caps-only: lowercase draws the capitals",
        "Every lowercase character maps to the same glyph as its capital, so 'adam' and " +
          "'ADAM' cut identically. Nothing is wrong with the font; it simply has no separate " +
          "lowercase.",
        "Nothing required. Expect the letter-pair sheet's lowercase rows to show capitals, " +
          "because that is what they are.",
      );
      rep.facts.push("caps-only font: all 26 lowercase map to the capital glyphs");
    } else if (same.length) {
      rep.facts.push(
        `${same.length} of ${have.length} lowercase letters map to their capital's glyph: ` +
          `${same.join("")}`,
      );
    }
  } catch {
    /* guarded per check, by design */
  }

  // ---- counters wound the wrong way: the letter cuts SOLID ----------- //
  try {
    const wrong = windingCheck(font);
    if (wrong.length) {
      const worst = wrong
        .slice(0, 8)
        .map((w) => `${w.glyph} (loses ${w.lost} of ${w.parity_holes})`)
        .join(", ");
      rep.add(
        ERROR,
        "wrong-winding",
        "Some counters are wound the wrong way, so those letters cut as solid metal",
        `${wrong.length} glyph(s) have a counter drawn in the SAME direction as the outline ` +
          `around it. Every measurement in this app treats a nested ring as a hole, but the ` +
          `cut path is built with a winding union, and a same-direction ring cancels instead ` +
          `of cutting. The hole is in the drawing and will not be in the metal: ${worst}.`,
        "In the font editor, reverse the direction of each counter so it runs opposite to the " +
          "contour containing it (most editors call this 'correct path direction' or 'set " +
          "PS/TT winding'). Do not move any points -- only the direction changes.",
        { glyphs: wrong },
      );
    }
    rep.facts.push(
      `winding check: ${wrong.length} glyph(s) whose counters would cancel in the cut`,
    );
  } catch {
    /* guarded per check, by design */
  }

  // ---- which letter PAIRS fail to join, across the whole alphabet ---- //
  if (joinScanBudget > 0) {
    try {
      const { failures, tested, truncated, total } = joinScan(font, joinScanBudget);
      rep.facts.push(
        `letter-join scan: ${tested} of ${total} combinations tested` +
          (truncated ? " (time limit reached)" : "") +
          `, ${failures.size} junction(s) disconnected`,
      );
      if (failures.size) {
        // sorted by the EXAMPLE string, as the Python's `key=lambda kv: kv[1]` does
        const items = [...failures.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        const shown = items
          .slice(0, 10)
          .map(([junction, ex]) => `${junction} (type ${pyRepr(ex)})`)
          .join("; ");
        const more = items.length > 10 ? ` …and ${items.length - 10} more` : "";
        rep.add(
          WARNING,
          "letter-gaps",
          `${failures.size} letter junction(s) do not join`,
          `Each of these leaves a gap, so a name containing it cuts as loose pieces instead ` +
            `of one plate: ${shown}${more}. Type the example next to a junction to see it in ` +
            `the preview.`,
          "Extend the left glyph's exit stroke until it crosses into the next letter. Note " +
            "some junctions only appear mid-word because the font swaps in a contextual form " +
            "— 'go' can be fine while 'ego' is not, so fix the form the example actually " +
            "uses.",
          {
            count: failures.size,
            junctions: junctionsFor(font, items.slice(0, JUNCTION_DETAIL), rep.scale),
            extra: items.slice(JUNCTION_DETAIL).map(([j, ex]) => [plain(j), ex] as [string, string]),
          },
        );
      }
      if (truncated) {
        rep.add(
          NOTE,
          "join-scan-partial",
          "Letter-join scan did not finish",
          `Only ${tested} of ${total} letter combinations were tested before the time limit. ` +
            `Untested combinations are not a pass.`,
          "The definitive check is the name itself: if a name cannot cut as one piece the " +
            "preview names the junction.",
        );
      }
    } catch (exc) {
      rep.add(
        NOTE,
        "join-scan-failed",
        "Letter-join scan did not run",
        excName(exc),
        "Other checks are unaffected.",
      );
    }
  }

  // Whether the font's letters join is only known after a name is built, and it
  // changes what has to be said about missing punctuation — an apostrophe that floats
  // clear of its neighbours cuts as a loose piece in a joining font.
  if (rep.meta.joins) {
    for (const f of rep.findings) {
      if (f.code === "missing-extras" || f.code === "missing-space") f.data.joins = true;
    }
  }

  return rep;
}

/** `%g`, for the one place the Python uses it. */
function pyG(v: number): string {
  const s = String(v);
  return s.includes("e") ? s : String(Number(v));
}

/** The module docstring, printed on a usage error exactly as the Python does. */
const USAGE = `
nameplate_fontcheck — say WHAT is wrong with a font, in words worth acting on.

    node src/fontcheck.ts "path/to/font.ttf" [more fonts...]

        --prompt          print a work order for whoever edits the font,
                          in font units, instead of the human report
        --no-join-scan    skip the letter-pair scan (the slow part)
        --budget=SECONDS  how long the letter-pair scan may take (default 25)
`.trimStart();

/**
 * The command line. Exit code is 1 when any font has an ERROR, 2 on a usage
 * problem, 0 otherwise — the same contract the Python's `main` has, because a
 * build script keys off it.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let wantPrompt = false;
  let budget = 25.0;
  const paths: string[] = [];
  for (const a of argv) {
    if (a === "--prompt" || a === "-p") {
      wantPrompt = true;
    } else if (a === "--no-join-scan") {
      // the letter-pair scan is the slow part by a wide margin; skipping it keeps
      // the per-name checks, and says so rather than passing silently
      budget = 0.0;
    } else if (a.startsWith("--budget=")) {
      const v = Number(a.split("=", 2)[1]);
      if (!Number.isFinite(v)) {
        console.log(`--budget wants a number of seconds, not ${pyRepr(a)}`);
        return 2;
      }
      budget = Math.max(0.0, v);
    } else if (a.startsWith("-")) {
      console.log(`unknown option ${pyRepr(a)}`);
      console.log(USAGE);
      return 2;
    } else {
      paths.push(a);
    }
  }

  if (!paths.length) {
    console.log(USAGE);
    return 2;
  }

  const { initSkia } = await import("./skia.ts");
  await initSkia();

  let worst = 0;
  for (const p of paths) {
    const rep = checkFont(p, { joinScanBudget: budget });
    if (wantPrompt) {
      // nothing but the block, so it can be piped straight to the clipboard
      console.log(rep.claudePrompt());
      console.log("");
    } else {
      console.log("=".repeat(78));
      console.log(rep.text());
      console.log("");
    }
    worst = Math.max(worst, rep.errors.length ? 1 : 0);
  }
  return worst;
}

// Compared as a resolved URL, not by basename. A basename test says "this module
// is the entry point" for ANY file with the same name — `tests/fontcheck.ts`
// importing `src/fontcheck.ts` matched, so the test run printed the CLI usage and
// exited before asserting anything.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}

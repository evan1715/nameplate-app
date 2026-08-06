/**
 * thickness.ts — where a name will SNAP, and what to tell the font.
 *
 * WHY THIS EXISTS
 *     A nameplate is cut out of sheet metal and then handled. The whole plate is
 *     only as strong as its narrowest piece of material: the ankle of an 'a', the
 *     waist of a script join, the wall left between an eyelet hole and the edge of
 *     the letter. If that piece is thinner than the metal can carry it snaps — on
 *     the laser bed, in the box, or in the customer's hand.
 *
 *     "This font is a bit thin" is not actionable. What is actionable is WHICH
 *     letter, WHERE on it, HOW thin, and by WHAT PERCENTAGE the font has to grow.
 *     The last of those is the reason this module exists at all: the fix belongs in
 *     the font, and whoever does it — a person or a model — works in FONT UNITS.
 *     So every number is given twice, in the shop's unit and in font units, and
 *     {@link claudePrompt} writes the whole thing out as an instruction that can be
 *     pasted straight to an AI that edits fonts.
 *
 * HOW THICKNESS IS MEASURED
 *     The same way eyelets.ts measures an eyelet wall: shoot a ray and see where it
 *     comes out. The material boundary is walked at evenly spaced points, and at
 *     each point a ray is cast along the INWARD normal until it leaves the
 *     material. That distance is the local thickness there — the length of metal a
 *     crack has to travel to break the plate at that spot.
 *
 *     LIMITS, honestly
 *       * A ray along the normal measures ACROSS the stroke, which is exactly what
 *         is wanted, but near a sharp corner (a serif tip, the apex of an 'A', the
 *         end of a script swash) it can read short: it crosses a wedge that tapers
 *         away to nothing rather than a stroke with any real width. Such readings
 *         are rejected by requiring the MIDDLE of the ray to sit at least
 *         {@link STRAIGHTNESS} x the measured width from the boundary — true when
 *         the two walls are roughly parallel, false inside a wedge. A tapered
 *         stroke still passes; a spike does not. It is not perfect: a wedge wide
 *         enough to look like a stroke is reported as one, which is arguably
 *         correct anyway.
 *       * Nothing thicker than {@link REACH_FRACTION} of the height being measured
 *         is recorded. It is not thin, and measuring it is wasted time.
 *       * Sampling is capped — see {@link MAX_SAMPLES}. One union contour can carry
 *         2000 points and there are usually several, so an uncapped walk would turn
 *         a preview into a wait. The cap is printed with the numbers.
 *       * Everything is measured on the FLATTENED outline the app actually cuts
 *         from, so a reading is good to about a font unit and no better.
 *
 * WHAT COUNTS AS ONE THIN SPOT
 *     A single thin ankle throws dozens of samples — both of its walls, all the way
 *     along it. Forty rows about one place would bury the second place. So samples
 *     are clustered per letter by proximity and each cluster is reported once, at
 *     its worst reading, carrying the number of samples behind it and its typical
 *     reading as well as its worst. A single freak sample is therefore visible as
 *     one instead of masquerading as a defect.
 *
 * HEIGHT
 *     Like leadin.ts, this module never touches doc.bbox, doc.scale or
 *     doc.basisHeight. It reads a finished Document and returns measurements, so the
 *     reported artwork size is the same whether you measure thickness or not.
 *
 * LETTER NAMES NEED THE FONT
 *     A Document does not carry its Font, and the eyelet and alternate forms only
 *     exist after shaping. So pass `font` (a Font or a path) to have each thin spot
 *     attributed to a letter. Without it the measurements are still correct; they
 *     are just located on the artwork rather than on a named letter.
 */

import * as path from "node:path";
import { Document, type Unit } from "./core.js";
import { Font, shape } from "./font.js";
import * as G from "./geom.js";
import * as LI from "./leadin.js";
import { glyphAreas } from "./fontcheck.js";
import { fmtF, fmtSigned, padLeft, padRight, pyG, wrapText } from "./pyformat.js";
import type { Point } from "./skia.js";
import * as EY from "./eyelets.js";

/**
 * Total boundary samples for the whole artwork, split between contours by length.
 * 900 is roughly one sample per 1/40 of a cap height on a normal name — fine
 * enough to find an ankle, coarse enough to finish in about a second.
 */
export const MAX_SAMPLES = 900;
/** Even a tiny counter gets looked at. */
export const MIN_RING_SAMPLES = 6;

/**
 * Nothing thicker than this fraction of the measured height is a thin spot, so the
 * ray stops there instead of running the length of a stem.
 */
export const REACH_FRACTION = 0.75;

/**
 * The wedge test. For a stroke with parallel walls the midpoint of the crossing
 * sits exactly half the width from both walls, so room/width == 0.50. In a wedge
 * the walls converge and the ratio falls. 0.42 accepts walls up to about 33 degrees
 * out of parallel, which keeps tapered script strokes and rejects serif tips and
 * apexes.
 */
export const STRAIGHTNESS = 0.42;

/**
 * Only the thinnest samples are clustered — clustering is O(n²) and the thick ones
 * are not the answer to any question here. {@link POOL_PER_GLYPH} guarantees every
 * letter still contributes its own worst spot, so a name with one very thin letter
 * does not hide the second-worst letter completely.
 */
export const POOL = 300;
export const POOL_PER_GLYPH = 4;

/**
 * Two samples belong to the same thin area when they are within this of each other:
 * a multiple of the local thickness (so the two walls of one stroke join up) or a
 * multiple of the sample spacing (so consecutive samples along one stroke join up),
 * whichever is larger.
 */
export const LINK_T = 1.6;
export const LINK_S = 2.5;

/**
 * …but an area may not sprawl further than this many times its own thickness from
 * its worst reading. Without the limit, a monoline script — where the whole letter
 * is the same weight — chains into a single "spot" covering the letter, which is the
 * mirror image of the problem clustering was added to solve.
 */
export const MAX_SPAN_T = 4.0;

/**
 * And a reading only joins an area if it is within this factor of the reading the
 * area started from. A thin serif slab sits right next to a thick stem, and without
 * this the area swallows the stem, which drags its typical reading up and makes the
 * thin place look like a stray measurement.
 */
export const THICK_TOL = 1.5;

/**
 * A uniform walk cannot see a web that is SHORT. Arc-length sampling spreads its
 * points around the whole boundary, so a neck only 18 font units long has almost no
 * arc to land on: on CHRISTOPHER at 1 in the nearest sample fell 47.7 fu away from
 * an 18.1 fu web between a counter wall and the outside edge, and the reported
 * minimum was 120.1 fu — 6.6x too thick, in the dangerous direction. Raising the
 * sample count does not fix it (28,800 samples still read +62% on ADAM); the web has
 * to be sought where it actually is.
 *
 * Real webs terminate at boundary VERTICES — they are formed by two features almost
 * meeting, and the almost-meeting points are nodes. So a second pass probes from
 * every vertex toward the nearest opposite wall. It reuses {@link crossWidth}, which
 * means the wedge test still applies: measured on the shipped fonts this pass found
 * 54/65/32 spikes and rejected every one of them at clearance ~0.00, so it adds real
 * webs without flooding the report with corner artifacts.
 *
 * The vertex pass uses the SAME wedge gate as the uniform walk. A stricter one was
 * tried and rejected: the two webs whose truth is double-derived (ADAM 72.76 fu,
 * CHRISTOPHER 18.13 fu) sit at clearance 0.4997 and 0.500, so every candidate gate
 * from 0.42 to 0.49 keeps them and the evidence cannot choose between them. Only a
 * third, single-sourced case moved, and picking a threshold to make one unverified
 * number agree is how a magic constant gets born. Instead the clearance ratio is
 * REPORTED per spot: 0.50 is a parallel-walled web that will snap, and a reading
 * nearer the gate is a taper into a junction, which you may reasonably choose to
 * leave alone. Judgement belongs to the reader, with the number in front of them.
 */
export const VERTEX_CEILING = 1.25;
/** Angular buckets: one per DIRECTION, not per distance. */
export const VERTEX_SECTORS = 16;
/** Ignore segments this close along the same ring. */
export const VERTEX_SKIP = 3;

/** One accepted reading: where it started, how thick, and where the ray left. */
interface Sample {
  p: Point;
  t: number;
  exit: Point;
  gi: number;
}

// --------------------------------------------------------------------------- //
//  the measurement
// --------------------------------------------------------------------------- //

/** The material, plus the lookups a thickness walk asks for over and over. */
class Solid {
  readonly material: G.Geometry;
  readonly prep: ReturnType<typeof G.prep>;
  readonly boundary: G.Geometry;
  /**
   * Absolute slack used for "did the ray really leave the material, or is this the
   * point it started from?".
   *
   * Derived from the ARTWORK's own size, not from the em. A Document from stack()
   * holds geometry already scaled into inches or millimetres with scale == 1, and
   * an em-derived slack of 0.2 there means 0.2 INCHES — which quietly rejected
   * every reading and reported a whole sheet as having no thin spot at all. The
   * artwork's span is the one measure that means the same thing in both frames.
   *
   * Never derived from the thickness being measured: a thin spot must not buy
   * itself a bigger tolerance in proportion to how thin it is.
   */
  readonly eps: number;

  constructor(material: G.Geometry, span: number) {
    this.material = material;
    this.prep = G.prep(material);
    this.boundary = G.boundary(material);
    this.eps = Math.max(span * 1e-5, 1e-12);
  }
}

/**
 * Every boundary ring of the material: outsides and holes alike.
 *
 * A hole's wall is material boundary too, and the wall between a counter and the
 * outside edge is exactly the kind of place that snaps.
 */
export function materialRings(material: G.Geometry): Point[][] {
  const out: Point[][] = [];
  for (const g of G.geoms(material)) {
    if (G.isEmpty(g) || G.geomType(g) !== "Polygon") continue;
    try {
      const ext = G.coords(G.exterior(g));
      out.push(ext.slice(0, -1)); // shapely's coords repeat the first point
      for (const r of G.interiors(g)) out.push(G.coords(r).slice(0, -1));
    } catch {
      continue;
    }
  }
  return out.filter((r) => r.length >= 3);
}

/** Perimeter of a closed ring. */
function ringLength(ring: Point[]): number {
  const n = ring.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * (point, normal) pairs spread around every boundary ring by arc length.
 *
 * Reuses leadin's `candidates`, which samples segment MIDPOINTS rather than
 * vertices — the same reason applies here as there. A corner has no meaningful
 * normal, and a long edge with no node in the middle is exactly where a thin waist
 * hides. It offers both normals per point; which of the two points into the
 * material is decided by measurement, not by trusting ring orientation.
 *
 * Its maxPts is a FLOOR, not a ceiling: it emits at least one sample per segment,
 * and a flattened script contour has thousands of segments shorter than the spacing
 * it works out. Asking for 900 on one such name produced 4000, so each ring's
 * samples are strided back down to the ring's share of the budget. The budget is
 * therefore honoured to within {@link MIN_RING_SAMPLES} per contour, which is what
 * keeps the walk under a second or two.
 */
function walk(rings: Point[][], samples: number): { out: LI.Candidate[]; total: number } {
  if (rings.length === 0) return { out: [], total: 0 };
  const lengths = rings.map((r) => Math.max(ringLength(r), 1e-9));
  const total = lengths.reduce((a, b) => a + b, 0);
  const out: LI.Candidate[] = [];
  for (let i = 0; i < rings.length; i++) {
    const k = Math.max(MIN_RING_SAMPLES, Math.round((samples * lengths[i]) / total));
    const cand = LI.candidates(rings[i], k);
    // candidates() emits the two opposite normals of a point back to back, so
    // thinning has to move in twos or half the points lose their inward one
    const pairs: LI.Candidate[][] = [];
    for (let j = 0; j < cand.length; j += 2) pairs.push(cand.slice(j, j + 2));
    let kept = pairs;
    if (pairs.length > k) {
      const stride = Math.ceil(pairs.length / k);
      kept = pairs.filter((_p, idx) => idx % stride === 0);
    }
    for (const pair of kept) out.push(...pair);
  }
  return { out, total };
}

/** Which of `sectors` angular buckets a direction falls in. */
function sectorOf(dx: number, dy: number, sectors: number): number {
  const k = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * sectors);
  return Math.min(Math.max(k, 0), sectors - 1);
}

/**
 * (point, inward normal) pairs anchored on boundary VERTICES.
 *
 * For each vertex, boundary segments within `ceiling` are found and the
 * perpendicular foot on each gives a direction to probe along. Only segments that
 * are not the vertex's own neighbours count, and only candidates closer than
 * `ceiling` are considered at all — this pass exists to look for material THINNER
 * than the uniform walk already found, so the search radius is small.
 *
 * ONE CANDIDATE PER DIRECTION, not the nearest N. Taking the nearest few segments
 * looks reasonable and is wrong: on ADAM the vertex at the D's notch had its six
 * nearest segments all within one degree of each other, so all six probes went the
 * same way and the web 72.8 fu away at -145 deg was never tried. Bucketing by angle
 * keeps the nearest candidate in each direction, so a crowd of near-parallel
 * neighbours cannot crowd out the one that matters — and it costs FEWER probes, not
 * more.
 *
 * `inside` is a cheap containment test. Most candidate directions point straight
 * across a COUNTER rather than through metal — the nearest boundary to a vertex is
 * very often the far side of a hole — and on a script name 25,721 directions yielded
 * 4 usable readings. Rejecting a direction whose chord midpoint is not in the
 * material costs a prepared-geometry point test instead of a ray/boundary
 * intersection.
 *
 * Yields directions, not measurements: whether a direction reads as a stroke or as a
 * wedge is {@link crossWidth}'s decision, exactly as for the uniform walk.
 */
function vertexProbes(
  rings: Point[][],
  ceiling: number,
  inside: ((x: number, y: number) => boolean) | null = null,
  sectors: number = VERTEX_SECTORS,
): [Point, Point][] {
  if (ceiling <= 0) return [];

  const segs: G.Geometry[] = [];
  const segRing: number[] = [];
  const segIdx: number[] = [];
  const ringN: number[] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    const n = ring.length;
    ringN.push(n);
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      segs.push(G.lineString([a, b]));
      segRing.push(ri);
      segIdx.push(i);
    }
  }
  if (segs.length === 0) return [];

  const verts: Point[] = [];
  const vRing: number[] = [];
  const vIdx: number[] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    rings[ri].forEach((v, i) => {
      verts.push(v);
      vRing.push(ri);
      vIdx.push(i);
    });
  }
  if (verts.length === 0) return [];

  const tree = new G.SpatialIndex(segs);
  const out: [Point, Point][] = [];
  for (let vpos = 0; vpos < verts.length; vpos++) {
    const pv = verts[vpos];
    const pvGeom = G.point(pv[0], pv[1]);
    const ri = vRing[vpos];
    const i = vIdx[vpos];
    const n = ringN[ri];
    const idxs = tree.withinDistance(pvGeom, ceiling);
    /** nearest candidate per direction sector */
    const best = new Map<number, { d: number; nvec: Point; q: Point }>();
    for (const j of idxs) {
      if (segRing[j] === ri) {
        // the vertex's own corner is not a web
        const raw = Math.abs(segIdx[j] - i);
        if (Math.min(raw, n - raw) <= VERTEX_SKIP) continue;
      }
      const seg = segs[j];
      const d = G.distance(seg, pvGeom);
      if (!(d > 0 && d <= ceiling)) continue;
      const q = G.nearestPointOnLine(seg, pvGeom);
      if (!q) continue;
      const dx = q[0] - pv[0];
      const dy = q[1] - pv[1];
      const L = Math.hypot(dx, dy);
      if (L <= 0) continue;
      const k = sectorOf(dx, dy, sectors);
      const hit = best.get(k);
      if (!hit || d < hit.d) best.set(k, { d, nvec: [dx / L, dy / L], q });
    }
    for (const { nvec, q } of best.values()) {
      if (inside && !inside((pv[0] + q[0]) / 2, (pv[1] + q[1]) / 2)) continue;
      out.push([pv, nvec]);
    }
  }
  return out;
}

/**
 * Thickness across the material at p along inward normal n, or null.
 *
 * null means "no honest reading here": the normal points out of the material (a
 * reflex vertex), nothing was crossed inside `reach` (so it is not thin), or the
 * crossing failed the wedge test described at the top of the file.
 *
 * @param straightness overrides the wedge gate for one call
 */
function crossWidth(
  solid: Solid,
  p: Point,
  n: Point,
  reach: number,
  straightness: number | null = null,
): number | null {
  const gate = straightness === null ? STRAIGHTNESS : straightness;
  const eps = solid.eps;
  if (!solid.prep.contains(G.point(p[0] + n[0] * eps, p[1] + n[1] * eps))) {
    return null; // this normal faces out, not in
  }

  const far: Point = [p[0] + n[0] * reach, p[1] + n[1] * reach];
  let hit: G.Geometry;
  try {
    hit = G.intersection(solid.boundary, G.lineString([p, far]));
  } catch {
    return null; // a self-touching ring here; skip it
  }
  if (G.isEmpty(hit)) return null;

  const ds: number[] = [];
  for (const g of G.geoms(hit)) {
    for (const c of G.coords(g)) {
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d > eps * 4) ds.push(d); // not the point we started from
    }
  }
  if (ds.length === 0) return null;

  for (const d of [...ds].sort((a, b) => a - b)) {
    // A ray can graze a cusp without leaving the material, which would read short.
    // The first crossing that counts is the first one with OUTSIDE just beyond it.
    if (solid.prep.contains(G.point(p[0] + n[0] * (d + eps), p[1] + n[1] * (d + eps)))) {
      continue;
    }
    const mid = G.point(p[0] + (n[0] * d) / 2, p[1] + (n[1] * d) / 2);
    let room: number;
    try {
      room = G.distance(solid.boundary, mid);
    } catch {
      return null;
    }
    if (room < gate * d) return null; // a wedge, not a stroke — see header
    return d;
  }
  return null;
}

// --------------------------------------------------------------------------- //
//  which letter, and where on it
// --------------------------------------------------------------------------- //
const UNI = /^u(?:ni)?([0-9A-Fa-f]{4,6})$/;

/**
 * The character a shaped glyph came from, as far as it can be worked out.
 *
 * The position in the string is tried FIRST, and only when it can be corroborated:
 * the character's own cmap glyph must have the same base name as the shaped glyph.
 * Going the other way round — glyph name back to a character — gets the case wrong
 * on a caps-only font, where 'o' and 'O' are the same glyph named 'O', and telling
 * someone to thicken 'O' when they typed 'o' is the kind of small lie that wastes an
 * afternoon.
 *
 * Failing that, a contextual form is not in the cmap at all ('A.eyeL', 'O.e21'), so
 * the suffix is dropped and the base looked up — preferring a character the name
 * actually contains. Fonts with a format 3.0 post table carry no useful glyph names
 * whatever, and there the raw position is the only handle there is; it is sound only
 * when shaping produced exactly one glyph per character, so that is checked.
 */
function sourceChar(
  rev: Map<string, string>,
  fwd: Map<string, string | undefined>,
  gname: string,
  text: string,
  placedI: number | null,
  nPlaced: number,
): string | null {
  const base = gname.split(".")[0];
  const chars = Array.from(text);
  const positional =
    placedI !== null && nPlaced === chars.length && placedI >= 0 && placedI < chars.length
      ? chars[placedI]
      : null;
  if (positional !== null) {
    const g = fwd.get(positional);
    if (g && g.split(".")[0] === base) return positional;
  }
  for (const key of [gname, base]) {
    const hit = rev.get(key);
    if (hit !== undefined) return hit;
  }
  const m = UNI.exec(base);
  if (m) {
    try {
      return String.fromCodePoint(parseInt(m[1], 16));
    } catch {
      /* not a codepoint after all */
    }
  }
  if (base.length === 1 && /[A-Za-z]/.test(base)) return base;
  return positional;
}

/** One shaped glyph's ink, ready for attribution. */
interface Letter {
  glyph: string;
  char: string | null;
  poly: G.Geometry;
}

/**
 * Each shaped glyph's name, source character and positioned filled polygon.
 *
 * Straight out of fontcheck's `glyphAreas`, which already shapes the text and places
 * each glyph's filled outline — the same shaping the artwork was built from, so a
 * contextual eyelet form is the shape that is actually being cut, not the plain
 * letter.
 */
function lettersOf(font: Font, text: string): Letter[] {
  let placed: { glyph: number }[];
  let areas: [string, G.Geometry][];
  try {
    placed = shape(font, text);
    areas = glyphAreas(font, text);
  } catch {
    return [];
  }

  const fwd = new Map<string, string | undefined>();
  for (const ch of new Set(Array.from(text))) {
    const gid = font.gidForChar(ch);
    fwd.set(ch, gid === undefined ? undefined : font.glyphName(gid));
  }
  const rev = new Map<string, string>();
  const inText = new Set(Array.from(text));
  for (const [cp, gid] of font.cmap) {
    const ch = String.fromCodePoint(cp);
    const gname = font.glyphName(gid);
    // a character from the name beats any other character that shares the glyph,
    // for the caps-only reason in sourceChar()
    const have = rev.get(gname);
    if (have === undefined || (inText.has(ch) && !inText.has(have))) rev.set(gname, ch);
  }

  // glyphAreas drops glyphs with no ink (a space), so its indices do not line up
  // with the shaped run. Walk both in order to recover each area's position in the
  // string, which is the last-resort source of the source character.
  const out: Letter[] = [];
  let j = 0;
  for (const [gname, poly] of areas) {
    while (j < placed.length && font.glyphName(placed[j].glyph) !== gname) j += 1;
    const pi = j < placed.length ? j : null;
    j += 1;
    out.push({
      glyph: gname,
      char: sourceChar(rev, fwd, gname, text, pi, placed.length),
      poly,
    });
  }
  return out;
}


/**
 * Index of the letter whose ink contains this point, or the nearest one.
 *
 * Nearest-with-a-tolerance rather than a plain containment test: the union outline is
 * rebuilt from curves after a boolean op while glyphAreas flattens each glyph
 * separately, so a boundary point can land a fraction of a unit outside the letter it
 * plainly belongs to.
 */
function whichLetter(letters: Letter[], pt: Point): number {
  const q = G.point(pt[0], pt[1]);
  for (let i = 0; i < letters.length; i++) {
    if (G.contains(letters[i].poly, q)) return i;
  }
  let best = -1;
  let bestD: number | null = null;
  for (let i = 0; i < letters.length; i++) {
    let d: number;
    try {
      d = G.distance(letters[i].poly, q);
    } catch {
      continue;
    }
    if (bestD === null || d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * "upper right", "bottom", "left side" — a place on the letter, in words.
 *
 * Read off the letter's OWN ink box, so "bottom" means the bottom of that letter and
 * not the bottom of the plate.
 */
function whereOn(pos: Point, bounds: [number, number, number, number]): string {
  const [x0, y0, x1, y1] = bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  const fx = w > 0 ? (pos[0] - x0) / w : 0.5;
  const fy = h > 0 ? (pos[1] - y0) / h : 0.5;
  const vert = fy < 0.28 ? "bottom" : fy > 0.72 ? "top" : "";
  const horiz = fx < 0.3 ? "left" : fx > 0.7 ? "right" : "";
  if (vert && horiz) return `${vert === "bottom" ? "lower" : "upper"} ${horiz}`;
  if (vert) return vert;
  if (horiz) return `${horiz} side`;
  return "middle";
}

/**
 * [(centre, hole radius)] for the eyelets, in doc.unit from the bottom-left.
 *
 * A wall next to an eyelet is the EYELET's wall: it is thin because the hardware
 * decides how big the hole is, and it belongs to eyelets.ts, not to the font's stroke
 * weight. Naming it stops the answer being "thicken the letter" when it is "move the
 * hole inboard or make it smaller".
 *
 * This is eyelets' own candidate test — round enough, square enough in the box, close
 * enough to an end — reusing its constants so the two cannot drift apart. Roundness
 * alone would not do: a square .notdef box scores 0.785 and the counter of an 'o'
 * scores higher still, so the box shape and the position along the artwork are both
 * needed.
 *
 * It deliberately stops there instead of calling measureEyelets(). That casts 240 rays
 * per eyelet and on a script name it cost more than this entire thickness walk (1.7s
 * of 1.9s), and nothing here needs an outer diameter: the only question is whether a
 * thin reading landed on an eyelet's wall. The eyelet tool stays the authority on what
 * the eyelet actually measures.
 */
function eyeletsOf(
  doc: Document,
  polys: G.Geometry[],
  depths: number[],
): [Point, number][] {
  const [x0, , x1] = doc.bbox;
  const width = Math.max(x1 - x0, 1e-9);
  const y0 = doc.bbox[1];
  const cands: [number, number, Point, number][] = [];
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    if (depths[i] % 2 !== 1 || G.isEmpty(p)) continue;
    try {
      const circ = circularityOf(p);
      if (circ < EY.CIRCULARITY_MIN) continue;
      const b = G.bounds(p);
      if (!b) continue;
      const [bx0, by0, bx1, by1] = b;
      const w = bx1 - bx0;
      const h = by1 - by0;
      if (w <= 0 || h <= 0 || Math.abs(w - h) / Math.max(w, h) > EY.ASPECT_TOL) continue;
      const cx = (bx0 + bx1) / 2;
      const cy = (by0 + by1) / 2;
      const frac = (cx - x0) / width;
      const nearEnd = Math.min(frac, 1 - frac);
      if (nearEnd > EY.END_FRACTION) continue;
      // These candidates are round by the test above, and for a round hole the
      // bounding box gives the radius directly — no inset search needed, which is the
      // other thing that would have cost real time.
      cands.push([
        nearEnd,
        -circ,
        [(cx - x0) * doc.scale, (cy - y0) * doc.scale],
        (Math.min(w, h) / 2) * doc.scale,
      ]);
    } catch {
      continue;
    }
  }
  cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return cands.slice(0, 2).map((c) => [c[2], c[3]] as [Point, number]); // a plate hangs from two
}

/** 4·pi·A / P² — eyelets.ts's own roundness measure, kept in step with it. */
function circularityOf(poly: G.Geometry): number {
  try {
    const p = G.length(poly);
    return p > 0 ? (4 * Math.PI * G.area(poly)) / (p * p) : 0;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------------------- //
//  results
// --------------------------------------------------------------------------- //

/**
 * One distinct thin area of the artwork.
 *
 * thickness/pos/across are physical, in `unit`. The font-unit versions are what a
 * font editor needs, and they are just the physical numbers divided by `scale` — a
 * ratio, so they hold at every cutting height, not only the one that was measured.
 */
/** The fields a {@link ThinSpot} is constructed from. */
export interface ThinSpotInit {
  unit: Unit;
  /** font units → unit. */
  scale: number;
  /** worst reading in this area */
  thickness: number;
  /** median reading in the same area */
  thickness_typical: number;
  /** from the artwork's bottom-left */
  pos: Point;
  /** the crossing */
  across: [Point, Point];
  /** glyph name, or "?" if no font given */
  glyph: string;
  /** source letter, when it is knowable */
  char: string | null;
  /** "upper right", "bottom", … */
  where: string;
  n_samples: number;
  /** how far the thin run reaches, in unit */
  extent: number;
  /**
   * How parallel the two walls are at the worst reading: the chord midpoint's
   * distance to the boundary, as a fraction of the chord. 0.50 means the walls are
   * parallel and this is a genuine web; lower means they converge, i.e. a taper into
   * a junction, and the reading is the width of a wedge rather than of a stroke.
   * Readings below {@link STRAIGHTNESS} are refused outright.
   */
  clearance: number;
  note: string;
}

/**
 * One distinct thin area of the artwork.
 *
 * thickness/pos/across are physical, in `unit`. The font-unit versions are what a
 * font editor needs, and they are just the physical numbers divided by `scale` — a
 * ratio, so they hold at every cutting height, not only the one that was measured.
 */
export class ThinSpot implements ThinSpotInit {
  unit: Unit;
  scale: number;
  thickness: number;
  thickness_typical: number;
  pos: Point;
  across: [Point, Point];
  glyph: string;
  char: string | null;
  where: string;
  n_samples: number;
  extent: number;
  clearance: number;
  note: string;

  constructor(init: ThinSpotInit) {
    this.unit = init.unit;
    this.scale = init.scale;
    this.thickness = init.thickness;
    this.thickness_typical = init.thickness_typical;
    this.pos = init.pos;
    this.across = init.across;
    this.glyph = init.glyph;
    this.char = init.char;
    this.where = init.where;
    this.n_samples = init.n_samples;
    this.extent = init.extent;
    this.clearance = init.clearance;
    this.note = init.note;
  }

  /** True when this is a web, not a taper — the snap risk that matters. */
  get parallel_walls(): boolean {
    return this.clearance >= 0.47;
  }

  /** A physical size back in font units. */
  fu(v: number): number {
    return this.scale ? v / this.scale : NaN;
  }

  get thickness_fu(): number {
    return this.fu(this.thickness);
  }

  get pos_fu(): Point {
    return [this.fu(this.pos[0]), this.fu(this.pos[1])];
  }

  /** How to refer to this spot's letter in one short phrase. */
  get letter(): string {
    if (this.char && this.glyph !== "?" && this.glyph !== this.char) {
      return `${this.char} (${this.glyph})`;
    }
    return this.char || this.glyph;
  }

  pct_increase(target: number): number {
    if (!this.thickness) return NaN;
    return (Number(target) / this.thickness - 1) * 100;
  }

  target_fu(target: number): number {
    return this.fu(Number(target));
  }
}

/** Everything a report needs, measured once. */
export class Survey {
  spots: ThinSpot[] = [];
  unit: Unit = "in";
  scale = 1.0;
  /** distinct thin areas found */
  n_areas = 0;
  /** of those, how many miss the target */
  n_below_target = 0;
  /** boundary points offered to the walk */
  samples_taken = 0;
  /** of those, how many gave a reading */
  samples_used = 0;
  /** measurement ceiling, in unit */
  reach = 0;
  letters_known = false;
  note = "";

  constructor(init: Partial<Survey> = {}) {
    Object.assign(this, init);
  }

  get thinnest(): number | null {
    return this.spots.length ? this.spots[0].thickness : null;
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
 * Group nearby samples so one thin ankle is one row, not forty.
 *
 * Each region grows out from the worst reading left unclaimed: neighbours join it
 * while they are within a link radius of something already in it, within
 * {@link MAX_SPAN_T} thicknesses of the reading it started from, and no more than
 * {@link THICK_TOL} times as thick as it. All three limits matter. Without the link
 * radius one ankle files forty rows; without the span limit a monoline script files
 * ONE row for a whole letter and the position on it is meaningless; without the
 * thickness limit a thin serif slab annexes the thick stem beside it and then reports
 * a typical thickness that belongs to the stem.
 *
 * Growing from the worst reading rather than from an arbitrary sample also puts the
 * reading a region reports at its centre, so the position printed beside a thickness
 * is the middle of that thin place and not the edge of a group.
 */
function regions(pool: Sample[], spacing: number): number[][] {
  const order = pool.map((_s, i) => i).sort((a, b) => pool[a].t - pool[b].t);
  const taken = new Array(pool.length).fill(false);
  const out: number[][] = [];
  for (const seed of order) {
    if (taken[seed]) continue;
    const t0 = pool[seed].t;
    const radius = Math.max(LINK_T * t0, LINK_S * spacing);
    const span = Math.max(MAX_SPAN_T * t0, 4.0 * spacing);
    const ceiling = THICK_TOL * t0;
    const [sx, sy] = pool[seed].p;
    taken[seed] = true;
    const members = [seed];
    const frontier = [seed];
    while (frontier.length) {
      const [px, py] = pool[frontier.pop()!].p;
      for (let j = 0; j < pool.length; j++) {
        if (taken[j] || pool[j].t > ceiling) continue;
        const [qx, qy] = pool[j].p;
        if (Math.hypot(px - qx, py - qy) > radius) continue;
        if (Math.hypot(sx - qx, sy - qy) > span) continue;
        taken[j] = true;
        members.push(j);
        frontier.push(j);
      }
    }
    out.push(members);
  }
  return out;
}

/**
 * Measure the artwork once and hand back the thin areas plus the context.
 *
 * {@link findThinSpots} is the short way in; this exists because a report wants to say
 * "14 areas are under target, here are the worst 8" and needs the 14.
 */
export function survey(
  doc: Document,
  target: number | null = null,
  samples: number = MAX_SAMPLES,
  topN = 8,
  font: Font | string | null = null,
): Survey {
  const unit = doc.unit;
  const scale = doc.scale;
  let f: Font | null = null;
  if (typeof font === "string") {
    try {
      f = new Font(font);
    } catch {
      f = null;
    }
  } else {
    f = font;
  }

  const ringList = LI.rings(doc);
  if (ringList.length === 0) {
    return new Survey({ unit, scale, note: "This name has no ink." });
  }
  let polys: G.Geometry[];
  let depths: number[];
  let material: G.Geometry;
  try {
    ({ polys, depths, material } = LI.analyse(ringList));
  } catch (exc) {
    return new Survey({
      unit, scale,
      note: `The outline could not be analysed (${(exc as Error).message}).`,
    });
  }
  if (G.isEmpty(material)) {
    return new Survey({ unit, scale, note: "This name has no material." });
  }

  const [x0, y0, x1, y1] = doc.bbox;
  // The artwork's own diagonal is the yardstick every tolerance here is built on,
  // because it is the one number that is in the same frame as the geometry whether
  // that geometry is in font units or already scaled (see Solid).
  const span = Math.hypot(x1 - x0, y1 - y0) || 1.0;
  const solid = new Solid(material, span);
  const mrings = materialRings(material);
  const { out: walkPts, total: perim } = walk(mrings, Math.max(Math.trunc(samples), 32));
  if (walkPts.length === 0) {
    return new Survey({ unit, scale, note: "The outline has no measurable edge." });
  }

  // Both normals of every sample point are offered, and only the inward one survives
  // crossWidth, so the true number of PLACES looked at is half.
  const places = Math.max(Math.floor(walkPts.length / 2), 1);
  const spacing = perim / places;
  const reach = Math.min(
    Math.max(REACH_FRACTION * doc.basisHeight, 0.05 * (y1 - y0)),
    span,
  );

  // Letter attribution is only meaningful for a single name. A stacked sheet holds
  // geometry already scaled into inches/mm while the glyph polygons that attribution
  // compares against are in font units, so containment never hits and the
  // nearest-glyph fallback silently blames the sheet's first letter for every spot —
  // including spots on a different name entirely. Better to report the position
  // honestly with no letter than to name the wrong one.
  const letters = f === null || isSheet(doc) ? [] : lettersOf(f, doc.text);

  const raw: Sample[] = [];
  for (const { anchor, normal } of walkPts) {
    const d = crossWidth(solid, anchor, normal, reach);
    if (d === null || d <= 0) continue;
    const exit: Point = [anchor[0] + normal[0] * d, anchor[1] + normal[1] * d];
    const gi = letters.length ? whichLetter(letters, anchor) : -1;
    raw.push({ p: anchor, t: d, exit, gi });
  }

  // ---- second pass: probe from the vertices ------------------------------- //
  // Bounded by what the uniform walk already found (and by the target, when one is
  // given, so the judge can still see spots around the target band).
  const thinSoFar = raw.length ? Math.min(...raw.map((s) => s.t)) : 0;
  let ceiling = thinSoFar * VERTEX_CEILING;
  if (target && scale) {
    ceiling = Math.max(ceiling, (Number(target) / scale) * VERTEX_CEILING);
  }
  if (ceiling > 0) {
    const seenProbe = new Set<string>();
    const inMetal = (x: number, y: number): boolean => {
      try {
        return solid.prep.contains(G.point(x, y));
      } catch {
        return true;
      }
    };
    for (const [p, nvec] of vertexProbes(mrings, ceiling, inMetal)) {
      const d = crossWidth(solid, p, nvec, reach);
      if (d === null || d <= 0 || d > ceiling) continue;
      const exit: Point = [p[0] + nvec[0] * d, p[1] + nvec[1] * d];
      // one reading per place: several vertices around the same neck all find it,
      // and eight copies of one web is not eight thin areas
      const key = `${round((p[0] + exit[0]) / 2, 1)},${round((p[1] + exit[1]) / 2, 1)}`;
      if (seenProbe.has(key)) continue;
      seenProbe.add(key);
      const gi = letters.length ? whichLetter(letters, p) : -1;
      raw.push({ p, t: d, exit, gi });
    }
  }

  if (raw.length === 0) {
    return new Survey({
      unit, scale, samples_taken: places,
      note: "Nothing in this artwork reads as a thin stroke.",
    });
  }

  // ---- pool: the thinnest overall, plus each letter's own worst ----------- //
  const order = raw.map((_s, i) => i).sort((a, b) => raw[a].t - raw[b].t);
  const poolIdx = new Set(order.slice(0, POOL));
  const per = new Map<number, number>();
  for (const i of order) {
    const g = raw[i].gi;
    const seen = per.get(g) ?? 0;
    if (seen < POOL_PER_GLYPH) {
      per.set(g, seen + 1);
      poolIdx.add(i);
    }
  }

  const byGlyph = new Map<number, Sample[]>();
  for (const i of Array.from(poolIdx).sort((a, b) => a - b)) {
    const g = raw[i].gi;
    const list = byGlyph.get(g);
    if (list) list.push(raw[i]);
    else byGlyph.set(g, [raw[i]]);
  }

  const eyelets = eyeletsOf(doc, polys, depths);

  const spots: ThinSpot[] = [];
  for (const [gi, group] of byGlyph) {
    for (const members of regions(group, spacing)) {
      const ms = members.map((k) => group[k]);
      const worst = ms.reduce((a, b) => (b.t < a.t ? b : a));
      const typical = median(ms.map((s) => s.t));
      // how far the thin run reaches, so "a 3 mm waist" and "3 mm all the way along
      // this stroke" do not read as the same finding
      const xs = [...ms.map((s) => s.p[0]), ...ms.map((s) => s.exit[0])];
      const ys = [...ms.map((s) => s.p[1]), ...ms.map((s) => s.exit[1])];
      const extent = Math.hypot(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      );

      let gname = "?";
      let char: string | null = null;
      let bounds: [number, number, number, number] = doc.bbox;
      if (gi >= 0 && gi < letters.length) {
        gname = letters[gi].glyph;
        char = letters[gi].char;
        const b = G.bounds(letters[gi].poly);
        bounds = b ?? doc.bbox;
      }

      // position: the middle of the crossing, which is the middle of the material —
      // a truer "where it is" than either wall
      const mx = (worst.p[0] + worst.exit[0]) / 2;
      const my = (worst.p[1] + worst.exit[1]) / 2;
      const across: [Point, Point] = [
        [(worst.p[0] - x0) * scale, (worst.p[1] - y0) * scale],
        [(worst.exit[0] - x0) * scale, (worst.exit[1] - y0) * scale],
      ];

      // Notes in order of what dominates the answer. "This glyph does not exist"
      // beats every other explanation, including the eyelet one — a .notdef box is a
      // square hole near the end of a short name, which is exactly what an eyelet
      // looks like from the outside.
      let note = "";
      if (gname.startsWith(".notdef")) {
        // A hollow rectangle has thin walls and will duly come top of this list, and
        // thickening it would be an entirely wasted afternoon: the font simply has no
        // glyph for that character. fontcheck reports the same defect from the font
        // side.
        note =
          "this is the missing-glyph box, not a letter — the font has no glyph for " +
          (char ? `'${char}'` : "this character") +
          ", so add that character rather than thickening anything";
      }
      // One end of the crossing sits on the hole's edge, so it is within the hole's
      // own radius of its centre; nothing but the eyelet wall is.
      if (!note) {
        for (const [[cx, cy], r] of eyelets) {
          if (across.some(([px, py]) => Math.hypot(px - cx, py - cy) <= r * 1.35)) {
            note =
              "the thinnest reading here is on the wall of an eyelet hole — that " +
              "wall belongs to the eyelet, so change the eyelet with the eyelet " +
              "tool rather than thickening the letter";
            break;
          }
        }
      }
      if (!note && ms.length === 1) {
        // Not a hedge about the method — a fact about this row. Every other row has
        // neighbouring readings agreeing with it; this one stands alone, so it is
        // either a very small feature or the last sample before one.
        note =
          "a single reading with nothing beside it to corroborate — a very small " +
          "feature, so confirm it on screen before acting on it";
      }

      // only for the spots that survive to the report, so this costs a handful of
      // distance() calls rather than one per sample
      let clear = 0;
      try {
        clear = G.distance(solid.boundary, G.point(mx, my)) / worst.t;
      } catch {
        clear = 0;
      }

      spots.push(
        new ThinSpot({
          unit, scale,
          thickness: worst.t * scale,
          thickness_typical: typical * scale,
          pos: [(mx - x0) * scale, (my - y0) * scale],
          across,
          glyph: gname,
          char,
          where: whereOn([mx, my], bounds),
          n_samples: ms.length,
          extent: extent * scale,
          clearance: clear,
          note,
        }),
      );
    }
  }

  spots.sort((a, b) => a.thickness - b.thickness);
  const nBelow = target
    ? spots.filter((s) => s.thickness < Number(target)).length
    : 0;
  return new Survey({
    spots: spots.slice(0, Math.max(Math.trunc(topN), 1)),
    unit, scale,
    n_areas: spots.length,
    n_below_target: nBelow,
    samples_taken: places,
    samples_used: raw.length,
    reach: reach * scale,
    letters_known: letters.length > 0,
  });
}

/**
 * The topN thinnest DISTINCT places in this artwork, thinnest first.
 *
 * @param doc     a finished Document; nothing on it is modified
 * @param target  the thickness you need, in doc.unit. Optional — it changes no
 *   measurement, it only lets the caller ask each spot for its `pct_increase()` and
 *   lets a report count how many places miss it.
 * @param samples how many boundary points to walk, in total, over every contour.
 *   Capped on purpose: see {@link MAX_SAMPLES}.
 * @param font    a Font or a font path. Without it the thin spots are still measured
 *   correctly but cannot be attributed to a named letter.
 */
export function findThinSpots(
  doc: Document,
  target: number | null = null,
  samples: number = MAX_SAMPLES,
  topN = 8,
  font: Font | string | null = null,
): ThinSpot[] {
  return survey(doc, target, samples, topN, font).spots;
}

// --------------------------------------------------------------------------- //
//  what it would look like fixed
// --------------------------------------------------------------------------- //

/**
 * Outline of the artwork if its thinnest place reached `target`.
 *
 * The material is grown by HALF the shortfall, because a stroke gains material on
 * both walls: dilating by (target - thinnest)/2 makes a crossing of `thinnest`
 * measure exactly `target`. Everything already thicker grows by the same amount,
 * which is what a font editor thickening a weight does too, so the preview is a fair
 * picture rather than a promise.
 *
 * Returned as closed outline polylines in doc.unit with the origin at the artwork's
 * bottom-left — the same frame as {@link ThinSpot.pos} — so it can be drawn straight
 * over the preview in another colour. Empty when there is nothing to show (no target,
 * or the artwork already passes).
 */
export function thickenPreview(
  doc: Document,
  target: number,
  thinnest: number | null = null,
  font: Font | string | null = null,
): Point[][] {
  if (!target || target <= 0) return [];
  if (thinnest === null) {
    thinnest = survey(doc, target, MAX_SAMPLES, 8, font).thinnest;
  }
  if (!thinnest || target <= thinnest) return [];

  const delta = (Number(target) - thinnest) / 2 / doc.scale; // font units
  let grown: G.Geometry;
  try {
    const { material } = LI.analyse(LI.rings(doc));
    // MITRE joins rather than round: these are letterforms, and a round join visibly
    // rounds off every serif and corner, so the overlay would read as a different
    // typeface instead of as this one thickened. The mitre limit keeps that honest —
    // at a very sharp apex an unlimited mitre shoots a spike far outside the letter,
    // so it is capped and the apex is bevelled instead.
    grown = G.bufferMitre(material, delta, 2.0);
  } catch {
    return [];
  }
  if (G.isEmpty(grown)) return [];

  const [x0, y0] = doc.bbox;
  const s = doc.scale;
  const out: Point[][] = [];
  for (const ring of materialRings(grown)) {
    out.push([
      ...ring.map(([x, y]) => [(x - x0) * s, (y - y0) * s] as Point),
      [(ring[0][0] - x0) * s, (ring[0][1] - y0) * s] as Point,
    ]);
  }
  return out;
}

// --------------------------------------------------------------------------- //
//  the human report
// --------------------------------------------------------------------------- //

/** "cap" → "cap height", for prose. */
function basisWords(basis: string): string {
  return (
    { cap: "cap height", xheight: "x-height", total: "overall artwork height" } as Record<
      string,
      string
    >
  )[basis] ?? `${basis} height`;
}

/**
 * True for a Document from core's `stack()`.
 *
 * A stacked sheet holds geometry ALREADY scaled into inches or millimetres, with
 * scale == 1 standing in for "no conversion left to do". Its thicknesses are
 * therefore real and correct, but dividing them by scale does not give font units —
 * it gives the same number back. Anything that would print or act on a font-unit
 * figure has to know that, or it states a size in font units that is out by three
 * orders of magnitude.
 */
export function isSheet(doc: Document): boolean {
  return doc.basis === "sheet";
}

/** The thin spots as text for a dialog or the console. */
export function reportText(
  doc: Document,
  target: number | null = null,
  spots: ThinSpot[] | null = null,
  font: Font | string | null = null,
  sv: Survey | null = null,
): string {
  if (sv === null) {
    if (spots === null) {
      sv = survey(doc, target, MAX_SAMPLES, 8, font);
    } else {
      sv = new Survey({
        spots: [...spots], unit: doc.unit, scale: doc.scale,
        n_areas: spots.length, letters_known: true,
        n_below_target: target
          ? spots.filter((s) => s.thickness < Number(target)).length
          : 0,
      });
    }
  }
  const u = sv.unit;
  const [w, h] = doc.size();
  const L = [`${doc.text} — ${fmtF(w, 3)} x ${fmtF(h, 3)} ${u}`, ""];

  if (sv.spots.length === 0) {
    L.push(
      "No thin spot found.",
      "",
      sv.note ||
        `Nothing in this artwork reads as a thin stroke — every crossing came ` +
          `out thicker than the ${fmtF(sv.reach, 3)} ${u} ceiling this ` +
          `measurement uses.`,
    );
    return L.join("\n");
  }

  L.push("THINNEST PARTS OF THE ARTWORK");
  L.push(
    `    measured across the stroke at ${sv.samples_used} of ` +
      `${sv.samples_taken} points walked around the outline`,
  );
  if (!sv.letters_known) {
    L.push(
      "    letters not named: pass the font to attribute each spot to a letter",
    );
  }
  L.push("");
  // On a stacked sheet the geometry is already in inches/mm, so "font units" do not
  // exist — printing a rounded number and telling the reader to ignore it invites
  // misreading. The columns are simply absent instead.
  const sheet = isSheet(doc);
  let head =
    `    ${padLeft("#", 2)}  ${padRight("letter", 16)} ${padRight("where", 12)} ` +
    `${padLeft("thinnest", 10)} ${padLeft("typical", 9)}` +
    (sheet ? "" : ` ${padLeft("font u", 8)}`);
  if (target) {
    head += (sheet ? "" : ` ${padLeft("want", 8)}`) + ` ${padLeft("increase", 9)}`;
  }
  L.push(head);
  sv.spots.forEach((s, i) => {
    // a flourish glyph can be called 'eflourishrightring'; let it break the column
    // and the whole table stops lining up
    const who = s.letter.length <= 16 ? s.letter : s.letter.slice(0, 15) + "…";
    let row =
      `    ${padLeft(String(i + 1), 2)}  ${padRight(who, 16)} ` +
      `${padRight(s.where, 12)} ${padLeft(fmtF(s.thickness, 4), 10)} ` +
      `${padLeft(fmtF(s.thickness_typical, 4), 9)}` +
      (sheet ? "" : ` ${padLeft(fmtF(s.thickness_fu, 1), 8)}`);
    if (target) {
      const pct = s.pct_increase(target);
      // a negative "increase" is just "already thick enough", and reads as an
      // instruction to make it thinner if it is printed as a number
      if (!sheet) row += ` ${padLeft(fmtF(s.target_fu(target), 1), 8)}`;
      row += pct > 0 ? ` ${padLeft(fmtSigned(pct, 2), 8)}%` : ` ${padLeft("ok", 9)}`;
    }
    L.push(row);
  });
  if (sheet) {
    L.push(
      `    (thinnest/typical in ${u}. This is a stacked sheet, so there are no font-unit`,
    );
    L.push(
      "     figures — measure a single name to get numbers to hand a font editor.)",
    );
  } else {
    L.push(
      `    (thinnest/typical in ${u}; 'font u' columns are font units, which is ` +
        `what a font editor works in)`,
    );
  }
  L.push("");

  sv.spots.forEach((s, i) => {
    L.push(`    ${padLeft(String(i + 1), 2)}  ${s.letter} — ${s.where}`);
    const fu = sheet ? "" : ` (${fmtF(s.thickness_fu, 1)} font units)`;
    L.push(
      `          ${fmtF(s.thickness, 4)} ${u}${fu} across, at ` +
        `${fmtF(s.pos[0], 3)}, ${fmtF(s.pos[1], 3)} ${u} from the bottom-left`,
    );
    L.push(
      `          from ${s.n_samples} reading(s) over about ` +
        `${fmtF(s.extent, 3)} ${u} of stroke`,
    );
    if (target) {
      const pct = s.pct_increase(target);
      const tfu = sheet ? "" : ` (${fmtF(s.target_fu(target), 1)} font units)`;
      if (pct > 0) {
        L.push(
          `          needs ${fmtF(Number(target), 4)} ${u}${tfu} — ` +
            `thicken by ${fmtSigned(pct, 2)}%`,
        );
      } else {
        L.push(
          `          already past your ${fmtF(Number(target), 4)} ${u}${tfu} — leave it`,
        );
      }
    }
    if (s.note) L.push(`          note: ${s.note}`);
  });
  L.push("");

  if (target) {
    L.push(`AGAINST YOUR TARGET OF ${fmtF(Number(target), 4)} ${u}`);
    if (sv.n_below_target) {
      L.push(
        `    ${sv.n_below_target} of ${sv.n_areas} distinct areas are thinner ` +
          `than that; the ${sv.spots.length} worst are listed above.`,
      );
      if (sheet) {
        // a sheet's scale is 1 unit = 1 inch/mm, so "font units" here would just
        // restate the physical number and mislead
        L.push(
          "    Measure a single name to get the font-unit target to hand a font editor.",
        );
      } else {
        L.push(
          `    In font units the target is ` +
            `${fmtF(Number(target) / sv.scale, 1)} at this height, and that ` +
            `number holds at every height.`,
        );
        L.push(
          "    Hand claude_prompt() to whoever edits the font — one instruction " +
            "covers all of them.",
        );
      }
    } else {
      L.push(
        `    Every one of the ${sv.n_areas} areas measured is at or above it. ` +
          `Nothing to thicken.`,
      );
    }
    L.push("");
  }

  L.push(
    "Thickness is measured across the stroke: a ray is cast inward from the " +
      "edge until it leaves the material.",
  );
  L.push(
    "'thinnest' is the worst reading in that area and is the number that " +
      "decides whether it snaps; 'typical' is the middle reading for the same " +
      "area, so a lone freak reading is visible as one.",
  );
  L.push(
    "Readings that cross a wedge rather than a stroke — a serif tip, an apex, " +
      "the end of a swash — are dropped, because thickening the font would not " +
      "fix them.",
  );
  return L.join("\n");
}

// --------------------------------------------------------------------------- //
//  the instruction to hand an AI that edits the font
// --------------------------------------------------------------------------- //

/**
 * Prompts are pasted into other tools and must be plain ASCII. Sanitising at the
 * BOUNDARY rather than at every source, because the text is assembled from notes and
 * letter names written all over this module: an em dash added to a note a year from
 * now would otherwise quietly break the contract again. The selftest missed exactly
 * that — it only checked prompt blocks that were non-empty in its own run, and the
 * thin-area block is empty unless a target is typed.
 */
const ASCII_MAP: [string, string][] = [
  ["—", " - "], ["–", "-"], ["’", "'"], ["‘", "'"],
  ["“", '"'], ["”", '"'], ["·", "-"], ["…", "..."],
  ["×", "x"], ["→", "->"], ["°", " deg"],
  ["ø", "dia"], ["Ø", "dia"], ["≥", ">="],
  ["≤", "<="], ["±", "+/-"], [" ", " "],
];

/** Plain ASCII, so a prompt pastes into anything without mangled bytes. */
export function asciiOnly(text: string): string {
  let out = text;
  for (const [bad, good] of ASCII_MAP) out = out.split(bad).join(good);
  // Python's `.encode("ascii", "replace")` substitutes '?' for anything left
  return Array.from(out)
    .map((ch) => (ch.codePointAt(0)! < 128 ? ch : "?"))
    .join("");
}

/**
 * The paste-ready instruction, from thin spots already measured.
 *
 * Same output as {@link claudePrompt}; this one exists so a caller that has just
 * drawn the spots on screen does not pay for the measurement twice.
 */
export function claudePromptFromSpots(
  doc: Document,
  target: number,
  spotsIn: ThinSpot[],
  fontPath: string | null = null,
  nAreas: number | null = null,
  nBelowTarget: number | null = null,
): string {
  const u = doc.unit;
  const s = doc.scale;
  const spots = [...spotsIn];
  if (!target || Number(target) <= 0) {
    return (
      "No target thickness was given, so there is nothing to ask for. " +
      "Set the thickness this metal needs (for example 0.060 in) and run this again."
    );
  }
  target = Number(target);
  if (isSheet(doc)) {
    // Refuse rather than emit font-unit sizes that are out by a factor of a thousand.
    // Being wrong here is worse than being unavailable: the whole value of this block
    // is that its numbers can be acted on without checking them.
    return (
      "This document is a stacked sheet of several names, whose geometry is " +
      `already scaled into ${u}, so there is no font-unit conversion to state ` +
      "and any size given here would be wrong. Measure ONE name at the height " +
      "it will be cut, then ask for the prompt again."
    );
  }
  if (spots.length === 0) {
    return (
      `Nothing in '${doc.text}' measures thinner than the ${fmtF(target, 4)} ${u} ` +
      `you asked for, so the font needs no change for this name at this size.`
    );
  }

  const fu = (v: number): number => (s ? v / s : NaN);
  const req = Math.ceil(fu(target)); // whole font units, up
  const worst = spots[0];
  const biggestPct = Math.max(...spots.map((sp) => sp.pct_increase(target)));
  const fname = fontPath ? path.basename(fontPath) : null;
  const below = spots.filter((sp) => sp.thickness < target);
  if (below.length === 0) {
    return (
      `Every thin area of '${doc.text}' is already at or above ` +
      `${fmtF(target, 4)} ${u} (${fmtF(fu(target), 1)} font units), so the font ` +
      `needs no change for this name at this size.`
    );
  }

  const L: string[] = [
    "FONT THICKENING REQUEST  -  ShineOn nameplate, laser-cut sheet metal",
    "",
  ];
  if (fname) {
    L.push(`FONT FILE      ${fname}`);
  } else {
    L.push(`FONT FAMILY    ${doc.fontFamily}`);
    L.push(
      "               (the file name was not supplied  -  this is the family " +
        "name reported by the font)",
    );
  }
  L.push(`unitsPerEm     ${doc.upem}`);
  L.push(`NAME TESTED    ${doc.text}`);
  L.push(`CUT AT         ${pyG(doc.targetHeight)} ${u} ${basisWords(doc.basis)}`);
  L.push("");

  // The caller may have measured more areas than it handed over; the honest count of
  // what is wrong is the one it counted, not the length of this list.
  const nUnder = Math.max(Math.trunc(nBelowTarget ?? 0), below.length);
  L.push("THE PROBLEM");
  L.push("  This name is cut out of sheet metal. Any part of a letter that is too");
  L.push("  thin snaps off when the plate is handled. At the size above, the thinnest");
  L.push(
    `  material in the artwork measures ${fmtF(worst.thickness, 4)} ${u} and it has to be at`,
  );
  L.push(
    `  least ${fmtF(target, 4)} ${u}. ${nUnder} separate area(s) are under that` +
      (nAreas ? `, of ${nAreas} measured.` : "."),
  );
  L.push("");

  L.push("ALL SIZES BELOW ARE IN FONT UNITS");
  L.push("  A font editor works in font units, not in inches or millimetres, so every");
  L.push(`  size here is in font units of this font's ${doc.upem}-unit em square.`);
  L.push(
    `  The conversion used is the one for this job: ${pyG(doc.targetHeight)} ${u} of ` +
      `${basisWords(doc.basis)} is`,
  );
  L.push(
    `  ${fmtF(doc.basisHeight, 0)} font units, so 1 font unit = ${fmtF(s, 6)} ${u}, and the`,
  );
  L.push(
    `  ${fmtF(target, 4)} ${u} minimum is ${fmtF(fu(target), 1)} font units  -  ` +
      `round up to ${req}.`,
  );
  L.push("  A thickness in font units is a proportion of the letter, so fixing it");
  L.push("  here fixes it at every size the name is ever cut. Do not convert these");
  L.push("  numbers back into inches or millimetres.");
  L.push("");

  L.push("THE THIN AREAS, THINNEST FIRST");
  below.forEach((sp, i) => {
    let who = sp.glyph !== "?" ? `glyph '${sp.glyph}'` : "glyph unknown";
    if (sp.char) who += ` (the letter ${sp.char})`;
    L.push(`  ${i + 1}. ${who}  -  ${sp.where} of the letter`);
    L.push(
      `     now ${fmtF(sp.thickness_fu, 1)} font units across, needs ${req} font units ` +
        `(${fmtSigned(sp.pct_increase(target), 1)}%)`,
    );
    if (sp.note) {
      // this block is read as a document, not scanned in a table, so the notes are
      // wrapped rather than left to run off the side
      L.push(...wrapText(sp.note, 74, "     note: ", "           "));
    }
  });
  if (nUnder > below.length) {
    L.push(
      `  ...and ${nUnder - below.length} more area(s) under the minimum, not ` +
        `listed one by one.`,
    );
    L.push("  The instruction below covers those as well  -  it is a rule, not a list.");
  }
  L.push("");

  L.push("THE INSTRUCTION");
  L.push(`  Thicken every stroke thinner than ${req} font units up to ${req} font units`);
  L.push(
    `  (an increase of up to ${fmtF(biggestPct, 0)}% at the worst place), keeping the outer`,
  );
  L.push("  silhouette and the counters' positions.");
  L.push("");
  L.push("  In plain terms: measure across each stroke listed above; where that");
  L.push(`  measurement is under ${req} font units, move the INNER wall of the stroke`);
  L.push(`  (the counter side) until it measures ${req}. The outside edge of the letter`);
  L.push("  stays exactly where it is, and each counter stays in the same place and");
  L.push("  keeps its shape  -  it may end up slightly smaller, and that is expected.");
  L.push("  Blend into the thicker part of the same stroke either side of the thin");
  L.push("  place so there is no step, kink or lump where the change ends.");
  L.push(`  Leave every stroke that already measures ${req} font units or more alone.`);
  L.push("");

  L.push("WHAT MUST NOT CHANGE");
  L.push("  * the advance width of any glyph, and all kerning and spacing: the name");
  L.push("    must occupy exactly the same width, so the cut file does not resize");
  L.push("  * the cap height, x-height, ascender, descender and baseline");
  L.push("  * the outer silhouette of each letter  -  no letter may get taller, wider");
  L.push("    or a different shape; this is a local thickening, not a new weight");
  L.push("  * the eyelet holes: their diameter, roundness and position are set by the");
  L.push("    hanging hardware. Do not resize, move or reshape any eyelet hole, and do");
  L.push("    not thicken a stroke by eating into one");
  L.push("  * the contextual and alternate glyph set: keep every alternate and eyelet");
  L.push("    form (.eyeL / .eyeR and similar), keep every glyph name, and do not add,");
  L.push("    remove or re-order glyphs. Leave the GSUB/calt/liga/kern rules exactly as");
  L.push("    they are, so the same name still shapes to the same glyphs");
  L.push("  * the colour/engrave layers (COLR and CPAL) and the unitsPerEm");
  L.push("  * anything not on the list above. Do not tidy, redraw, re-interpolate or");
  L.push("    otherwise improve the font while you are in there  -  the only change is");
  L.push("    the thickness of the strokes named above.");
  L.push("");

  L.push("HOW IT WILL BE CHECKED");
  const cmd = fname ? fname : "<font>";
  L.push(
    `  npx tsx src/thickness.ts ${cmd} "${doc.text}" ${pyG(doc.targetHeight)} ` +
      `${u} ${doc.basis} ${pyG(target)}`,
  );
  L.push(`  Every area it lists must read ${req} font units or more, and the artwork`);
  L.push("  size it prints must be unchanged from before the edit.");
  return asciiOnly(L.join("\n"));
}

/**
 * The block Sean pastes to an AI that edits the font.
 *
 * Unambiguous on purpose: it names the file and its em size, states that every size is
 * in font units and how that conversion was reached, lists each thin area with the
 * letter it is on and the increase it needs, gives ONE instruction that covers all of
 * them, and then says what must not change so the edit does not turn into a redesign.
 * Plain text, no markdown, safe to paste anywhere.
 *
 * `fontPath` is used both to name the file and, if `font` was not given, to load the
 * font so the letters can be named.
 */
export function claudePrompt(
  doc: Document,
  target: number,
  fontPath: string | null = null,
  font: Font | string | null = null,
  topN = 8,
): string {
  const sv = survey(doc, target, MAX_SAMPLES, topN, font ?? fontPath);
  return asciiOnly(
    claudePromptFromSpots(doc, target, sv.spots, fontPath, sv.n_areas, sv.n_below_target),
  );
}

/** Python's `round(v, n)`, for the probe de-duplication key. */
function round(v: number, n: number): number {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

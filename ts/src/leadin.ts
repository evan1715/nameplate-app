/**
 * leadin.ts — laser lead-in lines, the way CorelDRAW wants them.
 *
 * WHAT A LEAD-IN IS HERE, AND WHY IT IS MERGED INTO THE CONTOUR
 *     The laser pierces out in the scrap and travels in along a short approach
 *     before it reaches the part, so the pierce mark never lands on a finished
 *     edge.
 *
 *     CorelDRAW has no notion of a lead-in — it is an illustration program, and
 *     lead-in/lead-out is a feature of laser software (LightBurn generates them
 *     from Angle/Length/Style settings) or of a CAM plugin. Crucially, laser
 *     software treats every path in a file as its own separate cut and does NOT
 *     join a stray open line onto a nearby closed contour.
 *
 *     So a lead-in drawn as its own little line does not work: the machine would
 *     cut that line in the scrap, then separately pierce the closed contour on the
 *     finished edge — exactly the mark the lead-in was meant to avoid.
 *
 *     Therefore a contour that gets a lead-in is emitted as ONE continuous OPEN
 *     path: pierce point -> anchor on the contour -> all the way round -> back to
 *     the anchor. Any software that simply follows the path then starts in the
 *     scrap and flows into the outline. Contours with no lead-in stay closed.
 *     See {@link mergeRun}. Nothing is lost: runs + closed == every contour, and
 *     the total contour length is unchanged.
 *
 *     If your laser software has its own lead-in feature, prefer it and leave this
 *     switched off, or you will get two lead-ins.
 *
 * WHERE THEY GO
 *     * every hole (letter counters, eyelet holes)  -> lead-in lies INSIDE the
 *       hole, i.e. in the waste that drops out
 *     * the outer boundary                          -> one lead-in, OUTSIDE the
 *       part, in the surrounding scrap
 *     * never anywhere inside the material of the name itself
 *
 * CLEARANCE — why a lead-in is not just "doesn't touch the letter"
 *     Not crossing the material is not enough. A lead-in running a thousandth of
 *     an inch alongside an edge will still scorch or cut it, because the beam has
 *     width and a heat-affected zone. So every lead-in must also keep a standoff
 *     from ALL material along its length, and it leaves the contour at 90 degrees
 *     so it departs the edge as directly as possible. The only place it is allowed
 *     to be near material is the last fraction next to its own anchor point,
 *     where touching the contour is the entire purpose.
 *
 * ADAPTIVE LENGTH — small counters like 'e', 'a', 'o'
 *     The length is not guessed from a fixed ladder. For each candidate entry
 *     point the search measures how far it can actually travel while holding the
 *     standoff, by bisection, and takes the best position on the contour. A tight
 *     counter therefore gets the longest clear lead-in that genuinely fits rather
 *     than a coarse fraction or nothing at all. If even the standoff cannot be
 *     honoured, it is relaxed in steps before anything is given up.
 *
 * HEIGHT
 *     This module never touches doc.bbox, doc.basisHeight, doc.scale or
 *     doc.size(). It reads a finished Document and returns extra polylines. The
 *     reported artwork size is therefore identical whether lead-ins are on or off.
 *     The only thing that can change is the exported page/canvas size, and only
 *     when an outer lead-in would otherwise be clipped — see {@link docForExport}.
 */

import {
  Document,
  MM_PER_IN,
  pdfDocument,
  stack,
  svgSingle,
} from "./core.ts";
import * as G from "./geom.ts";
import type { Point } from "./skia.ts";

/** A sane default lead-in, in inches. */
export const DEFAULT_LEN_IN = 0.1;
/** …and in mm. */
export const DEFAULT_LEN_MM = 2.5;

/**
 * Standoff kept from every letter edge along the lead-in's length. Roughly a
 * kerf plus its heat-affected zone.
 */
export const CLEARANCE_IN = 0.012;
export const CLEARANCE_MM = 0.3;

/**
 * If the full standoff will not fit, relax it in these steps so a tight counter
 * still gets a lead-in — but never below {@link HARD_CLEARANCE_IN}. That floor is
 * what stops a sub-kerf sliver being "served" by a lead-in running along its
 * wall: below it there is no safe entry, so the hole is exempted instead.
 */
const CLEAR_STEPS = [1.0, 0.65, 0.4] as const;
export const HARD_CLEARANCE_IN = 0.004;
export const HARD_CLEARANCE_MM = 0.1;

/**
 * Below this a lead-in is finer than the kerf, so the "hole" it would sit in is
 * not something the laser can cut anyway. Merging overlapping letters can leave
 * slivers this small; they are reported as skipped, never silently dropped.
 */
export const MIN_LEAD_IN = 0.008;
export const MIN_LEAD_MM = 0.2;

/** Candidate entry points per contour. */
const SAMPLES = 56;
/** Bisection steps when measuring usable length. */
const BISECT = 14;

/**
 * A tiny ABSOLUTE slack in font units. Everything that needs "did this really
 * touch the material, or is it just floating-point noise at the anchor?" uses
 * this. It must never be derived from the requested lead-in length: doing so meant
 * a long requested lead-in bought itself permission to cut through the part, in
 * proportion to how long it was asked to be.
 */
const EPS_FU = 1e-6;

/** The default lead-in length for a unit. */
export function defaultLength(unit: string): number {
  return unit === "mm" ? DEFAULT_LEN_MM : DEFAULT_LEN_IN;
}

/** The default standoff for a unit. */
export function defaultClearance(unit: string): number {
  return unit === "mm" ? CLEARANCE_MM : CLEARANCE_IN;
}

/** The standoff floor for a unit — never relaxed past this. */
export function hardClearance(unit: string): number {
  return unit === "mm" ? HARD_CLEARANCE_MM : HARD_CLEARANCE_IN;
}

/** The shortest lead-in worth cutting, for a unit. */
export function minLength(unit: string): number {
  return unit === "mm" ? MIN_LEAD_MM : MIN_LEAD_IN;
}

// --------------------------------------------------------------------------- //
//  contour analysis
// --------------------------------------------------------------------------- //

/** Every cut ring of this document with at least three points. */
export function rings(doc: Document): Point[][] {
  return doc.cutPaths.flatMap((rs) => rs.filter((ring) => ring.length >= 3));
}

/** What {@link analyse} works out about a set of rings. */
export interface Analysis {
  /** One polygon per ring, repaired if self-intersecting. */
  polys: G.Geometry[];
  /** Nesting depth per ring: even = solid boundary, odd = hole. */
  depths: number[];
  /** The material area — solid minus holes, peeled depth by depth. */
  material: G.Geometry;
}

/**
 * Polygon per ring, nesting depth per ring, and the material area.
 *
 * depth 0 (even) = solid boundary, depth 1 (odd) = hole, and so on.
 */
export function analyse(ringList: Point[][]): Analysis {
  const polys: G.Geometry[] = ringList.map((r) => {
    let p = G.polygon(r);
    if (!G.isValid(p)) p = G.buffer(p, 0);
    return p;
  });

  // Nesting is measured with points taken from the ring ITSELF, not from
  // representativePoint(): a ring-only polygon includes its own counter, so the
  // outer contour of an 'O' has a representative point sitting inside the hole,
  // and the outer contour gets misread as a hole. Several vertices are sampled so
  // a single tangent vertex cannot flip the answer.
  const depths: number[] = [];
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    const ring = ringList[i];
    if (G.isEmpty(p)) {
      depths.push(0);
      continue;
    }
    const step = Math.max(1, Math.floor(ring.length / 5));
    const probes: G.Geometry[] = [];
    for (let k = 0; k < ring.length && probes.length < 5; k += step) {
      probes.push(G.point(ring[k][0], ring[k][1]));
    }
    let depth = 0;
    for (let j = 0; j < polys.length; j++) {
      if (j === i || G.isEmpty(polys[j])) continue;
      if (probes.some((pt) => G.contains(polys[j], pt))) depth += 1;
    }
    depths.push(depth);
  }

  // Build the mask by ALTERNATING in ascending depth order, not as one
  // union-of-evens minus union-of-odds.
  //
  // A hole ring covers everything nested inside it, so subtracting all the odd
  // rings at once deletes any depth-2 island as well: the island is inside the
  // depth-1 hole, so the difference removes it. Every safety check downstream then
  // sees empty space where a solid part actually sits, and a lead-in is free to
  // run straight through it. Measured on the shipped TGCarrie fonts, reachable by
  // typing (c) or (R): a lead cut 0.0318 in and 0.0807 in of real material,
  // silently breaking this module's one hard promise.
  //
  // Peeling depth by depth is the same expression for max depth <= 1 -- which is
  // every letter of every name -- so ordinary artwork is bit-identical.
  const byDepth = new Map<number, G.Geometry[]>();
  for (let i = 0; i < polys.length; i++) {
    if (G.isEmpty(polys[i])) continue;
    const group = byDepth.get(depths[i]);
    if (group) group.push(polys[i]);
    else byDepth.set(depths[i], [polys[i]]);
  }
  let material = G.emptyPolygon();
  for (const d of Array.from(byDepth.keys()).sort((a, b) => a - b)) {
    const layer = G.unaryUnion(byDepth.get(d)!);
    if (G.isEmpty(layer)) continue;
    material = d % 2 ? G.difference(material, layer) : G.union(material, layer);
  }
  return { polys, depths, material };
}

/**
 * Largest r whose r-inset is still non-empty — how wide the hole is.
 *
 * Used only to explain WHY a hole was exempted: a hole narrower than the standoff
 * cannot be entered safely no matter how long it is.
 */
export function inradius(poly: G.Geometry, iters = 30): number {
  if (G.isEmpty(poly)) return 0;
  const b = G.bounds(poly);
  if (!b) return 0;
  let lo = 0;
  let hi = Math.max(b[2] - b[0], b[3] - b[1]);
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    let empty: boolean;
    try {
      empty = G.isEmpty(G.buffer(poly, -mid));
    } catch {
      empty = true;
    }
    if (empty) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** The material, plus standoff-buffered copies cached per clearance. */
class Void {
  readonly material: G.Geometry;
  readonly prepMaterial: ReturnType<typeof G.prep>;
  private cache = new Map<number, { geom: G.Geometry; prep: ReturnType<typeof G.prep> }>();
  /**
   * The material's component polygons, indexed by envelope.
   *
   * On a single name this buys little. On a forty-name sheet it is the difference
   * between 388 seconds and a few: every lead-in candidate was being tested against
   * the ENTIRE sheet's material, so placing an entry near "Name007" paid to
   * intersect a segment against the other thirty-nine names as well.
   *
   * Prune-only, so the answers do not move. The pieces are the components of a
   * unioned MultiPolygon and therefore disjoint, which is what makes summing a
   * length across the surviving candidates the same number as measuring it against
   * the whole; and a component whose envelope misses the query could not have
   * contributed to it.
   */
  private readonly pieces: G.Geometry[];
  private readonly index: G.SpatialIndex;
  /** The material's outline, segment-indexed — see {@link lengthOfLineInside}. */
  private readonly edge: G.IndexedBoundary;

  constructor(material: G.Geometry) {
    this.material = material;
    this.prepMaterial = G.prep(material);
    this.pieces = G.geoms(material).filter((g) => !G.isEmpty(g));
    this.index = new G.SpatialIndex(this.pieces);
    this.edge = new G.IndexedBoundary(G.boundary(material));
  }

  /**
   * `length(material ∩ line)` for an open polyline, with the common case answered
   * without an overlay at all.
   *
   * A lead-in that does its job approaches from clear space and stops at the
   * surface, so almost every candidate tested here lies entirely OUTSIDE the
   * material and the honest answer is zero. Proving that needs no overlay: if no
   * segment of the line crosses the material's outline, and the line does not start
   * inside it, then the line never enters it. Only lines that do touch pay for the
   * exact measure — and that path is the original computation, unchanged, so the
   * number this returns is the number it always returned.
   *
   * The overlay was costing 388 seconds on a forty-name sheet, almost all of it
   * spent proving zeroes.
   */
  lengthOfLineInside(line: Point[]): number {
    let touches = false;
    for (let i = 0; i + 1 < line.length && !touches; i++) {
      if (this.edge.crossings(line[i], line[i + 1]).length) touches = true;
    }
    if (!touches && line.length && !this.containsPoint(G.point(line[0][0], line[0][1]))) {
      return 0;
    }
    return this.lengthInside(G.lineString(line));
  }

  /** `length(material ∩ g)`, over only the components that can meet `g`. */
  lengthInside(g: G.Geometry): number {
    let total = 0;
    for (const i of this.index.withinDistance(g, 0)) {
      total += G.length(G.intersection(this.pieces[i], g));
    }
    return total;
  }

  /** `material.contains(point)`, asking only the component that could hold it. */
  containsPoint(p: G.Geometry): boolean {
    for (const i of this.index.withinDistance(p, 0)) {
      if (G.contains(this.pieces[i], p)) return true;
    }
    return false;
  }

  /**
   * `distance(g, material)`, growing the query window until the best answer found
   * is proven — anything outside the window is at least `reach` away, so a best
   * inside it cannot be beaten.
   */
  distanceTo(g: G.Geometry): number {
    if (!this.pieces.length) return Infinity;
    const bb = G.bounds(this.material);
    let reach = bb ? Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 64 || 1 : 1;
    let best = Infinity;
    for (let guard = 0; guard < 40; guard++) {
      for (const i of this.index.withinDistance(g, reach)) {
        const d = G.distance(g, this.pieces[i]);
        if (d < best) best = d;
      }
      if (best <= reach) return best;
      reach *= 2;
    }
    return best;
  }

  /** The material grown by `clearance`, and a prepared copy of it. */
  buffered(clearance: number) {
    const key = Math.round(clearance * 1e7) / 1e7;
    let hit = this.cache.get(key);
    if (!hit) {
      const geom = clearance > 0 ? G.buffer(this.material, clearance) : this.material;
      hit = { geom, prep: G.prep(geom) };
      this.cache.set(key, hit);
    }
    return hit;
  }
}

// --------------------------------------------------------------------------- //
//  finding one lead-in
// --------------------------------------------------------------------------- //

/** One place a lead-in could enter, with the direction it would come from. */
export interface Candidate {
  anchor: Point;
  normal: Point;
  /** Index into the RAW ring of the edge this anchor sits on. */
  ringIdx: number;
}

/**
 * (anchor, normal) pairs sampled along the contour by ARC LENGTH.
 *
 * Sampling only the vertices is not enough. A union contour can be a triangle
 * whose longest edge runs 250 font units with no node in the middle — and the
 * middle of that edge is exactly where a lead-in wants to enter. Anchoring at the
 * corners instead aims the entry along the wedge and finds nothing.
 *
 * Each sample uses its own edge's true perpendicular, which is also a better entry
 * direction than a corner's bisector.
 */
export function candidates(ring: Point[], maxPts = 56): Candidate[] {
  const n = ring.length;
  const segs: { a: Point; b: Point; L: number; ringIdx: number }[] = [];
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > 1e-9) {
      // The RING index travels with the edge. Zero-length edges are skipped here,
      // so enumerating this list would give a position in the FILTERED list, not
      // in the ring — and mergeRun() indexes the raw ring with it. One duplicated
      // interior vertex would then shift the whole traversal by a vertex and close
      // the contour with a chord straight through the middle of the part.
      segs.push({ a, b, L, ringIdx: i });
      perimeter += L;
    }
  }
  if (segs.length === 0) return [];

  const spacing = Math.max(perimeter / Math.max(maxPts, 1), 1e-9);
  const out: Candidate[] = [];
  for (const { a, b, L, ringIdx } of segs) {
    const ux = (b[0] - a[0]) / L;
    const uy = (b[1] - a[1]) / L;
    const nx = -uy;
    const ny = ux;
    const k = Math.max(1, Math.round(L / spacing));
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5) / k; // midpoints, never the corners
      const p: Point = [a[0] + ux * L * t, a[1] + uy * L * t];
      out.push({ anchor: p, normal: [nx, ny], ringIdx });
      out.push({ anchor: p, normal: [-nx, -ny], ringIdx });
    }
  }
  return out;
}

/**
 * One continuous open path: pierce -> anchor -> all the way round -> anchor.
 *
 * THIS is what makes a lead-in actually work. CorelDRAW has no notion of a
 * lead-in, and laser software treats every path in the file separately — so a
 * lead-in drawn as its own little line is simply cut as its own little line, and
 * the contour still gets pierced on the finished edge. Emitting the lead-in and
 * the contour as ONE path means the beam starts out in the scrap, travels in along
 * the lead-in, and flows straight into the outline.
 *
 * The run ends back at the anchor, so the contour is closed by coincidence while
 * the path itself stays open.
 */
export function mergeRun(
  ring: Point[],
  anchor: Point,
  edgeIdx: number,
  pierce: Point,
): Point[] {
  const n = ring.length;
  if (n < 3) return [pierce, anchor];
  // walk from the anchor's edge all the way around and back to the anchor
  const tail: Point[] = [];
  for (let k = 0; k < n; k++) tail.push(ring[(edgeIdx + 1 + k) % n]);
  return [pierce, anchor, ...tail, anchor];
}

/**
 * How far this perpendicular can travel while holding the standoff.
 *
 * The first `near` of the run is exempt from the standoff — that stretch is the
 * approach to the anchor, where being next to the contour is the point.
 */
function usableLength(
  anchor: Point,
  nx: number,
  ny: number,
  voidGeom: Void,
  clearance: number,
  limit: number,
): number {
  const { prep: pclear } = voidGeom.buffered(clearance);
  // Always step a little off the anchor before the standoff is enforced,
  // otherwise a clearance of 0 would test a segment starting exactly on the
  // boundary and reject everything. This floor must NOT scale with the requested
  // length: tying it to `limit` meant asking for a 10 in lead-in created a 2 in
  // exemption zone and switched the safety check off.
  const near = Math.max(clearance * 1.15, EPS_FU);
  const pm = voidGeom.prepMaterial;

  const ok = (L: number): boolean => {
    if (L <= near) return false;
    // the perpendicular must not dive straight into the material (this happens at
    // a reflex vertex, where "outward" points inward)
    for (const t of [0.4, 0.8, 1.0]) {
      const q = G.point(anchor[0] + nx * near * t, anchor[1] + ny * near * t);
      if (pm.contains(q)) return false;
    }
    const far = G.lineString([
      [anchor[0] + nx * near, anchor[1] + ny * near],
      [anchor[0] + nx * L, anchor[1] + ny * L],
    ]);
    return !pclear.intersects(far);
  };

  if (ok(limit)) return limit;
  let lo = 0;
  let hi = limit;
  for (let i = 0; i < BISECT; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The strict check: never through the material, pierce never inside it. */
function verify(line: Point[], voidGeom: Void, tol: number): boolean {
  try {
    if (voidGeom.lengthOfLineInside(line) > tol) return false;
    return !voidGeom.containsPoint(G.point(line[0][0], line[0][1]));
  } catch {
    return false;
  }
}

/** What {@link findLeadIn} returns when it finds somewhere to enter. */
interface Found {
  line: [Point, Point];
  achieved: number;
  room: number;
  edgeIdx: number;
}

/**
 * Best (line, achieved length, achieved clearance) here, or null.
 *
 * "Best" is the longest that holds the standoff; ties break toward the one sitting
 * furthest from any edge, then toward a fixed side so repeat jobs come out
 * identical.
 */
function findLeadIn(
  ring: Point[],
  voidGeom: Void,
  length: number,
  clearance: number,
  bbox: [number, number, number, number] | null = null,
  preferTop = true,
): Found | null {
  const tol = EPS_FU; // absolute: never scales with the requested length

  type Cand = {
    inBbox: boolean;
    usable: number;
    pierce: Point;
    anchor: Point;
    edgeIdx: number;
  };
  const cands: Cand[] = [];
  let nFull = 0;
  for (const { anchor, normal, ringIdx } of candidates(ring, SAMPLES)) {
    const [nx, ny] = normal;
    const usable = usableLength(anchor, nx, ny, voidGeom, clearance, length);
    if (usable <= 0) continue;
    const pierce: Point = [anchor[0] + nx * usable, anchor[1] + ny * usable];
    let inBbox = true;
    if (bbox) {
      const [x0, y0, x1, y1] = bbox;
      inBbox = x0 <= pierce[0] && pierce[0] <= x1 && y0 <= pierce[1] && pierce[1] <= y1;
    }
    cands.push({ inBbox, usable, pierce, anchor, edgeIdx: ringIdx });
    if (usable >= length * 0.999 && inBbox) {
      nFull += 1;
      // several spots already take the full requested length; nothing better
      // exists, and scanning a 2000-point contour is waste
      if (nFull >= 8) break;
    }
  }
  if (cands.length === 0) return null;

  // longest first, and keep it inside the artwork box when that is possible
  const bySide = (p: Point) => (preferTop ? -p[1] : p[1]);
  cands.sort(
    (a, b) =>
      Number(!a.inBbox) - Number(!b.inBbox) ||
      b.usable - a.usable ||
      bySide(a.pierce) - bySide(b.pierce),
  );

  // among the near-longest, prefer the one with the most room around it
  const bestLen = cands[0].usable;
  const shortlist = cands.filter((c) => c.usable >= bestLen * 0.98).slice(0, 12);
  const scored = shortlist.map((c) => {
    const near = clearance * 1.15;
    const far = G.lineString([
      [
        c.anchor[0] + ((c.pierce[0] - c.anchor[0]) / c.usable) * near,
        c.anchor[1] + ((c.pierce[1] - c.anchor[1]) / c.usable) * near,
      ],
      c.pierce,
    ]);
    let room = 0;
    try {
      room = voidGeom.distanceTo(far);
    } catch {
      room = 0;
    }
    return { ...c, room };
  });
  scored.sort(
    (a, b) =>
      Number(!a.inBbox) - Number(!b.inBbox) ||
      b.room - a.room ||
      bySide(a.pierce) - bySide(b.pierce),
  );

  for (const c of scored) {
    const line: [Point, Point] = [c.pierce, c.anchor];
    if (verify(line, voidGeom, tol)) {
      return { line, achieved: c.usable, room: c.room, edgeIdx: c.edgeIdx };
    }
  }
  for (const c of cands) {
    // fall back
    const line: [Point, Point] = [c.pierce, c.anchor];
    if (verify(line, voidGeom, tol)) {
      return { line, achieved: c.usable, room: 0, edgeIdx: c.edgeIdx };
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
//  public API
// --------------------------------------------------------------------------- //

/** One hole's outcome, with the numbers that justify it. */
export interface HoleDetail {
  ring: number;
  status: "served" | "tiny";
  length: number;
  clearance: number;
  probe?: number;
  width?: number;
  reason?: string;
}

/** One lead-in that was actually placed. */
export interface LeadDetail {
  kind: "hole" | "outer";
  ring: number;
  length: number;
  clearance: number;
  standoff_asked: number;
}

/** Everything {@link leadInReport} works out, so callers can report honestly. */
export interface LeadInReport {
  /** The bare approach lines, pierce → anchor, in font units. */
  leads: Point[][];
  /** Pierce + the whole contour, as ONE open path each. */
  runs: Point[][];
  /** The contours that did NOT get a lead-in and so stay closed. */
  closed: Point[][];
  holes: number;
  outers: number;
  skipped_tiny: number;
  failed: number;
  holes_detail: HoleDetail[];
  leads_detail: LeadDetail[];
}

/**
 * Lead-ins plus what happened, so callers can report honestly.
 *
 * Lengths and clearances in `holes_detail` / `leads_detail` are physical, in
 * `doc.unit`.
 *
 * @param doc              the finished artwork
 * @param lengthInUnit     lead-in length in doc.unit; defaults per unit
 * @param clearanceInUnit  standoff in doc.unit; defaults per unit
 */
export function leadInReport(
  doc: Document,
  lengthInUnit: number | null = null,
  clearanceInUnit: number | null = null,
): LeadInReport {
  if (lengthInUnit === null || lengthInUnit === undefined) {
    lengthInUnit = defaultLength(doc.unit);
  }
  if (clearanceInUnit === null || clearanceInUnit === undefined) {
    clearanceInUnit = defaultClearance(doc.unit);
  }
  const ringList = rings(doc);
  // Every early return must carry the SAME keys as the full result, or a caller
  // that reads report.runs dies on exactly the inputs that need graceful
  // handling (length 0, a name with no ink). With no lead-ins every contour stays
  // closed — so "closed" is all of them and runs+closed still accounts for the
  // whole outline.
  const empty: LeadInReport = {
    leads: [], runs: [], closed: ringList.slice(), holes: 0, outers: 0,
    skipped_tiny: 0, failed: 0, holes_detail: [], leads_detail: [],
  };
  if (lengthInUnit <= 0 || ringList.length === 0) return empty;

  const scale = doc.scale;
  const length = lengthInUnit / scale; // unit -> font units
  // The floor exists to SKIP holes where only a sub-kerf lead-in would fit — it
  // must never override a deliberately tiny requested length, or asking for
  // 0.005 in lead-ins exempts every hole with a reason ("too narrow") that is
  // factually false. The user's explicit number wins.
  const floor = Math.min(minLength(doc.unit), lengthInUnit) / scale;
  const baseClear = Math.max(clearanceInUnit, 0) / scale;
  const { polys, depths, material } = analyse(ringList);
  if (G.isEmpty(material)) return empty;
  const voidGeom = new Void(material);

  const hard = Math.max(hardClearance(doc.unit) / scale, 0);
  const levels: number[] = [];
  for (const cf of CLEAR_STEPS) {
    // relax, but never below the floor
    const c = Math.max(baseClear * cf, hard);
    if (levels.length === 0 || Math.abs(c - levels[levels.length - 1]) > 1e-9) {
      levels.push(c);
    }
  }
  // The ladder must always bottom out at the kerf floor. Without this, a huge
  // requested standoff (bigger than the lead length allows) makes every lead-in
  // impossible BY CONSTRUCTION, and the file exports with the pierce on the
  // finished edge without a word said. The kerf floor is still a real standoff,
  // so safety is kept; only the user's excessive number is relaxed.
  if (levels.length && Math.abs(levels[levels.length - 1] - hard) > 1e-9) {
    levels.push(hard);
  }

  /** Best lead-in honouring the largest standoff that actually fits. */
  const attempt = (
    ring: Point[],
    bbox: [number, number, number, number] | null,
    preferTop: boolean,
  ): (Found & { usedClear: number }) | null => {
    let best: (Found & { usedClear: number }) | null = null;
    for (const c of levels) {
      const got = findLeadIn(ring, voidGeom, length, c, bbox, preferTop);
      if (!got) continue;
      best = { ...got, usedClear: c };
      if (got.achieved >= floor) return best;
    }
    return best;
  };

  const out: Point[][] = [];
  const runs: Point[][] = []; // pierce + full contour, as ONE open path
  const led = new Set<number>(); // ring indices that became a run
  const holesDetail: HoleDetail[] = [];
  const leadsDetail: LeadDetail[] = [];
  let nHoles = 0;
  let nOuters = 0;
  let skipped = 0;
  let failed = 0;

  for (let idx = 0; idx < ringList.length; idx++) {
    if (depths[idx] % 2 !== 1) continue;
    nHoles += 1;
    const got = attempt(ringList[idx], null, true);
    if (!got || got.achieved < floor) {
      // No safe entry exists here. Prove the hole really is tight by measuring
      // what would fit with NO standoff at all: that number is recorded so a
      // caller can tell a genuinely sub-kerf sliver from an algorithm that simply
      // failed to find a spot.
      const probe = findLeadIn(ringList[idx], voidGeom, length, 0, null, true);
      const probeLen = probe ? probe.achieved * scale : 0;
      // The honest measure of "no safe entry" is the hole's WIDTH, not how far a
      // line could run along it. A narrow slot between two letters can be long
      // yet still too tight to stand off from both walls.
      const width = inradius(polys[idx]) * scale;
      skipped += 1;
      holesDetail.push({
        ring: idx,
        status: "tiny",
        length: got ? got.achieved * scale : 0,
        clearance: got ? got.room * scale : 0,
        probe: probeLen,
        width,
        reason: "too narrow to enter with a safe standoff",
      });
      continue;
    }
    out.push(got.line);
    runs.push(mergeRun(ringList[idx], got.line[1], got.edgeIdx, got.line[0]));
    led.add(idx);
    holesDetail.push({
      ring: idx, status: "served",
      length: got.achieved * scale, clearance: got.room * scale,
    });
    leadsDetail.push({
      kind: "hole", ring: idx,
      length: got.achieved * scale, clearance: got.room * scale,
      standoff_asked: got.usedClear * scale,
    });
  }

  for (let idx = 0; idx < ringList.length; idx++) {
    if (depths[idx] % 2 !== 0) continue;
    nOuters += 1;
    const got = attempt(ringList[idx], doc.bbox, false);
    if (!got) {
      failed += 1;
      continue;
    }
    out.push(got.line);
    runs.push(mergeRun(ringList[idx], got.line[1], got.edgeIdx, got.line[0]));
    led.add(idx);
    leadsDetail.push({
      kind: "outer", ring: idx,
      length: got.achieved * scale, clearance: got.room * scale,
      standoff_asked: got.usedClear * scale,
    });
  }

  return {
    leads: out,
    runs,
    closed: ringList.filter((_r, i) => !led.has(i)),
    holes: nHoles,
    outers: nOuters,
    skipped_tiny: skipped,
    failed,
    holes_detail: holesDetail,
    leads_detail: leadsDetail,
  };
}

/**
 * Lead-in polylines for one document, in FONT UNITS.
 *
 * `lengthInUnit` is the physical lead-in length in doc.unit (in or mm); it is
 * converted through doc.scale, so a 0.1 in lead-in is 0.1 in on the material
 * whatever the name's height.
 */
export function leadInLines(
  doc: Document,
  lengthInUnit: number | null = null,
  clearanceInUnit: number | null = null,
): Point[][] {
  return leadInReport(doc, lengthInUnit, clearanceInUnit).leads;
}

/** The bounding box of a set of lead-ins, or null when there are none. */
export function leadInBbox(
  leads: Point[][],
): [number, number, number, number] | null {
  const pts = leads.flat();
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * A copy whose bbox also covers the lead-ins, so none get clipped.
 *
 * Only the exported canvas grows. `scale` and `basisHeight` are untouched, so the
 * artwork is exactly the same physical size and `doc.size()` on the ORIGINAL doc
 * is still the number to show the user.
 */
export function docForExport(doc: Document, leads: Point[][]): Document {
  const lb = leadInBbox(leads);
  if (!lb) return doc;
  const [x0, y0, x1, y1] = doc.bbox;
  const nx0 = Math.min(x0, lb[0]);
  const ny0 = Math.min(y0, lb[1]);
  const nx1 = Math.max(x1, lb[2]);
  const ny1 = Math.max(y1, lb[3]);
  if (nx0 === x0 && ny0 === y0 && nx1 === x1 && ny1 === y1) return doc;
  return doc.replace({ bbox: [nx0, ny0, nx1, ny1] });
}

// -- exporters: same contract as the core ones, plus lead-ins ---------------- //

/**
 * (document to write, open paths to add) with lead-ins merged in.
 *
 * A contour that got a lead-in is written as ONE open path that starts out in the
 * scrap; only contours without a lead-in stay closed. That is the whole point —
 * see {@link mergeRun}.
 */
function exportDoc(doc: Document, info: LeadInReport): [Document, Point[][]] {
  if (info.runs.length === 0) return [doc, []];
  let ex = docForExport(doc, info.leads);
  // [[]] would emit an empty <path d=""/>; give the writer nothing instead
  ex = ex.replace({ cutPaths: info.closed.length ? [info.closed] : [] });
  return [ex, info.runs];
}

/** One name as SVG, with lead-ins merged into their contours. */
export function svgSingleLeadin(
  doc: Document,
  lengthInUnit: number | null = null,
  margin = 0.0,
  clearanceInUnit: number | null = null,
): string {
  const info = leadInReport(doc, lengthInUnit, clearanceInUnit);
  const [ex, extra] = exportDoc(doc, info);
  return svgSingle(ex, margin, extra);
}

/** One page per name as PDF, with lead-ins merged into their contours. */
export function pdfDocumentLeadin(
  docs: Document[],
  lengthInUnit: number | null = null,
  marginPt = 6.0,
  clearanceInUnit: number | null = null,
): Uint8Array {
  const pairs = docs.map((d) =>
    exportDoc(d, leadInReport(d, lengthInUnit, clearanceInUnit)),
  );
  return pdfDocument(
    pairs.map((p) => p[0]),
    marginPt,
    true,
    pairs.map((p) => p[1]),
  );
}

/** Every name on one SVG sheet, with lead-ins. */
export function svgSheetLeadin(
  docs: Document[],
  gap = 0.25,
  lengthInUnit: number | null = null,
  clearanceInUnit: number | null = null,
): string {
  return svgSingleLeadin(stack(docs, gap), lengthInUnit, 0.0, clearanceInUnit);
}

/** Every name on one PDF page, with lead-ins. */
export function pdfSheetLeadin(
  docs: Document[],
  gap = 0.25,
  lengthInUnit: number | null = null,
  marginPt = 6.0,
  clearanceInUnit: number | null = null,
): Uint8Array {
  return pdfDocumentLeadin([stack(docs, gap)], lengthInUnit, marginPt, clearanceInUnit);
}

/** Re-exported so callers converting mm↔in do not need core as well. */
export { MM_PER_IN };

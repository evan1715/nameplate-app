/**
 * geom.ts — the `shapely` calls the engine makes, on top of `jsts`.
 *
 * WHY JSTS
 *   shapely is a Python wrapper around GEOS; GEOS is a C++ port of JTS; jsts is
 *   a JavaScript port of the same JTS. So the same algorithms, the same
 *   robustness rules and the same edge-case answers — which matters, because the
 *   engine leans on `buffer`, `intersection`, `unary_union` and `linemerge` to
 *   pull the engrave lines out of a font's colour layers, and those results feed
 *   straight into the exported file.
 *
 * WHAT THIS IS NOT
 *   Not a general geometry library. It exposes exactly the operations the ported
 *   modules use, named after their shapely equivalents so the ported code reads
 *   like the Python it came from. Anything shapely does that the engine never
 *   asked for is deliberately absent.
 *
 * A NOTE ON ERRORS
 *   shapely raises on a handful of degenerate inputs and the Python code catches
 *   those (`except Exception: continue`). jsts throws its own exception types, so
 *   the wrappers below normalise failures to `null`/empty rather than letting a
 *   jsts internal error escape with a different shape than the port expects.
 */

import type { Point } from "./skia.ts";

// jsts 2.x publishes a UMD bundle and no package entry point, so importing it
// for its side effect and reading the global it installs is the only way in.
// The import is top-level await, which makes this module async — fine, because
// every consumer is reached through the engine's own async bootstrap.
await import("jsts/dist/jsts.min.js");
const jsts: any = (globalThis as any).jsts;
if (!jsts?.geom) throw new Error("jsts failed to load (no global namespace)");
const GF = new jsts.geom.GeometryFactory();

/** A jsts geometry. Kept opaque — always go through the helpers here. */
export type Geometry = any;

/** shapely's `LineString(coords)`. Fewer than 2 points gives an empty geometry. */
export function lineString(pts: readonly Point[]): Geometry {
  if (pts.length < 2) return GF.createLineString([]);
  return GF.createLineString(pts.map((p) => new jsts.geom.Coordinate(p[0], p[1])));
}

/** shapely's `Point(x, y)`. */
export function point(x: number, y: number): Geometry {
  return GF.createPoint(new jsts.geom.Coordinate(x, y));
}

/**
 * shapely's `Polygon(ring)`. The ring is closed automatically, matching shapely.
 * A ring with fewer than 3 distinct points yields an empty polygon rather than
 * throwing, which is what shapely does for the degenerate contours fonts
 * sometimes contain.
 */
export function polygon(ring: readonly Point[]): Geometry {
  if (ring.length < 3) return GF.createPolygon(null, null);
  const coords = ring.map((p) => new jsts.geom.Coordinate(p[0], p[1]));
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first.x !== last.x || first.y !== last.y) {
    coords.push(new jsts.geom.Coordinate(first.x, first.y));
  }
  if (coords.length < 4) return GF.createPolygon(null, null);
  try {
    return GF.createPolygon(GF.createLinearRing(coords), []);
  } catch {
    return GF.createPolygon(null, null);
  }
}

/** An empty polygon — shapely's `Polygon()`. */
export function emptyPolygon(): Geometry {
  return GF.createPolygon(null, null);
}

/** `geom.is_empty`. A null geometry counts as empty. */
export function isEmpty(g: Geometry): boolean {
  return !g || g.isEmpty();
}

/** `geom.geom_type` — "Point", "LineString", "Polygon", "MultiPolygon", … */
export function geomType(g: Geometry): string {
  return g ? g.getGeometryType() : "GeometryCollection";
}

/** `geom.area`. */
export function area(g: Geometry): number {
  return isEmpty(g) ? 0 : g.getArea();
}

/** `geom.length` — perimeter for an area, total length for a line. */
export function length(g: Geometry): number {
  return isEmpty(g) ? 0 : g.getLength();
}

/** `geom.bounds` → (minx, miny, maxx, maxy), or null when empty. */
export function bounds(g: Geometry): [number, number, number, number] | null {
  if (isEmpty(g)) return null;
  const e = g.getEnvelopeInternal();
  return [e.getMinX(), e.getMinY(), e.getMaxX(), e.getMaxY()];
}

/** `geom.buffer(d)`. A negative distance insets; 0 repairs self-intersections. */
export function buffer(g: Geometry, d: number): Geometry {
  try {
    return g.buffer(d);
  } catch {
    return emptyPolygon();
  }
}

/** `a.intersection(b)`. */
export function intersection(a: Geometry, b: Geometry): Geometry {
  try {
    return a.intersection(b);
  } catch {
    return emptyPolygon();
  }
}

/** `a.union(b)`. */
export function union(a: Geometry, b: Geometry): Geometry {
  try {
    return a.union(b);
  } catch {
    return a;
  }
}

/** `a.difference(b)`. */
export function difference(a: Geometry, b: Geometry): Geometry {
  try {
    return a.difference(b);
  } catch {
    return a;
  }
}

/** `a.contains(b)` — strictly inside, boundary excluded, like GEOS. */
export function contains(a: Geometry, b: Geometry): boolean {
  try {
    return a.contains(b);
  } catch {
    return false;
  }
}

/** `a.intersects(b)`. */
export function intersects(a: Geometry, b: Geometry): boolean {
  try {
    return a.intersects(b);
  } catch {
    return false;
  }
}

/** `a.distance(b)` — shortest distance between the two geometries. */
export function distance(a: Geometry, b: Geometry): number {
  try {
    return a.distance(b);
  } catch {
    return 0;
  }
}

/** `geom.centroid`. */
export function centroid(g: Geometry): Point {
  const c = g.getCentroid().getCoordinate();
  return [c.x, c.y];
}

/**
 * `geom.representative_point()` — a point guaranteed to be inside the area,
 * which the centroid is not for a concave or holed polygon.
 */
export function representativePoint(g: Geometry): Point {
  try {
    const ipa = new jsts.algorithm.InteriorPointArea(g);
    const c = ipa.getInteriorPoint();
    return [c.x, c.y];
  } catch {
    return centroid(g);
  }
}

/** `shapely.ops.unary_union(list)` — dissolve a collection into one geometry. */
export function unaryUnion(geoms: readonly Geometry[]): Geometry {
  const live = geoms.filter((g) => !isEmpty(g));
  if (live.length === 0) return emptyPolygon();
  if (live.length === 1) return live[0];
  try {
    return jsts.operation.union.UnaryUnionOp.union(
      GF.createGeometryCollection(live),
    );
  } catch {
    // fall back to a pairwise union; slower but never leaves the caller
    // holding nothing when one member is slightly invalid
    let acc = live[0];
    for (let i = 1; i < live.length; i++) acc = union(acc, live[i]);
    return acc;
  }
}

/**
 * `shapely.ops.linemerge(geom)` — stitch touching LineStrings into the fewest
 * continuous lines possible.
 *
 * TRAP (SPEC.md §8.4): shapely's linemerge throws on a single LineString, so the
 * Python code checks the geometry type first. The same guard is kept here so the
 * two behave identically on a one-line input.
 */
export function lineMerge(g: Geometry): Geometry {
  if (isEmpty(g)) return g;
  if (geomType(g) !== "MultiLineString" && geomType(g) !== "GeometryCollection") return g;
  try {
    const merger = new jsts.operation.linemerge.LineMerger();
    merger.add(g);
    const merged: any[] = [];
    const it = merger.getMergedLineStrings().iterator();
    while (it.hasNext()) merged.push(it.next());
    if (merged.length === 0) return g;
    if (merged.length === 1) return merged[0];
    return GF.createMultiLineString(merged);
  } catch {
    return g;
  }
}

/**
 * The members of a multi-part geometry, or `[g]` for a single part.
 * Mirrors the Python idiom `hit.geoms if hasattr(hit, "geoms") else [hit]`.
 */
export function geoms(g: Geometry): Geometry[] {
  if (isEmpty(g)) return [];
  const n = g.getNumGeometries ? g.getNumGeometries() : 1;
  if (n <= 1 && !g.getGeometryN) return [g];
  const out: Geometry[] = [];
  for (let i = 0; i < n; i++) out.push(g.getGeometryN(i));
  return out;
}

/** `list(line.coords)` for a LineString. */
export function coords(g: Geometry): Point[] {
  if (isEmpty(g)) return [];
  return g.getCoordinates().map((c: any) => [c.x, c.y] as Point);
}

/** A polygon's outer ring as a LineString — shapely's `poly.exterior`. */
export function exterior(g: Geometry): Geometry {
  try {
    return g.getExteriorRing();
  } catch {
    return lineString([]);
  }
}

/**
 * `line.interpolate(d, normalized=True)` — the point a fraction of the way along
 * a line. Backed by JTS's LengthIndexedLine, the same machinery GEOS uses.
 */
export function interpolateNormalized(line: Geometry, fraction: number): Point {
  const lil = new jsts.linearref.LengthIndexedLine(line);
  const c = lil.extractPoint(fraction * line.getLength());
  return [c.x, c.y];
}

/** `shapely.affinity.translate(geom, xoff, yoff)`. */
export function translate(g: Geometry, xoff: number, yoff: number): Geometry {
  const t = jsts.geom.util.AffineTransformation.translationInstance(xoff, yoff);
  const copy = g.copy();
  copy.apply(t);
  return copy;
}

/** `geom.is_valid`. */
export function isValid(g: Geometry): boolean {
  try {
    return g.isValid();
  } catch {
    return false;
  }
}

/**
 * `shapely.prepared.prep(geom)` — a geometry indexed for many repeated predicate
 * tests. The lead-in search runs thousands of `contains`/`intersects` calls
 * against the same material, which is why the Python code prepares it.
 *
 * jsts' published bundle does not include JTS's `geom.prep` package, so a full
 * PreparedGeometry is not available. It DOES ship `IndexedPointInAreaLocator`,
 * which is the part that matters: every hot call here is `contains(a Point)` —
 * the thickness survey alone makes two per sample, thousands of times — and an
 * unprepared `contains` walks every edge of the polygon each time.
 *
 * So a point-in-area index is built once per prepared geometry and reused. This
 * is an indexing change only, not a semantic one: `contains(point)` is true
 * exactly when the point is INTERIOR, boundary and exterior both being false,
 * which is what the locator returns. Verified against unprepared `contains` on
 * interior, boundary, vertex, hole-interior, hole-boundary and exterior points.
 *
 * Anything that is not a Point, and any non-polygonal geometry, falls through to
 * the plain call.
 */
export function prep(g: Geometry): {
  contains(p: Geometry): boolean;
  intersects(p: Geometry): boolean;
} {
  const polygonal = (() => {
    try {
      const t = g.getGeometryType();
      return t === "Polygon" || t === "MultiPolygon";
    } catch {
      return false;
    }
  })();
  const Locator = jsts.algorithm?.locate?.IndexedPointInAreaLocator;
  const INTERIOR = jsts.geom.Location.INTERIOR;
  // Built on first use, not here: prep() is called for geometries that never get
  // a point test, and indexing a script font's outline is not free.
  let index: any;
  const locator = (): any => {
    if (index === undefined) index = polygonal && Locator ? new Locator(g) : null;
    return index;
  };

  // The same idea for `intersects`, which has no point-in-area shortcut: split the
  // geometry into its components once and index their envelopes. Built lazily for
  // the same reason, and skipped entirely for a single-part geometry, where there
  // is nothing to prune.
  let parts: { items: Geometry[]; index: SpatialIndex } | null | undefined;
  const components = (): { items: Geometry[]; index: SpatialIndex } | null => {
    if (parts === undefined) {
      const items = geoms(g).filter((x) => !isEmpty(x));
      parts = items.length > 1 ? { items, index: new SpatialIndex(items) } : null;
    }
    return parts;
  };

  return {
    contains(p: Geometry) {
      try {
        const loc = locator();
        if (loc && p.getGeometryType() === "Point" && !p.isEmpty()) {
          return loc.locate(p.getCoordinate()) === INTERIOR;
        }
        return g.contains(p);
      } catch {
        return false;
      }
    },
    /**
     * `intersects`, with the components that cannot reach `p` pruned away.
     *
     * This was the last unindexed predicate, and on a forty-name sheet it was 81%
     * of the lead-in pass: every candidate entry was being tested against the
     * buffered material of the WHOLE sheet, thirty-nine names of which were
     * nowhere near it.
     *
     * Exact for any argument, unlike `contains`: a geometry intersects a
     * collection exactly when it intersects at least one member, and a member
     * whose envelope misses `p` cannot be that member. `contains` gets no such
     * treatment on purpose — a shape can sit inside a collection's union without
     * sitting inside any single member — so it keeps the whole-geometry call.
     */
    intersects(p: Geometry) {
      try {
        const parts = components();
        if (!parts) return g.intersects(p);
        for (const i of parts.index.withinDistance(p, 0)) {
          if (parts.items[i].intersects(p)) return true;
        }
        return false;
      } catch {
        return false;
      }
    },
  };
}

/** `geom.boundary` — the rings of an area, or the endpoints of a line. */
export function boundary(g: Geometry): Geometry {
  try {
    return g.getBoundary();
  } catch {
    return lineString([]);
  }
}

/** A polygon's interior rings — shapely's `poly.interiors`. */
export function interiors(g: Geometry): Geometry[] {
  const out: Geometry[] = [];
  try {
    const n = g.getNumInteriorRing();
    for (let i = 0; i < n; i++) out.push(g.getInteriorRingN(i));
  } catch {
    /* not a polygon */
  }
  return out;
}

/**
 * `shapely.strtree.STRtree` — an R-tree over a fixed set of geometries.
 *
 * shapely's `query(geom, predicate="dwithin", distance=d)` has no jsts
 * equivalent: jsts' STRtree indexes envelopes and queries envelopes only. So the
 * envelope is grown by `d` and the candidates it returns are filtered by real
 * distance — which is what shapely does internally anyway, and gives the same
 * answers.
 */
export class SpatialIndex {
  private tree: any;
  private items: Geometry[];

  constructor(geoms: readonly Geometry[]) {
    this.items = geoms.slice();
    this.tree = new jsts.index.strtree.STRtree();
    this.items.forEach((g, i) => {
      if (!isEmpty(g)) this.tree.insert(g.getEnvelopeInternal(), i);
    });
  }

  /** Indices of every indexed geometry within `distance` of `g`. */
  withinDistance(g: Geometry, distance: number): number[] {
    const env = g.getEnvelopeInternal().copy();
    env.expandBy(distance);
    let hits: any[] = [];
    try {
      hits = this.tree.query(env);
    } catch {
      return [];
    }
    const out: number[] = [];
    for (const raw of hits) {
      const idx = typeof raw === "number" ? raw : raw?.getItem?.();
      if (typeof idx !== "number") continue;
      out.push(idx);
    }
    return out;
  }
}

/**
 * `shapely.ops.nearest_points(a, b)` — the closest pair, one point on each.
 *
 * Returned in shapely's order: the point on `a` first. A font-repair instruction
 * depends on that order, because it tells an editor which glyph's ink stops where
 * and which glyph's ink it has to reach.
 */
export function nearestPoints(a: Geometry, b: Geometry): [Point, Point] | null {
  try {
    const cs = jsts.operation.distance.DistanceOp.nearestPoints(a, b);
    return [
      [cs[0].x, cs[0].y],
      [cs[1].x, cs[1].y],
    ];
  } catch {
    return null;
  }
}

/** `line.project(point)` then `line.interpolate(...)` — the perpendicular foot. */
export function nearestPointOnLine(line: Geometry, p: Geometry): Point | null {
  try {
    const lil = new jsts.linearref.LengthIndexedLine(line);
    const idx = lil.indexOf(p.getCoordinate());
    const c = lil.extractPoint(idx);
    return [c.x, c.y];
  } catch {
    return null;
  }
}

/**
 * `geom.buffer(d, join_style=2, mitre_limit=…)` — a buffer with MITRED joins.
 *
 * The thicken preview needs this rather than the default round join: these are
 * letterforms, and rounding every serif and corner makes the overlay read as a
 * different typeface instead of as this one thickened. The mitre limit keeps it
 * honest — at a very sharp apex an unlimited mitre shoots a spike far outside the
 * letter, so it is capped and the apex is bevelled instead.
 */
export function bufferMitre(g: Geometry, d: number, mitreLimit: number): Geometry {
  try {
    const params = new jsts.operation.buffer.BufferParameters();
    params.setJoinStyle(jsts.operation.buffer.BufferParameters.JOIN_MITRE);
    params.setMitreLimit(mitreLimit);
    return jsts.operation.buffer.BufferOp.bufferOp(g, d, params);
  } catch {
    // a mitred buffer is a presentation choice, not a correctness one
    return buffer(g, d);
  }
}

/**
 * A boundary pre-cut into segments and indexed, for the two queries the thickness
 * survey makes thousands of times against the SAME geometry.
 *
 * WHY THIS EXISTS
 *   `crossWidth` casts a ray at every sample point and asks the material's boundary
 *   two questions: where does this ray cross you, and how far are you from this
 *   point. Both were going through `Geometry.intersection` / `Geometry.distance`,
 *   which walk every segment of the boundary every time. On a long script name the
 *   boundary has thousands of segments, and a CPU profile put 69% of a 345-second
 *   survey inside jsts' overlay machinery for exactly that reason. The Python is not
 *   cleverer here — GEOS simply indexes internally, and jsts does not.
 *
 * WHY THE ANSWERS ARE STILL IDENTICAL
 *   The index only PRUNES. Every candidate that survives is handed to jsts' own
 *   `RobustLineIntersector` and `Distance.pointToSegment`, so the arithmetic that
 *   produces a crossing point or a distance is the same code that produced it
 *   before — not a re-derivation. Segments the index rejects are ones whose envelope
 *   cannot reach the query, so they could not have contributed.
 *
 *   `crossings` returns points in index order rather than in overlay order. That is
 *   safe here because its one caller turns them into distances and sorts, and it is
 *   documented so that stays true.
 */
export class IndexedBoundary {
  private tree: any;
  private segs: { a: any; b: any }[] = [];
  private li = new jsts.algorithm.RobustLineIntersector();

  constructor(boundary: Geometry) {
    this.tree = new jsts.index.strtree.STRtree();
    for (const g of geoms(boundary)) {
      let cs: any[];
      try {
        cs = g.getCoordinates();
      } catch {
        continue;
      }
      for (let i = 0; i + 1 < cs.length; i++) {
        const a = cs[i];
        const b = cs[i + 1];
        if (a.x === b.x && a.y === b.y) continue; // a zero-length segment cannot be hit
        const idx = this.segs.length;
        this.segs.push({ a, b });
        const env = new jsts.geom.Envelope(a, b);
        this.tree.insert(env, idx);
      }
    }
    // STRtree builds lazily on first query; force it once so the cost is not
    // attributed to whichever sample happens to ask first.
    try {
      this.tree.query(new jsts.geom.Envelope(0, 0, 0, 0));
    } catch {
      /* an empty tree is fine */
    }
  }

  /** Candidate segment indices whose envelope reaches `env`. */
  private candidates(env: any): number[] {
    try {
      const hits = this.tree.query(env);
      const out: number[] = [];
      const n = hits.size ? hits.size() : hits.length;
      for (let i = 0; i < n; i++) out.push(hits.get ? hits.get(i) : hits[i]);
      return out;
    } catch {
      return this.segs.map((_s, i) => i);
    }
  }

  /**
   * Every point where the segment p→q crosses this boundary.
   *
   * Order is the index's, not the overlay's — see the class note.
   */
  crossings(p: Point, q: Point): Point[] {
    const C = jsts.geom.Coordinate;
    const pa = new C(p[0], p[1]);
    const pb = new C(q[0], q[1]);
    const env = new jsts.geom.Envelope(pa, pb);
    const out: Point[] = [];
    for (const i of this.candidates(env)) {
      const s = this.segs[i];
      this.li.computeIntersection(pa, pb, s.a, s.b);
      if (!this.li.hasIntersection()) continue;
      const n = this.li.getIntersectionNum();
      for (let k = 0; k < n; k++) {
        const c = this.li.getIntersection(k);
        out.push([c.x, c.y]);
      }
    }
    return out;
  }

  /**
   * Shortest distance from a point to this boundary.
   *
   * Grows the query window until it holds a candidate, then keeps growing while the
   * best distance found could still be beaten by something just outside — otherwise
   * a nearest segment lying diagonally outside the first window would be missed.
   */
  distanceTo(p: Point): number {
    const C = jsts.geom.Coordinate;
    const pt = new C(p[0], p[1]);
    if (!this.segs.length) return Infinity;
    let reach = 0;
    // seed the reach from the tree's own extent so the first query is not absurd
    try {
      const root = this.tree.getRoot?.().getBounds?.();
      if (root) reach = Math.max(root.getWidth(), root.getHeight()) / 64 || 1;
    } catch {
      reach = 1;
    }
    if (!(reach > 0)) reach = 1;

    let best = Infinity;
    for (let guard = 0; guard < 40; guard++) {
      const env = new jsts.geom.Envelope(pt.x - reach, pt.x + reach, pt.y - reach, pt.y + reach);
      for (const i of this.candidates(env)) {
        const s = this.segs[i];
        const d = jsts.algorithm.Distance.pointToSegment(pt, s.a, s.b);
        if (d < best) best = d;
      }
      // Safe to stop only when the whole window is proven: anything outside it is at
      // least `reach` away, so a best inside it cannot be beaten.
      if (best <= reach) return best;
      reach *= 2;
    }
    return best;
  }
}

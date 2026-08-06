/**
 * skia.ts — the `skia-pathops` layer, ported to TypeScript on top of CanvasKit.
 *
 * WHY THIS FILE EXISTS
 *   The Python engine unions the letters with `skia-pathops`, which is a thin
 *   Cython wrapper around Skia's own `SkPathOps::Op()` — *plus two
 *   post-processing passes that are easy to miss and that change the output*:
 *
 *     fix_winding=True          re-orders the result's contours (largest area
 *                               first) and reverses the ones whose direction
 *                               disagrees with their even-odd nesting, so the
 *                               path fills correctly under the non-zero rule.
 *     keep_starting_points=True rotates each output contour so it begins at one
 *                               of the INPUT contours' starting points, which is
 *                               what keeps a glyph's outline starting where the
 *                               type designer drew it.
 *
 *   CanvasKit exposes the same Skia `Op()` — verified: for Merriweather/"ADAM"
 *   the raw contour list comes out in the same order with the same coordinates.
 *   But CanvasKit stops there, so both passes above are reimplemented here,
 *   line for line against `skia-pathops`' `_pathops.pyx`.
 *
 *   Reading a path back out also has to match. skia-pathops does not hand a pen
 *   the raw verb stream: `SegmentPenIterator` joins consecutive quadratics that
 *   share an implied on-curve midpoint (the TrueType convention) and drops a
 *   final closing `lineTo` that merely repeats the contour's first point. Those
 *   are reproduced in {@link segments}.
 *
 * DO NOT swap this for a polygon-clipping library. The cut path keeps its Bézier
 * curves through the union; flattening first would change every intersection.
 */

import CanvasKitInit from "canvaskit-wasm";
import { createRequire } from "node:module";
import * as path from "node:path";

/** A 2-D point in font units. Tuples, not objects, to match the Python data. */
export type Point = [number, number];

/**
 * Skia path verbs, with the number of points each one carries in the *compact*
 * point array (the one `toCmds()` produces — a MOVE owns 1 point, a LINE owns
 * its endpoint only, and CLOSE owns none).
 *
 * A frozen object rather than a TypeScript `enum`: Node runs these files by
 * stripping types, and an `enum` is the one construct that has to EMIT code, so it
 * is rejected outright ("not supported in strip-only mode"). `as const` plus the
 * companion union type below gives the same call sites and the same exhaustiveness
 * checking with nothing left to emit.
 */
export const Verb = {
  Move: 0,
  Line: 1,
  Quad: 2,
  Conic: 3,
  Cubic: 4,
  Close: 5,
} as const;

/** Any one of the {@link Verb} values. */
export type Verb = (typeof Verb)[keyof typeof Verb];

/** POINTS_IN_VERB from _pathops.pyx — how many points each verb consumes. */
const POINTS_IN_VERB = [1, 1, 2, 2, 3, 0] as const;

/** Skia's `SK_ScalarNearlyZero`: 1/4096. Used for "are these points equal?". */
const SK_SCALAR_NEARLY_ZERO = 1 / (1 << 12);
const NEARLY_ZERO_SQD = SK_SCALAR_NEARLY_ZERO * SK_SCALAR_NEARLY_ZERO;

/** Skia's `can_normalize`: is this vector long enough to have a direction? */
function canNormalize(dx: number, dy: number): boolean {
  return dx * dx + dy * dy > NEARLY_ZERO_SQD;
}

/** `points_almost_equal` — within Skia's nearly-zero tolerance. */
function pointsAlmostEqual(a: Point, b: Point): boolean {
  return !canNormalize(a[0] - b[0], a[1] - b[1]);
}

/** `is_middle_point` — is p2 the midpoint of p1 and p3? (implied on-curve) */
function isMiddlePoint(p1: Point, p2: Point, p3: Point): boolean {
  const midx = (p1[0] + p3[0]) / 2;
  const midy = (p1[1] + p3[1]) / 2;
  return !canNormalize(p2[0] - midx, p2[1] - midy);
}

/** `collinear` — a triangle of zero area means the three points are in a line. */
function collinear(p1: Point, p2: Point, p3: Point): boolean {
  return (
    Math.abs(
      p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]),
    ) <= 2 * SK_SCALAR_NEARLY_ZERO
  );
}

// --------------------------------------------------------------------------- //
//  CanvasKit bootstrap
// --------------------------------------------------------------------------- //

/** The initialised CanvasKit module. `null` until {@link initSkia} has run. */
let CK: any = null;

/**
 * Load the CanvasKit WASM module. Must be awaited once before anything else in
 * this file is used; every other function here is synchronous afterwards, which
 * is what lets the ported engine keep the Python code's synchronous shape.
 */
export async function initSkia(): Promise<void> {
  if (CK) return;
  const require = createRequire(import.meta.url);
  const binDir = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
  CK = await CanvasKitInit({ locateFile: (f: string) => path.join(binDir, f) });
}

/** The raw CanvasKit module, for the few callers that need `Path` directly. */
export function canvasKit(): any {
  if (!CK) throw new Error("initSkia() has not been awaited yet");
  return CK;
}

// --------------------------------------------------------------------------- //
//  a path as plain data
// --------------------------------------------------------------------------- //

/**
 * One path as the compact (verb, point) stream Skia stores internally.
 *
 * Keeping paths as plain arrays rather than live CanvasKit handles matters: the
 * WASM objects have to be `delete()`d by hand, and a name like "CHRISTOPHER"
 * unions eleven glyphs, each pass allocating a new path. Plain arrays let the
 * garbage collector do it.
 */
export interface SkPathData {
  /** One entry per verb, in order. */
  verbs: Verb[];
  /** Flat point list; verb *i* owns `POINTS_IN_VERB[verbs[i]]` of them. */
  pts: Point[];
}

/** An empty path. */
export function emptyPath(): SkPathData {
  return { verbs: [], pts: [] };
}

/** True when the path has no verbs at all. */
export function isEmpty(p: SkPathData): boolean {
  return p.verbs.length === 0;
}

/** Deep copy, so callers can rotate/reverse a contour without side effects. */
export function clonePath(p: SkPathData): SkPathData {
  return { verbs: p.verbs.slice(), pts: p.pts.map((q) => [q[0], q[1]] as Point) };
}

/** Convert to the flat `[verb, ...coords, verb, ...]` array CanvasKit wants. */
function toCmdArray(p: SkPathData): number[] {
  const cmds: number[] = [];
  let i = 0;
  for (const v of p.verbs) {
    cmds.push(v);
    for (let k = 0; k < POINTS_IN_VERB[v]; k++, i++) cmds.push(p.pts[i][0], p.pts[i][1]);
  }
  return cmds;
}

/** Convert back from CanvasKit's flat command array. */
function fromCmdArray(cmds: Float32Array | number[]): SkPathData {
  const out = emptyPath();
  for (let i = 0; i < cmds.length; ) {
    const v = cmds[i++] as Verb;
    out.verbs.push(v);
    for (let k = 0; k < POINTS_IN_VERB[v]; k++) {
      out.pts.push([cmds[i], cmds[i + 1]]);
      i += 2;
    }
  }
  return out;
}

/**
 * Run `fn` with a live CanvasKit path built from `p`, then free it.
 * Every CanvasKit handle must be released or the WASM heap grows without bound.
 */
function withCkPath<T>(p: SkPathData, fn: (ck: any) => T): T {
  const handle = CK.Path.MakeFromCmds(toCmdArray(p));
  if (!handle) throw new Error("Skia rejected this path");
  try {
    return fn(handle);
  } finally {
    handle.delete();
  }
}

/** Translate every point. Skia's `transform(1,0,0,1,dx,dy)` does exactly this. */
export function translatePath(p: SkPathData, dx: number, dy: number): SkPathData {
  if (dx === 0 && dy === 0) return clonePath(p);
  return {
    verbs: p.verbs.slice(),
    pts: p.pts.map((q) => [q[0] + dx, q[1] + dy] as Point),
  };
}

/** Tight bounds (curve-aware, not control-point bounds) — or null when empty. */
function tightBounds(p: SkPathData): [number, number, number, number] | null {
  if (isEmpty(p)) return null;
  return withCkPath(p, (h) => {
    const r = h.computeTightBounds();
    return [r[0], r[1], r[2], r[3]] as [number, number, number, number];
  });
}

// --------------------------------------------------------------------------- //
//  contours
// --------------------------------------------------------------------------- //

/**
 * Split a path into one path per contour, exactly like `Path.contours`.
 *
 * A contour ends either at a CLOSE verb or at the next MOVE — skia contours are
 * implicitly open unless closed explicitly.
 */
export function contours(p: SkPathData): SkPathData[] {
  const out: SkPathData[] = [];
  let cur = emptyPath();
  let i = 0;
  for (const v of p.verbs) {
    const n = POINTS_IN_VERB[v];
    const own = p.pts.slice(i, i + n);
    i += n;
    if (v === Verb.Move) {
      if (!isEmpty(cur)) out.push(cur);
      cur = emptyPath();
      cur.verbs.push(v);
      cur.pts.push(...own);
    } else {
      cur.verbs.push(v);
      cur.pts.push(...own);
      if (v === Verb.Close) {
        out.push(cur);
        cur = emptyPath();
      }
    }
  }
  if (!isEmpty(cur)) out.push(cur);
  return out;
}

/** Concatenate contours back into one path. */
function joinContours(cs: SkPathData[]): SkPathData {
  const out = emptyPath();
  for (const c of cs) {
    out.verbs.push(...c.verbs);
    out.pts.push(...c.pts);
  }
  return out;
}

/** The first point of every contour — `Path.firstPoints`. */
export function firstPoints(p: SkPathData): Point[] {
  const out: Point[] = [];
  let i = 0;
  for (const v of p.verbs) {
    if (v === Verb.Move) out.push([p.pts[i][0], p.pts[i][1]]);
    i += POINTS_IN_VERB[v];
  }
  return out;
}

/** Does this single contour end with an explicit CLOSE? */
function contourIsClosed(verbs: Verb[]): boolean {
  let closed = false;
  for (let i = 1; i < verbs.length; i++) {
    if (verbs[i] === Verb.Move) throw new Error("expected a single contour");
    if (verbs[i] === Verb.Close) closed = true;
  }
  return closed;
}

/**
 * Signed area of a path, ported from `get_path_area` (itself fontTools'
 * areaPen). Negative means clockwise. Used only to sort and orient contours.
 */
export function pathArea(p: SkPathData): number {
  let value = 0;
  let p0: Point = [0, 0];
  let startPoint: Point = [0, 0];
  let needClose = false;
  let i = 0;
  for (const v of p.verbs) {
    const n = POINTS_IN_VERB[v];
    const own = p.pts.slice(i, i + n);
    i += n;
    if (v === Verb.Move) {
      if (needClose) value -= (startPoint[0] - p0[0]) * (startPoint[1] + p0[1]) * 0.5;
      p0 = startPoint = own[0];
      needClose = true;
    } else if (v === Verb.Line) {
      value -= (own[0][0] - p0[0]) * (own[0][1] + p0[1]) * 0.5;
      p0 = own[0];
    } else if (v === Verb.Quad) {
      // https://github.com/Pomax/bezierinfo/issues/44
      const [x0, y0] = p0;
      const x1 = own[0][0] - x0, y1 = own[0][1] - y0;
      const x2 = own[1][0] - x0, y2 = own[1][1] - y0;
      value -= (x2 * y1 - x1 * y2) / 3;
      value -= (own[1][0] - x0) * (own[1][1] + y0) * 0.5;
      p0 = own[1];
    } else if (v === Verb.Conic) {
      throw new Error("CONIC verbs are not supported");
    } else if (v === Verb.Cubic) {
      const [x0, y0] = p0;
      const x1 = own[0][0] - x0, y1 = own[0][1] - y0;
      const x2 = own[1][0] - x0, y2 = own[1][1] - y0;
      const x3 = own[2][0] - x0, y3 = own[2][1] - y0;
      value -=
        (x1 * (-y2 - y3) + x2 * (y1 - 2 * y3) + x3 * (y1 + 2 * y2)) * 0.15;
      value -= (own[2][0] - x0) * (own[2][1] + y0) * 0.5;
      p0 = own[2];
    } else if (v === Verb.Close) {
      value -= (startPoint[0] - p0[0]) * (startPoint[1] + p0[1]) * 0.5;
      p0 = startPoint = [0, 0];
      needClose = false;
    }
  }
  return value;
}

/**
 * Reverse one contour in place, ported from `reverse_contour`.
 * The contour's last point becomes its first and every segment is walked
 * backwards, so a clockwise ring becomes counter-clockwise.
 */
function reverseContour(c: SkPathData): void {
  if (isEmpty(c)) return;
  // the last point in the compact array is the contour's current end point
  if (c.pts.length === 0) return;
  const lastPt = c.pts[c.pts.length - 1];

  const verbs: Verb[] = [];
  const pts: Point[] = [];
  // temp.moveTo(lastPt)
  verbs.push(Verb.Move);
  pts.push([lastPt[0], lastPt[1]]);

  // Walk the verb and point arrays backwards, stopping before the leading MOVE.
  //
  // The indices mirror skia-pathops' pointer arithmetic exactly: it starts BOTH
  // cursors at `end() - 1`, i.e. at the last element, and subtracts the current
  // verb's point count before reading. Starting the point cursor one past the
  // end instead reads every segment shifted by one point, which silently turns
  // quadratics into lines and loses two thirds of the flattened outline.
  let vi = c.verbs.length - 1;
  let pi = c.pts.length - 1;
  let closed = false;
  while (vi > 0) {
    const v = c.verbs[vi];
    vi -= 1;
    pi -= POINTS_IN_VERB[v];
    const own = c.pts.slice(pi, pi + POINTS_IN_VERB[v]);
    if (v === Verb.Move) break; // multi-contour input: only reverse the last
    else if (v === Verb.Line) {
      verbs.push(Verb.Line);
      pts.push(own[0]);
    } else if (v === Verb.Quad) {
      verbs.push(Verb.Quad);
      pts.push(own[1], own[0]);
    } else if (v === Verb.Conic) {
      throw new Error("CONIC verbs are not supported");
    } else if (v === Verb.Cubic) {
      verbs.push(Verb.Cubic);
      pts.push(own[2], own[1], own[0]);
    } else if (v === Verb.Close) {
      closed = true;
    }
  }
  if (closed) verbs.push(Verb.Close);

  c.verbs = verbs;
  c.pts = pts;
}

/**
 * `path_is_inside(self, other)` — true when every on-curve point of `other`
 * lies inside `self`. Only valid on simplified (non-overlapping) paths, which
 * is what Skia's boolean ops return.
 */
function pathIsInside(self: SkPathData, other: SkPathData): boolean {
  const r1 = tightBounds(self);
  const r2 = tightBounds(other);
  if (!r1 || !r2) return false;
  // SkRect::Intersects — strict, so merely touching does not count
  if (!(r1[0] < r2[2] && r2[0] < r1[2] && r1[1] < r2[3] && r2[1] < r1[3])) return false;

  // collect other's on-curve points (the last point of each drawing verb)
  const onCurve: Point[] = [];
  let i = 0;
  for (const v of other.verbs) {
    const n = POINTS_IN_VERB[v];
    if (n > 0) onCurve.push(other.pts[i + n - 1]);
    i += n;
  }
  return withCkPath(self, (h) => onCurve.every((q) => h.contains(q[0], q[1])));
}

/**
 * `winding_from_even_odd` — orient a simplified path for the non-zero rule.
 *
 * Contours are sorted by descending absolute area, their nesting depth is
 * counted, and any contour whose direction disagrees with its depth is
 * reversed. Outermost contours end up counter-clockwise unless `clockwise`.
 *
 * The *re-ordering* is a visible side effect: the contours in the returned path
 * are in area order, not in the order Skia produced them. The SVG writer emits
 * them in that order, so this has to be reproduced to match the golden files.
 */
export function windingFromEvenOdd(p: SkPathData, clockwise = false): SkPathData {
  const inverse = !clockwise;

  // group by -|area| so equal-area contours keep their relative order, then
  // read the groups back in ascending key order == descending |area|
  const byArea = new Map<number, SkPathData[]>();
  for (const c of contours(p)) {
    const key = -Math.abs(pathArea(c));
    const group = byArea.get(key);
    if (group) group.push(c);
    else byArea.set(key, [c]);
  }
  const ordered: SkPathData[] = [];
  for (const key of Array.from(byArea.keys()).sort((a, b) => a - b)) {
    ordered.push(...byArea.get(key)!);
  }

  // increment the nesting level whenever a contour sits inside an earlier one
  const nested = new Array(ordered.length).fill(0);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      if (pathIsInside(ordered[i], ordered[j])) nested[j] += 1;
    }
  }

  // reverse a contour when its winding and its even-odd depth disagree
  for (let i = 0; i < ordered.length; i++) {
    const isClockwise = pathArea(ordered[i]) < 0;
    const isEven = (nested[i] & 1) === 0;
    // Python: if inverse ^ is_clockwise ^ is_even  (booleans as 0/1)
    if ((Number(inverse) ^ Number(isClockwise) ^ Number(isEven)) === 1) {
      reverseContour(ordered[i]);
    }
  }
  return joinContours(ordered);
}

/**
 * `find_oncurve_point` — index of the on-curve point that exactly equals (x, y).
 * Returns the index into the compact point array and the owning verb index, or
 * null. The comparison is exact, like `SkPoint::equals`.
 */
function findOnCurvePoint(
  x: number,
  y: number,
  pts: Point[],
  verbs: Verb[],
): { ptIndex: number; verbIndex: number } | null {
  let seen = 0;
  for (let i = 0; i < verbs.length; i++) {
    const n = POINTS_IN_VERB[verbs[i]];
    if (n === 0) continue;
    const j = seen + n - 1;
    if (pts[j][0] === x && pts[j][1] === y) return { ptIndex: j, verbIndex: i };
    seen += n;
  }
  return null;
}

/**
 * `set_contour_start_point` — rotate one contour so it begins at (x, y).
 *
 * Returns true when the contour was changed. Nothing happens unless (x, y) is
 * already an on-curve point of this contour and is not already its start.
 *
 * The old `moveTo` becomes a `lineTo` on the way round — unless it would be a
 * zero-length or collinear step — and a closing `lineTo` that merely repeats
 * the old start point is dropped. That dropped segment is why a rotated
 * contour can come out with one fewer point than the raw Skia output.
 */
function setContourStartPoint(c: SkPathData, x: number, y: number): boolean {
  const verbs = c.verbs;
  const pts = c.pts;
  const verbCount = verbs.length;
  const ptCount = pts.length;
  const closed = contourIsClosed(verbs);

  const found = findOnCurvePoint(x, y, pts, verbs);
  if (!found) return false;
  const { ptIndex, verbIndex } = found;
  if (ptIndex === 0) return false;
  if (!closed && ptIndex !== ptCount - 1) return false;

  if (!closed && ptIndex === ptCount - 1) {
    reverseContour(c);
    return true;
  }

  const nv: Verb[] = [];
  const np: Point[] = [];
  const firstVerb = verbs[verbIndex];
  let vi = (verbIndex + 1) % verbCount;
  const firstPt = pts[ptIndex];
  let pi = (ptIndex + 1) % ptCount;

  nv.push(Verb.Move);
  np.push([firstPt[0], firstPt[1]]);
  let last: Point = firstPt;

  for (let i = 1; i < verbCount; i++) {
    const v = verbs[vi];
    const n = POINTS_IN_VERB[v];
    if (v === Verb.Move) {
      // the original moveTo becomes a lineTo, unless it repeats the previous
      // point or is collinear with the next line segment
      const nextIsLine = verbs[(vi + 1) % verbCount] === Verb.Line;
      if (
        pointsAlmostEqual(last, pts[pi]) ||
        (nextIsLine && collinear(last, pts[pi], pts[(pi + 1) % ptCount]))
      ) {
        // drop it
      } else {
        nv.push(Verb.Line);
        np.push(pts[pi]);
        last = pts[pi];
      }
    } else if (v === Verb.Line) {
      // drop a closing lineTo whose endpoint is the old start point
      if (
        verbs[(vi + 1) % verbCount] === Verb.Close &&
        pointsAlmostEqual(pts[pi], pts[(pi + 1) % ptCount])
      ) {
        // drop it
      } else {
        nv.push(Verb.Line);
        np.push(pts[pi]);
        last = pts[pi];
      }
    } else if (v === Verb.Quad) {
      nv.push(Verb.Quad);
      np.push(pts[pi], pts[pi + 1]);
      last = pts[pi + 1];
    } else if (v === Verb.Conic) {
      throw new Error("CONIC verbs are not supported");
    } else if (v === Verb.Cubic) {
      nv.push(Verb.Cubic);
      np.push(pts[pi], pts[pi + 1], pts[pi + 2]);
      last = pts[pi + 2];
    } // Close: nothing
    vi = (vi + 1) % verbCount;
    pi = (pi + n) % ptCount;
  }

  // the segment that originally ARRIVED at the new start point closes the loop
  if (firstVerb === Verb.Quad) {
    nv.push(Verb.Quad);
    np.push(pts[pi], pts[pi + 1]);
  } else if (firstVerb === Verb.Cubic) {
    nv.push(Verb.Cubic);
    np.push(pts[pi], pts[pi + 1], pts[pi + 2]);
  }
  nv.push(Verb.Close);

  c.verbs = nv;
  c.pts = np;
  return true;
}

/**
 * `restore_starting_points` — rotate the result's contours back onto the input
 * contours' starting points. Each candidate point is used at most once, and
 * they are tried in the order the inputs supplied them.
 */
export function restoreStartingPoints(p: SkPathData, points: Point[]): SkPathData {
  if (points.length === 0) return p;
  const cs = contours(p);
  const remaining = points.slice();
  let modified = false;
  for (const c of cs) {
    for (let j = 0; j < remaining.length; j++) {
      if (setContourStartPoint(c, remaining[j][0], remaining[j][1])) {
        modified = true;
        remaining.splice(j, 1); // never reuse a point on another contour
        break;
      }
    }
  }
  return modified ? joinContours(cs) : p;
}

// --------------------------------------------------------------------------- //
//  the boolean operation
// --------------------------------------------------------------------------- //

/** Skia path operators, matching `pathops.PathOp`. */
export const PathOp = {
  DIFFERENCE: 0,
  INTERSECT: 1,
  UNION: 2,
  XOR: 3,
  REVERSE_DIFFERENCE: 4,
} as const;
export type PathOpName = (typeof PathOp)[keyof typeof PathOp];

/**
 * `pathops.op(one, two, operator)` — Skia's boolean op plus skia-pathops'
 * two post-processing passes, defaults included.
 *
 * @param one   left operand
 * @param two   right operand
 * @param op    which boolean operation
 * @param fixWinding           re-orient (and re-order) contours for non-zero fill
 * @param keepStartingPoints   rotate contours back onto the inputs' start points
 * @param clockwise            make outermost contours clockwise instead
 */
export function op(
  one: SkPathData,
  two: SkPathData,
  op: PathOpName,
  fixWinding = true,
  keepStartingPoints = true,
  clockwise = false,
): SkPathData {
  const first = keepStartingPoints ? [...firstPoints(one), ...firstPoints(two)] : [];

  const a = CK.Path.MakeFromCmds(toCmdArray(one));
  const b = CK.Path.MakeFromCmds(toCmdArray(two));
  if (!a || !b) throw new Error("Skia rejected an operand path");
  let raw: SkPathData;
  try {
    const r = CK.Path.MakeFromOp(a, b, mapOp(op));
    if (!r) throw new Error("operation did not succeed");
    try {
      raw = fromCmdArray(r.toCmds());
    } finally {
      r.delete();
    }
  } finally {
    a.delete();
    b.delete();
  }

  let result = raw;
  if (fixWinding) result = windingFromEvenOdd(result, clockwise);
  if (keepStartingPoints) result = restoreStartingPoints(result, first);
  return result;
}

/** Our operator constants happen to match CanvasKit's, but be explicit. */
function mapOp(o: PathOpName): any {
  switch (o) {
    case PathOp.DIFFERENCE: return CK.PathOp.Difference;
    case PathOp.INTERSECT: return CK.PathOp.Intersect;
    case PathOp.UNION: return CK.PathOp.Union;
    case PathOp.XOR: return CK.PathOp.XOR;
    case PathOp.REVERSE_DIFFERENCE: return CK.PathOp.ReverseDifference;
  }
}

// --------------------------------------------------------------------------- //
//  reading a path back out — the pen protocol
// --------------------------------------------------------------------------- //

/**
 * One pen call, as `skia-pathops`' `Path.segments` yields it.
 *
 * `qCurveTo` carries any number of off-curve points followed by the on-curve
 * end point, which may be `null` for the all-off-curve TrueType spline case.
 */
export type Segment =
  | { op: "moveTo"; pts: [Point] }
  | { op: "lineTo"; pts: [Point] }
  | { op: "qCurveTo"; pts: (Point | null)[] }
  | { op: "curveTo"; pts: [Point, Point, Point] }
  | { op: "closePath"; pts: [] }
  | { op: "endPath"; pts: [] };

/**
 * `Path.segments` — the verb stream as pen calls, with skia-pathops' two
 * conventions applied:
 *
 *  1. consecutive quadratics that share an implied on-curve midpoint collapse
 *     into one `qCurveTo` (TrueType's compact spline form);
 *  2. a final `lineTo`/curve endpoint that merely repeats the contour's first
 *     point is snapped to that first point, so nothing draws a zero-length
 *     closing segment;
 *  3. a whole contour that is one closed all-off-curve quadratic spline loses
 *     its `moveTo` and ends with `null`, which is how fontTools spells "the
 *     start point is implied".
 */
export function segments(p: SkPathData): Segment[] {
  const raw: Segment[] = [];
  const verbs = p.verbs;
  let pi = 0;
  let movePt: Point = [0, 0];
  let closed = true;

  const nextIsClose = (i: number) => i + 1 < verbs.length && verbs[i + 1] === Verb.Close;

  for (let i = 0; i < verbs.length; i++) {
    const v = verbs[i];
    if (v === Verb.Move) {
      // skia contours are implicitly open unless they end with CLOSE
      if (!closed) {
        closed = true;
        raw.push({ op: "endPath", pts: [] });
        i -= 1; // re-read this MOVE on the next pass
        continue;
      }
      movePt = p.pts[pi];
      closed = false;
      raw.push({ op: "moveTo", pts: [movePt] });
      pi += 1;
    } else if (v === Verb.Close) {
      closed = true;
      raw.push({ op: "closePath", pts: [] });
    } else if (v === Verb.Line) {
      const end = nextIsClose(i) && pointsAlmostEqual(p.pts[pi], movePt) ? movePt : p.pts[pi];
      raw.push({ op: "lineTo", pts: [end] });
      pi += 1;
    } else if (v === Verb.Quad) {
      // join the run of quadratics that share implied on-curve midpoints
      const pts: Point[] = [];
      let vi = i;
      let qi = pi;
      for (;;) {
        pts.push(p.pts[qi]); // this quad's off-curve point
        const nextVerb = vi + 1 < verbs.length ? verbs[vi + 1] : null;
        if (nextVerb === Verb.Quad) {
          // p.pts[qi+1] is this quad's on-curve end, p.pts[qi+2] the next
          // quad's off-curve point; if the end is their midpoint it is implied
          if (isMiddlePoint(p.pts[qi], p.pts[qi + 1], p.pts[qi + 2])) {
            vi += 1;
            qi += 2;
            continue;
          }
        } else if (nextVerb === Verb.Close && pointsAlmostEqual(p.pts[qi + 1], movePt)) {
          pts.push(movePt);
          qi += 2;
          break;
        }
        pts.push(p.pts[qi + 1]);
        qi += 2;
        break;
      }
      raw.push({ op: "qCurveTo", pts });
      i = vi;
      pi = qi;
    } else if (v === Verb.Cubic) {
      const end =
        nextIsClose(i) && pointsAlmostEqual(p.pts[pi + 2], movePt) ? movePt : p.pts[pi + 2];
      raw.push({ op: "curveTo", pts: [p.pts[pi], p.pts[pi + 1], end] });
      pi += 3;
    } else {
      throw new Error("CONIC verbs are not supported");
    }
  }
  if (!closed) raw.push({ op: "endPath", pts: [] });

  // Pass 2: the TrueType all-off-curve closed spline. When a contour is a
  // single closed qCurveTo whose start point is the midpoint of the last and
  // first off-curve points, the moveTo is dropped and the end becomes null.
  const out: Segment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const prev = i > 0 ? raw[i - 1] : null;
    const cur = raw[i];
    const next = i + 1 < raw.length ? raw[i + 1] : null;
    if (
      prev && prev.op === "moveTo" &&
      cur.op === "qCurveTo" &&
      next && next.op === "closePath" &&
      cur.pts.length > 1
    ) {
      const movePoint = prev.pts[0];
      const lastOn = cur.pts[cur.pts.length - 1];
      if (lastOn && movePoint[0] === lastOn[0] && movePoint[1] === lastOn[1]) {
        const lastOff = cur.pts[cur.pts.length - 2] as Point;
        const firstOff = cur.pts[0] as Point;
        if (isMiddlePoint(lastOff, movePoint, firstOff)) {
          out.pop(); // drop the moveTo
          out.push({ op: "qCurveTo", pts: [...cur.pts.slice(0, -1), null] });
          continue;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

/** Curve → polyline steps. Measurement and export both use this resolution. */
export const FLATTEN_STEPS = 24;

/** A quadratic Bézier as {@link FLATTEN_STEPS} points, excluding the start. */
function stepQuad(p0: Point, p1: Point, p2: Point): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= FLATTEN_STEPS; i++) {
    const t = i / FLATTEN_STEPS;
    const m = 1 - t;
    pts.push([
      m * m * p0[0] + 2 * m * t * p1[0] + t * t * p2[0],
      m * m * p0[1] + 2 * m * t * p1[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

/** A cubic Bézier as {@link FLATTEN_STEPS} points, excluding the start. */
function stepCubic(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= FLATTEN_STEPS; i++) {
    const t = i / FLATTEN_STEPS;
    const m = 1 - t;
    pts.push([
      m*m*m*p0[0] + 3*m*m*t*p1[0] + 3*m*t*t*p2[0] + t*t*t*p3[0],
      m*m*m*p0[1] + 3*m*m*t*p1[1] + 3*m*t*t*p2[1] + t*t*t*p3[1],
    ]);
  }
  return pts;
}

/**
 * Flatten a path's contours to polylines — the Python engine's
 * `_flatten_recording` and `Font.contours` are the same walk over the same pen
 * calls, so both are served from here.
 *
 * Contours shorter than three points are dropped: they enclose no area and only
 * ever came from degenerate font data.
 *
 * TRAP (SPEC.md §8.3): a new `moveTo` must close the previous contour, because
 * skia does not always emit `closePath` and contours get lost if you only
 * collect on close.
 */
export function flatten(p: SkPathData): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] | null = null;
  let pt: Point = [0, 0];

  for (const seg of segments(p)) {
    if (seg.op === "moveTo") {
      if (cur && cur.length > 2) out.push(cur);
      pt = seg.pts[0];
      cur = [pt];
    } else if (seg.op === "lineTo") {
      pt = seg.pts[0];
      cur!.push(pt);
    } else if (seg.op === "curveTo") {
      const [c1, c2, e] = seg.pts;
      cur!.push(...stepCubic(pt, c1, c2, e));
      pt = e;
    } else if (seg.op === "qCurveTo") {
      let pts = seg.pts.slice();
      if (pts.length && pts[pts.length - 1] === null) {
        // All-off-curve closed contour: a ring drawn with no on-curve points at
        // all. Legal TrueType, and how some fonts draw eyelet circles. It
        // arrives with NO preceding moveTo, so the contour starts at the implied
        // midpoint of the first and last off-curve points.
        if (cur && cur.length > 2) out.push(cur);
        pts = pts.slice(0, -1);
        const first = pts[0] as Point;
        const last = pts[pts.length - 1] as Point;
        const mid: Point = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
        cur = [mid];
        pt = mid;
        pts = [...pts, mid];
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const ctrl = pts[i] as Point;
        const nxt = pts[i + 1] as Point;
        // every off-curve point but the last implies an on-curve midpoint
        const end: Point =
          i < pts.length - 2 ? [(ctrl[0] + nxt[0]) / 2, (ctrl[1] + nxt[1]) / 2] : nxt;
        cur!.push(...stepQuad(pt, ctrl, end));
        pt = end;
      }
    } else {
      // closePath / endPath
      if (cur && cur.length > 2) out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length > 2) out.push(cur);
  return out;
}

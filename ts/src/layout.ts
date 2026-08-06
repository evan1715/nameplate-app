/**
 * layout.ts — how several names sit on one sheet.
 *
 *     vertical    stacked top to bottom, aligned on the left   (the original)
 *     horizontal  placed left to right, aligned on the bottom
 *
 * Each name is placed by its own bounding box plus the gap, so with any gap >= 0
 * two names can never overlap — at gap 0 they touch exactly, and every larger gap
 * separates them. {@link arrangementBounds} hands back the box each name ended up
 * in so that can be verified rather than assumed.
 *
 * Vertical delegates to core's `stack()` unchanged, so existing sheets come out
 * byte-for-byte as before.
 */

import { Document, stack, ValueError } from "./core.js";
import { emptyPath, type Point } from "./skia.js";

/** Stacked top to bottom, aligned on the left. */
export const VERTICAL = "vertical";
/** Placed left to right, aligned on the bottom. */
export const HORIZONTAL = "horizontal";
/** Both directions, for a CLI choice list. */
export const DIRECTIONS = [VERTICAL, HORIZONTAL] as const;
/** Which way a sheet runs. */
export type Direction = (typeof DIRECTIONS)[number];

/** This document's geometry moved so its bbox corner sits at (dx, dy). */
function placedRings(doc: Document, dx: number, dy: number): {
  cut: Point[][];
  eng: Point[][];
} {
  const sc = doc.scale;
  const [x0, y0] = doc.bbox;
  const move = ([x, y]: Point): Point => [(x - x0) * sc + dx, (y - y0) * sc + dy];
  const cut = doc.cutPaths.flatMap((rings) => rings.map((ring) => ring.map(move)));
  const eng = doc.engravePaths.map((line) => line.map(move));
  return { cut, eng };
}

/**
 * The box each name occupies, in sheet units, in the order given.
 * @returns one `[x0, y0, x1, y1]` per document
 */
export function arrangementBounds(
  docs: Document[],
  gap = 0.25,
  direction: Direction = VERTICAL,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (direction === HORIZONTAL) {
    let x = 0.0;
    for (const d of docs) {
      const [w, h] = d.size();
      out.push([x, 0.0, x + w, h]);
      x += w + gap;
    }
  } else {
    let yTop = 0.0;
    for (const d of docs) {
      const [w, h] = d.size();
      out.push([0.0, yTop - h, w, yTop]);
      yTop -= h + gap;
    }
  }
  return out;
}

/**
 * Index pairs whose boxes genuinely overlap. Touching does not count.
 *
 * The CLI calls this BEFORE writing anything, so a gap that would print one name
 * on top of another is refused rather than exported.
 */
export function overlaps(
  docs: Document[],
  gap = 0.25,
  direction: Direction = VERTICAL,
): [number, number][] {
  const boxes = arrangementBounds(docs, gap, direction);
  const bad: [number, number][] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [ax0, ay0, ax1, ay1] = boxes[i];
      const [bx0, by0, bx1, by1] = boxes[j];
      const ix = Math.min(ax1, bx1) - Math.max(ax0, bx0);
      const iy = Math.min(ay1, by1) - Math.max(ay0, by0);
      if (ix > 1e-9 && iy > 1e-9) bad.push([i, j]);
    }
  }
  return bad;
}

/**
 * One Document holding every name, already scaled into sheet units.
 * @throws {ValueError} when `docs` is empty
 */
export function arrange(
  docs: Document[],
  gap = 0.25,
  direction: Direction = VERTICAL,
): Document {
  if (docs.length === 0) throw new ValueError("nothing to arrange");
  // unchanged for vertical, which keeps the golden output identical
  if (direction !== HORIZONTAL) return stack(docs, gap);

  const d0 = docs[0];
  const cutRings: Point[][] = [];
  const engLines: Point[][] = [];
  let xLeft = 0.0;
  for (const d of docs) {
    const { cut, eng } = placedRings(d, xLeft, 0.0);
    cutRings.push(...cut);
    engLines.push(...eng);
    xLeft += d.size()[0] + gap; // its own width, then the gap
  }

  const xs = cutRings.flatMap((r) => r.map((p) => p[0]));
  const ys = cutRings.flatMap((r) => r.map((p) => p[1]));
  return new Document({
    text: docs.map((d) => d.text).join(" / "),
    fontFamily: d0.fontFamily,
    upem: d0.upem,
    cutPaths: [cutRings],
    cutSkia: emptyPath(),
    engravePaths: engLines,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    basis: "sheet",
    basisHeight: 1.0,
    targetHeight: 1.0,
    unit: d0.unit,
    warnings: docs.flatMap((d) => d.warnings),
  });
}

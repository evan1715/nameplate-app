/**
 * core.ts — engine for the ShineOn Nameplate Cut-File app.
 *
 * WHAT THIS DOES
 *     name text + font file + target height  ->  laser-ready outline artwork
 *
 *     * shapes the name with the font's own OpenType features, so contextual
 *       forms (eyelets, engrave variants) come out exactly as the font intends
 *     * unions every letter into ONE closed cut path, curves preserved, so the
 *       overlapping letters read as a single piece with no internal seams
 *     * pulls the engrave lines out of the font's COLR colour layers and
 *       converts them to open centerlines (one laser pass, not a filled sliver)
 *     * scales to a real-world height measured from the cap height, the
 *       x-height, or the whole artwork
 *     * writes SVG and PDF with hairline strokes, no fills, CUT and ENGRAVE
 *       separated
 *
 * This module has NO user interface and no global state:
 *
 *     const doc = buildDocument(font, "ADAM", 1.0, "in", "cap");
 *     const svg = svgSingle(doc);                 // string
 *     const pdf = pdfDocument([doc]);             // Uint8Array
 *     //  doc.cutPaths / doc.engravePaths are also there for on-screen preview
 *
 * Everything is in font units internally; scaling happens only at export.
 *
 * PORTING NOTE
 *     `initSkia()` must be awaited once before `buildDocument` is called. The
 *     Skia binding is WebAssembly and loads asynchronously; everything after
 *     that is synchronous, which keeps this file the same shape as the Python.
 */

import * as zlib from "node:zlib";
import { Font, type Placed, shape } from "./font.ts";
import * as G from "./geom.ts";
import {
  type Point,
  type SkPathData,
  PathOp,
  clonePath,
  emptyPath,
  op as skOp,
  segments,
  translatePath,
} from "./skia.ts";
import { fmtF, pyFloat, pyG } from "./pyformat.ts";

export const MM_PER_IN = 25.4;
export const PT_PER_IN = 72.0;
/** SVG stroke width; PDF uses width 0 (device hairline). */
export const HAIRLINE_IN = 0.001;
/** Curve → polyline steps, for measurement and engrave lines only. */
export const FLATTEN_STEPS = 24;
/** How far a glyph outline may sit from a red band and still match. */
export const ENGRAVE_TOL = 1.5;
/** Font units; shorter engrave fragments are specks, not lines. */
export const MIN_ENGRAVE_LEN = 25.0;

/** Which reference height the user's number refers to. */
export type Basis = "cap" | "xheight" | "total" | "sheet";
/** Real-world unit the artwork is sized in. */
export type Unit = "in" | "mm";

/** Everything one name needs to be previewed and exported. */
export class Document {
  /** The name as typed. */
  text: string;
  /** nameID 4 of the font it was set in. */
  fontFamily: string;
  /** Units per em of that font. */
  upem: number;
  /** Closed contours, font units. One entry per source document. */
  cutPaths: Point[][][];
  /** The same cut path with its curves intact, for anything that needs them. */
  cutSkia: SkPathData;
  /** Open polylines, font units — the engrave centerlines. */
  engravePaths: Point[][];
  /** (x0, y0, x1, y1) in font units. */
  bbox: [number, number, number, number];
  /** Which reference height {@link targetHeight} refers to. */
  basis: Basis;
  /** The reference height in font units, used for scaling. */
  basisHeight: number;
  /** The height the user asked for, in {@link unit}. */
  targetHeight: number;
  /** "in" or "mm". */
  unit: Unit;
  /** Informational notes for the user. Never errors, never block export. */
  warnings: string[];

  constructor(init: {
    text: string;
    fontFamily: string;
    upem: number;
    cutPaths: Point[][][];
    cutSkia: SkPathData;
    engravePaths: Point[][];
    bbox: [number, number, number, number];
    basis: Basis;
    basisHeight: number;
    targetHeight: number;
    unit: Unit;
    warnings?: string[];
  }) {
    this.text = init.text;
    this.fontFamily = init.fontFamily;
    this.upem = init.upem;
    this.cutPaths = init.cutPaths;
    this.cutSkia = init.cutSkia;
    this.engravePaths = init.engravePaths;
    this.bbox = init.bbox;
    this.basis = init.basis;
    this.basisHeight = init.basisHeight;
    this.targetHeight = init.targetHeight;
    this.unit = init.unit;
    this.warnings = init.warnings ?? [];
  }

  /**
   * font units → target unit (multiply).
   *
   * @throws when the reference height is not a usable size. A zero basis divided
   * straight through to a division by zero, and a non-finite one poisoned every
   * coordinate with inf/nan on the way to the file. Refuse with a message
   * instead of clamping to something the user did not ask for.
   */
  get scale(): number {
    if (!Number.isFinite(this.basisHeight) || this.basisHeight <= 0) {
      throw new ValueError(
        `Cannot scale ${pyRepr(this.text)}: the '${this.basis}' reference height ` +
          `measured ${pyFloat(this.basisHeight)} font units, which is not a usable ` +
          `size. Try a different height basis, or check the font.`,
      );
    }
    return this.targetHeight / this.basisHeight;
  }

  /** (width, height) in {@link unit} — this is the number to show the user. */
  size(): [number, number] {
    const [x0, y0, x1, y1] = this.bbox;
    const s = this.scale;
    return [(x1 - x0) * s, (y1 - y0) * s];
  }

  /** A shallow copy with some fields replaced — Python's `dataclasses.replace`. */
  replace(changes: Partial<Document>): Document {
    const d = new Document({
      text: this.text,
      fontFamily: this.fontFamily,
      upem: this.upem,
      cutPaths: this.cutPaths,
      cutSkia: this.cutSkia,
      engravePaths: this.engravePaths,
      bbox: this.bbox,
      basis: this.basis,
      basisHeight: this.basisHeight,
      targetHeight: this.targetHeight,
      unit: this.unit,
      warnings: this.warnings,
    });
    Object.assign(d, changes);
    return d;
  }
}

/** The engine's refusals, so callers can tell them from programming errors. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Python's `repr()` for a string, used inside engine messages. */
export function pyRepr(s: string): string {
  const esc = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${esc}'`;
}

/**
 * Capitals whose tops sit exactly ON the cap line. Round letters (O Q C G S) and
 * pointed ones (A) deliberately overshoot it, and J/Q descend below the
 * baseline, so none of those can define the cap height.
 */
export const FLAT_CAPS = "HETIFLMNVWXZ";
/**
 * Lowercase letters whose tops sit exactly on the x-line, for the same reason —
 * 'o' and 'e' overshoot, 'b'/'d'/'k' ascend, 'g'/'p'/'y' descend.
 */
export const FLAT_XHEIGHT = "xzvwus";

/**
 * The font's cap height in font units — ONE number for the whole font.
 *
 * This is deliberately independent of the name being set. Measuring whichever
 * capital happens to come first made the same setting deliver different metal:
 * 'JADAM' came out about 20% smaller than 'ADAM', because 'J' descends and its
 * total ink is far taller than its cap. Every name must scale by the same factor
 * or two orders in one job do not match.
 *
 * Measured from the font's own flat-topped capitals rather than taken from
 * OS/2.sCapHeight, because that metric is frequently wrong in display and script
 * faces — of the fonts in use here it disagrees with the real outlines by 27% in
 * one and 69% in another. The declared value is only a fallback.
 *
 * Ascenders and descenders are excluded by construction: the reference is the cap
 * line, so a descender simply hangs below it and makes the finished piece taller
 * without changing how big the letters are.
 */
export function capReference(font: Font): { ref: number; warn: string[] } {
  if (font.capRefCache) return font.capRefCache;

  const tops: number[] = [];
  for (const ch of FLAT_CAPS) {
    const gid = font.gidForChar(ch);
    if (gid === undefined) continue;
    const ys = font.contours(gid).flatMap((c) => c.map((p) => p[1]));
    if (ys.length && Math.max(...ys) > 0) tops.push(round3(Math.max(...ys)));
  }

  const warn: string[] = [];
  let ref = 0;
  const declared = font.declaredCapHeight;
  if (tops.length) {
    // the modal top, so one swash or one badly drawn letter cannot skew it
    ref = modal(tops);
    if (declared && Math.abs(declared - ref) > Math.max(2.0, ref * 0.02)) {
      warn.push(
        `This font declares a cap height of ${pyG(declared)} units but its ` +
          `capitals actually measure ${pyG(ref)}. Using the measured value, ` +
          `so the letters come out the size you asked for.`,
      );
    }
  } else if (declared && declared > 0) {
    ref = declared;
    warn.push(
      "No flat-topped capital to measure — used the cap height this font declares.",
    );
  }

  font.capRefCache = { ref, warn };
  return font.capRefCache;
}

/** Height in font units that the user's number refers to. */
export function measureBasis(
  font: Font,
  _text: string,
  placed: Placed[],
  basis: Basis,
): { height: number; warn: string[] } {
  const warn: string[] = [];

  if (basis === "cap") {
    // One reference for the WHOLE font (see capReference), never whichever
    // capital the name happens to start with: sizing by the first capital's ink
    // delivered 'JADAM' ~20% smaller than 'ADAM' for the same setting, because
    // 'J' descends. The superseded output is kept in
    // golden/superseded_first_capital_basis/ for the record.
    const { ref, warn: refWarn } = capReference(font);
    if (ref) return { height: ref, warn: [...warn, ...refWarn] };
    warn.push(
      "This font has no capital letters to measure — measured the whole artwork instead.",
    );
    basis = "total";
  } else if (basis === "xheight") {
    // Measured outlines first, declared metric only as a fallback — the SAME
    // policy as the cap reference, for the same reason: declared metrics are
    // frequently wrong in display and script faces. Two of the shipped fonts
    // prove it for x-height too: this Merriweather cut is unicase (its
    // "lowercase" letters ARE capitals topping at 1486) yet declares sxHeight
    // 1097 — trusting it delivered letters 35% taller than asked; TG Carrie
    // declares 1024 while its lowercase actually tops at 857 (16% small). What
    // the user measures with calipers must match what they typed, so the
    // outlines win.
    const tops: number[] = [];
    for (const ch of FLAT_XHEIGHT) {
      const gid = font.gidForChar(ch);
      if (gid === undefined) continue;
      const ys = font.contours(gid).flatMap((c) => c.map((p) => p[1]));
      if (ys.length && Math.max(...ys) > 0) tops.push(round3(Math.max(...ys)));
    }
    const sx = font.declaredXHeight;
    if (tops.length) {
      const ref = modal(tops);
      if (sx && Math.abs(sx - ref) > Math.max(2.0, ref * 0.02)) {
        warn.push(
          `This font declares an x-height of ${pyG(sx)} units but its ` +
            `lowercase actually measures ${pyG(ref)}. Using the measured ` +
            `value, so the letters come out the size you asked for.`,
        );
      }
      return { height: ref, warn };
    }
    if (sx && sx > 0) {
      warn.push(
        "No flat-topped lowercase to measure — used the x-height this font declares.",
      );
      return { height: sx, warn };
    }
    warn.push("No lowercase reference in this font — measured the whole artwork.");
    basis = "total";
  }

  const ys: number[] = [];
  for (const pl of placed) {
    for (const c of font.contours(pl.glyph)) for (const p of c) ys.push(p[1]);
  }
  if (ys.length === 0) {
    return { height: font.upem, warn: ["Nothing to measure — used the em size."] };
  }
  return { height: Math.max(...ys) - Math.min(...ys), warn };
}

/**
 * Build the artwork for one name.
 *
 * @param font     an open {@link Font} (or a path, which is opened here)
 * @param text     the name to set
 * @param height   finished size of the lettering, in `unit`
 * @param unit     "in" | "mm"
 * @param basis    "cap" | "xheight" | "total" — what `height` refers to
 * @param features OpenType features to shape with; defaults to calt/liga/kern/rlig
 * @throws {ValueError} on a height or a name that cannot produce artwork
 */
export function buildDocument(
  font: Font | string,
  text: string,
  height: number,
  unit: Unit = "in",
  basis: Basis = "cap",
  features?: Record<string, boolean> | null,
): Document {
  // Reject junk sizes before any geometry exists. inf and nan sailed all the way
  // into the files ('width="infin"', '/MediaBox [0 0 nan nan]'), 0 blew up in
  // Document.scale, a negative height mirrored the artwork, and 1e-6 rounded
  // every coordinate to 0.0000 and destroyed the drawing in silence. Refuse with
  // a message; do not clamp, or the user never learns.
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    throw new ValueError(
      `Height must be a positive, finite number — got ${pyFloat(height)}. ` +
        `Enter the finished size of the lettering, for example 1 in or 25 mm.`,
    );
  }
  const f = typeof font === "string" ? new Font(font) : font;
  const placed = shape(f, text, features);
  const drawable = placed.filter((p) => f.contours(p.glyph).length > 0);

  // No drawable glyph means no artwork: empty text, spaces/tabs only, or
  // invisible characters like U+200B / U+2060 / U+FEFF / U+00AD. These used to
  // crash later and further away. Say so here, plainly, rather than handing back
  // a degenerate document that only fails at export time.
  if (drawable.length === 0) {
    throw new ValueError(
      `There is nothing to cut in ${pyRepr(text)} — it produced no outline at all. ` +
        `Blank text, spaces and invisible characters have no shape. Type a ` +
        `name using characters this font can draw.`,
    );
  }

  // ---- cut path: union of every letter, curves preserved ------------------ //
  let union = emptyPath();
  for (const p of drawable) {
    // NOTE (SPEC.md §8.1): pathops' transform RETURNS a new path, it does not
    // mutate in place. Getting that wrong unioned every letter at x=0 and the
    // artwork came out as garbage — hence the explicit reassignment here.
    let piece = clonePath(f.outline(p.glyph));
    if (p.x || p.y) piece = translatePath(piece, p.x, p.y);
    union = skOp(union, piece, PathOp.UNION);
  }
  const polyCut = flattenPath(union);

  // ---- engrave lines: from the font's own red layers ---------------------- //
  const engrave: Point[][] = [];
  const warn: string[] = [];
  const outlinesAbs: G.Geometry[] = [];
  for (const p of drawable) {
    for (const c of f.contours(p.glyph)) {
      const ring: Point[] = c.map(([x, y]) => [x + p.x, y + p.y] as Point);
      outlinesAbs.push(G.lineString([...ring, ring[0]]));
    }
  }

  const raw: G.Geometry[] = [];
  let nBands = 0;
  for (const p of placed) {
    for (const layer of f.colr.get(p.glyph) ?? []) {
      if (!f.isEngraveLayer(layer.paletteIndex)) continue;
      let band = f.filled(layer.glyph);
      if (G.isEmpty(band)) continue;
      nBands += 1;
      band = G.translate(G.buffer(band, ENGRAVE_TOL), p.x, p.y);
      for (const ring of outlinesAbs) {
        const hit = G.intersection(ring, band);
        if (G.isEmpty(hit)) continue;
        for (const seg of G.geoms(hit)) {
          if (G.geomType(seg) === "LineString" && G.length(seg) >= MIN_ENGRAVE_LEN) {
            raw.push(seg);
          }
        }
      }
    }
  }
  if (raw.length) {
    // TRAP (SPEC.md §8.5): a band can graze more than one letter edge, producing
    // duplicate engrave lines. Dissolve them, then stitch the pieces back into
    // as few continuous lines as possible.
    const dissolved = G.unaryUnion(raw);
    const merged =
      G.geomType(dissolved) === "MultiLineString" ? G.lineMerge(dissolved) : dissolved;
    for (const seg of G.geoms(merged)) {
      if (G.geomType(seg) === "LineString" && G.length(seg) >= MIN_ENGRAVE_LEN) {
        engrave.push(G.coords(seg));
      }
    }
  }

  if (nBands && engrave.length === 0) {
    warn.push(
      "This font marks engrave lines but none landed on a letter edge — " +
        "check the font, or export cut-only.",
    );
  } else if (!nBands) {
    warn.push(
      f.colr.size
        ? "No engrave lines for this name — cut path only."
        : "This font has no engrave lines (no COLR table) — cut path only.",
    );
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const ring of polyCut) for (const pt of ring) { xs.push(pt[0]); ys.push(pt[1]); }
  const bbox: [number, number, number, number] = xs.length
    ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    : [0, 0, 0, 0];

  const { height: basisH, warn: basisWarn } = measureBasis(f, text, drawable, basis);
  // A positive but absurdly small height (1e-6) is finite, so it passes the
  // check above, yet every exported coordinate rounds to 0.0000 and the artwork
  // is gone. Say so rather than writing an empty drawing in silence.
  if (Number.isFinite(basisH) && basisH > 0) {
    const sc = height / basisH;
    if (Math.max((bbox[2] - bbox[0]) * sc, (bbox[3] - bbox[1]) * sc) < 5e-5) {
      basisWarn.push(
        `A ${basis} height of ${pyFloat(height)}${unit} is far too small to draw — ` +
          `every coordinate rounds to zero. Use a larger height.`,
      );
    }
  }

  return new Document({
    text,
    fontFamily: f.family,
    upem: f.upem,
    cutPaths: [polyCut],
    cutSkia: union,
    engravePaths: engrave,
    bbox,
    basis,
    basisHeight: basisH,
    targetHeight: height,
    unit,
    warnings: [...warn, ...basisWarn],
  });
}

/**
 * Flatten a united cut path's contours to polylines — Python's
 * `_flatten_recording`, reading the same pen calls out of the Skia path.
 *
 * TRAP (SPEC.md §8.3): a new `moveTo` must close the previous contour, because
 * skia does not always emit `closePath` and contours get dropped if you only
 * collect on close.
 */
export function flattenPath(p: SkPathData): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] | null = null;
  let pt: Point = [0, 0];

  const cubic = (p0: Point, p1: Point, p2: Point, p3: Point): Point[] => {
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
  };
  const quad = (p0: Point, p1: Point, p2: Point): Point[] => {
    const pts: Point[] = [];
    for (let i = 1; i <= FLATTEN_STEPS; i++) {
      const t = i / FLATTEN_STEPS;
      const m = 1 - t;
      pts.push([
        m*m*p0[0] + 2*m*t*p1[0] + t*t*p2[0],
        m*m*p0[1] + 2*m*t*p1[1] + t*t*p2[1],
      ]);
    }
    return pts;
  };

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
      cur!.push(...cubic(pt, c1, c2, e));
      pt = e;
    } else if (seg.op === "qCurveTo") {
      let pts = seg.pts.slice();
      if (pts.length && pts[pts.length - 1] === null) {
        // All-off-curve closed contour: a ring drawn with no on-curve points at
        // all. Legal TrueType and how some fonts draw eyelet circles, and it
        // arrives with NO preceding moveTo — so start the contour at the implied
        // midpoint. Without this, `cur` is null and the push below throws.
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
        cur!.push(...quad(pt, ctrl, end));
        pt = end;
      }
    } else if (seg.op === "closePath" || seg.op === "endPath") {
      if (cur && cur.length > 2) out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length > 2) out.push(cur);
  return out;
}

// --------------------------------------------------------------------------- //
//  SVG export
// --------------------------------------------------------------------------- //

/**
 * Make text safe inside an XML comment.
 *
 * A name is user input and it lands in the SVG's header comment. '--' is illegal
 * inside an XML comment, so a name like 'Mary--Jane' produced a file no
 * conforming parser would open; and '-->' ended the comment early, which let the
 * rest of the name inject live elements into the drawing. Angle brackets go too,
 * so nothing in a name can ever become geometry.
 */
export function xmlComment(s: string): string {
  let out = (s || "").replace(/</g, "(").replace(/>/g, ")");
  while (out.includes("--")) out = out.split("--").join("-");
  return out.replace(/-+$/, "");
}

/** Closed rings as an SVG path `d`, scaled and y-flipped into screen space. */
function svgPathClosed(
  rings: Point[][], sx: number, sy: number, ox: number, oy: number,
): string {
  const d: string[] = [];
  for (const ring of rings) {
    const pts = ring
      .map(([x, y]) => `${fmtF((x - ox) * sx, 4)},${fmtF((oy - y) * sy, 4)}`)
      .join(" L");
    d.push("M" + pts + " Z");
  }
  return d.join(" ");
}

/** One open polyline as an SVG path `d`. */
function svgPathOpen(
  line: Point[], sx: number, sy: number, ox: number, oy: number,
): string {
  return (
    "M" +
    line.map(([x, y]) => `${fmtF((x - ox) * sx, 4)},${fmtF((oy - y) * sy, 4)}`).join(" L")
  );
}

/**
 * One name, sized in real units.
 *
 * @param doc            the artwork
 * @param margin         extra space all round, in `doc.unit`
 * @param extraCutLines  OPEN polylines in font units that belong on the CUT
 *   layer (laser lead-ins). They join the CUT group so they cut with the
 *   outline, but unlike cutPaths they are never closed. Empty by default, in
 *   which case the output is byte-identical to a document without them.
 */
export function svgSingle(
  doc: Document,
  margin = 0.0,
  extraCutLines: Iterable<Point[]> = [],
): string {
  const s = doc.scale;
  const [x0, , , y1] = doc.bbox;
  const [bx0, by0, bx1, by1] = doc.bbox;
  const w = (bx1 - bx0) * s + 2 * margin;
  const h = (by1 - by0) * s + 2 * margin;
  const ox = x0 - margin / s;
  const oy = y1 + margin / s;
  const unit = doc.unit;
  let cut = doc.cutPaths
    .map((rings) => `<path d="${svgPathClosed(rings, s, s, ox, oy)}"/>`)
    .join("");
  cut += Array.from(extraCutLines)
    .map((l) => `<path d="${svgPathOpen(l, s, s, ox, oy)}"/>`)
    .join("");
  const eng = doc.engravePaths
    .map((l) => `<path d="${svgPathOpen(l, s, s, ox, oy)}"/>`)
    .join("");
  const sw = unit === "in" ? HAIRLINE_IN : HAIRLINE_IN * MM_PER_IN;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
    `width="${fmtF(w, 4)}${unit}" height="${fmtF(h, 4)}${unit}" ` +
    `viewBox="0 0 ${fmtF(w, 4)} ${fmtF(h, 4)}">\n` +
    `<!-- ${xmlComment(doc.text)} | ${xmlComment(doc.fontFamily)} | ` +
    `${doc.basis} height ` +
    `${pyFloat(doc.targetHeight)}${unit} | CUT=black outline, ENGRAVE=red centerlines -->\n` +
    `<g id="CUT" fill="none" stroke="#000000" stroke-width="${fmtF(sw, 5)}" ` +
    `stroke-linejoin="round">${cut}</g>\n` +
    `<g id="ENGRAVE" fill="none" stroke="#FF0000" stroke-width="${fmtF(sw, 5)}" ` +
    `stroke-linecap="round">${eng}</g>\n` +
    `</svg>\n`
  );
}

/** All names stacked on one sheet, left aligned. `gap` is in the docs' unit. */
export function svgSheet(docs: Document[], gap = 0.25): string {
  return svgSingle(stack(docs, gap));
}

// --------------------------------------------------------------------------- //
//  PDF export  (hand-rolled: exact hairlines, exact RGB, no dependencies)
// --------------------------------------------------------------------------- //

/** Escape a string for a PDF literal, latin-1 with '?' for anything else. */
function pdfEscape(s: string): Buffer {
  const esc = s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const bytes: number[] = [];
  for (const ch of esc) {
    const cp = ch.codePointAt(0)!;
    bytes.push(cp <= 0xff ? cp : 0x3f); // '?' — Python's errors="replace"
  }
  return Buffer.from(bytes);
}

/**
 * PDF content stream for one name. The PDF y axis points up, like font units.
 *
 * `extraCutLines` are OPEN black polylines (laser lead-ins): stroked with 'S' and
 * never 'h', so they stay open, and emitted while the colour is still black so
 * they belong to the cut, not the engrave.
 */
function pageStream(
  doc: Document, marginPt: number, extraCutLines: Iterable<Point[]> = [],
): { stream: Buffer; w: number; h: number } {
  const toPt = doc.unit === "in" ? PT_PER_IN : PT_PER_IN / MM_PER_IN;
  const s = doc.scale * toPt;
  const [x0, y0, x1, y1] = doc.bbox;
  const w = (x1 - x0) * s + 2 * marginPt;
  const h = (y1 - y0) * s + 2 * marginPt;
  const ox = x0;
  const oy = y0;
  const out: string[] = ["0 w"]; // width 0 = device hairline
  out.push("0 0 0 RG");
  const place = ([x, y]: Point): Point => [(x - ox) * s + marginPt, (y - oy) * s + marginPt];
  for (const rings of doc.cutPaths) {
    for (const ring of rings) {
      const pts = ring.map(place);
      out.push(`${fmtF(pts[0][0], 3)} ${fmtF(pts[0][1], 3)} m`);
      for (const [px, py] of pts.slice(1)) out.push(`${fmtF(px, 3)} ${fmtF(py, 3)} l`);
      out.push("h S");
    }
  }
  for (const line of extraCutLines) {
    const pts = line.map(place);
    out.push(`${fmtF(pts[0][0], 3)} ${fmtF(pts[0][1], 3)} m`);
    for (const [px, py] of pts.slice(1)) out.push(`${fmtF(px, 3)} ${fmtF(py, 3)} l`);
    out.push("S");
  }
  out.push("1 0 0 RG");
  for (const line of doc.engravePaths) {
    const pts = line.map(place);
    out.push(`${fmtF(pts[0][0], 3)} ${fmtF(pts[0][1], 3)} m`);
    for (const [px, py] of pts.slice(1)) out.push(`${fmtF(px, 3)} ${fmtF(py, 3)} l`);
    out.push("S");
  }
  return { stream: Buffer.from(out.join("\n"), "latin1"), w, h };
}

/**
 * One page per name, page size = artwork size + margin.
 *
 * @param docs          one page each, in order
 * @param marginPt      page margin in points
 * @param compress      Flate-compress the content streams
 * @param extraCutLines one list of open lead-in polylines per doc, positionally
 *                      matched to `docs`
 */
export function pdfDocument(
  docs: Document[],
  marginPt = 6.0,
  compress = true,
  extraCutLines: Point[][][] | null = null,
): Uint8Array {
  const objects: Buffer[] = [];
  /** @returns the new object's 1-based number */
  const add = (obj: Buffer): number => {
    objects.push(obj);
    return objects.length;
  };

  const pageIds: number[] = [];
  const contentIds: number[] = [];
  const sizes: [number, number][] = [];
  for (let i = 0; i < docs.length; i++) {
    const extra = extraCutLines ? extraCutLines[i] : [];
    const { stream, w, h } = pageStream(docs[i], marginPt, extra);
    const raw = compress ? zlib.deflateSync(stream) : stream;
    const filt = compress ? "/Filter /FlateDecode " : "";
    contentIds.push(
      add(
        Buffer.concat([
          Buffer.from(`<< ${filt}/Length ${raw.length} >>\nstream\n`, "latin1"),
          raw,
          Buffer.from("\nendstream", "latin1"),
        ]),
      ),
    );
    sizes.push([w, h]);
  }

  const pagesIdPlaceholder = objects.length + 1 + docs.length; // filled in below
  for (let i = 0; i < docs.length; i++) {
    const [w, h] = sizes[i];
    pageIds.push(
      add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R ` +
            `/MediaBox [0 0 ${fmtF(w, 3)} ${fmtF(h, 3)}] /Resources << >> ` +
            `/Contents ${contentIds[i]} 0 R >>`,
          "latin1",
        ),
      ),
    );
  }
  const kids = pageIds.map((pid) => `${pid} 0 R`).join(" ");
  const pagesId = add(
    Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${kids}] >>`, "latin1"),
  );
  if (pagesId !== pagesIdPlaceholder) {
    throw new Error(`page-tree numbering slipped: ${pagesId} vs ${pagesIdPlaceholder}`);
  }
  const infoId = add(
    Buffer.concat([
      Buffer.from("<< /Producer (ShineOn Nameplate Cut-File app) /Title (", "latin1"),
      pdfEscape(docs.map((d) => d.text).join(", ")),
      Buffer.from(") >>", "latin1"),
    ]),
  );
  const rootId = add(
    Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1"),
  );

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let len = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(len);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, body, tail);
    len += head.length + body.length + tail.length;
  });
  const xref = len;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) trailer += `${String(off).padStart(10, "0")} 00000 n \n`;
  trailer +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R ` +
    `/Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

/** All names on a single page, stacked, left aligned. */
export function pdfSheet(docs: Document[], gap = 0.25, marginPt = 6.0): Uint8Array {
  return pdfDocument([stack(docs, gap)], marginPt);
}

/**
 * One Document holding every name, already scaled into target units (scale == 1).
 *
 * Names are stacked top to bottom in reading order and aligned on the left.
 *
 * @throws {ValueError} when no name produced any outline to cut.
 */
export function stack(docs: Document[], gap = 0.25): Document {
  if (docs.length === 0) throw new ValueError("nothing to stack");
  const d0 = docs[0];
  const cutRings: Point[][] = [];
  const engLines: Point[][] = [];
  let yTop = 0.0; // y grows upward, so we walk downward
  let last = d0;
  for (const d of docs) {
    const sc = d.scale;
    const [x0, y0, , y1] = d.bbox;
    const dy = yTop - (y1 - y0) * sc; // bottom of this name
    for (const rings of d.cutPaths) {
      for (const ring of rings) {
        cutRings.push(ring.map(([x, y]) => [(x - x0) * sc, (y - y0) * sc + dy] as Point));
      }
    }
    for (const line of d.engravePaths) {
      engLines.push(line.map(([x, y]) => [(x - x0) * sc, (y - y0) * sc + dy] as Point));
    }
    yTop = dy - gap;
    last = d;
  }
  const xs = cutRings.flatMap((r) => r.map((p) => p[0]));
  const ys = cutRings.flatMap((r) => r.map((p) => p[1]));
  // Without this, an ink-free document reached min() on an empty list and the
  // sheet died with a bare "min() iterable argument is empty".
  if (xs.length === 0) {
    throw new ValueError(
      "Nothing to put on the sheet — none of these names produced any " +
        `outline to cut (${docs.map((d) => pyRepr(d.text)).join(", ")}).`,
    );
  }
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
    unit: (last ?? d0).unit,
    warnings: docs.flatMap((d) => d.warnings),
  });
}

// --------------------------------------------------------------------------- //
//  convenience
// --------------------------------------------------------------------------- //

/** A name turned into a filename: "Mary Jane" → "Mary_Jane". */
export function safeFilename(text: string): string {
  const s = text.replace(/[^A-Za-z0-9 _.\-]/g, "_").trim().replace(/ /g, "_");
  return s || "name";
}

/** The one-line summary the CLI prints. */
export function summary(doc: Document): string {
  const [w, h] = doc.size();
  const nCut = doc.cutPaths.reduce((n, r) => n + r.length, 0);
  return (
    `${doc.text}: ${fmtF(w, 3)} x ${fmtF(h, 3)} ${doc.unit}  |  ` +
    `${nCut} cut contour(s), ${doc.engravePaths.length} engrave line(s)`
  );
}

/** Python's `round(v, 3)` — banker's rounding, which JS does not do natively. */
function round3(v: number): number {
  const scaled = v * 1000;
  const r = Math.round(scaled);
  // exact .5 ties go to the even integer, like Python
  const out = Math.abs(scaled - Math.trunc(scaled)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return out / 1000;
}

/**
 * The most common value, ties broken toward the larger — Python's
 * `max(set(tops), key=lambda t: (tops.count(t), t))`.
 */
function modal(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestKey: [number, number] = [-1, -Infinity];
  for (const [v, c] of counts) {
    if (c > bestKey[0] || (c === bestKey[0] && v > bestKey[1])) {
      best = v;
      bestKey = [c, v];
    }
  }
  return best;
}

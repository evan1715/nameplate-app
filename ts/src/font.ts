/**
 * font.ts — one font file, opened once and reused for every name.
 *
 * The Python original leans on two libraries: `uharfbuzz` for shaping and
 * `fontTools` for outlines, metrics and the colour tables. Here HarfBuzz does
 * both jobs — it is the same HarfBuzz, compiled to WASM, and it already knows how
 * to decompose composite glyphs and interpret CFF charstrings, which is exactly
 * what SPEC.md §8.2 warns you have to get right:
 *
 *   TRAP: a plain RecordingPen records `addComponent` and drops composite
 *   glyphs silently — and Merriweather's variant glyphs are ALL composites, so
 *   whole letters vanish with no error. HarfBuzz's draw API always emits
 *   decomposed outlines, so the trap cannot be re-entered from here.
 *
 * `opentype.js` supplies the table-level facts HarfBuzz does not expose in the
 * shape the engine wants: the family name, the best Unicode cmap, OS/2's
 * declared cap height and x-height, and the `post` table's glyph names.
 */

import { readFileSync } from "node:fs";
import * as hb from "harfbuzzjs";
import opentype from "opentype.js";
import {
  type Point,
  type SkPathData,
  Verb,
  emptyPath,
  flatten,
  restoreStartingPoints,
} from "./skia.js";
import * as G from "./geom.js";

/** Curve → polyline steps, for measurement and engrave lines only. */
export const FLATTEN_STEPS = 24;

/** OpenType features the fonts' eyelets and engrave variants ride on. */
export const DEFAULT_FEATURES: Record<string, boolean> = {
  calt: true,
  liga: true,
  kern: true,
  rlig: true,
};

/** One COLR v0 layer: which glyph draws it and which palette entry colours it. */
export interface ColrLayer {
  /** Glyph id of the layer's outline. */
  glyph: number;
  /** Index into the CPAL palette. */
  paletteIndex: number;
}

/** An RGBA colour from the CPAL table, 0–255 per channel. */
export type Rgba = [number, number, number, number];

/**
 * One font file.
 *
 * NOT THREAD SAFE — the Python original says so and the same holds here: the
 * HarfBuzz face, the draw-func sink and the outline caches are all per-instance
 * mutable state. Open one per worker.
 */
export class Font {
  /** Path the font was read from. */
  readonly path: string;
  /** The raw file bytes. */
  readonly data: Uint8Array;
  /** Units per em from the `head` table. */
  readonly upem: number;

  private readonly blob: hb.Blob;
  private readonly face: hb.Face;
  private readonly hbFont: hb.Font;
  private readonly ot: opentype.Font;
  private readonly drawFuncs: hb.DrawFuncs;

  /** Glyph names in glyph-id order, from `post` (or `glyphNNNNN` when absent). */
  readonly glyphOrder: string[];
  /** Codepoint → glyph id, from the best Unicode cmap subtable. */
  readonly cmap: Map<number, number>;
  /** COLR v0: base glyph id → its colour layers. Empty when the font has none. */
  readonly colr: Map<number, ColrLayer[]>;
  /** The first CPAL palette, or empty when the font has no CPAL. */
  readonly palette: Rgba[];

  /** Curve-preserving outline per glyph, in font units. */
  private outlineCache = new Map<number, SkPathData>();
  /** Flattened outline per glyph, in font units. */
  private contourCache = new Map<number, Point[][]>();
  /** Filled shapely area per glyph. */
  private filledCache = new Map<number, G.Geometry>();
  /** Cached cap-height reference — see core's `capReference`. */
  capRefCache: { ref: number; warn: string[] } | null = null;

  /** Where the HarfBuzz draw callbacks accumulate. */
  private sink: PathSeg[] = [];

  /**
   * @param p Path to a .ttf / .otf / .ttc file.
   * @throws if the file cannot be read or is not a font this app can use.
   */
  constructor(p: string) {
    this.path = p;
    this.data = new Uint8Array(readFileSync(p));

    this.blob = new hb.Blob(this.data);
    this.face = new hb.Face(this.blob, 0);
    this.hbFont = new hb.Font(this.face);

    // opentype.js wants its own ArrayBuffer view of the same bytes
    const ab = this.data.buffer.slice(
      this.data.byteOffset,
      this.data.byteOffset + this.data.byteLength,
    ) as ArrayBuffer;
    this.ot = opentype.parse(ab);

    this.upem = this.ot.unitsPerEm;

    // --- glyph names, in glyph-id order ---------------------------------- //
    // The `post` table can be format 3.0, carrying no names at all. HarfBuzz
    // invents "gidNNN" in that case and fontTools invents "glyphNNNNN"; the
    // engine only ever uses names for reporting, and addresses geometry by id,
    // so either is fine as long as it is stable.
    this.glyphOrder = new Array(this.ot.numGlyphs);
    for (let gid = 0; gid < this.ot.numGlyphs; gid++) {
      const g = this.ot.glyphs.get(gid);
      this.glyphOrder[gid] = g?.name ?? `glyph${String(gid).padStart(5, "0")}`;
    }

    // --- the best Unicode cmap ------------------------------------------ //
    this.cmap = new Map();
    const cmapTable = (this.ot.tables as any).cmap;
    if (cmapTable?.glyphIndexMap) {
      for (const [cp, gid] of Object.entries(cmapTable.glyphIndexMap)) {
        this.cmap.set(Number(cp), Number(gid));
      }
    }

    // --- COLR v0 + CPAL -------------------------------------------------- //
    this.colr = new Map();
    if (this.face.hasColorLayers()) {
      for (let gid = 0; gid < this.ot.numGlyphs; gid++) {
        const layers = this.face.getGlyphColorLayers(gid);
        if (layers && layers.length) {
          this.colr.set(
            gid,
            layers.map((l) => ({
              glyph: l.glyph,
              // HarfBuzz reports `undefined` for "use the foreground colour",
              // which is not a palette entry; 0xFFFF is OpenType's own spelling
              // of the same thing, and is what fontTools reports as colorID.
              paletteIndex: l.colorIndex === undefined ? 0xffff : l.colorIndex,
            })),
          );
        }
      }
    }
    this.palette = [];
    if (this.face.hasColorPalettes()) {
      const pals = this.face.getColorPalettes();
      if (pals.length) {
        for (const c of pals[0].colors) {
          this.palette.push([c.red, c.green, c.blue, c.alpha]);
        }
      }
    }

    // --- the draw callbacks, wired once --------------------------------- //
    this.drawFuncs = new hb.DrawFuncs();
    this.drawFuncs.setMoveToFunc((x, y) => this.sink.push({ t: "M", a: [x, y] }));
    this.drawFuncs.setLineToFunc((x, y) => this.sink.push({ t: "L", a: [x, y] }));
    this.drawFuncs.setQuadraticToFunc((cx, cy, x, y) =>
      this.sink.push({ t: "Q", a: [cx, cy, x, y] }));
    this.drawFuncs.setCubicToFunc((ax, ay, bx, by, x, y) =>
      this.sink.push({ t: "C", a: [ax, ay, bx, by, x, y] }));
    this.drawFuncs.setClosePathFunc(() => this.sink.push({ t: "Z", a: [] }));
  }

  /** The HarfBuzz font handle, for the shaper. */
  get hb(): hb.Font {
    return this.hbFont;
  }

  /**
   * nameID 4 (full font name) — the dropdown label.
   *
   * Read straight out of the `name` table rather than through a library, because
   * the Python original takes the FIRST nameID 4 record in table order that
   * decodes, and libraries reorganise those records by platform and language.
   * Two records with different strings are common, so the choice is visible.
   *
   * Falls back to the file's base name, matching the Python original.
   */
  get family(): string {
    const table = this.face.referenceTable("name");
    if (table && table.length >= 6) {
      const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
      const count = view.getUint16(2);
      const stringOffset = view.getUint16(4);
      for (let i = 0; i < count; i++) {
        const rec = 6 + i * 12;
        if (rec + 12 > table.length) break;
        if (view.getUint16(rec + 6) !== 4) continue; // nameID 4 == full name
        const platformId = view.getUint16(rec);
        const length = view.getUint16(rec + 8);
        const offset = stringOffset + view.getUint16(rec + 10);
        if (offset + length > table.length) continue;
        const bytes = table.subarray(offset, offset + length);
        const text = decodeNameRecord(platformId, bytes);
        if (text) return text;
      }
    }
    const parts = this.path.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  /** Declared cap height from OS/2, or 0. Only ever used as a fallback. */
  get declaredCapHeight(): number {
    return (this.ot.tables as any).os2?.sCapHeight ?? 0;
  }

  /** Declared x-height from OS/2, or 0. Only ever used as a fallback. */
  get declaredXHeight(): number {
    return (this.ot.tables as any).os2?.sxHeight ?? 0;
  }

  /** Number of glyphs in the font. */
  get numGlyphs(): number {
    return this.ot.numGlyphs;
  }

  /** Glyph name for an id, for reports. */
  glyphName(gid: number): string {
    return this.glyphOrder[gid] ?? `gid${gid}`;
  }

  /** Glyph id for a name, or undefined. Built lazily; reports use it rarely. */
  private nameToGid: Map<string, number> | null = null;
  gidForName(name: string): number | undefined {
    if (!this.nameToGid) {
      this.nameToGid = new Map();
      this.glyphOrder.forEach((n, gid) => {
        if (!this.nameToGid!.has(n)) this.nameToGid!.set(n, gid);
      });
    }
    return this.nameToGid.get(name);
  }

  /** Glyph id the cmap maps this character to, or undefined. */
  gidForChar(ch: string): number | undefined {
    return this.cmap.get(ch.codePointAt(0)!);
  }

  /**
   * The raw HarfBuzz outline for one glyph — the pen calls, undecomposed into
   * points. Composites are already flattened into real contours by HarfBuzz.
   */
  private rawOutline(gid: number): PathSeg[] {
    this.sink = [];
    this.hbFont.drawGlyph(gid, this.drawFuncs);
    const out = this.sink;
    this.sink = [];
    return normaliseClosingLines(out);
  }

  /**
   * The point each contour of a TrueType glyph should START at, following
   * fontTools' rule — or null for a CFF glyph, where charstrings name their own
   * start points and every library agrees.
   *
   * WHY THIS MATTERS
   *   fontTools rotates a `glyf` contour to begin at the FIRST ON-CURVE POINT in
   *   the font's own point order (`_g_l_y_f.py`: `firstOnCurve = cFlags.index(1)`).
   *   HarfBuzz picks a different vertex. Both describe the same closed ring, so
   *   nothing about the shape changes — but the starting vertex propagates:
   *   `restoreStartingPoints` rotates each UNIONED contour onto one of the input
   *   contours' start points, so a different input start means a different
   *   exported path, and the golden files stop matching.
   *
   *   A contour with no on-curve points at all (legal TrueType — some of these
   *   fonts draw eyelet circles that way) starts at the implied midpoint of its
   *   last and first off-curve points, which is what the pen protocol's trailing
   *   `None` means.
   */
  private glyfContourStarts(gid: number): Point[] | null {
    const g: any = this.ot.glyphs.get(gid);
    const pts: any[] | undefined = g?.points;
    if (!pts || pts.length === 0) return null; // CFF, or an empty glyph
    const out: Point[] = [];
    let cur: any[] = [];
    for (const p of pts) {
      cur.push(p);
      if (p.lastPointOfContour) {
        out.push(startOfContour(cur));
        cur = [];
      }
    }
    if (cur.length) out.push(startOfContour(cur));
    return out;
  }

  /**
   * Glyph outline as a curve-preserving Skia path, in font units.
   * The Python equivalent is `Font.outline()`, which returns a `pathops.Path`.
   */
  outline(gid: number): SkPathData {
    const hit = this.outlineCache.get(gid);
    if (hit) return hit;
    const segs = this.rawOutline(gid);
    const p = emptyPath();
    for (const s of segs) {
      if (s.t === "M") {
        p.verbs.push(Verb.Move);
        p.pts.push([s.a[0], s.a[1]]);
      } else if (s.t === "L") {
        p.verbs.push(Verb.Line);
        p.pts.push([s.a[0], s.a[1]]);
      } else if (s.t === "Q") {
        p.verbs.push(Verb.Quad);
        p.pts.push([s.a[0], s.a[1]], [s.a[2], s.a[3]]);
      } else if (s.t === "C") {
        p.verbs.push(Verb.Cubic);
        p.pts.push([s.a[0], s.a[1]], [s.a[2], s.a[3]], [s.a[4], s.a[5]]);
      } else {
        p.verbs.push(Verb.Close);
      }
    }
    // rotate each contour onto the vertex fontTools would have started it at
    const starts = this.glyfContourStarts(gid);
    const rotated = starts && starts.length ? restoreStartingPoints(p, starts) : p;
    this.outlineCache.set(gid, rotated);
    return rotated;
  }

  /**
   * Glyph outline flattened to polylines, in font units — `Font.contours()`.
   *
   * Every curve becomes {@link FLATTEN_STEPS} straight steps. Contours shorter
   * than three points are dropped: they have no area and only ever came from
   * degenerate font data.
   *
   * TRAP (SPEC.md §8.3): a new `moveTo` must close the previous contour. Skia
   * does not always emit `closePath`, so collecting only on close loses
   * contours.
   */
  contours(gid: number): Point[][] {
    const hit = this.contourCache.get(gid);
    if (hit) return hit;
    // Flattened from the SAME path {@link outline} returns, so the measured
    // polyline and the cut path can never disagree about where a contour starts.
    // The Python engine gets both from one set of fontTools pen calls; this is
    // the equivalent single source.
    const out = flatten(this.outline(gid));
    this.contourCache.set(gid, out);
    return out;
  }

  /**
   * Glyph as a filled area — `Font.filled()`.
   *
   * Holes are resolved by CONTAINMENT PARITY: a ring nested inside an odd number
   * of larger rings is subtracted, one nested in an even number is added.
   *
   * DEVELOPERS.md §5: this is deliberately a different fill model from the one
   * the cut path uses (skia's winding union). `windingCheck()` in fontcheck
   * exists only to catch fonts where the two disagree. Do not "unify" them.
   */
  filled(gid: number): G.Geometry {
    const hit = this.filledCache.get(gid);
    if (hit) return hit;
    const cs = this.contours(gid);
    let rings = cs.map((c) => G.polygon(c));
    rings = rings.filter((r) => G.area(r) > 0);
    if (rings.length === 0) {
      const empty = G.emptyPolygon();
      this.filledCache.set(gid, empty);
      return empty;
    }
    const areas = rings.map((r) => G.area(r));
    // largest ring first, exactly like Python's sorted(..., key=-area)
    const order = rings.map((_, i) => i).sort((a, b) => areas[b] - areas[a]);
    let geom: G.Geometry | null = null;
    for (const i of order) {
      const r = G.buffer(rings[i], 0);
      const probe = G.point(...G.representativePoint(rings[i]));
      let depth = 0;
      for (let j = 0; j < rings.length; j++) {
        if (j === i) continue;
        if (areas[j] > areas[i] && G.contains(G.buffer(rings[j], 0), probe)) depth += 1;
      }
      if (geom === null) geom = r;
      else if (depth % 2) geom = G.difference(geom, r);
      else geom = G.union(geom, r);
    }
    const result = geom ?? G.emptyPolygon();
    this.filledCache.set(gid, result);
    return result;
  }

  /**
   * A layer counts as engraving when its palette colour is not black.
   *
   * That is the whole engrave-line detection rule: the fonts draw the marks that
   * say "this letter hides that one" as red COLR layers, and everything else in
   * the layer stack is the black letter itself.
   */
  isEngraveLayer(paletteIndex: number): boolean {
    if (paletteIndex >= this.palette.length) return false;
    const [r, g, b] = this.palette[paletteIndex];
    return !(r < 40 && g < 40 && b < 40);
  }
}

/**
 * Decode one `name` table record, the way fontTools' `NameRecord.toUnicode()`
 * does: platform 0 (Unicode) and 3 (Windows) are UTF-16BE, platform 1 is Mac
 * Roman. Anything that will not decode returns "" so the caller moves on to the
 * next record, matching the Python's `try/except Exception: pass`.
 */
function decodeNameRecord(platformId: number, bytes: Uint8Array): string {
  try {
    if (platformId === 0 || platformId === 3) {
      if (bytes.length % 2 !== 0) return "";
      let s = "";
      for (let i = 0; i < bytes.length; i += 2) {
        s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return s;
    }
    // Mac Roman agrees with Latin-1 across the ASCII range, which is all these
    // font names use; anything above 0x7f would need the full mapping table.
    return Buffer.from(bytes).toString("latin1");
  } catch {
    return "";
  }
}

/**
 * fontTools' choice of starting point for one `glyf` contour: the first
 * on-curve point in the font's point order, or — when the contour has no
 * on-curve points at all — the implied midpoint of its last and first
 * off-curve points.
 */
function startOfContour(points: { x: number; y: number; onCurve: boolean }[]): Point {
  const i = points.findIndex((p) => p.onCurve);
  if (i >= 0) return [points[i].x, points[i].y];
  const a = points[points.length - 1];
  const b = points[0];
  return [(a.x + b.x) / 2, (a.y + b.y) / 2];
}

/** One HarfBuzz draw callback, captured. */
interface PathSeg {
  t: "M" | "L" | "Q" | "C" | "Z";
  a: number[];
}

/**
 * Drop the redundant closing `lineTo` HarfBuzz emits at the end of a contour.
 *
 * HarfBuzz's draw API spells a closed contour out in full: it walks back to the
 * starting point with an explicit `line_to` and then calls `close_path`.
 * fontTools' pen protocol — which the Python engine measures and unions through —
 * treats `closePath` as implying that final straight segment, so it never
 * appears as a point.
 *
 * Leaving it in costs one extra point on every straight-closing contour, which
 * is enough to change the exported path data and to shift which vertex
 * `restoreStartingPoints` rotates a united contour onto. A closing segment that
 * is a CURVE is a real segment in both models and is left alone.
 *
 * The comparison is exact, not tolerant: this mirrors a structural difference
 * between two APIs, not a floating-point one, and a tolerance would risk eating
 * a genuinely tiny segment the font meant to draw.
 */
function normaliseClosingLines(segs: PathSeg[]): PathSeg[] {
  const out: PathSeg[] = [];
  let start: [number, number] | null = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t === "M") {
      start = [s.a[0], s.a[1]];
      out.push(s);
    } else if (
      s.t === "L" &&
      start &&
      i + 1 < segs.length &&
      segs[i + 1].t === "Z" &&
      s.a[0] === start[0] &&
      s.a[1] === start[1]
    ) {
      // the implied closing segment — skip it
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * A quadratic Bézier as {@link FLATTEN_STEPS} points, excluding the start.
 * Kept identical to the Python so the flattened polylines match point for point.
 */
export function flattenQuad(p0: Point, p1: Point, p2: Point): Point[] {
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
export function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= FLATTEN_STEPS; i++) {
    const t = i / FLATTEN_STEPS;
    const m = 1 - t;
    pts.push([
      m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
      m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

/** One shaped glyph at its pen position, in font units — Python's `Placed`. */
export interface Placed {
  /** Glyph id. The Python original carries the glyph NAME; see {@link Font}. */
  glyph: number;
  /** Pen x, font units. */
  x: number;
  /** Pen y, font units. */
  y: number;
  /**
   * Which character of the input this glyph came from (the HarfBuzz cluster).
   * Informational only — no geometry reads it. Contextual shaping can emit any
   * number of glyphs for a run, so a caller that needs to judge only PART of a
   * run has no other way to find which glyphs belong to which letters.
   */
  cluster: number;
}

/**
 * Shape one string with the font's own OpenType features.
 *
 * TRAP (SPEC.md §8.6): the features must be enabled. Merriweather's eyelets and
 * engrave variants ride on `calt`, the Carrie fonts' on `liga`. Shaping without
 * them silently produces plain letters and no eyelets at all.
 *
 * @param font     the font to shape with
 * @param text     the name being set
 * @param features feature tag → on/off; defaults to {@link DEFAULT_FEATURES}
 * @returns one {@link Placed} per output glyph, empty when nothing shaped
 */
export function shape(
  font: Font,
  text: string,
  features?: Record<string, boolean> | null,
): Placed[] {
  const out: Placed[] = [];
  if (!text) return out;

  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();

  const wanted = features ?? DEFAULT_FEATURES;
  const feats = Object.entries(wanted)
    .map(([tag, on]) => hb.Feature.fromString(`${tag}=${on ? 1 : 0}`))
    .filter((f): f is hb.Feature => !!f);
  hb.shape(font.hb, buf, feats);

  // An empty buffer reports no infos at all, not an empty list. Nothing shaped
  // is simply nothing placed; the caller decides what to do about it.
  const infos = buf.getGlyphInfos();
  const positions = buf.getGlyphPositions();
  if (!infos || !positions || infos.length === 0) return out;

  let x = 0;
  let y = 0;
  for (let i = 0; i < infos.length; i++) {
    out.push({
      glyph: infos[i].codepoint,
      x: x + positions[i].xOffset,
      y: y + positions[i].yOffset,
      cluster: infos[i].cluster ?? -1,
    });
    x += positions[i].xAdvance;
    y += positions[i].yAdvance;
  }
  return out;
}

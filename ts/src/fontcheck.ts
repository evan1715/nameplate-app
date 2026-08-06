/**
 * fontcheck.ts — what is WRONG with a font, from the artwork's point of view.
 *
 * PORTING STATUS
 *   This file is being built up module-piece by module-piece. The shaping-and-area
 *   layer below is complete and is what thickness.ts measures letters against; the
 *   defect detector, the join scan and the report writer are still to come from
 *   `nameplate_fontcheck.py`. `checkFont` is the entry point the CLI reaches for.
 *
 * WHY THE AREAS ARE TAKEN AFTER SHAPING
 *   A script font picks contextual forms, so 'g' before 'o' may be a different glyph
 *   than 'g' on its own, with a different exit stroke. Testing raw letters would test
 *   shapes the font never uses. Everything here therefore shapes the text first and
 *   measures the glyphs that shaping actually chose.
 */

import { Font, shape } from "./font.js";
import * as G from "./geom.js";

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
 * The defect report. NOT YET PORTED — the detector, the join scan and the report
 * writer are still in `nameplate_fontcheck.py`.
 *
 * The signature is here so `cli.ts`'s optional font report resolves against a real
 * export rather than a missing module, and so the shape of what is coming is
 * documented. It throws rather than returning an empty report: a caller must not be
 * able to mistake "not implemented" for "this font is clean".
 */
export function checkFont(
  _path: string,
  _opts: { names?: string[]; joinScanBudget?: number } = {},
): { text(): string } {
  throw new Error(
    "fontcheck.checkFont is not ported yet — the defect detector, join scan and " +
      "report writer are still only in nameplate_fontcheck.py",
  );
}

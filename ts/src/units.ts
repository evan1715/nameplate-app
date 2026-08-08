/**
 * units.ts — the fixed numbers, with nothing else in the file.
 *
 * These live apart from `core.ts` for one reason: the browser client needs them
 * and cannot import `core.ts`, which reaches for HarfBuzz, a WASM Skia and the
 * filesystem on the way in. A constant copied into the client instead would be
 * one more thing that can drift.
 *
 * `core.ts` re-exports every name here, so nothing else in the engine had to
 * change and `import { MM_PER_IN } from "./core.ts"` still reads the same.
 */

/** Millimetres per inch. Exact by definition since 1959. */
export const MM_PER_IN = 25.4;
/** PostScript points per inch. */
export const PT_PER_IN = 72.0;

/**
 * The smallest lettering height each unit allows.
 *
 * Not a safety margin — a floor below which the artwork stops being artwork. At
 * 1e-6 in every coordinate rounded to 0.0000 and the drawing was destroyed in
 * silence, which is why the engine refuses rather than clamping.
 */
export const MIN_IN = 0.05;
export const MIN_MM = 1.0;

/**
 * marks.ts — how the preview marks up what it measured.
 *
 * WHY THIS IS ITS OWN FILE
 *   The colours and the mark text are the only pieces of the application layer
 *   the BROWSER needs, and everything else in `app.ts` reaches for `node:fs`.
 *   Bundling that for a browser fails, so the pure part lives here and both sides
 *   import it — the client to paint with, `app.ts` to re-export.
 *
 *   The alternative was to copy the ramp and the label format into the client.
 *   That is the exact drift `nameplate_gui.py` warns about where it keeps
 *   `_prompt_sections` at module level: two copies of a rule that must agree, with
 *   nothing to make them.
 */

import { fmtF } from "./pyformat.ts";

/**
 * Preview mark-up colours. Black is cut and red is engrave, so everything the app
 * adds on top has to stay clear of both — and of each other, since the thin-area
 * marks and the eyelet marks can be on screen at the same time.
 */
/** Cyan — letters at the wanted thickness. */
export const THIN_TARGET = "#00d2d2";
/** Green — eyelet at the wanted inner diameter. */
export const EYE_TARGET_ID = "#2f9e44";
/** Lighter green — wanted outer diameter. */
export const EYE_TARGET_OD = "#7cc65b";
/** Teal — measured eyelet dimensions. */
export const EYE_DIM = "#0b7285";
/** Thin-area severity ramp, worst first: magenta -> orange -> amber -> olive. */
export const THIN_RAMP = ["#e6007e", "#ff6a00", "#ffab00", "#b8a000"] as const;
/** Green — already at or above the wanted thickness. */
export const THIN_OK = "#2f9e44";

/** Saints Row neon purple, used everywhere a toolkit would reach for blue. */
export const NEON = "#B026FF";
export const NEON_HOVER = "#C558FF";
export const NEON_PRESS = "#7B18C4";

/** Cut is black and engrave is red, on every surface. */
export const CUT_COLOUR = "#000000";
export const ENGRAVE_COLOUR = "#d40000";
/** Lead-ins, so they read as approach moves rather than as part of the part. */
export const LEAD_COLOUR = "#1971c2";

/**
 * The text on one thin-area mark: its rank, then how thick it is.
 *
 * Written "#7 · 0.0889 in", never "7. 0.0889 in". The rank used to be a number and
 * a full stop, which ran straight into the decimal that followed: a 0.0889 in
 * serif read as a 7.0889 in one, on a part whose whole height is 1 in. The hash
 * and the separator make the rank a label rather than a digit of the measurement.
 *
 * @param rank 1-based, worst first
 * @param spot the measured spot; a missing thickness reads as 0
 * @param unit "in" or "mm", printed as given
 */
export function thinLabel(rank: number, spot: { thickness?: number }, unit: string): string {
  return `#${rank} · ${fmtF(spot?.thickness ?? 0.0, 4)} ${unit}`;
}

/**
 * Severity colour for one thin spot.
 *
 * With a target typed the question is pass/fail and by how far, so the bands are
 * fixed fractions of the target — the colour then means the same thing in every
 * font.
 *
 * With no target there is nothing absolute to grade against, so the spots are
 * spread across the ramp between the thinnest and the least thin of THIS name.
 * Fixed ratios were tried first and were useless: a font whose thin places are all
 * within 5% of each other came out one flat colour, which is exactly the case
 * where you most need to see which is worst.
 *
 * @param spot     the spot being coloured
 * @param worst    the thinnest measurement in this name
 * @param thickest the least thin measurement in this name
 * @param target   the wanted thickness, or 0 when none was typed
 */
export function thinColour(
  spot: { thickness?: number },
  worst: number,
  thickest: number,
  target: number,
): string {
  const t = spot?.thickness || 0.0;
  if (target && target > 0) {
    const r = t / target;
    if (r >= 1.0) return THIN_OK;
    return r < 0.75 ? THIN_RAMP[0] : r < 0.9 ? THIN_RAMP[1] : THIN_RAMP[2];
  }
  if (worst <= 0 || thickest <= worst) return THIN_RAMP[0];
  const frac = (t - worst) / (thickest - worst); // 0 = worst, 1 = least
  const i = Math.trunc(frac * THIN_RAMP.length);
  return THIN_RAMP[Math.min(THIN_RAMP.length - 1, Math.max(0, i))];
}

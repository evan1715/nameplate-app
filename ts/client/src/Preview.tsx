/**
 * Preview.tsx — the artwork, drawn to a canvas.
 *
 * A port of `PreviewCanvas.paintEvent`, mark for mark: the dashed size box and
 * its two labels, black closed cut contours, lead-ins with a ring on the pierce
 * point, dashed comparison overlays, red open engrave centrelines, then the
 * measurements last so nothing can hide them, then the legend.
 *
 * WHAT IS DELIBERATELY UNCHANGED FROM QT
 *   * The order above. It is a stacking order, and swapping any two of them puts
 *     a measurement under the artwork it measures.
 *   * `fit()` / `toScreen()`: fit with a 56 px margin, then zoom and pan about
 *     the centre, and flip y — the artwork is in doc units from the bottom-left.
 *   * Ticks and label boxes are sized in SCREEN pixels, not doc units, so they
 *     stay legible at every zoom instead of vanishing or swamping the drawing.
 *   * The collision rule: a label that would land on one already drawn is
 *     dropped, worst-first order meaning the least bad numbers go first. Numbers
 *     on top of each other are worse than no numbers.
 *
 * WHAT IS NEW
 *   Device-pixel-ratio scaling. Qt handled it; a canvas does not, and without it
 *   every hairline is a blurred two-pixel smear on any modern screen.
 */

import { useEffect, useRef, useState } from "react";
import type { BuildResult } from "./api.ts";
import {
  CUT_COLOUR, ENGRAVE_COLOUR, EYE_DIM, EYE_TARGET_ID, EYE_TARGET_OD, NEON,
  THIN_OK, THIN_RAMP, THIN_TARGET, thinColour, thinLabel,
} from "../../src/marks.ts";
import { fmtF } from "../../src/pyformat.ts";

/** Doc-space point, as everything the engine hands out uses. */
type Pt = [number, number];

/** A label box already placed, for the collision check. */
interface Rect { x: number; y: number; w: number; h: number }

/** Which overlay kind gets which colour — the Qt canvas took the colour inline. */
const OVERLAY_COLOUR: Record<string, string> = {
  "thin-target": THIN_TARGET,
  "eyelet-target-id": EYE_TARGET_ID,
  "eyelet-target-od": EYE_TARGET_OD,
};

export interface PreviewProps {
  result: BuildResult | null;
  placeholder: string;
  /** The wanted thickness, which decides how the thin marks are graded. */
  thinTarget: number;
  /** Draw the measured eyelet dimensions. */
  showEyeDims: boolean;
  /** Draw the wanted-size rings, and name them in the legend. */
  showEyeWant: boolean;
  eyeTargetId: number;
  eyeTargetWall: number;
}

export function Preview(props: PreviewProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pt>([0, 0]);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [size, setSize] = useState<[number, number]>([800, 600]);

  // The canvas has no layout of its own — it fills its box, and the box is what
  // the flexbox sized. A ResizeObserver is the only way to learn that happened.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      setSize([box.clientWidth, box.clientHeight]);
    });
    ro.observe(box);
    setSize([box.clientWidth, box.clientHeight]);
    return () => ro.disconnect();
  }, []);

  // A new name is a new drawing; keeping the old zoom and pan would put it off
  // screen. `reset_view` in the Qt canvas, on the same trigger.
  useEffect(() => {
    setZoom(1);
    setPan([0, 0]);
  }, [props.result?.text, props.result?.unit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paint(canvas, size[0], size[1], zoom, pan, props);
  }, [size, zoom, pan, props]);

  return (
    <div
      className="preview"
      ref={boxRef}
      onWheel={(ev) => {
        ev.preventDefault();
        setZoom((z) => Math.max(0.15, Math.min(40, z * (ev.deltaY < 0 ? 1.12 : 1 / 1.12))));
      }}
      onPointerDown={(ev) => {
        (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
        drag.current = { x: ev.clientX, y: ev.clientY, px: pan[0], py: pan[1] };
      }}
      onPointerMove={(ev) => {
        const d = drag.current;
        if (d) setPan([d.px + (ev.clientX - d.x), d.py + (ev.clientY - d.y)]);
      }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => { setZoom(1); setPan([0, 0]); }}
      title="scroll to zoom · drag to pan · double-click to reset"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

/** One full repaint. Split out so it reads in the same order it draws. */
function paint(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  zoom: number,
  pan: Pt,
  props: PreviewProps,
): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const p = canvas.getContext("2d");
  if (!p) return;
  p.setTransform(dpr, 0, 0, dpr, 0, 0);
  p.fillStyle = "#ffffff";
  p.fillRect(0, 0, w, h);
  p.font = "12px system-ui, sans-serif";
  p.textBaseline = "middle";

  const res = props.result;
  if (!res || !res.cut.length) {
    p.fillStyle = "#9aa0a6";
    p.textAlign = "center";
    p.fillText(props.placeholder, w / 2, h / 2);
    return;
  }

  // fit, then zoom and pan about the centre
  const pad = 56.0;
  const aw = Math.max(w - 2 * pad, 20.0);
  const ah = Math.max(h - 2 * pad, 20.0);
  const k = (res.width > 0 && res.height > 0 ? Math.min(aw / res.width, ah / res.height) : 1) * zoom;
  const cx = w / 2 + pan[0];
  const cy = h / 2 + pan[1];
  /** doc units -> screen pixels, y flipped. */
  const S = (x: number, y: number): Pt =>
    [cx + (x - res.width / 2) * k, cy - (y - res.height / 2) * k];

  // ---- faint bounding box + physical size labels -------------------------- //
  const [bx0, by0] = S(0, res.height);
  const [bx1, by1] = S(res.width, 0);
  p.save();
  p.setLineDash([4, 3]);
  p.strokeStyle = "#c9ced4";
  p.lineWidth = 1;
  p.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
  p.restore();

  p.fillStyle = "#6b7177";
  p.textAlign = "center";
  p.fillText(`${fmtF(res.width, 3)} ${res.unit}`, (bx0 + bx1) / 2, by1 + 14);
  p.save();
  p.translate(bx0 - 12, (by0 + by1) / 2);
  p.rotate(-Math.PI / 2);
  p.fillText(`${fmtF(res.height, 3)} ${res.unit}`, 0, 0);
  p.restore();

  /** Draw one polyline, closing it or not. */
  const stroke = (line: readonly Pt[], close: boolean): void => {
    if (line.length < 2) return;
    p.beginPath();
    const [sx, sy] = S(line[0][0], line[0][1]);
    p.moveTo(sx, sy);
    for (let i = 1; i < line.length; i++) {
      const [x, y] = S(line[i][0], line[i][1]);
      p.lineTo(x, y);
    }
    if (close) p.closePath();
    p.stroke();
  };

  // ---- CUT — black hairline, closed --------------------------------------- //
  p.strokeStyle = CUT_COLOUR;
  p.lineWidth = 1.3;
  p.lineJoin = "round";
  for (const ring of res.cut) stroke(ring as Pt[], true);

  // ---- LEAD-INS ----------------------------------------------------------- //
  // They cut, so they are black like the outline. A small ring marks the pierce
  // point so it is obvious which end starts in scrap.
  if (res.leadins.length) {
    p.strokeStyle = CUT_COLOUR;
    p.lineWidth = 1.3;
    p.lineCap = "butt";
    for (const line of res.leadins) stroke(line as Pt[], false);
    p.strokeStyle = NEON;
    p.lineWidth = 1.2;
    for (const line of res.leadins) {
      if (line.length < 2) continue;
      const [sx, sy] = S(line[0][0], line[0][1]);
      p.beginPath();
      p.arc(sx, sy, 2.6, 0, Math.PI * 2);
      p.stroke();
    }
  }

  // ---- COMPARISON OVERLAYS ------------------------------------------------ //
  // What it would look like at a target size, drawn over the real artwork in its
  // own colour so both can be judged at once.
  p.save();
  p.setLineDash([5, 4]);
  p.lineWidth = 1.5;
  for (const ov of res.overlays ?? []) {
    p.strokeStyle = OVERLAY_COLOUR[ov.kind] ?? THIN_TARGET;
    for (const line of ov.rings) stroke(line as Pt[], false);
  }
  p.restore();

  // ---- ENGRAVE — red, open centrelines ------------------------------------ //
  p.strokeStyle = ENGRAVE_COLOUR;
  p.lineWidth = 1.3;
  p.lineCap = "round";
  for (const line of res.engrave) stroke(line as Pt[], false);
  p.lineCap = "butt";

  // ---- measurements, drawn last so they are never hidden ------------------ //
  const taken: Rect[] = [];
  const legend: [string, string][] = [];

  /**
   * One small label with a white backing, unless it would collide.
   *
   * Returns false when it was skipped, and a skipped label is the point: at low
   * zoom the crowded ones drop out and the coloured marks alone carry the
   * picture.
   */
  const label = (sx: number, sy: number, text: string, colour: string, anchor: string): boolean => {
    const tw = p.measureText(text).width + 6;
    const th = 15;
    let r: Rect =
      anchor === "above" ? { x: sx - tw / 2, y: sy - th - 3, w: tw, h: th }
        : anchor === "below" ? { x: sx - tw / 2, y: sy + 3, w: tw, h: th }
          : anchor === "right" ? { x: sx + 4, y: sy - th / 2, w: tw, h: th }
            : { x: sx - tw - 4, y: sy - th / 2, w: tw, h: th };
    // A number half off the edge is worse than useless, so it is pulled back
    // inside rather than clipped.
    if (r.x + r.w > w - 2) r = { ...r, x: w - 2 - r.w };
    if (r.x < 2) r = { ...r, x: 2 };
    if (r.y + r.h > h - 2) r = { ...r, y: h - 2 - r.h };
    if (r.y < 2) r = { ...r, y: 2 };
    for (const o of taken) {
      if (r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h) return false;
    }
    taken.push(r);
    p.fillStyle = "rgba(255,255,255,0.87)";
    p.fillRect(r.x, r.y, r.w, r.h);
    p.fillStyle = colour;
    p.textAlign = "center";
    p.fillText(text, r.x + r.w / 2, r.y + r.h / 2);
    return true;
  };

  /**
   * A measured distance between two doc-space points: line, end ticks, label.
   *
   * `at === "end"` labels the b end instead of the middle. Two dimensions that
   * share a centre — an inner and an outer diameter through the same hole — both
   * want the middle, and the second one silently lost its label to the collision
   * check, leaving a measured line with no number on it.
   */
  const dim = (a: Pt, b: Pt, text: string, colour: string, anchor: string, at = "mid"): void => {
    const [ax, ay] = S(a[0], a[1]);
    const [bx, by] = S(b[0], b[1]);
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy);
    if (L < 1.0) return;
    const nx = -dy / L;
    const ny = dx / L;
    p.strokeStyle = colour;
    p.lineWidth = 1.6;
    p.beginPath();
    p.moveTo(ax, ay);
    p.lineTo(bx, by);
    for (const [px, py] of [[ax, ay], [bx, by]] as Pt[]) {
      p.moveTo(px - nx * 4, py - ny * 4);
      p.lineTo(px + nx * 4, py + ny * 4);
    }
    p.stroke();
    const [lx, ly] = at === "end" ? [bx, by] : [(ax + bx) / 2, (ay + by) / 2];
    label(lx, ly, text, colour, anchor);
  };

  // EYELET DIMENSIONS — inner diameter across, outer diameter down, and the wall
  // at the exact point where it is thinnest, which is the spot that tears out.
  // Only when asked for: it is measurement, not artwork.
  if (props.showEyeDims && res.eyelets.length) {
    for (const e of res.eyelets) {
      const [ex, ey] = e.centre;
      const ri = e.inner_d / 2.0;
      const ro = e.outer_d / 2.0;
      dim([ex - ri, ey], [ex + ri, ey], `ID ${fmtF(e.inner_d, 4)} ${res.unit}`, EYE_DIM, "above");
      dim([ex, ey - ro], [ex, ey + ro], `OD ${fmtF(e.outer_d, 4)} ${res.unit}`, EYE_DIM, "above", "end");
      const at = e.wall_min_at;
      if (at) {
        const vx = at[0] - ex;
        const vy = at[1] - ey;
        const L = Math.hypot(vx, vy) || 1.0;
        dim(at as Pt, [at[0] + (vx / L) * e.wall_min, at[1] + (vy / L) * e.wall_min],
          `wall ${fmtF(e.wall_min, 4)} ${res.unit}`, EYE_DIM, "right");
      }
    }
    legend.push([EYE_DIM, "eyelet as measured"]);
  }
  if (props.showEyeWant && props.eyeTargetId) {
    legend.push([EYE_TARGET_ID, `wanted ID ${fmtF(props.eyeTargetId, 4)} ${res.unit}`]);
  }
  if (props.showEyeWant && props.eyeTargetWall) {
    legend.push([EYE_TARGET_OD, `wanted wall ${fmtF(props.eyeTargetWall, 4)} ${res.unit}`]);
  }

  // THIN AREAS — the measured crossing at each thin place, in a colour graded by
  // how thin it is, with the distance on it. Worst first, so if labels have to be
  // dropped for space it is the least bad ones that go.
  if (res.thin_spots.length) {
    const ts = res.thin_spots.map((s) => s.thickness || 0.0);
    const worst = Math.min(...ts);
    const thickest = Math.max(...ts);
    res.thin_spots.forEach((spot, i) => {
      const across = spot.across;
      if (!across || across.length !== 2) return;
      dim(across[0] as Pt, across[1] as Pt,
        thinLabel(i + 1, spot, res.unit),
        thinColour(spot, worst, thickest, props.thinTarget), "right");
    });
    if (props.thinTarget) {
      legend.push([THIN_RAMP[0], "thinner than wanted"]);
      legend.push([THIN_OK, "meets the wanted thickness"]);
      legend.push([THIN_TARGET, "letters at the wanted thickness"]);
    } else {
      legend.push([THIN_RAMP[0], "thinnest"]);
      legend.push([THIN_RAMP[THIN_RAMP.length - 1], "less thin"]);
    }
  }

  // ---- LEGEND ------------------------------------------------------------- //
  // A plain key in the corner. Colour alone is not readable when four kinds of
  // mark can be on screen at once.
  //
  // Laid out from the PARTS rather than from a guessed total: the box used to be
  // sized from the text width and the text then drawn in a rect that started
  // after the colour swatch, so every label lost the last few characters —
  // "thinnest" read as "thinnes".
  if (legend.length) {
    const x0 = 8;
    const padIn = 7;
    const sw = 16;
    const gap = 7;
    const lineH = 16;
    const tx = x0 + padIn + sw + gap;
    const adv = Math.max(...legend.map(([, t]) => p.measureText(t).width));
    const wide = (tx - x0) + adv + padIn;
    const hgt = legend.length * (lineH + 2) + 2 * padIn;
    p.fillStyle = "rgba(255,255,255,0.91)";
    p.fillRect(x0, x0, wide, hgt);
    p.strokeStyle = "#dfe3e8";
    p.lineWidth = 1;
    p.strokeRect(x0, x0, wide, hgt);
    let yy = x0 + padIn;
    p.textAlign = "left";
    for (const [colour, text] of legend) {
      p.strokeStyle = colour;
      p.lineWidth = 2.4;
      p.beginPath();
      p.moveTo(x0 + padIn, yy + lineH / 2);
      p.lineTo(x0 + padIn + sw, yy + lineH / 2);
      p.stroke();
      p.fillStyle = "#3c4043";
      p.fillText(text, tx, yy + lineH / 2);
      yy += lineH + 2;
    }
  }
}

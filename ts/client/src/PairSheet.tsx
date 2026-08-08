/**
 * PairSheet.tsx — the letter-pair contact sheet, in a scrollable window.
 *
 * A port of `PairGrid.paintEvent` and `PairSheetDialog`. The MODEL lives in
 * `src/pairgrid.ts` on the server — which rows exist, what each cell holds, the
 * scale per row width — so everything the Python's selftest asserts about this
 * sheet is tested with no browser. This file draws it and nothing else.
 *
 * CULLING IS NOT AN OPTIMISATION HERE, IT IS THE DESIGN
 *   26 columns x 182 rows is 4,732 cells of real glyph outlines. The Python
 *   painted only the ones inside the viewport for speed; this fetches only those,
 *   for the same reason plus one more — sending all of them would be megabytes of
 *   JSON per zoom step.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { SheetCell, SheetInfo } from "./api.ts";
import { NEON } from "../../src/marks.ts";

/** How far outside the viewport to fetch, in cells, so a small scroll is instant. */
const OVERSCAN = 2;

export interface PairSheetProps {
  fontPath: string;
  onClose: () => void;
}

export function PairSheet(props: PairSheetProps): React.ReactElement {
  const [info, setInfo] = useState<SheetInfo | null>(null);
  const [error, setError] = useState("");
  const [cells, setCells] = useState<SheetCell[]>([]);
  const [current, setCurrent] = useState<[number, number] | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });

  // The analysis is the slow part — seconds on a script face — so it happens once
  // per font and every zoom reuses it. That is what the server's grid cache is
  // for, and why zoom is a parameter of the same route rather than a re-analysis.
  useEffect(() => {
    let live = true;
    api.sheet(props.fontPath)
      .then((s) => { if (live) setInfo(s); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [props.fontPath]);

  // Fetch the cells the viewport can see, plus a little either side.
  useEffect(() => {
    if (!info) return;
    const r0 = Math.max(0, Math.floor(view.top / info.cell) - OVERSCAN);
    const r1 = Math.min(info.rows.length - 1, Math.floor((view.top + view.h) / info.cell) + OVERSCAN);
    const c0 = Math.max(0, Math.floor(view.left / info.cell) - OVERSCAN);
    const c1 = Math.min(info.cols.length - 1, Math.floor((view.left + view.w) / info.cell) + OVERSCAN);
    let live = true;
    api.sheetCells(props.fontPath, r0, r1, c0, c1)
      .then((cs) => { if (live) setCells(cs); })
      .catch(() => { /* a failed window just leaves the last one up */ });
    return () => { live = false; };
  }, [info, view, props.fontPath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !info) return;
    paintSheet(canvas, info, cells, current);
  }, [info, cells, current]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el) setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
  };

  const setZoom = (z: number): void => {
    api.sheet(props.fontPath, z).then(setInfo).catch((e: Error) => setError(e.message));
  };

  /** Step to the next flagged cell and scroll it into view — the arrow buttons. */
  const step = (delta: number): void => {
    if (!info?.flagged.length) return;
    const at = current
      ? info.flagged.findIndex(([r, c]) => r === current[0] && c === current[1])
      : -1;
    const next = info.flagged[(at + delta + info.flagged.length * 2) % info.flagged.length];
    setCurrent(next);
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({
        top: next[0] * info.cell - el.clientHeight / 2 + info.cell / 2,
        left: next[1] * info.cell - el.clientWidth / 2 + info.cell / 2,
        behavior: "smooth",
      });
    }
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Letter pairs</h2>
          <button className="ghost" onClick={props.onClose}>Close</button>
        </header>

        {error && <p className="error">{error}</p>}
        {!info && !error && <p className="muted">Shaping every pair in every position…</p>}

        {info && (
          <>
            <div className="row toolbar">
              <strong>
                {info.n_flagged} pair{info.n_flagged === 1 ? "" : "s"} do not join
              </strong>
              {info.untested > 0 && (
                <span className="warn">
                  {info.untested} never tested — the scan ran out of time
                </span>
              )}
              <span className="spacer" />
              <button onClick={() => step(-1)} disabled={!info.flagged.length}>◀ previous</button>
              <button onClick={() => step(1)} disabled={!info.flagged.length}>next ▶</button>
              <label>
                zoom&nbsp;
                <select value={info.zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                  {info.zooms.map((z) => (
                    <option key={z} value={z}>{Math.round(z * 100)}%</option>
                  ))}
                </select>
              </label>
            </div>

            <div
              className="sheet-scroll"
              ref={scrollRef}
              onScroll={onScroll}
              onMouseLeave={() => setTip(null)}
              onMouseMove={(ev) => {
                const el = scrollRef.current;
                if (!el) return;
                const box = el.getBoundingClientRect();
                const x = ev.clientX - box.left + el.scrollLeft;
                const y = ev.clientY - box.top + el.scrollTop;
                const ri = Math.floor(y / info.cell);
                const ci = Math.floor(x / info.cell);
                const hit = cells.find((c) => c.ri === ri && c.ci === ci);
                setTip(hit ? { x: ev.clientX, y: ev.clientY, html: hit.tip } : null);
              }}
              onClick={(ev) => {
                const el = scrollRef.current;
                if (!el) return;
                const box = el.getBoundingClientRect();
                setCurrent([
                  Math.floor((ev.clientY - box.top + el.scrollTop) / info.cell),
                  Math.floor((ev.clientX - box.left + el.scrollLeft) / info.cell),
                ]);
              }}
            >
              <canvas ref={canvasRef} style={{ width: info.width, height: info.height }} />
            </div>

            <details>
              <summary>Paste-ready fix for these pairs</summary>
              <textarea readOnly rows={12} value={info.prompt} />
              <button onClick={() => navigator.clipboard.writeText(info.prompt)}>Copy</button>
            </details>
          </>
        )}

        {tip && (
          <div
            className="tooltip"
            style={{ left: tip.x + 14, top: tip.y + 14 }}
            dangerouslySetInnerHTML={{ __html: tip.html }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Paint the visible cells.
 *
 * The canvas is the full sheet, so the browser's own scrolling does the panning
 * and no transform is needed — cells land at their real (ci*CELL, ri*CELL). Only
 * the fetched window is drawn; the rest stays whatever it last was, which is
 * invisible because it is scrolled away.
 */
function paintSheet(
  canvas: HTMLCanvasElement,
  info: SheetInfo,
  cells: readonly SheetCell[],
  current: [number, number] | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(info.width * dpr) || canvas.height !== Math.round(info.height * dpr)) {
    canvas.width = Math.round(info.width * dpr);
    canvas.height = Math.round(info.height * dpr);
  }
  const p = canvas.getContext("2d");
  if (!p) return;
  p.setTransform(dpr, 0, 0, dpr, 0, 0);
  p.fillStyle = "#ffffff";
  p.fillRect(0, 0, info.width, info.height);

  const CELL = info.cell;
  // Labels shrink with the cells so they stay in proportion when zoomed out.
  // Below a legible size the gap figure is dropped rather than drawn as an
  // unreadable smear — the red ring still says which pair it is.
  const px = Math.max(6, Math.round((11 * CELL) / 132));
  const showDetail = CELL >= 78;
  p.font = `${px}px system-ui, sans-serif`;
  p.textBaseline = "top";

  for (const cell of cells) {
    const x = cell.ci * CELL;
    const y = cell.ri * CELL;

    p.strokeStyle = "#e2e5e9";
    p.lineWidth = 1;
    p.strokeRect(x, y, CELL, CELL);

    // The glyphs, filled, at the one scale for this row width. Each glyph is its
    // OWN fill: one shared even-odd fill would punch the pair's overlap out as a
    // white hole, which is the opposite of what this sheet is for.
    if (cell.glyphs.length) {
      p.save();
      p.translate(x + CELL / 2, y + CELL * 0.62);
      p.scale(cell.scale, cell.scale);
      p.translate(cell.centreDx, 0);
      p.fillStyle = "#000000";
      for (const g of cell.glyphs) {
        p.beginPath();
        for (const contour of g.contours) {
          if (contour.length < 3) continue;
          p.moveTo(contour[0][0], -contour[0][1]); // font y is up
          for (let i = 1; i < contour.length; i++) p.lineTo(contour[i][0], -contour[i][1]);
          p.closePath();
        }
        p.fill("evenodd");
      }
      p.restore();
    }

    // The label, and a red ring plus the gap when it fails to join.
    p.textAlign = "center";
    if (cell.problem) {
      p.strokeStyle = "#d92b2b";
      p.lineWidth = 2;
      p.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
      p.fillStyle = "#d92b2b";
      if (showDetail && cell.badge) p.fillText(cell.badge, x + CELL / 2, y + CELL - px - 4);
    } else {
      // a colour per position, so which row you are on is obvious without
      // reading anything
      p.fillStyle = cell.labelKind === "middle" ? "#0b7285" // teal: middle of a word
        : cell.labelKind === "end" ? "#7048a8" // purple: an end of a word
          : "#7c8288";
    }
    p.fillText(cell.shown, x + CELL / 2, y + 2);

    // the one the arrows are parked on
    if (current && current[0] === cell.ri && current[1] === cell.ci) {
      p.strokeStyle = NEON;
      p.lineWidth = 3;
      p.strokeRect(x + 2, y + 2, CELL - 4, CELL - 4);
    }
  }
}

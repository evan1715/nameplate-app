/**
 * exporters.ts — writes the cut files in the order the laser must cut them.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CORE WRITERS
 *     The core writers emit one CUT group and one ENGRAVE group, in that order,
 *     with the contours in whatever order the union produced. That is fine for
 *     looking at, and wrong for cutting a part out of sheet metal:
 *
 *       * The part is held by the surrounding sheet ONLY until its outer edge is
 *         cut. The moment the outline is finished the part drops or shifts, and
 *         every cut after that is being made on air or on a moved part. So the
 *         OUTLINE MUST BE CUT LAST.
 *       * Engraving must happen while the part is still fully supported, so it
 *         goes FIRST.
 *       * The interior holes — letter counters and eyelet holes — come in between.
 *         Their slugs dropping out does not move the part.
 *
 *     Cut order is taken from stacking order, bottom first, and in a vector file
 *     the first thing written is the bottom. So everything here is emitted in the
 *     order: engrave, then inner cuts, then the outline, per name.
 *
 * GROUPS
 *     Each name is written as its own group so a sheet does not have to be
 *     hand-grouped after import. SVG carries real group names. PDF has no group
 *     concept, so each name becomes an Optional Content Group — a PDF layer —
 *     which CorelDRAW imports as a named layer.
 *
 * LEAD-INS
 *     A contour that has a lead-in is written as ONE open path that starts out in
 *     the scrap and runs into the outline (see leadin's `mergeRun`). It keeps its
 *     place in the order above: a hole's lead-in is part of the inner cuts, the
 *     outline's lead-in is part of the last cut.
 */

import * as zlib from "node:zlib";
import { Document, HAIRLINE_IN, MM_PER_IN, PT_PER_IN, ValueError, type Unit } from "./core.ts";
import * as LAY from "./layout.ts";
import * as LI from "./leadin.ts";
import { fmtF } from "./pyformat.ts";
import type { Point } from "./skia.ts";

/** A contour and whether it is written open (because it carries a lead-in). */
export type Geom = [pts: Point[], isOpen: boolean];

/** One name, in final sheet coordinates, already in cutting order. */
export class Piece {
  /** The name, used as the SVG group id / PDF layer name. */
  label: string;
  /** Engrave polylines — written FIRST, while the part is still supported. */
  engrave: Point[][] = [];
  /** Letter counters and eyelet holes — written second. */
  inner: Geom[] = [];
  /** The outline — written LAST, so the part stays held until the end. */
  outer: Geom[] = [];

  constructor(label: string) {
    this.label = label;
  }

  /** Every point in this piece, for working out the sheet's bounds. */
  *allPoints(): Generator<Point> {
    for (const p of this.engrave) yield* p;
    for (const [pts] of this.inner) yield* pts;
    for (const [pts] of this.outer) yield* pts;
  }
}

/**
 * Lay the names out and return them as cut-ordered pieces + overall bbox.
 *
 * Lead-ins are worked out per NAME, not on the merged sheet: each name is its own
 * part, so each one gets its own entry moves.
 *
 * @throws {ValueError} when no name produced any cuttable outline
 */
export function buildPieces(
  docs: Document[],
  gap = 0.25,
  direction: LAY.Direction = LAY.VERTICAL,
  leadLen: number | null = null,
  leadClear: number | null = null,
): { pieces: Piece[]; bbox: [number, number, number, number] } {
  const boxes = LAY.arrangementBounds(docs, gap, direction);
  const pieces: Piece[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const box = boxes[i];
    const s = doc.scale;
    const [x0, y0] = doc.bbox;
    const dx = box[0];
    const dy = box[1];

    const place = (pts: Point[]): Point[] =>
      pts.map(([x, y]) => [(x - x0) * s + dx, (y - y0) * s + dy] as Point);

    const ringList = LI.rings(doc);
    const { depths } = ringList.length
      ? LI.analyse(ringList)
      : { depths: [] as number[] };

    const runsByRing = new Map<number, Point[]>();
    if (leadLen) {
      const info = LI.leadInReport(doc, leadLen, leadClear);
      // match each run back to the ring it belongs to by its anchor
      info.leads_detail.forEach((detail, k) => {
        if (info.runs[k]) runsByRing.set(detail.ring, info.runs[k]);
      });
    }

    const pc = new Piece(doc.text);
    pc.engrave = doc.engravePaths.map(place);
    for (let idx = 0; idx < ringList.length; idx++) {
      const run = runsByRing.get(idx);
      const geom: Geom = run ? [place(run), true] : [place(ringList[idx]), false];
      if (depths[idx] % 2 === 1) pc.inner.push(geom); // a hole
      else pc.outer.push(geom); // the outline, cut last
    }
    pieces.push(pc);
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const pc of pieces) {
    for (const p of pc.allPoints()) {
      xs.push(p[0]);
      ys.push(p[1]);
    }
  }
  if (xs.length === 0) {
    throw new ValueError(
      "nothing to export: none of these names produced any cuttable outline",
    );
  }
  return {
    pieces,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

/**
 * A name turned into a unique XML id / PDF layer name.
 *
 * An XML Name may not START with a digit, hyphen or period — "-Ann" would make the
 * SVG invalid even though '-' is fine elsewhere in the id.
 */
function safeId(s: string, used: Set<string>): string {
  let out = Array.from(s)
    .map((ch) => (/[A-Za-z0-9]/.test(ch) || ch === "-" || ch === "_" ? ch : "_"))
    .join("");
  if (!out) out = "name";
  if (!/[A-Za-z_]/.test(out[0])) out = "n" + out;
  const base = out;
  let n = 2;
  while (used.has(out)) {
    out = `${base}_${n}`;
    n += 1;
  }
  used.add(out);
  return out;
}

// --------------------------------------------------------------------------- //
//  SVG
// --------------------------------------------------------------------------- //

/**
 * The sheet as SVG: one named group per name, each holding up to three subgroups
 * in cutting order.
 */
export function svg(
  pieces: Piece[],
  bbox: [number, number, number, number],
  unit: Unit,
): string {
  const [x0, , x1, y1] = bbox;
  const y0 = bbox[1];
  const w = x1 - x0;
  const h = y1 - y0;
  const sw = unit === "in" ? HAIRLINE_IN : HAIRLINE_IN * MM_PER_IN;

  const dOf = (pts: Point[], closed: boolean): string => {
    const body = pts
      .map(([x, y]) => `${fmtF(x - x0, 4)},${fmtF(y1 - y, 4)}`)
      .join(" L");
    return "M" + body + (closed ? " Z" : "");
  };

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
      `width="${fmtF(w, 4)}${unit}" height="${fmtF(h, 4)}${unit}" ` +
      `viewBox="0 0 ${fmtF(w, 4)} ${fmtF(h, 4)}">`,
    "<!-- cut order is bottom to top: engrave, then inner cuts, then the " +
      "outline last so the part stays held until the end -->",
  ];
  const used = new Set<string>();
  for (const pc of pieces) {
    const gid = safeId(pc.label, used);
    out.push(`<g id="${gid}">`);
    if (pc.engrave.length) {
      out.push(
        `<g id="${gid}__1_engrave" fill="none" stroke="#FF0000" ` +
          `stroke-width="${fmtF(sw, 5)}" stroke-linecap="round">` +
          pc.engrave.map((p) => `<path d="${dOf(p, false)}"/>`).join("") +
          "</g>",
      );
    }
    if (pc.inner.length) {
      out.push(
        `<g id="${gid}__2_cut_inner" fill="none" stroke="#000000" ` +
          `stroke-width="${fmtF(sw, 5)}" stroke-linejoin="round">` +
          pc.inner.map(([p, o]) => `<path d="${dOf(p, !o)}"/>`).join("") +
          "</g>",
      );
    }
    if (pc.outer.length) {
      out.push(
        `<g id="${gid}__3_cut_outline" fill="none" stroke="#000000" ` +
          `stroke-width="${fmtF(sw, 5)}" stroke-linejoin="round">` +
          pc.outer.map(([p, o]) => `<path d="${dOf(p, !o)}"/>`).join("") +
          "</g>",
      );
    }
    out.push("</g>");
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}

// --------------------------------------------------------------------------- //
//  PDF, with one Optional Content Group (layer) per name
// --------------------------------------------------------------------------- //

/** Escape a string for a PDF literal, latin-1 with '?' for anything else. */
function pdfEscape(s: string): Buffer {
  const esc = s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const bytes: number[] = [];
  for (const ch of esc) {
    const cp = ch.codePointAt(0)!;
    bytes.push(cp <= 0xff ? cp : 0x3f);
  }
  return Buffer.from(bytes);
}

/**
 * The sheet as PDF, one Optional Content Group (a named layer) per name.
 *
 * @param marginPt page margin in points
 * @param compress Flate-compress the content stream
 */
export function pdf(
  pieces: Piece[],
  bbox: [number, number, number, number],
  unit: Unit,
  marginPt = 6.0,
  compress = true,
): Uint8Array {
  const toPt = unit === "in" ? PT_PER_IN : PT_PER_IN / MM_PER_IN;
  const [x0, y0, x1, y1] = bbox;
  const w = (x1 - x0) * toPt + 2 * marginPt;
  const h = (y1 - y0) * toPt + 2 * marginPt;
  // An explicit hairline beats "0 w": width 0 is device-dependent and Corel
  // imports it as its own default, losing the hairline.
  const hairPt = HAIRLINE_IN * PT_PER_IN;

  const emit = (pts: Point[], closed: boolean): string[] => {
    const p = pts.map(
      ([x, y]) => [(x - x0) * toPt + marginPt, (y - y0) * toPt + marginPt] as Point,
    );
    const rows = [`${fmtF(p[0][0], 3)} ${fmtF(p[0][1], 3)} m`];
    for (const [a, b] of p.slice(1)) rows.push(`${fmtF(a, 3)} ${fmtF(b, 3)} l`);
    rows.push(closed ? "h S" : "S");
    return rows;
  };

  const body: string[] = [`${fmtF(hairPt, 4)} w`];
  const ocgNames: string[] = [];
  const used = new Set<string>();
  pieces.forEach((pc, i) => {
    ocgNames.push(safeId(pc.label, used));
    body.push(`/OC /MC${i} BDC`);
    if (pc.engrave.length) {
      // engrave first
      body.push("1 0 0 RG");
      for (const p of pc.engrave) body.push(...emit(p, false));
    }
    body.push("0 0 0 RG");
    for (const [p, o] of pc.inner) body.push(...emit(p, !o)); // then inner cuts
    for (const [p, o] of pc.outer) body.push(...emit(p, !o)); // outline LAST
    body.push("EMC");
  });

  const stream = Buffer.from(body.join("\n"), "latin1");
  const raw = compress ? zlib.deflateSync(stream) : stream;

  const objects: Buffer[] = [];
  const add = (o: Buffer): number => {
    objects.push(o);
    return objects.length;
  };

  const contentId = add(
    Buffer.concat([
      Buffer.from(
        `<< ${compress ? "/Filter /FlateDecode " : ""}/Length ${raw.length} >>\nstream\n`,
        "latin1",
      ),
      raw,
      Buffer.from("\nendstream", "latin1"),
    ]),
  );
  const ocgIds = ocgNames.map((n) =>
    add(
      Buffer.concat([
        Buffer.from("<< /Type /OCG /Name (", "latin1"),
        pdfEscape(n),
        Buffer.from(") >>", "latin1"),
      ]),
    ),
  );
  const props = ocgIds.map((oid, i) => `/MC${i} ${oid} 0 R`).join(" ");
  // The page is added before the Pages node, so its /Parent is the number the
  // Pages node will get: current count + 2.
  const pageId = add(
    Buffer.from(
      `<< /Type /Page /Parent ${objects.length + 2} 0 R ` +
        `/MediaBox [0 0 ${fmtF(w, 3)} ${fmtF(h, 3)}] ` +
        `/Resources << /Properties << ${props} >> >> ` +
        `/Contents ${contentId} 0 R >>`,
      "latin1",
    ),
  );
  const pagesId = add(
    Buffer.from(`<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`, "latin1"),
  );
  const order = ocgIds.map((oid) => `${oid} 0 R`).join(" ");
  const rootId = add(
    Buffer.from(
      `<< /Type /Catalog /Pages ${pagesId} 0 R ` +
        `/OCProperties << /OCGs [${order}] ` +
        `/D << /Order [${order}] /ON [${order}] >> >> >>`,
      "latin1",
    ),
  );
  const infoId = add(
    Buffer.concat([
      Buffer.from("<< /Producer (Sean's Font Prototyping Friend) /Title (", "latin1"),
      pdfEscape(pieces.map((p) => p.label).join(", ")),
      Buffer.from(") >>", "latin1"),
    ]),
  );

  const chunks: Buffer[] = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let len = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(len);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, o, tail);
    len += head.length + o.length + tail.length;
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

// --------------------------------------------------------------------------- //
//  convenience
// --------------------------------------------------------------------------- //

/** Lay out and write the whole job as SVG. */
export function exportSvg(
  docs: Document[],
  gap = 0.25,
  direction: LAY.Direction = LAY.VERTICAL,
  leadLen: number | null = null,
  leadClear: number | null = null,
): string {
  const { pieces, bbox } = buildPieces(docs, gap, direction, leadLen, leadClear);
  return svg(pieces, bbox, docs[0].unit);
}

/** Lay out and write the whole job as PDF. */
export function exportPdf(
  docs: Document[],
  gap = 0.25,
  direction: LAY.Direction = LAY.VERTICAL,
  leadLen: number | null = null,
  leadClear: number | null = null,
  marginPt = 6.0,
): Uint8Array {
  const { pieces, bbox } = buildPieces(docs, gap, direction, leadLen, leadClear);
  return pdf(pieces, bbox, docs[0].unit, marginPt);
}

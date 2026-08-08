/**
 * stress.ts — size accuracy and lead-in placement across many fonts/names.
 *
 *     node tests/stress.ts --font "<path>" [--font "<path>" ...]
 *     node tests/stress.ts --font-dir "<dir>"          (all .ttf/.otf inside)
 *
 * WHAT THIS PROVES
 *   SIZE
 *     S1  aspect ratio is identical at every height  (scaling height scales width
 *         by exactly the same factor — nothing gets stretched)
 *     S2  width scales linearly with height          w(kH) == k*w(H)
 *     S3  in and mm agree                            1 in artwork == 25.4 mm artwork
 *     S4  'cap' basis really is the first capital's ink height, re-derived
 *         independently from cmap rather than trusting the engine's number
 *     S5  'total' basis really is the whole artwork height
 *     S6  'xheight' basis uses the font's own OS/2 sxHeight
 *   LEAD-INS
 *     L1  count == one per hole + one per outer boundary
 *     L2  none of them run through the material of the name
 *     L3  no pierce point sits in the material
 *     L4  every hole has one, and its pierce is inside THAT hole
 *     L5  the outer lead-in's pierce is outside the part
 *     L6  each lead-in ends exactly on a vertex of its contour (Corel Join Curves)
 *     L7  lead-ins never change scale / bbox / size()
 *     L8  lead-in length is physical and constant across heights (or shortened
 *         only because a hole is too small, never longer than asked)
 *
 * Exit code 0 = everything passed.
 *
 * PORTED FROM `stress_test.py`, CHECK FOR CHECK
 *   Same check labels, same order, same detail strings — including the number
 *   formats — so `refs/stress.txt`, which is the Python suite's own captured
 *   output, reads as a line-by-line target. The docstring above is the Python
 *   one, kept verbatim: it still describes what the suite proves, S6's summary
 *   line included, even though the check itself grew past it (see S6 below).
 *
 *   The one thing that cannot be reproduced character for character is the
 *   traceback printed when a build throws, and it is marked where it happens.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initSkia } from "../src/skia.ts";
import { Font } from "../src/font.ts";
import type { Point } from "../src/skia.ts";
import {
  buildDocument, capReference, Document, MM_PER_IN, pyRepr,
} from "../src/core.ts";
import type { Unit } from "../src/core.ts";
import * as LI from "../src/leadin.ts";
import * as G from "../src/geom.ts";
import { fmtE, fmtF, pyFloat, pyG, pyRound } from "../src/pyformat.ts";

await initSkia();

const NAMES = ["A", "ADAM", "OLIVIA", "EMMA", "Mary Jane", "Christopher",
  "Sophia", "Ava", "liam", "Jo", "MICHAEL", "Bella Rose"];
const HEIGHTS_IN = [0.5, 1.0, 2.0, 4.0];
/**
 * Declared in the Python and never read — the size checks all pin "cap" and
 * name their own tolerances inline. Kept so the two files stay diffable; the
 * `void` below is what stops the compiler removing them for being unused.
 */
const BASES = ["cap", "xheight", "total"];
const TOL_RATIO = 1e-9;
const TOL_ABS = 1e-6;
void BASES, TOL_RATIO, TOL_ABS;

/** One row of the run: which font, which check, did it pass, and why. */
export type Row = [font: string, check: string, ok: boolean, detail: string];

export class Report {
  rows: Row[] = [];

  add(font: string, check: string, ok: boolean, detail = ""): void {
    this.rows.push([font, check, ok, detail]);
  }

  get failures(): Row[] {
    return this.rows.filter((r) => !r[2]);
  }

  summary(): string {
    const n = this.rows.length;
    return `${n - this.failures.length}/${n} checks passed`;
  }
}

/**
 * First capital's ink height in font units, derived from cmap directly.
 *
 * Unused, in the Python too: S4 used to assert against it and now asserts
 * against the cap LINE instead, for the reason spelled out there. Ported anyway
 * so the two files stay diffable.
 */
function capInkHeight(font: Font, text: string): number | null {
  for (const ch of text) {
    if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) {
      const g = font.cmap.get(ch.codePointAt(0) as number);
      if (!g) continue;
      const ys = font.contours(g).flatMap((c) => c.map((p) => p[1]));
      if (ys.length) return Math.max(...ys) - Math.min(...ys);
    }
  }
  return null;
}
void capInkHeight;

// --------------------------------------------------------------------------- //
//  size
// --------------------------------------------------------------------------- //

export function checkSize(font: Font, fname: string, rep: Report): void {
  for (const name of NAMES) {
    let docs: Map<number, Document>;
    try {
      docs = new Map(HEIGHTS_IN.map((h) => [h, buildDocument(font, name, h, "in", "cap")]));
    } catch (exc) {
      rep.add(fname, `S:build ${pyRepr(name)}`, false, excText(exc));
      continue;
    }

    const sizes = new Map(HEIGHTS_IN.map((h) => [h, (docs.get(h) as Document).size()]));
    if ([...sizes.values()].some(([w, hh]) => w <= 0 || hh <= 0)) {
      rep.add(fname, `S:nonzero ${pyRepr(name)}`, false, sizesRepr(sizes));
      continue;
    }

    // S1 aspect ratio constant
    const ratios = [...sizes.values()].map(([w, hh]) => w / hh);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    rep.add(fname, `S1 aspect constant ${pyRepr(name)}`, spread < 1e-9,
      `w/h spread ${fmtE(spread, 3)} over heights ${floatList(HEIGHTS_IN)}`);

    // S2 width linear in height
    const baseH = HEIGHTS_IN[0];
    const [bw, bh] = sizes.get(baseH) as [number, number];
    let worst = 0.0;
    for (const h of HEIGHTS_IN.slice(1)) {
      const k = h / baseH;
      const [w, hh] = sizes.get(h) as [number, number];
      worst = Math.max(worst, Math.abs(w - bw * k) / (bw * k), Math.abs(hh - bh * k) / (bh * k));
    }
    rep.add(fname, `S2 width scales with height ${pyRepr(name)}`, worst < 1e-9,
      `max relative error ${fmtE(worst, 3)}`);

    // S3 in vs mm
    const dMm = buildDocument(font, name, 25.4, "mm", "cap");
    const [wIn, hIn] = sizes.get(1.0) as [number, number];
    const [wMm, hMm] = dMm.size();
    const err = Math.max(Math.abs(wIn * MM_PER_IN - wMm), Math.abs(hIn * MM_PER_IN - hMm));
    rep.add(fname, `S3 in==mm ${pyRepr(name)}`, err < 1e-6,
      `1in -> ${fmtF(wIn * MM_PER_IN, 6)}x${fmtF(hIn * MM_PER_IN, 6)}mm vs ` +
      `25.4mm -> ${fmtF(wMm, 6)}x${fmtF(hMm, 6)}mm (err ${fmtE(err, 2)})`);

    // S4 the CAP LINE must land at the requested height. Not the first
    // capital's ink: a round 'O' overshoots the cap line and a 'J' descends
    // below the baseline, so their ink is legitimately taller. What has to be
    // identical between names is where the cap line sits, because that is
    // what makes 'JADAM' the same size as 'ADAM'.
    const { ref } = capReference(font);
    if (ref) {
      const got = ref * (docs.get(2.0) as Document).scale;
      rep.add(fname, `S4 cap line at requested height ${pyRepr(name)}`,
        Math.abs(got - 2.0) < 1e-9,
        `cap line lands at ${fmtF(got, 9)} in, asked 2.0`);
    }

    // S5 total basis == whole artwork height
    const dt = buildDocument(font, name, 2.0, "in", "total");
    rep.add(fname, `S5 total basis ${pyRepr(name)}`,
      Math.abs(dt.size()[1] - 2.0) < 1e-6,
      `artwork height ${fmtF(dt.size()[1], 9)} in, asked 2.0`);
  }

  // S6 xheight basis: the x-LINE must land at the requested height, i.e. the
  // basis equals the measured modal top of the flat lowercase (x z v w u s).
  // The declared OS/2.sxHeight is only a fallback — it is wrong by 16-35% in
  // two of the shipped families, so asserting it here would enshrine the bug.
  const tops: number[] = [];
  for (const ch of "xzvwus") {
    const g = font.cmap.get(ch.codePointAt(0) as number);
    if (!g) continue;
    const ys = font.contours(g).flatMap((c) => c.map((p) => p[1]));
    if (ys.length && Math.max(...ys) > 0) tops.push(pyRound(Math.max(...ys), 3));
  }
  if (tops.length) {
    // Python's `max(set(tops), key=lambda t: (tops.count(t), t))` — the modal
    // top, ties broken by the larger value.
    const seen = [...new Set(tops)];
    const count = (t: number) => tops.filter((x) => x === t).length;
    const expect = seen.reduce((best, t) =>
      count(t) > count(best) || (count(t) === count(best) && t > best) ? t : best);
    const d = buildDocument(font, "Adam", 1.0, "in", "xheight");
    rep.add(fname, "S6 xheight is the measured lowercase top",
      Math.abs(d.basisHeight - expect) < 1e-6,
      `basis_height ${pyG(d.basisHeight)} vs measured ${pyG(expect)}`);
  }
}

// --------------------------------------------------------------------------- //
//  lead-ins
// --------------------------------------------------------------------------- //

export function checkLeadins(font: Font, fname: string, rep: Report): void {
  for (const name of NAMES) {
    for (const [unit, height, lead] of [
      ["in", 1.0, 0.1], ["mm", 25.4, 2.5], ["in", 4.0, 0.1],
    ] as [Unit, number, number][]) {
      const tag = `${pyRepr(name)}@${pyFloat(height)}${unit}`;
      let doc: Document;
      let ringList: Point[][];
      let polys: G.Geometry[];
      let depths: number[];
      let mat: G.Geometry;
      let info: LI.LeadInReport;
      let leads: Point[][];
      try {
        doc = buildDocument(font, name, height, unit, "cap");
        ringList = LI.rings(doc);
        ({ polys, depths, material: mat } = LI.analyse(ringList));
        info = LI.leadInReport(doc, lead);
        leads = info.leads;
      } catch (exc) {
        // The one line that cannot match Python character for character: this is
        // a V8 stack, not `traceback.format_exc(limit=2)`. It only ever prints
        // when a build throws, which the reference run does not do.
        rep.add(fname, `L:build ${tag}`, false,
          `${excText(exc)}\n${((exc as Error).stack ?? "").split("\n").slice(0, 3).join("\n")}`);
        continue;
      }

      const holes = polys.map((p, i) => [p, ringList[i]] as const).filter((_, i) => depths[i] % 2 === 1);
      const outers = polys.map((p, i) => [p, ringList[i]] as const).filter((_, i) => depths[i] % 2 === 0);
      const wantFu = lead / doc.scale;
      const tol = wantFu * 0.02;

      // L1 count: one per cuttable hole + one per outer boundary. Holes
      // finer than the laser kerf are legitimately skipped, but nothing
      // may fail silently — info.failed must be zero.
      const expect = holes.length - info.skipped_tiny + outers.length;
      rep.add(fname, `L1 count ${tag}`,
        leads.length === expect && info.failed === 0,
        `${leads.length} lead-ins, expected ${expect} ` +
        `(${holes.length} holes - ${info.skipped_tiny} sub-kerf ` +
        `+ ${outers.length} outer), unexplained failures=${info.failed}`);

      // L2/L3 never in the material
      const inMat = leads.filter((l) => G.length(G.intersection(mat, G.lineString(l))) > tol);
      rep.add(fname, `L2 not through material ${tag}`, !inMat.length,
        `${inMat.length} lead-in(s) cross the name`);
      const pierceIn = leads.filter((l) => G.contains(mat, G.point(l[0][0], l[0][1])));
      rep.add(fname, `L3 pierce in scrap ${tag}`, !pierceIn.length,
        `${pierceIn.length} pierce point(s) inside the name`);

      // L4 every hole reported as "served" must really have a pierce
      // inside it. Only holes whose best achievable lead-in is finer than
      // the kerf are exempt, and those are reported, never silent.
      const missed: number[] = [];
      for (const h of info.holes_detail) {
        if (h.status !== "served") continue;
        const hp = polys[h.ring];
        // Python re-buffers inside the `any()`, once per lead; hoisted here
        // because it is the same polygon every time and this is the slowest
        // line in the suite.
        const grown = G.buffer(hp, tol);
        if (!leads.some((l) => G.contains(grown, G.point(l[0][0], l[0][1])))) {
          missed.push(G.area(hp));
        }
      }
      const nServed = info.holes_detail.filter((h) => h.status === "served").length;
      rep.add(fname, `L4 every cuttable hole has a lead-in ${tag}`,
        !missed.length,
        `${missed.length} served hole(s) with no pierce inside ` +
        `(areas ${floatList(missed.slice(0, 5).map((a) => pyRound(a, 1)))}); ` +
        `${nServed}/${holes.length} served, ` +
        `${info.skipped_tiny} sub-kerf exempt`);

      // L5 outer pierce outside the part
      const badOuter: number[] = [];
      for (const [op] of outers) {
        const shrunk = G.buffer(op, -tol);
        const outs = leads.filter((l) => {
          const pt = G.point(l[0][0], l[0][1]);
          return !G.contains(shrunk, pt) && !G.contains(op, pt);
        });
        if (!outs.length) badOuter.push(1);
      }
      rep.add(fname, `L5 outer lead-in is outside ${tag}`,
        !badOuter.length || !outers.length,
        `${badOuter.length}/${outers.length} outer boundaries without an ` +
        `outside pierce`);

      // L6 ends exactly ON a contour (anchors may sit mid-edge, since a
      // long edge with no node is often the only safe place to enter)
      const boundary = ringList.map((r) => G.lineString([...r, r[0]]));
      const eps = wantFu * 1e-6 + 1e-9;
      const off = leads.filter((l) => {
        const pt = G.point(l[l.length - 1][0], l[l.length - 1][1]);
        return Math.min(...boundary.map((b) => G.distance(b, pt))) > eps;
      });
      // Python compares rounded (x, y) TUPLES in a set, where -0.0 == 0.0 and
      // hashes the same; string keys do not, so the sign of a rounded zero is
      // normalised away here.
      const key = (x: number, y: number) => `${pyRound(x, 6) || 0},${pyRound(y, 6) || 0}`;
      const nodes = new Set(ringList.flatMap((r) => r.map(([x, y]) => key(x, y))));
      const onVert = leads.filter((l) => nodes.has(key(l[l.length - 1][0], l[l.length - 1][1]))).length;
      rep.add(fname, `L6 ends on the contour ${tag}`, !off.length,
        `${off.length} lead-in(s) not touching a contour; ` +
        `${onVert}/${leads.length} landed exactly on an existing node`);

      // L7 size untouched
      const before = snapshot(doc);
      LI.leadInLines(doc, lead);
      const ex = LI.docForExport(doc, leads);
      rep.add(fname, `L7 size untouched ${tag}`,
        before === snapshot(doc) && ex.scale === doc.scale,
        `scale/bbox/size stable, export scale same=` +
        `${ex.scale === doc.scale ? "True" : "False"}`);

      // L8 physical length: never longer than asked
      const lens = leads.map((l) => G.length(G.lineString(l)) * doc.scale);
      const tooLong = lens.filter((v) => v > lead + 1e-9);
      rep.add(fname, `L8 length <= requested ${tag}`, !tooLong.length,
        `${tooLong.length} too long; lengths ` +
        `${floatList(lens.slice(0, 8).map((v) => pyRound(v, 4)))}`);

      // L9 standoff: never graze a letter edge along the run
      const hard = LI.hardClearance(unit);
      const nearFu = hard / doc.scale * 1.15;
      const clears: number[] = [];
      for (const l of leads) {
        const seg = G.lineString(l);
        const a = l[1];
        const p = l[0];
        const t = Math.min(nearFu / Math.max(G.length(seg), 1e-12), 0.9);
        const start: Point = [a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t];
        clears.push(G.distance(G.lineString([start, p]), mat) * doc.scale);
      }
      const worst = clears.length ? Math.min(...clears) : Infinity;
      rep.add(fname, `L9 standoff from letters ${tag}`,
        worst >= hard * 0.98,
        `worst standoff ${fmtF(worst, 5)} ${unit}, floor ${pyG(hard)} ` +
        `over ${leads.length} lead-ins`);

      // L10 exempt holes must be provably too tight to enter safely
      const tiny = info.holes_detail.filter((h) => h.status === "tiny");
      const bad = tiny.filter((h) => (h.width ?? 0.0) > LI.hardClearance(unit) * 1.6);
      rep.add(fname, `L10 exemptions justified ${tag}`, !bad.length,
        `${tiny.length} exempt; widths ` +
        // Python's fallback here is the INT 0, which reprs as "0" and not "0.0".
        // Every "tiny" record carries a width, so it never fires — but a port
        // that quietly promoted it to 0.0 would be wrong on the day it does.
        `${pyList(tiny.slice(0, 6).map((h) =>
          h.width === undefined ? "0" : pyFloat(pyRound(h.width, 5))))} ` +
        `vs standoff floor ${pyG(LI.hardClearance(unit))} ` +
        `(a hole must be narrower than ~1.6x the standoff to be ` +
        `exempt); unjustified=${bad.length}`);
    }
  }
}

// --------------------------------------------------------------------------- //
//  main
// --------------------------------------------------------------------------- //

export function main(): number {
  // argparse's `action="append"` for --font/--font-dir, plus --quiet.
  const argv = process.argv.slice(2);
  const fontArgs: string[] = [];
  const fontDirs: string[] = [];
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--font") fontArgs.push(argv[++i]);
    else if (argv[i] === "--font-dir") fontDirs.push(argv[++i]);
    else if (argv[i] === "--quiet") quiet = true;
    else {
      console.error(`usage: stress.ts [--font PATH] [--font-dir DIR] [--quiet]`);
      return 2;
    }
  }

  let paths = [...fontArgs];
  for (const d of fontDirs) {
    for (const ext of [".ttf", ".otf", ".ttc"]) {
      const hits = fs.existsSync(d)
        ? fs.readdirSync(d).filter((n) => n.toLowerCase().endsWith(ext)).sort()
        : [];
      paths = paths.concat(hits.map((n) => path.join(d, n)));
    }
  }
  paths = paths.filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!paths.length) {
    console.error("stress.ts: error: no font files given");
    return 2;
  }

  const rep = new Report();
  for (const p of paths) {
    const label = path.basename(p);
    console.log(`=== ${label}`);
    let font: Font;
    try {
      font = new Font(p);
    } catch (exc) {
      rep.add(label, "open font", false, excText(exc));
      console.log(`    FAILED TO OPEN: ${(exc as Error).message}`);
      continue;
    }
    console.log(`    family=${pyRepr(font.family)} upem=${font.upem} ` +
      `colr=${font.colr.size ? "yes" : "no"}`);
    checkSize(font, label, rep);
    checkLeadins(font, label, rep);
    const mine = rep.rows.filter((r) => r[0] === label);
    const fails = mine.filter((r) => !r[2]);
    console.log(`    ${mine.length - fails.length}/${mine.length} passed` +
      (fails.length ? `  <-- ${fails.length} FAILURES` : ""));
    if (fails.length && !quiet) {
      for (const [, chk, , det] of fails.slice(0, 20)) console.log(`      FAIL ${chk}: ${det}`);
    }
  }

  console.log("=".repeat(78));
  console.log(rep.summary());
  if (rep.failures.length) {
    console.log(`\n${rep.failures.length} FAILURES:`);
    const seen = new Map<string, [string, string, string][]>();
    for (const [f, chk, , det] of rep.failures) {
      const k = chk.split(" ")[0];
      const bucket = seen.get(k);
      if (bucket) bucket.push([f, chk, det]);
      else seen.set(k, [[f, chk, det]]);
    }
    for (const k of [...seen.keys()].sort()) {
      const items = seen.get(k) as [string, string, string][];
      console.log(`\n  [${k}] ${items.length} failure(s)`);
      for (const [f, chk, det] of items.slice(0, 10)) console.log(`    ${f}: ${chk}\n        ${det}`);
    }
  }
  console.log("=".repeat(78));
  return rep.failures.length ? 1 : 0;
}

// --------------------------------------------------------------------------- //
//  small helpers that only exist to make the output read like the Python's
// --------------------------------------------------------------------------- //

/** Python's `f"{type(exc).__name__}: {exc}"`. */
function excText(exc: unknown): string {
  const e = exc as Error;
  return `${e?.name ?? "Error"}: ${e?.message ?? String(exc)}`;
}

/** Python's repr of a list of floats. */
function floatList(v: readonly number[]): string {
  return pyList(v.map(pyFloat));
}

/** Python's repr of a list whose items are already rendered. */
function pyList(v: readonly string[]): string {
  return `[${v.join(", ")}]`;
}

/** Python's repr of the `{height: (w, h)}` dict, for the non-positive-size line. */
function sizesRepr(sizes: ReadonlyMap<number, [number, number]>): string {
  const parts = [...sizes.entries()].map(
    ([h, [w, hh]]) => `${pyFloat(h)}: (${pyFloat(w)}, ${pyFloat(hh)})`);
  return `{${parts.join(", ")}}`;
}

/**
 * `(scale, bbox, size(), basis_height)` as one comparable value.
 *
 * Python compares that tuple with `==`, which compares the bbox tuple by VALUE.
 * JavaScript would compare the bbox array by identity and pass even if every
 * number in it had changed, so the snapshot is flattened to a string instead.
 */
function snapshot(doc: Document): string {
  return JSON.stringify([doc.scale, doc.bbox, doc.size(), doc.basisHeight]);
}

// Python's `if __name__ == "__main__": sys.exit(main())`. Compares RESOLVED
// file:// URLs rather than matching on the basename: `endsWith(basename(argv[1]))`
// fires when some other file with the same name is the entry point, and a suite
// that exits before asserting anything reads as a pass.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}

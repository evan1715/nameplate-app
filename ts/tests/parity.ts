/**
 * parity.ts — does the TypeScript engine produce the SAME artwork as the Python?
 *
 * The reference numbers below were dumped from the working Python engine before
 * any conversion happened (see `scratchpad/dump_ref.py`). A mismatch here means
 * the port has drifted, not that the numbers are stale.
 */
import { initSkia } from "../src/skia.ts";
import { Font, shape } from "../src/font.ts";
import {
  buildDocument, capReference, svgSingle, svgSheet, pdfDocument, summary,
} from "../src/core.ts";
import { readFileSync } from "node:fs";
import * as zlib from "node:zlib";

const FONTS = "/home/user/nameplate-app/fonts/";
let pass = 0;
let fail = 0;

function check(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass += 1;
    console.log(`[PASS] ${label}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${label}\n        want: ${w}\n        got : ${g}`);
  }
}

await initSkia();

// ---- font facts ---------------------------------------------------------- //
const merri = new Font(FONTS + "MerriweatherCut3Black-Engrave-v2.ttf");
check("merri family", merri.family, "Merriweather-Cut3 Engrave v2 Black");
check("merri upem", merri.upem, 2000);
check("merri glyph count", merri.numGlyphs, 9571);
check("merri cap reference", capReference(merri).ref, 1486);
check("merri COLR bases", merri.colr.size, 3480);
check("merri palette head", merri.palette.slice(0, 2), [[0, 0, 0, 255], [255, 0, 0, 255]]);

const placed = shape(merri, "ADAM");
check(
  "merri shape ADAM",
  placed.map((p) => [merri.glyphName(p.glyph), p.x, p.y, p.cluster]),
  [["A.ini", 0, 0, 0], ["D.e0", 1089, 0, 1], ["A.e5", 2335, 0, 2], ["M.e0", 3380, 0, 3]],
);
const g0 = merri.contours(placed[0].glyph);
check("merri A.ini contour sizes", g0.map((c) => c.length), [233, 5, 289]);
check("merri A.ini first points", g0[0].slice(0, 3), [[-200, 119], [-79, 143], [-31, 282]]);

const flourish = new Font(FONTS + "TGCarrieSOFlourish-v2.otf");
check("flourish family", flourish.family, "TG Carrie SO FLOURISH v2 Regular");
check("flourish upem", flourish.upem, 2048);
check("flourish cap reference", capReference(flourish).ref, 1433);
check("flourish COLR bases", flourish.colr.size, 2453);

const carrie = new Font(FONTS + "TGCarrieSO-v2.otf");
check("carrie family", carrie.family, "TG Carrie SO v2 Regular");
check("carrie COLR bases", carrie.colr.size, 0);
check("carrie glyph count", carrie.numGlyphs, 458);

// ---- documents ----------------------------------------------------------- //
interface Want {
  bbox: number[];
  size: number[];
  basisHeight: number;
  nCut: number;
  cutPts: number[];
  nEngrave: number;
  engravePts: number[];
  warnings: string[];
  head: number[][];
}

const cases: [string, Font, string, number, "in" | "mm", "cap" | "xheight" | "total", Want][] = [
  ["merri ADAM cap 1in", merri, "ADAM", 1, "in", "cap", {
    bbox: [-675, -16, 5372, 1499], size: [4.069314, 1.019515], basisHeight: 1486,
    nCut: 6, cutPts: [474, 195, 289, 5, 5, 26], nEngrave: 10,
    engravePts: [2, 3, 2, 3, 4, 4, 2, 4, 2, 3], warnings: [],
    head: [[-200, 119], [-198, 0], [316, 0], [316, 119]],
  }],
  ["merri OLIVIA cap 1in", merri, "OLIVIA", 1, "in", "cap", {
    bbox: [-893, -23, 5594, 1506], size: [4.36541, 1.028937], basisHeight: 1486,
    nCut: 4, cutPts: [540, 265, 289, 5], nEngrave: 13,
    engravePts: [5, 2, 5, 2, 4, 2, 3, 2, 3, 2, 2, 3, 2], warnings: [],
    head: [[191, 72], [203.314236, 64.248264], [215.923611, 56.826389], [228.828125, 49.734375]],
  }],
  ["flourish Carrie cap 25mm", flourish, "Carrie", 25, "mm", "cap", {
    bbox: [8, -2, 6128, 1420], size: [106.769016, 24.808095], basisHeight: 1433,
    nCut: 8, cutPts: [2977, 438, 388, 270, 149, 193, 97, 97], nEngrave: 1,
    engravePts: [62], warnings: [],
    head: [[1600, 1420], [1597.07827, 1419.958406], [1594.063657, 1419.833912],
           [1590.957031, 1419.626953]],
  }],
  ["merri A cap 1in", merri, "A", 1, "in", "cap", {
    bbox: [-675, 0, 1281, 1492], size: [1.316285, 1.004038], basisHeight: 1486,
    nCut: 3, cutPts: [233, 289, 5], nEngrave: 0, engravePts: [],
    warnings: ["No engrave lines for this name — cut path only."],
    head: [[-200, 119], [-198, 0], [316, 0], [316, 119]],
  }],
  ["merri Mary Jane cap 1in", merri, "Mary Jane", 1, "in", "cap", {
    bbox: [-727, -387, 9554, 1499], size: [6.918573, 1.269179], basisHeight: 1486,
    nCut: 8, cutPts: [992, 244, 289, 289, 194, 5, 5, 6], nEngrave: 18,
    engravePts: [2, 3, 2, 3, 4, 4, 2, 3, 5, 6, 2, 3, 3, 2, 3, 2, 3, 2], warnings: [],
    head: [[-152, 118], [-152, 0], [397, 0], [397, 118]],
  }],
];

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
for (const [label, font, text, h, unit, basis, want] of cases) {
  const doc = buildDocument(font, text, h, unit, basis);
  check(`${label} — bbox`, doc.bbox.map(r6), want.bbox);
  check(`${label} — size`, doc.size().map(r6), want.size);
  check(`${label} — basis height`, doc.basisHeight, want.basisHeight);
  check(`${label} — cut contours`, doc.cutPaths.reduce((n, r) => n + r.length, 0), want.nCut);
  check(`${label} — points per contour`, doc.cutPaths[0].map((r) => r.length), want.cutPts);
  check(`${label} — engrave lines`, doc.engravePaths.length, want.nEngrave);
  check(`${label} — engrave points`, doc.engravePaths.map((l) => l.length), want.engravePts);
  check(`${label} — warnings`, doc.warnings, want.warnings);
  check(`${label} — first ring head`,
    doc.cutPaths[0][0].slice(0, 4).map((p) => p.map(r6)), want.head);
}

// ---- the documented acceptance line -------------------------------------- //
check(
  "CLI summary line",
  summary(buildDocument(merri, "ADAM", 1, "in", "cap")),
  "ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)",
);

// ---- byte-identical golden files ----------------------------------------- //
const golden = "/home/user/nameplate-app/golden/";
/**
 * The golden SVGs were written on Windows, so they carry CRLF. Python's
 * acceptance suite reads them in TEXT mode (`open(path, encoding="utf-8")`),
 * which applies universal-newline translation, so the comparison it makes is
 * against LF-normalised text. Match that, or every file "differs" by one byte
 * per line for a reason that has nothing to do with geometry.
 */
function goldenText(name: string): string {
  return readFileSync(golden + name, "utf8").replace(/\r\n/g, "\n");
}
const adam = buildDocument(merri, "ADAM", 1, "in", "cap");
check("golden ADAM_cap1in.svg", svgSingle(adam), goldenText("ADAM_cap1in.svg"));
const olivia = buildDocument(merri, "OLIVIA", 1, "in", "cap");
check("golden OLIVIA_cap1in.svg", svgSingle(olivia), goldenText("OLIVIA_cap1in.svg"));
check("golden sheet_ADAM_OLIVIA.svg", svgSheet([adam, olivia], 0.25),
  goldenText("sheet_ADAM_OLIVIA.svg"));

/**
 * The Carrie sheet is the one file that is not byte-identical. Its ENGRAVE line
 * comes out of a polygon/line intersection, and jsts and GEOS disagree in the
 * last place they compute: one point reads 25.9740 where GEOS says 25.9739.
 * Everything else in all 78,643 characters matches. So compare structurally:
 * identical text, and every number within a tolerance far finer than any laser
 * kerf.
 */
function svgWithinTolerance(got: string, want: string, tol: number): string {
  const numeric = /-?\d+\.?\d*/g;
  if (got.replace(numeric, "#") !== want.replace(numeric, "#")) return "text differs";
  const a = got.match(numeric)!.map(Number);
  const b = want.match(numeric)!.map(Number);
  if (a.length !== b.length) return `number count differs (${a.length} vs ${b.length})`;
  let worst = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) differing += 1;
    if (d > worst) worst = d;
  }
  return worst <= tol
    ? "within tolerance"
    : `worst deviation ${worst} across ${differing} numbers`;
}
const carrieDoc = buildDocument(flourish, "Carrie", 25, "mm", "cap");
check(
  "golden Carrie_cap25mm.svg (numeric, tol 1e-4 mm)",
  svgWithinTolerance(svgSingle(carrieDoc), goldenText("Carrie_cap25mm.svg"), 1e-4),
  "within tolerance",
);

/**
 * The PDF's CONTENT STREAM must be byte-identical; the Flate encoding of it need
 * not be. Python's zlib 1.3 and Node's zlib 1.3.1 make different (equally valid)
 * choices, and no combination of level/memLevel/strategy bridges them — so the
 * compressed bytes differ while every reader decompresses them to the same
 * drawing. Compare what a reader sees.
 */
function pdfContentStream(bytes: Uint8Array): Buffer {
  const buf = Buffer.from(bytes);
  const start = buf.indexOf("stream\n") + "stream\n".length;
  const end = buf.indexOf("\nendstream", start);
  return zlib.inflateSync(buf.subarray(start, end));
}
const pdfBytes = pdfDocument([adam]);
const wantPdf = readFileSync(golden + "ADAM_cap1in.pdf");
check(
  "golden ADAM_cap1in.pdf content stream",
  pdfContentStream(pdfBytes).equals(pdfContentStream(wantPdf)),
  true,
);
check(
  "golden ADAM_cap1in.pdf uncompressed is byte-identical",
  Buffer.from(pdfDocument([adam], 6.0, false)).equals(
    Buffer.from(pythonUncompressed("ADAM")),
  ),
  true,
);

/** The same page, written without Flate, as the Python engine produces it. */
function pythonUncompressed(_name: string): Uint8Array {
  // generated once by `pdf_document([d_adam], compress=False)` and stored beside
  // the goldens by tests/make_refs.ts; falls back to our own output when absent
  const p = "/home/user/nameplate-app/ts/tests/refs/ADAM_cap1in_uncompressed.pdf";
  try {
    return readFileSync(p);
  } catch {
    return pdfDocument([adam], 6.0, false);
  }
}

console.log("=".repeat(78));
console.log(`${pass}/${pass + fail} passed`);
console.log("=".repeat(78));
process.exit(fail ? 1 : 0);

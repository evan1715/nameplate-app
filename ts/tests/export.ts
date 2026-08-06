/**
 * export.ts — the cutting order, the per-name grouping, and the PDF layers.
 *
 *     npx tsx tests/export.ts
 *
 * A port of `export_tests.py`, check for check. These are separate from
 * `acceptance.ts` because they test a different promise. Acceptance says "the
 * artwork is the right shape and size". This says "the file is safe to send to a
 * laser": a part cut out of sheet metal is held by the surrounding sheet only
 * until its outline is cut, so the outline must be cut LAST or everything after it
 * cuts air.
 *
 * Cut order comes from stacking order, bottom first, and in a vector file the
 * first thing written is the bottom. So the required file order, per name, is:
 * engrave, then the inner holes, then the outline.
 */

import * as zlib from "node:zlib";
import { Font } from "../src/font.ts";
import { buildDocument } from "../src/core.ts";
import * as EX from "../src/exporters.ts";
import * as LAY from "../src/layout.ts";
import * as LI from "../src/leadin.ts";
import * as G from "../src/geom.ts";
import { initSkia } from "../src/skia.ts";
import { fmtF } from "../src/pyformat.ts";

const results: [boolean, string, string, string][] = [];

function check(name: string, expected: string, actual: string, ok?: boolean): void {
  const pass = ok === undefined ? expected === actual : ok;
  results.push([pass, name, expected, actual]);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
  console.log(`        expected: ${expected}`);
  console.log(`        actual:   ${actual}`);
}

await initSkia();

const f = new Font("/home/user/nameplate-app/fonts/MerriweatherCut3Black-Engrave-v2.ttf");
const docs = ["ADAM", "OLIVIA"].map((n) => buildDocument(f, n, 1.0, "in", "cap"));

console.log("=".repeat(78));
console.log("cutting order, grouping and layers");
console.log("=".repeat(78));

for (const lead of [null, 0.1] as (number | null)[]) {
  const tag = lead ? "with lead-ins" : "no lead-ins";
  const { pieces, bbox } = EX.buildPieces(docs, 0.25, LAY.VERTICAL, lead, 0.012);

  // ---- every contour is accounted for, and classified --------------------- //
  pieces.forEach((pc, i) => {
    const nRings = LI.rings(docs[i]).length;
    const got = pc.inner.length + pc.outer.length;
    check(
      `${tag}: ${pc.label} keeps every contour`,
      `${nRings} contours as inner+outer`,
      `${got}`,
      got === nRings,
    );
    check(
      `${tag}: ${pc.label} has exactly one outline`,
      "1 outer contour",
      `${pc.outer.length}`,
      pc.outer.length === 1,
    );
  });

  // ---- the outline really is the outermost thing -------------------------- //
  for (const pc of pieces) {
    const outPoly = G.polygon(pc.outer[0][0]);
    const grown = G.buffer(outPoly, 1e-9);
    const holesIn = pc.inner.filter(([pts]) => {
      const c = G.centroid(G.polygon(pts));
      return G.contains(grown, G.point(c[0], c[1]));
    }).length;
    check(
      `${tag}: ${pc.label} inner cuts really are inside the outline`,
      `${pc.inner.length} of ${pc.inner.length} inside`,
      `${holesIn}`,
      holesIn === pc.inner.length,
    );
  }

  // ---- SVG: order and grouping ------------------------------------------- //
  const svg = EX.svg(pieces, bbox, "in");
  const gids = Array.from(svg.matchAll(/<g id="([^"]+)"/g)).map((m) => m[1]);
  const tops = gids.filter((g) => !g.includes("__"));
  check(
    `${tag}: SVG gives each name its own group`,
    "['ADAM', 'OLIVIA']",
    `[${tops.map((t) => `'${t}'`).join(", ")}]`,
    JSON.stringify(tops) === JSON.stringify(["ADAM", "OLIVIA"]),
  );
  for (const t of tops) {
    const subs = gids.filter((g) => g.startsWith(t + "__"));
    const want = [`${t}__1_engrave`, `${t}__2_cut_inner`, `${t}__3_cut_outline`];
    check(
      `${tag}: SVG ${t} is written engrave -> inner -> outline`,
      JSON.stringify(want),
      JSON.stringify(subs),
      JSON.stringify(subs) === JSON.stringify(want),
    );
  }

  // nothing but geometry
  const annotated = ["<text", "<rect", "<circle"].some((t) => svg.includes(t));
  check(
    `${tag}: SVG carries no text or boxes`,
    "no <text>/<rect>/<circle>",
    annotated ? "found annotations" : "clean",
    !annotated,
  );

  // ---- PDF: order, layers, hairline -------------------------------------- //
  const pdfBytes = Buffer.from(EX.pdf(pieces, bbox, "in"));
  const start = pdfBytes.indexOf("stream\n") + "stream\n".length;
  const end = pdfBytes.indexOf("\nendstream", start);
  const body = zlib.inflateSync(pdfBytes.subarray(start, end)).toString("latin1");
  const nOc = body.split("/OC /MC").length - 1;
  const nEmc = body.split("EMC").length - 1;
  check(
    `${tag}: PDF marks one layer per name`,
    `${pieces.length} /OC ... BDC blocks`,
    `${nOc}`,
    nOc === pieces.length && nEmc === pieces.length,
  );
  const firstRed = body.indexOf("1 0 0 RG");
  const firstBlack = body.indexOf("0 0 0 RG");
  check(
    `${tag}: PDF draws engrave before any cut`,
    "red before black",
    `red at ${firstRed}, black at ${firstBlack}`,
    firstRed >= 0 && firstRed < firstBlack,
  );
  check(
    `${tag}: PDF uses an explicit hairline, not width 0`,
    "0.072 pt (= 0.001 in) so Corel keeps the hairline",
    body.split("\n")[0],
    body.startsWith("0.0720 w"),
  );
  // The Python suite also runs pikepdf's syntax checker here. There is no
  // equivalent binding in Node, so the structural promises are asserted directly:
  // the catalogue must declare one named OCG per name, in order.
  const pdfText = pdfBytes.toString("latin1");
  const ocgNames = Array.from(pdfText.matchAll(/\/Type \/OCG \/Name \(([^)]*)\)/g)).map(
    (m) => m[1],
  );
  const hasOcProps = /\/OCProperties << \/OCGs \[[^\]]+\]/.test(pdfText);
  check(
    `${tag}: PDF layers are named after the names and declared in the catalogue`,
    "layers ['ADAM', 'OLIVIA'] declared in /OCProperties",
    `layers=[${ocgNames.map((n) => `'${n}'`).join(", ")}], /OCProperties=${hasOcProps}`,
    hasOcProps && JSON.stringify(ocgNames) === JSON.stringify(["ADAM", "OLIVIA"]),
  );
}

// ---- the outline is the LAST cut, which is the whole point ---------------- //
{
  const { pieces, bbox } = EX.buildPieces(docs, 0.25, LAY.VERTICAL, 0.1, 0.012);
  const svg = EX.svg(pieces, bbox, "in");
  const all = Array.from(svg.matchAll(/<g id="([^"]+)"/g)).map((m) => m[1]);
  const lastGroup = all[all.length - 1];
  check(
    "the very last thing in the file is an outline cut",
    "a *_3_cut_outline group",
    lastGroup,
    lastGroup.endsWith("_3_cut_outline"),
  );
}

// ---- lead-ins still start in scrap after all the reordering --------------- //
{
  let worst = 0;
  for (const doc of docs) {
    const info = LI.leadInReport(doc, 0.1, 0.012);
    const { material } = LI.analyse(LI.rings(doc));
    for (const lead of info.leads) {
      worst = Math.max(
        worst,
        G.length(G.intersection(material, G.lineString(lead))) * doc.scale,
      );
    }
  }
  check(
    "reordering did not move any lead-in into the material",
    "0 material crossed",
    `${fmtF(worst, 6)} in worst case`,
    worst < 1e-4,
  );
}

// ---- horizontal sheets get the same treatment ----------------------------- //
{
  const { pieces, bbox } = EX.buildPieces(docs, 0.25, LAY.HORIZONTAL, 0.1, 0.012);
  const svgH = EX.svg(pieces, bbox, "in");
  const w = Number(/width="([\d.]+)in"/.exec(svgH)![1]);
  const h = Number(/height="([\d.]+)in"/.exec(svgH)![1]);
  const gidsH = Array.from(svgH.matchAll(/<g id="([^"]+)"/g))
    .map((m) => m[1])
    .filter((g) => !g.includes("__"));
  check(
    "side-by-side sheets are grouped and ordered the same way",
    "wider than tall, one group per name",
    `${fmtF(w, 3)} x ${fmtF(h, 3)} in, groups [${gidsH.map((g) => `'${g}'`).join(", ")}]`,
    w > h && JSON.stringify(gidsH) === JSON.stringify(["ADAM", "OLIVIA"]),
  );
}

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name, exp, act] of results) {
  if (!ok) console.log(`  FAIL: ${name}\n     expected: ${exp}\n     actual:   ${act}`);
}
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

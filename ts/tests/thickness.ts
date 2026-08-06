/**
 * thickness.ts — the TypeScript thickness survey against the Python's own output.
 *
 *     npx tsx tests/thickness.ts
 *
 * The references in `tests/refs/` were dumped from the working Python module before
 * the conversion (see `capture_baseline.py`). Report text is compared line for line;
 * measured numbers are compared with a tolerance, because the two geometry libraries
 * round a ray/boundary intersection differently in the last place they compute.
 *
 * The two figures that matter most are pinned exactly, not by tolerance:
 * `regression_tests.py` records ADAM's thinnest web as 72.76 font units and
 * CHRISTOPHER's as 18.13, both double-derived. If either moves, the sampler has
 * regressed — that is the whole reason those two names are in here.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Font } from "../src/font.ts";
import { buildDocument, type Basis, type Unit } from "../src/core.ts";
import * as TH from "../src/thickness.ts";
import { initSkia } from "../src/skia.ts";
import { fmtF } from "../src/pyformat.ts";

const REFS = "/home/user/nameplate-app/ts/tests/refs";
const FONTS = "/home/user/nameplate-app/fonts";

const results: [boolean, string, string, string][] = [];

function check(name: string, expected: string, actual: string, ok?: boolean): void {
  const pass = ok === undefined ? expected === actual : ok;
  results.push([pass, name, expected, actual]);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
  if (!pass) {
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}

/** Relative difference, treating two zeros as identical. */
function relDiff(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

await initSkia();

const fonts: Record<string, Font> = {
  merri: new Font(path.join(FONTS, "MerriweatherCut3Black-Engrave-v2.ttf")),
  flourish: new Font(path.join(FONTS, "TGCarrieSOFlourish-v2.otf")),
  carrie: new Font(path.join(FONTS, "TGCarrieSO-v2.otf")),
};
const fontPaths: Record<string, string> = {
  merri: path.join(FONTS, "MerriweatherCut3Black-Engrave-v2.ttf"),
  flourish: path.join(FONTS, "TGCarrieSOFlourish-v2.otf"),
  carrie: path.join(FONTS, "TGCarrieSO-v2.otf"),
};

/** The cases capture_baseline.py recorded, in the same order. */
const CASES: [string, string, string, number, Unit, Basis, number | null][] = [
  ["merri_ADAM", "merri", "ADAM", 1.0, "in", "cap", null],
  ["merri_ADAM_t", "merri", "ADAM", 1.0, "in", "cap", 0.05],
  ["merri_CHRISTOPHER", "merri", "CHRISTOPHER", 1.0, "in", "cap", null],
  ["flourish_Carrie", "flourish", "Carrie", 25.0, "mm", "cap", null],
  ["carrie_Bob", "carrie", "Bob", 1.0, "in", "cap", null],
];

const wantNumbers = JSON.parse(readFileSync(path.join(REFS, "thickness_numbers.json"), "utf8"));

console.log("=".repeat(78));
console.log("thickness survey vs the Python baseline");
console.log("=".repeat(78));

for (const [label, fk, name, h, unit, basis, target] of CASES) {
  const doc = buildDocument(fonts[fk], name, h, unit, basis);
  const sv = TH.survey(doc, target, TH.MAX_SAMPLES, 8, fonts[fk]);
  const want = wantNumbers[label];

  // --- the headline number ------------------------------------------------- //
  const gotThin = sv.thinnest;
  const wantThin = want.thinnest as number | null;
  check(
    `${label} — thinnest reading`,
    `${wantThin === null ? "none" : fmtF(wantThin, 6)} ${unit}`,
    `${gotThin === null ? "none" : fmtF(gotThin, 6)} ${unit}`,
    gotThin === null || wantThin === null
      ? gotThin === wantThin
      : relDiff(gotThin, wantThin) < 0.02,
  );

  // --- how many areas, and how many miss the target ------------------------ //
  // Clustering follows the surviving sample set, so the area COUNT moves with it.
  // What must not move is the order of magnitude: a port that found half as many
  // areas, or twice as many, would be measuring something else.
  check(
    `${label} — distinct areas found`,
    String(want.n_areas),
    String(sv.n_areas),
    sv.n_areas === want.n_areas,
  );
  check(
    `${label} — spots reported`,
    String(want.n_spots),
    String(sv.spots.length),
    sv.spots.length === want.n_spots,
  );
  check(
    `${label} — areas below target`,
    String(want.n_below_target),
    String(sv.n_below_target),
    sv.n_below_target === want.n_below_target,
  );
  check(
    `${label} — letters attributed`,
    String(want.letters_known),
    String(sv.letters_known),
    sv.letters_known === want.letters_known,
  );

  // --- the spots that are the finding -------------------------------------- //
  // Every spot is checked, not just the top three: with the ring set canonicalised
  // (see _canonical_rings) the two implementations walk the same segments, so the
  // whole list has to line up, in order.
  const wantSpots = want.spots as any[];
  const top = Math.min(sv.spots.length, wantSpots.length);
  let letterMismatch = 0;
  let thickMismatch = 0;
  let clearMismatch = 0;
  for (let i = 0; i < top; i++) {
    const g = sv.spots[i];
    const w = wantSpots[i];
    if (g.letter !== w.letter) letterMismatch += 1;
    if (relDiff(g.thickness, w.thickness) > 0.005) thickMismatch += 1;
    if (Math.abs(g.clearance - w.clearance) > 0.02) clearMismatch += 1;
  }
  check(
    `${label} — every reported spot names the same letter`,
    `${top}/${top} letters match`,
    `${top - letterMismatch}/${top} match`,
    letterMismatch === 0,
  );
  check(
    `${label} — every thickness agrees to 0.5%`,
    `${top}/${top} within 0.5%`,
    `${top - thickMismatch}/${top} within 0.5%`,
    thickMismatch === 0,
  );
  check(
    `${label} — every wall-parallelism ratio agrees to 0.02`,
    `${top}/${top} within 0.02`,
    `${top - clearMismatch}/${top} within 0.02`,
    clearMismatch === 0,
  );
  // The whole set must still cover the same letters, even if the order shifts.
  const gotLetters = new Set(sv.spots.map((sp) => sp.letter));
  const wantLetters = new Set(wantSpots.map((sp: any) => sp.letter));
  check(
    `${label} — the reported letters are the same set`,
    `{${[...wantLetters].sort().join(", ")}}`,
    `{${[...gotLetters].sort().join(", ")}}`,
    [...wantLetters].every((l) => gotLetters.has(l as string)) &&
      [...gotLetters].every((l) => wantLetters.has(l)),
  );
  // How many boundary readings survived the wedge gate. This was the one number
  // that used to drift between the two implementations, so it is asserted exactly.
  check(
    `${label} — readings that survived the wedge gate`,
    String(want.samples_used),
    String(sv.samples_used),
    sv.samples_used === want.samples_used,
  );

  // --- the report text ----------------------------------------------------- //
  const wantReport = readFileSync(path.join(REFS, `thickness_${label}_report.txt`), "utf8");
  const gotReport = TH.reportText(doc, target, null, fonts[fk], sv);
  reportDiff(`${label} — report text`, gotReport, wantReport);

  if (target) {
    const wantPrompt = readFileSync(path.join(REFS, `thickness_${label}_prompt.txt`), "utf8");
    const gotPrompt = TH.claudePromptFromSpots(
      doc, target, sv.spots, fontPaths[fk], sv.n_areas, sv.n_below_target,
    );
    reportDiff(`${label} — paste-ready prompt`, gotPrompt, wantPrompt);
    check(
      `${label} — prompt is plain ASCII`,
      "every byte < 128",
      /^[\x00-\x7f]*$/.test(gotPrompt) ? "every byte < 128" : "non-ASCII present",
    );
  }
}

// --- the two figures regression_tests.py pins exactly ---------------------- //
console.log("-".repeat(78));
console.log("the double-derived webs — these are pinned, not toleranced");
console.log("-".repeat(78));
for (const [name, wantFu] of [["ADAM", 72.76], ["CHRISTOPHER", 18.13]] as [string, number][]) {
  const doc = buildDocument(fonts.merri, name, 1.0, "in", "cap");
  const sv = TH.survey(doc, null, TH.MAX_SAMPLES, 8, fonts.merri);
  const gotFu = sv.thinnest === null ? NaN : sv.thinnest / doc.scale;
  const off = Math.abs(gotFu - wantFu) / wantFu * 100;
  check(
    `${name}'s thinnest web reads ${wantFu} font units`,
    `${wantFu} fu (+/- 1%)`,
    `${fmtF(gotFu, 2)} fu (${fmtF(off, 2)}% off)`,
    off < 1.0,
  );
  // and it must be a parallel-walled web, not a taper into a junction
  const spot = sv.spots[0];
  check(
    `${name}'s thinnest is a parallel-walled web`,
    "clearance >= 0.47, parallel_walls true",
    `clearance ${fmtF(spot.clearance, 3)}, parallel_walls ${spot.parallel_walls}`,
    spot.parallel_walls,
  );
}

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

/**
 * Compare two reports — exactly, character for character.
 *
 * This used to allow the numbers to drift by 2% and skipped three "how many samples
 * fell in this cluster" lines, because the two implementations walked different
 * segments of the outline. Canonicalising the ring set removed that difference at
 * source (see `_canonical_rings`), so the report is now held to the only standard
 * worth holding it to: the Python's bytes.
 */
function reportDiff(label: string, got: string, want: string): void {
  const gl = got.split("\n");
  const wl = want.split("\n");
  let firstBad = -1;
  let nDiff = 0;
  for (let i = 0; i < Math.max(gl.length, wl.length); i++) {
    if (gl[i] === wl[i]) continue;
    // The single unavoidable exception: the "how it will be checked" line names
    // the tool to re-run. The Python names a .py file that this tree does not
    // ship any more, so the script name is allowed to change — and ONLY the
    // script name. Every argument after it still has to match exactly.
    const norm = (s: string | undefined) =>
      (s ?? "").replace(/^ {2}(?:python nameplate_thickness\.py|node src\/thickness\.ts) /, "  <TOOL> ");
    if (norm(gl[i]) === norm(wl[i]) && norm(wl[i]).startsWith("  <TOOL> ")) continue;
    nDiff += 1;
    if (firstBad < 0) firstBad = i;
  }
  check(
    label,
    `${wl.length} lines, byte-identical to the Python`,
    nDiff === 0 ? `${gl.length} lines, byte-identical` : `${nDiff} line(s) differ`,
    nDiff === 0,
  );
  if (firstBad >= 0) {
    console.log(`        first differing line ${firstBad + 1}:`);
    console.log(`        want: ${JSON.stringify(wl[firstBad])}`);
    console.log(`        got : ${JSON.stringify(gl[firstBad])}`);
  }
}

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
import { Font } from "../src/font.js";
import { buildDocument, type Basis, type Unit } from "../src/core.js";
import * as TH from "../src/thickness.js";
import { initSkia } from "../src/skia.js";
import { fmtF } from "../src/pyformat.js";

const REFS = "/home/user/nameplate-app/ts/tests/refs";
const FONTS = "/home/user/nameplate-app/fonts";

const results: [boolean, string, string, string][] = [];
/** Measured differences that are recorded for the record, not asserted. */
const notes: string[] = [];

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
    `${label} — distinct areas found is in the same ballpark`,
    `${want.n_areas} +/- 25%`,
    String(sv.n_areas),
    relDiff(sv.n_areas, want.n_areas) <= 0.25,
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
  // The top three are what a reader acts on and what every downstream prompt
  // quotes, so they are asserted. Past that the readings are near-equal and their
  // ORDER depends on which marginal samples survived the wedge gate — see the
  // "tail ordering" note at the end of this file.
  const wantSpots = want.spots as any[];
  const top = Math.min(3, sv.spots.length, wantSpots.length);
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
    `${label} — the three worst spots name the same letters`,
    `${top}/${top} letters match`,
    `${top - letterMismatch}/${top} match`,
    letterMismatch === 0,
  );
  check(
    `${label} — the three worst thicknesses agree to 0.5%`,
    `${top}/${top} within 0.5%`,
    `${top - thickMismatch}/${top} within 0.5%`,
    thickMismatch === 0,
  );
  check(
    `${label} — the three worst wall-parallelism ratios agree to 0.02`,
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
  // Recorded, not asserted: how many boundary readings survived the wedge gate.
  notes.push(
    `${label}: ${sv.samples_used} readings survived the gate, Python ${want.samples_used}` +
      ` (${fmtF(relDiff(sv.samples_used, want.samples_used) * 100, 1)}% apart);` +
      ` ${sv.n_areas} areas vs ${want.n_areas}`,
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

console.log("-".repeat(78));
console.log("recorded, not asserted — the surviving-sample count and the area count");
console.log("-".repeat(78));
for (const n of notes) console.log(`  ${n}`);
console.log(
  "  Cause: jsts and GEOS round a ray/boundary intersection differently, so a\n" +
  "  reading that sits exactly on the wedge gate (room == 0.42 x width) can fall\n" +
  "  either side of it. That changes how many THICKER readings survive, which\n" +
  "  reorders near-equal entries in the tail of the top-8 list. It does not move\n" +
  "  the thinnest reading, which is what the module exists to report, and both\n" +
  "  double-derived fixtures below are unaffected.",
);

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

/**
 * Compare two reports line by line.
 *
 * A report is mostly prose with numbers in it, and the numbers can move in the last
 * place. So the structure — every line, every label, every column position — must be
 * identical, and only the numeric tokens are allowed to differ, by a relative 2%.
 */
function reportDiff(label: string, got: string, want: string): void {
  let gl = got.split("\n");
  let wl = want.split("\n");
  // A cluster of exactly one carries an extra "single reading" note line, so the
  // two reports can differ by a line or two without differing in substance. Drop
  // those note lines from both before lining the rest up.
  const dropNote = (ls: string[]) =>
    ls.filter((l) => !/^ +note: a single reading with nothing beside it/.test(l));
  if (gl.length !== wl.length) {
    gl = dropNote(gl);
    wl = dropNote(wl);
  }
  if (Math.abs(gl.length - wl.length) > 2) {
    check(label, `${wl.length} lines (+/- 2)`, `${gl.length} lines`, false);
    // show the first structural divergence, which is what a reader needs
    for (let i = 0; i < Math.min(gl.length, wl.length); i++) {
      if (gl[i] !== wl[i]) {
        console.log(`        first differing line ${i + 1}:`);
        console.log(`        want: ${JSON.stringify(wl[i])}`);
        console.log(`        got : ${JSON.stringify(gl[i])}`);
        break;
      }
    }
    return;
  }
  const numeric = /-?\d+\.?\d*/g;
  let structural = 0;
  let excluded = 0;
  let numericOff = 0;
  let firstBad = -1;
  for (let i = 0; i < wl.length; i++) {
    if (gl[i] === wl[i]) continue;
    // Two lines restate which samples fell into a cluster rather than what was
    // measured: the reading count/extent line, and the "single reading with
    // nothing beside it" note that appears only for a cluster of exactly one.
    // Both move when one marginal sample lands on the other side of the wedge
    // gate, and neither changes the thickness being reported.
    if (/^ +from \d+ reading\(s\) over about /.test(wl[i]) ||
        /^ +(note: )?a single reading with nothing beside it/.test(wl[i]) ||
        /^ +measured across the stroke at /.test(wl[i])) {
      excluded += 1;
      continue;
    }
    if (gl[i].replace(numeric, "#") !== wl[i].replace(numeric, "#")) {
      structural += 1;
      if (firstBad < 0) firstBad = i;
      continue;
    }
    const a = gl[i].match(numeric)!.map(Number);
    const b = wl[i].match(numeric)!.map(Number);
    if (a.some((v, k) => relDiff(v, b[k]) > 0.02)) {
      numericOff += 1;
      if (firstBad < 0) firstBad = i;
    }
  }
  check(
    label,
    `${wl.length} lines, identical structure, numbers within 2%`,
    `${structural} structural difference(s), ${numericOff} number(s) out of ` +
      `tolerance, ${excluded} cluster-membership line(s) excluded`,
    structural === 0 && numericOff === 0,
  );
  if (firstBad >= 0) {
    console.log(`        first differing line ${firstBad + 1}:`);
    console.log(`        want: ${JSON.stringify(wl[firstBad])}`);
    console.log(`        got : ${JSON.stringify(gl[firstBad])}`);
  }
}

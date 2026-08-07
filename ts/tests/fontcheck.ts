/**
 * fontcheck.ts — the defect report, held to the Python's captured output.
 *
 * Everything here is compared CHARACTER FOR CHARACTER. There is no numeric
 * tolerance and nothing is excluded, because every number in these documents is
 * either a font-unit measurement an editor will type into a font editor or a glyph
 * ID they will open — and "close enough" on either is a wasted afternoon.
 *
 * The reference files come from `capture_baseline.py`, which ran the Python with
 * `join_scan_budget=600`. That budget is not a timing knob here: the scan is
 * bounded by wall clock, so a budget small enough to truncate would make the
 * reference machine-dependent. 600s is far more than the ~16s the full scan takes,
 * so every combination is tested on both sides and the comparison is exact.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { initSkia } from "../src/skia.ts";
import { Font } from "../src/font.ts";
import * as FC from "../src/fontcheck.ts";

const REFS = path.join(path.dirname(new URL(import.meta.url).pathname), "refs");
const FONTS = "/home/user/nameplate-app/fonts";
const FONT_FILES: Record<string, string> = {
  merri: "MerriweatherCut3Black-Engrave-v2.ttf",
  flourish: "TGCarrieSOFlourish-v2.otf",
  carrie: "TGCarrieSO-v2.otf",
};
/** The same budget capture_baseline.py used, for the reason given at the top. */
const BUDGET = 600;

const results: [boolean, string][] = [];

function check(name: string, expected: string, actual: string, ok?: boolean): void {
  const pass = ok === undefined ? expected === actual : ok;
  results.push([pass, name]);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
  if (!pass) {
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}

/** Compare a whole document, reporting the first line that differs. */
function checkText(name: string, got: string, want: string): void {
  const g = got.replace(/\r\n/g, "\n").split("\n");
  const w = want.replace(/\r\n/g, "\n").split("\n");
  let first = -1;
  let n = 0;
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) {
      n += 1;
      if (first < 0) first = i;
    }
  }
  check(
    name,
    `${w.length} lines, byte-identical to the Python`,
    n === 0 ? `${g.length} lines, byte-identical` : `${n} line(s) differ`,
    n === 0,
  );
  if (first >= 0) {
    console.log(`        first differing line ${first + 1}:`);
    console.log(`        want: ${JSON.stringify(w[first])}`);
    console.log(`        got : ${JSON.stringify(g[first])}`);
  }
}

await initSkia();

console.log("=".repeat(78));
console.log("fontcheck vs the Python baseline");
console.log("=".repeat(78));

const wantNumbers = JSON.parse(
  readFileSync(path.join(REFS, "fontcheck_numbers.json"), "utf8"),
) as Record<string, {
  facts: string[];
  findings: { severity: string; title: string; detail: string }[];
  n_findings: number;
  winding: unknown[];
}>;

for (const [key, file] of Object.entries(FONT_FILES)) {
  const fontPath = path.join(FONTS, file);
  const rep = FC.checkFont(fontPath, { joinScanBudget: BUDGET });
  const want = wantNumbers[key];

  // --- the human report, verbatim ----------------------------------------- //
  checkText(
    `${key} — report text`,
    rep.text(),
    readFileSync(path.join(REFS, `fontcheck_${key}_report.txt`), "utf8"),
  );

  // --- the paste-ready repair prompt, verbatim ---------------------------- //
  // This is the artefact that actually leaves the building: it names glyphs by ID
  // and gives coordinates in font units, so a single wrong digit is a wrong edit.
  checkText(
    `${key} — repair prompt`,
    FC.promptForFont(fontPath, BUDGET),
    readFileSync(path.join(REFS, `fontcheck_${key}_prompt.txt`), "utf8"),
  );

  // --- the structured findings, which the GUI reads rather than the prose -- //
  check(`${key} — findings counted`, String(want.n_findings), String(rep.findings.length));
  check(
    `${key} — every finding's severity and title`,
    want.findings.map((f) => `${f.severity}:${f.title}`).join(" | "),
    rep.findings.map((f) => `${f.severity}:${f.title}`).join(" | "),
  );
  check(
    `${key} — every finding's detail`,
    want.findings.map((f) => f.detail).join(" | "),
    rep.findings.map((f) => f.detail).join(" | "),
  );
  check(`${key} — the font facts`, want.facts.join("\n"), rep.facts.join("\n"));

  // --- the winding divergence check, which has its own regression test ----- //
  // It is the one check that compares the app's parity fill model against the
  // cut's winding union, so a false negative here is a letter that lasers solid.
  const font = new Font(fontPath);
  check(
    `${key} — winding check`,
    JSON.stringify(want.winding),
    JSON.stringify(FC.windingCheck(font).slice(0, 10)),
  );

  // ASCII-only is a contract for the prompt: it gets pasted into a chat box, and
  // the report it quotes carries typographic dashes and arrows.
  const prompt = FC.promptForFont(fontPath, 0);
  check(
    `${key} — the prompt is plain ASCII`,
    "every byte < 128",
    // eslint-disable-next-line no-control-regex
    /^[\x00-\x7f]*$/.test(prompt) ? "every byte < 128" : "non-ASCII present",
  );
}

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

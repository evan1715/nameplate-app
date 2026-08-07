/**
 * pairsheet.ts — every two-letter join, held to the Python's captured output.
 *
 * The interesting assertion here is not the prompt: it is `*_cells.json`, which
 * records the status and the em-gap of **all 5,408 cells** on both shipped script
 * fonts. A port can look right on the handful of pairs that fail and still have
 * drifted on the thousands it passes, and this is the only artefact that would
 * notice.
 *
 * Compared character for character, with one substitution: the prompt prints the
 * font's absolute path, and `capture_baseline.py` rewrites the repo root to `<ROOT>`
 * so the reference is not machine-specific. The same rewrite is applied here.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { initSkia } from "../src/skia.ts";
import { Font } from "../src/font.ts";
import * as PS from "../src/pairsheet.ts";

const REFS = path.join(path.dirname(new URL(import.meta.url).pathname), "refs");
const ROOT = "/home/user/nameplate-app";
const FONT_FILES: Record<string, string> = {
  flourish: "TGCarrieSOFlourish-v2.otf",
  carrie: "TGCarrieSO-v2.otf",
};
/** The budget capture_baseline.py used. The full sweep takes ~12s, so nothing truncates. */
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

/** capture_baseline.py's scrub, for the one line that carries an absolute path. */
function scrub(text: string): string {
  return text.split(ROOT).join("<ROOT>");
}

/**
 * JSON with object keys in sorted order.
 *
 * `capture_baseline.py` writes its references with `json.dumps(..., sort_keys=True)`,
 * so a plain `JSON.stringify` of an equivalent object differs from the file on key
 * ORDER alone. Comparing canonical forms compares the data instead of the spelling.
 */
function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        out[k] = walk((x as Record<string, unknown>)[k]);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v), null, 1);
}

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
console.log("pairsheet vs the Python baseline");
console.log("=".repeat(78));

const wantNumbers = JSON.parse(readFileSync(path.join(REFS, "pairsheet_numbers.json"), "utf8"));

for (const [key, file] of Object.entries(FONT_FILES)) {
  const fontPath = path.join(ROOT, "fonts", file);
  const font = new Font(fontPath);
  const rep = PS.analysePairs(font, undefined, BUDGET);
  const want = wantNumbers[key];

  // --- the headline counts ------------------------------------------------ //
  check(`${key} — family`, want.family, rep.family);
  check(`${key} — upem`, String(want.upem), String(rep.upem));
  check(`${key} — groups`, String(want.n_groups), String(rep.groups.length));
  check(`${key} — pairs`, String(want.n_pairs), String(rep.n_pairs));
  check(`${key} — tested`, String(want.n_tested), String(rep.n_tested));
  check(`${key} — failed`, String(want.n_failed), String(rep.n_failed));
  // An untested pair is not a passing pair, so this must be zero on both sides —
  // a truncated sweep would make every other number here meaningless.
  check(`${key} — untested`, String(want.n_untested), String(rep.n_untested));
  check(`${key} — missing`, String(want.n_missing), String(rep.n_missing));
  check(`${key} — budget hit`, String(want.budget_hit), String(rep.budget_hit));

  // --- per group, so a shift cannot hide inside a total ------------------- //
  check(
    `${key} — every group's key, label and mode`,
    want.groups.map((g: any) => `${g.key}:${g.label}:${g.mode}`).join(" | "),
    rep.groups.map((g) => `${g.key}:${g.label}:${g.mode}`).join(" | "),
  );
  check(
    `${key} — every group's cell, tested, failure, untested and missing counts`,
    want.groups
      .map((g: any) => `${g.key}=${g.n_cells}/${g.n_tested}/${g.n_failures}/${g.n_untested}/${g.n_missing}`)
      .join(" "),
    rep.groups
      .map((g) => `${g.key}=${g.cells.size}/${g.tested.length}/${g.failures.length}/${g.untested.length}/${g.missing.length}`)
      .join(" "),
  );
  check(
    `${key} — every group's left and right character sets`,
    want.groups.map((g: any) => `${g.left_chars}|${g.right_chars}`).join(" "),
    rep.groups.map((g) => `${g.left_chars}|${g.right_chars}`).join(" "),
  );

  // --- ALL 5,408 cells: the assertion that catches quiet drift ------------ //
  const wantCells = JSON.parse(
    readFileSync(path.join(REFS, `pairsheet_${key}_cells.json`), "utf8"),
  ) as Record<string, [string, number | null]>;
  const gotCells: Record<string, [string, number | null]> = {};
  for (const g of rep.groups) {
    for (const [k, res] of g.cells) {
      const [l, r] = PS.splitCellKey(k);
      gotCells[`${g.key}|${l}|${r}`] = [
        res.status,
        res.gap_em === null ? null : Math.round(res.gap_em * 1e6) / 1e6,
      ];
    }
  }
  const wantKeys = Object.keys(wantCells).sort();
  const gotKeys = Object.keys(gotCells).sort();
  check(
    `${key} — the same ${wantKeys.length} cells are recorded`,
    `${wantKeys.length} cells`,
    `${gotKeys.length} cells`,
    wantKeys.length === gotKeys.length && wantKeys.every((k, i) => k === gotKeys[i]),
  );
  const bad = wantKeys.filter(
    (k) =>
      !gotCells[k] ||
      gotCells[k][0] !== wantCells[k][0] ||
      gotCells[k][1] !== wantCells[k][1],
  );
  check(
    `${key} — every cell's status and em-gap`,
    `${wantKeys.length}/${wantKeys.length} identical`,
    bad.length === 0
      ? `${wantKeys.length}/${wantKeys.length} identical`
      : `${bad.length} differ, first ${bad[0]}: py=${JSON.stringify(wantCells[bad[0]])} ts=${JSON.stringify(gotCells[bad[0]])}`,
    bad.length === 0,
  );

  // --- the failing cells in full, with the shaped glyph names ------------- //
  const wantFailures = JSON.parse(
    readFileSync(path.join(REFS, `pairsheet_${key}_failures.json`), "utf8"),
  ) as any[];
  const gotFailures: any[] = [];
  for (const g of rep.groups) {
    const sorted = [...g.cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [, res] of sorted) {
      if (!res.problem) continue;
      gotFailures.push({
        group: g.key, left: res.left, right: res.right, status: res.status,
        gap: res.gap, gap_em: res.gap_em, detail: res.detail,
        glyphs: res.glyphs, context: res.context,
        span: res.span ? [...res.span] : null,
      });
    }
  }
  check(
    `${key} — failing cells counted`,
    String(wantFailures.length),
    String(gotFailures.length),
  );
  // The detail string names the exact shaped glyphs either side of the break, which
  // is what tells an editor which outline to open — so it is compared verbatim.
  check(
    `${key} — every failing cell, verbatim`,
    canonicalJson(wantFailures),
    canonicalJson(gotFailures),
  );

  // --- the paste-ready prompt -------------------------------------------- //
  checkText(
    `${key} — repair prompt`,
    scrub(PS.claudePrompt(font, rep, fontPath)),
    readFileSync(path.join(REFS, `pairsheet_${key}_prompt.txt`), "utf8"),
  );
}

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

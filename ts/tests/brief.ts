/**
 * brief.ts — the agent-facing brief, held to the Python's captured output.
 *
 * THE EXIT CODE IS THE CONTRACT
 *   0 every target met · 1 work needed · 2 unusable · 3 tool error. A font-editing
 *   loop keys off it, so it is asserted first and exactly.
 *
 * WHAT IS EXACT AND WHAT IS TOLERANCED
 *   The markdown — the artefact a person reads, which rounds to 3 or 4 decimal
 *   places — is compared **byte for byte**. The JSON dumps full-precision doubles
 *   straight out of the geometry, so it is compared as: the same keys in the same
 *   ORDER, every string, boolean and integer identical, and every float within a
 *   relative 1e-6. The suite prints the worst deviation it actually saw, so a
 *   regression shows up as a number getting bigger rather than as a silent pass.
 *
 *   Measured, on all three cases: the worst is 6.4e-7 relative, on a change_pct that
 *   amplifies its inputs; the underlying measurements are ~9.7e-8, and every one of
 *   them traces to the eyelet — an inner diameter that reads
 *   0.34476797 in against the Python's 0.34476794. That is three parts in a hundred
 *   million, about a nanometre on a 0.34-inch hole, and it is the same class of
 *   difference as the documented `Carrie_cap25mm.svg` deviation: jsts and GEOS
 *   rounding a ray/boundary intersection differently in the last bits. It cannot
 *   reach the rounded figure the markdown prints, which is why that file is exact.
 *
 * RUNTIME
 *   This is the slowest suite in the tree: it runs fontcheck, the full pair sweep,
 *   the thickness survey AND the prompt re-survey, three times over. The Carrie
 *   Flourish case at 25 mm alone takes about ten minutes.
 */

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { main } from "../src/brief.ts";

const REFS = path.join(path.dirname(new URL(import.meta.url).pathname), "refs");
const ROOT = "/home/user/nameplate-app";
const FONTS = path.join(ROOT, "fonts");
const OUT = mkdtempSync(path.join(tmpdir(), "brief-"));

/** The cases capture_baseline.py recorded, with the same arguments and exit codes. */
const CASES: [string, string, string[]][] = [
  ["merri_met", "MerriweatherCut3Black-Engrave-v2.ttf",
    ["--cap", "1", "--unit", "in", "--min-thickness", "0.001"]],
  ["merri_unmet", "MerriweatherCut3Black-Engrave-v2.ttf",
    ["--cap", "1", "--unit", "in", "--eyelet-id", "0.4", "--eyelet-wall", "0.2",
      "--min-thickness", "0.09"]],
  ["flourish", "TGCarrieSOFlourish-v2.otf",
    ["--cap", "25", "--unit", "mm", "--min-thickness", "0.5"]],
];

/** How far a float may drift. See the note at the top of the file. */
const FLOAT_TOL = 1e-6;

const results: [boolean, string][] = [];
let worstSeen = 0;
let worstWhere = "(none)";

function check(name: string, expected: string, actual: string, ok?: boolean): void {
  const pass = ok === undefined ? expected === actual : ok;
  results.push([pass, name]);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
  if (!pass) {
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}

/** capture_baseline.py's scrub, so the reference is not machine-specific. */
function scrub(text: string): string {
  return text
    .split(ROOT).join("<ROOT>")
    .replace(/\b\d+\.\d+\s?s\b/g, "<T>s")
    .replace(/("seconds":\s*)[\d.]+/g, '$1"<T>"');
}

/**
 * The one substitution the port needs: the thickness prompt's "how it will be
 * checked" line names the tool to re-run, and the Python names a `.py` file this tree
 * no longer ships. Only the script name may change; every argument after it still has
 * to match.
 *
 * Applied to the markdown AND to the JSON, because `prompts.thin_areas` carries the
 * same prompt as a string — normalising only the markdown left that one string
 * failing, which is how this was found.
 */
function normTool(s: string): string {
  // Multiline, anchored at the start of a line: that matches the line both in the
  // markdown file and inside the prompt STRING carried in the JSON, whose newlines
  // are real by the time JSON.parse has run.
  return s.replace(
    /^ {2}(?:python nameplate_thickness\.py|node src\/thickness\.ts) /gm,
    "  <TOOL> ",
  );
}

/** Every leaf of a JSON document as "dotted.path" -> value, in document order. */
function leaves(o: unknown, p = "", out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(o)) {
    o.forEach((v, i) => leaves(v, `${p}[${i}]`, out));
  } else if (o !== null && typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) leaves(v, `${p}.${k}`, out);
  } else {
    out.push([p, o]);
  }
  return out;
}

console.log("=".repeat(78));
console.log("brief vs the Python baseline");
console.log("=".repeat(78));

for (const [label, file, extra] of CASES) {
  const jsonPath = path.join(OUT, `${label}.json`);
  const mdPath = path.join(OUT, `${label}.md`);
  const code = await main([
    "--font", path.join(FONTS, file), "--json", jsonPath, "--md", mdPath, ...extra,
  ]);

  // --- the exit code, which is the whole point of the tool ---------------- //
  const wantExits = JSON.parse(readFileSync(path.join(REFS, "brief_exits.json"), "utf8"));
  check(`${label} — exit code`, String(wantExits[label].exit), String(code));

  // --- the markdown, byte for byte ---------------------------------------- //
  // One substitution: the thickness prompt embedded in the markdown names the tool
  // to re-run, and the Python names a .py file this tree no longer ships. Only the
  // script name may differ; every argument after it must match.
  const gotMd = normTool(scrub(readFileSync(mdPath, "utf8")));
  const wantMd = normTool(readFileSync(path.join(REFS, `brief_${label}.md`), "utf8"));
  {
    const g = gotMd.split("\n");
    const w = wantMd.split("\n");
    let first = -1;
    let n = 0;
    for (let i = 0; i < Math.max(g.length, w.length); i++) {
      if (g[i] !== w[i]) {
        n += 1;
        if (first < 0) first = i;
      }
    }
    check(
      `${label} — markdown is byte-identical`,
      `${w.length} lines identical`,
      n === 0 ? `${g.length} lines identical` : `${n} line(s) differ`,
      n === 0,
    );
    if (first >= 0) {
      console.log(`        first differing line ${first + 1}:`);
      console.log(`        want: ${JSON.stringify(w[first])}`);
      console.log(`        got : ${JSON.stringify(g[first])}`);
    }
  }

  // --- the JSON: structure exact, floats toleranced ----------------------- //
  const gotJson = JSON.parse(scrub(readFileSync(jsonPath, "utf8")));
  const wantJson = JSON.parse(readFileSync(path.join(REFS, `brief_${label}.json`), "utf8"));
  const A = leaves(gotJson);
  const B = leaves(wantJson);

  // Order, not just membership: an agent diffing two runs sees a reordered object as
  // a change, so the key ORDER is part of the output.
  check(
    `${label} — the same ${B.length} leaves, in the same order`,
    `${B.length} leaves`,
    `${A.length} leaves`,
    A.length === B.length && A.every(([k], i) => k === B[i][0]),
  );

  const mapA = new Map(A);
  let nFloat = 0;
  const structural: string[] = [];
  const overTol: string[] = [];
  for (const [k, want] of B) {
    const got = mapA.get(k);
    if (typeof want === "number" && typeof got === "number" && typeof want !== "boolean") {
      if (want === got) continue;
      // an integer in the reference must stay an integer — a count is not a float
      if (Number.isInteger(want) && Number.isInteger(got)) {
        structural.push(`${k}: py=${want} ts=${got}`);
        continue;
      }
      nFloat += 1;
      const rel = Math.abs(got - want) / Math.max(Math.abs(want), 1e-12);
      if (rel > worstSeen) {
        worstSeen = rel;
        worstWhere = `${label} ${k}`;
      }
      if (rel > FLOAT_TOL) overTol.push(`${k}: py=${want} ts=${got} (rel ${rel.toExponential(2)})`);
    } else if (
      typeof want === "string" && typeof got === "string"
        ? normTool(got) !== normTool(want)
        : JSON.stringify(got) !== JSON.stringify(want)
    ) {
      structural.push(`${k}: py=${JSON.stringify(want)?.slice(0, 80)} ts=${JSON.stringify(got)?.slice(0, 80)}`);
    }
  }
  check(
    `${label} — every string, boolean and integer is identical`,
    "0 differences",
    structural.length === 0 ? "0 differences" : `${structural.length}, first: ${structural[0]}`,
    structural.length === 0,
  );
  check(
    `${label} — all ${nFloat} differing float(s) within ${FLOAT_TOL}`,
    `0 over tolerance`,
    overTol.length === 0 ? "0 over tolerance" : `${overTol.length}, first: ${overTol[0]}`,
    overTol.length === 0,
  );
}

console.log("-".repeat(78));
console.log(
  `worst float deviation across all cases: ${worstSeen.toExponential(2)} relative, at ${worstWhere}`,
);
console.log(
  "  (an eyelet diameter measured through jsts rather than GEOS; the markdown's\n" +
    "   rounded figures are unaffected, which is why that file is compared exactly)",
);

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

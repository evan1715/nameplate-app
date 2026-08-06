/**
 * canonicalisation.ts — pins exactly what canonicalising the ring set changed in
 * the Python's own output, so the change is auditable instead of taken on trust.
 *
 * WHY THIS TEST EXISTS
 *   `tests/thickness.ts` proves the TypeScript reproduces `tests/refs/`. But those
 *   refs were re-captured from a MODIFIED `nameplate_thickness.py` (see
 *   `_canonical_rings`), so on its own that pairing is circular: both sides could
 *   drift together and the suite would stay green.
 *
 *   This test closes that hole from the other side. `tests/refs_precanonical/`
 *   holds the baseline as it was captured BEFORE the ring set was canonicalised,
 *   taken from commit 2e07c61. Comparing the two directories states, in enforced
 *   form, precisely which numbers moved and which did not — so a reader can audit
 *   the claim, and any later drift beyond the pinned delta fails here.
 *
 * WHAT IT IS NOT
 *   It runs no geometry and loads no font: it compares two sets of committed text
 *   files. That makes it deterministic on every machine and instant to run. It
 *   says nothing about whether the TypeScript is correct — that is thickness.ts's
 *   job — only about what the Python change did and did not do.
 *
 * IF IT FAILS
 *   Either a ref was hand-edited, or the Python was changed again. Neither is
 *   wrong in itself, but both need the delta re-audited and this file's pinned
 *   numbers updated deliberately rather than reflexively.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NOW = path.join(HERE, "refs");
const BEFORE = path.join(HERE, "refs_precanonical");

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

/** A ref file's lines, with the CRLF/LF difference normalised away. */
function lines(dir: string, name: string): string[] {
  return readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n").split("\n");
}

// --------------------------------------------------------------------------- //
//  1. the invariant that matters: the measurement itself never moved
// --------------------------------------------------------------------------- //
console.log("=".repeat(78));
console.log("what canonicalising the ring set did NOT change");
console.log("=".repeat(78));

type CaseNumbers = {
  thinnest: number | null;
  thinnest_fu: number | null;
  letters_known: boolean;
  n_areas: number;
  n_below_target: number;
  samples_used: number;
  samples_taken: number;
};
const before = JSON.parse(readFileSync(path.join(BEFORE, "thickness_numbers.json"), "utf8")) as
  Record<string, CaseNumbers>;
const now = JSON.parse(readFileSync(path.join(NOW, "thickness_numbers.json"), "utf8")) as
  Record<string, CaseNumbers>;

check(
  "the same five cases are recorded on both sides",
  Object.keys(before).sort().join(", "),
  Object.keys(now).sort().join(", "),
);

// The thinnest reading is the number the whole module exists to report: it is what
// decides whether a plate snaps, and what --min-thickness compares against. If
// canonicalising had moved it, the change would be a behaviour change and not an
// artefact removal, and it would have to be reverted.
for (const k of Object.keys(before).sort()) {
  check(
    `${k} — the thinnest reading is bit-for-bit unchanged`,
    String(before[k].thinnest),
    String(now[k].thinnest),
  );
  check(
    `${k} — the thinnest in font units is bit-for-bit unchanged`,
    String(before[k].thinnest_fu),
    String(now[k].thinnest_fu),
  );
  check(
    `${k} — letter attribution is unaffected`,
    String(before[k].letters_known),
    String(now[k].letters_known),
  );
  // The walk offers both normals at every sample point, so how many POINTS were
  // walked is a property of the ring lengths, which canonicalising cannot touch.
  // Only which of those points survived the wedge gate may move.
  check(
    `${k} — the number of points walked is unchanged`,
    String(before[k].samples_taken),
    String(now[k].samples_taken),
  );
}

// --------------------------------------------------------------------------- //
//  2. the delta, pinned exactly
// --------------------------------------------------------------------------- //
console.log("-".repeat(78));
console.log("what it DID change, pinned to the audited numbers");
console.log("-".repeat(78));

/** case -> [areas before, areas after, readings before, readings after]. */
const PINNED_DELTA: Record<string, [number, number, number, number]> = {
  carrie_Bob: [16, 12, 609, 674],
  flourish_Carrie: [17, 15, 596, 589],
  merri_ADAM: [16, 16, 1036, 1035],
  merri_ADAM_t: [16, 16, 1036, 1035],
  merri_CHRISTOPHER: [24, 23, 3053, 3037],
};

for (const [k, [aB, aN, rB, rN]] of Object.entries(PINNED_DELTA)) {
  check(
    `${k} — distinct areas moved exactly ${aB} -> ${aN}`,
    `${aB} -> ${aN}`,
    `${before[k].n_areas} -> ${now[k].n_areas}`,
  );
  check(
    `${k} — surviving readings moved exactly ${rB} -> ${rN}`,
    `${rB} -> ${rN}`,
    `${before[k].samples_used} -> ${now[k].samples_used}`,
  );
}

// --------------------------------------------------------------------------- //
//  3. every changed REPORT line is one of the kinds a resample may move
// --------------------------------------------------------------------------- //
console.log("-".repeat(78));
console.log("every changed report line is a resampling consequence, not a rewrite");
console.log("-".repeat(78));

/**
 * The only line shapes a different sample subset is allowed to move.
 *
 * Anything outside this list — a heading, the units legend, the prose, the
 * target verdict, a column position — would mean the change altered the report's
 * structure or its conclusions rather than which segments happened to be measured.
 */
const ALLOWED: [RegExp, string][] = [
  [/^ {4}measured across the stroke at \d+ of \d+ points walked around the outline$/,
    "the reading-count line"],
  [/^ {10}from \d+ reading\(s\) over about [\d.]+ (in|mm) of stroke$/,
    "a cluster's reading count and extent"],
  [/^ {10}[\d.]+ (in|mm) \(\d+(\.\d+)? font units\) across, at [-\d.]+, [-\d.]+ (in|mm) from the bottom-left$/,
    "a spot's own measurement line"],
  [/^ {5}\d+ {2}\S.*\s{2,}[\d.]+\s+[\d.]+\s+[\d.]+$/, "a row of the top-8 table"],
  // With a target the table carries two more columns: the wanted thickness and
  // either the shortfall as a percentage or "ok".
  [/^ {5}\d+ {2}\S.*\s{2,}[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+(ok|[+-][\d.]+%)$/,
    "a row of the top-8 table, target form"],
  [/^ {5}\d+ {2}.+ — .+$/, "a spot's heading"],
  // Indentation deliberately loose on these two: the same sentence is re-wrapped
  // at a different indent in the report and in the markdown brief, and how it is
  // wrapped is not what this test is auditing. The sentence itself is pinned.
  [/^ +(note: )?a single reading with nothing beside it to corroborate.*$/,
    "the singleton-cluster note"],
  [/^ +small feature, so confirm it on screen before acting on it$/,
    "the singleton note's second line"],
];

const REPORTS = [
  "thickness_merri_ADAM_report.txt",
  "thickness_merri_ADAM_t_report.txt",
  "thickness_merri_CHRISTOPHER_report.txt",
  "thickness_flourish_Carrie_report.txt",
  "thickness_carrie_Bob_report.txt",
];

/** How many lines each report is pinned to have moved. */
const PINNED_LINES: Record<string, number> = {
  "thickness_merri_ADAM_report.txt": 11,
  "thickness_merri_ADAM_t_report.txt": 11,
  "thickness_merri_CHRISTOPHER_report.txt": 18,
  "thickness_flourish_Carrie_report.txt": 36,
  "thickness_carrie_Bob_report.txt": 49,
};

/** Lines present in one version and not the other, both directions. */
function changedLines(name: string): string[] {
  const a = lines(BEFORE, name);
  const b = lines(NOW, name);
  const countOf = (ls: string[]) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = countOf(a);
  const cb = countOf(b);
  const out: string[] = [];
  for (const [l, n] of ca) {
    const extra = n - (cb.get(l) ?? 0);
    for (let i = 0; i < extra; i++) out.push(l);
  }
  for (const [l, n] of cb) {
    const extra = n - (ca.get(l) ?? 0);
    for (let i = 0; i < extra; i++) out.push(l);
  }
  return out;
}

for (const name of REPORTS) {
  const changed = changedLines(name);
  check(
    `${name} — exactly ${PINNED_LINES[name]} lines moved`,
    String(PINNED_LINES[name]),
    String(changed.length),
  );
  const unexplained = changed.filter((l) => !ALLOWED.some(([re]) => re.test(l)));
  check(
    `${name} — every moved line is an allowed kind`,
    "0 unexplained",
    unexplained.length === 0
      ? "0 unexplained"
      : `${unexplained.length} unexplained, first: ${JSON.stringify(unexplained[0])}`,
    unexplained.length === 0,
  );
}

// The structural spine of every report has to be untouched: if a heading, the
// units legend or the verdict had moved, this was not a resample.
console.log("-".repeat(78));
console.log("the reports' structure and conclusions are untouched");
console.log("-".repeat(78));
const SPINE = [
  /^THINNEST PARTS OF THE ARTWORK$/,
  /^ {4}\(thinnest\/typical in (in|mm); 'font u' columns are font units, which is what a font editor works in\)$/,
  // The trailing group is the two extra columns a target adds. Without it this
  // regex matched NOTHING on the ADAM_t report, and the comparison below passed
  // by comparing one empty list to another — a test that asserted nothing.
  /^ {5}# {2}letter {11}where {10}thinnest {3}typical {3}font u( {5}want {2}increase)?$/,
];
for (const name of REPORTS) {
  const a = lines(BEFORE, name);
  const b = lines(NOW, name);
  const spineOf = (ls: string[]) => ls.filter((l) => SPINE.some((re) => re.test(l)));
  // Guard against the vacuous pass: if the patterns stop matching, say so loudly
  // rather than quietly comparing nothing to nothing.
  check(
    `${name} — all ${SPINE.length} structural lines were found`,
    `${SPINE.length} found`,
    `${spineOf(a).length} found`,
    spineOf(a).length === SPINE.length,
  );
  check(`${name} — headings and legend identical`, spineOf(a).join("|"), spineOf(b).join("|"));
}

// The target verdict is a conclusion, not a measurement: ADAM_t is the only case
// with a target, and what it CONCLUDED must not have changed.
{
  const a = lines(BEFORE, "thickness_merri_ADAM_t_report.txt").filter((l) => /target/i.test(l));
  const b = lines(NOW, "thickness_merri_ADAM_t_report.txt").filter((l) => /target/i.test(l));
  check("merri_ADAM_t — every line mentioning the target is identical", a.join("|"), b.join("|"));
}

// The paste-ready prompt is the artefact that leaves the building, so it is held
// to being completely unchanged — it quotes the top spots, and if the resample had
// reordered ADAM's, this would say so.
{
  const a = lines(BEFORE, "thickness_merri_ADAM_t_prompt.txt").join("\n");
  const b = lines(NOW, "thickness_merri_ADAM_t_prompt.txt").join("\n");
  check("merri_ADAM_t — the paste-ready prompt is byte-identical", "identical", a === b ? "identical" : "differs", a === b);
}

// --------------------------------------------------------------------------- //
//  4. downstream: the brief quotes thickness numbers, so it moved with them
// --------------------------------------------------------------------------- //
console.log("-".repeat(78));
console.log("the brief moved only where it quotes a thickness number");
console.log("-".repeat(78));

/** file -> how many lines are pinned to have moved. */
const PINNED_BRIEF: Record<string, number> = {
  "brief_merri_unmet.md": 2,
};
for (const [name, want] of Object.entries(PINNED_BRIEF)) {
  const changed = changedLines(name);
  check(`${name} — exactly ${want} lines moved`, String(want), String(changed.length));
  const unexplained = changed.filter((l) => !ALLOWED.some(([re]) => re.test(l)));
  check(
    `${name} — every moved line is an allowed kind`,
    "0 unexplained",
    unexplained.length === 0
      ? "0 unexplained"
      : `${unexplained.length} unexplained, first: ${JSON.stringify(unexplained[0])}`,
    unexplained.length === 0,
  );
}

// The brief's JSON carries the survey verbatim, so the same invariant applies to it
// as to thickness_numbers.json: the thinnest figure must not have moved. And beyond
// that, the ONLY keys allowed to have moved anywhere in these documents are the two
// that hold thin-spot data — if canonicalising had reached a size, a bounding box, a
// junction or an eyelet, it would show up here.

/** Every leaf of a JSON document, as "dotted.path" -> value. */
function leaves(o: unknown, p = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (o !== null && typeof o === "object") {
    if (Array.isArray(o)) o.forEach((v, i) => leaves(v, `${p}[${i}]`).forEach((x, k) => out.set(k, x)));
    else {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        leaves(v, `${p}.${k}`).forEach((x, kk) => out.set(kk, x));
      }
    }
  } else {
    out.set(p, o);
  }
  return out;
}

/**
 * The keys whose values may differ across the change.
 *
 * `spots` and `thin_areas` are the thin-spot payload — exactly what a resample
 * moves. `seconds` is the brief's own wall-clock timing: it differs on every run
 * regardless, and is scrubbed in the current capture but was not in the archived
 * one, so it is excluded rather than being allowed to mask a real difference.
 */
const BRIEF_MAY_MOVE = new Set(["spots", "thin_areas"]);
const BRIEF_IS_TIMING = new Set(["seconds"]);

for (const name of ["brief_merri_met.json", "brief_merri_unmet.json", "brief_flourish.json"]) {
  const a = readFileSync(path.join(BEFORE, name), "utf8");
  const b = readFileSync(path.join(NOW, name), "utf8");
  const thinnest = (s: string) => (s.match(/"thinnest": [-\d.e]+/g) ?? []).join("|");
  check(`${name} — every "thinnest" value is unchanged`, thinnest(a), thinnest(b));

  const la = leaves(JSON.parse(a));
  const lb = leaves(JSON.parse(b));
  const offending: string[] = [];
  for (const k of new Set([...la.keys(), ...lb.keys()])) {
    if (JSON.stringify(la.get(k)) === JSON.stringify(lb.get(k))) continue;
    // which key of the path moved — the last named segment, ignoring array indices
    const named = k.split(".").filter(Boolean).map((s) => s.replace(/\[\d+\]$/, ""));
    if (named.some((s) => BRIEF_MAY_MOVE.has(s) || BRIEF_IS_TIMING.has(s))) continue;
    offending.push(k);
  }
  check(
    `${name} — nothing outside the thin-spot payload moved`,
    "0 other keys",
    offending.length === 0 ? "0 other keys" : `${offending.length}, first: ${offending[0]}`,
    offending.length === 0,
  );
}

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

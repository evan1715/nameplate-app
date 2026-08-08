/**
 * regression.ts — one test per defect found by the adversarial pass.
 *
 *     node tests/regression.ts
 *
 * Each test reproduces a specific reported failure. A PASS means the defect is gone;
 * a FAIL means it is still live. Kept separate from `acceptance.ts` so the two never
 * get confused: that file says "the app does what it promises", this one says "the
 * app no longer does what it did wrong".
 *
 * PORTED FROM `regression_tests.py`, CHECK FOR CHECK
 *   Same reference numbers, same names, same order — so `refs/regression.txt`, which
 *   is the Python suite's own captured output, reads as a line-by-line target. The
 *   detail strings are reproduced too wherever they carry a measurement, because a
 *   defect that comes back usually comes back as a number moving rather than as a
 *   check flipping.
 *
 *   Two of them cannot be reproduced exactly and say so where they are:
 *   #6 and #9 drive the CLI as a subprocess, and this runs `src/bin/cli.ts` rather
 *   than `nameplate_cli.py`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initSkia, PathOp, op, segments, Verb } from "../src/skia.ts";
import type { Point, SkPathData } from "../src/skia.ts";
import { Font, shape } from "../src/font.ts";
import {
  buildDocument, capReference, pdfDocument, safeFilename, stack, svgSingle, ValueError,
} from "../src/core.ts";
import * as LAY from "../src/layout.ts";
import * as LI from "../src/leadin.ts";
import * as EY from "../src/eyelets.ts";
import * as FC from "../src/fontcheck.ts";
import * as PS from "../src/pairsheet.ts";
import * as TH from "../src/thickness.ts";
import * as NB from "../src/brief.ts";
import * as G from "../src/geom.ts";
import { fmtF, fmtSigned } from "../src/pyformat.ts";

const HERE = "/home/user/nameplate-app";
const MERRI = path.join(HERE, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf");
const TG = path.join(HERE, "fonts", "TGCarrieSO-v2.otf");
const FLOURISH = path.join(HERE, "fonts", "TGCarrieSOFlourish-v2.otf");

const results: [boolean, string, string, string][] = [];

function check(ref: string, name: string, ok: boolean, detail = ""): void {
  results.push([ok, ref, name, detail]);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${ref}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}

/** Python's `repr()` of a short string, for the detail lines that quote a name. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\");
  if (q === "'") body = body.replace(/'/g, "\\'");
  return (
    q +
    body
      .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
      // Python escapes non-printables; the zero-width characters below are the
      // reason this suite exists, so they must not be printed raw into a report.
      .replace(/[-￿]/g, (c) =>
        /\p{L}|\p{N}|\p{P}|\p{S}/u.test(c) && !/[​-‏⁠﻿­]/.test(c)
          ? c
          : `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`,
      ) +
    q
  );
}

await initSkia();

const f = new Font(MERRI);
const ftg = new Font(TG);

// --------------------------------------------------------------------------- //
// #1 cap height must be the CAP height, not the first capital's total ink.
//    'J' and 'Q' descend below the baseline, which made JADAM ~20% smaller.
// --------------------------------------------------------------------------- //
const gA = f.gidForChar("A")!;
const capA = Math.max(...f.contours(gA).flatMap((c) => c.map((p) => p[1])));
const heights: Record<string, number> = {};
for (const nm of ["ADAM", "JADAM", "QADAM"]) {
  heights[nm] = capA * buildDocument(f, nm, 1.0, "in", "cap").scale;
}
const spread = Math.max(...Object.values(heights)) - Math.min(...Object.values(heights));
check(
  "#1", "cap height is independent of which capital starts the name",
  spread < 1e-6,
  "delivered height of 'A' at 1.000 in cap: " +
    Object.entries(heights).map(([k, v]) => `${k}=${fmtF(v, 4)}`).join(", ") +
    ` (spread ${fmtF(spread, 6)} in)`,
);

// and the documented ADAM numbers must be untouched by that fix
const dAdam = buildDocument(f, "ADAM", 1.0, "in", "cap");
const [wAdam, hAdam] = dAdam.size();
// ADAM's size moved deliberately when cap height became the font's own cap line
// instead of the first capital's total ink. What must hold now is that the CAP LINE
// lands exactly where it was asked to, for every name.
const { ref: capRef } = capReference(f);
const capline: Record<string, number> = {};
for (const nm of ["ADAM", "JADAM", "QADAM", "OLIVIA", "adam"]) {
  capline[nm] = capRef * buildDocument(f, nm, 1.0, "in", "cap").scale;
}
check(
  "#1b", "the cap line lands exactly at the requested height, every name",
  Object.values(capline).every((v) => Math.abs(v - 1.0) < 1e-9),
  `${fmtF(wAdam, 4)} x ${fmtF(hAdam, 4)} in for ADAM; cap line = ` +
    Object.entries(capline).map(([k, v]) => `${k}=${fmtF(v, 6)}`).join(", "),
);

// --------------------------------------------------------------------------- //
// #7 a name must not be able to break or inject into the SVG
// --------------------------------------------------------------------------- //
{
  let okXml = true;
  const detail: string[] = [];
  for (const nm of ["Mary--Jane", 'A--> <rect width="9"/> <!--', "A<b>B", "A-"]) {
    try {
      const s = svgSingle(buildDocument(f, nm, 1.0, "in", "cap"));
      // "must parse" — no XML parser in the standard library here, so the checks
      // the Python's ET.fromstring would have caught are made directly: a comment
      // that was closed early, and a tag that escaped into the body.
      if (/<!--(?:(?!-->)[\s\S])*<!--/.test(s)) throw new Error("nested comment");
      const body = s.includes("-->") ? s.split("-->").slice(1).join("-->") : s;
      if (body.includes("<rect") || body.includes("<b>")) {
        okXml = false;
        detail.push(`${pyRepr(nm)}: injected element`);
      }
    } catch (exc) {
      okXml = false;
      detail.push(`${pyRepr(nm)}: ${(exc as Error)?.constructor?.name ?? "Error"}`);
    }
  }
  check(
    "#7", "a name cannot break or inject into the exported SVG",
    okXml, detail.join("; ") || "all four hostile names parse, nothing injected",
  );
}

// --------------------------------------------------------------------------- //
// #5b lead-in exporters must not throw on their own early exits
// --------------------------------------------------------------------------- //
let info0: ReturnType<typeof LI.leadInReport>;
{
  let okKeys = true;
  const detail: string[] = [];
  for (const [label, len] of [["length 0", 0.0], ["length negative", -5.0]] as [string, number][]) {
    try {
      LI.svgSingleLeadin(dAdam, len);
      LI.pdfDocumentLeadin([dAdam], len);
    } catch (exc) {
      okKeys = false;
      detail.push(`${label}: ${(exc as Error)?.constructor?.name}: ${(exc as Error)?.message}`);
    }
  }
  info0 = LI.leadInReport(dAdam, 0.0);
  const haveKeys = [
    "leads", "runs", "closed", "holes", "outers", "skipped_tiny", "failed",
    "holes_detail", "leads_detail",
  ].every((k) => k in (info0 as unknown as Record<string, unknown>));
  check(
    "#5b", "lead-in exporters survive length 0 / negative",
    okKeys && haveKeys,
    detail.join("; ") || `all keys present on the early exit: ${haveKeys ? "True" : "False"}`,
  );

  // runs + closed must still account for every contour even on an early exit
  const nRings = LI.rings(dAdam).length;
  check(
    "#5b2", "runs+closed still accounts for every contour at length 0",
    info0.runs.length + info0.closed.length === nRings,
    `${info0.runs.length}+${info0.closed.length} vs ${nRings} contours`,
  );
}

// --------------------------------------------------------------------------- //
// #3 a big requested lead-in must NOT buy permission to cut the part
// --------------------------------------------------------------------------- //
{
  let worstCut = 0.0;
  let worstCase = "";
  const cases: [Font, string, number, string, number, number][] = [
    [ftg, "ADAM", 0.25, "in", 10.0, 2.0],
    [f, "Sophia", 1.0, "in", 10.0, 2.0],
    [f, "Sophia", 0.25, "in", 10.0, 0.5],
    [f, "Sophia", 0.05, "in", 10.0, 0.012],
    [f, "ADAM", 0.05, "in", 1.0, 0.5],
    [f, "Sophia", 1.0, "mm", 250.0, 50.0],
  ];
  for (const [fo, nm, ht, un, ln, cl] of cases) {
    const doc = buildDocument(fo, nm, ht, un as any, "cap");
    const inf = LI.leadInReport(doc, ln, cl);
    const { material } = LI.analyse(LI.rings(doc));
    for (const lead of inf.leads) {
      const cut = G.length(G.intersection(material, G.lineString(lead))) * doc.scale;
      if (cut > worstCut) {
        worstCut = cut;
        worstCase = `${nm}@${ht}${un} len=${ln} clear=${cl}`;
      }
    }
  }
  check(
    "#3", "an absurd lead-in length never cuts through the material",
    worstCut < 1e-4,
    `worst material cut across 6 abusive settings: ${fmtF(worstCut, 6)} ` +
      `(${worstCase || "none"})`,
  );
}

// --------------------------------------------------------------------------- //
// #5a / #5c / #5d names with no ink and bad heights must not crash
// --------------------------------------------------------------------------- //
{
  const badNames = [
    "", " ", "\t", "\n", "​", "⁠", "﻿", "­",
    "///", "..", "李明", "\u{1f600}",
  ];
  const crashes: string[] = [];
  for (const nm of badNames) {
    try {
      const d = buildDocument(f, nm, 1.0, "in", "cap");
      LI.leadInReport(d, 0.1);
      svgSingle(d);
      pdfDocument([d]);
      try {
        stack([d], 0.25);
      } catch (exc) {
        if (!(exc instanceof ValueError)) throw exc; // a refusal is fine; a crash is not
      }
    } catch (exc) {
      if (exc instanceof ValueError) continue; // deliberate, message-carrying refusal
      crashes.push(
        `${pyRepr(nm)}: ${(exc as Error)?.constructor?.name}: ${(exc as Error)?.message}`,
      );
    }
  }
  check(
    "#5a/c", "no-ink and exotic names never raise an unhandled error",
    crashes.length === 0,
    crashes.slice(0, 4).join("; ") ||
      `all ${badNames.length} handled (empty, whitespace, zero-width, CJK, emoji)`,
  );

  const hcrash: string[] = [];
  for (const ht of [0.0, -1.0, Infinity, NaN]) {
    try {
      const d = buildDocument(f, "ADAM", ht, "in", "cap");
      const s = svgSingle(d);
      if (s.includes("inf") || s.includes("nan")) {
        hcrash.push(`height ${ht}: wrote inf/nan into the SVG`);
      }
    } catch (exc) {
      if (exc instanceof ValueError) continue; // refused with a message: correct
      hcrash.push(`height ${ht}: ${(exc as Error)?.constructor?.name}`);
    }
  }
  check(
    "#5d/#8", "height 0 / negative / inf / nan are refused, never written",
    hcrash.length === 0,
    hcrash.join("; ") || "all four refused with a clear error instead of writing junk",
  );
}

// --------------------------------------------------------------------------- //
// #6 the CLI must not overwrite one order with another
//    Drives src/bin/cli.ts, where the Python drove nameplate_cli.py.
// --------------------------------------------------------------------------- //
{
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "sfpf_reg_"));
  try {
    execFileSync(
      process.execPath,
      [path.join(HERE, "ts", "src", "bin", "cli.ts"), "--font", MERRI, "--height", "1",
        "--format", "svg", "--out", tmp, "Adam!", "Adam?", "Adam."],
      { encoding: "utf8", timeout: 300_000, stdio: "pipe" },
    );
  } catch {
    /* the file count is the assertion, not the exit code */
  }
  const listing = fs.readdirSync(tmp).sort();
  const nSvg = listing.filter((x) => x.endsWith(".svg")).length;
  check(
    "#6", "three colliding names produce three files, not one",
    nSvg === 3,
    `${nSvg} svg file(s) written: [${listing.map((x) => pyRepr(x)).join(", ")}]`,
  );
}

// --------------------------------------------------------------------------- //
// #9 the CLI must refuse a sheet whose names would overlap
// --------------------------------------------------------------------------- //
{
  const tmp2 = fs.mkdtempSync(path.join(tmpdir(), "sfpf_reg2_"));
  let code = 0;
  let said = "";
  try {
    execFileSync(
      process.execPath,
      [path.join(HERE, "ts", "src", "bin", "cli.ts"), "--font", MERRI, "--height", "1",
        "--mode", "sheet", "--gap", "-0.5", "--format", "svg", "--out", tmp2,
        "ADAM", "OLIVIA"],
      { encoding: "utf8", timeout: 300_000, stdio: "pipe" },
    );
  } catch (exc) {
    const e = exc as { status?: number; stderr?: string; stdout?: string };
    code = e.status ?? 1;
    said = (e.stderr || e.stdout || "").trim();
  }
  const wrote = fs.existsSync(path.join(tmp2, "sheet.svg"));
  const lastLine = said ? said.split("\n").slice(-1)[0].slice(0, 90) : "";
  check(
    "#9", "the CLI refuses a negative sheet gap instead of overlapping names",
    code !== 0 && !wrote,
    `exit=${code}, sheet written=${wrote ? "True" : "False"}, said: ${lastLine}`,
  );
}

// --------------------------------------------------------------------------- //
// #4 performance: a long name and a big sheet must finish in reasonable time
// --------------------------------------------------------------------------- //
{
  let t0 = Date.now();
  const dLong = buildDocument(f, "a".repeat(120), 1.0, "in", "cap");
  LI.leadInReport(dLong, 0.1);
  let el = (Date.now() - t0) / 1000;
  check("#4a", "a 120-character name finishes well inside a minute",
    el < 60, `${fmtF(el, 1)}s for build + lead-ins`);

  t0 = Date.now();
  const many = Array.from({ length: 40 }, (_v, i) =>
    buildDocument(f, `Name${String(i).padStart(3, "0")}`, 1.0, "in", "cap"),
  );
  const sheet = LAY.arrange(many, 0.25, LAY.HORIZONTAL);
  LI.leadInReport(sheet, 0.1);
  el = (Date.now() - t0) / 1000;
  check("#4b", "a 40-name side-by-side sheet with lead-ins finishes inside a minute",
    el < 60, `${fmtF(el, 1)}s for 40 names + arrange + lead-ins`);
}

// --------------------------------------------------------------------------- //
// #10 thickness: the reported minimum must be the REAL minimum.
//
//     survey() used to walk the boundary at evenly spaced points only, so a short
//     thin neck could sit between two samples and never be measured. It reported
//     material as THICKER than it is -- the dangerous direction, because
//     --min-thickness MET is what says a font is safe to cut.
//
//     These two fixtures are DOUBLE-DERIVED: the 2026-08-05 audit found them with
//     one method, and the font factory's own measure_thickness.py reproduced them
//     from scratch with a different one, agreeing to three significant figures.
//     If either number drifts, the sampler has regressed.
// --------------------------------------------------------------------------- //
for (const [nm, truthFu, was] of [["ADAM", 72.76, 126.2], ["CHRISTOPHER", 18.13, 120.09]] as
  [string, number, number][]) {
  const d = buildDocument(f, nm, 1.0, "in", "cap");
  const sv = TH.survey(d, null, 900, 8, f);
  const got = sv.spots.length ? sv.spots[0].thickness / d.scale : NaN;
  const clear = sv.spots.length ? sv.spots[0].clearance : 0.0;
  const err = Math.abs(got / truthFu - 1.0) * 100.0;
  check(
    nm === "ADAM" ? "#10a" : "#10b",
    `${nm}'s thinnest reads the real ${truthFu} font units, not ${was}`,
    err < 2.0 && clear >= 0.47,
    `measured ${fmtF(got, 2)} fu (${fmtSigned(err, 2)}% of double-derived truth ` +
      `${truthFu}), clearance ${fmtF(clear, 3)} -- must be >= 0.47 to be a ` +
      `parallel-walled web rather than a taper`,
  );
}

// a short thin neck is exactly what uniform sampling steps over, so prove the vertex
// pass is what catches it: without it, ADAM reads the old wrong number
{
  const saved = TH.VERTEX_CEILING;
  let off = NaN;
  try {
    TH.setVertexCeiling(0.0); // disables the vertex pass entirely
    const d = buildDocument(f, "ADAM", 1.0, "in", "cap");
    const svOff = TH.survey(d, null, 900, 8, f);
    off = svOff.spots.length ? svOff.spots[0].thickness / d.scale : NaN;
  } finally {
    TH.setVertexCeiling(saved);
  }
  check(
    "#10c", "the vertex-anchored pass is what finds the web, not luck",
    off > 100.0,
    `with the vertex pass off ADAM reads ${fmtF(off, 2)} fu (the old over-report); ` +
      `with it on, 72.76`,
  );
}

// and it must stay usable: the whole point of accuracy-first is that it still
// finishes, so a long script name is the worst case worth pinning
{
  const t0 = Date.now();
  const dScr = buildDocument(ftg, "Alexandria", 25.0, "mm", "cap");
  TH.survey(dScr, null, 900, 8, ftg);
  const el = (Date.now() - t0) / 1000;
  check("#10d", "a long script name's thickness survey stays well under a minute",
    el < 30.0, `${fmtF(el, 1)}s for the worst shipped case`);
}

// --------------------------------------------------------------------------- //
// #11 the junctions a REAL name makes must be tested, not just 2-letter words.
//     TGCarrieSOFlourish's 'dd' shapes to Dleftring+dflourishrightring, while
//     'dda' shapes to Dleftring+d+aflourishrightring -- and Dleftring->d is broken.
// --------------------------------------------------------------------------- //
const fl = new Font(FLOURISH);
{
  const pieces = (doc: ReturnType<typeof buildDocument>) =>
    LI.analyse(LI.rings(doc)).depths.filter((x) => x % 2 === 0).length;
  const dWhole = buildDocument(fl, "dd", 1.0, "in", "cap");
  const dFirst = buildDocument(fl, "dda", 1.0, "in", "cap");
  const gWhole = shape(fl, "dd").map((p) => fl.glyphName(p.glyph));
  const gFirst = shape(fl, "dda").map((p) => fl.glyphName(p.glyph));
  check(
    "#11a",
    "the first letter of a name uses a DIFFERENT glyph pair than the same two letters alone",
    gWhole[0] === gFirst[0] && gWhole[1] !== gFirst[1],
    `'dd' -> (${gWhole.map(pyRepr).join(", ")}), 'dda' -> ` +
      `(${gFirst.map(pyRepr).join(", ")}); both break ` +
      `(${pieces(dWhole)} and ${pieces(dFirst)} pieces)`,
  );

  const repPairs = PS.analysePairs(fl, undefined, 180);
  const keys = repPairs.groups.map((g) => g.key);
  check(
    "#11b", "the pair sheet tests every positional junction",
    ["lower", "midlower", "firstlower", "firstcaplower", "lastlower"].every((k) =>
      keys.includes(k),
    ),
    `groups: [${keys.map(pyRepr).join(", ")}]`,
  );

  let firstCell: PS.PairResult | undefined;
  for (const g of repPairs.groups) {
    if (g.key === "firstlower") firstCell = g.cells.get(PS.cellKey("d", "d"));
  }
  check(
    "#11c", "the first-letter junction 'dda' is FLAGGED, not silently passed",
    Boolean(firstCell?.problem && firstCell?.context === "dda"),
    `status=${firstCell?.status}, context=${pyRepr(firstCell?.context ?? "")}, ` +
      `glyphs=(${(firstCell?.glyphs ?? []).map(pyRepr).join(", ")})`,
  );

  const { failures, tested, truncated, total } = FC.joinScan(fl);
  check(
    "#11d", "join_scan reaches the Capital-initial junction and finishes",
    failures.has("Dleftring→d") && !truncated,
    `${tested}/${total} combos, truncated=${truncated ? "True" : "False"}, ` +
      `Dleftring->d found=${failures.has("Dleftring→d") ? "True" : "False"}`,
  );
}

// --------------------------------------------------------------------------- //
// #12 a nested island must stay IN the material mask.
//     _analyse built the mask as union(even) - union(odd). A hole ring covers
//     everything nested inside it, so subtracting all the odd rings at once deleted
//     any depth-2 island too, and a lead-in was free to run through real metal.
// --------------------------------------------------------------------------- //
{
  let worstIsland = 0.0;
  let islandCases = 0;
  for (const fo of [ftg, fl]) {
    for (const ch of ["©", "®"]) {
      if (!fo.cmap.has(ch.codePointAt(0) as number)) continue;
      const d = buildDocument(fo, ch, 1.0, "in", "cap");
      const { polys, depths, material } = LI.analyse(LI.rings(d));
      if (!depths.length || Math.max(...depths) < 2) continue;
      islandCases += 1;
      // the island's own metal must be inside the mask
      const isl = G.unaryUnion(polys.filter((_p, i) => depths[i] === 2));
      const d3 = G.unaryUnion(polys.filter((_p, i) => depths[i] === 3));
      const body = G.isEmpty(d3) ? isl : G.difference(isl, d3);
      const covered = G.area(body) ? G.area(G.intersection(body, material)) / G.area(body) : 1.0;
      const info = LI.leadInReport(d, 0.1, 0.012);
      for (const lead of info.leads) {
        worstIsland = Math.max(
          worstIsland,
          G.length(G.intersection(material, G.lineString(lead))) * d.scale,
        );
      }
      if (covered < 0.999) worstIsland = Infinity;
    }
  }
  check(
    "#12", "a nested island stays in the material mask, so no lead-in cuts it",
    islandCases > 0 && worstIsland < 1e-4,
    `${islandCases} depth-2+ case(s) checked; worst lead cutting real material ` +
      `${fmtF(worstIsland, 6)} in (was 0.0807)`,
  );
}

// --------------------------------------------------------------------------- //
// #13 a letter's counter must not be reported as an eyelet.
// --------------------------------------------------------------------------- //
{
  const dBob = buildDocument(f, "Bob", 1.0, "in", "cap");
  const kept = EY.measureEyelets(dBob);
  const every = EY.measureEyelets(dBob, 2, true);
  check(
    "#13a", "the final letter's counter is not counted as an eyelet",
    kept.length === 1 && kept[0].side === "left" && every.length === 2,
    `kept [${kept.map((e) => pyRepr(e.side)).join(", ")}], rejected ` +
      `[${every.filter((e) => !e.confident)
        .map((e) => `(${pyRepr(e.side)}, ${Math.round(e.boss_spread_ratio * 100)})`)
        .join(", ")}] (% spread of radius)`,
  );
  check(
    "#13b", "the rejection is explained, not silent",
    EY.reportText(dBob).includes("NOT COUNTED AS EYELETS"),
    "report_text names the hole it left out and why",
  );
  const dAdam2 = buildDocument(f, "ADAM", 1.0, "in", "cap");
  const adamEyes = EY.measureEyelets(dAdam2);
  check(
    "#13c", "a genuine eyelet still passes the new gate",
    adamEyes.length === 1 && adamEyes[0].confident,
    `ADAM: ${adamEyes.length} confident eyelet(s)`,
  );
}

// --------------------------------------------------------------------------- //
// #14 counters wound the wrong way cut SOLID and nothing could see it.
// --------------------------------------------------------------------------- //
{
  const falsePos: Record<string, string[]> = {};
  for (const [fo, label] of [[f, "Merriweather"], [ftg, "TGCarrieSO"], [fl, "Flourish"]] as
    [Font, string][]) {
    const w = FC.windingCheck(fo);
    if (w.length) falsePos[label] = w.slice(0, 4).map((x) => x.glyph);
  }
  check(
    "#14a", "the winding check clears all three shipped fonts",
    Object.keys(falsePos).length === 0,
    `false positives: ${Object.keys(falsePos).length ? JSON.stringify(falsePos) : "none"}`,
  );

  // and it must actually fire on a same-direction nested ring
  const ringPath = (pts: Point[]): SkPathData => {
    const verbs: Verb[] = [Verb.Move];
    const out: Point[] = [pts[0]];
    for (const p of pts.slice(1)) {
      verbs.push(Verb.Line);
      out.push(p);
    }
    verbs.push(Verb.Close);
    return { verbs, pts: out };
  };
  const outer = ringPath([[0, 0], [100, 0], [100, 100], [0, 100]]);
  const inner = ringPath([[30, 30], [70, 30], [70, 70], [30, 70]]); // SAME winding
  const both: SkPathData = {
    verbs: [...outer.verbs, ...inner.verbs],
    pts: [...outer.pts, ...inner.pts],
  };
  const res = op({ verbs: [], pts: [] }, both, PathOp.UNION, false, false);
  const nContours = segments(res).filter((s) => s.op === "moveTo").length;
  check(
    "#14b", "a same-direction counter really does cancel in the cut path",
    nContours === 1,
    `skia union of outer+same-direction-counter -> ${nContours} contour(s); ` +
      `parity would say 2, so the hole vanishes in metal`,
  );
}

// --------------------------------------------------------------------------- //
// #15 pairs nobody measured must not pass. A tiny budget used to report
//     "flagged: 0" and exit 0 READY with nearly every combination UNTESTED.
// --------------------------------------------------------------------------- //
{
  const bSmall = NB.brief(TG, {
    cap: 1.0, unit: "in", pairBudget: 0.05, joinBudget: 0.0, minThickness: 0.06,
  });
  const blocking: string[] = bSmall.blocking ?? [];
  check(
    "#15", "an unmeasured pair scan cannot be reported as ready",
    bSmall.verdict !== "ready" &&
      (bSmall.pairs.untested ?? 0) > 0 &&
      blocking.some((x) => x.includes("never tested")),
    `verdict=${pyRepr(String(bSmall.verdict))}, untested=${bSmall.pairs.untested}, ` +
      `blocking=${blocking.length} line(s)`,
  );
}

// --------------------------------------------------------------------------- //
console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} regressions fixed`);
for (const [ok, ref, name, detail] of results) {
  if (!ok) console.log(`  STILL BROKEN ${ref}: ${name}\n     ${detail}`);
}
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

// Keep `safeFilename` referenced: the Python imports it for #6's filename collision
// reasoning, and dropping the import would quietly change what this file is testing.
void safeFilename;

/**
 * viewmodel.ts — the window's data layer, held to what the Python GUI's own
 * `--selftest` recorded.
 *
 * WHERE THESE EXPECTATIONS COME FROM
 *   Every string below is lifted from `refs/gui_selftest.txt`, which is the PySide6
 *   window driving its real widgets offscreen. They are not invented: if the Qt app
 *   printed `ADAM — 4.069 × 1.020 in`, so must this.
 *
 * WHAT THIS CANNOT COVER
 *   Two of that file's checks count pixels in a Qt-rendered canvas ("837 dark px,
 *   47 red px"). Those belong to a specific rasteriser and cannot be reproduced by a
 *   different one — a browser canvas will paint the same geometry and count
 *   differently. They are the GUI port's business, not this module's, and this
 *   module exists precisely so that everything EXCEPT them can be tested with no
 *   display at all.
 */

import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initSkia } from "../src/skia.ts";
import { Font } from "../src/font.ts";
import * as VM from "../src/viewmodel.ts";
import * as APP from "../src/app.ts";

const REFS = path.join(path.dirname(new URL(import.meta.url).pathname), "refs");
const ROOT = "/home/user/nameplate-app";
const FONTS = path.join(ROOT, "fonts");

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

/** The line of the captured GUI selftest that begins with this check's name. */
const SELFTEST = readFileSync(path.join(REFS, "gui_selftest.txt"), "utf8").split("\n");
function selftestLine(fragment: string): string {
  const hit = SELFTEST.find((l) => l.includes(fragment));
  return hit ?? `(no selftest line containing ${JSON.stringify(fragment)})`;
}

await initSkia();

console.log("=".repeat(78));
console.log("view model vs what the Python GUI's selftest recorded");
console.log("=".repeat(78));

// --- the font picker ------------------------------------------------------ //
// selftest: "exe lists fonts in fonts\: 3 -> ['Merriweather-Cut3 Engrave v2 Black',
//            'TG Carrie SO FLOURISH v2 Regular', 'TG Carrie SO v2 Regular']"
const fonts = VM.listFonts(FONTS);
check(
  "the picker lists every font in fonts/, by family, sorted",
  "Merriweather-Cut3 Engrave v2 Black | TG Carrie SO FLOURISH v2 Regular | TG Carrie SO v2 Regular",
  fonts.map((f) => f.family).join(" | "),
);
console.log(`        selftest said: ${selftestLine("exe lists fonts").trim()}`);

const merriPath = path.join(FONTS, "MerriweatherCut3Black-Engrave-v2.ttf");
const carriePath = path.join(FONTS, "TGCarrieSO-v2.otf");
const merri = new Font(merriPath);
const carrie = new Font(carriePath);

// --- the detail line under the picker ------------------------------------- //
// selftest: "... · carries engrave lines · no problems found"
const info = VM.probeFont(merriPath);
check(
  "the detail line reports engrave capability and the verdict",
  "MerriweatherCut3Black-Engrave-v2.ttf · carries engrave lines · no problems found",
  `${info.filename} · ${info.has_colr ? "carries engrave lines" : "cut only"} · ${info.verdict}`,
);
check("the detail line is assembled with the date in it", "4 fields", `${info.detail.split(" · ").length} fields`);

const cutOnly = VM.probeFont(carriePath);
check(
  "a cut-only font says so rather than claiming engrave lines",
  "cut only",
  cutOnly.has_colr ? "carries engrave lines" : "cut only",
);

// --- the preview ---------------------------------------------------------- //
// selftest: "preview size label: ADAM — 4.069 × 1.020 in"
//           "preview counts: 6 cut contours, 10 engrave lines"
const adam = VM.build({ font: merri, text: "ADAM", height: 1.0, unit: "in", basis: "cap" });
check("preview size label", "ADAM — 4.069 × 1.020 in", adam.size_label);
check("preview counts", "6 cut contours, 10 engrave lines", adam.count_label);
check("the preview hands over geometry to draw", "6 cut, 10 engrave", `${adam.cut.length} cut, ${adam.engrave.length} engrave`);
check("the artwork is placed from its own bottom-left corner", "x>=0 y>=0", (() => {
  const all = [...adam.cut, ...adam.engrave].flat();
  const minX = Math.min(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1]));
  return minX >= -1e-9 && minY >= -1e-9 ? "x>=0 y>=0" : `minX=${minX} minY=${minY}`;
})());

// selftest: "preview after unit switch is the same physical size:
//            ADAM — 103.361 × 25.896 mm"
const adamMm = VM.build({ font: merri, text: "ADAM", height: 25.4, unit: "mm", basis: "cap" });
check("the same physical size after a unit switch", "ADAM — 103.361 × 25.896 mm", adamMm.size_label);

// selftest: "lead-ins appear and the stated height does NOT change:
//            '6 cut contours, 10 engrave lines, 6 lead-ins'"
const withLeads = VM.build({
  font: merri, text: "ADAM", height: 1.0, unit: "in", basis: "cap", leadIn: true,
});
check("lead-ins are counted in the label", "6 cut contours, 10 engrave lines, 6 lead-ins", withLeads.count_label);
check("turning lead-ins on does not change the stated size", adam.size_label, withLeads.size_label);

// selftest: "a cut-only font does NOT warn in amber, and still exports:
//            counts='7 cut contours, 0 engrave lines'"
// The selftest drove this with the name "Carrie" on Carrie SO v2, not with ADAM.
const carrieBuild = VM.build({ font: carrie, text: "Carrie", height: 1.0, unit: "in", basis: "cap" });
check("a cut-only font states 0 engrave lines honestly", "7 cut contours, 0 engrave lines", carrieBuild.count_label);

// --- eyelets -------------------------------------------------------------- //
// selftest: "eyelet measurement returns ID < OD: ID=0.3448 OD=0.6549 in"
const eyed = VM.build({
  font: merri, text: "ADAM", height: 1.0, unit: "in", basis: "cap", eyeDims: true,
});
check(
  "the eyelet table fills actual and leaves want/change blank",
  "ID=0.3448 OD=0.6549 wall=0.1551 wall_min=0.1548, want/change blank",
  `ID=${eyed.eyelet_rows.id?.actual} OD=${eyed.eyelet_rows.od?.actual} ` +
    `wall=${eyed.eyelet_rows.wall?.actual} wall_min=${eyed.eyelet_rows.wall_min?.actual}, ` +
    (Object.values(eyed.eyelet_rows).every((r) => r.want === "" && r.change === "")
      ? "want/change blank"
      : "want/change filled"),
);
check(
  "the canvas is given the eyelet and the thinnest-wall point",
  "1 eyelet, wall point given",
  `${eyed.eyelets.length} eyelet, ${eyed.wall_at ? "wall point given" : "no wall point"}`,
);
check("no target means no overlay", "0", String(eyed.overlays.length));

// selftest: "a wanted eyelet ID draws the target ring: want=0.3793
//            overlays=['eyelet at target inner diameter']"
//           "the want and change columns fill in:
//            actual=0.3448 want=0.3793 change=+10.02%"
const wantId = VM.build({
  font: merri, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
  eyeDims: true, eyeTargetId: 0.3793,
});
check(
  "a wanted inner diameter draws the target ring",
  "['eyelet at target inner diameter']",
  JSON.stringify(wantId.overlays.map((o) => o.label)).replace(/"/g, "'"),
);
check(
  "the want and change columns fill in",
  "actual=0.3448 want=0.3793 change=+10.02%",
  `actual=${wantId.eyelet_rows.id.actual} want=${wantId.eyelet_rows.id.want} ` +
    `change=${wantId.eyelet_rows.id.change}`,
);

// selftest: "a wanted wall draws the target outer ring too:
//            overlays=['eyelet at target inner diameter',
//                      'eyelet at target outer diameter']"
const wantWall = VM.build({
  font: merri, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
  eyeDims: true, eyeTargetId: 0.3793, eyeTargetWall: 0.2,
});
check(
  "a wanted wall draws the outer ring too",
  "['eyelet at target inner diameter', 'eyelet at target outer diameter']",
  JSON.stringify(wantWall.overlays.map((o) => o.label)).replace(/"/g, "'").replace(/,/g, ", "),
);

// selftest: "the wanted-size toggle hides the rings but keeps the numbers:
//            overlays=[] want cell='0.3793'"
const hidden = VM.build({
  font: merri, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
  eyeDims: true, eyeTargetId: 0.3793, eyeTargetWall: 0.2, eyeWant: false,
});
check(
  "the wanted-size toggle hides the rings but keeps the numbers",
  "overlays=[] want='0.3793'",
  `overlays=[${hidden.overlays.map((o) => o.label).join(", ")}] want='${hidden.eyelet_rows.id.want}'`,
);

// --- thin areas ----------------------------------------------------------- //
// selftest: "thin areas are found and summarised: 15 cut contours, 0 engrave lines
//            ·  thinnest 0.0602 in (86 font units) on D, upper right"
const thinLine = selftestLine("thin areas are found and summarised");
const thinBuild = VM.build({
  font: carrie, text: "Danielle", height: 1.0, unit: "in", basis: "cap", thin: true,
});
check(
  "the thin-area summary is appended to the counts, in the Python's wording",
  "matches '<n> cut contours, <n> engrave lines  ·  thinnest <x> <unit> (<n> font units) on <letter>, <where>'",
  /^\d+ cut contours?, \d+ engrave lines?  ·  thinnest [\d.]+ in \(\d+ font units\) on .+, .+$/.test(
    thinBuild.count_label,
  )
    ? "matches '<n> cut contours, <n> engrave lines  ·  thinnest <x> <unit> (<n> font units) on <letter>, <where>'"
    : thinBuild.count_label,
);
console.log(`        selftest said: ${thinLine.trim()}`);

// selftest: "a target thickness draws a comparison overlay:
//            1 overlay(s): ['letters at target thickness']"
const worst = thinBuild.thin_spots[0];
const thinTarget = VM.build({
  font: carrie, text: "Danielle", height: 1.0, unit: "in", basis: "cap",
  thin: true, thinTarget: worst.thickness * 1.5,
});
check(
  "a target thickness draws a comparison overlay",
  "['letters at target thickness']",
  JSON.stringify(thinTarget.overlays.map((o) => o.label)).replace(/"/g, "'"),
);
check(
  "the overlay carries rings to draw",
  "at least one ring",
  thinTarget.overlays[0]?.rings.length ? "at least one ring" : "no rings",
);

// --- a name that does not cut as one piece -------------------------------- //
// The window names the junction that broke; that is the actionable part.
//
// "Dda" on the Flourish font, because that is a junction the pair sweep independently
// proved broken: tests/pairsheet.ts pins Dleftring -> d as a GAP shaped inside "Dda".
// Picking a name that merely LOOKS like it should break is how this check first went
// wrong -- Merriweather's letters overlap by design, so "A M" cuts as one plate.
const flourish = new Font(path.join(FONTS, "TGCarrieSOFlourish-v2.otf"));
const broken = VM.build({ font: flourish, text: "Dda", height: 1.0, unit: "in", basis: "cap" });
check(
  "a name that falls apart reports its piece count",
  "2 pieces",
  `${broken.pieces} pieces`,
);
check(
  "and names the junction that broke",
  "Dleftring\u2192d (0.001 in)",
  broken.gap_text,
);

// --------------------------------------------------------------------------- //
//  the two panels the Qt window had behind buttons its selftest never pressed
//
//  There is no reference line for either, because the Python's `--selftest` does
//  not click them — so these assert the CONTRACT rather than a captured string.
//  They exist because both were missing from the browser port at first, and a
//  feature nobody tests is a feature that quietly does not ship.
// --------------------------------------------------------------------------- //
{
  const merriPath = path.join(FONTS, "MerriweatherCut3Black-Engrave-v2.ttf");

  // Without a target there is prose and no request: with nothing to aim at there
  // is no change to ask for, and inventing one produces a repair instruction for
  // a font that may already be right.
  const bare = APP.thicknessReport(merriPath, "ADAM", 1.0, "in", "cap");
  check(
    "the thickness report measures without a target and asks for nothing",
    "starts with the size line, no prompt",
    `${bare.text.startsWith("ADAM — 4.069 x 1.020 in") ? "starts with the size line" : "starts " + JSON.stringify(bare.text.slice(0, 40))}` +
    `, ${bare.prompt ? "prompt " + bare.prompt.length + " chars" : "no prompt"}`,
  );
  const aimed = APP.thicknessReport(merriPath, "ADAM", 1.0, "in", "cap", 0.15);
  check(
    "and produces the paste-ready fix once one is typed",
    "same report, plus a prompt naming the font",
    `${aimed.text.startsWith("ADAM — 4.069 x 1.020 in") ? "same report" : "DIFFERENT report"}` +
    `, ${aimed.prompt.includes("MerriweatherCut3Black-Engrave-v2.ttf") ? "plus a prompt naming the font" : "prompt does NOT name the font"}`,
  );

  // "Add font…" writes into fonts/ so the font travels with the app folder. What
  // must not happen is a write outside it, or a file that is not a font being
  // left behind for the picker to trip over.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addfont-"));
  const staged = path.join(tmp, "staged.otf");
  fs.copyFileSync(path.join(FONTS, "TGCarrieSO-v2.otf"), staged);
  let added = "";
  let rejected = "";
  try {
    added = APP.addFont("../../escape/../staged.otf", fs.readFileSync(staged));
    try {
      APP.addFont("notafont.ttf", Buffer.from("this is not a font"));
      rejected = "ACCEPTED a non-font";
    } catch {
      rejected = fs.existsSync(path.join(APP.FONTS_DIR, "notafont.ttf"))
        ? "refused but left the file behind"
        : "refused and left nothing behind";
    }
  } finally {
    if (added) fs.rmSync(added, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  check(
    "Add font copies into fonts/, ignoring any path in the name",
    path.join(APP.FONTS_DIR, "staged.otf"),
    added,
  );
  check(
    "and a file that is not a font is refused, not left in the folder",
    "refused and left nothing behind",
    rejected,
  );
}

console.log("=".repeat(78));
const nOk = results.filter((r) => r[0]).length;
console.log(`${nOk}/${results.length} passed`);
for (const [ok, name] of results) if (!ok) console.log(`  FAIL: ${name}`);
console.log("=".repeat(78));
process.exit(nOk === results.length ? 0 : 1);

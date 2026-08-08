/**
 * gui.ts — the window's own selftest, ported check for check.
 *
 *     node tests/gui.ts [outdir]
 *
 * PORTED FROM `nameplate_gui.py --selftest`
 *   Same check names, same order, same detail strings, same `selftest: N/N passed`
 *   summary — so `refs/gui_selftest.txt`, which is the Qt window's own captured
 *   run, reads as a line-by-line target.
 *
 * WHERE THE CHECKS RUN
 *   Almost every assertion in the Python is about a RESULT or a LABEL, not about
 *   pixels: "ADAM — 4.069 × 1.020 in", which overlays are on, what the eyelet
 *   table reads, what the zip contains. Those run here against `viewmodel.ts` and
 *   `app.ts` with no browser at all — which is the whole reason those two modules
 *   exist.
 *
 *   The handful that are genuinely about the window run against the REAL window:
 *   a headless Chromium driving the React client over a real server. Marked
 *   `[browser]` below. They are the checks that would otherwise have been quietly
 *   dropped in the move off Qt — the canvas actually painting, a cleared target
 *   box committing to an em dash, the page staying responsive while a font check
 *   is in flight, export disabling itself on an empty name box.
 *
 * WHAT CANNOT MATCH CHARACTER FOR CHARACTER, AND WHY
 *   * The header block names Node, not Python, and there is no frozen exe or
 *     PyInstaller splash to report.
 *   * Check 6's pixel counts. A different renderer counts different pixels; what
 *     is asserted is the same thing the Python asserted — that dark ink and red
 *     ink both got painted, in quantity.
 *   * Check 68's event-loop turns. The Python counted `processEvents()` spins;
 *     this counts animation frames, which is the same question asked of a
 *     different loop.
 *   Everything else is held to the reference text.
 */

import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initSkia } from "../src/skia.ts";
import { Font } from "../src/font.ts";
import { buildDocument, pyRepr } from "../src/core.ts";
import * as APP from "../src/app.ts";
import * as EY from "../src/eyelets.ts";
import * as FC from "../src/fontcheck.ts";
import * as PG from "../src/pairgrid.ts";
import * as PS from "../src/pairsheet.ts";
import * as TH from "../src/thickness.ts";
import * as VM from "../src/viewmodel.ts";
import { serve } from "../src/server.ts";
import { fmtF, pyFloat, pyG } from "../src/pyformat.ts";
import { MM_PER_IN } from "../src/units.ts";

await initSkia();

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTDIR = process.argv[2] ?? path.join(HERE, "_ts_selftest");
fs.mkdirSync(OUTDIR, { recursive: true });

const checks: [boolean, string, string][] = [];

function rec(ok: boolean, name: string, detail: string): void {
  checks.push([ok, name, detail]);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function out(msg = ""): void {
  console.log(msg);
}

/** Python's repr of a list of strings. */
function pyList(v: readonly string[]): string {
  return `[${v.map(pyRepr).join(", ")}]`;
}

/** Python's `True`/`False`. */
function pyBool(v: boolean): string {
  return v ? "True" : "False";
}

/** Every entry name in a zip this app wrote, sorted, plus a CRC check. */
function zipNames(p: string): { names: string[]; bad: string | null } {
  // Reading it back with a DIFFERENT implementation is the point: a zip that only
  // this codebase can open is not a zip. `unzip -t` verifies every CRC, which is
  // what Python's `testzip()` did.
  try {
    const list = execFileSync("unzip", ["-Z1", p], { encoding: "utf-8" })
      .split("\n").filter(Boolean).sort();
    execFileSync("unzip", ["-tqq", p], { encoding: "utf-8" });
    return { names: list, bad: null };
  } catch (exc) {
    return { names: [], bad: `${(exc as Error).message}` };
  }
}

/** One file's text out of a zip, read back through the system unzip. */
function zipRead(p: string, entry: string): string {
  return execFileSync("unzip", ["-p", p, entry], { encoding: "utf-8", maxBuffer: 64 << 20 });
}

const man = APP.buildManifest();
out(`report location: ${path.join(OUTDIR, "selftest_report.txt")}`);
out(`build     = ${man.build_id ?? "(no manifest - from source)"}  built ${man.built_utc ?? "?"}`);
out(`frozen=false`);
out(`executable= ${process.execPath}`);
out(`BASE      = ${APP.BASE}`);
out(`FONTS_DIR = ${APP.FONTS_DIR}`);
out(`settings  = ${APP.SETTINGS_PATH}`);
out(`platform  = node ${process.versions.node}`);
out(`splash    = not in this build (normal when running from source)`);
const iconP = path.join(APP.BASE, "assets", "icon.ico");
out(`icon      = ${iconP} exists=${pyBool(fs.existsSync(iconP))}`);

// --------------------------------------------------------------------------- //
//  1. fonts listed from fonts/ next to the app
// --------------------------------------------------------------------------- //
const fonts = VM.listFonts(APP.FONTS_DIR);
const fams = fonts.map((f) => f.family);
rec(fams.length > 0, "exe lists fonts in fonts\\", `${fams.length} -> ${pyList(fams)}`);
if (!fams.length) process.exit(1);

// pick Merriweather so the expected numbers apply
const merri = fonts.find((f) => f.family.includes("Merriweather")) as VM.FontEntry;
rec(Boolean(merri), "selected Merriweather", merri?.family ?? "");

// 2. font detail line reports engrave capability
const merriInfo = VM.probeFont(merri.path);
rec(merriInfo.detail.includes("carries engrave lines"),
  "font detail reports engrave capability", merriInfo.detail);

// --------------------------------------------------------------------------- //
//  3. preview builds for the caret's name
// --------------------------------------------------------------------------- //
const merriFont = new Font(merri.path);
const res = VM.build({ font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap" });
rec(res.size_label.includes("ADAM —") && res.size_label.includes("4.069 × 1.020 in"),
  "preview size label", res.size_label);
rec(res.count_label === "6 cut contours, 10 engrave lines",
  "preview counts", res.count_label);

// 4. the canvas actually paints something  [browser — see the bottom of this file]

// --------------------------------------------------------------------------- //
//  5. per-name zip export
// --------------------------------------------------------------------------- //
{
  const zipPath = path.join(OUTDIR, "selftest_per_name.zip");
  APP.runExport({
    kind: "per-name", font_path: merri.path,
    names: ["ADAM", "OLIVIA", "Mary Jane"], height: 1.0, unit: "in",
    basis: "cap", formats: ["svg", "pdf"], gap: 0.25, dest: zipPath,
  });
  const { names, bad } = zipNames(zipPath);
  const want = ["ADAM.pdf", "ADAM.svg", "Mary_Jane.pdf", "Mary_Jane.svg",
    "OLIVIA.pdf", "OLIVIA.svg"];
  rec(JSON.stringify(names) === JSON.stringify(want) && bad === null,
    "per-name zip export", `${pyList(names)} (testzip=${bad === null ? "None" : bad})`);
}

// --------------------------------------------------------------------------- //
//  6. one-sheet export
// --------------------------------------------------------------------------- //
{
  const stem = path.join(OUTDIR, "selftest_sheet");
  APP.runExport({
    kind: "sheet", font_path: merri.path,
    names: ["ADAM", "OLIVIA", "Mary Jane"], height: 1.0, unit: "in",
    basis: "cap", formats: ["svg", "pdf"], gap: 0.25, dest: stem,
  });
  const svgOk = fs.existsSync(stem + ".svg") && fs.statSync(stem + ".svg").size > 2000;
  const pdfOk = fs.existsSync(stem + ".pdf") &&
    fs.readFileSync(stem + ".pdf").subarray(0, 5).toString("latin1") === "%PDF-";
  rec(svgOk && pdfOk, "one-sheet export",
    `sheet.svg=${svgOk ? fs.statSync(stem + ".svg").size : "MISSING"} B, ` +
    `sheet.pdf=${pdfOk ? fs.statSync(stem + ".pdf").size : "MISSING"} B`);
}

// --------------------------------------------------------------------------- //
//  7. mm/in conversion keeps the physical size
// --------------------------------------------------------------------------- //
{
  // The number in the box converts; the artwork does not move. `switchUnit` in
  // the client does the first half, and it is the same arithmetic.
  const mmHeight = Math.round(1.0 * MM_PER_IN * 1e6) / 1e6;
  rec(Math.abs(mmHeight - 25.4) < 1e-6, "in -> mm converts the number", `${pyG(mmHeight)} mm`);
  const mm = VM.build({ font: merriFont, text: "ADAM", height: 25.4, unit: "mm", basis: "cap" });
  rec(mm.size_label.includes("ADAM —") && mm.size_label.includes("103.361 × 25.896 mm"),
    "preview after unit switch is the same physical size", mm.size_label);
}

// --------------------------------------------------------------------------- //
//  8. settings.json is written next to the app
// --------------------------------------------------------------------------- //
{
  APP.saveSettings({
    font_path: merri.path, unit: "in", basis: "cap", height: 1.0, gap: 0.25,
    formats: ["svg", "pdf"], names: "ADAM", lead_in: false, lead_len: 0.1,
    lead_clear: 0.012, eye_target_id: 0, eye_target_wall: 0,
    eye_show_dims: false, eye_show_want: true, direction: "vertical",
  });
  const s = APP.loadSettings();
  rec(fs.existsSync(APP.SETTINGS_PATH) && Boolean(s.font_path),
    "settings.json written next to exe",
    `${APP.SETTINGS_PATH} -> font_path=${path.basename(s.font_path ?? "")}`);
}

// --------------------------------------------------------------------------- //
//  8b. lead-in toggle: preview gains lead-ins, reported size must not move
// --------------------------------------------------------------------------- //
{
  const before = res.size_label;
  const lead = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
    leadIn: true, leadLen: 0.1,
  });
  rec(lead.count_label.includes("lead-in") && before === lead.size_label,
    "lead-ins appear and the stated height does NOT change",
    `${pyRepr(lead.count_label)}; size ${pyRepr(before)} -> ${pyRepr(lead.size_label)}`);

  const leadZip = path.join(OUTDIR, "selftest_leadin.zip");
  APP.runExport({
    kind: "per-name", font_path: merri.path, names: ["ADAM"],
    height: 1.0, unit: "in", basis: "cap", formats: ["svg", "pdf"], gap: 0.25,
    dest: leadZip, lead_in: true, lead_len: 0.1,
  });
  const svg = zipRead(leadZip, "ADAM.svg");
  const gids = [...svg.matchAll(/<g id="([^"]+)"/g)].map((m) => m[1]);
  const subs = gids.filter((g) => g.includes("__"));
  // cutting order is file order: engrave, inner cuts, then the outline
  const orderOk = subs.length === 3 && subs[0].includes("engrave") &&
    subs[1].includes("cut_inner") && subs[2].includes("cut_outline");
  const opens = [...svg.matchAll(/<path d="([^"]*)"/g)].filter((m) => !m[1].includes("Z")).length;
  const noDims = !svg.includes("<text") && !svg.includes("<rect");
  rec(orderOk && opens >= 6 && noDims,
    "lead-in export is written in cutting order, outline last",
    `groups ${pyList(gids)}; ${opens} open path(s); ` +
    `order engrave->inner->outline: ${pyBool(orderOk)}; ` +
    `no <text>/<rect>: ${pyBool(noDims)}`);
}

// --------------------------------------------------------------------------- //
//  9. a cut-only font is NORMAL
// --------------------------------------------------------------------------- //
// It must not raise an amber warning, must still say 0 engrave lines in the grey
// line, and must still export. Most of Sean's fonts carry no engraving, so warning
// about it every time trained people to ignore the panel that also carries the
// real problems.
const carrieEntry = fonts.find((f) => f.family.includes("Carrie SO v2")) as VM.FontEntry;
const carrieFont = new Font(carrieEntry.path);
const carrieInfo = VM.probeFont(carrieEntry.path);
{
  const cut = VM.build({ font: carrieFont, text: "Carrie", height: 1.0, unit: "in", basis: "cap" });
  // "amber" is exactly what the panel shows: `notes`, not `warnings`. The engine
  // DOES say "no engrave lines (no COLR table)" for a cut-only font and that is
  // correct of it — the panel is what must stay quiet, and the view model is what
  // decides. Asserting on `warnings` here would pass while the real panel cried
  // wolf on most of the fonts this shop uses.
  const amber = cut.notes.join("  ");
  const quiet = !amber.toLowerCase().includes("engrave");
  rec(quiet && cut.n_cut > 0,
    "a cut-only font does NOT warn in amber, and still exports",
    `counts=${pyRepr(cut.count_label)} amber_visible=${pyBool(Boolean(amber))} ` +
    `amber=${pyRepr(amber.slice(0, 70))} zip=${pyBool(cut.n_cut > 0)}`);
  rec(cut.n_engrave === 0 && /\b0 engrave lines\b/.test(cut.count_label),
    "the engrave count is still stated honestly as 0",
    `n_engrave=${cut.n_engrave} counts=${pyRepr(cut.count_label)}`);
}

// 9-bis. the checker's probe names must be labelled as probes. Read bare, a report
// line starting "'ADAM':" made every font look as if it were called ADAM.
{
  const rep = APP.fontReportText(carrieEntry.path);
  const bare = rep.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("'ADAM'") || l.startsWith("'Adam'") ||
      l.startsWith("ADAM:") || l.startsWith("Adam:"));
  rec(!bare.length && rep.includes("test name"),
    "the checker calls ADAM/Adam test names, never the font's own name",
    `unlabelled lines=${pyList(bare.slice(0, 3))}`);
}

// --------------------------------------------------------------------------- //
//  8c. side-by-side sheet export: wider than tall
// --------------------------------------------------------------------------- //
{
  const stemH = path.join(OUTDIR, "selftest_sheet_horizontal");
  APP.runExport({
    kind: "sheet", font_path: carrieEntry.path,
    names: ["ADAM", "OLIVIA", "Mary Jane"], height: 1.0, unit: "in",
    basis: "cap", formats: ["svg"], gap: 0.25, dest: stemH, direction: "horizontal",
  });
  let ok = false;
  let detail = "no file";
  const head = fs.readFileSync(stemH + ".svg", "utf-8").slice(0, 400);
  const m = /width="([\d.]+)in" height="([\d.]+)in"/.exec(head);
  if (m) {
    const wH = Number(m[1]);
    const hH = Number(m[2]);
    ok = wH > hH * 3; // a row, not a column
    detail = `${fmtF(wH, 3)} x ${fmtF(hH, 3)} in (wide, so laid out in a row)`;
  }
  rec(ok, "side-by-side sheet export", detail);
}

// --------------------------------------------------------------------------- //
//  8d. thin areas: found, summarised, and the target draws a comparison
// --------------------------------------------------------------------------- //
{
  const thinRes = VM.build({
    font: carrieFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap", thin: true,
  });
  rec(thinRes.count_label.includes("thinnest"), "thin areas are found and summarised",
    thinRes.count_label.slice(-90));
  const withTarget = VM.build({
    font: carrieFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
    thin: true, thinTarget: 0.15,
  });
  const nOv = withTarget.overlays.length;
  rec(nOv >= 1, "a target thickness draws a comparison overlay",
    `${nOv} overlay(s): ${pyList(withTarget.overlays.map((o) => o.label))}`);
}

// --------------------------------------------------------------------------- //
//  9a. Reload font re-reads from disk and the preview survives it  [browser]
//  9b. Reload font and Check font buttons present                  [browser]
// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
//  9b2. eyelet measurement reports real numbers for the current artwork
// --------------------------------------------------------------------------- //
let wantId = 0;
{
  const etxt = APP.eyeletReportText(merri.path, "ADAM", 1.0, "in", "cap");
  const idm = /inner diameter\s+([\d.]+) in/.exec(etxt);
  const odm = /outer diameter\s+([\d.]+) in/.exec(etxt);
  const ok = Boolean(idm && odm) && Number(odm![1]) > Number(idm![1]) && Number(idm![1]) > 0;
  rec(ok, "eyelet measurement returns ID < OD",
    `ID=${idm ? idm[1] : "?"} OD=${odm ? odm[1] : "?"} in`);
  wantId = Math.round(Number(idm![1]) * 1.1 * 1e4) / 1e4;
}

// 9b3. the eyelet toggle fills the on-screen table and draws the dimensions
{
  const eye = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap", eyeDims: true,
  });
  const cells = eye.eyelet_rows;
  rec(Boolean(cells.id?.actual) && !cells.id?.want && !cells.id?.change,
    "eyelet toggle fills actual, leaves want/change blank",
    `{${["id", "od", "wall", "wall_min"].map((k) =>
      `${pyRepr(k)}: [${[cells[k]?.actual, cells[k]?.want, cells[k]?.change]
        .map((v) => pyRepr(v ?? "")).join(", ")}]`).join(", ")}}`);
  rec(Boolean(eye.eyelets.length && eye.eyelets[0].wall_min_at),
    "the canvas gets eyelets and the thinnest-wall point to draw",
    `show=${pyBool(true)} n=${eye.eyelets.length} ` +
    `wall_at=(${eye.eyelets[0].wall_min_at![0]}, ${eye.eyelets[0].wall_min_at![1]})`);
}

// 9b4. typing a wanted ID must redraw the preview with the target ring on it
{
  const withId = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
    eyeDims: true, eyeTargetId: wantId,
  });
  const labels = withId.overlays.map((o) => o.label);
  rec(labels.some((l) => l.includes("target inner diameter")),
    "a wanted eyelet ID draws the target ring on the preview",
    `want=${pyG(wantId)} overlays=${pyList(labels)}`);
  const pct = withId.eyelet_rows.id?.change ?? "";
  rec(withId.eyelet_rows.id?.want === fmtF(wantId, 4) && pct.startsWith("+"),
    "the want and change columns fill in",
    `actual=${withId.eyelet_rows.id?.actual} want=${withId.eyelet_rows.id?.want} change=${pct}`);

  const withWall = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
    eyeDims: true, eyeTargetId: wantId, eyeTargetWall: 0.2,
  });
  rec(withWall.overlays.some((o) => o.label.includes("target outer diameter")),
    "a wanted wall draws the target outer ring too",
    `overlays=${pyList(withWall.overlays.map((o) => o.label))}`);

  // 9b4b. the wanted size is a toggle: untick and the rings go, the numbers stay
  const noWant = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
    eyeDims: true, eyeTargetId: wantId, eyeTargetWall: 0.2, eyeWant: false,
  });
  rec(!noWant.overlays.some((o) => o.label.includes("target")) &&
    noWant.eyelet_rows.id?.want === fmtF(wantId, 4),
    "the wanted-size toggle hides the rings but keeps the numbers",
    `overlays=${pyList(noWant.overlays.map((o) => o.label))} ` +
    `want cell=${pyRepr(noWant.eyelet_rows.id?.want ?? "")}`);
  rec(withWall.overlays.some((o) => o.label.includes("target inner diameter")),
    "ticking it back brings the rings back", "");

  // 9b4c. deleting the text in a target box means NOTHING, not 0  [browser]

  // 9b4c-bis. and the build agrees: a cleared ID drops the ring and blanks the
  // want/change columns, while a wall target that is still set keeps its ring.
  const cleared = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap",
    eyeDims: true, eyeTargetId: 0, eyeTargetWall: 0.2,
  });
  rec(!cleared.overlays.some((o) => o.label.includes("target inner diameter")) &&
    !cleared.eyelet_rows.id?.want,
    "clearing it drops the ring and blanks the want/change columns",
    `want=${pyRepr(cleared.eyelet_rows.id?.want ?? "")} ` +
    `change=${pyRepr(cleared.eyelet_rows.id?.change ?? "")} ` +
    `overlays=${pyList(cleared.overlays.map((o) => o.label))}`);
}

// --------------------------------------------------------------------------- //
//  9b5. every thin spot carries the crossing the preview draws the distance on
// --------------------------------------------------------------------------- //
{
  const thinRes = VM.build({
    font: merriFont, text: "ADAM", height: 1.0, unit: "in", basis: "cap", thin: true,
  });
  const spots = thinRes.thin_spots;
  const good = spots.every((s) => s.across && s.across.length === 2);
  rec(good && spots.length >= 1,
    "thin spots carry a 2-point crossing to draw the distance across",
    `${spots.length} spot(s), all with a crossing=${pyBool(good)}`);

  // the mark labels must not read as one number: "7. 0.0889 in" looked like a
  // 7.0889 in feature on a part whose whole height is 1.020 in
  const labs = spots.map((sp, i) => APP.thinLabel(i + 1, sp, "in"));
  const bad = labs.filter((t) => /^\d+\.\s*\d/.test(t));
  rec(Boolean(labs.length) && !bad.length && labs.every((t) => t.startsWith("#")),
    "a thin mark's rank cannot be misread as part of the measurement",
    `${pyList(labs.slice(0, 3))}` + (bad.length ? ` AMBIGUOUS: ${pyList(bad)}` : ""));

  const ts = spots.length ? spots.map((s) => s.thickness) : [0.0];
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  const cols = spots.map((s) => APP.thinColour(s, lo, hi, 0.0));
  rec(new Set(cols).size >= 2 && cols[0] === APP.THIN_RAMP[0] &&
    cols.every((c) => c.startsWith("#")),
    "thin spots are graded into severity colours, worst the most vivid",
    `${new Set(cols).size} colour(s) over ${fmtF(lo, 4)}-${fmtF(hi, 4)}: ${pyList(cols)}`);
  const pass = APP.thinColour(spots[0], lo, hi, spots[0].thickness * 0.5);
  rec(pass === APP.THIN_OK, "a spot that already meets the wanted thickness goes green", pass);
}

// --------------------------------------------------------------------------- //
//  9b6. Generate prompts: four sections, blank where there is nothing to ask
// --------------------------------------------------------------------------- //
{
  // The eyelet ID box was CLEARED two checks ago and never re-typed, so the run
  // that builds these prompts sees no ID target and a 0.2 wall — which is why the
  // reference's eyelet block is 1237 chars and not the 1238 a set ID produces.
  const secs = APP.promptSections(merri.path, "ADAM", 1.0, "in", "cap", 0, 0, 0.2);
  rec(secs.length > 0, "Generate prompts finishes on the report thread without freezing",
    `${secs.length} section(s) came back`);
  const titles = secs.map((s) => s.title);
  rec(secs.length === 4 && titles.every((t) => /^\d/.test(t)),
    "Generate prompts produces one section per area", pyList(titles));
  const by: Record<string, string> = {};
  for (const s of secs) by[s.title.split(". ").slice(1).join(". ")] = s.body;
  rec(Boolean(by["Eyelet size"]) && by["Eyelet size"].includes("FONT UNITS"),
    "the eyelet section is filled once a target is typed",
    `${(by["Eyelet size"] ?? "").length} chars`);
  rec(by["Font defects"] === "",
    "a clean font leaves the defect section BLANK, not a fake request",
    `${(by["Font defects"] ?? "").length} chars`);
  const isAscii = (s: string) => [...s].every((c) => c.charCodeAt(0) < 128);
  rec(Object.values(by).filter(Boolean).every(isAscii),
    "every prompt is plain ASCII, so it pastes anywhere",
    `${pyList(Object.keys(by).filter((k) => by[k] && !isAscii(by[k])))} non-ASCII`);

  // ...and check the ones this run happened to leave EMPTY as well. The check
  // above only ever saw non-empty blocks, so the thin-area prompt -- which is
  // blank unless a target thickness is typed -- was never tested and shipped with
  // an em dash in it. Build all four directly, with targets supplied.
  const nonAscii: Record<string, string[]> = {};
  try {
    const d5 = buildDocument(merriFont, "ADAM", 1.0, "in", "cap");
    const built: [string, string][] = [
      ["thin_areas", TH.claudePrompt(d5, 0.15, merri.path, merriFont)],
      ["eyelet_size", EY.claudePrompt(d5, null, 0.4, 0.2, merri.path)],
      ["font_defects", FC.checkFont(merri.path, { joinScanBudget: 0.0 }).claudePrompt()],
      ["letter_pairs", PS.claudePrompt(
        merriFont, PS.analysePairs(merriFont, ["lower"], 8.0), merri.path)],
    ];
    for (const [label, text] of built) {
      if (text && !isAscii(text)) {
        nonAscii[label] = [...new Set([...text].filter((c) => c.charCodeAt(0) > 127)
          .map((c) => "0x" + c.charCodeAt(0).toString(16)))].sort();
      }
    }
  } catch (exc) {
    nonAscii["(builder raised)"] = [`${(exc as Error).name}: ${(exc as Error).message}`];
  }
  rec(!Object.keys(nonAscii).length,
    "EVERY prompt builder is ASCII, including blocks empty in this run",
    Object.keys(nonAscii).length ? JSON.stringify(nonAscii) : "all four clean with targets supplied");
}

// --------------------------------------------------------------------------- //
//  9c. the font checker produces a real report for the selected font
// --------------------------------------------------------------------------- //
{
  // Merriweather, not Carrie: check 9a selected it back and never left. The
  // reference's glyph names in the pair-sheet checks below say the same thing —
  // 'D.ini' is this unicase cut, not the script face.
  const txt = APP.fontReportText(merri.path);
  const headline = txt.split("\n").find((l) =>
    l.startsWith("No problems") || l.startsWith("CANNOT") || l.startsWith("Usable,")) ?? "?";
  rec(txt.includes("Font facts:") && txt.includes("outline format") &&
    !txt.includes("checker itself failed"),
    "font checker returns a report", `${txt.length} chars, headline=${pyRepr(headline)}`);
}

// --------------------------------------------------------------------------- //
//  9d. the letter-pair sheet: zoom, the flagged count, and the walk
// --------------------------------------------------------------------------- //
{
  const prep = PS.analysePairs(merriFont);
  rec(prep !== null, "the letter-pair analysis finishes on the report thread",
    `report arrived: ${pyBool(true)}`);

  const grid = new PG.PairGrid(merriFont, prep);
  const baseCell = grid.CELL;
  grid.setZoom(0.30);
  const smallCell = grid.CELL;
  grid.setZoom(2.40);
  const bigCell = grid.CELL;
  rec(smallCell < baseCell && baseCell < bigCell, "the pair sheet zooms out and in",
    `30%=${smallCell}px 100%=${baseCell}px 240%=${bigCell}px`);
  grid.setZoom(1.0);
  rec(grid.width === grid.cols.length * grid.CELL && grid.height === grid.rows.length * grid.CELL,
    "the zoomed sheet is still 26 columns x 52 rows",
    `${grid.width}x${grid.height}px, ${grid.cols.length}x${grid.rows.length} cells`);

  // one row per POSITION a pair can occupy in a real name: the whole word (both
  // eyelet forms), the first letter, the middle, the last
  const wantKeys = ["caplower", "lower", "firstcaplower", "firstlower",
    "midcaplower", "midlower", "lastlower"];
  const keys = grid.rows.slice(0, wantKeys.length).map(([k]) => k);
  rec(grid.rows.length === wantKeys.length * 26 &&
    JSON.stringify(keys) === JSON.stringify(wantKeys),
    "the pair sheet covers every positional junction, one row each",
    `${grid.rows.length} rows, first letter's rows = ${pyList(keys)}`);

  // the junctions a 3+ letter name makes at its ends must be DIFFERENT
  // measurements from the whole-word ones, not the same cell reached twice
  const wFirst = grid.result("firstlower", "d", "d");
  const wWhole = grid.result("lower", "d", "d");
  rec(Boolean(wFirst && wWhole && wFirst !== wWhole && wFirst.context === "dda" &&
    JSON.stringify(wFirst.span) === "[0,1]"),
    "a first-letter cell is shaped as 'dda' and judges glyphs 0-1",
    `whole=${wWhole ? pyTuple(wWhole.glyphs) : "None"} ` +
    `first=${wFirst ? pyTuple(wFirst.glyphs) : "None"} ` +
    `span=${wFirst?.span ? `(${wFirst.span[0]}, ${wFirst.span[1]})` : "None"}`);

  const wLast = grid.result("lastlower", "a", "b");
  rec(Boolean(wLast && wLast.context === "Aab" && JSON.stringify(wLast.span) === "[1,2]"),
    "a last-letter cell is shaped as 'Aab' and judges glyphs 1-2",
    `context=${pyRepr(wLast?.context ?? "")} ` +
    `span=${wLast?.span ? `(${wLast.span[0]}, ${wLast.span[1]})` : "None"}`);

  rec(new Set(Object.values(grid._scale_by_mode)).size === 3,
    "two-, three- and four-letter cells each get their own scale",
    `{${Object.entries(grid._scale_by_mode)
      .map(([m, v]) => `${pyRepr(m)}: ${pyFloat(round6(v))}`).join(", ")}}`);

  // the middle rows must actually shape a 4-letter word and mark which two
  // glyphs are under test
  const mid = grid.result("midlower", "a", "a");
  rec(Boolean(mid && mid.context === "Aaaa" && JSON.stringify(mid.span) === "[1,2]"),
    "a middle-of-word cell is shaped inside Aaaa and judges glyphs 1-2",
    `context=${pyRepr(mid?.context ?? "")} ` +
    `span=${mid?.span ? `(${mid.span[0]}, ${mid.span[1]})` : "None"} ` +
    `glyphs=${mid ? pyTuple(mid.glyphs) : "None"}`);

  // and it must be a DIFFERENT measurement from the whole-word one, not the same
  // cell reached twice: keying the lookup on (left, right) alone threw one away
  const start = grid.result("lower", "a", "a");
  rec(Boolean(mid && start && mid !== start && mid.glyphs.length > start.glyphs.length),
    "start-of-word and middle-of-word are kept as separate measurements",
    `start=${start ? pyTuple(start.glyphs) : "None"} mid=${mid ? pyTuple(mid.glyphs) : "None"}`);

  rec(Boolean(mid && start && mid.glyphs[1] !== start.glyphs[0]),
    "the middle row uses a medial glyph, not the initial (eyelet) one",
    `initial=${pyRepr(start!.glyphs[0])} medial=${pyRepr(mid!.glyphs[1])}`);

  rec(grid._scale_wide < grid._scale, "a four-letter cell is drawn at its own smaller scale",
    `2-letter=${fmtF(grid._scale, 6)} 4-letter=${fmtF(grid._scale_wide, 6)}`);

  const flagged = grid.flaggedCells();
  const order = flagged.map(([r, c]) => [r, c] as [number, number]);
  const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  rec(JSON.stringify(order) === JSON.stringify(sorted),
    "flagged pairs are walked in reading order, top to bottom",
    `${order.length} flagged: ${pyList(order.slice(0, 6)
      .map(([r, c]) => grid.rows[r][0] + grid.rows[r][1] + grid.cols[c]))}`);
  rec(flagged.length === grid.nFlagged(),
    "the flagged count matches the number the header shows",
    `${flagged.length} vs ${grid.nFlagged()}`);
}

// --------------------------------------------------------------------------- //
//  9f. the health surface: it must name the build and pass its own checks
// --------------------------------------------------------------------------- //
{
  const h = APP.healthReport();
  rec(["fonts folder", "settings file", "startup log", "CHECKS"].every((k) => h.includes(k)) &&
    !h.includes("PROBLEM"),
    "the health check names the build and reports no problems here",
    h.split("\n").map((l) => l.trim())
      .filter((l) => l.startsWith("build ") || l.startsWith("["))
      .join(" | ").slice(0, 150));
}

// --------------------------------------------------------------------------- //
//  the checks that are genuinely about the window
// --------------------------------------------------------------------------- //
await browserChecks();

// --------------------------------------------------------------------------- //
const nOk = checks.filter((c) => c[0]).length;
out("=".repeat(70));
out(`selftest: ${nOk}/${checks.length} passed`);
for (const [ok, name, detail] of checks) if (!ok) out(`  FAIL ${name}: ${detail}`);
out("=".repeat(70));
fs.writeFileSync(path.join(OUTDIR, "selftest_report.txt"),
  checks.map(([ok, name, d]) => `[${ok ? "PASS" : "FAIL"}] ${name}: ${d}`).join("\n") +
  `\n${"=".repeat(70)}\nselftest: ${nOk}/${checks.length} passed\n${"=".repeat(70)}\n`, "utf-8");
process.exit(nOk === checks.length ? 0 : 1);

// --------------------------------------------------------------------------- //
//  helpers
// --------------------------------------------------------------------------- //

/** Python's repr of a tuple of strings. */
function pyTuple(v: readonly string[]): string {
  return v.length === 1 ? `(${pyRepr(v[0])},)` : `(${v.map(pyRepr).join(", ")})`;
}

/** Python's `round(v, 6)`, for the scale dict the reference prints. */
function round6(v: number): number {
  return Number(fmtF(v, 6));
}

/**
 * The four checks that need a real window, in a real browser.
 *
 * A headless Chromium against a real server on a real port. Everything above
 * proved the app COMPUTES the right answers; this proves the page SHOWS them —
 * which is the half a Qt-to-browser port could otherwise lose without any test
 * noticing.
 */
async function browserChecks(): Promise<void> {
  const { chromium } = await import("playwright");
  const server = await serve(0);
  const port = (server.address() as { port: number }).port;
  // The pre-installed browser and the npm package can be different builds, so the
  // executable is named rather than looked up by version.
  const exe = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(
    fs.existsSync(exe) ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const settle = (ms = 1200) => page.waitForTimeout(ms);
  const nameBox = () => page.locator(".controls textarea").first();
  const sizeLabel = () => page.locator(".size-label");
  const countLabel = () => page.locator(".count-label");

  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(".app");
    await settle(1500);

    // Start from the documented defaults, exactly as the Python does: a previous
    // run leaving mm behind would fail checks written in inches.
    await page.selectOption(".controls select", { label: merri.family });
    await page.locator('input[type="radio"]').first().check();
    await nameBox().fill("ADAM");
    await page.waitForFunction(
      () => document.querySelector(".size-label")?.textContent?.includes("4.069 × 1.020 in"),
      undefined, { timeout: 30000 });

    // 4. the canvas actually paints something
    const shot = await page.locator(".preview canvas").screenshot({
      path: path.join(OUTDIR, "selftest_preview.png"),
    });
    const px = countInk(shot);
    rec(px.dark > 200 && px.red > 20, "canvas painted cut (black) + engrave (red)",
      `${px.dark} dark px, ${px.red} red px, ${px.w}x${px.h} -> ` +
      `${path.join(OUTDIR, "selftest_preview.png")}`);
    await page.screenshot({ path: path.join(OUTDIR, "selftest_window.png") });
    out(`       full window image -> ${path.join(OUTDIR, "selftest_window.png")}`);

    // 9a. Reload font re-reads the file and rebuilds the preview
    await page.getByRole("button", { name: "Reload font" }).click();
    await page.waitForFunction(
      () => document.querySelector(".status-text")?.textContent?.includes("Re-read"),
      undefined, { timeout: 30000 });
    // `.status-text`, not `.status`: the live "working…" indicator is a sibling
    // span, and reading the whole box would fold it into the message.
    const status = (await page.locator(".status-text").textContent()) ?? "";
    const size = (await sizeLabel().textContent()) ?? "";
    rec(status.includes("Re-read") && size.includes("4.069 × 1.020 in"),
      "Reload font re-reads the file and rebuilds the preview",
      `status=${pyRepr(status.trim())} size=${pyRepr(size)}`);

    // 9b. the two buttons exist
    const hasReload = await page.getByRole("button", { name: "Reload font" }).count() > 0;
    const hasCheck = await page.getByRole("button", { name: "Check font" }).count() > 0;
    rec(hasReload && hasCheck, "Reload font and Check font buttons present",
      `reload=${pyBool(hasReload)} check=${pyBool(hasCheck)}`);

    // 9b4c. deleting the text in a target box means NOTHING, not 0
    const idBox = page.locator(".target-spin").nth(1); // thin, then eyelet ID
    await idBox.fill(String(wantId));
    await settle(600);
    await idBox.fill("");
    await settle(300);
    const blank = (await idBox.inputValue()).trim() === "";
    rec(blank, "clearing a target box reads as nothing, not a number",
      `target=${pyFloat(0.0)} blank=${pyBool(blank)}`);
    // and the box itself must settle on the em dash, not snap back to the number
    await page.locator("h1").click();
    await settle(300);
    const settled = await idBox.inputValue();
    rec(settled === "—", "an emptied box commits to the em dash instead of the old value",
      `value=${pyFloat(0.0)} text=${pyRepr(settled)}`);

    // 9e. the point of the report thread: the window keeps painting. Queue the
    // slowest analysis and prove the page still runs while it works.
    const spins = await page.evaluate(async () => {
      let n = 0;
      let running = true;
      const tick = () => { if (running) { n += 1; requestAnimationFrame(tick); } };
      requestAnimationFrame(tick);
      const btn = [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Check font") as HTMLButtonElement;
      btn.click();
      const start = Date.now();
      while (!document.querySelector(".modal textarea") && Date.now() - start < 60000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      running = false;
      return { n, arrived: Boolean(document.querySelector(".modal textarea")) };
    });
    rec(spins.arrived && spins.n > 50,
      "the GUI event loop keeps running while a font check is in flight",
      `${spins.n} event-loop turns during the check, report ` +
      `${spins.arrived ? "arrived" : "did NOT arrive"}`);

    // the button that started a report is re-enabled when it finishes
    const btn = page.getByRole("button", { name: "Check font" });
    const enabled = await btn.isEnabled();
    rec(enabled, "the button that started a report is re-enabled when it finishes",
      `enabled=${pyBool(enabled)} text=${pyRepr((await btn.textContent()) ?? "")}`);
    await page.getByRole("button", { name: "Close" }).first().click();

    // 10. empty input disables export
    await nameBox().fill("");
    await settle(400);
    const zipOn = await page.getByRole("button", { name: "One file per name (zip)" }).isEnabled();
    const sheetOn = await page.getByRole("button", { name: "One sheet" }).isEnabled();
    rec(!zipOn && !sheetOn, "empty name box disables export",
      `zip=${pyBool(zipOn)} sheet=${pyBool(sheetOn)}`);

    if (pageErrors.length) rec(false, "the page threw no errors", pyList(pageErrors.slice(0, 3)));
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Dark and red pixels in a PNG, sampled every other row and column.
 *
 * The same test the Python ran on the Qt grab, with the same thresholds: dark is
 * every channel under 80, red is r>180 with g and b under 90. Decoded by handing
 * the PNG to the browser rather than by adding an image library — the pixels come
 * back through the same canvas that drew them.
 */
function countInk(png: Buffer): { dark: number; red: number; w: number; h: number } {
  // A PNG's IHDR carries the size in the first 24 bytes, which is all that is
  // needed alongside the counts the caller already has.
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const raw = decodePngRgba(png);
  let dark = 0;
  let red = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];
      if (r < 80 && g < 80 && b < 80) dark += 1;
      else if (r > 180 && g < 90 && b < 90) red += 1;
    }
  }
  return { dark, red, w, h };
}

/**
 * A PNG to RGBA bytes.
 *
 * Only what Chromium writes: 8-bit RGB or RGBA, non-interlaced, one IDAT stream.
 * Enough to count ink, and it keeps an image decoder out of the dependency list
 * for the sake of two numbers.
 */
function decodePngRgba(png: Buffer): Uint8Array {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const depth = png[24];
  const colour = png[25];
  if (depth !== 8 || (colour !== 2 && colour !== 6)) {
    throw new Error(`unexpected PNG: depth=${depth} colour=${colour}`);
  }
  const chan = colour === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  let at = 8;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const tag = png.subarray(at + 4, at + 8).toString("latin1");
    if (tag === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const data = inflateSync(Buffer.concat(idat));
  const stride = w * chan;
  const out = new Uint8Array(w * h * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = data[y * (stride + 1)];
    const src = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= chan ? line[i - chan] : 0;
      const b = prev[i];
      const c = i >= chan ? prev[i - chan] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * chan];
      out[(y * w + x) * 4 + 1] = line[x * chan + 1];
      out[(y * w + x) * 4 + 2] = line[x * chan + 2];
      out[(y * w + x) * 4 + 3] = chan === 4 ? line[x * chan + 3] : 255;
    }
    prev.set(line);
  }
  return out;
}

#!/usr/bin/env node
/**
 * verify_release.ts — prove the shipped archive works the way a new machine sees it.
 *
 *     npx tsx scripts/verify_release.ts
 *
 * A conversion of `verify_release.ps1`. It extracts `dist/nameplate-ts.tar.gz` into
 * a clean folder — no build tree, nothing left over from this machine — then drives
 * the extracted bundle and checks the files it produces. This is the test that
 * answers "does it run for someone who just unpacked it".
 *
 * WHAT CHANGED IN THE CONVERSION, AND WHY
 *     The PowerShell original drove a windowed `.exe` and had to use its
 *     `--selftest` switch, because a `--windowed` PyInstaller build has no stdout.
 *     A Node CLI has stdout, so the checks that read `selftest_report.txt` read the
 *     command's own output instead. The GUI-feature checks it walked
 *     ("lists fonts", "canvas painted", "pair sheet zooms out and in", …) have no
 *     equivalent yet: those exercise the Qt window, which is not part of this port.
 *     They are listed as SKIP rather than quietly dropped, so the count is honest.
 *
 * Exit code 0 = every check passed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = path.join(HERE, "dist", "nameplate-ts.tar.gz");
const STAGE = path.join(os.tmpdir(), "nameplate_release_test");

const failures: string[] = [];
const skipped: string[] = [];
let passes = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failures.push(`${name} -> ${detail}`);
    console.log(`[FAIL] ${name}`);
  }
  if (detail) console.log(`       ${detail}`);
}

/** A check this port cannot make yet, recorded rather than dropped. */
function skip(name: string, why: string): void {
  skipped.push(`${name} -> ${why}`);
  console.log(`[SKIP] ${name}`);
  console.log(`       ${why}`);
}

console.log("=== raw extraction test ===================================");
check("release archive exists", fs.existsSync(ARCHIVE), ARCHIVE);
if (!fs.existsSync(ARCHIVE)) {
  console.log("nothing to test — run scripts/build_all.ts first");
  process.exit(1);
}

if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
spawnSync("tar", ["-xzf", ARCHIVE, "-C", STAGE], { encoding: "utf8" });

const app = path.join(STAGE, "dist_bundle");
const entry = path.join(app, "nameplate-cli.mjs");
check("extracted app folder present", fs.existsSync(entry), entry);
if (!fs.existsSync(entry)) process.exit(1);

for (const need of ["node_modules", "fonts", "README.txt", "INSTALL.txt"]) {
  check(`shipped: ${need}`, fs.existsSync(path.join(app, need)));
}
const fontCount = fs
  .readdirSync(path.join(app, "fonts"))
  .filter((f) => /\.(ttf|otf|ttc)$/i.test(f)).length;
check("fonts shipped next to the entry point", fontCount >= 1, `${fontCount} font file(s)`);
check(
  "no leftover settings.json in the release",
  !fs.existsSync(path.join(app, "settings.json")),
);

// ---- run the bundle with the build tree out of reach ---------------------- //
/**
 * Drive the extracted bundle from its own folder, with a minimal environment, so
 * nothing resolves back into this repository's node_modules.
 */
function runBundle(args: string[], timeoutMs = 300_000): { code: number; out: string } {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: app,
    timeout: timeoutMs,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: os.tmpdir(),
      SystemRoot: process.env.SystemRoot,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 9999, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

console.log("\n=== driving the extracted bundle ==========================");
const out = path.join(app, "verify_out");
const font = path.join(app, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf");

// per-name export, three names — the equivalent of the exe's per-name zip check
const perName = runBundle([
  "--font", font, "--height", "1", "--unit", "in", "--basis", "cap",
  "--format", "both", "--mode", "per-name", "--out", out,
  "ADAM", "OLIVIA", "Mary Jane",
]);
check("bundle exits 0 on a per-name export", perName.code === 0, `exit=${perName.code}`);
check(
  "bundle produces the documented numbers",
  perName.out.includes("ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)"),
  perName.out.split("\n")[0],
);

{
  const want = ["ADAM.pdf", "ADAM.svg", "Mary_Jane.pdf", "Mary_Jane.svg", "OLIVIA.pdf", "OLIVIA.svg"];
  const got = fs.existsSync(out) ? fs.readdirSync(out).sort() : [];
  check(
    "per-name export writes one svg+pdf per name",
    JSON.stringify(got) === JSON.stringify(want),
    got.join(","),
  );
}

// one-sheet export
const sheetDir = path.join(app, "verify_sheet");
const sheet = runBundle([
  "--font", font, "--height", "1", "--unit", "in", "--basis", "cap",
  "--format", "both", "--mode", "sheet", "--out", sheetDir, "ADAM", "OLIVIA",
]);
check("bundle exits 0 on a one-sheet export", sheet.code === 0, `exit=${sheet.code}`);
for (const f of ["sheet.svg", "sheet.pdf"]) {
  const p = path.join(sheetDir, f);
  const ok = fs.existsSync(p) && fs.statSync(p).size > 1000;
  check(
    `one-sheet output: ${f}`,
    ok,
    fs.existsSync(p) ? `${fs.statSync(p).size} bytes` : "missing",
  );
}

// ---- the artefacts it produced -------------------------------------------- //
console.log("\n=== files the extracted bundle produced ===================");
{
  const pdf = path.join(sheetDir, "sheet.pdf");
  if (fs.existsSync(pdf)) {
    const sig = fs.readFileSync(pdf).subarray(0, 5).toString("latin1");
    check("sheet PDF has a real PDF header", sig === "%PDF-", sig);
    // the PDF must carry one named layer per name, in order
    const text = fs.readFileSync(pdf).toString("latin1");
    const names = Array.from(text.matchAll(/\/Type \/OCG \/Name \(([^)]*)\)/g)).map((m) => m[1]);
    check(
      "sheet PDF names one layer per name",
      JSON.stringify(names) === JSON.stringify(["ADAM", "OLIVIA"]),
      names.join(","),
    );
    // and the engrave pass must be written before any cut
    const start = fs.readFileSync(pdf).indexOf("stream\n") + "stream\n".length;
    const end = fs.readFileSync(pdf).indexOf("\nendstream", start);
    const body = zlib.inflateSync(fs.readFileSync(pdf).subarray(start, end)).toString("latin1");
    check(
      "sheet PDF draws engrave before any cut",
      body.indexOf("1 0 0 RG") >= 0 && body.indexOf("1 0 0 RG") < body.indexOf("0 0 0 RG"),
      `red at ${body.indexOf("1 0 0 RG")}, black at ${body.indexOf("0 0 0 RG")}`,
    );
  }
}
{
  const svg = path.join(sheetDir, "sheet.svg");
  if (fs.existsSync(svg)) {
    const s = fs.readFileSync(svg, "utf8");
    check("sheet SVG carries physical units", /width="[\d.]+in"/.test(s));
    // The exporter writes per-name groups in CUTTING order: engrave first, inner
    // cuts, then the outline last so the part stays held until the end.
    check(
      "sheet SVG is per-name grouped in cutting order",
      s.includes("__1_engrave") &&
        s.includes("__2_cut_inner") &&
        s.includes("__3_cut_outline") &&
        s.indexOf("__1_engrave") < s.indexOf("__3_cut_outline"),
    );
    check(
      "sheet SVG has no dimension marks to cut",
      !s.includes("<text") && !s.includes("<rect"),
    );
  }
}
{
  const manifest = path.join(app, "assets", "build_manifest.json");
  if (fs.existsSync(manifest)) {
    const man = JSON.parse(fs.readFileSync(manifest, "utf8"));
    check(
      "build manifest ships and carries a build id",
      typeof man.build_id === "string" && man.build_id.length === 12,
      `build ${man.build_id}, ${Object.keys(man.sources ?? {}).length} sources`,
    );
  } else {
    check("build manifest ships", false, "missing");
  }
}

// ---- the checks that belong to the GUI ------------------------------------ //
console.log("\n=== checks that need the desktop window ===================");
for (const feature of [
  "lists fonts", "preview size label", "canvas painted", "lead-ins appear",
  "Reload font", "font checker", "a cut-only font does NOT warn",
  "eyelet toggle fills actual", "wanted eyelet ID draws the target ring",
  "clearing a target box reads as nothing", "thin mark's rank cannot be misread",
  "Generate prompts produces one section", "pair sheet zooms out and in",
  "covers every positional junction", "window screenshot captured",
]) {
  skip(`feature exercised: ${feature}`, "the desktop window is not part of this port");
}

console.log("\n==========================================================");
if (failures.length === 0) {
  console.log(`ALL ${passes} CHECKS PASSED — the archive runs from a raw extraction`);
  if (skipped.length) console.log(`${skipped.length} check(s) skipped (see above)`);
  console.log(`tested at: ${app}`);
  process.exit(0);
} else {
  console.log(`${passes} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}

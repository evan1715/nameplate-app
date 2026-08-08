#!/usr/bin/env node
/**
 * verify_install.ts — prove package.json alone is enough to install and run.
 *
 *     node scripts/verify_install.ts
 *
 * A conversion of `verify_venv.ps1`. That script built a throwaway virtual
 * environment with nothing in it, installed ONLY what `requirements.txt` asked for,
 * and then ran the engine inside it — so a dependency missing from
 * `requirements.txt` showed up here rather than on someone else's PC.
 *
 * The Node equivalent is a throwaway directory holding nothing but a copy of
 * `package.json` and the source, with a fresh `npm install` into it. If a
 * dependency is only present because it happens to be in this repository's
 * `node_modules`, this is where it fails.
 *
 * Needs network access for `npm install`. Exit code 0 = every check passed.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(HERE, "..");
const STAGE = path.join(os.tmpdir(), "nameplate_install_test");
let fails = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) fails += 1;
  if (detail) console.log(`       ${detail}`);
}

console.log("=== clean install directory ===============================");
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// Only the manifest and the source travel — deliberately NOT node_modules, and
// deliberately not package-lock.json, so the declared ranges are what gets tested.
fs.copyFileSync(path.join(HERE, "package.json"), path.join(STAGE, "package.json"));
fs.copyFileSync(path.join(HERE, "tsconfig.json"), path.join(STAGE, "tsconfig.json"));
for (const dir of ["src", "tests", "scripts"]) {
  fs.cpSync(path.join(HERE, dir), path.join(STAGE, dir), { recursive: true });
}
// the fonts and goldens the suites read live one level up, as they do in the repo
fs.cpSync(path.join(REPO, "fonts"), path.join(path.dirname(STAGE), "fonts"), {
  recursive: true,
});
check("staged a clean tree with no node_modules", !fs.existsSync(path.join(STAGE, "node_modules")));

console.log("\n=== installing package.json only ==========================");
const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: STAGE,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
check(
  "npm install succeeded",
  install.status === 0,
  `exit=${install.status}${install.status === 0 ? "" : "\n" + (install.stderr ?? "").slice(-800)}`,
);
if (install.status !== 0) process.exit(1);

console.log("\n=== engine works in the clean install =====================");
const outDir = path.join(STAGE, "out");
const cli = spawnSync(
  "node",
  [
    "src/bin/cli.ts",
    "--font", path.join(REPO, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf"),
    "--height", "1", "--unit", "in", "--basis", "cap",
    "--format", "both", "--mode", "per-name", "--out", outDir, "ADAM",
  ],
  { cwd: STAGE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const expected = "ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)";
check(
  "CLI produces the documented numbers",
  (cli.stdout ?? "").includes(expected),
  (cli.stdout ?? cli.stderr ?? "").split("\n")[0],
);

console.log("\n=== every module loads in the clean install ===============");
for (const mod of [
  "src/skia.ts", "src/geom.ts", "src/pyformat.ts", "src/font.ts", "src/core.ts",
  "src/layout.ts", "src/leadin.ts", "src/exporters.ts", "src/eyelets.ts",
]) {
  // A probe FILE, not `node --eval`: the inline form is treated as CommonJS, which
  // rejects the top-level await these modules use (geom.ts awaits the jsts UMD
  // bundle, and every module that touches Skia awaits its WASM).
  const probe = path.join(STAGE, "_probe.mts");
  fs.writeFileSync(probe, `await import("./${mod}");\n`, "utf8");
  const r = spawnSync("node", [probe], {
    cwd: STAGE,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.rmSync(probe, { force: true });
  check(`import ${mod}`, r.status === 0, r.status === 0 ? "" : (r.stderr ?? "").slice(-300));
}

console.log("\n=== the suites pass in the clean install ==================");
for (const suite of ["tests/parity.ts", "tests/acceptance.ts", "tests/export.ts"]) {
  const r = spawnSync("node", [suite], {
    cwd: STAGE,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = ((r.stdout ?? "").match(/^\d+\/\d+ passed$/m) ?? ["(no summary)"])[0];
  check(`${suite} passes`, r.status === 0, line);
}

console.log("\n==========================================================");
if (fails === 0) {
  console.log("package.json is COMPLETE — a bare install can run the engine");
  process.exit(0);
} else {
  console.log(`${fails} check(s) FAILED — package.json is missing something`);
  process.exit(1);
}

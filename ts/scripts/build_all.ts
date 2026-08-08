#!/usr/bin/env node
/**
 * build_all.ts — produce every shippable artifact from a clean state.
 *
 *     node scripts/build_all.ts
 *
 * A conversion of `build_all.ps1`. The Python original's pipeline was
 *
 *     make_assets -> make_manifest -> tests -> PyInstaller -> zip -> Inno Setup
 *
 * and the shape here is the same, with the packaging steps replaced by the Node
 * equivalents:
 *
 *   | PowerShell / Python          | here                                      |
 *   |------------------------------|-------------------------------------------|
 *   | `make_assets.py`             | skipped — icon/splash belong to the Qt UI  |
 *   | `make_manifest.py`           | `scripts/make_manifest.ts`                |
 *   | acceptance/export/regression | `tests/acceptance.ts`, `tests/export.ts`  |
 *   | PyInstaller `--onedir`       | `esbuild` bundle + the WASM assets         |
 *   | the PySide6 window           | `esbuild` client bundle + `src/server.ts`  |
 *   | `Compress-Archive`           | a `.tar.gz` written with `tar`             |
 *   | Inno Setup                   | skipped — there is no installer to build   |
 *
 * THE ONE RULE THAT CARRIED OVER UNCHANGED
 *     Nothing is packaged until the tests pass. The PowerShell original refused to
 *     run PyInstaller if any suite failed, with a comment recording that it used to
 *     run only the acceptance suite — which meant the export contract and the
 *     regressions were never checked before an installer went out. Both run here.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(HERE, "dist_bundle");

/** A step heading, the way the PowerShell script's `Say` did it. */
function say(msg: string): void {
  console.log(`\n=== ${msg}`);
}

/** Run a command, echoing the last few lines; throws on a non-zero exit. */
function run(cmd: string, args: string[], tailLines = 3): void {
  const r = spawnSync(cmd, args, { cwd: HERE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trimEnd().split("\n");
  for (const line of out.slice(-tailLines)) console.log(`    ${line}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} FAILED (exit ${r.status})`);
}

say("0. stamp the build so the bundle can prove which code it is");
run("node", ["scripts/make_manifest.ts"], 1);

say("1. tests must pass before anything is built");
// ALL of them. The PowerShell original used to run the acceptance suite only,
// which meant the suite proving the CorelDRAW-verified export contract (per-name
// groups, cut order engrave -> inner -> outline) never ran before packaging.
// The window's own selftest is in here too, now that the window is part of the
// port: it is the only suite that proves the shipped page draws what the engine
// measured, and shipping without it would repeat the original's mistake one level
// up.
run("npm", ["run", "build:client"], 2);
for (const suite of ["tests/parity.ts", "tests/acceptance.ts", "tests/export.ts",
  "tests/gui.ts"]) {
  console.log(`  ${suite}`);
  run("node", [suite], 3);
}

say("2. typecheck");
// Both projects: the engine and the client are separate tsconfigs on purpose (the
// client needs the DOM lib and JSX, the engine must not have them), so one
// invocation checks half the tree.
run("npx", ["tsc", "--noEmit"], 2);
run("npx", ["tsc", "-p", "client/tsconfig.json", "--noEmit"], 2);

say("3. clean previous output");
for (const d of [DIST, path.join(HERE, "dist")]) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}
// stray run-time files must never be packaged
for (const f of ["settings.json", "startup.log"]) {
  const p = path.join(HERE, f);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

say("4. bundle the CLI");
fs.mkdirSync(DIST, { recursive: true });
run(
  "npx",
  [
    "esbuild", "src/cli.ts",
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    // The three WASM/UMD dependencies load their own binary assets at runtime and
    // must stay external, or the bundle tries to inline a .wasm file as JavaScript.
    "--external:canvaskit-wasm", "--external:harfbuzzjs", "--external:jsts",
    "--external:opentype.js",
    `--outfile=${path.join(DIST, "nameplate-cli.mjs")}`,
  ],
  2,
);

say("4b. bundle the app: the server, and the page it serves");
run(
  "npx",
  [
    "esbuild", "src/server.ts",
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    "--external:canvaskit-wasm", "--external:harfbuzzjs", "--external:jsts",
    "--external:opentype.js",
    `--outfile=${path.join(DIST, "nameplate-app.mjs")}`,
  ],
  2,
);

say("5. stage what the bundle needs beside it");
// The externals above have to travel with the bundle, along with the fonts and the
// docs — the same "folder you can copy" shape the PowerShell build produced.
const stageDeps = ["canvaskit-wasm", "harfbuzzjs", "jsts", "opentype.js"];
for (const dep of stageDeps) {
  const from = path.join(HERE, "node_modules", dep);
  const to = path.join(DIST, "node_modules", dep);
  fs.cpSync(from, to, { recursive: true });
}
fs.cpSync(path.join(HERE, "..", "fonts"), path.join(DIST, "fonts"), { recursive: true });
// The page, already bundled by step 1's `build:client`. The server resolves it
// relative to itself, so it has to sit in a `client/` beside the .mjs.
fs.mkdirSync(path.join(DIST, "client"), { recursive: true });
for (const f of ["index.html", "app.css", "bundle.js"]) {
  fs.copyFileSync(path.join(HERE, "client", f), path.join(DIST, "client", f));
}
fs.copyFileSync(path.join(HERE, "..", "README_APP.txt"), path.join(DIST, "README.txt"));
fs.copyFileSync(path.join(HERE, "..", "INSTALL.txt"), path.join(DIST, "INSTALL.txt"));
if (fs.existsSync(path.join(HERE, "assets", "build_manifest.json"))) {
  fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(HERE, "assets", "build_manifest.json"),
    path.join(DIST, "assets", "build_manifest.json"),
  );
}

say("6. prove the freshly built bundle works");
// The PowerShell original ran the exe's own --selftest here and refused to package
// if it failed. The equivalent for a CLI bundle is to make it produce the
// documented artwork and check the line it prints.
const proofDir = path.join(DIST, "_buildcheck");
const proof = execFileSync(
  process.execPath,
  [
    path.join(DIST, "nameplate-cli.mjs"),
    "--font", path.join(DIST, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf"),
    "--height", "1", "--unit", "in", "--basis", "cap",
    "--format", "both", "--mode", "per-name", "--out", proofDir, "ADAM",
  ],
  { cwd: DIST, encoding: "utf8" },
);
const wanted = "ADAM: 4.069 x 1.020 in  |  6 cut contour(s), 10 engrave line(s)";
console.log(`    ${proof.split("\n")[0]}`);
if (!proof.includes(wanted)) {
  throw new Error(`the built bundle did not produce the documented numbers\n  want: ${wanted}`);
}
for (const f of ["ADAM.svg", "ADAM.pdf"]) {
  const p = path.join(proofDir, f);
  if (!fs.existsSync(p) || fs.statSync(p).size < 1000) {
    throw new Error(`the built bundle did not write a usable ${f}`);
  }
}
fs.rmSync(proofDir, { recursive: true, force: true });

say("6b. prove the bundled app serves the page and measures a name");
{
  const proc = spawn(process.execPath, [path.join(DIST, "nameplate-app.mjs"), "--port", "0"],
    { cwd: DIST, stdio: ["ignore", "pipe", "pipe"] });
  try {
    // The server prints the URL it bound to; that line is also the readiness signal,
    // so there is nothing to poll and no sleep to guess at.
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      proc.stdout.on("data", (c: Buffer) => {
        buf += c.toString();
        const m = /open (http:\/\/127\.0\.0\.1:\d+)\//.exec(buf);
        if (m) resolve(m[1]);
      });
      proc.on("exit", (code) => reject(new Error(`the app exited before serving (${code})`)));
      setTimeout(() => reject(new Error("the app did not start within 60s")), 60_000);
    });
    const page = await fetch(`${line}/`).then((r) => r.text());
    if (!page.includes('id="root"')) throw new Error("the bundled app did not serve the page");
    const built = await fetch(`${line}/api/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: path.join(DIST, "fonts", "MerriweatherCut3Black-Engrave-v2.ttf"),
        text: "ADAM", height: 1, unit: "in", basis: "cap",
      }),
    }).then((r) => r.json());
    console.log(`    ${built.size_label}  |  ${built.count_label}`);
    if (built.size_label !== "ADAM — 4.069 × 1.020 in" ||
      built.count_label !== "6 cut contours, 10 engrave lines") {
      throw new Error("the bundled app did not produce the documented numbers");
    }
  } finally {
    proc.kill();
  }
}

say("7. portable archive");
fs.mkdirSync(path.join(HERE, "dist"), { recursive: true });
const archive = path.join(HERE, "dist", "nameplate-ts.tar.gz");
run("tar", ["-czf", archive, "-C", path.dirname(DIST), path.basename(DIST)], 1);

say("done");
for (const f of [archive]) {
  if (fs.existsSync(f)) {
    const mb = fs.statSync(f).size / 1024 / 1024;
    console.log(`  ${f.padEnd(58)} ${mb.toFixed(1)} MB`);
  }
}

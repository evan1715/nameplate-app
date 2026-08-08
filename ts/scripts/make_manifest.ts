#!/usr/bin/env node
/**
 * make_manifest.ts — stamp the build so a shipped bundle can prove which code it is.
 *
 *     node scripts/make_manifest.ts        # writes assets/build_manifest.json
 *
 * There is no git in the original project, so "which version is on that shop PC?"
 * had no answer: two builds with the same file size could differ by a fix, and a
 * bug report could not be tied to code. This writes a content hash of every source
 * file that goes into the build, plus the dependency versions, into a JSON file the
 * bundler ships. The app shows it under "Health check" and prints it in a selftest,
 * so the answer comes from the build itself rather than from someone's memory.
 *
 * Run by {@link ../scripts/build_all.ts} before bundling. Safe to run by hand.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(HERE, "..");
const OUT = path.join(HERE, "assets", "build_manifest.json");

/**
 * Everything whose content changes behaviour. Docs and tests are deliberately
 * included: a build whose README disagrees with its code is a build worth telling
 * apart.
 *
 * Paths are relative to the `ts/` directory, except the two shipped text files,
 * which live at the repository root.
 */
const SOURCES = [
  // the engine
  "src/skia.ts", "src/geom.ts", "src/pyformat.ts", "src/units.ts", "src/font.ts",
  "src/core.ts", "src/layout.ts", "src/leadin.ts", "src/exporters.ts",
  "src/eyelets.ts", "src/cli.ts",
  // the entry points, which are the only files that decide what a command does
  "src/bin/cli.ts", "src/bin/brief.ts", "src/bin/fontcheck.ts", "src/bin/server.ts",
  // the measurement tools
  "src/thickness.ts", "src/fontcheck.ts", "src/pairsheet.ts", "src/brief.ts",
  // the app: the window minus the widgets, and the widgets
  "src/viewmodel.ts", "src/app.ts", "src/marks.ts", "src/pairgrid.ts",
  "src/server.ts",
  "client/index.html", "client/app.css", "client/src/main.tsx",
  "client/src/App.tsx", "client/src/Preview.tsx", "client/src/PairSheet.tsx",
  "client/src/widgets.tsx", "client/src/api.ts",
  // the suites, because a build whose tests disagree with its code is worth
  // telling apart from one whose tests do not
  "tests/acceptance.ts", "tests/export.ts", "tests/parity.ts", "tests/gui.ts",
  "tests/regression.ts", "tests/stress.ts", "tests/thickness.ts",
  "tests/fontcheck.ts", "tests/pairsheet.ts", "tests/brief.ts",
  "tests/viewmodel.ts", "tests/canonicalisation.ts",
  "../README_APP.txt", "../INSTALL.txt",
] as const;

/**
 * Dependencies whose version changes what the app produces, so they belong in the
 * stamp. React is here for the same reason the client sources are: it decides what
 * the person in front of the window actually sees.
 */
const DEPS = ["harfbuzzjs", "canvaskit-wasm", "jsts", "opentype.js", "typescript",
  "react", "react-dom", "esbuild"] as const;

/** sha256 of a file's bytes, or null when it cannot be read. */
function sha(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/** Everything that goes into `assets/build_manifest.json`. */
export interface Manifest {
  app: string;
  /** One short id that changes whenever any source file changes. */
  build_id: string;
  built_utc: string;
  built_on: string;
  node: string;
  platform: string;
  dependencies: Record<string, string>;
  /** Source file → first 16 hex digits of its sha256. */
  sources: Record<string, string>;
  fonts_shipped: { file: string; sha256_16: string }[];
}

/** Collect the manifest without writing it. */
export function build(): Manifest {
  const files: Record<string, string> = {};
  for (const name of SOURCES) {
    const h = sha(path.join(HERE, name));
    // strip the "../" so the key names the shipped file, as the Python does
    if (h) files[name.replace(/^\.\.\//, "")] = h.slice(0, 16);
  }

  // one number that changes whenever any of them changes
  const joined = Object.keys(files)
    .sort()
    .map((k) => `${k}:${files[k]}`)
    .join("");
  const buildId = createHash("sha256").update(joined).digest("hex").slice(0, 12);

  const deps: Record<string, string> = {};
  for (const mod of DEPS) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(HERE, "node_modules", mod, "package.json"), "utf8"),
      );
      deps[mod] = pkg.version ?? "?";
    } catch {
      deps[mod] = "(not installed)";
    }
  }

  const fontsShipped: { file: string; sha256_16: string }[] = [];
  const fdir = path.join(REPO, "fonts");
  if (fs.existsSync(fdir) && fs.statSync(fdir).isDirectory()) {
    for (const f of fs.readdirSync(fdir).sort()) {
      if (/\.(ttf|otf|ttc)$/i.test(f)) {
        fontsShipped.push({ file: f, sha256_16: (sha(path.join(fdir, f)) ?? "").slice(0, 16) });
      }
    }
  }

  return {
    app: "Sean's Font Prototyping Friend",
    build_id: buildId,
    built_utc: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z"),
    built_on: os.hostname(),
    node: process.versions.node,
    platform: `${os.type()}-${os.release()}-${os.arch()}`,
    dependencies: deps,
    sources: files,
    fonts_shipped: fontsShipped,
  };
}

/** Write `assets/build_manifest.json` and report it. */
export function main(): number {
  const man = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(man, null, 2), "utf8");
  console.log(
    `build ${man.build_id} (${Object.keys(man.sources).length} sources, ` +
      `${man.fonts_shipped.length} fonts) -> ${OUT}`,
  );
  return 0;
}

if (import.meta.url.endsWith(path.basename(process.argv[1] ?? ""))) {
  process.exit(main());
}

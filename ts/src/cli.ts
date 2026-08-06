#!/usr/bin/env node
/**
 * cli.ts — command line front end for the engine.
 *
 * Exists so the engine can be tested without a GUI, and so the same logic can be
 * scripted for a batch of orders. Any front end must call the same functions.
 *
 *     npx tsx src/cli.ts --font "MerriweatherCut3Black-Engrave-v2.ttf" \
 *         --height 1 --unit in --basis cap --format both --mode per-name \
 *         --out ./out ADAM OLIVIA "MARY JANE"
 *
 *     npx tsx src/cli.ts --font Carrie.otf --height 25 --unit mm \
 *         --mode sheet --arrange horizontal --format svg --out ./out \
 *         --names-file names.txt
 *
 * Every ordinary mistake — a typo'd path, a file that is not a font, a height that
 * cannot be drawn — answers with one line and a non-zero exit, never a stack
 * trace. A batch of real orders is usually driven by a script or handed to an
 * operator, and neither can act on a stack trace. Nothing is written until the
 * whole job is known to be sound, so a refusal never leaves half an order on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Font } from "./font.ts";
import {
  buildDocument,
  safeFilename,
  summary,
  ValueError,
  type Basis,
  type Unit,
  type Document,
} from "./core.ts";
import { exportPdf, exportSvg } from "./exporters.ts";
import { DIRECTIONS, overlaps, VERTICAL, type Direction } from "./layout.ts";
import { initSkia } from "./skia.ts";
import { pyG } from "./pyformat.ts";

/**
 * Below this the 4-decimal numbers in the SVG/PDF all round to 0.0000, so the file
 * would look like a success and contain no artwork at all.
 */
const MIN_HEIGHT: Record<Unit, number> = { in: 0.001, mm: 0.03 };

/** The exit code argparse itself uses for bad usage. */
const BAD_INPUT = 2;

/** Refuse the job: one line the operator can act on, on stderr. */
function fail(msg: string): number {
  process.stderr.write(msg + "\n");
  return BAD_INPUT;
}

/**
 * Why this height cannot be drawn, or null.
 *
 * Checked before anything is built, because every one of these values reaches the
 * exporter as a divisor or as literal text: inf/nan end up inside width="..." and
 * /MediaBox, 0 raises deep in the exporter, and a hair-width height writes a file
 * whose every coordinate has rounded to zero.
 */
export function heightProblem(height: number, unit: Unit): string | null {
  if (!Number.isFinite(height)) {
    return Number.isNaN(height)
      ? "--height nan is not a number — give the finished height."
      : "--height must be a real size, not infinity.";
  }
  if (height === 0) return "--height 0 has no size — give the finished height of the name.";
  if (height < 0) return `--height must be positive — ${pyG(height)} is negative.`;
  const floor = MIN_HEIGHT[unit];
  if (height < floor) {
    return (
      `--height ${pyG(height)} ${unit} is too small to export — ` +
      `the artwork would round away to nothing. ` +
      `The smallest usable height is ${pyG(floor)} ${unit}.`
    );
  }
  return null;
}

/** Names from a text file. A folder or a binary file is a typo, not a crash. */
function namesFromFile(p: string): { names: string[]; problem: string | null } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch (e: any) {
    return { names: [], problem: `--names-file ${p} cannot be read: ${e.code ?? e.message}.` };
  }
  if (stat.isDirectory()) {
    return { names: [], problem: `--names-file ${p} is a folder, not a text file.` };
  }
  let text: string;
  try {
    const raw = fs.readFileSync(p);
    // A NUL byte means this is not text; Python raises UnicodeDecodeError here.
    if (raw.includes(0)) {
      return {
        names: [],
        problem:
          `--names-file ${p} is not text — it looks like a binary ` +
          `file. Save it as plain UTF-8, one name per line.`,
      };
    }
    text = raw.toString("utf8").replace(/^﻿/, ""); // utf-8-sig
  } catch (e: any) {
    return { names: [], problem: `--names-file ${p} cannot be read: ${e.code ?? e.message}.` };
  }
  const names = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l);
  if (names.length === 0) return { names: [], problem: `--names-file ${p} contains no names.` };
  return { names, problem: null };
}

/**
 * The font checker's own defect report, so the user learns WHY a font failed.
 *
 * Imported lazily rather than at the top, exactly as the Python does: the checker
 * is a convenience, and a missing or broken module must not turn a clear font
 * error into an import crash.
 *
 * Loaded lazily: the defect detector pulls in the whole geometry stack, and a CLI
 * run that never hits a bad font should not pay for it.
 */
async function fontReport(p: string): Promise<string> {
  try {
    const fc = await import("./fontcheck.ts");
    return fc.checkFont(p, { joinScanBudget: 0 }).text();
  } catch {
    return "";
  }
}

/** (font, problem). The cheap checks come first so the message is specific. */
async function loadFont(p: string): Promise<{ font: Font | null; problem: string | null }> {
  if (!p.trim()) {
    return { font: null, problem: "--font is empty — give the path to a .ttf or .otf file." };
  }
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(p);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) {
    return { font: null, problem: `--font ${p} is a folder, not a font file.` };
  }
  if (!stat?.isFile()) return { font: null, problem: `--font ${p} does not exist.` };
  if (stat.size === 0) {
    return { font: null, problem: `--font ${p} is empty (0 bytes) — the copy failed.` };
  }
  try {
    return { font: new Font(p), problem: null };
  } catch (exc: any) {
    const report = await fontReport(p);
    return {
      font: null,
      problem:
        `--font ${p} is not a font this app can use ` +
        `(${exc?.name ?? "Error"}: ${exc?.message ?? exc}).` +
        (report ? `\n\n${report}` : ""),
    };
  }
}

/** Problem creating the output folder, or null. */
function makeOutDir(p: string): string | null {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e: any) {
    if (e.code === "EEXIST") return `--out ${p} is an existing file, not a folder.`;
    return `--out ${p} cannot be created: ${e.code ?? e.message}.`;
  }
  if (!fs.statSync(p).isDirectory()) {
    return `--out ${p} is an existing file, not a folder.`;
  }
  return null;
}

/** SVG is text, PDF is bytes; both may fail on a folder we cannot write. */
function write(p: string, data: string | Uint8Array): void {
  if (typeof data === "string") fs.writeFileSync(p, data, "utf8");
  else fs.writeFileSync(p, data);
}

/** Everything the command line can set. */
interface Args {
  names: string[];
  namesFile?: string;
  font?: string;
  height?: number;
  unit: Unit;
  basis: Basis;
  format: "svg" | "pdf" | "both";
  mode: "per-name" | "sheet";
  arrange: Direction;
  gap: number;
  out: string;
}

/** A usage error, reported the way argparse reports one. */
class UsageError extends Error {}

/**
 * Parse argv the way the Python `argparse` setup does, including its choices and
 * its "required" flags.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    names: [], unit: "in", basis: "cap", format: "both", mode: "per-name",
    arrange: VERTICAL, gap: 0.25, out: ".",
  };
  const need = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) throw new UsageError(`argument ${flag}: expected one argument`);
    return argv[i + 1];
  };
  const choice = <T extends string>(flag: string, v: string, allowed: readonly T[]): T => {
    if (!(allowed as readonly string[]).includes(v)) {
      throw new UsageError(
        `argument ${flag}: invalid choice: '${v}' (choose from ${allowed.map((c) => `'${c}'`).join(", ")})`,
      );
    }
    return v as T;
  };
  const number = (flag: string, v: string): number => {
    // Python's float() accepts "nan"/"inf"; the height checks depend on that, so
    // do not reject them here.
    const n = Number(v);
    if (v.trim() === "" || (Number.isNaN(n) && !/^[-+]?(nan)$/i.test(v.trim()))) {
      throw new UsageError(`argument ${flag}: invalid float value: '${v}'`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--names-file": args.namesFile = need(i, a); i++; break;
      case "--font": args.font = need(i, a); i++; break;
      case "--height": args.height = number(a, need(i, a)); i++; break;
      case "--unit": args.unit = choice(a, need(i, a), ["in", "mm"] as const); i++; break;
      case "--basis":
        args.basis = choice(a, need(i, a), ["cap", "xheight", "total"] as const);
        i++; break;
      case "--format":
        args.format = choice(a, need(i, a), ["svg", "pdf", "both"] as const); i++; break;
      case "--mode":
        args.mode = choice(a, need(i, a), ["per-name", "sheet"] as const); i++; break;
      case "--arrange": args.arrange = choice(a, need(i, a), DIRECTIONS); i++; break;
      case "--gap": args.gap = number(a, need(i, a)); i++; break;
      case "--out": args.out = need(i, a); i++; break;
      default:
        if (a.startsWith("--")) throw new UsageError(`unrecognized arguments: ${a}`);
        args.names.push(a);
    }
  }
  if (args.font === undefined) {
    throw new UsageError("the following arguments are required: --font");
  }
  if (args.height === undefined) {
    throw new UsageError("the following arguments are required: --height");
  }
  return args;
}

/**
 * Run the CLI.
 * @param argv arguments after the program name
 * @returns the process exit code
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e: any) {
    process.stderr.write(`nameplate-cli: error: ${e.message}\n`);
    return BAD_INPUT;
  }

  await initSkia();

  const problem0 = heightProblem(args.height!, args.unit);
  if (problem0) return fail(problem0);

  // the gap goes straight into geometry, so inf/nan poisons the file the same way
  // a bad height would — same rule, same wording
  if (!Number.isFinite(args.gap)) {
    return fail(`--gap must be a real size, not ${args.gap}.`);
  }
  if (args.gap > 1000) {
    return fail(
      `--gap ${pyG(args.gap)} ${args.unit} is bigger than any sheet ` +
        `— give the spacing between names.`,
    );
  }

  const names = [...args.names];
  if (args.namesFile) {
    const { names: fromFile, problem } = namesFromFile(args.namesFile);
    if (problem) return fail(problem);
    names.push(...fromFile);
  }
  if (names.length === 0) {
    process.stderr.write("nameplate-cli: error: no names given\n");
    return BAD_INPUT;
  }

  const { font, problem: fontProblem } = await loadFont(args.font!);
  if (fontProblem) return fail(fontProblem);
  const outProblem = makeOutDir(args.out);
  if (outProblem) return fail(outProblem);

  const docs: Document[] = [];
  for (const name of names) {
    // Spaces and zero-width characters shape happily and cut nothing; left in the
    // list they take a slot on the sheet and break stacking. The engine refuses
    // them with a message of its own, so honour both that refusal and a document
    // that simply came back with no contours — one bad line in a batch must not
    // cost the operator the other orders.
    let doc: Document;
    try {
      doc = buildDocument(font!, name, args.height!, args.unit, args.basis);
    } catch (exc) {
      if (exc instanceof ValueError) {
        process.stderr.write(
          `! skipped '${name}' — the engine refused it: ${exc.message}\n`,
        );
        continue;
      }
      throw exc;
    }
    if (doc.cutPaths.reduce((n, r) => n + r.length, 0) === 0) {
      process.stderr.write(
        `! skipped '${name}' — no cuttable outline (blank or invisible characters only).\n`,
      );
      continue;
    }
    docs.push(doc);
    process.stdout.write(summary(doc) + "\n");
    for (const w of doc.warnings) process.stdout.write(`    ! ${w}\n`);
  }
  if (docs.length === 0) {
    return fail("None of the names given produce any artwork — nothing to write.");
  }

  const written: string[] = [];
  try {
    if (args.mode === "sheet") {
      // the boxes are known before any geometry is placed, so a gap that would
      // print one name on top of another is refused, not exported
      const clash = overlaps(docs, args.gap, args.arrange);
      if (clash.length) {
        const pairs = clash
          .slice(0, 4)
          .map(([i, j]) => `'${docs[i].text}'+'${docs[j].text}'`)
          .join(", ");
        return fail(
          `--gap ${pyG(args.gap)} ${args.unit} makes these names ` +
            `overlap on the sheet: ${pairs}. Nothing written — increase the gap.`,
        );
      }
      const stem = path.join(args.out, "sheet");
      // exporters.ts writes in CUTTING order — engrave, then the inner holes, then
      // the outline last — and gives each name its own group (SVG) or layer (PDF).
      // Writing through the core writers instead would produce a file that cuts
      // the outline first and drops the part before the rest of the job is done.
      if (args.format === "svg" || args.format === "both") {
        write(stem + ".svg", exportSvg(docs, args.gap, args.arrange));
        written.push(stem + ".svg");
      }
      if (args.format === "pdf" || args.format === "both") {
        write(stem + ".pdf", exportPdf(docs, args.gap, args.arrange));
        written.push(stem + ".pdf");
      }
    } else {
      const used = new Set<string>();
      for (const d of docs) {
        const base = safeFilename(d.text);
        let stem = base;
        let n = 1;
        // '!' and '?' both clean to '_', and every CJK name cleans to '__';
        // without this the second order overwrites the first. Case-insensitive
        // because Windows filenames are.
        while (used.has(stem.toLowerCase())) {
          n += 1;
          stem = `${base}_${n}`;
        }
        used.add(stem.toLowerCase());
        const full = path.join(args.out, stem);
        if (args.format === "svg" || args.format === "both") {
          write(full + ".svg", exportSvg([d], args.gap, args.arrange));
          written.push(full + ".svg");
        }
        if (args.format === "pdf" || args.format === "both") {
          write(full + ".pdf", exportPdf([d], args.gap, args.arrange));
          written.push(full + ".pdf");
        }
      }
    }
  } catch (e: any) {
    if (e?.code) return fail(`Cannot write ${e.path ?? args.out}: ${e.code}.`);
    throw e;
  }

  for (const p of written) process.stdout.write(`wrote ${p}\n`);
  return 0;
}

// Run only when invoked directly, so the tests can import `main` instead.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(await main());
}

/**
 * app.ts — everything `nameplate_gui.py`'s window does that is not a widget.
 *
 * WHERE THE SEAM IS
 *   `viewmodel.ts` owns one preview build: the paths, the numbers and the label
 *   strings. This module owns the rest of the application around it — settings,
 *   the health surface, the export jobs, the prompt blocks, the report texts and
 *   the mark styling. Between the two, every assertion in the Python's
 *   `--selftest` has somewhere to live that is not a toolkit.
 *
 *   The split matters because a browser cannot do half of this: reading a font
 *   off disk, writing a zip, persisting settings next to the app. Those run on
 *   the server (`server.ts`); the client asks for them over HTTP and draws the
 *   answers. So this file is deliberately Node-only, and deliberately free of
 *   anything that assumes a DOM.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   Anything the toolkit alone decided: window geometry, focus order, the
 *   stylesheet, the debounce timer. Those are the client's business, and none of
 *   them is asserted on.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { Document, buildDocument, pyRepr, safeFilename } from "./core.ts";
import { Font } from "./font.ts";
import * as EY from "./eyelets.ts";
import * as FC from "./fontcheck.ts";
import * as PS from "./pairsheet.ts";
import * as TH from "./thickness.ts";
import * as LAY from "./layout.ts";
import * as EX from "./exporters.ts";
import { fmtF, pyG } from "./pyformat.ts";
// Re-exported so this module stays the one place the application layer is
// reached from, while the browser can import the pure half on its own.
export {
  CUT_COLOUR, ENGRAVE_COLOUR, EYE_DIM, EYE_TARGET_ID, EYE_TARGET_OD, LEAD_COLOUR,
  NEON, NEON_HOVER, NEON_PRESS, THIN_OK, THIN_RAMP, THIN_TARGET, thinColour, thinLabel,
} from "./marks.ts";

export const APP_NAME = "Sean's Font Prototyping Friend";
export const FONT_EXTS = [".ttf", ".otf", ".ttc"];

// The height floors, from the one module that owns the fixed numbers.
export { MIN_IN, MIN_MM } from "./units.ts";

// --------------------------------------------------------------------------- //
//  where things live
// --------------------------------------------------------------------------- //

/**
 * The folder fonts/ and settings.json sit next to.
 *
 * SPEC.md §6: both must be writable and must travel with the app, so this is the
 * app root, never wherever the module happens to have been imported from. In the
 * Python that meant `sys.executable` when frozen; here it is the package root,
 * one level up from `src/`.
 */
export const BASE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const FONTS_DIR = path.join(BASE, "fonts");
export const SETTINGS_PATH = path.join(BASE, "settings.json");

// --------------------------------------------------------------------------- //
//  settings — plain JSON next to the app, so the folder stays portable
// --------------------------------------------------------------------------- //

/** Everything the window remembers between runs. Every field optional. */
export interface Settings {
  font_path?: string;
  unit?: string;
  basis?: string;
  names?: string;
  direction?: string;
  height?: number;
  gap?: number;
  lead_len?: number;
  lead_clear?: number;
  eye_target_id?: number;
  eye_target_wall?: number;
  lead_in?: boolean;
  formats?: string[];
  eye_show_dims?: boolean;
  eye_show_want?: boolean;
}

/** The type each key is allowed to be, mirroring the Python's `_SETTING_TYPES`. */
const SETTING_TYPES: Record<string, "string" | "number" | "boolean" | "array"> = {
  font_path: "string", unit: "string", basis: "string", names: "string",
  direction: "string",
  height: "number", gap: "number",
  lead_len: "number", lead_clear: "number",
  eye_target_id: "number", eye_target_wall: "number",
  lead_in: "boolean", formats: "array",
  eye_show_dims: "boolean", eye_show_want: "boolean",
};

/**
 * settings.json, with every value type-checked.
 *
 * The file is external data — hand-edited, synced between PCs, or corrupted. A
 * `{"font_path": 123}` used to poison the font list until Refresh, because the
 * value went straight into path calls. A wrongly-typed value is dropped and the
 * default takes over; the rest of the file still loads.
 *
 * JavaScript has no `bool is a subclass of int` trap, but it has its own: `typeof
 * null === "object"` and `typeof [] === "object"`, so "is this a plain value of
 * the declared kind" has to be asked explicitly rather than with one `typeof`.
 */
export function loadSettings(file = SETTINGS_PATH): Settings {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const want = SETTING_TYPES[k];
      if (!want) {
        out[k] = v; // an unknown key is someone else's; carry it through untouched
        continue;
      }
      if (want === "array") {
        if (Array.isArray(v)) out[k] = v;
      } else if (want === "number") {
        // NaN and Infinity cannot come out of JSON.parse, so `typeof` is enough
        if (typeof v === "number") out[k] = v;
      } else if (typeof v === want) {
        out[k] = v;
      }
    }
    return out as Settings;
  } catch {
    return {};
  }
}

/** Write settings.json. A read-only folder must not break the app. */
export function saveSettings(data: Settings, file = SETTINGS_PATH): void {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    /* deliberate: losing a preference is not worth an error dialog */
  }
}

// --------------------------------------------------------------------------- //
//  health surface
// --------------------------------------------------------------------------- //

/** What this build was made from, or `{}` when running from source. */
export function buildManifest(): Record<string, any> {
  for (const base of [BASE, path.join(BASE, "ts")]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(base, "assets", "build_manifest.json"), "utf-8"));
    } catch {
      continue;
    }
  }
  return {};
}

/** Where the startup log goes, or "" when nowhere is writable. */
export function logPath(): string {
  for (const folder of [BASE, process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "SeansFontPrototypingFriend") : ""]) {
    if (!folder) continue;
    try {
      fs.mkdirSync(folder, { recursive: true });
      const p = path.join(folder, "startup.log");
      fs.appendFileSync(p, "");
      return p;
    } catch {
      continue;
    }
  }
  return "";
}

/** Everything worth knowing when something is wrong on someone's machine. */
export function healthReport(): string {
  const man = buildManifest();
  const L: string[] = [APP_NAME, "=".repeat(APP_NAME.length), ""];
  if (Object.keys(man).length) {
    L.push(`build            ${man.build_id ?? "?"}`);
    L.push(`built            ${man.built_utc ?? "?"} on ${man.built_on ?? "?"}`);
    L.push(`built with       Node ${man.node ?? "?"}`);
    const deps: Record<string, string> = man.dependencies ?? {};
    if (Object.keys(deps).length) {
      L.push("dependencies     " +
        Object.entries(deps).map(([k, v]) => `${k} ${v}`).join(", "));
    }
  } else {
    L.push("build            (running from source - no manifest)");
  }
  L.push("",
    `frozen exe       false`,
    `running from     ${BASE}`,
    `fonts folder     ${FONTS_DIR}`,
    `settings file    ${SETTINGS_PATH}`,
    `startup log      ${logPath()}`,
    `node now         ${process.versions.node}`,
    "");

  // the things that actually go wrong on a shop PC
  const checks: [string, boolean][] = [];
  checks.push(["fonts folder exists", fs.existsSync(FONTS_DIR) && fs.statSync(FONTS_DIR).isDirectory()]);
  let n = 0;
  try {
    n = fs.readdirSync(FONTS_DIR)
      .filter((f) => FONT_EXTS.some((e) => f.toLowerCase().endsWith(e))).length;
  } catch {
    n = 0;
  }
  checks.push([`fonts present (${n})`, n > 0]);
  let writable = false;
  try {
    const probe = path.join(BASE, ".write_probe");
    fs.writeFileSync(probe, "x", "utf-8");
    fs.unlinkSync(probe);
    writable = true;
  } catch {
    /* not writable; the check below says so */
  }
  checks.push(["app folder is writable", writable]);
  checks.push(["path length under 240 chars", BASE.length < 240]);
  L.push("CHECKS");
  for (const [label, ok] of checks) L.push(`  [${ok ? "ok" : "PROBLEM"}] ${label}`);

  if (man.fonts_shipped) {
    L.push("", "FONTS THIS BUILD SHIPPED WITH");
    for (const f of man.fonts_shipped as Record<string, string>[]) {
      L.push(`  ${f.sha256_16 ?? "?"}  ${f.file ?? "?"}`);
    }
  }
  return L.join("\n");
}

/** Make sure a writable fonts/ exists next to the app. */
export function ensureFontsDir(): void {
  try {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
  } catch {
    /* nothing to do — healthReport reports it */
  }
}

// --------------------------------------------------------------------------- //
//  export jobs
// --------------------------------------------------------------------------- //

/** One export the user asked for. Mirrors the Python dataclass field for field. */
export interface ExportJob {
  /** "per-name" (a zip of one file per name) | "sheet" (one file, all names). */
  kind: string;
  font_path: string;
  names: string[];
  height: number;
  unit: string;
  basis: string;
  /** ["svg"], ["pdf"], or both. */
  formats: string[];
  gap: number;
  /** Zip path for per-name, or the stem (no extension) for a sheet. */
  dest: string;
  /** Add laser lead-in lines. */
  lead_in?: boolean;
  /** Lead-in length, in `unit`. */
  lead_len?: number;
  /** Standoff from letters, in `unit`. */
  lead_clear?: number;
  /** Sheet layout: "vertical" | "horizontal". */
  direction?: string;
}

/** How far an export has got, for the progress bar. */
export type Progress = (done: number, total: number, label: string) => void;

/**
 * Run one export job to completion and return the paths written.
 *
 * Synchronous on purpose. The Python ran this on its own QThread only because a
 * frozen Qt window must keep painting; the server answers one request at a time
 * on its own process and the client stays responsive regardless.
 *
 * @throws when a sheet's names would overlap at the requested gap — refusing is
 * the point, since the alternative is silently welding two names together.
 */
export function runExport(job: ExportJob, onProgress?: Progress): string[] {
  const font = new Font(job.font_path);
  const total = job.names.length + 1;
  const docs: Document[] = [];
  for (let i = 0; i < job.names.length; i++) {
    onProgress?.(i, total, job.names[i]);
    docs.push(buildDocument(font, job.names[i], job.height,
      job.unit as any, job.basis as any));
  }
  onProgress?.(job.names.length, total, "writing files");

  const lead = job.lead_in ? (job.lead_len ?? 0) : null;
  const clr = job.lead_clear || null;
  const direction = (job.direction ?? LAY.VERTICAL) as LAY.Direction;
  const written: string[] = [];

  if (job.kind === "sheet") {
    const stem = job.dest;
    const clash = LAY.overlaps(docs, job.gap, direction);
    if (clash.length) {
      const names = clash.slice(0, 4)
        .map(([i, j]) => `${pyRepr(docs[i].text)}+${pyRepr(docs[j].text)}`).join(", ");
      throw new Error(
        `With this gap the names would overlap on the sheet (${names}). ` +
        `Increase the sheet gap.`);
    }
    // exporters.ts writes in CUTTING order — engrave, then the inner holes, then
    // the outline last, per name — and gives each name its own SVG group / PDF
    // layer.
    if (job.formats.includes("svg")) {
      const p = stem + ".svg";
      fs.writeFileSync(p, EX.exportSvg(docs, job.gap, direction, lead, clr), "utf-8");
      written.push(p);
    }
    if (job.formats.includes("pdf")) {
      const p = stem + ".pdf";
      fs.writeFileSync(p, EX.exportPdf(docs, job.gap, direction, lead, clr));
      written.push(p);
    }
  } else {
    const used = new Map<string, number>();
    const entries: [string, Uint8Array][] = [];
    for (const doc of docs) {
      let stem = safeFilename(doc.text);
      const n = (used.get(stem.toLowerCase()) ?? 0) + 1;
      used.set(stem.toLowerCase(), n);
      if (n > 1) stem = `${stem}_${n}`; // two identical lines
      if (job.formats.includes("svg")) {
        entries.push([stem + ".svg",
          new TextEncoder().encode(EX.exportSvg([doc], job.gap, direction, lead, clr))]);
      }
      if (job.formats.includes("pdf")) {
        entries.push([stem + ".pdf", EX.exportPdf([doc], job.gap, direction, lead, clr)]);
      }
    }
    fs.writeFileSync(job.dest, zip(entries));
    written.push(job.dest);
  }
  onProgress?.(total, total, "done");
  return written;
}

/**
 * A DEFLATE-compressed zip, written by hand.
 *
 * Node ships the compressor but no archiver, and the alternative is a dependency
 * whose whole job is 60 lines of header. The format written is the one every
 * unzipper accepts and the one Python's `zipfile` with `ZIP_DEFLATED` produces:
 * local header + deflate stream per entry, then a central directory.
 *
 * Deliberately NOT zip64 and not writing a data descriptor: the sizes are all
 * known before the header is written, and a cut file that needed 4 GB would have
 * gone wrong long before it got here.
 *
 * The timestamp is fixed rather than "now" so the same names and font produce the
 * same bytes twice — a zip that differs every run cannot be diffed against a
 * reference.
 */
export function zip(entries: readonly [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  // MS-DOS packed date/time: 1980-01-01 00:00:00, the zip epoch.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  for (const [name, body] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const deflated = new Uint8Array(deflateRawSync(body));
    const crc = crc32(body);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed: 2.0 (deflate)
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 8, true); // method: deflate
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, deflated.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length

    const head = new Uint8Array(local.buffer);
    chunks.push(head, nameBytes, deflated);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); // central directory header signature
    cen.setUint16(4, 20, true); // version made by
    cen.setUint16(6, 20, true); // version needed
    cen.setUint16(8, 0, true);
    cen.setUint16(10, 8, true);
    cen.setUint16(12, DOS_TIME, true);
    cen.setUint16(14, DOS_DATE, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, deflated.length, true);
    cen.setUint32(24, body.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true); // relative offset of local header
    central.push(new Uint8Array(cen.buffer), nameBytes);

    offset += head.length + nameBytes.length + deflated.length;
  }

  const centralBytes = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes.length, true);
  end.setUint32(16, offset, true);
  return concat([...chunks, centralBytes, new Uint8Array(end.buffer)]);
}

/** CRC-32 (IEEE), as the zip central directory records it. */
function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
let CRC_TABLE: Uint32Array | null = null;

/** One buffer from many. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --------------------------------------------------------------------------- //
//  the report texts behind the buttons
// --------------------------------------------------------------------------- //

/** Human-readable defect list for one font, or a reason it is missing. */
export function fontReportText(p: string): string {
  try {
    return FC.checkFont(p).text();
  } catch (exc) {
    return `The font checker itself failed: ${errText(exc)}`;
  }
}

/**
 * The full thin-area report for the name and height currently previewed, plus the
 * paste-ready fix when a target thickness has been typed.
 *
 * The prompt is empty without a target on purpose: with nothing to aim at there is
 * no change to ask for, and inventing one produces a repair request for a font
 * that may already be right.
 */
export function thicknessReport(
  fontPath: string,
  name: string,
  height: number,
  unit: string,
  basis: string,
  target = 0,
): { text: string; prompt: string } {
  if (!fontPath) return { text: "No font selected.", prompt: "" };
  if (!name) {
    return {
      text: "Type a name first — thickness is measured on the artwork, not the font.",
      prompt: "",
    };
  }
  const font = new Font(fontPath);
  const doc = buildDocument(font, name, height, unit as any, basis as any);
  const text = TH.reportText(doc, target || null, null, font);
  let prompt = "";
  if (target) {
    try {
      prompt = TH.claudePrompt(doc, target, fontPath, font);
    } catch (exc) {
      prompt = `(could not build the copy-paste instruction: ${errText(exc)})`;
    }
  }
  return { text, prompt };
}

/**
 * Copy a font file into `fonts/` so it travels with the app.
 *
 * The Qt window's "Add font…" opened a file dialog and copied the chosen file; a
 * browser cannot read a path, so it uploads the bytes instead and this writes
 * them. Same outcome: the font ends up in the folder, and a Refresh lists it.
 *
 * The name is reduced to its basename before use. A browser will not normally
 * send a path, but "trusted because it usually is" is how a write lands outside
 * the folder it was meant for.
 */
export function addFont(filename: string, bytes: Uint8Array): string {
  const name = path.basename(filename);
  if (!FONT_EXTS.some((e) => name.toLowerCase().endsWith(e))) {
    throw new Error(`${name} is not a .ttf, .otf or .ttc`);
  }
  ensureFontsDir();
  const dest = path.join(FONTS_DIR, name);
  fs.writeFileSync(dest, bytes);
  // Opening it is the check: a file that cannot be read is not a font this app
  // can use, and finding that out now beats finding it out in the picker.
  try {
    new Font(dest);
  } catch (exc) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${name} could not be read as a font: ${errText(exc)}`);
  }
  return dest;
}

/** Eyelet measurements for the name and height currently previewed. */
export function eyeletReportText(
  fontPath: string,
  name: string,
  height: number,
  unit: string,
  basis: string,
  targetId = 0,
  targetWall = 0,
): string {
  if (!fontPath) return "No font selected.";
  if (!name) {
    return "Type a name first. The eyelet is part of the artwork, not " +
      "of the font on its own — it is a contextual form that only " +
      "appears on the first and last letter, so there is nothing " +
      "to measure until a name is shaped.";
  }
  try {
    const doc = buildDocument(new Font(fontPath), name, height, unit as any, basis as any);
    return EY.reportText(doc, null, targetId || null, targetWall || null);
  } catch (exc) {
    return `Could not measure: ${errText(exc)}\n\n` +
      `Click “Check font” to see whether the font itself is the problem.`;
  }
}

// --------------------------------------------------------------------------- //
//  the four paste-ready prompt blocks
// --------------------------------------------------------------------------- //

/** One prompt block: its heading, a plain-English note, and the body to paste. */
export interface PromptSection {
  title: string;
  note: string;
  body: string;
}

/**
 * The four paste-ready prompt blocks. Pure computation, no widgets.
 *
 * Lives here rather than in the client so the UI and `brief.ts` cannot drift into
 * producing different prompts for the same font — that drift is exactly what the
 * Python's comment on this function warns about.
 */
export function promptSections(
  fontPath: string,
  name: string,
  height: number,
  unit: string,
  basis: string,
  thinTarget = 0,
  eyeId = 0,
  eyeWall = 0,
): PromptSection[] {
  const sections: PromptSection[] = [];
  let font: Font | null = null;
  let doc: Document | null = null;
  let docErr = "";
  try {
    font = new Font(fontPath);
    if (name) doc = buildDocument(font, name, height, unit as any, basis as any);
  } catch (exc) {
    docErr = errText(exc);
  }

  // 1. the font itself
  {
    let body = "";
    let note = "";
    try {
      const rep = FC.checkFont(fontPath);
      if (rep.errors.length || rep.warnings.length) {
        body = rep.claudePrompt();
        note = `${rep.errors.length} error(s), ${rep.warnings.length} warning(s).`;
      } else {
        note = "Checked - no errors and no warnings in this font.";
      }
    } catch (exc) {
      note = `The font check itself failed: ${errText(exc)}`;
    }
    sections.push({ title: "1. Font defects", note, body });
  }

  // 2. letter pairs
  {
    let body = "";
    let note = "";
    try {
      if (font === null) {
        note = `The font could not be opened: ${docErr}`;
      } else {
        const prep = PS.analysePairs(font);
        let bad = 0;
        for (const g of prep.groups) for (const c of g.cells.values()) if (c.problem) bad += 1;
        const untested = Math.trunc(prep.n_untested || 0);
        if (bad || untested) {
          body = PS.claudePrompt(font, prep, fontPath);
          note = `${bad} letter pair(s) do not join.`;
          if (untested) {
            note += ` ${untested} were never tested - the scan ran out ` +
              `of time, so this list may be incomplete.`;
          }
        } else {
          note = "Every letter pair joins cleanly, in every position " +
            "(whole word, first letter, middle, last letter).";
        }
      }
    } catch (exc) {
      note = `The pair scan failed: ${errText(exc)}`;
    }
    sections.push({ title: "2. Letter pairs that do not join", note, body });
  }

  // 3. thin areas
  {
    let body = "";
    let note = "";
    const target = thinTarget || 0.0;
    if (doc === null) {
      note = `Type a name first - thin areas are measured on the artwork.` +
        (docErr ? " " + docErr : "");
    } else if (!target) {
      note = "Type a wanted thickness in “Thin areas” to get this. " +
        "Without a target there is no change to ask for.";
    } else {
      try {
        body = TH.claudePrompt(doc, target, fontPath, font);
        note = `Wanted thickness ${fmtF(target, 4)} ${unit}, measured on ` +
          `${pyRepr(name)} at ${pyG(height)} ${unit}.`;
      } catch (exc) {
        note = `Could not build it: ${errText(exc)}`;
      }
    }
    sections.push({ title: "3. Thin areas to thicken", note, body });
  }

  // 4. eyelet size
  {
    let body = "";
    let note = "";
    const tId = eyeId || null;
    const tWall = eyeWall || null;
    if (doc === null) {
      note = `Type a name first - the eyelet is a contextual form on the ` +
        `first and last letter, so it only exists once a name is ` +
        `shaped.` + (docErr ? " " + docErr : "");
    } else if (tId === null && tWall === null) {
      note = "Type a wanted inner diameter or wall in “Eyelets” to get this.";
    } else {
      try {
        body = EY.claudePrompt(doc, null, tId, tWall, fontPath);
        note = `Measured on ${pyRepr(name)} at ${pyG(height)} ${unit} ${basis} height.`;
        if (!body) note += "  No eyelet was found in this name.";
      } catch (exc) {
        note = `Could not build it: ${errText(exc)}`;
      }
    }
    sections.push({ title: "4. Eyelet size", note, body });
  }

  // The blocks OVERLAP and their fences contradict each other if pasted as a
  // batch: block 4 resizes the eyelet holes while blocks 1 and 3 forbid touching
  // them. Say so where it cannot be missed.
  if (sections[3].body) {
    for (const i of [0, 2]) {
      if (sections[i].body) {
        sections[i].body += "\n\n" +
          "EXCEPTION: a separate eyelet-size request from this " +
          "same report resizes the eyelet holes. For those holes, " +
          "that request wins over the 'do not change' rule above.";
      }
    }
  }
  return sections;
}

/** Python's `f"{type(exc).__name__}: {exc}"`. */
function errText(exc: unknown): string {
  const e = exc as Error;
  return `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}`;
}

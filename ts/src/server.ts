/**
 * server.ts — the engine behind an HTTP API, plus the client that draws it.
 *
 *     node src/server.ts [--port 8175] [--no-open]
 *
 * WHY A SERVER AT ALL
 *   The engine reads fonts off disk with HarfBuzz, unions outlines with a WASM
 *   Skia, and writes zips. None of that belongs in a browser tab, and two of the
 *   three cannot go there. So the split is the same one `viewmodel.ts` describes:
 *   this process does the measuring, the page does the drawing.
 *
 *   That is also what the PySide6 window did — a worker thread owning its own
 *   `Font` cache, with the widgets only ever seeing the finished result. The
 *   thread became a process; the signal became a fetch. The seam did not move.
 *
 * WHY IT IS DELIBERATELY BORING
 *   No framework, no middleware, no sessions. It answers a dozen routes with JSON
 *   and serves three static files. Everything worth testing is in `viewmodel.ts`
 *   and `app.ts`, both of which are tested with no server running — so this file
 *   has no logic of its own to get wrong.
 *
 * IT LISTENS ON LOOPBACK ONLY
 *   Every route reads and writes local files by absolute path. That is exactly
 *   right for a desktop app and exactly wrong for anything reachable from another
 *   machine, so the socket is bound to 127.0.0.1 and there is no flag to change
 *   it.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Font } from "./font.ts";
import { initSkia } from "./skia.ts";
import * as APP from "./app.ts";
import * as PG from "./pairgrid.ts";
import * as PS from "./pairsheet.ts";
import * as VM from "./viewmodel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(HERE, "..", "client");

/**
 * One open `Font` per path, exactly like the Qt preview worker's cache.
 *
 * Opening a font is the single most expensive thing here — several hundred
 * milliseconds on the shipped script faces — and a preview rebuild happens on
 * every keystroke. `forget` is what the Reload button needs: the whole point of
 * that button is to pick up an edit made in a font editor while the app was open,
 * which a cache would otherwise hide.
 */
const fontCache = new Map<string, Font>();

function openFont(p: string): Font {
  const hit = fontCache.get(p);
  if (hit) return hit;
  const f = new Font(p);
  fontCache.set(p, f);
  return f;
}

function forgetFont(p: string): void {
  fontCache.delete(p);
}

/** One analysed pair report per font path, so the sheet does not re-scan on zoom. */
const gridCache = new Map<string, PG.PairGrid>();

// --------------------------------------------------------------------------- //
//  routes
// --------------------------------------------------------------------------- //

/** Everything a route can be handed, already parsed. */
type Body = Record<string, any>;

/** The routes, by path. Each returns anything JSON-serialisable. */
const ROUTES: Record<string, (body: Body) => unknown> = {
  /** What the window needs before it can show anything. */
  "/api/state": () => ({
    app_name: APP.APP_NAME,
    base: APP.BASE,
    fonts_dir: APP.FONTS_DIR,
    settings_path: APP.SETTINGS_PATH,
    settings: APP.loadSettings(),
    fonts: VM.listFonts(APP.FONTS_DIR),
  }),

  /** Persist the window's preferences. Mirrors `MainWindow._persist`. */
  "/api/settings": (body) => {
    APP.saveSettings(body.settings ?? {});
    return { ok: true, path: APP.SETTINGS_PATH };
  },

  /** The font list, re-scanned. This is the Refresh button. */
  "/api/fonts": () => VM.listFonts(APP.FONTS_DIR),

  /** Open a font and check it, the way selecting one in the picker does. */
  "/api/probe": (body) => VM.probeFont(String(body.path)),

  /**
   * Re-read a font from disk and re-probe it.
   *
   * The status text is the Python's, word for word — the selftest reads it back.
   */
  "/api/reload": (body) => {
    const p = String(body.path);
    forgetFont(p);
    gridCache.delete(p);
    return {
      info: VM.probeFont(p),
      status: `Re-read ${path.basename(p)} from disk.`,
    };
  },

  /** One preview build. Everything the window shows, computed with no window. */
  "/api/build": (body) => VM.build({
    font: openFont(String(body.path)),
    text: String(body.text ?? ""),
    height: Number(body.height ?? 1),
    unit: String(body.unit ?? "in"),
    basis: String(body.basis ?? "cap"),
    leadIn: Boolean(body.lead_in),
    leadLen: Number(body.lead_len ?? 0),
    leadClear: Number(body.lead_clear ?? 0),
    thin: Boolean(body.thin),
    thinTarget: Number(body.thin_target ?? 0),
    eyeTargetId: Number(body.eye_target_id ?? 0),
    eyeTargetWall: Number(body.eye_target_wall ?? 0),
    eyeDims: Boolean(body.eye_dims),
    eyeWant: body.eye_want === undefined ? true : Boolean(body.eye_want),
  }),

  /** Write an export to disk and report what was written. */
  "/api/export": (body) => ({ written: APP.runExport(body.job as APP.ExportJob) }),

  /** The text behind one of the report buttons. */
  "/api/report": (body) => {
    const kind = String(body.kind);
    if (kind === "health") return { text: APP.healthReport() };
    if (kind === "check") return { text: APP.fontReportText(String(body.path)) };
    if (kind === "thickness") {
      return APP.thicknessReport(
        String(body.path), String(body.text ?? ""), Number(body.height ?? 1),
        String(body.unit ?? "in"), String(body.basis ?? "cap"),
        Number(body.thin_target ?? 0));
    }
    if (kind === "eyelets") {
      return {
        text: APP.eyeletReportText(
          String(body.path), String(body.text ?? ""), Number(body.height ?? 1),
          String(body.unit ?? "in"), String(body.basis ?? "cap"),
          Number(body.eye_target_id ?? 0), Number(body.eye_target_wall ?? 0)),
      };
    }
    throw new Error(`unknown report kind ${JSON.stringify(kind)}`);
  },

  /** Copy an uploaded font into `fonts/`, then hand back the refreshed list. */
  "/api/addfont": (body) => {
    const added = APP.addFont(String(body.name), Buffer.from(String(body.data), "base64"));
    return { added, fonts: VM.listFonts(APP.FONTS_DIR) };
  },

  /** The four paste-ready prompt blocks. */
  "/api/prompts": (body) => APP.promptSections(
    String(body.path), String(body.text ?? ""), Number(body.height ?? 1),
    String(body.unit ?? "in"), String(body.basis ?? "cap"),
    Number(body.thin_target ?? 0), Number(body.eye_target_id ?? 0),
    Number(body.eye_target_wall ?? 0)),

  /**
   * Analyse the letter pairs and describe the sheet.
   *
   * The cells themselves are NOT in this answer: 26 columns x 182 rows of glyph
   * outlines is megabytes, and the Python only ever painted the ones on screen.
   * `/api/pairsheet/cells` serves that window.
   */
  "/api/pairsheet": (body) => {
    const p = String(body.path);
    let grid = gridCache.get(p);
    if (!grid) {
      const font = openFont(p);
      grid = new PG.PairGrid(font, PS.analysePairs(font));
      gridCache.set(p, grid);
    }
    if (body.zoom !== undefined) grid.setZoom(Number(body.zoom));
    return {
      rows: grid.rows,
      cols: grid.cols,
      cell: grid.CELL,
      zoom: grid.zoom(),
      zooms: grid.zoomSteps(),
      width: grid.width,
      height: grid.height,
      n_flagged: grid.nFlagged(),
      flagged: grid.flaggedCells().map(([r, c]) => [r, c]),
      row_labels: grid.rows.map((_, ri) => grid!.rowLabel(ri)),
      upem: grid.font.upem,
      prompt: PS.claudePrompt(grid.font, grid.report, p),
      untested: grid.report.n_untested,
    };
  },

  /** The cells inside one viewport, ready to paint. */
  "/api/pairsheet/cells": (body) => {
    const grid = gridCache.get(String(body.path));
    if (!grid) throw new Error("no pair sheet has been analysed for this font yet");
    const out: unknown[] = [];
    const r0 = Math.max(0, Number(body.r0 ?? 0));
    const r1 = Math.min(grid.rows.length - 1, Number(body.r1 ?? 0));
    const c0 = Math.max(0, Number(body.c0 ?? 0));
    const c1 = Math.min(grid.cols.length - 1, Number(body.c1 ?? 0));
    for (let ri = r0; ri <= r1; ri++) {
      for (let ci = c0; ci <= c1; ci++) {
        out.push({ ri, ci, ...grid.cellDrawing(ri, ci), tip: grid.describe(ri, ci) });
      }
    }
    return out;
  },
};

// --------------------------------------------------------------------------- //
//  plumbing
// --------------------------------------------------------------------------- //

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res: http.ServerResponse, code: number, type: string, body: string | Uint8Array): void {
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body as any) });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // A name list is a few kB. Anything past this is not a request this app makes.
      if (size > 8 << 20) reject(new Error("request body too large"));
      else parts.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf-8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (exc) {
        reject(exc);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Hand a written export back to the browser so "Save" lands in Downloads.
 *
 * Confined to files this process wrote under the app root or the OS temp dir.
 * Without that, `?path=` is an invitation to read any file the user can read,
 * which is not a trade a local convenience is worth.
 */
function download(res: http.ServerResponse, p: string): void {
  const full = path.resolve(p);
  const roots = [APP.BASE, fs.realpathSync(tmpdir())];
  if (!roots.some((r) => full.startsWith(r + path.sep))) {
    send(res, 403, "text/plain; charset=utf-8", "outside the app folder");
    return;
  }
  if (!fs.existsSync(full)) {
    send(res, 404, "text/plain; charset=utf-8", "no such file");
    return;
  }
  const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${path.basename(full)}"`,
  });
  res.end(fs.readFileSync(full));
}

/** Serve one static file out of `client/`, refusing anything outside it. */
function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.resolve(CLIENT_DIR, rel);
  if (!full.startsWith(path.resolve(CLIENT_DIR) + path.sep)) {
    send(res, 403, "text/plain; charset=utf-8", "no");
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    send(res, 404, "text/plain; charset=utf-8", `not found: ${rel}`);
    return;
  }
  send(res, 200, MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
    fs.readFileSync(full));
}

/** Start listening. Exported so a test can drive the API without a shell. */
export async function serve(port = 8175): Promise<http.Server> {
  await initSkia();
  APP.ensureFontsDir();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void (async () => {
      try {
        if (url.pathname === "/api/download") {
          download(res, url.searchParams.get("path") ?? "");
          return;
        }
        const route = ROUTES[url.pathname];
        if (route) {
          const body = req.method === "POST" ? await readBody(req) : {};
          send(res, 200, "application/json; charset=utf-8", JSON.stringify(route(body)));
          return;
        }
        serveStatic(res, url.pathname);
      } catch (exc) {
        // The client shows this verbatim in the amber strip, so it has to say
        // what went wrong rather than "500".
        const e = exc as Error;
        send(res, 500, "application/json; charset=utf-8",
          JSON.stringify({ error: `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}` }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--port");
  const port = at >= 0 ? Number(argv[at + 1]) : 8175;
  const server = await serve(port);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  console.log(`${APP.APP_NAME}`);
  console.log(`  open ${url}`);
  console.log(`  fonts   ${APP.FONTS_DIR}`);
  console.log(`  settings ${APP.SETTINGS_PATH}`);
}

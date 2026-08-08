/**
 * api.ts — the one place the page talks to the engine.
 *
 * Every call is a POST of JSON to a route in `src/server.ts` and a JSON answer
 * back. The types below are the SAME types the server computes — imported from
 * the engine, not re-declared — so a field renamed on one side stops compiling on
 * the other instead of arriving as `undefined` at runtime.
 */

import type { BuildResult, FontEntry, FontInfo } from "../../src/viewmodel.ts";
import type { CellDrawing } from "../../src/pairgrid.ts";
import type { ExportJob, PromptSection, Settings } from "../../src/app.ts";

export type { BuildResult, CellDrawing, ExportJob, FontEntry, FontInfo, PromptSection, Settings };

/** What the window needs before it can show anything. */
export interface AppState {
  app_name: string;
  base: string;
  fonts_dir: string;
  settings_path: string;
  settings: Settings;
  fonts: FontEntry[];
}

/** Everything one preview build is asked for — one field per control. */
export interface BuildParams {
  path: string;
  text: string;
  height: number;
  unit: string;
  basis: string;
  lead_in?: boolean;
  lead_len?: number;
  lead_clear?: number;
  thin?: boolean;
  thin_target?: number;
  eye_target_id?: number;
  eye_target_wall?: number;
  eye_dims?: boolean;
  eye_want?: boolean;
}

/** How the sheet is laid out, without any of its cells. */
export interface SheetInfo {
  rows: [string, string][];
  cols: string[];
  cell: number;
  zoom: number;
  zooms: number[];
  width: number;
  height: number;
  n_flagged: number;
  flagged: [number, number][];
  row_labels: string[];
  upem: number;
  prompt: string;
  untested: number;
}

/** One cell, plus where it sits and what its tooltip says. */
export type SheetCell = CellDrawing & { ri: number; ci: number; tip: string };

/**
 * POST to a route and return its answer.
 *
 * A route that throws answers with `{error}` and an HTTP 500; that becomes a
 * rejected promise carrying the server's own message, because the amber strip
 * shows it verbatim and "500" tells nobody anything.
 */
async function post<T>(route: string, body: unknown = {}): Promise<T> {
  const res = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  state: () => post<AppState>("/api/state"),
  saveSettings: (settings: Settings) => post<{ ok: boolean }>("/api/settings", { settings }),
  fonts: () => post<FontEntry[]>("/api/fonts"),
  probe: (path: string) => post<FontInfo>("/api/probe", { path }),
  reload: (path: string) => post<{ info: FontInfo; status: string }>("/api/reload", { path }),
  build: (p: BuildParams) => post<BuildResult>("/api/build", p),
  export: (job: ExportJob) => post<{ written: string[] }>("/api/export", { job }),
  report: (body: Record<string, unknown>) =>
    post<{ text: string; prompt?: string }>("/api/report", body),
  addFont: (name: string, data: string) =>
    post<{ added: string; fonts: FontEntry[] }>("/api/addfont", { name, data }),
  prompts: (body: Record<string, unknown>) => post<PromptSection[]>("/api/prompts", body),
  sheet: (path: string, zoom?: number) => post<SheetInfo>("/api/pairsheet", { path, zoom }),
  sheetCells: (path: string, r0: number, r1: number, c0: number, c1: number) =>
    post<SheetCell[]>("/api/pairsheet/cells", { path, r0, r1, c0, c1 }),
  /** Where the browser fetches a file this process wrote. */
  downloadUrl: (path: string) => `/api/download?path=${encodeURIComponent(path)}`,
};

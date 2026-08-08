/**
 * App.tsx — the window.
 *
 * A port of `MainWindow`: the same controls, the same labels, the same rules
 * about when a measurement is worth paying for. What it is NOT is a port of the
 * layout code — a browser lays itself out, and none of the geometry was ever
 * asserted on.
 *
 * WHAT MOVED AND WHAT DID NOT
 *   The Qt window ran a debounce timer, a preview thread and a report thread, so
 *   that typing stayed smooth while a build took a second. Here the build is a
 *   fetch: it is already off the UI thread, so the threads are gone and the
 *   debounce stays — typing a name is still one keystroke per rebuild without it.
 *
 *   Every label format below is the Python's, character for character, because
 *   `viewmodel.ts` computes them and `tests/gui.ts` reads them back. Nothing here
 *   formats a number itself.
 *
 * THE RULE ABOUT MEASUREMENTS
 *   The thin-area scan and the eyelet measurement are seconds and hundreds of
 *   milliseconds respectively. They are requested only when something on screen
 *   is asking for them — the toggle is on, or a target has been typed — exactly
 *   as the Qt worker gated them. Ungated, this is far too slow to run on a
 *   keystroke.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import type { AppState, BuildResult, FontEntry, FontInfo, PromptSection, Settings } from "./api.ts";
import { Preview } from "./Preview.tsx";
import { PairSheet } from "./PairSheet.tsx";
import { PromptsDialog, TargetSpin, TextDialog } from "./widgets.tsx";
import { MIN_IN, MIN_MM, MM_PER_IN } from "../../src/units.ts";

/** Rebuild this long after the last keystroke. `DEBOUNCE_MS` in the Python. */
const DEBOUNCE_MS = 150;

/** Which report is on screen, if any. */
type ReportKind = "check" | "eyelets" | "thickness" | "health" | null;

export function App(): React.ReactElement {
  // ---- what the app knows about itself ---------------------------------- //
  const [state, setState] = useState<AppState | null>(null);
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [fontPath, setFontPath] = useState("");
  const [info, setInfo] = useState<FontInfo | null>(null);

  // ---- the controls ------------------------------------------------------ //
  const [names, setNames] = useState("ADAM");
  const [caret, setCaret] = useState(0);
  const [height, setHeight] = useState(1.0);
  const [unit, setUnit] = useState("in");
  const [basis, setBasis] = useState("cap");
  const [gap, setGap] = useState(0.25);
  const [direction, setDirection] = useState("vertical");
  const [formats, setFormats] = useState<string[]>(["svg", "pdf"]);

  const [leadIn, setLeadIn] = useState(false);
  const [leadLen, setLeadLen] = useState(0.1);
  const [leadClear, setLeadClear] = useState(0.012);

  const [thin, setThin] = useState(false);
  const [thinTarget, setThinTarget] = useState(0);

  const [eyeDims, setEyeDims] = useState(false);
  const [eyeWant, setEyeWant] = useState(true);
  const [eyeTargetId, setEyeTargetId] = useState(0);
  const [eyeTargetWall, setEyeTargetWall] = useState(0);

  // ---- what came back ---------------------------------------------------- //
  const [result, setResult] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [status, setStatus] = useState("");
  /** The amber panel, in two halves: what the font check said, and what the build said. */
  const [fontNotes, setFontNotes] = useState<string[]>([]);
  const [previewNotes, setPreviewNotes] = useState<string[]>([]);
  const [report, setReport] = useState<{ kind: ReportKind; title: string; text: string } | null>(null);
  const [prompts, setPrompts] = useState<PromptSection[] | null>(null);
  const [busy, setBusy] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);

  /** The name the caret is on — that is the one previewed. `caret_name` in Python. */
  const currentName = useMemo(() => {
    const lines = names.split("\n");
    let at = 0;
    for (const line of lines) {
      if (caret <= at + line.length) return line.trim();
      at += line.length + 1;
    }
    return (lines[lines.length - 1] ?? "").trim();
  }, [names, caret]);

  /** Every non-blank line, which is what an export runs over. */
  const allNames = useMemo(
    () => names.split("\n").map((s) => s.trim()).filter(Boolean),
    [names],
  );

  // ---- start up ---------------------------------------------------------- //
  useEffect(() => {
    api.state().then((s) => {
      setState(s);
      setFonts(s.fonts);
      const want = s.settings.font_path;
      const pick = (want && s.fonts.find((f) => f.path === want)) || s.fonts[0];
      if (pick) setFontPath(pick.path);
      restore(s.settings, {
        setNames, setHeight, setUnit, setBasis, setGap, setDirection, setFormats,
        setLeadIn, setLeadLen, setLeadClear, setEyeTargetId, setEyeTargetWall,
        setEyeDims, setEyeWant,
      });
    }).catch((e: Error) => setPreviewNotes([e.message]));
  }, []);

  // ---- probe whichever font is selected ---------------------------------- //
  useEffect(() => {
    if (!fontPath) return;
    setInfo(null);
    let live = true;
    api.probe(fontPath)
      .then((i) => { if (live) { setInfo(i); setFontNotes(i.notes); } })
      .catch((e: Error) => { if (live) setFontNotes([e.message]); });
    return () => { live = false; };
  }, [fontPath]);

  // ---- the preview, debounced -------------------------------------------- //
  const fileRef = useRef<HTMLInputElement>(null);
  const buildSeq = useRef(0);
  const rebuild = useCallback(() => {
    if (!fontPath || !currentName) {
      setResult(null);
      return;
    }
    const seq = ++buildSeq.current;
    setBuilding(true);
    api.build({
      path: fontPath, text: currentName, height, unit, basis,
      lead_in: leadIn, lead_len: leadLen, lead_clear: leadClear,
      thin, thin_target: thinTarget,
      eye_target_id: eyeTargetId, eye_target_wall: eyeTargetWall,
      eye_dims: eyeDims, eye_want: eyeWant,
    }).then((r) => {
      // An answer that is not the newest is thrown away rather than shown. Builds
      // do not finish in the order they were asked for — a thin-area scan takes
      // seconds and the keystroke after it takes milliseconds — so without this
      // the older, slower answer lands last and the screen goes stale.
      if (seq !== buildSeq.current) return;
      setResult(r);
      // `notes` is the amber panel, already assembled and already filtered: the
      // rule about which engine messages are worth showing lives in the view
      // model, not here, so it cannot drift between the page and the tests.
      setPreviewNotes(r.notes);
      setBuilding(false);
    }).catch((e: Error) => {
      if (seq !== buildSeq.current) return;
      setResult(null);
      setPreviewNotes([e.message, "Click “Check font” for what to fix in this font."]);
      setBuilding(false);
    });
  }, [fontPath, currentName, height, unit, basis, leadIn, leadLen, leadClear,
    thin, thinTarget, eyeTargetId, eyeTargetWall, eyeDims, eyeWant]);

  useEffect(() => {
    const t = setTimeout(rebuild, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rebuild]);

  // ---- remember the settings --------------------------------------------- //
  const persist = useCallback(() => {
    void api.saveSettings({
      font_path: fontPath, unit, basis, height, gap, formats, names,
      lead_in: leadIn, lead_len: leadLen, lead_clear: leadClear,
      eye_target_id: eyeTargetId, eye_target_wall: eyeTargetWall,
      eye_show_dims: eyeDims, eye_show_want: eyeWant, direction,
    });
  }, [fontPath, unit, basis, height, gap, formats, names, leadIn, leadLen,
    leadClear, eyeTargetId, eyeTargetWall, eyeDims, eyeWant, direction]);

  useEffect(() => {
    const t = setTimeout(persist, 800);
    return () => clearTimeout(t);
  }, [persist]);

  // ---- unit switch converts the number ------------------------------------ //
  /**
   * Switching units must keep the PHYSICAL size, so the number converts.
   *
   * Every length on screen is in the current unit — the height, the lead-in, the
   * standoff, the gap, both eyelet targets and the thin target — so all of them
   * convert together or the artwork changes size behind the user's back.
   */
  const switchUnit = (to: string): void => {
    if (to === unit) return;
    const k = to === "mm" ? MM_PER_IN : 1 / MM_PER_IN;
    const conv = (v: number) => Math.round(v * k * 1e6) / 1e6;
    setUnit(to);
    setHeight(Math.max(to === "mm" ? MIN_MM : MIN_IN, conv(height)));
    setGap(conv(gap));
    setLeadLen(conv(leadLen));
    setLeadClear(conv(leadClear));
    setThinTarget(thinTarget ? conv(thinTarget) : 0);
    setEyeTargetId(eyeTargetId ? conv(eyeTargetId) : 0);
    setEyeTargetWall(eyeTargetWall ? conv(eyeTargetWall) : 0);
  };

  // ---- the buttons -------------------------------------------------------- //
  const runReport = (kind: Exclude<ReportKind, null>, title: string): void => {
    setBusy(title);
    api.report({
      kind, path: fontPath, text: currentName, height, unit, basis,
      thin_target: thinTarget,
      eye_target_id: eyeTargetId, eye_target_wall: eyeTargetWall,
    }).then((r) => {
      // The thin-area report carries its paste-ready fix alongside the prose when
      // a target was typed. Showing them in one box is what the Qt dialog did, and
      // it keeps the measurement and the request that came from it together.
      setReport({
        kind, title,
        text: r.prompt ? `${r.text}\n\n${"-".repeat(70)}\n\n${r.prompt}` : r.text,
      });
      setBusy("");
    }).catch((e: Error) => {
      setPreviewNotes([e.message]);
      setBusy("");
    });
  };

  const doExport = (kind: "per-name" | "sheet"): void => {
    if (!allNames.length || !formats.length) return;
    const stem = kind === "sheet" ? "sheet" : "nameplates.zip";
    setBusy(kind === "sheet" ? "Writing the sheet…" : `Writing ${allNames.length} name(s)…`);
    api.export({
      kind, font_path: fontPath, names: allNames, height, unit, basis,
      formats, gap, dest: `${state?.base ?? "."}/exports/${stem}`,
      lead_in: leadIn, lead_len: leadLen, lead_clear: leadClear, direction,
    }).then((r) => {
      setBusy("");
      setStatus(`Wrote ${r.written.map((p) => p.split("/").pop()).join(", ")}`);
      // Hand each file to the browser so it lands in Downloads. Writing it next
      // to the app as well is deliberate: this is a shop tool, and "where did it
      // go?" is answered by a path, not by a browser setting.
      for (const p of r.written) {
        const a = document.createElement("a");
        a.href = api.downloadUrl(p);
        a.download = "";
        a.click();
      }
    }).catch((e: Error) => {
      setBusy("");
      setPreviewNotes([e.message]);
    });
  };

  const reloadFont = (): void => {
    api.reload(fontPath).then((r) => {
      setInfo(r.info);
      setStatus(r.status);
      rebuild();
    }).catch((e: Error) => setPreviewNotes([e.message]));
  };

  const generatePrompts = (): void => {
    setBusy("Building every prompt…");
    api.prompts({
      path: fontPath, text: currentName, height, unit, basis,
      thin_target: thinTarget, eye_target_id: eyeTargetId, eye_target_wall: eyeTargetWall,
    }).then((s) => {
      setPrompts(s);
      setBusy("");
    }).catch((e: Error) => {
      setPreviewNotes([e.message]);
      setBusy("");
    });
  };

  /** One panel for both the font check and the current preview, as Qt had. */
  const notes = [...fontNotes, ...previewNotes];

  const step = unit === "mm" ? 0.1 : 0.005;
  const rows = result?.eyelet_rows ?? {};

  return (
    <div className="app">
      <header className="titlebar">
        <h1>{state?.app_name ?? "Sean's Font Prototyping Friend"}</h1>
        <span className="spacer" />
        <button onClick={() => runReport("health", "Health check")}>Health</button>
      </header>

      <div className="body">
        {/* ---------------------------------------------------------------- */}
        <aside className="controls">
          <fieldset>
            <legend>Font</legend>
            <select value={fontPath} onChange={(e) => setFontPath(e.target.value)}>
              {fonts.map((f) => <option key={f.path} value={f.path}>{f.family}</option>)}
            </select>
            <p className="detail">{info ? info.detail : "checking…"}</p>
            <div className="row">
              <button onClick={() => api.fonts().then(setFonts)}>Refresh</button>
              <button onClick={reloadFont}>Reload font</button>
              <button onClick={() => runReport("check", "Font check")}>Check font</button>
            </div>
            <div className="row">
              {/* The Qt window opened a file dialog and copied the file into fonts/.
                  A browser cannot read a path, so the bytes are uploaded and the
                  server writes them — same outcome, and the font still travels
                  with the app folder. */}
              <button onClick={() => fileRef.current?.click()}>Add font…</button>
              <input
                ref={fileRef}
                type="file"
                accept=".ttf,.otf,.ttc"
                style={{ display: "none" }}
                onChange={async (ev) => {
                  const file = ev.target.files?.[0];
                  ev.target.value = "";
                  if (!file) return;
                  try {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    let bin = "";
                    for (const b of bytes) bin += String.fromCharCode(b);
                    const r = await api.addFont(file.name, btoa(bin));
                    setFonts(r.fonts);
                    setFontPath(r.added);
                    setStatus(`Added ${file.name} to the fonts folder.`);
                  } catch (e) {
                    setPreviewNotes([(e as Error).message]);
                  }
                }}
              />
            </div>
            <div className="row">
              <button onClick={() => setSheetOpen(true)}>Letter pairs…</button>
              <button onClick={generatePrompts}>Generate prompts</button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Names</legend>
            <textarea
              rows={6}
              value={names}
              placeholder="One name per line"
              onChange={(e) => {
                setNames(e.target.value);
                setCaret(e.target.selectionStart ?? 0);
              }}
              onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            />
            <p className="muted">
              {allNames.length} name{allNames.length === 1 ? "" : "s"} · previewing{" "}
              <strong>{currentName || "(nothing)"}</strong>
            </p>
          </fieldset>

          <fieldset>
            <legend>Size</legend>
            <label className="field">
              Height
              <input
                type="number"
                value={height}
                step={unit === "mm" ? 0.5 : 0.05}
                min={unit === "mm" ? MIN_MM : MIN_IN}
                onChange={(e) => setHeight(Number(e.target.value) || 0)}
              />
              <span className="suffix">{unit}</span>
            </label>
            <div className="row radios">
              {["in", "mm"].map((u) => (
                <label key={u}>
                  <input type="radio" checked={unit === u} onChange={() => switchUnit(u)} /> {u}
                </label>
              ))}
            </div>
            <div className="row radios">
              {[["cap", "cap height"], ["xheight", "x-height"], ["total", "whole artwork"]].map(
                ([b, lab]) => (
                  <label key={b}>
                    <input type="radio" checked={basis === b} onChange={() => setBasis(b)} /> {lab}
                  </label>
                ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Lead-ins</legend>
            <label>
              <input type="checkbox" checked={leadIn} onChange={(e) => setLeadIn(e.target.checked)} />
              {" "}Add laser lead-in lines
            </label>
            <label className="field">
              Length
              <input type="number" value={leadLen} step={step} disabled={!leadIn}
                onChange={(e) => setLeadLen(Number(e.target.value) || 0)} />
              <span className="suffix">{unit}</span>
            </label>
            <label className="field">
              Standoff
              <input type="number" value={leadClear} step={step} disabled={!leadIn}
                onChange={(e) => setLeadClear(Number(e.target.value) || 0)} />
              <span className="suffix">{unit}</span>
            </label>
          </fieldset>

          <fieldset>
            <legend>Thin areas</legend>
            <label>
              <input type="checkbox" checked={thin} onChange={(e) => setThin(e.target.checked)} />
              {" "}Find the thin places
            </label>
            <label className="field">
              Wanted
              <TargetSpin value={thinTarget} onChange={setThinTarget} step={step} suffix={` ${unit}`}
                title="Leave empty for no target" />
            </label>
            <button onClick={() => runReport("thickness", "Thin areas")}>
              Full thickness report…
            </button>
          </fieldset>

          <fieldset>
            <legend>Eyelets</legend>
            <label>
              <input type="checkbox" checked={eyeDims} onChange={(e) => setEyeDims(e.target.checked)} />
              {" "}Show the measurements
            </label>
            <label>
              <input type="checkbox" checked={eyeWant} onChange={(e) => setEyeWant(e.target.checked)} />
              {" "}Draw the wanted size
            </label>
            <label className="field">
              Wanted ID
              <TargetSpin value={eyeTargetId} onChange={setEyeTargetId} step={step} suffix={` ${unit}`} />
            </label>
            <label className="field">
              Wanted wall
              <TargetSpin value={eyeTargetWall} onChange={setEyeTargetWall} step={step} suffix={` ${unit}`} />
            </label>
            <table className="eyelets">
              <thead>
                <tr><th /><th>actual</th><th>want</th><th>change</th></tr>
              </thead>
              <tbody>
                {[["id", "inner ⌀"], ["od", "outer ⌀"], ["wall", "wall"], ["wall_min", "thinnest wall"]]
                  .map(([key, lab]) => (
                    <tr key={key}>
                      <th>{lab}</th>
                      <td>{rows[key]?.actual ?? ""}</td>
                      <td>{rows[key]?.want ?? ""}</td>
                      <td>{rows[key]?.change ?? ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <button onClick={() => runReport("eyelets", "Eyelet measurements")}>
              Full eyelet report…
            </button>
          </fieldset>

          <fieldset>
            <legend>Export</legend>
            <div className="row">
              {["svg", "pdf"].map((f) => (
                <label key={f}>
                  <input
                    type="checkbox"
                    checked={formats.includes(f)}
                    onChange={(e) => setFormats(
                      e.target.checked ? [...formats, f].sort() : formats.filter((x) => x !== f))}
                  /> {f.toUpperCase()}
                </label>
              ))}
            </div>
            <label className="field">
              Sheet gap
              <input type="number" value={gap} step={step}
                onChange={(e) => setGap(Number(e.target.value) || 0)} />
              <span className="suffix">{unit}</span>
            </label>
            <div className="row radios">
              {["vertical", "horizontal"].map((d) => (
                <label key={d}>
                  <input type="radio" checked={direction === d} onChange={() => setDirection(d)} /> {d}
                </label>
              ))}
            </div>
            <div className="row">
              <button
                disabled={!allNames.length || !formats.length}
                onClick={() => doExport("per-name")}
              >
                One file per name (zip)
              </button>
              <button
                disabled={!allNames.length || !formats.length}
                onClick={() => doExport("sheet")}
              >
                One sheet
              </button>
            </div>
          </fieldset>
        </aside>

        {/* ---------------------------------------------------------------- */}
        <main>
          <div className="labels">
            <div className="size-label">{result?.size_label ?? ""}</div>
            <div className="count-label">{result?.count_label ?? ""}</div>
          </div>
          {notes.length ? (
            <div className="amber">
              {notes.map((n) => <div key={n}>⚠ {n}</div>)}
            </div>
          ) : null}
          <Preview
            result={result}
            placeholder={fontPath ? "Type a name" : "Put a font in fonts/"}
            thinTarget={thinTarget}
            showEyeDims={eyeDims}
            showEyeWant={eyeWant}
            eyeTargetId={eyeTargetId}
            eyeTargetWall={eyeTargetWall}
          />
          <div className="status">
            <span className="status-text">{busy || status}</span>
            {building ? <span className="working"> working…</span> : null}
          </div>
        </main>
      </div>

      {report && (
        <TextDialog
          title={report.title}
          body={report.text}
          copyLabel={report.kind === "health" ? "Copy for a bug report" : "Copy"}
          onClose={() => setReport(null)}
        />
      )}
      {prompts && <PromptsDialog sections={prompts} onClose={() => setPrompts(null)} />}
      {sheetOpen && fontPath && (
        <PairSheet fontPath={fontPath} onClose={() => setSheetOpen(false)} />
      )}
    </div>
  );
}

/**
 * Apply a saved settings file to the controls.
 *
 * Every field is optional and every one is checked before it is used — the file
 * is external data, and `loadSettings` already dropped anything of the wrong
 * type, but a value from an older version can still be missing entirely.
 */
function restore(s: Settings, set: Record<string, (v: any) => void>): void {
  if (typeof s.names === "string") set.setNames(s.names);
  if (typeof s.unit === "string") set.setUnit(s.unit);
  if (typeof s.basis === "string") set.setBasis(s.basis);
  if (typeof s.height === "number") set.setHeight(s.height);
  if (typeof s.gap === "number") set.setGap(s.gap);
  if (typeof s.direction === "string") set.setDirection(s.direction);
  if (Array.isArray(s.formats) && s.formats.length) set.setFormats(s.formats);
  if (typeof s.lead_in === "boolean") set.setLeadIn(s.lead_in);
  if (typeof s.lead_len === "number") set.setLeadLen(s.lead_len);
  if (typeof s.lead_clear === "number") set.setLeadClear(s.lead_clear);
  if (typeof s.eye_target_id === "number") set.setEyeTargetId(s.eye_target_id);
  if (typeof s.eye_target_wall === "number") set.setEyeTargetWall(s.eye_target_wall);
  if (typeof s.eye_show_dims === "boolean") set.setEyeDims(s.eye_show_dims);
  if (typeof s.eye_show_want === "boolean") set.setEyeWant(s.eye_show_want);
}

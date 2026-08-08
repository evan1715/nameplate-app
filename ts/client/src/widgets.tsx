/**
 * widgets.tsx — the two controls the app needed that a browser does not have.
 *
 * Everything else is a plain `<input>` or `<select>`; only these two carry
 * behaviour the Python's selftest asserts on.
 */

import { useEffect, useRef, useState } from "react";

// --------------------------------------------------------------------------- //
//  TargetSpin
// --------------------------------------------------------------------------- //

export interface TargetSpinProps {
  /** The current value. 0 means "not asked for". */
  value: number;
  onChange: (v: number) => void;
  /** Printed after the number, e.g. " in". */
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
  title?: string;
  id?: string;
}

/**
 * A wanted-size box that can be emptied again.
 *
 * A plain number input has the same problem the Qt spin box had: once a target is
 * typed there is no obvious way to say "never mind" short of typing 0 and knowing
 * that 0 happens to mean off. So an empty box is a real state here — it reads as
 * 0.0, which everything downstream already treats as "not asked for", and it
 * SHOWS an em dash once you leave it, rather than snapping back to the number you
 * were trying to remove.
 *
 * The display is deliberately left alone while you type and only settles on the
 * dash on blur, so nothing is rewritten under the cursor mid-edit.
 */
export function TargetSpin(props: TargetSpinProps): React.ReactElement {
  const [text, setText] = useState(props.value ? String(props.value) : "");
  const [focused, setFocused] = useState(false);

  // Adopt a value set from outside (a unit switch converts it), but never while
  // the box has focus — that would rewrite what is being typed.
  useEffect(() => {
    if (!focused) setText(props.value ? String(props.value) : "");
  }, [props.value, focused]);

  const shown = focused ? text : text.trim() === "" ? "—" : text;

  return (
    <input
      id={props.id}
      className="target-spin"
      type="text"
      inputMode="decimal"
      title={props.title}
      value={shown + (focused || shown === "—" ? "" : (props.suffix ?? ""))}
      onFocus={(e) => {
        setFocused(true);
        // select-all so typing replaces, which is what a spin box does
        requestAnimationFrame(() => e.target.select());
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        // Keep only what could be part of a number, so a stray suffix or a pasted
        // "0.15 in" still reads as 0.15 rather than as nothing.
        const raw = e.target.value.replace(/[^\d.\-]/g, "");
        setText(raw);
        const v = Number.parseFloat(raw);
        props.onChange(Number.isFinite(v) && raw.trim() !== "" ? clamp(v, props) : 0);
      }}
      onKeyDown={(e) => {
        const stepBy = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
        if (!stepBy) return;
        e.preventDefault();
        const v = clamp((Number.parseFloat(text) || 0) + stepBy * (props.step ?? 0.01), props);
        setText(String(round(v)));
        props.onChange(v);
      }}
    />
  );
}

function clamp(v: number, p: { min?: number; max?: number }): number {
  return Math.max(p.min ?? 0, Math.min(p.max ?? 1e9, v));
}

/** Kill the float noise a repeated step accumulates (0.1 + 0.01 = 0.11000000000000001). */
function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// --------------------------------------------------------------------------- //
//  TextDialog
// --------------------------------------------------------------------------- //

export interface TextDialogProps {
  title: string;
  body: string;
  onClose: () => void;
  copyLabel?: string;
}

/**
 * A report in a box the mouse can select, with a Copy button.
 *
 * An alert() looks right for this and is wrong for it, for the reason the Python
 * gives about QMessageBox: its text cannot be selected, so anything worth handing
 * to someone else has to be retyped.
 */
export function TextDialog(props: TextDialogProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{props.title}</h2>
          <button className="ghost" onClick={props.onClose}>Close</button>
        </header>
        <textarea ref={ref} readOnly value={props.body} rows={22} />
        <div className="row">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(props.body);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "Copied" : (props.copyLabel ?? "Copy")}
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
//  PromptsDialog
// --------------------------------------------------------------------------- //

export interface PromptsDialogProps {
  sections: { title: string; note: string; body: string }[];
  onClose: () => void;
}

/**
 * The four paste-ready prompt blocks, each with its own Copy button.
 *
 * A section with an empty body is shown with its note and NO box. That is
 * deliberate and it is asserted on: a clean font must leave the defect section
 * blank rather than produce a fake request to fix nothing.
 */
export function PromptsDialog(props: PromptsDialogProps): React.ReactElement {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Prompts for an AI that edits fonts</h2>
          <button className="ghost" onClick={props.onClose}>Close</button>
        </header>
        {props.sections.map((s) => (
          <section key={s.title} className="prompt-block">
            <h3>{s.title}</h3>
            <p className="muted">{s.note}</p>
            {s.body ? (
              <>
                <textarea readOnly value={s.body} rows={10} />
                <button onClick={() => void navigator.clipboard.writeText(s.body)}>Copy</button>
              </>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

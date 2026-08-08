/**
 * pyformat.ts — Python's number formatting, reproduced exactly.
 *
 * WHY THIS IS NOT A ONE-LINER
 *   The exported SVG and PDF are compared against `golden/` BYTE FOR BYTE, so
 *   every number in them has to render the same digits Python renders. Three
 *   places JavaScript disagrees:
 *
 *   1. `Number.prototype.toFixed` breaks an exact tie by rounding AWAY from
 *      zero; C's `printf`, and therefore Python's `f"{v:.4f}"`, breaks it to the
 *      NEAREST EVEN digit. Ties are not hypothetical here — flattened Bézier
 *      points land on exact binary fractions such as 5/32 = 0.15625, which
 *      `.4f` renders as "0.1562" in Python and "0.1563" in JavaScript.
 *   2. `String(1.0)` is "1" in JavaScript and "1.0" in Python. That string goes
 *      into the SVG header comment as the requested height.
 *   3. `%g` (used in the engine's warning text) has its own rules about when to
 *      switch to exponent form and how many significant digits to keep.
 *
 *   So the fixed-point formatter below works on the double's EXACT value using
 *   BigInt, rather than on an approximation of it.
 */

/**
 * Split a finite double into an exact `mantissa * 2^exponent`, both integers.
 * Every double is exactly such a product, which is what makes exact decimal
 * rendering possible.
 */
function decompose(v: number): { mantissa: bigint; exponent: number } {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, v);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const rawExp = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (rawExp === 0) {
    // subnormal: no implicit leading 1, exponent fixed at the minimum
    return { mantissa: fraction, exponent: -1074 };
  }
  return { mantissa: fraction | (1n << 52n), exponent: rawExp - 1075 };
}

/** 10^n as a BigInt. */
function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** A finite double as an exact rational — the same decomposition, one step on. */
function ratio(v: number): { num: bigint; den: bigint } {
  const { mantissa, exponent } = decompose(v);
  if (exponent >= 0) return { num: mantissa << BigInt(exponent), den: 1n };
  return { num: mantissa, den: 1n << BigInt(-exponent) };
}

/** `num / den` rounded to an integer, ties to even. Both must be positive. */
function roundHalfEven(num: bigint, den: bigint): bigint {
  let q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && q % 2n === 1n) q += 1n;
  return q;
}

/**
 * Python's `f"{v:.{digits}f}"` — fixed-point with round-half-to-even, computed
 * from the double's exact value.
 *
 * @param v      the number
 * @param digits digits after the decimal point
 * @returns the formatted string, e.g. `fmtF(4.0693, 3) === "4.069"`
 */
export function fmtF(v: number, digits: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";

  const negative = v < 0 || Object.is(v, -0);
  const abs = Math.abs(v);

  const { mantissa, exponent } = decompose(abs);
  // value = mantissa * 2^exponent; we want round(value * 10^digits)
  let numerator: bigint;
  let denominator: bigint;
  if (exponent >= 0) {
    numerator = mantissa * (1n << BigInt(exponent)) * pow10(digits);
    denominator = 1n;
  } else {
    numerator = mantissa * pow10(digits);
    denominator = 1n << BigInt(-exponent);
  }

  let q = numerator / denominator;
  const r = numerator % denominator;
  const twice = r * 2n;
  if (twice > denominator) q += 1n;
  else if (twice === denominator && q % 2n === 1n) q += 1n; // tie → even

  let body = q.toString();
  if (digits > 0) {
    body = body.padStart(digits + 1, "0");
    body = body.slice(0, body.length - digits) + "." + body.slice(body.length - digits);
  }
  // Python prints "-0.000" for a negative value that rounds to zero, and so
  // does C's printf, so the sign is kept even when every digit is 0.
  return negative ? "-" + body : body;
}

/**
 * Python's `str(float)` / `repr(float)` — the shortest string that round-trips,
 * always with a decimal point or an exponent.
 *
 * JavaScript's `String(n)` is also the shortest round-tripping form, so the only
 * work here is Python's cosmetic differences: a trailing ".0" on whole numbers,
 * and exponents written as `1e-05` / `1e+16`.
 */
export function pyFloat(v: number): string {
  if (typeof v !== "number") return String(v);
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";

  const abs = Math.abs(v);
  // Python switches to exponent form outside [1e-4, 1e16)
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mantissa, exp] = v.toExponential().split("e");
    const sign = exp.startsWith("-") ? "-" : "+";
    const magnitude = exp.replace(/^[-+]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${magnitude}`;
  }
  const s = String(v);
  return /[.e]/.test(s) ? s : s + ".0";
}

/**
 * Python's `f"{v:g}"` — 6 significant digits, trailing zeros stripped, switching
 * to exponent form when the exponent is below -4 or at least the precision.
 *
 * @param v         the number
 * @param precision significant digits; Python's default is 6
 */
export function pyG(v: number, precision = 6): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return "0";

  const p = precision === 0 ? 1 : precision;
  // the decimal exponent as %e would write it
  const exp = Number(v.toExponential(p - 1).split("e")[1]);

  if (exp < -4 || exp >= p) {
    let [mantissa, e] = v.toExponential(p - 1).split("e");
    if (mantissa.includes(".")) mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
    const sign = e.startsWith("-") ? "-" : "+";
    const magnitude = e.replace(/^[-+]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${magnitude}`;
  }
  let out = fmtF(v, Math.max(0, p - 1 - exp));
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

/**
 * Python's `f"{v:.{digits}e}"` — scientific notation, ties to even, exponent
 * always signed and at least two digits (`1.235e-09`, `0.000e+00`).
 *
 * Computed from the double's exact value for the same reason `fmtF` is: the
 * tolerance lines in the stress suite print `{spread:.3e}`, and a spread that is
 * exactly zero must render `0.000e+00` rather than something JavaScript's
 * `toExponential` happens to produce for a denormal near it.
 *
 * @param v      the number
 * @param digits digits after the decimal point in the mantissa
 */
export function fmtE(v: number, digits: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";

  const sign = v < 0 || Object.is(v, -0) ? "-" : "";
  const abs = Math.abs(v);
  const point = (s: string) => (digits > 0 ? s.slice(0, 1) + "." + s.slice(1) : s);

  if (abs === 0) return `${sign}${point("0".repeat(digits + 1))}e+00`;

  const { num, den } = ratio(abs);
  /** `abs * 10^k`, rounded to an integer. */
  const scaled = (k: number): bigint =>
    k >= 0 ? roundHalfEven(num * pow10(k), den) : roundHalfEven(num, den * pow10(-k));

  // Math.log10 can be off by one at a power of ten, and rounding the mantissa can
  // carry it up to 10.000 — so the guess is corrected against the exact value
  // rather than trusted. Both loops run at most once.
  let exp = Math.floor(Math.log10(abs));
  let digitsOut = scaled(digits - exp);
  while (digitsOut < pow10(digits)) digitsOut = scaled(digits - --exp);
  while (digitsOut >= pow10(digits + 1)) digitsOut = scaled(digits - ++exp);

  const e = (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  return `${sign}${point(digitsOut.toString())}e${e}`;
}

/**
 * Python's `round(v, digits)` — the exact value rounded to `digits` decimal
 * places with ties to even, then back to the nearest double.
 *
 * Not `Math.round(v * 10 ** digits) / 10 ** digits`: that scales through a second
 * rounding error, so it disagrees with Python on values that sit near a tie. This
 * matters where a rounded number is COMPARED rather than printed — the x-height
 * check picks the modal glyph top out of `round(top, 3)` values, and one value
 * landing on a different double changes which top wins the mode.
 *
 * @param v      the number
 * @param digits decimal places; may be 0
 */
export function pyRound(v: number, digits = 0): number {
  if (!Number.isFinite(v)) return v;
  return Number(fmtF(v, digits));
}

/**
 * Python's `f"{v:+.2f}%"`-style explicit sign, for the report tables.
 * @param v      the number
 * @param digits digits after the decimal point
 */
export function fmtSigned(v: number, digits: number): string {
  if (Number.isNaN(v)) return "nan";
  const body = fmtF(Math.abs(v), digits);
  return (v < 0 ? "-" : "+") + body;
}

/** Left-pad to `width`, like Python's `f"{s:>10}"`. */
export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** Right-pad to `width`, like Python's `f"{s:<10}"` / `f"{s:10s}"`. */
export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Python's `textwrap.wordsep_re`, translated.
 *
 * This is the part that makes a naive wrapper disagree with textwrap. It does not
 * split on whitespace: it splits into whitespace runs, em-dash runs, and words
 * that may themselves be split AFTER an internal hyphen — so "cut-only" is two
 * chunks, "cut-" and "only", and a line may legally end on the hyphen.
 *
 * Python's `\w` is Unicode-aware and JavaScript's is ASCII-only. That difference
 * cannot bite here: every string that reaches this function has already been put
 * through the ASCII flattening the prompts are contractually held to.
 */
const WORDSEP_RE = new RegExp(
  "([\\t\\n\\v\\f\\r ]+" + // any whitespace
    "|(?<=[\\w!\"'&.,?])-{2,}(?=\\w)" + // em-dash between words
    "|[^\\t\\n\\v\\f\\r ]+?(?:" + // word, possibly hyphenated
    "-(?:(?<=[^\\d\\W]{2}-)|(?<=[^\\d\\W]-[^\\d\\W]-))(?=[^\\d\\W]-?[^\\d\\W])" +
    "|(?=[\\t\\n\\v\\f\\r ]|$)" +
    "|(?<=[\\w!\"'&.,?])(?=-{2,}\\w)" +
    "))",
);

/**
 * Python's `textwrap.wrap(text, width, initial_indent, subsequent_indent)`.
 *
 * Greedy, with the indent counted inside the width — which is what makes the
 * wrapped notes in a report line up under their label.
 *
 * Ported against textwrap's real defaults, `break_long_words=True` and
 * `break_on_hyphens=True`, rather than the more obvious "split on spaces". Those
 * defaults are not cosmetic: a word longer than the line is CUT mid-word by
 * Python, and a glyph name like `eflourishrightring` in a font-repair prompt is
 * exactly such a word. Refusing to split it looks tidier and disagrees with the
 * Python on the one line a font editor is meant to act on.
 */
export function wrapText(
  text: string,
  width: number,
  initialIndent = "",
  subsequentIndent = "",
): string[] {
  // textwrap splits, then drops the empty strings the capturing group leaves.
  let chunks = text.split(WORDSEP_RE).filter((c) => c);
  if (chunks.length === 0) return [];
  // `_wrap_chunks` consumes from the end, so the list is reversed once up front.
  chunks.reverse();

  const lines: string[] = [];
  const isSpace = (s: string) => /^[\t\n\v\f\r ]+$/.test(s);

  while (chunks.length) {
    const indent = lines.length ? subsequentIndent : initialIndent;
    const room = width - indent.length;
    // Non-progress guard. When the indent is at least as wide as the line there
    // is no room for even one character, and the long-word handler can hand back
    // the chunk it was given; Python spins forever on that input. `_para` never
    // produces it — the widest indent in this codebase is 22 against a width of
    // 73 — so the guard costs nothing on real input and turns a hang into a
    // truncated line on absurd input.
    const before = chunks.length + chunks.reduce((n, c) => n + c.length, 0);

    // drop_whitespace: a run of spaces never starts a continuation line
    if (lines.length && chunks.length && isSpace(chunks[chunks.length - 1])) {
      chunks.pop();
      if (!chunks.length) break;
    }

    const cur: string[] = [];
    let curLen = 0;
    while (chunks.length) {
      const l = chunks[chunks.length - 1].length;
      if (curLen + l > room) break;
      cur.push(chunks.pop() as string);
      curLen += l;
    }

    // _handle_long_word: what is left does not fit on ANY line, so cut it
    if (chunks.length && chunks[chunks.length - 1].length > room) {
      const spaceLeft = room < 1 ? 1 : room - curLen;
      const chunk = chunks[chunks.length - 1];
      let end = spaceLeft;
      // break_on_hyphens: prefer to cut just after an existing hyphen
      if (chunk.length > spaceLeft) {
        const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
        if (hyphen > 0 && [...chunk.slice(0, hyphen)].some((c) => c !== "-")) {
          end = hyphen + 1;
        }
      }
      // Appended UNCONDITIONALLY, exactly as Python does — including when `end`
      // is 0 and the slice is empty. That empty string is load-bearing: when the
      // line is already exactly full it becomes the last element, so the single
      // trailing-whitespace drop below removes IT and leaves the real space
      // before it in place. Skipping the empty append strips that space instead,
      // which is the only way this function disagreed with textwrap across 828
      // differential cases.
      cur.push(chunk.slice(0, end));
      chunks[chunks.length - 1] = chunk.slice(end);
      curLen = cur.reduce((n, c) => n + c.length, 0);
    }

    // drop_whitespace: and never ends on one either
    if (cur.length && isSpace(cur[cur.length - 1])) {
      curLen -= cur[cur.length - 1].length;
      cur.pop();
    }

    if (cur.length) lines.push(indent + cur.join(""));

    // textwrap's _split never yields empty chunks; the long-word cut above can
    // leave one behind, so restore the invariant it relies on.
    while (chunks.length && chunks[chunks.length - 1] === "") chunks.pop();

    const after = chunks.length + chunks.reduce((n, c) => n + c.length, 0);
    if (after >= before && !cur.length) break;
  }
  return lines;
}

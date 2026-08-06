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

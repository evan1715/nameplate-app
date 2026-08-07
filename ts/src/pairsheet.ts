/**
 * pairsheet.ts — test every two-letter join a font can make.
 *
 * WHY THIS EXISTS
 *   A nameplate is cut out of one piece of metal. The engine unions all the letters
 *   of a name into a single closed path, so the name only survives the laser if every
 *   neighbouring pair of letters actually overlaps. Where two letters merely come
 *   close, the union leaves two islands and that part of the name drops out of the
 *   sheet as a loose letter.
 *
 *   Whether a font joins is a property of PAIRS, not of letters, and there are 676
 *   pairs per alphabet case — far too many to check by typing names. This module
 *   tests all of them geometrically.
 *
 * WHAT IT PRODUCES
 *   analysePairs()  a PairReport: per pair, the shaped glyph names, whether the ink
 *                   touches, and if not, the gap in font units and ems. Bounded by a
 *                   wall-clock budget, and pairs it never reached are reported as
 *                   UNTESTED, never as passes.
 *   claudePrompt()  the failures rewritten as a paste-ready instruction for an AI
 *                   that edits the font, grouped by the LEFT letter because one exit
 *                   stroke usually explains a whole row of failures.
 *
 * NOT PORTED HERE — THE CONTACT SHEET
 *   `nameplate_pairsheet.py` also renders PNG contact sheets with QPainter
 *   (`render_sheet`, `_paint_cell`, `_render_page`, `sheet_sizes`). That is a
 *   painting layer against a specific UI toolkit, not analysis: it belongs with the
 *   GUI port and its own canvas, so it is deliberately left out rather than
 *   half-translated. Everything the tests and the brief consume — the measurements
 *   and the prompt — is here.
 */

import { basename, resolve } from "node:path";
import { Font, shape } from "./font.ts";
import * as G from "./geom.ts";
import { fmtF, pyG } from "./pyformat.ts";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * (key, human label, left characters, right characters, where in the word)
 *
 * WHERE IN THE WORD MATTERS, and it is not a nicety. These fonts swap in different
 * glyphs by position: shaping 'ab' gives A.ini + B.e0 — an INITIAL form carrying the
 * eyelet — while the same pair inside 'Aaba' gives A.e0 + B.e0, different outlines
 * entirely. Testing only 'ab' therefore never looks at the glyphs that actually get
 * used in the middle of a name, which is most of the letters in most names.
 *
 *   mode "start"   the pair is the whole word: shape left + right
 *   mode "middle"  the pair sits inside a word: shape A + left + right + a, and judge
 *                  ONLY the link between the two middle letters
 */
export const GROUP_SPECS: [string, string, string, string, string][] = [
  ["lower", "start of a word: lowercase + lowercase", LOWER, LOWER, "start"],
  ["caplower", "start of a word: capital + lowercase", UPPER, LOWER, "start"],
  ["caps", "start of a word: capital + capital", UPPER, UPPER, "start"],
  ["midlower", "middle of a word: lowercase + lowercase", LOWER, LOWER, "middle"],
  ["midcaplower", "middle of a word: capital + lowercase", UPPER, LOWER, "middle"],
  // The two junctions a real name of three letters or more actually makes at its
  // ENDS, which nothing above covers. A two-letter word puts its first letter in the
  // initial form and its second in the FINAL form; a longer name puts the second
  // letter in a MEDIAL form instead, and that is a different glyph. Measured on the
  // shipped TGCarrieSOFlourish: 'dd' shapes to Dleftring + dflourishrightring, while
  // 'dda' shapes to Dleftring + d + aflourishrightring -- and the Dleftring->d
  // junction is BROKEN (2 pieces) while no group above ever looks at it.
  ["firstlower", "first letter of a word: lowercase + lowercase", LOWER, LOWER, "first"],
  ["firstcaplower", "first letter of a word: capital + lowercase", UPPER, LOWER, "first"],
  ["lastlower", "last letter of a word: lowercase + lowercase", LOWER, LOWER, "last"],
];
export const GROUP_KEYS: string[] = GROUP_SPECS.map((g) => g[0]);
export const DEFAULT_GROUPS = GROUP_KEYS;
export const MIDDLE_MODES = GROUP_SPECS.filter((g) => g[4] === "middle").map((g) => g[0]);
/**
 * Every mode that shapes the pair inside a longer string, so it needs the wrapper
 * letters present in the font before it can be tested at all.
 */
export const WRAPPED_MODES = ["middle", "first", "last"];

/**
 * How each wrapped mode builds its string and which typed characters it judges.
 * The cluster window is expressed in character positions of the shaped text.
 *   middle  A + left + right + a   judge clusters 1-2   medial -> medial
 *   first       left + right + a   judge clusters 0-1   INITIAL -> medial
 *   last    A + left + right       judge clusters 1-2   medial -> FINAL
 */
const MODE_SHAPE: Record<
  string,
  { build: (l: string, r: string, w: [string, string]) => string; window: [number, number] }
> = {
  middle: { build: (l, r, w) => w[0] + l + r + w[1], window: [1, 2] },
  first: { build: (l, r, w) => l + r + w[1], window: [0, 1] },
  last: { build: (l, r, w) => w[0] + l + r, window: [1, 2] },
};
export const DEFAULT_BUDGET_S = 30.0;

/**
 * The letters wrapped around a middle-of-word pair. A capital first and a lowercase
 * last, because that is what a real name looks like — and because both ends then take
 * the eyelet forms, leaving the pair under test in the medial forms where it belongs.
 * 'Aaaa' is this wrapper around the pair 'aa'.
 */
export const MIDDLE_WRAP: [string, string] = ["A", "a"];

// Pair outcomes. Only OK / GAP / EMPTY mean the geometry was actually measured; the
// rest exist so that "we did not look" can never be mistaken for "it passed".
export const OK = "ok"; // ink touches — the union will fuse these two letters
export const GAP = "gap"; // ink does not touch — this pair falls apart when cut
export const EMPTY = "empty"; // a glyph drew no ink at all, so there is nothing to join
export const MISSING = "missing"; // a character is not in the font's cmap — not tested
export const UNTESTED = "untested"; // the time budget ran out before this pair
export const ERROR = "error"; // shaping or outline building failed — not tested

export const TESTED_STATUSES = [OK, GAP, EMPTY];
export const PROBLEM_STATUSES = [GAP, EMPTY, ERROR];

// --------------------------------------------------------------------------- //
//  report model
// --------------------------------------------------------------------------- //

/** One two-character combination, as the font actually shaped it. */
export class PairResult {
  left: string;
  right: string;
  /** SHAPED names — 'go' may not use 'g','o'. */
  glyphs: string[];
  status: string;
  /** font units, worst non-touching link */
  gap: number | null;
  /** same gap as a fraction of the em */
  gap_em: number | null;
  /** why, in words, when it is not a plain OK */
  detail: string;
  /** pen position per glyph */
  offsets: [number, number][];
  /**
   * For a middle-of-word test: the whole fake word that was shaped ("Aaba"), and
   * which glyphs of it are the pair under test. Empty for a start-of-word test, where
   * the pair IS the word.
   */
  context: string;
  span: [number, number] | null;

  constructor(
    left: string,
    right: string,
    glyphs: string[],
    status: string,
    gap: number | null,
    gapEm: number | null,
    detail = "",
    offsets: [number, number][] = [],
    context = "",
    span: [number, number] | null = null,
  ) {
    this.left = left;
    this.right = right;
    this.glyphs = glyphs;
    this.status = status;
    this.gap = gap;
    this.gap_em = gapEm;
    this.detail = detail;
    this.offsets = offsets;
    this.context = context;
    this.span = span;
  }

  get pair(): string {
    return this.left + this.right;
  }

  /** What to print over the cell: the whole word when there is one. */
  get shown(): string {
    return this.context || this.pair;
  }

  get leftGlyph(): string {
    return this.glyphs.length ? this.glyphs[0] : "?";
  }

  get rightGlyph(): string {
    return this.glyphs.length ? this.glyphs[this.glyphs.length - 1] : "?";
  }

  get tested(): boolean {
    return TESTED_STATUSES.includes(this.status);
  }

  get problem(): boolean {
    return PROBLEM_STATUSES.includes(this.status);
  }

  /** The two characters collapsed into one glyph, so there is no join. */
  get ligature(): boolean {
    return this.glyphs.length === 1;
  }
}

/** Every pair in one of the alphabet-case groups. */
export class PairGroup {
  key: string;
  label: string;
  left_chars: string;
  right_chars: string;
  /** Keyed by {@link cellKey}, because a Map cannot key on a tuple. */
  cells: Map<string, PairResult> = new Map();
  mode: string;

  constructor(key: string, label: string, leftChars: string, rightChars: string, mode = "start") {
    this.key = key;
    this.label = label;
    this.left_chars = leftChars;
    this.right_chars = rightChars;
    this.mode = mode;
  }

  get middle(): boolean {
    return this.mode === "middle";
  }

  /** The pair was shaped inside a longer string, not as a whole word. */
  get wrapped(): boolean {
    return WRAPPED_MODES.includes(this.mode);
  }

  get results(): PairResult[] {
    return [...this.cells.values()];
  }

  get tested(): PairResult[] {
    return this.results.filter((r) => r.tested);
  }

  get failures(): PairResult[] {
    return this.results.filter((r) => r.problem);
  }

  get untested(): PairResult[] {
    return this.results.filter((r) => r.status === UNTESTED);
  }

  get missing(): PairResult[] {
    return this.results.filter((r) => r.status === MISSING);
  }

  /**
   * Failures bucketed under their left letter, in alphabet order.
   *
   * Fixing the exit stroke of one letter usually fixes every pair that starts with
   * it, so this is the order the repair actually happens in.
   */
  byLeft(): [string, PairResult[]][] {
    const buckets = new Map<string, PairResult[]>();
    for (const res of this.failures) {
      const b = buckets.get(res.left);
      if (b) b.push(res);
      else buckets.set(res.left, [res]);
    }
    for (const group of buckets.values()) {
      group.sort((a, b) => (a.right < b.right ? -1 : a.right > b.right ? 1 : 0));
    }
    return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

/** Everything the sweep found, across every group. */
export class PairReport {
  font_path: string;
  family: string;
  upem: number;
  budget_s: number;
  elapsed_s: number;
  groups: PairGroup[];
  features: Record<string, boolean> | null;

  constructor(
    fontPath: string,
    family: string,
    upem: number,
    budgetS: number,
    elapsedS: number,
    groups: PairGroup[],
    features: Record<string, boolean> | null = null,
  ) {
    this.font_path = fontPath;
    this.family = family;
    this.upem = upem;
    this.budget_s = budgetS;
    this.elapsed_s = elapsedS;
    this.groups = groups;
    this.features = features;
  }

  group(key: string): PairGroup | null {
    return this.groups.find((g) => g.key === key) ?? null;
  }

  get n_tested(): number {
    return this.groups.reduce((n, g) => n + g.tested.length, 0);
  }

  get n_failed(): number {
    return this.groups.reduce((n, g) => n + g.failures.length, 0);
  }

  get n_untested(): number {
    return this.groups.reduce((n, g) => n + g.untested.length, 0);
  }

  get n_missing(): number {
    return this.groups.reduce((n, g) => n + g.missing.length, 0);
  }

  get n_pairs(): number {
    return this.groups.reduce((n, g) => n + g.cells.size, 0);
  }

  get budget_hit(): boolean {
    return this.n_untested > 0;
  }
}

// --------------------------------------------------------------------------- //
//  the pair test
// --------------------------------------------------------------------------- //

/**
 * `Font.filled()` with a cache.
 *
 * The engine caches contours but NOT the assembled polygon, and rebuilding it means
 * one geometry union/difference pass per contour. A 26x26 sweep asks for ~1350 glyphs
 * out of ~700 distinct ones, so without this the sweep runs roughly 13x longer than
 * it needs to for no extra information.
 */
function filledCached(font: Font, cache: Map<number, G.Geometry>, gid: number): G.Geometry {
  let hit = cache.get(gid);
  if (hit === undefined) {
    hit = font.filled(gid);
    cache.set(gid, hit);
  }
  return hit;
}

/** The first glyph of a run always sits at the origin — don't copy it. */
function moved(geom: G.Geometry, dx: number, dy: number): G.Geometry {
  if (dx === 0.0 && dy === 0.0) return geom;
  return G.translate(geom, dx, dy);
}

/** `time.monotonic()`. */
function monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** Python's `f"{type(exc).__name__}: {exc}"`. */
function excStr(exc: unknown): string {
  const e = exc as Error;
  return `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}`;
}

/** Python's `repr()` of a short string. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\");
  if (q === "'") body = body.replace(/'/g, "\\'");
  return q + body.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + q;
}

/**
 * Shape one pair and ask whether its ink is continuous.
 *
 * Guarded pair by pair: one glyph with a degenerate outline must cost us that single
 * cell, not the whole 676-pair sweep.
 */
function testPair(
  font: Font,
  cache: Map<number, G.Geometry>,
  left: string,
  right: string,
  features: Record<string, boolean> | null,
): PairResult {
  const text = left + right;
  let placed;
  try {
    placed = shape(font, text, features);
  } catch (exc) {
    return new PairResult(left, right, [], ERROR, null, null, `shaping failed: ${excStr(exc)}`);
  }

  const names = placed.map((p) => font.glyphName(p.glyph));
  const offsets = placed.map((p) => [p.x, p.y] as [number, number]);
  if (!placed.length) {
    return new PairResult(
      left, right, names, ERROR, null, null, "the shaper dropped both characters", offsets,
    );
  }

  const geoms: G.Geometry[] = [];
  for (const p of placed) {
    try {
      geoms.push(moved(filledCached(font, cache, p.glyph), p.x, p.y));
    } catch (exc) {
      return new PairResult(
        left, right, names, ERROR, null, null,
        `glyph ${pyRepr(font.glyphName(p.glyph))} would not build: ${excStr(exc)}`, offsets,
      );
    }
  }

  const blank = names.filter((_n, i) => G.isEmpty(geoms[i]));
  if (blank.length) {
    // No ink means nothing can overlap, and it also means the letter itself will not
    // cut. Either way it is a defect, not a pass.
    return new PairResult(
      left, right, names, EMPTY, null, null, "no ink in " + blank.join(", "), offsets,
    );
  }

  if (geoms.length === 1) {
    // A ligature: the font replaced both characters with one glyph, so the join is
    // drawn into the glyph and there is nothing left to test.
    return new PairResult(
      left, right, names, OK, 0.0, 0.0,
      "shaped to a single ligature glyph — no join to make", offsets,
    );
  }

  // Contextual shaping can emit more than two glyphs (inserted connectors, marks).
  // The run only cuts as one piece if EVERY consecutive link touches, so the pair is
  // judged by its worst link.
  let worst = 0.0;
  const broken: string[] = [];
  for (let i = 0; i + 1 < geoms.length; i++) {
    const a = geoms[i];
    const b = geoms[i + 1];
    if (G.intersects(a, b)) continue;
    const d = G.distance(a, b);
    if (!Number.isFinite(d)) {
      return new PairResult(
        left, right, names, ERROR, null, null,
        `gap between ${names[i]} and ${names[i + 1]} is not measurable`, offsets,
      );
    }
    worst = Math.max(worst, d);
    broken.push(`${names[i]}|${names[i + 1]}`);
  }

  if (!broken.length) return new PairResult(left, right, names, OK, 0.0, 0.0, "", offsets);

  return new PairResult(
    left, right, names, GAP, worst, worst / font.upem,
    "ink does not touch at " + broken.join(", "), offsets,
  );
}

/**
 * Worst gap over the consecutive links in geoms[lo..hi].
 *
 * Returns [worst gap or null, broken link names]. null means a distance came back
 * non-finite, which is a measurement failure, not a pass.
 */
function linkGaps(
  names: string[],
  geoms: G.Geometry[],
  lo: number,
  hi: number,
): [number | null, string[]] {
  let worst = 0.0;
  const broken: string[] = [];
  for (let i = lo; i < hi; i++) {
    const a = geoms[i];
    const b = geoms[i + 1];
    if (G.intersects(a, b)) continue;
    const d = G.distance(a, b);
    if (!Number.isFinite(d)) return [null, [`${names[i]}|${names[i + 1]}`]];
    worst = Math.max(worst, d);
    broken.push(`${names[i]}|${names[i + 1]}`);
  }
  return [worst, broken];
}

/**
 * Shape wrap[0] + left + right + wrap[1]; judge only the middle link.
 *
 * The joins to the wrapper letters are not the subject here — they are already covered
 * by the start-of-word groups — so a break against the wrapper must not be reported as
 * a failure of this pair. HarfBuzz cluster indices say which shaped glyphs came from
 * which typed character, which is the only reliable way to find the middle: contextual
 * shaping can emit any number of glyphs, and it may insert a connector between the two
 * letters that belongs to neither.
 */
function testMiddle(
  font: Font,
  cache: Map<number, G.Geometry>,
  left: string,
  right: string,
  features: Record<string, boolean> | null,
  wrap: [string, string] = MIDDLE_WRAP,
  mode = "middle",
): PairResult {
  const { build, window } = MODE_SHAPE[mode] ?? MODE_SHAPE.middle;
  const text = build(left, right, wrap);
  let placed;
  try {
    placed = shape(font, text, features);
  } catch (exc) {
    return new PairResult(
      left, right, [], ERROR, null, null,
      `shaping ${pyRepr(text)} failed: ${excStr(exc)}`, [], text,
    );
  }

  const names = placed.map((p) => font.glyphName(p.glyph));
  const offsets = placed.map((p) => [p.x, p.y] as [number, number]);
  if (!placed.length) {
    return new PairResult(
      left, right, names, ERROR, null, null,
      `the shaper dropped ${pyRepr(text)} entirely`, offsets, text,
    );
  }

  // `window` says which typed characters are the pair under test for this mode
  let idx = placed
    .map((pl, i) => (window.includes(pl.cluster) ? i : -1))
    .filter((i) => i >= 0);
  if (!idx.length) {
    // No cluster information (or the shaper merged everything into one cluster). Fall
    // back to positions only when the glyph count says the mapping is unambiguous;
    // otherwise refuse rather than measure the wrong link and call it a result.
    if (placed.length === text.length) {
      idx = [...window];
    } else {
      return new PairResult(
        left, right, names, ERROR, null, null,
        `cannot tell which of the ${placed.length} glyphs of ${pyRepr(text)} are the ` +
          `pair under test`,
        offsets, text,
      );
    }
  }
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);

  const geoms: G.Geometry[] = [];
  for (const pl of placed) {
    try {
      geoms.push(moved(filledCached(font, cache, pl.glyph), pl.x, pl.y));
    } catch (exc) {
      return new PairResult(
        left, right, names, ERROR, null, null,
        `glyph ${pyRepr(font.glyphName(pl.glyph))} would not build: ${excStr(exc)}`,
        offsets, text,
      );
    }
  }

  const blank: string[] = [];
  for (let i = lo; i <= hi; i++) if (G.isEmpty(geoms[i])) blank.push(names[i]);
  if (blank.length) {
    return new PairResult(
      left, right, names, EMPTY, null, null, "no ink in " + blank.join(", "),
      offsets, text, [lo, hi],
    );
  }

  if (lo === hi) {
    // Both letters shaped to ONE glyph — a ligature. There is no join left to make,
    // so there is nothing to fail.
    return new PairResult(
      left, right, names, OK, 0.0, 0.0,
      `${left}${right} shaped to the single glyph ${pyRepr(names[lo])} inside ` +
        `${pyRepr(text)} - no join to make`,
      offsets, text, [lo, hi],
    );
  }

  const [worst, broken] = linkGaps(names, geoms, lo, hi);
  if (worst === null) {
    return new PairResult(
      left, right, names, ERROR, null, null,
      `gap at ${broken[0]} is not measurable`, offsets, text, [lo, hi],
    );
  }
  if (!broken.length) {
    return new PairResult(left, right, names, OK, 0.0, 0.0, "", offsets, text, [lo, hi]);
  }
  return new PairResult(
    left, right, names, GAP, worst, worst / font.upem,
    "ink does not touch at " + broken.join(", ") + ` (shaped inside ${pyRepr(text)})`,
    offsets, text, [lo, hi],
  );
}

/**
 * The separator inside a {@link cellKey}.
 *
 * Spelled as an escape rather than typed as a literal character. The first version
 * of this file carried a raw NUL byte in the template string: it looked like a space
 * in every editor, made the file report as binary to grep, and split wrongly wherever
 * it was read back. A separator nobody can see is a separator nobody can split on.
 * NUL is still the right CHOICE — no letter can contain it — it just has to be
 * written down.
 */
export const CELL_KEY_SEP = "\u0000";

/**
 * The Map key for one cell.
 *
 * The Python keys `cells` on the tuple `(left, right)`; a JavaScript Map compares
 * object keys by identity, so the pair is flattened into a string instead. Use
 * {@link splitCellKey} to get the pair back rather than splitting by hand.
 */
export function cellKey(left: string, right: string): string {
  return left + CELL_KEY_SEP + right;
}

/** The (left, right) pair a {@link cellKey} was built from. */
export function splitCellKey(key: string): [string, string] {
  const i = key.indexOf(CELL_KEY_SEP);
  return [key.slice(0, i), key.slice(i + CELL_KEY_SEP.length)];
}

/**
 * Test every two-character combination in the requested groups.
 *
 * @param font     an open Font
 * @param sets     any of the {@link GROUP_KEYS}
 * @param budgetS  wall-clock ceiling for the WHOLE sweep. Whatever is left when it
 *                 expires comes back as UNTESTED — deliberately not as OK, because a
 *                 pair nobody measured is not a pair that works.
 * @param features OpenType features to shape with; null uses the engine's defaults,
 *                 which is what the real cut file gets. Pass {} to see the font with
 *                 contextual alternates switched off, i.e. the bare base glyphs.
 */
export function analysePairs(
  font: Font,
  sets: string[] = DEFAULT_GROUPS,
  budgetS: number = DEFAULT_BUDGET_S,
  features: Record<string, boolean> | null = null,
): PairReport {
  const keys = [...sets];
  const unknown = keys.filter((k) => !GROUP_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(
      `unknown pair group(s) ${JSON.stringify(unknown)}; expected any of ` +
        `${JSON.stringify(GROUP_KEYS)}`,
    );
  }

  const cache = new Map<number, G.Geometry>(); // glyph id -> filled polygon
  const started = monotonic();
  const groups: PairGroup[] = [];
  const inCmap = (c: string) => font.cmap.has(c.codePointAt(0) as number);

  for (const [key, label, lefts, rights, mode] of GROUP_SPECS) {
    if (!keys.includes(key)) continue;
    const group = new PairGroup(key, label, lefts, rights, mode);
    // A wrapped test needs its wrapper letters as well as the pair itself
    const needed = WRAPPED_MODES.includes(mode) ? MIDDLE_WRAP : [];
    const wrapAbsent = needed.filter((c) => !inCmap(c));
    for (const left of lefts) {
      for (const right of rights) {
        const absent = [left, right].filter((c) => !inCmap(c)).concat(wrapAbsent);
        if (absent.length) {
          group.cells.set(
            cellKey(left, right),
            new PairResult(
              left, right, [], MISSING, null, null,
              "not in the font's cmap: " + absent.join(" "),
            ),
          );
          continue;
        }
        if (monotonic() - started > budgetS) {
          group.cells.set(
            cellKey(left, right),
            new PairResult(
              left, right, [], UNTESTED, null, null,
              `the ${pyG(budgetS)}s budget ran out before this pair`,
            ),
          );
          continue;
        }
        group.cells.set(
          cellKey(left, right),
          WRAPPED_MODES.includes(mode)
            ? testMiddle(font, cache, left, right, features, MIDDLE_WRAP, mode)
            : testPair(font, cache, left, right, features),
        );
      }
    }
    groups.push(group);
  }

  return new PairReport(
    font.path, font.family, font.upem, budgetS, monotonic() - started, groups, features,
  );
}

// --------------------------------------------------------------------------- //
//  instruction for a font-editing AI
// --------------------------------------------------------------------------- //

/**
 * 3 decimals normally — more when 3 would round a real gap down to zero.
 *
 * A hairline gap is still a broken nameplate, so it must never print as "0.000 em"
 * and read like a pass.
 */
export function fmtEm(value: number): string {
  if (value && Math.abs(value) < 0.001) return fmtF(value, 5);
  return fmtF(value, 3);
}

/** Python's `round()` — half to even, not half away from zero. */
function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * The failures, rewritten as a paste-ready brief for an AI that edits fonts.
 *
 * Deliberately plain text with no markdown: it gets pasted straight into a chat, and
 * it names the font, the em, and the exact SHAPED glyph names, because every one of
 * those has been a source of an edit landing on the wrong glyph in the wrong font at
 * the wrong scale.
 */
export function claudePrompt(_font: Font, report: PairReport, fontPath: string): string {
  const upem = report.upem;
  // Ask for a real bite, not a kiss. 1% of the em is enough for skia's union to fuse
  // two contours reliably at any sane cutting scale.
  const overlap = Math.max(8, Math.trunc(pyRound(0.01 * upem)));
  const L: string[] = [];
  const a = (s: string) => L.push(s);

  a("FONT TO EDIT");
  a(`  file name    : ${basename(fontPath)}`);
  a(`  full path    : ${resolve(fontPath)}`);
  a(`  family name  : ${report.family}`);
  a(`  unitsPerEm   : ${upem}`);
  a("");
  a(`Every size below is in FONT UNITS on this font's ${upem}-unit em.`);
  a(`For scale: 1% of the em is ${overlap} units. Do not read the numbers as`);
  a("points, pixels, millimetres or percentages.");
  a("");
  a("WHY THIS MATTERS");
  a("  These letters get laser-cut out of one piece of sheet metal. The cutting");
  a("  app unions all the letters of a name into ONE closed path. Wherever two");
  a("  neighbouring letters do not overlap, the union leaves two separate");
  a("  islands and that letter drops out of the sheet as a loose piece.");
  a("");

  const totalFailed = report.n_failed;
  if (totalFailed === 0) {
    a("RESULT: NOTHING TO FIX.");
    a(`  All ${report.n_tested} pairs that were tested have overlapping ink,`);
    a("  so every one of them will union into a single cut path.");
    if (report.n_missing) {
      a(`  ${report.n_missing} pairs were skipped because a character is not`);
      a("  in the font's cmap.");
    }
    if (report.budget_hit) {
      a(`  WARNING: ${report.n_untested} pairs were NOT tested - the`);
      a(`  ${pyG(report.budget_s)}s time budget ran out. Those are unknown, not passes.`);
      a("  Re-run with a larger budget before treating the font as clean.");
    }
    a("  Do not make any changes to this font.");
    return L.join("\n");
  }

  a(`FAILING PAIRS: ${totalFailed} of ${report.n_tested} tested pairs have a`);
  a("gap between the two letters. They are grouped by their LEFT letter,");
  a("because the left letter's exit stroke is usually the single thing that");
  a("has to change to fix the whole group.");
  a("");

  for (const group of report.groups) {
    const buckets = group.byLeft();
    a(
      `--- ${group.label.toUpperCase()} --- ` +
        `${group.failures.length} of ${group.tested.length} tested pairs failed`,
    );
    if (!buckets.length) {
      a("  none failed in this group.");
      a("");
      continue;
    }
    for (const [left, results] of buckets) {
      a(
        `  LEFT LETTER '${left}'  (${results.length} failing pair` +
          `${results.length !== 1 ? "s" : ""})`,
      );
      for (const res of results) {
        if (res.status === GAP) {
          const need = (res.gap ?? 0.0) + overlap;
          const run = res.glyphs.join(" -> ");
          a(`    '${res.left}' + '${res.right}'   glyphs: ${run}`);
          a(
            `        gap ${fmtF(res.gap as number, 1)} units (${fmtEm(res.gap_em ?? 0.0)} em)` +
              ` - close it and then overlap: extend by >= ${fmtF(need, 0)} units`,
          );
        } else if (res.status === EMPTY) {
          a(`    '${res.left}' + '${res.right}'   glyphs: ${res.glyphs.join(" -> ") || "(none)"}`);
          a(`        NO INK: ${res.detail} - this glyph does not draw at all`);
        } else {
          a(`    '${res.left}' + '${res.right}'   glyphs: ${res.glyphs.join(" -> ") || "(none)"}`);
          a(`        could not be measured: ${res.detail}`);
        }
      }
      a("");
    }
  }

  a("WHAT TO CHANGE");
  a("  For each failing pair, extend the LEFT glyph's exit stroke (or, where");
  a("  that would distort the letter, the RIGHT glyph's entry stroke) along the");
  a("  natural direction of the stroke until the two outlines OVERLAP by at");
  a(`  least ${overlap} font units measured across the join.`);
  a("  A hairline touch is NOT enough. The app unions the letters into one cut");
  a("  path, and two outlines that only graze each other can union into a");
  a("  pinch that the laser cuts straight through. Aim for a real overlap.");
  a("  Keep the extension on the stroke's own path and weight so the letter");
  a("  still reads as the same letter - do not add a straight connector bar.");
  a("  Every gap above was measured with this font's own kerning applied, the");
  a("  same way the cutting app shapes a name. Some of these pairs are pushed");
  a("  apart by a positive kern; close them by extending the outline anyway.");
  a("  The spacing is the design and the app depends on it, so do not buy the");
  a("  overlap by re-kerning the pair.");
  a("");
  a("EDIT THE GLYPH THAT IS NAMED, NOT THE BASE LETTER");
  a("  This font uses contextual alternates, so the glyph that actually draws");
  a("  in a pair is often NOT the plain base glyph. The 'glyphs:' line above");
  a("  gives the real shaped glyph names, in order, as the shaper chose them");
  a("  (names like 'g.alt3' or 'bflourishrightring.eng3' are alternates).");
  a("  Make each edit on the glyph named there. Editing the plain base glyph");
  a("  instead changes something nobody sees and leaves the gap exactly as it");
  a("  is. If one alternate is shared by several failing pairs, fixing it once");
  a("  fixes all of them - check before editing the same outline twice.");
  a("");
  a("DO NOT CHANGE");
  a("  - unitsPerEm");
  a("  - cap height, x-height, ascender, descender, or any vertical metric");
  a("  - advance widths and side bearings (the letters must not re-space)");
  a("  - kerning values");
  a("  - eyelet hole sizes, shapes or positions");
  a("  - the set of alternate glyphs, or the feature rules that pick them");
  a("    (calt, liga, rlig, kern) - the same alternate must still be chosen");
  a("    for the same pair after the edit");
  a("  - the colour layers / engrave lines");
  a("  - ANY glyph not named in the list above");
  a("");
  a("HOW IT WILL BE CHECKED");
  a("  Every pair is re-shaped and the two filled outlines are tested for");
  a("  intersection. A pair passes only when the ink actually overlaps, and no");
  a("  pair that passes today may start failing.");
  if (report.n_missing) {
    a(`  (${report.n_missing} pairs are skipped: a character is not in the cmap.)`);
  }
  if (report.budget_hit) {
    a(
      `  (${report.n_untested} pairs were NOT tested before the ` +
        `${pyG(report.budget_s)}s budget ran out, so more may still be broken.)`,
    );
  }
  return L.join("\n");
}

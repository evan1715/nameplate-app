---
name: nameplate-font
description: Build or finish a laser nameplate font to Sean's targets — a cap height, eyelet inner diameter and wall, and a minimum letter thickness. Use when handed a font (.ttf/.otf) to make, complete, fix, thicken, or adjust eyelets on for ShineOn nameplates, or when asked to make a font meet a size/thickness spec. Drives Sean's Font Prototyping Friend as the measuring instrument and judge.
---

# Building a nameplate font to spec

You are editing a font so it cuts correctly as a laser nameplate. You do not
guess whether it is right — **the app measures and judges it, and its exit code
decides when you are done.**

## The one command

```bash
python nameplate_brief.py --font <FONT> --cap <H> --unit in \
    --eyelet-id <ID> --eyelet-wall <WALL> --min-thickness <MIN> \
    --json brief.json --md brief.md
```

Run it from `C:\Users\Zack\Documents\Calude Code Apps\nameplate-app`
(the "Calude" misspelling is real — do not correct it). Python is at
`C:\Users\Zack\AppData\Local\Programs\Python\Python312\python.exe`; call it by
full path, because `python` on PATH is a Microsoft Store stub.

**Exit code is the contract:**

| code | meaning | what you do |
|---|---|---|
| 0 | every target met | stop, report, hand the font back |
| 1 | builds, but targets not met | fix the next thing, run again |
| 2 | unusable — will not parse, no cmap, a name fails to build | fix that first; nothing else matters |
| 3 | the tool itself failed | read stderr, fix the invocation |

Never declare a font finished on your own judgement. Only exit 0 does that.

## The loop

1. **Measure first, before touching anything.** Run the command. Read
   `brief.md` for the shape of the problem and `brief.json` for the numbers.
2. **Fix in this order.** Later items are meaningless if an earlier one is broken:
   1. `verdict: unusable` / `font_check.findings` with `severity: ERROR`
   2. `blocking` — a test name that cuts as more than one loose piece
   3. `pairs.worst_first` — letter pairs that do not join. Each carries the
      `position` it failed at and the `shaped_from` string it was tested inside,
      and **position matters as much as the pair**: these fonts swap glyphs by
      position, so "d+d fails" is half a fact. On the Flourish font `dd` (a whole
      word) and `dda` (the first letter of a name) use different second glyphs
      and break at different junctions. Fix the junction the report names, in the
      glyph it names — the positions tested are whole word, first letter, middle,
      and last letter.
   4. `targets` rows reading `NOT MET`
3. **Work in font units, never in inches.** Every target row gives
   `font_units.measured -> font_units.target`. Those hold at *every* cutting
   height because everything scales linearly — set them once and the font is
   right at 1 in and at 12 mm. A value in inches is only true at the height it
   was measured at.
4. **Re-run after every edit.** One edit, one measurement. Two edits at once and
   you cannot tell which one moved the number.
5. **Stop at exit 0.** Then report what changed, per glyph, with before/after
   font-unit coordinates.

## What the numbers mean

- `targets[]` — one row per judged target: `measured`, `target`, `change_pct`,
  `font_units`, `verdict`. `eyelet inner diameter` and `eyelet wall` must match
  (`equal`); `thinnest part of the letters` is a floor (`at-least`), so thicker
  is fine.
- `eyelets[]` — measured on the **shaped artwork**, not the font in the
  abstract. Eyelets are contextual glyphs that only appear on the first and last
  letter, so they only exist once a name is shaped. `wall_thinnest` is the number
  that decides whether the eyelet tears out; `wall_avg` is `(OD-ID)/2`.
- `thickness.spots[]` — worst first, each with `letter`, `where`, `at` (position
  from the artwork's bottom-left), `thickness_font_units`, `needs_pct`, and
  **`clearance`** / `parallel_walls`. Read the clearance before thickening
  anything: about **0.50 means parallel walls — a genuine web that will snap**,
  worth fixing; nearer **0.42 is a taper into a junction**, where the reading is
  the width of a wedge rather than of a stroke, and usually is not.
  Fixtures: ADAM reads 72.76 fu and CHRISTOPHER 18.13 fu at 1.000 in cap on
  Merriweather-Cut3, both at clearance 0.500, both double-derived. If either
  number moves, the sampler has regressed — say so rather than editing the font.
- `cap_height_check` — a **fact block, not a target.** Nothing in it can fail, by
  design. It used to be a judged row and that was a bug: it compared a single H's
  ink bounding box against a cap-LINE target, so any font whose H overshoots
  failed forever and exit 0 was unreachable — and the only way to close that gap
  is to squash the H, destroying the overshoot the app exists to preserve. **If
  you ever see a cap-height row reading NOT MET, the app has regressed. Do not
  edit the font to satisfy it.**
  It reports the cap line in font units and, per letter for H E I T A O J Q, the
  ink top and how far it sits over the cap line. Round and pointed capitals read
  over the line on purpose (overshoot): in Merriweather at 1.000 in, H = 1.000,
  A = 1.004, O = 1.029, J = 1.260. **All correct. Never "fix" it.** The cap LINE
  is what is held constant across every name, which is the entire reason the app
  exists.
- `names[]` — `pieces` must be 1. A nameplate has to cut as one plate; separate
  pieces fall apart on the bed.
- `prompts` — four paste-ready instruction blocks (font defects, letter pairs,
  thin areas, eyelet size). **An empty string means nothing to fix in that
  area** — do not invent work for it. Use these as your own brief; they already
  name the glyphs and the exact sizes.
  **Use ONE block per round.** They overlap, and their fences contradict each
  other: block 4 resizes eyelet holes that blocks 1 and 3 forbid touching. Every
  block was measured on the same version of the font, so once you act on one the
  others describe a font that no longer exists — re-run and take the fresh
  blocks. All four are plain ASCII by contract.
- `blocking[]` — hard stops that make the verdict "needs work" no matter what
  the target rows say. Read it first. It fires when a test name cuts as more than
  one piece, when letter pairs were **never tested** (the scan ran out of time —
  an untested pair is not a passing pair), and when more thin areas are under
  target than the report lists.
- `thickness.areas_found` / `areas_below_target` / `spots_shown` — `spots[]` is
  capped, so these say how much you are not being shown. Fixing the eight listed
  areas does not finish a font with forty.

## Rules that come from the app, not from taste

- **Never add, delete, merge or reorder glyphs.** The app addresses glyphs by
  ID. If you must add one, append it to the very end of the glyph order.
- **Do not change** unitsPerEm, the family name, cap height, x-height, advance
  widths, or any glyph you were not asked to touch. `report_text` in the JSON
  lists the fence explicitly.
- **Do not subset** or "remove unused glyphs", and do not decompose or recompose
  composites.
- **Eyelets are contextual forms on several glyphs.** Change the eyelet in
  *every* glyph that carries one, or the two ends of a name stop matching.
- **Cut-only is normal.** Most of these fonts have no COLR table and therefore
  no engrave lines. That is expected and is not a defect to fix. Only add
  engraving if you were explicitly asked to.
- Missing apostrophe / hyphen / period is fine and not reported. A missing
  **space** is a real problem — two-word names run together.
- `post` table format 3.0 (no glyph names) is handled by the app but makes
  editing miserable; re-export with format 2.0 if you get the choice.

## Looking at it, not just measuring it

The numbers do not tell you whether the letters actually look right or how they
join. Two things to look at:

- **`brief.md`** already lists the flagged pairs and the thin places with their
  letters and positions.
- **The app itself**, for anything visual — the letter-pair sheet (all 1,352
  two-letter combinations drawn from raw outlines, the font as Illustrator shows
  it), the thin-area overlay, and the eyelet dimensions. Launch it with
  `python nameplate_gui.py`, pick the font, and use "View every letter pair…"
  and "Generate prompts…". Do this when a pair is flagged and you need to see
  *how* it breaks before deciding which side to edit.

Offscreen rendering has no font database, so any screenshot you take headlessly
draws text as empty boxes. Set `QT_QPA_PLATFORM=windows` to get real text.

The pair sheet has **seven rows per letter**, one per position a pair can occupy
in a name: whole word (both eyelet forms), first letter (initial → medial),
middle (medial → medial, teal), last letter (medial → final, purple). Hover any
cell for the shaped glyph names — that is how you confirm which positional form
you are looking at.

## Reporting a problem with the app itself

Click **Health check…** and copy the text. It carries the build id, the paths,
and whether the machine can run it. A bug report without it cannot be tied to
code, because there is no git here and two exes of the same size can differ by a
fix. Crashes inside a worker thread also write `crash-*.txt` beside
`startup.log`.

## Reporting back

State, in this order: the verdict and exit code; every target with before →
after; each glyph you changed with its ID, which contour and points moved, and
before/after coordinates in font units; and anything you chose not to change and
why. If you stopped short of exit 0, say exactly which target is still NOT MET
and what you would do next — never imply it is finished.

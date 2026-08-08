Sean's Font Prototyping Friend
==============================
Type a name, get a laser-ready cut file. One merged outline, no fill, hairline
stroke, red engrave lines kept as open centerlines, sized in mm or inches,
exported as SVG and PDF for CorelDRAW.


RUNNING IT
  Open a Command Prompt in this folder and run:

      cd ts
      npm start

  It prints an address — http://127.0.0.1:8175/ — open that in your browser.
  Leave the Command Prompt window open while you use it; that window IS the
  app, and closing it stops it. Full instructions, including the one-time
  setup, are in INSTALL.txt.

  It needs Node.js. No Python, no installer, no admin rights. Copy this whole
  folder anywhere — another PC, a USB stick, a network share — and it runs from
  wherever it sits.

  It listens on 127.0.0.1, which means this computer and nothing else. Nobody
  on the network can reach it and there is no setting to change that.


THE FOLDER
  ts\                     the app itself
  fonts\                  your fonts live here (see below)
  settings.json           remembers your last font and settings; created on
                          first run, safe to delete
  README.txt              this file
  INSTALL.txt             how to set it up on a new machine


FONTS
  Every .ttf / .otf / .ttc in fonts\ shows up in the Font dropdown.

  Adding one    Either drop the file into fonts\ and click Refresh, or use
                "Add font…" which copies it into fonts\ for you. Either way it
                travels with the folder.

  New version   Drop the new file in and click Refresh — no restart needed. If
  of a font     two files report the same font name, the app uses the newest
                file and shows each one's date so you can tell them apart.

  The grey line under the dropdown tells you the file name, its date, and
  whether that font "carries engrave lines" or is "cut only".


USING IT
  Names         One name per line. The preview shows the line your cursor is
                on. Batch as many as you like.

  Height        A number plus mm or in. Switching mm/in converts the number,
                so the artwork keeps its physical size. Minimum 0.05 in / 1 mm.

  Measured from cap height  — the first capital letter in that name
                x-height    — the font's own lowercase height
                total       — everything, including eyelets and descenders

  Preview       Scroll to zoom, drag to pan, double-click to fit. The dashed
                box is the real artwork size, labelled in your chosen unit.
                Black = cut, red = engrave. The preview is always on white,
                whatever theme the rest of the page is in — a cut file is
                judged against white paper.

  Warnings      Amber notes are information, not errors, and never stop an
                export. "No engrave lines for this name" is normal — some
                fonts only place an engrave line before a lowercase letter,
                and some fonts have none at all.


LASER LEAD-IN LINES
  Tick "Add lead-in lines", set a length and a standoff.

  What you get   One approach inside every hole — letter counters and eyelet
                 holes — plus one outside the name. The laser pierces at the
                 far end, in the scrap that drops out, and travels in before it
                 reaches the part, so the pierce mark never lands on a finished
                 edge. Nothing is ever placed inside the material of the name.

  VERIFIED IN CORELDRAW
                 This is not a guess. CorelDRAW 2022 was driven directly and
                 asked what it had actually imported: the lead-in paths arrive
                 OPEN (not silently closed), each one carries its whole contour
                 as a single path of up to 477 nodes, and all 6 pierce points
                 are the START nodes of those paths — distance 0.000. With the
                 toggle off the same outline imports CLOSED, which proves the
                 difference is the lead-in feature and not chance.

  READ THIS — HOW THEY ARE WRITTEN, AND WHY
                 CorelDRAW has no idea what a lead-in is; it is a drawing
                 program. Lead-in/lead-out is a feature of laser software
                 (LightBurn generates them from its own Angle/Length settings)
                 or of a CAM plugin. And laser software cuts every path in a
                 file separately — it will NOT join a stray little line onto a
                 nearby closed outline.

                 So a lead-in drawn as its own separate line does not work: the
                 machine cuts that line off in the scrap, then pierces the
                 outline on the finished edge anyway.

                 This app therefore writes each lead-in as PART OF the outline:
                 one continuous open curve that starts out in the scrap, runs in
                 to the edge, and carries straight on around the whole contour.
                 Any software that simply follows the path starts in the waste
                 and flows into the cut. In Corel you will see one open curve
                 per contour instead of a closed shape — that is correct and
                 intended.

                 IF YOUR LASER SOFTWARE HAS ITS OWN LEAD-IN SETTING, USE THAT
                 AND LEAVE THIS SWITCHED OFF, or you will get two lead-ins.

  Keep clear     How far the approach stays away from every letter edge along
                 its length, so the beam cannot scorch the part. Only the last
                 fraction next to the outline is allowed close — that is where
                 it joins the cut. Relaxed automatically in a counter too tight
                 to hold it, but never below a kerf; a hole with no safe way in
                 is skipped and reported instead of being cut badly.

  In the preview A small purple ring marks each pierce point.

  Length         Real physical length, so 0.1 in stays 0.1 in whatever height
                 the name is. In a tight counter it is shortened to the longest
                 that genuinely fits rather than cutting into the letter.

  Height         Lead-ins are NEVER counted in the height. The size shown in
                 the app and the scale of the artwork are identical whether the
                 toggle is on or off.


EYELETS
  Measured on the name you are previewing, at the height you have set — not on
  the font in the abstract, since the eyelet only appears on the first and last
  letter.

  Show eyelet sizes on the preview
                 Tick it and the sizes are drawn straight onto the artwork:
                 the inner diameter across the hole, the outer diameter down
                 it, and the wall AT THE EXACT POINT WHERE IT IS THINNEST —
                 that is the spot that tears out, so that is where the
                 dimension goes. All in teal, with a key in the corner.

  The table      actual | want | change, live on the main window, no pop-up:

                     inner Ø         0.3448    0.3793    +10.02%
                     outer Ø         0.6549    0.7793    +19.00%
                     wall, avg       0.1551    0.2000    +28.97%
                     wall, thinnest  0.1548

                 The want and change cells stay BLANK for anything you did not
                 ask for. A blank means "not asked for" — a 0.00% would claim
                 the eyelet is already right.

  Want ID / wall Type the size you actually want. Leave the boxes at "—" to
                 only measure.

                 BACKSPACE THE BOX EMPTY to take a target back out again. It
                 goes to "—", meaning nothing — not 0 — and the wanted size
                 disappears from the preview and from the want/change columns.

  Show the wanted size on the preview
                 Draws the eyelet you are ASKING for over the one you have:
                 wanted inner diameter in green, wanted outer diameter in light
                 green. Untick to see the artwork on its own — the numbers in
                 the table stay either way.

  Full eyelet report…
                 The same numbers plus roundness, both ends when the name has
                 two, and the exact font-unit sizes to hand to whoever edits
                 the font. Because everything scales linearly, font-unit sizes
                 hold at any height, not just the one measured. The text can be
                 selected with the mouse.


THIN AREAS
  "Show the thinnest parts" finds the places that snap when the part is cut from
  metal, and marks each one ON THE PREVIEW: the crossing it was measured across,
  the distance written next to it, and a colour for how bad it is —

      magenta  the thinnest place in this name
      orange   next
      amber    next
      olive    the least thin of the ones found
      green    already at or above the thickness you asked for

  Numbered 1, 2, 3… worst first, matching the report. With a target typed the
  colours mean pass or fail against that target instead, and the letters at the
  wanted thickness are drawn over the top in cyan.

  Labels that would sit on top of each other are dropped rather than smeared —
  zoom in and they come back.


CHECKING A FONT
  Every font is checked automatically the moment you select it. The grey line
  under the dropdown ends with the verdict, and anything found appears in the
  amber panel.

  "Check font"   The full report: what is wrong, what it does to the artwork,
                 and what to change in the font. It also scans letter pairs for
                 gaps, including pairs behind a leading letter — a script font
                 can join 'go' perfectly and still break in 'ego', because it
                 swaps in a different form mid-word.

  "Reload font"  Re-reads the selected file from disk. Use it after replacing a
                 font with a new version under the same file name.

  Missing punctuation is NOT reported as a problem. These fonts are drawn for
  single names and are not expected to carry an apostrophe, hyphen or period; it
  is listed among the font facts instead. A missing SPACE still is a warning,
  because a two-word name would run together.

  If a name cannot cut as one piece, the preview says so and names the junction
  that broke.

  "View every letter pair…"
                 Every letter combination on one scrollable sheet, drawn from
                 the raw outlines — the font as Illustrator shows it with text
                 converted to outlines, not a Windows font preview.

                 SEVEN ROWS PER LETTER — one for every position a pair can
                 occupy in a real name. These fonts change the glyph by
                 position, so a pair that joins in one position breaks in
                 another:

                     Xa  xa      the WHOLE word: first letter INITIAL (eyelet),
                                 last letter FINAL (eyelet)
                     Xaa xaa     the FIRST LETTER of a longer name: initial
                                 form joining a MEDIAL one       (purple)
                     AXaa Axaa   the MIDDLE: both medial, no eyelet   (teal)
                     Axa         the LAST LETTER of a longer name: medial
                                 joining the FINAL form          (purple)

                 That covers your three cases: the initial eyelet, the end
                 eyelet, and the plain glyphs in between.

                 The end rows are not the same test as the whole-word rows. On
                 the Flourish font 'dd' shapes to Dleftring+dflourishrightring
                 while 'dda' shapes to Dleftring+d+aflourishrightring — and
                 THAT junction is broken. Before these rows existed, nothing in
                 the app could see it.

                 It is not the same test twice: shaping 'ab' gives A.ini + B.e0,
                 while the same pair inside 'Aaba' gives A.e0 + B.e0 — different
                 outlines. On one of the production fonts a pair joins fine as a
                 whole word and breaks in the middle of one.

                 Hover any cell for the shaped glyph names, with the two letters
                 under test in bold. That is how you confirm you are looking at
                 the form you think you are.

                 If a font's lowercase rows look like capitals, the font is
                 caps-only — its lowercase characters map to the same glyphs as
                 its capitals. That is the font, not the sheet.

                 The count of flagged pairs is at the top. "next flagged ▶" and
                 "◀ previous" jump the view from one flagged pair to the next in
                 reading order, the way Ctrl+F walks a document; F3, Ctrl+F or
                 Enter do the same, Shift+F3 goes back. The pair you are on gets
                 a purple ring.

                 Zoom out to 30% to see the whole sheet at once, or in to 240%
                 to look closely.


PROMPTS FOR CLAUDE
  "Generate prompts" collects every paste-ready instruction
  for the current font into one window, one box per area:

      1. Font defects
      2. Letter pairs that do not join
      3. Thin areas to thicken
      4. Eyelet size

  Each box has its own Copy button, and the text can be selected with the mouse
  like any other text. A box left BLANK means there is nothing to fix in that
  area — the app will not invent a repair request for a font that is already
  right. Sections 3 and 4 need a wanted thickness or a wanted eyelet size typed
  in first, since without a target there is no change to ask for.

  Every prompt is plain ASCII and names the font, so it pastes anywhere without
  mangled characters and Claude cannot mix up which font you mean.


EXPORTING
  Tick SVG, PDF, or both.

  One file per name (zip)   One file per name inside a zip, named after the
                            name (Mary Jane -> Mary_Jane.svg).
  One sheet                 Every name on a single sheet. Set the spacing with
                            "Sheet gap", in your chosen unit.

  Both land in your browser's Downloads, and a copy is also written to
  exports\ inside the app folder — so "where did it go?" always has a path as
  an answer, not just a browser setting.

  Sheet layout   stacked        names top to bottom, aligned on the left
                 side by side   names left to right, aligned on the bottom

                 Either way each name is placed by its own bounding box plus
                 the gap, so names cannot overlap. If a gap ever would make them
                 overlap the export refuses and tells you, rather than writing a
                 sheet with names on top of each other.


CUTTING ORDER — THIS MATTERS FOR SHEET METAL
  A part is held by the surrounding sheet only until its outer edge is cut. The
  moment the outline finishes, the part drops or shifts, and anything cut after
  that is cutting air or a moved part.

  So every file is written in cutting order. Cut order comes from stacking
  order, bottom first, and the app writes, for each name:

      1. the engraving          (while the part is still fully supported)
      2. the inner cuts         (letter counters and the eyelet holes)
      3. the outline            LAST

  Each name is finished before the next one starts, so on a multi-name sheet
  name 1 is complete and dropped out before name 2 is touched.

  This has been checked in CorelDRAW itself, not just assumed: after import the
  engraving sits at the bottom of the stack and an outline cut sits at the top,
  for both SVG and PDF.

  If your laser software re-orders or optimises the cut path, that will override
  this. Turn its path optimisation off, or check its preview, if you rely on the
  order.


IN CORELDRAW
  Import the SVG or PDF. Sizes are real: a 1 in cap height imports as 1 in —
  checked by driving CorelDRAW 2022 itself and reading its property bar, which
  matched the app's reported size for ADAM exactly. Lines are hairline, nothing
  is filled. (ADAM at 1.000 in cap height is 4.069 x 1.020 in; run the check in
  INSTALL.txt to confirm it on your own machine.)

  Each name comes in as its own container, so you do not have to group them by
  hand:
      SVG   one named GROUP per name, e.g. "ADAM", holding three subgroups in
            cutting order (engrave, inner cuts, outline)
      PDF   one named LAYER per name

  Cut versus engrave is told apart by colour — black cuts, red engraves — and
  both survive the import. Only the SVG can carry group NAMES; a PDF has no
  named-group concept, which is why names become layers there instead.

  PREFER THE SVG if you want to select CUT or ENGRAVE by name and keep the
  0.001 in hairline. Prefer the PDF if you want each name on its own layer.
  Both are the same physical size.

  The exported files contain cut and engrave geometry ONLY. The dashed size
  box and the dimension labels you see in the preview are on-screen guides;
  they are never written to the SVG or PDF, so there is nothing extra for the
  laser to mistake for a cut.

  The engrave lines are open centerlines, meant for a single laser pass. Don't
  close or fill them or they will be cut twice.


PROMPTS: ONE BLOCK PER ROUND
  The blocks in "Generate prompts…" overlap on purpose, and their rules
  contradict each other if you paste them all at once: block 4 resizes the
  eyelet holes, while blocks 1 and 3 say not to touch them. Paste ONE, get the
  font back, re-run, then use the fresh blocks. Everything in the window was
  measured on the same version of the font, so the moment one block is carried
  out the others are describing a font that no longer exists.


HEALTH CHECK
  "Health" in the top right tells you which build this is (a short id stamped
  in at build time), where it keeps its files, and whether this machine can
  actually run it — folder writable, fonts present, path not too long. Copy
  that text into any bug report; it is the only way to tie a problem to the
  exact code that produced it.


IF SOMETHING GOES WRONG
  The app shows the actual error in the amber panel rather than failing
  silently, and the Command Prompt window it is running in shows the rest.

  No fonts listed     Check that fonts\ sits in the app folder and holds at
                      least one .ttf/.otf/.ttc, then click Refresh. Health
                      prints the exact folder it is looking in.
  Page won't load     Look at the Command Prompt window. If it says
                      "address already in use", the app is already running in
                      another window. If it says "node is not recognised",
                      Node.js is not installed — see INSTALL.txt.
  Won't save settings The app folder is read-only. Move it somewhere under your
                      user folder. Health says whether it is writable.

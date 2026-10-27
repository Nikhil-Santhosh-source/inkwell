# Goodnotes Investigation Report

A user-visible behavior study and implementation plan for an original iPad
note-taking app. This is **not** a reverse engineering of Goodnotes.

Last updated: 2026-10-26

## 1. Scope and version

- **Goodnotes version observed:** None yet.
- **iPad model / iPadOS version:** Not provided.
- **Development machine:** Windows 11 PC. Node.js 24.22.1 and Git 2.49 are
  available. Xcode and the Swift toolchain are **not** available (they run
  only on macOS).
- **Project:** Inkwell, a PWA started from scratch (see `README.md`).
- **In scope (P0):** documents, canvas, Pencil ink, color/thickness, eraser,
  undo/redo, multiple pages, local save/restore.
- **Out of scope until approved:** cloud sync, accounts, analytics, any
  external service.

### Role of REA in this study

REA (the reverse-engineering MCP installed on this PC) is **not used to
analyze Goodnotes**, for these reasons:

- The playbook limits the study to user-visible behavior and forbids
  inspecting Goodnotes internals or bypassing app protections.
- The iPad app cannot be reached from this Windows PC. App Store builds are
  FairPlay-encrypted, and decrypting them would bypass a protection.
- Goodnotes' terms of service may restrict reverse engineering of its
  software (not yet checked).

REA can still help with **this project's own builds**, for example:
- inspecting our own web bundle or app binary
  (`analyze_web_bundle`, `inspect_artifact`)
- comparing two of our own releases (`compare_application_versions`)
- tracking open questions (`record_unknown`, `list_unknowns`)

## 2. Feature inventory

See `goodnotes_feature_map.md`. All 19 features are `Not investigated`.

## 3. Observed workflows

None yet. Use the observation template in the feature map and the sequence
below, with a disposable test notebook and non-sensitive sample files:

1. Library/home screen
2. Create a notebook
3. Canvas and toolbars
4. Write several strokes with Apple Pencil
5. Pen color and thickness
6. Erase, undo, redo
7. Lasso / selection
8. Add and navigate pages
9. Zoom and pan
10. Import and annotate a PDF
11. Rename, move, duplicate, delete a test document
12. Close and reopen to check persistence
13. Search and export
14. Rotate the iPad; background and foreground the app

Send screenshots or screen recordings for each step; they become the evidence.

## 4. Evidence and confidence

| Claim | Confidence | Evidence |
|---|---|---|
| Feature list in the feature map | Unknown (hypothesis) | Playbook only |

No Observed or Inferred claims yet.

## 5. Architecture proposal

The stack decision is open (see section 6). Both options share this
conceptual design:

- **App shell:** library, document view, settings, lifecycle handling.
- **Document model:** document metadata + ordered page ids; pages hold
  strokes. Kept independent of UI state.
- **Stroke format:** points in page coordinates with pressure and timestamp,
  plus color, width and tool. Versioned from the first release.
- **Edit commands:** every change is a command with an inverse, driving
  undo/redo and making edits unit-testable.
- **Persistence:** debounced autosave, atomic writes, schema version field,
  migration tests before any format change.
- **Rendering:** view transform (zoom/pan) separate from page coordinates;
  only visible pages rendered.

### Option A — Native iPadOS (Swift, SwiftUI + PencilKit/UIKit)
- Best inking latency, palm rejection, Pencil hover/pressure/tilt, and
  Files integration.
- **Requires a Mac** with Xcode to build, run in the simulator, and install on
  an iPad. Alternatives: a cloud Mac rental, or macOS CI (e.g. GitHub Actions)
  for builds, though testing on the device still needs a Mac or TestFlight.
  TestFlight needs an Apple Developer account (paid).

### Option B — Installable web app (PWA) for iPad Safari
- Buildable and testable on this Windows PC today; installs to the iPad Home
  Screen with no Mac or developer account.
- Apple Pencil works through Pointer Events (`pointerType: "pen"`, pressure,
  coalesced events).
- Weaker than native: somewhat higher ink latency, less reliable palm
  rejection, storage can be evicted unless persistent storage is granted, and
  limited Files/share integration.
- Could later be wrapped or rewritten natively; the document format and
  command model carry over.

**Recommendation:** Choose Option A if you have or can get a Mac. Otherwise,
choose Option B for the first milestone, and keep the data format
platform-neutral (JSON) so the work isn't lost if you switch later.

## 6. Risks and open questions

Decided:
- **Stack:** PWA (Option B), chosen 2026-10-26. App name: Inkwell.

Defaults in use (change any time):
- Minimum iPadOS: 17 (native) / Safari 17 (PWA).
- Storage: local only.
- PDF: import + annotate in P1; export in P1.
- Handwriting recognition: not required for the first version (P2).
- Purpose: personal use / prototype, not App Store distribution.

Technical risks:
- Ink latency and palm rejection (higher risk on PWA).
- Data loss on crash or storage eviction.
- Coordinate drift between zoom/rotation and stored strokes.
- Memory use on long documents.

Other open questions:
- Which iPad model and Apple Pencil generation will you use?
- Goodnotes' terms of service regarding reverse engineering (not yet checked;
  not needed for a behavior-only study).

## 7. Implementation progress

### Session 1 (2026-10-26) — planning
- Created `docs/goodnotes_feature_map.md` and `docs/goodnotes_investigation.md`.

### Session 2 (2026-10-26) — Milestone 1 built
Implemented in `app/` (plain JavaScript modules, no build step):
- Library: create, rename, open, delete (with confirmation).
- One fixed-size page (768×1024 units) per notebook, scaled to fit the screen.
- Pen input via Pointer Events with coalesced events and pressure; mouse
  accepted for desktop testing; finger input ignored unless enabled.
- Versioned JSON-shaped records in IndexedDB; each change is one transaction.
- Debounced autosave (400 ms), immediate save on hide/close, retry on failure.
- Web app manifest, PNG/SVG icons, network-first service worker.

Tests run:
- `npm test`: **22 passed, 0 failed** (model, storage with fake-indexeddb,
  autosave).
- Manual check in the desktop browser pane (Chromium, mouse input):
  created a notebook → drew 2 strokes → status showed "Saved" → reloaded →
  both strokes present → resized the window → strokes stayed in place on the
  page → a synthetic finger touch drew nothing → renamed → deleted → the
  database held 0 documents and 0 pages. No console errors.

Not verified:
- Anything on a real iPad: Apple Pencil pressure, latency, palm rejection,
  Safari gesture conflicts, rotation, Home Screen install.
- Offline mode / service worker (needs HTTPS or localhost; not exercised).
- Force-quit within 2 s of the last stroke on iPadOS.

Known issues and limits:
- No undo, eraser, colors, multiple pages, or zoom/pan yet (next milestones).
- Served over plain http on the LAN, Safari runs it without offline mode and
  may evict storage more readily; HTTPS hosting is not set up.
- Strokes are drawn as straight segments; no smoothing yet.

### Session 3 (2026-10-26) — iPad test of Milestone 1, then Milestone 2

iPad test (user's screen recording of Inkwell in Safari over the PC's Mobile
Hotspot, `192.168.137.1`). Observed in the recording:
- Parts of letters missing ("Nikhil" rendered as "Nk'l"): Safari's own touch
  handling was taking over some Pencil touches.
- Safari's text callout (Copy / Look Up / Translate) opened on the toolbar
  label where the palm rested; the palm also switched on "Draw with finger".
- Page filled ~40% of the landscape screen, so writing was small.
- User reported visible lag.

Fixes:
- `touchstart`/`touchmove` default prevented on the canvas area; text
  selection and callouts disabled app-wide; finger-drawing setting moved
  into the ⋯ menu, away from the writing area.
- Palm rejection: contacts larger than 44 px are ignored; touches are
  ignored while the Pencil is down; the Pencil cancels any finger gesture.
- Live ink drawn on a separate canvas layer each animation frame, with
  coalesced and (where Safari provides them) predicted pointer events;
  committed strokes on a base layer with cached outlines.
- Strokes smoothed (midpoint quadratic curves) and drawn as filled,
  pressure-varying outlines.
- Page fits the screen width and scrolls; pinch to zoom.

Milestone 2 added: toolbar (pen, highlighter, eraser, lasso), colors with a
custom picker, 3 sizes per tool, undo/redo (command model) with buttons,
keyboard and 2/3-finger taps, lasso move/delete/duplicate/recolor, 5 paper
templates × 7 paper colors (undoable), keyboard shortcuts with a help sheet.

Tests run:
- `npm test`: **49 passed, 0 failed** (adds commands, geometry, paper).
- Desktop browser pane at iPad landscape (1180×820) and portrait (820×1180)
  sizes, with synthetic pen events (varying pressure) and touch events:
  pen strokes, highlighter drawn under ink, a 80 px "palm" touch drew nothing
  and didn't scroll, two-finger tap undid, three-finger tap redid, eraser
  removed only crossed strokes, Ctrl+Z restored them, lasso selected and moved
  strokes, recolor, Grid + Dark paper, Ctrl+= zoom, wheel scroll, pinch, fit
  width, rotation keeps strokes in place. No console errors.

Not verified: everything on the real iPad — whether lag and broken strokes
are actually fixed, palm rejection with a real palm, and whether Safari
provides predicted events.

Known limits:
- Web apps can't use Apple Pencil double-tap/squeeze or PencilKit; latency
  will remain somewhat higher than native apps.
- Whole-stroke eraser only (no partial erase yet). One page per notebook.

### Session 4 (2026-10-26) — lasso fix, Milestone 3

User retest: reported a lasso issue (details not yet provided). Found and
fixed one likely cause: Delete/Duplicate on the selection bar could not be
tapped on iPad, because Safari-gesture blocking also applied to the bar.

Milestone 3 added:
- Multiple pages per notebook, stacked vertically with continuous scroll; ink,
  eraser and lasso act on the page where the Pencil lands.
- Pages sidebar (toggle) with live thumbnails, move up/down, delete (with
  confirmation; a notebook keeps at least one page), add page.
- Add page after the current page (button, ⇧⌘N); new pages copy the current
  page's paper. Page counter ("2 / 5").
- Undo/redo across pages (history per notebook; scrolls to the changed page).
- Library cards show a first-page preview and page count.
- Export PDF (⋯ menu, ⌘E): vector paths, highlighter transparency kept,
  Flate-compressed when the browser supports it. Uses the share sheet when
  available (needs https); otherwise downloads, which on iPad opens the PDF
  with its own Share button.
- Dialogs now resolve on button press instead of waiting for the `close`
  event, which a hidden browser pane delivered late or not at all.

Tests run:
- `npm test`: **58 passed, 0 failed** (adds multi-page storage, PDF
  structure/xref/stream lengths/compression round trip, history forget).
- Desktop browser pane at 1180×820 with synthetic pen events: strokes landed
  on the page under the pointer (counts per page [4, 1, 2] as drawn), add page
  inserted after the current page, move up ×2 reordered correctly, undo
  changed the right page, delete page cancel/confirm worked, export produced
  a 5-page, 38 KB compressed PDF named after the notebook. No console errors.

Not verified: everything on the real iPad; the PDF opened in a real viewer
(structure was checked programmatically only); the share sheet (needs https).

### Session 5 (2026-10-26) — iPad feedback fixes, seven milestones

User retest (screenshot): page too large in landscape, pinch zoom not
working, undo/redo taps laggy.
- Cause of pinch/tap problems: Safari reports fingertip contact sizes of
  40–70 px; the 44 px palm threshold discarded many fingers. Raised to 110 px.
  Taps right after writing were also ignored for 400 ms; now 150 ms.
- Page width at zoom 1 capped at 820 px (about full width in portrait);
  zoom level is remembered per device.

Milestones built (selected by the user):
1. PDF import & annotate — pdf.js 4.10.38 (legacy build, vendored in
   `app/vendor`, no CDN) renders each PDF page to a 1536 px JPEG used as the
   page background; pages keep the PDF's shape.
2. Shapes + partial eraser — hold the Pencil still ~0.55 s at the end of a
   stroke to snap to a line (level/plumb within 7°), ellipse, triangle or
   rectangle; eraser "Partial" mode cuts strokes into pieces.
3. Text & pictures — text tool (tap to type, tap again to edit), picture
   insert (scaled to ≤1600 px JPEG); both move, resize and delete with the lasso.
4. Folders & search — folders, move, duplicate notebook, search by name,
   sort by edited/name/created.
5. Backup & restore — whole library to one JSON file (pictures as base64);
   restore adds alongside, never overwrites; folders merge by name.
6. More pens & page sizes — ballpoint/fountain/pencil styles, custom colors
   saved as favorites (up to 6), page sizes 3:4, A4, Letter, landscape, square.
7. Page tools — drag pages in the sidebar, copy/cut/paste (⌘C/⌘X/⌘V,
   lasso tap on empty space → Paste), ruler (drag/twist with fingers; ink
   started at its edge draws straight).

Storage: IndexedDB version 2 adds `folders` and `assets` stores; existing
notebooks upgrade in place (verified in the browser with the earlier test
notebook). Each picture/PDF page asset belongs to exactly one page; deleting
a page or notebook deletes its assets; copies get their own assets.

Tests run:
- `npm test`: **86 passed, 0 failed** (adds items/update/batch/replace
  commands, shapes, partial erase, fountain widths, ruler snapping, assets,
  folders, duplicate, backup round trip, PDF images/text/pencil).
- Desktop browser pane at 1180×820 with synthetic pen/touch input:
  folder create/filter, landscape+grid notebook, search, sort, copy, move;
  PDF import of a 2-page PDF made by Inkwell's own exporter (pdf.js rendered
  it correctly — first real-viewer check of the export); fountain and pencil
  strokes; circle snapped to a 73-point ellipse; partial erase split two
  strokes, undo restored them; text box; picture insert; resize 200×100 →
  272×136; copy + lasso-tap paste at the tapped spot with its own asset;
  ruler stroke with zero vertical spread; sidebar drag moved page 3 to the
  top; export of 3 pages with 4 images re-opened in pdf.js; backup of 4
  notebooks/9 pages/4 assets restored as 4 added copies.

Not verified: all of the above on the iPad; PDF import speed and memory on
large PDFs on iPad; text in non-Latin scripts in exported PDFs (shown as "?").

Known limits:
- Imported PDF pages are pictures: their text can't be selected or searched,
  and very large PDFs take time and storage.
- Exported text boxes use Helvetica; characters outside Latin-1 become "?".
- Deleting a picture via undo/redo history keeps its stored image until the
  page or notebook is deleted (no orphan cleanup yet).

### Session 6 (2026-10-26) — whiteboard, connectors, ink settings, gestures

Source: two feature descriptions supplied by the user (`2.txt`,
`Untitled.txt`) describing Goodnotes' whiteboard, ink settings and Pencil
gestures. Treated as user-supplied descriptions (confidence: Inferred), not
verified against Goodnotes.

Built:
- Whiteboard notebooks: one endless page (no clamping), 5–400% zoom with a
  zoom badge (tap to reset), toggleable minimap (tap/drag to navigate), dot or
  square grid that coarsens when zoomed out. Exported to PDF and shown in the
  library framed around their content.
- Shapes: arrows are now recognized (shaft + barb, hold to snap). Lines and
  arrows whose ends land on a recognized shape, text box or picture become
  connectors; moving the shape stretches them in the same undo step.
- Layer locking: "Lock" on a selection; locked content is skipped by lasso,
  erasers, scribble-erase and connectors; "Unlock everything here" in ⋯.
- Pens: Brush added. Per-style ink settings (pressure sensitivity, tip
  sharpness/taper, fountain tip flatness, stroke stabilization) via the
  sliders button; highlighter stabilization. Fountain nib follows Pencil
  azimuth and a tilted pencil draws wider when Safari reports the angles
  (stored as optional 4th/5th point values). Ballpoint now defaults to
  constant width; strokes saved earlier keep their pressure response.
- Eyedropper (I): picks the colour under the next tap, saved as a favourite.
- Gestures (toggles in ⋯): scribble to erase, circle to select (offers a
  "Select" button), two/three-finger double-tap option. Space insertion is a
  toolbar tool (drag down to add room, up to remove it) rather than a gesture.
- Scribble to text: text boxes are plain text fields, so iPadOS Scribble can
  convert handwriting into them; not verified on the device.

Tests run:
- `npm test`: **105 passed, 0 failed** (adds pen radii/settings/tilt,
  whiteboard framing, arrows, connectors, locking, scribble, loops).
- Desktop browser pane at 1180×820, synthetic input: whiteboard created;
  rough box, circle and arrow snapped; arrow attached to both and its end
  followed the circle when moved 120 units; zoom clamped at 5% and 400%;
  reset to 100%; scribble erased the word under it; circle → Select removed
  the loop and selected the enclosed writing; Lock hid it from the lasso;
  unlock restored; space tool moved content down exactly 100; eyedropper
  picked #1d8a4a from a green stroke; brush settings saved on the stroke;
  stabilization reduced ±6 jitter to 3.3; whiteboard exported as one
  556×518 pt page; a regular notebook still drew and saved with no errors.

Not verified: everything on the iPad, especially whether Safari reports
Pencil azimuth/altitude, iPadOS Scribble in text boxes, and gesture feel.

### Session 7 (2026-10-27) — stroke smoothness, floating toolbar

User recording (IMG_0011) at 157% zoom on a whiteboard: round letters drawn
as polygons ("o" as a hexagon, corners in "B") for all pen styles. Cause:
Safari reports Pencil positions about 60 times a second, so fast writing
leaves long gaps, and the midpoint-quadratic smoothing joined them almost
straight.

Fixes:
- Strokes now follow a centripetal Catmull-Rom spline through every sample,
  subdivided to ≤1.5 page units. (A 1-2-1 pre-average was tried and dropped:
  it shrank a 20-unit circle to 15.) Test: a circle sampled at 6 points stays
  round (>90% radius between samples) instead of a hexagon (87%).
- The live stroke no longer builds a full saved stroke (ids, rounding) every
  frame; it previews with slightly coarser curve steps.
- Toolbar floats over the page: drag the grip to move it anywhere (position
  saved as a share of free space, so it survives rotation); collapse button
  shrinks it to just the tools; colours moved to a pop-up palette and pen
  styles to a menu, cutting it from 1,164 px to 859 px wide; pages start
  below it.

Tests: `npm test` 106 passed. Browser pane: sparse "O" and "B" render
smooth at 244%; toolbar dragged to several positions and the top-right
corner; collapse to 388 px; palette and pen menu open beside the toolbar.
Not verified on the iPad.

Note: the browser pane on the PC lost its test notebooks when the Claude app
restarted (its storage was reset). Notes on the iPad are stored on the iPad;
the Backup feature protects against this kind of loss.

### Session 8 (2026-10-27) — more shapes, curved arrows, arrowheads

Draw-and-hold now recognizes: line, curve (one bend or an S, fitted with a
least-squares cubic Bézier), arrow, curved arrow, double-headed arrow
(straight or curved; a barb doubling back at either end, found as the
sharpest >100° turn near that end), standalone arrowhead "V", triangle,
rectangle (near-equal sides → square), diamond, polygon of 5–8 sides
(near-regular → regular; told apart from circles by straight edges), and
ellipse (near-round → circle). Arrowheads are redrawn along the direction
the shaft arrives at its tip. A "V" drawn and held within 28 units of a
line/curve/arrow end becomes that end's arrowhead (one undoable update).
Lines, curves and arrows store Bézier controls, so connectors keep their
bend when an attached shape moves; older straight connectors still work.

Tests: `npm test` 116 passed (adds shapes.test.js). Browser pane: curved
arrow, line + V → arrow, hexagon all snapped as expected. Not verified on
the iPad.

### Session 9 (2026-10-27) — review and optimization; deleting text boxes

Text boxes: while editing one, a Done / Delete text box bar appears above
it (Delete is undoable). Selected text boxes could already be deleted from
the lasso selection bar.

Review findings and fixes:
- Memory: every decoded picture/PDF page stayed in memory forever (~12 MB
  per imported page; a 50-page PDF ≈ 600 MB, enough for iPad Safari to
  reload the tab). Now two least-recently-used caches: up to 16 full-size
  images for pages on screen, up to 400 small (240 px) copies for thumbnails,
  covers and the minimap; evicted images are released (`close()`).
- Thumbnails and covers decoded full-size images; now they use the small
  copies. When an image loads, only the thumbnails that show it are redrawn
  (previously all of them).
- Pan/pinch/trackpad scrolling redrew every visible stroke each frame; now
  frames reuse a scaled snapshot of the last full render while moving, and
  redraw at full quality 140 ms after movement stops.
- Off-screen strokes and items are skipped when drawing. Measured in the
  browser: 3,000 strokes at ~500% zoom, 1.6 ms → 0.2 ms per frame (8×).
- Minimap content is drawn once and cached; each frame only adds the
  visible-area outline (previously redrew all whiteboard content per frame).
- Page sidebar is rebuilt 250 ms after edits stop, not after every stroke.

Tests: `npm test` 116 passed. Browser pane: text box Done/Delete/undo;
pinch to 500% and pan render correctly mid-gesture and after settling.
Not verified on the iPad.

### Session 10 (2026-10-27) — upright toolbar, hold to move, sizes

- Toolbar: drag it by the grip or any empty part straight away, or hold any
  button ~0.4 s then drag (a quick tap still presses it; the click after a
  hold-move is swallowed). With the finger within 56 px of the left/right
  edge it stands upright and sticks to that side; it lies flat again once
  dragged well away (hysteresis prevents flicker). Upright, pen names are
  shortened and quick sizes move into the size panel so it fits (669 px tall
  in landscape).
- Sizes: every tool has an exact size on a logarithmic slider over its range
  (pen 0.5–20, highlighter 4–60, eraser 3–80, text 8–96 pt) with a preview,
  plus three quick sizes the user can overwrite ("Save here"). [ and ] step
  ±15%. Settings from older versions (a preset index) are converted.

Tests: `npm test` 116 passed. Browser pane: drag from a divider to the right
edge → upright; hold a button and drag to the middle → flat, button not
pressed; quick tap still selects; slider → 6.6, saved to quick size 3; left
edge upright fits on screen. Not verified on the iPad.

Fix (same day, user report "after saving a size I can't change it"): with
the toolbar upright low on the screen, toolbar panels opened above it and ran
off the top edge, hiding the size slider. Panels now open beside an upright
toolbar, level with the tapped button, are clamped to the screen, and scroll
if taller than the space. Verified with real clicks: slider → 13.7, Save
here → quick size 1, slider still changes it (→ 1.1), quick size 2 → 2.5.

### Session 11 (2026-10-27) — corners in curves

User screenshot: a fast "C" (fountain pen, 120%) showed a visible corner at
each sampled point. The spline itself was fine (a 7-sample half circle stays
within 1.6% of round). Cause: Safari repeats a Pencil position (e.g. when only
pressure changes); a spline through two near-identical points kinks — a 5.5°
bend became 94.5°. Fix: points within 1.2 units of the previous kept point are
merged before smoothing (higher pressure kept, true end kept), which also
smooths strokes already saved; new strokes skip repeats within 0.5 units at
capture. Test added; `npm test` 117 passed. Browser: an 8-sample "C" with
repeated samples renders as a clean curve. Not verified on the iPad.

## 8. Next steps

1. Retest on the iPad: curves drawn fast, toolbar moving/upright, sizes, text box delete, scrolling/zooming smoothness, then
   shapes and arrows, writing smoothness, the floating toolbar, whiteboard.
2. Host on HTTPS (e.g. GitHub Pages): share sheet, offline use, full-screen
   Home Screen install, no PC needed.
3. Possible later: handwriting search, PDF text layer, orphaned-image cleanup.

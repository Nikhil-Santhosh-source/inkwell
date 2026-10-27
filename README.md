# Inkwell

A local-first handwritten notes web app (PWA) for iPad with Apple Pencil.
Original code; inspired by user-visible note-taking workflows (see `docs/`).

## Features

- Library: create (with page size and paper), rename, open, move, copy and
  delete notebooks, with first-page previews; folders; search; sort.
- Import PDF (library ⋯ menu) and write on top of it.
- Back up the whole library to one file, and restore it (library ⋯ menu).
- Text boxes (T tool), pictures (picture button), shapes (hold the Pencil
  at the end of a stroke), partial eraser, ruler (R).
- Pen styles: ballpoint, fountain pen, pencil; custom colors become favorites.
- Copy/cut/paste (⌘C/⌘X/⌘V, or lasso-tap empty space → Paste); drag pages
  in the sidebar.
- Whiteboards: an infinite canvas (New notebook → Type → Whiteboard) with a
  minimap and 5–400% zoom.
- Draw and hold to snap: straight lines, curves, triangles,
  squares/rectangles, diamonds, 5–8-sided polygons, circles/ellipses.
  Open strokes only become lines or curves (arrow snapping is off; a flick
  at the end is ignored).
- Connectors: a line between shapes follows them when they move,
  keeping its curve. Lock content in place from the selection bar.
- Brush pen and ink settings (sliders button): pressure sensitivity, tip
  sharpness, tip flatness, stabilization. Eyedropper (I).
- Gestures: scribble to erase, circle to select, optional double-tap
  undo/redo; space tool (S) to add or remove room.
- Floating toolbar: drag any empty part (or hold a button, then drag) to
  move it; at the left/right edge it stands upright. The arrow collapses it;
  tap the colour circle for the palette, the pen name for pen styles.
- Sizes: three quick sizes per tool (yours to change) plus an exact-size
  slider; tap the number in the toolbar.
- Multiple pages: continuous scroll, pages sidebar with thumbnails, add,
  delete, move up/down; page counter.
- Export PDF (⋯ menu or ⌘E): sharp vector output of every page.
- Tools: pen (pressure-sensitive), highlighter, eraser, lasso; 7 pen colors,
  5 highlighter colors, custom color, 3 sizes per tool.
- Lasso: move by dragging inside, delete, duplicate, recolor (tap a color).
- Undo/redo: buttons, ⌘Z / ⇧⌘Z, two-finger tap / three-finger tap.
- Paper: Blank, Lined, Grid, Dotted, Cornell × 7 paper colors (incl. dark).
- Page fits the screen width; one finger scrolls, pinch zooms.
- Palm rejection: fingers never draw unless "Draw with finger" is on (⋯ menu);
  large contacts and touches while the Pencil is down are ignored.
- Keyboard shortcuts (press `?` in a notebook for the list).
- Autosave to IndexedDB about 0.4 s after each edit, and immediately when
  the app is hidden or closed.

## Run

```bash
npm install
npm start
```

Open http://localhost:5173/ on this PC. A mouse draws like a pen, for testing.

## Try it on the iPad

1. Connect the iPad and the PC to the same Wi-Fi network.
2. Run `npm start` and open the "on your network" address it prints
   (e.g. `http://192.168.1.20:5173/`) in Safari on the iPad.
3. If it doesn't load, allow Node.js through Windows Firewall on private networks.

Over plain `http` the app works and saves notes, but Safari won't enable
offline mode or a true Home Screen install; both need HTTPS. Use the
published copy (below) for real use; this local copy is for trying changes.

## Publish (GitHub Pages)

Every push to `main` runs `.github/workflows/publish.yml`: it installs, runs
`npm test`, and only if everything passes publishes `app/` to GitHub Pages.
Before pushing a change, bump the version (see `docs/SAFE_CHANGES.md`) so the
iPad offers the update.

## Test

```bash
npm test
```

Unit tests cover the document model, IndexedDB storage (using
`fake-indexeddb`), autosave, edit commands/undo, geometry, paper layouts, and
PDF output.

## Layout

```text
app/            the PWA (served as-is, no build step)
  src/model.js      versioned document/page/stroke data
  src/storage.js    IndexedDB persistence, one transaction per change
  src/autosave.js   debounced, ordered, retrying saves
  src/commands.js   undoable edit commands and history
  src/geometry.js   smoothing, stroke outlines, hit testing
  src/paper.js      paper templates and colors
  src/render.js     drawing pages and thumbnails
  src/document-view.js  multi-page rendering, Pencil tools, finger gestures
  src/pdf.js        PDF export (vector ink and text, JPEG pictures)
  src/media.js      PDF import and picture conversion (uses pdf.js)
  src/util.js       base64 and file-name helpers
  src/whiteboard.js whiteboard content bounds and framing
  vendor/           pdf.js, copied from node_modules by `npm install`
  src/app.js        library/editor views, toolbar, shortcuts
  src/theme.js      colour themes and light/dark appearance
scripts/        dev server and icon generator
.github/        publish workflow (tests, then GitHub Pages)
tests/          node:test unit tests
docs/           feature map and investigation report
```

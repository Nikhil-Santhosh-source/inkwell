# Goodnotes Feature Map

A user-visible behavior study used to plan an original iPad note-taking app.
This is **not** a reverse engineering of Goodnotes. No Goodnotes code, assets,
data formats or internals are used or assumed.

**Confidence levels:** Observed (verified on device or in public docs) ·
Inferred (reasonable explanation, not verified) · Unknown (no evidence yet).

**Status values:** Not investigated · Observed · Planned · In progress ·
Implemented · Verified.

> As of 2026-10-26, no Goodnotes feature has been observed yet. Every row
> below is a **hypothesis** taken from the playbook. Each row needs an
> observation on the iPad (screenshot or screen recording) before its
> Goodnotes confidence moves to `Observed`. The Status column tracks our own
> app (Inkwell); `Verified` will mean tested on a real iPad.

## Summary

| ID | Feature | Priority | Status | Confidence | Evidence |
|---|---|---|---|---|---|
| F01 | Create / open / rename documents | P0 | Implemented (Inkwell, desktop browser only) | Unknown (Goodnotes) | None yet |
| F02 | Writing canvas (page, zoom, pan) | P0 | Implemented (fit-width, pinch/scroll) — iPad retest pending | Unknown | None yet |
| F03 | Apple Pencil ink strokes | P0 | Reworked after iPad test (lag, broken strokes) — retest pending | Unknown | None yet |
| F04 | Pen color and thickness | P0 | Implemented (desktop browser) | Unknown | None yet |
| F05 | Eraser | P0 | Implemented — whole-stroke (desktop browser) | Unknown | None yet |
| F06 | Undo / redo | P0 | Implemented — buttons, ⌘Z, 2/3-finger tap (desktop browser) | Unknown | None yet |
| F07 | Multiple pages | P0 | Implemented — add, delete, reorder, thumbnails (desktop browser) | Unknown | None yet |
| F08 | Reliable local save and restore | P0 | Implemented (desktop browser only) | Unknown | None yet |
| F09 | Folders / collections | P1 | Implemented — folders, move, duplicate (desktop browser) | Unknown | None yet |
| F10 | PDF import and annotation | P1 | Implemented — pages rendered as backgrounds (desktop browser) | Unknown | None yet |
| F11 | Lasso / selection (move, delete) | P1 | Implemented — move, delete, duplicate, recolor (desktop browser) | Unknown | None yet |
| F12 | Export / share | P1 | Implemented — vector PDF; share sheet needs https (desktop browser) | Unknown | None yet |
| F13 | Document name search | P1 | Implemented — search + sort (desktop browser) | Unknown | None yet |
| F14 | Orientation and app lifecycle handling | P1 | Not investigated | Unknown | None yet |
| F15 | Handwriting recognition and search | P2 | Not investigated | Unknown | None yet |
| F16 | Shape recognition | P2 | Implemented — hold to snap line/ellipse/triangle/rectangle (desktop browser) | Unknown | None yet |
| F17 | Image and text box insertion | P2 | Implemented — move, resize, recolor text (desktop browser) | Unknown | None yet |
| F18 | Cloud sync | P2 | Not investigated | Unknown | None yet — needs explicit approval |
| F19 | Templates / advanced organization | P2 | Paper templates + colors implemented (desktop browser) | Unknown | None yet |
| F20 | Highlighter | P1 | Implemented (desktop browser) | Unknown | None yet |
| F21 | Keyboard shortcuts | P1 | Implemented (desktop browser) | Unknown | None yet |
| F22 | Partial eraser | P1 | Implemented (desktop browser) | Unknown | None yet |
| F23 | Pen styles (ballpoint, fountain, pencil), favorite colors | P2 | Implemented (desktop browser) | Unknown | None yet |
| F24 | Page sizes (3:4, A4, Letter, landscape, square) | P1 | Implemented (desktop browser) | Unknown | None yet |
| F25 | Page drag-to-reorder, copy/cut/paste, ruler | P2 | Implemented (desktop browser) | Unknown | None yet |
| F26 | Backup & restore of the whole library | P1 | Implemented (desktop browser) | Unknown | None yet |
| F27 | Whiteboard: infinite canvas, 5–400% zoom, minimap, dot grid | P2 | Implemented (desktop browser) | Inferred (user's notes, 2.txt) | User-supplied description |
| F28 | Arrow shapes and connectors that follow moved shapes | P2 | Implemented (desktop browser) | Inferred (2.txt) | User-supplied description |
| F29 | Layer locking | P2 | Implemented — lock selection, unlock all (desktop browser) | Inferred (2.txt) | User-supplied description |
| F30 | Brush pen; ink settings (pressure sensitivity, tip sharpness, flatness, stabilization) | P2 | Implemented (desktop browser) | Inferred (Untitled.txt) | User-supplied description |
| F31 | Eyedropper | P2 | Implemented (desktop browser) | Inferred (Untitled.txt) | User-supplied description |
| F32 | Scribble to erase, circle to select, space insertion, two/three-finger double-tap | P2 | Implemented; space insertion is a tool, not a gesture (desktop browser) | Inferred (both notes) | User-supplied description |
| F33 | Scribble to text | P2 | Relies on iPadOS Scribble in text boxes; not verified | Inferred (Untitled.txt) | User-supplied description |

## Observation record template

Copy this block for each workflow you observe on the iPad.

```text
Feature:
Starting state:
User action:
Visible response:
Persistence:
Edge cases:
Evidence: (screenshot / recording filename, or public doc URL)
Confidence: Observed | Inferred | Unknown
Implementation idea:
```

## P0 features in detail

The implementation notes below cover both candidate stacks (see the open
decision in `goodnotes_investigation.md`): **Native** = Swift/SwiftUI with
PencilKit or UIKit; **PWA** = an installable web app using Pointer Events and
canvas rendering.

### F01 — Create / open / rename documents
- **User goal:** Start a new notebook and find it again later.
- **To observe:** On the library screen, create a notebook, rename it, open
  it, go back. Note the default name, where it appears, and how renaming is done.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** A library screen listing document metadata
  (id, title, created, modified) stored separately from page content.
- **Risks:** Losing data on rename or delete; delete needs confirmation or a
  recently-deleted area.
- **Acceptance criteria:** Create → rename → relaunch the app → the document
  is listed under its new name and opens with its content intact.

### F02 — Writing canvas (page, zoom, pan)
- **User goal:** Write on a page-sized surface and move around it.
- **To observe:** Open a page, pinch to zoom, two-finger pan, and check
  whether the page has fixed dimensions and what happens at its edges.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** Strokes stored in page coordinates (points on
  a fixed page size), with a separate view transform for zoom/pan.
- **Risks:** Strokes drifting after zoom or rotation if view and page
  coordinates are mixed.
- **Acceptance criteria:** Write, zoom to 300%, pan, rotate the iPad → strokes
  stay exactly in place relative to the page.

### F03 — Apple Pencil ink strokes
- **User goal:** Natural, low-latency handwriting.
- **To observe:** Write quickly and slowly; rest a palm on the screen;
  touch with a finger while the pen tool is active.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** Native: PencilKit or a custom `UITouch`
  pipeline using `touch.type == .pencil`, coalesced and predicted touches.
  PWA: `pointerType === "pen"`, `getCoalescedEvents()`, pressure from
  `PointerEvent.pressure`; finger input reserved for scrolling.
- **Risks:** Latency and palm rejection are weaker in a PWA than native.
- **Acceptance criteria:** Continuous writing shows no visible lag; a resting
  palm produces no marks.

### F04 — Pen color and thickness
- **User goal:** Choose ink color and line width.
- **To observe:** Open the pen options, note which presets exist and whether
  settings are remembered per tool.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** Tool state object (tool, color, width) kept
  apart from document data; each stroke stores its own color and width.
- **Risks:** Low.
- **Acceptance criteria:** Changing color affects only new strokes; existing
  strokes keep their original color after relaunch.

### F05 — Eraser
- **User goal:** Remove mistakes.
- **To observe:** Check whether erasing removes whole strokes, partial
  strokes, or both; whether it can be limited to highlighter only.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** Start with whole-stroke erasing (hit-test
  stroke segments against the eraser path); add partial erasing later by
  splitting strokes.
- **Risks:** Erasing unrelated overlapping strokes.
- **Acceptance criteria:** Erasing one of two crossing strokes leaves the
  other untouched; erase is undoable.

### F06 — Undo / redo
- **User goal:** Reverse and restore edits.
- **To observe:** Draw, erase, undo several times, redo; check whether undo
  history survives closing the document.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** Every edit is an explicit command (add
  stroke, remove strokes, move selection) with an inverse, kept on an undo
  stack per document.
- **Risks:** Commands that don't fully restore state.
- **Acceptance criteria:** Any sequence of N edits followed by N undos returns
  the page to exactly its starting state (unit-tested).

### F07 — Multiple pages
- **User goal:** Notebooks longer than one page.
- **To observe:** Add a page, scroll between pages, reorder and delete pages;
  check whether scrolling is vertical or page-by-page.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** A document holds an ordered list of page ids;
  each page's strokes are stored separately so large documents load lazily.
- **Risks:** Memory use on long documents.
- **Acceptance criteria:** Add, reorder and delete pages, relaunch → order and
  content are preserved.

### F08 — Reliable local save and restore
- **User goal:** Never lose work.
- **To observe:** Write, then immediately force-quit the app; reopen and see
  what survived.
- **Observed behavior:** Not investigated.
- **Proposed implementation:** Autosave after each edit (debounced), writing
  to a temporary file and atomically replacing the old one; versioned file
  format from day one. PWA: IndexedDB transactions plus
  `navigator.storage.persist()`.
- **Risks:** iPadOS may evict PWA storage if it isn't marked persistent.
- **Acceptance criteria:** Force-quit within 2 seconds of the last stroke →
  the stroke is present after relaunch.

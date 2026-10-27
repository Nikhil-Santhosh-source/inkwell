// Document view: renders a notebook's pages stacked vertically and turns
// pointer input into edit commands for the page under the Pencil.
//
// Two stacked canvases fill the viewport:
//   base — paper and committed content, redrawn only when pages or the view change
//   wet  — the stroke being drawn, the lasso, the selection and the ruler, redrawn every frame
// Keeping live ink on its own layer is what keeps inking responsive.
//
// Input routing:
//   Apple Pencil (and mouse)  → the active tool, on the page where it lands
//   fingers                   → scroll, pinch-zoom, move/rotate the ruler,
//                               two-finger tap = undo, three = redo
//   large contacts (palms), and any touch while the Pencil is down → ignored

import { createStroke, getItems, getPaper, newId, strokeStyle, strokeTool } from './model.js';
import {
  RULER_LENGTH, RULER_WIDTH, addArrowhead, closedLoop, connectorTargetAt, eraseFromStroke, isConnectorShape,
  isScribble, itemAt, itemBounds,
  distances, inkCurve, inkOutline, itemsInLasso, onRuler, projectToRuler, recognizeShape, rulerSnapLine, settledDistance,
  strokeAt, strokeHitsCircle, strokeRadius, strokesInLasso, strokesUnderScribble, traceOutline, traceStroke, unionBounds,
} from './geometry.js';
import {
  addStrokesCommand, moveStrokesCommand, removeStrokesCommand, replaceStrokesCommand, updateCommand,
} from './commands.js';
import { cachedBounds, drawContent, drawItem, drawPage, fillStroke } from './render.js';
import { contentBounds } from './whiteboard.js';
import { paperColor } from './paper.js';

const PAGE_GAP = 28; // page units between pages
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const VIEW_MARGIN = 24; // CSS px of desk around the pages
const TOP_CLEARANCE = 76; // CSS px above the first page, so it starts below the floating toolbar
const MAX_FIT_WIDTH = 820; // a page is never wider than this at zoom 1 (about full width in iPad portrait)
// Touches wider or taller than this (CSS px) are treated as palms. Safari on
// iPad reports fingertips at 40–70 px, so this must stay well above that.
const PALM_SIZE = 110;
const MOVE_SLOP = 10; // CSS px before a touch counts as a drag
const TAP_TIME = 350; // ms
const DOUBLE_TAP_TIME = 400; // ms between the two taps of a double tap
const PEN_QUIET_TIME = 150; // ms after the Pencil lifts during which finger taps are ignored
const SHAPE_HOLD_TIME = 550; // ms the Pencil rests at the end of a stroke to turn it into a shape
// Measured on screen, not on the page: zoomed in, a few page units is a
// lot of hand movement, and slow writing was being taken for a hold.
const SHAPE_HOLD_SLOP = 4; // CSS px of wobble allowed while holding
const UNSNAP_DISTANCE = 12; // CSS px: moving on this far after a snap undoes it (still writing)
// When the browser doesn't predict where the Pencil is going (Safari often
// doesn't), live ink is carried on along its current motion for about this
// long, so it keeps up with the tip instead of trailing a frame behind.
const PREDICT_MS = 12;
const PREDICT_MAX = 14; // CSS px: never guess further than this
const PREDICT_STALE = 30; // ms: when the Pencil stops reporting, the guess is dropped (it stopped moving)
const HANDLE_SIZE = 22; // CSS px hit area of the selection's resize handle
const SETTLE_TIME = 140; // ms after trackpad/minimap movement stops before the full-quality redraw
const REFILL_TIME = 120; // ms: while moving, redraw at most this often when the view runs past what was drawn
const GESTURE_SETTLE_TIME = 350; // the same while fingers rest on the screen mid-pinch (redrawn at once when they lift)
const NONE = new Set();

const round2 = (v) => Math.round(v * 100) / 100;

export class DocumentView {
  constructor(container, {
    onCommand, onUndo, onRedo, onSelectionChange, onCurrentPageChange, onZoomChange, onTextRequest, onEmptyLassoTap,
    onLoopDrawn, initialZoom = 1,
  } = {}) {
    this.container = container;
    this.onCommand = onCommand;
    this.onUndo = onUndo;
    this.onRedo = onRedo;
    this.onSelectionChange = onSelectionChange;
    this.onCurrentPageChange = onCurrentPageChange;
    this.onZoomChange = onZoomChange;
    this.onTextRequest = onTextRequest;
    this.onEmptyLassoTap = onEmptyLassoTap;
    this.onLoopDrawn = onLoopDrawn;
    this.initialZoom = initialZoom;
    // Pencil gestures, switchable in settings.
    this.gestures = { scribble: true, circle: true, doubleTap: false };
    this.colorPick = null; // eyedropper: called with the colour under the next tap
    this.minimapVisible = true;

    this.base = document.createElement('canvas');
    this.wet = document.createElement('canvas');
    this.minimap = document.createElement('canvas');
    this.base.className = 'layer';
    this.wet.className = 'layer';
    this.minimap.className = 'minimap';
    this.minimap.hidden = true;
    container.append(this.base, this.wet, this.minimap);
    this.minimapCtx = this.minimap.getContext('2d');
    this.baseCtx = this.base.getContext('2d', { alpha: false });
    // While the view moves, the base layer is moved and scaled by the GPU
    // (a CSS transform) instead of being repainted; see viewChanged.
    this.base.style.transformOrigin = '0 0';
    this.base.style.willChange = 'transform';
    this.wetCtx = this.wet.getContext('2d', { desynchronized: true });

    this.pages = [];
    this.tops = []; // document y of each page's top edge
    this.tool = { tool: 'pen', color: '#1d1d1f', width: 2.5 };
    this.allowFinger = false;
    this.ruler = null; // { x, y, angle } in document units, when shown

    // View: document point (dx, dy) appears at CSS (offsetX + dx * scale, offsetY + dy * scale).
    this.zoom = 1;
    this.fitScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.viewW = 0;
    this.viewH = 0;
    this.dpr = 1;
    this.currentPage = -1;

    this.action = null; // the Pencil/mouse action in progress
    this.touches = new Map(); // active finger contacts: id → { x, y, startX, startY }
    this.ignoredTouches = new Set();
    this.gesture = null;
    this.lastPenUp = 0;
    this.selection = null; // { pageId, ids: Set, itemIds: Set }

    this.baseDirty = true;
    this.frame = 0;

    this.listeners = [
      [this.wet, 'pointerdown', (e) => this.handleDown(e)],
      [this.wet, 'pointermove', (e) => this.handleMove(e)],
      [this.wet, 'pointerup', (e) => this.handleUp(e, false)],
      [this.wet, 'pointercancel', (e) => this.handleUp(e, true)],
      [this.wet, 'wheel', (e) => this.handleWheel(e), { passive: false }],
      [this.minimap, 'pointerdown', (e) => this.minimapNavigate(e, true)],
      [this.minimap, 'pointermove', (e) => this.minimapNavigate(e, false)],
      // Stop Safari's own touch handling (scrolling, zoom, text selection,
      // Scribble). Left on, it steals Pencil touches and cuts strokes short.
      // Only on the canvases: on buttons (the selection bar) it would block taps.
      [container, 'touchstart', (e) => this.blockSafariTouch(e), { passive: false }],
      [container, 'touchmove', (e) => this.blockSafariTouch(e), { passive: false }],
      [container, 'gesturestart', (e) => e.preventDefault(), { passive: false }],
      [container, 'contextmenu', (e) => e.preventDefault()],
    ];
    for (const [target, type, fn, opts] of this.listeners) target.addEventListener(type, fn, opts);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  destroy() {
    this.finishAction(false);
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    clearTimeout(this.wheelTimer);
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.resizeObserver.disconnect();
    this.base.remove();
    this.wet.remove();
    this.minimap.remove();
  }

  blockSafariTouch(event) {
    if (event.target === this.wet || event.target === this.base || event.target === this.minimap) event.preventDefault();
  }

  // True for a whiteboard: one endless page, no edges.
  get infinite() {
    return this.pages[0]?.infinite === true;
  }

  get minZoom() {
    return this.infinite ? 0.05 : MIN_ZOOM;
  }

  get maxZoom() {
    return this.infinite ? 4 : MAX_ZOOM;
  }

  setMinimapVisible(visible) {
    this.minimapVisible = visible;
    this.minimap.hidden = !(visible && this.infinite);
    this.requestFrame();
  }

  // ---- State from the app ----

  setPages(pages) {
    const first = this.pages.length === 0;
    this.pages = pages;
    let y = 0;
    this.tops = pages.map((p) => {
      const top = y;
      y += p.height + PAGE_GAP;
      return top;
    });
    if (this.selection) {
      const page = pages.find((p) => p.id === this.selection.pageId);
      const ids = page ? page.strokes.map((s) => s.id).filter((id) => this.selection.ids.has(id)) : [];
      const itemIds = page ? getItems(page).map((i) => i.id).filter((id) => this.selection.itemIds.has(id)) : [];
      if (ids.length !== this.selection.ids.size || itemIds.length !== this.selection.itemIds.size) {
        this.setSelection(page ? page.id : null, ids, itemIds);
      }
    }
    this.minimap.hidden = !(this.minimapVisible && this.infinite);
    this.minimapCache = null; // content changed
    if (first) this.resize(true);
    else this.clampView();
    this.invalidate();
  }

  setTool(tool) {
    this.tool = { ...tool };
    if (tool.tool !== 'lasso') this.setSelection(null, []);
    this.requestFrame();
  }

  setSelection(pageId, ids, itemIds = []) {
    this.selection = pageId && (ids.length || itemIds.length) ? { pageId, ids: new Set(ids), itemIds: new Set(itemIds) } : null;
    this.requestFrame();
    this.onSelectionChange?.(Boolean(this.selection));
  }

  // { pageId, ids: [], itemIds: [] } or null.
  get selectionInfo() {
    if (!this.selection) return null;
    return { pageId: this.selection.pageId, ids: [...this.selection.ids], itemIds: [...this.selection.itemIds] };
  }

  // Shows the ruler across the middle of the view, or hides it.
  setRulerVisible(visible) {
    if (visible && !this.ruler) {
      this.ruler = {
        x: (this.viewW / 2 - this.offsetX) / this.scale,
        y: (this.viewH / 2 - this.offsetY) / this.scale,
        angle: 0,
      };
    } else if (!visible) {
      this.ruler = null;
    }
    this.requestFrame();
  }

  // ---- Layout ----

  get pageWidth() {
    return this.pages[0]?.width ?? 768;
  }

  pageTop(index) {
    return this.tops[index] ?? 0;
  }

  get docHeight() {
    const last = this.pages.length - 1;
    return last < 0 ? 0 : this.tops[last] + this.pages[last].height;
  }

  // The page containing a document point, or -1 for the gaps and margins.
  pageIndexAt(x, y) {
    if (this.infinite) return 0;
    if (x < 0 || x > this.pageWidth) return -1;
    for (let i = 0; i < this.pages.length; i++) {
      if (y >= this.tops[i] && y <= this.tops[i] + this.pages[i].height) return i;
    }
    return -1;
  }

  // CSS position (relative to the container) of a point on page `index`.
  pageToLocal(index, x, y) {
    return { x: this.offsetX + x * this.scale, y: this.offsetY + (this.pageTop(index) + y) * this.scale };
  }

  // The page-unit point at the centre of what's visible on page `index`.
  visibleCenter(index) {
    if (this.infinite) {
      return { x: (this.viewW / 2 - this.offsetX) / this.scale, y: (this.viewH / 2 - this.offsetY) / this.scale };
    }
    const page = this.pages[index];
    const top = this.pageTop(index);
    const y0 = Math.max(top, -this.offsetY / this.scale);
    const y1 = Math.min(top + page.height, (this.viewH - this.offsetY) / this.scale);
    const x0 = Math.max(0, -this.offsetX / this.scale);
    const x1 = Math.min(page.width, (this.viewW - this.offsetX) / this.scale);
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 - top };
  }

  // ---- View transform ----

  get scale() {
    return this.fitScale * this.zoom;
  }

  resize(reset = false) {
    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !this.pages.length) return;
    // Keep the document point at the top centre of the view where it was.
    const anchorX = (this.viewW / 2 - this.offsetX) / this.scale;
    const anchorY = (0 - this.offsetY) / this.scale;

    this.viewW = rect.width;
    this.viewH = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    for (const canvas of [this.base, this.wet]) {
      canvas.width = Math.round(rect.width * this.dpr);
      canvas.height = Math.round(rect.height * this.dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    // On a whiteboard, zoom 1 (100%) is one page unit per CSS pixel.
    this.fitScale = this.infinite ? 1 : Math.min(rect.width - VIEW_MARGIN * 2, MAX_FIT_WIDTH) / this.pageWidth;

    if (reset && this.infinite) {
      this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.initialZoom));
      this.initialZoom = 1;
      const b = contentBounds(this.pages[0]);
      const cx = b ? (b.minX + b.maxX) / 2 : rect.width / 2;
      const cy = b ? (b.minY + b.maxY) / 2 : rect.height / 2;
      this.offsetX = rect.width / 2 - cx * this.scale;
      this.offsetY = rect.height / 2 - cy * this.scale;
    } else if (reset) {
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.initialZoom));
      this.initialZoom = 1;
      this.offsetX = (rect.width - this.pageWidth * this.scale) / 2;
      this.offsetY = TOP_CLEARANCE;
    } else {
      this.offsetX = this.viewW / 2 - anchorX * this.scale;
      this.offsetY = -anchorY * this.scale;
    }
    this.clampView();
    this.invalidate();
  }

  clampView() {
    if (this.infinite) return; // a whiteboard has no edges to stop at
    const docW = this.pageWidth * this.scale;
    const docH = this.docHeight * this.scale;
    const clampAxis = (offset, size, viewSize) => {
      if (size + VIEW_MARGIN * 2 <= viewSize) return (viewSize - size) / 2;
      return Math.min(VIEW_MARGIN, Math.max(viewSize - size - VIEW_MARGIN, offset));
    };
    this.offsetX = clampAxis(this.offsetX, docW, this.viewW);
    this.offsetY = docH + VIEW_MARGIN + TOP_CLEARANCE <= this.viewH
      ? TOP_CLEARANCE
      : Math.min(TOP_CLEARANCE, Math.max(this.viewH - docH - VIEW_MARGIN, this.offsetY));
  }

  zoomAt(cx, cy, factor) {
    const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const applied = newZoom / this.zoom;
    this.zoom = newZoom;
    this.offsetX = cx - (cx - this.offsetX) * applied;
    this.offsetY = cy - (cy - this.offsetY) * applied;
    this.clampView();
    this.viewChanged();
    if (applied !== 1) this.onZoomChange?.(this.zoom);
  }

  panBy(dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clampView();
    this.viewChanged();
  }

  // After a pan or zoom. While fingers, the trackpad or the minimap are
  // still moving the view, the last full render is moved and scaled on the
  // GPU (a CSS transform on the base canvas): no repainting at all, however
  // much is on the page. The sharp redraw happens once the movement ends.
  viewChanged() {
    if (!(this.gesture || this.wheeling || this.minimapDragging) || !this.rendered) {
      this.invalidate();
      return;
    }
    this.viewDirty = true;
    this.requestFrame();
    this.updateCurrentPage();
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.invalidate(), this.gesture ? GESTURE_SETTLE_TIME : SETTLE_TIME);
  }

  // Shows the last full render where the current view puts it.
  transformBase() {
    const r = this.rendered;
    const k = this.scale / r.scale;
    this.base.style.transform = `matrix(${k}, 0, 0, ${k}, ${this.offsetX - r.offsetX * k}, ${this.offsetY - r.offsetY * k})`;
    this.baseMoved = true;
  }

  zoomBy(factor) {
    this.zoomAt(this.viewW / 2, this.viewH / 2, factor);
  }

  fitWidth() {
    const top = this.currentPage;
    this.resize(true);
    this.onZoomChange?.(this.zoom);
    if (top > 0) this.scrollToPage(top);
  }

  scrollToPage(index) {
    this.offsetY = TOP_CLEARANCE - this.pageTop(index) * this.scale;
    this.clampView();
    this.invalidate();
  }

  toDoc(clientX, clientY) {
    const rect = this.wet.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offsetX) / this.scale,
      y: (clientY - rect.top - this.offsetY) / this.scale,
    };
  }

  toLocal(clientX, clientY) {
    const rect = this.wet.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // ---- Selection geometry ----

  selectedBounds() {
    if (!this.selection) return null;
    const index = this.pages.findIndex((p) => p.id === this.selection.pageId);
    if (index < 0) return null;
    const page = this.pages[index];
    const bounds = unionBounds([
      ...page.strokes.filter((s) => this.selection.ids.has(s.id)).map(cachedBounds),
      ...getItems(page).filter((i) => this.selection.itemIds.has(i.id)).map(itemBounds),
    ]);
    return bounds && { ...bounds, index };
  }

  // Maps a page point through the in-progress move/resize of the selection.
  transformPoint(x, y) {
    const a = this.action;
    if (a?.type === 'move') return { x: x + a.dx, y: y + a.dy };
    if (a?.type === 'scale') return { x: a.anchor.x + (x - a.anchor.x) * a.factor, y: a.anchor.y + (y - a.anchor.y) * a.factor };
    return { x, y };
  }

  // Selection rectangle in CSS px relative to the container, for the action bar.
  selectionRect() {
    const b = this.selectedBounds();
    if (!b) return null;
    const p0 = this.transformPoint(b.minX, b.minY);
    const p1 = this.transformPoint(b.maxX, b.maxY);
    const a = this.pageToLocal(b.index, p0.x, p0.y);
    const c = this.pageToLocal(b.index, p1.x, p1.y);
    return { left: a.x, top: a.y, right: c.x, bottom: c.y };
  }

  // ---- Rendering ----

  invalidate() {
    this.baseDirty = true;
    this.requestFrame();
    // Not left to the next frame: "add page" must see the page the user is on right away.
    this.updateCurrentPage();
  }

  requestFrame() {
    if (!this.frame && !this.inFrame) this.frame = requestAnimationFrame(() => this.renderFrame());
  }

  // Transform for drawing page `index` in page units.
  setPageTransform(ctx, index) {
    const s = this.scale * this.dpr;
    ctx.setTransform(s, 0, 0, s, this.offsetX * this.dpr, (this.offsetY + this.pageTop(index) * this.scale) * this.dpr);
  }

  renderFrame() {
    this.frame = 0;
    if (!this.pages.length) return;
    this.inFrame = true; // view changes made here are drawn in this frame
    if (this.gesturePending) {
      this.gesturePending = false;
      this.stepGesture();
    }
    this.inFrame = false;
    if (this.baseDirty) {
      this.baseDirty = false;
      this.viewDirty = false;
      this.renderBase();
      this.renderMinimap();
    } else if (this.viewDirty) {
      this.viewDirty = false;
      if (this.needsRefill()) this.renderBase();
      else this.transformBase();
      this.renderMinimap();
    }
    this.renderWet();
  }

  // While the view moves, true when it has run past the edges of the last
  // full render (scrolling into a part that was never drawn), and a redraw
  // hasn't just happened.
  needsRefill() {
    if (performance.now() - (this.renderedAt ?? 0) < REFILL_TIME) return false;
    const r = this.rendered;
    const k = this.scale / r.scale;
    const left = this.offsetX - r.offsetX * k;
    const top = this.offsetY - r.offsetY * k;
    const mx = this.viewW * 0.1;
    const my = this.viewH * 0.1;
    return left > mx || top > my || left + this.viewW * k < this.viewW - mx || top + this.viewH * k < this.viewH - my;
  }

  // The part of the view over page `index`, in that page's units (for skipping
  // what's off screen).
  pageViewRect(index) {
    const top = this.pageTop(index);
    const pad = 4 / this.scale;
    return {
      minX: -this.offsetX / this.scale - pad,
      maxX: (this.viewW - this.offsetX) / this.scale + pad,
      minY: -this.offsetY / this.scale - top - pad,
      maxY: (this.viewH - this.offsetY) / this.scale - top + pad,
    };
  }

  updateCurrentPage() {
    if (!this.pages.length || this.viewH <= 0) return;
    const centerY = (this.viewH / 2 - this.offsetY) / this.scale;
    let index = this.pages.length - 1;
    for (let i = 0; i < this.pages.length; i++) {
      if (centerY < this.tops[i] + this.pages[i].height + PAGE_GAP / 2) {
        index = i;
        break;
      }
    }
    if (index !== this.currentPage) {
      this.currentPage = index;
      this.onCurrentPageChange?.(index);
    }
  }

  // What the base layer leaves out of a page while an action shows it on the wet layer.
  hiddenFor(pageId) {
    const a = this.action;
    if (a?.pageId !== pageId) return { hidden: NONE, hiddenItems: NONE };
    if (a.type === 'erase') return { hidden: a.erased, hiddenItems: NONE };
    if ((a.type === 'move' || a.type === 'scale') && this.selection) {
      return { hidden: this.selection.ids, hiddenItems: this.selection.itemIds };
    }
    return { hidden: NONE, hiddenItems: NONE };
  }

  // Read once: a style lookup on every frame would slow down zooming.
  deskColor() {
    this.desk ??= getComputedStyle(this.container).getPropertyValue('--desk').trim() || '#d9d5cc';
    return this.desk;
  }

  // The app's theme changed: pick up the new desk colour and redraw.
  refreshTheme() {
    this.desk = null;
    this.minimapCache = null;
    this.invalidate();
  }

  renderBase() {
    this.baseGen = (this.baseGen ?? 0) + 1; // anything drawn onto the base layer before is gone
    this.rendered = { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY };
    this.renderedAt = performance.now();
    if (this.baseMoved) {
      this.base.style.transform = '';
      this.baseMoved = false;
    }
    // What shows around the moved base layer while zooming out.
    this.container.style.background = this.infinite ? paperColor(getPaper(this.pages[0]).color).fill : '';
    if (this.infinite) {
      this.renderWhiteboard();
      return;
    }
    const ctx = this.baseCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.deskColor();
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const viewTop = -this.offsetY / this.scale;
    const viewBottom = (this.viewH - this.offsetY) / this.scale;
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      if (this.tops[i] > viewBottom || this.tops[i] + page.height < viewTop) continue;
      this.setPageTransform(ctx, i);
      const options = { ...this.hiddenFor(page.id), view: this.pageViewRect(i) };
      if (this.action?.type === 'partial' && this.action.pageId === page.id) options.strokes = this.action.working;
      drawPage(ctx, page, options);
      // Page edge, so dark paper stays distinct from a dark desk.
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)';
      ctx.lineWidth = 1 / this.scale;
      ctx.strokeRect(0, 0, page.width, page.height);
    }
  }

  // The whiteboard: paper colour everywhere, a dot or square grid that stays
  // readable at every zoom, then the content with no page edges.
  renderWhiteboard() {
    const ctx = this.baseCtx;
    const page = this.pages[0];
    const paper = getPaper(page);
    const color = paperColor(paper.color);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color.fill;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    if (paper.template === 'dotted' || paper.template === 'grid') {
      // Grid spacing in page units, doubled until it's at least 14 CSS px apart.
      let step = 24;
      while (step * this.scale < 14) step *= 2;
      const s = step * this.scale * this.dpr;
      const x0 = ((this.offsetX * this.dpr) % s + s) % s;
      const y0 = ((this.offsetY * this.dpr) % s + s) % s;
      ctx.fillStyle = color.line;
      ctx.strokeStyle = color.line;
      ctx.lineWidth = this.dpr;
      ctx.beginPath();
      if (paper.template === 'dotted') {
        const r = 1.3 * this.dpr;
        for (let y = y0; y < this.base.height; y += s) {
          for (let x = x0; x < this.base.width; x += s) {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
        }
        ctx.fill();
      } else {
        for (let x = x0; x < this.base.width; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, this.base.height); }
        for (let y = y0; y < this.base.height; y += s) { ctx.moveTo(0, y); ctx.lineTo(this.base.width, y); }
        ctx.stroke();
      }
    }
    this.setPageTransform(ctx, 0);
    const options = { ...this.hiddenFor(page.id), view: this.pageViewRect(0) };
    if (this.action?.type === 'partial') options.strokes = this.action.working;
    drawContent(ctx, page, options);
  }

  // Forgets the minimap's drawing so it's redone (content or pictures changed).
  invalidateMinimap() {
    this.minimapCache = null;
    this.invalidate();
  }

  // The minimap: all content, scaled to fit, with the visible area outlined.
  // Tap or drag on it to move there. The content is drawn once into a cached
  // canvas (redrawn only when the whiteboard changes); each frame only adds
  // the outline of the visible area.
  renderMinimap() {
    if (this.minimap.hidden) return;
    const css = { w: 180, h: 120 };
    if (this.minimap.width !== css.w * this.dpr) {
      this.minimap.width = css.w * this.dpr;
      this.minimap.height = css.h * this.dpr;
      this.minimapCache = null;
    }
    const view = {
      minX: -this.offsetX / this.scale,
      minY: -this.offsetY / this.scale,
      maxX: (this.viewW - this.offsetX) / this.scale,
      maxY: (this.viewH - this.offsetY) / this.scale,
    };
    if (!this.minimapCache) {
      const content = contentBounds(this.pages[0]) ?? view;
      const padX = (content.maxX - content.minX) * 0.15 + 40;
      const padY = (content.maxY - content.minY) * 0.15 + 40;
      const w = content.maxX - content.minX + padX * 2;
      const h = content.maxY - content.minY + padY * 2;
      const k = Math.min(this.minimap.width / w, this.minimap.height / h);
      const ox = (this.minimap.width - w * k) / 2 - (content.minX - padX) * k;
      const oy = (this.minimap.height - h * k) / 2 - (content.minY - padY) * k;
      const canvas = document.createElement('canvas');
      canvas.width = this.minimap.width;
      canvas.height = this.minimap.height;
      const c = canvas.getContext('2d');
      c.setTransform(k, 0, 0, k, ox, oy);
      drawContent(c, this.pages[0], { imageSize: 'thumb' });
      this.minimapCache = canvas;
      this.minimapMap = { k, ox, oy };
    }
    const { k, ox, oy } = this.minimapMap;
    const ctx = this.minimapCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.drawImage(this.minimapCache, 0, 0);
    ctx.strokeStyle = '#2f5bd3';
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeRect(view.minX * k + ox, view.minY * k + oy, (view.maxX - view.minX) * k, (view.maxY - view.minY) * k);
  }

  minimapNavigate(event, start) {
    if (!this.minimapMap || (!start && !this.minimapDragging)) return;
    event.preventDefault();
    if (start) {
      this.minimapDragging = true;
      try { this.minimap.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
      const stop = () => { this.minimapDragging = false; };
      this.minimap.addEventListener('pointerup', stop, { once: true });
      this.minimap.addEventListener('pointercancel', stop, { once: true });
    }
    const rect = this.minimap.getBoundingClientRect();
    const { k, ox, oy } = this.minimapMap;
    const x = ((event.clientX - rect.left) * this.dpr - ox) / k;
    const y = ((event.clientY - rect.top) * this.dpr - oy) / k;
    this.offsetX = this.viewW / 2 - x * this.scale;
    this.offsetY = this.viewH / 2 - y * this.scale;
    this.viewChanged();
  }

  // Back to 100%, centred on the content (whiteboard), or fit width (pages).
  resetView() {
    this.initialZoom = 1;
    this.resize(true);
    this.onZoomChange?.(this.zoom);
  }

  // The stroke being written. A lightweight preview (no ids or rounding)
  // with slightly coarser curve steps; the saved stroke gets the full
  // treatment on lift.
  //
  // Redrawing the whole stroke every frame costs more the longer it gets,
  // so for solid ink the part that has settled (smoothing no longer changes
  // it; see geometry.settledDistance) is drawn once, onto the base layer,
  // and only the last bit is redrawn each frame. Every frame then costs the
  // same however long the stroke. Translucent ink (highlighter, pencil)
  // would look darker where the two parts overlap, so it's redrawn whole.
  // The base layer is redrawn when the stroke is saved, which replaces the
  // settled part with the saved stroke.
  renderLiveInk(ctx, action, page) {
    const toArray = (p) => (p.azimuth === undefined ? [p.x, p.y, p.pressure] : [p.x, p.y, p.pressure, p.azimuth, p.altitude]);
    const stroke = { ...action.pen, points: action.points.map(toArray) };
    if (action.shape) stroke.shape = action.shape;
    const solid = strokeTool(stroke) === 'pen' && strokeStyle(stroke) !== 'pencil' && !action.snapped && !this.baseMoved;
    if (!solid) {
      stroke.points = [...stroke.points, ...action.predicted.map(toArray)];
      fillStroke(ctx, stroke, traceStroke(new Path2D(), stroke, inkCurve(stroke, 2.5)));
      return;
    }
    // Settled is judged without the predicted points, which are only a guess.
    const settled = inkOutline(stroke, 2.5);
    const along = distances(settled.points);
    const until = along[along.length - 1] - settledDistance(stroke);
    const live = action.live?.gen === this.baseGen ? action.live : { gen: this.baseGen, drawn: 0 };
    action.live = live;
    let k = live.drawn;
    while (k + 1 < settled.points.length && along[k + 1] <= until) k++;
    if (k > live.drawn) {
      const base = this.baseCtx;
      base.save();
      this.setPageTransform(base, action.pageIndex);
      if (!this.infinite) {
        base.beginPath();
        base.rect(0, 0, page.width, page.height);
        base.clip();
      }
      fillStroke(base, stroke, traceOutline(new Path2D(), settled.points, settled.radii, live.drawn, k));
      base.restore();
      live.drawn = k;
    }
    // The rest, with the prediction, from where the settled part ends.
    const outline = action.predicted.length
      ? inkOutline({ ...stroke, points: [...stroke.points, ...action.predicted.map(toArray)] }, 2.5)
      : settled;
    if (live.drawn < outline.points.length - 1 || live.drawn === 0) {
      fillStroke(ctx, stroke, traceOutline(new Path2D(), outline.points, outline.radii, live.drawn, outline.points.length - 1));
    }
  }

  renderWet() {
    const ctx = this.wetCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.wet.width, this.wet.height);
    const action = this.action;
    const px = 1 / this.scale; // one CSS pixel in page units

    if (action) {
      const page = this.pages[action.pageIndex];
      this.setPageTransform(ctx, action.pageIndex);
      ctx.save();
      if (!this.infinite) {
        ctx.beginPath();
        ctx.rect(0, 0, page.width, page.height);
        ctx.clip();
      }
      if (action.type === 'ink') {
        this.renderLiveInk(ctx, action, page);
      } else if (action.type === 'move' || action.type === 'scale') {
        if (action.type === 'move') {
          ctx.translate(action.dx, action.dy);
        } else {
          ctx.translate(action.anchor.x, action.anchor.y);
          ctx.scale(action.factor, action.factor);
          ctx.translate(-action.anchor.x, -action.anchor.y);
        }
        for (const item of getItems(page)) if (this.selection?.itemIds.has(item.id)) drawItem(ctx, item);
        for (const stroke of page.strokes) if (this.selection?.ids.has(stroke.id)) fillStroke(ctx, stroke);
      }
      ctx.restore();

      if (action.type === 'lasso' && action.points.length > 1) {
        ctx.beginPath();
        action.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = '#2f5bd3';
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([6 * px, 5 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (action.type === 'space') {
        // The line where space is added or removed, and the gap being made.
        const left = this.infinite ? -this.offsetX / this.scale : 0;
        const right = this.infinite ? (this.viewW - this.offsetX) / this.scale : page.width;
        ctx.fillStyle = action.dy >= 0 ? 'rgba(47, 91, 211, 0.12)' : 'rgba(211, 47, 47, 0.12)';
        ctx.fillRect(left, Math.min(action.y, action.y + action.dy), right - left, Math.abs(action.dy));
        ctx.strokeStyle = '#2f5bd3';
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([8 * px, 6 * px]);
        ctx.beginPath();
        ctx.moveTo(left, action.y);
        ctx.lineTo(right, action.y);
        ctx.moveTo(left, action.y + action.dy);
        ctx.lineTo(right, action.y + action.dy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if ((action.type === 'erase' || action.type === 'partial') && action.cursor) {
        ctx.beginPath();
        ctx.arc(action.cursor.x, action.cursor.y, action.radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(80, 80, 80, 0.7)';
        ctx.lineWidth = px;
        ctx.stroke();
      }
    }

    if (this.ruler) this.renderRuler(ctx);

    const rect = this.selectionRect();
    if (rect) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.strokeStyle = '#2f5bd3';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rect.left - 6, rect.top - 6, rect.right - rect.left + 12, rect.bottom - rect.top + 12);
      ctx.setLineDash([]);
      // Resize handle at the bottom-right corner.
      ctx.beginPath();
      ctx.arc(rect.right + 6, rect.bottom + 6, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.stroke();
      this.onSelectionChange?.(true);
    }
  }

  renderRuler(ctx) {
    const s = this.scale * this.dpr;
    const { x, y, angle } = this.ruler;
    ctx.setTransform(s, 0, 0, s, this.offsetX * this.dpr, this.offsetY * this.dpr);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const halfL = RULER_LENGTH / 2;
    const halfW = RULER_WIDTH / 2;
    ctx.fillStyle = 'rgba(40, 44, 52, 0.72)';
    ctx.fillRect(-halfL, -halfW, RULER_LENGTH, RULER_WIDTH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1 / this.scale;
    ctx.beginPath();
    for (let t = -halfL; t <= halfL; t += 16) {
      const long = Math.round((t + halfL) / 16) % 5 === 0;
      const len = long ? 18 : 9;
      ctx.moveTo(t, -halfW);
      ctx.lineTo(t, -halfW + len);
      ctx.moveTo(t, halfW);
      ctx.lineTo(t, halfW - len);
    }
    ctx.stroke();
    ctx.rotate(-angle);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${14}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let degrees = Math.round((-angle * 180) / Math.PI) % 360;
    if (degrees < 0) degrees += 360;
    ctx.fillText(`${degrees}°`, 0, 0);
    ctx.restore();
  }

  // ---- Input ----

  handleDown(event) {
    if (!this.pages.length) return;
    if (this.colorPick && !this.isPalm(event)) {
      event.preventDefault();
      this.pickColorAt(event);
      return;
    }
    if (event.pointerType === 'touch') {
      const doc = this.toDoc(event.clientX, event.clientY);
      const fingerDraws = this.allowFinger && this.tool.tool !== 'text' && !onRuler(this.ruler, doc.x, doc.y);
      if (fingerDraws && this.touches.size === 0 && !this.action && !this.isPalm(event)) {
        this.startAction(event);
      } else {
        this.touchDown(event);
      }
      return;
    }
    const isPen = event.pointerType === 'pen' || (event.pointerType === 'mouse' && event.button === 0);
    if (!isPen || this.action) return;
    // The Pencil wins: drop any finger gesture (usually a resting palm).
    this.cancelGesture();
    this.startAction(event);
  }

  handleMove(event) {
    if (this.action && event.pointerId === this.action.pointerId) {
      this.moveAction(event);
    } else if (event.pointerType === 'touch') {
      this.touchMove(event);
    }
  }

  handleUp(event, cancelled) {
    if (this.action && event.pointerId === this.action.pointerId) {
      // A cancelled ink stroke is kept: losing ink is worse than an extra mark, which undo removes.
      this.finishAction(true);
      this.lastPenUp = performance.now();
    } else if (event.pointerType === 'touch') {
      this.touchUp(event, cancelled);
    }
  }

  handleWheel(event) {
    event.preventDefault();
    // Wheel and trackpad events come in bursts; treat the burst as one movement.
    this.wheeling = true;
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => { this.wheeling = false; }, SETTLE_TIME);
    if (event.ctrlKey || event.metaKey) {
      const { x, y } = this.toLocal(event.clientX, event.clientY);
      this.zoomAt(x, y, Math.exp(-event.deltaY * 0.01));
    } else {
      this.panBy(-event.deltaX, -event.deltaY);
    }
  }

  isPalm(event) {
    return event.width > PALM_SIZE || event.height > PALM_SIZE;
  }

  // Eyedropper: the colour of the page under the pointer, as #rrggbb.
  pickColorAt(event) {
    if (this.baseDirty) {
      // Read what's actually on the page now, not the last frame drawn.
      this.baseDirty = false;
      this.renderBase();
    }
    const { x, y } = this.toLocal(event.clientX, event.clientY);
    const px = Math.min(this.base.width - 1, Math.max(0, Math.round(x * this.dpr)));
    const py = Math.min(this.base.height - 1, Math.max(0, Math.round(y * this.dpr)));
    const [r, g, b] = this.baseCtx.getImageData(px, py, 1, 1).data;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const callback = this.colorPick;
    this.colorPick = null;
    callback(hex);
  }

  // A pointer position in the action's page units. The Pencil also reports
  // its angle (azimuth) and tilt (altitude) where the browser supports it.
  samplePoint(e, top) {
    const { x, y } = this.toDoc(e.clientX, e.clientY);
    // Mouse and finger report 0.5 (or 0) while pressed; the Pencil reports real pressure.
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    const point = { x, y: y - top, pressure, t: e.timeStamp };
    if (e.pointerType === 'pen' && Number.isFinite(e.azimuthAngle) && Number.isFinite(e.altitudeAngle)) {
      point.azimuth = e.azimuthAngle;
      point.altitude = e.altitudeAngle;
    }
    return point;
  }

  samplePoints(event, top) {
    const coalesced = event.getCoalescedEvents?.() ?? [];
    return (coalesced.length ? coalesced : [event]).map((e) => this.samplePoint(e, top));
  }

  // ---- Tool actions (Pencil, mouse, or finger when allowed) ----

  overResizeHandle(event) {
    const rect = this.selectionRect();
    if (!rect) return false;
    const { x, y } = this.toLocal(event.clientX, event.clientY);
    return Math.hypot(x - (rect.right + 6), y - (rect.bottom + 6)) <= HANDLE_SIZE;
  }

  startAction(event) {
    const docPoint = this.toDoc(event.clientX, event.clientY);
    const pageIndex = this.pageIndexAt(docPoint.x, docPoint.y);
    const resizing = this.tool.tool === 'lasso' && this.overResizeHandle(event);
    if (pageIndex < 0 && !resizing) {
      // Tapping the desk clears a selection; nothing to draw on.
      if (this.selection) this.setSelection(null, []);
      return;
    }
    const index = resizing ? this.selectedBounds().index : pageIndex;
    const page = this.pages[index];
    const top = this.pageTop(index);
    const point = this.samplePoint(event, top);

    if (this.tool.tool === 'text') {
      const item = itemAt(getItems(page).filter((i) => i.type === 'text'), point.x, point.y, 6);
      this.onTextRequest?.(page.id, point.x, point.y, item);
      return;
    }

    event.preventDefault();
    try { this.wet.setPointerCapture(event.pointerId); } catch { /* synthetic or already gone */ }
    const base = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      lastLocal: this.toLocal(event.clientX, event.clientY),
      pageIndex: index,
      pageId: page.id,
      top,
    };
    switch (this.tool.tool) {
      case 'pen':
      case 'highlighter': {
        // Along the ruler's edge, ink is drawn straight against it.
        const inkRadius = strokeRadius(this.tool, 0.5);
        const snap = rulerSnapLine(this.ruler, docPoint.x, docPoint.y, inkRadius);
        this.action = {
          ...base, type: 'ink', pen: { ...this.tool, res: 1 / this.scale }, points: [], predicted: [], snap, snapped: false,
          holdAnchor: point, holdTimer: 0,
        };
        this.addInkPoints([point]);
        this.armShapeHold(point);
        break;
      }
      case 'eraser':
        if (this.tool.mode === 'partial') {
          this.action = { ...base, type: 'partial', radius: this.tool.width, working: page.strokes, cursor: null };
        } else {
          this.action = { ...base, type: 'erase', radius: this.tool.width, erased: new Set(), cursor: null };
        }
        this.eraseAt(point);
        break;
      case 'space':
        this.action = { ...base, type: 'space', y: point.y, dy: 0 };
        break;
      case 'lasso': {
        const b = this.selection?.pageId === page.id ? this.selectedBounds() : null;
        if (resizing && b) {
          this.action = { ...base, type: 'scale', anchor: { x: b.minX, y: b.minY }, startDist: Math.max(10, Math.hypot(point.x - b.minX, point.y - b.minY)), factor: 1 };
          this.invalidate();
        } else if (b && this.insideSelection(point)) {
          this.action = { ...base, type: 'move', start: point, dx: 0, dy: 0 };
          this.invalidate(); // hide the selection on the base layer while it moves
        } else {
          this.setSelection(null, []);
          this.action = { ...base, type: 'lasso', points: [[point.x, point.y]] };
        }
        break;
      }
      default:
        return;
    }
    this.requestFrame();
  }

  // Adds ink points: steadied by the stabilization setting (each point moves
  // only part of the way toward the pointer), and projected onto the ruler
  // edge when snapping. Pencil angle data is kept only for the pen styles
  // that use it.
  addInkPoints(points) {
    const a = this.action;
    const keepAngles = a.pen.tool === 'pen' && (a.pen.style === 'fountain' || a.pen.style === 'pencil');
    const steady = a.pen.stabilize ?? 0;
    for (const raw of points) {
      let p = keepAngles ? raw : { x: raw.x, y: raw.y, pressure: raw.pressure };
      (a.recent ??= []).push(raw);
      if (a.recent.length > 8) a.recent.shift();
      a.lastRaw = p;
      if (steady > 0) {
        const follow = 1 - steady * 0.85;
        a.steady = a.steady ? { ...p, x: a.steady.x + (p.x - a.steady.x) * follow, y: a.steady.y + (p.y - a.steady.y) * follow } : { ...p };
        p = { ...a.steady };
      }
      if (a.snap) {
        const q = projectToRuler(a.snap, p.x, p.y + a.top);
        p = { ...p, x: q.x, y: q.y - a.top };
      }
      // A repeat of (nearly) the same spot only updates the pressure; storing
      // it would kink the smoothed curve (see geometry.mergeNearPoints).
      const last = a.points[a.points.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) {
        if (p.pressure > last.pressure) last.pressure = p.pressure;
      } else {
        a.points.push(p);
      }
    }
  }

  // Where the Pencil is about to be: the browser's prediction when it gives
  // one, otherwise the recent motion carried on for PREDICT_MS. Only shown
  // while writing; the saved stroke uses real points only.
  predictInk(action, event) {
    const native = event.getPredictedEvents?.() ?? [];
    if (native.length) return native.slice(0, 2).map((e) => this.samplePoint(e, action.top));
    const recent = action.recent ?? [];
    if (recent.length < 3) return [];
    const last = recent[recent.length - 1];
    // Average speed over the last ~30 ms, which steadies the guess.
    let first = recent[recent.length - 2];
    for (let i = recent.length - 2; i >= 0 && last.t - recent[i].t <= 30; i--) first = recent[i];
    const dt = last.t - first.t;
    if (!(dt > 2)) return [];
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy) * this.scale; // CSS px per ms
    if (speed < 0.05) return []; // resting or nearly: nothing to guess
    const reach = Math.min(PREDICT_MS, PREDICT_MAX / speed);
    return [{ ...last, x: last.x + vx * reach, y: last.y + vy * reach }];
  }

  // Holding the Pencil still at the end of a stroke turns it into a clean shape.
  armShapeHold(point) {
    const a = this.action;
    clearTimeout(a.holdTimer);
    a.holdAnchor = point;
    a.holdTimer = setTimeout(() => {
      if (this.action !== a || a.snapped || a.snap) return;
      const shape = recognizeShape(a.points);
      if (!shape) return;
      a.drawn = a.points; // kept in case the Pencil moves on: then it wasn't a hold
      a.points = shape.points.map((p) => ({ x: p.x, y: p.y, pressure: 0.5 }));
      const { points, ...meta } = shape;
      a.shape = meta;
      a.predicted = [];
      a.snapped = true;
      this.baseDirty = true; // clears the part of the stroke drawn there
      this.requestFrame();
    }, SHAPE_HOLD_TIME);
  }

  moveAction(event) {
    event.preventDefault();
    const action = this.action;
    const points = this.samplePoints(event, action.top);
    action.lastLocal = this.toLocal(event.clientX, event.clientY);
    switch (action.type) {
      case 'ink': {
        if (action.snapped) {
          // Resting wobble is ignored; moving on means the writing continues.
          const p = points[points.length - 1];
          if (Math.hypot(p.x - action.holdAnchor.x, p.y - action.holdAnchor.y) * this.scale < UNSNAP_DISTANCE) break;
          action.points = action.drawn;
          action.snapped = false;
          action.shape = undefined;
        }
        this.addInkPoints(points);
        action.predicted = action.snap ? [] : this.predictInk(action, event);
        // A Pencil held still sends nothing, which would leave the last
        // guess showing past the tip: redraw without it once it's stale.
        clearTimeout(action.staleTimer);
        if (action.predicted.length) action.staleTimer = setTimeout(() => {
          if (this.action !== action) return;
          action.predicted = [];
          this.requestFrame();
        }, PREDICT_STALE);
        const last = points[points.length - 1];
        if (Math.hypot(last.x - action.holdAnchor.x, last.y - action.holdAnchor.y) * this.scale > SHAPE_HOLD_SLOP) this.armShapeHold(last);
        break;
      }
      case 'erase':
      case 'partial':
        for (const p of points) this.eraseAt(p);
        break;
      case 'lasso':
        for (const p of points) action.points.push([p.x, p.y]);
        break;
      case 'move': {
        const last = points[points.length - 1];
        action.dx = last.x - action.start.x;
        action.dy = last.y - action.start.y;
        break;
      }
      case 'scale': {
        const last = points[points.length - 1];
        const dist = Math.hypot(last.x - action.anchor.x, last.y - action.anchor.y);
        action.factor = Math.min(8, Math.max(0.1, dist / action.startDist));
        break;
      }
      case 'space':
        action.dy = points[points.length - 1].y - action.y;
        break;
      default:
        break;
    }
    this.requestFrame();
  }

  finishAction(commit) {
    const action = this.action;
    if (!action) return;
    this.action = null;
    clearTimeout(action.holdTimer);
    clearTimeout(action.staleTimer);
    const page = this.pages[action.pageIndex];
    if (commit && page) {
      switch (action.type) {
        case 'ink':
          this.finishInk(page, action);
          break;
        case 'space':
          if (Math.abs(action.dy) > 1) this.onCommand?.(page.id, this.spaceCommand(page, action));
          break;
        case 'erase':
          if (action.erased.size) this.onCommand?.(page.id, removeStrokesCommand(page, [...action.erased]));
          break;
        case 'partial':
          if (action.working !== page.strokes) this.onCommand?.(page.id, replaceStrokesCommand(page, action.working));
          break;
        case 'lasso':
          this.finishLasso(page, action);
          break;
        case 'move':
          if (Math.hypot(action.dx, action.dy) > 0.5) {
            this.onCommand?.(page.id, moveStrokesCommand(this.selection.ids, action.dx, action.dy, this.selection.itemIds));
          }
          break;
        case 'scale':
          if (Math.abs(action.factor - 1) > 0.01) this.onCommand?.(page.id, this.scaleCommand(page, action));
          break;
        default:
          break;
      }
    }
    this.invalidate();
  }

  // Commits a pen or highlighter stroke, applying the Pencil gestures:
  //   scribble over writing → erases it (the scribble isn't kept)
  //   a recognized line/arrow with ends on shapes → a connector that follows them
  //   a loop around writing → offers to select what it encloses
  finishInk(page, action) {
    const pen = action.pen;
    if (action.lastRaw && !action.snapped && !action.snap && (pen.stabilize ?? 0) > 0) {
      action.points.push(action.lastRaw); // the steadied line ends where the Pencil lifted
    }
    const freehand = pen.tool === 'pen' && !action.snapped && !action.snap;
    if (freehand && this.gestures.scribble && isScribble(action.points)) {
      const ids = strokesUnderScribble(page.strokes, action.points);
      if (ids.length) {
        this.onCommand?.(page.id, removeStrokesCommand(page, ids));
        return;
      }
    }

    // A "V" drawn at the end of a line, curve or arrow becomes its arrowhead.
    if (action.shape?.kind === 'chevron') {
      const target = this.arrowheadTarget(page, action.shape.tip);
      if (target) {
        this.onCommand?.(page.id, updateCommand([{ before: target.stroke, after: addArrowhead(target.stroke, target.atEnd) }], []));
        return;
      }
    }

    const stroke = createStroke(action.points, pen, page);
    if (action.shape) {
      stroke.shape = { kind: action.shape.kind };
      if (action.shape.controls) {
        const { controls, heads, start, end } = action.shape;
        Object.assign(stroke.shape, { controls, heads, start, end });
        const from = connectorTargetAt(page.strokes, getItems(page), ...start);
        const to = connectorTargetAt(page.strokes, getItems(page), ...end);
        if ((from || to) && from !== to) stroke.connect = { from, to };
      }
    }
    this.onCommand?.(page.id, addStrokesCommand(page, [stroke]));

    if (freehand && this.gestures.circle) {
      const loop = closedLoop(action.points);
      if (loop) {
        const ids = strokesInLasso(page.strokes.filter((s) => !s.locked), loop);
        const itemIds = itemsInLasso(getItems(page).filter((i) => !i.locked), loop);
        if (ids.length || itemIds.length) this.onLoopDrawn?.(page.id, stroke.id, ids, itemIds, action.lastLocal);
      }
    }
  }

  // The line/curve/arrow whose free end is nearest the tip of a drawn "V"
  // (within 28 page units): { stroke, atEnd }, or null.
  arrowheadTarget(page, [x, y]) {
    let best = null;
    let bestDist = 28;
    for (const s of page.strokes) {
      if (s.locked || !isConnectorShape(s)) continue;
      for (const atEnd of [false, true]) {
        const [ex, ey] = atEnd ? s.shape.end : s.shape.start;
        const d = Math.hypot(ex - x, ey - y);
        if (d < bestDist) {
          bestDist = d;
          best = { stroke: s, atEnd };
        }
      }
    }
    return best;
  }

  // Moves everything below the line down by dy (or up, when dy < 0).
  spaceCommand(page, { y, dy }) {
    const ids = page.strokes.filter((s) => !s.locked && cachedBounds(s).minY >= y - 2).map((s) => s.id);
    const itemIds = getItems(page).filter((i) => !i.locked && i.y >= y - 2).map((i) => i.id);
    return moveStrokesCommand(ids, 0, dy, itemIds);
  }

  finishLasso(page, action) {
    const strokes = page.strokes.filter((s) => !s.locked);
    const items = getItems(page).filter((i) => !i.locked);
    let travel = 0; // CSS px along the lasso path
    for (let i = 1; i < action.points.length; i++) {
      travel += Math.hypot(action.points[i][0] - action.points[i - 1][0], action.points[i][1] - action.points[i - 1][1]) * this.scale;
    }
    if (travel < 8) {
      // A tap: select what's under it, or offer to paste on empty space.
      const [x, y] = action.points[0];
      const item = itemAt(items, x, y, 4);
      const stroke = item ? null : strokeAt(strokes, x, y, 8 / this.scale);
      if (item) this.setSelection(page.id, [], [item.id]);
      else if (stroke) this.setSelection(page.id, [stroke.id]);
      else this.onEmptyLassoTap?.(page.id, x, y);
      return;
    }
    this.setSelection(page.id, strokesInLasso(strokes, action.points), itemsInLasso(items, action.points));
  }

  scaleCommand(page, { anchor, factor }) {
    const sx = (x) => round2(anchor.x + (x - anchor.x) * factor);
    const sy = (y) => round2(anchor.y + (y - anchor.y) * factor);
    const strokes = page.strokes.filter((s) => this.selection.ids.has(s.id)).map((before) => {
      const after = { ...before, width: round2(before.width * factor), points: before.points.map(([x, y, ...rest]) => [sx(x), sy(y), ...rest]) };
      if (before.shape?.start) {
        const scale = ([x, y]) => [sx(x), sy(y)];
        after.shape = { ...before.shape, start: scale(before.shape.start), end: scale(before.shape.end) };
        if (before.shape.controls) after.shape.controls = before.shape.controls.map(scale);
      }
      return { before, after };
    });
    const items = getItems(page).filter((i) => this.selection.itemIds.has(i.id)).map((before) => {
      const after = { ...before, x: sx(before.x), y: sy(before.y), width: round2(before.width * factor), height: round2(before.height * factor) };
      if (before.type === 'text') after.size = round2(before.size * factor);
      return { before, after };
    });
    return updateCommand(strokes, items);
  }

  eraseAt(point) {
    const action = this.action;
    action.cursor = point;
    let changed = false;
    if (action.type === 'partial') {
      const next = [];
      for (const stroke of action.working) {
        const runs = stroke.locked ? null : eraseFromStroke(stroke, point.x, point.y, action.radius, cachedBounds(stroke));
        if (runs === null) {
          next.push(stroke);
        } else {
          changed = true;
          for (const run of runs) {
            // Pieces are plain ink: no longer a recognized shape or connector.
            const { shape, connect, ...piece } = stroke;
            next.push({ ...piece, id: newId(), points: run });
          }
        }
      }
      if (changed) action.working = next;
    } else {
      for (const stroke of this.pages[action.pageIndex].strokes) {
        if (!stroke.locked && !action.erased.has(stroke.id) && strokeHitsCircle(stroke, point.x, point.y, action.radius, cachedBounds(stroke))) {
          action.erased.add(stroke.id);
          changed = true;
        }
      }
    }
    if (changed) this.invalidate();
  }

  insideSelection(point) {
    const b = this.selectedBounds();
    const pad = 10 / this.scale;
    return b && point.x >= b.minX - pad && point.x <= b.maxX + pad && point.y >= b.minY - pad && point.y <= b.maxY + pad;
  }

  // ---- Finger gestures ----

  touchDown(event) {
    if ((this.action && this.action.pointerType !== 'touch') || this.isPalm(event)) {
      this.ignoredTouches.add(event.pointerId);
      return;
    }
    // A finger stroke in progress becomes a two-finger gesture when a second finger lands.
    if (this.action) {
      const { pointerId, lastLocal } = this.action;
      this.finishAction(false);
      this.touches.set(pointerId, { ...lastLocal, startX: lastLocal.x, startY: lastLocal.y });
      this.gesture = { maxTouches: 1, start: performance.now(), moved: false };
    }
    const local = this.toLocal(event.clientX, event.clientY);
    this.touches.set(event.pointerId, { ...local, startX: local.x, startY: local.y });
    if (!this.gesture) {
      const doc = this.toDoc(event.clientX, event.clientY);
      // A gesture that starts on the ruler moves and turns the ruler instead of the page.
      this.gesture = { maxTouches: 0, start: performance.now(), moved: false, ruler: onRuler(this.ruler, doc.x, doc.y) };
    }
    this.gesture.maxTouches = Math.max(this.gesture.maxTouches, this.touches.size);
    this.gesture.prevCentroid = null;
  }

  touchMove(event) {
    const touch = this.touches.get(event.pointerId);
    if (!touch || !this.gesture) return;
    const local = this.toLocal(event.clientX, event.clientY);
    touch.x = local.x;
    touch.y = local.y;
    if (Math.hypot(touch.x - touch.startX, touch.y - touch.startY) > MOVE_SLOP) this.gesture.moved = true;
    if (!this.gesture.moved) return;
    // Each finger reports separately; moving the view per report would use
    // one finger's new position with the other's old one (a jittery zoom).
    // The view follows all fingers together, once per frame.
    this.gesturePending = true;
    this.requestFrame();
  }

  stepGesture() {
    if (!this.gesture || !this.touches.size) return;
    const pts = [...this.touches.values()];
    const centroid = {
      x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
      y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
    };
    const two = pts.length >= 2;
    const distance = two ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    const angle = two ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : 0;
    const g = this.gesture;
    if (g.prevCentroid && g.prevCount === pts.length) {
      if (g.ruler && this.ruler) {
        this.ruler.x += (centroid.x - g.prevCentroid.x) / this.scale;
        this.ruler.y += (centroid.y - g.prevCentroid.y) / this.scale;
        if (two) this.ruler.angle = snapAngle(this.ruler.angle + angle - g.prevAngle);
        this.requestFrame();
      } else {
        if (two && g.prevDistance > 0) this.zoomAt(centroid.x, centroid.y, distance / g.prevDistance);
        this.panBy(centroid.x - g.prevCentroid.x, centroid.y - g.prevCentroid.y);
      }
    }
    g.prevCentroid = centroid;
    g.prevDistance = distance;
    g.prevAngle = angle;
    g.prevCount = pts.length;
  }

  touchUp(event, cancelled) {
    if (this.ignoredTouches.delete(event.pointerId)) return;
    if (!this.touches.delete(event.pointerId) || !this.gesture) return;
    this.gesture.prevCentroid = null;
    if (this.touches.size > 0) return;
    const g = this.gesture;
    this.gesture = null;
    if (g.moved && this.baseMoved) {
      // Fingers lifted: sharpen now rather than after a pause.
      clearTimeout(this.settleTimer);
      this.invalidate();
    }
    const now = performance.now();
    const isTap = !cancelled && !g.moved && now - g.start < TAP_TIME && now - this.lastPenUp > PEN_QUIET_TIME;
    if (!isTap || (g.maxTouches !== 2 && g.maxTouches !== 3)) return;
    if (this.gestures.doubleTap) {
      // Undo/redo on the second of two quick taps with the same number of fingers.
      const prev = this.lastFingerTap;
      this.lastFingerTap = { count: g.maxTouches, time: now };
      if (!prev || prev.count !== g.maxTouches || now - prev.time > DOUBLE_TAP_TIME) return;
      this.lastFingerTap = null;
    }
    if (g.maxTouches === 2) this.onUndo?.();
    else this.onRedo?.();
  }

  cancelGesture() {
    for (const id of this.touches.keys()) this.ignoredTouches.add(id);
    this.touches.clear();
    this.gesture = null;
  }
}

// Ruler angles stick to multiples of 15° when within 2°.
function snapAngle(angle) {
  const step = Math.PI / 12;
  const nearest = Math.round(angle / step) * step;
  return Math.abs(angle - nearest) < (2 * Math.PI) / 180 ? nearest : angle;
}

// Canvas drawing of page content, shared by the editor, thumbnails and the library.
// Everything draws in page units; callers set the transform.

import { strokeBounds, traceStroke } from './geometry.js';
import { getItems, getPaper, strokeStyle, strokeTool } from './model.js';
import { drawPaper } from './paper.js';
import { finitePage } from './whiteboard.js';

export const HIGHLIGHTER_ALPHA = 0.38;
export const PENCIL_ALPHA = 0.85;
export const TEXT_LINE_HEIGHT = 1.3;
export const TEXT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
const NONE = new Set();

// Strokes are immutable, so their outline and bounds can be cached per object.
const pathCache = new WeakMap();
const boundsCache = new WeakMap();

export function strokePath(stroke) {
  let path = pathCache.get(stroke);
  if (!path) {
    path = traceStroke(new Path2D(), stroke);
    pathCache.set(stroke, path);
  }
  return path;
}

export function cachedBounds(stroke) {
  let bounds = boundsCache.get(stroke);
  if (!bounds) {
    bounds = strokeBounds(stroke);
    boundsCache.set(stroke, bounds);
  }
  return bounds;
}

// ---- Assets (images) ----

// The app supplies how to load an asset's bytes: async (id) => { bytes, mime }.
let assetSource = null;
const assetListeners = new Set();

// Decoded images are kept in two least-recently-used caches, because a
// decoded PDF page is ~12 MB and iPad Safari reloads the page when memory
// runs out:
//   full  — full resolution, for the pages on screen (a few dozen at most)
//   thumb — at most THUMB_WIDTH px wide, for thumbnails, covers and the minimap
const THUMB_WIDTH = 240;
const caches = {
  full: { map: new Map(), limit: 16 },
  thumb: { map: new Map(), limit: 400 },
};

export function setAssetSource(fn) {
  assetSource = fn;
}

// Called with (asset id, 'full' | 'thumb') whenever an image finishes loading, so views can redraw.
export function onAssetLoaded(fn) {
  assetListeners.add(fn);
  return () => assetListeners.delete(fn);
}

const isBitmap = (v) => v && typeof v === 'object';

function evict(cache) {
  let count = 0;
  for (const v of cache.map.values()) if (isBitmap(v)) count++;
  for (const [key, v] of cache.map) {
    if (count <= cache.limit) break;
    if (!isBitmap(v)) continue;
    v.close?.();
    cache.map.delete(key);
    count--;
  }
}

async function decode(asset, size) {
  const bitmap = await createImageBitmap(new Blob([asset.bytes], { type: asset.mime }));
  if (size === 'full' || bitmap.width <= THUMB_WIDTH) return bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = Math.max(1, Math.round((bitmap.height * THUMB_WIDTH) / bitmap.width));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const small = await createImageBitmap(canvas);
  canvas.width = canvas.height = 0;
  return small;
}

// The decoded image for an asset at 'full' or 'thumb' size, or null while it loads.
export function getAssetImage(id, size = 'full') {
  const cache = caches[size];
  const cached = cache.map.get(id);
  if (isBitmap(cached)) {
    // Mark as recently used.
    cache.map.delete(id);
    cache.map.set(id, cached);
    return cached;
  }
  if (!cached && assetSource) {
    cache.map.set(id, 'loading');
    assetSource(id)
      .then((asset) => (asset ? decode(asset, size) : null))
      .then((bitmap) => {
        cache.map.set(id, bitmap ?? 'failed');
        evict(cache);
        if (bitmap) for (const fn of assetListeners) fn(id, size);
      })
      .catch(() => cache.map.set(id, 'failed'));
  }
  return null;
}

// ---- Pencil texture ----

const grainCache = new Map(); // color → CanvasPattern

// A grainy fill in the stroke's color, so pencil lines look like graphite.
function pencilPattern(ctx, color) {
  let pattern = grainCache.get(color);
  if (!pattern) {
    const size = 48;
    const tile = document.createElement('canvas');
    tile.width = tile.height = size;
    const t = tile.getContext('2d');
    t.fillStyle = color;
    t.fillRect(0, 0, size, size);
    const img = t.getImageData(0, 0, size, size);
    // Deterministic noise so the texture doesn't shimmer between redraws.
    let seed = 7;
    for (let i = 3; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      img.data[i] = 120 + (seed % 136);
    }
    t.putImageData(img, 0, 0);
    pattern = ctx.createPattern(tile, 'repeat');
    pattern.setTransform?.(new DOMMatrix().scale(0.5));
    grainCache.set(color, pattern);
  }
  return pattern;
}

export function fillStroke(ctx, stroke, path = strokePath(stroke)) {
  const tool = strokeTool(stroke);
  if (tool === 'highlighter') {
    ctx.fillStyle = stroke.color;
    ctx.globalAlpha = HIGHLIGHTER_ALPHA;
  } else if (strokeStyle(stroke) === 'pencil') {
    ctx.fillStyle = pencilPattern(ctx, stroke.color);
    ctx.globalAlpha = PENCIL_ALPHA;
  } else {
    ctx.fillStyle = stroke.color;
  }
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

// ---- Text ----

let measureCtx = null;

export function textFont(size) {
  return `${size}px ${TEXT_FONT_FAMILY}`;
}

// Wraps text into lines that fit `width` at `size`. Explicit newlines are kept.
export function layoutText(text, width, size) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = textFont(size);
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const candidate = line + word;
      if (line && measureCtx.measureText(candidate.trimEnd()).width > width) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function textHeight(lineCount, size) {
  return Math.max(1, lineCount) * size * TEXT_LINE_HEIGHT;
}

// ---- Items ----

export function drawItem(ctx, item, imageSize = 'full') {
  if (item.type === 'image') {
    const image = getAssetImage(item.assetId, imageSize);
    if (image) {
      ctx.drawImage(image, item.x, item.y, item.width, item.height);
    } else {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.15)';
      ctx.fillRect(item.x, item.y, item.width, item.height);
    }
  } else if (item.type === 'text') {
    ctx.fillStyle = item.color;
    ctx.font = textFont(item.size);
    ctx.textBaseline = 'top';
    (item.lines ?? [item.text]).forEach((line, i) => {
      ctx.fillText(line, item.x, item.y + i * item.size * TEXT_LINE_HEIGHT + item.size * 0.1);
    });
  }
}

// ---- Pages ----

function drawBackground(ctx, page, paperLineWidth, imageSize) {
  if (page.background) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, page.width, page.height);
    const image = getAssetImage(page.background.assetId, imageSize);
    if (image) ctx.drawImage(image, 0, 0, page.width, page.height);
  } else {
    drawPaper(ctx, getPaper(page), page.width, page.height, paperLineWidth);
  }
}

// Layering: paper (or PDF page) → pictures → highlighter → text → ink.
// Options:
//   hidden / hiddenItems — stroke / item ids not to draw
//   strokes   — draw these instead of the page's (partial-eraser preview)
//   view      — { minX, minY, maxX, maxY } in page units: skip what's outside it
//   imageSize — 'full' or 'thumb' pictures
export function drawPage(ctx, page, { paperLineWidth = 1, ...options } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, page.width, page.height);
  ctx.clip();
  drawBackground(ctx, page, paperLineWidth, options.imageSize ?? 'full');
  drawContent(ctx, page, options);
  ctx.restore();
}

const overlaps = (b, v) => b.maxX >= v.minX && b.minX <= v.maxX && b.maxY >= v.minY && b.minY <= v.maxY;

// Pictures, highlighter, text and ink, without paper or clipping (whiteboards).
export function drawContent(ctx, page, {
  hidden = NONE, hiddenItems = NONE, strokes = page.strokes, view = null, imageSize = 'full',
} = {}) {
  const visible = (b) => !view || overlaps(b, view);
  const items = getItems(page).filter((i) => !hiddenItems.has(i.id)
    && visible({ minX: i.x, minY: i.y, maxX: i.x + i.width, maxY: i.y + i.height }));
  const shown = strokes.filter((s) => !hidden.has(s.id) && visible(cachedBounds(s)));
  for (const item of items) if (item.type === 'image') drawItem(ctx, item, imageSize);
  for (const stroke of shown) if (strokeTool(stroke) === 'highlighter') fillStroke(ctx, stroke);
  for (const item of items) if (item.type === 'text') drawItem(ctx, item, imageSize);
  for (const stroke of shown) if (strokeTool(stroke) !== 'highlighter') fillStroke(ctx, stroke);
}

// Draws a page into a canvas at most cssWidth wide (and 1.4× that tall).
// Whiteboards are framed around their content.
export function renderThumbnail(canvas, sourcePage, cssWidth) {
  const page = finitePage(sourcePage);
  const dpr = window.devicePixelRatio || 1;
  const cssScale = Math.min(cssWidth / page.width, (cssWidth * 1.4) / page.height);
  const cssW = page.width * cssScale;
  const cssH = page.height * cssScale;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  const scale = cssScale * dpr;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  // Paper lines about one device pixel wide at this size; small pictures.
  drawPage(ctx, page, { paperLineWidth: Math.max(1, 1 / scale), imageSize: 'thumb' });
}

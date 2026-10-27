// Document model: plain, versioned, JSON-serializable data. No UI state here.

export const SCHEMA_VERSION = 1;

// Pages are always PAGE_WIDTH units wide; their height depends on the page
// size (or an imported PDF page's shape). Strokes are stored in these units,
// independent of screen size, zoom or orientation.
export const PAGE_WIDTH = 768;
export const PAGE_HEIGHT = 1024;

export const PAGE_SIZES = [
  { id: 'standard', label: 'Standard (3:4)', height: 1024 },
  { id: 'a4', label: 'A4', height: 1086 },
  { id: 'letter', label: 'Letter', height: 994 },
  { id: 'landscape', label: 'Landscape (4:3)', height: 576 },
  { id: 'square', label: 'Square', height: 768 },
];

export const PEN_STYLES = [
  { id: 'ballpoint', label: 'Ballpoint' },
  { id: 'fountain', label: 'Fountain' },
  { id: 'brush', label: 'Brush' },
  { id: 'pencil', label: 'Pencil' },
];

// Starting ink settings per pen style (see geometry.pointRadii); the user
// can change them, and each stroke keeps the settings it was drawn with.
export const PEN_STYLE_DEFAULTS = {
  ballpoint: { sens: 0, taper: 0, stab: 0 },
  fountain: { sens: 0.6, taper: 0.3, flat: 0.8, stab: 0 },
  brush: { sens: 1, taper: 0.7, stab: 0 },
  pencil: { sens: 0.5, taper: 0.2, stab: 0 },
};

// A whiteboard is one endless page: no edges, so nothing is clamped to it.
export function isWhiteboard(page) {
  return page.infinite === true;
}

export const DEFAULT_PEN = Object.freeze({ tool: 'pen', color: '#1d1d1f', width: 2.5 });

// Pages created before paper styles existed render as plain white.
export const LEGACY_PAPER = Object.freeze({ template: 'blank', color: 'white' });
export const DEFAULT_PAPER = Object.freeze({ template: 'lined', color: 'white' });

export function getPaper(page) {
  return page.paper ?? LEGACY_PAPER;
}

// Text boxes and images on a page. Pages saved before items existed have none.
export function getItems(page) {
  return page.items ?? [];
}

const MAX_TITLE_LENGTH = 200;

export function newId() {
  // crypto.randomUUID only exists in secure contexts; iPad testing over plain
  // http on the LAN is not one, so fall back to getRandomValues.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeTitle(title) {
  const trimmed = String(title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed || 'Untitled';
}

export function createPage(paper = DEFAULT_PAPER, height = PAGE_HEIGHT) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    width: PAGE_WIDTH,
    height,
    paper: { ...paper },
    strokes: [],
  };
}

export function createWhiteboardPage(paper = { template: 'dotted', color: 'white' }) {
  return { ...createPage(paper), infinite: true };
}

// kind: 'notebook' (pages) or 'whiteboard' (one infinite canvas).
export function createDocument(title, now = Date.now(), {
  paper = DEFAULT_PAPER, height = PAGE_HEIGHT, folderId = null, kind = 'notebook',
} = {}) {
  const page = kind === 'whiteboard' ? createWhiteboardPage() : createPage(paper, height);
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    title: normalizeTitle(title),
    createdAt: now,
    modifiedAt: now,
    folderId,
    pageIds: [page.id],
  };
  if (kind === 'whiteboard') doc.kind = 'whiteboard';
  return { doc, pages: [page] };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// points: [{ x, y, pressure, azimuth?, altitude? }] in page units. Stored
// compactly as [x, y, p], or [x, y, p, azimuth, altitude] when the Pencil
// reports its angle. Points are kept inside the page unless it's a whiteboard.
// pen: { tool, color, width, style?, sens?, taper?, flat? }
export function createStroke(points, pen = DEFAULT_PEN, page = { width: PAGE_WIDTH, height: PAGE_HEIGHT }) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('A stroke needs at least one point');
  }
  const bounded = !isWhiteboard(page);
  const stored = points.map(({ x, y, pressure, azimuth, altitude }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Stroke point is not a number');
    const p = Number.isFinite(pressure) ? clamp(pressure, 0, 1) : 0.5;
    const px = bounded ? clamp(x, 0, page.width) : x;
    const py = bounded ? clamp(y, 0, page.height) : y;
    const point = [round(px, 2), round(py, 2), round(p, 3)];
    if (Number.isFinite(azimuth) && Number.isFinite(altitude)) point.push(round(azimuth, 2), round(altitude, 2));
    return point;
  });
  const stroke = { id: newId(), tool: pen.tool ?? 'pen', color: pen.color, width: pen.width, points: stored };
  if (pen.style && pen.style !== 'ballpoint') stroke.style = pen.style;
  for (const key of ['sens', 'taper', 'flat']) {
    if (Number.isFinite(pen[key])) stroke[key] = round(pen[key], 2);
  }
  return stroke;
}

// Returns a new page; the input page is not modified.
export function addStroke(page, stroke) {
  return { ...page, strokes: [...page.strokes, stroke] };
}

// Strokes saved before tools existed are pen strokes.
export function strokeTool(stroke) {
  return stroke.tool ?? 'pen';
}

export function strokeStyle(stroke) {
  return stroke.style ?? 'ballpoint';
}

export function createTextItem({ x, y, width, text, size, color, lines, height }) {
  return { id: newId(), type: 'text', x, y, width, height, text, size, color, lines };
}

export function createImageItem({ x, y, width, height, assetId }) {
  return { id: newId(), type: 'image', x, y, width, height, assetId };
}

// Asset ids (images, PDF backgrounds) a page refers to.
export function pageAssetIds(page) {
  const ids = getItems(page).filter((i) => i.type === 'image').map((i) => i.assetId);
  if (page.background?.assetId) ids.push(page.background.assetId);
  return ids;
}

export function validateDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Document record is missing');
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported document format version ${doc.schemaVersion}`);
  }
  if (typeof doc.id !== 'string' || typeof doc.title !== 'string' || !Array.isArray(doc.pageIds)) {
    throw new Error('Document record is malformed');
  }
  return doc;
}

export function validatePage(page) {
  if (!page || typeof page !== 'object') throw new Error('Page record is missing');
  if (page.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported page format version ${page.schemaVersion}`);
  }
  if (typeof page.id !== 'string' || !Array.isArray(page.strokes)) {
    throw new Error('Page record is malformed');
  }
  if (page.items !== undefined && !Array.isArray(page.items)) throw new Error('Page record is malformed');
  return page;
}

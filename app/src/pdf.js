// Minimal PDF writer for notebook pages. Paper, ink and text become vector
// content, so exported handwriting stays sharp at any zoom; pictures and
// imported PDF pages are embedded as JPEG images. No dependencies.

import { smoothPoints, traceStroke } from './geometry.js';
import { getItems, getPaper, strokeStyle, strokeTool } from './model.js';
import { paperLayout } from './paper.js';
import { HIGHLIGHTER_ALPHA, PENCIL_ALPHA, TEXT_LINE_HEIGHT } from './render.js';

// 768 page units wide → 576 pt (8 in), close to Letter/A4 width.
const PT_PER_UNIT = 0.75;
const KAPPA = 0.5522847498; // control-point distance for a quarter circle as a cubic Bézier

function num(n) {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const value = Number.parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(value)) return [0, 0, 0];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => Math.round((c / 255) * 1000) / 1000);
}

const color = (hex, op) => `${hexToRgb(hex).join(' ')} ${op}`;

// PDF string for the built-in Helvetica font (WinAnsi): characters outside
// Latin-1 become "?", since standard fonts can't show them.
export function pdfLatinString(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `(${out})`;
}

// Collects path operators; implements the subset of Path2D that traceStroke uses.
class PdfPath {
  constructor() {
    this.ops = [];
  }

  moveTo(x, y) {
    this.ops.push(`${num(x)} ${num(y)} m`);
  }

  lineTo(x, y) {
    this.ops.push(`${num(x)} ${num(y)} l`);
  }

  closePath() {
    this.ops.push('h');
  }

  // Full circle starting at (cx + r, cy), in the same direction as canvas arc(..., false).
  arc(cx, cy, r) {
    const k = KAPPA * r;
    const c = (...p) => this.ops.push(`${p.map(num).join(' ')} c`);
    c(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
    c(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
    c(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
    c(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
  }
}

// Draws image resource `name` into the box, upright under the page's y-down transform.
function imageOps(name, x, y, w, h) {
  return ['q', `${num(w)} 0 0 ${num(-h)} ${num(x)} ${num(y + h)} cm`, `/${name} Do`, 'Q'];
}

function strokeOps(stroke) {
  const path = traceStroke(new PdfPath(), stroke, smoothPoints(stroke.points, 2));
  const fill = [color(stroke.color, 'rg'), ...path.ops, 'f'];
  if (strokeTool(stroke) === 'highlighter') return ['q', '/GSh gs', ...fill, 'Q'];
  if (strokeStyle(stroke) === 'pencil') return ['q', '/GSp gs', ...fill, 'Q'];
  return fill;
}

function textOps(item) {
  const out = [color(item.color, 'rg'), 'BT', `/F1 ${num(item.size)} Tf`];
  (item.lines ?? [item.text]).forEach((line, i) => {
    // Flip the text matrix back upright; baseline about 0.9 em below the line top.
    const baseline = item.y + i * item.size * TEXT_LINE_HEIGHT + item.size * 0.9;
    out.push(`1 0 0 -1 ${num(item.x)} ${num(baseline)} Tm`, `${pdfLatinString(line)} Tj`);
  });
  out.push('ET');
  return out;
}

// The content stream of one page, in page units with y pointing down.
// imageNames maps asset id → resource name for this page's images.
export function pageContent(page, imageNames = new Map()) {
  const out = [];
  const hPt = page.height * PT_PER_UNIT;
  out.push('q', `${PT_PER_UNIT} 0 0 ${-PT_PER_UNIT} 0 ${num(hPt)} cm`);

  if (page.background) {
    out.push('1 1 1 rg', `0 0 ${page.width} ${num(page.height)} re f`);
    const name = imageNames.get(page.background.assetId);
    if (name) out.push(...imageOps(name, 0, 0, page.width, page.height));
  } else {
    const layout = paperLayout(getPaper(page), page.width, page.height);
    out.push(color(layout.fill, 'rg'), `0 0 ${page.width} ${num(page.height)} re f`);
    if (layout.lines.length) {
      out.push('1 w');
      let current = null;
      for (const line of layout.lines) {
        if (line.color !== current) {
          if (current) out.push('S');
          current = line.color;
          out.push(color(current, 'RG'));
        }
        out.push(`${num(line.x1)} ${num(line.y1)} m ${num(line.x2)} ${num(line.y2)} l`);
      }
      out.push('S');
    }
    if (layout.dots.length) {
      const dots = new PdfPath();
      for (const { x, y } of layout.dots) {
        dots.moveTo(x + 1.4, y);
        dots.arc(x, y, 1.4);
      }
      out.push(color(layout.dotColor, 'rg'), ...dots.ops, 'f');
    }
  }

  // Same layering as on screen: pictures → highlighter → text → ink.
  const items = getItems(page);
  for (const item of items) {
    const name = item.type === 'image' && imageNames.get(item.assetId);
    if (name) out.push(...imageOps(name, item.x, item.y, item.width, item.height));
  }
  for (const stroke of page.strokes) if (strokeTool(stroke) === 'highlighter') out.push(...strokeOps(stroke));
  for (const item of items) if (item.type === 'text') out.push(...textOps(item));
  for (const stroke of page.strokes) if (strokeTool(stroke) !== 'highlighter') out.push(...strokeOps(stroke));
  out.push('Q');
  return out.join('\n');
}

// PDF text string as UTF-16BE hex, so any language survives.
function pdfText(text) {
  let hex = 'FEFF';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const units = code > 0xffff
      ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
      : [code];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

function pageImageIds(page) {
  const ids = getItems(page).filter((i) => i.type === 'image').map((i) => i.assetId);
  if (page.background) ids.push(page.background.assetId);
  return ids;
}

// Builds a PDF of the given pages.
//   compress: optional (bytes) => zlib-deflated bytes, for /FlateDecode streams
//   images:   Map of asset id → { bytes (JPEG), width, height } in pixels
export async function buildPdf(pages, { title = 'Notebook', compress, images = new Map() } = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id, body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (id, dict, data) => {
    offsets[id] = length;
    push(`${id} 0 obj\n<< ${dict ? `${dict} ` : ''}/Length ${data.length} >>\nstream\n`);
    push(data);
    push('\nendstream\nendobj\n');
  };

  // Object ids: 1 catalog, 2 page tree, 3–4 transparency states, 5 info,
  // 6 font, then one per image, then two per page (page, contents).
  const imageIds = new Map();
  let nextId = 7;
  for (const page of pages) {
    for (const assetId of pageImageIds(page)) {
      if (images.has(assetId) && !imageIds.has(assetId)) imageIds.set(assetId, nextId++);
    }
  }
  const firstPageId = nextId;
  const pageId = (i) => firstPageId + i * 2;

  push('%PDF-1.4\n%âãÏÓ\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, `<< /Type /ExtGState /ca ${HIGHLIGHTER_ALPHA} >>`);
  object(4, `<< /Type /ExtGState /ca ${PENCIL_ALPHA} >>`);
  object(5, `<< /Title ${pdfText(title)} /Producer (Inkwell) >>`);
  object(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (const [assetId, id] of imageIds) {
    const image = images.get(assetId);
    stream(id, `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, image.bytes);
  }
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const names = new Map();
    const xobjects = [];
    for (const assetId of pageImageIds(page)) {
      if (imageIds.has(assetId) && !names.has(assetId)) {
        const name = `Im${imageIds.get(assetId)}`;
        names.set(assetId, name);
        xobjects.push(`/${name} ${imageIds.get(assetId)} 0 R`);
      }
    }
    const box = `[0 0 ${num(page.width * PT_PER_UNIT)} ${num(page.height * PT_PER_UNIT)}]`;
    const resources = `<< /ExtGState << /GSh 3 0 R /GSp 4 0 R >> /Font << /F1 6 0 R >>${xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : ''} >>`;
    object(pageId(i), `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Resources ${resources} /Contents ${pageId(i) + 1} 0 R >>`);
    const raw = encoder.encode(pageContent(page, names));
    if (compress) stream(pageId(i) + 1, '/Filter /FlateDecode', await compress(raw));
    else stream(pageId(i) + 1, '', raw);
  }

  const count = offsets.length;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

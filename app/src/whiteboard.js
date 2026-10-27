// Whiteboards are endless; thumbnails and PDF export need a finite page.
// These helpers measure a whiteboard's content and frame it as a page.

import { itemBounds, strokeBounds, unionBounds } from './geometry.js';
import { getItems, isWhiteboard, PAGE_HEIGHT, PAGE_WIDTH } from './model.js';
import { translateStroke } from './commands.js';

// Bounds of everything drawn or placed on a page, or null when it's empty.
export function contentBounds(page) {
  return unionBounds([...page.strokes.map(strokeBounds), ...getItems(page).map(itemBounds)]);
}

// A whiteboard as an ordinary page just big enough for its content, plus a
// margin. Other pages are returned unchanged.
export function finitePage(page, margin = 48) {
  if (!isWhiteboard(page)) return page;
  const { infinite, ...rest } = page;
  const bounds = contentBounds(page);
  if (!bounds) return { ...rest, width: PAGE_WIDTH, height: PAGE_HEIGHT };
  const dx = margin - bounds.minX;
  const dy = margin - bounds.minY;
  return {
    ...rest,
    width: Math.max(200, Math.ceil(bounds.maxX - bounds.minX + margin * 2)),
    height: Math.max(200, Math.ceil(bounds.maxY - bounds.minY + margin * 2)),
    strokes: page.strokes.map((s) => translateStroke(s, dx, dy)),
    items: getItems(page).map((i) => ({ ...i, x: i.x + dx, y: i.y + dy })),
  };
}

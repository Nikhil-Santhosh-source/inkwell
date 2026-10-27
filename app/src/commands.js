// Edits as data. Every command can be applied to a page and inverted,
// which is what undo/redo is built on. Pages are never modified in place.

import { getItems } from './model.js';

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Shifts a stroke, keeping any Pencil angle data on its points and moving a
// line/arrow's recorded ends with it.
export function translateStroke(stroke, dx, dy) {
  const moved = { ...stroke, points: stroke.points.map(([x, y, ...rest]) => [round2(x + dx), round2(y + dy), ...rest]) };
  if (stroke.shape?.start) {
    const shift = ([x, y]) => [round2(x + dx), round2(y + dy)];
    moved.shape = { ...stroke.shape, start: shift(stroke.shape.start), end: shift(stroke.shape.end) };
    if (stroke.shape.controls) moved.shape.controls = stroke.shape.controls.map(shift);
  }
  return moved;
}

// Sets `locked` on strokes and items (locked content can't be selected or erased).
export function lockCommand(page, strokeIds, itemIds, locked) {
  const sIds = new Set(strokeIds);
  const iIds = new Set(itemIds);
  const flip = (x) => {
    const after = { ...x };
    if (locked) after.locked = true;
    else delete after.locked;
    return { before: x, after };
  };
  return updateCommand(
    page.strokes.filter((s) => sIds.has(s.id) && Boolean(s.locked) !== locked).map(flip),
    getItems(page).filter((i) => iIds.has(i.id) && Boolean(i.locked) !== locked).map(flip),
  );
}

// ---- Builders: describe an edit against the current page ----

export function addStrokesCommand(page, strokes) {
  return {
    type: 'insert',
    entries: strokes.map((stroke, i) => ({ index: page.strokes.length + i, stroke })),
  };
}

export function removeStrokesCommand(page, ids) {
  const wanted = new Set(ids);
  const entries = [];
  page.strokes.forEach((stroke, index) => {
    if (wanted.has(stroke.id)) entries.push({ index, stroke });
  });
  return { type: 'delete', entries };
}

export function addItemsCommand(page, items) {
  const count = getItems(page).length;
  return { type: 'insertItems', entries: items.map((item, i) => ({ index: count + i, item })) };
}

export function removeItemsCommand(page, ids) {
  const wanted = new Set(ids);
  const entries = [];
  getItems(page).forEach((item, index) => {
    if (wanted.has(item.id)) entries.push({ index, item });
  });
  return { type: 'deleteItems', entries };
}

export function moveStrokesCommand(ids, dx, dy, itemIds = []) {
  return { type: 'move', ids: [...ids], itemIds: [...itemIds], dx: round2(dx), dy: round2(dy) };
}

export function recolorStrokesCommand(page, ids, color) {
  const wanted = new Set(ids);
  const changes = page.strokes
    .filter((stroke) => wanted.has(stroke.id) && stroke.color !== color)
    .map((stroke) => ({ id: stroke.id, from: stroke.color, to: color }));
  return { type: 'recolor', changes };
}

export function paperCommand(fromPaper, toPaper) {
  return { type: 'paper', from: { ...fromPaper }, to: { ...toPaper } };
}

// Replaces strokes and items by id with new versions (resize, text edits).
export function updateCommand(strokes = [], items = []) {
  return { type: 'update', strokes, items };
}

export function batchCommand(cmds) {
  return { type: 'batch', cmds: cmds.filter((cmd) => !isEmptyCommand(cmd)) };
}

export function removeSelectionCommand(page, strokeIds, itemIds = []) {
  return batchCommand([removeStrokesCommand(page, strokeIds), removeItemsCommand(page, itemIds)]);
}

// Turns a page's strokes into `finalStrokes` (same order), as a delete of the
// strokes that are gone plus an insert of the new ones at their positions.
// Used by the partial eraser, which splits strokes into pieces.
export function replaceStrokesCommand(page, finalStrokes) {
  const finalIds = new Set(finalStrokes.map((s) => s.id));
  const originalIds = new Set(page.strokes.map((s) => s.id));
  const removed = page.strokes.filter((s) => !finalIds.has(s.id)).map((s) => s.id);
  const entries = [];
  finalStrokes.forEach((stroke, index) => {
    if (!originalIds.has(stroke.id)) entries.push({ index, stroke });
  });
  return batchCommand([removeStrokesCommand(page, removed), { type: 'insert', entries }]);
}

// A command that would change nothing; callers skip recording these.
export function isEmptyCommand(cmd) {
  switch (cmd.type) {
    case 'insert':
    case 'delete':
    case 'insertItems':
    case 'deleteItems': return cmd.entries.length === 0;
    case 'move': return (cmd.ids.length === 0 && (cmd.itemIds ?? []).length === 0) || (cmd.dx === 0 && cmd.dy === 0);
    case 'recolor': return cmd.changes.length === 0;
    case 'paper': return cmd.from.template === cmd.to.template && cmd.from.color === cmd.to.color;
    case 'update': return cmd.strokes.length === 0 && cmd.items.length === 0;
    case 'batch': return cmd.cmds.every(isEmptyCommand);
    default: return false;
  }
}

// ---- Apply / invert ----

function insertAt(list, entries, key) {
  const out = list.slice();
  for (const entry of [...entries].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(entry.index, out.length), 0, entry[key]);
  }
  return out;
}

function replaceById(list, pairs) {
  const after = new Map(pairs.map((p) => [p.after.id, p.after]));
  return list.map((x) => after.get(x.id) ?? x);
}

export function applyCommand(page, cmd) {
  switch (cmd.type) {
    case 'insert':
      return { ...page, strokes: insertAt(page.strokes, cmd.entries, 'stroke') };
    case 'delete': {
      const ids = new Set(cmd.entries.map((e) => e.stroke.id));
      return { ...page, strokes: page.strokes.filter((s) => !ids.has(s.id)) };
    }
    case 'insertItems':
      return { ...page, items: insertAt(getItems(page), cmd.entries, 'item') };
    case 'deleteItems': {
      const ids = new Set(cmd.entries.map((e) => e.item.id));
      return { ...page, items: getItems(page).filter((i) => !ids.has(i.id)) };
    }
    case 'move': {
      const ids = new Set(cmd.ids);
      const itemIds = new Set(cmd.itemIds ?? []);
      const moved = {
        ...page,
        strokes: page.strokes.map((s) => (ids.has(s.id) ? translateStroke(s, cmd.dx, cmd.dy) : s)),
      };
      if (itemIds.size) {
        moved.items = getItems(page).map((i) => (itemIds.has(i.id)
          ? { ...i, x: round2(i.x + cmd.dx), y: round2(i.y + cmd.dy) }
          : i));
      }
      return moved;
    }
    case 'recolor': {
      const colors = new Map(cmd.changes.map((c) => [c.id, c.to]));
      return { ...page, strokes: page.strokes.map((s) => (colors.has(s.id) ? { ...s, color: colors.get(s.id) } : s)) };
    }
    case 'paper':
      return { ...page, paper: { ...cmd.to } };
    case 'update': {
      const updated = { ...page, strokes: replaceById(page.strokes, cmd.strokes) };
      if (cmd.items.length) updated.items = replaceById(getItems(page), cmd.items);
      return updated;
    }
    case 'batch':
      return cmd.cmds.reduce(applyCommand, page);
    default:
      throw new Error(`Unknown command ${cmd.type}`);
  }
}

export function invertCommand(cmd) {
  switch (cmd.type) {
    case 'insert': return { type: 'delete', entries: cmd.entries };
    case 'delete': return { type: 'insert', entries: cmd.entries };
    case 'insertItems': return { type: 'deleteItems', entries: cmd.entries };
    case 'deleteItems': return { type: 'insertItems', entries: cmd.entries };
    case 'move': return { ...cmd, dx: -cmd.dx, dy: -cmd.dy };
    case 'recolor': return { type: 'recolor', changes: cmd.changes.map((c) => ({ id: c.id, from: c.to, to: c.from })) };
    case 'paper': return { type: 'paper', from: cmd.to, to: cmd.from };
    case 'update': {
      const swap = (pairs) => pairs.map(({ before, after }) => ({ before: after, after: before }));
      return { type: 'update', strokes: swap(cmd.strokes), items: swap(cmd.items) };
    }
    case 'batch': return { type: 'batch', cmds: cmd.cmds.map(invertCommand).reverse() };
    default: throw new Error(`Unknown command ${cmd.type}`);
  }
}

// ---- History ----

// Undo/redo stacks of entries ({ pageId, cmd } in the app). The caller
// applies them: invertCommand(entry.cmd) to undo, entry.cmd to redo.
export class History {
  constructor(limit = 300) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
  }

  get canUndo() {
    return this.done.length > 0;
  }

  get canRedo() {
    return this.undone.length > 0;
  }

  record(entry) {
    this.done.push(entry);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  // Returns the entry to revert, or null if there is nothing to undo.
  undo() {
    const entry = this.done.pop();
    if (!entry) return null;
    this.undone.push(entry);
    return entry;
  }

  // Returns the entry to re-apply, or null if there is nothing to redo.
  redo() {
    const entry = this.undone.pop();
    if (!entry) return null;
    this.done.push(entry);
    return entry;
  }

  // Drops entries that no longer apply (for example, of a deleted page).
  forget(predicate) {
    this.done = this.done.filter((e) => !predicate(e));
    this.undone = this.undone.filter((e) => !predicate(e));
  }
}

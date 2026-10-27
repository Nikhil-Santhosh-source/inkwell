import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPage, createStroke, getPaper } from '../app/src/model.js';
import {
  History, addStrokesCommand, applyCommand, invertCommand, isEmptyCommand, moveStrokesCommand, paperCommand,
  recolorStrokesCommand, removeStrokesCommand,
} from '../app/src/commands.js';

function stroke(x, y, color = '#000') {
  return createStroke([{ x, y, pressure: 0.5 }, { x: x + 10.25, y: y + 5.5, pressure: 0.7 }], { tool: 'pen', color, width: 2 });
}

function pageWith(...strokes) {
  return { ...createPage(), strokes };
}

test('insert appends new strokes and its inverse removes them', () => {
  const a = stroke(1, 1);
  const page = pageWith(a);
  const b = stroke(5, 5);
  const cmd = addStrokesCommand(page, [b]);
  const after = applyCommand(page, cmd);
  assert.deepEqual(after.strokes.map((s) => s.id), [a.id, b.id]);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
});

test('delete restores strokes at their original positions on undo', () => {
  const [a, b, c, d] = [stroke(1, 1), stroke(2, 2), stroke(3, 3), stroke(4, 4)];
  const page = pageWith(a, b, c, d);
  const cmd = removeStrokesCommand(page, [d.id, b.id]);
  const after = applyCommand(page, cmd);
  assert.deepEqual(after.strokes.map((s) => s.id), [a.id, c.id]);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)).strokes.map((s) => s.id), [a.id, b.id, c.id, d.id]);
});

test('move translates only the given strokes and undoes exactly', () => {
  const [a, b] = [stroke(10, 10), stroke(50, 50)];
  const page = pageWith(a, b);
  const cmd = moveStrokesCommand([a.id], 12.345, -3.333);
  const after = applyCommand(page, cmd);
  assert.deepEqual(after.strokes[0].points[0].slice(0, 2), [22.35, 6.67]);
  assert.equal(after.strokes[1], b);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
});

test('recolor changes colors and undo restores each original color', () => {
  const [a, b] = [stroke(1, 1, '#111'), stroke(2, 2, '#222')];
  const page = pageWith(a, b);
  const cmd = recolorStrokesCommand(page, [a.id, b.id], '#f00');
  const after = applyCommand(page, cmd);
  assert.deepEqual(after.strokes.map((s) => s.color), ['#f00', '#f00']);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
});

test('paper changes are undoable', () => {
  const page = createPage();
  const before = getPaper(page);
  const cmd = paperCommand(before, { template: 'grid', color: 'dark' });
  const after = applyCommand(page, cmd);
  assert.deepEqual(getPaper(after), { template: 'grid', color: 'dark' });
  assert.deepEqual(getPaper(applyCommand(after, invertCommand(cmd))), before);
});

test('no-op commands are detected', () => {
  const page = pageWith(stroke(1, 1, '#f00'));
  assert.ok(isEmptyCommand(removeStrokesCommand(page, ['missing'])));
  assert.ok(isEmptyCommand(moveStrokesCommand([page.strokes[0].id], 0, 0)));
  assert.ok(isEmptyCommand(recolorStrokesCommand(page, [page.strokes[0].id], '#f00')));
  assert.ok(isEmptyCommand(paperCommand(getPaper(page), getPaper(page))));
  assert.ok(!isEmptyCommand(addStrokesCommand(page, [stroke(2, 2)])));
});

// Mirrors how the app uses History: entries are commands, applied by the caller.
const undoOn = (history, page) => {
  const cmd = history.undo();
  return cmd ? applyCommand(page, invertCommand(cmd)) : null;
};
const redoOn = (history, page) => {
  const cmd = history.redo();
  return cmd ? applyCommand(page, cmd) : null;
};

test('N edits followed by N undos returns the exact starting page, and redo replays them', () => {
  const history = new History();
  const start = pageWith(stroke(1, 1), stroke(2, 2));
  let page = start;
  const snapshots = [page];
  const doEdit = (cmd) => {
    history.record(cmd);
    page = applyCommand(page, cmd);
    snapshots.push(page);
  };
  doEdit(addStrokesCommand(page, [stroke(3, 3)]));
  doEdit(moveStrokesCommand([page.strokes[0].id, page.strokes[2].id], 7.5, 8.25));
  doEdit(recolorStrokesCommand(page, [page.strokes[1].id], '#00f'));
  doEdit(removeStrokesCommand(page, [page.strokes[0].id]));
  doEdit(paperCommand(getPaper(page), { template: 'dotted', color: 'cream' }));

  for (let i = snapshots.length - 2; i >= 0; i--) {
    page = undoOn(history, page);
    assert.deepEqual(page, snapshots[i]);
  }
  assert.equal(undoOn(history, page), null);
  for (let i = 1; i < snapshots.length; i++) {
    page = redoOn(history, page);
    assert.deepEqual(page, snapshots[i]);
  }
  assert.equal(redoOn(history, page), null);
});

test('a new edit clears the redo stack', () => {
  const history = new History();
  let page = createPage();
  const cmd = addStrokesCommand(page, [stroke(1, 1)]);
  history.record(cmd);
  page = applyCommand(page, cmd);
  page = undoOn(history, page);
  assert.ok(history.canRedo);
  history.record(addStrokesCommand(page, [stroke(2, 2)]));
  assert.ok(!history.canRedo);
});

test('history keeps at most its limit of steps', () => {
  const history = new History(3);
  let page = createPage();
  for (let i = 0; i < 5; i++) {
    const cmd = addStrokesCommand(page, [stroke(i, i)]);
    history.record(cmd);
    page = applyCommand(page, cmd);
  }
  let undos = 0;
  while (history.canUndo) {
    page = undoOn(history, page);
    undos++;
  }
  assert.equal(undos, 3);
  assert.equal(page.strokes.length, 2);
});

test('forget drops entries for a deleted page from both stacks', () => {
  const history = new History();
  history.record({ pageId: 'a', n: 1 });
  history.record({ pageId: 'b', n: 2 });
  history.record({ pageId: 'a', n: 3 });
  history.undo();
  history.forget((e) => e.pageId === 'a');
  assert.ok(!history.canRedo); // the undone 'a' entry is gone too
  assert.deepEqual(history.undo(), { pageId: 'b', n: 2 });
  assert.ok(!history.canUndo);
});

// ---- Items, updates, batches ----

import { createImageItem, createTextItem, getItems } from '../app/src/model.js';
import {
  addItemsCommand, batchCommand, removeItemsCommand, removeSelectionCommand, replaceStrokesCommand, updateCommand,
} from '../app/src/commands.js';

const textItem = (x) => createTextItem({ x, y: 10, width: 100, height: 20, text: `t${x}`, size: 16, color: '#000', lines: [`t${x}`] });

test('items can be inserted and deleted, restoring their order on undo', () => {
  const [a, b, c] = [textItem(1), textItem(2), createImageItem({ x: 0, y: 0, width: 5, height: 5, assetId: 'x' })];
  let page = createPage();
  page = applyCommand(page, addItemsCommand(page, [a, b, c]));
  assert.deepEqual(getItems(page).map((i) => i.id), [a.id, b.id, c.id]);
  const del = removeItemsCommand(page, [a.id, c.id]);
  const after = applyCommand(page, del);
  assert.deepEqual(getItems(after).map((i) => i.id), [b.id]);
  assert.deepEqual(applyCommand(after, invertCommand(del)), page);
});

test('move carries items along with strokes', () => {
  const s = stroke(10, 10);
  const item = textItem(5);
  const page = { ...pageWith(s), items: [item] };
  const cmd = moveStrokesCommand([s.id], 10, 20, [item.id]);
  const after = applyCommand(page, cmd);
  assert.deepEqual([getItems(after)[0].x, getItems(after)[0].y], [15, 30]);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
});

test('update swaps whole objects and undoes by swapping back', () => {
  const s = stroke(1, 1);
  const item = textItem(1);
  const page = { ...pageWith(s), items: [item] };
  const cmd = updateCommand([{ before: s, after: { ...s, width: 9 } }], [{ before: item, after: { ...item, text: 'new' } }]);
  const after = applyCommand(page, cmd);
  assert.equal(after.strokes[0].width, 9);
  assert.equal(getItems(after)[0].text, 'new');
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
});

test('batches apply in order, undo in reverse, and drop empty parts', () => {
  const s = stroke(1, 1);
  const item = textItem(1);
  const page = { ...pageWith(s), items: [item] };
  const cmd = removeSelectionCommand(page, [s.id], [item.id]);
  assert.equal(cmd.cmds.length, 2);
  const after = applyCommand(page, cmd);
  assert.equal(after.strokes.length, 0);
  assert.equal(getItems(after).length, 0);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
  assert.ok(isEmptyCommand(batchCommand([removeStrokesCommand(page, ['none'])])));
});

test('replaceStrokesCommand turns a stroke into pieces in place, and undo restores it', () => {
  const [a, b, c] = [stroke(1, 1), stroke(50, 50), stroke(90, 90)];
  const page = pageWith(a, b, c);
  const pieces = [{ ...b, id: 'p1', points: b.points.slice(0, 1) }, { ...b, id: 'p2', points: b.points.slice(1) }];
  const cmd = replaceStrokesCommand(page, [a, ...pieces, c]);
  const after = applyCommand(page, cmd);
  assert.deepEqual(after.strokes.map((s) => s.id), [a.id, 'p1', 'p2', c.id]);
  assert.deepEqual(applyCommand(after, invertCommand(cmd)), page);
  assert.ok(isEmptyCommand(replaceStrokesCommand(page, page.strokes)));
});

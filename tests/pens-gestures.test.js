import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createPage, createStroke, createTextItem, createWhiteboardPage } from '../app/src/model.js';
import {
  arrowPoints, closedLoop, connectorTargetAt, followConnectors, isScribble, pointRadii, recognizeShape,
  distances, inkCurve, inkOutline, settledDistance, smoothPoints, strokesUnderScribble, traceStroke,
} from '../app/src/geometry.js';
import { applyCommand, invertCommand, lockCommand, moveStrokesCommand, translateStroke } from '../app/src/commands.js';
import { contentBounds, finitePage } from '../app/src/whiteboard.js';

const pts = (fn, n = 60) => Array.from({ length: n + 1 }, (_, i) => fn(i / n));
const pen = (extra = {}) => ({ tool: 'pen', color: '#000', width: 4, ...extra });

// ---- Pens and ink settings ----

test('a ballpoint with no pressure sensitivity draws an even line', () => {
  const r = pointRadii(pen({ sens: 0 }), [[0, 0, 0.1], [10, 0, 0.9]]);
  assert.equal(r[0], r[1]);
});

test('strokes saved before ink settings existed keep responding to pressure', () => {
  const r = pointRadii(pen(), [[0, 0, 0.1], [10, 0, 0.9]]);
  assert.ok(r[1] > r[0] * 2);
});

test('a brush responds to pressure more than a fountain pen', () => {
  const spread = (style) => {
    const r = pointRadii(pen({ style, sens: 1, flat: 0 }), [[0, 0, 0.1], [10, 0, 1]]);
    return r[1] / r[0];
  };
  assert.ok(spread('brush') > spread('fountain'));
});

test('tip sharpness tapers both ends of a stroke', () => {
  const line = Array.from({ length: 50 }, (_, i) => [i * 4, 0, 0.5]);
  const blunt = pointRadii(pen({ sens: 0, taper: 0 }), line);
  const sharp = pointRadii(pen({ sens: 0, taper: 1 }), line);
  assert.equal(blunt[0], blunt[25]);
  assert.ok(sharp[0] < sharp[25] * 0.3);
  assert.ok(sharp[49] < sharp[25] * 0.3);
  assert.equal(sharp[25], blunt[25]);
});

test('a flatter fountain nib makes a bigger thick/thin difference', () => {
  const ratio = (flat) => {
    const s = pen({ style: 'fountain', sens: 0, flat });
    const along = pointRadii(s, [[0, 0, 0.5], [10, 10, 0.5]])[0];
    const across = pointRadii(s, [[0, 0, 0.5], [10, -10, 0.5]])[0];
    return across / along;
  };
  assert.ok(ratio(1) > ratio(0.3));
  assert.equal(ratio(0), 1);
});

test('the fountain nib follows the Pencil azimuth when it is known', () => {
  const s = pen({ style: 'fountain', sens: 0, flat: 1 });
  // Moving right: thin when the nib (azimuth + 45°) lies along x, thick when across.
  const alongNib = pointRadii(s, [[0, 0, 0.5, -Math.PI / 4, 1], [10, 0, 0.5, -Math.PI / 4, 1]])[0];
  const acrossNib = pointRadii(s, [[0, 0, 0.5, Math.PI / 4, 1], [10, 0, 0.5, Math.PI / 4, 1]])[0];
  assert.ok(acrossNib > alongNib * 4);
});

test('a tilted pencil draws wider, like shading', () => {
  const s = pen({ style: 'pencil', sens: 0 });
  const upright = pointRadii(s, [[0, 0, 0.5, 0, Math.PI / 2]])[0];
  const tilted = pointRadii(s, [[0, 0, 0.5, 0, 0.3]])[0];
  assert.ok(tilted > upright * 2);
});

test('createStroke keeps Pencil angles and the ink settings it was drawn with', () => {
  const s = createStroke([{ x: 1, y: 2, pressure: 0.5, azimuth: 1.234, altitude: 0.987 }], pen({ style: 'fountain', sens: 0.6, taper: 0.3, flat: 0.8 }));
  assert.deepEqual(s.points[0], [1, 2, 0.5, 1.23, 0.99]);
  assert.equal(s.style, 'fountain');
  assert.deepEqual([s.sens, s.taper, s.flat], [0.6, 0.3, 0.8]);
});

test('smoothing and moving keep the Pencil angle data on each point', () => {
  const points = [[0, 0, 0.5, 1, 1], [10, 5, 0.5, 1.2, 0.8], [20, 0, 0.5, 1.4, 0.6]];
  assert.ok(smoothPoints(points).every((p) => p.length === 5));
  const moved = translateStroke({ id: 's', points }, 5, 5);
  assert.deepEqual(moved.points[1], [15, 10, 0.5, 1.2, 0.8]);
});

// ---- Whiteboards ----

test('a whiteboard is one endless page; ink is not clamped to it', () => {
  const { doc, pages } = createDocument('Board', 1, { kind: 'whiteboard' });
  assert.equal(doc.kind, 'whiteboard');
  assert.equal(pages[0].infinite, true);
  const s = createStroke([{ x: -500, y: 5000 }], pen(), pages[0]);
  assert.deepEqual(s.points[0].slice(0, 2), [-500, 5000]);
  const clamped = createStroke([{ x: -500, y: 5000 }], pen(), createPage());
  assert.deepEqual(clamped.points[0].slice(0, 2), [0, 1024]);
});

test('a whiteboard is framed around its content for thumbnails and PDF', () => {
  const board = createWhiteboardPage();
  assert.equal(contentBounds(board), null);
  assert.deepEqual([finitePage(board).width, finitePage(board).height], [768, 1024]);
  board.strokes = [createStroke([{ x: -300, y: 200 }, { x: 900, y: 2200 }], pen({ sens: 0 }), board)];
  board.items = [createTextItem({ x: 1000, y: 2000, width: 100, height: 30, text: 'x', size: 16, color: '#000', lines: ['x'] })];
  const page = finitePage(board, 40);
  assert.equal(page.infinite, undefined);
  const b = contentBounds(page);
  assert.ok(Math.abs(b.minX - 40) < 0.01 && Math.abs(b.minY - 40) < 0.01);
  assert.equal(page.width, Math.ceil(b.maxX + 40));
  assert.equal(page.height, Math.ceil(b.maxY + 40));
  const notWhiteboard = createPage();
  assert.equal(finitePage(notWhiteboard), notWhiteboard);
});

// ---- Arrows and connectors ----

test('a stroke with a barb at its end is recognized as an arrow', () => {
  const shaft = pts((t) => ({ x: 100 + t * 300, y: 200 + Math.sin(t * 10) * 2 }), 40);
  const barb = pts((t) => ({ x: 400 - t * 30, y: 200 - t * 22 }), 8).slice(1);
  const shape = recognizeShape([...shaft, ...barb], { arrows: true });
  assert.equal(shape.kind, 'arrow');
  assert.deepEqual(shape.start, [100, 200]);
  assert.ok(Math.abs(shape.end[0] - 400) < 1 && Math.abs(shape.end[1] - 200) < 0.01);
});

test('arrowPoints draws the shaft and both barbs as one path', () => {
  const p = arrowPoints({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(p[0], { x: 0, y: 0 });
  assert.ok(p.filter((q) => Math.abs(q.x - 100) < 0.01 && Math.abs(q.y) < 0.01).length >= 2, 'returns to the tip between barbs');
  assert.ok(p.some((q) => q.y > 5) && p.some((q) => q.y < -5), 'barbs on both sides');
});

function shapeStroke(kind, x, y, w, h) {
  return { id: `${kind}-${x}`, tool: 'pen', color: '#000', width: 2, shape: { kind }, points: [[x, y, 0.5], [x + w, y, 0.5], [x + w, y + h, 0.5], [x, y + h, 0.5]] };
}

test('connector ends attach to the smallest shape or item under them', () => {
  const big = shapeStroke('rectangle', 0, 0, 500, 500);
  const small = shapeStroke('ellipse', 100, 100, 50, 50);
  const plain = { ...shapeStroke('rectangle', 300, 300, 50, 50), shape: undefined, id: 'plain' };
  const item = createTextItem({ x: 600, y: 600, width: 80, height: 30, text: 'n', size: 16, color: '#000', lines: ['n'] });
  assert.equal(connectorTargetAt([big, small], [], 120, 120), small.id);
  assert.equal(connectorTargetAt([big, small], [], 400, 50), big.id);
  assert.equal(connectorTargetAt([plain], [], 320, 320), null, 'plain ink is not a target');
  assert.equal(connectorTargetAt([], [item], 640, 610), item.id);
  assert.equal(connectorTargetAt([{ ...small, locked: true }], [], 120, 120), null, 'locked shapes are not targets');
});

test('moving a shape stretches the arrows attached to it, and undo restores them', () => {
  const a = shapeStroke('ellipse', 0, 0, 100, 100);
  const b = shapeStroke('ellipse', 400, 0, 100, 100);
  const arrow = {
    id: 'arrow', tool: 'pen', color: '#000', width: 2, points: [], connect: { from: a.id, to: b.id },
    shape: { kind: 'arrow', start: [100, 50], end: [400, 50] },
  };
  const page = { ...createPage(), strokes: [a, b, arrow] };
  const pairs = followConnectors(page.strokes, [b.id], 0, 200);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].after.shape.start, [100, 50]);
  assert.deepEqual(pairs[0].after.shape.end, [400, 250]);
  assert.ok(pairs[0].after.points.length > 10);
  // Moving the arrow together with its shapes leaves it to the move itself.
  assert.equal(followConnectors(page.strokes, [a.id, b.id, arrow.id], 10, 10).length, 0);
  // A move shifts a connector's recorded ends along with its points.
  const moved = applyCommand(page, moveStrokesCommand([arrow.id], 10, 20));
  assert.deepEqual(moved.strokes[2].shape.start, [110, 70]);
  assert.deepEqual(applyCommand(moved, invertCommand(moveStrokesCommand([arrow.id], 10, 20))).strokes[2].shape, arrow.shape);
});

// ---- Locking ----

test('lock and unlock are undoable updates that only touch what changes', () => {
  const s1 = createStroke([{ x: 1, y: 1 }], pen());
  const s2 = { ...createStroke([{ x: 2, y: 2 }], pen()), locked: true };
  const page = { ...createPage(), strokes: [s1, s2] };
  const lock = lockCommand(page, [s1.id, s2.id], [], true);
  assert.equal(lock.strokes.length, 1, 'already-locked stroke unchanged');
  const locked = applyCommand(page, lock);
  assert.ok(locked.strokes.every((s) => s.locked));
  const unlocked = applyCommand(locked, lockCommand(locked, [s1.id, s2.id], [], false));
  assert.ok(unlocked.strokes.every((s) => !('locked' in s)));
  assert.deepEqual(applyCommand(locked, invertCommand(lock)), page);
});

// ---- Pencil gestures ----

const scribble = pts((t) => ({ x: 100 + Math.sin(t * Math.PI * 14) * 40, y: 100 + t * 30 }), 120);

test('fast back-and-forth is a scribble; ordinary writing is not', () => {
  assert.ok(isScribble(scribble));
  assert.ok(!isScribble(pts((t) => ({ x: 100 + t * 300, y: 100 + Math.sin(t * 6) * 20 }))));
  assert.ok(!isScribble(pts((t) => ({ x: 100 + 50 * Math.cos(t * 6.28), y: 100 + 50 * Math.sin(t * 6.28) }))));
});

test('a scribble crosses out the strokes under it, but not locked or distant ones', () => {
  const under = createStroke(pts((t) => ({ x: 80 + t * 40, y: 115, pressure: 0.5 }), 10), pen());
  const far = createStroke(pts((t) => ({ x: 400 + t * 40, y: 400, pressure: 0.5 }), 10), pen());
  const locked = { ...createStroke(pts((t) => ({ x: 80 + t * 40, y: 110, pressure: 0.5 }), 10), pen()), locked: true };
  assert.deepEqual(strokesUnderScribble([under, far, locked], scribble), [under.id]);
});

test('a stroke that closes on itself is a loop usable as a lasso', () => {
  const loop = pts((t) => ({ x: 200 + 80 * Math.cos(t * 6.2), y: 200 + 60 * Math.sin(t * 6.2) }));
  assert.equal(closedLoop(loop).length, loop.length);
  assert.equal(closedLoop(pts((t) => ({ x: t * 300, y: 0 }))), null);
  assert.equal(closedLoop(pts((t) => ({ x: 5 * Math.cos(t * 6.2), y: 5 * Math.sin(t * 6.2) }))), null, 'too small');
});

// ---- Smooth ink ----

// A circle written fast and noisily, as the Pencil reports it at 240 Hz:
// positions a fraction of a unit off, pressure and angle flickering.
function noisyCircle(seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  return Array.from({ length: 161 }, (_, i) => {
    const a = (i / 160) * Math.PI * 2;
    return [200 + 60 * Math.cos(a) + rnd() * 1.4, 200 + 60 * Math.sin(a) + rnd() * 1.4, 0.55 + rnd() * 0.3, -0.6 + rnd() * 0.5, 1 + rnd() * 0.2];
  });
}

function outlineCircles(stroke) {
  const circles = [];
  traceStroke({ moveTo() {}, lineTo() {}, closePath() {}, arc(x, y, r) { circles.push({ x, y, r }); } }, stroke);
  return circles;
}

test('noisy Pencil input gives a smooth line and an even width', () => {
  for (const style of ['ballpoint', 'fountain']) {
    const stroke = { ...pen({ style, width: 15.5 }), points: noisyCircle() };
    const circles = outlineCircles(stroke);
    let widthJump = 0;
    let bend = 0;
    // The tips stay exactly where the Pencil touched down and lifted (under
    // the round caps), so the line is measured away from them.
    for (let i = 6; i < circles.length - 5; i++) {
      const [a, b, c] = [circles[i - 2], circles[i - 1], circles[i]];
      const step = Math.hypot(c.x - b.x, c.y - b.y) || 1;
      widthJump = Math.max(widthJump, Math.abs(c.r - b.r) / step);
      let d = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
      if (d > Math.PI) d = 2 * Math.PI - d;
      bend = Math.max(bend, d);
    }
    // The width changes gradually (no lumps) and the line doesn't zigzag.
    assert.ok(widthJump < 0.35, `${style}: width jumps ${widthJump.toFixed(2)} per unit`);
    assert.ok((bend * 180) / Math.PI < 12, `${style}: bends ${((bend * 180) / Math.PI).toFixed(1)}° between neighbours`);
    // Still the same size of circle, starting and ending where it was drawn.
    const r = circles.map((c) => Math.hypot(c.x - 200, c.y - 200));
    assert.ok(Math.min(...r) > 57 && Math.max(...r) < 63);
    assert.ok(Math.hypot(circles[0].x - stroke.points[0][0], circles[0].y - stroke.points[0][1]) < 1e-6);
  }
});

test('outline pieces meet the circles at their shared tangents', () => {
  const quads = [];
  let current = [];
  const recorder = {
    moveTo(x, y) { current = [[x, y]]; },
    lineTo(x, y) { current.push([x, y]); },
    closePath() { quads.push(current); },
    arc() {},
  };
  // A line that thickens: the sides must touch both end circles exactly.
  const stroke = { ...pen({ sens: 1 }), points: [[0, 0, 0.1], [40, 0, 1]] };
  traceStroke(recorder, stroke, stroke.points);
  const radii = pointRadii(stroke, stroke.points);
  const [q] = quads;
  assert.ok(Math.abs(Math.hypot(q[0][0], q[0][1]) - radii[0]) < 1e-9);
  assert.ok(Math.abs(Math.hypot(q[1][0] - 40, q[1][1]) - radii[1]) < 1e-9);
  // The side is perpendicular to the radius at both ends (a true tangent).
  const side = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  assert.ok(Math.abs(side[0] * q[0][0] + side[1] * q[0][1]) < 1e-6);
});

test('snapped shapes keep sharp corners', () => {
  const box = [[0, 0, 0.5], [50, 0, 0.5], [50, 50, 0.5]];
  const stroke = { ...pen(), points: box, shape: { kind: 'rectangle' } };
  assert.ok(inkCurve(stroke).some((p) => Math.hypot(p[0] - 50, p[1]) < 1e-9), 'corner kept exactly');
});

test('the settled part of a live stroke never changes as the stroke grows', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (const style of ['ballpoint', 'fountain', 'brush']) {
    for (const res of [0.27, 1, 1.7, undefined]) {
      // Cursive-like loops with uneven spacing (fast and slow writing).
      let t = 0;
      const all = Array.from({ length: 220 }, () => {
        t += 0.05 + Math.abs(rnd()) * 0.25;
        return [100 + t * 9 + 14 * Math.cos(t * 2.1), 200 + 18 * Math.sin(t * 2.1) + rnd(), 0.5 + rnd() * 0.4, -0.5 + rnd() * 0.3, 1 + rnd() * 0.2];
      });
      const settings = { ballpoint: {}, fountain: { sens: 0.6, taper: 0.3, flat: 0.8 }, brush: { sens: 1, taper: 0.7 } }[style];
      const pen0 = { ...pen({ style, width: 6, ...settings }), ...(res ? { res } : {}) };
      const final = inkOutline({ ...pen0, points: all }, 2.5);
      for (const k of [20, 60, 110, 170]) {
        const partial = { ...pen0, points: all.slice(0, k) };
        const live = inkOutline(partial, 2.5);
        const along = distances(live.points);
        const settled = along[along.length - 1] - settledDistance(partial);
        for (let j = 0; j < live.points.length && along[j] <= settled; j++) {
          const a = live.points[j];
          const b = final.points[j];
          assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 && Math.abs(live.radii[j] - final.radii[j]) < 1e-6,
            `${style} res ${res} after ${k} points: point ${j} moved`);
        }
      }
    }
  }
});

test('zoomed in, small writing keeps its detail; zoomed out, jitter is still smoothed', () => {
  // A small loop 3 page units across, written at 367% (0.27 page units per pixel).
  const loop = Array.from({ length: 41 }, (_, i) => [50 + 1.5 * Math.cos((i / 40) * Math.PI * 2), 50 + 1.5 * Math.sin((i / 40) * Math.PI * 2), 0.5]);
  const zoomed = inkCurve({ ...pen(), points: loop, res: 0.27 });
  const r = zoomed.slice(5, -5).map(([x, y]) => Math.hypot(x - 50, y - 50));
  assert.ok(Math.min(...r) > 1.35, `loop kept its size (smallest radius ${Math.min(...r).toFixed(2)})`);
  // Written at 100%, the same small loop would be a pixel-sized scribble; it's evened out.
  const plain = inkCurve({ ...pen(), points: loop, res: 1 });
  assert.ok(plain.length > 0);
});

test('scribbles are recognised in any direction, handwriting is not', () => {
  // Up and down while moving along a word (wider than tall).
  const upDown = pts((t) => ({ x: 100 + t * 90, y: 100 + Math.sin(t * Math.PI * 16) * 18 }), 160);
  assert.ok(isScribble(upDown), 'vertical zigzag across a word');
  // Side to side, a short quick one (two and a half back-and-forths).
  const quick = pts((t) => ({ x: 100 + Math.sin(t * Math.PI * 5) * 40, y: 100 + t * 12 }), 60);
  assert.ok(isScribble(quick), 'short scribble');
  // Diagonal.
  const diagonal = pts((t) => { const a = Math.sin(t * Math.PI * 12) * 35; return { x: 100 + a + t * 20, y: 100 + a + t * 5 }; }, 140);
  assert.ok(isScribble(diagonal), 'diagonal scribble');
  // Handwriting: "mmmm" and "minimum" style up-downs move along by about a letter each.
  const mmm = pts((t) => ({ x: 100 + t * 160, y: 100 - Math.abs(Math.sin(t * Math.PI * 8)) * 16 }), 200);
  assert.ok(!isScribble(mmm), 'mmm is writing');
  const wave = pts((t) => ({ x: 100 + t * 300, y: 100 + Math.sin(t * Math.PI * 10) * 12 }), 200);
  assert.ok(!isScribble(wave), 'a wavy line is writing');
});

test('a scribble over part of a long stroke erases it', () => {
  // One long cursive stroke; the scribble covers about a quarter of it.
  const long = createStroke(pts((t) => ({ x: 100 + t * 400, y: 200 + Math.sin(t * 40) * 8, pressure: 0.5 }), 200), pen());
  const part = pts((t) => ({ x: 120 + t * 80, y: 200 + Math.sin(t * Math.PI * 16) * 20 }), 160);
  assert.ok(isScribble(part));
  assert.deepEqual(strokesUnderScribble([long], part), [long.id]);
  // Merely crossing it once with a line doesn't.
  const across = pts((t) => ({ x: 300, y: 150 + t * 100 }), 40);
  assert.deepEqual(strokesUnderScribble([long], across), []);
});

test('scribbles over small letters count, at any zoom', () => {
  // A small letter is about 14 px tall on screen; the scribble over it ~16 px wide.
  for (const res of [0.27, 0.7, 1.6]) {
    const px = (v) => v * res;
    const letter = createStroke(pts((t) => ({ x: 100 + px(8) * Math.cos(t * 6.28), y: 100 + px(7) * Math.sin(t * 6.28), pressure: 0.5 }), 40), pen({ width: px(2) }));
    const scribble = pts((t) => ({ x: 100 + Math.sin(t * Math.PI * 9) * px(9), y: 100 - px(6) + t * px(12) }), 50);
    assert.ok(isScribble(scribble, res), `scribble at res ${res}`);
    assert.deepEqual(strokesUnderScribble([letter], scribble, res), [letter.id], `letter erased at res ${res}`);
    // A tiny tick or dot isn't a scribble.
    assert.ok(!isScribble(pts((t) => ({ x: 100 + px(2) * t, y: 100 + px(2) * Math.sin(t * 9) }), 20), res));
  }
});

test('a scribble over one part of a big drawing erases that drawing stroke', () => {
  // A large circle drawn in one stroke; the scribble covers about a tenth of it.
  const circle = createStroke(pts((t) => ({ x: 300 + 150 * Math.cos(t * 6.28), y: 300 + 150 * Math.sin(t * 6.28), pressure: 0.5 }), 200), pen());
  const scribble = pts((t) => ({ x: 450 + Math.sin(t * Math.PI * 12) * 20, y: 270 + t * 60 }), 120);
  assert.ok(isScribble(scribble));
  assert.deepEqual(strokesUnderScribble([circle], scribble), [circle.id]);
});

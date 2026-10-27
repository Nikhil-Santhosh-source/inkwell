import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStroke } from '../app/src/model.js';
import {
  distanceToSegment, pointInPolygon, smoothPoints, strokeBounds, strokeHitsCircle, strokeRadius, strokesInLasso,
  traceStroke, unionBounds,
} from '../app/src/geometry.js';

const pen = { tool: 'pen', color: '#000', width: 4 };
const line = (x1, y1, x2, y2, opts = pen) => createStroke([{ x: x1, y: y1, pressure: 0.5 }, { x: x2, y: y2, pressure: 0.5 }], opts);

test('pen width follows pressure; highlighter width does not', () => {
  assert.ok(strokeRadius(pen, 1) > strokeRadius(pen, 0.2));
  const hl = { tool: 'highlighter', width: 16 };
  assert.equal(strokeRadius(hl, 0.1), 8);
  assert.equal(strokeRadius(hl, 1), 8);
});

test('strokes saved before tools existed behave as pens', () => {
  assert.equal(strokeRadius({ width: 4 }, 0.5), strokeRadius(pen, 0.5));
});

test('smoothPoints keeps endpoints, passes through every sample, and fills in between', () => {
  const pts = [[0, 0, 0.5], [10, 0, 0.5], [10, 10, 0.5], [20, 10, 0.5]];
  const smooth = smoothPoints(pts);
  assert.deepEqual(smooth[0], pts[0]);
  assert.deepEqual(smooth.at(-1).slice(0, 2), pts.at(-1).slice(0, 2));
  assert.ok(smooth.length > pts.length * 4);
  for (const [x, y] of pts) assert.ok(smooth.some((p) => Math.hypot(p[0] - x, p[1] - y) < 1e-6));
  // Between samples the path curves rather than running straight.
  const between = smooth.filter(([x, y]) => x > 10.01 && y > 0.5 && y < 9.5);
  assert.ok(between.length > 0);
});

test('smoothPoints leaves short strokes unchanged', () => {
  const pts = [[1, 1, 0.5], [2, 2, 0.5]];
  assert.deepEqual(smoothPoints(pts), pts);
});

test('traceStroke emits one circle per point and one quad per segment', () => {
  const calls = { moveTo: 0, lineTo: 0, arc: 0, closePath: 0 };
  const recorder = Object.fromEntries(Object.keys(calls).map((k) => [k, () => { calls[k]++; }]));
  const s = line(0, 0, 100, 0);
  traceStroke(recorder, s, s.points);
  assert.equal(calls.arc, 2);
  assert.equal(calls.closePath, 1);
  assert.equal(calls.lineTo, 3);
});

test('traceStroke handles a single-point stroke (a dot)', () => {
  let arcs = 0;
  const recorder = { moveTo() {}, lineTo() {}, closePath() {}, arc() { arcs++; } };
  traceStroke(recorder, createStroke([{ x: 5, y: 5, pressure: 0.5 }], pen));
  assert.equal(arcs, 1);
});

test('strokeBounds includes the ink radius', () => {
  const s = line(10, 20, 30, 40);
  const r = strokeRadius(s, 0.5);
  assert.deepEqual(strokeBounds(s), { minX: 10 - r, minY: 20 - r, maxX: 30 + r, maxY: 40 + r });
  assert.deepEqual(unionBounds([{ minX: 0, minY: 5, maxX: 1, maxY: 6 }, { minX: -1, minY: 7, maxX: 3, maxY: 8 }]),
    { minX: -1, minY: 5, maxX: 3, maxY: 8 });
  assert.equal(unionBounds([]), null);
});

test('distanceToSegment measures to the nearest point, including endpoints', () => {
  assert.equal(distanceToSegment(5, 3, 0, 0, 10, 0), 3);
  assert.equal(distanceToSegment(13, 4, 0, 0, 10, 0), 5);
  assert.equal(distanceToSegment(3, 4, 0, 0, 0, 0), 5);
});

test('eraser hit testing touches crossing strokes only where they are', () => {
  const horizontal = line(0, 50, 100, 50);
  const vertical = line(50, 0, 50, 100);
  const far = line(0, 200, 100, 200);
  // Eraser at a point on the horizontal stroke, away from the crossing.
  assert.ok(strokeHitsCircle(horizontal, 10, 52, 3));
  assert.ok(!strokeHitsCircle(vertical, 10, 52, 3));
  assert.ok(!strokeHitsCircle(far, 10, 52, 3));
});

test('pointInPolygon works for a concave shape', () => {
  const u = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]];
  assert.ok(pointInPolygon(5, 20, u));
  assert.ok(!pointInPolygon(15, 20, u));
  assert.ok(!pointInPolygon(40, 5, u));
});

test('lasso selects strokes that are mostly inside', () => {
  const inside = line(10, 10, 20, 20);
  const outside = line(200, 200, 210, 210);
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.deepEqual(strokesInLasso([inside, outside], square), [inside.id]);
  assert.deepEqual(strokesInLasso([inside], [[0, 0], [1, 1]]), []);
});

// ---- Pen styles, partial erase, shapes, ruler, items ----

import {
  densify, eraseFromStroke, itemAt, itemsInLasso, mergeNearPoints, onRuler, pointRadii, projectToRuler, recognizeShape, rulerSnapLine,
  simplify, strokeAt,
} from '../app/src/geometry.js';

test('a fountain pen is thin along its 45Â° nib and thick across it', () => {
  const fountain = { tool: 'pen', style: 'fountain', width: 4 };
  const along = pointRadii(fountain, [[0, 0, 0.5], [10, 10, 0.5]])[0];
  const across = pointRadii(fountain, [[0, 0, 0.5], [10, -10, 0.5]])[0];
  assert.ok(across > along * 3);
  const ballpoint = { tool: 'pen', width: 4 };
  assert.equal(pointRadii(ballpoint, [[0, 0, 0.5]])[0], strokeRadius(ballpoint, 0.5));
});

test('densify keeps the ends and limits the gap between points', () => {
  const pts = densify([[0, 0, 0.5], [10, 0, 0.5]], 2);
  assert.deepEqual(pts[0], [0, 0, 0.5]);
  assert.deepEqual(pts.at(-1), [10, 0, 0.5]);
  assert.ok(pts.every((p, i) => i === 0 || p[0] - pts[i - 1][0] <= 2.0001));
});

test('the partial eraser splits a stroke where it touches and ignores others', () => {
  const s = line(0, 50, 200, 50);
  assert.equal(eraseFromStroke(s, 100, 300, 10), null);
  const runs = eraseFromStroke(s, 100, 50, 10);
  assert.equal(runs.length, 2);
  assert.ok(runs[0].every(([x]) => x < 100) && runs[1].every(([x]) => x > 100));
  // Erasing the very end leaves one piece.
  assert.equal(eraseFromStroke(s, 0, 50, 10).length, 1);
});

test('simplify reduces a noisy straight line to its ends', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i % 2 ? 0.5 : -0.5 }));
  assert.equal(simplify(pts, 2).length, 2);
});

const pts = (fn, n = 60) => Array.from({ length: n + 1 }, (_, i) => fn(i / n));

test('a wobbly stroke is recognized as a straight line and snapped level', () => {
  const shape = recognizeShape(pts((t) => ({ x: 100 + t * 300, y: 200 + Math.sin(t * 20) * 3 + t * 8 })));
  assert.equal(shape.kind, 'line');
  assert.ok(shape.points.every((p) => Math.abs(p.y - 200) < 0.01), 'snapped horizontal');
});

test('a rough circle becomes an ellipse', () => {
  const shape = recognizeShape(pts((t) => ({
    x: 300 + (100 + Math.sin(t * 31) * 4) * Math.cos(t * Math.PI * 2),
    y: 300 + (80 + Math.cos(t * 17) * 4) * Math.sin(t * Math.PI * 2),
  })));
  assert.equal(shape.kind, 'ellipse');
});

test('a rough box becomes a rectangle and a rough triangle a triangle', () => {
  const corners = (list) => pts((t) => {
    const n = list.length;
    const seg = Math.min(n - 1, Math.floor(t * n));
    const local = t * n - seg;
    const a = list[seg];
    const b = list[(seg + 1) % n];
    return { x: a.x + (b.x - a.x) * local + Math.sin(t * 50) * 1.5, y: a.y + (b.y - a.y) * local };
  }, 120);
  assert.equal(recognizeShape(corners([{ x: 100, y: 100 }, { x: 400, y: 102 }, { x: 398, y: 300 }, { x: 101, y: 298 }])).kind, 'rectangle');
  assert.equal(recognizeShape(corners([{ x: 200, y: 100 }, { x: 350, y: 350 }, { x: 50, y: 350 }])).kind, 'triangle');
});

test('scribbles and tiny marks are not turned into shapes', () => {
  assert.equal(recognizeShape(pts((t) => ({ x: t * 10, y: 0 }))), null);
  assert.equal(recognizeShape(pts((t) => ({ x: 100 + t * 200, y: 100 + Math.sin(t * 9) * 60 }))), null);
});

test('ink starting at a ruler edge snaps onto that edge line', () => {
  const ruler = { x: 400, y: 400, angle: 0 };
  assert.equal(rulerSnapLine(ruler, 400, 200), null, 'far from the ruler');
  const line = rulerSnapLine(ruler, 300, 400 - 50, 2);
  assert.ok(line);
  const p = projectToRuler(line, 350, 330);
  assert.equal(p.x, 350);
  assert.equal(p.y, 400 - 48 - 2 - 1);
  assert.ok(onRuler(ruler, 400, 400));
  assert.ok(!onRuler(ruler, 400, 500));
});

test('items can be hit, lassoed by their centre, and strokes found under a point', () => {
  const items = [{ id: 'a', x: 0, y: 0, width: 100, height: 50 }, { id: 'b', x: 50, y: 20, width: 100, height: 50 }];
  assert.equal(itemAt(items, 60, 30).id, 'b', 'topmost wins');
  assert.equal(itemAt(items, 300, 300), null);
  assert.deepEqual(itemsInLasso(items, [[-10, -10], [80, -10], [80, 60], [-10, 60]]), ['a']);
  const s = line(0, 0, 100, 0);
  assert.equal(strokeAt([s], 50, 3, 4).id, s.id);
  assert.equal(strokeAt([s], 50, 30, 4), null);
});

test('a circle sampled at only 6 points (fast writing) is smoothed into a round curve', () => {
  const r = 20;
  const sparse = Array.from({ length: 7 }, (_, i) => [100 + r * Math.cos((i / 6) * Math.PI * 2), 100 + r * Math.sin((i / 6) * Math.PI * 2), 0.5]);
  const smooth = smoothPoints(sparse);
  assert.ok(smooth.length > 40, 'filled in between the samples');
  // A hexagon's edge midpoints sit 13% inside the circle; the curve should stay within ~6%.
  const radii = smooth.map(([x, y]) => Math.hypot(x - 100, y - 100));
  assert.ok(Math.min(...radii) > r * 0.8);
  const midEdge = smooth[Math.floor(smooth.length / 12)];
  assert.ok(Math.hypot(midEdge[0] - 100, midEdge[1] - 100) > r * 0.9, 'bulges out between samples instead of cutting straight across');
  assert.ok(smooth.every((p) => p.length === 3));
});

test('near-duplicate Pencil samples do not put kinks in a smooth curve', () => {
  const r = 100;
  const clean = Array.from({ length: 7 }, (_, i) => {
    const a = Math.PI * 0.5 + (i / 6) * Math.PI;
    return [300 + r * Math.cos(a), 300 + r * Math.sin(a), 0.5];
  });
  // Safari often repeats a position with only the pressure changed.
  const withDupes = clean.flatMap((p, i) => (i > 0 && i < 6 ? [p, [p[0] + 0.2, p[1] + 0.1, 0.7]] : [p]));
  const sharpestBend = (s) => {
    let worst = 0;
    for (let i = 2; i < s.length - 2; i++) {
      const a = Math.atan2(s[i][1] - s[i - 2][1], s[i][0] - s[i - 2][0]);
      const b = Math.atan2(s[i + 2][1] - s[i][1], s[i + 2][0] - s[i][0]);
      let d = Math.abs(b - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      worst = Math.max(worst, (d * 180) / Math.PI);
    }
    return worst;
  };
  assert.ok(sharpestBend(smoothPoints(withDupes)) < 10, 'no sharp corners');
  // The merged points keep the higher pressure and the true end point.
  const merged = mergeNearPoints(withDupes);
  assert.equal(merged.length, clean.length);
  assert.equal(merged[1][2], 0.7);
  assert.deepEqual(merged.at(-1), withDupes.at(-1));
});

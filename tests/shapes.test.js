import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addArrowhead, connectorPoints, cubicAt, fitCubic, followConnectors, recognizeShape,
} from '../app/src/geometry.js';
import { translateStroke } from '../app/src/commands.js';

const pts = (fn, n = 80) => Array.from({ length: n + 1 }, (_, i) => fn(i / n));
const wobble = (p, i) => ({ x: p.x + Math.sin(i * 1.7) * 1.2, y: p.y + Math.cos(i * 2.3) * 1.2 });
const near = (a, b, tol = 2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;

// A quarter-circle-ish arc from (100, 300) curving up to (300, 100).
const arc = (t) => ({ x: 100 + 200 * Math.sin((t * Math.PI) / 2), y: 300 - 200 * (1 - Math.cos((t * Math.PI) / 2)) });

// Barb lines doubling back from a tip, `angle` degrees off the reverse direction.
function barb(tip, arrivingAngle, side, length = 22, n = 6) {
  const back = arrivingAngle + Math.PI + side * (30 * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => ({ x: tip.x + Math.cos(back) * length * ((i + 1) / n), y: tip.y + Math.sin(back) * length * ((i + 1) / n) }));
}

test('fitCubic reproduces a Bézier curve it was sampled from', () => {
  const controls = [{ x: 0, y: 0 }, { x: 100, y: -80 }, { x: 200, y: 80 }, { x: 300, y: 0 }];
  const fit = fitCubic(pts((t) => cubicAt(controls, t), 60));
  assert.ok(fit.error < 3, `error ${fit.error}`);
});

test('a smooth open bend becomes a clean curve', () => {
  const shape = recognizeShape(pts(arc).map(wobble));
  assert.equal(shape.kind, 'curve');
  assert.ok(near(shape.start, [100, 300], 3) && near(shape.end, [300, 100], 3));
  assert.deepEqual(shape.heads, { start: false, end: false });
});

test('a curve with a barb at the end becomes a curved arrow with the head along the curve', () => {
  const shaft = pts(arc);
  const tip = shaft[shaft.length - 1];
  // The arc arrives heading up (north) at its end.
  const shape = recognizeShape([...shaft, ...barb(tip, -Math.PI / 2, 1)].map(wobble), { arrows: true });
  assert.equal(shape.kind, 'curved-arrow');
  assert.deepEqual(shape.heads, { start: false, end: true });
  assert.ok(near(shape.end, [300, 100], 4));
  // The barbs sit behind the tip (below it), one on each side of the arrival direction.
  const [ex, ey] = shape.end;
  const head = shape.points.filter((p) => Math.hypot(p.x - ex, p.y - ey) < 40 && p.y > ey + 8);
  assert.ok(head.some((p) => p.x < ex - 5) && head.some((p) => p.x > ex + 5));
});

test('a straight arrow with heads at both ends is recognized', () => {
  const start = { x: 100, y: 200 };
  const end = { x: 400, y: 200 };
  const shaft = pts((t) => ({ x: 100 + 300 * t, y: 200 }), 40);
  // Drawn starting at one barb, into the start tip, along the shaft, then the end barb.
  const startBarb = barb(start, Math.PI, -1).reverse();
  const shape = recognizeShape([...startBarb, ...shaft, ...barb(end, 0, 1)].map(wobble), { arrows: true });
  assert.equal(shape.kind, 'arrow');
  assert.deepEqual(shape.heads, { start: true, end: true });
  assert.ok(Math.abs(shape.start[1] - 200) < 3 && Math.abs(shape.end[1] - 200) < 3);
});

test('a standalone V becomes a symmetric arrowhead', () => {
  const tip = { x: 300, y: 300 };
  const v = [...pts((t) => ({ x: 270 + 30 * t, y: 270 + 30 * t }), 10), ...pts((t) => ({ x: 300 - 31 * t, y: 300 + 29 * t }), 10).slice(1)];
  const shape = recognizeShape(v, { arrows: true });
  assert.equal(shape.kind, 'chevron');
  assert.ok(near(shape.tip, [300, 300], 2));
  assert.ok(shape.pointing[0] > 0.9, 'points right');
});

test('a V added at a line end turns the line into an arrow, keeping its path', () => {
  const line = recognizeShape(pts((t) => ({ x: 100 + 300 * t, y: 200 }), 30));
  const stroke = { id: 's', tool: 'pen', color: '#000', width: 2, points: [], shape: { kind: line.kind, controls: line.controls, heads: line.heads, start: line.start, end: line.end } };
  const arrow = addArrowhead(stroke, true);
  assert.equal(arrow.shape.kind, 'arrow');
  assert.deepEqual(arrow.shape.heads, { start: false, end: true });
  const both = addArrowhead(arrow, false);
  assert.deepEqual(both.shape.heads, { start: true, end: true });
  assert.deepEqual(both.shape.start, line.start);
  assert.ok(both.points.length > arrow.points.length);
});

test('connectorPoints draws a curve and its heads as one path', () => {
  const controls = [[0, 0], [50, -60], [150, -60], [200, 0]];
  const plain = connectorPoints(controls, {});
  const headed = connectorPoints(controls, { start: true, end: true });
  assert.ok(Math.hypot(plain[0].x, plain[0].y) < 0.01);
  assert.ok(headed.length > plain.length + 8);
  // Arrives at (200, 0) heading down-right, so its barbs are up-left of the tip.
  assert.ok(headed.slice(-10).every((p) => p.x <= 200.01 && p.y <= 0.01));
});

test('squares, circles, diamonds and regular polygons snap cleanly', () => {
  const polygon = (n, r, rot = 0, cx = 300, cy = 300, steps = 20) => {
    const corners = Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(rot + (i * 2 * Math.PI) / n), y: cy + r * Math.sin(rot + (i * 2 * Math.PI) / n) }));
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % n];
      for (let k = 0; k < steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
    out.push(corners[0]);
    return out.map(wobble);
  };
  const square = recognizeShape(polygon(4, 100, Math.PI / 4));
  assert.equal(square.kind, 'rectangle');
  const xs = square.points.map((p) => p.x);
  const ys = square.points.map((p) => p.y);
  assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - (Math.max(...ys) - Math.min(...ys))) < 0.5, 'equal sides');

  const diamond = recognizeShape(polygon(4, 100, 0));
  assert.equal(diamond.kind, 'rectangle');

  for (const n of [5, 6]) {
    const shape = recognizeShape(polygon(n, 120, -Math.PI / 2));
    assert.equal(shape.kind, 'polygon', `${n} sides`);
  }

  const circle = recognizeShape(pts((t) => ({ x: 300 + 100 * Math.cos(t * 6.28), y: 300 + 96 * Math.sin(t * 6.28) })).map(wobble));
  assert.equal(circle.kind, 'ellipse');
  const r = circle.points.map((p) => Math.hypot(p.x - 300, p.y - 300));
  assert.ok(Math.max(...r) - Math.min(...r) < 1, 'snapped to a circle');
});

test('moving the shape at one end of a curved connector keeps its bend', () => {
  const controls = [[100, 100], [150, 0], [250, 0], [300, 100]];
  const connector = {
    id: 'c', tool: 'pen', color: '#000', width: 2, points: [], connect: { from: 'a', to: 'b' },
    shape: { kind: 'curved-arrow', controls, heads: { start: false, end: true }, start: [100, 100], end: [300, 100] },
  };
  const [pair] = followConnectors([connector], ['b'], 50, 40);
  assert.deepEqual(pair.after.shape.controls, [[100, 100], [150, 0], [300, 40], [350, 140]]);
  assert.equal(pair.after.shape.kind, 'curved-arrow');
  // Moving the connector itself shifts its controls too.
  assert.deepEqual(translateStroke(connector, 10, 10).shape.controls[0], [110, 110]);
});

test('handwriting and scribbles still are not turned into shapes', () => {
  const word = pts((t) => ({ x: 100 + 300 * t, y: 200 + Math.sin(t * 40) * 25 + Math.cos(t * 17) * 10 }));
  assert.equal(recognizeShape(word), null);
});

// A closed outline through `corners`, drawn starting `startAt` of the way
// round, ending `extra` of the way past the start (negative leaves a gap).
function outline(corners, startAt, extra, n = 120) {
  const ring = [...corners, corners[0]];
  const lens = ring.slice(1).map((c, i) => Math.hypot(c.x - ring[i].x, c.y - ring[i].y));
  const total = lens.reduce((s, v) => s + v, 0);
  const at = (f) => {
    let d = (((f % 1) + 1) % 1) * total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i]) return { x: ring[i].x + ((ring[i + 1].x - ring[i].x) * d) / lens[i], y: ring[i].y + ((ring[i + 1].y - ring[i].y) * d) / lens[i] };
      d -= lens[i];
    }
    return ring[0];
  };
  return pts((t) => at(startAt + t * (1 + extra)), n).map(wobble);
}

test('closed shapes are never mistaken for arrows, wherever they start or end', () => {
  const shapes = {
    triangle: [{ x: 200, y: 100 }, { x: 320, y: 300 }, { x: 80, y: 300 }],
    rectangle: [{ x: 100, y: 100 }, { x: 340, y: 100 }, { x: 340, y: 260 }, { x: 100, y: 260 }],
    diamond: [{ x: 200, y: 80 }, { x: 320, y: 200 }, { x: 200, y: 320 }, { x: 80, y: 200 }],
  };
  for (const [kind, corners] of Object.entries(shapes)) {
    for (const startAt of [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 0.9]) {
      for (const extra of [-0.04, 0, 0.05, 0.1]) {
        const shape = recognizeShape(outline(corners, startAt, extra));
        const want = kind === 'triangle' ? 'triangle' : 'rectangle';
        assert.equal(shape?.kind, want, `${kind} starting at ${startAt}, overshoot ${extra}: got ${shape?.kind}`);
      }
    }
  }
});

test('a closed shape with a little hook where the pen lifts is not an arrow', () => {
  const square = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }];
  const triangle = [{ x: 200, y: 100 }, { x: 320, y: 300 }, { x: 80, y: 300 }];
  for (const [corners, kind] of [[square, 'rectangle'], [triangle, 'triangle']]) {
    for (const startAt of [0, 0.3, 0.7]) {
      const path = outline(corners, startAt, 0.02);
      const end = path[path.length - 1];
      const prev = path[path.length - 6];
      const heading = Math.atan2(end.y - prev.y, end.x - prev.x);
      // The pen flicks back sharply (about 150°) for a short way as it lifts.
      const hook = barb(end, heading, 1, 18, 5);
      assert.equal(recognizeShape([...path, ...hook]).kind, kind, `${kind} starting at ${startAt}`);
    }
  }
  // A real arrow still is one.
  const shaft = pts((t) => ({ x: 100 + 300 * t, y: 200 }), 40);
  assert.equal(recognizeShape([...shaft, ...barb({ x: 400, y: 200 }, 0, 1)].map(wobble), { arrows: true }).kind, 'arrow');
});

test('with arrows off (the app), a line or curve with a hook at the end stays a plain line or curve', () => {
  const shaft = pts((t) => ({ x: 100 + 300 * t, y: 200 }), 40);
  const line = recognizeShape([...shaft, ...barb({ x: 400, y: 200 }, 0, 1)].map(wobble));
  assert.equal(line.kind, 'line');
  assert.deepEqual(line.heads, { start: false, end: false });
  assert.ok(near(line.end, [400, 200], 4), 'ends at the tip, not at the end of the hook');
  const curve = recognizeShape([...pts(arc), ...barb(pts(arc).at(-1), -Math.PI / 2, 1)].map(wobble));
  assert.equal(curve.kind, 'curve');
  assert.deepEqual(curve.heads, { start: false, end: false });
  // A "V" on its own isn't turned into an arrowhead.
  const v = [...pts((t) => ({ x: 100 + 40 * t, y: 100 + 40 * t }), 10), ...pts((t) => ({ x: 140 - 40 * t, y: 140 + 40 * t }), 10).slice(1)];
  assert.notEqual(recognizeShape(v)?.kind, 'chevron');
});

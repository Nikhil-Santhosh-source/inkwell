// Stroke geometry: smoothing, outlines, bounds, hit testing, shape
// recognition, partial erasing and ruler snapping.
// Pure functions on page-unit data; no DOM access.

import { strokeStyle, strokeTool } from './model.js';

const DEFAULT_NIB_ANGLE = Math.PI / 4; // a nib held at 45° when the Pencil doesn't report its angle

// Width response to pressure for each pen style (1 at medium pressure).
const PRESSURE_CURVES = {
  ballpoint: (p) => 0.35 + 1.3 * p,
  fountain: (p) => 0.35 + 1.3 * p,
  brush: (p) => 0.1 + 1.9 * p,
  pencil: (p) => 0.5 + p,
};

// Radius of a stroke at a given pressure, ignoring direction, tilt and
// tapering. Used for hit testing. Highlighters keep a constant width.
export function strokeRadius(stroke, pressure) {
  if (strokeTool(stroke) === 'highlighter') return stroke.width / 2;
  const curve = PRESSURE_CURVES[strokeStyle(stroke)] ?? PRESSURE_CURVES.ballpoint;
  return (stroke.width * Math.max(curve(pressure), 1)) / 2;
}

// Radius at each point. Points are [x, y, pressure] or, from the Pencil,
// [x, y, pressure, azimuth, altitude]. Per-stroke settings:
//   sens  — pressure sensitivity 0..1 (strokes saved without it: 1)
//   taper — tip sharpness 0..1: how much the ends narrow to a point
//   flat  — fountain nib flatness 0..1: thin along the nib, thick across it
// A fountain nib follows the Pencil's azimuth when known; a tilted pencil
// draws wider, like shading with the side of a lead.
export function pointRadii(stroke, points) {
  if (strokeTool(stroke) === 'highlighter') return points.map(() => stroke.width / 2);
  const style = strokeStyle(stroke);
  const curve = PRESSURE_CURVES[style] ?? PRESSURE_CURVES.ballpoint;
  const sens = stroke.sens ?? 1;
  const taper = stroke.taper ?? 0;
  const flat = stroke.flat ?? 0.8;
  const half = stroke.width / 2;

  // Distance along the stroke, for tapering the ends.
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = along[along.length - 1];
  const taperLength = Math.max(6, stroke.width * 8);

  return points.map((p, i) => {
    let r = half * (1 + (curve(p[2]) - 1) * sens);
    if (style === 'fountain') {
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const nib = p.length > 3 ? p[3] + Math.PI / 4 : DEFAULT_NIB_ANGLE;
      const across = dx === 0 && dy === 0 ? 1 : Math.abs(Math.sin(Math.atan2(dy, dx) - nib));
      r *= (1 - flat) + flat * (0.15 + 1.25 * across);
    }
    if (style === 'pencil' && p.length > 4) {
      r *= 1 + (1 - Math.min(1, p[4] / (Math.PI / 2))) * 2.5;
    }
    if (taper > 0 && points.length > 1) {
      const reach = Math.min(1, (along[i] + 0.5) / taperLength, (total - along[i] + 0.5) / taperLength);
      r *= Math.max(0.12, 1 - taper * (1 - reach));
    }
    return r;
  });
}

// Linear blend of two points, component by component (keeps tilt data).
export function lerpPoint(a, b, t) {
  return a.map((v, k) => v + ((b[k] ?? v) - v) * t);
}

// Turns the sparse points the Pencil reports (about 60 a second in Safari,
// so fast writing leaves gaps) into a smooth curve: a centripetal
// Catmull-Rom spline through every point, subdivided so no piece is longer
// than `maxStep` page units. Passing through the real points keeps letters
// their true size (averaging points would shrink every curve); centripetal
// parameterisation avoids loops and overshoot at sharp turns. Shaky hands
// are handled by the stabilization setting instead.
// points: [[x, y, p, ...]]. Returns a new array in the same format.
export function smoothPoints(points, maxStep = 1.5) {
  const pts = mergeNearPoints(points);
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.min(24, Math.max(1, Math.ceil(len / maxStep)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const [x, y] = centripetal(p0, p1, p2, p3, t);
      const q = lerpPoint(p1, p2, t); // pressure and tilt vary linearly
      q[0] = x;
      q[1] = y;
      out.push(q);
    }
  }
  return out;
}

// Safari often reports the Pencil twice at (almost) the same spot, e.g. when
// only the pressure changed. A spline forced through two near-identical
// points kinks sharply there (a 5° bend became 95° in testing), so points
// within MERGE_GAP of the last kept one are folded into it: the position is
// kept, the pressure is the larger of the two. The last point is always kept.
const MERGE_GAP = 1.2; // page units

export function mergeNearPoints(points) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    const close = Math.hypot(p[0] - last[0], p[1] - last[1]) < MERGE_GAP;
    if (!close) {
      out.push(p);
    } else if (i === points.length - 1) {
      // Keep the true end of the stroke, dropping the near point before it.
      if (out.length > 1) out[out.length - 1] = p;
      else out.push(p);
    } else if (p[2] > last[2]) {
      out[out.length - 1] = [last[0], last[1], p[2], ...last.slice(3)];
    }
  }
  return out;
}

// Point at t (0..1) between p1 and p2 on a centripetal Catmull-Rom spline.
function centripetal(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => [0, 1].map((k) => ((tb - u) * a[k] + (u - ta) * b[k]) / (tb - ta));
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

// Builds the filled outline of a stroke as a union of round-capped segments
// ("capsules"). All sub-paths wind the same way, so a single nonzero fill
// covers overlaps once: translucent highlighters don't darken where they cross.
// `path` is anything with moveTo/lineTo/arc/closePath, such as a Path2D.
export function traceStroke(path, stroke, points = smoothPoints(stroke.points)) {
  const radii = pointRadii(stroke, points);
  const circle = (x, y, r) => {
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, Math.PI * 2, false);
  };
  circle(points[0][0], points[0][1], radii[0]);
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const ra = radii[i - 1];
    const rb = radii[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      const nx = -dy / len;
      const ny = dx / len;
      // Clockwise on screen (y down), matching arc(..., false).
      path.moveTo(ax - nx * ra, ay - ny * ra);
      path.lineTo(bx - nx * rb, by - ny * rb);
      path.lineTo(bx + nx * rb, by + ny * rb);
      path.lineTo(ax + nx * ra, ay + ny * ra);
      path.closePath();
    }
    circle(bx, by, rb);
  }
  return path;
}

export function strokeBounds(stroke) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const radii = pointRadii(stroke, stroke.points);
  const maxR = Math.max(...radii);
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX: minX - maxR, minY: minY - maxR, maxX: maxX + maxR, maxY: maxY + maxR };
}

export function unionBounds(boundsList) {
  if (boundsList.length === 0) return null;
  return boundsList.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX),
    minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX),
    maxY: Math.max(acc.maxY, b.maxY),
  }));
}

export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// True if a circle (the eraser tip) touches the stroke's ink.
export function strokeHitsCircle(stroke, x, y, radius, bounds = strokeBounds(stroke)) {
  if (x + radius < bounds.minX || x - radius > bounds.maxX || y + radius < bounds.minY || y - radius > bounds.maxY) {
    return false;
  }
  const pts = stroke.points;
  if (pts.length === 1) {
    return Math.hypot(x - pts[0][0], y - pts[0][1]) <= radius + strokeRadius(stroke, pts[0][2]);
  }
  for (let i = 1; i < pts.length; i++) {
    const reach = radius + strokeRadius(stroke, Math.max(pts[i - 1][2], pts[i][2]));
    if (distanceToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
  }
  return false;
}

// ---- Partial erasing ----

// Adds points so no two neighbours are more than `step` apart.
export function densify(points, step) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k <= n; k++) out.push(lerpPoint(a, b, k / n));
  }
  return out;
}

// Cuts the part of a stroke under the eraser circle out of it. Returns null
// if the stroke isn't touched, otherwise the remaining runs of points
// (possibly none). Each run becomes its own stroke.
export function eraseFromStroke(stroke, x, y, radius, bounds = strokeBounds(stroke)) {
  if (!strokeHitsCircle(stroke, x, y, radius, bounds)) return null;
  const reach = radius + stroke.width * 0.3;
  const pts = densify(stroke.points, Math.max(0.75, radius / 3));
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (Math.hypot(p[0] - x, p[1] - y) <= reach) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(p.map((v, k) => (k === 2 ? Math.round(v * 1000) / 1000 : Math.round(v * 100) / 100)));
    }
  }
  if (run.length) runs.push(run);
  // Crumbs left at the edge of the eraser aren't worth keeping.
  return runs.filter((r) => r.length >= 2 || (stroke.points.length === 1 && r.length === 1));
}

// ---- Lasso ----

// Even-odd ray casting. polygon: [[x, y]].
export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Ids of strokes with at least half their points inside the lasso.
export function strokesInLasso(strokes, polygon) {
  if (polygon.length < 3) return [];
  return strokes
    .filter((stroke) => {
      const inside = stroke.points.filter(([x, y]) => pointInPolygon(x, y, polygon)).length;
      return inside * 2 >= stroke.points.length;
    })
    .map((stroke) => stroke.id);
}

export function itemBounds(item) {
  return { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
}

// Ids of items whose centre is inside the lasso.
export function itemsInLasso(items, polygon) {
  if (polygon.length < 3) return [];
  return items
    .filter((i) => pointInPolygon(i.x + i.width / 2, i.y + i.height / 2, polygon))
    .map((i) => i.id);
}

// The topmost item under a point, or null.
export function itemAt(items, x, y, pad = 0) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (x >= it.x - pad && x <= it.x + it.width + pad && y >= it.y - pad && y <= it.y + it.height + pad) return it;
  }
  return null;
}

// The topmost stroke within `pad` of a point, or null.
export function strokeAt(strokes, x, y, pad) {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokeHitsCircle(strokes[i], x, y, pad)) return strokes[i];
  }
  return null;
}

// ---- Shape recognition ----

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

function pointSegmentDistance(p, a, b) {
  return distanceToSegment(p.x, p.y, a.x, a.y, b.x, b.y);
}

// Ramer–Douglas–Peucker simplification of an open polyline.
export function simplify(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegmentDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(pts.slice(index), epsilon)];
}

function edgePoints(corners, step = 4) {
  const out = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const a = corners[i];
    const b = corners[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push(corners[corners.length - 1]);
  return out;
}

// Snaps a near-horizontal or near-vertical line to the axis.
function snapLine(a, b) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const tolerance = (7 * Math.PI) / 180;
  const nearest = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angle - nearest) > tolerance) return b;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + Math.cos(nearest) * len, y: a.y + Math.sin(nearest) * len };
}

// Recognizes a hand-drawn shape held at the end of the stroke:
//   open:   line, curve, arrow, curved arrow, double-headed arrow, arrowhead (V)
//   closed: triangle, rectangle/square, diamond, polygon (5–8 sides), ellipse/circle
// points: [{ x, y }]. Returns { kind, points, ... } with clean points, or null.
// Lines, curves and arrows also return `controls` (a cubic Bézier: start,
// two handles, end) and `heads` ({ start, end }), so they can be rebuilt
// when used as connectors.
export function recognizeShape(points) {
  if (points.length < 3) return null;
  const length = pathLength(points);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (length < 24 || diag < 16) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);

  // Line: every point close to the start–end segment.
  const maxDeviation = Math.max(...points.map((p) => pointSegmentDistance(p, first, last)));
  if (gap > length * 0.8 && maxDeviation < Math.max(5, gap * 0.07)) {
    return connectorShape(straightControls(first, snapLine(first, last)), { start: false, end: false });
  }

  // A stroke that comes back to where it started is a closed shape, even
  // with an overshoot or a little hook at the end; never an arrow.
  const loop = closeLoop(points, diag);
  if (loop) return recognizeClosed(loop, diag);

  // Arrows, straight or curved: a shaft with a barb doubling back at either end.
  const arrow = recognizeArrow(points);
  if (arrow) return arrow;

  // An arrowhead on its own: two similar arms meeting at a point.
  const chevron = recognizeChevron(points, diag);
  if (chevron) return chevron;

  // Open curve: one smooth bend (or an S), fitted with a single cubic Bézier.
  if (gap > diag * 0.3) {
    const fit = fitCubic(points);
    if (fit && fit.error < Math.max(5, length * 0.045)) return connectorShape(fit.controls, { start: false, end: false });
    return null;
  }
  return recognizeClosed(points, diag);
}

// The part of a stroke that goes once round, if its end comes back near its
// start (within 20% of the shape's size). Whatever is drawn past the closest
// approach to the start is trimmed. Returns null for open strokes.
function closeLoop(points, diag) {
  const first = points[0];
  let best = -1;
  let bestGap = diag * 0.2;
  for (let i = Math.floor(points.length * 0.6); i < points.length; i++) {
    const gap = Math.hypot(points[i].x - first.x, points[i].y - first.y);
    if (gap <= bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best < 0 ? null : points.slice(0, best + 1);
}

// Corners of a closed outline. It's walked from its farthest point from the
// centre (always a real corner), so starting to draw mid-side doesn't add a
// corner; corners where the outline barely turns are dropped.
function loopCorners(points, diag) {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let far = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i].x - cx, points[i].y - cy) > Math.hypot(points[far].x - cx, points[far].y - cy)) far = i;
  }
  const path = [...points.slice(far), ...points.slice(0, far), points[far]];
  let corners = simplify(path, diag * 0.09).slice(0, -1);
  for (let i = 0; corners.length > 3 && i < corners.length; i++) {
    const prev = corners[(i + corners.length - 1) % corners.length];
    const c = corners[i];
    const next = corners[(i + 1) % corners.length];
    let turn = Math.abs(Math.atan2(next.y - c.y, next.x - c.x) - Math.atan2(c.y - prev.y, c.x - prev.x));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn < (28 * Math.PI) / 180) {
      corners = corners.filter((_, k) => k !== i);
      i = -1;
    }
  }
  return { path, corners };
}

// Closed shapes: triangle, rectangle/square, diamond, polygon, ellipse/circle.
function recognizeClosed(points, diag) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max((maxX - minX) / 2, 1);
  const ry = Math.max((maxY - minY) / 2, 1);
  const ellipseError = points.reduce((sum, p) => sum + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / points.length;

  const { path: closed, corners } = loopCorners(points, diag);

  if (corners.length === 3 && ellipseError > 0.1) {
    return { kind: 'triangle', points: edgePoints([...corners, corners[0]]) };
  }
  if (corners.length === 4 && ellipseError > 0.07) {
    const axisAligned = corners.every((c, i) => {
      const n = corners[(i + 1) % 4];
      const angle = Math.abs(Math.atan2(n.y - c.y, n.x - c.x)) % (Math.PI / 2);
      return Math.min(angle, Math.PI / 2 - angle) < (12 * Math.PI) / 180;
    });
    if (axisAligned) {
      // A box; nearly equal sides become a square.
      let w = maxX - minX;
      let h = maxY - minY;
      if (Math.abs(w - h) < Math.max(w, h) * 0.1) w = h = (w + h) / 2;
      const rect = [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 }];
      return { kind: 'rectangle', points: edgePoints([...rect, rect[0]]) };
    }
    // Tilted four-sided shapes (diamonds) keep their corners; a near-square one is made exact.
    const quad = regularize(corners);
    return { kind: 'rectangle', points: edgePoints([...quad, quad[0]]) };
  }
  // 5–8 corners joined by straight edges is a polygon; a circle traced
  // through as many corners bows out between them instead.
  if (corners.length >= 5 && corners.length <= 8 && straightEdges(closed, corners)) {
    const poly = regularize(corners);
    return { kind: 'polygon', points: edgePoints([...poly, poly[0]]) };
  }
  if (ellipseError < 0.16) {
    // Nearly round ellipses become circles.
    let ex = rx;
    let ey = ry;
    if (Math.abs(rx - ry) < Math.max(rx, ry) * 0.1) ex = ey = (rx + ry) / 2;
    const steps = 72;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      pts.push({ x: cx + ex * Math.cos(t), y: cy + ey * Math.sin(t) });
    }
    return { kind: 'ellipse', points: pts };
  }
  return null;
}

// True if the path between each pair of neighbouring corners stays close to
// the straight edge joining them (on average within 6% of the edge length).
// A circle's arcs bow out ~13% between six corners.
function straightEdges(path, corners) {
  const idx = corners.map((c) => path.indexOf(c));
  if (idx.some((i) => i < 0)) return false;
  let total = 0;
  for (let k = 0; k < idx.length; k++) {
    const from = idx[k];
    const to = k + 1 < idx.length ? idx[k + 1] : path.length - 1;
    const a = path[from];
    const b = path[to];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let bow = 0;
    for (let i = from + 1; i < to; i++) bow = Math.max(bow, pointSegmentDistance(path[i], a, b));
    total += bow / len;
  }
  return total / idx.length < 0.06;
}

// Corners of a hand-drawn polygon; when they're close to a regular polygon
// (similar distance from the centre, evenly spaced), the regular one.
function regularize(corners) {
  const n = corners.length;
  const cx = corners.reduce((s, c) => s + c.x, 0) / n;
  const cy = corners.reduce((s, c) => s + c.y, 0) / n;
  const radii = corners.map((c) => Math.hypot(c.x - cx, c.y - cy));
  const r = radii.reduce((s, v) => s + v, 0) / n;
  if (radii.some((v) => Math.abs(v - r) > r * 0.18)) return corners;
  const a0 = Math.atan2(corners[0].y - cy, corners[0].x - cx);
  const dir = Math.sign(cross(corners[0], corners[1], { x: cx, y: cy })) || 1;
  const regular = corners.map((_, i) => {
    const a = a0 + dir * (i * 2 * Math.PI) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  // Only use it if every corner is near where it was drawn.
  return regular.every((p, i) => Math.hypot(p.x - corners[i].x, p.y - corners[i].y) < r * 0.3) ? regular : corners;
}

function cross(a, b, o) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// ---- Lines, curves and arrows as cubic Béziers ----

export function cubicAt([p0, c1, c2, p3], t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

function straightControls(a, b) {
  return [a, { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }, { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 }, b];
}

// Least-squares cubic Bézier through the points with fixed ends.
// Returns { controls, error } (error: largest distance from a point to the
// fitted curve at its chord-length parameter), or null.
export function fitCubic(points) {
  if (points.length < 4) return null;
  const p0 = points[0];
  const p3 = points[points.length - 1];
  const dist = [0];
  for (let i = 1; i < points.length; i++) dist.push(dist[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = dist[dist.length - 1];
  if (total === 0) return null;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  const r1 = { x: 0, y: 0 };
  const r2 = { x: 0, y: 0 };
  points.forEach((p, i) => {
    const t = dist[i] / total;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    const rx = p.x - b0 * p0.x - b3 * p3.x;
    const ry = p.y - b0 * p0.y - b3 * p3.y;
    s11 += b1 * b1;
    s12 += b1 * b2;
    s22 += b2 * b2;
    r1.x += b1 * rx;
    r1.y += b1 * ry;
    r2.x += b2 * rx;
    r2.y += b2 * ry;
  });
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) < 1e-9) return null;
  const c1 = { x: (r1.x * s22 - r2.x * s12) / det, y: (r1.y * s22 - r2.y * s12) / det };
  const c2 = { x: (r2.x * s11 - r1.x * s12) / det, y: (r2.y * s11 - r1.y * s12) / det };
  const controls = [p0, c1, c2, p3];
  // Error: distance from each point to the nearest of many curve samples.
  const samples = Array.from({ length: 64 }, (_, k) => cubicAt(controls, k / 63));
  let error = 0;
  for (const p of points) {
    let best = Infinity;
    for (let k = 1; k < samples.length; k++) best = Math.min(best, pointSegmentDistance(p, samples[k - 1], samples[k]));
    error = Math.max(error, best);
  }
  return { controls, error };
}

// The kind name for a connector-style shape.
function connectorKind(controls, heads) {
  const [p0, c1, c2, p3] = controls;
  const straight = pointSegmentDistance(c1, p0, p3) < 1 && pointSegmentDistance(c2, p0, p3) < 1;
  if (heads.start || heads.end) return straight ? 'arrow' : 'curved-arrow';
  return straight ? 'line' : 'curve';
}

function connectorShape(controls, heads) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const clean = controls.map((c) => ({ x: r2(c.x), y: r2(c.y) }));
  return {
    kind: connectorKind(clean, heads),
    points: connectorPoints(clean, heads),
    controls: clean.map((c) => [c.x, c.y]),
    heads: { ...heads },
    start: [clean[0].x, clean[0].y],
    end: [clean[3].x, clean[3].y],
  };
}

// The direction a curve travels as it arrives at its end (or leaves its start).
function endDirection(controls, atEnd) {
  const [p0, c1, c2, p3] = controls;
  const [tip, ...toward] = atEnd ? [p3, c2, c1, p0] : [p0, c1, c2, p3];
  const from = toward.find((c) => Math.hypot(c.x - tip.x, c.y - tip.y) > 0.5) ?? toward[toward.length - 1];
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  return { x: (tip.x - from.x) / len, y: (tip.y - from.y) / len };
}

// Points for a line/curve/arrow as one continuous stroke: each arrowhead is
// drawn out from its tip and back, along the direction the curve arrives.
export function connectorPoints(controls, heads = {}) {
  const ctl = controls.map((c) => (Array.isArray(c) ? { x: c[0], y: c[1] } : c));
  let chord = 0;
  let prev = ctl[0];
  for (let k = 1; k <= 16; k++) {
    const q = cubicAt(ctl, k / 16);
    chord += Math.hypot(q.x - prev.x, q.y - prev.y);
    prev = q;
  }
  const steps = Math.min(240, Math.max(8, Math.ceil(chord / 4)));
  const curve = Array.from({ length: steps + 1 }, (_, k) => cubicAt(ctl, k / steps));
  const size = Math.min(36, Math.max(10, chord * 0.2));
  const barbs = (atEnd) => {
    const tip = atEnd ? ctl[3] : ctl[0];
    const d = endDirection(ctl, atEnd);
    const angle = Math.atan2(d.y, d.x);
    return [1, -1].map((side) => ({
      x: tip.x - size * Math.cos(angle + side * (Math.PI / 7)),
      y: tip.y - size * Math.sin(angle + side * (Math.PI / 7)),
    }));
  };
  let out = curve;
  if (heads.start) {
    const [b1, b2] = barbs(false);
    out = [...edgePoints([b1, ctl[0], b2, ctl[0]]).slice(0, -1), ...out];
  }
  if (heads.end) {
    const [b1, b2] = barbs(true);
    out = [...out.slice(0, -1), ...edgePoints([ctl[3], b1, ctl[3], b2])];
  }
  return out;
}

// Kept for strokes drawn before curves existed.
export function arrowPoints(start, end) {
  return connectorPoints(straightControls(start, end), { end: true });
}

// Finds where an arrowhead doubles back from the shaft: the sharpest turn
// (over 100°) near one end of the stroke, with only a short barb beyond it.
// Returns the index of the tip, or -1.
function findHeadTip(points, atEnd) {
  const n = points.length;
  const dist = [0];
  for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = dist[n - 1];
  const reach = Math.max(4, total * 0.03);
  const at = (i, delta) => {
    // The point about `delta` units along the path from i (backwards when negative).
    const target = dist[i] + delta;
    let j = i;
    if (delta < 0) while (j > 0 && dist[j] > target) j--;
    else while (j < n - 1 && dist[j] < target) j++;
    return points[j];
  };
  let best = -1;
  let bestTurn = (100 * Math.PI) / 180;
  for (let i = 1; i < n - 1; i++) {
    const beyond = atEnd ? total - dist[i] : dist[i];
    if (beyond < 6 || beyond > total * 0.32) continue;
    const a = at(i, -reach);
    const b = at(i, reach);
    const inA = Math.atan2(points[i].y - a.y, points[i].x - a.x);
    const outA = Math.atan2(b.y - points[i].y, b.x - points[i].x);
    let turn = Math.abs(outA - inA);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > bestTurn) {
      bestTurn = turn;
      best = i;
    }
  }
  return best;
}

// Arrows: a straight or curved shaft with a barb doubling back at one or
// both ends. The head is redrawn cleanly along the shaft's direction.
function recognizeArrow(points) {
  let shaft = points;
  const heads = { start: false, end: false };
  const endTip = findHeadTip(shaft, true);
  if (endTip > 0) {
    const tip = shaft[endTip];
    const barb = shaft.slice(endTip);
    const shaftLen = pathLength(shaft.slice(0, endTip + 1));
    if (barb.every((p) => Math.hypot(p.x - tip.x, p.y - tip.y) < Math.max(12, shaftLen * 0.45))) {
      shaft = shaft.slice(0, endTip + 1);
      heads.end = true;
    }
  }
  const startTip = findHeadTip(shaft, false);
  if (startTip > 0) {
    const tip = shaft[startTip];
    const barb = shaft.slice(0, startTip + 1);
    const shaftLen = pathLength(shaft.slice(startTip));
    if (barb.every((p) => Math.hypot(p.x - tip.x, p.y - tip.y) < Math.max(12, shaftLen * 0.45))) {
      shaft = shaft.slice(startTip);
      heads.start = true;
    }
  }
  if (!heads.start && !heads.end) return null;
  if (pathLength(shaft) < 30) return null;

  const a = shaft[0];
  const b = shaft[shaft.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const deviation = Math.max(...shaft.map((p) => pointSegmentDistance(p, a, b)));
  if (deviation < Math.max(5, chord * 0.07)) {
    const end = heads.end && !heads.start ? snapLine(a, b) : b;
    const start = heads.start && !heads.end ? snapLine(b, a) : a;
    return connectorShape(straightControls(start, end), heads);
  }
  const fit = fitCubic(shaft);
  if (!fit || fit.error > Math.max(6, pathLength(shaft) * 0.05)) return null;
  return connectorShape(fit.controls, heads);
}

// A standalone arrowhead: "V" with two similar arms at 25–120°. It can be
// added to the end of an existing line (see the document view).
function recognizeChevron(points, diag) {
  const corners = simplify(points, Math.max(3, diag * 0.08));
  if (corners.length !== 3) return null;
  const [a, tip, b] = corners;
  const la = Math.hypot(a.x - tip.x, a.y - tip.y);
  const lb = Math.hypot(b.x - tip.x, b.y - tip.y);
  if (la < 8 || lb < 8 || Math.max(la, lb) / Math.min(la, lb) > 1.8) return null;
  let angle = Math.abs(Math.atan2(a.y - tip.y, a.x - tip.x) - Math.atan2(b.y - tip.y, b.x - tip.x));
  if (angle > Math.PI) angle = 2 * Math.PI - angle;
  if (angle < (25 * Math.PI) / 180 || angle > (120 * Math.PI) / 180) return null;
  // Make it symmetric about its bisector, arms of equal length.
  const len = (la + lb) / 2;
  const bis = Math.atan2((a.y - tip.y) / la + (b.y - tip.y) / lb, (a.x - tip.x) / la + (b.x - tip.x) / lb);
  const arm = (side) => ({ x: tip.x + len * Math.cos(bis + (side * angle) / 2), y: tip.y + len * Math.sin(bis + (side * angle) / 2) });
  // The direction the head points: from the arms' middle toward the tip.
  const pointing = [Math.cos(bis + Math.PI), Math.sin(bis + Math.PI)];
  return { kind: 'chevron', points: edgePoints([arm(1), tip, arm(-1)]), tip: [tip.x, tip.y], pointing };
}

// Adds an arrowhead to one end of a line/curve/arrow stroke (when a "V" is
// drawn at its end). Returns the updated stroke.
export function addArrowhead(stroke, atEnd) {
  const shape = connectorOf(stroke);
  const heads = { ...shape.heads, [atEnd ? 'end' : 'start']: true };
  return rebuildConnector({ ...stroke, shape: { ...stroke.shape, controls: shape.controls, heads } }, shape.controls);
}

// A line/curve/arrow stroke's Bézier controls and heads, including strokes
// saved before curves existed (which only recorded start and end).
export function connectorOf(stroke) {
  const shape = stroke.shape;
  const controls = shape.controls
    ? shape.controls.map(([x, y]) => [x, y])
    : straightControls({ x: shape.start[0], y: shape.start[1] }, { x: shape.end[0], y: shape.end[1] }).map((c) => [c.x, c.y]);
  const heads = shape.heads ?? { start: false, end: shape.kind === 'arrow' };
  return { controls, heads };
}

const CONNECTOR_KINDS = new Set(['line', 'curve', 'arrow', 'curved-arrow']);

export function isConnectorShape(stroke) {
  return CONNECTOR_KINDS.has(stroke.shape?.kind) && Boolean(stroke.shape.start);
}

// Rebuilds a line/curve/arrow stroke from (new) Bézier controls.
export function rebuildConnector(stroke, controls) {
  const { heads } = connectorOf(stroke);
  const built = connectorShape(controls.map(([x, y]) => ({ x, y })), heads);
  return {
    ...stroke,
    points: built.points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, 0.5]),
    shape: { ...stroke.shape, kind: built.kind, controls: built.controls, heads: built.heads, start: built.start, end: built.end },
  };
}

// Kinds of recognized shapes that connectors can attach to.
const CLOSED_SHAPES = new Set(['ellipse', 'rectangle', 'triangle', 'polygon']);

// The id of the closed shape stroke or item at (x, y), preferring the
// smallest one (a bubble inside a bigger frame), or null.
export function connectorTargetAt(strokes, items, x, y, pad = 14) {
  let best = null;
  let bestArea = Infinity;
  const consider = (id, b) => {
    if (x < b.minX - pad || x > b.maxX + pad || y < b.minY - pad || y > b.maxY + pad) return;
    const area = (b.maxX - b.minX) * (b.maxY - b.minY);
    if (area < bestArea) {
      best = id;
      bestArea = area;
    }
  };
  for (const s of strokes) if (CLOSED_SHAPES.has(s.shape?.kind) && !s.locked) consider(s.id, strokeBounds(s));
  for (const i of items) if (!i.locked) consider(i.id, itemBounds(i));
  return best;
}

// After shapes or items move by (dx, dy), returns { before, after } pairs for
// connectors (lines/arrows) whose ends are attached to them. Connectors that
// moved themselves are left alone.
// A moved end carries its handle with it, so a curve keeps its bend.
export function followConnectors(strokes, movedIds, dx, dy) {
  const moved = new Set(movedIds);
  const pairs = [];
  for (const s of strokes) {
    if (!s.connect || !isConnectorShape(s) || moved.has(s.id)) continue;
    const fromMoved = moved.has(s.connect.from);
    const toMoved = moved.has(s.connect.to);
    if (!fromMoved && !toMoved) continue;
    const [p0, c1, c2, p3] = connectorOf(s).controls;
    const shift = ([x, y], on) => (on ? [x + dx, y + dy] : [x, y]);
    const controls = [shift(p0, fromMoved), shift(c1, fromMoved), shift(c2, toMoved), shift(p3, toMoved)];
    pairs.push({ before: s, after: rebuildConnector(s, controls) });
  }
  return pairs;
}

// ---- Pencil gestures ----

// A scribble: fast back-and-forth over a small area, used to erase.
// points: [{ x, y }].
export function isScribble(points) {
  if (points.length < 12) return false;
  const length = pathLength(points);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const diag = Math.hypot(w, h);
  if (diag < 10 || length < diag * 3.5) return false;
  // Count direction reversals along the scribble's long axis.
  const axis = w >= h ? 'x' : 'y';
  let reversals = 0;
  let direction = 0;
  let anchor = points[0][axis];
  for (const p of points) {
    const delta = p[axis] - anchor;
    if (Math.abs(delta) < 3) continue;
    const sign = Math.sign(delta);
    if (direction !== 0 && sign !== direction) reversals++;
    direction = sign;
    anchor = p[axis];
  }
  return reversals >= 5;
}

// Strokes a scribble crosses out: at least 35% of their points inside the
// scribble's bounding box, or crossed by its path. Locked strokes are kept.
export function strokesUnderScribble(strokes, points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  return strokes.filter((s) => {
    if (s.locked) return false;
    const inside = s.points.filter(([x, y]) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY).length;
    return inside / s.points.length >= 0.35;
  }).map((s) => s.id);
}

// If a stroke closes into a loop, its outline as a lasso polygon; else null.
// points: [{ x, y }].
export function closedLoop(points) {
  if (points.length < 10) return null;
  const length = pathLength(points);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const first = points[0];
  const last = points[points.length - 1];
  if (diag < 40 || length < diag * 2 || Math.hypot(last.x - first.x, last.y - first.y) > diag * 0.25) return null;
  return points.map((p) => [p.x, p.y]);
}

// ---- Ruler ----

export const RULER_LENGTH = 1400;
export const RULER_WIDTH = 96;
const RULER_SNAP_DISTANCE = 30;

// Unit vectors along and across a ruler at `angle`.
export function rulerAxes(angle) {
  return { ux: Math.cos(angle), uy: Math.sin(angle), nx: -Math.sin(angle), ny: Math.cos(angle) };
}

// If (x, y) is near one of the ruler's long edges, returns the line to draw
// along: { x, y, angle, offset } where offset is the signed distance from the
// ruler's centre line. Coordinates in the ruler's space (document units).
export function rulerSnapLine(ruler, x, y, inkRadius = 0) {
  if (!ruler) return null;
  const { ux, uy, nx, ny } = rulerAxes(ruler.angle);
  const along = (x - ruler.x) * ux + (y - ruler.y) * uy;
  const across = (x - ruler.x) * nx + (y - ruler.y) * ny;
  if (Math.abs(along) > RULER_LENGTH / 2 + RULER_SNAP_DISTANCE) return null;
  const edge = RULER_WIDTH / 2;
  if (Math.abs(Math.abs(across) - edge) > RULER_SNAP_DISTANCE) return null;
  return { ...ruler, offset: Math.sign(across || 1) * (edge + inkRadius + 1) };
}

// Projects a point onto a snap line from rulerSnapLine.
export function projectToRuler(line, x, y) {
  const { ux, uy, nx, ny } = rulerAxes(line.angle);
  const along = (x - line.x) * ux + (y - line.y) * uy;
  return { x: line.x + ux * along + nx * line.offset, y: line.y + uy * along + ny * line.offset };
}

// True if (x, y) is on the ruler's body.
export function onRuler(ruler, x, y) {
  if (!ruler) return false;
  const { ux, uy, nx, ny } = rulerAxes(ruler.angle);
  const along = (x - ruler.x) * ux + (y - ruler.y) * uy;
  const across = (x - ruler.x) * nx + (y - ruler.y) * ny;
  return Math.abs(along) <= RULER_LENGTH / 2 && Math.abs(across) <= RULER_WIDTH / 2;
}
